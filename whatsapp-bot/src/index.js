/**
 * src/index.js
 * Main entry point for ACTION Kinoquiz WhatsApp Bot
 *
 * Implements:
 * - Direct Baileys WhatsApp connection with persistent multi-file auth
 * - Dual QR presentation: Terminal ANSI output + Web viewer at http://localhost:PORT
 * - Interactive 5-state booking FSM dialogue engine
 * - Web modal direct booking interceptor
 * - Automatic SQLite database persistence (bookings, contacts, teams, sessions)
 * - Telegram organizer alert integration (HTML card with wa.me link)
 * - Safe broadcast queue with randomized 3-7s anti-ban delay
 * - Automated Tuesday 12:00 game-day reminder scheduler
 * - Web dashboard with status API and instant CSV export
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { initDatabase, normalizePhone } from './db/database.js';
import { exportBookingsToCsv } from './db/exportCsv.js';
import { exportBookingsToGoogleSheets } from './db/exportSheets.js';
import { getActiveGames } from './games/gameLoader.js';
import { handleIncomingMessage, FSM_STATES } from './dialog/fsm.js';
import { sendBookingAlert } from './telegram/notifier.js';
import {
  createBroadcaster,
  isOptOutMessage,
  isOptInMessage,
  handleOptOut,
  handleOptIn,
  phoneToJid
} from './broadcast/broadcaster.js';
import { initGameDayScheduler } from './broadcast/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botRootDir = path.resolve(__dirname, '..');

// 1. Logger
const logger = pino({
  level: config.logLevel || 'info',
  transport:
    config.env === 'development'
      ? {
          target: 'pino/file',
          options: { destination: 1 }
        }
      : undefined
});

// 2. Initialize SQLite Database
logger.info({ dbPath: config.dbPath }, 'Initializing SQLite database...');
const db = initDatabase(config.dbPath);

// Global bot state
let currentQrCode = null;
let isConnected = false;
let botPhone = null;
let currentSock = null;
let broadcaster = null;
let scheduler = null;

/**
 * Renders HTML for the QR code and Status Web Interface
 * @param {string|null} qrDataUrl
 * @returns {string} HTML content
 */
