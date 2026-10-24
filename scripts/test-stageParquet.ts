// A staged import round-trips through Parquet EXACTLY (src/data/stageCodec.ts,
// src/engine/parquetStore.ts `encodeCell` / `limit`; docs/any-pod/00-design.md §3.4).
//
//   1. DIFFERENTIAL: a nasty table written with the stage codec and read back
//      equals the in-memory table, Object.is on every cell — `-0`, `007`, 1e21,
//      0.1+0.2, '', null, whitespace, NBSP, tab, a leading BOM, a lone surrogate,
//      U+0000, emoji, a long string — and the metadata (column names with quotes,
//      newlines, U+0000 and a lone surrogate; types; rowCount; warnings;
//      sheetNames) round-trips byte for byte; a limited read is its first rows;
//   2. the edge tables: 0 columns × N rows, N columns × 0 rows, 1,000 columns;
//   3. one 20 MB row goes through the stage writer AND the dataset writer
//      (past read_json's default 16 MB maximum_object_size);
//   4. NEGATIVE CONTROL: the same table through the dataset encoding (no tags)
//      is NOT equal — the fixture bites;
//   5. a cell that is not a string, a number or null is refused before a write.
//
// STAGE_MEASURE=1 also times a 1M × 10 and a 20k × 1,000 table (write + read).
//
//   npm run build:ts && node scripts/test-stageParquet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const codec: typeof import('../src/data/stageCodec') = require('../src/data/stageCodec');

type Cell = import('../src/data/transforms').Cell;
type Col = import('../src/data/parse').ParsedColumn;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-stage-'));
let n = 0;
const file = (): string => path.join(TMP, `t${n++}.parquet`);

const LONE = 'a\uD800b';
const NASTY: Cell[] = ['007', -0, 0, NaN, Infinity, -Infinity, 1e21, 0.1 + 0.2, -1.5e-300, '', null, ' ', ' x ', '\tx\t', '﻿bom', '﻿﻿', LONE, 'nul\u0000inside', '😀 é', 'x'.repeat(5_000), 'n123', 's', 'j"', 42, Number.MAX_SAFE_INTEGER + 2, '-0'];
const COLS: Col[] = [
  { name: 'Name "X"', type: 'text' }, { name: 'line\nbreak', type: 'number' }, { name: '', type: 'date' },
  { name: 'nul\u0000name', type: 'text' }, { name: LONE, type: 'text' }, { name: 'Name "X"', type: 'number' },
];

/** A width × height table whose cells cycle through NASTY. */
function table(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => NASTY[(r * 7 + c) % NASTY.length]));
}
const same = (a: Cell[][], b: Cell[][]): boolean => a.length === b.length && a.every((row, r) => row.length === b[r].length && row.every((v, c) => Object.is(v, b[r][c])));

async function roundTrip(columns: Col[], rows: Cell[][], limit?: number): Promise<Cell[][] | null> {
  const f = file();
  await parquetStore.writeTableAsync(f, columns, rows, { encodeCell: codec.encodeCell });
  const read = await parquetStore.readTableAsync(f, undefined, limit);
  return read ? codec.decodeRows(read.rows) : null;
}

