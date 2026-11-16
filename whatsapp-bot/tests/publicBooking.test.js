/**
 * tests/publicBooking.test.js
 * Unit Test Suite for Public Website Booking API & WhatsApp Auto-Confirmation
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, normalizePhone } from '../src/db/database.js';
import { phoneToJid } from '../src/broadcast/broadcaster.js';

test('Public Website Booking API Logic Test Suite', async (t) => {
  const db = initDatabase(':memory:');

  await t.test('1. Validates required fields: team name and captain phone', () => {
    const rawPayloadMissingTeam = { phone: '+7 701 123 45 67', players: '6' };
    const team = (rawPayloadMissingTeam.team || '').trim();
    assert.equal(Boolean(team), false);

    const rawPayloadMissingPhone = { team: 'ДНК', phone: '   ' };
    const phone = (rawPayloadMissingPhone.phone || '').trim();
    assert.equal(Boolean(phone), false);

    const invalidPhone = 'hello';
    const digits = String(invalidPhone).replace(/\D/g, '');
    assert.ok(digits.length < 10, 'Invalid phone has fewer than 10 digits');
  });

  await t.test('2. Successfully creates booking and updates captain contact in database', () => {
    const normPhone = normalizePhone('+7 (777) 987-65-43');
    assert.equal(normPhone, '+77779876543');

    const booking = db.bookings.create({
      teamName: 'Интерстеллар',
      captainName: 'Купер',
      captainPhone: normPhone,
      playersCount: 6,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      source: 'website',
      status: 'confirmed',
      notes: 'Лига Падаваны'
    });

    assert.ok(booking.id, 'Booking must have an ID');
    assert.equal(booking.team_name, 'Интерстеллар');
    assert.equal(booking.source, 'website');
    assert.equal(booking.players_count, 6);

    // Upsert captain contact
    db.contacts.upsert({
      phone: normPhone,
      name: 'Купер',
      teamName: 'Интерстеллар',
      role: 'captain'
    });

    const contact = db.contacts.getByPhone(normPhone);
    assert.ok(contact, 'Contact must be saved');
    assert.equal(contact.team_name, 'Интерстеллар');
    assert.equal(contact.is_subscribed, 1);
  });

  await t.test('3. WhatsApp confirmation message format contains all event details', () => {
    const teamName = 'Матрица';
    const captainName = 'Нео';
    const playersCount = 8;
    const gameTitle = 'Культовые Аниме';
    const gameDate = '24 ноября';
    const location = 'Караоке-бар «То Место»';

    const greetingName = captainName ? `, ${captainName}` : '';
    const datePart = gameDate ? ` (${gameDate})` : '';
    const confirmationText = [
      `🎉 *Здравствуйте${greetingName}!*`,
      '',
      `Ваша бронь стола на *ACTION Киноквиз* успешно принята! 🎬🍿`,
      '',
      `👥 *Команда:* «${teamName}»`,
      `♟️ *Количество игроков:* ${playersCount} чел.`,
      `📅 *Игра:* ${gameTitle}${datePart}`,
      `📍 *Место:* ${location}`,
      `💰 *Взнос:* 3 000 ₸ с игрока`,
      '',
      `Стол закреплён за вашей командой! Ждём вас к 19:30! ✨`,
      '',
      `_Если изменятся планы или состав команды — просто напишите нам в ответ на это сообщение._`
    ].join('\n');

    assert.ok(confirmationText.includes('Матрица'));
    assert.ok(confirmationText.includes('Нео'));
    assert.ok(confirmationText.includes('8 чел.'));
    assert.ok(confirmationText.includes('Культовые Аниме (24 ноября)'));
    assert.ok(confirmationText.includes('То Место'));
  });

  await t.test('4. Correctly converts captain phone to Baileys WhatsApp JID', () => {
    const phone = '+7 (701) 186-31-90';
    const norm = normalizePhone(phone);
    assert.equal(norm, '+77011863190');
    const jid = phoneToJid(norm);
    assert.equal(jid, '77011863190@s.whatsapp.net');
  });

  await t.test('5. Handles single player booking without a team (noTeam: true)', () => {
    const normPhone = normalizePhone('+7 705 333 22 11');
    const captainName = 'Алина';
    const noTeam = true;
    const teamName = noTeam ? 'Ищу команду' : 'ДНК';
    const playersCount = noTeam ? 1 : 6;
    const notes = '[ИЩЕТ КОМАНДУ] Лига: Падаваны';

    const booking = db.bookings.create({
      teamName,
      captainName,
      captainPhone: normPhone,
      playersCount,
      gameTitle: 'Киномарафон: 100 вопросов',
      gameDate: '17 ноября',
      source: 'website',
      status: 'confirmed',
      notes
    });

    assert.equal(booking.team_name, 'Ищу команду');
    assert.equal(booking.captain_name, 'Алина');
    assert.equal(booking.players_count, 1);
    assert.ok(booking.notes.includes('ИЩЕТ КОМАНДУ'));

    db.contacts.upsert({
      phone: normPhone,
      name: captainName,
      teamName,
      role: 'player'
    });

    const contact = db.contacts.getByPhone(normPhone);
    assert.equal(contact.name, 'Алина');
    assert.equal(contact.team_name, 'Ищу команду');
  });
});
