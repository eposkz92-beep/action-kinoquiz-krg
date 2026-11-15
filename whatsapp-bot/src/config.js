import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botRootDir = path.resolve(__dirname, '..');

/**
 * Safely parses integer with fallback default
 * @param {string|undefined} val
 * @param {number} fallback
 * @returns {number}
 */
function parseIntSafe(val, fallback) {
  if (!val) return fallback;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? fallback : num;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  port: parseIntSafe(process.env.PORT, 3000),
  qrPort: parseIntSafe(process.env.QR_PORT, 3000),
  dbPath: process.env.DB_PATH || path.join(botRootDir, 'data', 'kinoquiz.db'),
  authDir: process.env.AUTH_DIR || path.join(botRootDir, 'auth_info_baileys'),
  exportDir: process.env.CSV_EXPORT_DIR || path.join(botRootDir, 'exports'),
  instagramStatePath: process.env.INSTAGRAM_STATE_PATH || path.resolve(botRootDir, '..', 'instagram_state.json'),
  indexHtmlPath: process.env.INDEX_HTML_PATH || path.resolve(botRootDir, '..', 'index.html'),
  timezone: process.env.TIMEZONE || 'Asia/Almaty',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '9063876092:AAHscUTNdY39nZ0OJuG8UyKvjL4ibV3-AXE',
    chatId: process.env.TELEGRAM_CHAT_ID || '-5567159550',
    get enabled() {
      return Boolean(this.botToken && this.chatId);
    }
  },

  googleSheets: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Брони',
    get enabled() {
      return Boolean(this.serviceAccountEmail && this.privateKey && this.spreadsheetId);
    }
  },

  quiz: {
    location: process.env.QUIZ_LOCATION || 'Караоке-бар «То Место», г. Караганда, пр. Нуркена Абдирова, д. 5',
    address2GisUrl: 'https://2gis.kz/karaganda/search/%D0%A2%D0%BE%20%D0%BC%D0%B5%D1%81%D1%82%D0%BE%20%D0%9D%D1%83%D1%80%D0%BA%D0%B5%D0%BD%D0%B0%20%D0%90%D0%B1%D0%B4%D0%B8%D1%80%D0%BE%D0%B2%D0%B0%2C%205',
    pricePerPlayer: parseIntSafe(process.env.QUIZ_PRICE_PER_PLAYER, 3000),
    organizerPhone: process.env.ORGANIZER_PHONE || '+7 701 186 31 90',
    organizerWaLink: 'https://wa.me/77011863190',
    minPlayers: 2,
    maxPlayers: 10,
    sessionTimeoutMinutes: 20
  },

  broadcast: {
    minDelayMs: 3000,
    maxDelayMs: 7000,
    optOutKeyword: 'СТОП',
    reminderCron: '0 12 * * 2' // Every Tuesday at 12:00
  },

  security: {
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || 'kinoquiz2026',
    apiSecret: process.env.API_SECRET || process.env.ADMIN_PASSWORD || 'kinoquiz2026'
  }
};

export default config;
