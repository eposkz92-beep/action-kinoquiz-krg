import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { formatBookingDate } from './exportCsv.js';

/**
 * Escapes XML special characters for safe inclusion in OpenXML tags.
 * @param {any} val
 * @returns {string}
 */
export function escapeXml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converts a 1-based column index to an Excel column letter (1 -> 'A', 28 -> 'AB')
 * @param {number} colIndex
 * @returns {string}
 */
export function getColLetter(colIndex) {
  let temp;
  let letter = '';
  let col = colIndex;
  while (col > 0) {
    temp = (col - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    col = Math.floor((col - temp) / 26);
  }
  return letter;
}

/**
 * Sanitizes and truncates Excel sheet name to <= 31 chars, removing forbidden chars.
 * @param {string} name
 * @param {string} [fallback='Лист']
 * @param {Set<string>} [existingNames=new Set()]
 * @returns {string}
 */
export function sanitizeSheetName(name, fallback = 'Лист', existingNames = new Set()) {
  let cleaned = String(name || '')
    .replace(/[\\/?*:[\]]/g, '')
    .trim()
    .replace(/^'+|'+$/g, '');
  if (!cleaned) cleaned = fallback;
  if (cleaned.length > 31) cleaned = cleaned.slice(0, 31).trim();

  let finalName = cleaned;
  let counter = 2;
  while (existingNames.has(finalName.toLowerCase())) {
    const suffix = ` (${counter})`;
    const maxBase = 31 - suffix.length;
    finalName = cleaned.slice(0, maxBase).trim() + suffix;
    counter++;
  }
  existingNames.add(finalName.toLowerCase());
  return finalName;
}

/**
 * Generates a concise, attractive worksheet tab name for a game.
 * @param {string} gameTitle
 * @param {string} gameDate
 * @returns {string}
 */
export function getShortGameName(gameTitle, gameDate) {
  const title = (gameTitle || 'Игра').replace(/\s*\([^)]+\)/, '').trim() || (gameTitle || 'Игра');
  let shortTitle = title;
  if (shortTitle.toLowerCase().includes('киномарафон')) {
    shortTitle = 'Киномарафон';
  } else if (shortTitle.toLowerCase().includes('аниме')) {
    shortTitle = 'Культовые Аниме';
  } else if (shortTitle.length > 18) {
    shortTitle = shortTitle.slice(0, 18).trim();
  }

  let shortDate = '';
  if (gameDate) {
    const dMatch = String(gameDate).match(/(\d{1,2}[.\/]\d{1,2})/);
    if (dMatch) {
      shortDate = dMatch[1];
    } else {
      const monthMatch = String(gameDate).match(/(\d{1,2}\s+[а-яА-ЯёЁ]+)/);
      if (monthMatch) shortDate = monthMatch[1];
    }
  }

  const name = shortDate ? `${shortTitle} (${shortDate})` : shortTitle;
  return name.replace(/[\\/?*:[\]]/g, '').trim().slice(0, 31);
}

/**
 * Creates a standard uncompressed/deflated ZIP archive using Node.js built-in zlib.
 * Generates standard PKZIP 2.0 format compatible with mobile and desktop zip parsers.
 * @param {Array<{name: string, data: string|Buffer}>} files
 * @returns {Buffer}
 */
