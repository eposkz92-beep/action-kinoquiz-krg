/**
 * src/broadcast/manualBroadcast.js
 * Manual / Ad-hoc Broadcast Engine for ACTION Kinoquiz WhatsApp Bot
 *
 * Implements:
 * - Ready-to-use message templates for Reschedule (Перенос), Cancellation (Отмена), and Urgent announcements (Объявления)
 * - Safe audience targeting: specific game captains vs. all contacts
 * - Phone deduplication and opt-out filtering
 * - Integration with serialized FIFO broadcaster queue
 */
import { normalizePhone } from '../db/database.js';

export const BROADCAST_TEMPLATES = {
  reschedule: `⚠️ *ACTION КИНОКВИЗ — ПЕРЕНОС ИГРЫ!*

Приветствуем, {{captain}}!
Сообщаем об изменении даты/времени проведения игры *«{{game}}»*:

📅 *Новая дата:* {{newDate}}
⏰ *Время сбора:* {{newTime}}
📍 *Место:* {{location}}
{{reasonLine}}
Бронь команды *«{{team}}»* ({{players}} чел.) автоматически сохранена за вами!
Если вашей команде не подходит новое время, просто напишите нам в ответном сообщении.

Приносим извинения за неудобства и ждём вас на игре! 🎬✨`,

  cancel: `❌ *ACTION КИНОКВИЗ — ОТМЕНА ИГРЫ*

Здравствуйте, {{captain}}!
К сожалению, игра *«{{game}}»* ({{date}}) отменяется.
{{reasonLine}}
Бронь команды *«{{team}}»* аннулирована. Все внесенные предоплаты (если были) будут возвращены в полном объеме.

Будем искренне рады видеть команду *«{{team}}»* на наших следующих играх! Расписание квизов доступно на сайте и в боте.

Приносим искренние извинения за доставленные неудобства! 🙏🎬`,

  custom: `📢 *ACTION КИНОКВИЗ — ВАЖНОЕ СООБЩЕНИЕ*

Здравствуйте, {{captain}} (команда *«{{team}}»*)!

{{text}}

📍 Караоке-бар «То Место», пр. Нуркена Абдирова, 5
Организаторы ACTION Киноквиз Караганда 🎬`
};

/**
 * Prepares the template and parameters for broadcast.
 *
 * @param {Object} options
 * @param {'reschedule'|'cancel'|'custom'} options.type - Template type
 * @param {string} [options.customText] - Custom announcement text
 * @param {string} [options.newDate] - New date for reschedule
 * @param {string} [options.newTime] - New time for reschedule
 * @param {string} [options.reason] - Reason for reschedule or cancel
 * @param {string} [options.location] - Venue location
 * @param {string} [options.overrideTemplate] - Fully custom template string
 * @returns {{ template: string, defaultParams: Object }}
 */
export function prepareBroadcastTemplate({
  type = 'custom',
  customText = '',
  newDate = '',
  newTime = '19:30',
  reason = '',
  location = 'Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
  overrideTemplate = null
} = {}) {
  let template = overrideTemplate || BROADCAST_TEMPLATES[type] || BROADCAST_TEMPLATES.custom;

  const reasonLine = reason && reason.trim() ? `📌 *Причина:* ${reason.trim()}\n` : '';

  const defaultParams = {
    newDate: newDate || 'будет сообщена дополнительно',
    newTime: newTime || '19:30',
    reasonLine,
    reason: reason || '',
    text: customText || '',
    location
  };

  return { template, defaultParams };
}

/**
 * Resolves recipients based on target audience:
 * - 'game': only captains registered for the specified game (deduplicated by phone)
 * - 'all': all subscribed contacts in the database
 *
 * @param {Object} options
 * @param {Object} options.db - SQLite database instance
 * @param {'game'|'all'} [options.target='game'] - Target audience
 * @param {string} [options.gameTitle] - Game title filter if target === 'game'
 * @param {string} [options.gameDate] - Game date filter if target === 'game'
 * @returns {Array<{ phone: string, name: string, team: string, params: Object }>}
 */
