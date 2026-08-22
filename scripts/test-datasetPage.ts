'use strict';

// Self-check for src/datasetPage.ts — the server-side paged read that replaces
// the Explore grid's "hold the whole table in the renderer" model.
//
// This suite is DIFFERENTIAL by design. `readPage`'s only job is to produce the
// same window the shipped grid produces, so almost nothing here is asserted
// against a hand-written expectation: a fixture is written with
// `parquetStore.writeTable`, read back with `parquetStore.readTable`, and the
// resident page is compared to `pageRowsJs` — the verbatim transcription of
// `renderer/hub/datasets.ts`'s `explorerDisplayRows` + `sortCompare` — over
// those exact rows. A hand-written expectation can agree with a bug in both
// implementations; an equivalence assertion cannot.
//
// The few non-differential assertions are the ones the reference implementation
// cannot state about itself: that the unsorted page IS `rows.slice(offset,
// offset + limit)` of the stored table, that paging a many-ties sort is a
// PERMUTATION of the table (the bug an unstable sort causes), that '007' is not
// read as 7, and the measured timings past the current 50,000-row cap.
//
//   npm run build:ts && node scripts/test-datasetPage.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dp from '../src/engine/datasetPage';
import * as pq from '../src/engine/parquetStore';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';

import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-page-'));
let seq = 0;
function tmpFile(): string {
  return path.join(dir, `t${seq++}.parquet`);
}
function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── The differential harness ─────────────────────────────────────────────────
//
// A fixture is (columns, rows). `fixture()` writes it, reads it back, and hands
// back both the page source AND the hydrated table — so every comparison is
// against the SAME bytes, not against the in-memory array that went in.

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

// Object.is throughout, so '' can never compare equal to null and 0 can never
// compare equal to '' by coercion — the distinctions this storage layer exists
// to preserve.
function sameRows(a: Cell[][], b: Cell[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].length !== b[i].length) return false;
    for (let c = 0; c < a[i].length; c += 1) if (!Object.is(a[i][c], b[i][c])) return false;
  }
  return true;
}

/** readPage must equal pageRowsJs over the round-tripped rows, exactly. */
function diff(label: string, f: Fixture, req: dp.PageRequest): dp.PageResult | null {
  const want = dp.pageRowsJs(f.columns, f.rows, req);
  const got = dp.readPage(f.src, req);
  if (!got) {
    ok(`${label}: readPage returned a page`, false);
    return null;
  }
  ok(`${label}: total === pageRowsJs (${want.total})`, want.total === got.total);
  ok(`${label}: offset === pageRowsJs (${want.offset})`, want.offset === got.offset);
  ok(`${label}: rows === pageRowsJs (${want.rows.length} rows)`, sameRows(want.rows, got.rows));
  return got;
}

function show(rows: Cell[][], c: number): string {
  return JSON.stringify(rows.map((r) => r[c]));
}

// ─────────────────────────────────────────────────────────────────────────────

if (!dp.isPageResident()) {
  console.error('FAIL datasetPage: DuckDB bridge unavailable — nothing was verified');
  cleanup();
  process.exit(1);
}
ok('isPageResident(): true when the bridge is up', dp.isPageResident() === true);

