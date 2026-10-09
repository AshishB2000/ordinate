// The live-parity MATRIX, for any engine — helper for scripts/test-liveParity.ts
// (DuckDB, every `npm test`), scripts/test-liveParityPostgres.ts (CI's Postgres),
// scripts/test-liveParityClickhouse.ts (a nightly container) and the
// real-account nightly (scripts/warehouseLiveParity.ts: Snowflake, BigQuery).
// docs/live-data/00-plan.md L2.2, L2.8.
//
// One fixture (./liveParityFixture.ts) is loaded twice: as an EXTRACT (a real
// dataset, stored to Parquet like any other) and into the ENGINE, typed the way
// that warehouse types it. Then a generated matrix — aggregation × category
// kind × grain × filter op × series × top N — is asked of BOTH:
//
//   extract  the functions the app calls today: `vizDataFor` (charts, resident
//            or JS), `computeCardMetric` (KPI tiles), `computeCard` (answers);
//   live     adapt (liveSpec) → compile in the engine's dialect → the engine's
//            runner (on a real engine: its connector's own `runBound`) → shape
//            (evaluateLive).
//
// Labels and values agree under `Object.is`; sum/avg figures within the
// documented ~1e-13 float tolerance only; warnings and the category note
// byte-for-byte. Order is checked against each path's OWN rule. Divergences are
// named, pinned exceptions (./liveParityPins.ts), never a loosened comparison.
// The same comparison runs on every engine; only `stride` (a cloud warehouse
// bills per statement) thins the chart, KPI and answer cases — never a filter op.

import type { FilterStep } from '../src/data/transforms';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { AnswerSpec } from '../src/ai/answerSpec';
import type { LiveColumn, LiveIR } from '../src/engine/live/liveSpec';
import type { CompileEnv, CompiledQuery } from '../src/engine/live/compile';
import type { LiveOutcome, LiveStep } from '../src/engine/live/evaluate';
import type { LiveChart, LiveRows } from '../src/engine/live/shape';
import type { SqlDialect } from '../src/engine/live/dialect';
import type { ChartLike } from './liveParityCompare';
import type { ParityEngine, StoredColumn } from './liveParityFixture';

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ev: typeof import('../src/engine/live/evaluate') = require('../src/engine/live/evaluate');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

export type Ok = (label: string, cond: boolean, extra?: unknown) => void;
type Cell = import('../src/data/transforms').Cell;

const show = (v: unknown): string => JSON.stringify(v);
const TOLERANT = new Set(['sum', 'avg', 'none']);

/** The extract twin of the fixture: a saved dataset and the rows it reads back. */
export interface Extract {
  pid: string;
  did: string;
  rows: Cell[][];
  stored: { columns: import('../src/data/parse').ParsedColumn[]; rows: Cell[][] };
}

/** Save the fixture as an extract in a new project (local mode, or inside a request context on the server). */
export async function setupExtract(ok: Ok): Promise<Extract | null> {
  await projects.init();
  const project = await projects.createProject('Live parity');
  const rows = fx.fixtureRows();
  const imported = fx.importTyped(fx.COLUMNS, rows);
  const ds = await datasets.saveDataset(project.id, { name: 'Fixture', sourceKind: 'csv', columns: imported.columns, rows: imported.rows });
  if (!ds) { ok('saved the extract fixture', false); return null; }
  const back = await datasets.getDataset(project.id, ds.id);
  if (!back) { ok('read the extract back', false); return null; }
  ok(`fixture: ${rows.length} rows, every column kind`, rows.length > 400);
  ok('the extract stored −0 as 0 (String(cell)) — the reason live normalises −0',
    back.rows.some((r) => Object.is(r[3], 0)) && !back.rows.some((r) => Object.is(r[3], -0)) && rows.some((r) => Object.is(r[3], -0)));
  ok("the warehouse side holds '' AND NULL in `cat`; the extract, typed as an import types it, holds them as ONE null (whitespace-only cells stay text)",
    rows.some((r) => r[1] === '') && rows.some((r) => r[1] === null) && !back.rows.some((r) => r[1] === '') && back.rows.some((r) => r[1] === '\t'));
  return { pid: project.id, did: ds.id, rows, stored: { columns: back.columns, rows: back.rows } };
}

