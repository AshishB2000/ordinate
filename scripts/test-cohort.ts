'use strict';

// Self-check for src/analysis/cohortData.ts and src/engine/cohortResident.ts.
//
// First, the properties no second implementation can vouch for: which cohort
// a first event lands in across week / month / quarter boundaries (under the
// workspace calendar's week start and fiscal year), that a retention cell
// divides by the COHORT's size, that a cell past the data is blank while a
// quiet period inside it is 0%, and that a duplicate event cannot inflate a
// distinct count. Then the house style: a DIFFERENTIAL, JS reference against
// the resident path, `Object.is` leaf by leaf, over the same Parquet bytes —
// including the bundled sample, with `state` standing in for a customer id.
//
//   npm run build:ts && node scripts/test-cohort.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cohort from '../src/analysis/cohortData';
import * as cohortResident from '../src/engine/cohortResident';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import { parseCsv } from '../src/data/parse';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import type { CohortEncoding, CohortGrid } from '../src/analysis/cohortData';
import type { CalendarPrefs } from '../src/analysis/dateIntel';
import { sanitizeBundle } from '../src/analysis/dashboardExport';
import { sanitizePayload } from '../src/publish/sanitize';
import { ok, finish } from './selfcheck';

const MON: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1 };
const SUN: CalendarPrefs = { weekStart: 0, fiscalYearStart: 1 };
const APRIL: CalendarPrefs = { weekStart: 1, fiscalYearStart: 4 };
// Week calendars: the fixture's dates cross NRF fiscal 2023's 53rd week (Jan 28 – Feb 3 2024).
const RETAIL: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' };
const ISO_WEEKS: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1, calendarType: 'iso', yearEnd: 'nearest' };

const COLS: ParsedColumn[] = [
  { name: 'user', type: 'text' }, { name: 'day', type: 'date' },
  { name: 'amount', type: 'number' }, { name: 'plan', type: 'text' },
];

function enc(over: Partial<CohortEncoding> = {}): CohortEncoding {
  return { entity: 'user', date: 'day', grain: 'month', show: 'retention', curve: false, ...over };
}
const grid = (rows: Cell[][], e: CohortEncoding, cal = MON, filters?: FilterStep[], cols = COLS): CohortGrid =>
  cohort.buildCohort(cols, rows, e, filters, cal).grid;

// ── 1. Cohort assignment across period boundaries ────────────────────────────

function testBoundaries(): void {
  // 2024-03-03 is a Sunday. Monday weeks split it from the 4th; Sunday weeks do not.
  const rows: Cell[][] = [['a', '2024-03-03', 1, 'x'], ['a', '2024-03-04', 1, 'x']];
  const mon = grid(rows, enc({ grain: 'week' }), MON);
  ok('week (Mon start): Sunday 3 Mar is the week of Mon 26 Feb', mon.cohorts[0] === '2024-02-26', mon.cohorts.join());
  ok('week (Mon start): Monday 4 Mar is period 1 — retention 100% there',
     mon.periods === 2 && mon.cells[0][1] === 100, JSON.stringify(mon.cells));
  const sun = grid(rows, enc({ grain: 'week' }), SUN);
  ok('week (Sun start): both days are the week of Sun 3 Mar, one period',
     sun.cohorts[0] === '2024-03-03' && sun.periods === 1, JSON.stringify(sun));

  const months = grid([['a', '2023-12-31', 1, 'x'], ['a', '2024-01-01', 1, 'x'], ['b', '2024-01-31', 1, 'x'], ['b', '2024-02-01', 1, 'x']],
    enc(), MON);
  ok('month: 31 Dec → 1 Jan crosses a year and is k = 1', months.cohorts.join() === '2023-12,2024-01'
     && months.cells[0][1] === 100, JSON.stringify(months));
  ok('month: 31 Jan → 1 Feb is k = 1 for the January cohort', months.cells[1][1] === 100);

  const qRows: Cell[][] = [['a', '2024-03-31', 1, 'x'], ['a', '2024-04-01', 1, 'x']];
  const cal = grid(qRows, enc({ grain: 'quarter' }), MON);
  ok('quarter (calendar): 31 Mar is 2024-Q1, 1 Apr is k = 1', cal.cohorts[0] === '2024-Q1' && cal.periods === 2);
  const fiscal = grid([['a', '2024-03-31', 1, 'x'], ['a', '2024-04-01', 1, 'x'], ['b', '2024-06-30', 1, 'x']],
    enc({ grain: 'quarter' }), APRIL);
  ok('quarter (fiscal April): 31 Mar closes FQ4, 1 Apr opens FQ1', fiscal.cohorts[0] === '2024-01 (FQ4)'
     && fiscal.cohorts[1] === '2024-04 (FQ1)', fiscal.cohorts.join());
  ok('quarter (fiscal April): 30 Jun is still FQ1 — one cohort, not two', fiscal.sizes.join() === '1,1');

  ok('periodOrdinal: consecutive weeks differ by exactly 1 (pre-1970 too)',
     cohort.periodOrdinal(-7, 'week', MON) + 1 === cohort.periodOrdinal(0, 'week', MON)
     && cohort.periodOrdinal(-1, 'week', MON) === cohort.periodOrdinal(-3, 'week', MON));
  ok('an ISO timestamp with a time reads as its date', grid([['a', '2024-05-02T23:59:59', 1, 'x']], enc()).cohorts[0] === '2024-05');
}

