/**
 * src/dialog/webBookingParser.js
 * Regex Interceptor and Parser for Website Pre-filled WhatsApp Booking Messages
 */
import { normalizePhone } from '../db/database.js';

/**
 * Strips matched enclosing quotes (including typographic quotes) from extremities,
 * preserving internal nested quotation marks.
 *
 * Handles all typographic styles:
 * « », » «, „ “, „ ”, “ ”, ‘ ’, " ", ' '
 *
 * @param {string} str
 * @returns {string}
 */
export function stripTypographicQuotes(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();

  // Strip leading and trailing markdown formatting (*, _) and whitespace
  s = s.replace(/^[\s*_]+|[\s*_]+$/g, '');

  const quotePairs = [
    ['«', '»'],
    ['»', '«'],
    ['„', '“'],
    ['„', '”'],
    ['“', '”'],
    ['‘', '’'],
    ['"', '"'],
    ["'", "'"]
  ];

  const allQuotes = new Set(['«', '»', '„', '“', '”', '‘', '’', '"', "'"]);

  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    changed = false;
    iterations++;

    // 1. Check known enclosing quote pairs
    for (const [open, close] of quotePairs) {
      if (s.startsWith(open) && s.endsWith(close) && s.length >= (open.length + close.length)) {
        s = s.slice(open.length, s.length - close.length).trim();
        s = s.replace(/^[\s*_]+|[\s*_]+$/g, '');
        changed = true;
        break;
      }
    }

    if (changed) continue;

    // 2. Check if both extremities have quotes from allQuotes
    if (s.length >= 2 && allQuotes.has(s[0]) && allQuotes.has(s[s.length - 1])) {
      s = s.slice(1, -1).trim();
      s = s.replace(/^[\s*_]+|[\s*_]+$/g, '');
      changed = true;
      continue;
    }

    // 3. Single unmatched quote at beginning only (e.g. user typed «ДНК without closing quote)
    // Only strip if there is no other quote in the string
    if (s.length >= 1 && allQuotes.has(s[0])) {
      const rest = s.slice(1);
      const hasOtherQuotes = [...rest].some(c => allQuotes.has(c));
      if (!hasOtherQuotes) {
        s = rest.trim();
        s = s.replace(/^[\s*_]+|[\s*_]+$/g, '');
        changed = true;
        continue;
      }
    }

    // 4. Single unmatched quote at end only (e.g. user typed ДНК» without opening quote)
    // Only strip if there is no other quote in the string (preserves nested quotes like Клуб "Кино")
    if (s.length >= 1 && allQuotes.has(s[s.length - 1])) {
      const start = s.slice(0, -1);
      const hasOtherQuotes = [...start].some(c => allQuotes.has(c));
      if (!hasOtherQuotes) {
        s = start.trim();
        s = s.replace(/^[\s*_]+|[\s*_]+$/g, '');
        changed = true;
        continue;
      }
    }
  }

  return s;
}

/**
 * Checks if incoming text is a pre-filled booking message from action-kinoquiz-krg website.
 * Requires AT LEAST ONE mandatory modal structural marker from the website template:
 * - 'выбранная игра'
 * - ('команда' AND ('количество игроков' OR 'число игроков'))
 * - 'настрой команды'
 *
 * Casual conversational inquiries like:
 * "Здравствуйте! Мы хотим забронировать стол на киноквиз, сколько это стоит?"
 * or
 * "Мы не хотим забронировать стол на киноквиз, мы хотим узнать результаты"
 * return false.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isWebBookingMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  // Mandatory modal structural markers from index.html template
  const hasGameMarker = lower.includes('выбранная игра');
  const hasTeamAndPlayers =
    lower.includes('команда') &&
    (lower.includes('количество игроков') || lower.includes('число игроков'));
  const hasMoodMarker = lower.includes('настрой команды');

  const hasStructuralMarker = hasGameMarker || hasTeamAndPlayers || hasMoodMarker;
  if (!hasStructuralMarker) {
    return false;
  }

  // Must also contain booking intent or action branding
  const hasBookingIntent =
    lower.includes('забронировать') ||
    lower.includes('action киноквиз') ||
    lower.includes('киноквиз в караганде');

  return hasBookingIntent;
}

/**
 * Formats a phone string to include leading + if missing.
 * @param {string} phone
 * @returns {string}
 */
function toInternationalPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return '';
  if (norm.startsWith('+')) return norm;
  if (norm.startsWith('8') && norm.length === 11) {
    return '+7' + norm.slice(1);
  }
  if (norm.startsWith('7') && norm.length === 11) {
    return '+' + norm;
  }
  return '+' + norm;
}

/**
 * Parses pre-filled website booking message into structured booking parameters.
 * If no modal fields (neither game nor team nor phone) are matched, returns
 * { isWebBooking: false } so conversational messages without modal fields never get auto-booked.
 *
 * @param {string} text
 * @param {string} [senderJid] - Sender WhatsApp JID for fallback phone
 * @returns {{ isWebBooking: boolean, data?: Object }}
 */
