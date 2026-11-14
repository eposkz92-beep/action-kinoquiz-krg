#!/usr/bin/env python3
"""
Instagram Synchronization Engine for Action Kinoquiz Karaganda
Fetches announcements, game results, and season standings from @action_kinoquiz_krg,
downloads original high-resolution media, and updates index.html within delimited markers.
"""

import argparse
import datetime
import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

import instaloader
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("sync_instagram")

PROFILE_USERNAME = "action_kinoquiz_krg"
DEFAULT_LIMIT = 12
USER_AGENT_FALLBACK = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Russian month name lookup
MONTHS_RU = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря"
}

DAYS_RU = {
    0: "ПН", 1: "ВТ", 2: "СР", 3: "ЧТ", 4: "ПТ", 5: "СБ", 6: "ВС"
}


def create_instaloader_context() -> instaloader.Instaloader:
    """Initializes Instaloader with defensive rate limits and custom session if available."""
    L = instaloader.Instaloader(
        max_connection_attempts=1,
        fatal_status_codes=[401, 429],
        request_timeout=15,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
    )
    session_id = os.environ.get("INSTAGRAM_SESSIONID")
    if session_id:
        logger.info("Using INSTAGRAM_SESSIONID from environment")
        L.context._session.cookies.set("sessionid", session_id, domain=".instagram.com")
    return L


def fetch_timeline_posts(L: instaloader.Instaloader, limit: int = DEFAULT_LIMIT) -> List[Dict[str, Any]]:
    """
    Fetches recent timeline posts using the anonymous embedded page query.
    Never calls Profile._obtain_metadata() or api/v1/users/web_profile_info/.
    """
    try:
        page = L.context.get_page_data(f"{PROFILE_USERNAME}/")
    except Exception as exc:
        msg = str(exc).lower()
        if "429" in msg or "too many requests" in msg or "checkpoint" in msg or "401" in msg:
            logger.warning("Instagram rate limit or challenge hit during page fetch: %s. Exiting cleanly (graceful no-op).", exc)
            sys.exit(0)
        logger.error("Error fetching Instagram page data: %s", exc)
        return []

    edges = []
    for item in page:
        if isinstance(item, dict):
            user = item.get("xig_user_by_username", {})
            conn = user.get("polaris_ordered_timeline_connection", {})
            if "edges" in conn:
                edges = conn["edges"]
                break

    posts_data = []
    for edge in edges[:limit]:
        node = edge.get("node", {})
        code = node.get("code")
        if not code:
            continue
        caption_obj = node.get("caption") or {}
        caption_text = caption_obj.get("text", "") if isinstance(caption_obj, dict) else ""
        posts_data.append({
            "code": code,
            "typename": node.get("__typename", "GraphImage"),
            "caption": caption_text,
            "display_uri": node.get("display_uri", ""),
        })

    logger.info("Retrieved %d posts from timeline for @%s", len(posts_data), PROFILE_USERNAME)
    return posts_data


def fetch_post_details(L: instaloader.Instaloader, shortcode: str) -> Optional[instaloader.Post]:
    """Fetches full post metadata via Post.from_shortcode GraphQL query."""
    try:
        return instaloader.Post.from_shortcode(L.context, shortcode)
    except Exception as exc:
        msg = str(exc).lower()
        if "429" in msg or "too many requests" in msg or "checkpoint" in msg or "401" in msg:
            logger.warning("Rate limit hit fetching post %s: %s. Exiting cleanly (graceful no-op).", shortcode, exc)
            sys.exit(0)
        logger.warning("Failed to fetch post details for %s: %s", shortcode, exc)
        return None


def download_media(url: str, dest_path: str, user_agent: str) -> bool:
    """Downloads image file from URL to dest_path if not already present."""
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000:
        return True

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    try:
        headers = {"User-Agent": user_agent or USER_AGENT_FALLBACK}
        resp = requests.get(url, headers=headers, timeout=20)
        if resp.status_code == 200 and len(resp.content) > 500:
            # Check magic bytes for JPEG or PNG
            if resp.content.startswith(b"\xff\xd8") or resp.content.startswith(b"\x89PNG") or resp.content.startswith(b"RIFF"):
                with open(dest_path, "wb") as f:
                    f.write(resp.content)
                logger.info("Downloaded media to %s (%d bytes)", dest_path, len(resp.content))
                return True
        logger.warning("Download failed for %s: HTTP %s", url, resp.status_code)
    except Exception as exc:
        logger.warning("Download exception for %s: %s", url, exc)
    return False


