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
 * Formats a raw database timestamp into a clean, localized date-time string
 * suitable for display in Excel, CSV, and Web interfaces.
 * Output format: "DD.MM.YYYY HH:mm" (e.g. "15.11.2026 14:00")
 * @param {string|Date|number} rawVal
 * @param {string} [timeZone='Asia/Almaty']
 * @returns {string}
 */
export function formatBookingDate(rawVal, timeZone = 'Asia/Almaty') {
  if (rawVal === null || rawVal === undefined) return '';
  const str = String(rawVal).trim();
  if (!str) return '';

  // If already in DD.MM.YYYY format, return as is
  if (/^\d{2}\.\d{2}\.\d{4}/.test(str)) {
    return str;
  }

  // Handle standard SQLite datetime format: YYYY-MM-DD HH:mm:ss
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    const [_, y, mo, d, h = '00', min = '00'] = match;
    // If explicit UTC timezone indicator is present
    if (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
      try {
        const date = new Date(str);
        if (!isNaN(date.getTime())) {
          const parts = new Intl.DateTimeFormat('ru-RU', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }).formatToParts(date);
          const p = {};
          for (const item of parts) p[item.type] = item.value;
          return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
        }
      } catch {}
    }
    return `${d}.${mo}.${y} ${h}:${min}`;
  }

  try {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      const parts = new Intl.DateTimeFormat('ru-RU', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(date);
      const p = {};
      for (const item of parts) p[item.type] = item.value;
      return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
    }
  } catch {}

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
      escapeCsvField(formatBookingDate(r.created_at) || r.created_at),
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

/**
 * Escapes HTML characters for safe table rendering.
 * @param {any} val
 * @returns {string}
 */
export function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Exports bookings as a styled HTML Excel document (.xls) with Russian headers,
 * auto-formatted phone numbers, zebra rows, borders, and sum calculations.
 * @param {Object} db - DatabaseSync instance or { db, bookings } DAO
 * @param {Object} [options]
 * @returns {string}
 */
export function exportBookingsToExcelHtml(db, options = {}) {
  let records = [];
  if (db && db.bookings && typeof db.bookings.list === 'function') {
    records = db.bookings.list({ limit: 10000 });
  } else if (db && typeof db.prepare === 'function') {
    records = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  } else if (db && db.db && typeof db.db.prepare === 'function') {
    records = db.db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  }

  const pricePerPlayer = options.pricePerPlayer || 3000;

  let totalPlayersSum = 0;
  let totalRevenueSum = 0;

  const rows = records.map((r, index) => {
    const players = Number(r.players_count) || 0;
    const totalSum = players * pricePerPlayer;
    totalPlayersSum += players;
    totalRevenueSum += totalSum;

    const sourceLabel = r.source === 'web' ? 'Сайт' : 'WhatsApp бот';
    const statusLabel = r.status === 'cancelled' ? 'Отменена' : 'Подтверждена';
    const bg = index % 2 === 0 ? '#ffffff' : '#f9fafb';
    const createdAtFormatted = formatBookingDate(r.created_at);

    return `
      <tr style="background-color: ${bg};">
        <td style="text-align: center; border: 1px solid #d1d5db; padding: 8px;">${r.id || (index + 1)}</td>
        <td style="text-align: center; border: 1px solid #d1d5db; padding: 8px; mso-number-format:'\\@'; white-space: nowrap;">${escapeHtml(createdAtFormatted)}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px; font-weight: bold; color: #111827;">${escapeHtml(r.team_name || '')}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px;">${escapeHtml(r.captain_name || '')}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px; mso-number-format:'\\@'; white-space: nowrap;">${escapeHtml(r.captain_phone || '')}</td>
        <td style="text-align: center; border: 1px solid #d1d5db; padding: 8px; font-weight: bold;">${players}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px;">${escapeHtml(r.game_title || '')}</td>
        <td style="text-align: center; border: 1px solid #d1d5db; padding: 8px; mso-number-format:'\\@'; white-space: nowrap;">${escapeHtml(r.game_date || '')}</td>
        <td style="text-align: right; border: 1px solid #d1d5db; padding: 8px; font-weight: bold; color: #b45309;">${totalSum.toLocaleString('ru-RU')} ₸</td>
        <td style="border: 1px solid #d1d5db; padding: 8px; text-align: center;">${sourceLabel}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px; text-align: center;">${statusLabel}</td>
        <td style="border: 1px solid #d1d5db; padding: 8px;">${escapeHtml(r.notes || '')}</td>
      </tr>
    `;
  }).join('\n');

  const nowStr = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

  return `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta http-equiv="Content-Type" content="application/vnd.ms-excel; charset=UTF-8">
  <!--[if gte mso 9]>
  <xml>
    <x:ExcelWorkbook>
      <x:ExcelWorksheets>
        <x:ExcelWorksheet>
          <x:Name>Брони Киноквиз</x:Name>
          <x:WorksheetOptions>
            <x:DisplayGridlines/>
          </x:WorksheetOptions>
        </x:ExcelWorksheet>
      </x:ExcelWorksheets>
    </x:ExcelWorkbook>
  </xml>
  <![endif]-->
  <style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2937; margin: 15px; }
    h2 { color: #b45309; margin-bottom: 4px; font-size: 16pt; }
    p { color: #6b7280; font-size: 10pt; margin-top: 0; margin-bottom: 15px; }
    table { border-collapse: collapse; width: 100%; border: 1px solid #9ca3af; }
    th { background-color: #f59e0b; color: #000000; font-weight: bold; border: 1px solid #b45309; padding: 10px 8px; text-align: center; }
    td { font-size: 10.5pt; vertical-align: middle; }
    .total-row { background-color: #fef3c7; font-weight: bold; border-top: 2px solid #b45309; }
  </style>
</head>
<body>
  <h2>🎬 Таблица бронирований — ACTION Киноквиз Караганда</h2>
  <p>Сформировано: ${nowStr} • Стоимость: ${pricePerPlayer.toLocaleString('ru-RU')} ₸ / игрок</p>
  <table>
    <thead>
      <tr>
        <th style="width: 45px;">№</th>
        <th style="width: 155px;">Дата заявки</th>
        <th style="width: 180px;">Команда</th>
        <th style="width: 140px;">Капитан</th>
        <th style="width: 150px;">Телефон капитана</th>
        <th style="width: 80px;">Игроков</th>
        <th style="width: 220px;">Игра</th>
        <th style="width: 130px;">Дата игры</th>
        <th style="width: 120px;">К оплате (₸)</th>
        <th style="width: 100px;">Источник</th>
        <th style="width: 110px;">Статус</th>
        <th style="width: 180px;">Примечания</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="12" style="text-align: center; padding: 20px; color: #9ca3af;">Броней пока нет</td></tr>'}
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="5" style="border: 1px solid #b45309; padding: 10px; text-align: right;">ИТОГО:</td>
        <td style="border: 1px solid #b45309; padding: 10px; text-align: center;">${totalPlayersSum} чел.</td>
        <td colspan="2" style="border: 1px solid #b45309; padding: 10px;"></td>
        <td style="border: 1px solid #b45309; padding: 10px; text-align: right; color: #b45309;">${totalRevenueSum.toLocaleString('ru-RU')} ₸</td>
        <td colspan="3" style="border: 1px solid #b45309; padding: 10px;"></td>
      </tr>
    </tfoot>
  </table>
</body>
</html>
  `.trim();
}

export const exportBookingsToCsv = exportBookingsCsv;
export default exportBookingsCsv;