/** The columns a Live record of `stored` would declare: the fixture's types, the engine's type names. */
export function declared(engine: ParityEngine, stored: StoredColumn[], columns: LiveColumn[] = fx.COLUMNS): LiveColumn[] {
  return columns.map((c, i) => ({ ...c, sourceType: engine.typeName(stored[i].store) }));
}

/**
 * The comparisons, bound to one extract and one runner. Every function returns
 * PROBLEMS (empty = agree), so a negative control can run the very same check
 * and require that it finds something.
 */
export function parityKit(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>) {
  const live = (ir: LiveIR, env: CompileEnv): Promise<LiveOutcome> => ev.evaluateLive(ir, env, run);

  /** The extract's own order: first-seen over the filtered stored rows. */
  function extractFirstSeen(labels: (string | number)[], enc: VizEncoding, filters: FilterStep[], info: { kind: string; grain?: string; note?: string } | undefined): string[] {
    if (!info) return [];
    const t = transforms.applyPipeline({ columns: x.stored.columns, rows: x.stored.rows }, filters);
    const ci = t.columns.findIndex((c) => c.name === enc.category);
    const cells = t.rows.map((r) => r[ci]);
    if (info.kind === 'date') {
      const g = info.grain as import('../src/analysis/categoryKey').DateGrain;
      const keys = cells.map((c) => { const p = ck.parseDateCell(c); return p ? ck.dateBucket(p, g) : null; });
      return cmp.firstSeenProblems(labels, keys, (k) => (k === null ? '' : ck.dateBucketLabel(k as number, g)));
    }
    if (info.kind === 'number') {
      const nums = cells.filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
      const plan = ck.binPlan(nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : null, nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : null, enc.bins);
      const keys = cells.map((c) => (typeof c === 'number' && Number.isFinite(c) ? ck.binIndex(c, plan.lo, plan.width, plan.bins) : null));
      return cmp.firstSeenProblems(labels, keys, (k) => (k === null ? '' : ck.binLabel(k as number, plan.lo, plan.width, plan.bins, plan.hi)));
    }
    const kept = info.note ? new Set(labels.filter((l) => l !== ck.OTHER_LABEL)) : null;
    const keys = cells.map((c) => (kept && !kept.has(c == null ? '' : String(c)) ? '\u0000other' : c));
    return cmp.firstSeenProblems(labels, keys, (k) => (k === '\u0000other' ? ck.OTHER_LABEL : k == null ? '' : String(k)));
  }

  function sameInfo(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
    const o = a || {};
    return ['kind', 'grain', 'binned', 'note'].every((k) => Object.is(o[k], b[k]));
  }

  /**
   * Live's own order. Unsplit: checked directly. Split: the category order must
   * be the unsplit chart's (a category ranks by its TOTAL), and a text split's
   * series order the series column's own chart order.
   */
  async function liveOrder(ir: LiveIR, chart: LiveChart, env: CompileEnv): Promise<string[]> {
    const natural = ir.category!.kind !== 'text' && ir.order === 'natural';
    if (!ir.series) return cmp.liveOrderProblems(chart, natural ? 'natural' : 'value');
    if (natural) return cmp.liveOrderProblems(chart, 'natural');
    const out: string[] = [];
    // A category's rank is its TOTAL, here summed from the per-series parts and
    // in the flat chart summed directly — two summation orders, so totals that are
    // equal in exact arithmetic (241.9 vs 241.89999999999998, measured) may swap.
    // Within the float tolerance either order is right; beyond it, never.
    const flat = await live({ ...ir, series: undefined, measures: [ir.measures[0]], top: undefined }, env);
    if (flat.ok && flat.kind === 'chart') {
      // By KEY, not label: the key is what the statement grouped by (a NULL key is labelled '').
      const fk = flat.chart.keys.map((k) => show(k));
      const fv = flat.chart.data.series[0].values;
      const at = chart.keys.map((k) => fk.indexOf(show(k)));
      if (at.some((i) => i < 0)) out.push('a split category is missing from the flat chart');
      out.push(...cmp.orderedByTotal(chart.keys.map((k) => show(k)), (_k, i) => fv[at[i]] ?? null));
    }
    const scol = env.columns.find((c) => c.name === ir.series)!;
    const names = chart.data.series.map((s) => s.name);
    if (scol.type === 'text') {
      const byS = await live({ ...ir, category: { column: ir.series!, kind: 'text' }, series: undefined, measures: [ir.measures[0]], top: undefined, order: 'natural' }, env);
      if (byS.ok && byS.kind === 'chart') {
        const sl = byS.chart.data.labels;
        out.push(...cmp.orderedByTotal(names, (n) => byS.chart.data.series[0].values[sl.indexOf(n)] ?? null).map((p) => `series: ${p}`));
      }
    } else {
      const keys = names.map((n) => (n === '' ? null : Number(n)));
      for (let i = 1; i < keys.length; i += 1) if (cmp.keyCompare(keys[i - 1], keys[i]) >= 0) out.push(`number series out of order: ${show(names)}`);
    }
    return out;
  }

  async function chartProblems(enc: VizEncoding, filters: FilterStep[], env: CompileEnv): Promise<string[]> {
    const reply = await visualsIpc.vizDataFor(x.pid, x.did, enc, filters);
    if (!reply.ok) return [`extract failed: ${reply.error}`];
    const a = spec.fromVizEncoding(enc, filters, env.columns, {});
    if (!a.ok) return [`live refused: ${a.code}`];
    const out = await live(a.ir, env);
    if (!out.ok) return [`live refused: ${out.code} — ${out.message}`];
    if (out.kind !== 'chart') return ['live answered a metric'];
    const problems: string[] = [];
    const warnings = a.warnings.concat(out.warnings);
    if (show(reply.warnings) !== show(warnings)) problems.push(`warnings ${show(reply.warnings)} vs ${show(warnings)}`);
    if (!sameInfo(reply.category as Record<string, unknown> | undefined, out.chart.category as unknown as Record<string, unknown>)) {
      problems.push(`category ${show(reply.category)} vs ${show(out.chart.category)}`);
    }
    const split = !!enc.series;
    const aggs = a.ir.measures.map((m) => m.aggregation);
    problems.push(...cmp.compareCharts(reply.data, out.chart.data, (k) => TOLERANT.has(split ? aggs[0] : aggs[k]), split));
    problems.push(...extractFirstSeen(reply.data.labels, enc, filters, reply.category));
    problems.push(...(await liveOrder(a.ir, out.chart, env)));
    return problems;
  }

  async function metricProblems(m: { column: string; aggregation: import('../src/analysis/metricValue').MetricAggregation }, filters: FilterStep[], env: CompileEnv): Promise<string[]> {
    const ext = await dashIpc.computeCardMetric(x.pid, x.did, m, filters);
    const a = spec.fromMetric(m, filters, env.columns, {});
    if (!a.ok) return [`live refused: ${a.code}`];
    const out = await live(a.ir, env);
    if (!out.ok || out.kind !== 'metric') return [`live failed: ${show(out)}`];
    return cmp.sameNumber(ext.value, out.value, TOLERANT.has(m.aggregation)) ? [] : [`${show(ext.value)} vs ${show(out.value)}`];
  }

  async function answerProblems(s: AnswerSpec, env: CompileEnv): Promise<string[]> {
    const built = await answers.computeCard(x.pid, s);
    if ('ok' in built) return [`extract failed: ${built.reason}`];
    const card = built.card;
    const a = spec.fromAnswerSpec(s, env.columns, {});
    if (!a.ok) return [`live refused: ${a.code}`];
    const out = await live(a.ir, env);
    if (!out.ok || out.kind !== 'chart') return [`live failed: ${show(out)}`];
    const problems: string[] = [];
    const notes = a.warnings.concat(out.warnings);
    if (out.chart.category.note) notes.push(out.chart.category.note);
    if (show(card.notes) !== show(notes)) problems.push(`notes ${show(card.notes)} vs ${show(notes)}`);
    const aggs = a.ir.measures.map((m) => m.aggregation);
    const tol = (k: number): boolean => TOLERANT.has(s.series ? aggs[0] : aggs[k]);
    const date = a.ir.category!.kind === 'date';
    if (date) problems.push(...extractFirstSeen(card.data.labels, { category: s.category, values: s.measures, grain: s.grain }, card.steps, out.chart.category));
    else problems.push(...cmp.rankedProblems(card.data));
    problems.push(...(await liveOrder(a.ir, out.chart, env)));
    if (s.top === undefined || date) {
      problems.push(...cmp.compareCharts(card.data, out.chart.data, tol, !!s.series));
      return problems;
    }
    // A top N: every live row is the extract's own figure for that category, the
    // live cut is the live order's first N, and — unsplit — the N VALUES equal the
    // extract's N values. Tied categories AT the cut may differ (first-seen there,
    // label here); a split ranks by the category total here, by the first series
    // there (both pinned in liveParityPins).
    const withoutTop = { ...s };
    delete withoutTop.top;
    const full = await answers.computeCard(x.pid, withoutTop);
    const liveFull = await live({ ...a.ir, top: undefined }, env);
    if ('ok' in full || !liveFull.ok || liveFull.kind !== 'chart') return problems.concat(['no full ranking to compare']);
    const fullData = full.card.data;
    const keep = out.chart.data.labels.map((l) => fullData.labels.indexOf(l));
    const restricted: ChartLike = { labels: keep.map((i) => fullData.labels[i]), series: fullData.series.map((v) => ({ name: v.name, values: keep.map((i) => v.values[i]) })) };
    problems.push(...cmp.compareCharts(restricted, out.chart.data, tol, !!s.series));
    if (show(liveFull.chart.data.labels.slice(0, s.top)) !== show(out.chart.data.labels)) problems.push('live top N is not the head of its own order');
    if (!s.series) {
      const sortNum = (xs: (number | null)[]): (number | null)[] => xs.slice().sort((p, q) => (p ?? -Infinity) - (q ?? -Infinity));
      const ev0 = sortNum(card.data.series[0].values);
      const lv0 = sortNum(out.chart.data.series[0].values);
      if (ev0.length !== lv0.length || ev0.some((v, i) => !cmp.sameNumber(v, lv0[i], tol(0)))) problems.push(`top-N values ${show(ev0)} vs ${show(lv0)}`);
    }
    return problems;
  }

  return { live, chartProblems, metricProblems, answerProblems };
}