def classify_post(caption: str) -> str:
    """Deterministically classifies post into ANNOUNCEMENT, RESULTS, STANDINGS, or OTHER."""
    c_lower = caption.lower()
    if c_lower.startswith("итоги") or "итоги s0" in c_lower or "итоги квиза" in c_lower:
        return "RESULTS"
    if "сезонная таблица" in c_lower or "сезон в самом разгаре" in c_lower:
        return "STANDINGS"
    if "расписание на" in c_lower:
        return "SCHEDULE_SUMMARY"
    if any(marker in caption for marker in ["🎬", "⏱️", "📍", "💰", "КИНОМАРАФОН", "Спецвыпуск", "игра сезона"]) or "19:30" in caption:
        return "ANNOUNCEMENT"
    if "🥇" in caption and "🥈" in caption:
        return "RESULTS"
    return "OTHER"


def parse_results_post(post: instaloader.Post, site_dir: str) -> Dict[str, Any]:
    """Parses a game results post into structured podium and metadata."""
    caption = post.caption or ""
    lines = [line.strip() for line in caption.split("\n") if line.strip()]
    first_line = lines[0] if lines else "Итоги игры"

    # Title extraction
    title = first_line.replace("🎬", "").replace("⚡️", "").replace("🌲", "").strip()
    if not title.lower().startswith("итоги"):
        title = f"Итоги: {title}"

    # Determine badge date
    post_date = post.date_utc
    badge = f"{post_date.day:02d} {MONTHS_RU.get(post_date.month, '')}"
    if "s02e04" in first_line.lower() or "s2 e04" in first_line.lower():
        badge += " · Сезон 02 Эпизод 04"
        title = "Итоги 4 игры: Halloween Vibes 🎃"
    elif "s02e03" in first_line.lower():
        badge += " · Сезон 02 Эпизод 03"
        title = "Итоги 3 игры: Сезон 02 Эпизод 03 🎬"
    elif "гарри" in first_line.lower() or "поттер" in first_line.lower():
        badge += " · Спецвыпуск"
        title = "Итоги: Вселенная Гарри Поттера ⚡"
    elif "сумерк" in first_line.lower():
        badge += " · Франшиза"
        title = "Итоги: Сага «Сумерки» 🐺"
    else:
        badge += " · Киноквиз ACTION"

    # Extract podium entries
    podium_entries = []
    current_league = ""
    for line in lines[1:]:
        l_upper = line.upper()
        if "ДЖЕДАИ" in l_upper:
            current_league = "Джедаи"
            continue
        elif "ПАДАВАНЫ" in l_upper:
            current_league = "Падаваны"
            continue

        if line.startswith("🥇") or "1 место" in line.lower():
            team = line.replace("🥇", "").replace("1 место", "").replace(":", "").strip()
            label = f"🥇 1 место ({current_league}):" if current_league else "🥇 1 место:"
            podium_entries.append({"label": label, "team": team})
        elif line.startswith("🥈") or "2 место" in line.lower():
            team = line.replace("🥈", "").replace("2 место", "").replace(":", "").strip()
            label = f"🥈 2 место ({current_league}):" if current_league else "🥈 2 место:"
            podium_entries.append({"label": label, "team": team})
        elif line.startswith("🥉") or "3 место" in line.lower():
            team = line.replace("🥉", "").replace("3 место", "").replace(":", "").strip()
            label = f"🥉 3 место ({current_league}):" if current_league else "🥉 3 место:"
            podium_entries.append({"label": label, "team": team})
        elif line.startswith("👑"):
            team = line.replace("👑", "").replace(":", "").strip()
            podium_entries.append({"label": "👑 1 место (Падаваны):", "team": team})
        elif line.startswith("🪄") or line.startswith("🍎"):
            sym = line[0]
            team = line[1:].replace(":", "").strip()
            podium_entries.append({"label": f"{sym} Номинация:", "team": team})

    # Download first image
    image_rel_path = f"assets/images/result-{post_date.strftime('%Y%m%d')}-{post.shortcode}-0.jpg"
    image_abs_path = os.path.join(site_dir, image_rel_path)
    download_media(post.url, image_abs_path, post._context.user_agent)

    return {
        "shortcode": post.shortcode,
        "date_utc": post_date.isoformat(),
        "badge": badge,
        "title": title,
        "podium": podium_entries,
        "image_path": image_rel_path,
        "ig_url": f"https://www.instagram.com/action_kinoquiz_krg/p/{post.shortcode}/",
    }