// ── 1. The unsorted, unsearched page IS rows.slice(offset, offset + limit) ───
//
// The one assertion `pageRowsJs` cannot make about itself: that the DEFAULT
// order is file order, i.e. the order the grid shows today.
{
  const cols: ParsedColumn[] = [
    { name: 'city', type: 'text' },
    { name: 'pop', type: 'number' },
    { name: 'day', type: 'date' },
  ];
  const rows: Cell[][] = [];
  for (let i = 0; i < 137; i += 1) rows.push([`city-${i}`, i * 3, `2024-01-${(i % 28) + 1}`]);
  const f = fixture(cols, rows);

  for (const [offset, limit] of [[0, 10], [50, 10], [130, 10], [136, 10], [0, 500], [7, 1]]) {
    const got = dp.readPage(f.src, { offset, limit });
    ok(
      `source order: offset ${offset} limit ${limit} === rows.slice()`,
      got !== null && sameRows(got.rows, f.rows.slice(offset, offset + limit)) && got.total === 137,
    );
    diff(`source order (${offset}/${limit})`, f, { offset, limit });
  }

  // Paging boundaries.
  const past = dp.readPage(f.src, { offset: 500, limit: 25 });
  ok('past the end: empty rows, real total', past !== null && past.rows.length === 0 && past.total === 137);
  ok('past the end: offset echoed back', past !== null && past.offset === 500);

  const all = dp.readPage(f.src, { offset: 0, limit: 1000 });
  ok('limit larger than the table returns the whole table', all !== null && all.rows.length === 137);

  const zero = dp.readPage(f.src, { offset: 0, limit: 0 });
  ok('limit 0: no rows, real total', zero !== null && zero.rows.length === 0 && zero.total === 137);

  const clamped = dp.readPage(f.src, { offset: -5, limit: 9_999_999 });
  ok('negative offset clamps to 0', clamped !== null && clamped.offset === 0);
  ok(`limit clamps to MAX_LIMIT (${dp.MAX_LIMIT})`, clamped !== null && clamped.rows.length === 137);

  ok('non-finite offset → null (fall back)', dp.readPage(f.src, { offset: NaN, limit: 10 }) === null);
  ok('non-finite limit → null (fall back)', dp.readPage(f.src, { offset: 0, limit: Infinity }) === null);

  // Every page, concatenated, is the table.
  const seen: Cell[][] = [];
  for (let o = 0; o < 137; o += 20) {
    const p = dp.readPage(f.src, { offset: o, limit: 20 });
    if (p) seen.push(...p.rows);
  }
  ok('paging through in 20s reassembles the table exactly', sameRows(seen, f.rows));
}

// ── 2. Sorting: numeric column, both directions ─────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'name', type: 'text' },
    { name: 'score', type: 'number' },
  ];
  const f = fixture(cols, [
    ['e', 12],
    ['a', -3],
    ['d', null], // empty → sorts LAST in both directions
    ['b', 1000],
    ['c', 0],
    ['f', 7.5],
    ['g', null],
  ]);

  for (const dir of ['asc', 'desc'] as const) {
    const got = diff(`number sort ${dir}`, f, { offset: 0, limit: 10, sortColumn: 'score', sortDir: dir });
    if (got) console.log(`     score ${dir}: ${show(got.rows, 1)}`);
  }
  const asc = dp.readPage(f.src, { offset: 0, limit: 10, sortColumn: 'score', sortDir: 'asc' });
  ok('number asc: numeric, not lexical (-3 < 0 < 7.5 < 12 < 1000)',
    asc !== null && JSON.stringify(asc.rows.map((r) => r[1])) === JSON.stringify([-3, 0, 7.5, 12, 1000, null, null]));
  const desc = dp.readPage(f.src, { offset: 0, limit: 10, sortColumn: 'score', sortDir: 'desc' });
  ok('number desc: empties still last',
    desc !== null && JSON.stringify(desc.rows.map((r) => r[1])) === JSON.stringify([1000, 12, 7.5, 0, -3, null, null]));

  // Paged, sorted — the window must be the window of the SORTED table.
  diff('number sort, page 2', f, { offset: 2, limit: 3, sortColumn: 'score', sortDir: 'asc' });
  diff('number sort, past the end', f, { offset: 99, limit: 3, sortColumn: 'score', sortDir: 'desc' });
}