export function createZipBuffer(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedData = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data, 'utf8');
    const crc = zlib.crc32(uncompressedData);
    const compressedData = zlib.deflateRawSync(uncompressedData);

    // 1. Local File Header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);          // version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6);       // bit flag: UTF-8 filenames
    lh.writeUInt16LE(8, 8);           // compression method: 8 = Deflate
    lh.writeUInt16LE(0, 10);          // last mod file time
    lh.writeUInt16LE(0, 12);          // last mod file date
    lh.writeUInt32LE(crc, 14);        // CRC-32
    lh.writeUInt32LE(compressedData.length, 18);  // compressed size
    lh.writeUInt32LE(uncompressedData.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);         // filename length
    lh.writeUInt16LE(0, 28);                       // extra field length

    localHeaders.push(lh, nameBuf, compressedData);

    // 2. Central Directory Header
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);       // bit flag: UTF-8
    ch.writeUInt16LE(8, 10);          // compression: Deflate
    ch.writeUInt16LE(0, 12);          // time
    ch.writeUInt16LE(0, 14);          // date
    ch.writeUInt32LE(crc, 16);        // CRC-32
    ch.writeUInt32LE(compressedData.length, 20);  // compressed size
    ch.writeUInt32LE(uncompressedData.length, 24); // uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28);         // filename length
    ch.writeUInt16LE(0, 30);                       // extra field length
    ch.writeUInt16LE(0, 32);                       // file comment length
    ch.writeUInt16LE(0, 34);                       // disk number start
    ch.writeUInt16LE(0, 36);                       // internal file attributes
    ch.writeUInt32LE(0, 38);                       // external file attributes
    ch.writeUInt32LE(offset, 42);                  // relative offset of local header

    centralHeaders.push(ch, nameBuf);

    offset += 30 + nameBuf.length + compressedData.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(centralHeaders);
  const cdSize = cdBuf.length;

  // 3. End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // start disk
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);     // size of central directory
  eocd.writeUInt32LE(cdStart, 16);    // offset of start of central directory
  eocd.writeUInt16LE(0, 20);          // comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/**
 * Generates an authentic Microsoft Excel OpenXML (.xlsx) file as a Buffer.
 * Divides bookings into separated tables by games so they don't get mixed together:
 * - Sheet 1: «Все игры (Сводная)» with distinct formatted tables for each game and grand total
 * - Dedicated sheets for each game (e.g. «Киномарафон (17.11)», «Культовые Аниме (24.11)»)
 *
 * @param {Object} db - DatabaseSync instance or { db, bookings } DAO or Array
 * @param {Object} [options]
 * @returns {Buffer} Valid .xlsx binary Buffer
 */
