/**
 * src/telegram/notifier.js
 * Telegram Bot API Alerting Module for ACTION Kinoquiz WhatsApp Bot
 *
 * Dispatches structured HTML notifications to organizer chat upon new bookings.
 * Features:
 * - Native fetch with AbortSignal timeout (10s)
 * - Automatic retry with backoff for HTTP 429 and 5xx errors
 * - Immediate abort without retry on 4xx client errors
 * - HTML character escaping and Karaganda local timezone formatting (UTC+5)
 * - Clickable WhatsApp links for captains
 * - Complete error isolation: never throws unhandled rejections
 */
import config from '../config.js';

/**
 * Sanitizes HTML special characters for Telegram HTML parse mode.
 * Replaces '&' first to prevent double-escaping, then '<', '>', and '"'.
 *
 * @param {any} str - Input text
 * @returns {string} Sanitized string safe for Telegram HTML mode
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalizes a phone number for WhatsApp direct link (wa.me/<digits>).
 * Strips all non-digit characters and converts Kazakh trunk prefix (8 -> 7).
 *
 * @param {string|number} phone - Raw phone number
 * @returns {string} Digits-only string (e.g. '77011863190') or empty string
 */
export function cleanPhoneForWa(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) {
    digits = '7' + digits.slice(1);
  }
  return digits;
}

/**
 * Formats a currency amount with standard ASCII spaces as thousand separators.
 * Avoids unicode NO-BREAK SPACE (\u00A0) for cross-platform test reliability.
 *
 * @param {number|string} amount - Number or numeric string
 * @returns {string} E.g. '18 000'
 */
export function formatCurrency(amount) {
  const num = Number(amount);
  if (isNaN(num)) return '0';
  return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Formats a date into Karaganda local time (Asia/Almaty, UTC+5).
 * Format: DD.MM.YYYY, HH:mm:ss
 *
 * @param {Date|string|number} [dateInput] - Date instance, timestamp, or SQLite datetime string
 * @param {string} [timezone='Asia/Almaty'] - Timezone identifier
 * @returns {string} Formatted timestamp string (e.g. '15.11.2026, 02:00:00')
 */
export function formatKaragandaTime(dateInput, timezone = 'Asia/Almaty') {
  let date = dateInput ? new Date(dateInput) : new Date();
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateInput.trim())) {
    // Explicit SQLite localtime format - treat as Karaganda local time (+05:00)
    date = new Date(dateInput.trim().replace(' ', 'T') + '+05:00');
  } else if (isNaN(date.getTime()) && typeof dateInput === 'string') {
    // Handle SQLite datetime 'YYYY-MM-DD HH:mm:ss'
    const iso = dateInput.replace(' ', 'T') + 'Z';
    date = new Date(iso);
  }
  if (isNaN(date.getTime())) {
    date = new Date();
  }

  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date);

    const m = {};
    for (const p of parts) {
      m[p.type] = p.value;
    }
    return `${m.day}.${m.month}.${m.year}, ${m.hour}:${m.minute}:${m.second}`;
  } catch {
    return date.toISOString();
  }
}

/**
 * Formats a booking alert card in Telegram HTML mode.
 * Supports both snake_case (database rows) and camelCase (object literals).
 *
 * @param {Object} booking - Booking details
 * @param {Object} [options={}] - Formatting options
 * @param {number} [options.pricePerPlayer] - Price per player in Tenge
 * @param {string} [options.timezone] - Timezone for timestamp display
 * @returns {string} HTML-formatted message
 */
