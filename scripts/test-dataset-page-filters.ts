'use strict';

// Self-check for FILTERED paging — `PageRequest.filters` in src/datasetPage.ts.
//
// The rows behind a number are only worth showing if they are the SAME rows the
// number was computed from. That is not a UI property: it is the property that
// `readPage`'s WHERE and `applyPipeline`'s fold select identical sets. So this
// suite is differential like every other one in this layer — a fixture is
// written with `parquetStore.writeTable`, read back, and `readPage(src, req)` is
// compared cell-by-cell with `Object.is` against `pageRowsJs(columns, rows, req)`
// over those exact bytes, for every combination of filter × search × sort ×
// offset below.
//
// The fixture is built to hit the distinctions this codebase keeps insisting on:
//
//   - `null` vs `''` vs `'   '` vs `'\t'` in the SAME text column. "Empty" means
//     all four to a filter (`sqlGen.sqlEmpty`) and only the first two to a sort
//     (`sortCompare`), so a filtered sort exercises both spellings at once.
//   - a TEXT column holding '007', '07' and '7'. `= '7'` must keep exactly one
//     of them; a stray `TRY_CAST` would fuse all three.
//   - a NUMBER column whose stored text is '007'. `parse.isFiniteNumber` is
//     strict, so this is a real numeric cell (7) and `= 7` must find it — the
//     mirror image of the case above, on the DECLARED type.
//   - a filter on a column that does not exist, which BOTH sides must skip
//     rather than throw and rather than matching nothing.
//
//   npm run build:ts && node scripts/test-dataset-page-filters.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dp from '../src/engine/datasetPage';
import * as pq from '../src/engine/parquetStore';
import type { ParsedColumn } from '../src/parse';
import type { Cell, FilterStep } from '../src/transforms';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-page-filters-'));
function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── The fixture ──────────────────────────────────────────────────────────────

const cols: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'code', type: 'text' }, // '007' stays text — parse.ts's whole point
  { name: 'amount', type: 'number' },
  { name: 'day', type: 'date' },
];

const REGIONS: Cell[] = ['North', 'South', 'East', 'West', '', '   ', '\t', null, 'north', 'Nörth'];
const CODES: Cell[] = ['007', '07', '7', '0070', '', null];

const rows: Cell[][] = [];
for (let i = 0; i < 240; i += 1) {
  rows.push([
    REGIONS[i % REGIONS.length],
    CODES[i % CODES.length],
    // Every 11th row is a non-numeric hole; '007' arrives as the number 7.
    i % 11 === 0 ? null : i % 17 === 0 ? 7 : (i % 23) * 5,
    `2024-0${(i % 9) + 1}-1${i % 10}`,
  ]);
}
// A couple of rows that exist only to be found by an exact-string filter.
rows.push(['North', '007', 7, '2024-01-01']);
rows.push([null, null, null, '']);

const file = path.join(dir, 'filters.parquet');
pq.writeTable(file, cols, rows);
const back = pq.readTable(file, cols);
if (!back) {
  console.error('FAIL fixture read-back failed — nothing was verified');
  cleanup();
  process.exit(1);
}
const src: dp.PageSource = { parquetPath: file, columns: cols };
const table = back.rows;

// Object.is throughout: '' must never compare equal to null, and 0 must never
// compare equal to '' — the distinctions the storage layer exists to preserve.
function sameRows(a: Cell[][], b: Cell[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].length !== b[i].length) return false;
    for (let c = 0; c < a[i].length; c += 1) if (!Object.is(a[i][c], b[i][c])) return false;
  }
  return true;
}

/** readPage must equal pageRowsJs over the round-tripped rows, exactly. */
function diff(label: string, req: dp.PageRequest): dp.PageResult | null {
  const want = dp.pageRowsJs(back!.columns, table, req);
  const got = dp.readPage(src, req);
  if (!got) {
    ok(`${label}: readPage served the page (did not fall back)`, false);
    return null;
  }
  ok(
    `${label}: total ${got.total} === pageRowsJs ${want.total}` +
      `, rows ${got.rows.length} === ${want.rows.length}`,
    want.total === got.total && want.offset === got.offset && sameRows(want.rows, got.rows),
  );
  return got;
}

// ─────────────────────────────────────────────────────────────────────────────

if (!dp.isPageResident()) {
  console.error('FAIL dataset-page-filters: DuckDB bridge unavailable — nothing was verified');
  cleanup();
  process.exit(1);
}

// ── 1. The matrix: filter × search × sort × offset ───────────────────────────
//
// Every combination is a differential assertion. The point is not any single
// answer but that two independent implementations agree on all of them.

