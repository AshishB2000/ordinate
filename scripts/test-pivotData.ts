'use strict';

// Self-check for src/analysis/pivotData.ts and src/engine/pivotResident.ts.
//
// Two kinds of assertion, and the split is deliberate.
//
// The FIRST kind is arithmetic against hand-written fixtures whose sums are
// obvious by inspection — because the properties a pivot has to get right are
// properties no second implementation can verify for you: that a subtotal is
// recomputed rather than folded (so an `avg` subtotal is the mean of ROWS, not
// the mean of the means above it), that `pct_row` sums to 1, that tied ranks
// share a number, that a cap sets `truncated`.
//
// The SECOND kind is the house style: a DIFFERENTIAL between the JS reference
// and the resident path, `Object.is`, cell by cell, over the same Parquet bytes
// — including the bundled sample, which is the data every user sees first.
//
//   npm run build:ts && node scripts/test-pivotData.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pivotData from '../src/analysis/pivotData';
import * as pivotResident from '../src/engine/pivotResident';
import * as pqSync from '../src/engine/parquetStoreSync';
import * as duck from '../src/engine/duckdb';
import { parseCsv } from '../src/data/parse';
import { setCalendar } from '../src/analysis/dateIntel';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import type { PivotEncoding, PivotGrid } from '../src/analysis/pivotData';

import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-pivot-'));
let seq = 0;
const tmpFile = (): string => path.join(dir, `t${seq++}.parquet`);
function cleanup(): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Fixture {
  src: { parquetPath: string; columns: ParsedColumn[] };
  columns: ParsedColumn[];
  rows: Cell[][];
}

/**
 * Write, read back, and hand over BOTH — so every comparison is against the
 * same bytes rather than against the array that went in. A `number` column's
 * NaN becomes null on the way through storage and the reference has to see the
 * post-round-trip value too. Copied in intent from test-residentQuery.ts.
 */
function fixture(columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = tmpFile();
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, columns: back.columns, rows: back.rows };
}

const SALES_COLS: ParsedColumn[] = [
  { name: 'category', type: 'text' },
  { name: 'sub', type: 'text' },
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'day', type: 'date' },
];

// Two categories × two sub-categories × two regions, with figures chosen so the
// subtotals and totals are readable at a glance:
//
//            West   East  | Total
//   Furn            .     |
//     Chairs   10     20  |   30
//     Tables   30     40  |   70
//   Furn sub   40     60  |  100
//   Tech
//     Phones  100    200  |  300
//   Tech sub  100    200  |  300
//   Total     140    260  |  400
const SALES_ROWS: Cell[][] = [
  ['Furn', 'Chairs', 'West', 10, '2023-01-15'],
  ['Furn', 'Chairs', 'East', 20, '2023-02-20'],
  ['Furn', 'Tables', 'West', 30, '2023-04-10'],
  ['Furn', 'Tables', 'East', 40, '2024-01-05'],
  ['Tech', 'Phones', 'West', 100, '2024-02-11'],
  ['Tech', 'Phones', 'East', 200, '2024-07-30'],
];

function enc(over: Partial<PivotEncoding> = {}): PivotEncoding {
  return {
    rows: [{ column: 'category' }, { column: 'sub' }],
    columns: [{ column: 'region' }],
    values: [{ column: 'amount', aggregation: 'sum' }],
    totals: { rows: true, columns: true, grand: true },
    ...over,
  };
}

const js = (f: Fixture, e: PivotEncoding, filters?: FilterStep[]): PivotGrid =>
  pivotData.buildPivotGrid(f.columns, f.rows, e, filters).grid;

/** Find a grid row by its joined header path. */
function rowAt(g: PivotGrid, pathText: string): number {
  return g.rowHeaders.findIndex((h) => h.join('/') === pathText);
}

// ── 1. Two-level rows × one-level columns, with subtotals ────────────────────