export function parseWebBookingMessage(text, senderJid = '') {
  if (!isWebBookingMessage(text)) {
    return { isWebBooking: false };
  }

  // 1. Chosen game: 📅 *Выбранная игра:* ${game} ${themeEmoji}
  let gameTitle = 'ACTION Киноквиз';
  let gameDate = 'Вторник 19:30';
  const gameMatch = text.match(/(?:^|\n)\s*(?:📅\s*)?\*?Выбранная игра[*:]*\s*([^\r\n]+)/i);
  if (gameMatch) {
    let rawGame = gameMatch[1].trim();
    // Strip trailing emoji & special symbols
    rawGame = rawGame.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u, '').trim();
    // Strip surrounding quotes
    rawGame = stripTypographicQuotes(rawGame);

    const dateMatch = rawGame.match(/^(.*?)\s*\(([^)]+)\)$/);
    if (dateMatch) {
      gameTitle = dateMatch[1].trim();
      gameDate = dateMatch[2].trim();
    } else {
      gameTitle = rawGame;
    }
  }

  // 2. Punchline / mood: 💬 *Настрой команды:* ${punchline}
  let punchline = '';
  const punchlineMatch = text.match(/(?:^|\n)\s*(?:💬\s*)?\*?Настрой команды[*:]*\s*([^\r\n]+)/i);
  if (punchlineMatch) {
    punchline = stripTypographicQuotes(punchlineMatch[1]);
  }

  // 3. Team: 👥 *Команда:* «${team}»
  let teamName = 'Команда';
  const teamMatch = text.match(/(?:^|\n)\s*(?:👥\s*)?\*?Команда[*:]*\s*([^\r\n]+)/i);
  if (teamMatch) {
    const rawTeam = stripTypographicQuotes(teamMatch[1]);
    if (rawTeam.length > 0) {
      teamName = rawTeam;
    }
  }

  // 4. Players count: ♟️ *Количество игроков:* ${players} чел.
  let playersCount = 4;
  let playersRaw = '';
  const playersMatch = text.match(
    /(?:^|\n)\s*(?:♟️?\s*)?\*?(?:Количество игроков|Число игроков|Игроков)[*:]*\s*([^\r\n]+)/i
  );
  if (playersMatch) {
    playersRaw = playersMatch[1].trim();
    if (/ищу команду/i.test(playersRaw)) {
      playersCount = 1;
    } else if (/больше 10/i.test(playersRaw) || /10\+/i.test(playersRaw)) {
      playersCount = 10;
    } else {
      const numMatch = playersRaw.match(/(\d+)/);
      if (numMatch) {
        playersCount = parseInt(numMatch[1], 10);
      }
    }
  }

  // 5. League: 🏆 *Лига:* ${league}
  let league = 'Падаваны (новички)';
  const leagueMatch = text.match(/(?:^|\n)\s*(?:🏆\s*)?\*?Лига[*:]*\s*([^\r\n]+)/i);
  if (leagueMatch) {
    league = stripTypographicQuotes(leagueMatch[1]);
  }

  // 6. Captain phone: 📱 *Телефон капитана:* ${phone}
  let captainPhone = '';
  const phoneMatch = text.match(
    /(?:^|\n)\s*(?:📱\s*)?\*?(?:Телефон капитана|Телефон|Номер)[*:]*\s*([^\r\n]+)/i
  );
  if (phoneMatch) {
    captainPhone = stripTypographicQuotes(phoneMatch[1]);
  }

  // Defect 1: If no modal fields (neither game nor team nor phone) are matched, return { isWebBooking: false }
  if (!gameMatch && !teamMatch && !phoneMatch) {
    return { isWebBooking: false };
  }

  // Defensive safe JID splitting
  const safeJid = typeof senderJid === 'string' ? senderJid : '';
  const jidPhonePart = safeJid ? safeJid.split('@')[0].split(':')[0] : '';
  if (!captainPhone && jidPhonePart) {
    captainPhone = jidPhonePart;
  }

  const normalizedPhone =
    toInternationalPhone(captainPhone) ||
    toInternationalPhone(jidPhonePart) ||
    '+77011863190';

  const notesParts = [
    punchline ? `Настрой: ${punchline}` : '',
    league ? `Лига: ${league}` : '',
    playersRaw ? `Состав: ${playersRaw}` : ''
  ].filter(Boolean);

  const parsedData = {
    teamName,
    team: teamName,
    captainName: 'Капитан',
    captain: 'Капитан',
    captainPhone: normalizedPhone,
    phone: normalizedPhone,
    playersCount: Math.max(1, Math.min(playersCount, 15)),
    players: Math.max(1, Math.min(playersCount, 15)),
    gameTitle,
    game: gameTitle,
    gameDate,
    league,
    punchline,
    notes: notesParts.join(' | ')
  };

  return {
    isWebBooking: true,
    data: parsedData
  };
}

export default {
  isWebBookingMessage,
  parseWebBookingMessage,
  stripTypographicQuotes
};
