import { exportBookingsToXlsxBuffer } from '../db/exportXlsx.js';
import { escapeHtml } from '../db/exportCsv.js';

/**
 * Initializes and starts Telegram bot polling for organizer command & button handling.
 * Zero-dependency: uses native Node.js global fetch and FormData.
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance with bookings DAO
 * @param {Object} params.config - Global config
 * @param {Object} params.logger - Logger
 * @param {Function} [params.syncRepositoryGames] - Function to trigger GitHub sync
 * @returns {{ stop: Function }} Controller to stop polling
 */
export function startTelegramPoller({ db, config, logger, syncRepositoryGames }) {
  const token = config.telegram?.botToken;
  const targetChatId = String(config.telegram?.chatId || '');

  if (!token) {
    logger.warn('Telegram botToken not configured, poller will not start');
    return { stop: () => {} };
  }

  let isRunning = true;
  let offset = 0;
  let abortController = null;

  async function sendMessage(chatId, text, extra = {}) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...extra
        })
      });
      return await res.json();
    } catch (err) {
      logger.error({ err: err.message, chatId }, 'Failed to send Telegram message');
      return null;
    }
  }

  async function answerCallbackQuery(callbackQueryId, text = '') {
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text || undefined
        })
      });
    } catch (e) {}
  }

  async function sendExcelDocument(chatId) {
    try {
      const pricePerPlayer = Number(config.quiz?.pricePerPlayer) || 3000;
      const buf = exportBookingsToXlsxBuffer(db, { pricePerPlayer });
      const now = new Date();
      const dateStr = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' }).replace(/\./g, '-');
      const filename = `kinoquiz_bookings_${dateStr}.xlsx`;

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('caption', `📊 <b>Таблица броней ACTION Киноквиз</b> (.xlsx)\nСформировано: ${now.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`);
      formData.append('parse_mode', 'HTML');
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      formData.append('document', blob, filename);

      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });
      return await res.json();
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send Excel document to Telegram');
      await sendMessage(chatId, '❌ Ошибка при формировании Excel файла.');
      return null;
    }
  }

  async function sendBookingsList(chatId) {
    try {
      const bookings = db.bookings.list({ limit: 100 }) || [];
      if (bookings.length === 0) {
        await sendMessage(chatId, '📋 <b>Броней пока нет.</b>');
        return;
      }

      const price = Number(config.quiz?.pricePerPlayer) || 3000;
      let totalPlayers = 0;
      let totalSum = 0;

      const lines = ['📋 <b>СПИСОК БРОНЕЙ — ACTION КИНОКВИЗ</b>', ''];
      bookings.forEach((b, i) => {
        const players = Number(b.players_count) || 0;
        const fee = players * price;
        totalPlayers += players;
        totalSum += fee;

        let rawPhone = String(b.captain_phone || '');
        let digits = rawPhone.replace(/\D/g, '');
        if (digits.startsWith('8') && digits.length === 11) digits = '7' + digits.slice(1);
        const waLink = digits ? `<a href="https://wa.me/${digits}">${escapeHtml(rawPhone)}</a>` : escapeHtml(rawPhone);

        const statusIcon = b.status === 'cancelled' ? '❌' : '✅';

        lines.push(`<b>${i + 1}. «${escapeHtml(b.team_name)}»</b> ${statusIcon} — 👥 <b>${players} чел.</b> (${fee.toLocaleString('ru-RU')} ₸)`);
        lines.push(`   👤 Капитан: ${escapeHtml(b.captain_name)} • 📱 ${waLink}`);
        lines.push(`   🎬 Игра: <i>${escapeHtml(b.game_title)} (${escapeHtml(b.game_date)})</i>`);
        if (b.notes) {
          lines.push(`   📝 Примечание: <i>${escapeHtml(b.notes)}</i>`);
        }
        lines.push('');
      });

      lines.push(`─────────────`);
      lines.push(`👥 <b>ИТОГО ИГРОКОВ:</b> ${totalPlayers} чел.`);
      lines.push(`💰 <b>ОЖИДАЕМЫЙ СБОР:</b> ${totalSum.toLocaleString('ru-RU')} ₸`);

      await sendMessage(chatId, lines.join('\n'));
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send bookings list');
      await sendMessage(chatId, '❌ Ошибка при получении списка броней.');
    }
  }

  async function sendStats(chatId) {
    try {
      const bookings = db.bookings.list({ limit: 1000 }) || [];
      const contacts = db.contacts ? db.contacts.list({ limit: 1000 }) : [];
      const price = Number(config.quiz?.pricePerPlayer) || 3000;
      const totalPlayers = bookings.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
      const totalSum = totalPlayers * price;
      const activeBookings = bookings.filter(b => b.status !== 'cancelled').length;

      const text = [
        '📊 <b>ПАРИЛКА СТАТИСТИКИ — ACTION КИНОКВИЗ</b>',
        '',
        `🎟️ <b>Всего броней:</b> ${bookings.length} (активных: ${activeBookings})`,
        `👥 <b>Всего игроков:</b> ${totalPlayers} чел.`,
        `💰 <b>Ожидаемый сбор:</b> ${totalSum.toLocaleString('ru-RU')} ₸`,
        `📇 <b>База контактов:</b> ${contacts.length} чел.`,
        `📍 <b>Локация:</b> ${config.quiz?.location || 'Караоке-бар «То Место»'}`,
        `⏰ <b>Обновлено:</b> ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`
      ].join('\n');

      await sendMessage(chatId, text);
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send stats');
    }
  }

  async function sendMainMenu(chatId) {
    const text = [
      '🎬 <b>ACTION Киноквиз Караганда — Панель управления</b>',
      '',
      'Выберите нужное действие:'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Статистика', callback_data: 'stats' },
          { text: '📋 Список броней', callback_data: 'bookings' }
        ],
        [
          { text: '📥 Скачать Excel (.xlsx)', callback_data: 'excel' }
        ],
        [
          { text: '🔄 Обновить игры с GitHub', callback_data: 'sync' }
        ]
      ]
    };

    await sendMessage(chatId, text, { reply_markup: replyMarkup });
  }

  async function handleSync(chatId) {
    if (typeof syncRepositoryGames === 'function') {
      await sendMessage(chatId, '⏳ Запускаю синхронизацию расписания с GitHub...');
      try {
        const res = await syncRepositoryGames();
        await sendMessage(chatId, res.ok
          ? `✅ <b>Расписание успешно обновлено!</b>\n<code>${escapeHtml(res.output)}</code>`
          : `⚠️ Ошибка синхронизации: ${escapeHtml(res.error)}`
        );
      } catch (e) {
        await sendMessage(chatId, `❌ Ошибка: ${escapeHtml(e.message)}`);
      }
    } else {
      await sendMessage(chatId, 'ℹ️ Функция синхронизации доступна только на сервере.');
    }
  }

  async function handleUpdate(update) {
    try {
      // 1. Handle incoming text commands
      if (update.message && update.message.text) {
        const msg = update.message;
        const chatId = String(msg.chat.id);
        const text = msg.text.trim();
        const cmd = text.split(' ')[0].toLowerCase().replace('@actionquiz_bot', '');

        // Security check: only respond in the designated group or from admins
        const isAuthorized = !targetChatId || chatId === targetChatId || chatId === '443670744' || String(msg.from?.id) === '443670744';

        if (!isAuthorized) {
          logger.warn({ chatId, from: msg.from?.username }, 'Unauthorized Telegram interaction ignored');
          return;
        }

        if (cmd === '/start' || cmd === '/admin' || cmd === '/menu' || cmd === 'панель' || cmd === 'меню') {
          await sendMainMenu(chatId);
        } else if (cmd === '/excel' || cmd === '/xlsx') {
          await sendExcelDocument(chatId);
        } else if (cmd === '/bookings' || cmd === '/list' || cmd === '/брони') {
          await sendBookingsList(chatId);
        } else if (cmd === '/stats' || cmd === '/статистика') {
          await sendStats(chatId);
        } else if (cmd === '/sync' || cmd === '/обновить') {
          await handleSync(chatId);
        }
      }

      // 2. Handle inline button callbacks
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = String(cq.message?.chat?.id);
        const data = cq.data;

        await answerCallbackQuery(cq.id);

        if (data === 'stats') {
          await sendStats(chatId);
        } else if (data === 'bookings') {
          await sendBookingsList(chatId);
        } else if (data === 'excel') {
          await sendExcelDocument(chatId);
        } else if (data === 'sync') {
          await handleSync(chatId);
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Error in Telegram handleUpdate');
    }
  }

  // Polling loop
  (async function runPoll() {
    logger.info('Telegram Bot Poller started for @actionquiz_bot');

    // Register bot commands list in Telegram menu
    try {
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'menu', description: 'Панель управления ACTION Киноквиз' },
            { command: 'excel', description: '📥 Скачать выгрузку в Excel (.xlsx)' },
            { command: 'bookings', description: '📋 Список зарегистрированных команд' },
            { command: 'stats', description: '📊 Статистика сбора и игроков' },
            { command: 'sync', description: '🔄 Обновить игры с GitHub' }
          ]
        })
      });
    } catch (e) {}

    while (isRunning) {
      try {
        abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 35000);

        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`;
        const res = await fetch(url, { signal: abortController.signal });
        clearTimeout(timeout);

        if (!res.ok) {
          await new Promise(r => setTimeout(r, 4000));
          continue;
        }

        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            await handleUpdate(update);
          }
        }
      } catch (err) {
        if (!isRunning) break;
        // Wait 3 seconds on network error before retrying
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    logger.info('Telegram Bot Poller stopped');
  })();

  return {
    stop: () => {
      isRunning = false;
      if (abortController) {
        try { abortController.abort(); } catch (e) {}
      }
    }
  };
}

export default startTelegramPoller;
