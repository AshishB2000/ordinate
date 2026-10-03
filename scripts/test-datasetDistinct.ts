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
import * as dp from '../src/engine/datasetPage';
import * as pq from '../src/engine/parquetStore';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';

import { ok, failureCount } from './selfcheck';

async function main(): Promise<void> {

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
async function differential(label: string, f: Fixture, column: string, limit: number): Promise<void> {
  const js = dp.distinctValuesJs(f.columns, f.rows, column, limit);
  const sql = await dp.readDistinct(f.src, column, limit);
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
await differential('resident matches JS on a plain column', f1, 'city', 200);
await differential('resident matches JS on a number-typed column', f1, 'amount', 200);

ok('unknown column → JS gives []', same(dp.distinctValuesJs(f1.columns, f1.rows, 'nope', 200), []));
ok('unknown column → resident falls back (null), never a wrong []', await dp.readDistinct(f1.src, 'nope', 200) === null);

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
await differential('resident agrees on the emptiness rule', f2, 'v', 200);

// ── §3 order is first-seen, not sorted (rule 2) ──────────────────────────────

const f3 = fixture([{ name: 'v', type: 'text' }], [['zebra'], ['apple'], ['mango'], ['apple'], ['zebra']]);

ok('JS: NOT alphabetical — insertion order', same(dp.distinctValuesJs(f3.columns, f3.rows, 'v', 200), ['zebra', 'apple', 'mango']));
await differential('resident preserves first-seen order, not GROUP BY order', f3, 'v', 200);

// ── §4 the cap counts outputs, not rows (rule 3) ─────────────────────────────

const manyRows: Cell[][] = [];
for (let i = 0; i < 500; i += 1) manyRows.push([`v${i % 37}`]); // 37 distinct over 500 rows
const f4 = fixture([{ name: 'v', type: 'text' }], manyRows);

ok('JS: 37 distinct from 500 rows, under the cap', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 200).length === 37);
ok('JS: cap truncates to exactly the cap', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 10).length === 10);
await differential('resident matches under the cap', f4, 'v', 200);
await differential('resident matches AT the cap', f4, 'v', 10);
await differential('resident matches at cap 1', f4, 'v', 1);

ok('JS: cap 0 → []', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 0).length === 0);
ok('resident: cap 0 → [] (not a fallback)', same(await dp.readDistinct(f4.src, 'v', 0), []));
ok('cap is clamped to MAX_DISTINCT', dp.distinctValuesJs(f4.columns, f4.rows, 'v', 10_000).length <= dp.MAX_DISTINCT);

// ── §5 leading zeros survive (the landmine this whole layer exists for) ──────

const f5 = fixture([{ name: 'zip', type: 'text' }], [['007'], ['00210'], ['007'], ['90210']]);

ok('JS: "007" stays a string, not 7', same(dp.distinctValuesJs(f5.columns, f5.rows, 'zip', 200), ['007', '00210', '90210']));
await differential('resident does not turn "007" into 7', f5, 'zip', 200);

// ── §6 an all-empty column yields [], not a fallback ─────────────────────────

const f6 = fixture([{ name: 'v', type: 'text' }], [[null], [''], [null]]);
ok('JS: all-empty → []', same(dp.distinctValuesJs(f6.columns, f6.rows, 'v', 200), []));
if (resident) ok('resident: all-empty → [] (a real answer, not null)', same(await dp.readDistinct(f6.src, 'v', 200), []));
else ok('resident: all-empty (bridge down — skipped)', true);

// ── §7 the searched page: server-side search + the pre-cap total ─────────────
//
// The filter dialog's checkbox list needs both. The search MUST run in SQL — a
// high-cardinality text column on a 1,000,000-row dataset can have hundreds of
// thousands of distinct values, and fetching them all to filter in the renderer
// is exactly the pattern that capped datasets at 50k before this module existed.
// `total` is what lets the UI say "showing the first 200 of 4,812" rather than
// implying 200 is all there is.

/** Same differential idea as above, over the {values,total} pair. */
async function differentialPage(label: string, f: Fixture, column: string, req: any): Promise<void> {
  const js = dp.distinctValuesPageJs(f.columns, f.rows, column, req);
  const sql = await dp.readDistinctPage(f.src, column, req);
  if (sql === null) {
    ok(label + ' (bridge down — JS path only)', true);
    return;
  }
  ok(label, same(sql.values, js.values) && Object.is(sql.total, js.total));
}

