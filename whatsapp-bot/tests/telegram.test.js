/**
 * tests/telegram.test.js
 * Comprehensive Unit Test Suite for Telegram Alerts Module (Milestone M3)
 *
 * Verifies:
 * 1. HTML sanitization & escaping (escapeHtml)
 * 2. WhatsApp phone cleaning (cleanPhoneForWa)
 * 3. ASCII currency formatting (formatCurrency)
 * 4. Karaganda timezone formatting (formatKaragandaTime)
 * 5. Structured alert card HTML format (formatBookingAlert)
 * 6. Successful alert dispatch via mock fetch (sendBookingAlert)
 * 7. Graceful degradation when Telegram credentials are not configured
 * 8. Rate limit (HTTP 429) retry logic with retry_after backoff
 * 9. Transient server error (HTTP 5xx) retry logic with exponential backoff
 * 10. Immediate failure on non-transient 4xx client errors (no retry loop)
 * 11. Network timeout and abort signal handling
 * 12. Full error isolation (no unhandled rejections)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  cleanPhoneForWa,
  formatCurrency,
  formatKaragandaTime,
  formatBookingAlert,
  sendBookingAlert,
  sendBroadcastLaunchAlert
} from '../src/telegram/notifier.js';

test('Telegram Alerts Test Suite (Milestone M3)', async (t) => {
  // 1. HTML Escaping
  await t.test('1. escapeHtml sanitizes special characters and preserves valid text', () => {
    assert.equal(escapeHtml('Normal text 123'), 'Normal text 123');
    assert.equal(escapeHtml('«Киноманы & Друзья» <VIP> "Pro"'), '«Киноманы &amp; Друзья» &lt;VIP&gt; &quot;Pro&quot;');
    assert.equal(escapeHtml('&<>\"'), '&amp;&lt;&gt;&quot;');
    // Order test: Ensure & is replaced first (no double-escaping)
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    // Primitives handling
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(12345), '12345');
    assert.equal(escapeHtml(false), 'false');
  });

  // 2. WhatsApp Phone Cleaning
  await t.test('2. cleanPhoneForWa normalizes phone numbers for wa.me links', () => {
    assert.equal(cleanPhoneForWa('+7 (701) 186-31-90'), '77011863190');
    assert.equal(cleanPhoneForWa('+77011863190'), '77011863190');
    // Local KZ trunk 8 converted to 7
    assert.equal(cleanPhoneForWa('87011863190'), '77011863190');
    assert.equal(cleanPhoneForWa('8 (7212) 50-60-70'), '77212506070');
    // Empty & invalid values
    assert.equal(cleanPhoneForWa(''), '');
    assert.equal(cleanPhoneForWa(null), '');
    assert.equal(cleanPhoneForWa(undefined), '');
  });

  // 3. Currency Formatting
  await t.test('3. formatCurrency produces standard ASCII space thousand separators', () => {
    assert.equal(formatCurrency(18000), '18 000');
    assert.equal(formatCurrency('18000'), '18 000');
    assert.equal(formatCurrency(3000), '3 000');
    assert.equal(formatCurrency(1234567), '1 234 567');
    assert.equal(formatCurrency(0), '0');
    assert.equal(formatCurrency('0'), '0');
    assert.equal(formatCurrency('abc'), '0');
    assert.equal(formatCurrency(null), '0');
    // Verify standard ASCII space (code 32, not non-breaking space 160)
    const formatted = formatCurrency(18000);
    assert.equal(formatted.charCodeAt(2), 32);
  });

  // 4. Timezone Formatting
  await t.test('4. formatKaragandaTime converts timestamps to DD.MM.YYYY, HH:mm:ss in UTC+5', () => {
    // 2026-11-14T20:00:00Z is 2026-11-15T01:00:00+05:00
    const fixedIso = '2026-11-14T20:00:00.000Z';
    const formatted = formatKaragandaTime(fixedIso, 'Asia/Almaty');
    assert.match(formatted, /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
    assert.equal(formatted, '15.11.2026, 01:00:00');

    // SQLite local datetime fallback
    const sqliteDate = '2026-11-15 01:00:00';
    const formattedSqlite = formatKaragandaTime(sqliteDate, 'Asia/Almaty');
    assert.match(formattedSqlite, /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
  });

  // 5. Message Card Formatting
  await t.test('5. formatBookingAlert generates valid HTML alert card with all required fields', () => {
    const booking = {
      id: 42,
      team_name: '«Киноманы & Друзья» <VIP>',
      captain_name: 'Алексей <Снайпер & Капитан>',
      captain_phone: '+7 (701) 186-31-90',
      players_count: 6,
      game_title: '100% "Marvel" & <DC>',
      game_date: '2026-11-17 (ВТ, 19:30)',
      source: 'whatsapp_bot',
      created_at: '2026-11-14T21:00:00.000Z'
    };

    const card = formatBookingAlert(booking, { pricePerPlayer: 3000 });

    // Assertions for required sections and styling
    assert.match(card, /🎟️ <b>НОВАЯ БРОНЬ СТОЛА — ACTION КИНОКВИЗ<\/b>/);
    assert.match(card, /🎬 <b>Игра:<\/b> 100% &quot;Marvel&quot; &amp; &lt;DC&gt;/);
    assert.match(card, /📅 <b>Дата:<\/b> 2026-11-17 \(ВТ, 19:30\)/);
    assert.match(card, /👥 <b>Команда:<\/b> ««Киноманы &amp; Друзья» &lt;VIP&gt;»/);
    assert.match(card, /🔢 <b>Игроков:<\/b> 6 чел\. \(взнос: 18 000 ₸\)/);
    assert.match(card, /👤 <b>Капитан:<\/b> Алексей &lt;Снайпер &amp; Капитан&gt;/);
    assert.match(card, /📱 <b>WhatsApp:<\/b> <a href="https:\/\/wa\.me\/77011863190">\+7 \(701\) 186-31-90<\/a>/);
    assert.match(card, /🆔 <b>ID брони:<\/b> #42/);
    assert.match(card, /ℹ️ <b>Источник:<\/b> whatsapp_bot/);
    assert.match(card, /⏰ <b>Создана:<\/b> \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2} \(UTC\+5\)/);

    // Verify camelCase input support
    const camelBooking = {
      id: 99,
      teamName: 'Dream Team',
      captainName: 'Ольга',
      captainPhone: '87011112233',
      playersCount: 4,
      gameTitle: 'Гарри Поттер',
      gameDate: '24 ноября'
    };
    const camelCard = formatBookingAlert(camelBooking);
    assert.match(camelCard, /👥 <b>Команда:<\/b> «Dream Team»/);
    assert.match(camelCard, /🔢 <b>Игроков:<\/b> 4 чел\. \(взнос: 12 000 ₸\)/);
    assert.match(camelCard, /<a href="https:\/\/wa\.me\/77011112233">87011112233<\/a>/);

    // Verify empty phone handling (no broken <a> tag)
    const noPhoneBooking = {
      teamName: 'Ghost',
      playersCount: 2
    };
    const noPhoneCard = formatBookingAlert(noPhoneBooking);
    assert.match(noPhoneCard, /📱 <b>WhatsApp:<\/b> Не указан/);
    assert.ok(!noPhoneCard.includes('<a href="https://wa.me/'));

    // Verify options = null does not throw
    const nullOptionsCard = formatBookingAlert(booking, null);
    assert.match(nullOptionsCard, /🎟️ <b>НОВАЯ БРОНЬ СТОЛА — ACTION КИНОКВИЗ<\/b>/);

    // Verify bookingId HTML escaping
    const injectionBooking = {
      id: '<script>alert(1)</script>',
      team_name: 'Hackers'
    };
    const injectionCard = formatBookingAlert(injectionBooking);
    assert.match(injectionCard, /🆔 <b>ID брони:<\/b> #&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  // 6. Successful Delivery via Mock Fetch
  await t.test('6. sendBookingAlert successfully delivers notification card via Telegram API', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          ok: true,
          result: {
            message_id: 1042,
            chat: { id: -1001234567890 },
            text: 'Delivered'
          }
        })
      };
    };

    const booking = {
      id: 15,
      team_name: 'Победители',
      captain_name: 'Иван',
      captain_phone: '+7 701 555 44 33',
      players_count: 5,
      game_title: 'Marvel vs DC',
      game_date: '17 ноября'
    };

    const config = {
      botToken: 'TEST_BOT_TOKEN_123',
      chatId: '-1001234567890'
    };

    const result = await sendBookingAlert(booking, config, { fetch: mockFetch });

    assert.equal(result.success, true);
    assert.equal(result.messageId, 1042);
    assert.equal(capturedUrl, 'https://api.telegram.org/botTEST_BOT_TOKEN_123/sendMessage');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.chat_id, '-1001234567890');
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.disable_web_page_preview, true);
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.match(body.text, /Победители/);
    assert.match(body.text, /15 000 ₸/);
  });

  // 7. Missing Config Isolation
  await t.test('7. sendBookingAlert returns graceful skipped response when botToken or chatId is missing', async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return { ok: true };
    };

    const booking = { team_name: 'Test Team', players_count: 4 };

    // Missing botToken
    const res1 = await sendBookingAlert(booking, { botToken: '', chatId: '123' }, { fetch: mockFetch });
    assert.equal(res1.success, false);
    assert.equal(res1.skipped, true);
    assert.match(res1.error, /not configured/);

    // Missing chatId
    const res2 = await sendBookingAlert(booking, { botToken: 'TOKEN', chatId: '' }, { fetch: mockFetch });
    assert.equal(res2.success, false);
    assert.equal(res2.skipped, true);

    // Completely empty config
    const res3 = await sendBookingAlert(booking, {}, { fetch: mockFetch });
    assert.equal(res3.success, false);
    assert.equal(res3.skipped, true);

    assert.equal(fetchCalled, false, 'fetch should never be invoked when credentials are missing');
  });

  // 8. HTTP 429 Rate Limit Handling
  await t.test('8. sendBookingAlert retries and succeeds after HTTP 429 rate limit backoff', async () => {
    let callCount = 0;
    const sleptDelays = [];

    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '2' }),
          json: async () => ({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 2',
            parameters: { retry_after: 2 }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          ok: true,
          result: { message_id: 2001 }
        })
      };
    };

    const sleepFn = async (ms) => {
      sleptDelays.push(ms);
    };

    const booking = { teamName: 'RateLimitedTeam', playersCount: 4 };
    const config = { botToken: 'TOKEN', chatId: '123' };

    const result = await sendBookingAlert(booking, config, {
      fetch: mockFetch,
      sleepFn,
      maxRetries: 3
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, 2001);
    assert.equal(callCount, 2);
    assert.deepEqual(sleptDelays, [2000]);
  });

  // 9. HTTP 5xx Server Error Exponential Backoff
  await t.test('9. sendBookingAlert retries transient 5xx server errors with exponential backoff', async () => {
    let callCount = 0;
    const sleptDelays = [];

    const mockFetch = async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: new Headers(),
          json: async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' })
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({
          ok: true,
          result: { message_id: 3001 }
        })
      };
    };

    const sleepFn = async (ms) => {
      sleptDelays.push(ms);
    };

    const booking = { teamName: '5xxTeam', playersCount: 5 };
    const config = { botToken: 'TOKEN', chatId: '123' };

    const result = await sendBookingAlert(booking, config, {
      fetch: mockFetch,
      sleepFn,
      maxRetries: 3
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, 3001);
    assert.equal(callCount, 3);
    // Exponential backoff: attempt 0 -> 500ms, attempt 1 -> 1000ms
    assert.deepEqual(sleptDelays, [500, 1000]);
  });

  // 10. HTTP 4xx Client Error Immediate Abort
  await t.test('10. sendBookingAlert aborts immediately without retrying on 4xx client errors', async () => {
    let callCount = 0;
    const sleptDelays = [];

    const mockFetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found'
        })
      };
    };

    const sleepFn = async (ms) => {
      sleptDelays.push(ms);
    };

    const booking = { teamName: 'BadRequestTeam', playersCount: 4 };
    const config = { botToken: 'TOKEN', chatId: 'INVALID_CHAT' };

    const result = await sendBookingAlert(booking, config, {
      fetch: mockFetch,
      sleepFn,
      maxRetries: 3
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Telegram API error \(HTTP 400\): Bad Request: chat not found/);
    assert.equal(callCount, 1, 'Should fail immediately on 400 without retry loop');
    assert.equal(sleptDelays.length, 0);
  });

  // 11. Network Timeout / Abort Handling
  await t.test('11. sendBookingAlert gracefully catches network timeouts and returns error', async () => {
    const sleptDelays = [];
    const mockFetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    };

    const sleepFn = async (ms) => {
      sleptDelays.push(ms);
    };

    const booking = { teamName: 'TimeoutTeam', playersCount: 4 };
    const config = { botToken: 'TOKEN', chatId: '123' };

    const result = await sendBookingAlert(booking, config, {
      fetch: mockFetch,
      sleepFn,
      timeoutMs: 5000,
      maxRetries: 2
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Request timed out after 5000ms/);
    // Retried twice: 500ms, 1000ms
    assert.deepEqual(sleptDelays, [500, 1000]);
  });

  // 12. Broadcast Launch Alert
  await t.test('12. sendBroadcastLaunchAlert formats and sends urgent broadcast notification', async () => {
    let capturedBody = null;
    const mockFetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 888 } })
      };
    };

    const config = { botToken: 'TOKEN_XYZ', chatId: '-100999' };
    const res = await sendBroadcastLaunchAlert({
      type: 'reschedule',
      target: 'game',
      gameTitle: 'Киномарафон: 100 вопросов',
      recipientsCount: 8,
      template: 'Уважаемый капитан, игра переносится...',
      batchId: 'BATCH_RESCHEDULE_1'
    }, config, { fetch: mockFetch });

    assert.equal(res.success, true);
    assert.equal(res.messageId, 888);
    assert.ok(capturedBody);
    assert.match(capturedBody.text, /ЗАПУЩЕНА СРОЧНАЯ РАССЫЛКА WHATSAPP/);
    assert.match(capturedBody.text, /Перенос игры/);
    assert.match(capturedBody.text, /Киномарафон: 100 вопросов/);
    assert.match(capturedBody.text, /8/);
  });

  // 13. Inline Delete Button in Booking Alert
  await t.test('13. sendBookingAlert automatically attaches inline delete button when booking has ID', async () => {
    let capturedBody = null;
    const mockFetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1055 } })
      };
    };

    const booking = {
      id: 42,
      team_name: 'КиберПанки',
      captain_name: 'Виктор',
      captain_phone: '+7 701 999 88 77',
      players_count: 6,
      game_title: 'Киномарафон',
      game_date: '17 ноября'
    };

    const config = { botToken: 'TEST_TOKEN', chatId: '-10042' };
    const res = await sendBookingAlert(booking, config, { fetch: mockFetch });

    assert.equal(res.success, true);
    assert.ok(capturedBody);
    assert.ok(capturedBody.reply_markup);
    assert.ok(Array.isArray(capturedBody.reply_markup.inline_keyboard));
    assert.equal(capturedBody.reply_markup.inline_keyboard[0][0].text, '🗑️ Удалить эту бронь');
    assert.equal(capturedBody.reply_markup.inline_keyboard[0][0].callback_data, 'del_ask_42');
  });

  // 14. Custom or Null reply_markup
  await t.test('14. sendBookingAlert allows overriding or disabling reply_markup', async () => {
    let capturedBody = null;
    const mockFetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1056 } })
      };
    };

    const booking = { id: 99, team_name: 'NoButtons' };
    const config = { botToken: 'TEST_TOKEN', chatId: '-10042' };

    await sendBookingAlert(booking, config, { fetch: mockFetch, reply_markup: null });
    assert.equal(capturedBody.reply_markup, undefined);
  });

  // 15. Telegram Phone List Formatting & WhatsApp Links
  await t.test('15. Telegram phone list helpers format KZ phone numbers and direct wa.me chat links', () => {
    const rawPhones = ['+7 (701) 186-31-90', '87019998877', '+77021112233'];
    const cleaned = rawPhones.map(p => cleanPhoneForWa(p));
    assert.deepEqual(cleaned, ['77011863190', '77019998877', '77021112233']);

    cleaned.forEach(digits => {
      const waLink = `https://wa.me/${digits}`;
      assert.ok(waLink.startsWith('https://wa.me/770'));
    });
  });

  // 16. Telegram Recipients Resolution for Phone Viewing
  await t.test('16. resolveBroadcastRecipients correctly groups phone numbers for Telegram viewer', async () => {
    const { resolveBroadcastRecipients } = await import('../src/broadcast/manualBroadcast.js');
    const mockDb = {
      bookings: {
        list: () => [
          { captain_phone: '+7 701 111 22 33', captain_name: 'Алихан', team_name: 'Бригада', game_title: 'Киномарафон', status: 'confirmed' },
          { captain_phone: '+7 701 111 22 33', captain_name: 'Алихан 2', team_name: 'Бригада Резерв', game_title: 'Киномарафон', status: 'confirmed' }, // duplicate phone
          { captain_phone: '+7 702 444 55 66', captain_name: 'Гульнар', team_name: 'Анимешники', game_title: 'Культовые Аниме', status: 'confirmed' },
          { captain_phone: '+7 705 777 88 99', captain_name: 'Иван', team_name: 'Отмененные', game_title: 'Киномарафон', status: 'cancelled' }
        ]
      },
      contacts: {
        getByPhone: () => null,
        listForBroadcast: () => [
          { phone: '+7 701 111 22 33', name: 'Алихан', team_name: 'Бригада' },
          { phone: '+7 702 444 55 66', name: 'Гульнар', team_name: 'Анимешники' }
        ]
      }
    };

    const g1Recipients = resolveBroadcastRecipients({ db: mockDb, target: 'game', gameTitle: 'Киномарафон' });
    assert.equal(g1Recipients.length, 1);
    assert.equal(g1Recipients[0].phone, '+7 701 111 22 33');

    const allRecipients = resolveBroadcastRecipients({ db: mockDb, target: 'all' });
    assert.equal(allRecipients.length, 2);
  });

  await t.test('14. formatBookingAlert prominently highlights players without a team', () => {
    const noTeamBooking = {
      id: 77,
      team_name: 'Ищу команду',
      captain_name: 'Арман',
      captain_phone: '+7 701 555 44 33',
      players_count: 1,
      game_title: 'Киномарафон: 100 вопросов',
      game_date: '17 ноября',
      notes: '[ИЩЕТ КОМАНДУ] Лига: Падаваны',
      source: 'website'
    };
    const alertHtml = formatBookingAlert(noTeamBooking);
    assert.match(alertHtml, /⚠️ <b>НОВАЯ ЗАЯВКА: ИГРОК БЕЗ КОМАНДЫ!<\/b> 🙋‍♂️/);
    assert.match(alertHtml, /🚨 <b>ВНИМАНИЕ ОРГАНИЗАТОРАМ:<\/b>/);
    assert.match(alertHtml, /👉 <b>У игрока нет команды! Нужно подобрать команду \/ распределить игрока!<\/b>/);
    assert.match(alertHtml, /👤 <b>Капитан:<\/b> Арман/);
  });
});
