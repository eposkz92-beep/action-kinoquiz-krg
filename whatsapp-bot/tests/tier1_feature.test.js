/**
 * tests/tier1_feature.test.js
 * Tier 1: Feature Coverage Test Suite (40 Test Cases across F1-F8)
 * ACTION Kinoquiz WhatsApp Bot
 *
 * Runner: node --test tests/tier1_feature.test.js
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Test Infrastructure Helpers
import { createMockSocket } from './helpers/mockSocket.js';
import { createMockTelegram } from './helpers/mockTelegram.js';
import {
  createMockGoogleSheets,
  EXPECTED_SCHEMA_COLUMNS,
  EXPECTED_EXPORT_COLUMNS
} from './helpers/mockGoogleSheets.js';
import { createTestEnv } from './helpers/testEnv.js';
import { createMockCatalog } from './helpers/mockCatalog.js';
import {
  assertConfirmationCard,
  extractCardFields,
  cleanCardValue
} from './helpers/cardAssertions.js';

// Application Modules Under Test
import { initDatabase, normalizePhone } from '../src/db/database.js';
import { exportBookingsCsv } from '../src/db/exportCsv.js';
import { exportBookingsToGoogleSheets } from '../src/db/exportSheets.js';
import { getActiveGames } from '../src/games/gameLoader.js';
import { handleIncomingMessage, FSM_STATES, isSessionTimedOut } from '../src/dialog/fsm.js';
import {
  getMainMenuCard,
  getMainMenuText,
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
import {
  escapeHtml,
  cleanPhoneForWa,
  formatCurrency,
  formatKaragandaTime,
  formatBookingAlert,
  sendBookingAlert
} from '../src/telegram/notifier.js';
import {
  getRandomJitter,
  getRandomTypingDelay,
  phoneToJid,
  personalizeMessage,
  isOptOutMessage,
  isOptInMessage,
  handleOptOut,
  handleOptIn,
  createBroadcaster,
  enqueueBroadcast
} from '../src/broadcast/broadcaster.js';
import {
  getAlmatyDateInfo,
  findTonightGame,
  getTonightBookings,
  initGameDayScheduler,
  DEFAULT_REMINDER_TEMPLATE
} from '../src/broadcast/scheduler.js';

// ============================================================================
// Feature F1: WhatsApp Gateway & Auth Lifecycle (R1) - 5 Tests
// ============================================================================
describe('F1: WhatsApp Gateway & Auth Lifecycle (R1)', () => {
  test('F1-01: Socket initialization & bot profile identity', () => {
    const sock = createMockSocket();
    assert.ok(sock.ev, 'Must expose EventEmitter ev');
    assert.ok(sock.user, 'Must expose user profile');
    assert.equal(sock.user.id, '77011863190:0@s.whatsapp.net');
    assert.equal(sock.user.name, 'ACTION Kinoquiz Bot');
    assert.equal(sock.ws.isOpen, true);
    assert.equal(sock.sentMessages.length, 0);
  });

  test('F1-02: QR code event dispatch (simulateQr)', () => {
    const sock = createMockSocket();
    let qrEvent = null;
    sock.ev.on('connection.update', (update) => {
      if (update.qr) qrEvent = update;
    });

    sock.simulateQr('2@TEST_QR_CODE_PAIRING_PAYLOAD');
    assert.ok(qrEvent);
    assert.equal(qrEvent.connection, 'connecting');
    assert.equal(qrEvent.qr, '2@TEST_QR_CODE_PAIRING_PAYLOAD');
  });

  test('F1-03: Connection open event dispatch (simulateOpen)', () => {
    const sock = createMockSocket();
    let openEvent = null;
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') openEvent = update;
    });

    sock.simulateOpen(true);
    assert.ok(openEvent);
    assert.equal(openEvent.connection, 'open');
    assert.equal(openEvent.isNewLogin, true);
    assert.equal(sock.ws.isOpen, true);
  });

  test('F1-04: Message dispatch & outbound store (sendMessage)', async () => {
    const sock = createMockSocket();
    const recipientJid = '77015551234@s.whatsapp.net';

    // Verify incoming dispatch
    let incomingEvent = null;
    sock.ev.on('messages.upsert', (ev) => { incomingEvent = ev; });
    sock.simulateIncomingMessage({ jid: recipientJid, text: 'Привет' });
    assert.ok(incomingEvent);
    assert.equal(incomingEvent.messages[0].message.conversation, 'Привет');

    // Verify outbound sendMessage
    const sendResult = await sock.sendMessage(recipientJid, { text: 'Здравствуйте! Главное меню' });
    assert.equal(sock.sentMessages.length, 1);
    assert.equal(sock.getLastMessage().text, 'Здравствуйте! Главное меню');
    assert.equal(sendResult.key.remoteJid, recipientJid);
  });

  test('F1-05: Credential update & socket teardown (end)', () => {
    const sock = createMockSocket();
    let credsUpdated = false;
    let closedEvent = null;

    sock.ev.on('creds.update', () => { credsUpdated = true; });
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'close') closedEvent = u;
    });

    sock.simulateCredsUpdate({ noiseKey: 'test-key' });
    assert.equal(credsUpdated, true);

    sock.end();
    assert.equal(sock.ws.isOpen, false);
    assert.ok(closedEvent);
    assert.equal(closedEvent.connection, 'close');
  });
});

// ============================================================================
// Feature F2: Menu Navigation & Inactivity (R2) - 5 Tests
// ============================================================================
describe('F2: Menu Navigation & Inactivity (R2)', () => {
  let env;
  const jid = '77011863190@s.whatsapp.net';

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F2-01: Greeting / unrecognized input returns Main Menu', async () => {
    const res = await handleIncomingMessage({ jid, text: 'Привет!', db: env });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.equal(res.replies.length, 1);
    assert.ok(res.replies[0].includes('ACTION Киноквиз Караганда'));
    assert.ok(res.replies[0].includes('1️⃣'));
    assert.ok(res.replies[0].includes('5️⃣'));
    assert.ok(!res.replies[0].includes('**'));
  });

  test('F2-02: Menu option 2 / афиша returns Schedule card', async () => {
    const res2 = await handleIncomingMessage({ jid, text: '2', db: env });
    assert.equal(res2.state, FSM_STATES.IDLE);
    assert.ok(res2.replies[0].includes('Афиша игр'));
    assert.ok(res2.replies[0].includes('Киномарафон'));

    const resWord = await handleIncomingMessage({ jid, text: 'афиша', db: env });
    assert.ok(resWord.replies[0].includes('Афиша игр'));
  });

  test('F2-03: Menu option 3 / адрес returns Venue & 2GIS', async () => {
    const res = await handleIncomingMessage({ jid, text: '3', db: env });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.replies[0].includes('То Место'));
    assert.ok(res.replies[0].includes('Нуркена Абдирова, д. 5'));
    assert.ok(res.replies[0].includes('2gis.kz'));
  });

  test('F2-04: Menu option 4 / правила returns Rules & Leagues', async () => {
    const res = await handleIncomingMessage({ jid, text: '4', db: env });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.replies[0].includes('Падаваны'));
    assert.ok(res.replies[0].includes('Джедаи'));
    assert.ok(res.replies[0].includes('3 000 ₸'));
  });

  test('F2-05: Menu option 5 / контакты returns Organizer contact', async () => {
    const res = await handleIncomingMessage({ jid, text: '5', db: env });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.replies[0].includes('+7 701 186 31 90'));
    assert.ok(res.replies[0].includes('wa.me/77011863190'));
    assert.ok(res.replies[0].includes('@action_kinoquiz_krg'));
  });
});

// ============================================================================
// Feature F3: Interactive Booking FSM (R2) - 5 Tests
// ============================================================================
describe('F3: Interactive Booking FSM (R2)', () => {
  let env;
  const jid = '77011863190@s.whatsapp.net';

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F3-01: Step 1: Start booking (1) transitions to AWAITING_TEAM_NAME', async () => {
    const res = await handleIncomingMessage({ jid, text: '1', db: env });
    assert.equal(res.state, FSM_STATES.AWAITING_TEAM_NAME);
    assert.ok(res.replies[0].includes('Как называется ваша команда?'));

    const session = env.sessions.get(jid);
    assert.ok(session);
    assert.equal(session.state, FSM_STATES.AWAITING_TEAM_NAME);
  });

  test('F3-02: Step 2: Team name transitions to AWAITING_PLAYERS_COUNT', async () => {
    await handleIncomingMessage({ jid, text: '1', db: env });
    const res = await handleIncomingMessage({ jid, text: 'Интерстеллар', db: env });

    assert.equal(res.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
    assert.ok(res.replies[0].includes('Интерстеллар'));
    assert.ok(res.replies[0].includes('количество человек'));

    const session = env.sessions.get(jid);
    assert.equal(session.data.teamName, 'Интерстеллар');
  });

  test('F3-03: Step 3: Players count transitions to AWAITING_GAME_SELECTION', async () => {
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'Интерстеллар', db: env });
    const res = await handleIncomingMessage({ jid, text: '6', db: env });

    assert.equal(res.state, FSM_STATES.AWAITING_GAME_SELECTION);
    assert.ok(res.replies[0].includes('Выберите игру из списка'));

    const session = env.sessions.get(jid);
    assert.equal(session.data.playersCount, 6);
    assert.ok(session.data.availableGames.length > 0);
  });

  test('F3-04: Step 4: Game index selection transitions to AWAITING_CAPTAIN_NAME', async () => {
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'Интерстеллар', db: env });
    await handleIncomingMessage({ jid, text: '6', db: env });
    const res = await handleIncomingMessage({ jid, text: '1', db: env });

    assert.equal(res.state, FSM_STATES.AWAITING_CAPTAIN_NAME);
    assert.ok(res.replies[0].includes('имя капитана'));

    const session = env.sessions.get(jid);
    assert.ok(session.data.selectedGame);
  });

  test('F3-05: Step 5: Captain name completes booking & generates confirmation card', async () => {
    await handleIncomingMessage({ jid, text: '1', db: env });
    await handleIncomingMessage({ jid, text: 'Интерстеллар', db: env });
    await handleIncomingMessage({ jid, text: '6', db: env });
    await handleIncomingMessage({ jid, text: '1', db: env });
    const res = await handleIncomingMessage({ jid, text: 'Купер', db: env });

    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.bookingCreated, 'Booking record must be returned');
    assert.equal(res.bookingCreated.team_name, 'Интерстеллар');
    assert.equal(res.bookingCreated.players_count, 6);
    assert.equal(res.bookingCreated.captain_name, 'Купер');

    // WhatsApp single-asterisk card validation
    assertConfirmationCard(res.replies[0], {
      team: 'Интерстеллар',
      players: 6,
      captain: 'Купер',
      venue: 'То Место',
      fee: '3 000'
    });

    // Session cleared from database
    assert.equal(env.sessions.get(jid), null);
  });
});

// ============================================================================
// Feature F4: Web Booking Interceptor (R2) - 5 Tests
// ============================================================================
describe('F4: Web Booking Interceptor (R2)', () => {
  let env;
  const jid = '77011863190@s.whatsapp.net';

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F4-01: Standard web booking message regex parsing', () => {
    const rawMessage = [
      '🎬🍿 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Киномарафон: 100 вопросов (17.11 в 19:30) 🎯',
      '💬 *Настрой команды:* Готовы побеждать!',
      '👥 *Команда:* «ДНК»',
      '♟️ *Количество игроков:* 6 чел.',
      '🏆 *Лига:* Падаваны (новички)',
      '📱 *Телефон капитана:* +7 701 186 31 90',
      '',
      '📍 *Место:* Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
      '💰 *Взнос:* 3 000 ₸ с игрока',
      '🎟️ Ждём подтверждения брони стола!'
    ].join('\n');

    assert.equal(isWebBookingMessage(rawMessage), true);
    const parsed = parseWebBookingMessage(rawMessage, jid);
    assert.equal(parsed.isWebBooking, true);
    assert.equal(parsed.data.teamName, 'ДНК');
    assert.equal(parsed.data.playersCount, 6);
    assert.equal(parsed.data.captainPhone, '+77011863190');
  });

  test('F4-02: Direct web booking creation & instant confirmation', async () => {
    const webMsg = [
      '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '📅 *Выбранная игра:* Киномарафон',
      '👥 *Команда:* «Острые Козырьки»',
      '♟️ *Количество игроков:* 8 чел.',
      '📱 *Телефон капитана:* +7 701 186 31 90'
    ].join('\n');

    const res = await handleIncomingMessage({ jid, text: webMsg, db: env });
    assert.equal(res.state, FSM_STATES.IDLE);
    assert.ok(res.bookingCreated);
    assert.equal(res.bookingCreated.source, 'web_modal');
    assert.equal(res.bookingCreated.team_name, 'Острые Козырьки');

    assertConfirmationCard(res.replies[0], {
      team: 'Острые Козырьки',
      players: 8
    });
  });

  test('F4-03: Multi-theme emoji header parsing', () => {
    const themes = [
      '🦊⛩️⚔️ *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '⚡🧙‍♂️🏰 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '🐺🧛‍♂️🌲 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*'
    ];

    for (const header of themes) {
      const msg = [
        header,
        '📅 *Выбранная игра:* Игра',
        '👥 *Команда:* «Тест»',
        '♟️ *Количество игроков:* 5'
      ].join('\n');
      assert.equal(isWebBookingMessage(msg), true);
      const parsed = parseWebBookingMessage(msg, jid);
      assert.equal(parsed.isWebBooking, true);
      assert.equal(parsed.data.teamName, 'Тест');
    }
  });

  test('F4-04: Typographic quotes stripping in team names', () => {
    assert.equal(stripTypographicQuotes('«ДНК»'), 'ДНК');
    assert.equal(stripTypographicQuotes('„ДНК“'), 'ДНК');
    assert.equal(stripTypographicQuotes('“ДНК”'), 'ДНК');
    assert.equal(stripTypographicQuotes('«Клуб "Кино"»'), 'Клуб "Кино"');
  });

  test('F4-05: Missing captain phone line falls back to sender JID', () => {
    const msg = [
      '*Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '👥 *Команда:* «Без Телефона»',
      '♟️ *Количество игроков:* 4 чел.',
      '📅 *Выбранная игра:* Киномарафон'
    ].join('\n');

    const parsed = parseWebBookingMessage(msg, '77028889900@s.whatsapp.net');
    assert.equal(parsed.isWebBooking, true);
    assert.equal(parsed.data.captainPhone, '+77028889900');
  });
});

// ============================================================================
// Feature F5: Storage Engine & Data Exports (R3) - 5 Tests
// ============================================================================
describe('F5: Storage Engine & Data Exports (R3)', () => {
  let env;

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F5-01: SQLite tables and indexes initialization', () => {
    const tables = env.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('teams'));
    assert.ok(tables.includes('bookings'));
    assert.ok(tables.includes('contacts'));
    assert.ok(tables.includes('broadcast_logs'));
    assert.ok(tables.includes('user_sessions'));
  });

  test('F5-02: Bookings CRUD operations', () => {
    const created = env.bookings.create({
      teamName: 'Киноманы',
      captainName: 'Алексей',
      captainPhone: '+7 701 186 31 90',
      playersCount: 6,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '2026-11-24',
      source: 'whatsapp_bot'
    });

    assert.ok(created.id > 0);
    const fetched = env.bookings.getById(created.id);
    assert.equal(fetched.team_name, 'Киноманы');
    assert.equal(fetched.captain_phone, '+77011863190');

    const filtered = env.bookings.list({ gameTitle: 'Киномарафон: 100 вопросов' });
    assert.equal(filtered.length, 1);
  });

  test('F5-03: Contacts upsert & deduplication by phone', () => {
    const c1 = env.contacts.upsert({
      phone: '+77011863190',
      name: 'Алексей',
      teamName: 'Киноманы'
    });
    assert.equal(c1.is_subscribed, 1);

    const c2 = env.contacts.upsert({
      phone: '+77011863190',
      name: 'Алексей Обновленный',
      teamName: 'Супер Киноманы'
    });
    assert.equal(c2.name, 'Алексей Обновленный');

    const list = env.contacts.listForBroadcast();
    assert.equal(list.filter(c => c.phone === '+77011863190').length, 1);
  });

  test('F5-04: Local CSV export with UTF-8 BOM & RFC 4180 escaping', async () => {
    env.seedBooking({
      teamName: 'Команда «Звезда» & Co!',
      captainName: 'Иван',
      captainPhone: '+77011112233',
      playersCount: 5,
      gameTitle: 'Аниме',
      notes: 'Стол "VIP"\nВторая строка'
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
    const outputPath = path.join(tempDir, 'export.csv');

    const csv = await exportBookingsCsv(env.db, outputPath);
    assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');
    assert.ok(csv.includes('ID,Created At,Team Name,Captain Name'));
    assert.ok(csv.includes('""VIP""'));
    assert.ok(fs.existsSync(outputPath));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('F5-05: Google Sheets export synchronization', async () => {
    const mockSheets = createMockGoogleSheets();
    env.seedBooking({
      teamName: 'Синхро-Команда',
      captainName: 'Тестер',
      captainPhone: '+77019998877',
      playersCount: 6,
      gameTitle: 'Киномарафон',
      gameDate: '2026-11-24'
    });

    const res = await exportBookingsToGoogleSheets(env.db, { sheetsClient: mockSheets });
    assert.equal(res.syncedCount, 1);
    assert.equal(mockSheets.listRows().length, 1);
    const row = mockSheets.listRows()[0];
    assert.equal(row.length, 10);
    assert.equal(row[2], 'Синхро-Команда');
  });
});

// ============================================================================
// Feature F6: Telegram Organizer Alerting (R4) - 5 Tests
// ============================================================================
describe('F6: Telegram Organizer Alerting (R4)', () => {
  const telegram = createMockTelegram();

  afterEach(() => {
    telegram.uninstall();
    telegram.clear();
  });

  test('F6-01: Structured Telegram HTML alert card generation', () => {
    const booking = {
      id: 42,
      team_name: '«Киноманы»',
      captain_name: 'Алексей',
      captain_phone: '+7 701 186 31 90',
      players_count: 6,
      game_title: 'Киномарафон',
      game_date: '24 ноября (ВТ, 19:30)',
      source: 'whatsapp_bot'
    };

    const card = formatBookingAlert(booking, { pricePerPlayer: 3000 });
    assert.match(card, /🎟️ <b>НОВАЯ БРОНЬ СТОЛА — ACTION КИНОКВИЗ<\/b>/);
    assert.match(card, /🎬 <b>Игра:<\/b> Киномарафон/);
    assert.match(card, /👥 <b>Команда:<\/b> ««Киноманы»»/);
    assert.match(card, /🔢 <b>Игроков:<\/b> 6 чел\. \(взнос: 18 000 ₸\)/);
    assert.match(card, /📱 <b>WhatsApp:<\/b> <a href="https:\/\/wa\.me\/77011863190">\+7 701 186 31 90<\/a>/);
    assert.match(card, /🆔 <b>ID брони:<\/b> #42/);
  });

  test('F6-02: HTML special characters escaping', () => {
    assert.equal(escapeHtml('«Киноманы & VIP» <Pro>'), '«Киноманы &amp; VIP» &lt;Pro&gt;');
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('F6-03: Telegram alert dispatch via Bot API', async () => {
    telegram.install();

    const booking = {
      id: 10,
      team_name: 'Победители',
      captain_name: 'Алексей',
      captain_phone: '+77011863190',
      players_count: 4,
      game_title: 'Marvel vs DC',
      game_date: '24 ноября'
    };

    const config = {
      botToken: 'TEST_TOKEN',
      chatId: '-1001234567890'
    };

    const result = await sendBookingAlert(booking, config);
    assert.equal(result.success, true);
    assert.equal(telegram.requests.length, 1);

    const alert = telegram.getLastAlert();
    assert.equal(alert.chat_id, '-1001234567890');
    assert.equal(alert.parse_mode, 'HTML');
    assert.match(alert.text, /Победители/);
  });

  test('F6-04: Graceful skip when Telegram credentials unconfigured', async () => {
    const booking = { team_name: 'БезТокена', players_count: 4 };
    const res = await sendBookingAlert(booking, { botToken: '', chatId: '' });
    assert.equal(res.success, false);
    assert.ok(res.error.includes('not configured'));
  });

  test('F6-05: Non-blocking error isolation on Telegram failures', async () => {
    telegram.install();
    telegram.setStatus(500);

    const booking = { team_name: 'Изоляция', players_count: 4 };
    const config = { botToken: 'TEST_TOKEN', chatId: '-1001234567890' };

    const res = await sendBookingAlert(booking, config, { maxRetries: 0 });
    assert.equal(res.success, false);
    assert.ok(res.error);
  });
});

// ============================================================================
// Feature F7: Broadcast Queue & Anti-Ban (R5) - 5 Tests
// ============================================================================
describe('F7: Broadcast Queue & Anti-Ban (R5)', () => {
  let env;
  let mockSocket;

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
    mockSocket = createMockSocket();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F7-01: Template token personalization', () => {
    const template = 'Привет, {{captain}}! Команда {{team}} играет в {{game}} {{date}} в {{time}}. Взнос: {{price}}.';
    const params = {
      captain: 'Алексей',
      team: '«Киноманы»',
      game: 'Marvel',
      date: '24 ноября',
      time: '19:30',
      price: '3 000 ₸'
    };

    const res = personalizeMessage(template, params);
    assert.equal(res, 'Привет, Алексей! Команда «Киноманы» играет в Marvel 24 ноября в 19:30. Взнос: 3 000 ₸.');
  });

  test('F7-02: Randomized anti-ban jitter & typing delay bounds', () => {
    for (let i = 0; i < 100; i++) {
      const jitter = getRandomJitter(3000, 7000);
      assert.ok(jitter >= 3000 && jitter <= 7000);
      const typing = getRandomTypingDelay(1000, 2000);
      assert.ok(typing >= 1000 && typing <= 2000);
    }
  });

  test('F7-03: Serialized FIFO broadcast queue execution', async () => {
    const recordedDelays = [];
    const broadcaster = createBroadcaster({
      db: env,
      sock: mockSocket,
      sleepFn: async (ms) => { recordedDelays.push(ms); },
      typingDelayFn: async () => {}
    });

    const recipients = [
      { phone: '+77011110001', name: 'Капитан 1', team: 'Команда 1' },
      { phone: '+77011110002', name: 'Капитан 2', team: 'Команда 2' }
    ];

    await broadcaster.enqueue({
      recipients,
      messageTemplate: 'Привет, {{captain}}!',
      campaign: 'test_fifo'
    });

    await broadcaster.drain();

    assert.equal(mockSocket.sentMessages.length, 2);
    assert.equal(mockSocket.sentMessages[0].jid, '77011110001@s.whatsapp.net');
    assert.equal(mockSocket.sentMessages[1].jid, '77011110002@s.whatsapp.net');
    assert.equal(mockSocket.presenceUpdates.length, 2);
    assert.equal(recordedDelays.length, 1);
  });

  test('F7-04: Opt-out command detection and SQLite handler', () => {
    assert.equal(isOptOutMessage('СТОП'), true);
    assert.equal(isOptOutMessage('stop'), true);

    env.contacts.upsert({ phone: '+77011863190', name: 'Алексей' });
    const res = handleOptOut({ phone: '+77011863190', text: 'СТОП', db: env });
    assert.equal(res.optedOut, true);
    assert.equal(env.contacts.getByPhone('+77011863190').is_subscribed, 0);
  });

  test('F7-05: Opted-out contact exclusion in broadcast queue', async () => {
    env.contacts.upsert({ phone: '+77010000001', name: 'Капитан 1' });
    env.contacts.upsert({ phone: '+77010000002', name: 'Капитан 2' });
    env.contacts.setSubscription('+77010000002', 0); // Opt-out

    const broadcaster = createBroadcaster({
      db: env,
      sock: mockSocket,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    await broadcaster.enqueue({
      recipients: [
        { phone: '+77010000001', name: 'Капитан 1' },
        { phone: '+77010000002', name: 'Капитан 2' }
      ],
      messageTemplate: 'Анонс!',
      campaign: 'opt_out_test'
    });

    await broadcaster.drain();

    assert.equal(mockSocket.sentMessages.length, 1);
    assert.equal(mockSocket.sentMessages[0].jid, '77010000001@s.whatsapp.net');
    const logs = env.broadcastLogs.list({ campaign: 'opt_out_test' });
    const skipped = logs.find(l => l.recipient_phone === '+77010000002');
    assert.equal(skipped.status, 'skipped_opted_out');
  });
});

// ============================================================================
// Feature F8: Game Day Reminders (Tuesday 12:00) (R5) - 5 Tests
// ============================================================================
describe('F8: Game Day Reminders (Tuesday 12:00) (R5)', () => {
  let env;
  let mockSocket;

  beforeEach(async () => {
    env = await createTestEnv({ inMemory: true });
    mockSocket = createMockSocket();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('F8-01: Almaty timezone evaluation for Tuesdays', () => {
    // 2026-11-24 is Tuesday
    const tuesday = new Date('2026-11-24T07:00:00.000Z'); // 12:00 Almaty
    const info = getAlmatyDateInfo(tuesday, 'Asia/Almaty');
    assert.equal(info.isTuesday, true);
    assert.equal(info.weekday, 'Tue');
  });

  test('F8-02: Tonight game matching from catalog', () => {
    const mockGames = [
      { id: 'g1', title: 'Киномарафон', dateStr: '24 ноября', status: 'open', dayName: 'ВТ' },
      { id: 'g2', title: 'Аниме', dateStr: '01 декабря', status: 'open', dayName: 'ВТ' }
    ];

    const dateInfo = getAlmatyDateInfo(new Date('2026-11-24T12:00:00+05:00'), 'Asia/Almaty');
    const tonight = findTonightGame(mockGames, dateInfo);
    assert.ok(tonight);
    assert.equal(tonight.title, 'Киномарафон');
  });

  test('F8-03: Confirmed tonight bookings retrieval', () => {
    env.seedBooking({
      teamName: 'Альфа',
      captainName: 'Алексей',
      captainPhone: '+77011112233',
      gameTitle: 'Киномарафон',
      status: 'confirmed'
    });
    env.seedBooking({
      teamName: 'Бета',
      captainName: 'Борис',
      captainPhone: '+77014445566',
      gameTitle: 'Киномарафон',
      status: 'cancelled'
    });

    const bookings = getTonightBookings(env, { title: 'Киномарафон' });
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].team_name, 'Альфа');
  });

  test('F8-04: Captain phone deduplication for multiple tables', () => {
    env.seedBooking({
      teamName: 'Стол 1',
      captainName: 'Алексей',
      captainPhone: '+7 (701) 111-22-33',
      gameTitle: 'Киномарафон',
      status: 'confirmed'
    });
    env.seedBooking({
      teamName: 'Стол 2',
      captainName: 'Алексей',
      captainPhone: '+7 701 111 22 33',
      gameTitle: 'Киномарафон',
      status: 'confirmed'
    });

    const bookings = getTonightBookings(env, { title: 'Киномарафон' });
    assert.equal(bookings.length, 2);

    // Grouping by normalized phone results in 1 unique captain
    const phoneMap = new Map();
    for (const b of bookings) {
      const p = normalizePhone(b.captain_phone);
      if (!phoneMap.has(p)) phoneMap.set(p, b);
    }
    assert.equal(phoneMap.size, 1);
  });

  test('F8-05: Full Tuesday game-day reminder dispatch', async () => {
    env.seedBooking({
      teamName: 'Альфа',
      captainName: 'Алексей',
      captainPhone: '+77011112233',
      gameTitle: 'Киномарафон: 100 вопросов',
      status: 'confirmed'
    });

    const mockGames = [{
      id: 'g1',
      title: 'Киномарафон: 100 вопросов',
      dateStr: '24 ноября',
      timeStr: '19:30',
      dayName: 'ВТ',
      status: 'open'
    }];

    const broadcaster = createBroadcaster({
      db: env,
      sock: mockSocket,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    const scheduler = await initGameDayScheduler({
      db: env,
      getActiveGames: () => mockGames,
      broadcaster,
      timezone: 'Asia/Almaty'
    });

    const tuesdayDate = new Date('2026-11-24T12:00:00+05:00');
    const result = await scheduler.runNow(tuesdayDate);

    assert.equal(result.success, true);
    assert.equal(result.queuedCount, 1);

    await broadcaster.drain();

    assert.equal(mockSocket.sentMessages.length, 1);
    assert.match(mockSocket.sentMessages[0].text, /Алексей/);
    assert.match(mockSocket.sentMessages[0].text, /Киномарафон: 100 вопросов/);

    scheduler.stop();
  });
});