// ── The matrix ───────────────────────────────────────────────────────────────

export const M = (column: string, aggregation: VizMeasure['aggregation']): VizMeasure => ({ column, aggregation });
export const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);

const CATEGORIES: Partial<VizEncoding>[] = [
  { category: 'cat' }, { category: 'many' }, { category: 'region' }, { category: 'bigid' },
  { category: 'amt' }, { category: 'qty', bins: 20 }, { category: 'qty' },
  { category: 'd' }, { category: 'd', grain: 'day' }, { category: 'd', grain: 'week' }, { category: 'd', grain: 'month' },
  { category: 'd', grain: 'quarter' }, { category: 'd', grain: 'year' },
];
const MEASURES: VizMeasure[][] = [
  [M('amt', 'sum')], [M('amt', 'avg')], [M('cat', 'count')], [M('amt', 'min')], [M('qty', 'max')], [M('amt', 'none')],
  [M('d', 'count')], [M('amt', 'sum'), M('region', 'count'), M('qty', 'avg'), M('amt', 'max')],
];
const SERIES: (string | undefined)[] = [undefined, 'region', 'tier'];

/** Every operator on every column type — the extract's reference cases. */
export const FILTERS: FilterStep[][] = [
  [F('cat', '=', 'Alpha')], [F('cat', '=', '')], [F('cat', '=', '7')], [F('cat', '!=', '7')], [F('cat', '>', 'B')],
  [F('cat', '<', 'b')], [F('cat', '>=', 'Alpha')], [F('cat', '<=', '')], [F('cat', 'contains', 'a')], [F('cat', 'contains', '')],
  [F('cat', 'contains', '%')], [F('cat', 'contains', '_')], [F('cat', 'contains', 'a%b')], [F('cat', 'in', undefined, { values: ['Alpha', '007', null] })],
  [F('cat', 'not in', undefined, { values: ['Alpha', ''] })], [F('cat', 'in', undefined, { values: [] })], [F('cat', 'is_empty')], [F('cat', 'not_empty')],
  [F('amt', '=', 0.1)], [F('amt', '=', -0)], [F('amt', '=', '7')], [F('amt', '=', '007')], [F('amt', '!=', 12)], [F('amt', '>', 0)],
  [F('amt', '<', 0)], [F('amt', '>=', 12345.678)], [F('amt', '<=', -3.5)], [F('amt', 'in', undefined, { values: [0.1, '12', 'abc', null] })],
  [F('amt', 'not in', undefined, { values: [0.1] })], [F('amt', 'is_empty')], [F('amt', 'not_empty')], [F('qty', 'not in', undefined, { values: ['x'] })],
  [F('d', '=', '2024-01-01')], [F('d', '!=', '2024-01-01')], [F('d', '>', '2024-06-30')], [F('d', '<', '2024')], [F('d', '>=', '2024-12-30')],
  [F('d', '<=', '2023-12-31')], [F('d', 'in', undefined, { values: ['2024-02-29', '2025-01-01', null] })], [F('d', 'not in', undefined, { values: ['2024-02-29'] })],
  [F('d', 'contains', '2024-12')], [F('d', 'is_empty')], [F('d', 'not_empty')],
  [F('d', 'period', undefined, { period: { preset: 'custom', from: '2024-03-31', to: '2024-04-01' } })],
  [F('d', 'period', undefined, { period: { preset: 'custom', from: '2025-01-01' } })],
  [F('d', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } })], [F('d', 'period', undefined, { period: { preset: 'ytd' } })],
  [F('d', 'period', undefined, { period: { preset: 'last_year' } })], [F('d', 'period')],
  [F('bigid', '=', '12345678901234567890')], [F('bigid', 'contains', '345')], [F('nope', '=', 'x')], [F('cat', 'bogus' as FilterStep['op'], 'x')],
  [F('region', 'in', undefined, { values: ['North', 'South', null] }), F('qty', '>=', 3)], [F('many', 'contains', 'm1'), F('amt', '!=', 0.1)],
  // Values a warehouse's parameter transport must carry intact (ClickHouse's
  // TSV-escaped `param_`, Snowflake's and BigQuery's JSON binds): a tab, a quote,
  // a backslash, a decomposed é — matched, and matched by nothing.
  [F('cat', '=', '\t')], [F('cat', 'in', undefined, { values: ["O'Brien", '\t', 'e\u0301'] })], [F('cat', 'contains', "'\\")],
];