// ── 3. Sorting: text column, both directions ────────────────────────────────
//
// The grid compares with `localeCompare`, which is ICU collation: 'a' < 'B',
// 'é' < 'f', a leading space sorts early. DuckDB's DEFAULT comparison is BINARY
// and gets every one of those backwards, so this block is what pins `COLLATE en`.
{
  const cols: ParsedColumn[] = [{ name: 'label', type: 'text' }];
  const f = fixture(cols, [
    ['banana'],
    ['Apple'],
    ['apple'],
    [''], // empty → last
    ['é'],
    ['f'],
    ['B'],
    ['a'],
    [null], // empty → last
    ['  spaced'],
    ['_under'],
    ['Zebra'],
    ['zebra'],
    ['   '], // whitespace-only is a REAL value, not an empty
  ]);

  for (const dir of ['asc', 'desc'] as const) {
    const got = diff(`text sort ${dir}`, f, { offset: 0, limit: 50, sortColumn: 'label', sortDir: dir });
    if (got) console.log(`     label ${dir}: ${show(got.rows, 0)}`);
  }
  const asc = dp.readPage(f.src, { offset: 0, limit: 50, sortColumn: 'label', sortDir: 'asc' });
  ok("text asc: ICU collation, not byte order ('a' before 'B')",
    asc !== null && asc.rows.findIndex((r) => r[0] === 'a') < asc.rows.findIndex((r) => r[0] === 'B'));
  ok("text asc: accents collate ('é' before 'f')",
    asc !== null && asc.rows.findIndex((r) => r[0] === 'é') < asc.rows.findIndex((r) => r[0] === 'f'));
  ok('text asc: whitespace-only is a value, empty string is not',
    asc !== null && asc.rows.findIndex((r) => r[0] === '   ') < asc.rows.findIndex((r) => r[0] === ''));
  ok('text: null and \'\' both sort last, in both directions',
    asc !== null && asc.rows.slice(-2).every((r) => r[0] === '' || r[0] === null));

  // Paged text sort.
  for (const o of [0, 3, 6, 12, 20]) diff(`text sort page @${o}`, f, { offset: o, limit: 3, sortColumn: 'label', sortDir: 'asc' });

  // A date column sorts as text — the grid's `type !== 'number'` branch.
  const dcols: ParsedColumn[] = [{ name: 'day', type: 'date' }];
  const df = fixture(dcols, [['2024-03-01'], ['2023-12-31'], ['2024-01-15'], [null], ['2024-03-01']]);
  diff('date sort asc (lexical)', df, { offset: 0, limit: 10, sortColumn: 'day', sortDir: 'asc' });
  diff('date sort desc (lexical)', df, { offset: 0, limit: 10, sortColumn: 'day', sortDir: 'desc' });
}

// ── 4. Leading zeros: a TEXT column must never be cast to sort ──────────────
//
// `TRY_CAST('007' AS DOUBLE)` is 7. Sorting a text column numerically would
// collapse '007', '07' and '7' into one indistinguishable key — the exact bug
// `parquetStore` stores everything as VARCHAR to prevent.
{
  const cols: ParsedColumn[] = [{ name: 'id', type: 'text' }];
  const f = fixture(cols, [['7'], ['007'], ['70'], ['07'], ['0007'], ['10'], ['9']]);

  const asc = diff('leading-zero text sort asc', f, { offset: 0, limit: 10, sortColumn: 'id', sortDir: 'asc' });
  const desc = diff('leading-zero text sort desc', f, { offset: 0, limit: 10, sortColumn: 'id', sortDir: 'desc' });
  if (asc) console.log(`     id asc: ${show(asc.rows, 0)}`);

  ok('leading zeros survive the round trip as strings',
    asc !== null && asc.rows.every((r) => typeof r[0] === 'string'));
  ok("'007' is not read as 7", asc !== null && asc.rows.some((r) => r[0] === '007'));
  ok('all five distinct zero-padded ids are still distinct',
    asc !== null && new Set(asc.rows.map((r) => String(r[0]))).size === 7);
  // What the JS grid actually does: localeCompare on the digit STRINGS, so
  // '0007' < '007' < '07' < '10' < '7' < '70' < '9'.
  ok("'007' sorts before '07' (character-by-character, not numerically)",
    asc !== null && asc.rows.findIndex((r) => r[0] === '007') < asc.rows.findIndex((r) => r[0] === '07'));
  ok("'10' sorts before '9' (lexical, so not numeric order)",
    asc !== null && asc.rows.findIndex((r) => r[0] === '10') < asc.rows.findIndex((r) => r[0] === '9'));
  ok('desc is the exact reverse of asc',
    asc !== null && desc !== null &&
      JSON.stringify(desc.rows.map((r) => r[0])) === JSON.stringify(asc.rows.map((r) => r[0]).reverse()));

  // The same values DECLARED number: now they really are numbers, and 007 === 7.
  const ncols: ParsedColumn[] = [{ name: 'id', type: 'number' }];
  const nf = fixture(ncols, [[7], [70], [10], [9]]);
  diff('same digits as a number column sort numerically', nf, { offset: 0, limit: 10, sortColumn: 'id', sortDir: 'asc' });
  const nasc = dp.readPage(nf.src, { offset: 0, limit: 10, sortColumn: 'id', sortDir: 'asc' });
  ok('number column: 9 before 10 (numeric, unlike the text column above)',
    nasc !== null && JSON.stringify(nasc.rows.map((r) => r[0])) === JSON.stringify([7, 9, 10, 70]));
}

