'use strict';

// DIFFERENTIAL self-check for the `period` filter: the resident SQL
// (residentQuery.filterPredicate → periodSql) and the prepare-pipeline SQL
// (sqlGen via runResidentPipeline) against the JS fold (transforms.stepFilter),
// over the SAME stored bytes, compared with Object.is.
//
// Every relative preset is exercised on a pinned clock and two calendars, and
// so is every SHIFTED scope a KPI Compare or a chart overlay issues — the
// comparison figure is only as right as the second query that computes it.
// The fixture's date cells are the adversarial set: ISO and US shapes, single
// digits, a time suffix, a non-date (Feb 30), prose, NBSP/tab/empty, a number.
//
//   npm run build:ts && node scripts/test-periodResident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as rq from '../src/engine/residentQuery';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import * as metricValue from '../src/analysis/metricValue';
import * as vizData from '../src/analysis/vizData';
import { applyPipeline } from '../src/data/transforms';
import { runResidentPipeline } from '../src/engine/pipelineDuck';
import { setCalendar, PERIOD_PRESETS, N_PRESETS } from '../src/analysis/dateIntel';
import type { PeriodSpec } from '../src/analysis/dateIntel';
import { compareScope, overlayFilters } from '../src/analysis/periodScope';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';

import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-period-'));
function cleanup(): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const COLS: ParsedColumn[] = [
  { name: 'id', type: 'number' },
  { name: 'd', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'v', type: 'number' },
];

// Two years of first-and-fifteenth dates, in both canonical shapes, plus the
// cells a period must NOT read — spread across regions so a group-by has work.
const ROWS: Cell[][] = [];
{
  let id = 0;
  const regions = ['East', 'West', 'North'];
  for (let y = 2023; y <= 2025; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      for (const d of [1, 15, 28]) {
        const mm = String(m).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        // Mostly ISO, some US, some with a time — the three shapes a date
        // column really holds.
        const cell = id % 7 === 3 ? `${mm}/${dd}/${y}` : id % 11 === 5 ? `${y}-${mm}-${dd} 08:30:00` : `${y}-${mm}-${dd}`;
        ROWS.push([id, cell, regions[id % 3], (id * 37) % 101 + 0.25]);
        id += 1;
      }
    }
  }
  for (const junk of ['2024-02-30', 'Jan 5, 2024', '', ' ', '\t', null, '2024-3-5', ' 2024-03-05', '2024-10-15T23:59:59Z']) {
    ROWS.push([id, junk, 'East', 1]);
    id += 1;
  }
}

const file = path.join(dir, 'fixture.parquet');
pq.writeTable(file, COLS, ROWS);
const back = pq.readTable(file, COLS);
if (!back) throw new Error('fixture read-back failed');
const src: rq.ResidentSource = { parquetPath: file, columns: COLS };

/** The ids the JS fold keeps. */
function jsIds(filters: FilterStep[]): string {
  return JSON.stringify(applyPipeline({ columns: back!.columns, rows: back!.rows }, filters).rows.map((r) => r[0]));
}
/** The ids the resident predicate keeps, in stored order. */
function sqlIds(filters: FilterStep[]): string {
  const params: duck.DuckValue[] = [];
  const preds = rq.filterPredicates(COLS, filters, params);
  const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
  const rows = duck.query(`SELECT CAST(c0 AS DOUBLE) AS id FROM ${pq.relationSql(file, { fileRowNumber: true })}${where} ORDER BY file_row_number;`, params);
  return JSON.stringify(rows.map((r) => r.id));
}

function diff(label: string, filters: FilterStep[]): void {
  const want = jsIds(filters);
  ok(`${label}: resident rows === fold rows`, want === sqlIds(filters), `fold ${want}\n     sql  ${sqlIds(filters)}`);
  for (const aggregation of ['sum', 'count'] as metricValue.MetricAggregation[]) {
    const rows = applyPipeline({ columns: back!.columns, rows: back!.rows }, filters).rows;
    const w = metricValue.computeMetric(back!.columns, rows, { column: 'v', aggregation });
    const g = rq.computeMetricResident(src, { column: 'v', aggregation }, filters);
    ok(`${label}: ${aggregation}(v) resident === JS (${w})`, Object.is(w, g), `resident ${g}`);
  }
  const pipe = runResidentPipeline(file, COLS, filters);
  ok(`${label}: prepare-pipeline SQL rows === fold`, !!pipe && JSON.stringify(pipe.rows.map((r) => r[0])) === want);
}

