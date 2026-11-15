/**
 * tests/webBooking.test.js
 * Unit Test Suite for Web Booking Parser and Auto-Booking Interception
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestEnv } from './helpers/testEnv.js';
import { assertConfirmationCard } from './helpers/cardAssertions.js';
import {
  isWebBookingMessage,
  parseWebBookingMessage,
  stripTypographicQuotes
} from '../src/dialog/webBookingParser.js';
import { handleIncomingMessage, FSM_STATES } from '../src/dialog/fsm.js';

describe('Web Booking Parser & Interceptor Test Suite (Milestone M2)', () => {
  // 1. Standard Web Modal Message Parsing
  test('1. Standard web modal booking message parsing', () => {
    const rawMessage = [
      '🎬🍿 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Киномарафон: 100 вопросов (17.11 в 19:30) 🎯',
      '💬 *Настрой команды:* Готовы к кинобаттлу!',
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

    const parsed = parseWebBookingMessage(rawMessage, '77011863190@s.whatsapp.net');
    assert.equal(parsed.isWebBooking, true);
    assert.ok(parsed.data);

    assert.equal(parsed.data.teamName, 'ДНК');
    assert.equal(parsed.data.playersCount, 6);
    assert.equal(parsed.data.gameTitle, 'Киномарафон: 100 вопросов');
    assert.equal(parsed.data.gameDate, '17.11 в 19:30');
    assert.equal(parsed.data.league, 'Падаваны (новички)');
    assert.equal(parsed.data.captainPhone, '+77011863190');
    assert.equal(parsed.data.captainName, 'Капитан');
    assert.ok(parsed.data.notes.includes('Настрой: Готовы к кинобаттлу!'));
    assert.ok(parsed.data.notes.includes('Лига: Падаваны (новички)'));
  });

  // 2. Themed Emojis & Variations
  test('2. Themed emojis variations (Marathon, Anime, Harry Potter, Twilight)', () => {
    // 2.1 Marathon Theme
    const marathonMsg = [
      '🏃‍♂️🎬💥 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Киномарафон: 100 вопросов (17.11 в 19:30) 💯🔥',
      '💬 *Настрой команды:* Идём за рекордом на 100 вопросах!',
      '👥 *Команда:* «Острые Козырьки»',
      '♟️ *Количество игроков:* 8 чел.',
      '🏆 *Лига:* Джедаи (опытные)',
      '📱 *Телефон капитана:* +7 777 123 45 67',
      '',
      '📍 *Место:* Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
      '💰 *Взнос:* 3 000 ₸ с игрока',
      '🎟️ Ждём подтверждения брони стола!'
    ].join('\n');

    const pMarathon = parseWebBookingMessage(marathonMsg);
    assert.equal(pMarathon.isWebBooking, true);
    assert.equal(pMarathon.data.teamName, 'Острые Козырьки');
    assert.equal(pMarathon.data.playersCount, 8);
    assert.equal(pMarathon.data.gameTitle, 'Киномарафон: 100 вопросов');
    assert.equal(pMarathon.data.captainPhone, '+77771234567');

    // 2.2 Anime Theme
    const animeMsg = [
      '🦊⛩️⚔️ *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Культовые Аниме (24.11 в 19:30) 🍜⚡',
      '💬 *Настрой команды:* Даттебайо! Готовимся к битве шиноби!',
      '👥 *Команда:* «Коноха»',
      '♟️ *Количество игроков:* 4 чел.',
      '🏆 *Лига:* Падаваны (новички)',
      '📱 *Телефон капитана:* 87019998877',
      '',
      '📍 *Место:* Караоке-бар «То Место»',
      '💰 *Взнос:* 3 000 ₸',
      '🎟️ Ждём подтверждения!'
    ].join('\n');

    const pAnime = parseWebBookingMessage(animeMsg);
    assert.equal(pAnime.isWebBooking, true);
    assert.equal(pAnime.data.teamName, 'Коноха');
    assert.equal(pAnime.data.playersCount, 4);
    assert.equal(pAnime.data.gameTitle, 'Культовые Аниме');
    assert.equal(pAnime.data.captainPhone, '+77019998877');

    // 2.3 Harry Potter Theme
    const hpMsg = [
      '⚡🧙‍♂️🏰 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Вселенная Гарри Поттера (01.12 в 19:30) 🪄🦉',
      '💬 *Настрой команды:* Шалость удалась!',
      '👥 *Команда:* «Гриффиндор»',
      '♟️ *Количество игроков:* 5 чел.',
      '🏆 *Лига:* Джедаи (опытные)',
      '📱 *Телефон капитана:* +7 705 555 44 33',
      '',
      '📍 *Место:* Караоке-бар «То Место»',
      '💰 *Взнос:* 3 000 ₸',
      '🎟️ Ждём подтверждения брони стола!'
    ].join('\n');

    const pHp = parseWebBookingMessage(hpMsg);
    assert.equal(pHp.isWebBooking, true);
    assert.equal(pHp.data.teamName, 'Гриффиндор');
    assert.equal(pHp.data.playersCount, 5);
    assert.equal(pHp.data.gameTitle, 'Вселенная Гарри Поттера');

    // 2.4 Twilight Theme
    const twilightMsg = [
      '🐺🧛‍♂️🌲 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '',
      '📅 *Выбранная игра:* Сага Сумерки (08.12 в 19:30) 🍎🌙',
      '💬 *Настрой команды:* Эдвард vs Джейкоб!',
      '👥 *Команда:* «Каллены»',
      '♟️ *Количество игроков:* 7 чел.',
      '🏆 *Лига:* Падаваны (новички)',
      '📱 *Телефон капитана:* 77013332211',
      '',
      '📍 *Место:* Караоке-бар «То Место»',
      '💰 *Взнос:* 3 000 ₸ с игрока'
    ].join('\n');

    const pTwilight = parseWebBookingMessage(twilightMsg);
    assert.equal(pTwilight.isWebBooking, true);
    assert.equal(pTwilight.data.teamName, 'Каллены');
    assert.equal(pTwilight.data.playersCount, 7);
    assert.equal(pTwilight.data.captainPhone, '+77013332211');
  });

  // 3. Edge Cases: Line Endings, Missing Quotes, Special Players
  test('3. Edge cases (CRLF vs LF, missing asterisks, quotes, special player counts)', () => {
    // 3.1 Windows CRLF line endings (\r\n)
    const crlfMsg =
      '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*\r\n\r\n' +
      '📅 *Выбранная игра:* Киномарафон (17.11 в 19:30)\r\n' +
      '👥 *Команда:* «CRLF Мастера»\r\n' +
      '♟️ *Количество игроков:* 6 чел.\r\n' +
      '📱 *Телефон капитана:* +7 701 111 22 33\r\n' +
      '📍 *Место:* Караоке-бар «То Место»\r\n';

    const pCrlf = parseWebBookingMessage(crlfMsg);
    assert.equal(pCrlf.isWebBooking, true);
    assert.equal(pCrlf.data.teamName, 'CRLF Мастера');
    assert.equal(pCrlf.data.playersCount, 6);

    // 3.2 Stripped asterisks / plain text formatting
    const plainMsg = [
      'Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!',
      '',
      'Выбранная игра: Киномарафон: 100 вопросов',
      'Команда: Без Звёздочек',
      'Количество игроков: 5',
      'Телефон капитана: 87015556677'
    ].join('\n');

    const pPlain = parseWebBookingMessage(plainMsg);
    assert.equal(pPlain.isWebBooking, true);
    assert.equal(pPlain.data.teamName, 'Без Звёздочек');
    assert.equal(pPlain.data.playersCount, 5);
    assert.equal(pPlain.data.captainPhone, '+77015556677');

    // 3.3 Special players count: "1 (ищу команду)"
    const soloMsg = [
      '*Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '👥 *Команда:* «Одинокий Волк»',
      '♟️ *Количество игроков:* 1 (ищу команду)',
      '📅 *Выбранная игра:* Киномарафон (17.11 в 19:30)',
      '📱 *Телефон капитана:* +7 701 777 88 99'
    ].join('\n');

    const pSolo = parseWebBookingMessage(soloMsg);
    assert.equal(pSolo.isWebBooking, true);
    assert.equal(pSolo.data.playersCount, 1);
    assert.ok(pSolo.data.notes.includes('1 (ищу команду)'));

    // 3.4 Special players count: "Больше 10"
    const bigMsg = [
      '*Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '👥 *Команда:* «Большая Компания»',
      '♟️ *Количество игроков:* Больше 10 чел.',
      '📅 *Выбранная игра:* Киномарафон (17.11 в 19:30)',
      '📱 *Телефон капитана:* +7 701 777 88 99'
    ].join('\n');

    const pBig = parseWebBookingMessage(bigMsg);
    assert.equal(pBig.isWebBooking, true);
    assert.equal(pBig.data.playersCount, 10);

    // 3.5 Fallback to senderJid when phone line is missing
    const noPhoneMsg = [
      '*Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '👥 *Команда:* «Без Телефона»',
      '♟️ *Количество игроков:* 4 чел.',
      '📅 *Выбранная игра:* Киномарафон (17.11 в 19:30)'
    ].join('\n');

    const pFallback = parseWebBookingMessage(noPhoneMsg, '77028889900@s.whatsapp.net');
    assert.equal(pFallback.isWebBooking, true);
    assert.equal(pFallback.data.captainPhone, '+77028889900');
  });

  // 4. Negative Cases
  test('4. Negative cases (normal conversation, malformed input)', () => {
    assert.equal(isWebBookingMessage('Привет! Хотим сыграть в киноквиз'), false);
    assert.equal(isWebBookingMessage(''), false);
    assert.equal(isWebBookingMessage(null), false);
    assert.equal(isWebBookingMessage(undefined), false);

    const neg1 = parseWebBookingMessage('Здравствуйте, подскажите расписание на ноябрь?');
    assert.equal(neg1.isWebBooking, false);
    assert.equal(neg1.data, undefined);

    const neg2 = parseWebBookingMessage('');
    assert.equal(neg2.isWebBooking, false);
  });

  // 5. Auto-Booking Creation via handleIncomingMessage
  test('5. Auto-booking creation and database persistence via handleIncomingMessage', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const senderJid = '77011863190@s.whatsapp.net';
      const webMessage = [
        '🎬🍿 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
        '',
        '📅 *Выбранная игра:* Киномарафон: 100 вопросов (17.11 в 19:30) 🎯',
        '💬 *Настрой команды:* Только победа!',
        '👥 *Команда:* «Интерстеллар»',
        '♟️ *Количество игроков:* 6 чел.',
        '🏆 *Лига:* Джедаи (опытные)',
        '📱 *Телефон капитана:* +7 701 186 31 90',
        '',
        '📍 *Место:* Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
        '💰 *Взнос:* 3 000 ₸ с игрока',
        '🎟️ Ждём подтверждения брони стола!'
      ].join('\n');

      // Pre-seed an active session to verify it gets cleared
      env.sessions.set(senderJid, FSM_STATES.AWAITING_TEAM_NAME, { some: 'old_data' });

      // Handle message
      const result = await handleIncomingMessage({
        jid: senderJid,
        text: webMessage,
        pushName: 'Купер',
        db: env
      });

      // Assertions on result
      assert.equal(result.state, FSM_STATES.IDLE);
      assert.ok(result.bookingCreated, 'Must return created booking');
      assert.equal(result.bookingCreated.source, 'web_modal');
      assert.equal(result.bookingCreated.team_name, 'Интерстеллар');
      assert.equal(result.bookingCreated.players_count, 6);
      assert.equal(result.bookingCreated.captain_phone, '+77011863190');
      assert.equal(result.bookingCreated.game_title, 'Киномарафон: 100 вопросов');

      // Session should be cleared
      assert.equal(env.sessions.get(senderJid), null);

      // Database assertions
      const bookingsInDb = env.bookings.list();
      assert.equal(bookingsInDb.length, 1);
      assert.equal(bookingsInDb[0].team_name, 'Интерстеллар');
      assert.equal(bookingsInDb[0].source, 'web_modal');

      const teamInDb = env.teams.getByName('Интерстеллар');
      assert.ok(teamInDb);
      assert.equal(teamInDb.name, 'Интерстеллар');

      const contactInDb = env.contacts.getByPhone('+77011863190');
      assert.ok(contactInDb);
      assert.equal(contactInDb.phone, '+77011863190');

      // Confirmation card verification
      assert.equal(result.replies.length, 1);
      const confirmationCard = result.replies[0];
      assertConfirmationCard(confirmationCard, {
        team: 'Интерстеллар',
        players: 6,
        phone: '+77011863190',
        game: 'Киномарафон: 100 вопросов'
      });
    } finally {
      await env.cleanup();
    }
  });

  // 6. Defect 1: Casual Queries False Positive Rejection
  test('6. Defect 1: Casual queries must NOT trigger web booking parser or auto-booking', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const casualQueries = [
        'Здравствуйте! Мы хотим забронировать стол на киноквиз, сколько это стоит?',
        'Мы не хотим забронировать стол на киноквиз, мы хотим узнать результаты',
        'Привет, хочу забронировать киноквиз в Караганде',
        'Подскажите, как забронировать стол на киноквиз?'
      ];

      for (const query of casualQueries) {
        // 1. isWebBookingMessage MUST return false
        assert.equal(
          isWebBookingMessage(query),
          false,
          `Casual query falsely matched isWebBookingMessage: "${query}"`
        );

        // 2. parseWebBookingMessage MUST return { isWebBooking: false }
        const parsed = parseWebBookingMessage(query, '77011863190@s.whatsapp.net');
        assert.equal(
          parsed.isWebBooking,
          false,
          `Casual query falsely set isWebBooking: true: "${query}"`
        );
        assert.equal(parsed.data, undefined);

        // 3. handleIncomingMessage MUST NOT create any booking
        const result = await handleIncomingMessage({
          jid: '77011863190@s.whatsapp.net',
          text: query,
          db: env
        });

        assert.equal(
          result.bookingCreated,
          undefined,
          `Casual query falsely created a booking in DB for: "${query}"`
        );

        // Verify no phantom "Команда" bookings exist in DB
        const bookings = env.bookings.list();
        assert.equal(bookings.length, 0, 'No bookings must be created for casual queries');
      }
    } finally {
      await env.cleanup();
    }
  });

  // 7. Defect 2: Typographic Quote Stripping & Nested Quotes
  test('7. Defect 2: Typographic quotes stripping for all styles and nested quotes', () => {
    // 7.1 Direct stripTypographicQuotes tests
    const quotePairs = [
      ['«ДНК»', 'ДНК'],
      ['„ДНК“', 'ДНК'],
      ['»ДНК«', 'ДНК'],
      ['“ДНК”', 'ДНК'],
      ['‘ДНК’', 'ДНК'],
      ['"ДНК"', 'ДНК'],
      ["'ДНК'", 'ДНК'],
      ['««ДНК»»', 'ДНК'],
      ['«„ДНК“»', 'ДНК'],
      ['«»ДНК«»', 'ДНК'],
      ['*«ДНК»*', 'ДНК'],
      ['«*ДНК*»', 'ДНК'],
      ['«Клуб "Кино"»', 'Клуб "Кино"'],
      ['„Клуб "Кино"“', 'Клуб "Кино"'],
      ['»Клуб "Кино"«', 'Клуб "Кино"'],
      ['“Клуб "Кино"”', 'Клуб "Кино"'],
      ['‘Клуб "Кино"’', 'Клуб "Кино"'],
      ['"Клуб \'Кино\'"', "Клуб 'Кино'"],
      ["'Клуб \"Кино\"'", 'Клуб "Кино"']
    ];

    for (const [input, expected] of quotePairs) {
      assert.equal(
        stripTypographicQuotes(input),
        expected,
        `stripTypographicQuotes failed for "${input}"`
      );
    }

    // 7.2 Web booking modal message parsing with various quote styles
    const stylesToTest = [
      '«ДНК»',
      '„ДНК“',
      '»ДНК«',
      '“ДНК”',
      '‘ДНК’',
      '"ДНК"',
      "'ДНК'"
    ];

    for (const q of stylesToTest) {
      const msg = [
        '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
        '📅 *Выбранная игра:* Киномарафон',
        `👥 *Команда:* ${q}`,
        '♟️ *Количество игроков:* 5',
        '📱 *Телефон капитана:* +7 701 186 31 90'
      ].join('\n');

      const parsed = parseWebBookingMessage(msg);
      assert.equal(parsed.isWebBooking, true);
      assert.equal(
        parsed.data.teamName,
        'ДНК',
        `Failed extracting teamName for quote style: ${q}`
      );
    }

    // 7.3 Nested quotes in web booking modal
    const nestedMsg = [
      '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '📅 *Выбранная игра:* Киномарафон',
      '👥 *Команда:* «Клуб "Кино"»',
      '♟️ *Количество игроков:* 6',
      '📱 *Телефон капитана:* +7 701 186 31 90'
    ].join('\n');

    const pNested = parseWebBookingMessage(nestedMsg);
    assert.equal(pNested.isWebBooking, true);
    assert.equal(
      pNested.data.teamName,
      'Клуб "Кино"',
      'Nested quote inner quotation mark must be preserved'
    );
  });

  // 8. Safe JID Handling (Null/Undefined)
  test('8. Safe JID splitting with null and undefined inputs', () => {
    const webMsg = [
      '🎬 *Здравствуйте! Хотим забронировать стол на ACTION Киноквиз в Караганде!*',
      '📅 *Выбранная игра:* Киномарафон',
      '👥 *Команда:* «ДНК»',
      '♟️ *Количество игроков:* 4'
    ].join('\n');

    // Passing explicit null should not throw TypeError
    assert.doesNotThrow(() => {
      const pNull = parseWebBookingMessage(webMsg, null);
      assert.equal(pNull.isWebBooking, true);
      assert.ok(pNull.data.captainPhone);
    });

    // Passing explicit undefined should not throw TypeError
    assert.doesNotThrow(() => {
      const pUndef = parseWebBookingMessage(webMsg, undefined);
      assert.equal(pUndef.isWebBooking, true);
      assert.ok(pUndef.data.captainPhone);
    });
  });
});