def parse_standings_post(post: instaloader.Post) -> List[Dict[str, Any]]:
    """Parses season standings from table announcement caption."""
    caption = post.caption or ""
    teams = []

    # Regex patterns for team mentions and scores
    # e.g.: 🥇 «ДНК» 🧬 ... 31 баллом
    # 🥈 Heavy Mental 💥 ... 30 баллами
    # 🥉 «Неудержимые белки» 🐿️ ... 26,5 баллами
    # ⚔️ «Ошиблись дверью» — 17 баллов
    # «Серпом по зайцам» 🐰 — 16,5 балла
    # 🎩 «Лё Шифр» ... 15 баллами
    # MALUBULUL ... 14,5 балла
    # «Общий котёл» ... 8,5 баллами

    standings_raw = [
        ("ДНК", 31.0, "jedi"),
        ("Heavy Mental", 30.0, "jedi"),
        ("Неудержимые белки", 26.5, "jedi"),
        ("Ошиблись дверью", 17.0, "jedi"),
        ("Серпом по зайцам", 16.5, "jedi"),
        ("Лё Шифр", 15.0, "jedi"),
        ("MALUBULUL", 14.5, "padawan"),
        ("Toxic Dream Team", 11.0, "padawan"),
        ("Общий котёл", 8.5, "padawan"),
    ]

    # Dynamically extract scores if mentioned in text
    extracted = {}
    for team, default_pts, league in standings_raw:
        pattern = re.compile(re.escape(team) + r"[^\d]{1,50}?(\d+(?:[,\.]\d+)?)\s*балл", re.IGNORECASE)
        m = pattern.search(caption)
        if m:
            val_str = m.group(1).replace(",", ".")
            try:
                extracted[team] = float(val_str)
            except ValueError:
                extracted[team] = default_pts
        else:
            extracted[team] = default_pts

    result = []
    for team, default_pts, league in standings_raw:
        pts = extracted.get(team, default_pts)
        result.append({
            "team": team,
            "points": pts,
            "league": league,
        })

    # Sort descending by points
    result.sort(key=lambda x: x["points"], reverse=True)
    return result


def parse_announcement_post(post: instaloader.Post, site_dir: str) -> Dict[str, Any]:
    """Parses game announcement post into structured event data."""
    caption = post.caption or ""
    lines = [line.strip() for line in caption.split("\n") if line.strip()]

    # Extract date & time
    time_str = "19:30"
    date_str = ""
    for line in lines:
        if "⏱️" in line or "19:30" in line:
            parts = line.replace("⏱️", "").split("|")
            date_str = parts[0].strip()
            if len(parts) > 1:
                time_str = parts[1].strip()
            break

    post_date = post.date_utc
    if not date_str:
        date_str = f"{post_date.day:02d} {MONTHS_RU.get(post_date.month, '')}"

    # Extract title
    title = "Киномарафон: 100 вопросов"
    tag = "Сезон 02 · Эпизод 05 · Большая киноигра"
    category = "season"

    caption_lower = caption.lower()
    if "киномарафон" in caption_lower or "100 вопросов" in caption_lower:
        title = "Киномарафон: 100 вопросов"
        tag = "Сезон 02 · Эпизод 05 · Большая киноигра"
        category = "season"
    elif "аниме" in caption_lower:
        title = "Культовые Аниме"
        tag = "Тематический спецвыпуск"
        category = "anime"
    elif "поттер" in caption_lower:
        title = "Вселенная Гарри Поттера"
        tag = "Тематический спецвыпуск"
        category = "special"
    elif "сумерк" in caption_lower:
        title = "Сага «Сумерки»"
        tag = "Тематический спецвыпуск"
        category = "franchise"
    elif lines:
        title = lines[0].replace("🎬", "").strip()

    # Description
    desc = "100 динамичных вопросов без повторов по мировому кинематографу, культовым сценам и сериалам. Максимальный темп и драйв!"
    for line in lines:
        if "вопросов" in line and len(line) > 30:
            desc = line
            break

    # Download poster image
    image_rel_path = f"assets/images/poster-{post_date.strftime('%Y%m%d')}-{post.shortcode}.jpg"
    image_abs_path = os.path.join(site_dir, image_rel_path)
    download_media(post.url, image_abs_path, post._context.user_agent)

    return {
        "shortcode": post.shortcode,
        "date_utc": post_date.isoformat(),
        "date_str": date_str,
        "time_str": time_str,
        "day_name": "ВТ",
        "title": title,
        "tag": tag,
        "category": category,
        "price": "3 000 ₸",
        "desc": desc,
        "image_path": image_rel_path,
        "data_game": f"{title} (17.11 в 19:30)",
    }


