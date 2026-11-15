/**
 * src/dialog/fsm.js
 * 5-State Finite State Machine for ACTION Kinoquiz WhatsApp Booking
 */
import { normalizePhone } from '../db/database.js';
import { getActiveGames } from '../games/gameLoader.js';
import {
  getMainMenuCard,
  getScheduleCard,
  getVenueCard,
  getRulesCard,
  getContactsCard,
  formatConfirmationCard
} from './menu.js';
import {
  isWebBookingMessage,
  parseWebBookingMessage,
  stripTypographicQuotes
} from './webBookingParser.js';
import config from '../config.js';

export const FSM_STATES = {
  IDLE: 'IDLE',
  AWAITING_TEAM_NAME: 'AWAITING_TEAM_NAME',
  AWAITING_PLAYERS_COUNT: 'AWAITING_PLAYERS_COUNT',
  AWAITING_GAME_SELECTION: 'AWAITING_GAME_SELECTION',
  AWAITING_CAPTAIN_NAME: 'AWAITING_CAPTAIN_NAME',
  AWAITING_CAPTAIN_PHONE: 'AWAITING_CAPTAIN_PHONE'
};

const CANCEL_COMMANDS = new Set([
  '0', 'отмена', 'стоп', 'меню', 'отменить', 'назад', 'отбой', 'cancel', 'stop', 'menu', 'exit', 'reset'
]);

const NO_GAMES_MESSAGE =
  'На данный момент открытых для бронирования игр нет. Следите за анонсами в Instagram @action_kinoquiz_krg или обратитесь к организатору (+7 701 186 31 90).';

/**
 * Parses SQLite datetime string or Date object into a JS Date.
 * @param {string|Date} str
 * @returns {Date|null}
 */
export function parseSqliteDate(str) {
  if (!str) return null;
  if (str instanceof Date) return str;
  const s = String(str).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Checks whether a session has timed out due to 20+ minutes of inactivity.
 * @param {Object} session
 * @param {Date|number|string} now
 * @returns {boolean}
 */
export function isSessionTimedOut(session, now = new Date()) {
  if (!session || !session.updated_at || session.state === FSM_STATES.IDLE) {
    return false;
  }
  const timeoutMinutes = config.quiz?.sessionTimeoutMinutes || 20;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const lastActive = parseSqliteDate(session.updated_at);
  if (!lastActive) return false;
  const currentTime = now instanceof Date ? now : new Date(now);
  return currentTime.getTime() - lastActive.getTime() > timeoutMs;
}

/**
 * Checks whether a JID or string represents a masked WhatsApp LID rather than a real phone number.
 * @param {string} jid
 * @returns {boolean}
 */
export function isLidJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (jid.includes('@lid')) return true;
  const part = jid.split('@')[0].split(':')[0];
  // WhatsApp LIDs are 13+ digit numbers (often starting with 31), not valid Kazakh/CIS phones
  if (/^\d{13,}$/.test(part)) return true;
  return false;
}

/**
 * Extracts a phone number from arbitrary user text (e.g. "Азамат +7 701 123 45 67").
 * @param {string} text
 * @returns {{ raw: string, formatted: string }|null}
 */
export function extractPhoneFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/(?:\+?7|8)?[\s\-(]*7\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
  if (m) {
    const raw = m[0];
    const formatted = toInternationalPhone(raw);
    if (formatted) return { raw, formatted };
  }
  return null;
}

/**
 * Formats a phone string into international format.
 * Rejects masked WhatsApp LIDs.
 * @param {string} phone
 * @returns {string}
 */
export function toInternationalPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return '';
  // Masked LIDs have 13+ digits without a leading +
  if (norm.length >= 13 && !String(phone).trim().startsWith('+')) {
    return '';
  }
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
 * Renders the game selection list prompt.
 * @param {Array<Object>} games
 * @returns {string}
 */
