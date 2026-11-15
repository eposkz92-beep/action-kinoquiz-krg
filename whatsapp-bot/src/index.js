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
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import cron from 'node-cron';

const execAsync = promisify(exec);

import config from './config.js';
import { initDatabase, normalizePhone } from './db/database.js';
import { exportBookingsCsv, exportBookingsToCsv, exportBookingsToExcelHtml, escapeHtml, formatBookingDate } from './db/exportCsv.js';
import { exportBookingsToXlsxBuffer } from './db/exportXlsx.js';
import { exportBookingsToGoogleSheets } from './db/exportSheets.js';
import { getActiveGames } from './games/gameLoader.js';
import { handleIncomingMessage, FSM_STATES } from './dialog/fsm.js';
import { sendBookingAlert } from './telegram/notifier.js';
import { startTelegramPoller } from './telegram/botPoller.js';
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
  const bookings = db.bookings.list({ limit: 1000 }) || [];
  const contactsCount = db.contacts ? db.contacts.list({ limit: 1000 }).length : 0;
  const pricePerPlayer = Number(config.quiz?.pricePerPlayer) || 3000;
  const totalPlayers = bookings.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
  const totalRevenue = totalPlayers * pricePerPlayer;
  const venueCapacity = Number(config.quiz?.venueCapacity) || 60;
  const activeGames = getActiveGames();

  // 1. Capacity progress cards for active games
  const capacityCardsHtml = activeGames.map((game, idx) => {
    const matchingBookings = bookings.filter(b => {
      const gTitle = (b.game_title || '').toLowerCase();
      const target = (game.title || '').toLowerCase();
      return gTitle.includes(target) || target.includes(gTitle) || (game.dateStr && gTitle.includes(game.dateStr.toLowerCase()));
    });
    const gamePlayers = matchingBookings.reduce((sum, b) => sum + (Number(b.players_count) || 0), 0);
    const pct = Math.min(100, Math.round((gamePlayers / venueCapacity) * 100));
    const remaining = Math.max(0, venueCapacity - gamePlayers);
    const barGradient = pct >= 90
      ? 'linear-gradient(90deg, #ef4444, #dc2626)'
      : pct >= 65
      ? 'linear-gradient(90deg, #f59e0b, #d97706)'
      : 'linear-gradient(90deg, #10b981, #059669)';

    return `
      <div class="capacity-game-card">
        <div class="capacity-card-header">
          <div class="capacity-game-info">
            <span class="capacity-game-badge">Игра #${idx + 1}</span>
            <span class="capacity-game-title">${escapeHtml(game.title)}</span>
          </div>
          <div class="capacity-pct-badge">${pct}%</div>
        </div>
        <div class="capacity-card-meta">
          <span>📅 <b>${escapeHtml(game.dateStr || '')}</b> в ${escapeHtml(game.timeStr || '19:30')}</span>
          <span>📍 ${escapeHtml(config.quiz?.location || 'Караоке-бар «То Место»')}</span>
        </div>
        <div class="capacity-track">
          <div class="capacity-fill" style="width: ${pct}%; background: ${barGradient};"></div>
        </div>
        <div class="capacity-card-footer">
          <span>Занято: <b>${gamePlayers}</b> / ${venueCapacity} мест (<b>${matchingBookings.length}</b> команд)</span>
          <span class="${remaining > 0 ? 'text-success' : 'text-danger'}">
            ${remaining > 0 ? `🟢 Свободно: <b>${remaining}</b> мест` : '🔴 <b>Все места заняты!</b>'}
          </span>
        </div>
      </div>
    `;
  }).join('\n');

  // 2. Table rows
  const tableRows = bookings.map((b, i) => {
    const players = Number(b.players_count) || 0;
    const sum = players * pricePerPlayer;
    let rawPhone = b.captain_phone || '';
    let digits = String(rawPhone).replace(/\D/g, '');
    if (digits.startsWith('8') && digits.length === 11) digits = '7' + digits.slice(1);
    const waUrl = digits ? `https://wa.me/${digits}` : '#';

    const sourceBadge = b.source === 'web'
      ? '<span class="badge badge-blue">Сайт</span>'
      : '<span class="badge badge-green">WhatsApp</span>';

    const statusBadge = b.status === 'cancelled'
      ? '<span class="badge badge-red">Отменена</span>'
      : '<span class="badge badge-emerald">✅ Подтверждена</span>';

    return `
      <tr id="booking-row-${b.id}" class="booking-row" data-game="${escapeHtml(b.game_title || '')}" data-players="${players}" data-sum="${sum}">
        <td class="cell-center text-muted"><b>${b.id || (i + 1)}</b></td>
        <td class="cell-date">${escapeHtml(formatBookingDate(b.created_at))}</td>
        <td class="cell-team"><span class="team-name">${escapeHtml(b.team_name)}</span></td>
        <td class="cell-center"><span class="players-pill">👥 ${players} чел.</span></td>
        <td class="cell-captain">${escapeHtml(b.captain_name)}</td>
        <td class="cell-phone">
          <span class="phone-num">${escapeHtml(rawPhone)}</span>
          ${digits ? `<a href="${waUrl}" target="_blank" class="wa-btn" title="Написать капитану в WhatsApp">💬 WhatsApp</a>` : ''}
        </td>
        <td class="cell-game">${escapeHtml(b.game_title)}</td>
        <td class="cell-date"><b>${escapeHtml(b.game_date)}</b></td>
        <td class="cell-sum">${sum.toLocaleString('ru-RU')} ₸</td>
        <td class="cell-center">${sourceBadge}</td>
        <td class="cell-center">${statusBadge}</td>
        <td class="cell-center">
          <button onclick="deleteBooking(${b.id}, '${escapeHtml(b.team_name)}')" class="del-btn" title="Удалить бронь">🗑️</button>
        </td>
      </tr>
    `;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ACTION Киноквиз — Панель бронирований</title>

  <!-- PWA & Mobile Web App Meta -->
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Киноквиз">
  <meta name="theme-color" content="#f59e0b">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">

  <style>
    :root {
      --bg: #0b0914;
      --card-bg: #151126;
      --card-border: #2c244d;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --border: #231c3d;
      --success: #10b981;
      --error: #ef4444;
      --excel: #107c41;
      --excel-hover: #0b5c30;
      --csv: #2563eb;
      --csv-hover: #1d4ed8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body {
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .wrapper {
      max-width: 1240px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .header-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-title {
      font-size: 26px;
      font-weight: 800;
      color: var(--accent);
      letter-spacing: 0.5px;
    }
    .logo-sub {
      font-size: 13.5px;
      color: var(--muted);
      margin-top: 3px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      border-radius: 9999px;
      font-size: 13.5px;
      font-weight: 700;
    }
    .status-connected {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .status-waiting {
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent);
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 18px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .metric-icon {
      font-size: 32px;
      background: rgba(255,255,255,0.03);
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .metric-val {
      font-size: 24px;
      font-weight: 800;
      color: var(--text);
    }
    .metric-lbl {
      font-size: 12.5px;
      color: var(--muted);
      margin-top: 3px;
    }
    .qr-card-compact {
      background: var(--card-bg);
      border: 1px solid var(--accent);
      border-radius: 16px;
      padding: 20px 24px;
      display: flex;
      align-items: center;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 24px;
    }
    .qr-box {
      background: #ffffff;
      padding: 10px;
      border-radius: 12px;
      display: inline-block;
    }
    .qr-box img {
      display: block;
      width: 170px;
      height: 170px;
    }
    .qr-info {
      max-width: 500px;
      font-size: 13.5px;
      line-height: 1.6;
      color: var(--muted);
    }
    .qr-info h4 {
      color: var(--accent);
      font-size: 16px;
      margin-bottom: 8px;
    }
    .qr-info ol { margin-left: 20px; margin-top: 6px; }

    /* Capacity Progress Section */
    .capacity-section {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .capacity-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .capacity-game-card {
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .capacity-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .capacity-game-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .capacity-game-badge {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .capacity-game-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
    }
    .capacity-pct-badge {
      font-size: 13px;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent);
      border: 1px solid rgba(245, 158, 11, 0.3);
      white-space: nowrap;
    }
    .capacity-card-meta {
      font-size: 12.5px;
      color: var(--muted);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .capacity-track {
      background: rgba(255,255,255,0.06);
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
    }
    .capacity-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.4s ease;
    }
    .capacity-card-footer {
      font-size: 12.5px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .text-success { color: #10b981; }
    .text-danger { color: #ef4444; }

    /* Dedicated Export & Actions Section */
    .export-section {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .export-header {
      font-size: 14px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .export-buttons-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .export-action-btn {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 20px;
      border-radius: 12px;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      color: #fff;
    }
    .export-action-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.3);
    }
    .btn-excel-card {
      background: linear-gradient(135deg, #107c41, #0b5c30);
      border: 1px solid #15803d;
    }
    .btn-csv-card {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      border: 1px solid #1e40af;
    }
    .btn-add-card {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      border: 1px solid #b45309;
      color: #0b0914;
    }
    .btn-add-card .btn-title-main { color: #0b0914; }
    .btn-add-card .btn-desc-sub { color: #451a03; }
    .btn-add-card .btn-icon-large { background: rgba(0,0,0,0.12); color: #0b0914; }
    .btn-sync-card {
      background: linear-gradient(135deg, #374151, #1f2937);
      border: 1px solid #4b5563;
    }
    .btn-icon-large {
      font-size: 26px;
      background: rgba(255,255,255,0.15);
      width: 48px;
      height: 48px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .btn-content {
      display: flex;
      flex-direction: column;
      text-align: left;
    }
    .btn-title-main {
      font-size: 15.5px;
      font-weight: 700;
    }
    .btn-desc-sub {
      font-size: 12px;
      opacity: 0.85;
      margin-top: 3px;
    }

    /* Filter Pills Bar */
    .filter-pills-bar {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 4px;
      flex-wrap: wrap;
    }
    .filter-pill {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 10px 18px;
      border-radius: 999px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .filter-pill:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .filter-pill.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #0b0914;
      font-weight: 700;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.3);
    }
    .pill-badge {
      background: rgba(0,0,0,0.2);
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11.5px;
    }
    .filter-pill.active .pill-badge {
      background: rgba(0,0,0,0.25);
      color: #0b0914;
      font-weight: 800;
    }

    /* Table Toolbar */
    .table-toolbar-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 14px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .search-input {
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 18px;
      color: var(--text);
      font-size: 14px;
      width: 380px;
      max-width: 100%;
      outline: none;
      transition: border 0.2s;
    }
    .search-input:focus {
      border-color: var(--accent);
    }
    .search-counter {
      color: var(--muted);
      font-size: 13.5px;
      font-weight: 600;
    }

    /* Bookings Table */
    .table-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    .table-responsive {
      overflow-x: auto;
      width: 100%;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13.5px;
    }
    thead th {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #000000;
      font-weight: 800;
      font-size: 12.5px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 15px 16px;
      border: none;
      white-space: nowrap;
    }
    tbody td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      vertical-align: middle;
    }
    tbody tr:nth-child(even) {
      background: rgba(255,255,255,0.015);
    }
    tbody tr:hover {
      background: rgba(245, 158, 11, 0.05);
    }
    tfoot td {
      background: rgba(255,255,255,0.04);
      padding: 16px;
      font-weight: 800;
      font-size: 14px;
      color: var(--text);
      border-top: 2px solid var(--border);
    }
    .cell-center { text-align: center; }
    .text-muted { color: var(--muted); }
    .cell-date { white-space: nowrap; color: var(--muted); font-size: 12.5px; }
    .cell-team { color: var(--text); font-size: 14px; }
    .team-name { color: #fff; font-weight: 700; }
    .cell-captain { font-weight: 600; color: #e5e7eb; }
    .cell-game { color: var(--accent); font-weight: 600; }
    .cell-sum { font-weight: 800; color: #fbbf24; font-size: 14px; white-space: nowrap; }
    .players-pill {
      background: rgba(245, 158, 11, 0.15);
      color: var(--accent);
      padding: 5px 12px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 12.5px;
      display: inline-block;
      white-space: nowrap;
    }
    .cell-phone {
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .phone-num {
      font-family: monospace;
      font-size: 13px;
    }
    .wa-btn {
      background: #25d366;
      color: #fff;
      padding: 4px 10px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 11.5px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.2s;
    }
    .wa-btn:hover { background: #1ebd5b; }
    .del-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 16px;
      opacity: 0.6;
      transition: opacity 0.2s, transform 0.2s;
    }
    .del-btn:hover {
      opacity: 1;
      transform: scale(1.2);
    }
    .badge {
      display: inline-block;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge-blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-emerald { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .empty-state {
      padding: 50px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 14.5px;
    }

    /* Modal Dialog */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 16px;
    }
    .modal-card {
      background: #18132e;
      border: 1px solid var(--accent);
      border-radius: 20px;
      max-width: 540px;
      width: 100%;
      padding: 26px 28px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6);
      animation: modalIn 0.25s ease-out;
    }
    @keyframes modalIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 800;
      color: var(--accent);
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 22px;
      cursor: pointer;
      line-height: 1;
      padding: 4px;
      transition: color 0.2s;
    }
    .modal-close:hover { color: #fff; }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 520px) {
      .form-row { grid-template-columns: 1fr; gap: 0; }
    }
    .form-label {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--muted);
    }
    .form-label .req { color: var(--error); }
    .form-input {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 11px 14px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-input:focus {
      border-color: var(--accent);
    }
    .form-input option {
      background: #18132e;
      color: #fff;
    }
    .modal-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--error);
      color: #f87171;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
    }
    .btn-cancel {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 10px 18px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13.5px;
    }
    .btn-cancel:hover { color: #fff; border-color: var(--muted); }
    .btn-submit {
      background: var(--accent);
      border: none;
      color: #0b0914;
      padding: 10px 22px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 800;
      font-size: 13.5px;
      transition: background 0.2s, transform 0.1s;
    }
    .btn-submit:hover { background: #d97706; transform: translateY(-1px); }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>

  <script>
    let currentFilter = 'all';

    async function checkStatusAndQr() {
      try {
        const res = await fetch('/api/qr-data');
        const data = await res.json();
        if (data.status === 'connected') {
          const badge = document.getElementById('status-badge');
          if (badge && !badge.classList.contains('status-connected')) {
            window.location.reload();
          }
          return;
        }
        if (data.qrDataUrl) {
          const img = document.getElementById('qr-img');
          if (img && img.src !== data.qrDataUrl) {
            img.src = data.qrDataUrl;
          }
          const box = document.getElementById('qr-box-container');
          if (box) box.style.display = 'block';
        }
      } catch (e) {}
    }

    async function requestFreshQr() {
      const btn = document.getElementById('refresh-btn');
      if (btn) btn.innerText = '⏳ Обновляем...';
      try {
        await fetch('/api/restart-auth', { method: 'POST' });
        setTimeout(async () => {
          await checkStatusAndQr();
          if (btn) btn.innerText = '🔄 Получить новый QR-код';
        }, 3000);
      } catch (e) {
        if (btn) btn.innerText = '🔄 Получить новый QR-код';
      }
    }

    async function syncGames() {
      const titleSpan = document.getElementById('sync-btn-title');
      if (titleSpan) titleSpan.innerText = '⏳ Синхронизация...';
      try {
        const res = await fetch('/api/sync-games', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          alert('✅ Расписание игр успешно синхронизировано с GitHub!\n\n' + (data.message || 'Все игры актуальны.'));
          window.location.reload();
        } else {
          alert('⚠️ Ошибка обновления: ' + (data.error || 'Не удалось обновить'));
        }
      } catch (e) {
        alert('⚠️ Ошибка соединения с сервером');
      } finally {
        if (titleSpan) titleSpan.innerText = 'Обновить игры';
      }
    }

    async function deleteBooking(id, teamName) {
      if (!confirm('Удалить бронь команды «' + teamName + '»?')) return;
      try {
        const res = await fetch('/api/bookings/delete?id=' + id, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          window.location.reload();
        } else {
          alert('Ошибка при удалении брони');
        }
      } catch (e) {
        alert('Ошибка сети при удалении');
      }
    }

    function setGameFilter(game, btnEl) {
      currentFilter = game;
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      if (btnEl) btnEl.classList.add('active');
      applyFilters();
    }

    function filterTable() {
      applyFilters();
    }

    function applyFilters() {
      const searchVal = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
      const rows = document.querySelectorAll('#bookingsTable tbody tr.booking-row');
      let visibleCount = 0;
      let visiblePlayers = 0;
      let visibleSum = 0;

      rows.forEach(r => {
        const rowText = r.innerText.toLowerCase();
        const rowGame = (r.getAttribute('data-game') || '').toLowerCase();
        const players = Number(r.getAttribute('data-players')) || 0;
        const sum = Number(r.getAttribute('data-sum')) || 0;

        const matchesSearch = !searchVal || rowText.includes(searchVal);
        let matchesGame = true;
        if (currentFilter !== 'all') {
          const filterLower = currentFilter.toLowerCase();
          matchesGame = rowGame.includes(filterLower) || filterLower.includes(rowGame);
        }

        const visible = matchesSearch && matchesGame;
        r.style.display = visible ? '' : 'none';

        if (visible) {
          visibleCount++;
          visiblePlayers += players;
          visibleSum += sum;
        }
      });

      const countEl = document.getElementById('search-count');
      if (countEl) countEl.innerText = 'Показано: ' + visibleCount + ' из ' + rows.length;

      const fPlayers = document.getElementById('footer-players');
      if (fPlayers) fPlayers.innerText = '👥 ' + visiblePlayers + ' чел.';

      const fSum = document.getElementById('footer-sum');
      if (fSum) fSum.innerText = visibleSum.toLocaleString('ru-RU') + ' ₸';
    }

    function openBookingModal() {
      const modal = document.getElementById('bookingModal');
      if (modal) {
        modal.style.display = 'flex';
        document.getElementById('mTeamName')?.focus();
      }
    }

    function closeBookingModal() {
      const modal = document.getElementById('bookingModal');
      if (modal) modal.style.display = 'none';
      const errEl = document.getElementById('modalError');
      if (errEl) errEl.style.display = 'none';
    }

    async function submitBooking(event) {
      event.preventDefault();
      const errEl = document.getElementById('modalError');
      const submitBtn = document.getElementById('mSubmitBtn');
      if (errEl) errEl.style.display = 'none';

      const teamName = document.getElementById('mTeamName')?.value.trim();
      const captainName = document.getElementById('mCaptainName')?.value.trim();
      const captainPhone = document.getElementById('mCaptainPhone')?.value.trim();
      const playersCount = parseInt(document.getElementById('mPlayersCount')?.value, 10) || 5;
      const gameRaw = document.getElementById('mGameSelect')?.value || '';
      const [gameTitle, gameDate] = gameRaw.split('|');
      const notes = document.getElementById('mNotes')?.value.trim() || '';

      if (!teamName || !captainName || !captainPhone) {
        if (errEl) {
          errEl.innerText = 'Пожалуйста, заполните все обязательные поля';
          errEl.style.display = 'block';
        }
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = '⏳ Сохранение...';
      }

      try {
        const res = await fetch('/api/bookings/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teamName,
            captainName,
            captainPhone,
            playersCount,
            gameTitle,
            gameDate,
            source: 'web',
            status: 'confirmed',
            notes
          })
        });

        const data = await res.json();
        if (data.ok) {
          alert('✅ Бронь команды «' + teamName + '» успешно добавлена!\nУведомление отправлено в Telegram.');
          closeBookingModal();
          window.location.reload();
        } else {
          if (errEl) {
            errEl.innerText = 'Ошибка: ' + (data.error || 'Не удалось сохранить бронь');
            errEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errEl) {
          errEl.innerText = 'Ошибка сети при сохранении';
          errEl.style.display = 'block';
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerText = '💾 Зарегистрировать';
        }
      }
    }

    setInterval(checkStatusAndQr, 4000);
  </script>
</head>
<body>
  <div class="wrapper">
    <!-- Header -->
    <div class="header-card">
      <div>
        <div class="logo-title">🎬 ACTION Киноквиз</div>
        <div class="logo-sub">Панель управления бронированиями и WhatsApp Бот • г. Караганда</div>
      </div>
      <div>
        ${
          isConnected
            ? `<div id="status-badge" class="status-badge status-connected"><span>●</span> Бот онлайн: +${botPhone || 'WhatsApp'}</div>`
            : `<div id="status-badge" class="status-badge status-waiting"><span>●</span> Ожидание привязки WhatsApp</div>`
        }
      </div>
    </div>

    <!-- QR block (if waiting) -->
    ${
      !isConnected
        ? `
      <div class="qr-card-compact">
        <div style="text-align: center;">
          <div id="qr-box-container">
            <div class="qr-box">
              <img id="qr-img" src="${qrDataUrl || ''}" alt="WhatsApp QR">
            </div>
          </div>
          <button id="refresh-btn" onclick="requestFreshQr()" class="btn-sync-card" style="margin-top: 10px; font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer; color: #fff;">🔄 Новый QR-код</button>
        </div>
        <div class="qr-info">
          <h4>📲 Привязка номера WhatsApp</h4>
          <p>Отсканируйте этот QR-код прямо с телефона организатора:</p>
          <ol>
            <li>Откройте <b>WhatsApp</b> на телефоне.</li>
            <li>Зайдите в <b>Настройки</b> ➔ <b>Связанные устройства</b>.</li>
            <li>Нажмите <b>Привязка устройства</b> и наведите камеру на QR-код.</li>
          </ol>
        </div>
      </div>
      `
        : ''
    }

    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-icon">🎯</div>
        <div>
          <div class="metric-val">${bookings.length}</div>
          <div class="metric-lbl">Команд зарегистрировано</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">👥</div>
        <div>
          <div class="metric-val">${totalPlayers}</div>
          <div class="metric-lbl">Всего участников</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">💰</div>
        <div>
          <div class="metric-val">${totalRevenue.toLocaleString('ru-RU')} ₸</div>
          <div class="metric-lbl">Общая сумма (${pricePerPlayer.toLocaleString('ru-RU')} ₸/чел)</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">📱</div>
        <div>
          <div class="metric-val">${contactsCount}</div>
          <div class="metric-lbl">Капитанов в базе</div>
        </div>
      </div>
    </div>

    <!-- Capacity Progress Bars for Active Games -->
    <div class="capacity-section">
      <div class="section-title">📊 Заполняемость зала («То Место», макс ${venueCapacity} мест)</div>
      <div class="capacity-grid">
        ${capacityCardsHtml || '<div class="text-muted">Нет активных игр в расписании</div>'}
      </div>
    </div>

    <!-- Actions & Export Buttons Section -->
    <div class="export-section">
      <div class="export-header">📥 Действия и выгрузка</div>
      <div class="export-buttons-grid">
        <button onclick="openBookingModal()" class="export-action-btn btn-add-card">
          <div class="btn-icon-large">➕</div>
          <div class="btn-content">
            <span class="btn-title-main">Добавить бронь</span>
            <span class="btn-desc-sub">Быстрая регистрация команды</span>
          </div>
        </button>

        <a href="/api/export/excel" class="export-action-btn btn-excel-card" download target="_blank">
          <div class="btn-icon-large">📊</div>
          <div class="btn-content">
            <span class="btn-title-main">Скачать в Excel (.xlsx)</span>
            <span class="btn-desc-sub">Официальный формат для телефона и ПК</span>
          </div>
        </a>

        <a href="/api/export/csv" class="export-action-btn btn-csv-card" download target="_blank">
          <div class="btn-icon-large">📄</div>
          <div class="btn-content">
            <span class="btn-title-main">Скачать в CSV (.csv)</span>
            <span class="btn-desc-sub">Таблица с разделителями UTF-8</span>
          </div>
        </a>

        <button id="sync-btn" onclick="syncGames()" class="export-action-btn btn-sync-card">
          <div class="btn-icon-large">🔄</div>
          <div class="btn-content">
            <span id="sync-btn-title" class="btn-title-main">Обновить игры</span>
            <span class="btn-desc-sub">Синхронизация расписания с GitHub</span>
          </div>
        </button>
      </div>
    </div>

    <!-- Filter Pills for Bookings Table -->
    <div class="filter-pills-bar">
      <button class="filter-pill active" onclick="setGameFilter('all', this)">
        🌟 Все игры <span class="pill-badge">${bookings.length}</span>
      </button>
      ${activeGames.map((game) => {
        const matchingCount = bookings.filter(b => {
          const gTitle = (b.game_title || '').toLowerCase();
          const target = (game.title || '').toLowerCase();
          return gTitle.includes(target) || target.includes(gTitle) || (game.dateStr && gTitle.includes(game.dateStr.toLowerCase()));
        }).length;
        const shortTitle = game.title.length > 28 ? game.title.slice(0, 26) + '…' : game.title;
        return `
          <button class="filter-pill" onclick="setGameFilter('${escapeHtml(game.title)}', this)">
            🎬 ${escapeHtml(shortTitle)} (${escapeHtml(game.dateStr)}) <span class="pill-badge">${matchingCount}</span>
          </button>
        `;
      }).join('\n')}
    </div>

    <!-- Table Toolbar: Search & Counter -->
    <div class="table-toolbar-card">
      <input type="text" id="searchInput" class="search-input" placeholder="🔍 Быстрый поиск по команде, капитану, телефону..." oninput="filterTable()">
      <div id="search-count" class="search-counter">Показано: ${bookings.length} из ${bookings.length}</div>
    </div>

    <!-- Bookings Table -->
    <div class="table-card">
      <div class="table-responsive">
        <table id="bookingsTable">
          <thead>
            <tr>
              <th class="cell-center" style="width: 45px;">№</th>
              <th>Дата заявки</th>
              <th>Команда</th>
              <th class="cell-center">Игроков</th>
              <th>Капитан</th>
              <th>Телефон</th>
              <th>Игра</th>
              <th>Дата игры</th>
              <th>К оплате</th>
              <th class="cell-center">Источник</th>
              <th class="cell-center">Статус</th>
              <th class="cell-center" style="width: 50px;">Удалить</th>
            </tr>
          </thead>
          <tbody>
            ${
              tableRows ||
              '<tr><td colspan="12" class="empty-state">Броней пока нет. Они появятся здесь сразу при регистрации с сайта или из WhatsApp!</td></tr>'
            }
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="text-align: right; color: var(--accent);">ИТОГО (показано):</td>
              <td class="cell-center" style="color: var(--accent);"><span id="footer-players">👥 ${totalPlayers} чел.</span></td>
              <td colspan="4"></td>
              <td style="color: #fbbf24; font-size: 15px;"><span id="footer-sum">${totalRevenue.toLocaleString('ru-RU')} ₸</span></td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  </div>

  <!-- Modal for Fast Manual Booking -->
  <div id="bookingModal" class="modal-backdrop" style="display: none;" onclick="if(event.target === this) closeBookingModal()">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">➕ Быстрая регистрация команды</div>
        <button type="button" class="modal-close" onclick="closeBookingModal()">✕</button>
      </div>
      <form id="manualBookingForm" onsubmit="submitBooking(event)">
        <div class="form-group">
          <label class="form-label">Название команды <span class="req">*</span></label>
          <input type="text" id="mTeamName" class="form-input" required placeholder="Например: Акацуки, Томас Шелби">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Имя капитана <span class="req">*</span></label>
            <input type="text" id="mCaptainName" class="form-input" required placeholder="Имя капитана">
          </div>
          <div class="form-group">
            <label class="form-label">Телефон (WhatsApp) <span class="req">*</span></label>
            <input type="tel" id="mCaptainPhone" class="form-input" required placeholder="+7 777 123 45 67">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Кол-во участников <span class="req">*</span></label>
            <select id="mPlayersCount" class="form-input">
              <option value="2">👥 2 человека</option>
              <option value="3">👥 3 человека</option>
              <option value="4">👥 4 человека</option>
              <option value="5" selected>👥 5 человек (стандарт)</option>
              <option value="6">👥 6 человек</option>
              <option value="7">👥 7 человек</option>
              <option value="8">👥 8 человек</option>
              <option value="9">👥 9 человек</option>
              <option value="10">👥 10 человек</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Игра <span class="req">*</span></label>
            <select id="mGameSelect" class="form-input">
              ${activeGames.map((g) => `<option value="${escapeHtml(g.title)}|${escapeHtml(g.dateStr)}">${escapeHtml(g.title)} (${escapeHtml(g.dateStr)})</option>`).join('\n')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Примечание / пожелания (необязательно)</label>
          <input type="text" id="mNotes" class="form-input" placeholder="Например: стол у сцены, день рождения">
        </div>
        <div id="modalError" class="modal-error" style="display: none;"></div>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" onclick="closeBookingModal()">Отмена</button>
          <button type="submit" id="mSubmitBtn" class="btn-submit">💾 Зарегистрировать</button>
        </div>
      </form>
    </div>
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

  if (url.pathname === '/api/qr-data') {
    let qrDataUrl = null;
    if (currentQrCode) {
      try {
        qrDataUrl = await QRCode.toDataURL(currentQrCode);
      } catch (err) {
        logger.error({ err }, 'Failed to generate QR data URL');
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isConnected ? 'connected' : currentQrCode ? 'qr_ready' : 'starting',
        qrDataUrl
      })
    );
    return;
  }

  if (url.pathname === '/manifest.json') {
    const manifest = {
      name: 'ACTION Киноквиз — Панель',
      short_name: 'Киноквиз',
      description: 'Панель управления бронированиями и ботом ACTION Киноквиз Караганда',
      start_url: '/',
      display: 'standalone',
      background_color: '#0b0914',
      theme_color: '#f59e0b',
      icons: [
        {
          src: '/icon.svg',
          sizes: '192x192 512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable'
        }
      ]
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify(manifest, null, 2));
    return;
  }

  if (url.pathname === '/icon.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)" />
  <text x="50%" y="54%" font-size="64" text-anchor="middle" dominant-baseline="middle">🎬</text>
</svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end(svg);
    return;
  }

  if (url.pathname === '/api/restart-auth') {
    logger.info('Received request for fresh QR code generation - clearing auth directory...');
    currentQrCode = null;
    isConnected = false;
    if (currentSock) {
      try {
        currentSock.end();
      } catch (e) {}
      currentSock = null;
    }
    try {
      const authDir = path.resolve(config.authDir);
      if (fs.existsSync(authDir)) {
        const files = fs.readdirSync(authDir);
        for (const file of files) {
          fs.rmSync(path.join(authDir, file), { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to clear auth directory in /api/restart-auth');
    }
    setTimeout(() => {
      startBot().catch((e) => logger.error({ e }, 'Error restarting bot'));
    }, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Cleared credentials and restarting auth...' }));
    return;
  }

  if (url.pathname === '/api/export/csv') {
    try {
      const csvContent = await exportBookingsCsv(db);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `bookings_${timestamp}.csv`;
      const csvBuffer = Buffer.from(csvContent, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': csvBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(csvBuffer);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/export/excel' || url.pathname === '/api/export/xlsx') {
    try {
      const xlsxBuffer = exportBookingsToXlsxBuffer(db, { pricePerPlayer: config.quiz?.pricePerPlayer || 3000 });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `kinoquiz_bookings_${timestamp}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': xlsxBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(xlsxBuffer);
    } catch (err) {
      logger.error({ err }, 'Error exporting to XLSX');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/export/xls') {
    try {
      const excelHtml = exportBookingsToExcelHtml(db, { pricePerPlayer: config.quiz?.pricePerPlayer || 3000 });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `kinoquiz_bookings_${timestamp}.xls`;
      const excelBuffer = Buffer.from(excelHtml, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': excelBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(excelBuffer);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/sync-games' && req.method === 'POST') {
    logger.info('Manual games sync triggered via dashboard');
    const syncRes = await syncRepositoryGames();
    if (syncRes.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: syncRes.output }));
      if (syncRes.hasUpdates) {
        setTimeout(() => process.exit(0), 1000);
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: syncRes.error }));
    }
    return;
  }

  if (url.pathname === '/api/restart-server' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Server restarting...' }));
    setTimeout(() => process.exit(0), 500);
    return;
  }

  if (url.pathname === '/api/bookings/create' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const booking = db.bookings.create({
          teamName: payload.teamName || payload.team_name,
          captainName: payload.captainName || payload.captain_name,
          captainPhone: payload.captainPhone || payload.captain_phone,
          playersCount: payload.playersCount || payload.players_count,
          gameTitle: payload.gameTitle || payload.game_title,
          gameDate: payload.gameDate || payload.game_date,
          source: payload.source || 'web',
          status: payload.status || 'confirmed',
          notes: payload.notes || ''
        });

        let telegramResult = null;
        try {
          telegramResult = await sendBookingAlert(booking);
        } catch (tgErr) {
          logger.warn({ tgErr }, 'Telegram alert failed in /api/bookings/create');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, booking, telegram: telegramResult }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/bookings/delete' && req.method === 'POST') {
    const id = url.searchParams.get('id');
    if (id && db.bookings.delete(id)) {
      logger.info({ bookingId: id }, 'Booking deleted via dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Booking not found' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/**
 * Automatically pulls latest games and repository changes from GitHub.
 */
async function syncRepositoryGames() {
  try {
    const repoDir = path.resolve(botRootDir, '..');
    const { stdout, stderr } = await execAsync('git pull --ff-only', { cwd: repoDir });
    const output = (stdout || '').trim();
    const hasUpdates = output.includes('Updating') || output.includes('Fast-forward') || output.includes('files changed');
    logger.info({ stdout: output, stderr: (stderr || '').trim(), hasUpdates }, 'Repository auto-synced from GitHub');
    return { ok: true, output: output || 'Уже обновлено (Already up to date).', hasUpdates };
  } catch (err) {
    logger.warn({ err: err.message }, 'Auto-sync git pull skipped or failed');
    return { ok: false, error: err.message, hasUpdates: false };
  }
}

webServer.listen(config.qrPort, '0.0.0.0', () => {
  logger.info(`Web QR & Dashboard running at http://0.0.0.0:${config.qrPort}`);

  // Schedule auto-sync: Nightly at 00:30 (after Instagram sync at 00:00) and every 4 hours
  try {
    cron.schedule('30 0 * * *', () => {
      logger.info('Scheduled nightly git sync triggered...');
      syncRepositoryGames();
    }, { timezone: config.timezone });

    cron.schedule('0 */4 * * *', () => {
      logger.info('Scheduled 4-hour periodic git sync triggered...');
      syncRepositoryGames();
    }, { timezone: config.timezone });
    logger.info('Automated game sync cron jobs initialized (nightly 00:30 + 4-hour interval)');
  } catch (cronErr) {
    logger.warn({ cronErr }, 'Failed to schedule automatic git sync cron');
  }

  // Start Telegram Bot Poller for direct in-chat management and Excel downloads
  if (config.telegram?.enabled) {
    try {
      startTelegramPoller({ db, config, logger, syncRepositoryGames });
      logger.info('Telegram Bot Poller active for @actionquiz_bot');
    } catch (tgPollerErr) {
      logger.warn({ tgPollerErr }, 'Failed to start Telegram Bot Poller');
    }
  }
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
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
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

      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const shouldReconnect = !isLoggedOut;
      logger.warn({ statusCode, shouldReconnect, isLoggedOut }, 'WhatsApp connection closed');

      if (scheduler && typeof scheduler.stop === 'function') {
        scheduler.stop();
      }

      if (isLoggedOut) {
        logger.warn('WhatsApp session was logged out by user. Clearing auth directory to generate a fresh QR code...');
        try {
          if (fs.existsSync(authDir)) {
            const files = fs.readdirSync(authDir);
            for (const file of files) {
              fs.rmSync(path.join(authDir, file), { recursive: true, force: true });
            }
          }
        } catch (clearErr) {
          logger.error({ clearErr }, 'Failed to clear auth directory on logout');
        }
        logger.info('Starting fresh bot session in 2 seconds...');
        setTimeout(() => startBot(), 2000);
      } else if (shouldReconnect) {
        logger.info('Reconnecting to WhatsApp in 3 seconds...');
        setTimeout(() => startBot(), 3000);
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