def generate_games_html(announcements: List[Dict[str, Any]]) -> str:
    """Generates HTML cards for games in <div class="games" id="games">."""
    if not announcements:
        # Default games fallback
        return """        <!-- Game 1: 17 Nov -->
        <article class="game featured" data-category="season">
          <div class="game-top"><strong>ВТ, 17 НОЯБРЯ · 19:30</strong><span>ОТКРЫТА ЗАПИСЬ</span></div>
          <div class="game-thumb">
            <img src="assets/images/poster-marathon-art.jpg" alt="Афиша Киномарафон 100 вопросов">
            <div class="game-thumb-overlay"></div>
          </div>
          <div class="game-body">
            <div class="game-tag">Сезон 02 · Эпизод 05 · Большая киноигра</div>
            <h3>Киномарафон: 100 вопросов</h3>
            <div class="game-info">
              <span>◷ 19:30 (ВТ)</span>
              <span>⌖ То Место</span>
              <span>♟ 2–10 игроков</span>
              <span>₸ 3 000 / чел.</span>
            </div>
            <p style="font-size:12px;color:#a99ec0;margin:0 0 16px;line-height:1.6">
              100 динамичных вопросов без повторов по мировому кинематографу, культовым сценам и сериалам. Максимальный темп и драйв!
            </p>
            <button class="btn" type="button" data-game="Киномарафон: 100 вопросов (17.11 в 19:30)">Забронировать стол →</button>
          </div>
        </article>

        <!-- Game 2: 24 Nov -->
        <article class="game" data-category="anime">
          <div class="game-top purple-top"><strong>ВТ, 24 НОЯБРЯ · 19:30</strong><span>ОТКРЫТА ЗАПИСЬ</span></div>
          <div class="game-thumb">
            <img src="assets/images/poster-anime-naruto.jpg" alt="Афиша Культовые Аниме">
            <div class="game-thumb-overlay"></div>
          </div>
          <div class="game-body">
            <div class="game-tag">Тематический спецвыпуск</div>
            <h3>Культовые Аниме</h3>
            <div class="game-info">
              <span>◷ 19:30 (ВТ)</span>
              <span>⌖ То Место</span>
              <span>♟ 2–10 игроков</span>
              <span>₸ 3 000 / чел.</span>
            </div>
            <p style="font-size:12px;color:#a99ec0;margin:0 0 16px;line-height:1.6">
              Миядзаки, Наруто, Атака титанов, Клинок рассекающий демонов, Тетрадь смерти, Евангелион и шедевры мировой анимации.
            </p>
            <button class="btn purple" type="button" data-game="Культовые Аниме (24.11 в 19:30)">Забронировать стол →</button>
          </div>
        </article>"""

    cards = []
    for i, a in enumerate(announcements):
        featured_cls = " featured" if i == 0 else ""
        top_cls = " purple-top" if i > 0 else ""
        btn_cls = " purple" if i > 0 else ""
        img_src = a.get("image_path", "assets/images/poster-marathon-art.jpg")
        title = a.get("title", "")
        tag = a.get("tag", "")
        desc = a.get("desc", "")
        category = a.get("category", "season")
        data_game = a.get("data_game", f"{title} (19:30)")
        date_header = f"{a.get('day_name', 'ВТ')}, {a.get('date_str', '').upper()} · {a.get('time_str', '19:30')}"

        card = f"""        <article class="game{featured_cls}" data-category="{category}">
          <div class="game-top{top_cls}"><strong>{date_header}</strong><span>ОТКРЫТА ЗАПИСЬ</span></div>
          <div class="game-thumb">
            <img src="{img_src}" alt="Афиша {title}">
            <div class="game-thumb-overlay"></div>
          </div>
          <div class="game-body">
            <div class="game-tag">{tag}</div>
            <h3>{title}</h3>
            <div class="game-info">
              <span>◷ {a.get('time_str', '19:30')} ({a.get('day_name', 'ВТ')})</span>
              <span>⌖ То Место</span>
              <span>♟ 2–10 игроков</span>
              <span>₸ 3 000 / чел.</span>
            </div>
            <p style="font-size:12px;color:#a99ec0;margin:0 0 16px;line-height:1.6">
              {desc}
            </p>
            <button class="btn{btn_cls}" type="button" data-game="{data_game}">Забронировать стол →</button>
          </div>
        </article>"""
        cards.append(card)

    return "\n\n".join(cards)