function formatGameSelectionPrompt(games = []) {
  const lines = [
    '📅 *Выберите игру из списка (отправьте номер):*',
    ''
  ];

  games.forEach((g, idx) => {
    const numEmoji = idx < 9 ? `${idx + 1}️⃣` : `${idx + 1}.`;
    lines.push(`${numEmoji} *${g.title}*`);
    const datePart = g.dateStr ? `${g.dayName ? g.dayName + ', ' : ''}${g.dateStr}` : 'Каждый вторник';
    const timePart = g.timeStr || '19:30';
    lines.push(`   📅 ${datePart} в ${timePart}`);
    lines.push(`   💰 ${g.price || '3 000 ₸'} / чел. · ${g.status || 'ОТКРЫТА ЗАПИСЬ'}`);
    lines.push('');
  });

  lines.push('_Отправьте номер выбранной игры (1, 2...):_');
  return lines.join('\n');
}

/**
 * Handles incoming WhatsApp message and advances the booking FSM.
 * 
 * @param {Object} params
 * @param {string} params.jid - User WhatsApp JID
 * @param {string} params.text - Message text
 * @param {string} [params.pushName] - WhatsApp pushName
 * @param {Object} params.db - Initialized database client
 * @param {Object} [params.gameCatalog] - Game catalog loader/module
 * @param {string} [params.parentDir] - Parent directory for catalog files
 * @param {Date|number|string} [params.now] - Current timestamp for timeout checks
 * @returns {Promise<{ replies: string[], bookingCreated?: Object, state?: string }>}
 */