function renderWebDashboard(qrDataUrl) {
  const bookingsCount = db.bookings.list({ limit: 1000 }).length;
  const contactsCount = db.contacts.list({ limit: 1000 }).length;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ACTION Киноквиз — WhatsApp Бот</title>
  <style>
    :root {
      --bg: #0d0b18;
      --card-bg: #171329;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --border: #2e264f;
      --success: #10b981;
      --error: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      max-width: 520px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      text-align: center;
    }
    .logo {
      font-size: 26px;
      font-weight: 800;
      color: var(--accent);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: 14px;
      color: var(--muted);
      margin-bottom: 24px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .status-connected {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .status-waiting {
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .qr-box {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 20px;
    }
    .qr-box img {
      display: block;
      width: 250px;
      height: 250px;
    }
    .instructions {
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
      text-align: left;
      background: rgba(255,255,255,0.03);
      padding: 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .instructions ol {
      margin-left: 20px;
      margin-top: 6px;
    }
    .instructions li {
      margin-bottom: 4px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .stat-val {
      font-size: 20px;
      font-weight: 700;
      color: var(--text);
    }
    .stat-lbl {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .btn {
      display: inline-block;
      padding: 12px 20px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: background 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: #000;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    .btn-outline {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-outline:hover {
      background: rgba(255,255,255,0.05);
    }
  </style>
  <script>
    // Auto-refresh until connected
    ${!isConnected ? `
    setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.status === 'connected') {
          window.location.reload();
        }
      } catch (e) {}
    }, 3000);
    ` : ''}
  </script>
</head>
<body>
  <div class="container">
    <div class="logo">🎬 ACTION Киноквиз</div>
    <div class="subtitle">Автономный WhatsApp Бот • Караганда</div>

    ${
      isConnected
        ? `
      <div class="status-badge status-connected">
        <span>●</span> Бот успешно подключен: +${botPhone || 'WhatsApp'}
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">${bookingsCount}</div>
          <div class="stat-lbl">Всего броней</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${contactsCount}</div>
          <div class="stat-lbl">Капитанов в базе</div>
        </div>
      </div>
      <div class="actions">
        <a href="/api/export/csv" class="btn btn-primary" download>📥 Скачать брони (Excel / CSV)</a>
      </div>
      `
        : `
      <div class="status-badge status-waiting">
        <span>●</span> Ожидание сканирования QR-кода
      </div>

      ${
        qrDataUrl
          ? `
        <div class="qr-box">
          <img src="${qrDataUrl}" alt="WhatsApp QR Code">
        </div>
        <div class="instructions">
          <strong>Инструкция для подключения:</strong>
          <ol>
            <li>Откройте <b>WhatsApp</b> на телефоне организатора.</li>
            <li>Перейдите в <b>Настройки</b> ➔ <b>Связанные устройства</b>.</li>
            <li>Нажмите <b>Привязка устройства</b> и наведите камеру на QR-код.</li>
          </ol>
        </div>
        `
          : `
        <div style="padding: 40px; color: var(--muted);">
          Генерация QR-кода соединения...<br>
          Пожалуйста, подождите несколько секунд.
        </div>
        `
      }
      `
    }
  </div>
</body>
</html>`;
}

// 3. Start Lightweight Web Dashboard & Status Server
const webServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/qr') {
    let qrDataUrl = null;
    if (currentQrCode) {
      try {
        qrDataUrl = await QRCode.toDataURL(currentQrCode);
      } catch (err) {
        logger.error({ err }, 'Failed to generate QR data URL');
      }
    }
    const html = renderWebDashboard(qrDataUrl);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isConnected ? 'connected' : currentQrCode ? 'qr_ready' : 'starting',
        phone: botPhone,
        uptime: process.uptime(),
        bookingsCount: db.bookings.list({ limit: 1 }).length
      })
    );
    return;
  }

  if (url.pathname === '/api/export/csv') {
    try {
      const csvContent = await exportBookingsCsv(db);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `bookings_${timestamp}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(csvContent);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

webServer.listen(config.qrPort, () => {
  logger.info(`Web QR & Dashboard running at http://localhost:${config.qrPort}`);
});

// 4. Baileys WhatsApp Connection Manager
async function startBot() {
  const authDir = path.resolve(config.authDir);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Using Baileys version');

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Suppress internal Baileys noise
    printQRInTerminal: false,
    auth: state,
    browser: ['ACTION Kinoquiz Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });

  currentSock = sock;

  // Initialize Broadcaster with the active socket
  broadcaster = createBroadcaster({
    db,
    sock,
    logger,
    delayRange: [config.broadcast.minDelayMs, config.broadcast.maxDelayMs]
  });

  // Initialize Tuesday Game-Day Scheduler
  scheduler = await initGameDayScheduler({
    db,
    getActiveGames,
    broadcaster,
    cronExpr: config.broadcast.reminderCron,
    timezone: config.timezone,
    parentDir: botRootDir,
    logger
  });

  // Creds persistence
  sock.ev.on('creds.update', saveCreds);

  // Connection Lifecycle
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrCode = qr;
      logger.info('New WhatsApp QR code received! Scan from terminal or web:');
      qrcodeTerminal.generate(qr, { small: true });
      logger.info(`📱 Open in browser: http://localhost:${config.qrPort}`);
    }

    if (connection === 'close') {
      isConnected = false;
      currentQrCode = null;
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : (lastDisconnect?.error)?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode, shouldReconnect }, 'WhatsApp connection closed');

      if (scheduler && typeof scheduler.stop === 'function') {
        scheduler.stop();
      }

      if (shouldReconnect) {
        logger.info('Reconnecting to WhatsApp in 3 seconds...');
        setTimeout(() => startBot(), 3000);
      } else {
        logger.error('WhatsApp session logged out. Clear auth_info_baileys and restart.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQrCode = null;
      botPhone = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
      logger.info(`🎉 ACTION Kinoquiz WhatsApp Bot connected! Account: +${botPhone}`);
    }
  });

  // Incoming Messages Handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!messages || messages.length === 0) return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
          // Skip group messages and status stories, only process direct chats
          continue;
        }

        // Extract message text content
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!text || !text.trim()) continue;

        const senderPhone = remoteJid.split('@')[0].split(':')[0];
        const pushName = msg.pushName || '';

        logger.info({ from: senderPhone, name: pushName, text: text.slice(0, 60) }, 'Incoming message');

        // Mark as read
        try {
          await sock.readMessages([msg.key]);
        } catch {
          // Ignore read receipt errors
        }

        // 1. Opt-out ("СТОП") / Opt-in ("СТАРТ") handlers
        if (isOptOutMessage(text)) {
          const optOutRes = handleOptOut({ phone: remoteJid, db });
          await sock.sendMessage(remoteJid, { text: optOutRes.replyText });
          continue;
        }

        if (isOptInMessage(text)) {
          const optInRes = handleOptIn({ phone: remoteJid, db });
          await sock.sendMessage(remoteJid, { text: optInRes.replyText });
          continue;
        }

        // 2. Process message through FSM / Web Booking Parser
        const response = await handleIncomingMessage({
          jid: remoteJid,
          text,
          pushName,
          db,
          parentDir: botRootDir
        });

        // 3. Send FSM replies with simulated typing indicator
        if (Array.isArray(response.replies) && response.replies.length > 0) {
          for (const reply of response.replies) {
            try {
              await sock.sendPresenceUpdate('composing', remoteJid);
              await new Promise((r) => setTimeout(r, 600));
              await sock.sendMessage(remoteJid, { text: reply });
              await sock.sendPresenceUpdate('paused', remoteJid);
            } catch (sendErr) {
              logger.error({ err: sendErr, remoteJid }, 'Failed to deliver message');
            }
          }
        }

        // 4. New Booking Side-Effects
        if (response.bookingCreated) {
          const booking = response.bookingCreated;
          logger.info({ bookingId: booking.id, team: booking.team_name }, 'New booking confirmed!');

          // Upsert into contacts database
          try {
            db.contacts.upsert({
              phone: booking.captain_phone,
              name: booking.captain_name,
              team: booking.team_name
            });
          } catch (contactErr) {
            logger.warn({ err: contactErr }, 'Failed to upsert contact');
          }

          // Dispatch Telegram notification to organizer
          if (config.telegram.enabled) {
            logger.info('Dispatching booking alert to Telegram...');
            sendBookingAlert(booking, {
              botToken: config.telegram.botToken,
              chatId: config.telegram.chatId
            }).then((res) => {
              if (res.success) {
                logger.info({ messageId: res.messageId }, 'Telegram notification sent');
              } else {
                logger.warn({ error: res.error }, 'Telegram notification failed');
              }
            }).catch((err) => {
              logger.error({ err }, 'Telegram notification unexpected error');
            });
          }

          // Sync to Google Sheets if configured
          if (config.googleSheets.enabled) {
            logger.info('Exporting booking to Google Sheets...');
            exportBookingsToGoogleSheets(db, config.googleSheets).catch((sheetsErr) => {
              logger.warn({ err: sheetsErr }, 'Google Sheets sync failed');
            });
          }
        }
      } catch (msgErr) {
        logger.error({ err: msgErr }, 'Error processing incoming message');
      }
    }
  });
}

// 5. Graceful Process Teardown
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down WhatsApp Bot...');

  if (scheduler && typeof scheduler.stop === 'function') {
    scheduler.stop();
  }

  if (webServer) {
    webServer.close();
  }

  if (db && typeof db.close === 'function') {
    db.close();
  }

  logger.info('Cleanup complete. Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start Bot
startBot().catch((err) => {
  logger.fatal({ err }, 'Fatal error during bot startup');
  process.exit(1);
});
