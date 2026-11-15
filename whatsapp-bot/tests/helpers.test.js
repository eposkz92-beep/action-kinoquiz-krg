/**
 * tests/helpers.test.js
 * Verification Test Suite for Offline Mock Test Infrastructure & Fixtures (Milestone TM1)
 * Runner: node --test tests/helpers.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createMockSocket } from './helpers/mockSocket.js';
import { createMockTelegram } from './helpers/mockTelegram.js';
import {
  createMockGoogleSheets,
  EXPECTED_SCHEMA_COLUMNS,
  EXPECTED_EXPORT_COLUMNS
} from './helpers/mockGoogleSheets.js';
import { createTestEnv } from './helpers/testEnv.js';
import { createMockCatalog } from './helpers/mockCatalog.js';
import { exportBookingsToGoogleSheets } from '../src/db/exportSheets.js';
import { getActiveGames } from '../src/games/gameLoader.js';
import {
  assertConfirmationCard,
  extractCardFields,
  cleanCardValue
} from './helpers/cardAssertions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 1. Mock Socket Test Suite
// ============================================================================
test('1. Mock WhatsApp Socket (mockSocket.js)', async (t) => {
  await t.test('1.1 Socket initialization & defaults', () => {
    const sock = createMockSocket();
    assert.ok(sock.ev, 'Must expose EventEmitter ev');
    assert.ok(sock.user, 'Must expose user profile');
    assert.equal(sock.user.id, '77011863190:0@s.whatsapp.net');
    assert.equal(sock.user.name, 'ACTION Kinoquiz Bot');
    assert.equal(sock.ws.isOpen, true, 'WebSocket should be open by default');
    assert.equal(sock.sentMessages.length, 0);
    assert.equal(sock.presenceUpdates.length, 0);
    assert.equal(sock.readReceipts.length, 0);
  });

  await t.test('1.2 Custom bot user credentials', () => {
    const sock = createMockSocket({
      botJid: 'custom_bot@s.whatsapp.net',
      botName: 'Custom Bot Name'
    });
    assert.equal(sock.user.id, 'custom_bot@s.whatsapp.net');
    assert.equal(sock.user.name, 'Custom Bot Name');
  });

  await t.test('1.3 sendMessage records text and options', async () => {
    const sock = createMockSocket();
    const jid = '77015551234@s.whatsapp.net';

    // String content
    const res1 = await sock.sendMessage(jid, 'Привет, мир!');
    assert.ok(res1.key.id, 'Should return message key id');
    assert.equal(res1.key.remoteJid, jid);
    assert.equal(res1.key.fromMe, true);
    assert.equal(res1.message.conversation, 'Привет, мир!');

    // Object content with text and quoted options
    const res2 = await sock.sendMessage(
      jid,
      { text: 'Второе сообщение' },
      { quoted: { key: { id: 'parent_msg' } } }
    );
    assert.equal(res2.message.conversation, 'Второе сообщение');

    assert.equal(sock.sentMessages.length, 2);
    assert.equal(sock.getLastMessage().text, 'Второе сообщение');
    assert.equal(sock.getLastMessage(jid).text, 'Второе сообщение');
    assert.deepEqual(sock.getSentTexts(jid), ['Привет, мир!', 'Второе сообщение']);
  });

  await t.test('1.4 sendPresenceUpdate and readMessages recording', async () => {
    const sock = createMockSocket();
    const jid = '77015559999@s.whatsapp.net';

    await sock.sendPresenceUpdate('composing', jid);
    await sock.sendPresenceUpdate('paused', jid);
    await sock.readMessages([{ remoteJid: jid, id: 'msg_101', fromMe: false }]);

    assert.equal(sock.presenceUpdates.length, 2);
    assert.equal(sock.presenceUpdates[0].presence, 'composing');
    assert.equal(sock.presenceUpdates[1].presence, 'paused');
    assert.equal(sock.getPresenceUpdates(jid).length, 2);

    assert.equal(sock.readReceipts.length, 1);
    assert.equal(sock.readReceipts[0].id, 'msg_101');
  });

  await t.test('1.5 clear() resets inspection arrays', async () => {
    const sock = createMockSocket();
    await sock.sendMessage('jid@s.whatsapp.net', 'Test');
    await sock.sendPresenceUpdate('composing', 'jid@s.whatsapp.net');
    await sock.readMessages([{ id: 'key' }]);

    assert.equal(sock.sentMessages.length, 1);
    assert.equal(sock.presenceUpdates.length, 1);
    assert.equal(sock.readReceipts.length, 1);

    sock.clear();
    assert.equal(sock.sentMessages.length, 0);
    assert.equal(sock.presenceUpdates.length, 0);
    assert.equal(sock.readReceipts.length, 0);
    assert.equal(sock.getLastMessage(), null);
  });

  await t.test('1.6 simulateIncomingMessage dispatches messages.upsert', async () => {
    const sock = createMockSocket();
    let receivedEvent = null;

    sock.ev.on('messages.upsert', (ev) => {
      receivedEvent = ev;
    });

    const dispatched = sock.simulateIncomingMessage({
      jid: '77011112233@s.whatsapp.net',
      text: '1',
      pushName: 'Арман'
    });

    assert.ok(receivedEvent, 'Must emit messages.upsert event');
    assert.equal(receivedEvent.type, 'notify');
    assert.equal(receivedEvent.messages.length, 1);

    const msg = receivedEvent.messages[0];
    assert.equal(msg.key.remoteJid, '77011112233@s.whatsapp.net');
    assert.equal(msg.key.fromMe, false);
    assert.equal(msg.pushName, 'Арман');
    assert.equal(msg.message.conversation, '1');
    assert.equal(dispatched.key.id, msg.key.id);
  });

  await t.test('1.7 simulateIncomingMessage handles ephemeral messages', () => {
    const sock = createMockSocket();
    let received = null;
    sock.ev.on('messages.upsert', (ev) => {
      received = ev.messages[0];
    });

    sock.simulateIncomingMessage({
      jid: 'user@s.whatsapp.net',
      text: 'Временный текст',
      isEphemeral: true
    });

    assert.ok(received.message.ephemeralMessage);
    assert.equal(received.message.ephemeralMessage.message.conversation, 'Временный текст');
  });

  await t.test('1.8 Connection lifecycle: simulateQr, simulateOpen, simulateDisconnect', () => {
    const sock = createMockSocket();
    const updates = [];
    sock.ev.on('connection.update', (u) => updates.push(u));

    // Simulate QR
    sock.simulateQr('2@QR_CODE_STRING_TEST');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].connection, 'connecting');
    assert.equal(updates[0].qr, '2@QR_CODE_STRING_TEST');

    // Simulate Open
    sock.simulateOpen();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].connection, 'open');
    assert.equal(sock.ws.isOpen, true);

    // Simulate Disconnect with statusCode 515 (restart required)
    sock.simulateDisconnect(515, 'Restart required');
    assert.equal(updates.length, 3);
    assert.equal(updates[2].connection, 'close');
    assert.equal(updates[2].lastDisconnect.error.output.statusCode, 515);
    assert.equal(sock.ws.isOpen, false);
  });

  await t.test('1.9 Disconnect with 401 via logout() and end()', async () => {
    const sock = createMockSocket();
    const updates = [];
    sock.ev.on('connection.update', (u) => updates.push(u));

    await sock.logout();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].connection, 'close');
    assert.equal(updates[0].lastDisconnect.error.output.statusCode, 401);

    // sendMessage rejected when closed
    await assert.rejects(
      async () => {
        await sock.sendMessage('user@s.whatsapp.net', 'Fail');
      },
      { message: /Socket is closed/ }
    );
  });
});

// ============================================================================
// 2. Mock Telegram Test Suite
// ============================================================================
test('2. Mock Telegram API Interceptor (mockTelegram.js)', async (t) => {
  const telegram = createMockTelegram();

  t.after(() => {
    telegram.uninstall();
    telegram.clear();
  });

  await t.test('2.1 Intercepts global fetch for api.telegram.org', async () => {
    telegram.install();

    const response = await fetch('https://api.telegram.org/bot12345:TEST_TOKEN/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: -1001234567890,
        text: '🔔 <b>Новая бронь!</b>',
        parse_mode: 'HTML'
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.ok, true);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.message_id > 0);

    assert.equal(telegram.requests.length, 1);
    const lastAlert = telegram.getLastAlert();
    assert.equal(lastAlert.chat_id, -1001234567890);
    assert.equal(lastAlert.text, '🔔 <b>Новая бронь!</b>');
    assert.equal(lastAlert.parse_mode, 'HTML');
  });

  await t.test('2.2 Parses URLSearchParams and query parameters', async () => {
    const params = new URLSearchParams();
    params.append('chat_id', '99887766');
    params.append('text', 'Сообщение через форму');

    const res = await fetch('https://api.telegram.org/bot123/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    assert.equal(res.status, 200);
    const alert = telegram.getLastAlert();
    assert.equal(alert.chat_id, '99887766');
    assert.equal(alert.text, 'Сообщение через форму');
  });

  await t.test('2.3 Fault injection: HTTP 429 Too Many Requests', async () => {
    telegram.setStatus(429);

    const response = await fetch('https://api.telegram.org/bot123/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: 123, text: 'Hi' })
    });

    assert.equal(response.status, 429);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get('Retry-After'), '5');

    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error_code, 429);
    assert.equal(body.parameters.retry_after, 5);

    // Reset
    telegram.setStatus(200);
  });

  await t.test('2.4 Fault injection: HTTP 500 Internal Error', async () => {
    telegram.setStatus(500);

    const response = await fetch('https://api.telegram.org/bot123/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: 123, text: 'Hi' })
    });

    assert.equal(response.status, 500);
    assert.equal(response.ok, false);
    telegram.setStatus(200);
  });

  await t.test('2.5 Network failure simulation: failNext', async () => {
    telegram.failNext(new TypeError('Network connection refused'));

    await assert.rejects(
      async () => {
        await fetch('https://api.telegram.org/bot123/sendMessage', { method: 'POST' });
      },
      { name: 'TypeError', message: 'Network connection refused' }
    );

    // Subsequent request should succeed normally
    const normalResponse = await fetch('https://api.telegram.org/bot123/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ text: 'Recovered' })
    });
    assert.equal(normalResponse.status, 200);
  });

  await t.test('2.6 uninstall() restores native globalThis.fetch', async () => {
    telegram.uninstall();

    // Verify non-telegram request doesn't throw unhandled mock error
    // (We test against a mock dummy function to confirm globalThis.fetch is unhooked)
    const nativeFetch = globalThis.fetch;
    assert.notEqual(nativeFetch.name, 'mockFetch');
  });
});

// ============================================================================
// 3. Mock Google Sheets Test Suite
// ============================================================================
test('3. Mock Google Sheets & Schema Validation (mockGoogleSheets.js)', async (t) => {
  await t.test('3.1 Schema columns definition verification', () => {
    assert.equal(EXPECTED_SCHEMA_COLUMNS.length, 8);
    assert.deepEqual(EXPECTED_SCHEMA_COLUMNS, [
      'timestamp',
      'teamName',
      'captainName',
      'phone',
      'playersCount',
      'gameTitle',
      'gameDate',
      'source'
    ]);
    assert.equal(EXPECTED_EXPORT_COLUMNS.length, 10);
    assert.deepEqual(EXPECTED_EXPORT_COLUMNS, [
      'id',
      'created_at',
      'team_name',
      'captain_name',
      'captain_phone',
      'players_count',
      'game_title',
      'game_date',
      'source',
      'notes'
    ]);
  });

  await t.test('3.2 Standard 8-column appendRows success', async () => {
    const sheets = createMockGoogleSheets();
    const validRow = [
      '2026-11-15T01:30:00.000Z',
      'Киноманы',
      'Алексей',
      '+77011863190',
      6,
      'Киномарафон: 100 вопросов',
      '2026-11-24',
      'whatsapp'
    ];

    const result = await sheets.appendRows('sheet_123', 'Брони!A1', [validRow]);
    assert.equal(result.updates.updatedRows, 1);
    assert.equal(result.updates.updatedColumns, 8);
    assert.equal(result.updates.updatedCells, 8);
    assert.equal(result.updates.updatedRange, 'Брони!A1:H1');

    const allRows = sheets.listRows();
    assert.equal(allRows.length, 1);
    assert.deepEqual(allRows[0], validRow);
  });

  await t.test('3.3 Flexible invocation: appendRows(rows) and appendRows(id, rows)', async () => {
    const sheets = createMockGoogleSheets();
    const row1 = ['ts1', 'Team A', 'Capt A', '701111', 4, 'Game 1', '2026-11-24', 'whatsapp'];
    const row2 = ['ts2', 'Team B', 'Capt B', '701222', 8, 'Game 2', '2026-12-01', 'website'];

    // 1-arg invocation
    await sheets.appendRows([row1]);
    // 2-arg invocation
    await sheets.appendRows('sheet_id', [row2]);

    assert.equal(sheets.listRows().length, 2);
  });

  await t.test('3.4 appendRow(row) alias support (SCOPE.md:36 contract)', async () => {
    const sheets = createMockGoogleSheets();
    const row8 = ['2026-11-15T01:30:00.000Z', 'Команда 8', 'Капитан 8', '+77011112233', 4, 'Игра 1', '2026-11-24', 'whatsapp'];
    const res8 = await sheets.appendRow(row8);
    assert.equal(res8.updates.updatedRows, 1);
    assert.equal(res8.updates.updatedColumns, 8);
    assert.equal(res8.updates.updatedRange, 'Брони!A1:H1');
    assert.equal(sheets.listRows().length, 1);

    const row10 = [2, '2026-11-15T01:35:00.000Z', 'Команда 10', 'Капитан 10', '+77011112244', 6, 'Игра 2', '2026-12-01', 'website', 'VIP стол'];
    const res10 = await sheets.appendRow(row10);
    assert.equal(res10.updates.updatedRows, 1);
    assert.equal(res10.updates.updatedColumns, 10);
    assert.equal(res10.updates.updatedRange, 'Брони!A2:J2');
    assert.equal(sheets.listRows().length, 2);
  });

  await t.test('3.5 10-column database export rows & exportBookingsToGoogleSheets integration', async () => {
    const sheets = createMockGoogleSheets();
    const dbRow10 = [
      1,
      '2026-11-15T01:30:00.000Z',
      'Киноманы',
      'Алексей',
      '+77011863190',
      6,
      'Киномарафон: 100 вопросов',
      '2026-11-24',
      'whatsapp',
      'Без лука'
    ];

    const res = await sheets.appendRows([dbRow10]);
    assert.equal(res.updates.updatedRows, 1);
    assert.equal(res.updates.updatedColumns, 10);
    assert.equal(res.updates.updatedRange, 'Брони!A1:J1');
    assert.equal(sheets.listRows().length, 1);
    assert.deepEqual(sheets.listRows()[0], dbRow10);

    // Verify seamless integration with src/db/exportSheets.js
    const env = await createTestEnv({ inMemory: true });
    env.seedBooking({
      teamName: 'Интеграция',
      captainName: 'Тестер',
      captainPhone: '+77019998877',
      playersCount: 7,
      gameTitle: 'Культовые Аниме',
      gameDate: '2026-12-01',
      source: 'whatsapp',
      notes: 'Стол у сцены'
    });

    const exportRes = await exportBookingsToGoogleSheets(env.db, { sheetsClient: sheets });
    assert.equal(exportRes.syncedCount, 1);
    assert.equal(sheets.listRows().length, 2);
    const exportedRow = sheets.listRows()[1];
    assert.equal(exportedRow.length, 10);
    assert.equal(exportedRow[2], 'Интеграция');
    assert.equal(exportedRow[3], 'Тестер');
    await env.cleanup();
  });

  await t.test('3.6 Schema validation: rejects rows with < 8 or > 10 columns', async () => {
    const sheets = createMockGoogleSheets();

    // 7 columns (missing source)
    const shortRow = ['ts', 'Team', 'Captain', '701', 5, 'Game', 'Date'];
    await assert.rejects(
      async () => {
        await sheets.appendRows([shortRow]);
      },
      { message: /expected 8 or 10 columns/ }
    );

    // 11 columns (extra fields)
    const longRow = [1, 'ts', 'Team', 'Captain', '701', 5, 'Game', 'Date', 'whatsapp', 'notes', 'extra_col'];
    await assert.rejects(
      async () => {
        await sheets.appendRows([longRow]);
      },
      { message: /expected 8 or 10 columns/ }
    );

    // Non-array row
    await assert.rejects(
      async () => {
        await sheets.appendRows(['not-an-array']);
      },
      { message: /row must be an Array/ }
    );
  });

  await t.test('3.7 Fault injection: setStatus(403) and clear()', async () => {
    const sheets = createMockGoogleSheets();
    sheets.setStatus(403);

    const validRow = ['ts', 'Team', 'Capt', '701', 6, 'Game', 'Date', 'src'];
    await assert.rejects(
      async () => {
        await sheets.appendRows([validRow]);
      },
      (err) => {
        assert.equal(err.code, 403);
        return true;
      }
    );

    // clear resets status
    sheets.clear();
    const res = await sheets.appendRows([validRow]);
    assert.equal(res.updates.updatedRows, 1);
  });
});

// ============================================================================
// 4. Test Environment Isolation Suite
// ============================================================================
test('4. Test Environment Isolation (testEnv.js)', async (t) => {
  await t.test('4.1 In-memory SQLite mode initialization', async () => {
    const env = await createTestEnv({ inMemory: true });
    assert.equal(env.dbPath, ':memory:');
    assert.equal(env.tempDir, null);
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.DB_PATH, ':memory:');
    assert.ok(process.env.TELEGRAM_BOT_TOKEN);

    // Verify tables created
    const tables = env.db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all().map(r => r.name);
    assert.ok(tables.includes('teams'));
    assert.ok(tables.includes('bookings'));
    assert.ok(tables.includes('contacts'));
    assert.ok(tables.includes('broadcast_logs'));
    assert.ok(tables.includes('user_sessions'));

    // Test seedBooking helper
    const booking = env.seedBooking({
      teamName: 'Кинотест',
      captainName: 'Диас',
      captainPhone: '+77017778899',
      playersCount: 5,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '2026-11-24'
    });
    assert.ok(booking.id > 0);
    assert.equal(booking.team_name, 'Кинотест');

    await env.cleanup();
  });

  await t.test('4.2 Temp file disk mode & safe Windows cleanup', async () => {
    const env = await createTestEnv({ inMemory: false });
    assert.ok(env.tempDir);
    assert.ok(fs.existsSync(env.tempDir));
    assert.ok(fs.existsSync(env.dbPath));
    assert.ok(fs.existsSync(env.mockCatalogPath));

    // Verify catalog JSON file generated
    const catalogRaw = fs.readFileSync(env.mockCatalogPath, 'utf-8');
    const catalog = JSON.parse(catalogRaw);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.profile, 'action_kinoquiz_krg');
    assert.ok(catalog.processed_posts);

    // Teardown
    await env.cleanup();

    // Verify tempDir deleted and Windows file lock released cleanly
    assert.equal(fs.existsSync(env.tempDir), false, 'tempDir must be completely removed');
  });

  await t.test('4.3 Environment variable restoration on cleanup', async () => {
    const originalCustom = process.env.MY_CUSTOM_TEST_VAR;
    const env = await createTestEnv({
      env: {
        MY_CUSTOM_TEST_VAR: 'temporary_value_xyz'
      }
    });

    assert.equal(process.env.MY_CUSTOM_TEST_VAR, 'temporary_value_xyz');
    await env.cleanup();
    assert.equal(process.env.MY_CUSTOM_TEST_VAR, originalCustom);
  });

  await t.test('4.4 PARENT_DIR isolation and getActiveGames resolution', async () => {
    const prevParentDir = process.env.PARENT_DIR;

    // 1. In-memory mode sets PARENT_DIR to fixtures
    const envMemory = await createTestEnv({ inMemory: true });
    assert.ok(process.env.PARENT_DIR);
    assert.ok(fs.existsSync(path.join(process.env.PARENT_DIR, 'instagram_state.json')));
    const memoryGames = getActiveGames();
    assert.ok(memoryGames.length >= 2, 'getActiveGames without args must load from PARENT_DIR fixtures');
    await envMemory.cleanup();
    assert.equal(process.env.PARENT_DIR, prevParentDir, 'PARENT_DIR must be restored after in-memory cleanup');

    // 2. Disk mode sets PARENT_DIR to tempDir
    const envDisk = await createTestEnv({
      inMemory: false,
      catalog: { preset: 'single_future' }
    });
    assert.equal(process.env.PARENT_DIR, envDisk.tempDir);
    const diskGames = getActiveGames();
    assert.equal(diskGames.length, 1, 'getActiveGames without args must load single_future game from tempDir');
    assert.equal(diskGames[0].title, 'Киномарафон: 100 вопросов');
    await envDisk.cleanup();
    assert.equal(process.env.PARENT_DIR, prevParentDir, 'PARENT_DIR must be restored after disk cleanup');
  });

  await t.test('4.5 Interleaved createTestEnv instances and concurrent isolation', async () => {
    const prevParentDir = process.env.PARENT_DIR;

    // Test A: Interleaved cleanup order (create A, create B; cleanup A, cleanup B)
    const envA = await createTestEnv({
      inMemory: false,
      catalog: { preset: 'single_future' },
      env: { TEST_INTERLEAVED_A: 'val_a' }
    });
    const envB = await createTestEnv({
      inMemory: false,
      catalog: { preset: 'default' },
      env: { TEST_INTERLEAVED_B: 'val_b' }
    });

    assert.equal(process.env.PARENT_DIR, envB.tempDir, 'Active PARENT_DIR must point to most recent envB');
    assert.equal(process.env.TEST_INTERLEAVED_A, 'val_a');
    assert.equal(process.env.TEST_INTERLEAVED_B, 'val_b');

    // Clean up envA first while envB is still active
    await envA.cleanup();
    assert.equal(fs.existsSync(envA.tempDir), false, 'envA tempDir must be deleted');
    assert.equal(process.env.PARENT_DIR, envB.tempDir, 'PARENT_DIR must remain pointing to active envB tempDir, not deleted envA');
    assert.equal(process.env.TEST_INTERLEAVED_B, 'val_b');
    assert.equal(process.env.TEST_INTERLEAVED_A, undefined, 'Cleaned up envA variables must be removed');

    // Verify catalog resolution uses envB's directory
    const gamesDuringB = getActiveGames();
    assert.equal(gamesDuringB.length, 2, 'Must load default preset from active envB');

    // Clean up envB
    await envB.cleanup();
    assert.equal(fs.existsSync(envB.tempDir), false, 'envB tempDir must be deleted');
    assert.equal(process.env.PARENT_DIR, prevParentDir, 'PARENT_DIR must be restored to original root value (no leaks)');
    assert.equal(process.env.TEST_INTERLEAVED_B, undefined, 'Cleaned up envB variables must be removed');

    // Test B: Reverse interleaved cleanup order (create C, create D; cleanup D, cleanup C)
    const envC = await createTestEnv({
      inMemory: false,
      catalog: { preset: 'single_future' },
      env: { TEST_INTERLEAVED_C: 'val_c' }
    });
    const envD = await createTestEnv({
      inMemory: false,
      catalog: { preset: 'default' },
      env: { TEST_INTERLEAVED_D: 'val_d' }
    });

    assert.equal(process.env.PARENT_DIR, envD.tempDir);

    // Clean up envD first
    await envD.cleanup();
    assert.equal(fs.existsSync(envD.tempDir), false, 'envD tempDir must be deleted');
    assert.equal(process.env.PARENT_DIR, envC.tempDir, 'PARENT_DIR must fall back to remaining active envC tempDir');
    assert.equal(process.env.TEST_INTERLEAVED_C, 'val_c');
    assert.equal(process.env.TEST_INTERLEAVED_D, undefined, 'envD variable must be removed');

    // Verify catalog resolution falls back to envC's single_future catalog
    const gamesDuringC = getActiveGames();
    assert.equal(gamesDuringC.length, 1, 'Must load single_future preset from active envC');
    assert.equal(gamesDuringC[0].title, 'Киномарафон: 100 вопросов');

    // Clean up envC
    await envC.cleanup();
    assert.equal(fs.existsSync(envC.tempDir), false, 'envC tempDir must be deleted');
    assert.equal(process.env.PARENT_DIR, prevParentDir, 'PARENT_DIR must be restored to original root value');
    assert.equal(process.env.TEST_INTERLEAVED_C, undefined);

    // Test C: Parallel batch stress (10 parallel instances via Promise.all)
    const batch = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createTestEnv({
          inMemory: false,
          env: { [`BATCH_STRESS_VAR_${i}`]: `stress_val_${i}` }
        })
      )
    );
    await Promise.all(batch.map(e => e.cleanup()));

    assert.equal(process.env.PARENT_DIR, prevParentDir, 'No PARENT_DIR leak after parallel batch');
    for (let i = 0; i < 10; i++) {
      assert.equal(process.env[`BATCH_STRESS_VAR_${i}`], undefined, `BATCH_STRESS_VAR_${i} must not leak`);
    }
  });
});

// ============================================================================
// 5. Dynamic Mock Catalog Test Suite
// ============================================================================
test('5. Dynamic Mock Catalog Generator (mockCatalog.js)', async (t) => {
  await t.test('5.1 Default preset structure and active_games', () => {
    const catalog = createMockCatalog();
    assert.equal(catalog.data.version, 1);
    assert.equal(catalog.data.profile, 'action_kinoquiz_krg');
    assert.ok(catalog.data.last_sync_utc);

    const posts = Object.values(catalog.data.processed_posts);
    const announcements = posts.filter(p => p.type === 'ANNOUNCEMENT');
    assert.ok(announcements.length >= 2, 'Default preset should have upcoming announcement games');

    assert.ok(Array.isArray(catalog.data.active_games), 'Must include active_games array');
    assert.equal(catalog.data.active_games.length, 2);
    const firstGame = catalog.data.active_games[0];
    assert.equal(firstGame.id, 'game-1');
    assert.equal(firstGame.title, 'Киномарафон: 100 вопросов');
    assert.ok(firstGame.dateStr);
    assert.equal(firstGame.timeStr, '19:30');
    assert.ok(firstGame.dayName);
    assert.equal(firstGame.price, '3 000 ₸');
    assert.equal(firstGame.status, 'open');
    assert.ok(firstGame.desc);
  });

  await t.test('5.2 empty preset', () => {
    const catalog = createMockCatalog({ preset: 'empty' });
    assert.deepEqual(catalog.data.processed_posts, {});
    assert.deepEqual(catalog.data.active_games, []);
  });

  await t.test('5.3 past_only preset', () => {
    const catalog = createMockCatalog({ preset: 'past_only' });
    const posts = Object.values(catalog.data.processed_posts);
    assert.ok(posts.length > 0);
    const futurePosts = posts.filter(
      p => p.type === 'ANNOUNCEMENT' && new Date(p.date_utc).getTime() > Date.now()
    );
    assert.equal(futurePosts.length, 0, 'past_only preset must have zero future games');
    assert.deepEqual(catalog.data.active_games, []);
  });

  await t.test('5.4 today_tuesday preset for cron reminders', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const catalog = createMockCatalog({ preset: 'today_tuesday', now });
    const todayPost = catalog.data.processed_posts['POST_TODAY'];
    assert.ok(todayPost);
    assert.ok(todayPost.date_utc.startsWith('2026-11-17'));
    assert.ok(todayPost.date_utc.includes('19:30:00'));

    assert.equal(catalog.data.active_games.length, 2);
    assert.equal(catalog.data.active_games[0].id, 'game-today');
    assert.equal(catalog.data.active_games[0].title, 'Сегодняшний Киноквиз: 100 вопросов');
    assert.equal(catalog.data.active_games[1].id, 'game-next-week');
  });

  await t.test('5.5 customGames override and writeTo(filePath)', () => {
    const tmpFile = path.join(os.tmpdir(), `test_catalog_${Date.now()}.json`);
    const custom = [
      { title: 'Кастомный Квиз 1', dateUtc: '2026-12-05T19:30:00' },
      { title: 'Кастомный Квиз 2', dateUtc: '2026-12-12T19:30:00' }
    ];

    const catalog = createMockCatalog({ customGames: custom });
    catalog.writeTo(tmpFile);

    assert.ok(fs.existsSync(tmpFile));
    const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(saved.processed_posts['POST_CUSTOM_1'].title, 'Кастомный Квиз 1');
    assert.equal(saved.processed_posts['POST_CUSTOM_2'].title, 'Кастомный Квиз 2');
    assert.equal(saved.active_games.length, 2);
    assert.equal(saved.active_games[0].title, 'Кастомный Квиз 1');
    assert.equal(saved.active_games[1].title, 'Кастомный Квиз 2');

    fs.unlinkSync(tmpFile);
  });

  await t.test('5.6 single_future preset', () => {
    const catalog = createMockCatalog({ preset: 'single_future' });
    assert.equal(catalog.data.active_games.length, 1);
    assert.equal(catalog.data.active_games[0].id, 'game-1');
    assert.equal(catalog.data.active_games[0].title, 'Киномарафон: 100 вопросов');
  });

  await t.test('5.7 getActiveGames loads games from mock catalog file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-loader-test-'));
    const catalog = createMockCatalog({ preset: 'today_tuesday' });
    catalog.writeTo(path.join(tmpDir, 'instagram_state.json'));

    const games = getActiveGames(tmpDir);
    assert.equal(games.length, 2);
    assert.equal(games[0].title, 'Сегодняшний Киноквиз: 100 вопросов');
    assert.equal(games[1].title, 'Культовые Аниме');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ============================================================================
// 6. WhatsApp Confirmation Card Assertions Test Suite
// ============================================================================
test('6. WhatsApp Confirmation Card Assertions (cardAssertions.js)', async (t) => {
  const validCardText = [
    '✅ *Бронь стола успешно подтверждена!*',
    '',
    '📅 *Выбранная игра:* Киномарафон: 100 вопросов (24.11 в 19:30) 🎬',
    '👥 *Команда:* «Киноманы»',
    '♟️ *Количество игроков:* 6 чел.',
    '👤 *Капитан:* Алексей (+7 701 186-31-90)',
    '📱 *Телефон:* +7 701 186-31-90',
    '',
    '📍 *Место:* Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
    '💰 *Взнос:* 3 000 ₸ с игрока',
    '🎟️ Ждём вас на игре!'
  ].join('\n');

  await t.test('6.1 Field extraction with extractCardFields', () => {
    const fields = extractCardFields(validCardText);
    assert.equal(fields.team, 'Киноманы');
    assert.equal(fields.players, 6);
    assert.ok(fields.captain.includes('Алексей'));
    assert.ok(fields.game.includes('Киномарафон'));
    assert.ok(fields.venue.includes('То Место'));
    assert.ok(fields.fee.includes('3 000'));
  });

  await t.test('6.2 Full card validation with assertConfirmationCard', () => {
    const extracted = assertConfirmationCard(validCardText, {
      team: 'Киноманы',
      players: 6,
      captain: 'Алексей',
      game: 'Киномарафон',
      venue: 'То Место',
      fee: '3 000'
    });
    assert.equal(extracted.team, 'Киноманы');
    assert.equal(extracted.players, 6);
  });

  await t.test('6.3 Rejects double-asterisk Markdown violation (**bold**)', () => {
    const invalidText = validCardText.replace('*Команда:*', '**Команда:**');
    assert.throws(
      () => {
        assertConfirmationCard(invalidText);
      },
      { message: /WhatsApp markdown violation: double asterisks/ }
    );
  });

  await t.test('6.4 Rejects Markdown heading syntax (# Header)', () => {
    const invalidHeading = '# Подтверждение брони\n' + validCardText;
    assert.throws(
      () => {
        assertConfirmationCard(invalidHeading);
      },
      { message: /Markdown heading syntax/ }
    );
  });

  await t.test('6.5 Rejects field mismatches', () => {
    assert.throws(
      () => {
        assertConfirmationCard(validCardText, { team: 'Другая Команда' });
      },
      { message: /Team mismatch/ }
    );

    assert.throws(
      () => {
        assertConfirmationCard(validCardText, { players: 10 });
      },
      { message: /Players count mismatch/ }
    );
  });

  await t.test('6.6 cleanCardValue trims quotes, asterisks, and whitespace', () => {
    assert.equal(cleanCardValue('«Команда»'), 'Команда');
    assert.equal(cleanCardValue('*Текст*'), 'Текст');
    assert.equal(cleanCardValue('  "Капитан"  '), 'Капитан');
    assert.equal(cleanCardValue(null), '');
  });
});

// ============================================================================
// 7. Static Fixtures Validation
// ============================================================================
test('7. Static Fixtures Validation', async (t) => {
  await t.test('7.1 tests/fixtures/instagram_state.json schema compliance and active_games', () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/instagram_state.json');
    assert.ok(fs.existsSync(fixturePath), 'Fixture file must exist');

    const content = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    assert.equal(content.version, 1);
    assert.equal(content.profile, 'action_kinoquiz_krg');
    assert.ok(content.last_sync_utc);
    assert.ok(content.processed_posts);

    const posts = Object.values(content.processed_posts);
    const types = new Set(posts.map(p => p.type));
    assert.ok(types.has('ANNOUNCEMENT'), 'Must include ANNOUNCEMENT posts');
    assert.ok(types.has('RESULTS'), 'Must include RESULTS posts');
    assert.ok(types.has('STANDINGS'), 'Must include STANDINGS posts');

    // Verify active_games array
    assert.ok(Array.isArray(content.active_games), 'Must include active_games array');
    assert.ok(content.active_games.length >= 2, 'Must have at least 2 active games');
    assert.equal(content.active_games[0].id, 'game-1');
    assert.equal(content.active_games[0].title, 'Киномарафон: 100 вопросов');
    assert.equal(content.active_games[1].id, 'game-2');
    assert.equal(content.active_games[1].title, 'Культовые Аниме');

    // Verify getActiveGames loads from fixture dir
    const loadedGames = getActiveGames(path.dirname(fixturePath));
    assert.equal(loadedGames.length, 2);
    assert.equal(loadedGames[0].title, 'Киномарафон: 100 вопросов');
    assert.equal(loadedGames[1].title, 'Культовые Аниме');
  });

  await t.test('7.2 tests/fixtures/service_account.json RSA key validity', () => {
    const saPath = path.resolve(__dirname, 'fixtures/service_account.json');
    assert.ok(fs.existsSync(saPath), 'Service account fixture must exist');

    const sa = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
    assert.equal(sa.type, 'service_account');
    assert.ok(sa.project_id);
    assert.ok(sa.client_email);
    assert.ok(sa.private_key);

    // Verify genuine PKCS#8 RSA key using native node:crypto
    const key = crypto.createPrivateKey(sa.private_key);
    assert.equal(key.asymmetricKeyType, 'rsa');
  });
});