type Kit = ReturnType<typeof parityKit>;

async function charts(kit: Kit, ok: Ok, name: string, env: CompileEnv, opts: { categories?: Partial<VizEncoding>[]; measures?: VizMeasure[][]; series?: (string | undefined)[]; stride?: number } = {}): Promise<number> {
  let n = 0;
  let bad = 0;
  const stride = opts.stride ?? 1;
  let k = 0;
  for (const cat of opts.categories ?? CATEGORIES) {
    for (const values of opts.measures ?? MEASURES) {
      for (const series of opts.series ?? SERIES) {
        k += 1;
        if (k % stride !== 0) continue;
        // All-'none' with no split is the raw-points branch, refused on live by design (test-liveCompile).
        if (!series && values.every((v) => v.aggregation === 'none')) continue;
        const enc = { ...cat, values, ...(series ? { series } : {}) } as VizEncoding;
        for (const filters of [[], FILTERS[k % FILTERS.length]]) {
          const p = await kit.chartProblems(enc, filters, env);
          n += 1;
          if (p.length) {
            bad += 1;
            if (bad <= 12) ok(`${name}: ${show(enc)} ${show(filters)}`, false, p.join(' | '));
          }
        }
      }
    }
  }
  ok(`${name}: ${n} charts agree with the extract (labels, values, warnings, category, order)`, bad === 0, `${bad} disagree`);
  return n;
}