// ── 5. Search: text cells, numeric cells, no match, and `total` ─────────────
{
  const cols: ParsedColumn[] = [
    { name: 'city', type: 'text' },
    { name: 'pop', type: 'number' },
    { name: 'note', type: 'text' },
  ];
  const f = fixture(cols, [
    ['Paris', 2148327, 'capital'],
    ['Berlin', 3769495, ''],
    ['Prague', 1309000, null],
    ['paris, TX', 25171, 'not the capital'],
    [null, 42, 'no city'],
    ['Nice', null, 'no pop'],
  ]);

  for (const q of ['par', 'PAR', 'Par', 'capital', '13', '3769495', 'zzz', '', '   ', ' par ', 'no']) {
    diff(`search ${JSON.stringify(q)}`, f, { offset: 0, limit: 50, search: q });
  }

  const par = dp.readPage(f.src, { offset: 0, limit: 50, search: 'PAR' });
  ok('search is case-insensitive across all columns', par !== null && par.total === 2);
  const num = dp.readPage(f.src, { offset: 0, limit: 50, search: '3769495' });
  ok('search matches a NUMERIC cell by its rendered string', num !== null && num.total === 1);
  const partialNum = dp.readPage(f.src, { offset: 0, limit: 50, search: '148' });
  ok('search matches a SUBSTRING of a numeric cell', partialNum !== null && partialNum.total === 1);
  const none = dp.readPage(f.src, { offset: 0, limit: 50, search: 'zzz' });
  ok('no match: total 0 and no rows', none !== null && none.total === 0 && none.rows.length === 0);
  const blank = dp.readPage(f.src, { offset: 0, limit: 50, search: '   ' });
  ok('whitespace-only search is trimmed away → no filter', blank !== null && blank.total === 6);
  const trimmed = dp.readPage(f.src, { offset: 0, limit: 50, search: ' par ' });
  ok('search is trimmed before matching', trimmed !== null && trimmed.total === 2);
  const nullish = dp.readPage(f.src, { offset: 0, limit: 50, search: 'null' });
  ok('a null cell is never searched (does not match "null")', nullish !== null && nullish.total === 0);
  const emptyStr = dp.readPage(f.src, { offset: 0, limit: 50, search: 'capital' });
  ok('search spans every column, not just the first', emptyStr !== null && emptyStr.total === 2);

  // total is post-search, pre-page — and paging inside a search is stable.
  const page = dp.readPage(f.src, { offset: 1, limit: 1, search: 'p' });
  const ref = dp.pageRowsJs(f.columns, f.rows, { offset: 1, limit: 1, search: 'p' });
  ok('total is the SEARCH count, not the page length',
    page !== null && page.total === ref.total && page.rows.length === 1 && page.total > 1);

  // Search + sort together.
  for (const dir of ['asc', 'desc'] as const) {
    diff(`search + sort ${dir}`, f, { offset: 0, limit: 50, search: 'p', sortColumn: 'pop', sortDir: dir });
    diff(`search + text sort ${dir}`, f, { offset: 0, limit: 50, search: 'a', sortColumn: 'city', sortDir: dir });
  }
}

// ── 6. null vs '' stay distinct, everywhere ─────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 't', type: 'text' },
    { name: 'n', type: 'number' },
  ];
  const f = fixture(cols, [
    [null, 1],
    ['', 2],
    ['   ', 3],
    ['x', null],
  ]);

  const p = dp.readPage(f.src, { offset: 0, limit: 10 });
  ok('null stays null', p !== null && p.rows[0][0] === null);
  ok("'' stays '' (NOT re-parsed to null)", p !== null && p.rows[1][0] === '');
  ok('whitespace stays verbatim', p !== null && p.rows[2][0] === '   ');
  ok('a null number cell stays null', p !== null && p.rows[3][1] === null);
  ok('number cells come back as JS numbers', p !== null && typeof p.rows[0][1] === 'number');
  diff('null vs empty: unsorted', f, { offset: 0, limit: 10 });
  diff('null vs empty: text sort', f, { offset: 0, limit: 10, sortColumn: 't', sortDir: 'asc' });
  diff('null vs empty: number sort', f, { offset: 0, limit: 10, sortColumn: 'n', sortDir: 'desc' });
}