const FILTERS: { label: string; steps: FilterStep[] }[] = [
  { label: 'none', steps: [] },
  { label: 'region = North', steps: [{ type: 'filter', column: 'region', op: '=', value: 'North' }] },
  // '' and null are ONE value to a string comparison (transforms stringifies a
  // null cell to '') and whitespace is NOT — the opposite of `is_empty` below.
  { label: "region = ''", steps: [{ type: 'filter', column: 'region', op: '=', value: '' }] },
  { label: 'region is_empty', steps: [{ type: 'filter', column: 'region', op: 'is_empty' }] },
  { label: 'region not_empty', steps: [{ type: 'filter', column: 'region', op: 'not_empty' }] },
  { label: 'region != North', steps: [{ type: 'filter', column: 'region', op: '!=', value: 'North' }] },
  { label: 'region contains or', steps: [{ type: 'filter', column: 'region', op: 'contains', value: 'or' }] },
  { label: 'region in (North,West)', steps: [{ type: 'filter', column: 'region', op: 'in', values: ['North', 'West'] }] },
  { label: 'region not in (North)', steps: [{ type: 'filter', column: 'region', op: 'not in', values: ['North'] }] },
  // TEXT '007': exactly one of '007'/'07'/'7' may match '7'.
  { label: "code = '7' (text)", steps: [{ type: 'filter', column: 'code', op: '=', value: '7' }] },
  { label: "code = '007' (text)", steps: [{ type: 'filter', column: 'code', op: '=', value: '007' }] },
  // NUMBER column whose stored text is '007' — the declared type decides.
  { label: 'amount = 7 (number)', steps: [{ type: 'filter', column: 'amount', op: '=', value: 7 }] },
  { label: "amount = '007' (number)", steps: [{ type: 'filter', column: 'amount', op: '=', value: '007' }] },
  { label: 'amount > 40', steps: [{ type: 'filter', column: 'amount', op: '>', value: 40 }] },
  { label: 'amount is_empty', steps: [{ type: 'filter', column: 'amount', op: 'is_empty' }] },
  { label: 'day >= 2024-05', steps: [{ type: 'filter', column: 'day', op: '>=', value: '2024-05' }] },
  // Two steps are a conjunction, and order must not matter to the result.
  {
    label: 'region=North AND amount>10',
    steps: [
      { type: 'filter', column: 'region', op: '=', value: 'North' },
      { type: 'filter', column: 'amount', op: '>', value: 10 },
    ],
  },
  // Skipped by BOTH sides — never thrown, never "matches nothing".
  { label: 'unknown column', steps: [{ type: 'filter', column: 'nope', op: '=', value: 'x' }] },
  {
    label: 'unknown column + real one',
    steps: [
      { type: 'filter', column: 'nope', op: '=', value: 'x' },
      { type: 'filter', column: 'region', op: '=', value: 'South' },
    ],
  },
  // An empty `in` list applies NOTHING (transforms skips it with a warning).
  { label: 'in with no values', steps: [{ type: 'filter', column: 'region', op: 'in', values: [] }] },
];

const SEARCHES = ['', 'north', '00', '7'];
const SORTS: { sortColumn?: string; sortDir?: 'asc' | 'desc' }[] = [
  {},
  { sortColumn: 'region', sortDir: 'asc' },
  { sortColumn: 'region', sortDir: 'desc' },
  { sortColumn: 'amount', sortDir: 'asc' },
  { sortColumn: 'code', sortDir: 'desc' },
];
const OFFSETS = [0, 10, 37];

let combos = 0;
for (const f of FILTERS) {
  for (const search of SEARCHES) {
    for (const sort of SORTS) {
      for (const offset of OFFSETS) {
        combos += 1;
        const req: dp.PageRequest = { offset, limit: 12, search, ...sort, filters: f.steps };
        const label =
          `[${f.label}] search=${JSON.stringify(search)} ` +
          `sort=${sort.sortColumn ?? '-'}${sort.sortDir === 'desc' ? '↓' : ''} offset=${offset}`;
        diff(label, req);
      }
    }
  }
}
ok(`matrix covered ${combos} filter × search × sort × offset combinations`, combos === 20 * 4 * 5 * 3);

// ── 2. The assertions the reference cannot make about itself ─────────────────

// A filter really does narrow, and `total` is the FILTERED count — the number
// the drill panel puts in its header.
{
  const all = dp.readPage(src, { offset: 0, limit: 1 });
  const north = dp.readPage(src, {
    offset: 0,
    limit: 1,
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'North' }],
  });
  ok(
    'total is the POST-filter count, not the table size',
    all !== null && north !== null && north.total < all.total && north.total > 0,
  );
  ok('total is independent of the window', all !== null && all.total === table.length);
}

// `total` counts the filtered AND searched set, before paging.
{
  const req: dp.PageRequest = {
    offset: 0,
    limit: 5,
    search: 'north',
    filters: [{ type: 'filter', column: 'region', op: 'not_empty' }],
  };
  const got = dp.readPage(src, req);
  const want = dp.pageRowsJs(back.columns, table, req);
  ok('filter + search compose into one total', got !== null && got.total === want.total && got.total > 5);
  ok('the window is bounded by limit, the total is not', got !== null && got.rows.length === 5);
}