export function exportBookingsToXlsxBuffer(db, options = {}) {
  let records = [];
  if (Array.isArray(db)) {
    records = db;
  } else if (Array.isArray(options.records)) {
    records = options.records;
  } else if (Array.isArray(options.bookings)) {
    records = options.bookings;
  } else if (db && db.bookings && typeof db.bookings.list === 'function') {
    records = db.bookings.list({ limit: 10000 });
  } else if (db && typeof db.prepare === 'function') {
    records = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  } else if (db && db.db && typeof db.db.prepare === 'function') {
    records = db.db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  }

  const pricePerPlayer = Number(options.pricePerPlayer) || 3000;
  const gameFilter = options.gameTitleFilter || options.filterGame;
  if (gameFilter) {
    const fLower = String(gameFilter).toLowerCase().trim();
    records = records.filter(r => (r.game_title || '').toLowerCase().includes(fLower));
  }

  // Group records by game (clean title + game date)
  const groupsMap = new Map();
  for (const r of records) {
    const rawTitle = (r.game_title || 'Другие игры').trim();
    const cleanTitle = rawTitle.replace(/\s*\([^)]+\)/, '').trim() || rawTitle;
    let gameDate = (r.game_date || '').trim();

    if (!gameDate) {
      const match = rawTitle.match(/\(([^)]+)\)/);
      if (match) gameDate = match[1].trim();
    }

    const groupKey = gameDate ? `${cleanTitle} (${gameDate})` : cleanTitle;

    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, {
        groupKey,
        gameTitle: cleanTitle,
        gameDate: gameDate || 'Скоро',
        records: []
      });
    }
    groupsMap.get(groupKey).records.push(r);
  }

  const gameGroups = Array.from(groupsMap.values());

  // Assign clean unique worksheet names
  const existingSheetNames = new Set(['все игры (сводная)']);
  gameGroups.forEach((g) => {
    const baseTabName = getShortGameName(g.gameTitle, g.gameDate);
    g.sheetName = sanitizeSheetName(baseTabName, 'Игра', existingSheetNames);
  });

  // Column definitions: widths
  const colWidths = [
    { min: 1, max: 1, width: 6 },   // A: №
    { min: 2, max: 2, width: 18 },  // B: Дата заявки
    { min: 3, max: 3, width: 24 },  // C: Команда
    { min: 4, max: 4, width: 20 },  // D: Капитан
    { min: 5, max: 5, width: 18 },  // E: Телефон
    { min: 6, max: 6, width: 12 },  // F: Игроков
    { min: 7, max: 7, width: 26 },  // G: Игра
    { min: 8, max: 8, width: 16 },  // H: Дата игры
    { min: 9, max: 9, width: 16 },  // I: К оплате
    { min: 10, max: 10, width: 14 }, // J: Источник
    { min: 11, max: 11, width: 15 }, // K: Статус
    { min: 12, max: 12, width: 24 }  // L: Примечания
  ];

  const colsXml = `<cols>` + colWidths.map(c =>
    `<col min="${c.min}" max="${c.max}" width="${c.width}" customWidth="1"/>`
  ).join('') + `</cols>`;

  // Headers row
  const headers = [
    '№',
    'Дата заявки',
    'Команда',
    'Капитан',
    'Телефон капитана',
    'Игроков',
    'Игра',
    'Дата игры',
    'К оплате (₸)',
    'Источник',
    'Статус',
    'Примечания'
  ];

  // Helper to render an isolated game block (Banner + Column Headers + Team rows + Game subtotal)
  function renderGameBlock(gameGroup, startRowNum) {
    const rows = [];
    let currentRow = startRowNum;

    // 1. Game Banner Header Row
    const bannerText = `🎬 ИГРА: ${gameGroup.gameTitle}   |   📅 ДАТА: ${gameGroup.gameDate || 'Скоро'}`;
    const bannerCells = [
      `<c r="A${currentRow}" t="inlineStr" s="9"><is><t>${escapeXml(bannerText)}</t></is></c>`,
      ...['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map(col =>
        `<c r="${col}${currentRow}" s="10"/>`
      )
    ];
    rows.push(`<row r="${currentRow}" ht="28" customHeight="1">${bannerCells.join('')}</row>`);
    currentRow++;

    // 2. Column Headers Row
    const headerCells = headers.map((h, i) => {
      const col = getColLetter(i + 1);
      return `<c r="${col}${currentRow}" t="inlineStr" s="1"><is><t>${escapeXml(h)}</t></is></c>`;
    }).join('');
    rows.push(`<row r="${currentRow}" ht="26" customHeight="1">${headerCells}</row>`);
    currentRow++;

    // 3. Team Rows
    let gamePlayersSum = 0;
    let gameRevenueSum = 0;

    gameGroup.records.forEach((r, idx) => {
      const players = Number(r.players_count) || 0;
      const sum = players * pricePerPlayer;
      gamePlayersSum += players;
      gameRevenueSum += sum;

      const sourceLabel = (r.source === 'web' || r.source === 'website') ? 'Сайт' : 'WhatsApp бот';
      const statusLabel = r.status === 'cancelled' ? 'Отменена' : 'Подтверждена';
      const formattedDate = formatBookingDate(r.created_at);

      const cells = [
        `<c r="A${currentRow}" s="3"><v>${idx + 1}</v></c>`,
        `<c r="B${currentRow}" t="inlineStr" s="3"><is><t>${escapeXml(formattedDate)}</t></is></c>`,
        `<c r="C${currentRow}" t="inlineStr" s="4"><is><t>${escapeXml(r.team_name || '')}</t></is></c>`,
        `<c r="D${currentRow}" t="inlineStr" s="2"><is><t>${escapeXml(r.captain_name || '')}</t></is></c>`,
        `<c r="E${currentRow}" t="inlineStr" s="3"><is><t>${escapeXml(r.captain_phone || '')}</t></is></c>`,
        `<c r="F${currentRow}" s="3"><v>${players}</v></c>`,
        `<c r="G${currentRow}" t="inlineStr" s="2"><is><t>${escapeXml(r.game_title || '')}</t></is></c>`,
        `<c r="H${currentRow}" t="inlineStr" s="3"><is><t>${escapeXml(r.game_date || '')}</t></is></c>`,
        `<c r="I${currentRow}" t="inlineStr" s="5"><is><t>${sum.toLocaleString('ru-RU')} ₸</t></is></c>`,
        `<c r="J${currentRow}" t="inlineStr" s="3"><is><t>${escapeXml(sourceLabel)}</t></is></c>`,
        `<c r="K${currentRow}" t="inlineStr" s="3"><is><t>${escapeXml(statusLabel)}</t></is></c>`,
        `<c r="L${currentRow}" t="inlineStr" s="2"><is><t>${escapeXml(r.notes || '')}</t></is></c>`
      ];

      rows.push(`<row r="${currentRow}" ht="22" customHeight="1">${cells.join('')}</row>`);
      currentRow++;
    });

    // 4. Game Subtotal Row
    const subtotalCells = [
      `<c r="A${currentRow}" s="14"/>`,
      `<c r="B${currentRow}" s="14"/>`,
      `<c r="C${currentRow}" s="14"/>`,
      `<c r="D${currentRow}" s="14"/>`,
      `<c r="E${currentRow}" t="inlineStr" s="11"><is><t>ИТОГО ПО ИГРЕ (${gameGroup.records.length} ком.):</t></is></c>`,
      `<c r="F${currentRow}" t="inlineStr" s="12"><is><t>${gamePlayersSum} чел.</t></is></c>`,
      `<c r="G${currentRow}" s="14"/>`,
      `<c r="H${currentRow}" s="14"/>`,
      `<c r="I${currentRow}" t="inlineStr" s="13"><is><t>${gameRevenueSum.toLocaleString('ru-RU')} ₸</t></is></c>`,
      `<c r="J${currentRow}" s="14"/>`,
      `<c r="K${currentRow}" s="14"/>`,
      `<c r="L${currentRow}" s="14"/>`
    ];
    rows.push(`<row r="${currentRow}" ht="26" customHeight="1">${subtotalCells.join('')}</row>`);
    currentRow++;

    return {
      rows,
      nextRowNum: currentRow,
      playersSum: gamePlayersSum,
      revenueSum: gameRevenueSum
    };
  }

  // --- Build Sheet 1: «Все игры (Сводная)» ---
  const sheet1RowsXml = [];
  let currentSheet1Row = 1;
  let grandTotalPlayers = 0;
  let grandTotalRevenue = 0;

  if (records.length === 0) {
    const headerCells = headers.map((h, i) => {
      const col = getColLetter(i + 1);
      return `<c r="${col}1" t="inlineStr" s="1"><is><t>${escapeXml(h)}</t></is></c>`;
    }).join('');
    sheet1RowsXml.push(`<row r="1" ht="26" customHeight="1">${headerCells}</row>`);
    sheet1RowsXml.push(`<row r="2" ht="24" customHeight="1"><c r="A2" t="inlineStr" s="2"><is><t>Броней пока нет</t></is></c></row>`);
  } else {
    gameGroups.forEach((group, gIdx) => {
      const block = renderGameBlock(group, currentSheet1Row);
      sheet1RowsXml.push(...block.rows);
      currentSheet1Row = block.nextRowNum;
      grandTotalPlayers += block.playersSum;
      grandTotalRevenue += block.revenueSum;

      // Blank spacer row between game tables
      if (gIdx < gameGroups.length - 1) {
        sheet1RowsXml.push(`<row r="${currentSheet1Row}" ht="14"/>`);
        currentSheet1Row++;
      }
    });

    // Grand total row at the very bottom of Sheet 1
    const grandRowNum = currentSheet1Row;
    const grandTotalCells = [
      `<c r="A${grandRowNum}" s="6"/>`,
      `<c r="B${grandRowNum}" s="6"/>`,
      `<c r="C${grandRowNum}" s="6"/>`,
      `<c r="D${grandRowNum}" s="6"/>`,
      `<c r="E${grandRowNum}" t="inlineStr" s="6"><is><t>ОБЩИЙ ИТОГ (${records.length} ком.):</t></is></c>`,
      `<c r="F${grandRowNum}" t="inlineStr" s="7"><is><t>${grandTotalPlayers} чел.</t></is></c>`,
      `<c r="G${grandRowNum}" s="6"/>`,
      `<c r="H${grandRowNum}" s="6"/>`,
      `<c r="I${grandRowNum}" t="inlineStr" s="8"><is><t>${grandTotalRevenue.toLocaleString('ru-RU')} ₸</t></is></c>`,
      `<c r="J${grandRowNum}" s="6"/>`,
      `<c r="K${grandRowNum}" s="6"/>`,
      `<c r="L${grandRowNum}" s="6"/>`
    ];
    sheet1RowsXml.push(`<row r="${grandRowNum}" ht="28" customHeight="1">${grandTotalCells.join('')}</row>`);
  }

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${colsXml}
  <sheetData>
    ${sheet1RowsXml.join('\n    ')}
  </sheetData>
