import fs from 'node:fs';
import path from 'node:path';

/**
 * Escapes a single CSV value following RFC 4180
 * @param {any} val
 * @returns {string}
 */
export function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports bookings to CSV with UTF-8 BOM and RFC 4180 escaping.
 * @param {Object} db - DatabaseSync instance or { db, bookings } DAO
 * @param {string} [outputPath] - Optional file path to write CSV to disk
 * @param {string} [gameTitleFilter] - Optional filter for specific game title
 * @returns {Promise<string>} Generated CSV string with BOM
 */
export async function exportBookingsCsv(db, outputPath = null, gameTitleFilter = null) {
  let records = [];

  // Flexible DB input handling (handles both raw DatabaseSync or initDatabase result)
  if (db && db.bookings && typeof db.bookings.list === 'function') {
    records = db.bookings.list({ gameTitle: gameTitleFilter, limit: 10000 });
  } else if (db && typeof db.prepare === 'function') {
    if (gameTitleFilter) {
      records = db.prepare('SELECT * FROM bookings WHERE game_title = ? ORDER BY created_at ASC;').all(gameTitleFilter);
    } else {
      records = db.prepare('SELECT * FROM bookings ORDER BY created_at ASC;').all();
    }
  } else if (db && db.db && typeof db.db.prepare === 'function') {
    if (gameTitleFilter) {
      records = db.db.prepare('SELECT * FROM bookings WHERE game_title = ? ORDER BY created_at ASC;').all(gameTitleFilter);
    } else {
      records = db.db.prepare('SELECT * FROM bookings ORDER BY created_at ASC;').all();
    }
  }

  const headers = [
    'ID',
    'Created At',
    'Team Name',
    'Captain Name',
    'Captain Phone',
    'Players Count',
    'Game Title',
    'Game Date',
    'Source',
    'Notes'
  ];

  const rows = [headers.join(',')];

  for (const r of records) {
    const row = [
      escapeCsvField(r.id),
      escapeCsvField(r.created_at),
      escapeCsvField(r.team_name),
      escapeCsvField(r.captain_name),
      escapeCsvField(r.captain_phone),
      escapeCsvField(r.players_count),
      escapeCsvField(r.game_title),
      escapeCsvField(r.game_date),
      escapeCsvField(r.source),
      escapeCsvField(r.notes || '')
    ];
    rows.push(row.join(','));
  }

  // UTF-8 BOM prefix (\uFEFF) ensures proper Cyrillic display in Excel
  const csvContent = '\uFEFF' + rows.join('\r\n') + '\r\n';

  if (outputPath) {
    const resolvedPath = path.resolve(outputPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(resolvedPath, csvContent, 'utf8');
  }

  return csvContent;
}

export const exportBookingsToCsv = exportBookingsCsv;
export default exportBookingsCsv;
