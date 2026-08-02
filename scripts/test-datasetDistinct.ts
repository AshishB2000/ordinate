'use strict';

// Self-check for src/datasetPage.ts's `readDistinct` / `distinctValuesJs` — the
// column-value list behind the dashboard filter pickers.
//
// DIFFERENTIAL, like test-datasetPage.ts: `readDistinct` exists only to produce
// what the renderer's old `distinctColumnOptions` loop produced, so the answer
// is compared against `distinctValuesJs` (the verbatim transcription of that
// loop) over the SAME bytes read back from Parquet — never against a
// hand-written list, which could agree with a bug in both.
//
// Three rules this pins that are easy to "improve" into a bug:
//   1. Empty here is ONLY null and ''. A whitespace-only value IS a legitimate
//      option. That differs from the whitespace rule used elsewhere in the
//      resident layer, and it matches the JS original, which is what matters.
//   2. First-seen order, not sorted and not GROUP BY order — a bare GROUP BY
//      does not preserve insertion order and whether it reorders is
//      machine-dependent.
//   3. The cap counts DISTINCT OUTPUTS, not rows scanned.
//
//   npm run build:ts && node scripts/test-datasetDistinct.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dp from '../src/datasetPage';
import * as pq from '../src/parquetStore';
import type { ParsedColumn } from '../src/parse';
import type { Cell } from '../src/transforms';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-distinct-'));
let seq = 0;
function tmpFile(): string {
  seq += 1;
  return path.join(dir, `d${seq}.parquet`);
}
function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp dir that will not delete is not a test failure */
  }
}

interface Fixture {
  src: dp.PageSource;
  columns: ParsedColumn[];
  rows: Cell[][];
}

function fixture(columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = tmpFile();
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, columns: back.columns, rows: back.rows };
}

// Object.is elementwise, so '' can never pass as null.
function same(a: string[] | null, b: string[]): boolean {
  if (a === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Assert the resident answer equals the JS reference, when the bridge is up. */
function differential(label: string, f: Fixture, column: string, limit: number): void {
  const js = dp.distinctValuesJs(f.columns, f.rows, column, limit);
  const sql = dp.readDistinct(f.src, column, limit);
  if (sql === null) {
    // null ALWAYS means "fall back", never "no values" — the caller keeps the JS
    // path, so this is not a failure, just an unexercised comparison.
    ok(label + ' (bridge down — JS path only)', true);
    return;
  }
  ok(label, same(sql, js));
}

const resident = dp.isPageResident();
console.log(resident ? '# DuckDB bridge available — differential' : '# no bridge — JS reference only');

// ── §1 the basics ────────────────────────────────────────────────────────────

const cols: ParsedColumn[] = [
  { name: 'city', type: 'text' },
  { name: 'amount', type: 'number' },
];

const f1 = fixture(cols, [
  ['Oslo', '10'],
  ['Bergen', '20'],
  ['Oslo', '30'],
  ['Tromso', '40'],
  ['Bergen', '50'],
]);

ok('JS: dedupes, first-seen order', same(dp.distinctValuesJs(f1.columns, f1.rows, 'city', 200), ['Oslo', 'Bergen', 'Tromso']));
differential('resident matches JS on a plain column', f1, 'city', 200);
differential('resident matches JS on a number-typed column', f1, 'amount', 200);

ok('unknown column → JS gives []', same(dp.distinctValuesJs(f1.columns, f1.rows, 'nope', 200), []));
ok('unknown column → resident falls back (null), never a wrong []', dp.readDistinct(f1.src, 'nope', 200) === null);

// ── §2 emptiness: ONLY null and '' (rule 1) ──────────────────────────────────

const f2 = fixture([{ name: 'v', type: 'text' }], [
  ['a'],
  [null],
  [''],
  ['   '],
  ['\t'],
  ['a'],
  ['b'],
]);

const js2 = dp.distinctValuesJs(f2.columns, f2.rows, 'v', 200);
ok('JS: null and "" dropped; whitespace-only KEPT', same(js2, ['a', '   ', '\t', 'b']));
ok('JS: "" is not in the output', js2.indexOf('') === -1);
differential('resident agrees on the emptiness rule', f2, 'v', 200);

// ── §3 order is first-seen, not sorted (rule 2) ──────────────────────────────

const f3 = fixture([{ name: 'v', type: 'text' }], [['zebra'], ['apple'], ['mango'], ['apple'], ['zebra']]);

ok('JS: NOT alphabetical — insertion order', same(dp.distinctValuesJs(f3.columns, f3.rows, 'v', 200), ['zebra', 'apple', 'mango']));
differential('resident preserves first-seen order, not GROUP BY order', f3, 'v', 200);

// ── §4 the cap counts outputs, not rows (rule 3) ─────────────────────────────

const manyRows: Cell[][] = [];
for (let i = 0; i < 500; i += 1) manyRows.push([`v${i % 37}`]); // 37 distinct over 500 rows
const f4 = fixture([{ name: 'v', type: 'text' }], manyRows);

ok('JS: 37 distinct from 500 rows, under the cap', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 200).length === 37);
ok('JS: cap truncates to exactly the cap', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 10).length === 10);
differential('resident matches under the cap', f4, 'v', 200);
differential('resident matches AT the cap', f4, 'v', 10);
differential('resident matches at cap 1', f4, 'v', 1);

ok('JS: cap 0 → []', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 0).length === 0);
ok('resident: cap 0 → [] (not a fallback)', same(dp.readDistinct(f4.src, 'v', 0), []));
ok('cap is clamped to MAX_DISTINCT', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 10_000).length <= dp.MAX_DISTINCT);

// ── §5 leading zeros survive (the landmine this whole layer exists for) ──────

const f5 = fixture([{ name: 'zip', type: 'text' }], [['007'], ['00210'], ['007'], ['90210']]);

ok('JS: "007" stays a string, not 7', same(dp.distinctValuesJs(f5.columns, f5.rows, 'zip', 200), ['007', '00210', '90210']));
differential('resident does not turn "007" into 7', f5, 'zip', 200);

// ── §6 an all-empty column yields [], not a fallback ─────────────────────────

const f6 = fixture([{ name: 'v', type: 'text' }], [[null], [''], [null]]);
ok('JS: all-empty → []', same(dp.distinctValuesJs(f6.columns, f6.rows, 'v', 200), []));
if (resident) ok('resident: all-empty → [] (a real answer, not null)', same(dp.readDistinct(f6.src, 'v', 200), []));
else ok('resident: all-empty (bridge down — skipped)', true);

// ─────────────────────────────────────────────────────────────────────────────

cleanup();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll datasetDistinct checks passed');