export async function handleIncomingMessage({
  jid,
  text,
  pushName = '',
  db,
  gameCatalog = null,
  parentDir = null,
  now = new Date()
}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (!trimmed) {
    if (!db || !db.sessions) {
      return { replies: [], state: FSM_STATES.IDLE };
    }
    const session = db.sessions.get(jid);
    if (session && session.state !== FSM_STATES.IDLE) {
      return {
        replies: ['❌ Сообщение не может быть пустым. Пожалуйста, введите ответ:'],
        state: session.state
      };
    }
    return { replies: [], state: FSM_STATES.IDLE };
  }

  if (!db || !db.sessions) {
    return { replies: [], state: FSM_STATES.IDLE };
  }

  // Safe JID extraction
  const safeJid = typeof jid === 'string' ? jid : '';
  const jidPhonePart = safeJid ? safeJid.split('@')[0].split(':')[0] : '';

  // Fetch session first
  let session = db.sessions.get(jid) || { jid, state: FSM_STATES.IDLE, data: {} };

  const replies = [];

  // Helper to load active games
  async function loadGames() {
    if (gameCatalog && typeof gameCatalog.getActiveGames === 'function') {
      return gameCatalog.getActiveGames(parentDir);
    }
    return getActiveGames(parentDir);
  }

  // 1. Web Modal Interceptor
  if (isWebBookingMessage(trimmed)) {
    const parsed = parseWebBookingMessage(trimmed, jid);
    if (parsed.isWebBooking && parsed.data) {
      const captainPhone =
        parsed.data.captainPhone ||
        toInternationalPhone(jidPhonePart) ||
        '+77011863190';

      const booking = db.bookings.create({
        teamName: parsed.data.teamName,
        captainName: parsed.data.captainName || pushName || 'Капитан',
        captainPhone: captainPhone,
        playersCount: parsed.data.playersCount,
        gameTitle: parsed.data.gameTitle,
        gameDate: parsed.data.gameDate,
        source: 'web_modal',
        status: 'confirmed',
        notes: parsed.data.notes || ''
      });

      // Clear any session in progress
      db.sessions.clear(jid);

      const card = formatConfirmationCard({
        ...booking,
        league: parsed.data.league,
        notes: parsed.data.notes
      });

      return {
        replies: [card],
        bookingCreated: booking,
        state: FSM_STATES.IDLE
      };
    }
  }

  // 2. Refresh session and check 20-min inactivity timeout
  session = db.sessions.get(jid) || { jid, state: FSM_STATES.IDLE, data: {} };

  if (session.state !== FSM_STATES.IDLE && isSessionTimedOut(session, now)) {
    db.sessions.clear(jid);
    session = { jid, state: FSM_STATES.IDLE, data: {} };
    replies.push(
      '⏳ *Время сессии истекло.*\nВы не отправляли сообщений более 20 минут. Начните бронирование сначала.'
    );
  }

  const lower = trimmed.toLowerCase();

  // 3. Global Cancellation Commands
  if (CANCEL_COMMANDS.has(lower)) {
    if (session.state !== FSM_STATES.IDLE) {
      db.sessions.clear(jid);
      replies.push('🔄 *Бронирование отменено.*');
      replies.push(getMainMenuCard());
      return { replies, state: FSM_STATES.IDLE };
    }

    if (lower === 'стоп' || lower === 'stop') {
      const phone = toInternationalPhone(jidPhonePart);
      if (phone) {
        db.contacts.setSubscription(phone, 0);
      }
      replies.push(
        '🔕 *Вы успешно отписались от авторассылок ACTION Киноквиз.*\nЧтобы возобновить подписку, напишите любое сообщение.'
      );
      return { replies, state: FSM_STATES.IDLE };
    }

    replies.push(getMainMenuCard());
    return { replies, state: FSM_STATES.IDLE };
  }

  // 4. FSM State Handling
  switch (session.state) {
    case FSM_STATES.IDLE: {
      // Check options 1-5 or keyword navigation
      if (
        lower === '1' ||
        lower.includes('забронировать') ||
        lower.includes('бронь') ||
        lower.includes('запись') ||
        lower.includes('играть')
      ) {
        const games = await loadGames();
        if (!games || games.length === 0) {
          replies.push(NO_GAMES_MESSAGE);
          return { replies, state: FSM_STATES.IDLE };
        }

        db.sessions.set(jid, FSM_STATES.AWAITING_TEAM_NAME, { availableGames: games });
        replies.push(
          [
            '🎬 *Бронирование стола на ACTION Киноквиз* 🍿',
            '',
            'Как называется ваша команда? Введите название:',
            '',
            '_Для отмены в любой момент отправьте *0*._'
          ].join('\n')
        );
        return { replies, state: FSM_STATES.AWAITING_TEAM_NAME };
      }

      if (
        lower === '2' ||
        lower.includes('афиша') ||
        lower.includes('игры') ||
        lower.includes('расписание')
      ) {
        const games = await loadGames();
        replies.push(getScheduleCard(games));
        return { replies, state: FSM_STATES.IDLE };
      }

      if (
        lower === '3' ||
        lower.includes('адрес') ||
        lower.includes('где') ||
        lower.includes('2gis') ||
        lower.includes('локация')
      ) {
        replies.push(getVenueCard());
        return { replies, state: FSM_STATES.IDLE };
      }

      if (
        lower === '4' ||
        lower.includes('правила') ||
        lower.includes('лиги') ||
        lower.includes('формат')
      ) {
        replies.push(getRulesCard());
        return { replies, state: FSM_STATES.IDLE };
      }

      if (
        lower === '5' ||
        lower.includes('контакт') ||
        lower.includes('организатор') ||
        lower.includes('телефон')
      ) {
        replies.push(getContactsCard());
        return { replies, state: FSM_STATES.IDLE };
      }

      // Default: unrecognized input in IDLE replies with Main Menu
      replies.push(getMainMenuCard());
      return { replies, state: FSM_STATES.IDLE };
    }

    case FSM_STATES.AWAITING_TEAM_NAME: {
      const cleanTeam = stripTypographicQuotes(trimmed);
      if (cleanTeam.length < 2) {
        replies.push('❌ Название команды должно содержать минимум 2 символа.\nПожалуйста, введите название команды:');
        return { replies, state: FSM_STATES.AWAITING_TEAM_NAME };
      }

      const nextData = { ...session.data, teamName: cleanTeam };
      db.sessions.set(jid, FSM_STATES.AWAITING_PLAYERS_COUNT, nextData);

      replies.push(
        [
          `👥 Отлично, команда *«${cleanTeam}»*!`,
          '',
          'Укажите *количество человек* в команде (от 2 до 10 игроков):',
          '',
          '_Оптимальный состав команды — 4–8 человек. Взнос: 3 000 ₸ с игрока._'
        ].join('\n')
      );
      return { replies, state: FSM_STATES.AWAITING_PLAYERS_COUNT };
    }

    case FSM_STATES.AWAITING_PLAYERS_COUNT: {
      const match = trimmed.match(/\d+/);
      const count = match ? parseInt(match[0], 10) : null;

      if (!count || !Number.isInteger(count) || count < 2 || count > 10) {
        replies.push(
          [
            '❌ Пожалуйста, укажите число игроков от *2 до 10* за одним столом.',
            '',
            '_Если вас больше 10, рекомендуем забронировать 2 стола._'
          ].join('\n')
        );
        return { replies, state: FSM_STATES.AWAITING_PLAYERS_COUNT };
      }

      let games = session.data.availableGames;
      if (!Array.isArray(games) || games.length === 0) {
        games = await loadGames();
      }

      if (!games || games.length === 0) {
        db.sessions.clear(jid);
        replies.push(NO_GAMES_MESSAGE);
        return { replies, state: FSM_STATES.IDLE };
      }

      const nextData = { ...session.data, playersCount: count, availableGames: games };
      db.sessions.set(jid, FSM_STATES.AWAITING_GAME_SELECTION, nextData);

      replies.push(formatGameSelectionPrompt(games));
      return { replies, state: FSM_STATES.AWAITING_GAME_SELECTION };
    }

    case FSM_STATES.AWAITING_GAME_SELECTION: {
      const games = session.data.availableGames || [];
      if (!games || games.length === 0) {
        db.sessions.clear(jid);
        replies.push(NO_GAMES_MESSAGE);
        return { replies, state: FSM_STATES.IDLE };
      }

      const idx = parseInt(trimmed, 10);

      if (!Number.isInteger(idx) || idx < 1 || idx > games.length) {
        replies.push(`❌ Пожалуйста, выберите номер игры из списка (от 1 до ${games.length}):`);
        return { replies, state: FSM_STATES.AWAITING_GAME_SELECTION };
      }

      const selectedGame = games[idx - 1];
      const nextData = { ...session.data, selectedGame };
      db.sessions.set(jid, FSM_STATES.AWAITING_CAPTAIN_NAME, nextData);

      const dateDisplay = selectedGame.dateStr
        ? `${selectedGame.dateStr} в ${selectedGame.timeStr || '19:30'}`
        : 'Каждый вторник в 19:30';

      replies.push(
        [
          `🎮 Вы выбрали: *${selectedGame.title}* (${dateDisplay})`,
          '',
          '👤 Введите *имя капитана* команды (или контактного лица для связи):'
        ].join('\n')
      );
      return { replies, state: FSM_STATES.AWAITING_CAPTAIN_NAME };
    }

    case FSM_STATES.AWAITING_CAPTAIN_NAME: {
      const cleanCaptain = stripTypographicQuotes(trimmed);
      if (cleanCaptain.length < 2) {
        replies.push('❌ Пожалуйста, укажите имя капитана (минимум 2 символа):');
        return { replies, state: FSM_STATES.AWAITING_CAPTAIN_NAME };
      }

      // 1. Check if user provided phone along with name (e.g. "Азамат +7 701 123 45 67")
      const phoneInText = extractPhoneFromText(cleanCaptain);
      let captainName = cleanCaptain;
      let explicitPhone = '';
      if (phoneInText) {
        explicitPhone = phoneInText.formatted;
        captainName = stripTypographicQuotes(
          cleanCaptain.replace(phoneInText.raw, '').replace(/[(),:;]/g, ' ').trim()
        );
      }

      // 2. Check if sender JID is an LID (masked ID like 31181613584540@lid)
      const isLid = isLidJid(safeJid);

      // If no explicit phone was provided and this is an LID, ask for the phone number
      if (!explicitPhone && isLid) {
        const nextData = { ...session.data, captainName: captainName || cleanCaptain };
        db.sessions.set(jid, FSM_STATES.AWAITING_CAPTAIN_PHONE, nextData);
        replies.push(
          [
            `👤 Капитан: *${captainName || cleanCaptain}*`,
            '',
            '📱 Введите *номер телефона* капитана для подтверждения брони:',
            '_(например: +7 701 123 45 67 или 87011234567)_'
          ].join('\n')
        );
        return { replies, state: FSM_STATES.AWAITING_CAPTAIN_PHONE };
      }

      const captainPhone =
        explicitPhone ||
        toInternationalPhone(jidPhonePart) ||
        '+77011863190';
      const selectedGame = session.data.selectedGame || {};
      const gameTitle = selectedGame.title || 'ACTION Киноквиз';
      const gameDate = selectedGame.dateStr || 'Вторник 19:30';
      const timeStr = selectedGame.timeStr || '19:30';

      const booking = db.bookings.create({
        teamName: session.data.teamName,
        captainName: captainName || cleanCaptain,
        captainPhone: captainPhone,
        playersCount: session.data.playersCount,
        gameTitle: gameTitle,
        gameDate: gameDate,
        source: 'whatsapp_bot',
        status: 'confirmed',
        notes: `Время: ${timeStr}`
      });

      // Clear session after successful booking
      db.sessions.clear(jid);

      const card = formatConfirmationCard(booking);
      replies.push(card);

      return {
        replies,
        bookingCreated: booking,
        state: FSM_STATES.IDLE
      };
    }

    case FSM_STATES.AWAITING_CAPTAIN_PHONE: {
      const cleanDigits = trimmed.replace(/\D/g, '');
      if (cleanDigits.length < 10 || cleanDigits.length > 15) {
        replies.push(
          [
            '❌ Пожалуйста, введите корректный номер телефона капитана (от 10 цифр):',
            '_(например: +7 701 123 45 67 или 87011234567)_'
          ].join('\n')
        );
        return { replies, state: FSM_STATES.AWAITING_CAPTAIN_PHONE };
      }

      const captainPhone = toInternationalPhone(trimmed) || ('+' + cleanDigits);
      const captainName = session.data.captainName || 'Капитан';
      const selectedGame = session.data.selectedGame || {};
      const gameTitle = selectedGame.title || 'ACTION Киноквиз';
      const gameDate = selectedGame.dateStr || 'Вторник 19:30';
      const timeStr = selectedGame.timeStr || '19:30';

      const booking = db.bookings.create({
        teamName: session.data.teamName,
        captainName: captainName,
        captainPhone: captainPhone,
        playersCount: session.data.playersCount,
        gameTitle: gameTitle,
        gameDate: gameDate,
        source: 'whatsapp_bot',
        status: 'confirmed',
        notes: `Время: ${timeStr}`
      });

      // Clear session after successful booking
      db.sessions.clear(jid);

      const card = formatConfirmationCard(booking);
      replies.push(card);

      return {
        replies,
        bookingCreated: booking,
        state: FSM_STATES.IDLE
      };
    }

    default: {
      db.sessions.clear(jid);
      replies.push(getMainMenuCard());
      return { replies, state: FSM_STATES.IDLE };
    }
  }
}

export default {
  FSM_STATES,
  handleIncomingMessage,
  isSessionTimedOut,
  parseSqliteDate
};
