import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Normalizes date strings like "17 НОЯБРЯ" to "17 ноября"
 * @param {string} str
 * @returns {string}
 */
function normalizeDateStr(str) {
  if (!str) return '';
  const s = str.trim();
  const m = s.match(/^(\d{1,2})\s+([а-яёА-ЯЁ]+)$/);
  if (m) {
    return `${m[1]} ${m[2].toLowerCase()}`;
  }
  return s;
}

/**
 * Normalizes price strings like "₸ 3 000 / чел." to "3 000 ₸"
 * @param {string} str
 * @returns {string}
 */
function normalizePrice(str) {
  if (!str) return '3 000 ₸';
  if (str.includes('3 000') || str.includes('3000')) return '3 000 ₸';
  return str.trim();
}

/**
 * Resolves directory containing instagram_state.json and index.html
 * @param {string} [dir]
 * @returns {string}
 */
function findSiteDir(dir) {
  const candidateList = [
    dir,
    process.env.PARENT_DIR,
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../..')
  ].filter(Boolean);

  for (const c of candidateList) {
    if (fs.existsSync(path.join(c, 'index.html')) || fs.existsSync(path.join(c, 'instagram_state.json'))) {
      return c;
    }
  }

  return dir || path.resolve(__dirname, '../../..');
}

/**
 * Returns active games from instagram_state.json or index.html fallback.
 * @param {string} [parentDir] - Root directory of the action-kinoquiz-krg site
 * @returns {Array<{ id: string, title: string, dateStr: string, timeStr: string, dayName: string, price: string, status: string, desc: string, rawOptionValue: string }>}
 */
export function getActiveGames(parentDir) {
  const dir = findSiteDir(parentDir);

  // Tier 1: instagram_state.json (fixtures or explicit active_games array)
  const statePath = path.join(dir, 'instagram_state.json');
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const state = JSON.parse(raw);
      if (Array.isArray(state.active_games) && state.active_games.length > 0) {
        return state.active_games.map((g, idx) => ({
          id: String(g.id || `game-${idx + 1}`),
          title: g.title || '',
          dateStr: normalizeDateStr(g.dateStr || g.date_str),
          timeStr: g.timeStr || g.time_str || '19:30',
          dayName: g.dayName || g.day_name || 'ВТ',
          price: normalizePrice(g.price),
          status: g.status || 'ОТКРЫТА ЗАПИСЬ',
          desc: g.desc || g.description || '',
          rawOptionValue: g.rawOptionValue || g.data_game || `${g.title} (${g.dateStr || g.date_str || ''} в ${g.timeStr || g.time_str || '19:30'})`
        }));
      }
    } catch {
      // Ignore JSON parse errors and proceed to HTML fallback
    }
  }

  // Tier 2: index.html AUTOSYNC:GAMES schedule articles
  const indexPath = path.join(dir, 'index.html');
  if (fs.existsSync(indexPath)) {
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const gamesMatch = html.match(/<!-- AUTOSYNC:GAMES_START -->([\s\S]*?)<!-- AUTOSYNC:GAMES_END -->/);
      if (gamesMatch) {
        const block = gamesMatch[1];
        const articleRegex = /<article\s+class="game([^"]*)"[^>]*>([\s\S]*?)<\/article>/g;
        const games = [];
        let match;
        let idx = 1;

        while ((match = articleRegex.exec(block)) !== null) {
          const isFeatured = match[1].includes('featured');
          const content = match[2];

          const topMatch = content.match(/<div class="game-top[^"]*">\s*<strong>([^<]+)<\/strong>(?:\s*<span>([^<]+)<\/span>)?\s*<\/div>/);
          let dateHeader = topMatch ? topMatch[1].trim() : '';
          let status = topMatch && topMatch[2] ? topMatch[2].trim() : (isFeatured ? 'Ближайшая игра' : 'ОТКРЫТА ЗАПИСЬ');

          let dayName = 'ВТ';
          let dateStr = '';
          let timeStr = '19:30';

          if (dateHeader) {
            const parts = dateHeader.split('·');
            if (parts.length > 1) {
              timeStr = parts[1].trim();
            }
            const dayDate = parts[0].trim().split(',');
            if (dayDate.length > 1) {
              dayName = dayDate[0].trim();
              dateStr = dayDate[1].trim();
            } else {
              dateStr = dayDate[0].trim();
            }
          }

          const titleMatch = content.match(/<h3>([^<]+)<\/h3>/);
          const title = titleMatch ? titleMatch[1].trim() : `Игра ${idx}`;

          const priceMatch = content.match(/<span>(₸\s*[\d\s]+[^<]*)<\/span>/i);
          const price = normalizePrice(priceMatch ? priceMatch[1] : '3 000 ₸');

          const descMatch = content.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          const desc = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '';

          const btnMatch = content.match(/data-game="([^"]+)"/);
          const rawOptionValue = btnMatch ? btnMatch[1].trim() : `${title} (${dateStr} в ${timeStr})`;

          games.push({
            id: `game-${idx++}`,
            title,
            dateStr: normalizeDateStr(dateStr),
            timeStr,
            dayName,
            price,
            status,
            desc,
            rawOptionValue
          });
        }

        if (games.length > 0) {
          return games;
        }
      }

      // Tier 3: index.html AUTOSYNC:SELECT_GAMES dropdown options
      const selectMatch = html.match(/<!-- AUTOSYNC:SELECT_GAMES_START -->([\s\S]*?)<!-- AUTOSYNC:SELECT_GAMES_END -->/);
      if (selectMatch) {
        const optBlock = selectMatch[1];
        const optRegex = /<option\s+value="([^"]+)">([^<]+)<\/option>/g;
        const games = [];
        let match;
        let idx = 1;
        while ((match = optRegex.exec(optBlock)) !== null) {
          const val = match[1].trim();
          const text = match[2].trim();
          const title = val.replace(/\s*\([^)]*\)$/, '').trim();
          games.push({
            id: `game-${idx++}`,
            title,
            dateStr: 'Вторник',
            timeStr: '19:30',
            dayName: 'ВТ',
            price: '3 000 ₸',
            status: 'ОТКРЫТА ЗАПИСЬ',
            desc: text,
            rawOptionValue: val
          });
        }
        if (games.length > 0) {
          return games;
        }
      }
    } catch {
      // Fallback
    }
  }

  // Tier 4: Safe default games (Karaganda «То Место» schedule)
  return [
    {
      id: 'default-1',
      title: 'Киномарафон: 100 вопросов',
      dateStr: '17 ноября',
      timeStr: '19:30',
      dayName: 'ВТ',
      price: '3 000 ₸',
      status: 'ОТКРЫТА ЗАПИСЬ',
      desc: '100 динамичных вопросов без повторов по мировому кинематографу, культовым сценам и сериалам.',
      rawOptionValue: 'Киномарафон: 100 вопросов (17.11 в 19:30)'
    },
    {
      id: 'default-2',
      title: 'Культовые Аниме',
      dateStr: '24 ноября',
      timeStr: '19:30',
      dayName: 'ВТ',
      price: '3 000 ₸',
      status: 'ОТКРЫТА ЗАПИСЬ',
      desc: 'Миядзаки, Наруто, Атака титанов, Клинок рассекающий демонов, Тетрадь смерти, Евангелион и шедевры мировой анимации.',
      rawOptionValue: 'Культовые Аниме (24.11 в 19:30)'
    }
  ];
}

export default getActiveGames;
