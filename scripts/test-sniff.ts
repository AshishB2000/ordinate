// Self-check for src/data/sniff.ts — what a dropped file REALLY is, by content.
//
// The extension never enters: every case below is bytes only, which is the
// point — a `.csv` that is a PNG, a `.json` that is CSV and a renamed program
// are told apart here or not at all.
//
//   npm run build:ts && node scripts/test-sniff.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { sniffBytes, classifyJson, classifyZip, zipNames, csvDelimiter, utf8, HEAD_BYTES } from '../src/data/sniff';

const zlib: typeof import('zlib') = require('zlib');

/** Sniff a whole in-memory file the way main reads one: head + tail + size. */
function sniff(buf: Buffer): ReturnType<typeof sniffBytes> {
  return sniffBytes(buf.subarray(0, HEAD_BYTES), buf.subarray(Math.max(0, buf.length - 256 * 1024)), buf.length);
}
const kind = (buf: Buffer): string => { const s = sniff(buf); return s.ok ? s.kind : 'refused: ' + s.reason; };

/** A minimal STORED zip holding `names` — enough for the central directory. */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const data = Buffer.from('x');
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(zlib.crc32(data) >>> 0, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(zlib.crc32(data) >>> 0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ── Delimited text ──────────────────────────────────────────────────────────
const csv = Buffer.from('region,sku,amount\nWest,007,12\nEast,008,-3\n');
ok('csv: a comma table is csv', kind(csv) === 'csv');
const tsv = sniff(Buffer.from('a\tb\tc\n1\t2\t3\n4\t5\t6\n'));
ok('csv: a tab table is csv with a tab delimiter', tsv.ok && tsv.kind === 'csv' && tsv.delimiter === '\t', JSON.stringify(tsv));
const semi = sniff(Buffer.from('a;b\n1,5;2\n3,5;4\n'));
ok('csv: a semicolon table (decimal commas) picks ; — the consistent one', semi.ok && semi.kind === 'csv' && semi.delimiter === ';', JSON.stringify(semi));
ok('csv: a UTF-8 BOM is fine', kind(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv])) === 'csv');
ok('csv: CRLF line ends are fine', kind(Buffer.from('a,b\r\n1,2\r\n3,4\r\n')) === 'csv');
ok('csv: a quoted field holding commas and a newline still counts as one field',
  kind(Buffer.from('name,note\n"Smith, J","line one\nline two"\nLee,ok\n')) === 'csv');
ok('csv: one column with no delimiter at all is a single-column csv', kind(Buffer.from('id\n001\n002\n003\n')) === 'csv');
ok('csv: a header-only file is still a table', kind(Buffer.from('a,b,c\n')) === 'csv');
ok('csv: prose whose lines split differently is refused', !sniff(Buffer.from('Hello, world.\nThis line, has, three commas.\nNone here\nAnd, one\nAgain, two, here\n')).ok);
ok('csv: a JSON-named file holding CSV is csv — the name never counts', kind(Buffer.from('city,visits\nOslo,10\n')) === 'csv');
ok('csvDelimiter: inconsistent rows → null', csvDelimiter('a,b,c\n1\n2,3,4,5\n6\n', true) === null);

// ── Refusals ────────────────────────────────────────────────────────────────
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const pngVerdict = sniff(png);
ok('refuse: a .csv that is really a PNG says it is a PNG image', !pngVerdict.ok && /PNG image/.test(pngVerdict.reason), JSON.stringify(pngVerdict));
ok('refuse: a JPEG', /JPEG/.test(kind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))));
ok('refuse: a PDF', /PDF/.test(kind(Buffer.from('%PDF-1.7\n...'))));
ok('refuse: a renamed Mach-O program', /program/.test(kind(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))));
ok('refuse: a renamed ELF program', /program/.test(kind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))));
ok('refuse: a renamed Windows program', /program/.test(kind(Buffer.from('MZ\x90\x00\x03'))));
ok('refuse: NUL bytes in otherwise-text bytes', /binary/.test(kind(Buffer.from('a,b\n1,\u00002\n'))));
ok('refuse: invalid UTF-8', /UTF-8/.test(kind(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xc3, 0x28, 0x2c, 0x31, 0x0a]))));
ok('refuse: an empty file', /empty/.test(kind(Buffer.alloc(0))));
ok('refuse: whitespace only', /empty/.test(kind(Buffer.from('  \n\n '))));
ok('refuse: an old .xls (OLE) names the fix', /xlsx/.test(kind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))));
ok('refuse: gzip', /gzip/.test(kind(Buffer.from([0x1f, 0x8b, 8, 0]))));