// ── 2. Retention denominators and the triangle ───────────────────────────────

function testRetention(): void {
  const rows: Cell[][] = [
    ['a', '2024-01-05', 10, 'x'], ['b', '2024-01-09', 10, 'x'], ['c', '2024-01-20', 10, 'x'], ['d', '2024-01-28', 10, 'x'],
    ['a', '2024-02-02', 5, 'x'],
    ['b', '2024-03-15', 5, 'x'], ['a', '2024-03-16', 5, 'x'],
    ['e', '2024-02-10', 7, 'y'], ['e', '2024-03-01', 7, 'y'],
  ];
  const g = grid(rows, enc());
  ok('two cohorts, sized by their MEMBERS', g.cohorts.join() === '2024-01,2024-02' && g.sizes.join() === '4,1',
     JSON.stringify(g));
  ok('k = 0 is 100% by definition', g.cells[0][0] === 100 && g.cells[1][0] === 100);
  ok('Jan cohort: 1 of 4 back in Feb → 25% (denominator is the cohort, not the period)', g.cells[0][1] === 25);
  ok('Jan cohort: b skipped Feb and still counts in Mar → 50%', g.cells[0][2] === 50);
  ok('Feb cohort: its last cell is past the data → BLANK, not 0', g.cells[1][2] === null && g.cells[1][1] === 100);
  ok('the triangle: three periods for the oldest cohort', g.periods === 3);
  ok('average is size-weighted: k=1 → (1 + 1) / (4 + 1) = 40%', g.average[1] === 40, JSON.stringify(g.average));
  ok('average at k=2 only counts cohorts that have reached it', g.average[2] === 50);

  const quiet = grid([['a', '2024-01-05', 1, 'x'], ['b', '2024-01-05', 1, 'x'], ['a', '2024-03-01', 1, 'x']], enc());
  ok('a quiet period INSIDE the data is a real 0%, not a blank', quiet.cells[0][1] === 0 && quiet.cells[0][2] === 50,
     JSON.stringify(quiet.cells));

  const dup = grid(rows.concat([['a', '2024-02-02', 5, 'x'], ['a', '2024-02-02', 5, 'x']]), enc());
  ok('duplicate events cannot inflate a distinct count', dup.cells[0][1] === 25 && dup.sizes[0] === 4);

  const value = grid(rows, enc({ show: 'value', value: 'amount' }));
  ok('cumulative value per member: Jan k0 = 40 / 4', value.cells[0][0] === 10, JSON.stringify(value.cells));
  ok('…k1 adds Feb\'s 5 → 45 / 4', value.cells[0][1] === 11.25);
  ok('…k2 adds Mar\'s 10 → 55 / 4', value.cells[0][2] === 13.75);
  ok('value mode names what a cell is', value.valueName === 'amount per member');
}

// ── 3. Exclusions, needs, caps, sanitising ───────────────────────────────────