function testShape(): void {
  const f = fixture(SALES_COLS, SALES_ROWS);
  const g = js(f, enc());

  ok('shape: five grid rows — two parents and three leaves',
     g.rowHeaders.length === 5, JSON.stringify(g.rowHeaders));
  ok('shape: a parent row comes before its own children',
     g.rowHeaders.map((h) => h.join('/')).join(' | ')
       === 'Furn | Furn/Chairs | Furn/Tables | Tech | Tech/Phones');
  ok('shape: parents are subtotals, leaves are leaves',
     g.rowKinds.join(',') === 'subtotal,leaf,leaf,subtotal,leaf');
  ok('shape: two column groups, first-seen order',
     g.colHeaders.map((h) => h.join('/')).join(',') === 'West,East',
     JSON.stringify(g.colHeaders));

  const cell = (p: string, c: number): number | null => g.cells[rowAt(g, p)][c];
  ok('cells: Furn/Chairs West is 10', Object.is(cell('Furn/Chairs', 0), 10));
  ok('cells: Furn/Tables East is 40', Object.is(cell('Furn/Tables', 1), 40));
  ok('subtotal: Furn West is 40 (10 + 30)', Object.is(cell('Furn', 0), 40));
  ok('subtotal: Furn East is 60 (20 + 40)', Object.is(cell('Furn', 1), 60));
  ok('subtotal: Tech West is 100', Object.is(cell('Tech', 0), 100));

  const rt = g.rowTotals as (number | null)[][];
  ok('Total column: Furn totals 100', Object.is(rt[rowAt(g, 'Furn')][0], 100));
  ok('Total column: Furn/Tables totals 70', Object.is(rt[rowAt(g, 'Furn/Tables')][0], 70));
  const ct = g.colTotals as (number | null)[];
  ok('Total row: West totals 140', Object.is(ct[0], 140));
  ok('Total row: East totals 260', Object.is(ct[1], 260));
  ok('grand total is 400', Object.is((g.grand as (number | null)[])[0], 400));

  // A single value field under real column groups does NOT repeat its own name
  // in the header — the group name is the header.
  ok('one value field leaves the value name out of the column header',
     g.colHeaders.every((h) => h.length === 1));

  const two = js(f, enc({
    values: [
      { column: 'amount', aggregation: 'sum' },
      { column: 'amount', aggregation: 'avg' },
    ],
  }));
  ok('two value fields double the grid columns and name themselves',
     two.colHeaders.map((h) => h.join('/')).join(',')
       === 'West/sum of amount,West/avg of amount,East/sum of amount,East/avg of amount',
     JSON.stringify(two.colHeaders));
}

// ── 2. A subtotal is RECOMPUTED, never folded ────────────────────────────────

function testAvgSubtotal(): void {
  // Chairs: 10, 30 → mean 20.  Tables: 80 → mean 80.
  // Folding the cells would give (20 + 80) / 2 = 50. The right answer is the
  // mean of the four rows' three values: (10 + 30 + 80) / 3 = 40.
  const rows: Cell[][] = [
    ['Furn', 'Chairs', 'West', 10, '2023-01-01'],
    ['Furn', 'Chairs', 'West', 30, '2023-01-02'],
    ['Furn', 'Tables', 'West', 80, '2023-01-03'],
  ];
  const f = fixture(SALES_COLS, rows);
  const g = js(f, enc({ values: [{ column: 'amount', aggregation: 'avg' }] }));
  const furn = g.cells[rowAt(g, 'Furn')][0];
  ok('avg subtotal is the mean of the ROWS (40), not the mean of the means (50)',
     Object.is(furn, 40), String(furn));

  const gmin = js(f, enc({ values: [{ column: 'amount', aggregation: 'min' }] }));
  ok('min subtotal is the smallest row, not the smallest cell',
     Object.is(gmin.cells[rowAt(gmin, 'Furn')][0], 10));

  // count over a text column: three non-empty `sub` cells under Furn.
  const gcount = js(f, enc({ values: [{ column: 'sub', aggregation: 'count' }] }));
  ok('count subtotal counts rows, not cells above it',
     Object.is(gcount.cells[rowAt(gcount, 'Furn')][0], 3));
}