// ── UTF-8 cut mid-character ────────────────────────────────────────────────
const euro = Buffer.from('a,b\n€,1\n', 'utf8');
const cut = euro.subarray(0, euro.indexOf(0xe2) + 2); // mid-way through '€'
ok('utf8: a head cut mid-character drops the partial char, not the verdict', utf8(cut, false) === 'a,b\n');
ok('utf8: the same bytes as a WHOLE file are invalid', utf8(cut, true) === null);

// ── Parquet ────────────────────────────────────────────────────────────────
const parquet = Buffer.concat([Buffer.from('PAR1'), Buffer.alloc(64, 7), Buffer.from('PAR1')]);
ok('parquet: PAR1 at both ends', kind(parquet) === 'parquet');
ok('parquet: PAR1 head without the tail is a damaged file', /damaged Parquet/.test(kind(Buffer.concat([Buffer.from('PAR1'), Buffer.alloc(64, 7)]))));

// ── ZIP: workbook, bundle, neither ─────────────────────────────────────────
const xlsx = zip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
const xs = sniff(xlsx);
ok('zip: an xlsx sniffs as a zip with its entry names', xs.ok && xs.kind === 'zip' && Array.isArray(xs.names) && xs.names.length === 4, JSON.stringify(xs));
ok('zip: those names classify as a workbook', xs.ok && xs.kind === 'zip' && classifyZip(xs.names) === 'xlsx');
const bundleZip = zip(['manifest.json', 'project.json', 'datasets/x.json']);
ok('zip: manifest + project.json is a bundle candidate', classifyZip(zipNames(bundleZip, bundleZip.length)) === 'bundle');
const docx = zip(['[Content_Types].xml', 'word/document.xml']);
ok('zip: a .docx (no xl/workbook.xml) is neither', classifyZip(zipNames(docx, docx.length)) === null);
const big = zip(['[Content_Types].xml', 'xl/workbook.xml']);
ok('zip: a central directory outside the tail is reported as unknown (null), not guessed', zipNames(big.subarray(big.length - 30), big.length) === null);
ok('zip: a truncated zip with no end record → null', zipNames(Buffer.from('PK\u0003\u0004junk'), 10) === null);

// ── JSON: records, GeoJSON, template, refusals ────────────────────────────
ok('json: an array of records', kind(Buffer.from('[{"a":1},{"a":2}]')) === 'json');
ok('json: leading whitespace and a BOM', kind(Buffer.from('﻿  \n[{"a":1}]')) === 'json');
ok('classifyJson: records', JSON.stringify(classifyJson('[{"a":1}]')) === '{"ok":true,"kind":"json"}');
ok('classifyJson: a 2D array is records', classifyJson('[["a","b"],[1,2]]').ok);
ok('classifyJson: a FeatureCollection is GeoJSON', JSON.stringify(classifyJson('{"type":"FeatureCollection","features":[]}')) === '{"ok":true,"kind":"geojson"}');
ok('classifyJson: a bare Polygon is GeoJSON', (classifyJson('{"type":"Polygon","coordinates":[]}') as any).kind === 'geojson');
ok('classifyJson: an Ordinate template manifest', (classifyJson('{"format":"ordinate-template","name":"x"}') as any).kind === 'template');
ok('classifyJson: an object of fields is one record', (classifyJson('{"a":1,"b":"x"}') as any).kind === 'json');
ok('classifyJson: broken JSON is refused', !classifyJson('[{"a":1},').ok);
ok('classifyJson: a list of numbers is not records', !classifyJson('[1,2,3]').ok);
ok('classifyJson: an empty list is refused', !classifyJson('[]').ok);
ok('classifyJson: a bare string is refused', !classifyJson('"hello"').ok);

finish();
