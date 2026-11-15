import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { initDatabase, normalizePhone } from '../src/db/database.js';
import { exportBookingsCsv } from '../src/db/exportCsv.js';
import { exportBookingsToGoogleSheets } from '../src/db/exportSheets.js';
import { getActiveGames } from '../src/games/gameLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Storage Engine & Data Layer Test Suite (Milestone M1)', async (t) => {
  // Use in-memory SQLite database for high-speed, isolated unit testing
  const { db, teams, bookings, contacts, broadcastLogs, sessions, close } = initDatabase(':memory:');

  await t.test('1. Table schema initialization', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('teams'), 'teams table must exist');
    assert.ok(tables.includes('bookings'), 'bookings table must exist');
    assert.ok(tables.includes('contacts'), 'contacts table must exist');
    assert.ok(tables.includes('broadcast_logs'), 'broadcast_logs table must exist');
    assert.ok(tables.includes('user_sessions'), 'user_sessions table must exist');

    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    assert.ok(indices.some(name => name.includes('bookings')), 'bookings indices must exist');
    assert.ok(indices.some(name => name.includes('contacts')), 'contacts indices must exist');
  });

  await t.test('2. Phone normalization helper', () => {
    assert.equal(normalizePhone('+7 (701) 186-31-90'), '+77011863190');
    assert.equal(normalizePhone('8-701-186 31 90'), '87011863190');
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), '');
  });

  await t.test('3. Bookings CRUD operations', () => {
    const booking = bookings.create({
      teamName: 'Киноманы',
      captainName: 'Алексей',
      captainPhone: '+7 701 186 31 90',
      playersCount: 6,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '2026-11-17',
      source: 'whatsapp_bot',
      notes: 'Столик у экрана'
    });

    assert.ok(booking.id > 0, 'Booking must receive auto-increment ID');
    assert.equal(booking.team_name, 'Киноманы');
    assert.equal(booking.captain_name, 'Алексей');
    assert.equal(booking.captain_phone, '+77011863190');
    assert.equal(booking.players_count, 6);
    assert.equal(booking.game_title, 'Киномарафон: 100 вопросов');
    assert.equal(booking.source, 'whatsapp_bot');
    assert.equal(booking.notes, 'Столик у экрана');
    assert.ok(booking.created_at, 'created_at timestamp must be set');

    // Get by ID
    const fetched = bookings.getById(booking.id);
    assert.ok(fetched);
    assert.equal(fetched.id, booking.id);
    assert.equal(fetched.team_name, 'Киноманы');

    // List all
    const allBookings = bookings.list();
    assert.ok(allBookings.length >= 1);

    // List filtered by game title
    const filtered = bookings.list({ gameTitle: 'Киномарафон: 100 вопросов' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, booking.id);

    const emptyFilter = bookings.list({ gameTitle: 'Несуществующая игра' });
    assert.equal(emptyFilter.length, 0);

    // Pagination limit
    const limited = bookings.list({ limit: 1 });
    assert.equal(limited.length, 1);
  });

  await t.test('4. Contacts CRUD and broadcast subscriptions', () => {
    // New contact insert
    const c1 = contacts.upsert({
      phone: '+77011863190',
      name: 'Алексей',
      teamName: 'Киноманы',
      role: 'captain'
    });
    assert.equal(c1.phone, '+77011863190');
    assert.equal(c1.name, 'Алексей');
    assert.equal(c1.is_subscribed, 1);

    // Contact upsert with duplicate phone updates fields without duplicate key error
    const c2 = contacts.upsert({
      phone: '+77011863190',
      name: 'Алексей Смирнов',
      teamName: 'Супер Киноманы'
    });
    assert.equal(c2.phone, '+77011863190');
    assert.equal(c2.name, 'Алексей Смирнов');
    assert.equal(c2.team_name, 'Супер Киноманы');

    // Get by phone
    const byPhone = contacts.getByPhone('+77011863190');
    assert.ok(byPhone);
    assert.equal(byPhone.name, 'Алексей Смирнов');

    // List for broadcast (should contain subscribed contact)
    let broadcastList = contacts.listForBroadcast();
    assert.equal(broadcastList.filter(c => c.phone === '+77011863190').length, 1);

    // Opt-out handling
    contacts.setSubscription('+77011863190', 0);
    broadcastList = contacts.listForBroadcast();
    assert.equal(broadcastList.filter(c => c.phone === '+77011863190').length, 0);

    // Opt-in restore
    contacts.setSubscription('+77011863190', 1);
    broadcastList = contacts.listForBroadcast();
    assert.equal(broadcastList.filter(c => c.phone === '+77011863190').length, 1);
  });

  await t.test('5. Broadcast logs creation and listing', () => {
    const log1 = broadcastLogs.create({
      campaign: 'tuesday_reminder_20261117',
      recipientPhone: '+77011863190',
      recipientName: 'Алексей',
      message: 'Напоминаем: сегодня в 19:30 киноквиз!',
      status: 'sent'
    });
    assert.ok(log1.id > 0);
    assert.equal(log1.campaign, 'tuesday_reminder_20261117');
    assert.equal(log1.recipient_phone, '+77011863190');

    const logsAll = broadcastLogs.list();
    assert.ok(logsAll.length >= 1);

    const logsCampaign = broadcastLogs.list({ campaign: 'tuesday_reminder_20261117' });
    assert.equal(logsCampaign.length, 1);

    const emptyCampaign = broadcastLogs.list({ campaign: 'unknown_campaign' });
    assert.equal(emptyCampaign.length, 0);
  });

  await t.test('6. User sessions lifecycle', () => {
    const testJid = '77011863190@s.whatsapp.net';

    // Initial non-existent session
    assert.equal(sessions.get(testJid), null);

    // Save session state
    sessions.set(testJid, 'WAITING_PLAYERS', { teamName: 'Киноманы', step: 2 });
    const s1 = sessions.get(testJid);
    assert.ok(s1);
    assert.equal(s1.jid, testJid);
    assert.equal(s1.state, 'WAITING_PLAYERS');
    assert.deepEqual(s1.data, { teamName: 'Киноманы', step: 2 });

    // Update existing session
    sessions.set(testJid, 'WAITING_GAME', { teamName: 'Киноманы', playersCount: 5 });
    const s2 = sessions.get(testJid);
    assert.equal(s2.state, 'WAITING_GAME');
    assert.equal(s2.data.playersCount, 5);

    // Clear session
    sessions.clear(testJid);
    assert.equal(sessions.get(testJid), null);

    // Clearing non-existent session is safe
    assert.doesNotThrow(() => sessions.clear('unknown@s.whatsapp.net'));
  });

  await t.test('7. Edge cases: Special characters, Cyrillic, Emojis, Boundary numbers', () => {
    const complexBooking = bookings.create({
      teamName: 'Команда «Звезда» & Co! 🎬🍿',
      captainName: "Д'Артаньян O'Connor",
      captainPhone: '+7(702) 999-88-77',
      playersCount: 2, // minimum boundary
      gameTitle: 'Культовые Аниме (24.11 в 19:30)',
      gameDate: '2026-11-24',
      source: 'web_modal',
      notes: 'VIP стол.\n"Вторая строка с кавычками"\tТабуляция'
    });

    assert.equal(complexBooking.team_name, 'Команда «Звезда» & Co! 🎬🍿');
    assert.equal(complexBooking.captain_name, "Д'Артаньян O'Connor");
    assert.equal(complexBooking.captain_phone, '+77029998877');
    assert.equal(complexBooking.players_count, 2);
    assert.equal(complexBooking.notes, 'VIP стол.\n"Вторая строка с кавычками"\tТабуляция');

    const maxPlayersBooking = bookings.create({
      teamName: 'Максимум 10',
      captainName: 'Иван',
      captainPhone: '77771234567',
      playersCount: 10, // maximum boundary
      gameTitle: 'Культовые Аниме',
      gameDate: '2026-11-24'
    });
    assert.equal(maxPlayersBooking.players_count, 10);
  });

  await t.test('8. CSV Export generation & RFC 4180 escaping', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoquiz-csv-'));
    const outputPath = path.join(tempDir, 'bookings_export.csv');

    const csvContent = await exportBookingsCsv(db, outputPath);

    // Verify UTF-8 BOM
    assert.ok(csvContent.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM (\\uFEFF)');

    // Verify 10 headers
    assert.ok(csvContent.includes('ID,Created At,Team Name,Captain Name,Captain Phone,Players Count,Game Title,Game Date,Source,Notes'));

    // Verify escaping of quotes, commas, and newlines
    assert.ok(csvContent.includes('""Вторая строка с кавычками""'));
    assert.ok(csvContent.includes('Команда «Звезда» & Co! 🎬🍿'));

    // Verify written file
    assert.ok(fs.existsSync(outputPath), 'Output CSV file must be written to disk');
    const fileContent = fs.readFileSync(outputPath, 'utf8');
    assert.equal(fileContent, csvContent);

    // Test game title filter export
    const filteredCsv = await exportBookingsCsv(db, null, 'Культовые Аниме');
    assert.ok(filteredCsv.startsWith('\uFEFF'));
    assert.ok(filteredCsv.includes('Максимум 10'));

    // Clean up temp
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('9. Google Sheets sync: Graceful degradation and mock client', async () => {
    // 1. Unconfigured credentials return graceful error object without throwing
    const unconfiguredRes = await exportBookingsToGoogleSheets(db, {});
    assert.equal(unconfiguredRes.syncedCount, 0);
    assert.ok(unconfiguredRes.error.includes('Google Sheets credentials not configured'));

    // 2. Mock sheetsClient records appended rows
    const appendedRows = [];
    const mockSheetsClient = {
      async appendRows(rows) {
        appendedRows.push(...rows);
      }
    };

    const mockRes = await exportBookingsToGoogleSheets(db, { sheetsClient: mockSheetsClient });
    assert.ok(mockRes.syncedCount >= 3, 'Synced rows count should match existing bookings');
    assert.equal(appendedRows.length, mockRes.syncedCount);
    assert.equal(appendedRows[0][2], 'Киноманы'); // Team Name column

    // 3. Network or authorization error returns graceful error object without unhandled rejection
    const failingFetchStub = async () => {
      return {
        ok: false,
        status: 403,
        async text() {
          return 'Permission denied';
        }
      };
    };

    const failingRes = await exportBookingsToGoogleSheets(db, {
      googleSheets: {
        serviceAccountEmail: 'test@serviceaccount.com',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
        spreadsheetId: 'test-spreadsheet-id'
      },
      fetchStub: failingFetchStub
    });

    assert.equal(failingRes.syncedCount, 0);
    assert.ok(failingRes.error);
  });

  await t.test('10. Game catalog loader parsing & fallbacks', () => {
    // Test parent directory with live workspace
    const parentDir = path.resolve(__dirname, '../../..');
    const games = getActiveGames(parentDir);

    assert.ok(Array.isArray(games), 'getActiveGames must return array');
    assert.ok(games.length >= 1, 'At least one active game must be returned');

    const first = games[0];
    assert.ok(first.id, 'Game must have id');
    assert.ok(first.title, 'Game must have title');
    assert.ok(first.dateStr, 'Game must have dateStr');
    assert.ok(first.timeStr, 'Game must have timeStr');
    assert.ok(first.price, 'Game must have price');
    assert.ok(first.status, 'Game must have status');

    // Test fallback behavior with empty/missing directory
    const fallbackGames = getActiveGames('/non-existent-directory-12345');
    assert.ok(Array.isArray(fallbackGames));
    assert.ok(fallbackGames.length >= 1, 'Fallback must provide default games without throwing');
    assert.equal(fallbackGames[0].title, 'Киномарафон: 100 вопросов');
  });

  close();
});
