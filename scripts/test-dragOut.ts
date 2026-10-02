// Self-check for src/app/dragOut.ts — the files a drag OUT of the app carries:
// the dataset CSV (RFC 4180, formula-injection safe), safe temp file names, the
// per-drag folder, and the PNG a chart hands over.
//
//   npm run build:ts && node scripts/test-dragOut.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { csvField, csvOf, safeFileName, writeDragFile, clearDragDir, pngFromDataUrl } from '../src/app/dragOut';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// ── RFC 4180 ────────────────────────────────────────────────────────────────
ok('csv: a plain field is bare', csvField('West') === 'West');
ok('csv: a comma is quoted', csvField('Smith, J') === '"Smith, J"');
ok('csv: a quote is doubled inside quotes', csvField('say "hi"') === '"say ""hi"""');
ok('csv: a newline is quoted', csvField('a\nb') === '"a\nb"');
ok('csv: leading/trailing spaces survive by quoting', csvField(' x ') === '" x "');
ok('csv: null and undefined are empty', csvField(null) === '' && csvField(undefined) === '');
ok('csv: leading zeros stay text', csvField('007') === '007');
ok('csv: a number is written plainly', csvField(1234.5) === '1234.5');
ok('csv: NaN / Infinity are empty, not "NaN"', csvField(NaN) === '' && csvField(Infinity) === '');

// ── Formula injection ───────────────────────────────────────────────────────
ok('inject: =formula gets a leading quote', csvField('=SUM(A1:A9)') === "'=SUM(A1:A9)");
ok('inject: +, - and @ too', csvField('+1') === "'+1" && csvField('-cmd') === "'-cmd" && csvField('@x') === "'@x");
ok('inject: a leading tab is guarded', csvField('\tx') === "'\tx");
ok('inject: =HYPERLINK with commas is guarded AND quoted', csvField('=HYPERLINK("http://x","y")') === '"\'=HYPERLINK(""http://x"",""y"")"');
ok('inject: a NEGATIVE NUMBER is a number, never prefixed', csvField(-12) === '-12');
ok('inject: an = in the middle is fine', csvField('a=b') === 'a=b');

const table = csvOf(['region', 'note', 'amount'], [['West', '=1+1', -3], ['East, North', null, 4], ['Short']]);
ok('csvOf: header, rows, CRLF, ragged rows padded', table === 'region,note,amount\r\nWest,\'=1+1,-3\r\n"East, North",,4\r\nShort,,\r\n', JSON.stringify(table));
ok('csvOf: a header that looks like a formula is guarded too', csvOf(['=x'], []) === "'=x\r\n");

// ── File names ──────────────────────────────────────────────────────────────
ok('name: an ordinary name is kept', safeFileName('Sales by region', 'Chart') === 'Sales by region');
ok('name: separators and reserved characters go', safeFileName('a/b\\c:d*e?f"g<h>i|j', 'x') === 'a b c d e f g h i j');
ok('name: no path traversal survives', !safeFileName('../../etc/passwd', 'x').includes('/') && !safeFileName('../../etc/passwd', 'x').startsWith('.'));
ok('name: control characters go', safeFileName('a\u0000b\u001fc', 'x') === 'a b c');
ok('name: a leading dot (hidden file) goes', safeFileName('.secret', 'x') === 'secret');
ok('name: empty falls back', safeFileName('', 'Chart') === 'Chart' && safeFileName(null, 'Data') === 'Data' && safeFileName('...', 'Data') === 'Data');
ok('name: Windows device names fall back', safeFileName('CON', 'Data') === 'Data' && safeFileName('lpt1', 'Data') === 'Data');
ok('name: capped at 80 characters', safeFileName('x'.repeat(300), 'y').length === 80);

// ── The per-drag folder ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dragout-')), 'ordinate-drag');
  const a = await writeDragFile(dir, 'Sales / Q1', 'csv', 'a,b\r\n');
  const b = await writeDragFile(dir, 'Sales / Q1', 'csv', 'c,d\r\n');
  ok('write: the file the user sees has the clean name', path.basename(a) === 'Sales Q1.csv', a);
  ok('write: two same-named drags never share a file', a !== b && fs.readFileSync(a, 'utf8') === 'a,b\r\n' && fs.readFileSync(b, 'utf8') === 'c,d\r\n');
  ok('write: it lands inside the drag folder', path.dirname(path.dirname(a)) === dir);
  ok('write: no temp file is left behind', fs.readdirSync(path.dirname(a)).length === 1);
  clearDragDir(dir);
  ok('clear: the next launch removes every old drag file', !fs.existsSync(dir));
  clearDragDir(dir);
  ok('clear: clearing an absent folder is a no-op', !fs.existsSync(dir));

  // ── The chart PNG ──
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const url = 'data:image/png;base64,' + pngBytes.toString('base64');
  ok('png: a PNG data URL decodes to its bytes', !!pngFromDataUrl(url, 1024) && pngFromDataUrl(url, 1024)!.equals(pngBytes));
  ok('png: a JPEG data URL is refused', pngFromDataUrl('data:image/jpeg;base64,' + pngBytes.toString('base64'), 1024) === null);
  ok('png: bytes that are not a PNG under a PNG label are refused', pngFromDataUrl('data:image/png;base64,' + Buffer.from('<svg/>').toString('base64'), 1024) === null);
  ok('png: over the size cap is refused', pngFromDataUrl(url, 4) === null);
  ok('png: not a string is refused', pngFromDataUrl({}, 1024) === null);
  finish();
}

void main();
