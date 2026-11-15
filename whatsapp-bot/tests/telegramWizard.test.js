/**
 * tests/telegramWizard.test.js
 * Unit Test Suite for Telegram Interactive Menu & Broadcast Wizard
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareBroadcastTemplate,
  resolveBroadcastRecipients,
  BROADCAST_TEMPLATES
} from '../src/broadcast/manualBroadcast.js';
import { personalizeMessage } from '../src/broadcast/broadcaster.js';
import { initDatabase } from '../src/db/database.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('Telegram Wizard & Target Audience Test Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoquiz-wizard-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDatabase(dbPath);

  t.after(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  });

  // Seed sample bookings across multiple games
  db.bookings.create({
    teamName: 'Киноманы',
    captainName: 'Алексей',
    captainPhone: '+7 (701) 111-22-33',
    playersCount: 6,
    gameTitle: 'Киномарафон: 100 вопросов',
    gameDate: '17 ноября',
    status: 'confirmed'
  });

  db.bookings.create({
    teamName: 'Анимешники',
    captainName: 'Диас',
    captainPhone: '+7 (702) 222-33-44',
    playersCount: 5,
    gameTitle: 'Культовые Аниме',
    gameDate: '24 ноября',
    status: 'confirmed'
  });

  db.bookings.create({
    teamName: 'Отмененные',
    captainName: 'Игорь',
    captainPhone: '+7 (703) 333-44-55',
    playersCount: 4,
    gameTitle: 'Киномарафон: 100 вопросов',
    gameDate: '17 ноября',
    status: 'cancelled'
  });

  await t.test('1. Audience target resolution isolates Game 1 recipients', () => {
    const recipients = resolveBroadcastRecipients({
      db,
      target: 'game',
      gameTitle: 'Киномарафон: 100 вопросов'
    });

    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].name, 'Алексей');
    assert.equal(recipients[0].team, 'Киноманы');
  });

  await t.test('2. Audience target resolution isolates Game 2 recipients', () => {
    const recipients = resolveBroadcastRecipients({
      db,
      target: 'game',
      gameTitle: 'Культовые Аниме'
    });

    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].name, 'Диас');
    assert.equal(recipients[0].team, 'Анимешники');
  });

  await t.test('3. Audience target "all" contacts retrieves all subscribed captains', () => {
    const recipients = resolveBroadcastRecipients({
      db,
      target: 'all'
    });

    assert.ok(recipients.length >= 2);
    const names = recipients.map(r => r.name);
    assert.ok(names.includes('Алексей'));
    assert.ok(names.includes('Диас'));
  });

  await t.test('4. Reschedule broadcast template correctly formats tokens', () => {
    const { template, defaultParams } = prepareBroadcastTemplate({
      type: 'reschedule',
      newDate: '20 ноября (среда)',
      newTime: '19:30',
      reason: 'Технические работы'
    });

    const personalized = personalizeMessage(template, {
      captain: 'Алексей',
      team: 'Киноманы',
      game: 'Киномарафон: 100 вопросов',
      date: '17 ноября',
      players: '6',
      ...defaultParams
    });

    assert.ok(personalized.includes('Алексей'));
    assert.ok(personalized.includes('Киноманы'));
    assert.ok(personalized.includes('20 ноября (среда)'));
    assert.ok(personalized.includes('Технические работы'));
    assert.ok(personalized.includes('автоматически сохранена'));
  });

  await t.test('5. Cancellation broadcast template includes refund information', () => {
    const { template, defaultParams } = prepareBroadcastTemplate({
      type: 'cancel',
      reason: 'Форс-мажор на площадке'
    });

    const personalized = personalizeMessage(template, {
      captain: 'Диас',
      team: 'Анимешники',
      game: 'Культовые Аниме',
      date: '24 ноября',
      ...defaultParams
    });

    assert.ok(personalized.includes('Диас'));
    assert.ok(personalized.includes('Анимешники'));
    assert.ok(personalized.includes('Форс-мажор на площадке'));
    assert.ok(personalized.includes('возвращены в полном объеме'));
  });

  await t.test('6. Custom announcement template formats natural text with team tokens', () => {
    const { template, defaultParams } = prepareBroadcastTemplate({
      type: 'custom',
      customText: 'Ждем всех сегодня в 19:00 на разминку!'
    });

    const personalized = personalizeMessage(template, {
      captain: 'Алексей',
      team: 'Киноманы',
      game: 'Киномарафон: 100 вопросов',
      ...defaultParams
    });

    assert.ok(personalized.includes('Алексей'));
    assert.ok(personalized.includes('Киноманы'));
    assert.ok(personalized.includes('Ждем всех сегодня в 19:00 на разминку!'));
  });
});