const f7 = fixture([{ name: 'v', type: 'text' }], [
  ['California'], ['Washington'], ['New York'], ['california'],
  ['Carolina'], ['Washington'], ['Texas'], [null], [''],
]);

{
  const all = dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', {});
  ok('JS: no search → every distinct value, total === length',
    all.values.length === 6 && all.total === 6);

  // Case-INSENSITIVE substring, matching what a search box means to a user.
  const cal = dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: 'cal' });
  ok('JS: search is a case-insensitive substring match',
    same(cal.values, ['California', 'california']) && cal.total === 2);
  ok('JS: a mid-word match counts too (Carolina has no "cal", "lina" does)',
    dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: 'LINA' }).total === 1);
  ok('JS: a search matching nothing is an empty list with total 0',
    dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: 'zzz' }).total === 0);
  ok('JS: a blank search is not a filter',
    dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: '' }).total === 6);

  // THE POINT OF `total`: the cap truncates `values` but NOT the count.
  const capped = dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { limit: 2 });
  ok('JS: total is the PRE-cap count, so truncation is never silent',
    capped.values.length === 2 && capped.total === 6);
  // …and it is the count AFTER the search, not of the whole column.
  const both = dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: 'a', limit: 1 });
  ok('JS: total counts search matches, not the whole column',
    both.values.length === 1 && both.total === 5);
  ok('JS: a zero cap still reports the real total',
    dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { limit: 0 }).total === 6);
}

await differentialPage('resident matches JS with no search', f7, 'v', {});
await differentialPage('resident matches JS on a search', f7, 'v', { search: 'cal' });
await differentialPage('resident matches JS on an upper-case search', f7, 'v', { search: 'WASH' });
await differentialPage('resident matches JS on a no-match search', f7, 'v', { search: 'zzz' });
await differentialPage('resident matches JS on a blank search', f7, 'v', { search: '' });
await differentialPage('resident matches JS when the cap truncates', f7, 'v', { limit: 2 });
await differentialPage('resident matches JS on search + cap together', f7, 'v', { search: 'a', limit: 1 });
await differentialPage('resident matches JS at a zero cap', f7, 'v', { limit: 0 });
await differentialPage('resident matches JS on the emptiness rule', f2, 'v', { search: '' });
await differentialPage('resident matches JS searching a number-typed column', f1, 'amount', { search: '0' });

// The search is untrusted input from a text box: it must stay a bound parameter.
{
  const evil = "' OR 1=1 --";
  const js = dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { search: evil });
  const sql = await dp.readDistinctPage(f7.src, 'v', { search: evil });
  ok('a SQL-shaped search term matches nothing rather than executing',
    js.total === 0 && (sql === null || sql.total === 0));
  const quote = await dp.readDistinctPage(f7.src, 'v', { search: "'" });
  ok("a lone quote is a search term, not a syntax error", quote !== null && quote.total === 0);
}

// The cap can never be raised past MAX_DISTINCT by the caller — the ceiling is
// the module's, not the renderer's.
{
  const over = dp.distinctValuesPageJs(f4.columns, f4.rows, 'v', { limit: 10_000 });
  ok('JS: a caller cannot request more than MAX_DISTINCT', over.values.length <= dp.MAX_DISTINCT);
  await differentialPage('resident honours the same ceiling', f4, 'v', { limit: 10_000 });
}

// readDistinct is now a thin wrapper — assert it still answers identically, so
// the existing `dataset:distinct` callers are provably unaffected.
{
  const wrapped = await dp.readDistinct(f7.src, 'v', 200);
  const paged = await dp.readDistinctPage(f7.src, 'v', { limit: 200 });
  ok('readDistinct still equals readDistinctPage().values',
    (wrapped === null && paged === null) || (paged !== null && same(wrapped, paged.values)));
  ok('distinctValuesJs still equals distinctValuesPageJs().values',
    same(dp.distinctValuesJs(f7.columns, f7.rows, 'v', 200),
      dp.distinctValuesPageJs(f7.columns, f7.rows, 'v', { limit: 200 }).values));
}

// ─────────────────────────────────────────────────────────────────────────────

cleanup();
if (failureCount() > 0) {
  console.error(`\n${failureCount()} check(s) failed`);
  process.exit(1);
}
console.log('\nAll datasetDistinct checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
