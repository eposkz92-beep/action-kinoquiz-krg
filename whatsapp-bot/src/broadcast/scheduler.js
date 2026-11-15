/**
 * src/broadcast/scheduler.js
 * Tuesday Game-Day Scheduler for ACTION Kinoquiz WhatsApp Bot
 *
 * Implements:
 * - Automated game-day reminder cron: Tuesday 12:00 (Asia/Almaty) via node-cron
 * - Tonight's game matching from active games catalog
 * - Confirmed bookings filtering (status = 'confirmed') from SQLite
 * - Captain deduplication (only 1 reminder per unique phone number)
 * - Broadcast enqueueing with personalized reminder template
 * - Manual on-demand execution (runNow) with custom date for instant offline testing
 * - Orderly cancellation (stop)
 */
import { normalizePhone } from '../db/database.js';
import { phoneToJid } from './broadcaster.js';

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

/**
 * Standard game-day reminder message template.
 */
export const DEFAULT_REMINDER_TEMPLATE =
  'Привет, {{captain}}! Напоминаем, что сегодня в {{time}} состоится киноквиз «{{game}}». ' +
  'Ждём команду «{{team}}» в баре «То Место» (пр. Нуркена Абдирова, 5). До встречи! 🎬';

/**
 * Calculates calendar details in the Karaganda/Almaty timezone (Asia/Almaty, UTC+5).
 *
 * @param {Date|string|number} [date=new Date()]
 * @param {string} [timezone='Asia/Almaty']
 * @returns {Object} { year, month, day, weekday, isTuesday, dateStrRu, isoDateStr }
 */
export function getAlmatyDateInfo(date = new Date(), timezone = 'Asia/Almaty') {
  const d = date instanceof Date ? date : new Date(date);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).formatToParts(d);

  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const year = parseInt(partMap.year, 10);
  const month = parseInt(partMap.month, 10);
  const day = parseInt(partMap.day, 10);
  const weekday = partMap.weekday; // 'Tue', 'Wed', etc.

  const isTuesday = weekday === 'Tue';
  const monthRu = RU_MONTHS[month - 1] || '';
  const dateStrRu = `${day} ${monthRu}`;
  const isoDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    year,
    month,
    day,
    weekday,
    isTuesday,
    dateStrRu,
    isoDateStr
  };
}

/**
 * Finds the game scheduled for tonight among the active games list.
 *
 * @param {Array<Object>} games - Array of active games from gameLoader
 * @param {Object} dateInfo - Date metadata from getAlmatyDateInfo
 * @returns {Object|null} Matching game info or null
 */
export function findTonightGame(games = [], dateInfo) {
  if (!Array.isArray(games) || games.length === 0) return null;

  const targetRu = (dateInfo?.dateStrRu || '').toLowerCase();
  const targetIso = (dateInfo?.isoDateStr || '').toLowerCase();

  // 1. Direct date match in dateStr or rawOptionValue
  for (const game of games) {
    const dStr = (game.dateStr || '').toLowerCase();
    const rawVal = (game.rawOptionValue || '').toLowerCase();
    if (
      (targetRu && (dStr.includes(targetRu) || rawVal.includes(targetRu))) ||
      (targetIso && (dStr.includes(targetIso) || rawVal.includes(targetIso)))
    ) {
      return game;
    }
  }

  // 2. Tuesday game match if today is Tuesday
  if (dateInfo?.isTuesday) {
    const tuesdayGame = games.find(
      (g) => g.dayName === 'ВТ' || g.status === 'Ближайшая игра' || g.status === 'ОТКРЫТА ЗАПИСЬ'
    );
    if (tuesdayGame) return tuesdayGame;
  }

  // 3. Fallback to first available game
  return games[0] || null;
}

/**
 * Retrieves confirmed bookings for a given game from the database.
 * Filters out cancelled or invalid bookings.
 *
 * @param {Object} db - Database instance
 * @param {Object} game - Game metadata object
 * @returns {Array<Object>} Confirmed bookings
 */
export function getTonightBookings(db, game) {
  if (!db?.bookings || !game) return [];
  const list = db.bookings.list({
    gameTitle: game.title,
    status: 'confirmed',
    limit: 500
  });
  return list.filter((b) => !b.status || b.status === 'confirmed');
}

/**
 * Initializes the Tuesday Game-Day Scheduler.
 *
 * @param {Object} options
 * @param {Object} options.db - SQLite database instance
 * @param {Function} options.getActiveGames - Game catalog loader function
 * @param {Object} options.broadcaster - Broadcaster instance with .enqueue()
 * @param {string} [options.cronExpr='0 12 * * 2'] - Cron expression (Tuesday 12:00)
 * @param {string} [options.timezone='Asia/Almaty'] - Timezone
 * @param {string} [options.reminderTemplate] - Custom reminder message template
 * @param {string} [options.parentDir] - Root directory for gameLoader
 * @param {Object} [options.cronModule] - Optional injectable node-cron module
 * @param {Object} [options.logger] - Optional logger
 * @returns {Promise<{ task: Object|null, runNow: Function, stop: Function }>}
 */