// '007' is not 7 on a TEXT column, and IS 7 on a NUMBER column. Two filters,
// two answers, decided by the declared type and nothing else.
{
  const codeIdx = 1;
  const seven = dp.readPage(src, {
    offset: 0,
    limit: 500,
    filters: [{ type: 'filter', column: 'code', op: '=', value: '7' }],
  });
  ok(
    "text '007' is NOT matched by = '7'",
    seven !== null && seven.rows.length > 0 && seven.rows.every((r) => r[codeIdx] === '7'),
  );

  // The mirror image, and the stricter half: on a NUMBER column the TARGET goes
  // through `parse.coerceValue` too, and `isFiniteNumber('007')` is false — a
  // leading zero means the string was never a number. So the filter keeps ZERO
  // rows rather than quietly reading the target as 7 and matching the cells that
  // hold it. Both paths agree (the matrix covers this filter); the point here is
  // WHICH answer they agree on.
  const amountIdx = 2;
  const asNum = dp.readPage(src, {
    offset: 0,
    limit: 500,
    filters: [{ type: 'filter', column: 'amount', op: '=', value: '007' }],
  });
  ok("number column: '007' is not a numeric target — it matches nothing", asNum !== null && asNum.rows.length === 0);

  const seven7 = dp.readPage(src, {
    offset: 0,
    limit: 500,
    filters: [{ type: 'filter', column: 'amount', op: '=', value: 7 }],
  });
  ok(
    '…while the number 7 finds exactly the cells holding 7',
    seven7 !== null && seven7.rows.length > 0 && seven7.rows.every((r) => r[amountIdx] === 7),
  );
}

// Empty means null OR '' OR whitespace — for a FILTER. (A sort disagrees on
// whitespace, deliberately; §1's sorted-and-filtered combinations pin that the
// two rules coexist without either leaking into the other.)
{
  const idx = 0;
  const empty = dp.readPage(src, {
    offset: 0,
    limit: 500,
    filters: [{ type: 'filter', column: 'region', op: 'is_empty' }],
  });
  ok(
    'is_empty keeps null, "", "   " and "\\t"',
    empty !== null &&
      empty.rows.length > 0 &&
      empty.rows.every((r) => r[idx] === null || String(r[idx]).trim() === ''),
  );
  const kinds = new Set(empty!.rows.map((r) => JSON.stringify(r[idx])));
  ok('…and all four spellings are present', kinds.size === 4);
}

// An unknown filter column is SKIPPED, not thrown and not "matches nothing".
{
  const req: dp.PageRequest = {
    offset: 0,
    limit: 10,
    filters: [{ type: 'filter', column: 'nope', op: '=', value: 'x' }],
  };
  const got = dp.readPage(src, req);
  const none = dp.readPage(src, { offset: 0, limit: 10 });
  ok(
    'a filter on a missing column is skipped, exactly as transforms skips it',
    got !== null && none !== null && got.total === none.total && sameRows(got.rows, none.rows),
  );
}

// Paging a filtered set is still a PERMUTATION — no row duplicated, none lost.
// This is the bug an ORDER BY without the file ordinal causes, and adding a
// WHERE does not make it go away.
{
  const filters: FilterStep[] = [{ type: 'filter', column: 'region', op: 'not_empty' }];
  const req = { limit: 7, sortColumn: 'amount', sortDir: 'asc' as const, filters };
  const first = dp.readPage(src, { ...req, offset: 0 });
  if (!first) {
    ok('filtered paging: first page served', false);
  } else {
    const seen: Cell[][] = [];
    for (let off = 0; off < first.total; off += 7) {
      const page = dp.readPage(src, { ...req, offset: off });
      if (!page) {
        ok(`filtered paging: page at ${off} served`, false);
        break;
      }
      seen.push(...page.rows);
    }
    const want = dp.pageRowsJs(back.columns, table, { ...req, offset: 0, limit: dp.MAX_LIMIT });
    ok(
      `paging a filtered sort concatenates to the whole filtered set (${seen.length} rows)`,
      seen.length === first.total && sameRows(seen, want.rows),
    );
  }
}

// The JS reference is pure: filtering must not mutate the caller's rows.
{
  const before = JSON.stringify(table);
  dp.pageRowsJs(back.columns, table, {
    offset: 0,
    limit: 10,
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'North' }],
  });
  ok('pageRowsJs does not mutate the rows it was given', JSON.stringify(table) === before);
}

// A malformed filter list is shape-checked, not trusted.
{
  const junk = dp.readPage(src, { offset: 0, limit: 5, filters: 'not-an-array' as any });
  const none = dp.readPage(src, { offset: 0, limit: 5 });
  ok('a non-array `filters` is ignored, not thrown', junk !== null && none !== null && junk.total === none.total);
}

cleanup();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dataset page filter checks passed');
