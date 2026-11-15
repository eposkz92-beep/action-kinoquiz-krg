import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase } from '../src/db/database.js';
import {
  BROADCAST_TEMPLATES,
  prepareBroadcastTemplate,
  resolveBroadcastRecipients,
  executeManualBroadcast
} from '../src/broadcast/manualBroadcast.js';

describe('Manual / Ad-hoc Broadcast Engine', () => {
  let db;

  beforeEach(() => {
    db = initDatabase(':memory:');

    // Seed bookings
    db.bookings.create({
      teamName: 'ДНК',
      captainName: 'Алексей',
      captainPhone: '+77011112233',
      playersCount: 6,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      status: 'confirmed'
    });

    db.bookings.create({
      teamName: 'Heavy Mental',
      captainName: 'Динара',
      captainPhone: '87012223344',
      playersCount: 5,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      status: 'confirmed'
    });

    // Duplicate booking for same captain on same game
    db.bookings.create({
      teamName: 'ДНК Резерв',
      captainName: 'Алексей',
      captainPhone: '+77011112233',
      playersCount: 4,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      status: 'confirmed'
    });

    // Cancelled booking
    db.bookings.create({
      teamName: 'Отмененные',
      captainName: 'Иван',
      captainPhone: '+77019998877',
      playersCount: 4,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      status: 'cancelled'
    });

    // Different game booking
    db.bookings.create({
      teamName: 'Анимешники',
      captainName: 'Наруто',
      captainPhone: '+77054443322',
      playersCount: 6,
      gameTitle: 'Культовые Аниме',
      gameDate: '24 ноября',
      status: 'confirmed'
    });

    // Seed contacts
    db.contacts.upsert({ phone: '+77011112233', name: 'Алексей', teamName: 'ДНК' });
    db.contacts.upsert({ phone: '+77012223344', name: 'Динара', teamName: 'Heavy Mental' });
    db.contacts.upsert({ phone: '+77054443322', name: 'Наруто', teamName: 'Анимешники' });
    db.contacts.upsert({ phone: '+77078889900', name: 'Сергей', teamName: 'Спартак' });
  });

  it('1. prepareBroadcastTemplate returns templates with injected reasons and defaults', () => {
    const resResched = prepareBroadcastTemplate({
      type: 'reschedule',
      newDate: '20 ноября (среда)',
      newTime: '19:45',
      reason: 'Технические работы в зале'
    });

    assert.ok(resResched.template.includes('ПЕРЕНОС ИГРЫ'));
    assert.strictEqual(resResched.defaultParams.newDate, '20 ноября (среда)');
    assert.strictEqual(resResched.defaultParams.newTime, '19:45');
    assert.ok(resResched.defaultParams.reasonLine.includes('Технические работы в зале'));

    const resCancel = prepareBroadcastTemplate({
      type: 'cancel',
      reason: 'Форс-мажорные обстоятельства'
    });
    assert.ok(resCancel.template.includes('ОТМЕНА ИГРЫ'));
    assert.ok(resCancel.defaultParams.reasonLine.includes('Форс-мажорные'));

    const resCustom = prepareBroadcastTemplate({
      type: 'custom',
      customText: 'Ждем всех к 19:00 для разминки!'
    });
    assert.ok(resCustom.template.includes('ВАЖНОЕ СООБЩЕНИЕ'));
    assert.strictEqual(resCustom.defaultParams.text, 'Ждем всех к 19:00 для разминки!');
  });

  it('2. resolveBroadcastRecipients filters by game, deduplicates phones, and excludes cancelled bookings', () => {
    const recipients = resolveBroadcastRecipients({
      db,
      target: 'game',
      gameTitle: 'Киномарафон'
    });

    // Should contain Алексей (+77011112233) only once, and Динара (87012223344)
    // Ivan is cancelled, Naruto is in Anime game
    assert.strictEqual(recipients.length, 2);

    const phones = recipients.map(r => r.phone);
    assert.ok(phones.includes('+77011112233'));
    assert.ok(phones.includes('87012223344'));

    assert.strictEqual(recipients[0].params.game, 'Киномарафон: 100 вопросов');
  });

  it('3. resolveBroadcastRecipients respects opt-out subscription in contacts table', () => {
    // Unsubscribe Алексей
    db.contacts.setSubscription('+77011112233', 0);

    const recipients = resolveBroadcastRecipients({
      db,
      target: 'game',
      gameTitle: 'Киномарафон'
    });

    // Only Динара remains
    assert.strictEqual(recipients.length, 1);
    assert.strictEqual(recipients[0].name, 'Динара');
  });

  it('4. resolveBroadcastRecipients with target="all" includes all subscribed contacts', () => {
    // Bookings creation automatically registers captains into contacts table:
    // Алексей, Динара, Иван, Наруто + manual Сергей
    const totalContactsBefore = db.contacts.listForBroadcast().length;
    const recipients = resolveBroadcastRecipients({
      db,
      target: 'all'
    });

    assert.strictEqual(recipients.length, totalContactsBefore);

    // Unsubscribe Сергей
    db.contacts.setSubscription('+77078889900', 0);
    const updated = resolveBroadcastRecipients({
      db,
      target: 'all'
    });
    assert.strictEqual(updated.length, totalContactsBefore - 1);
  });

  it('5. executeManualBroadcast enqueues jobs and fires Telegram alert callback', async () => {
    let enqueuedPayload = null;
    let alertPayload = null;

    const mockBroadcaster = {
      async enqueue(payload) {
        enqueuedPayload = payload;
        return { batchId: 'BATCH_TEST_123', queuedCount: payload.recipients.length };
      }
    };

    const alertCallback = async (data) => {
      alertPayload = data;
    };

    const result = await executeManualBroadcast({
      db,
      broadcaster: mockBroadcaster,
      type: 'reschedule',
      target: 'game',
      gameTitle: 'Киномарафон',
      newDate: '21 ноября',
      newTime: '19:30',
      reason: 'Спецмероприятие',
      telegramAlertFn: alertCallback
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.batchId, 'BATCH_TEST_123');
    assert.strictEqual(result.queuedCount, 2);
    assert.strictEqual(result.recipientsCount, 2);

    assert.ok(enqueuedPayload);
    assert.strictEqual(enqueuedPayload.recipients.length, 2);
    assert.strictEqual(enqueuedPayload.params.newDate, '21 ноября');

    assert.ok(alertPayload);
    assert.strictEqual(alertPayload.type, 'reschedule');
    assert.strictEqual(alertPayload.recipientsCount, 2);
    assert.strictEqual(alertPayload.batchId, 'BATCH_TEST_123');
  });

  it('6. executeManualBroadcast returns 0 queued when no matching recipients exist', async () => {
    const mockBroadcaster = {
      async enqueue() {
        assert.fail('Should not be called');
      }
    };

    const result = await executeManualBroadcast({
      db,
      broadcaster: mockBroadcaster,
      type: 'cancel',
      target: 'game',
      gameTitle: 'Несуществующая игра'
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.queuedCount, 0);
    assert.strictEqual(result.batchId, null);
  });

  it('7. executeManualBroadcast supports custom override template', async () => {
    let capturedTemplate = '';
    const mockBroadcaster = {
      async enqueue(payload) {
        capturedTemplate = payload.messageTemplate;
        return { batchId: 'BATCH_OVERRIDE_1', queuedCount: 1 };
      }
    };

    const customTpl = 'Внимание, игра начинается раньше: {{newTime}}!';
    const result = await executeManualBroadcast({
      db,
      broadcaster: mockBroadcaster,
      type: 'custom',
      target: 'game',
      gameTitle: 'Культовые Аниме',
      overrideTemplate: customTpl,
      newTime: '18:00'
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedTemplate, customTpl);
  });

  it('8. executeManualBroadcast rejects when broadcaster is not provided', async () => {
    await assert.rejects(
      () => executeManualBroadcast({ db, broadcaster: null }),
      /Broadcaster instance is required/
    );
  });
});