function testEdges(): void {
  const g = grid([
    ['a', '2024-01-01', 1, 'x'], ['', '2024-01-01', 1, 'x'], ['  ', '2024-01-02', 1, 'x'], [null, '2024-01-01', 1, 'x'],
    ['b', 'not a date', 1, 'x'], ['b', '2024-02-31', 1, 'x'], ['b', '', 1, 'x'],
  ], enc());
  ok('empty / whitespace entities and unreadable dates are excluded and COUNTED', g.excluded === 6 && g.sizes.join() === '1',
     JSON.stringify(g));

  ok('no entity → an empty grid that says what to pick', /entity/i.test(grid([], enc({ entity: '' })).needs));
  ok('value mode without a value column says so', /value column/i.test(grid([], enc({ show: 'value' })).needs));
  ok('a text value column is refused, not silently summed as 0',
     /not a number/.test(grid([], enc({ show: 'value', value: 'plan' })).needs));

  const many: Cell[][] = [];
  for (let m = 0; m < 70; m += 1) many.push(['u' + m, `${2020 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`, 1, 'x']);
  const capped = grid(many, enc());
  ok('past COHORT_CAP the LATEST cohorts are kept and the grid says so',
     capped.cohorts.length === cohort.COHORT_CAP && capped.truncated && capped.cohorts[capped.cohorts.length - 1] === '2025-10');

  const s = cohort.sanitizeCohort({ entity: 'u', date: 'd', grain: 'decade', show: 'nope', curve: 'yes', extra: 1 });
  ok('sanitize: unknown grain → month, show → retention, curve only when true, stray keys dropped',
     JSON.stringify(s) === JSON.stringify({ entity: 'u', date: 'd', grain: 'month', show: 'retention', curve: false }));
  ok('sanitize: a non-object is no cohort at all', cohort.sanitizeCohort('x') === undefined && cohort.sanitizeCohort([]) === undefined);

  const curve = cohort.cohortChartData(grid([['a', '2024-01-05', 1, 'x'], ['a', '2024-02-05', 1, 'x']], enc()));
  ok('chart data is the retention curve: periods × (cohorts + Average)',
     curve.labels.join() === 'Month 0,Month 1' && curve.series.map((x) => x.name).join() === '2024-01,Average');
}

// ── 4. Captions ──────────────────────────────────────────────────────────────

function testCaption(): void {
  const rows: Cell[][] = [];
  const users = ['a', 'b', 'c', 'd'];
  users.forEach((u, i) => { rows.push([u, '2024-01-10', 1, 'x']); if (i < 2) rows.push([u, '2024-04-10', 1, 'x']); });
  ['e', 'f'].forEach((u) => { rows.push([u, '2024-02-10', 1, 'x']); rows.push([u, '2024-05-10', 1, 'x']); });
  const g = grid(rows, enc());
  const text = cohort.cohortCaption(g);
  ok('caption: Month-3 retention averages over the cohorts that reached it, and names the best one',
     text === 'Month-3 retention averages 66.7%; the 2024-02 cohort retains best at 100%', text);
  ok('caption: an incomplete encoding has nothing to summarise', cohort.cohortCaption(grid([], enc({ date: '' }))) === 'No data to summarize');
  ok('caption: a single period says there is no later month yet',
     cohort.cohortCaption(grid([['a', '2024-01-01', 1, 'x']], enc())) === '1 cohort, 1 member; no later month yet');
}

// ── 5. Exports carry labels and numbers only ─────────────────────────────────

function testExportWhitelists(): void {
  const g = grid([['a', '2024-01-05', 1, 'x'], ['a', '2024-02-05', 1, 'x']], enc());
  const chart = cohort.cohortChartData(g);
  const bundle = sanitizeBundle({ name: 'd', pages: [{ name: 'p', cards: [{ kind: 'chart', chartType: 'cohort', layout: { x: 0, y: 0, w: 6, h: 4 },
    data: { labels: chart.labels, series: chart.series.map((x) => ({ label: x.name, values: x.values })), cohort: g, secret: 'k' } }] }] });
  const card = JSON.stringify(bundle.pages[0].cards[0]);
  ok('dashboard export: the grid and stray keys are dropped, the curve stays', !/cohort"|secret/.test(card) && /Month 1/.test(card), card);
  const pub = JSON.stringify(sanitizePayload({ labels: chart.labels, series: [], cohort: g, caption: 'c' }));
  ok('publish: a payload never carries the grid', !/cohorts|sizes/.test(pub), pub);
}

// ── 6. The differential ──────────────────────────────────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-cohort-'));
let seq = 0;

function fixture(columns: ParsedColumn[], rows: Cell[][]): { src: { parquetPath: string; columns: ParsedColumn[] }; rows: Cell[][]; columns: ParsedColumn[] } {
  const file = path.join(dir, `t${seq++}.parquet`);
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, rows: back.rows, columns: back.columns };
}