// ── 3. Show values as ────────────────────────────────────────────────────────

function testShowAs(): void {
  const f = fixture(SALES_COLS, SALES_ROWS);

  const pr = js(f, enc({ showAs: 'pct_row' }));
  for (let r = 0; r < pr.cells.length; r += 1) {
    const total = pr.cells[r].reduce((a: number, v) => a + (v ?? 0), 0);
    ok(`pct_row: row ${r} sums to 1`, Math.abs(total - 1) < 1e-12, String(total));
  }
  ok('pct_row: Furn/Chairs West is 10/30',
     Math.abs((pr.cells[rowAt(pr, 'Furn/Chairs')][0] as number) - 10 / 30) < 1e-12);

  const pc = js(f, enc({ showAs: 'pct_col' }));
  // LEAF rows only — a subtotal is its children over again, so including it
  // would make the column sum to 2.
  let leafWest = 0;
  pc.cells.forEach((row, r) => { if (pc.rowKinds[r] === 'leaf') leafWest += (row[0] as number) ?? 0; });
  ok('pct_col: the leaf rows of a column sum to 1', Math.abs(leafWest - 1) < 1e-12, String(leafWest));
  ok('pct_col: Furn/Chairs West is 10/140',
     Math.abs((pc.cells[rowAt(pc, 'Furn/Chairs')][0] as number) - 10 / 140) < 1e-12);

  const pt = js(f, enc({ showAs: 'pct_total' }));
  let leafAll = 0;
  pt.cells.forEach((row, r) => {
    if (pt.rowKinds[r] !== 'leaf') return;
    for (const v of row) leafAll += (v as number) ?? 0;
  });
  ok('pct_total: every leaf cell together sums to 1', Math.abs(leafAll - 1) < 1e-12, String(leafAll));
  ok('pct_total: Tech/Phones East is 200/400',
     Math.abs((pt.cells[rowAt(pt, 'Tech/Phones')][1] as number) - 0.5) < 1e-12);

  ok('showAs leaves the Total column as a FIGURE, not a percentage',
     Object.is((js(f, enc({ showAs: 'pct_row' })).rowTotals as (number | null)[][])[rowAt(pr, 'Furn')][0], 100));
}

function testRankTies(): void {
  // West: 50, 50, 10 → ranks 1, 1, 2 (dense competition ranking, ties shared).
  const rows: Cell[][] = [
    ['A', 'a1', 'West', 50, '2023-01-01'],
    ['B', 'b1', 'West', 50, '2023-01-02'],
    ['C', 'c1', 'West', 10, '2023-01-03'],
  ];
  const f = fixture(SALES_COLS, rows);
  const g = js(f, enc({ rows: [{ column: 'category' }], showAs: 'rank' }));
  const at = (p: string): number | null => g.cells[rowAt(g, p)][0];
  ok('rank: the two tied leaders share rank 1', Object.is(at('A'), 1) && Object.is(at('B'), 1),
     JSON.stringify(g.cells));
  ok('rank: the next value is 2, not 3', Object.is(at('C'), 2));

  const withNull = fixture(SALES_COLS, rows.concat([['D', 'd1', 'East', 5, '2023-01-04']]));
  const gn = js(withNull, enc({ rows: [{ column: 'category' }], showAs: 'rank' }));
  ok('rank: a cell with no rows stays null rather than ranking last',
     Object.is(gn.cells[rowAt(gn, 'D')][0], null), JSON.stringify(gn.cells));
}

// ── 4. Sort, Top N, grains, truncation ───────────────────────────────────────