</worksheet>`;

  // --- Build Dedicated Sheets per Game ---
  const dedicatedSheets = gameGroups.map((group, idx) => {
    const sheetNum = idx + 2;
    const block = renderGameBlock(group, 1);

    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${colsXml}
  <sheetData>
    ${block.rows.join('\n    ')}
  </sheetData>
</worksheet>`;

    return {
      sheetNum,
      name: group.sheetName,
      fileName: `worksheets/sheet${sheetNum}.xml`,
      partName: `/xl/worksheets/sheet${sheetNum}.xml`,
      xml
    };
  });

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${dedicatedSheets.map(s => `<Override PartName="${s.partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`;

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // 3. xl/_rels/workbook.xml.rels
  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  ${dedicatedSheets.map(s => `<Relationship Id="rId${s.sheetNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.fileName}"/>`).join('\n  ')}
  <Relationship Id="rId${dedicatedSheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // 4. xl/workbook.xml
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="20480" windowHeight="10240"/>
  </bookViews>
  <sheets>
    <sheet name="Все игры (Сводная)" sheetId="1" r:id="rId1"/>
    ${dedicatedSheets.map(s => `<sheet name="${escapeXml(s.name)}" sheetId="${s.sheetNum}" r:id="rId${s.sheetNum}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

  // 5. xl/styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <!-- Font 0: Normal text -->
    <font><sz val="11"/><name val="Calibri"/><color rgb="FF1F2937"/></font>
    <!-- Font 1: Bold black (header) -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF000000"/></font>
    <!-- Font 2: Bold team / total -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
    <!-- Font 3: Bold amber (revenue) -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB45309"/></font>
    <!-- Font 4: Bold white (game banner) -->
    <font><b/><sz val="12"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
    <!-- Font 5: Bold indigo (game subtotal) -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF312E81"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <!-- Fill 2: Amber/Gold header (#F59E0B) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF59E0B"/></patternFill></fill>
    <!-- Fill 3: Zebra light-gray (#F9FAFB) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF9FAFB"/></patternFill></fill>
    <!-- Fill 4: Total row light amber (#FEF3C7) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
    <!-- Fill 5: Game banner dark slate (#1E293B) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
    <!-- Fill 6: Game subtotal light indigo (#EEF2FF) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFEEF2FF"/></patternFill></fill>
    <!-- Fill 7: Grand total gold (#FDE68A) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFDE68A"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <!-- Border 1: Thin light gray border -->
    <border>
      <left style="thin"><color rgb="FFD1D5DB"/></left>
      <right style="thin"><color rgb="FFD1D5DB"/></right>
      <top style="thin"><color rgb="FFD1D5DB"/></top>
      <bottom style="thin"><color rgb="FFD1D5DB"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="15">
    <!-- 0: Default general -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Header (bold black, gold fill, border, centered) -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 2: Regular left -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 3: Regular center -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 4: Regular bold left (team name) -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 5: Regular bold right (revenue) -->
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 6: Grand total label right -->
    <xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 7: Grand total center -->
    <xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 8: Grand total revenue right -->
    <xf numFmtId="0" fontId="3" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 9: Game banner left (bold white text, dark slate fill) -->
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <!-- 10: Game banner empty cell (dark slate fill) -->
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <!-- 11: Game subtotal label right (light indigo fill) -->
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 12: Game subtotal center (light indigo fill) -->
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 13: Game subtotal revenue right (light indigo fill) -->
    <xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 14: Game subtotal empty cell (light indigo fill) -->
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    ...dedicatedSheets.map(s => ({ name: `xl/${s.fileName}`, data: s.xml }))
  ];

  return createZipBuffer(files);
}

/**
 * Writes XLSX buffer to disk.
 * @param {Object} db
 * @param {string} outputPath
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
export async function exportBookingsToXlsx(db, outputPath, options = {}) {
  const buf = exportBookingsToXlsxBuffer(db, options);
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  await fs.promises.writeFile(resolved, buf);
  return resolved;
}

export default exportBookingsToXlsxBuffer;
