// Self-check for src/analysis/insights.ts + src/ipc/insights.ts.
//
// Two kinds of assertion, deliberately:
//
//   1. HAND-CHECKABLE NUMBERS. Each new kind gets a tiny fixture whose answer
//      you can work out on paper (the comments carry the arithmetic). These
//      pin WHAT the rule says, so a change that moves both aggregators together
//      still fails.
//   2. THE DIFFERENTIAL. `residentAgg` (SQL over a real .parquet) against
//      `jsAgg` (a fold over the round-tripped rows), compared field by field
//      with `Object.is`. Every fixture below is integer-valued on purpose:
//      parallel float summation differs from a JS left-fold by ~1e-13 (see the
//      known divergences in CLAUDE.md), and this suite must fail on a WRONG
//      figure, not on that.
//
//   npm run build:ts && node scripts/test-insights.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Insight = import('../src/analysis/insights').Insight;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-insights-ud-'));

// ── The electron stub (test-anomaliesResident.ts pattern) ───────────────────
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_n: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      dialog: {}, net: {}, nativeImage: {}, shell: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const insights: typeof import('../src/analysis/insights') = require('../src/analysis/insights');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const insightsIpc: typeof import('../src/ipc/insights') = require('../src/ipc/insights');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-insights-fx-'));
let fileSeq = 0;
function fixtureFile(): string {
  fileSeq += 1;
  return path.join(tmpDir, `f${fileSeq}.parquet`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  label: string;
  file: string;
  columns: ParsedColumn[];
  /** Rows as READ BACK from Parquet — what the JS reference must see. */
  rows: Cell[][];
}

function makeFixture(label: string, columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = fixtureFile();
  parquetStore.writeTable(file, columns, rows);
  const back = parquetStore.readTable(file, columns);
  if (!back) throw new Error(`fixture read-back failed: ${label}`);
  return { label, file, columns, rows: back.rows };
}

function show(i: Insight): string {
  const facts = Object.keys(i.facts).sort().map((k) => {
    const v = (i.facts as Record<string, unknown>)[k];
    return `${k}=${typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : JSON.stringify(v)}`;
  }).join('|');
  return `${i.id}§${i.kind}§${i.severity}§${i.title}§${i.detail}§{${facts}}§${JSON.stringify(i.chart ?? null)}`;
}

/** Field-by-field, `Object.is` on every scalar fact. */
function same(a: Insight[], b: Insight[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.kind !== y.kind || x.severity !== y.severity) return false;
    if (x.title !== y.title || x.detail !== y.detail) return false;
    if (!Object.is(x.column, y.column) || !Object.is(x.periodKey, y.periodKey)) return false;
    if (JSON.stringify(x.chart ?? null) !== JSON.stringify(y.chart ?? null)) return false;
    const kx = Object.keys(x.facts).sort();
    const ky = Object.keys(y.facts).sort();
    if (kx.join(',') !== ky.join(',')) return false;
    for (const k of kx) if (!Object.is((x.facts as any)[k], (y.facts as any)[k])) return false;
  }
  return true;
}

/** THE differential. Returns the resident list so a test can also pin it. */
function diff(f: Fixture, opts?: import('../src/analysis/insights').InsightOptions): Insight[] {
  const want = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows), opts);
  const got = insights.detectInsights('ds', f.columns, insights.residentAgg({ parquetPath: f.file, columns: f.columns }), opts);
  ok(`${f.label}: resident found something (not a silent empty fast path)`, got.length > 0);
  const equal = same(want, got);
  ok(`${f.label}: resident === JS (${want.length} insight${want.length === 1 ? '' : 's'})`, equal);
  if (!equal) {
    console.error('--- js       ---\n' + want.map(show).join('\n'));
    console.error('--- resident ---\n' + got.map(show).join('\n'));
  }
  return got;
}

function byKind(list: Insight[], kind: string): Insight[] {
  return list.filter((i) => i.kind === kind);
}