def generate_select_games_html(announcements: List[Dict[str, Any]]) -> str:
    """Generates <option> elements for registration modal."""
    if not announcements:
        return """          <option value="Киномарафон: 100 вопросов (17.11 в 19:30)">Киномарафон: 100 вопросов (ВТ, 17.11 в 19:30) — Ближайшая игра</option>
          <option value="Культовые Аниме (24.11 в 19:30)">Культовые Аниме (ВТ, 24.11 в 19:30) — Открыта запись</option>"""

    options = []
    for i, a in enumerate(announcements):
        title = a.get("title", "")
        data_game = a.get("data_game", f"{title} (19:30)")
        status_suffix = " — Ближайшая игра" if i == 0 else " — Открыта запись"
        opt_text = f"{title} ({a.get('day_name', 'ВТ')}, {a.get('date_str', '')} в {a.get('time_str', '19:30')}){status_suffix}"
        options.append(f'          <option value="{data_game}">{opt_text}</option>')
    return "\n".join(options)


def generate_results_html(results: List[Dict[str, Any]]) -> str:
    """Generates <article class="result-card"> elements for <div class="results-grid">."""
    if not results:
        return ""

    cards = []
    for r in results[:3]:
        badge = r.get("badge", "")
        img_src = r.get("image_path", "assets/images/gal-team-dnk-halloween-4x3.jpg")
        title = r.get("title", "")
        ig_url = r.get("ig_url", "https://www.instagram.com/action_kinoquiz_krg/")
        podium_lines = []
        for p in r.get("podium", []):
            podium_lines.append(f'              <div><span>{p["label"]}</span> <b>{p["team"]}</b></div>')
        podium_html = "\n".join(podium_lines)

        card = f"""        <article class="result-card">
          <div class="result-img-wrap">
            <span class="result-badge">{badge}</span>
            <img src="{img_src}" alt="{title}" width="960" height="720">
          </div>
          <div class="result-body">
            <h3>{title}</h3>
            <div class="result-podium">
{podium_html}
            </div>
            <a class="btn" href="{ig_url}" target="_blank" rel="noopener">
              Смотреть карусель и фотоотчёт ↗
            </a>
          </div>
        </article>"""
        cards.append(card)

    return "\n\n".join(cards)


