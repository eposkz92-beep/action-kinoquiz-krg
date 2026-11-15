import crypto from 'node:crypto';

/**
 * Creates signed JWT for Google Service Account authentication using native node:crypto.
 * @param {string} serviceAccountEmail
 * @param {string} privateKey
 * @returns {string} Signed JWT
 */
function createServiceAccountJwt(serviceAccountEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  const signature = signer.sign(privateKey, 'base64url');

  return `${unsignedToken}.${signature}`;
}

/**
 * Exports bookings to Google Sheets with graceful non-blocking degradation.
 * @param {Object} db - DatabaseSync instance or { db, bookings } DAO
 * @param {Object} [config={}] - Configuration options or mock client
 * @returns {Promise<{ syncedCount: number, error?: string }>}
 */
export async function exportBookingsToGoogleSheets(db, config = {}) {
  try {
    // 1. Extract records from DB
    let records = [];
    if (db && db.bookings && typeof db.bookings.list === 'function') {
      records = db.bookings.list({ limit: 10000 });
    } else if (db && typeof db.prepare === 'function') {
      records = db.prepare('SELECT * FROM bookings ORDER BY created_at ASC;').all();
    } else if (db && db.db && typeof db.db.prepare === 'function') {
      records = db.db.prepare('SELECT * FROM bookings ORDER BY created_at ASC;').all();
    }

    if (records.length === 0) {
      return { syncedCount: 0 };
    }

    // 2. Check for injected mock client (for offline unit and e2e testing)
    if (config.sheetsClient && typeof config.sheetsClient.appendRows === 'function') {
      const rows = records.map(r => [
        r.id,
        r.created_at,
        r.team_name,
        r.captain_name,
        r.captain_phone,
        r.players_count,
        r.game_title,
        r.game_date,
        r.source,
        r.notes || ''
      ]);
      await config.sheetsClient.appendRows(rows);
      return { syncedCount: rows.length };
    }

    // 3. Resolve configuration
    const sheetsCfg = config.googleSheets || config;
    const email = sheetsCfg.serviceAccountEmail;
    const key = (sheetsCfg.privateKey || '').replace(/\\n/g, '\n');
    const spreadsheetId = sheetsCfg.spreadsheetId;
    const sheetName = sheetsCfg.sheetName || 'Брони';
    const fetchFn = config.fetchStub || config.fetch || globalThis.fetch;

    // Graceful degradation when credentials are not configured
    if (!email || !key || !spreadsheetId) {
      return {
        syncedCount: 0,
        error: 'Google Sheets credentials not configured'
      };
    }

    // 4. Generate JWT & acquire access token
    const assertionJwt = createServiceAccountJwt(email, key);

    const tokenResponse = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertionJwt
      }).toString()
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return {
        syncedCount: 0,
        error: `OAuth2 token exchange failed (${tokenResponse.status}): ${errText}`
      };
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // 5. Append rows to Google Sheet
    const rows = records.map(r => [
      r.id,
      r.created_at,
      r.team_name,
      r.captain_name,
      r.captain_phone,
      r.players_count,
      r.game_title,
      r.game_date,
      r.source,
      r.notes || ''
    ]);

    const range = `${encodeURIComponent(sheetName)}!A1`;
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

    const appendResponse = await fetchFn(appendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: rows
      })
    });

    if (!appendResponse.ok) {
      const errText = await appendResponse.text();
      return {
        syncedCount: 0,
        error: `Google Sheets API append failed (${appendResponse.status}): ${errText}`
      };
    }

    return { syncedCount: rows.length };
  } catch (err) {
    // Non-blocking error handling
    return {
      syncedCount: 0,
      error: err.message || String(err)
    };
  }
}

export default exportBookingsToGoogleSheets;