export interface MatrixReport {
  charts: number;
  metrics: number;
  answers: number;
  statements: number;
  ms: number;
  /** The compile environments the matrix ran (the pins reuse TYPED). */
  envs: { typed: CompileEnv; sql: CompileEnv; textNumbers: CompileEnv };
}

/**
 * Load the fixture into `engine` (typed, and with numbers stored as text) and
 * run the whole matrix against the extract. `stride` > 1 runs every stride-th
 * chart, KPI and answer case (every filter op still runs); the DuckDB bench and
 * the CI engines run them all.
 */
export async function runMatrix(x: Extract, engine: ParityEngine, opts: { ok: Ok; stride?: number; prefix?: string }): Promise<MatrixReport> {
  const { ok } = opts;
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  const label = (s: string): string => (engine.name === 'duckdb' ? s : `${engine.name}: ${s}`);
  let statements = 0;
  const kit = parityKit(x, (q, step) => { statements += 1; return engine.run(q, step); });
  cmp.stats.maxRelDev = 0;
  cmp.stats.tolerated = 0;

  const prefix = opts.prefix ?? '';
  const typedLayout = fx.layout(fx.COLUMNS);
  const textLayout = fx.layout(fx.COLUMNS, true);
  const typedSource = await engine.load(`${prefix}live_typed`, typedLayout, fx.warehouseCells(fx.COLUMNS, x.rows));
  const textSource = await engine.load(`${prefix}live_text`, textLayout, fx.warehouseCells(fx.COLUMNS, x.rows, true));
  const ident = dialects.dialectFor(engine.dialect).ident;
  const typedCols = declared(engine, typedLayout);
  const TYPED = fx.env(typedSource, typedCols, engine.dialect);
  // A defining query over the same rows, ending in a comment and a `;` (rule F3).
  const defining = typedSource.kind === 'table' ? `SELECT * FROM ${typedSource.parts.map(ident).join('.')}` : `SELECT * FROM (\n${typedSource.sql}\n) AS lv_def`;
  const SQL = fx.env({ kind: 'sql', sql: `${defining} -- every row, a trailing comment\n;` }, typedCols, engine.dialect);
  const TEXTNUM = fx.env(textSource, declared(engine, textLayout), engine.dialect);

  const started = Date.now();
  let n = await charts(kit, ok, label('typed table'), TYPED, { stride });
  n += await charts(kit, ok, label('defining query'), SQL, { stride: 7 * stride });
  n += await charts(kit, ok, label('numbers stored as text'), TEXTNUM, {
    categories: [{ category: 'amt' }, { category: 'qty', bins: 20 }, { category: 'cat' }, { category: 'd', grain: 'quarter' }],
    measures: [[M('amt', 'sum')], [M('amt', 'avg')], [M('amt', 'count')], [M('amt', 'min')], [M('qty', 'max')]],
    stride,
  });

  // Every filter op, on a chart and on two KPI tiles — at any stride.
  let fbad = 0;
  for (const f of FILTERS) {
    const p = (await kit.chartProblems({ category: 'cat', values: [M('amt', 'sum'), M('region', 'count')] }, f, TYPED))
      .concat(await kit.metricProblems({ column: 'amt', aggregation: 'sum' }, f, TYPED))
      .concat(await kit.metricProblems({ column: 'cat', aggregation: 'count' }, f, TYPED));
    if (p.length && ++fbad <= 8) ok(label(`filter ${show(f)}`), false, p.join(' | '));
  }
  ok(label(`every filter op (${FILTERS.length} steps) agrees on a chart and two KPIs`), fbad === 0, `${fbad} disagree`);

  // KPI tiles: every aggregation over every column kind, under a rotating filter.
  let mbad = 0;
  let mn = 0;
  const METRICS: [string, import('../src/analysis/metricValue').MetricAggregation][] = [
    ['amt', 'sum'], ['amt', 'avg'], ['amt', 'min'], ['amt', 'max'], ['amt', 'count'], ['qty', 'sum'], ['qty', 'avg'],
    ['cat', 'count'], ['d', 'count'], ['bigid', 'count'], ['region', 'count'], ['tier', 'max'],
  ];
  let mk = 0;
  for (const env of [TYPED, TEXTNUM, SQL]) {
    for (const [i, [column, aggregation]] of METRICS.entries()) {
      for (const f of [[], FILTERS[(i * 5) % FILTERS.length], FILTERS[(i * 11 + 3) % FILTERS.length]]) {
        if (++mk % stride !== 0) continue;
        const p = await kit.metricProblems({ column, aggregation }, f, env);
        mn += 1;
        if (p.length && ++mbad <= 8) ok(label(`metric ${aggregation}(${column}) ${show(f)}`), false, p.join(' | '));
      }
    }
  }
  ok(label(`${mn} KPI values agree with computeCardMetric`), mbad === 0, `${mbad} disagree`);

  // AI answers: ranked categories, top N, splits, data-relative periods.
  let abad = 0;
  let an = 0;
  const PERIODS: AnswerSpec['filters'][] = [
    [], [{ column: 'd', period: 'last_quarter' }], [{ column: 'd', period: 'last_year', yearsBack: 1 }],
    [{ column: 'region', op: '=', value: 'North' }], [{ column: 'd', period: 'last_month' }, { column: 'qty', op: '>', value: 4 }],
  ];
  let k = 0;
  for (const category of ['cat', 'many', 'region', 'qty', 'd']) {
    for (const measures of [[M('amt', 'sum')], [M('amt', 'avg')], [M('cat', 'count')], [M('qty', 'max'), M('amt', 'sum')]]) {
      for (const series of [undefined, 'region']) {
        for (const top of [undefined, 3, 7]) {
          k += 1;
          if (k % stride !== 0) continue;
          const s: AnswerSpec = { datasetId: x.did, category, measures, filters: PERIODS[k % PERIODS.length], chartType: 'column', title: 'q' };
          if (series && series !== category) s.series = series;
          if (top) s.top = top;
          const p = await kit.answerProblems(s, TYPED);
          an += 1;
          if (p.length && ++abad <= 8) ok(label(`answer ${show(s)}`), false, p.join(' | '));
        }
      }
    }
  }
  ok(label(`${an} AI answers agree with computeCard`), abad === 0, `${abad} disagree`);

  // A retail and an ISO week calendar: the warehouse groups by day, our code rolls up.
  for (const calendarType of ['445', 'iso']) {
    dateIntel.setCalendar({ weekStart: 1, fiscalYearStart: 1, calendarType, yearEnd: 'nearest' });
    n += await charts(kit, ok, label(`week calendar ${calendarType}`), TYPED, {
      categories: [{ category: 'd' }, { category: 'd', grain: 'day' }, { category: 'd', grain: 'week' }, { category: 'd', grain: 'month' }, { category: 'd', grain: 'quarter' }, { category: 'd', grain: 'year' }],
      measures: [[M('amt', 'sum')], [M('amt', 'avg')], [M('cat', 'count')], [M('amt', 'min')]],
      stride,
    });
  }
  dateIntel.setCalendar({ weekStart: 1, fiscalYearStart: 1 });

  const ms = Date.now() - started;
  console.log(`  ${engine.name} matrix${stride > 1 ? ` (every ${stride}th case)` : ''}: ${n} charts, ${mn} metrics, ${an} answers, ${statements} live statements in ${ms} ms; ` +
    `largest float deviation ${cmp.stats.maxRelDev.toExponential(2)} over ${cmp.stats.tolerated} tolerated sum/avg figures`);
  ok(label(`float deviations stay inside the documented ${cmp.REL_TOL} (max ${cmp.stats.maxRelDev})`), cmp.stats.maxRelDev <= cmp.REL_TOL);
  return { charts: n, metrics: mn, answers: an, statements, ms, envs: { typed: TYPED, sql: SQL, textNumbers: TEXTNUM } };
}