export function formatBookingAlert(booking, options = {}) {
  options = options || {};
  const b = booking || {};

  const teamName = b.team_name || b.teamName || 'Без названия';
  const captainName = b.captain_name || b.captainName || 'Не указан';
  const captainPhone = b.captain_phone || b.captainPhone || '';
  const playersCount = Number(b.players_count || b.playersCount || 0);
  const gameTitle = b.game_title || b.gameTitle || 'Киноквиз ACTION';
  const gameDate = b.game_date || b.gameDate || 'Скоро';
  const bookingId = b.id || b.bookingId || '—';
  const source = b.source || 'whatsapp_bot';
  const notes = b.notes || '';
  const createdAt = b.created_at || b.createdAt || new Date();

  const isWeb = source === 'website' || source === 'web' || Boolean(options.isWebBooking);
  const isNoTeam = Boolean(
    b.no_team ||
    b.noTeam ||
    (notes && notes.includes('ИЩЕТ КОМАНДУ')) ||
    teamName === 'Ищу команду' ||
    teamName.toLowerCase().includes('ищу команду') ||
    teamName.toLowerCase().includes('без команды')
  );

  const header = isNoTeam
    ? '⚠️ <b>НОВАЯ ЗАЯВКА: ИГРОК БЕЗ КОМАНДЫ!</b> 🙋‍♂️'
    : isWeb
      ? '🌐 <b>НОВАЯ ЗАЯВКА С САЙТА — ACTION КИНОКВИЗ</b>'
      : '🎟️ <b>НОВАЯ БРОНЬ СТОЛА — ACTION КИНОКВИЗ</b>';

  const sourceBadge = isWeb
    ? '🌐 <b>Официальный сайт</b> (онлайн-форма)'
    : escapeHtml(source);

  const pricePerPlayer = Number(options.pricePerPlayer || config?.quiz?.pricePerPlayer || 3000);
  const tz = options.timezone || config?.timezone || 'Asia/Almaty';
  const totalFee = formatCurrency(playersCount * pricePerPlayer);

  const cleanPhone = cleanPhoneForWa(captainPhone);
  const waLink = cleanPhone
    ? `<a href="https://wa.me/${cleanPhone}">${escapeHtml(captainPhone)}</a>`
    : (escapeHtml(captainPhone) || 'Не указан');

  const formattedCreated = formatKaragandaTime(createdAt, tz);

  const lines = [
    header,
    ''
  ];

  if (isNoTeam) {
    lines.push('🚨 <b>ВНИМАНИЕ ОРГАНИЗАТОРАМ:</b>');
    lines.push('👉 <b>У игрока нет команды! Нужно подобрать команду / распределить игрока!</b>');
    lines.push('');
  }

  lines.push(
    `🎬 <b>Игра:</b> ${escapeHtml(gameTitle)}`,
    `📅 <b>Дата:</b> ${escapeHtml(gameDate)}`,
    '',
    `👥 <b>Команда:</b> «${escapeHtml(teamName)}»${isNoTeam ? ' <i>(нет команды / ищет состав)</i>' : ''}`,
    `🔢 <b>Игроков:</b> ${playersCount} чел. (взнос: ${totalFee} ₸)`,
    '',
    `👤 <b>Капитан:</b> ${escapeHtml(captainName)}`,
    `📱 <b>WhatsApp:</b> ${waLink}`
  );

  if (notes) {
    lines.push(`📝 <b>Лига / Примечания:</b> <i>${escapeHtml(notes)}</i>`);
  }

  lines.push('');
  lines.push(`🆔 <b>ID брони:</b> #${escapeHtml(bookingId)}`);
  lines.push(`ℹ️ <b>Источник:</b> ${sourceBadge}`);
  lines.push(`⏰ <b>Создана:</b> ${formattedCreated} (UTC+5)`);

  return lines.join('\n');
}

/**
 * Sends a generic raw HTML message to the organizer Telegram chat.
 * Catches all errors and returns a status object; never throws an unhandled rejection.
 *
 * @param {string} text - HTML message text
 * @param {Object} [customConfig=null] - Optional override config
 * @param {Object} [options={}] - Execution options
 * @returns {Promise<{ success: boolean, messageId?: number, skipped?: boolean, error?: string }>}
 */
export async function sendTelegramMessage(text, customConfig = null, options = {}) {
  try {
    const cfg = customConfig || config;
    const botToken = cfg?.botToken || cfg?.telegram?.botToken || '';
    const chatId = cfg?.chatId || cfg?.telegram?.chatId || '';

    if (!botToken || !chatId) {
      return {
        success: false,
        skipped: true,
        error: 'Telegram botToken or chatId is not configured'
      };
    }

    const fetchFn = options.fetch || globalThis.fetch;
    const sleepFn = options.sleepFn || ((ms) => new Promise(r => setTimeout(r, ms)));
    const timeoutMs = options.timeoutMs || 10000;
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let signal;
        let timer = null;

        if (typeof AbortSignal?.timeout === 'function') {
          signal = AbortSignal.timeout(timeoutMs);
        } else {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);
          signal = controller.signal;
        }

        const messagePayload = {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          link_preview_options: {
            is_disabled: true
          }
        };

        const replyMarkup = options.reply_markup || options.replyMarkup;
        if (replyMarkup) {
          messagePayload.reply_markup = replyMarkup;
        }

        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(messagePayload),
          signal
        });

        if (timer) clearTimeout(timer);

        if (response.ok) {
          const data = await response.json();
          if (data && data.ok) {
            return {
              success: true,
              messageId: data.result?.message_id
            };
          }
          return {
            success: false,
            error: data?.description || 'Unknown Telegram error'
          };
        }

        // Handle HTTP 429 Too Many Requests
        if (response.status === 429) {
          let data = null;
          try {
            data = await response.json();
          } catch {}

          const retryAfterSec = Number(
            data?.parameters?.retry_after ||
            response.headers?.get?.('retry-after') ||
            1
          );

          if (attempt < maxRetries) {
            await sleepFn(retryAfterSec * 1000);
            continue;
          }

          return {
            success: false,
            error: `Rate limit exceeded (HTTP 429): ${data?.description || 'Too Many Requests'}`
          };
        }

        // Handle HTTP 5xx Server Errors (transient)
        if (response.status >= 500) {
          let data = null;
          try {
            data = await response.json();
          } catch {}

          if (attempt < maxRetries) {
            const backoffMs = 500 * Math.pow(2, attempt);
            await sleepFn(backoffMs);
            continue;
          }

          return {
            success: false,
            error: `Telegram server error (HTTP ${response.status}): ${data?.description || response.statusText || 'Server Error'}`
          };
        }

        // Handle HTTP 4xx Client Errors (non-transient, fail immediately without retry)
        let data = null;
        try {
          data = await response.json();
        } catch {}

        return {
          success: false,
          error: `Telegram API error (HTTP ${response.status}): ${data?.description || response.statusText || 'Client Error'}`
        };
      } catch (err) {
        if (attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt);
          await sleepFn(backoffMs);
          continue;
        }

        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
          success: false,
          error: isTimeout
            ? `Request timed out after ${timeoutMs}ms`
            : `Network error: ${err.message || String(err)}`
        };
      }
    }

    return {
      success: false,
      error: 'Max retries exceeded'
    };
  } catch (outerErr) {
    return {
      success: false,
      error: outerErr?.message || String(outerErr)
    };
  }
}