function testSort(): void {
  const f = fixture(SALES_COLS, SALES_ROWS);
  // Column 0 is West: Furn 40 vs Tech 100, so Tech leads; and INSIDE Furn,
  // Tables (30) leads Chairs (10). Siblings are ordered at EVERY level, and a
  // child never leaves its parent.
  const g = js(f, enc({ sort: { by: 0, dir: 'desc' } }));
  ok('sort by a column descending reorders parents and keeps children under them',
     g.rowHeaders.map((h) => h.join('/')).join(' | ')
       === 'Tech | Tech/Phones | Furn | Furn/Tables | Furn/Chairs',
     JSON.stringify(g.rowHeaders));

  const lab = js(f, enc({ sort: { by: 'label', dir: 'desc' } }));
  ok('sort by label descending orders siblings at every level',
     lab.rowHeaders.map((h) => h.join('/')).join(' | ')
       === 'Tech | Tech/Phones | Furn | Furn/Tables | Furn/Chairs',
     JSON.stringify(lab.rowHeaders));
}

function testTopN(): void {
  const f = fixture(SALES_COLS, SALES_ROWS);
  const g = js(f, enc({ rows: [{ column: 'sub' }], topN: { n: 1, byValueIdx: 0 } }));
  // Phones (300) beats Tables (70) beats Chairs (30).
  ok('topN keeps only the leading key of the outermost dimension',
     g.rowHeaders.length === 1 && g.rowHeaders[0][0] === 'Phones', JSON.stringify(g.rowHeaders));
  ok('topN narrows the GRAND total too — it describes the rows shown',
     Object.is((g.grand as (number | null)[])[0], 300));

  const wide = js(f, enc({ rows: [{ column: 'sub' }], topN: { n: 10, byValueIdx: 0 } }));
  ok('topN wider than the data changes nothing', wide.rowHeaders.length === 3);
}

function testGrains(): void {
  const f = fixture(SALES_COLS, SALES_ROWS);
  const byYear = js(f, enc({ rows: [{ column: 'day', grain: 'year' }], columns: [] }));
  ok('date grain year: two buckets', byYear.rowHeaders.length === 2, JSON.stringify(byYear.rowHeaders));
  ok('date grain year: 2023 totals 60 (10 + 20 + 30)',
     Object.is(byYear.cells[rowAt(byYear, '2023')][0], 60), JSON.stringify(byYear.rowHeaders));
  ok('date grain year: 2024 totals 340 (40 + 100 + 200)',
     Object.is(byYear.cells[rowAt(byYear, '2024')][0], 340));

  const byQuarter = js(f, enc({ rows: [{ column: 'day', grain: 'quarter' }], columns: [] }));
  ok('date grain quarter: four buckets', byQuarter.rowHeaders.length === 4,
     JSON.stringify(byQuarter.rowHeaders));
  const byMonth = js(f, enc({ rows: [{ column: 'day', grain: 'month' }], columns: [] }));
  ok('date grain month: six buckets, one per row', byMonth.rowHeaders.length === 6,
     JSON.stringify(byMonth.rowHeaders));
}

function testTruncation(): void {
  const cols: ParsedColumn[] = [
    { name: 'k', type: 'text' }, { name: 'c', type: 'text' }, { name: 'n', type: 'number' },
  ];
  const wide: Cell[][] = [];
  for (let i = 0; i < pivotData.PIVOT_ROW_CAP + 50; i += 1) wide.push([`k${i}`, 'one', i]);
  const f = fixture(cols, wide);
  const g = js(f, {
    rows: [{ column: 'k' }], columns: [{ column: 'c' }],
    values: [{ column: 'n', aggregation: 'sum' }],
    totals: { rows: false, columns: false, grand: false },
  });
  ok('row cap: the grid stops at PIVOT_ROW_CAP row groups',
     g.rowGroupCount === pivotData.PIVOT_ROW_CAP, String(g.rowGroupCount));
  ok('row cap: and says so', g.truncated === true);

  const manyCols: Cell[][] = [];
  for (let i = 0; i < pivotData.PIVOT_COL_CAP + 5; i += 1) manyCols.push(['one', `c${i}`, i]);
  const f2 = fixture(cols, manyCols);
  const g2 = js(f2, {
    rows: [{ column: 'k' }], columns: [{ column: 'c' }],
    values: [{ column: 'n', aggregation: 'sum' }],
    totals: { rows: false, columns: false, grand: false },
  });
  ok('column cap: the grid stops at PIVOT_COL_CAP column groups',
     g2.colGroupCount === pivotData.PIVOT_COL_CAP, String(g2.colGroupCount));
  ok('column cap: and says so', g2.truncated === true);
}