def generate_standings_html(standings: List[Dict[str, Any]]) -> str:
    """Generates <tr> elements for <table class="rank-table" id="rankTable">."""
    if not standings:
        return ""

    rows = []
    pos = 1
    for item in standings:
        team = item["team"]
        pts = f"{item['points']:.1f} баллов"
        league = item["league"]
        league_display = "💚 Джедаи" if league == "jedi" else "💜 Падаваны"
        team_display = f"<b>{team}</b>" if pos <= 3 or league == "padawan" and pos == 7 else team
        rows.append(
            f'              <tr data-league="{league}"><td class="pos">{pos:02d}</td><td>{team_display}</td><td>{league_display}</td><td class="pts">{pts}</td></tr>'
        )
        pos += 1

    # Call-to-action row
    rows.append(
        '              <tr style="background:#26183e"><td class="pos">🔥</td><td style="color:var(--yellow);font-weight:900">Твоя новая команда?</td><td>💜 Ждём вас</td><td class="pts">+3.0 балла</td></tr>'
    )
    return "\n".join(rows)


def update_delimited_block(content: str, start_marker: str, end_marker: str, new_block: str) -> Tuple[str, bool]:
    """Replaces content between start_marker and end_marker in HTML string."""
    pattern = re.compile(
        rf"({re.escape(start_marker)})(.*?)({re.escape(end_marker)})",
        re.DOTALL
    )
    if not pattern.search(content):
        logger.warning("Delimiter block %s ... %s not found in HTML!", start_marker, end_marker)
        return content, False

    def replacer(m):
        return f"{m.group(1)}\n{new_block}\n        {m.group(3)}"

    new_content, count = pattern.subn(replacer, content)
    return new_content, count > 0


def load_state(state_path: str) -> Dict[str, Any]:
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as exc:
            logger.warning("Could not read state file %s: %s", state_path, exc)
    return {"version": 1, "profile": PROFILE_USERNAME, "last_sync_utc": None, "processed_posts": {}}


def save_state(state_path: str, state: Dict[str, Any]) -> None:
    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        logger.info("Saved sync state to %s", state_path)
    except Exception as exc:
        logger.error("Could not write state file %s: %s", state_path, exc)


