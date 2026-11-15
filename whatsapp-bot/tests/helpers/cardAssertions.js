/**
 * tests/helpers/cardAssertions.js
 * Verification and Field Extraction Helper for WhatsApp Confirmation Cards
 */
import assert from 'node:assert/strict';

/**
 * Strips WhatsApp formatting symbols (*, _, ~), quotes («, », ", '), and whitespace.
 * @param {string} val
 * @returns {string}
 */
export function cleanCardValue(val) {
  if (!val) return '';
  return String(val)
    .replace(/^[\s*_~«"']+|[\s*_~»"']+$/g, '')
    .trim();
}

/**
 * Extracts structured properties from a WhatsApp booking confirmation or details card.
 * @param {string} text - Message text
 * @returns {Object} Extracted fields
 */
export function extractCardFields(text) {
  if (!text || typeof text !== 'string') {
    return {};
  }

  const fields = {};

  // 1. Team: 👥 *Команда:* «...»
  const teamMatch = text.match(/(?:^|\n)\s*(?:👥\s*)?\*?Команда[*:]*\s*([^\n]+)/i);
  if (teamMatch) {
    fields.team = cleanCardValue(teamMatch[1]);
  }

  // 2. Players count: ♟️ *Количество игроков:* N чел.
  const playersMatch = text.match(
    /(?:^|\n)\s*(?:♟️\s*)?\*?(?:Количество игроков|Число игроков|Игроков)[*:]*\s*(\d+)/i
  );
  if (playersMatch) {
    fields.players = parseInt(playersMatch[1], 10);
  }

  // 3. Captain: 👤 *Капитан:* Имя (или 👤 *Капитан:* Имя +7...)
  const captainMatch = text.match(/(?:^|\n)\s*(?:👤\s*)?\*?Капитан[*:]*\s*([^\n]+)/i);
  if (captainMatch) {
    fields.captain = cleanCardValue(captainMatch[1]);
  }

  // 4. Phone: 📱 *Телефон капитана:* +7...
  const phoneMatch = text.match(
    /(?:^|\n)\s*(?:📱\s*)?\*?(?:Телефон капитана|Телефон|Номер)[*:]*\s*([^\n]+)/i
  );
  if (phoneMatch) {
    fields.phone = cleanCardValue(phoneMatch[1]);
  }

  // 5. Game: 📅 *Выбранная игра:* Название... or 📅 *Игра:* Название...
  const gameMatch = text.match(/(?:^|\n)\s*(?:📅\s*)?\*?(?:Выбранная игра|Игра)[*:]*\s*([^\n]+)/i);
  if (gameMatch) {
    fields.game = cleanCardValue(gameMatch[1]);
  }

  // 6. Venue: 📍 *Место:* Караоке-бар «То Место» ...
  // Line-anchored to prevent greedy keyword matching on "То Место"
  const venueMatch = text.match(/(?:^|\n)\s*(?:📍\s*)?\*?Место[*:]*\s*([^\n]+)/i);
  if (venueMatch) {
    fields.venue = cleanCardValue(venueMatch[1]);
  }

  // 7. Fee: 💰 *Взнос:* 3 000 ₸ с игрока
  const feeMatch = text.match(/(?:^|\n)\s*(?:💰\s*)?\*?Взнос[*:]*\s*([^\n]+)/i);
  if (feeMatch) {
    fields.fee = cleanCardValue(feeMatch[1]);
  }

  return fields;
}

/**
 * Asserts structural and formatting compliance of a WhatsApp confirmation card.
 * @param {string} text - Message text sent by the bot
 * @param {Object} [expected={}] - Expected values to assert
 * @returns {Object} Extracted card fields
 */
export function assertConfirmationCard(text, expected = {}) {
  assert.ok(typeof text === 'string' && text.length > 0, 'Card text must be a non-empty string');

  // 1. WhatsApp Formatting Invariants
  assert.ok(
    !text.includes('**'),
    'WhatsApp markdown violation: double asterisks (**) found. WhatsApp requires single asterisks (*text*) for bold.'
  );
  assert.ok(
    !/(?:^|\n)#{1,6}\s/.test(text),
    'WhatsApp markdown violation: Markdown heading syntax (#) found. Not supported in WhatsApp messages.'
  );

  // 2. Extract fields
  const fields = extractCardFields(text);

  // 3. Verify Expected Values
  if (expected.team !== undefined) {
    assert.ok(fields.team, `Card must contain team name, expected "${expected.team}"`);
    assert.equal(
      fields.team.toLowerCase(),
      expected.team.toLowerCase(),
      `Team mismatch: "${fields.team}" !== "${expected.team}"`
    );
  }

  if (expected.players !== undefined) {
    assert.ok(fields.players !== undefined, `Card must contain players count, expected ${expected.players}`);
    assert.equal(
      fields.players,
      expected.players,
      `Players count mismatch: ${fields.players} !== ${expected.players}`
    );
  }

  if (expected.captain !== undefined) {
    assert.ok(fields.captain, `Card must contain captain info, expected to include "${expected.captain}"`);
    assert.ok(
      fields.captain.toLowerCase().includes(expected.captain.toLowerCase()),
      `Captain mismatch: "${fields.captain}" should contain "${expected.captain}"`
    );
  }

  if (expected.game !== undefined) {
    assert.ok(fields.game, `Card must contain game title, expected to include "${expected.game}"`);
    assert.ok(
      fields.game.toLowerCase().includes(expected.game.toLowerCase()),
      `Game mismatch: "${fields.game}" should contain "${expected.game}"`
    );
  }

  if (expected.venue !== undefined) {
    assert.ok(fields.venue, `Card must contain venue, expected to include "${expected.venue}"`);
    assert.ok(
      fields.venue.toLowerCase().includes(expected.venue.toLowerCase()),
      `Venue mismatch: "${fields.venue}" should contain "${expected.venue}"`
    );
  }

  if (expected.fee !== undefined) {
    assert.ok(fields.fee, `Card must contain fee, expected to include "${expected.fee}"`);
    assert.ok(
      fields.fee.includes(expected.fee),
      `Fee mismatch: "${fields.fee}" should contain "${expected.fee}"`
    );
  }

  if (expected.phone !== undefined) {
    assert.ok(fields.phone, `Card must contain phone, expected to include "${expected.phone}"`);
    assert.ok(
      fields.phone.includes(expected.phone),
      `Phone mismatch: "${fields.phone}" should contain "${expected.phone}"`
    );
  }

  // 4. Default Venue & Price Markers Presence Check
  if (expected.checkDefaultVenue !== false) {
    assert.ok(
      text.includes('То Место') || (fields.venue && fields.venue.includes('То Место')),
      'Confirmation card should reference venue "То Место"'
    );
  }

  if (expected.checkDefaultFee !== false) {
    assert.ok(
      text.includes('3 000') || text.includes('3000'),
      'Confirmation card should reference entry fee "3 000 ₸"'
    );
  }

  return fields;
}

export default {
  assertConfirmationCard,
  extractCardFields,
  cleanCardValue
};
