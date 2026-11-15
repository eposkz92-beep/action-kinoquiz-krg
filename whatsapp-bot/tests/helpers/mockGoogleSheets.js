/**
 * tests/helpers/mockGoogleSheets.js
 * In-Memory Google Sheets Mock & Schema Validator (8-10 Columns) for ACTION Kinoquiz Bot Testing
 */

/**
 * Expected 8-column schema headers:
 * [timestamp, teamName, captainName, phone, playersCount, gameTitle, gameDate, source]
 */
export const EXPECTED_SCHEMA_COLUMNS = [
  'timestamp',
  'teamName',
  'captainName',
  'phone',
  'playersCount',
  'gameTitle',
  'gameDate',
  'source'
];

/**
 * Expected 10-column database export headers (src/db/exportSheets.js):
 * [id, created_at, team_name, captain_name, captain_phone, players_count, game_title, game_date, source, notes]
 */
export const EXPECTED_EXPORT_COLUMNS = [
  'id',
  'created_at',
  'team_name',
  'captain_name',
  'captain_phone',
  'players_count',
  'game_title',
  'game_date',
  'source',
  'notes'
];

/**
 * Creates an emulated Google Sheets client with schema validation (8 to 10 columns).
 * @param {Object} [options]
 * @param {boolean} [options.strictSchema=true]
 * @returns {Object} Mock Google Sheets client
 */
export function createMockGoogleSheets(options = {}) {
  const records = [];
  let currentStatus = 200;
  let customError = null;
  let originalFetch = null;

  const mockClient = {
    records,

    /**
     * Appends a single row to the spreadsheet (alias conforming to SCOPE.md).
     * @param {Array} row
     * @returns {Promise<Object>}
     */
    async appendRow(row) {
      return this.appendRows('default-sheet-id', 'A1', [row]);
    },

    /**
     * Appends rows to the spreadsheet.
     * Supports:
     * - appendRows(spreadsheetId, range, rows)
     * - appendRows(rows)
     * - appendRows(spreadsheetId, rows)
     *
     * @param {string|Array} arg1
     * @param {string|Array} [arg2]
     * @param {Array} [arg3]
     * @returns {Promise<Object>} Google Sheets update result
     */
    async appendRows(arg1, arg2, arg3) {
      let spreadsheetId = 'mock_spreadsheet_id';
      let range = 'Брони!A1';
      let rows = [];

      if (Array.isArray(arg1)) {
        rows = arg1;
      } else if (typeof arg1 === 'string' && Array.isArray(arg2)) {
        spreadsheetId = arg1;
        rows = arg2;
      } else {
        spreadsheetId = String(arg1 || 'mock_spreadsheet_id');
        range = String(arg2 || 'Брони!A1');
        rows = Array.isArray(arg3) ? arg3 : [];
      }

      // 1. Fault injection
      if (currentStatus !== 200) {
        const error = customError || new Error(`Google Sheets API Error ${currentStatus}`);
        error.code = currentStatus;
        error.status = currentStatus;
        throw error;
      }

      // 2. Schema validation (accepts both 8-column and 10-column rows)
      const isStrict = options.strictSchema !== false;
      if (isStrict) {
        if (!Array.isArray(rows)) {
          throw new Error('Invalid appendRows invocation: rows must be an Array');
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!Array.isArray(row)) {
            throw new Error(`Invalid row schema at index ${i}: row must be an Array`);
          }
          if (row.length !== 8 && row.length !== 10) {
            throw new Error(
              `Invalid row schema at index ${i}: expected 8 or 10 columns [8: ${EXPECTED_SCHEMA_COLUMNS.join(
                ', '
              )} | 10: ${EXPECTED_EXPORT_COLUMNS.join(', ')}], but received ${row.length} columns`
            );
          }
        }
      }

      const entry = {
        spreadsheetId,
        range,
        rows: [...rows],
        timestamp: Date.now()
      };
      records.push(entry);

      const totalExistingRows = records.reduce((acc, r) => acc + r.rows.length, 0);
      const startIdx = totalExistingRows - rows.length + 1;
      const endIdx = totalExistingRows;

      const maxCols = rows.length > 0 ? rows.reduce((max, r) => Math.max(max, r.length), 8) : 8;
      const colLetter = maxCols === 10 ? 'J' : (maxCols === 9 ? 'I' : 'H');
      const totalCells = rows.reduce((acc, r) => acc + r.length, 0);
      const sheetPrefix = range.includes('!') ? range.split('!')[0] : 'Брони';

      return {
        spreadsheetId,
        tableRange: range,
        updates: {
          spreadsheetId,
          updatedRange: `${sheetPrefix}!A${startIdx}:${colLetter}${endIdx}`,
          updatedRows: rows.length,
          updatedColumns: maxCols,
          updatedCells: totalCells
        }
      };
    },

    /**
     * Lists all appended rows flattened into a single array.
     * @returns {Array<Array>}
     */
    listRows() {
      const allRows = [];
      for (const rec of records) {
        allRows.push(...rec.rows);
      }
      return allRows;
    },

    /**
     * Configures error status code or custom error object for fault simulation.
     * @param {number} code
     * @param {Error|null} [error=null]
     */
    setStatus(code, error = null) {
      currentStatus = Number(code) || 200;
      customError = error;
    },

    /**
     * Clears all recorded entries and resets status to 200.
     */
    clear() {
      records.length = 0;
      currentStatus = 200;
      customError = null;
    },

    /**
     * Installs optional fetch interceptor for sheets.googleapis.com
     */
    installFetchInterceptor() {
      if (!originalFetch) {
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, fetchOptions = {}) => {
          const urlStr = String(url);
          if (urlStr.includes('sheets.googleapis.com')) {
            if (currentStatus !== 200) {
              const errResp = {
                error: {
                  code: currentStatus,
                  message: customError?.message || `Google Sheets API Error ${currentStatus}`,
                  status: currentStatus === 403 ? 'PERMISSION_DENIED' : 'UNAVAILABLE'
                }
              };
              return {
                ok: false,
                status: currentStatus,
                statusText: 'Error',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: async () => errResp,
                text: async () => JSON.stringify(errResp)
              };
            }

            let bodyObj = {};
            try {
              bodyObj = JSON.parse(fetchOptions.body || '{}');
            } catch {}

            const rows = bodyObj.values || [];
            await mockClient.appendRows(urlStr, 'A1', rows);

            const maxCols = rows.length > 0 ? rows.reduce((max, r) => Math.max(max, r.length), 8) : 8;
            const totalCells = rows.reduce((acc, r) => acc + (r.length || 8), 0);
            const okResp = {
              spreadsheetId: 'mock_spreadsheet_id',
              updates: {
                updatedRows: rows.length,
                updatedColumns: maxCols,
                updatedCells: totalCells
              }
            };

            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: new Headers({ 'Content-Type': 'application/json' }),
              json: async () => okResp,
              text: async () => JSON.stringify(okResp)
            };
          }

          if (originalFetch) {
            return originalFetch(url, fetchOptions);
          }
          throw new Error(`Unhandled non-sheets fetch to: ${urlStr}`);
        };
      }
    },

    /**
     * Uninstalls fetch interceptor if installed.
     */
    uninstallFetchInterceptor() {
      if (originalFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = null;
      }
    }
  };

  return mockClient;
}

export default createMockGoogleSheets;
