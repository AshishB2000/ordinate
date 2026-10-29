// Self-check for an uploaded .xlsx (src/data/parseXlsx.ts, src/data/xlsxGuard.ts):
// the container is checked before exceljs inflates a byte (NV-48), and a sheet's
// used range is held to a cell budget and read without creating a cell per gap
// (NV-49). Every workbook here is written byte by byte by the test itself, and
// each refusal has its CONTROL — the same workbook without the trap parses.
//
//   npm run build:ts && node scripts/test-xlsxImport.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');

const { parseXlsx }: typeof import('../src/data/parseXlsx') = require('../src/data/parseXlsx');
const { MAX_XLSX_CELLS, MAX_XLSX_UNPACKED }: typeof import('../src/data/xlsxGuard') = require('../src/data/xlsxGuard');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-xlsx-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* temp */ } });

interface Entry {
  name: string;
  data: Buffer;
  /** Compressed bytes as written (default deflateRaw(data)). */
  body?: Buffer;
  /** Declared uncompressed size (default data.length). */
  usize?: number;
  /** A streaming writer's entry: flag 0x8, zeros in the local header, a descriptor after the data. */
  descriptor?: boolean;
}

/** A zip, written field by field. */
function zip(entries: Entry[], comment = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.body ?? zlib.deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(e.data) >>> 0;
    const usize = e.usize ?? e.data.length;
    const flags = e.descriptor ? 0x0808 : 0x0800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8);
    if (!e.descriptor) { lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); }
    lh.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(body.length, 8); dd.writeUInt32LE(usize, 12); }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(lh, name, body, dd);
    cds.push(cd, name);
    offset += 30 + name.length + body.length + dd.length;
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, end, comment]);
}

