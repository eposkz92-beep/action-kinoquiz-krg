import { exportBookingsToXlsxBuffer } from '../db/exportXlsx.js';
import { escapeHtml } from '../db/exportCsv.js';
import { getActiveGames } from '../games/gameLoader.js';
import { getGamesArchive } from '../games/gamesArchive.js';
import QRCode from 'qrcode';
import {
  executeManualBroadcast,
  prepareBroadcastTemplate,
  resolveBroadcastRecipients,
  BROADCAST_TEMPLATES
} from '../broadcast/manualBroadcast.js';
import { personalizeMessage } from '../broadcast/broadcaster.js';
import { sendBroadcastLaunchAlert, sendBookingAlert } from './notifier.js';

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
export function startTelegramPoller({ db, config, logger, syncRepositoryGames, broadcaster, getWhatsAppStatus, restartAuth }) {
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

  async function editOrSendMessage(chatId, messageId, text, extra = {}) {
    if (messageId) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...extra
          })
        });
        const data = await res.json();
        if (data.ok) return data;
      } catch (e) {}
    }
    return await sendMessage(chatId, text, extra);
  }

  const tgSessions = new Map();

  const MAIN_REPLY_KEYBOARD = {
    keyboard: [
      [{ text: '📊 Статистика' }, { text: '📋 Список броней' }],
      [{ text: '📢 Срочная рассылка' }, { text: '➕ Добавить бронь' }],
      [{ text: '📜 Архив игр' }, { text: '📥 Скачать Excel' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };

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
          ],
          [
            { text: '« В главное меню', callback_data: 'menu' }
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
          ],
          [
            { text: '« В главное меню', callback_data: 'menu' }
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
            { text: '📥 Скачать Excel (.xlsx)', callback_data: 'excel' },
            { text: '« В главное меню', callback_data: 'menu' }
          ]
        ]
      };

      await sendMessage(chatId, lines.join('\n'), { reply_markup: replyMarkup });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to send games archive');
      await sendMessage(chatId, '❌ Ошибка при формировании архива игр.');
    }
  }

  async function sendWhatsAppStatusOrQr(chatId) {
    const st = typeof getWhatsAppStatus === 'function'
      ? getWhatsAppStatus()
      : { isConnected: false, botPhone: null, currentQrCode: null };

    if (st.isConnected) {
      const text = [
        '🟢 <b>WHATSAPP ПОДКЛЮЧЕН И РАБОТАЕТ!</b>',
        '',
        `📱 <b>Номер бота:</b> +${escapeHtml(st.botPhone || '77011863190')}`,
        '🤖 <b>Статус:</b> В сети, принимает брони и отправляет рассылки.',
        '',
        '<i>Если вы хотите сменить номер или перепривязать WhatsApp заново, нажмите кнопку ниже:</i>'
      ].join('\n');

      const replyMarkup = {
        inline_keyboard: [
          [{ text: '🔄 Сменить номер / Новый QR', callback_data: 'wa_reconnect' }],
          [{ text: '« В главное меню', callback_data: 'menu' }]
        ]
      };

      await sendMessage(chatId, text, { reply_markup: replyMarkup });
      return;
    }

    if (st.currentQrCode) {
      try {
        const buf = await QRCode.toBuffer(st.currentQrCode, { width: 600, margin: 2 });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', [
          '📱 <b>QR-КОД ДЛЯ ПОДКЛЮЧЕНИЯ WHATSAPP</b>',
          '',
          '1. Откройте <b>WhatsApp</b> на телефоне с номером организатора',
          '2. Перейдите в <b>Связанные устройства</b> → <b>Привязка устройства</b>',
          '3. Наведите камеру на этот QR-код',
          '',
          '⏳ <i>QR-код обновляется автоматически каждые 20–30 секунд.</i>'
        ].join('\n'));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', new Blob([buf], { type: 'image/png' }), 'whatsapp_qr.png');

        const replyMarkup = JSON.stringify({
          inline_keyboard: [
            [{ text: '🔄 Обновить QR-код', callback_data: 'wa_qr' }],
            [{ text: '« В главное меню', callback_data: 'menu' }]
          ]
        });
        formData.append('reply_markup', replyMarkup);

        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          body: formData
        });
        return;
      } catch (err) {
        logger.error({ err: err.message }, 'Failed to send QR photo to Telegram');
      }
    }

    await sendMessage(chatId, '⏳ <b>Генерирую QR-код для подключения WhatsApp...</b>\nПодождите 3–5 секунд и нажмите кнопку «Обновить QR-код».', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Обновить QR-код', callback_data: 'wa_qr' }],
          [{ text: '« В главное меню', callback_data: 'menu' }]
        ]
      }
    });
  }

  async function sendMainMenu(chatId, messageId = null) {
    tgSessions.delete(chatId);
    const games = getActiveGames();
    const g1 = games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    const g2 = games[1] || { title: 'Культовые Аниме', dateStr: '24 ноября' };

    const allBookings = db.bookings?.list({ limit: 1000 }) || [];
    const bGame1 = allBookings.filter(b => b.status !== 'cancelled' && ((b.game_title || '').includes(g1.title) || (b.game_date || '').includes(g1.dateStr)));
    const bGame2 = allBookings.filter(b => b.status !== 'cancelled' && ((b.game_title || '').includes(g2.title) || (b.game_date || '').includes(g2.dateStr)));

    const pGame1 = bGame1.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
    const pGame2 = bGame2.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);

    const contactsCount = db.contacts ? db.contacts.list({ limit: 1000 }).length : 0;
    const freeTables1 = Math.max(0, Math.floor((venueCapacity - pGame1) / 6));

    const shortG1 = g1.title.length > 20 ? g1.title.slice(0, 18) + '…' : g1.title;
    const shortG2 = g2.title.length > 20 ? g2.title.slice(0, 18) + '…' : g2.title;

    const waStatus = typeof getWhatsAppStatus === 'function' ? getWhatsAppStatus() : null;
    let waLine = '🤖 <b>WhatsApp:</b> 🟢 Подключен (+7 701 186 31 90)';
    if (waStatus && !waStatus.isConnected) {
      waLine = '🤖 <b>WhatsApp:</b> 🟡 Требуется привязка QR';
    } else if (waStatus?.botPhone) {
      waLine = `🤖 <b>WhatsApp:</b> 🟢 +${escapeHtml(waStatus.botPhone)} (в сети)`;
    }

    const text = [
      '🎬 <b>ACTION Киноквиз Караганда — Панель управления</b>',
      '',
      `🎯 <b>Ближайшая игра:</b> «${escapeHtml(g1.title)}» (${escapeHtml(g1.dateStr)})`,
      `   👥 <b>${bGame1.length}</b> команд (${pGame1} чел.) • Свободно ~${freeTables1} столов`,
      '',
      `🗓 <b>Следующая игра:</b> «${escapeHtml(g2.title)}» (${escapeHtml(g2.dateStr)})`,
      `   👥 <b>${bGame2.length}</b> команд (${pGame2} чел.)`,
      '',
      `📱 <b>База контактов:</b> ${contactsCount} капитанов`,
      waLine,
      '',
      '<i>Выберите нужное действие кнопками ниже:</i>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '📊 Посадка зала', callback_data: 'stats' },
          { text: '📋 Список броней', callback_data: 'bookings' }
        ],
        [
          { text: '📢 Срочная рассылка', callback_data: 'bc_start' },
          { text: '➕ Добавить бронь', callback_data: 'add_start' }
        ],
        [
          { text: '📱 WhatsApp QR / Статус', callback_data: 'wa_qr' },
          { text: '📥 Скачать Excel', callback_data: 'excel' }
        ],
        [
          { text: `🎬 ${escapeHtml(shortG1)}`, callback_data: 'filter_game_1' },
          { text: `🎌 ${escapeHtml(shortG2)}`, callback_data: 'filter_game_2' }
        ],
        [
          { text: '📜 Архив всех игр', callback_data: 'archive' },
          { text: '🔄 Обновить игры с GitHub', callback_data: 'sync' }
        ]
      ]
    };

    if (messageId) {
      await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
    } else {
      await sendMessage(chatId, text, {
        reply_markup: {
          ...replyMarkup,
          ...MAIN_REPLY_KEYBOARD
        }
      });
    }
  }

  // --- INTERACTIVE BROADCAST WIZARD ---

  async function startBroadcastWizard(chatId, messageId = null) {
    const games = getActiveGames();
    const g1 = games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    const g2 = games[1] || { title: 'Культовые Аниме', dateStr: '24 ноября' };

    const countG1 = resolveBroadcastRecipients({ db, target: 'game', gameTitle: g1.title }).length;
    const countG2 = resolveBroadcastRecipients({ db, target: 'game', gameTitle: g2.title }).length;
    const totalContacts = resolveBroadcastRecipients({ db, target: 'all' }).length;

    tgSessions.set(chatId, {
      flow: 'broadcast',
      step: 'choose_target',
      g1,
      g2,
      countG1,
      countG2,
      totalContacts
    });

    const shortG1 = g1.title.length > 22 ? g1.title.slice(0, 20) + '…' : g1.title;
    const shortG2 = g2.title.length > 22 ? g2.title.slice(0, 20) + '…' : g2.title;

    const text = [
      '📢 <b>РАССЫЛКА В WHATSAPP — ШАГ 1 ИЗ 3</b>',
      '',
      '<b>Кому именно отправить сообщение?</b>',
      '',
      '1️⃣ 🎯 <b>БЛИЖАЙШАЯ ИГРА:</b>',
      `   🎬 «${escapeHtml(g1.title)}» (${escapeHtml(g1.dateStr)})`,
      `   👥 <b>${countG1}</b> команд(ы) записано`,
      '   <i>(Сообщение получат только капитаны этой игры)</i>',
      '',
      '2️⃣ 🗓 <b>СЛЕДУЮЩАЯ ИГРА:</b>',
      `   🎌 «${escapeHtml(g2.title)}» (${escapeHtml(g2.dateStr)})`,
      `   👥 <b>${countG2}</b> команд(ы) записано`,
      '   <i>(Сообщение получат только капитаны этой игры)</i>',
      '',
      '3️⃣ 🌐 <b>ВСЯ БАЗА КОНТАКТОВ:</b>',
      `   👥 Все подписанные капитаны (<b>${totalContacts}</b> чел.)`,
      '',
      '🛡️ <i>Защита от бана: FIFO-очередь с паузой 3–7 сек + симуляция набора текста.</i>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: `🎯 1. Ближайшая: ${shortG1} (${countG1} ком.)`, callback_data: 'bc_tgt_0' }
        ],
        [
          { text: `🗓 2. Следующая: ${shortG2} (${countG2} ком.)`, callback_data: 'bc_tgt_1' }
        ],
        [
          { text: `🌐 3. ВСЯ база контактов (${totalContacts} чел.)`, callback_data: 'bc_tgt_all' }
        ],
        [
          { text: '📊 Статус очереди', callback_data: 'bc_status' },
          { text: '« В главное меню', callback_data: 'menu' }
        ]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function chooseBroadcastType(chatId, messageId, targetCode) {
    const session = tgSessions.get(chatId) || {};
    const games = getActiveGames();
    const g1 = session.g1 || games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    const g2 = session.g2 || games[1] || { title: 'Культовые Аниме', dateStr: '24 ноября' };

    let target = 'game';
    let gameTitle = '';
    let gameDate = '';
    let targetLabel = '';
    let recipientsCount = 0;

    if (targetCode === '0') {
      target = 'game';
      gameTitle = g1.title;
      gameDate = g1.dateStr;
      targetLabel = `Ближайшая игра «${g1.title}» (${g1.dateStr})`;
      recipientsCount = resolveBroadcastRecipients({ db, target: 'game', gameTitle }).length;
    } else if (targetCode === '1') {
      target = 'game';
      gameTitle = g2.title;
      gameDate = g2.dateStr;
      targetLabel = `Следующая игра «${g2.title}» (${g2.dateStr})`;
      recipientsCount = resolveBroadcastRecipients({ db, target: 'game', gameTitle }).length;
    } else {
      target = 'all';
      targetLabel = 'ВСЯ база контактов (все игры)';
      recipientsCount = resolveBroadcastRecipients({ db, target: 'all' }).length;
    }

    session.flow = 'broadcast';
    session.step = 'choose_type';
    session.target = target;
    session.targetCode = targetCode;
    session.gameTitle = gameTitle;
    session.gameDate = gameDate;
    session.targetLabel = targetLabel;
    session.recipientsCount = recipientsCount;
    tgSessions.set(chatId, session);

    if (recipientsCount === 0) {
      const emptyText = [
        '⚠️ <b>НЕТ ЗАРЕГИСТРИРОВАННЫХ КОМАНД</b>',
        '',
        `На выбранную игру (<b>${escapeHtml(targetLabel)}</b>) пока нет активных зарегистрированных команд.`,
        '',
        'Пожалуйста, выберите другую аудиторию или вернитесь в меню.'
      ].join('\n');

      const emptyMarkup = {
        inline_keyboard: [
          [{ text: '« Назад к выбору аудитории', callback_data: 'bc_start' }],
          [{ text: '« В главное меню', callback_data: 'menu' }]
        ]
      };
      await editOrSendMessage(chatId, messageId, emptyText, { reply_markup: emptyMarkup });
      return;
    }

    const text = [
      '📢 <b>РАССЫЛКА В WHATSAPP — ШАГ 2 ИЗ 3</b>',
      '',
      '🎯 <b>ВЫБРАННАЯ АУДИТОРИЯ:</b>',
      `👉 <b>${escapeHtml(targetLabel)}</b>`,
      `👥 <b>Получателей:</b> <b>${recipientsCount}</b> команд / контактов`,
      '',
      '<b>Выберите тему сообщения:</b>',
      '',
      '⚠️ <b>1. Перенос игры</b>',
      'Изменение даты/времени. Бронь команды и столик сохраняются.',
      '',
      '❌ <b>2. Отмена игры</b>',
      'Уведомление об отмене игры и полном возврате предоплаты.',
      '',
      '📢 <b>3. Срочное объявление</b>',
      'Любое важное сообщение (сбор за 30 мин, схема заезда, правила).'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '⚠️ 1. Перенос игры', callback_data: 'bc_kind_reschedule' },
          { text: '❌ 2. Отмена игры', callback_data: 'bc_kind_cancel' }
        ],
        [
          { text: '📢 3. Срочное объявление', callback_data: 'bc_kind_custom' }
        ],
        [
          { text: '« Назад к выбору аудитории', callback_data: 'bc_start' }
        ]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function promptBroadcastContent(chatId, messageId, kind) {
    const session = tgSessions.get(chatId);
    if (!session) {
      await startBroadcastWizard(chatId, messageId);
      return;
    }

    session.type = kind;
    session.step = 'awaiting_broadcast_text';
    tgSessions.set(chatId, session);

    const backCb = `bc_back_tgt_${session.targetCode || '0'}`;

    if (kind === 'reschedule') {
      const text = [
        '⚠️ <b>ПЕРЕНОС ИГРЫ: ВВЕДИТЕ ДАННЫЕ</b>',
        '',
        `🎯 <b>Аудитория:</b> ${escapeHtml(session.targetLabel)}`,
        `👥 <b>Получателей:</b> <b>${session.recipientsCount}</b> команд`,
        '',
        '👇 <b>Просто напишите сообщением новую дату и причину:</b>',
        '<i>Например:</i>',
        '«Переносим на среду 20 ноября в 19:30 из-за ремонта зала»',
        '',
        '⚡ <b>Или выберите один из готовых вариантов в 1 клик:</b>'
      ].join('\n');

      const replyMarkup = {
        inline_keyboard: [
          [{ text: '📅 На ср 20.11 в 19:30 (Тех. работы)', callback_data: 'bc_p_resched_1' }],
          [{ text: '📅 На чт 21.11 в 19:30 (Замена мультимедиа)', callback_data: 'bc_p_resched_2' }],
          [{ text: '📅 На сл. неделю (дата уточняется)', callback_data: 'bc_p_resched_3' }],
          [{ text: '« Назад к выбору темы', callback_data: backCb }]
        ]
      };
      await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
      return;
    }

    if (kind === 'cancel') {
      const text = [
        '❌ <b>ОТМЕНА ИГРЫ: УКАЖИТЕ ПРИЧИНУ</b>',
        '',
        `🎯 <b>Аудитория:</b> ${escapeHtml(session.targetLabel)}`,
        `👥 <b>Получателей:</b> <b>${session.recipientsCount}</b> команд`,
        '',
        '👇 <b>Напишите причину отмены в ответном сообщении:</b>',
        '<i>Например:</i> «По форс-мажорным обстоятельствам площадки»',
        '',
        '⚡ <b>Или выберите готовый вариант в 1 клик:</b>'
      ].join('\n');

      const replyMarkup = {
        inline_keyboard: [
          [{ text: '⚠️ Форс-мажор на площадке', callback_data: 'bc_p_cancel_1' }],
          [{ text: '❄️ Буран / Погодные условия', callback_data: 'bc_p_cancel_2' }],
          [{ text: '🔧 Технические неполадки в баре', callback_data: 'bc_p_cancel_3' }],
          [{ text: '« Назад к выбору темы', callback_data: backCb }]
        ]
      };
      await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
      return;
    }

    // kind === 'custom'
    const text = [
      '📢 <b>СРОЧНОЕ ОБЪЯВЛЕНИЕ / НАПОМИНАНИЕ</b>',
      '',
      `🎯 <b>Аудитория:</b> ${escapeHtml(session.targetLabel)}`,
      `👥 <b>Получателей:</b> <b>${session.recipientsCount}</b> чел.`,
      '',
      '👇 <b>Напишите текст сообщения прямо в этот чат:</b>',
      '',
      '⚡ <b>Или нажмите готовое напоминание в 1 клик:</b>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [{ text: '⏰ Сбор за 30 мин до старта (в 19:00)', callback_data: 'bc_p_custom_1' }],
        [{ text: '📍 Напоминание: Караоке «То Место», 2 этаж', callback_data: 'bc_p_custom_2' }],
        [{ text: '🚗 Парковка за зданием бара (ул. Комиссарова)', callback_data: 'bc_p_custom_3' }],
        [{ text: '« Назад к выбору темы', callback_data: backCb }]
      ]
    };
    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function handlePresetContent(chatId, messageId, presetKey) {
    const session = tgSessions.get(chatId);
    if (!session) {
      await startBroadcastWizard(chatId, messageId);
      return;
    }

    if (presetKey === 'bc_p_resched_1') {
      session.newDate = '20 ноября (среда)';
      session.newTime = '19:30';
      session.reason = 'Технические работы в зале';
    } else if (presetKey === 'bc_p_resched_2') {
      session.newDate = '21 ноября (четверг)';
      session.newTime = '19:30';
      session.reason = 'Замена мультимедиа оборудования';
    } else if (presetKey === 'bc_p_resched_3') {
      session.newDate = 'следующая неделя (будет сообщена дополнительно)';
      session.newTime = '19:30';
      session.reason = 'Форс-мажор на площадке проведения';
    } else if (presetKey === 'bc_p_cancel_1') {
      session.reason = 'Форс-мажорные обстоятельства на площадке проведения';
    } else if (presetKey === 'bc_p_cancel_2') {
      session.reason = 'Штормовое предупреждение и неблагоприятные погодные условия';
    } else if (presetKey === 'bc_p_cancel_3') {
      session.reason = 'Технические неполадки электросети в караоке-баре';
    } else if (presetKey === 'bc_p_custom_1') {
      session.customText = 'Напоминаем, что сбор команд начинается за 30 минут до старта (в 19:00)! Ждём вас к разминке в караоке-баре «То Место».';
    } else if (presetKey === 'bc_p_custom_2') {
      session.customText = 'Ждём всех сегодня на 2-м этаже караоке-бара «То Место» (пр. Нуркена Абдирова, 5). Ваш столик уже подготовлен!';
    } else if (presetKey === 'bc_p_custom_3') {
      session.customText = 'Обратите внимание: бесплатная парковка для участников доступна прямо за зданием бара (въезд с ул. Комиссарова).';
    }

    tgSessions.set(chatId, session);
    await showBroadcastPreview(chatId, messageId);
  }

  async function showBroadcastPreview(chatId, messageId = null) {
    const session = tgSessions.get(chatId);
    if (!session) {
      await startBroadcastWizard(chatId, messageId);
      return;
    }

    session.step = 'confirm_broadcast';
    tgSessions.set(chatId, session);

    const { template, defaultParams } = prepareBroadcastTemplate({
      type: session.type,
      customText: session.customText || '',
      newDate: session.newDate || '',
      newTime: session.newTime || '19:30',
      reason: session.reason || ''
    });

    session.preparedTemplate = template;
    session.preparedParams = defaultParams;

    const sampleText = personalizeMessage(template, {
      captain: 'Алексей',
      team: 'ДНК',
      game: session.gameTitle || 'Киномарафон: 100 вопросов',
      date: session.gameDate || '17 ноября',
      players: '6',
      ...defaultParams
    });

    const text = [
      '👁️ <b>ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР РАССЫЛКИ (ШАГ 3 ИЗ 3)</b>',
      '',
      `🎯 <b>Кому отправляем:</b>`,
      `👉 <b>${escapeHtml(session.targetLabel)}</b>`,
      `👥 <b>Всего получателей:</b> <b>${session.recipientsCount}</b> команд / капитанов`,
      '🛡️ <b>Защита WhatsApp:</b> Пауза 3–7 сек + симуляция набора текста',
      '',
      '📝 <b>Текст, который получит каждый капитан:</b>',
      '──────────────────────',
      `<pre>${escapeHtml(sampleText)}</pre>`,
      '──────────────────────',
      '<i>(Имя капитана и название команды подставляются индивидуально для каждого получателя)</i>',
      '',
      '🚀 <b>Запустить эту рассылку в WhatsApp?</b>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: `🚀 ДА, ОТПРАВИТЬ (${session.recipientsCount} ком.)`, callback_data: 'bc_send_confirmed' }
        ],
        [
          { text: '✏️ Ввести другой текст', callback_data: 'bc_reenter' },
          { text: '❌ Отменить рассылку', callback_data: 'bc_cancel' }
        ]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function executeAndReportBroadcast(chatId, messageId) {
    const session = tgSessions.get(chatId);
    if (!session) {
      await sendMessage(chatId, '⚠️ Время ожидания истекло. Пожалуйста, запустите рассылку заново.');
      await sendMainMenu(chatId);
      return;
    }

    await editOrSendMessage(chatId, messageId, '⏳ <b>Ставлю сообщения в очередь WhatsApp...</b>');

    try {
      const res = await executeManualBroadcast({
        db,
        broadcaster,
        type: session.type,
        target: session.target,
        gameTitle: session.gameTitle,
        gameDate: session.gameDate,
        customText: session.customText,
        newDate: session.newDate,
        newTime: session.newTime,
        reason: session.reason,
        overrideTemplate: session.overrideTemplate || null,
        telegramAlertFn: (payload) => sendBroadcastLaunchAlert(payload)
      });

      const targetLabel = session.targetLabel;
      tgSessions.delete(chatId);

      const successText = [
        '✅ <b>РАССЫЛКА УСПЕШНО ЗАПУЩЕНА!</b>',
        '',
        `🎯 <b>Аудитория:</b> ${escapeHtml(targetLabel)}`,
        `👥 <b>Добавлено в очередь:</b> <b>${res.queuedCount}</b> команд(ы)`,
        `🆔 <b>ID пакета:</b> <code>${res.batchId}</code>`,
        '',
        '<i>Сообщения отправляются в WhatsApp по очереди FIFO с задержкой 3–7 секунд для защиты номера от бана.</i>'
      ].join('\n');

      const replyMarkup = {
        inline_keyboard: [
          [{ text: '📊 Статус очереди', callback_data: 'bc_status' }],
          [{ text: '« В главное меню', callback_data: 'menu' }]
        ]
      };

      await editOrSendMessage(chatId, messageId, successText, { reply_markup: replyMarkup });
    } catch (err) {
      logger.error({ err }, 'Error in executeAndReportBroadcast');
      tgSessions.delete(chatId);
      await editOrSendMessage(chatId, messageId, `❌ <b>Ошибка запуска рассылки:</b> ${escapeHtml(err.message)}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '« В главное меню', callback_data: 'menu' }]]
        }
      });
    }
  }

  // --- INTERACTIVE ADD BOOKING WIZARD ---

  async function startAddBookingWizard(chatId, messageId = null) {
    const games = getActiveGames();
    const g1 = games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    const g2 = games[1] || { title: 'Культовые Аниме', dateStr: '24 ноября' };

    tgSessions.set(chatId, {
      flow: 'add_booking',
      step: 'choose_game',
      g1,
      g2
    });

    const text = [
      '➕ <b>РЕГИСТРАЦИЯ КОМАНДЫ (ШАГ 1 ИЗ 2)</b>',
      '',
      '<b>На какую игру регистрируем команду?</b>',
      '',
      `1️⃣ 🎬 <b>«${escapeHtml(g1.title)}»</b> (${escapeHtml(g1.dateStr)})`,
      `2️⃣ 🎌 <b>«${escapeHtml(g2.title)}»</b> (${escapeHtml(g2.dateStr)})`
    ].join('\n');

    const shortG1 = g1.title.length > 22 ? g1.title.slice(0, 20) + '…' : g1.title;
    const shortG2 = g2.title.length > 22 ? g2.title.slice(0, 20) + '…' : g2.title;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: `🎬 1. ${shortG1} (${g1.dateStr})`, callback_data: 'add_g_0' }
        ],
        [
          { text: `🎌 2. ${shortG2} (${g2.dateStr})`, callback_data: 'add_g_1' }
        ],
        [
          { text: '« В главное меню', callback_data: 'menu' }
        ]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function handleSelectBookingGame(chatId, messageId, gameIdx) {
    const session = tgSessions.get(chatId) || {};
    const games = getActiveGames();
    const chosenGame = (gameIdx === '1' && games[1]) ? games[1] : (games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' });

    session.flow = 'add_booking';
    session.step = 'awaiting_booking_info';
    session.chosenGame = chosenGame;
    tgSessions.set(chatId, session);

    const text = [
      '➕ <b>РЕГИСТРАЦИЯ КОМАНДЫ (ШАГ 2 ИЗ 2)</b>',
      '',
      `🎬 <b>Игра:</b> «${escapeHtml(chosenGame.title)}» (${escapeHtml(chosenGame.dateStr)})`,
      '',
      '👇 <b>Просто напишите данные команды в ответном сообщении:</b>',
      '',
      '<i>Пример (скопируйте и измените под себя):</i>',
      '<code>Гарри Поттер, Гермиона, +7 701 555 44 33, 6 игроков, Столик у сцены</code>',
      '',
      '<i>(Или просто: «Название команды, Телефон, Имя капитана»)</i>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [{ text: '« Изменить игру', callback_data: 'add_start' }],
        [{ text: '« Отмена', callback_data: 'menu' }]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function handleIncomingInteractiveText(chatId, text) {
    const session = tgSessions.get(chatId);
    if (!session) return false;

    const lower = text.toLowerCase().trim();
    if (lower === 'отмена' || lower === 'назад' || lower === '/cancel') {
      tgSessions.delete(chatId);
      await sendMessage(chatId, 'Действие отменено.');
      await sendMainMenu(chatId);
      return true;
    }

    if (session.flow === 'broadcast' && session.step === 'awaiting_broadcast_text') {
      if (session.type === 'reschedule') {
        session.reason = text;
        session.newDate = 'согласно сообщению';
      } else if (session.type === 'cancel') {
        session.reason = text;
      } else {
        session.customText = text;
      }
      tgSessions.set(chatId, session);
      await showBroadcastPreview(chatId, null);
      return true;
    }

    if (session.flow === 'add_booking' && session.step === 'awaiting_booking_info') {
      const parts = text.split(',').map(s => s.trim());
      const teamName = parts[0] || 'Команда';
      let captainName = parts[1] || 'Капитан';
      let phone = '';
      let playersCount = 6;
      let notes = '';

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (/[+0-9]{7,}/.test(p.replace(/\D/g, ''))) {
          phone = p;
        } else if (/\d+/.test(p) && p.length <= 2) {
          playersCount = parseInt(p, 10) || 6;
        } else if (i === 1) {
          captainName = p;
        } else {
          notes = notes ? `${notes}, ${p}` : p;
        }
      }

      if (!phone) {
        phone = '+77000000000';
      }

      const game = session.chosenGame || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };

      try {
        const booking = db.bookings.create({
          teamName,
          captainName,
          captainPhone: phone,
          playersCount,
          gameTitle: game.title,
          gameDate: game.dateStr,
          source: 'telegram_wizard',
          status: 'confirmed',
          notes
        });

        tgSessions.delete(chatId);

        try {
          await sendBookingAlert(booking);
        } catch (e) {}

        const successText = [
          '✅ <b>КОМАНДА УСПЕШНО ЗАРЕГИСТРИРОВАНА!</b>',
          '',
          `👥 <b>Команда:</b> «${escapeHtml(booking.team_name)}»`,
          `👤 <b>Капитан:</b> ${escapeHtml(booking.captain_name)} (📱 ${escapeHtml(booking.captain_phone)})`,
          `🔢 <b>Игроков:</b> ${booking.players_count} чел.`,
          `🎬 <b>Игра:</b> ${escapeHtml(booking.game_title)} (${escapeHtml(booking.game_date)})`,
          notes ? `📝 <b>Примечание:</b> <i>${escapeHtml(notes)}</i>` : '',
          '',
          '<i>Бронь внесена в базу данных и доступна в Excel и на веб-панели!</i>'
        ].filter(Boolean).join('\n');

        await sendMessage(chatId, successText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📋 Список броней', callback_data: 'bookings' }],
              [{ text: '« В главное меню', callback_data: 'menu' }]
            ]
          }
        });
        return true;
      } catch (err) {
        await sendMessage(chatId, `❌ Ошибка регистрации: ${escapeHtml(err.message)}`);
        return true;
      }
    }

    return false;
  }

  async function sendBroadcastStatus(chatId, messageId = null) {
    if (!broadcaster || typeof broadcaster.getStatus !== 'function') {
      await editOrSendMessage(chatId, messageId, 'ℹ️ Сервис рассылки еще инициализируется или временно недоступен.');
      return;
    }

    const s = broadcaster.getStatus();
    const logsCount = db?.broadcastLogs ? db.broadcastLogs.listAll(100).length : 0;

    const text = [
      '📊 <b>СТАТУС СИСТЕМЫ РАССЫЛКИ WHATSAPP</b>',
      '',
      `⏳ <b>Сообщений в очереди:</b> ${s.queueLength}`,
      `🔄 <b>Статус воркера:</b> ${s.isRunning ? '🟢 Активен (отправка)' : '⚪ Ожидание заданий'}`,
      `✅ <b>Успешно отправлено:</b> ${s.sentCount}`,
      `❌ <b>Ошибок отправки:</b> ${s.failedCount}`,
      `🚫 <b>Пропущено (отписались «СТОП»):</b> ${s.skippedCount}`,
      `📦 <b>Всего обработано за сессию:</b> ${s.processedCount}`,
      `📜 <b>Записей в журнале SQLite:</b> ${logsCount}`,
      '',
      '<i>Защита от бана: пауза 3–7 сек между номерами + симуляция набора текста.</i>'
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🔄 Обновить статус', callback_data: 'bc_status' },
          { text: '📢 Запустить рассылку', callback_data: 'bc_start' }
        ],
        [
          { text: '« В главное меню', callback_data: 'menu' }
        ]
      ]
    };

    await editOrSendMessage(chatId, messageId, text, { reply_markup: replyMarkup });
  }

  async function handleBroadcastCommand(chatId, argsStr) {
    if (!argsStr || !argsStr.trim()) {
      await startBroadcastWizard(chatId);
      return;
    }

    const parts = argsStr.trim().split(/\s+/);
    const subCmd = parts[0].toLowerCase();
    const rest = argsStr.trim().slice(subCmd.length).trim();

    if (subCmd === 'status' || subCmd === 'статус') {
      await sendBroadcastStatus(chatId);
      return;
    }

    await startBroadcastWizard(chatId);
  }

  async function handleAddCommand(chatId, argsStr) {
    if (!argsStr || !argsStr.trim()) {
      await startAddBookingWizard(chatId);
      return;
    }

    const parts = argsStr.split(',').map(s => s.trim());
    if (parts.length < 2) {
      await startAddBookingWizard(chatId);
      return;
    }

    const teamName = parts[0];
    const captainName = parts[1] || 'Капитан';
    const captainPhone = parts[2] || '+77000000000';
    const playersCount = parseInt(parts[3], 10) || 6;
    const gameChoice = parts[4] || '1';
    const notes = parts.slice(5).join(', ') || '';

    const games = getActiveGames();
    let chosenGame = games[0] || { title: 'Киномарафон: 100 вопросов', dateStr: '17 ноября' };
    if (gameChoice === '2' && games[1]) chosenGame = games[1];

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
      await sendMessage(chatId, `❌ Ошибка: ${escapeHtml(err.message)}`);
    }
  }

  async function handleSync(chatId) {
    if (typeof syncRepositoryGames === 'function') {
      await sendMessage(chatId, '⏳ Запускаю синхронизацию расписания с GitHub...');
      try {
        const res = await syncRepositoryGames();
        await sendMessage(chatId, res.ok
          ? `✅ <b>Расписание успешно обновлено! Перезапускаю сервис...</b>\n<code>${escapeHtml(res.output)}</code>`
          : `⚠️ Ошибка синхронизации: ${escapeHtml(res.error)}`
        );
        if (res.ok) {
          setTimeout(() => process.exit(0), 1000);
        }
      } catch (e) {
        await sendMessage(chatId, `❌ Ошибка: ${escapeHtml(e.message)}`);
      }
    } else {
      await sendMessage(chatId, 'ℹ️ Функция синхронизации доступна только на сервере.');
    }
  }

  async function handleUpdate(update) {
    try {
      // 1. Handle incoming text commands & reply keyboard taps
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

        const lowerText = text.toLowerCase();

        // 1a. Persistent Reply Keyboard button routing
        if (text === '📊 Статистика' || lowerText === '📊 статистика') {
          tgSessions.delete(chatId);
          await sendStats(chatId);
          return;
        }
        if (text === '📋 Список броней' || lowerText === '📋 список броней') {
          tgSessions.delete(chatId);
          await sendBookingsList(chatId);
          return;
        }
        if (text === '📢 Срочная рассылка' || lowerText === '📢 срочная рассылка') {
          tgSessions.delete(chatId);
          await startBroadcastWizard(chatId);
          return;
        }
        if (text === '➕ Добавить бронь' || lowerText === '➕ добавить бронь') {
          tgSessions.delete(chatId);
          await startAddBookingWizard(chatId);
          return;
        }
        if (text === '📜 Архив игр' || lowerText === '📜 архив игр') {
          tgSessions.delete(chatId);
          await sendGamesArchive(chatId);
          return;
        }
        if (text === '📥 Скачать Excel' || lowerText === '📥 скачать excel') {
          tgSessions.delete(chatId);
          await sendExcelDocument(chatId);
          return;
        }

        // 1b. Global cancel keywords
        if (lowerText === 'отмена' || lowerText === 'назад' || lowerText === '/cancel') {
          tgSessions.delete(chatId);
          await sendMessage(chatId, 'Действие отменено.');
          await sendMainMenu(chatId);
          return;
        }

        // 1c. Interactive multi-step wizard input (broadcasting or manual booking)
        if (tgSessions.has(chatId) && !text.startsWith('/')) {
          const handled = await handleIncomingInteractiveText(chatId, text);
          if (handled) return;
        }

        // 1d. Traditional slash commands
        if (firstWord === '/start') {
          await sendMessage(chatId, '🎬 Добро пожаловать в панель управления ACTION Киноквиз!', {
            reply_markup: MAIN_REPLY_KEYBOARD
          });
          await sendMainMenu(chatId);
        } else if (firstWord === '/admin' || firstWord === '/menu' || firstWord === 'панель' || firstWord === 'меню') {
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
        } else if (firstWord === '/broadcast' || firstWord === '/рассылка') {
          await handleBroadcastCommand(chatId, args);
        } else if (firstWord === '/qr' || lowerText === 'qr' || lowerText === 'кьюар' || lowerText === 'кью ар') {
          await sendWhatsAppStatusOrQr(chatId);
        } else if (firstWord === '/sync' || firstWord === '/обновить') {
          await handleSync(chatId);
        } else if (firstWord === '/restart' || firstWord === '/перезапуск') {
          await sendMessage(chatId, '🔄 <b>Перезапуск сервиса...</b>\nБот перезагружается с актуальным кодом. Через 5-10 секунд он снова будет онлайн.');
          setTimeout(() => process.exit(0), 500);
        }
      }

      // 2. Handle inline button callbacks
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = String(cq.message?.chat?.id);
        const messageId = cq.message?.message_id;
        const data = cq.data;

        await answerCallbackQuery(cq.id);

        if (data === 'wa_qr') {
          await sendWhatsAppStatusOrQr(chatId);
        } else if (data === 'wa_reconnect') {
          await sendMessage(chatId, '⏳ <b>Сбрасываю старую сессию WhatsApp и создаю новый QR-код...</b>\nПодождите пару секунд, сейчас пришлю свежий QR прямо сюда.');
          if (typeof restartAuth === 'function') {
            try {
              await restartAuth();
              setTimeout(async () => {
                await sendWhatsAppStatusOrQr(chatId);
              }, 3000);
            } catch (e) {
              await sendMessage(chatId, '❌ Ошибка при сбросе сессии: ' + escapeHtml(e.message));
            }
          }
        } else if (data === 'stats') {
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
        } else if (data === 'menu') {
          await sendMainMenu(chatId, messageId);
        } else if (data === 'sync') {
          await handleSync(chatId);
        } else if (data === 'add_start' || data === 'help_add') {
          await startAddBookingWizard(chatId, messageId);
        } else if (data === 'add_g_0') {
          await handleSelectBookingGame(chatId, messageId, '0');
        } else if (data === 'add_g_1') {
          await handleSelectBookingGame(chatId, messageId, '1');
        } else if (data === 'bc_start' || data === 'bc_menu') {
          await startBroadcastWizard(chatId, messageId);
        } else if (data === 'bc_tgt_0') {
          await chooseBroadcastType(chatId, messageId, '0');
        } else if (data === 'bc_tgt_1') {
          await chooseBroadcastType(chatId, messageId, '1');
        } else if (data === 'bc_tgt_all') {
          await chooseBroadcastType(chatId, messageId, 'all');
        } else if (data === 'bc_kind_reschedule') {
          await promptBroadcastContent(chatId, messageId, 'reschedule');
        } else if (data === 'bc_kind_cancel') {
          await promptBroadcastContent(chatId, messageId, 'cancel');
        } else if (data === 'bc_kind_custom') {
          await promptBroadcastContent(chatId, messageId, 'custom');
        } else if (data.startsWith('bc_p_')) {
          await handlePresetContent(chatId, messageId, data);
        } else if (data === 'bc_send_confirmed') {
          await executeAndReportBroadcast(chatId, messageId);
        } else if (data === 'bc_reenter') {
          const session = tgSessions.get(chatId);
          await promptBroadcastContent(chatId, messageId, session?.type || 'custom');
        } else if (data === 'bc_cancel') {
          tgSessions.delete(chatId);
          await sendMainMenu(chatId, messageId);
        } else if (data.startsWith('bc_back_tgt_')) {
          const tgt = data.replace('bc_back_tgt_', '');
          await chooseBroadcastType(chatId, messageId, tgt);
        } else if (data === 'bc_status') {
          await sendBroadcastStatus(chatId, messageId);
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
            { command: 'qr', description: '📱 Статус WhatsApp и QR-код' },
            { command: 'broadcast', description: '📢 Срочная рассылка (перенос, отмена)' },
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