function specs(): PeriodSpec[] {
  const out: PeriodSpec[] = [];
  for (const p of PERIOD_PRESETS) {
    if (p === 'custom') {
      out.push({ preset: 'custom', from: '2024-02-15', to: '2024-06-28' });
      out.push({ preset: 'custom', from: '2025-03-01' });
      out.push({ preset: 'custom', to: '2023-02-01' });
    } else if (N_PRESETS.has(p)) {
      out.push({ preset: p, n: 1 }, { preset: p, n: 3 });
    } else {
      out.push({ preset: p });
    }
  }
  return out;
}

if (!rq.isResident()) {
  console.error('FAIL periodResident: DuckDB bridge unavailable — nothing was verified');
  cleanup();
  process.exit(1);
}

// Two clocks × two calendars: mid-quarter with calendar years, and a date just
// after a July fiscal year starts with Sunday weeks.
const RUNS: Array<{ today: string; cal: { weekStart: number; fiscalYearStart: number } }> = [
  { today: '2024-10-15', cal: { weekStart: 1, fiscalYearStart: 1 } },
  { today: '2024-07-02', cal: { weekStart: 0, fiscalYearStart: 7 } },
];
const cols = COLS.map((c) => ({ name: c.name, type: c.type }));
const east: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'East' };

for (const run of RUNS) {
  process.env.ORDINATE_TODAY = run.today;
  setCalendar(run.cal);
  const tag = `${run.today} fy${run.cal.fiscalYearStart} ws${run.cal.weekStart}`;
  for (const spec of specs()) {
    const step: FilterStep = { type: 'filter', column: 'd', op: 'period', period: spec };
    const name = `${tag} ${spec.preset}${spec.n ? '(' + spec.n + ')' : ''}${spec.from || spec.to ? `[${spec.from || ''}..${spec.to || ''}]` : ''}`;
    diff(name, [step]);
    diff(name + ' & East', [east, step]);
    // The SHIFTED scopes a Compare and an overlay issue.
    for (const mode of ['previous_period', 'previous_year'] as const) {
      const moved = compareScope([east, step], cols, { mode });
      if (moved) diff(`${name} → ${mode}`, moved.filters);
    }
    diff(`${name} → overlay`, overlayFilters([step], cols));
  }
}

// A grouped chart under a period filter: aggregateResident vs buildVizData.
{
  process.env.ORDINATE_TODAY = '2024-10-15';
  setCalendar({ weekStart: 1, fiscalYearStart: 7 });
  for (const spec of [{ preset: 'this_year' }, { preset: 'last_n_months', n: 6 }] as PeriodSpec[]) {
    const filters: FilterStep[] = [{ type: 'filter', column: 'd', op: 'period', period: spec }];
    const want = vizData.buildVizData(back.columns, back.rows, { category: 'region', values: [{ column: 'v', aggregation: 'sum' }] }, filters).data;
    const plan = rq.resolveCatKey(src, 'region', [{ column: 'v', aggregation: 'sum' }], filters);
    const got = plan ? rq.aggregateResident(src, 'region', [{ column: 'v', aggregation: 'sum' }], filters, plan.key) : null;
    ok(`group by region under ${spec.preset}: labels agree`, !!got && JSON.stringify(got.labels) === JSON.stringify(want.labels));
    ok(`group by region under ${spec.preset}: values agree (Object.is)`, !!got && got.series[0].values.every((v, i) => Object.is(v, want.series[0].values[i])));
  }
}

delete process.env.ORDINATE_TODAY;
setCalendar({ weekStart: 1, fiscalYearStart: 1 });
cleanup();
duck.shutdown();
if (failureCount() > 0) {
  console.error(`\n${failureCount()} period differential check(s) failed`);
  process.exit(1);
}
console.log('\nAll period differential checks passed.');