// ── 5. Sanitisation ──────────────────────────────────────────────────────────

function testSanitize(): void {
  const s = pivotData.sanitizePivot({
    rows: [{ column: 'a' }, { column: 'b' }, { column: 'c' }, { column: 'd' }],
    columns: [{ column: 'x' }, { column: 'y' }, { column: 'z' }],
    values: [
      { column: 'n', aggregation: 'sum' }, { column: 'n', aggregation: 'avg' },
      { column: 'n', aggregation: 'min' }, { column: 'n', aggregation: 'max' },
      { column: 'n', aggregation: 'count' },
    ],
    showAs: 'evil',
    sort: { by: -3, dir: 'sideways' },
    totals: { rows: 1, columns: 0, grand: 'yes' },
    conditional: [{ valueIdx: 0, kind: 'scale' }, { valueIdx: 0, kind: 'nope' }],
    topN: { n: 0, byValueIdx: 2 },
    extra: 'dropped',
  }) as PivotEncoding;
  ok('sanitize caps rows at 3', s.rows.length === pivotData.PIVOT_MAX_ROWS);
  ok('sanitize caps columns at 2', s.columns.length === pivotData.PIVOT_MAX_COLS);
  ok('sanitize caps values at 4', s.values.length === pivotData.PIVOT_MAX_VALUES);
  ok('sanitize drops an unknown showAs rather than defaulting it', s.showAs === undefined);
  ok('sanitize drops a negative sort column', s.sort === undefined);
  ok('sanitize coerces the three totals to booleans',
     s.totals.rows === true && s.totals.columns === false && s.totals.grand === true);
  ok('sanitize drops an unknown conditional kind',
     (s.conditional || []).length === 1 && (s.conditional as never[])[0] !== undefined);
  ok('sanitize drops a non-positive topN', s.topN === undefined);
  ok('sanitize drops unknown keys', !('extra' in (s as unknown as Record<string, unknown>)));
  ok('sanitize returns undefined for a non-pivot', pivotData.sanitizePivot({}) === undefined);
  ok('sanitize never throws on rubbish',
     pivotData.sanitizePivot(null) === undefined && pivotData.sanitizePivot(7) === undefined);

  const grained = pivotData.sanitizePivot({
    rows: [{ column: 'd', grain: 'day' }, { column: 'e', grain: 'month' }],
    values: [{ column: 'n', aggregation: 'sum' }],
  }) as PivotEncoding;
  ok('sanitize drops a grain a pivot does not offer (day) and keeps one it does (month)',
     grained.rows[0].grain === undefined && grained.rows[1].grain === 'month');
}

// ── 6. The differential: resident vs JS ──────────────────────────────────────

