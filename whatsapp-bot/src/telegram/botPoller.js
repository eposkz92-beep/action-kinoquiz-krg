import { exportBookingsToXlsxBuffer } from '../db/exportXlsx.js';
import { escapeHtml } from '../db/exportCsv.js';
import { getActiveGames } from '../games/gameLoader.js';
import { getGamesArchive } from '../games/gamesArchive.js';

/**
 * Builds an ASCII/Emoji progress bar
 * @param {number} current
 * @param {number} total
 * @param {number} [barLength=10]
 * @returns {string} e.g. "▓▓▓░░░░░░░ 30%"
 */
function makeProgressBar(current, total, barLength = 10) {
  if (total <= 0) return '░'.repeat(barLength) + ' 0%';
  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  const filled = Math.min(barLength, Math.round((pct / 100) * barLength));
  const empty = barLength - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
}

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
  const venueCapacity = Number(config.quiz?.venueCapacity) || 60; // Max capacity in Karaoke Bar "To Mesto"

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

  async function sendBookingsList(chatId, filterGame = null) {
    try {
      let bookings = db.bookings.list({ limit: 100 }) || [];
      if (filterGame) {
        bookings = bookings.filter(b => (b.game_title || '').toLowerCase().includes(filterGame.toLowerCase()));
      }

      if (bookings.length === 0) {
        await sendMessage(chatId, filterGame
          ? `📋 <b>Броней на игру «${escapeHtml(filterGame)}» пока нет.</b>`
          : '📋 <b>Броней пока нет.</b>'
        );
        return;
      }

      const price = Number(config.quiz?.pricePerPlayer) || 3000;
      let totalPlayers = 0;
      let totalSum = 0;

      const titleHeader = filterGame
        ? `📋 <b>БРОНИ: «${escapeHtml(filterGame)}»</b>`
        : '📋 <b>АКТУАЛЬНЫЙ СПИСОК БРОНЕЙ</b>';

      const lines = [titleHeader, ''];
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
        lines.push(`   👤 ${escapeHtml(b.captain_name)} • 📱 ${waLink}`);
        if (!filterGame) {
          lines.push(`   🎬 <i>${escapeHtml(b.game_title)} (${escapeHtml(b.game_date)})</i>`);
        }
        if (b.notes) {
          lines.push(`   📝 <i>${escapeHtml(b.notes)}</i>`);
        }
        lines.push('');
      });

      lines.push(`─────────────`);
      lines.push(`👥 <b>Всего игроков:</b> ${totalPlayers} чел.`);
      lines.push(`💰 <b>Ожидаемый сбор:</b> ${totalSum.toLocaleString('ru-RU')} ₸`);

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '🎬 Киномарафон (17.11)', callback_data: 'filter_game_1' },
            { text: '🎌 Аниме (24.11)', callback_data: 'filter_game_2' }
          ],
          [
            { text: '🌟 Все игры', callback_data: 'bookings' },
            { text: '📥 Скачать Excel', callback_data: 'excel' }
          ]
        ]
      };

      await sendMessage(chatId, lines.join('\n'), { reply_markup: replyMarkup });
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

      // Group by games
      const games = getActiveGames();
      const gameStatsLines = [];

      games.forEach((g) => {
        const gameBookings = bookings.filter(b => (b.game_title || '').includes(g.title) || (b.game_date || '').includes(g.dateStr));
        const players = gameBookings.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
        const freeSpots = Math.max(0, venueCapacity - players);
        const freeTables = Math.floor(freeSpots / 6);
        const bar = makeProgressBar(players, venueCapacity);

        gameStatsLines.push(`🎬 <b>«${escapeHtml(g.title)}»</b> (${escapeHtml(g.dateStr)})`);
        gameStatsLines.push(`   📊 Занято: <b>${players}</b> / ${venueCapacity} мест ${bar}`);
        gameStatsLines.push(`   🪑 Команд: ${gameBookings.length} • Свободно ~${freeTables} столов (${freeSpots} мест)`);
        gameStatsLines.push('');
      });

      const text = [
        '📊 <b>СТАТИСТИКА И ПОСАДКА ЗАЛА — ACTION КИНОКВИЗ</b>',
        '',
        `🎟️ <b>Всего броней:</b> ${bookings.length} (активных: ${activeBookings})`,
        `👥 <b>Всего игроков:</b> ${totalPlayers} чел.`,
        `💰 <b>Ожидаемый сбор:</b> ${totalSum.toLocaleString('ru-RU')} ₸`,
        `📇 <b>База контактов:</b> ${contacts.length} капитанов`,
        '',
        '📌 <b>Заполненность зала по играм («То Место»):</b>',
        '',
        gameStatsLines.join('\n'),
        `📍 <b>Адрес:</b> ${config.quiz?.location || 'Караоке-бар «То Место»'}`,
        `⏰ <b>Сформировано:</b> ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`
      ].join('\n');

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '📋 Список броней', callback_data: 'bookings' },
            { text: '📥 Скачать Excel', callback_data: 'excel' }
          ]
        ]
      };

      await sendMessage(chatId, text, { reply_markup: replyMarkup });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send stats');
    }
  }

  async function sendGamesArchive(chatId) {
    try {
      const archive = getGamesArchive(db, config);
      const lines = [
        '📜 <b>АРХИВ И ИСТОРИЯ ИГР — ACTION КИНОКВИЗ</b>',
        '',
        '🏆 <b>СЕЗОН 02 (Осень 2026):</b>',
        ''
      ];

      archive.pastGames.forEach((g, idx) => {
        lines.push(`<b>${idx + 1}. ${escapeHtml(g.title)}</b>`);
        lines.push(`   📅 <b>Дата:</b> ${g.dateLabel} • 📍 ${escapeHtml(g.venue)}`);
        lines.push(`   👥 <b>Итог:</b> ${g.teamsCount} команд • <b>${g.playersCount} игроков</b> (${g.revenue.toLocaleString('ru-RU')} ₸)`);
        if (g.winners) {
          lines.push(`   🏆 🥇 <b>${escapeHtml(g.winners.first)}</b> | 🥈 ${escapeHtml(g.winners.second)} | 🥉 ${escapeHtml(g.winners.third)}`);
        }
        if (g.notes) {
          lines.push(`   📝 <i>${escapeHtml(g.notes)}</i>`);
        }
        lines.push('');
      });

      if (archive.activeGames.length > 0) {
        lines.push('⏳ <b>АКТУАЛЬНЫЕ ИГРЫ В ЗАПИСИ:</b>');
        lines.push('');
        archive.activeGames.forEach((g, idx) => {
          lines.push(`<b>${idx + 1}. 🎬 ${escapeHtml(g.title)}</b> (${g.date})`);
          lines.push(`   👥 Записано: <b>${g.teamsCount}</b> команд • <b>${g.playersCount}</b> игроков (${g.revenue.toLocaleString('ru-RU')} ₸)`);
          lines.push(`   🟢 Статус: ${g.statusLabel}`);
          lines.push('');
        });
      }

      lines.push('─────────────');
      lines.push('📊 <b>ИТОГИ ПО СЕЗОНУ:</b>');
      lines.push(`• Игр проведено: <b>${archive.stats.completedGames}</b> (+ ${archive.stats.upcomingGames} в анонсе)`);
      lines.push(`• Всего участников: <b>${archive.stats.totalPlayers} чел.</b> (~${archive.stats.avgPlayersPerGame} чел./игра)`);
      lines.push(`• Общий сбор: <b>${archive.stats.totalRevenue.toLocaleString('ru-RU')} ₸</b> (~${archive.stats.avgRevenuePerGame.toLocaleString('ru-RU')} ₸/игра)`);

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '📊 Текущая посадка', callback_data: 'stats' },
            { text: '📋 Список броней', callback_data: 'bookings' }
          ],
          [
            { text: '📥 Скачать Excel (.xlsx)', callback_data: 'excel' }
          ]
        ]
      };

      await sendMessage(chatId, lines.join('\n'), { reply_markup: replyMarkup });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send games archive');
      await sendMessage(chatId, '❌ Ошибка при формировании архива игр.');
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
          { text: '📊 Статистика и посадка', callback_data: 'stats' },
          { text: '📜 Архив всех игр', callback_data: 'archive' }
        ],
        [
          { text: '📋 Список броней', callback_data: 'bookings' },
          { text: '📥 Скачать Excel (.xlsx)', callback_data: 'excel' }
        ],
        [
          { text: '🎬 Киномарафон (17.11)', callback_data: 'filter_game_1' },
          { text: '🎌 Аниме (24.11)', callback_data: 'filter_game_2' }
        ],
        [
          { text: '➕ Быстрая бронь', callback_data: 'help_add' },
          { text: '🔄 Обновить игры с GitHub', callback_data: 'sync' }
        ]
      ]
    };

    await sendMessage(chatId, text, { reply_markup: replyMarkup });
  }

  async function handleAddCommand(chatId, argsStr) {
    const games = getActiveGames();
    if (!argsStr || !argsStr.trim()) {
      const g1 = games[0] ? games[0].title : 'Киномарафон: 100 вопросов';
      const g2 = games[1] ? games[1].title : 'Культовые Аниме';

      const helpText = [
        '➕ <b>БЫСТРОЕ ДОБАВЛЕНИЕ БРОНИ ВРУЧНУЮ</b>',
        '',
        'Чтобы записать команду, отправьте сообщение в формате (через запятую):',
        '<code>/add Команда, Капитан, Телефон, Игроков, Номер игры, Примечание</code>',
        '',
        '👉 <b>Номера активных игр:</b>',
        `1 = ${escapeHtml(g1)} (17 ноября)`,
        `2 = ${escapeHtml(g2)} (24 ноября)`,
        '',
        '💡 <b>Пример (скопируйте и измените):</b>',
        '<code>/add Гарри Поттер, Гермиона, +77015554433, 6, 1, Столик у сцены</code>'
      ].join('\n');

      await sendMessage(chatId, helpText);
      return;
    }

    // Parse comma-separated arguments
    const parts = argsStr.split(',').map(s => s.trim());
    if (parts.length < 4) {
      await sendMessage(chatId, '⚠️ <b>Недостаточно данных.</b>\nФормат: <code>/add Команда, Капитан, Телефон, Игроков, [Игра 1/2], [Примечание]</code>');
      return;
    }

    const teamName = parts[0];
    const captainName = parts[1];
    const captainPhone = parts[2];
    const playersCount = parseInt(parts[3], 10) || 6;
    const gameChoice = parts[4] || '1';
    const notes = parts.slice(5).join(', ') || '';

    let chosenGame = games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    if (gameChoice === '2' && games[1]) {
      chosenGame = games[1];
    } else if (gameChoice.length > 2) {
      const match = games.find(g => g.title.toLowerCase().includes(gameChoice.toLowerCase()));
      if (match) chosenGame = match;
    }

    try {
      const booking = db.bookings.create({
        teamName,
        captainName,
        captainPhone,
        playersCount,
        gameTitle: chosenGame.title,
        gameDate: chosenGame.dateStr,
        source: 'telegram_manual',
        status: 'confirmed',
        notes
      });

      const successText = [
        '✅ <b>БРОНЬ УСПЕШНО ДОБАВЛЕНА!</b>',
        '',
        `👥 <b>Команда:</b> «${escapeHtml(booking.team_name)}»`,
        `👤 <b>Капитан:</b> ${escapeHtml(booking.captain_name)} (📱 ${escapeHtml(booking.captain_phone)})`,
        `🔢 <b>Игроков:</b> ${booking.players_count} чел.`,
        `🎬 <b>Игра:</b> ${escapeHtml(booking.game_title)} (${escapeHtml(booking.game_date)})`,
        notes ? `📝 <b>Примечание:</b> <i>${escapeHtml(notes)}</i>` : '',
        '',
        '<i>Бронь внесена в базу данных и сразу доступна в Excel и на панели!</i>'
      ].filter(Boolean).join('\n');

      await sendMessage(chatId, successText);
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to add manual booking');
      await sendMessage(chatId, `❌ Ошибка при создании брони: ${escapeHtml(err.message)}`);
    }
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
        const firstWord = text.split(/\s+/)[0].toLowerCase().replace('@actionquiz_bot', '');
        const args = text.slice(firstWord.length).trim();

        // Security check
        const isAuthorized = !targetChatId || chatId === targetChatId || chatId === '443670744' || String(msg.from?.id) === '443670744';

        if (!isAuthorized) {
          logger.warn({ chatId, from: msg.from?.username }, 'Unauthorized Telegram interaction ignored');
          return;
        }

        if (firstWord === '/start' || firstWord === '/admin' || firstWord === '/menu' || firstWord === 'панель' || firstWord === 'меню') {
          await sendMainMenu(chatId);
        } else if (firstWord === '/excel' || firstWord === '/xlsx') {
          await sendExcelDocument(chatId);
        } else if (firstWord === '/bookings' || firstWord === '/list' || firstWord === '/брони') {
          await sendBookingsList(chatId);
        } else if (firstWord === '/stats' || firstWord === '/статистика') {
          await sendStats(chatId);
        } else if (firstWord === '/archive' || firstWord === '/архив' || firstWord === '/игры' || firstWord === '/история') {
          await sendGamesArchive(chatId);
        } else if (firstWord === '/add' || firstWord === '/добавить') {
          await handleAddCommand(chatId, args);
        } else if (firstWord === '/sync' || firstWord === '/обновить') {
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
        } else if (data === 'archive') {
          await sendGamesArchive(chatId);
        } else if (data === 'bookings') {
          await sendBookingsList(chatId);
        } else if (data === 'filter_game_1') {
          await sendBookingsList(chatId, 'Киномарафон');
        } else if (data === 'filter_game_2') {
          await sendBookingsList(chatId, 'Аниме');
        } else if (data === 'excel') {
          await sendExcelDocument(chatId);
        } else if (data === 'help_add') {
          await handleAddCommand(chatId, '');
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
            { command: 'archive', description: '📜 Архив и история всех игр' },
            { command: 'stats', description: '📊 Статистика и посадка зала' },
            { command: 'bookings', description: '📋 Список зарегистрированных команд' },
            { command: 'excel', description: '📥 Скачать выгрузку в Excel (.xlsx)' },
            { command: 'add', description: '➕ Быстро добавить бронь вручную' },
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