// ── 7. STABLE PAGING over a column with many ties ──────────────────────────
//
// THE bug an unstable sort causes: with 5,000 rows sharing 5 sort keys, a
// non-total ORDER BY lets the engine return the tied rows in a different order
// for page 2 than for page 1 — so a row lands on both pages and another on
// neither. The concatenation of every page must be an exact PERMUTATION of the
// table: every row present, exactly once.
{
  const cols: ParsedColumn[] = [
    { name: 'bucket', type: 'text' },
    { name: 'uid', type: 'number' },
    { name: 'tiebucket', type: 'number' },
  ];
  const N = 5000;
  const rows: Cell[][] = [];
  for (let i = 0; i < N; i += 1) rows.push([`b${i % 5}`, i, i % 3]);
  const f = fixture(cols, rows);

  for (const [col, dir] of [['bucket', 'asc'], ['bucket', 'desc'], ['tiebucket', 'asc']] as const) {
    const seen: number[] = [];
    const PAGE = 137; // deliberately not a divisor of N
    for (let o = 0; o < N; o += PAGE) {
      const p = dp.readPage(f.src, { offset: o, limit: PAGE, sortColumn: col, sortDir: dir });
      if (!p) {
        ok(`stable paging (${col} ${dir}): every page read`, false);
        break;
      }
      for (const r of p.rows) seen.push(Number(r[1]));
    }
    const uniq = new Set(seen);
    ok(`stable paging (${col} ${dir}): ${N} rows returned in total`, seen.length === N);
    ok(`stable paging (${col} ${dir}): every row exactly once, none duplicated or dropped`,
      uniq.size === N && seen.every((u) => Number.isInteger(u) && u >= 0 && u < N));

    // …and the concatenation is the SAME order the JS grid would produce.
    const want = dp.pageRowsJs(f.columns, f.rows, { offset: 0, limit: N, sortColumn: col, sortDir: dir });
    ok(`stable paging (${col} ${dir}): concatenated pages === pageRowsJs`,
      JSON.stringify(seen) === JSON.stringify(want.rows.map((r) => Number(r[1]))));
  }

  // Repeating the same page must give the same answer.
  const a = dp.readPage(f.src, { offset: 2000, limit: 50, sortColumn: 'bucket', sortDir: 'asc' });
  const b = dp.readPage(f.src, { offset: 2000, limit: 50, sortColumn: 'bucket', sortDir: 'asc' });
  ok('the same page read twice is identical', a !== null && b !== null && sameRows(a.rows, b.rows));
}

// ── 8. Fallback contract: null means "fall back", never "no rows" ──────────
{
  const cols: ParsedColumn[] = [{ name: 'a', type: 'text' }];
  const f = fixture(cols, [['x']]);

  ok('missing file → null', dp.readPage({ parquetPath: path.join(dir, 'nope.parquet'), columns: cols }, { offset: 0, limit: 5 }) === null);
  ok('non-.parquet path → null', dp.readPage({ parquetPath: path.join(dir, 'x.txt'), columns: cols }, { offset: 0, limit: 5 }) === null);
  ok('0-column schema → null', dp.readPage({ parquetPath: f.src.parquetPath, columns: [] }, { offset: 0, limit: 5 }) === null);
  // ponytail: deliberately malformed input — the point is that it cannot throw.
  ok('malformed schema → null', dp.readPage({ parquetPath: f.src.parquetPath, columns: [null as any] }, { offset: 0, limit: 5 }) === null);
  ok('no request at all → null', dp.readPage(f.src, undefined as any) === null);

  // An unknown sort column is simply not a sort — same as the grid, whose
  // expSortCol can only ever be a real index.
  const unknown = dp.readPage(f.src, { offset: 0, limit: 5, sortColumn: 'nope', sortDir: 'desc' });
  ok('unknown sort column → unsorted page, not an error', unknown !== null && unknown.rows.length === 1);
  diff('unknown sort column matches pageRowsJs', f, { offset: 0, limit: 5, sortColumn: 'nope', sortDir: 'desc' });

  // An empty table is a real answer, not a fallback.
  const empty = fixture(cols, []);
  const ep = dp.readPage(empty.src, { offset: 0, limit: 10, search: 'x', sortColumn: 'a', sortDir: 'asc' });
  ok('empty table: a real page with total 0', ep !== null && ep.total === 0 && ep.rows.length === 0);
}