const COLS = (...spec: [string, ParsedColumn['type']][]): ParsedColumn[] =>
  spec.map(([name, type]) => ({ name, type }));

async function main(): Promise<void> {
  // ── movers ────────────────────────────────────────────────────────────────
  // Two periods, three regions. 2024-01 → 2024-02:
  //   West  100 → 150  = +50, +50%
  //   East  200 → 180  = -20, -10%
  //   North  50 →  25  = -25, -50%
  {
    const cols = COLS(['month', 'date'], ['region', 'text'], ['sales', 'number']);
    const rows: Cell[][] = [
      ['2024-01', 'West', 100], ['2024-01', 'East', 200], ['2024-01', 'North', 50],
      ['2024-02', 'West', 150], ['2024-02', 'East', 180], ['2024-02', 'North', 25],
    ];
    const f = makeFixture('movers', cols, rows);
    const list = diff(f);
    const movers = byKind(list, 'mover');
    ok('movers: all three regions moved, so all three are reported', movers.length === 3);

    const west = movers.find((m) => m.facts.category === 'West');
    ok('movers: West prev 100 / now 150 / change +50 / +50%',
      !!west && Object.is(west.facts.prev, 100) && Object.is(west.facts.now, 150)
      && Object.is(west.facts.change, 50) && Object.is(west.facts.pctChange, 0.5));
    ok('movers: West title names the app figure', !!west && west.title === 'West sales rose 50% in 2024-02');
    ok('movers: +50% is past the 25% warn line', !!west && west.severity === 'warn');
    ok('movers: the chart is that ONE category over time',
      !!west && west.chart?.type === 'line' && west.chart.encoding.category === 'month'
      && JSON.stringify(west.chart.filters) === JSON.stringify([{ type: 'filter', column: 'region', op: '=', value: 'West' }]));

    const east = movers.find((m) => m.facts.category === 'East');
    ok('movers: East -10% is info, not warn', !!east && east.severity === 'info' && Object.is(east.facts.pctChange, -0.1));

    const north = movers.find((m) => m.facts.category === 'North');
    ok('movers: North fell 50%', !!north && Object.is(north.facts.change, -25) && Object.is(north.facts.pctChange, -0.5));

    ok('movers: the id names the finding, not the figure',
      !!west && west.id === 'ds:mover:region:sales:West:2024-02');
    ok('movers: periodKey is the latest period', !!west && west.periodKey === '2024-02');
  }

  // ── movers: a category absent from the prior period ───────────────────────
  // South appears only in 2024-02, so prev is 0 and there is no percentage to
  // state. The card must still exist and must NOT invent one.
  {
    const cols = COLS(['month', 'date'], ['region', 'text'], ['sales', 'number']);
    const f = makeFixture('movers/new-category', cols, [
      ['2024-01', 'West', 100], ['2024-01', 'East', 200],
      ['2024-02', 'West', 100], ['2024-02', 'East', 200], ['2024-02', 'South', 70],
    ]);
    const list = diff(f);
    const south = byKind(list, 'mover').find((m) => m.facts.category === 'South');
    ok('movers: a brand-new category is reported', !!south && Object.is(south.facts.change, 70));
    ok('movers: …with NO pctChange fact (0 → 70 has no percentage)',
      !!south && !('pctChange' in south.facts) && !/%/.test(south.title));
    ok('movers: an unchanged category is not a mover',
      byKind(list, 'mover').every((m) => m.facts.category !== 'West'));
  }

  // ── trend + the 15% gate ──────────────────────────────────────────────────
  // y = 100, 110, 120, 130 over four periods. Least squares recovers it exactly:
  // slope 10, fitted start 100, total change 30 → +30%. Past the 15% gate.
  {
    const cols = COLS(['month', 'date'], ['sales', 'number']);
    const f = makeFixture('trend/up', cols, [
      ['2024-01', 100], ['2024-02', 110], ['2024-03', 120], ['2024-04', 130],
    ]);
    const list = diff(f);
    const t = byKind(list, 'trend')[0];
    ok('trend: slope 10, change 30, +30% over 4 periods',
      !!t && Object.is(t.facts.slope, 10) && Object.is(t.facts.change, 30)
      && Object.is(t.facts.pctChange, 0.3) && Object.is(t.facts.periods, 4));
    ok('trend: title states the app figure', !!t && t.title === 'sales trended up 30% over 4 periods');
    ok('trend: the chart is the measure over the date column',
      !!t && t.chart?.type === 'line' && t.chart.encoding.category === 'month' && !t.chart.filters);
  }
  {
    // y = 100, 103, 106, 109 → slope 3, change 9, +9%. Under the gate: silent.
    const cols = COLS(['month', 'date'], ['sales', 'number']);
    const f = makeFixture('trend/flat', cols, [
      ['2024-01', 100], ['2024-02', 103], ['2024-03', 106], ['2024-04', 109],
    ]);
    const jsList = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows));
    const resList = insights.detectInsights('ds', f.columns, insights.residentAgg({ parquetPath: f.file, columns: f.columns }));
    ok('trend: +9% is under the 15% gate — no trend insight', byKind(jsList, 'trend').length === 0);
    ok('trend: the gate is the same on both paths', same(jsList, resList));
    ok('trend: lowering the gate to 5% makes the SAME series report',
      byKind(insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows), { trendPct: 0.05 }), 'trend').length === 1);
  }
  {
    // Three periods is under MIN_TREND_PERIODS — a two-point "line" is not a trend.
    const cols = COLS(['month', 'date'], ['sales', 'number']);
    const f = makeFixture('trend/too-short', cols, [['2024-01', 10], ['2024-02', 50], ['2024-03', 90]]);
    ok('trend: three periods is too short to fit',
      byKind(insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows)), 'trend').length === 0);
  }
  {
    // Sixteen periods; only the LAST TWELVE are fitted. Periods 1-4 are noise at
    // 1000, then 12 periods of y = 100 + 10i → slope 10, change 110, +110%.
    const cols = COLS(['month', 'date'], ['sales', 'number']);
    const rows: Cell[][] = [];
    for (let i = 0; i < 4; i += 1) rows.push([`2023-0${i + 1}`, 1000]);
    for (let i = 0; i < 12; i += 1) rows.push([`2024-${String(i + 1).padStart(2, '0')}`, 100 + 10 * i]);
    const f = makeFixture('trend/window', cols, rows);
    const t = byKind(diff(f), 'trend')[0];
    ok('trend: only the last 12 periods are fitted (slope 10, +110%)',
      !!t && Object.is(t.facts.periods, 12) && Object.is(t.facts.slope, 10)
      && Object.is(t.facts.change, 110) && Object.is(t.facts.pctChange, 1.1)
      && t.facts.firstPeriod === '2024-01');
  }

  // ── concentration ─────────────────────────────────────────────────────────
  // 8 categories: 60, 20, 5, 5, 3, 3, 2, 2 → total 100. The top ONE is 60%,
  // which reaches the 60% share on its own; 1 of 8 = 12.5%, inside the 25% head.
  {
    const cols = COLS(['state', 'text'], ['revenue', 'number']);
    const vals = [60, 20, 5, 5, 3, 3, 2, 2];
    const f = makeFixture('concentration', cols,
      vals.map((v, i) => [`S${i}`, v] as Cell[]));
    const list = diff(f);
    const c = byKind(list, 'concentration')[0];
    ok('concentration: 1 of 8 carries 60 of 100',
      !!c && Object.is(c.facts.head, 1) && Object.is(c.facts.categories, 8)
      && Object.is(c.facts.headTotal, 60) && Object.is(c.facts.total, 100)
      && Object.is(c.facts.share, 0.6));
    ok('concentration: title reads as a sentence', !!c && c.title === '1 of 8 state are 60% of revenue');
    ok('concentration: the top category is named', !!c && c.facts.topCategory === 'S0' && Object.is(c.facts.topShare, 0.6));
  }
  {
    // Eight equal categories: the head needs 5 of 8 to reach 60%, which is not
    // a concentrated head. Nothing to report.
    const cols = COLS(['state', 'text'], ['revenue', 'number']);
    const f = makeFixture('concentration/flat', cols,
      [10, 10, 10, 10, 10, 10, 10, 10].map((v, i) => [`S${i}`, v] as Cell[]));
    const jsList = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows));
    const resList = insights.detectInsights('ds', f.columns, insights.residentAgg({ parquetPath: f.file, columns: f.columns }));
    ok('concentration: an even spread is not a finding', byKind(jsList, 'concentration').length === 0);
    ok('concentration: both paths agree it is not', same(jsList, resList));
  }

  // ── daily dates roll up to months past 24 distinct values ─────────────────
  {
    // 60 consecutive days across Jan/Feb/Mar 2024, one row each, revenue 1 per
    // day for two regions — except March, where West doubles.
    //   Feb: West 29, East 29   Mar: West 62, East 31
    // (Feb has 29 days in 2024; March has 31.) So West rose 33 (+113.8%) and
    // East rose 2 (+6.9%) from 2024-02 to 2024-03 — a MONTH-over-month move,
    // which is the whole point: day-over-day on 2 rows is not a finding.
    const cols = COLS(['day', 'date'], ['region', 'text'], ['revenue', 'number']);
    const rows: Cell[][] = [];
    const days = (m: number, n: number): void => {
      for (let d = 1; d <= n; d += 1) {
        const iso = `2024-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        rows.push([iso, 'West', m === 3 ? 2 : 1]);
        rows.push([iso, 'East', 1]);
      }
    };
    days(1, 31); days(2, 29); days(3, 31);
    const f = makeFixture('rollup', cols, rows);
    const list = diff(f);
    const movers = byKind(list, 'mover');
    const west = movers.find((m) => m.facts.category === 'West');
    ok('roll-up: 91 daily dates become monthly periods',
      !!west && west.facts.fromPeriod === '2024-02' && west.facts.toPeriod === '2024-03');
    ok('roll-up: West 29 → 62 is the MONTH total, not a day',
      !!west && Object.is(west.facts.prev, 29) && Object.is(west.facts.now, 62));
    ok('roll-up: the trend is fitted on months too',
      byKind(list, 'trend').every((t) => Object.is(t.facts.periods, 3) || t.facts.firstPeriod === '2024-01'));
  }
  {
    // 20 distinct days is UNDER the threshold, so days stay days.
    const cols = COLS(['day', 'date'], ['region', 'text'], ['revenue', 'number']);
    const rows: Cell[][] = [];
    for (let d = 1; d <= 20; d += 1) {
      const iso = `2024-01-${String(d).padStart(2, '0')}`;
      rows.push([iso, 'West', d === 20 ? 50 : 10]);
      rows.push([iso, 'East', 10]);
    }
    const f = makeFixture('rollup/under', cols, rows);
    const west = byKind(diff(f), 'mover').find((m) => m.facts.category === 'West');
    ok('roll-up: under 24 distinct dates, a period is still one day',
      !!west && west.facts.fromPeriod === '2024-01-19' && west.facts.toPeriod === '2024-01-20');
  }
  {
    // A non-ISO date column is never prefix-bucketed — a prefix of an unknown
    // shape is a guess, and `contains` on a guess is a wrong filter.
    const cols = COLS(['period', 'date'], ['region', 'text'], ['revenue', 'number']);
    const rows: Cell[][] = [];
    for (let q = 1; q <= 30; q += 1) {
      rows.push([`P${String(q).padStart(2, '0')}`, 'West', q]);
      rows.push([`P${String(q).padStart(2, '0')}`, 'East', 1]);
    }
    const f = makeFixture('rollup/non-iso', cols, rows);
    const west = byKind(diff(f), 'mover').find((m) => m.facts.category === 'West');
    ok('roll-up: a non-ISO date column keeps its raw values as periods',
      !!west && west.facts.fromPeriod === 'P29' && west.facts.toPeriod === 'P30');
  }

  // ── concentration is NOT limited to mover-sized columns ───────────────────
  {
    // 40 states: one at 600, thirty-nine at 10 = 990 total. The head needs 1
    // (600/990 = 60.6%), and 1 of 40 is well inside the 25% head. 40 > the 30
    // the MOVER gate allows, and that must not silence this.
    const cols = COLS(['state', 'text'], ['revenue', 'number']);
    const f = makeFixture('concentration/wide', cols,
      Array.from({ length: 40 }, (_, i) => [`S${i}`, i === 0 ? 600 : 10] as Cell[]));
    const c = byKind(diff(f), 'concentration')[0];
    ok('concentration: reported on a 40-value column the movers rule skips',
      !!c && Object.is(c.facts.categories, 40) && Object.is(c.facts.head, 1));
  }

  // ── the 12 cap, and the ranking that decides WHICH 12 ─────────────────────
  {
    // Two dimensions x two measures x ten categories, half rising and half
    // falling, over two periods: 4 triples x 6 movers = 24 candidates, twice
    // the cap. (The rule reports at most three up and three down per triple.)
    // Base 1000 each (10 000 a period); five rise and five fall by 500..900, so
    // the period total is unchanged and every move is 5-9% of it — comfortably
    // material, and none of them a base effect.
    const cols = COLS(['month', 'date'], ['region', 'text'], ['product', 'text'], ['sales', 'number'], ['units', 'number']);
    const rows: Cell[][] = [];
    for (let i = 0; i < 10; i += 1) {
      const size = 500 + (i % 5) * 100;
      const step = i < 5 ? size : -size;
      const r = `R${String(i).padStart(2, '0')}`;
      const p = `P${String(i).padStart(2, '0')}`;
      rows.push(['2024-01', r, p, 1000, 1000]);
      rows.push(['2024-02', r, p, 1000 + step, 1000 + step]);
    }
    const f = makeFixture('cap', cols, rows);
    const list = diff(f);
    ok('cap: no more than 6 cards of any ONE kind', list.length === 6 && byKind(list, 'mover').length === 6);
    ok('cap: warn findings are ranked before info',
      list.findIndex((i) => i.severity === 'info') === -1
      || list.slice(list.findIndex((i) => i.severity === 'info')).every((i) => i.severity === 'info'));
    // With the per-kind cap lifted, 24 candidate movers meet the 12 total cap.
    const wide = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows), { maxPerKind: 99 });
    ok('cap: never more than 12 insights for one dataset', wide.length === 12);
    ok('cap: maxTotal is honoured when lowered',
      insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows),
        { maxTotal: 3, maxPerKind: 99 }).length === 3);
    ok('cap: the survivors are the biggest contributors',
      wide.every((i) => typeof i.facts.contribution === 'number' && (i.facts.contribution as number) >= 0.02));
  }

  // ── materiality: a big percentage of a small number is not a finding ──────
  {
    // West is 9900 of a 10 000 period and moves 1%. Tiny is 100 → 300: +200%,
    // but only 2%… of nothing much. At 1000 total the 2% gate lets it through;
    // here the period is 10 000 and 200 is 2%, so raise the noise: Tiny moves
    // 100 → 150, which is +50% and 0.5% of the period. Below the gate.
    const cols = COLS(['month', 'date'], ['region', 'text'], ['sales', 'number']);
    const f = makeFixture('materiality', cols, [
      ['2024-01', 'West', 9900], ['2024-01', 'Tiny', 100],
      ['2024-02', 'West', 9850], ['2024-02', 'Tiny', 150],
    ]);
    const jsList = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows));
    const resList = insights.detectInsights('ds', f.columns, insights.residentAgg({ parquetPath: f.file, columns: f.columns }));
    ok('materiality: +50% on 0.5% of the period is not a mover',
      byKind(jsList, 'mover').length === 0, JSON.stringify(jsList.map((i) => i.title)));
    ok('materiality: both paths agree', same(jsList, resList));
  }
  {
    // A base effect: 1 → 500 is +49 900%, far past the credible ceiling, and it
    // is 50% of the period — so only the ceiling can stop it.
    const cols = COLS(['month', 'date'], ['region', 'text'], ['sales', 'number']);
    const f = makeFixture('base-effect', cols, [
      ['2024-01', 'West', 500], ['2024-01', 'Blip', 1],
      ['2024-02', 'West', 500], ['2024-02', 'Blip', 500],
    ]);
    const jsList = insights.detectInsights('ds', f.columns, insights.jsAgg(f.columns, f.rows));
    const resList = insights.detectInsights('ds', f.columns, insights.residentAgg({ parquetPath: f.file, columns: f.columns }));
    ok('base effect: +49 900% off a base of 1 is suppressed',
      byKind(jsList, 'mover').length === 0, JSON.stringify(jsList.map((i) => i.title)));
    ok('base effect: both paths agree', same(jsList, resList));
  }

  // ── which columns become the measures ─────────────────────────────────────
  {
    // Three number columns. `discount` comes FIRST in the schema but totals ~2;
    // `revenue` totals 60 000. Picking by column order would report on discount
    // and never mention revenue — which is exactly what the sample did.
    const cols = COLS(['month', 'date'], ['region', 'text'],
      ['discount', 'number'], ['ship_days', 'number'], ['revenue', 'number']);
    const rows: Cell[][] = [];
    for (let m = 1; m <= 6; m += 1) {
      const mm = `2024-0${m}`;
      rows.push([mm, 'West', 0.1, 3, 5000 + m * 1000]);
      rows.push([mm, 'East', 0.1, 4, 5000]);
    }
    const f = makeFixture('measures', cols, rows);
    const list = diff(f);
    ok('measures: the three biggest totals are chosen, not the first three',
      list.some((i) => i.facts.measure === 'revenue'), JSON.stringify(list.map((i) => i.title)));
    ok('measures: the trend is fitted on revenue',
      byKind(list, 'trend').some((t) => t.facts.measure === 'revenue'));
  }

  // ── the rules the aggregators must share ──────────────────────────────────
  {
    // '007' is a TEXT column (parse.ts keeps leading zeros), so summing it is
    // not a fast path that quietly answers 7 — it is no answer at all.
    const cols = COLS(['code', 'text'], ['month', 'date']);
    const f = makeFixture('text-measure', cols, [['007', '2024-01'], ['008', '2024-02']]);
    const js = insights.jsAgg(f.columns, f.rows);
    const res = insights.residentAgg({ parquetPath: f.file, columns: f.columns });
    ok('a text column is never summed (JS)', js('month', 'code') === null);
    ok('a text column is never summed (resident)', res('month', 'code') === null);
  }
  {
    // Empty is null OR '' OR whitespace, on both sides, and a group of them is
    // dropped rather than labelled ''.
    const cols = COLS(['region', 'text'], ['sales', 'number']);
    const f = makeFixture('empty-groups', cols, [
      ['West', 10], [null, 20], ['', 30], ['   ', 40], ['\t', 50], ['East', 60],
    ]);
    const js = insights.jsAgg(f.columns, f.rows)('region', 'sales');
    const res = insights.residentAgg({ parquetPath: f.file, columns: f.columns })('region', 'sales');
    ok('empty groups are dropped, first-seen order preserved (JS)',
      JSON.stringify(js) === JSON.stringify({ labels: ['West', 'East'], values: [10, 60] }));
    ok('…and identically on the resident path', JSON.stringify(js) === JSON.stringify(res));
  }
  {
    // A group with no finite value sums to null, never 0 — asymmetric on purpose.
    const cols = COLS(['region', 'text'], ['sales', 'number']);
    const f = makeFixture('null-sum', cols, [['West', null], ['East', 5]]);
    const js = insights.jsAgg(f.columns, f.rows)('region', 'sales');
    const res = insights.residentAgg({ parquetPath: f.file, columns: f.columns })('region', 'sales');
    ok('a group with nothing to sum is null, not 0 (JS)', js !== null && Object.is(js.values[0], null));
    ok('…and identically on the resident path', res !== null && Object.is(res.values[0], null));
  }

  // ── degenerate inputs never throw ─────────────────────────────────────────
  ok('no columns → []', insights.detectInsights('ds', [], () => null).length === 0);
  ok('a dead aggregator → []', insights.detectInsights('ds', COLS(['a', 'number']), () => null).length === 0);
  ok('a THROWING aggregator → []',
    insights.detectInsights('ds', COLS(['a', 'number'], ['b', 'date']), () => { throw new Error('x'); }).length === 0);
  ok('a null column list → []', insights.detectInsights('ds', null as any, () => null).length === 0);

  // ── dismiss persistence (the IPC + the project record) ────────────────────
  {
    await projects.init();
    await datasets.init();
    insightsIpc.register();
    const proj = await projects.createProject('Insights test');

    const cols = COLS(['month', 'date'], ['region', 'text'], ['sales', 'number']);
    const saved = await datasets.saveDataset(proj.id, {
      name: 'Sales', sourceKind: 'csv', columns: cols,
      rows: [
        ['2024-01', 'West', 100], ['2024-01', 'East', 200],
        ['2024-02', 'West', 150], ['2024-02', 'East', 180],
      ],
    } as any);
    const dsId = (saved as any).id as string;

    const list = handlers.get('insights:list') as IpcHandler;
    const dismiss = handlers.get('insights:dismiss') as IpcHandler;
    ok('both channels are registered', typeof list === 'function' && typeof dismiss === 'function');

    const first = await list(null, { projectId: proj.id, datasetId: dsId });
    ok('insights:list returns findings for a real dataset', first.ok === true && first.insights.length > 0);
    const victim = first.insights[0].id as string;

    const d = await dismiss(null, { projectId: proj.id, id: victim });
    ok('insights:dismiss stores the id on the project record', d.ok === true && d.dismissed.includes(victim));

    const second = await list(null, { projectId: proj.id, datasetId: dsId });
    ok('a dismissed insight is gone from the next list',
      second.insights.every((i: Insight) => i.id !== victim));
    ok('…and only that one is gone', second.insights.length === first.insights.length - 1);

    // The whole point: it survives a reload. Re-read the record off disk.
    const reread = await projects.getProject(proj.id);
    ok('the dismissal is on disk, not in memory', (reread?.dismissedInsights || []).includes(victim));

    const back = await dismiss(null, { projectId: proj.id, id: victim, dismissed: false });
    ok('un-dismissing removes it again', back.ok === true && !back.dismissed.includes(victim));
    const third = await list(null, { projectId: proj.id, datasetId: dsId });
    ok('…and the card comes back', third.insights.some((i: Insight) => i.id === victim));

    // Ids are stable across recomputes — that is what makes a dismissal stick.
    insightsIpc.clearCache();
    const fourth = await list(null, { projectId: proj.id, datasetId: dsId });
    ok('recomputing from scratch yields the same ids',
      JSON.stringify(fourth.insights.map((i: Insight) => i.id))
      === JSON.stringify(third.insights.map((i: Insight) => i.id)));

    const bogus = await dismiss(null, { projectId: 'not-a-uuid', id: 'x' });
    ok('a bad project id is an error, not a throw', bogus.ok === false);
    const none = await list(null, {});
    ok('a missing projectId is an empty list, not a throw', none.ok === true && none.insights.length === 0);
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' insights check(s) FAILED'); process.exit(1); }
    console.log('\nAll insights checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
