/**
 * tests/dialog.test.js
 * Unit Test Suite for Dialog FSM, Navigation Menus, and Session Management
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestEnv } from './helpers/testEnv.js';
import { assertConfirmationCard } from './helpers/cardAssertions.js';
import {
  getMainMenuCard,
  getMainMenuText,
  getScheduleCard,
  getScheduleText,
  getVenueCard,
  getLocationText,
  getRulesCard,
  getRulesAndLeaguesText,
  getContactsCard,
  getContactsText,
  formatConfirmationCard
} from '../src/dialog/menu.js';
import { handleIncomingMessage, FSM_STATES, isSessionTimedOut } from '../src/dialog/fsm.js';

describe('Dialog FSM & Menu Test Suite (Milestone M2)', () => {
  // 1. Menu & Informational Cards Formatting & Markdown Compliance
  test('1. Informational cards formatting and WhatsApp markdown compliance', () => {
    // 1.1 Main menu card
    const menu = getMainMenuCard();
    assert.ok(typeof menu === 'string' && menu.length > 0);
    assert.ok(!menu.includes('**'), 'Menu must not contain double asterisks');
    assert.ok(!/(?:^|\n)#{1,6}\s/.test(menu), 'Menu must not contain Markdown headers');
    assert.ok(menu.includes('1️⃣'), 'Menu must include option 1');
    assert.ok(menu.includes('5️⃣'), 'Menu must include option 5');
    assert.ok(menu.includes('ACTION Киноквиз'), 'Menu must include branding');
    assert.equal(menu, getMainMenuText());

    // 1.2 Schedule card
    const sampleGames = [
      {
        title: 'Киномарафон: 100 вопросов',
        dateStr: '17 ноября',
        timeStr: '19:30',
        dayName: 'ВТ',
        price: '3 000 ₸',
        status: 'ОТКРЫТА ЗАПИСЬ',
        desc: 'Спецвыпуск'
      }
    ];
    const schedule = getScheduleCard(sampleGames);
    assert.ok(!schedule.includes('**'), 'Schedule must not contain double asterisks');
    assert.ok(!/(?:^|\n)#{1,6}\s/.test(schedule), 'Schedule must not contain Markdown headers');
    assert.ok(schedule.includes('Киномарафон: 100 вопросов'));
    assert.ok(schedule.includes('3 000 ₸'));
    assert.ok(schedule.includes('19:30'));
    assert.equal(schedule, getScheduleText(sampleGames));

    // Empty games schedule fallback
    const emptySchedule = getScheduleCard([]);
    assert.ok(!emptySchedule.includes('**'));
    assert.ok(emptySchedule.includes('открытых игр нет'));

    // 1.3 Venue & 2GIS card
    const venue = getVenueCard();
    assert.ok(!venue.includes('**'), 'Venue must not contain double asterisks');
    assert.ok(!/(?:^|\n)#{1,6}\s/.test(venue), 'Venue must not contain Markdown headers');
    assert.ok(venue.includes('То Место'), 'Venue must reference То Место');
    assert.ok(venue.includes('Нуркена Абдирова, д. 5'));
    assert.ok(venue.includes('2gis.kz'), 'Venue must contain 2GIS link');
    assert.equal(venue, getLocationText());

    // 1.4 Rules & Leagues card
    const rules = getRulesCard();
    assert.ok(!rules.includes('**'), 'Rules must not contain double asterisks');
    assert.ok(!/(?:^|\n)#{1,6}\s/.test(rules), 'Rules must not contain Markdown headers');
    assert.ok(rules.includes('Падаваны'), 'Rules must explain Padawans league');
    assert.ok(rules.includes('Джедаи'), 'Rules must explain Jedi league');
    assert.ok(rules.includes('3 000 ₸'), 'Rules must include entry fee');
    assert.ok(rules.includes('Оскар'), 'Rules must mention Oscar statuettes');
    assert.ok(rules.includes('рома'), 'Rules must mention rum raffle');
    assert.equal(rules, getRulesAndLeaguesText());

    // 1.5 Contacts card
    const contacts = getContactsCard();
    assert.ok(!contacts.includes('**'), 'Contacts must not contain double asterisks');
    assert.ok(!/(?:^|\n)#{1,6}\s/.test(contacts), 'Contacts must not contain Markdown headers');
    assert.ok(contacts.includes('+7 701 186 31 90'), 'Contacts must include phone number');
    assert.ok(contacts.includes('wa.me/77011863190'), 'Contacts must include wa.me link');
    assert.ok(contacts.includes('@action_kinoquiz_krg'), 'Contacts must include Instagram handle');
    assert.equal(contacts, getContactsText());

    // 1.6 Confirmation card
    const sampleBooking = {
      team_name: 'Звёздный десант',
      players_count: 6,
      captain_name: 'Джонни Рико',
      captain_phone: '+77011863190',
      game_title: 'Киномарафон: 100 вопросов',
      game_date: '17 ноября'
    };
    const card = formatConfirmationCard(sampleBooking);
    assertConfirmationCard(card, {
      team: 'Звёздный десант',
      players: 6,
      captain: 'Джонни Рико',
      phone: '+77011863190',
      game: 'Киномарафон: 100 вопросов'
    });
  });

  // 2. Navigation in IDLE State
  test('2. IDLE state menu routing and command keywords', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';

      // 2.1 Greeting / unrecognized text returns Main Menu
      const resHello = await handleIncomingMessage({ jid, text: 'Привет!', db: env });
      assert.equal(resHello.state, FSM_STATES.IDLE);
      assert.equal(resHello.replies.length, 1);
      assert.ok(resHello.replies[0].includes('ACTION Киноквиз Караганда'));

      // 2.2 Option '2' or 'афиша' returns Schedule card
      const resSchedule = await handleIncomingMessage({ jid, text: '2', db: env });
      assert.equal(resSchedule.state, FSM_STATES.IDLE);
      assert.ok(resSchedule.replies[0].includes('Афиша игр'));

      const resAfisha = await handleIncomingMessage({ jid, text: 'афиша', db: env });
      assert.equal(resAfisha.state, FSM_STATES.IDLE);
      assert.ok(resAfisha.replies[0].includes('Афиша игр'));

      // 2.3 Option '3' or 'адрес' returns Venue & 2GIS card
      const resVenue = await handleIncomingMessage({ jid, text: '3', db: env });
      assert.equal(resVenue.state, FSM_STATES.IDLE);
      assert.ok(resVenue.replies[0].includes('То Место'));
      assert.ok(resVenue.replies[0].includes('2gis.kz'));

      const resAddress = await handleIncomingMessage({ jid, text: 'адрес', db: env });
      assert.equal(resAddress.state, FSM_STATES.IDLE);
      assert.ok(resAddress.replies[0].includes('То Место'));

      // 2.4 Option '4' or 'правила' returns Rules card
      const resRules = await handleIncomingMessage({ jid, text: '4', db: env });
      assert.equal(resRules.state, FSM_STATES.IDLE);
      assert.ok(resRules.replies[0].includes('Правила и формат'));

      const resRulesWord = await handleIncomingMessage({ jid, text: 'правила', db: env });
      assert.equal(resRulesWord.state, FSM_STATES.IDLE);
      assert.ok(resRulesWord.replies[0].includes('Правила и формат'));

      // 2.5 Option '5' or 'контакты' returns Contacts card
      const resContacts = await handleIncomingMessage({ jid, text: '5', db: env });
      assert.equal(resContacts.state, FSM_STATES.IDLE);
      assert.ok(resContacts.replies[0].includes('+7 701 186 31 90'));

      const resContactsWord = await handleIncomingMessage({ jid, text: 'контакты', db: env });
      assert.equal(resContactsWord.state, FSM_STATES.IDLE);
      assert.ok(resContactsWord.replies[0].includes('+7 701 186 31 90'));
    } finally {
      await env.cleanup();
    }
  });

  // 3. Step-by-Step 5-State Booking Happy Path
  test('3. Step-by-step 5-state booking happy path', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';

      // Step 1: Start booking via '1'
      const step1 = await handleIncomingMessage({ jid, text: '1', db: env });
      assert.equal(step1.state, FSM_STATES.AWAITING_TEAM_NAME);
      assert.ok(step1.replies[0].includes('Как называется ваша команда?'));

      const sessionStep1 = env.sessions.get(jid);
      assert.ok(sessionStep1);
      assert.equal(sessionStep1.state, FSM_STATES.AWAITING_TEAM_NAME);

      // Step 2: Provide team name
      const step2 = await handleIncomingMessage({ jid, text: 'Киноманы Караганды', db: env });
      assert.equal(step2.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(step2.replies[0].includes('Киноманы Караганды'));
      assert.ok(step2.replies[0].includes('количество человек'));

      const sessionStep2 = env.sessions.get(jid);
      assert.equal(sessionStep2.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.equal(sessionStep2.data.teamName, 'Киноманы Караганды');

      // Step 3: Provide players count
      const step3 = await handleIncomingMessage({ jid, text: '6', db: env });
      assert.equal(step3.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.ok(step3.replies[0].includes('Выберите игру из списка'));

      const sessionStep3 = env.sessions.get(jid);
      assert.equal(sessionStep3.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.equal(sessionStep3.data.playersCount, 6);
      assert.ok(Array.isArray(sessionStep3.data.availableGames) && sessionStep3.data.availableGames.length > 0);

      // Step 4: Select game by index (1)
      const step4 = await handleIncomingMessage({ jid, text: '1', db: env });
      assert.equal(step4.state, FSM_STATES.AWAITING_CAPTAIN_NAME);
      assert.ok(step4.replies[0].includes('имя капитана'));

      const sessionStep4 = env.sessions.get(jid);
      assert.equal(sessionStep4.state, FSM_STATES.AWAITING_CAPTAIN_NAME);
      assert.ok(sessionStep4.data.selectedGame);

      // Step 5: Provide captain name
      const step5 = await handleIncomingMessage({ jid, text: 'Алексей', db: env });
      assert.equal(step5.state, FSM_STATES.IDLE);
      assert.ok(step5.bookingCreated, 'Booking record must be returned upon completion');
      assert.equal(step5.bookingCreated.team_name, 'Киноманы Караганды');
      assert.equal(step5.bookingCreated.players_count, 6);
      assert.equal(step5.bookingCreated.captain_name, 'Алексей');
      assert.equal(step5.bookingCreated.captain_phone, '+77011863190');

      // Verify confirmation card compliance
      assert.equal(step5.replies.length, 1);
      assertConfirmationCard(step5.replies[0], {
        team: 'Киноманы Караганды',
        players: 6,
        captain: 'Алексей',
        phone: '+77011863190'
      });

      // Verify session was cleared from DB
      const sessionFinal = env.sessions.get(jid);
      assert.equal(sessionFinal, null);

      // Verify booking stored in DB
      const bookingsInDb = env.bookings.list();
      assert.equal(bookingsInDb.length, 1);
      assert.equal(bookingsInDb[0].team_name, 'Киноманы Караганды');
    } finally {
      await env.cleanup();
    }
  });

  // 4. Boundary Validations
  test('4. Boundary validations (team name, player count, game index, captain name)', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';

      // 4.1 Team name boundary (< 2 characters)
      await handleIncomingMessage({ jid, text: '1', db: env });
      const badTeam = await handleIncomingMessage({ jid, text: 'A', db: env });
      assert.equal(badTeam.state, FSM_STATES.AWAITING_TEAM_NAME);
      assert.ok(badTeam.replies[0].includes('минимум 2 символа'));

      const emptyTeam = await handleIncomingMessage({ jid, text: '   ', db: env });
      assert.equal(emptyTeam.state, FSM_STATES.AWAITING_TEAM_NAME);

      // Valid team name
      const goodTeam = await handleIncomingMessage({ jid, text: 'ДНК', db: env });
      assert.equal(goodTeam.state, FSM_STATES.AWAITING_PLAYERS_COUNT);

      // 4.2 Players count boundary (< 2 or > 10 or non-numeric)
      const badPlayersNaN = await handleIncomingMessage({ jid, text: 'много нас', db: env });
      assert.equal(badPlayersNaN.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(badPlayersNaN.replies[0].includes('2 до 10'));

      const badPlayersLow = await handleIncomingMessage({ jid, text: '1', db: env });
      assert.equal(badPlayersLow.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(badPlayersLow.replies[0].includes('2 до 10'));

      const badPlayersZero = await handleIncomingMessage({ jid, text: '0', db: env });
      // '0' is a cancel command, so it cancels:
      assert.equal(badPlayersZero.state, FSM_STATES.IDLE);
      assert.ok(badPlayersZero.replies[0].includes('отменено'));

      // Re-enter to test > 10
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'ДНК', db: env });
      const badPlayersHigh = await handleIncomingMessage({ jid, text: '11', db: env });
      assert.equal(badPlayersHigh.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(badPlayersHigh.replies[0].includes('2 до 10'));

      // Valid players count: lower bound 2
      const goodPlayers2 = await handleIncomingMessage({ jid, text: '2', db: env });
      assert.equal(goodPlayers2.state, FSM_STATES.AWAITING_GAME_SELECTION);

      // 4.3 Game index boundary
      const badGameOut = await handleIncomingMessage({ jid, text: '99', db: env });
      assert.equal(badGameOut.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.ok(badGameOut.replies[0].includes('выберите номер игры'));

      const badGameWord = await handleIncomingMessage({ jid, text: 'первая', db: env });
      assert.equal(badGameWord.state, FSM_STATES.AWAITING_GAME_SELECTION);

      // Valid game index (1)
      const goodGame = await handleIncomingMessage({ jid, text: '1', db: env });
      assert.equal(goodGame.state, FSM_STATES.AWAITING_CAPTAIN_NAME);

      // 4.4 Captain name boundary (< 2 characters)
      const badCaptain = await handleIncomingMessage({ jid, text: 'Я', db: env });
      assert.equal(badCaptain.state, FSM_STATES.AWAITING_CAPTAIN_NAME);
      assert.ok(badCaptain.replies[0].includes('минимум 2 символа'));

      // Valid captain name (>= 2 characters)
      const goodCaptain = await handleIncomingMessage({ jid, text: 'Капитан Джек', db: env });
      assert.equal(goodCaptain.state, FSM_STATES.IDLE);
      assert.ok(goodCaptain.bookingCreated);
      assert.equal(goodCaptain.bookingCreated.captain_name, 'Капитан Джек');
    } finally {
      await env.cleanup();
    }
  });

  // 5. Global Cancellation & Opt-Out
  test('5. Global cancellation at every step and opt-out on "стоп"', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';

      // 5.1 Cancel at AWAITING_TEAM_NAME via '0'
      await handleIncomingMessage({ jid, text: '1', db: env });
      const cancel1 = await handleIncomingMessage({ jid, text: '0', db: env });
      assert.equal(cancel1.state, FSM_STATES.IDLE);
      assert.ok(cancel1.replies[0].includes('Бронирование отменено'));
      assert.equal(env.sessions.get(jid), null);

      // 5.2 Cancel at AWAITING_PLAYERS_COUNT via 'отмена'
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'Тестовая команда', db: env });
      const cancel2 = await handleIncomingMessage({ jid, text: 'отмена', db: env });
      assert.equal(cancel2.state, FSM_STATES.IDLE);
      assert.ok(cancel2.replies[0].includes('Бронирование отменено'));

      // 5.3 Cancel at AWAITING_GAME_SELECTION via 'назад'
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'Тестовая команда', db: env });
      await handleIncomingMessage({ jid, text: '4', db: env });
      const cancel3 = await handleIncomingMessage({ jid, text: 'назад', db: env });
      assert.equal(cancel3.state, FSM_STATES.IDLE);
      assert.ok(cancel3.replies[0].includes('Бронирование отменено'));

      // 5.4 Cancel at AWAITING_CAPTAIN_NAME via 'меню'
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'Тестовая команда', db: env });
      await handleIncomingMessage({ jid, text: '4', db: env });
      await handleIncomingMessage({ jid, text: '1', db: env });
      const cancel4 = await handleIncomingMessage({ jid, text: 'меню', db: env });
      assert.equal(cancel4.state, FSM_STATES.IDLE);
      assert.ok(cancel4.replies[0].includes('Бронирование отменено'));

      // 5.5 Broadcast opt-out on 'стоп' when in IDLE
      // Pre-seed subscribed contact
      env.contacts.upsert({ phone: '+77011863190', name: 'Иван' });
      assert.equal(env.contacts.getByPhone('+77011863190').is_subscribed, 1);

      const stopRes = await handleIncomingMessage({ jid, text: 'стоп', db: env });
      assert.equal(stopRes.state, FSM_STATES.IDLE);
      assert.ok(stopRes.replies[0].includes('отписались от авторассылок'));
      assert.equal(env.contacts.getByPhone('+77011863190').is_subscribed, 0);
    } finally {
      await env.cleanup();
    }
  });

  // 6. Inactivity Timeout (20 Minutes)
  test('6. Inactivity timeout (20 minutes) resets session', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';
      const baseTime = new Date('2026-11-14T20:00:00Z');

      // Start booking
      await handleIncomingMessage({ jid, text: '1', db: env });
      await handleIncomingMessage({ jid, text: 'Молния', db: env });

      const session = env.sessions.get(jid);
      assert.equal(session.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      const lastActive = new Date(session.updated_at.replace(' ', 'T'));

      // Message within 10 minutes (valid)
      const time10m = new Date(lastActive.getTime() + 10 * 60 * 1000);
      assert.equal(isSessionTimedOut(session, time10m), false);

      // Message at lastActive + 25 minutes (expired)
      const time25m = new Date(lastActive.getTime() + 25 * 60 * 1000);
      assert.equal(isSessionTimedOut(session, time25m), true);

      // Incoming message at 25m triggers timeout reset and processes new message
      const resExpired = await handleIncomingMessage({ jid, text: 'Привет', db: env, now: time25m });
      assert.equal(resExpired.state, FSM_STATES.IDLE);
      assert.ok(resExpired.replies.some(r => r.includes('Время сессии истекло')));
      assert.ok(resExpired.replies.some(r => r.includes('ACTION Киноквиз Караганда')));
    } finally {
      await env.cleanup();
    }
  });

  // 7. Multi-Session Concurrency & State Isolation
  test('7. Multi-session concurrency without crosstalk', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jidA = '77011111111@s.whatsapp.net';
      const jidB = '77022222222@s.whatsapp.net';

      // User A starts booking
      await handleIncomingMessage({ jid: jidA, text: '1', db: env });
      await handleIncomingMessage({ jid: jidA, text: 'Команда А', db: env });

      // User B browses schedule
      const resB1 = await handleIncomingMessage({ jid: jidB, text: '2', db: env });
      assert.equal(resB1.state, FSM_STATES.IDLE);

      // User B starts booking
      await handleIncomingMessage({ jid: jidB, text: '1', db: env });
      await handleIncomingMessage({ jid: jidB, text: 'Команда Б', db: env });
      await handleIncomingMessage({ jid: jidB, text: '8', db: env });

      // Verify sessions are completely separated in DB
      const sessionA = env.sessions.get(jidA);
      const sessionB = env.sessions.get(jidB);

      assert.equal(sessionA.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.equal(sessionA.data.teamName, 'Команда А');

      assert.equal(sessionB.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.equal(sessionB.data.teamName, 'Команда Б');
      assert.equal(sessionB.data.playersCount, 8);

      // User A completes booking
      await handleIncomingMessage({ jid: jidA, text: '4', db: env });
      await handleIncomingMessage({ jid: jidA, text: '1', db: env });
      const finishA = await handleIncomingMessage({ jid: jidA, text: 'Капитан А', db: env });
      assert.equal(finishA.state, FSM_STATES.IDLE);
      assert.equal(finishA.bookingCreated.team_name, 'Команда А');
      assert.equal(finishA.bookingCreated.captain_phone, '+77011111111');

      // User B session is still active at AWAITING_GAME_SELECTION
      const sessionBStillActive = env.sessions.get(jidB);
      assert.equal(sessionBStillActive.state, FSM_STATES.AWAITING_GAME_SELECTION);
      assert.equal(sessionBStillActive.data.teamName, 'Команда Б');
    } finally {
      await env.cleanup();
    }
  });

  // 8. Empty Game Catalog Guard
  test('8. Empty game catalog guard resets to IDLE with organizer contact', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      const jid = '77011863190@s.whatsapp.net';
      const emptyCatalog = { getActiveGames: async () => [] };

      // 8.1 Start booking with empty catalog from IDLE
      const startRes = await handleIncomingMessage({
        jid,
        text: '1',
        db: env,
        gameCatalog: emptyCatalog
      });

      assert.equal(startRes.state, FSM_STATES.IDLE);
      assert.equal(startRes.replies.length, 1);
      assert.ok(startRes.replies[0].includes('открытых для бронирования игр нет'));
      assert.ok(startRes.replies[0].includes('+7 701 186 31 90'));
      assert.equal(env.sessions.get(jid), null, 'Session must not be created');

      // 8.2 Advance from AWAITING_PLAYERS_COUNT when catalog returns empty
      // Pre-seed active session with 0 available games
      env.sessions.set(jid, FSM_STATES.AWAITING_PLAYERS_COUNT, {
        teamName: 'Быстрые',
        availableGames: []
      });

      const advanceRes = await handleIncomingMessage({
        jid,
        text: '5',
        db: env,
        gameCatalog: emptyCatalog
      });

      assert.equal(advanceRes.state, FSM_STATES.IDLE);
      assert.ok(advanceRes.replies[0].includes('открытых для бронирования игр нет'));
      assert.ok(advanceRes.replies[0].includes('+7 701 186 31 90'));
      assert.equal(env.sessions.get(jid), null, 'Session must be cleared');
    } finally {
      await env.cleanup();
    }
  });

  // 9. Defensive Hardening: Missing DB, Null JID, Typographic Quotes in FSM
  test('9. Defensive hardening: Missing DB, Null JID, and Typographic quotes in FSM', async () => {
    const env = await createTestEnv({ inMemory: true });
    try {
      // 9.1 Calling handleIncomingMessage with whitespace and no DB should return IDLE without error
      const noDbWhitespace = await handleIncomingMessage({ text: '   ' });
      assert.equal(noDbWhitespace.state, FSM_STATES.IDLE);
      assert.deepEqual(noDbWhitespace.replies, []);

      const noDbNull = await handleIncomingMessage({ text: null });
      assert.equal(noDbNull.state, FSM_STATES.IDLE);

      const noDbUndef = await handleIncomingMessage({ text: undefined });
      assert.equal(noDbUndef.state, FSM_STATES.IDLE);

      // 9.2 Null JID splitting should not throw
      const nullJidRes = await handleIncomingMessage({
        jid: null,
        text: '2',
        db: env
      });
      assert.equal(nullJidRes.state, FSM_STATES.IDLE);

      // 9.3 Typographic quotes in team name and captain name in FSM
      const jid = '77099998877@s.whatsapp.net';
      await handleIncomingMessage({ jid, text: '1', db: env });

      // Enter team name with German quotes „ДНК“
      const resTeam = await handleIncomingMessage({ jid, text: '„ДНК“', db: env });
      assert.equal(resTeam.state, FSM_STATES.AWAITING_PLAYERS_COUNT);
      assert.ok(resTeam.replies[0].includes('«ДНК»'));

      const session = env.sessions.get(jid);
      assert.equal(session.data.teamName, 'ДНК', 'Quotes must be stripped in session data');

      // Enter players
      await handleIncomingMessage({ jid, text: '4', db: env });
      // Select game
      await handleIncomingMessage({ jid, text: '1', db: env });

      // Enter captain name with curly quotes “Капитан Немо”
      const resCaptain = await handleIncomingMessage({ jid, text: '“Капитан Немо”', db: env });
      assert.equal(resCaptain.state, FSM_STATES.IDLE);
      assert.ok(resCaptain.bookingCreated);
      assert.equal(resCaptain.bookingCreated.captain_name, 'Капитан Немо');
      assert.equal(resCaptain.bookingCreated.team_name, 'ДНК');
    } finally {
      await env.cleanup();
    }
  });
});