/**
 * Sends a structured booking alert to the organizer Telegram chat.
 * Catches all errors and returns a status object; never throws an unhandled rejection.
 *
 * @param {Object} booking - Booking details object
 * @param {Object} [customConfig=null] - Optional override config { botToken, chatId } or { telegram: { botToken, chatId } }
 * @param {Object} [options={}] - Execution options
 * @returns {Promise<{ success: boolean, messageId?: number, skipped?: boolean, error?: string }>}
 */
export async function sendBookingAlert(booking, customConfig = null, options = {}) {
  const formattedText = formatBookingAlert(booking, options);
  const bookingId = booking?.id || booking?.bookingId;

  let replyMarkup = options?.reply_markup !== undefined ? options.reply_markup : options?.replyMarkup;
  if (replyMarkup === undefined && bookingId) {
    replyMarkup = {
      inline_keyboard: [
        [
          { text: '🗑️ Удалить эту бронь', callback_data: `del_ask_${bookingId}` }
        ]
      ]
    };
  }

  return sendTelegramMessage(formattedText, customConfig, {
    ...options,
    reply_markup: replyMarkup
  });
}

/**
 * Sends a notification to the organizer chat when an urgent or ad-hoc broadcast is launched.
 *
 * @param {Object} payload
 * @param {string} payload.type - 'reschedule' | 'cancel' | 'custom'
 * @param {string} payload.target - 'game' | 'all'
 * @param {string} [payload.gameTitle] - Game title if target is 'game'
 * @param {number} payload.recipientsCount - Number of recipients queued
 * @param {string} payload.template - Preview of message template
 * @param {string} [payload.batchId] - Batch identifier
 * @param {Object} [customConfig=null]
 * @param {Object} [options={}]
 * @returns {Promise<{ success: boolean, messageId?: number }>}
 */
export async function sendBroadcastLaunchAlert(payload, customConfig = null, options = {}) {
  const typeLabels = {
    reschedule: '⚠️ Перенос игры',
    cancel: '❌ Отмена игры',
    custom: '📢 Срочное объявление',
    freeform: '💬 Произвольный текст'
  };
  const typeLabel = typeLabels[payload.type] || '📢 Рассылка';
  const targetLabel = payload.target === 'game'
    ? `Записанные на игру: «${escapeHtml(payload.gameTitle || 'Выбранная игра')}»`
    : 'Все контакты из базы';

  const preview = escapeHtml((payload.template || '').slice(0, 320) + ((payload.template || '').length > 320 ? '...' : ''));

  const text = [
    `📢 <b>ЗАПУЩЕНА СРОЧНАЯ РАССЫЛКА WHATSAPP</b>`,
    ``,
    `📌 <b>Тип:</b> ${typeLabel}`,
    `🎯 <b>Аудитория:</b> ${targetLabel}`,
    `👥 <b>Получателей:</b> <b>${payload.recipientsCount}</b> чел. (очередь FIFO с анти-бан задержкой)`,
    `🆔 <b>ID пакета:</b> <code>${payload.batchId || 'N/A'}</code>`,
    ``,
    `📝 <b>Текст рассылки:</b>`,
    `<pre>${preview}</pre>`,
    ``,
    `<i>Сообщения отправляются с паузой 3–7 сек с симуляцией набора текста.</i>`
  ].join('\n');

  return sendTelegramMessage(text, customConfig, options);
}

export default {
  sendBookingAlert,
  sendTelegramMessage,
  sendBroadcastLaunchAlert,
  formatBookingAlert,
  escapeHtml,
  cleanPhoneForWa,
  formatKaragandaTime,
  formatCurrency
};