const x = (s: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
const NS = 'http://schemas.openxmlformats.org';
/** A minimal workbook of one sheet whose cells are `[address, number]`. */
function workbook(cells: Array<[string, number]>, extra: Entry[] = [], descriptor = false, tail = ''): Entry[] {
  const rows = new Map<number, string[]>();
  for (const [ref, v] of cells) {
    const r = Number(/\d+$/.exec(ref)![0]);
    rows.set(r, [...(rows.get(r) || []), `<c r="${ref}"><v>${v}</v></c>`]);
  }
  const sheetData = [...rows].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.join('')}</row>`).join('');
  return [
    { name: '[Content_Types].xml', data: x(`<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: '_rels/.rels', data: x(`<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: x(`<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: x(`<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: x(`<worksheet xmlns="${NS}/spreadsheetml/2006/main">${tail.startsWith('<cols') ? tail : ''}<sheetData>${sheetData}</sheetData>${tail.startsWith('<cols') ? '' : tail}</worksheet>`) },
    ...extra,
  ].map((e) => ({ ...e, descriptor }));
}

let n = 0;
function file(bytes: Buffer): string {
  const f = path.join(DIR, `w${n++}.xlsx`);
  fs.writeFileSync(f, bytes);
  return f;
}

/** The parse's rows, or the refusal's message. */
async function outcome(bytes: Buffer): Promise<string> {
  try {
    const r = await parseXlsx(file(bytes));
    return `rows=${r.rowCount} cols=${r.columns.length}`;
  } catch (err) {
    return (err as Error).message;
  }
}

/** A raw deflate stream of `mb` MiB of zeros (about a thousandth of that compressed). */
const zeros = (mb: number): Buffer => zlib.deflateRawSync(Buffer.alloc(mb << 20), { level: 9 });

async function main(): Promise<void> {
  const CELLS: Array<[string, number]> = [['A1', 1], ['B1', 2], ['A2', 3], ['B2', 4]];
  ok('control: a minimal workbook parses', (await outcome(zip(workbook(CELLS)))) === 'rows=1 cols=2');
  ok('a streaming writer\'s data descriptors are accepted', (await outcome(zip(workbook(CELLS, [], true)))) === 'rows=1 cols=2');

  // ── NV-48: the container, before exceljs ──────────────────────────────────
  const refusal = /^This Excel file cannot be imported: it is damaged, or it unpacks to more than 512 MB/;
  const honest = zip(workbook(CELLS, [{ name: 'xl/media/pad.bin', data: Buffer.alloc(0), body: zlib.deflateRawSync(Buffer.alloc(0)), usize: MAX_XLSX_UNPACKED + 1 }]));
  const r1 = await outcome(honest);
  ok('an entry DECLARING more than the unpacked budget is refused before anything inflates', refusal.test(r1), r1);
  const pad = zeros(64); // 64 MiB of zeros, ~64 KB compressed
  const lying = zip(workbook(CELLS, [{ name: 'xl/media/pad.bin', data: Buffer.alloc(0), body: pad, usize: 1 << 20 }]));
  const mem = (): number => process.memoryUsage().arrayBuffers + process.memoryUsage().external;
  const before = mem();
  let peak = before;
  const iv = setInterval(() => { peak = Math.max(peak, mem()); }, 2);
  const r2 = await outcome(lying);
  clearInterval(iv);
  ok('an entry that inflates past what it declares is stopped by the counter', refusal.test(r2), r2);
  ok('…without inflating it (peak growth under 16 MB)', peak - before < 16 << 20, `${((peak - before) / 1048576).toFixed(1)} MB`);
  // Negative control: exceljs (JSZip) alone inflates the whole entry and only THEN finds the size wrong.
  const ExcelJS: typeof import('exceljs') = require('exceljs');
  const alone = await new ExcelJS.Workbook().xlsx.readFile(file(lying)).then(() => 'read', (e: Error) => e.message);
  ok('negative control: exceljs alone inflates to the end before it checks the size', /uncompressed data size mismatch/.test(alone), alone);
  const fits = zip(workbook(CELLS, [{ name: 'xl/media/pad.bin', data: Buffer.alloc(1 << 20) }]));
  ok('negative control: the same entry, declared truthfully and under the budget, parses', (await outcome(fits)) === 'rows=1 cols=2');
  const tooMany = zip(workbook(CELLS, Array.from({ length: 10_001 }, (_, i) => ({ name: `xl/media/m${i}.bin`, data: Buffer.from('x') }))));
  ok('more than 10,000 entries is refused', refusal.test(await outcome(tooMany)));
  // JSZip takes the LAST end-record signature: one inside the comment must not point it elsewhere.
  const forged = zip(workbook(CELLS), Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(4)]));
  ok('a second end-of-directory signature in the comment is refused', refusal.test(await outcome(forged)));
  ok('negative control: a plain comment parses', (await outcome(zip(workbook(CELLS), Buffer.from('made by a test')))) === 'rows=1 cols=2');
  ok('not a zip at all is refused with the same sentence', refusal.test(await outcome(Buffer.from('id,name\n1,a\n'))));

  // ── NV-49: the used range ─────────────────────────────────────────────────
  const t0 = Date.now();
  const sparse = await outcome(zip(workbook([['A1', 1], ['XFD2000', 2]])));
  ok('one far cell (XFD2000) is refused by the cell budget, quickly',
    /^This sheet spans 2,000 rows by 16,384 columns, more than the 20,000,000 cells/.test(sparse) && Date.now() - t0 < 5000, sparse);
  ok('negative control: a sparse range inside the budget parses, gaps empty',
    (await outcome(zip(workbook([['A1', 1], ['Z100', 2]])))) === 'rows=99 cols=26');
  ok('the budget is the table cap\'s shape', MAX_XLSX_CELLS === 20_000_000);

  // ── NV-49, inside exceljs: ranges it expands one object per cell while it loads ──
  const ranges = /^This Excel file cannot be imported: its merged cells, data validation or column settings cover more than 20,000,000 cells/;
  const sheet = (tail: string) => outcome(zip(workbook(CELLS, [], false, tail)));
  const t1 = Date.now();
  const merge = await sheet('<mergeCells count="1"><mergeCell ref="A1:XFD2000"/></mergeCells>');
  ok('a merge of A1:XFD2000 (33M cells) is refused before exceljs loads it', ranges.test(merge) && Date.now() - t1 < 5000, merge);
  ok('negative control: an ordinary merge parses', (await sheet('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')) === 'rows=1 cols=2');
  ok('a data validation over the whole sheet is refused', ranges.test(await sheet(
    '<dataValidations count="1"><dataValidation type="whole" sqref="C3 A1:XFD1048576"><formula1>1</formula1></dataValidation></dataValidations>')));
  ok('…and through a sheet-qualified range', ranges.test(await sheet(
    "<dataValidations count=\"1\"><dataValidation type=\"whole\" sqref=\"'My Sheet'!A1:XFD1048576\"><formula1>1</formula1></dataValidation></dataValidations>")));
  ok('negative control: a validation down one column parses', (await sheet(
    '<dataValidations count="1"><dataValidation type="whole" sqref="A2:A10000"><formula1>1</formula1></dataValidation></dataValidations>')) === 'rows=1 cols=2');
  ok('a column run to two billion is refused', ranges.test(await sheet('<cols><col min="1" max="2000000000" width="9"/></cols>')));
  ok('negative control: ordinary column widths parse', (await sheet('<cols><col min="1" max="5" width="9"/></cols>')) === 'rows=1 cols=2');
  ok('an entity inside a range is refused, never decoded twice', ranges.test(await sheet('<mergeCells count="1"><mergeCell ref="A1&#58;B2"/></mergeCells>')));
}

main()
  .then(() => finish())
  .catch((e) => { console.error(e); process.exit(1); });