/** The first leaf where `a` and `b` differ under Object.is, or ''. */
function firstDiff(a: unknown, b: unknown, at = '$'): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}.length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) { const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`); if (d) return d; } // any: generic walk
    return '';
  }
  return Object.is(a, b) ? '' : `${at}: ${String(a)} vs ${String(b)}`;
}

function diff(label: string, f: ReturnType<typeof fixture>, e: CohortEncoding, cal = MON, filters?: FilterStep[]): void {
  const js = cohort.buildCohort(f.columns, f.rows, e, filters, cal).grid;
  const res = cohortResident.cohortGridResident(f.src, e, filters, cal);
  ok(`${label}: resident answered`, !!res);
  if (!res) return;
  const d = firstDiff(js, res);
  ok(`${label}: resident ≡ JS, Object.is leaf by leaf`, d === '', d);
}

function testDifferential(): void {
  const rows: Cell[][] = [
    ['a', '2024-01-05', 10.1, 'x'], ['b', '2024-01-09', 0.2, 'x'], ['c', '2024-01-20', 0.3, 'y'], ['d', '2024-01-28', 1e16, 'y'],
    ['a', '2024-02-02', 1, 'x'], ['d', '2024-02-03', -1e16, 'y'], ['b', '2024-03-15', 0.7, 'x'], ['a', '2024-03-16T08:00:00', null, 'x'],
    ['e', '02/10/2024', 7, 'y'], ['e', '2024-03-01', -0, 'y'], ['a', '2024-02-02', 1, 'x'],
    ['', '2024-01-01', 1, 'x'], ['  ', '2024-01-01', 1, 'x'], ['f', 'Jan 5, 2024', 1, 'x'], ['g', '2024-02-31', 1, 'x'],
    ['007', '2023-12-31', 3, 'y'], ['7', '2024-01-01', 4, 'y'],
  ];
  const f = fixture(COLS, rows);
  for (const grain of ['week', 'month', 'quarter'] as const) {
    diff(`diff/${grain}/retention`, f, enc({ grain }));
    diff(`diff/${grain}/value`, f, enc({ grain, show: 'value', value: 'amount' }));
  }
  diff('diff/week/Sunday start', f, enc({ grain: 'week' }), SUN);
  diff('diff/quarter/fiscal April', f, enc({ grain: 'quarter', show: 'value', value: 'amount' }), APRIL);
  for (const grain of ['week', 'month', 'quarter'] as const) {
    diff(`diff/${grain}/retail 4-5-4`, f, enc({ grain, show: 'value', value: 'amount' }), RETAIL);
    diff(`diff/${grain}/ISO week-year`, f, enc({ grain }), ISO_WEEKS);
  }
  diff('diff/filtered', f, enc(), MON, [{ type: 'filter', column: 'plan', op: '=', value: 'x' }]);
  diff('diff/filtered-to-nothing', f, enc(), MON, [{ type: 'filter', column: 'plan', op: '=', value: 'none' }]);
  diff('diff/empty-table', fixture(COLS, []), enc());

  const numCols: ParsedColumn[] = [{ name: 'id', type: 'number' }, { name: 'day', type: 'date' }];
  diff('diff/number entity keys on the number', fixture(numCols, [[1, '2024-01-01'], [1.0, '2024-02-01'], [null, '2024-01-01'], [2, '2024-03-01']]),
       enc({ entity: 'id' }));
}

function testSample(): void {
  const csv = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');
  if (!fs.existsSync(csv)) { ok('sample: assets/samples/retail-orders.csv exists', false, csv); return; }
  const parsed = parseCsv(fs.readFileSync(csv, 'utf8'), ',');
  const f = fixture(parsed.columns, parsed.rows);
  const e = enc({ entity: 'state', date: 'order_date' });
  diff('sample/states by first-order month', f, e);
  diff('sample/cumulative revenue per state, weekly', f, { ...e, grain: 'week', show: 'value', value: 'revenue' });
  diff('sample/quarterly, filtered to Technology', f, { ...e, grain: 'quarter' }, MON,
       [{ type: 'filter', column: 'category', op: '=', value: 'Technology' }]);
  const g = cohort.buildCohort(f.columns, f.rows, e, [], MON).grid;
  ok('sample: every state is in exactly one cohort', g.sizes.reduce((a, b) => a + b, 0)
     === new Set(f.rows.map((r) => r[parsed.columns.findIndex((c) => c.name === 'state')])).size);
}

function main(): void {
  testBoundaries();
  testRetention();
  testEdges();
  testCaption();
  testExportWhitelists();
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) console.log('ok   (skipped) the DuckDB bridge is unavailable — differential not run');
  else { testDifferential(); testSample(); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  finish();
}

main();