export async function initGameDayScheduler(options = {}) {
  const {
    db,
    getActiveGames,
    broadcaster,
    cronExpr = '0 12 * * 2',
    timezone = 'Asia/Almaty',
    reminderTemplate = DEFAULT_REMINDER_TEMPLATE,
    parentDir,
    cronModule = null,
    logger = null
  } = options;

  /**
   * Runs the game-day reminder workflow on demand.
   *
   * @param {Date|string|number} [customDate=new Date()]
   * @param {Object} [runOptions={}]
   * @param {boolean} [runOptions.force=false] - Ignore Tuesday check
   * @param {boolean} [runOptions.ignoreDayCheck=false] - Ignore Tuesday check
   * @param {Object} [runOptions.targetGame] - Explicit game override
   * @returns {Promise<Object>} Execution summary
   */
  async function runNow(customDate = new Date(), runOptions = {}) {
    const dateInfo = getAlmatyDateInfo(customDate, timezone);

    // Guard: Only run automatically on Tuesdays unless forced
    if (!runOptions.force && !dateInfo.isTuesday && !runOptions.ignoreDayCheck) {
      if (logger?.info) {
        logger.info('Scheduler: Current day is not Tuesday, skipping reminder execution.');
      }
      return { success: true, reason: 'not_tuesday', queuedCount: 0 };
    }

    const games = typeof getActiveGames === 'function' ? getActiveGames(parentDir) : [];
    if (!games || games.length === 0) {
      if (logger?.info) {
        logger.info('Scheduler: No active games found in catalog.');
      }
      return { success: true, reason: 'no_games_found', queuedCount: 0 };
    }

    const tonightGame = runOptions.targetGame || findTonightGame(games, dateInfo);
    if (!tonightGame) {
      if (logger?.info) {
        logger.info('Scheduler: No active game found for tonight.');
      }
      return { success: true, reason: 'no_game_tonight', queuedCount: 0 };
    }

    const confirmedBookings = getTonightBookings(db, tonightGame);
    if (confirmedBookings.length === 0) {
      if (logger?.info) {
        logger.info({ game: tonightGame.title }, 'Scheduler: No confirmed bookings for tonight.');
      }
      return {
        success: true,
        reason: 'no_confirmed_bookings',
        game: tonightGame,
        queuedCount: 0
      };
    }

    // Deduplicate by canonical WhatsApp JID so captains receive only 1 reminder
    const uniqueCaptains = new Map();
    for (const b of confirmedBookings) {
      const phoneKey = phoneToJid(b.captain_phone) || normalizePhone(b.captain_phone);
      if (phoneKey && !uniqueCaptains.has(phoneKey)) {
        uniqueCaptains.set(phoneKey, b);
      }
    }

    const recipients = Array.from(uniqueCaptains.values()).map((b) => ({
      phone: b.captain_phone,
      name: b.captain_name,
      team: b.team_name,
      params: {
        captain: b.captain_name,
        team: b.team_name,
        game: tonightGame.title,
        date: tonightGame.dateStr,
        time: tonightGame.timeStr || '19:30',
        players: b.players_count
      }
    }));

    let enqueueResult = { queuedCount: 0 };
    if (broadcaster && typeof broadcaster.enqueue === 'function') {
      enqueueResult = await broadcaster.enqueue({
        campaign: 'game_day_reminder_tuesday',
        recipients,
        messageTemplate: reminderTemplate,
        params: {
          game: tonightGame.title,
          date: tonightGame.dateStr,
          time: tonightGame.timeStr || '19:30'
        }
      });
    }

    return {
      success: true,
      game: tonightGame,
      bookingsCount: confirmedBookings.length,
      uniqueCaptainsCount: uniqueCaptains.size,
      queuedCount: enqueueResult.queuedCount ?? recipients.length
    };
  }

  // Load cron module (injectable or dynamic import)
  let cron = cronModule;
  if (!cron) {
    try {
      cron = (await import('node-cron')).default;
    } catch {
      if (logger?.warn) {
        logger.warn('node-cron module not available; running in on-demand mode');
      }
    }
  }

  let task = null;
  if (cron && typeof cron.schedule === 'function') {
    try {
      task = cron.schedule(
        cronExpr,
        async () => {
          try {
            await runNow(new Date());
          } catch (cronErr) {
            if (logger?.error) {
              logger.error({ err: cronErr }, 'Cron execution error');
            }
          }
        },
        { timezone }
      );
    } catch (schedErr) {
      if (logger?.error) {
        logger.error({ err: schedErr }, 'Failed to schedule cron');
      }
    }
  }

  function stop() {
    if (task && typeof task.stop === 'function') {
      task.stop();
    }
  }

  return {
    task,
    runNow,
    stop
  };
}

export default {
  initGameDayScheduler,
  getAlmatyDateInfo,
  findTonightGame,
  getTonightBookings,
  DEFAULT_REMINDER_TEMPLATE
};