async function diffGrid(label: string, f: Fixture, e: PivotEncoding, filters?: FilterStep[]): Promise<void> {
  const want = js(f, e, filters);
  const got = await pivotResident.pivotGridResident(f.src, e, filters);
  if (!got) {
    ok(`${label}: resident answered`, false, 'null — the fast path declined');
    return;
  }
  ok(`${label}: same row headers`,
     JSON.stringify(got.rowHeaders) === JSON.stringify(want.rowHeaders),
     JSON.stringify({ want: want.rowHeaders, got: got.rowHeaders }));
  ok(`${label}: same row kinds`, got.rowKinds.join(',') === want.rowKinds.join(','));
  ok(`${label}: same column headers`,
     JSON.stringify(got.colHeaders) === JSON.stringify(want.colHeaders),
     JSON.stringify({ want: want.colHeaders, got: got.colHeaders }));

  let cellsAgree = want.cells.length === got.cells.length;
  let firstDiff = '';
  for (let r = 0; cellsAgree && r < want.cells.length; r += 1) {
    if (want.cells[r].length !== got.cells[r].length) { cellsAgree = false; break; }
    for (let c = 0; c < want.cells[r].length; c += 1) {
      if (!Object.is(want.cells[r][c], got.cells[r][c])) {
        cellsAgree = false;
        firstDiff = `[${r}][${c}] want ${want.cells[r][c]} got ${got.cells[r][c]}`;
        break;
      }
    }
  }
  ok(`${label}: every cell is Object.is-equal`, cellsAgree, firstDiff);
  ok(`${label}: same Total column`,
     JSON.stringify(got.rowTotals) === JSON.stringify(want.rowTotals));
  ok(`${label}: same Total row`,
     JSON.stringify(got.colTotals) === JSON.stringify(want.colTotals));
  ok(`${label}: same grand total`, JSON.stringify(got.grand) === JSON.stringify(want.grand));
  ok(`${label}: same truncation verdict`, got.truncated === want.truncated);
}