// ── 9. 200,000 rows — well past the 50,000-row import cap ──────────────────
//
// The whole point of the module. `pageRowsJs` is run alongside as the oracle,
// which is also a fair measure of what the OLD grid paid PER INTERACTION (it
// re-filtered and re-sorted a full copy on every keystroke) — on top of the
// hydration and structured clone the resident path removes entirely.
{
  const cols: ParsedColumn[] = [
    { name: 'id', type: 'number' },
    { name: 'name', type: 'text' },
    { name: 'region', type: 'text' },
    { name: 'sales', type: 'number' },
    { name: 'day', type: 'date' },
    { name: 'note', type: 'text' },
  ];
  const REGIONS = ['West', 'East', 'North', 'South', 'Central'];
  const N = 200_000;
  const rows: Cell[][] = new Array(N);
  for (let i = 0; i < N; i += 1) {
    rows[i] = [
      i,
      `name-${(i * 7919) % N}`,
      REGIONS[i % REGIONS.length],
      (i * 37) % 100_000,
      `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      i % 11 === 0 ? '' : i % 17 === 0 ? null : `note ${i % 997}`,
    ];
  }

  const t0 = Date.now();
  const file = tmpFile();
  pq.writeTable(file, cols, rows);
  const tWrite = Date.now() - t0;
  const src: dp.PageSource = { parquetPath: file, columns: cols };

  const t1 = Date.now();
  const back = pq.readTable(file, cols);
  const tHydrate = Date.now() - t1;
  if (!back) throw new Error('200k fixture read-back failed');
  const f: Fixture = { src, columns: back.columns, rows: back.rows };
  ok(`200k: fixture round-trips ${N} rows`, f.rows.length === N);

  console.log(`     200k: write ${tWrite} ms, full hydrate (what the grid used to pay) ${tHydrate} ms`);

  function timed(label: string, req: dp.PageRequest): void {
    const s = Date.now();
    const got = dp.readPage(src, req);
    const resident = Date.now() - s;
    const s2 = Date.now();
    const want = dp.pageRowsJs(f.columns, f.rows, req);
    const js = Date.now() - s2;
    ok(`200k ${label}: === pageRowsJs (total ${want.total})`,
      got !== null && got.total === want.total && sameRows(got.rows, want.rows));
    console.log(`     200k ${label}: resident ${resident} ms, JS-over-hydrated ${js} ms`);
  }

  timed('page @0', { offset: 0, limit: 100 });
  timed('page @150000', { offset: 150_000, limit: 100 });
  timed('sort number asc', { offset: 0, limit: 100, sortColumn: 'sales', sortDir: 'asc' });
  timed('sort number desc @100000', { offset: 100_000, limit: 100, sortColumn: 'sales', sortDir: 'desc' });
  timed('sort text asc', { offset: 0, limit: 100, sortColumn: 'name', sortDir: 'asc' });
  timed('sort ties (region) @99900', { offset: 99_900, limit: 100, sortColumn: 'region', sortDir: 'asc' });
  timed('search "note 42"', { offset: 0, limit: 100, search: 'note 42' });
  timed('search + sort', { offset: 0, limit: 100, search: 'West', sortColumn: 'sales', sortDir: 'desc' });

  // Stability at scale: page through the whole ties-heavy sort.
  const seen = new Set<number>();
  let count = 0;
  const PAGE = dp.MAX_LIMIT;
  const sStable = Date.now();
  for (let o = 0; o < N; o += PAGE) {
    const p = dp.readPage(src, { offset: o, limit: PAGE, sortColumn: 'region', sortDir: 'asc' });
    if (!p) break;
    for (const r of p.rows) {
      seen.add(Number(r[0]));
      count += 1;
    }
  }
  console.log(`     200k: paged the whole ties-heavy sort in ${Math.ceil(N / PAGE)} pages, ${Date.now() - sStable} ms`);
  ok('200k stable paging: every row exactly once across 40 pages', count === N && seen.size === N);
}

// ─────────────────────────────────────────────────────────────────────────────

cleanup();
if (failureCount() > 0) {
  console.error(`\n${failureCount()} check(s) failed`);
  process.exit(1);
}
console.log('\nAll datasetPage checks passed');