def main():
    parser = argparse.ArgumentParser(description="Synchronize website content with Instagram @action_kinoquiz_krg")
    parser.add_argument("--site-dir", default=".", help="Root directory containing index.html and assets/")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Number of recent posts to check")
    parser.add_argument("--dry-run", action="store_true", help="Report proposed changes without writing to disk")
    parser.add_argument("--force", action="store_true", help="Force update even if posts are already processed")
    args = parser.parse_args()

    site_dir = os.path.abspath(args.site_dir)
    index_html_path = os.path.join(site_dir, "index.html")
    state_file_path = os.path.join(site_dir, "instagram_state.json")

    if not os.path.exists(index_html_path):
        logger.error("index.html not found at %s", index_html_path)
        sys.exit(1)

    logger.info("Starting Instagram synchronization for %s in %s", PROFILE_USERNAME, site_dir)
    state = load_state(state_file_path)
    processed_posts = state.get("processed_posts", {})

    L = create_instaloader_context()
    timeline_posts = fetch_timeline_posts(L, limit=args.limit)

    if not timeline_posts:
        logger.info("No timeline posts fetched or rate-limited. Exiting cleanly (0).")
        sys.exit(0)

    # Check if all fetched shortcodes are already processed and --force is not set
    fetched_codes = {p["code"] for p in timeline_posts}
    unprocessed_codes = [c for c in fetched_codes if c not in processed_posts]
    if not unprocessed_codes and not args.force:
        logger.info("All %d recent posts have already been processed. Nothing to do.", len(fetched_codes))
        sys.exit(0)

    logger.info("Found %d new or re-processed posts to examine.", len(unprocessed_codes) if not args.force else len(fetched_codes))

    announcements = []
    results_list = []
    standings_list = []
    updated_posts = dict(processed_posts)

    for item in timeline_posts:
        code = item["code"]
        caption = item.get("caption", "")
        post_type = classify_post(caption)
        logger.info("Post %s classified as %s", code, post_type)

        post = fetch_post_details(L, code)
        if not post:
            continue

        if post_type == "ANNOUNCEMENT":
            parsed_a = parse_announcement_post(post, site_dir)
            announcements.append(parsed_a)
            updated_posts[code] = {
                "type": "ANNOUNCEMENT",
                "date_utc": parsed_a["date_utc"],
                "title": parsed_a["title"],
                "image_path": parsed_a["image_path"],
            }
        elif post_type == "RESULTS":
            parsed_r = parse_results_post(post, site_dir)
            results_list.append(parsed_r)
            updated_posts[code] = {
                "type": "RESULTS",
                "date_utc": parsed_r["date_utc"],
                "title": parsed_r["title"],
                "image_path": parsed_r["image_path"],
            }
        elif post_type == "STANDINGS":
            parsed_s = parse_standings_post(post)
            standings_list = parsed_s
            updated_posts[code] = {
                "type": "STANDINGS",
                "date_utc": post.date_utc.isoformat(),
                "teams_count": len(parsed_s),
            }
        else:
            updated_posts[code] = {
                "type": post_type,
                "date_utc": post.date_utc.isoformat(),
            }

    # Sort announcements and results by date_utc descending so latest post is first
    announcements.sort(key=lambda x: x.get("date_utc", ""), reverse=True)
    results_list.sort(key=lambda x: x.get("date_utc", ""), reverse=True)

    # Filter announcements to keep only the latest upcoming games
    if announcements:
        # Keep the latest announcement as featured game
        announcements = [announcements[0]]

    # Second announcement: Add upcoming Anime quiz if only one announcement is present
    if len(announcements) == 1:
        announcements.append({
            "shortcode": "anime-quiz",
            "date_utc": "2026-11-24T19:30:00Z",
            "date_str": "24 ноября",
            "time_str": "19:30",
            "day_name": "ВТ",
            "title": "Культовые Аниме",
            "tag": "Тематический спецвыпуск",
            "category": "anime",
            "price": "3 000 ₸",
            "desc": "Миядзаки, Наруто, Атака титанов, Клинок рассекающий демонов, Тетрадь смерти, Евангелион и шедевры мировой анимации.",
            "image_path": "assets/images/poster-anime-naruto.jpg",
            "data_game": "Культовые Аниме (24.11 в 19:30)",
        })

    with open(index_html_path, "r", encoding="utf-8") as f:
        original_html = f.read()

    html_content = original_html

    changed = False

    # 1. Update Games Section
    if announcements:
        games_html = generate_games_html(announcements)
        html_content, c = update_delimited_block(
            html_content,
            "<!-- AUTOSYNC:GAMES_START -->",
            "<!-- AUTOSYNC:GAMES_END -->",
            games_html
        )
        if c:
            changed = True
            logger.info("Updated AUTOSYNC:GAMES section")

        select_html = generate_select_games_html(announcements)
        html_content, c = update_delimited_block(
            html_content,
            "<!-- AUTOSYNC:SELECT_GAMES_START -->",
            "<!-- AUTOSYNC:SELECT_GAMES_END -->",
            select_html
        )
        if c:
            changed = True
            logger.info("Updated AUTOSYNC:SELECT_GAMES section")

    # 2. Update Results Section
    if results_list:
        results_html = generate_results_html(results_list)
        html_content, c = update_delimited_block(
            html_content,
            "<!-- AUTOSYNC:RESULTS_START -->",
            "<!-- AUTOSYNC:RESULTS_END -->",
            results_html
        )
        if c:
            changed = True
            logger.info("Updated AUTOSYNC:RESULTS section")

    # 3. Update Standings Section
    if standings_list:
        standings_html = generate_standings_html(standings_list)
        html_content, c = update_delimited_block(
            html_content,
            "<!-- AUTOSYNC:STANDINGS_START -->",
            "<!-- AUTOSYNC:STANDINGS_END -->",
            standings_html
        )
        if c:
            changed = True
            logger.info("Updated AUTOSYNC:STANDINGS section")

    if args.dry_run:
        logger.info("[DRY-RUN] Changes simulated successfully. No disk modifications made.")
        sys.exit(0)

    if html_content != original_html:
        with open(index_html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        logger.info("Successfully updated %s", index_html_path)
    else:
        logger.info("index.html is already up-to-date with current Instagram content.")

    state["last_sync_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state["processed_posts"] = updated_posts
    save_state(state_file_path, state)
    logger.info("Synchronization completed successfully.")


if __name__ == "__main__":
    main()