(async () => {
  // 1. The differential.
  const rows = table(COLS.length, 400);
  const back = await roundTrip(COLS, rows);
  ok('DIFFERENTIAL: every cell comes back Object.is-equal (−0, 007, a BOM, a lone surrogate, NUL, …)', !!back && same(back, rows));
  const first = await roundTrip(COLS, rows, 37);
  ok('a limited read is exactly the first rows, in order', !!first && same(first, rows.slice(0, 37)));
  const meta = { columns: COLS, rowCount: rows.length, warnings: ['Ragged rows — padded to 6 columns', LONE], sheetNames: ['Sheet "1"', 'nul\u0000'] };
  const stored = JSON.stringify({ v: 1, table: meta });
  const metaBack = (JSON.parse(stored) as { table: typeof meta }).table;
  ok('the metadata round-trips through the row\'s text: names with quotes, newlines, U+0000 and a lone surrogate; types; counts; warnings; sheets',
    JSON.stringify(metaBack) === JSON.stringify(meta) && metaBack.columns.every((c, i) => Object.is(c.name, COLS[i].name) && c.type === COLS[i].type) && !stored.includes('\u0000'));

  // 2. Edge tables.
  const empty: Cell[][] = Array.from({ length: 9 }, () => []);
  const noCols = await roundTrip([], empty);
  ok('0 columns × 9 rows keeps its 9 rows', !!noCols && noCols.length === 9 && noCols.every((r) => r.length === 0));
  const noRows = await roundTrip(COLS, []);
  ok('6 columns × 0 rows is an empty table', !!noRows && noRows.length === 0);
  const wideCols = Array.from({ length: 1_000 }, (_, i): Col => ({ name: `c${i}`, type: i % 2 ? 'number' : 'text' }));
  const wide = table(1_000, 20);
  const wideBack = await roundTrip(wideCols, wide);
  ok('1,000 columns × 20 rows round-trips exactly', !!wideBack && same(wideBack, wide));

  // 3. One 20 MB row, through both writers.
  const huge: Cell[][] = [['y'.repeat(20 * 1024 * 1024), 1]];
  const hugeCols: Col[] = [{ name: 'big', type: 'text' }, { name: 'n', type: 'number' }];
  const hugeBack = await roundTrip(hugeCols, huge).catch((e: Error) => e.message);
  ok('a 20 MB row through the stage writer (past read_json\'s default 16 MB object cap)', Array.isArray(hugeBack) && same(hugeBack, huge), typeof hugeBack === 'string' ? hugeBack.slice(0, 200) : '');
  const ds = file();
  const dsErr = await parquetStore.writeTableAsync(ds, hugeCols, huge).then(() => '', (e: Error) => e.message);
  const dsBack = dsErr ? null : await parquetStore.readTableAsync(ds, hugeCols);
  ok('…and through the dataset writer', !dsErr && !!dsBack && dsBack.rows[0][0] === huge[0][0], dsErr.slice(0, 200));

  // 4. NEGATIVE CONTROL: the dataset encoding (String(cell) + the declared type) is not exact.
  const plain = file();
  await parquetStore.writeTableAsync(plain, COLS, rows);
  const plainBack = await parquetStore.readTableAsync(plain, COLS);
  ok('NEGATIVE CONTROL: the dataset encoding loses −0, numbers in text columns and the lone surrogate — the fixture bites',
    !!plainBack && !same(plainBack.rows, rows) && plainBack.rows.flat().every((v) => v !== LONE));

  // 5. The stage contract.
  const refused = (fn: () => unknown): boolean => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
  ok('a boolean, a Date or an object cell is refused before anything is written', [true, new Date(0), {}].every((v) => refused(() => codec.checkCells([[v as unknown as Cell]])) && refused(() => codec.encodeCell(v as unknown as Cell))));

  if (process.env.STAGE_MEASURE === '1') {
    for (const [w, h] of [[10, 1_000_000], [1_000, 20_000]] as const) {
      const cols = Array.from({ length: w }, (_, i): Col => ({ name: `c${i}`, type: i % 2 ? 'number' : 'text' }));
      const big = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c): Cell => (c % 2 ? r * 1.5 + c : `v${r}-${c}`)));
      const f = file();
      const t0 = Date.now();
      await parquetStore.writeTableAsync(f, cols, big, { encodeCell: codec.encodeCell });
      const t1 = Date.now();
      const read = await parquetStore.readTableAsync(f);
      if (read) codec.decodeRows(read.rows);
      const t2 = Date.now();
      console.log(`measure: ${h.toLocaleString('en-US')} × ${w}: write ${t1 - t0} ms, read ${t2 - t1} ms, ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
    }
  }
})()
  .catch((err) => ok('the suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