export function resolveBroadcastRecipients({ db, target = 'game', gameTitle = '', gameDate = '' }) {
  if (!db) return [];

  const seenPhones = new Set();
  const recipients = [];

  if (target === 'game') {
    const allBookings = db.bookings?.list({ limit: 1000 }) || [];
    const titleFilter = (gameTitle || '').toLowerCase().trim();
    const dateFilter = (gameDate || '').toLowerCase().trim();

    const filtered = allBookings.filter((b) => {
      if (b.status === 'cancelled') return false;
      const bTitle = (b.game_title || '').toLowerCase();
      const bDate = (b.game_date || '').toLowerCase();

      if (titleFilter && !bTitle.includes(titleFilter) && !titleFilter.includes(bTitle)) {
        return false;
      }
      if (dateFilter && !bDate.includes(dateFilter) && !dateFilter.includes(bDate)) {
        return false;
      }
      return true;
    });

    for (const b of filtered) {
      const normPhone = normalizePhone(b.captain_phone);
      if (!normPhone || seenPhones.has(normPhone)) continue;

      // Check if captain opted out
      const contact = db.contacts?.getByPhone ? db.contacts.getByPhone(normPhone) : null;
      if (contact && contact.is_subscribed === 0) continue;

      seenPhones.add(normPhone);
      recipients.push({
        phone: b.captain_phone,
        name: b.captain_name || 'Капитан',
        team: b.team_name || 'Команда',
        params: {
          captain: b.captain_name || 'Капитан',
          team: b.team_name || 'Команда',
          game: b.game_title || 'ACTION Киноквиз',
          date: b.game_date || '',
          players: b.players_count || '5-6',
          phone: normPhone
        }
      });
    }
  } else {
    // Target 'all' contacts
    const contacts = db.contacts?.listForBroadcast ? db.contacts.listForBroadcast() : (db.contacts?.list({ limit: 2000 }) || []);
    for (const c of contacts) {
      if (c.is_subscribed === 0) continue;
      const normPhone = normalizePhone(c.phone);
      if (!normPhone || seenPhones.has(normPhone)) continue;

      seenPhones.add(normPhone);
      recipients.push({
        phone: c.phone,
        name: c.name || 'Капитан',
        team: c.team_name || 'Команда',
        params: {
          captain: c.name || 'Капитан',
          team: c.team_name || 'Команда',
          phone: normPhone
        }
      });
    }
  }

  return recipients;
}

/**
 * Dispatches a manual broadcast campaign through the broadcaster queue.
 *
 * @param {Object} options
 * @param {Object} options.db - Database DAO
 * @param {Object} options.broadcaster - Serialized FIFO Broadcaster instance
 * @param {'reschedule'|'cancel'|'custom'} options.type - Broadcast type
 * @param {'game'|'all'} [options.target='game'] - Target audience
 * @param {string} [options.gameTitle] - Game title
 * @param {string} [options.gameDate] - Game date
 * @param {string} [options.customText] - Custom announcement text
 * @param {string} [options.newDate] - New date
 * @param {string} [options.newTime] - New time
 * @param {string} [options.reason] - Reason
 * @param {string} [options.overrideTemplate] - Custom template override
 * @param {Function} [options.telegramAlertFn] - Optional callback to notify Telegram organizer chat
 * @returns {Promise<{ ok: boolean, batchId: string|null, queuedCount: number, type: string, target: string }>}
 */
export async function executeManualBroadcast({
  db,
  broadcaster,
  type = 'custom',
  target = 'game',
  gameTitle = '',
  gameDate = '',
  customText = '',
  newDate = '',
  newTime = '19:30',
  reason = '',
  overrideTemplate = null,
  telegramAlertFn = null
} = {}) {
  if (!broadcaster) {
    throw new Error('Broadcaster instance is required');
  }

  const { template, defaultParams } = prepareBroadcastTemplate({
    type,
    customText,
    newDate,
    newTime,
    reason,
    overrideTemplate
  });

  const recipients = resolveBroadcastRecipients({
    db,
    target,
    gameTitle,
    gameDate
  });

  if (recipients.length === 0) {
    return {
      ok: true,
      batchId: null,
      queuedCount: 0,
      recipientsCount: 0,
      type,
      target,
      message: 'Нет подходящих получателей для рассылки'
    };
  }

  const campaign = `manual_${type}_${Date.now()}`;
  const enqueueResult = await broadcaster.enqueue({
    recipients,
    messageTemplate: template,
    campaign,
    params: defaultParams
  });

  // Optional Telegram alert
  if (typeof telegramAlertFn === 'function') {
    try {
      await telegramAlertFn({
        type,
        target,
        gameTitle,
        recipientsCount: recipients.length,
        template,
        batchId: enqueueResult.batchId
      });
    } catch (e) {
      // Non-fatal
    }
  }

  return {
    ok: true,
    batchId: enqueueResult.batchId,
    queuedCount: enqueueResult.queuedCount,
    recipientsCount: recipients.length,
    type,
    target,
    campaign
  };
}