/**
 * The compiled text with every text-key fold (`CASE WHEN t = '' THEN NULL ELSE
 * t END`, compileFilter `keyText`) put back to the bare `t` — the compiler as
 * it was before L2.8. Fold-free text comes back unchanged.
 */
export function withoutBlankFold(sql: string): string {
  return sql.replace(/CASE WHEN (.+?) = '' THEN NULL ELSE \1 END/g, '$1');
}

/**
 * NEGATIVE CONTROL for the '' / NULL fold (found by L3.2, fixed in L2.8): the
 * same statements run with the fold stripped — '' and NULL two groups again —
 * must disagree with the extract on `cat`, whose warehouse twin holds both.
 * Returns the problems found; empty means the matrix could not see the fold.
 */
export async function unfoldedBlankCaught(x: Extract, engine: ParityEngine, typed: CompileEnv): Promise<{ problems: string[]; stripped: number }> {
  let stripped = 0;
  const kit = parityKit(x, (q, step) => {
    const sql = withoutBlankFold(q.sql);
    if (sql !== q.sql) stripped += 1;
    return engine.run({ ...q, sql }, step);
  });
  const problems = (await kit.chartProblems({ category: 'cat', values: [M('amt', 'sum')] }, [], typed))
    .concat(await kit.chartProblems({ category: 'region', values: [M('amt', 'sum')], series: 'cat' }, [], typed))
    .concat(await kit.answerProblems({ datasetId: x.did, category: 'cat', measures: [M('amt', 'sum')], filters: [], chartType: 'column', title: 'q', top: 30 }, typed));
  return { problems, stripped };
}

/**
 * NEGATIVE CONTROL, on the engine under test: the same comparisons with an
 * empty predicate that forgets whitespace (tab, NBSP, '  ' are not empty) must
 * find failures, or the run proves nothing. `blank` defaults to a spelling
 * every dialect accepts.
 */
export async function brokenBlankCaught(x: Extract, engine: ParityEngine, typed: CompileEnv, blank?: SqlDialect['blank']): Promise<string[]> {
  const kit = parityKit(x, engine.run);
  const broken = fx.env(typed.source, typed.columns, {
    ...dialects.dialectFor(engine.dialect), blank: blank ?? ((v: string) => `(${v} IS NULL OR ${v} = '')`),
  });
  return (await kit.chartProblems({ category: 'region', values: [M('cat', 'count')] }, [], broken))
    .concat(await kit.metricProblems({ column: 'cat', aggregation: 'count' }, [], broken))
    .concat(await kit.chartProblems({ category: 'region', values: [M('amt', 'sum')] }, [F('cat', 'is_empty')], broken));
}
