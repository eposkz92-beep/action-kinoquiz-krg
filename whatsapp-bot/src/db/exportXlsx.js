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
 * Opens 100% natively on iPhone, iPad, Android, Excel Mobile, Google Sheets, LibreOffice, and PC.
 * @param {Object} db - DatabaseSync instance or { db, bookings } DAO
 * @param {Object} [options]
 * @returns {Buffer} Valid .xlsx binary Buffer
 */
export function exportBookingsToXlsxBuffer(db, options = {}) {
  let records = [];
  if (db && db.bookings && typeof db.bookings.list === 'function') {
    records = db.bookings.list({ limit: 10000 });
  } else if (db && typeof db.prepare === 'function') {
    records = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  } else if (db && db.db && typeof db.db.prepare === 'function') {
    records = db.db.prepare('SELECT * FROM bookings ORDER BY created_at DESC;').all();
  }

  const pricePerPlayer = Number(options.pricePerPlayer) || 3000;

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
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
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // 4. xl/workbook.xml
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews>
    <workbookView xWindow="0" yWindow="0" windowWidth="20480" windowHeight="10240"/>
  </bookViews>
  <sheets>
    <sheet name="Брони Киноквиз" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  // 5. xl/styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <!-- Font 0: Normal text -->
    <font><sz val="11"/><name val="Calibri"/><color rgb="FF1F2937"/></font>
    <!-- Font 1: Bold black (header) -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF000000"/></font>
    <!-- Font 2: Bold team / total -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
    <!-- Font 3: Bold amber (revenue) -->
    <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFB45309"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <!-- Fill 2: Amber/Gold header (#F59E0B) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF59E0B"/></patternFill></fill>
    <!-- Fill 3: Zebra light-gray (#F9FAFB) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFF9FAFB"/></patternFill></fill>
    <!-- Fill 4: Total row light amber (#FEF3C7) -->
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
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
  <cellXfs count="9">
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
    <!-- 6: Total label right -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 7: Total center -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 8: Total revenue right -->
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  // Column definitions: widths and styles
  const colWidths = [
    { min: 1, max: 1, width: 6 },   // A: №
    { min: 2, max: 2, width: 18 },  // B: Дата заявки
    { min: 3, max: 3, width: 22 },  // C: Команда
    { min: 4, max: 4, width: 18 },  // D: Капитан
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

  const headerCells = headers.map((h, i) => {
    const col = getColLetter(i + 1);
    return `<c r="${col}1" t="inlineStr" s="1"><is><t>${escapeXml(h)}</t></is></c>`;
  }).join('');

  const rowsXml = [`<row r="1" ht="28" customHeight="1">${headerCells}</row>`];

  let totalPlayersSum = 0;
  let totalRevenueSum = 0;

  records.forEach((r, idx) => {
    const rowNum = idx + 2;
    const players = Number(r.players_count) || 0;
    const sum = players * pricePerPlayer;
    totalPlayersSum += players;
    totalRevenueSum += sum;

    const sourceLabel = (r.source === 'web' || r.source === 'website') ? 'Сайт' : 'WhatsApp бот';
    const statusLabel = r.status === 'cancelled' ? 'Отменена' : 'Подтверждена';
    const formattedDate = formatBookingDate(r.created_at);

    const cells = [
      `<c r="A${rowNum}" s="3"><v>${r.id || (idx + 1)}</v></c>`,
      `<c r="B${rowNum}" t="inlineStr" s="3"><is><t>${escapeXml(formattedDate)}</t></is></c>`,
      `<c r="C${rowNum}" t="inlineStr" s="4"><is><t>${escapeXml(r.team_name || '')}</t></is></c>`,
      `<c r="D${rowNum}" t="inlineStr" s="2"><is><t>${escapeXml(r.captain_name || '')}</t></is></c>`,
      `<c r="E${rowNum}" t="inlineStr" s="3"><is><t>${escapeXml(r.captain_phone || '')}</t></is></c>`,
      `<c r="F${rowNum}" s="3"><v>${players}</v></c>`,
      `<c r="G${rowNum}" t="inlineStr" s="2"><is><t>${escapeXml(r.game_title || '')}</t></is></c>`,
      `<c r="H${rowNum}" t="inlineStr" s="3"><is><t>${escapeXml(r.game_date || '')}</t></is></c>`,
      `<c r="I${rowNum}" t="inlineStr" s="5"><is><t>${sum.toLocaleString('ru-RU')} ₸</t></is></c>`,
      `<c r="J${rowNum}" t="inlineStr" s="3"><is><t>${escapeXml(sourceLabel)}</t></is></c>`,
      `<c r="K${rowNum}" t="inlineStr" s="3"><is><t>${escapeXml(statusLabel)}</t></is></c>`,
      `<c r="L${rowNum}" t="inlineStr" s="2"><is><t>${escapeXml(r.notes || '')}</t></is></c>`
    ];

    rowsXml.push(`<row r="${rowNum}" ht="22" customHeight="1">${cells.join('')}</row>`);
  });

  // Total footer row
  const totalRowNum = records.length + 2;
  const totalCells = [
    `<c r="A${totalRowNum}" s="6"/>`,
    `<c r="B${totalRowNum}" s="6"/>`,
    `<c r="C${totalRowNum}" s="6"/>`,
    `<c r="D${totalRowNum}" s="6"/>`,
    `<c r="E${totalRowNum}" t="inlineStr" s="6"><is><t>ИТОГО:</t></is></c>`,
    `<c r="F${totalRowNum}" t="inlineStr" s="7"><is><t>${totalPlayersSum} чел.</t></is></c>`,
    `<c r="G${totalRowNum}" s="6"/>`,
    `<c r="H${totalRowNum}" s="6"/>`,
    `<c r="I${totalRowNum}" t="inlineStr" s="8"><is><t>${totalRevenueSum.toLocaleString('ru-RU')} ₸</t></is></c>`,
    `<c r="J${totalRowNum}" s="6"/>`,
    `<c r="K${totalRowNum}" s="6"/>`,
    `<c r="L${totalRowNum}" s="6"/>`
  ];
  rowsXml.push(`<row r="${totalRowNum}" ht="26" customHeight="1">${totalCells.join('')}</row>`);

  // 6. xl/worksheets/sheet1.xml
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${colsXml}
  <sheetData>
    ${rowsXml.join('\n    ')}
  </sheetData>
</worksheet>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: worksheetXml }
  ]);
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
