/**
 * tests/broadcast.test.js
 * Comprehensive Unit Test Suite for Broadcast Engine & Tuesday Scheduler (Milestone M3)
 *
 * Verifies:
 * 1. Template variable substitution and token personalization (personalizeMessage)
 * 2. Anti-spam randomized jitter calculation within [3000, 7000] ms bounds
 * 3. Anti-spam typing presence simulation delay within [1000, 2000] ms bounds
 * 4. Phone number to WhatsApp JID conversion (phoneToJid)
 * 5. Opt-out and opt-in command detection (isOptOutMessage / isOptInMessage)
 * 6. Opt-out database handler (handleOptOut & handleOptIn)
 * 7. Serialized FIFO queue execution with presence simulation and jitter delays
 * 8. Queue filtering of opted-out recipients (status: 'skipped_opted_out')
 * 9. Resiliency against socket send errors (status: 'failed', no worker crash)
 * 10. Tuesday Game-Day Scheduler (calendar info, game matching, confirmed bookings, deduplication)
 * 11. Scheduler execution skipping on non-Tuesday dates
 * 12. Scheduler task lifecycle and stop()
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRandomJitter,
  getRandomTypingDelay,
  phoneToJid,
  personalizeMessage,
  isOptOutMessage,
  isOptInMessage,
  handleOptOut,
  handleOptIn,
  findContactFlexible,
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

import { initDatabase } from '../src/db/database.js';
import { createMockSocket } from './helpers/mockSocket.js';

test('Broadcast Engine & Tuesday Scheduler Test Suite (Milestone M3)', async (t) => {
  // 1. Template Token Personalization
  await t.test('1. personalizeMessage dynamically substitutes recipient and game tokens', () => {
    const template =
      'Привет, {{captain}}! Команда {{team}} играет в {{game}} {{date}} в {{time}}. Взнос: {{price}}. Ждём вас: {{location}}! Человек: {{players}}.';

    const params = {
      captain: 'Алексей',
      team: '«Киноманы»',
      game: 'Marvel & DC',
      date: '24 ноября',
      time: '19:30',
      price: '3 000 ₸',
      location: 'Караоке-бар «То Место»',
      players: 6
    };

    const res = personalizeMessage(template, params);

    assert.equal(
      res,
      'Привет, Алексей! Команда «Киноманы» играет в Marvel & DC 24 ноября в 19:30. Взнос: 3 000 ₸. Ждём вас: Караоке-бар «То Место»! Человек: 6.'
    );

    // Case-insensitivity check
    const templateCase = 'Капитан: {{CAPTAIN}}, Команда: {{Team}}, Игра: {{GAME}}';
    assert.equal(
      personalizeMessage(templateCase, { captain: 'Ольга', team: 'Stars', game: 'Cinema' }),
      'Капитан: Ольга, Команда: Stars, Игра: Cinema'
    );

    // Unknown tokens preserved, missing params fallback
    const templateFallback = 'Привет, {{name}}! Токен {{unrecognized}} остался.';
    assert.equal(
      personalizeMessage(templateFallback, { name: 'Иван' }),
      'Привет, Иван! Токен {{unrecognized}} остался.'
    );

    // Non-string template returns empty string
    assert.equal(personalizeMessage(null), '');
    assert.equal(personalizeMessage(undefined), '');
  });

  // 2. Jitter Timing Math
  await t.test('2. getRandomJitter generates integer values strictly within [3000, 7000] ms', () => {
    let minObserved = Infinity;
    let maxObserved = -Infinity;

    for (let i = 0; i < 10000; i++) {
      const val = getRandomJitter(3000, 7000);
      assert.ok(Number.isInteger(val), `Value ${val} should be an integer`);
      assert.ok(val >= 3000, `Value ${val} should be >= 3000`);
      assert.ok(val <= 7000, `Value ${val} should be <= 7000`);

      if (val < minObserved) minObserved = val;
      if (val > maxObserved) maxObserved = val;
    }

    // Verify statistical coverage across the 3000-7000 interval
    assert.ok(minObserved <= 3050, `Expected min near 3000, got ${minObserved}`);
    assert.ok(maxObserved >= 6950, `Expected max near 7000, got ${maxObserved}`);
  });

  // 3. Typing Presence Delay Math
  await t.test('3. getRandomTypingDelay generates integer values strictly within [1000, 2000] ms', () => {
    let minObserved = Infinity;
    let maxObserved = -Infinity;

    for (let i = 0; i < 1000; i++) {
      const val = getRandomTypingDelay(1000, 2000);
      assert.ok(Number.isInteger(val), `Value ${val} should be an integer`);
      assert.ok(val >= 1000, `Value ${val} should be >= 1000`);
      assert.ok(val <= 2000, `Value ${val} should be <= 2000`);

      if (val < minObserved) minObserved = val;
      if (val > maxObserved) maxObserved = val;
    }

    assert.ok(minObserved <= 1050, `Expected min near 1000, got ${minObserved}`);
    assert.ok(maxObserved >= 1950, `Expected max near 2000, got ${maxObserved}`);
  });

  // 4. Phone to WhatsApp JID Conversion
  await t.test('4. phoneToJid formats Kazakhstan phone numbers into WhatsApp JIDs', () => {
    assert.equal(phoneToJid('+7 (701) 186-31-90'), '77011863190@s.whatsapp.net');
    assert.equal(phoneToJid('+77011863190'), '77011863190@s.whatsapp.net');
    assert.equal(phoneToJid('87011863190'), '77011863190@s.whatsapp.net');
    assert.equal(phoneToJid('8 (7212) 50-60-70'), '77212506070@s.whatsapp.net');
    assert.equal(phoneToJid(''), '');
    assert.equal(phoneToJid(null), '');
  });

  // 5. Opt-Out and Opt-In Command Detection
  await t.test('5. isOptOutMessage and isOptInMessage accurately match unsubscribe/subscribe commands', () => {
    // Valid opt-out
    assert.equal(isOptOutMessage('СТОП'), true);
    assert.equal(isOptOutMessage('стоп'), true);
    assert.equal(isOptOutMessage('STOP'), true);
    assert.equal(isOptOutMessage('stop'), true);
    assert.equal(isOptOutMessage('  СТОП  \n'), true);

    // Negative opt-out cases
    assert.equal(isOptOutMessage('Привет'), false);
    assert.equal(isOptOutMessage('СТОП СПАСИБО'), false);
    assert.equal(isOptOutMessage('1'), false);
    assert.equal(isOptOutMessage('отмена'), false);
    assert.equal(isOptOutMessage(null), false);

    // Valid opt-in
    assert.equal(isOptInMessage('СТАРТ'), true);
    assert.equal(isOptInMessage('старт'), true);
    assert.equal(isOptInMessage('START'), true);
    assert.equal(isOptInMessage('start'), true);
    assert.equal(isOptInMessage('  СТАРТ  '), true);
    assert.equal(isOptInMessage('Запуск'), false);
  });

  // 6. Opt-Out & Opt-In SQLite Handler
  await t.test('6. handleOptOut updates contacts subscription and records opted_out log', () => {
    const db = initDatabase(':memory:');

    // Create subscribed contact
    db.contacts.upsert({
      phone: '+7 (701) 186-31-90',
      name: 'Алексей',
      teamName: 'Киноманы',
      role: 'captain'
    });

    const contactBefore = db.contacts.getByPhone('+77011863190');
    assert.equal(contactBefore.is_subscribed, 1);

    // Process opt-out
    const res = handleOptOut({ phone: '+7 (701) 186-31-90', text: 'СТОП', db });
    assert.equal(res.optedOut, true);
    assert.match(res.replyText, /успешно отписались/);

    const contactAfter = db.contacts.getByPhone('+77011863190');
    assert.equal(contactAfter.is_subscribed, 0);

    // Verify broadcast_logs entry
    const logs = db.broadcastLogs.list({ campaign: 'opt_out' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'opted_out');
    assert.equal(logs[0].recipient_phone, '+77011863190');

    // Re-subscribe with handleOptIn
    const inRes = handleOptIn({ phone: '+77011863190', text: 'СТАРТ', db });
    assert.equal(inRes.optedIn, true);
    assert.match(inRes.replyText, /снова подписаны/);

    const contactResubscribed = db.contacts.getByPhone('+77011863190');
    assert.equal(contactResubscribed.is_subscribed, 1);

    db.db.close();
  });

  // 6b. Cross-Format Opt-Out & findContactFlexible
  await t.test('6b. handleOptOut handles cross-format numbers (digits-only JID opts out +7... contact)', () => {
    const db = initDatabase(':memory:');

    // Contact stored with international '+' format: '+7 (701) 186-31-90' -> '+77011863190'
    db.contacts.upsert({
      phone: '+7 (701) 186-31-90',
      name: 'Алексей',
      teamName: 'Киноманы',
      role: 'captain'
    });

    const contactBefore = db.contacts.getByPhone('+77011863190');
    assert.equal(contactBefore.is_subscribed, 1);

    // Incoming WhatsApp Baileys message sender is digits-only: '77011863190'
    const res = handleOptOut({ phone: '77011863190', text: 'СТОП', db });
    assert.equal(res.optedOut, true);

    // Verify contact in SQLite was updated to is_subscribed = 0
    const contactAfter = db.contacts.getByPhone('+77011863190');
    assert.equal(contactAfter.is_subscribed, 0);

    // Verify broadcast_logs recorded opt-out
    const logs = db.broadcastLogs.list({ campaign: 'opt_out' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'opted_out');
    assert.equal(logs[0].recipient_phone, '+77011863190');

    // Test findContactFlexible directly across variants
    assert.ok(findContactFlexible(db, '+7 (701) 186-31-90'));
    assert.ok(findContactFlexible(db, '+77011863190'));
    assert.ok(findContactFlexible(db, '77011863190'));
    assert.ok(findContactFlexible(db, '87011863190'));
    assert.ok(findContactFlexible(db, '8 (701) 186-31-90'));
    assert.equal(findContactFlexible(db, '77029998877'), null);

    // Re-subscribe with local trunk '87011863190'
    const inRes = handleOptIn({ phone: '87011863190', text: 'СТАРТ', db });
    assert.equal(inRes.optedIn, true);

    const contactResubscribed = db.contacts.getByPhone('+77011863190');
    assert.equal(contactResubscribed.is_subscribed, 1);

    db.db.close();
  });

  // 7. Serialized FIFO Queue Execution
  await t.test('7. createBroadcaster executes serialized queue with presence typing and jitter delays', async () => {
    const db = initDatabase(':memory:');
    const mockSocket = createMockSocket();

    const recordedDelays = [];
    const recordedTypingDelays = [];

    const broadcaster = createBroadcaster({
      db,
      sock: mockSocket,
      sleepFn: async (ms) => {
        recordedDelays.push(ms);
      },
      typingDelayFn: async (ms) => {
        recordedTypingDelays.push(ms);
      },
      delayRange: { min: 3000, max: 7000 },
      typingDelayRange: { min: 1000, max: 2000 }
    });

    const recipients = [
      { phone: '+77011110001', name: 'Капитан 1', team: 'Команда 1' },
      { phone: '+77011110002', name: 'Капитан 2', team: 'Команда 2' },
      { phone: '+77011110003', name: 'Капитан 3', team: 'Команда 3' }
    ];

    const template = 'Привет, {{captain}}! Ваша команда: {{team}}.';

    const enqueueResult = await broadcaster.enqueue({
      recipients,
      messageTemplate: template,
      campaign: 'test_fifo'
    });

    assert.equal(enqueueResult.queuedCount, 3);
    assert.ok(enqueueResult.batchId.startsWith('BATCH_'));

    // Wait until queue is completely drained
    await broadcaster.drain();

    const status = broadcaster.getStatus();
    assert.equal(status.processedCount, 3);
    assert.equal(status.sentCount, 3);
    assert.equal(status.failedCount, 0);
    assert.equal(status.queueLength, 0);
    assert.equal(status.isRunning, false);

    // Verify presence typing updates
    assert.equal(mockSocket.presenceUpdates.length, 3);
    for (const update of mockSocket.presenceUpdates) {
      assert.equal(update.presence, 'composing');
    }
    assert.equal(recordedTypingDelays.length, 3);
    for (const td of recordedTypingDelays) {
      assert.ok(td >= 1000 && td <= 2000);
    }

    // Verify messages sent in exact FIFO order
    assert.equal(mockSocket.sentMessages.length, 3);
    assert.equal(mockSocket.sentMessages[0].jid, '77011110001@s.whatsapp.net');
    assert.equal(mockSocket.sentMessages[0].content.text, 'Привет, Капитан 1! Ваша команда: Команда 1.');
    assert.equal(mockSocket.sentMessages[1].jid, '77011110002@s.whatsapp.net');
    assert.equal(mockSocket.sentMessages[1].content.text, 'Привет, Капитан 2! Ваша команда: Команда 2.');
    assert.equal(mockSocket.sentMessages[2].jid, '77011110003@s.whatsapp.net');
    assert.equal(mockSocket.sentMessages[2].content.text, 'Привет, Капитан 3! Ваша команда: Команда 3.');

    // Verify jitter delays between messages (2 delays for 3 messages)
    assert.equal(recordedDelays.length, 2);
    for (const delay of recordedDelays) {
      assert.ok(delay >= 3000 && delay <= 7000);
    }

    // Verify SQLite broadcast_logs entries
    const logs = db.broadcastLogs.list({ campaign: 'test_fifo' });
    assert.equal(logs.length, 3);
    for (const log of logs) {
      assert.equal(log.status, 'sent');
      assert.equal(log.error, null);
    }

    db.db.close();
  });

  // 8. Opt-Out Filter in Broadcast Queue
  await t.test('8. createBroadcaster skips unsubscribed contacts with status=skipped_opted_out', async () => {
    const db = initDatabase(':memory:');
    const mockSocket = createMockSocket();

    // Create 3 contacts in DB: #2 is unsubscribed
    db.contacts.upsert({ phone: '+77010000001', name: 'Капитан 1', teamName: 'Команда 1' });
    db.contacts.upsert({ phone: '+77010000002', name: 'Капитан 2', teamName: 'Команда 2' });
    db.contacts.upsert({ phone: '+77010000003', name: 'Капитан 3', teamName: 'Команда 3' });
    db.contacts.setSubscription('+77010000002', 0); // Opt-out

    const broadcaster = createBroadcaster({
      db,
      sock: mockSocket,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    const recipients = [
      { phone: '+77010000001', name: 'Капитан 1', team: 'Команда 1' },
      { phone: '+77010000002', name: 'Капитан 2', team: 'Команда 2' },
      { phone: '+77010000003', name: 'Капитан 3', team: 'Команда 3' }
    ];

    await broadcaster.enqueue({
      recipients,
      messageTemplate: 'Привет, {{captain}}!',
      campaign: 'opt_out_check'
    });

    await broadcaster.drain();

    const status = broadcaster.getStatus();
    assert.equal(status.sentCount, 2);
    assert.equal(status.skippedCount, 1);

    // Only 2 messages dispatched via socket (contacts 1 and 3)
    assert.equal(mockSocket.sentMessages.length, 2);
    assert.equal(mockSocket.sentMessages[0].jid, '77010000001@s.whatsapp.net');
    assert.equal(mockSocket.sentMessages[1].jid, '77010000003@s.whatsapp.net');

    // DB logs verify skipped_opted_out
    const logs = db.broadcastLogs.list({ campaign: 'opt_out_check' });
    assert.equal(logs.length, 3);
    const skippedLog = logs.find((l) => l.recipient_phone === '+77010000002');
    assert.ok(skippedLog);
    assert.equal(skippedLog.status, 'skipped_opted_out');

    db.db.close();
  });

  // 9. Socket Send Error Resilience
  await t.test('9. createBroadcaster logs failed status without crashing on socket errors', async () => {
    const db = initDatabase(':memory:');

    let sendAttempts = 0;
    const failingSender = async (jid, content) => {
      sendAttempts++;
      if (sendAttempts === 1) {
        throw new Error('Connection terminated by remote host');
      }
      return { key: { id: 'msg-success' } };
    };

    const broadcaster = createBroadcaster({
      db,
      senderFn: failingSender,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    await broadcaster.enqueue({
      recipients: [
        { phone: '+77012220001', name: 'Капитан 1' },
        { phone: '+77012220002', name: 'Капитан 2' }
      ],
      messageTemplate: 'Анонс!',
      campaign: 'error_resilience'
    });

    await broadcaster.drain();

    const status = broadcaster.getStatus();
    assert.equal(status.failedCount, 1);
    assert.equal(status.sentCount, 1);
    assert.equal(status.processedCount, 2);

    const logs = db.broadcastLogs.list({ campaign: 'error_resilience' });
    assert.equal(logs.length, 2);

    const failedLog = logs.find((l) => l.recipient_phone === '+77012220001');
    assert.ok(failedLog);
    assert.equal(failedLog.status, 'failed');
    assert.match(failedLog.error, /Connection terminated/);

    const successLog = logs.find((l) => l.recipient_phone === '+77012220002');
    assert.ok(successLog);
    assert.equal(successLog.status, 'sent');

    db.db.close();
  });

  // 10. Tuesday Game-Day Scheduler Logic
  await t.test('10. initGameDayScheduler compiles tonight bookings and deduplicates captain reminders', async () => {
    const db = initDatabase(':memory:');
    const mockSocket = createMockSocket();

    const broadcaster = createBroadcaster({
      db,
      sock: mockSocket,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    // Seed bookings for tonight's game:
    // Game: 'Киномарафон: 100 вопросов' on '2026-11-24'
    const gameTitle = 'Киномарафон: 100 вопросов';

    // 1. Booking for Captain A (confirmed)
    db.bookings.create({
      teamName: 'Команда Альфа',
      captainName: 'Алексей',
      captainPhone: '+7 (701) 111-22-33',
      playersCount: 6,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // 2. Second booking for Captain A (same phone, different or second table) -> should be deduplicated
    db.bookings.create({
      teamName: 'Команда Альфа 2',
      captainName: 'Алексей',
      captainPhone: '+7 701 111 22 33',
      playersCount: 4,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // 3. Booking for Captain B (confirmed)
    db.bookings.create({
      teamName: 'Команда Бета',
      captainName: 'Борис',
      captainPhone: '+7 (701) 444-55-66',
      playersCount: 5,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // 4. Booking for Captain C (cancelled) -> should be excluded
    db.bookings.create({
      teamName: 'Команда Гамма',
      captainName: 'Григорий',
      captainPhone: '+7 (701) 777-88-99',
      playersCount: 4,
      gameTitle,
      gameDate: '24 ноября',
      status: 'cancelled'
    });

    // Mock catalog loader returning tonight's game
    const mockGames = [
      {
        id: 'game-1',
        title: gameTitle,
        dateStr: '24 ноября',
        timeStr: '19:30',
        dayName: 'ВТ',
        status: 'ОТКРЫТА ЗАПИСЬ'
      }
    ];

    const mockGetActiveGames = () => mockGames;

    // Fixed Tuesday date: 2026-11-24 (Tuesday)
    const tuesdayDate = new Date('2026-11-24T12:00:00.000+05:00');

    const scheduler = await initGameDayScheduler({
      db,
      getActiveGames: mockGetActiveGames,
      broadcaster,
      timezone: 'Asia/Almaty'
    });

    const runResult = await scheduler.runNow(tuesdayDate);

    assert.equal(runResult.success, true);
    assert.equal(runResult.game.title, gameTitle);
    // 3 confirmed bookings in total for tonight
    assert.equal(runResult.bookingsCount, 3);
    // 2 unique captain phone numbers (Captain A and Captain B)
    assert.equal(runResult.uniqueCaptainsCount, 2);
    assert.equal(runResult.queuedCount, 2);

    await broadcaster.drain();

    // Verify exactly 2 reminders sent via WhatsApp
    assert.equal(mockSocket.sentMessages.length, 2);
    assert.match(mockSocket.sentMessages[0].content.text, /Алексей/);
    assert.match(mockSocket.sentMessages[0].content.text, /Киномарафон: 100 вопросов/);
    assert.match(mockSocket.sentMessages[1].content.text, /Борис/);

    scheduler.stop();
    db.db.close();
  });

  // 10b. Cross-Format Captain Deduplication in Scheduler
  await t.test('10b. initGameDayScheduler deduplicates cross-format captain phones (+7... and 8...)', async () => {
    const db = initDatabase(':memory:');
    const mockSocket = createMockSocket();

    const broadcaster = createBroadcaster({
      db,
      sock: mockSocket,
      sleepFn: async () => {},
      typingDelayFn: async () => {}
    });

    const gameTitle = 'Гарри Поттер: Турнир Трёх Волшебников';

    // Booking 1: '+7 (701) 111-22-33'
    db.bookings.create({
      teamName: 'Гриффиндор',
      captainName: 'Гарри',
      captainPhone: '+7 (701) 111-22-33',
      playersCount: 6,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // Booking 2: '87011112233' (same captain, different phone format: local trunk 8)
    db.bookings.create({
      teamName: 'Гриффиндор Стол 2',
      captainName: 'Гарри',
      captainPhone: '87011112233',
      playersCount: 5,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // Booking 3: '77011112233' (same captain, digits-only format)
    db.bookings.create({
      teamName: 'Гриффиндор Стол 3',
      captainName: 'Гарри',
      captainPhone: '77011112233',
      playersCount: 4,
      gameTitle,
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    const mockGames = [
      {
        id: 'game-hp',
        title: gameTitle,
        dateStr: '24 ноября',
        timeStr: '19:30',
        dayName: 'ВТ',
        status: 'ОТКРЫТА ЗАПИСЬ'
      }
    ];

    const scheduler = await initGameDayScheduler({
      db,
      getActiveGames: () => mockGames,
      broadcaster,
      timezone: 'Asia/Almaty'
    });

    const tuesdayDate = new Date('2026-11-24T12:00:00.000+05:00');
    const runResult = await scheduler.runNow(tuesdayDate);

    assert.equal(runResult.success, true);
    assert.equal(runResult.bookingsCount, 3);
    // Deduplicated across '+7...', '8...', '7...' to exactly 1 unique captain
    assert.equal(runResult.uniqueCaptainsCount, 1);
    assert.equal(runResult.queuedCount, 1);

    await broadcaster.drain();

    assert.equal(mockSocket.sentMessages.length, 1);
    assert.equal(mockSocket.sentMessages[0].jid, '77011112233@s.whatsapp.net');

    scheduler.stop();
    db.db.close();
  });

  // 11. Scheduler Day Guard (Skip on Non-Tuesday)
  await t.test('11. scheduler.runNow skips reminder dispatch when day is not Tuesday', async () => {
    const db = initDatabase(':memory:');
    const broadcaster = createBroadcaster({ db });

    const scheduler = await initGameDayScheduler({
      db,
      getActiveGames: () => [],
      broadcaster
    });

    // Wednesday: 2026-11-25
    const wednesdayDate = new Date('2026-11-25T12:00:00.000+05:00');
    const result = await scheduler.runNow(wednesdayDate);

    assert.equal(result.success, true);
    assert.equal(result.reason, 'not_tuesday');
    assert.equal(result.queuedCount, 0);

    scheduler.stop();
    db.db.close();
  });

  // 12. Scheduler Lifecycle and Stop()
  await t.test('12. scheduler exposes stop() method to cleanly stop scheduled cron task', async () => {
    let cronScheduled = false;
    let cronStopped = false;

    const mockCron = {
      schedule: (expr, fn, opts) => {
        cronScheduled = true;
        return {
          stop: () => {
            cronStopped = true;
          }
        };
      }
    };

    const scheduler = await initGameDayScheduler({
      db: null,
      getActiveGames: () => [],
      broadcaster: null,
      cronModule: mockCron
    });

    assert.equal(cronScheduled, true);
    scheduler.stop();
    assert.equal(cronStopped, true);
  });
});
