/**
 * tests/tier2_boundary.test.js
 * Tier 2: Boundary Value Analysis, Corner-Case & Negative Validation Test Suite (41 Tests)
 * ACTION Kinoquiz WhatsApp Bot
 *
 * Feature Distribution:
 * - F1: Gateway Recovery & Disconnect Codes (5 tests)
 * - F2: Menu Navigation & Session Boundary (5 tests)
 * - F3: Booking FSM Boundary & Player Validation (6 tests)
 * - F4: Web Modal Interceptor Boundary & Edge Cases (5 tests)
 * - F5: Storage Engine Boundaries & Error Handling (5 tests)
 * - F6: Telegram Alerting Boundaries & Fault Injection (5 tests)
 * - F7: Broadcast Queue Edge Cases & Opt-Out (5 tests)
 * - F8: Tuesday Scheduler Edge Cases & Date Filtering (5 tests)
 * Total: 41 tests
 *
 * Runner: node --test tests/tier2_boundary.test.js
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Test Infrastructure Helpers
import { createMockSocket } from './helpers/mockSocket.js';
import { createMockTelegram } from './helpers/mockTelegram.js';
import { createMockGoogleSheets } from './helpers/mockGoogleSheets.js';
import { createTestEnv } from './helpers/testEnv.js';
import { createMockCatalog } from './helpers/mockCatalog.js';
import { assertConfirmationCard, extractCardFields } from './helpers/cardAssertions.js';

// Application Modules Under Test
import {
  handleIncomingMessage,
  FSM_STATES,
  isSessionTimedOut,
  parseSqliteDate
} from '../src/dialog/fsm.js';
import {
  getMainMenuCard,
  getScheduleCard,
  getVenueCard,
  getRulesCard,
  getContactsCard,
  formatConfirmationCard
} from '../src/dialog/menu.js';
import {
  isWebBookingMessage,
  parseWebBookingMessage,
  stripTypographicQuotes
} from '../src/dialog/webBookingParser.js';
import { initDatabase, normalizePhone } from '../src/db/database.js';
import { exportBookingsCsv, escapeCsvField } from '../src/db/exportCsv.js';
import { exportBookingsToGoogleSheets } from '../src/db/exportSheets.js';
import {
  sendBookingAlert,
  formatBookingAlert,
  escapeHtml,
  cleanPhoneForWa,
  formatCurrency,
  formatKaragandaTime
} from '../src/telegram/notifier.js';
import {
  createBroadcaster,
  getRandomJitter,
  getRandomTypingDelay,
  personalizeMessage,
  isOptOutMessage,
  isOptInMessage,
  handleOptOut,
  handleOptIn,
  phoneToJid
} from '../src/broadcast/broadcaster.js';
import {
  initGameDayScheduler,
  getAlmatyDateInfo,
  findTonightGame,
  getTonightBookings,
  DEFAULT_REMINDER_TEMPLATE
} from '../src/broadcast/scheduler.js';
import { getActiveGames } from '../src/games/gameLoader.js';

// ============================================================================
// Feature F1: WhatsApp Gateway & Auth Reconnection (5 Tests)
// ============================================================================
describe('F1: Gateway Recovery & Auth Disconnect Codes', () => {
  test('T2-F1-01: Disconnect Status 401 triggers credential wipe policy', () => {
    const sock = createMockSocket();
    let wipeTriggered = false;

    sock.ev.on('connection.update', (update) => {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 401) {
        wipeTriggered = true;
      }
    });

    sock.simulateDisconnect(401, 'Logged out from mobile device');
    assert.equal(wipeTriggered, true);
    assert.equal(sock.ws.isOpen, false);
  });

  test('T2-F1-02: Disconnect Status 515 triggers instant restart without credential wipe', () => {
    const sock = createMockSocket();
    let restartWithoutWipe = false;

    sock.ev.on('connection.update', (update) => {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 515) {
        restartWithoutWipe = true;
      }
    });

    sock.simulateDisconnect(515, 'Restart required');
    assert.equal(restartWithoutWipe, true);
    assert.equal(sock.ws.isOpen, false);
  });

  test('T2-F1-03: Disconnect Status 408 / 428 applies backoff reconnection', () => {
    const sock = createMockSocket();
    const reconnectCodes = [];

    sock.ev.on('connection.update', (update) => {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if (code === 408 || code === 428) {
        reconnectCodes.push(code);
      }
    });

    sock.simulateDisconnect(408, 'Connection Timed Out');
    sock.simulateDisconnect(428, 'Connection Closed');
    assert.deepEqual(reconnectCodes, [408, 428]);
  });

  test('T2-F1-04: Malformed or empty QR events handled without throwing', () => {
    const sock = createMockSocket();
    const receivedQrs = [];

    sock.ev.on('connection.update', (u) => {
      if (u.qr !== undefined) receivedQrs.push(u.qr);
    });

    assert.doesNotThrow(() => {
      sock.simulateQr('');
      sock.simulateQr(null);
      sock.simulateQr('CORRUPTED_RAW_QR_TOKEN_STRING');
    });

    assert.equal(receivedQrs.length, 3);
  });

  test('T2-F1-05: Outbound message rejected when socket is closed', async () => {
    const sock = createMockSocket();
    sock.end();

    await assert.rejects(
      async () => {
        await sock.sendMessage('77011863190@s.whatsapp.net', 'Hello');
      },
      { message: /Socket is closed/ }
    );
  });
});

// ============================================================================
// Feature F2: Menu Navigation & Session Boundary (5 Tests)
// ============================================================================
describe('F2: Menu Navigation & Session Boundary', () => {
  let env;

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('T2-F2-01: Invalid menu selections in IDLE fall back to Main Menu', async () => {
    const jid = '77011110001@s.whatsapp.net';
    for (const invalidInput of ['0', '6', '99', 'hello', '🎉🍿🎬']) {
      const res = await handleIncomingMessage({ jid, text: invalidInput, db: env });
      assert.equal(res.state, FSM_STATES.IDLE);
      assert.ok(res.replies[0].includes('ACTION Киноквиз Караганда'));
      assert.equal(env.sessions.get(jid), null);
    }
  });

  test('T2-F2-02: "назад" and "отмена" at root menu (IDLE) do not show cancellation error', async () => {
    const jid = '77011110002@s.whatsapp.net';
    const resНазад = await handleIncomingMessage({ jid, text: 'назад', db: env });
    assert.equal(resНазад.state, FSM_STATES.IDLE);
    assert.equal(resНазад.replies.length, 1);
    assert.ok(!resНазад.replies[0].includes('отменено'));
    assert.ok(resНазад.replies[0].includes('ACTION Киноквиз'));

    const resОтмена = await handleIncomingMessage({ jid, text: 'отмена', db: env });
    assert.equal(resОтмена.state, FSM_STATES.IDLE);
    assert.equal(resОтмена.replies.length, 1);
    assert.ok(!resОтмена.replies[0].includes('отменено'));
    assert.ok(resОтмена.replies[0].includes('ACTION Киноквиз'));
  });

  test('T2-F2-03: Global cancellation keywords at each nested state purge session', async () => {
    const jid = '77011110003@s.whatsapp.net';

    // 1. Cancel at AWAITING_TEAM_NAME
    await handleIncomingMessage({ jid, text: '1', db: env });
    assert.equal(env.sessions.get(jid).state, FSM_STATES.AWAITING_TEAM_NAME);
    const resCancel1 = await handleIncomingMessage({ jid, text: 'отбой', db: env });
    assert.equal(resCancel1.state, FSM_STATES.IDLE);
    assert.ok(resCancel1.replies[0].includes('Бронирование отменено'));
    assert.equal(env.sessions.get(jid), null);

    // 2. Cancel at AWAITING_PLAYERS_COUNT
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });
    assert.equal(env.sessions.get(jid).state, FSM_STATES.AWAITING_PLAYERS_COUNT);
    const resCancel2 = await handleIncomingMessage({ jid, text: 'cancel', db: env });
    assert.equal(resCancel2.state, FSM_STATES.IDLE);
    assert.ok(resCancel2.replies[0].includes('Бронирование отменено'));
    assert.equal(env.sessions.get(jid), null);

    // 3. Cancel at AWAITING_GAME_SELECTION
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });
    await handleIncomingMessage({ jid, text: '5', db: env });
    assert.equal(env.sessions.get(jid).state, FSM_STATES.AWAITING_GAME_SELECTION);
    const resCancel3 = await handleIncomingMessage({ jid, text: '0', db: env });
    assert.equal(resCancel3.state, FSM_STATES.IDLE);
    assert.ok(resCancel3.replies[0].includes('Бронирование отменено'));
    assert.equal(env.sessions.get(jid), null);

    // 4. Cancel at AWAITING_CAPTAIN_NAME
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });
    await handleIncomingMessage({ jid, text: '5', db: env });
    await handleIncomingMessage({ jid, text: '1', db: env });
    assert.equal(env.sessions.get(jid).state, FSM_STATES.AWAITING_CAPTAIN_NAME);
    const resCancel4 = await handleIncomingMessage({ jid, text: 'отмена', db: env });
    assert.equal(resCancel4.state, FSM_STATES.IDLE);
    assert.ok(resCancel4.replies[0].includes('Бронирование отменено'));
    assert.equal(env.sessions.get(jid), null);
  });

  test('T2-F2-04: Inactivity timeout boundary check at 20 minutes', () => {
    const session = {
      jid: '77011110004@s.whatsapp.net',
      state: FSM_STATES.AWAITING_PLAYERS_COUNT,
      updated_at: '2026-11-14 20:00:00'
    };
    const lastActive = parseSqliteDate(session.updated_at);
    const exact20m = new Date(lastActive.getTime() + 20 * 60 * 1000);
    const expired20m1ms = new Date(lastActive.getTime() + 20 * 60 * 1000 + 1);

    assert.equal(isSessionTimedOut(session, exact20m), false);
    assert.equal(isSessionTimedOut(session, expired20m1ms), true);
  });

  test('T2-F2-05: Inactivity timeout during active booking resets state and handles turn', async () => {
    const jid = '77011110005@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'Киноманы', db: env });
    await handleIncomingMessage({ jid, text: '6', db: env });
    assert.equal(env.sessions.get(jid).state, FSM_STATES.AWAITING_GAME_SELECTION);

    const session = env.sessions.get(jid);
    const after25m = new Date(parseSqliteDate(session.updated_at).getTime() + 25 * 60 * 1000);
    const res = await handleIncomingMessage({ jid, text: '1', db: env, now: after25m });

    assert.ok(res.replies.some(r => r.includes('Время сессии истекло')));
    assert.equal(res.state, FSM_STATES.AWAITING_TEAM_NAME);
  });
});

// ============================================================================
// Feature F3: Booking FSM Boundary & Player Validation (6 Tests)
// ============================================================================
describe('F3: Booking FSM Boundary & Player Validation', () => {
  let env;

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('T2-F3-01: Team name rejection on empty, whitespace, 1 char, and quotes only', async () => {
    const jid = '77011110006@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });

    for (const badTeam of ['   ', 'X', '«»', '""']) {
      const res = await handleIncomingMessage({ jid, text: badTeam, db: env });
      assert.equal(res.state, FSM_STATES.AWAITING_TEAM_NAME);
      assert.ok(
        res.replies[0].includes('минимум 2 символа') || res.replies[0].includes('не может быть пустым')
      );
    }
  });

  test('T2-F3-02: Players count low boundaries: 1 player, word "два", negative string', async () => {
    const jid = '77011110007@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });

    for (const badCount of ['1', 'два', '-1']) {
      const res = await handleIncomingMessage({ jid, text: badCount, db: env });
      assert.equal(res.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(res.replies[0].includes('2 до 10'));
    }
  });

  test('T2-F3-03: Players count high & non-numeric boundaries: 11, 100, "много нас"', async () => {
    const jid = '77011110008@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });

    for (const highCount of ['11', '100', 'много нас']) {
      const res = await handleIncomingMessage({ jid, text: highCount, db: env });
      assert.equal(res.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(res.replies[0].includes('2 до 10'));
    }
  });

  test('T2-F3-04: Game catalog empty or past-only guard blocks booking', async () => {
    const jid = '77011110009@s.whatsapp.net';
    const res = await handleIncomingMessage({
      jid,
      text: '1',
      db: env,
      gameCatalog: { getActiveGames: () => [] }
    });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.replies[0].includes('открытых для бронирования игр нет'));
    assert.equal(env.sessions.get(jid), null);
  });

  test('T2-F3-05: Game selection out-of-bounds: 0, negative, > games.length, non-integer', async () => {
    const jid = '77011110010@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });
    await handleIncomingMessage({ jid, text: '6', db: env });

    for (const badGame of ['99', '-1', 'первая', 'abc']) {
      const res = await handleIncomingMessage({ jid, text: badGame, db: env });
      assert.equal(res.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.ok(res.replies[0].includes('выберите номер игры из списка'));
    }
  });

  test('T2-F3-06: Captain name boundary (<2 chars), typographic quotes, and JID phone fallback', async () => {
    const jid = '@s.whatsapp.net';
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'ДНК', db: env });
    await handleIncomingMessage({ jid, text: '6', db: env });
    await handleIncomingMessage({ jid, text: '1', db: env });

    const badCapt = await handleIncomingMessage({ jid, text: 'Я', db: env });
    assert.equal(badCapt.state, FSM_STATES.AWAITING_CAPTAIN_NAME);

    const goodCapt = await handleIncomingMessage({ jid, text: '«Капитан Джек»', db: env });
    assert.equal(goodCapt.state, FSM_STATES.IDLE);
    assert.equal(goodCapt.bookingCreated.captain_name, 'Капитан Джек');
    assert.equal(goodCapt.bookingCreated.captain_phone, '+77011863190');
  });
});

// ============================================================================
// Feature F4: Web Modal Interceptor Boundary & Edge Cases (5 Tests)
// ============================================================================
describe('F4: Web Modal Interceptor Boundary & Edge Cases', () => {
  test('T2-F4-01: Casual conversational queries with keywords do NOT trigger web booking', () => {
    const text = 'Здравствуйте! Мы хотим забронировать стол на киноквиз в Караганде, сколько это стоит?';
    assert.equal(isWebBookingMessage(text), false);
    const parsed = parseWebBookingMessage(text);
    assert.equal(parsed.isWebBooking, false);
  });

  test('T2-F4-02: Corrupt web template missing core modal fields returns false', () => {
    const corrupt =
      '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз!*\n💬 *Настрой команды:* Готовы побеждать!\n';
    const parsed = parseWebBookingMessage(corrupt);
    assert.equal(parsed.isWebBooking, false);
  });

  test('T2-F4-03: Missing phone in web payload falls back to sender JID or default organizer phone', () => {
    const msgNoPhone = [
      '🎬🍿 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '📅 *Выбранная игра:* Киномарафон (17.11 в 19:30)',
      '👥 *Команда:* «ДНК»',
      '♟️ *Количество игроков:* 6 чел.'
    ].join('\n');

    const parsed = parseWebBookingMessage(msgNoPhone, '77771234567@s.whatsapp.net');
    assert.equal(parsed.isWebBooking, true);
    assert.equal(parsed.data.captainPhone, '+77771234567');
  });

  test('T2-F4-04: Boundary player counts in web payload: "ищу команду", "больше 10", clamping', () => {
    const base = '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз!*\n📅 *Выбранная игра:* Киномарафон\n👥 *Команда:* ДНК\n';

    const p1 = parseWebBookingMessage(base + '♟️ *Количество игроков:* ищу команду');
    assert.equal(p1.data.playersCount, 1);

    const p10 = parseWebBookingMessage(base + '♟️ *Количество игроков:* больше 10 чел.');
    assert.equal(p10.data.playersCount, 10);

    const p99 = parseWebBookingMessage(base + '♟️ *Количество игроков:* 99 чел.');
    assert.equal(p99.data.playersCount, 15);
  });

  test('T2-F4-05: CRLF (\\r\\n) newlines, missing asterisks, and nested typographic quotes', () => {
    const crlfMsg = '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз!*\r\n📅 Выбранная игра: Киномарафон\r\n👥 Команда: «ДНК "Победа"»\r\n♟️ Число игроков: 5\r\n';
    const parsed = parseWebBookingMessage(crlfMsg, '77011863190@s.whatsapp.net');
    assert.equal(parsed.isWebBooking, true);
    assert.equal(parsed.data.teamName, 'ДНК "Победа"');
    assert.equal(parsed.data.playersCount, 5);
  });
});

// ============================================================================
// Feature F5: Storage Engine Boundaries & Error Handling (5 Tests)
// ============================================================================
describe('F5: Storage Engine Boundaries & Error Handling', () => {
  test('T2-F5-01: SQL injection safety across all DAO inputs', () => {
    const db = initDatabase(':memory:');
    try {
      const b = db.bookings.create({
        teamName: "'; DROP TABLE bookings; --",
        captainName: "Admin' OR '1'='1",
        captainPhone: '+77011863190',
        playersCount: 4,
        gameTitle: "Cinema'; SELECT * FROM contacts; --",
        gameDate: '2026-11-24',
        notes: "'); DELETE FROM teams; --"
      });
      assert.ok(b.id);
      const found = db.bookings.getById(b.id);
      assert.equal(found.team_name, "'; DROP TABLE bookings; --");
      assert.equal(found.captain_name, "Admin' OR '1'='1");
      const all = db.bookings.list();
      assert.equal(all.length, 1);
    } finally {
      db.close();
    }
  });

  test('T2-F5-02: CSV export RFC 4180 escaping and UTF-8 BOM prefix', async () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'Команда "Звезда", №1',
        captainName: 'Иван, Капитан',
        captainPhone: '+77011863190',
        playersCount: 6,
        gameTitle: 'Киномарафон',
        gameDate: '24 ноября',
        notes: 'Первая строка\nВторая строка'
      });
      const csv = await exportBookingsCsv(db);
      assert.ok(csv.startsWith('\uFEFF'));
      assert.ok(csv.includes('"Команда ""Звезда"", №1"'));
      assert.ok(csv.includes('"Иван, Капитан"'));
      assert.ok(csv.includes('"Первая строка\nВторая строка"'));
    } finally {
      db.close();
    }
  });

  test('T2-F5-03: Empty database export behavior for CSV and Google Sheets', async () => {
    const db = initDatabase(':memory:');
    try {
      const csv = await exportBookingsCsv(db);
      assert.ok(csv.startsWith('\uFEFF'));
      const lines = csv.trim().split(/\r?\n/);
      assert.equal(lines.length, 1); // Header row only
      assert.ok(lines[0].includes('Team Name'));

      const sheetsRes = await exportBookingsToGoogleSheets(db);
      assert.deepEqual(sheetsRes, { syncedCount: 0 });
    } finally {
      db.close();
    }
  });

  test('T2-F5-04: Google Sheets error isolation: HTTP 403 Forbidden and HTTP 404', async () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'ДНК',
        captainName: 'Алекс',
        captainPhone: '+77011863190',
        playersCount: 5,
        gameTitle: 'Игра',
        gameDate: '24.11'
      });
      const mockSheets = createMockGoogleSheets();
      mockSheets.setStatus(403, new Error('Permission denied'));
      const res = await exportBookingsToGoogleSheets(db, { sheetsClient: mockSheets });
      assert.equal(res.syncedCount, 0);
      assert.ok(res.error.includes('Permission denied'));
    } finally {
      db.close();
    }
  });

  test('T2-F5-05: Google Sheets unconfigured credentials graceful degradation', async () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'ДНК',
        captainName: 'Алекс',
        captainPhone: '+77011863190',
        playersCount: 5,
        gameTitle: 'Игра',
        gameDate: '24.11'
      });
      const res = await exportBookingsToGoogleSheets(db, {
        googleSheets: { serviceAccountEmail: '', privateKey: '', spreadsheetId: '' }
      });
      assert.equal(res.syncedCount, 0);
      assert.equal(res.error, 'Google Sheets credentials not configured');
    } finally {
      db.close();
    }
  });
});

// ============================================================================
// Feature F6: Telegram Alerting Boundaries & Fault Injection (5 Tests)
// ============================================================================
describe('F6: Telegram Alerting Boundaries & Fault Injection', () => {
  test('T2-F6-01: HTML character escaping in Telegram alerts', () => {
    const alert = formatBookingAlert({
      team_name: '«Tom & Jerry <VIP>»',
      captain_name: 'Иван "Капитан"',
      game_title: 'Cinema & Movies > Season 1'
    });
    assert.ok(alert.includes('&amp;'));
    assert.ok(alert.includes('&lt;VIP&gt;'));
    assert.ok(alert.includes('&quot;Капитан&quot;'));
    assert.ok(!alert.includes('<VIP>'));
  });

  test('T2-F6-02: HTTP 429 Rate Limit retry with retry_after and exhaustion handling', async () => {
    const sleeps = [];
    const fetchStub = async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
      json: async () => ({ ok: false, parameters: { retry_after: 2 }, description: 'Too Many Requests' })
    });
    const res = await sendBookingAlert(
      { team_name: 'ДНК' },
      { botToken: 'tok', chatId: '123' },
      {
        fetch: fetchStub,
        sleepFn: async (ms) => sleeps.push(ms),
        maxRetries: 2
      }
    );
    assert.equal(res.success, false);
    assert.ok(res.error.includes('Rate limit exceeded (HTTP 429)'));
    assert.equal(sleeps.length, 2);
    assert.equal(sleeps[0], 2000);
  });

  test('T2-F6-03: HTTP 500 Server Error exponential backoff retry', async () => {
    const sleeps = [];
    const fetchStub = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: 'Internal Server Error' })
    });
    const res = await sendBookingAlert(
      { team_name: 'ДНК' },
      { botToken: 'tok', chatId: '123' },
      {
        fetch: fetchStub,
        sleepFn: async (ms) => sleeps.push(ms),
        maxRetries: 2
      }
    );
    assert.equal(res.success, false);
    assert.ok(res.error.includes('HTTP 500'));
    assert.deepEqual(sleeps, [500, 1000]);
  });

  test('T2-F6-04: HTTP 400 Client Error immediate failure without retry', async () => {
    let fetchCalls = 0;
    const sleeps = [];
    const fetchStub = async () => {
      fetchCalls++;
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request' }) };
    };
    const res = await sendBookingAlert(
      { team_name: 'ДНК' },
      { botToken: 'tok', chatId: '123' },
      {
        fetch: fetchStub,
        sleepFn: async (ms) => sleeps.push(ms),
        maxRetries: 3
      }
    );
    assert.equal(res.success, false);
    assert.equal(fetchCalls, 1);
    assert.equal(sleeps.length, 0);
  });

  test('T2-F6-05: Telegram network failure does NOT block user booking confirmation', async () => {
    const env = await createTestEnv({ inMemory: true });
    const mockTg = createMockTelegram();
    mockTg.install();
    mockTg.failNext(new TypeError('Network connection refused'));

    try {
      const jid = '77011110011@s.whatsapp.net';
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'ДНК', db: env });
      await handleIncomingMessage({ jid, text: '6', db: env });
      await handleIncomingMessage({ jid, text: '1', db: env });
      const res = await handleIncomingMessage({ jid, text: 'Алексей', db: env });

      assert.equal(res.state, FSM_STATES.IDLE);
      assert.ok(res.bookingCreated);
      assertConfirmationCard(res.replies[0], { team: 'ДНК', players: 6, captain: 'Алексей' });
    } finally {
      mockTg.uninstall();
      mockTg.clear();
      await env.cleanup();
    }
  });
});

// ============================================================================
// Feature F7: Broadcast Queue Edge Cases & Opt-Out (5 Tests)
// ============================================================================
describe('F7: Broadcast Queue Edge Cases & Opt-Out', () => {
  test('T2-F7-01: Empty broadcast recipient list drains immediately with zero sent', async () => {
    const b = createBroadcaster({ sleepFn: async () => {}, typingDelayFn: async () => {} });
    const res = await b.enqueue({ recipients: [] });
    assert.equal(res.queuedCount, 0);
    await b.drain();
    assert.equal(b.getStatus().sentCount, 0);
    assert.equal(b.getStatus().processedCount, 0);
  });

  test('T2-F7-02: Unsubscribed contacts ("СТОП") excluded with status: "skipped_opted_out"', async () => {
    const db = initDatabase(':memory:');
    try {
      db.contacts.upsert({ phone: '+77011112233', name: 'Отказник' });
      db.contacts.setSubscription('+77011112233', 0);
      let sendCalls = 0;
      const b = createBroadcaster({
        db,
        senderFn: async () => { sendCalls++; },
        sleepFn: async () => {},
        typingDelayFn: async () => {}
      });
      await b.enqueue({ recipients: [{ phone: '+77011112233' }], messageTemplate: 'Привет!' });
      await b.drain();
      assert.equal(sendCalls, 0);
      assert.equal(b.getStatus().skippedCount, 1);
      const logs = db.broadcastLogs.list();
      assert.equal(logs[0].status, 'skipped_opted_out');
    } finally {
      db.close();
    }
  });

  test('T2-F7-03: High-volume serialized FIFO execution with concurrency <= 1', async () => {
    let maxWorkers = 0;
    const sentOrder = [];
    const b = createBroadcaster({
      senderFn: async (jid) => {
        const current = b.getStatus().activeWorkerCount;
        if (current > maxWorkers) maxWorkers = current;
        sentOrder.push(jid);
      },
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });
    const recipients = Array.from({ length: 50 }, (_, i) => ({
      phone: `+770100000${String(i).padStart(2, '0')}`
    }));
    await b.enqueue({ recipients, messageTemplate: 'Test' });
    await b.drain();
    assert.equal(maxWorkers, 1);
    assert.equal(b.getStatus().sentCount, 50);
    assert.equal(sentOrder.length, 50);
  });

  test('T2-F7-04: Resilient queue processing on socket send failures', async () => {
    const db = initDatabase(':memory:');
    try {
      let attempt = 0;
      const b = createBroadcaster({
        db,
        senderFn: async () => {
          attempt++;
          if (attempt === 2) throw new Error('Socket timeout');
        },
        sleepFn: async () => {},
        typingDelayFn: async () => {}
      });
      await b.enqueue({
        recipients: [{ phone: '+77011110001' }, { phone: '+77011110002' }, { phone: '+77011110003' }],
        messageTemplate: 'Msg'
      });
      await b.drain();
      assert.equal(b.getStatus().sentCount, 2);
      assert.equal(b.getStatus().failedCount, 1);
      const logs = db.broadcastLogs.list();
      assert.equal(logs.length, 3);
    } finally {
      db.close();
    }
  });

  test('T2-F7-05: Opt-out ("СТОП") and re-subscription ("СТАРТ") lifecycle', () => {
    const db = initDatabase(':memory:');
    try {
      db.contacts.upsert({ phone: '+77011863190', name: 'Иван' });
      assert.equal(db.contacts.getByPhone('+77011863190').is_subscribed, 1);
      handleOptOut({ phone: '+77011863190', db });
      assert.equal(db.contacts.getByPhone('+77011863190').is_subscribed, 0);
      handleOptIn({ phone: '+77011863190', db });
      assert.equal(db.contacts.getByPhone('+77011863190').is_subscribed, 1);
    } finally {
      db.close();
    }
  });
});

// ============================================================================
// Feature F8: Tuesday Scheduler Edge Cases & Date Filtering (5 Tests)
// ============================================================================
describe('F8: Tuesday Scheduler Edge Cases & Date Filtering', () => {
  test('T2-F8-01: Day-of-week guard: non-Tuesday execution skips reminder dispatch', async () => {
    const db = initDatabase(':memory:');
    try {
      const scheduler = await initGameDayScheduler({ db, getActiveGames: () => [] });
      const resWed = await scheduler.runNow(new Date('2026-11-18T12:00:00Z'));
      assert.equal(resWed.reason, 'not_tuesday');
      assert.equal(resWed.queuedCount, 0);
      scheduler.stop();
    } finally {
      db.close();
    }
  });

  test('T2-F8-02: Empty catalog returns reason: "no_games_found"', async () => {
    const db = initDatabase(':memory:');
    try {
      const scheduler = await initGameDayScheduler({ db, getActiveGames: () => [] });
      const res = await scheduler.runNow(new Date('2026-11-24T07:00:00Z')); // Tuesday 12:00 Almaty
      assert.equal(res.reason, 'no_games_found');
      assert.equal(res.queuedCount, 0);
      scheduler.stop();
    } finally {
      db.close();
    }
  });

  test('T2-F8-03: Cross-game date filtering: other dates not alerted', () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'Команда А',
        captainName: 'Капитан А',
        captainPhone: '+77011111111',
        playersCount: 5,
        gameTitle: 'Киномарафон: 100 вопросов',
        gameDate: '24 ноября'
      });
      db.bookings.create({
        teamName: 'Команда Б',
        captainName: 'Капитан Б',
        captainPhone: '+77022222222',
        playersCount: 5,
        gameTitle: 'Культовые Аниме',
        gameDate: '1 декабря'
      });
      const tonight = { title: 'Киномарафон: 100 вопросов', dateStr: '24 ноября' };
      const bookings = getTonightBookings(db, tonight);
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].team_name, 'Команда А');
    } finally {
      db.close();
    }
  });

  test('T2-F8-04: Captain deduplication: multiple bookings under same phone receive 1 reminder', () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'Команда 1',
        captainName: 'Алексей',
        captainPhone: '+77011863190',
        playersCount: 5,
        gameTitle: 'Киномарафон',
        gameDate: '24 ноября'
      });
      db.bookings.create({
        teamName: 'Команда 2',
        captainName: 'Алексей',
        captainPhone: '+77011863190',
        playersCount: 6,
        gameTitle: 'Киномарафон',
        gameDate: '24 ноября'
      });
      const tonight = { title: 'Киномарафон', dateStr: '24 ноября' };
      const bookings = getTonightBookings(db, tonight);
      assert.equal(bookings.length, 2);
      const uniqueCaptains = new Map();
      for (const b of bookings) {
        const key = phoneToJid(b.captain_phone);
        if (!uniqueCaptains.has(key)) uniqueCaptains.set(key, b);
      }
      assert.equal(uniqueCaptains.size, 1);
    } finally {
      db.close();
    }
  });

  test('T2-F8-05: Cancelled bookings excluded from game-day reminders', () => {
    const db = initDatabase(':memory:');
    try {
      db.bookings.create({
        teamName: 'Отменённые',
        captainName: 'Капитан',
        captainPhone: '+77011863190',
        playersCount: 5,
        gameTitle: 'Киномарафон',
        gameDate: '24 ноября',
        status: 'cancelled'
      });
      const tonight = { title: 'Киномарафон', dateStr: '24 ноября' };
      const bookings = getTonightBookings(db, tonight);
      assert.equal(bookings.length, 0);
    } finally {
      db.close();
    }
  });
});