async function testDifferential(): Promise<void> {
  const f = fixture(SALES_COLS, SALES_ROWS);
  await diffGrid('diff/two-level', f, enc());
  await diffGrid('diff/no-columns', f, enc({ columns: [] }));
  await diffGrid('diff/single-level', f, enc({ rows: [{ column: 'category' }] }));
  await diffGrid('diff/three-levels', f,
           enc({ rows: [{ column: 'category' }, { column: 'sub' }, { column: 'region' }] }));
  await diffGrid('diff/no-totals', f, enc({ totals: { rows: false, columns: false, grand: false } }));
  await diffGrid('diff/four-values', f, enc({
    values: [
      { column: 'amount', aggregation: 'sum' },
      { column: 'amount', aggregation: 'avg' },
      { column: 'amount', aggregation: 'min' },
      { column: 'sub', aggregation: 'count' },
    ],
  }));
  await diffGrid('diff/pct_row', f, enc({ showAs: 'pct_row' }));
  await diffGrid('diff/rank', f, enc({ showAs: 'rank' }));
  await diffGrid('diff/sorted-by-value', f, enc({ sort: { by: 0, dir: 'desc' } }));
  await diffGrid('diff/sorted-by-label', f, enc({ sort: { by: 'label', dir: 'desc' } }));
  await diffGrid('diff/topN', f, enc({ rows: [{ column: 'sub' }], topN: { n: 2, byValueIdx: 0 } }));
  await diffGrid('diff/date-grain-year', f, enc({ rows: [{ column: 'day', grain: 'year' }] }));
  await diffGrid('diff/date-grain-quarter', f,
           enc({ rows: [{ column: 'day', grain: 'quarter' }], columns: [{ column: 'region' }] }));
  await diffGrid('diff/filtered', f, enc(), [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  await diffGrid('diff/filtered-in', f, enc(),
           [{ type: 'filter', column: 'category', op: 'in', values: ['Tech'] }]);
  await diffGrid('diff/filtered-to-nothing', f, enc(),
           [{ type: 'filter', column: 'region', op: '=', value: 'Nowhere' }]);

  // The shapes the resident layer gets wrong when it is careless: an empty
  // string and a null are two groups, whitespace is empty, a leading-zero id is
  // text, and a number dimension keys on the round-tripped number.
  const messy: ParsedColumn[] = [
    { name: 'k', type: 'text' }, { name: 'c', type: 'text' },
    { name: 'n', type: 'number' }, { name: 'num', type: 'number' },
  ];
  const messyRows: Cell[][] = [
    ['', 'x', 1, 1], [null, 'x', 2, 1], ['  ', 'x', 4, 1.0],
    ['007', 'y', 8, 2], ['7', 'y', 16, 2], ['ok', '', 32, null],
  ];
  const mf = fixture(messy, messyRows);
  const messyEnc: PivotEncoding = {
    rows: [{ column: 'k' }], columns: [{ column: 'c' }],
    values: [{ column: 'n', aggregation: 'sum' }, { column: 'k', aggregation: 'count' }],
    totals: { rows: true, columns: true, grand: true },
  };
  await diffGrid('diff/nulls-empties-and-leading-zeros', mf, messyEnc);
  await diffGrid('diff/number-dimension', mf, {
    ...messyEnc, rows: [{ column: 'num' }], columns: [],
  });
  await diffGrid('diff/empty-table', fixture(messy, []), messyEnc);
}

// ── 7. The differential over the BUNDLED SAMPLE ──────────────────────────────

async function testSample(): Promise<void> {
  const csv = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');
  if (!fs.existsSync(csv)) {
    ok('sample: assets/samples/retail-orders.csv exists', false, csv);
    return;
  }
  const parsed = parseCsv(fs.readFileSync(csv, 'utf8'), ',');
  const f = fixture(parsed.columns, parsed.rows);
  const e: PivotEncoding = {
    rows: [{ column: 'category' }, { column: 'sub_category' }],
    columns: [{ column: 'region' }],
    values: [{ column: 'revenue', aggregation: 'sum' }],
    totals: { rows: true, columns: true, grand: true },
  };
  await diffGrid('sample/revenue by category × region', f, e);
  await diffGrid('sample/avg profit by month', f, {
    rows: [{ column: 'order_date', grain: 'month' }],
    columns: [{ column: 'customer_segment' }],
    values: [{ column: 'profit', aggregation: 'avg' }],
    totals: { rows: true, columns: true, grand: true },
  });
  // Under a retail calendar a pivot's month / quarter / year are its periods,
  // quarters and years — compiled in SQL (engine/weekCalSql), labelled in JS.
  setCalendar({ calendarType: '454', yearEnd: 'nearest' });
  for (const grain of ['month', 'quarter', 'year'] as const) {
    await diffGrid(`sample/4-5-4 ${grain}`, f, {
      rows: [{ column: 'order_date', grain }], columns: [{ column: 'region' }],
      values: [{ column: 'revenue', aggregation: 'sum' }], totals: { rows: true, columns: true, grand: true },
    });
  }
  setCalendar({});

  // The grand total of sum(revenue) over the whole sample IS the sample
  // dashboard's Revenue KPI. Asserted here, off the same bytes, so the smoke's
  // on-screen comparison has a unit-level twin.
  const g = js(f, e);
  const grand = (g.grand as (number | null)[])[0] as number;
  let want = 0;
  const ri = parsed.columns.findIndex((c) => c.name === 'revenue');
  for (const r of f.rows) if (typeof r[ri] === 'number') want += r[ri] as number;
  ok('sample: the grand total equals the sum of every revenue cell',
     Object.is(grand, want), `${grand} vs ${want}`);
  ok('sample: which rounds to the 5.2M the Revenue KPI shows',
     (grand / 1e6).toFixed(1) === '5.2', String(grand));
  ok('sample: three category groups', g.rowHeaders.filter((h) => h.length === 1).length === 3,
     JSON.stringify(g.rowHeaders.filter((h) => h.length === 1)));
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testShape();
  testAvgSubtotal();
  testShowAs();
  testRankTies();
  testSort();
  testTopN();
  testGrains();
  testTruncation();
  testSanitize();

  // The resident half needs the bridge. Without it the JS assertions above
  // still stand and the differential is SKIPPED rather than failed — the same
  // rule every other resident suite follows.
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) {
    console.log('ok   (skipped) the DuckDB bridge is unavailable — differential not run');
  } else {
    await testDifferential();
    await testSample();
  }
  cleanup();
  process.exit(failureCount() ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
