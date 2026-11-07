// Live calculated fields in the parity matrix (semantic layer part 8, step 04; docs/semantic-layer/08-engine.md
// Tests "Matrix") — helper for scripts/test-liveParity.ts (DuckDB, in full) and scripts/test-liveParityPostgres.ts
// (CI's Postgres, thinned).
//
// The fixture is saved again as an EXTRACT whose Prepare steps are CALC_STEPS (Prepare computes them in JS,
// `transforms.stepCalculatedField`), and the warehouse twin is asked through the same formulas as Live calcs
// (step 03's SQL in step 04's layers). Every case goes through the matrix's own comparison (./liveParityMatrix
// `parityKit`): labels and values under `Object.is`, sum/avg within the documented float tolerance only.
// A disagreement is fixed in the SQL builder or becomes a named pin (./liveParityPins), never a looser check.
//
// Cases: every aggregation over the number calcs; a distinct count of every calc (part 5's countd, which counts by
// the declared type, so a calc counts as its stored type); the text calcs (a boolean is text on both) as categories;
// bins over a calc; a split by one; every filter op moved onto a text and a number calc; the KPI of each; all
// of it again under a row access lock; then again under part 1 step 08's base filters (./liveParityBase BASE_P),
// which a copy runs as Prepare steps before the calcs and Live runs innermost, below every calc layer.
// NEGATIVE CONTROLS: Live with a wrong formula disagrees with the copy; so do the base-filtered questions without the base.

import type { FilterStep } from '../src/data/transforms';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { CompileEnv, CompiledQuery } from '../src/engine/live/compile';
import type { LiveStep } from '../src/engine/live/evaluate';
import type { LiveRows } from '../src/engine/live/shape';
import type { LiveCalc } from '../src/data/liveCalcs';
import type { Extract, Ok } from './liveParityMatrix';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const liveCalcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');
const rowLock: typeof import('../src/data/rowLock') = require('../src/data/rowLock');
const liveBase: typeof import('../src/engine/live/liveBase') = require('../src/engine/live/liveBase');
const formulaSql: typeof import('../src/engine/live/formulaSql') = require('../src/engine/live/formulaSql');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');

const show = (v: unknown): string => JSON.stringify(v);
const { M, F } = mx;

/** The formulas, as Prepare steps on the copy and as Live calcs. `upper` is refused on Live (casing), so the text calc trims. */
export const CALC_STEPS: { name: string; expression: string }[] = [
  { name: 'Margin', expression: '[amt] - [qty]' },
  { name: 'Margin2', expression: '[Margin] * 2' },
  { name: 'Band', expression: "IF [amt] > 100 THEN 'high' ELSEIF [amt] > 10 THEN 'mid' ELSE 'low' END" },
  { name: 'Big', expression: '[amt] > 100' },
  { name: 'R1', expression: 'round([amt], 1)' },
  { name: 'Yr', expression: 'year([d])' },
  { name: 'RegionT', expression: 'trim([region])' },
  { name: 'Either', expression: 'coalesce([cat], [region])' },
];
const NUMBERS = ['Margin', 'Margin2', 'R1', 'Yr'];
const TEXTS = ['Band', 'Big', 'RegionT', 'Either'];
const AGGS: VizMeasure['aggregation'][] = ['sum', 'avg', 'count', 'min', 'max'];

/** The calcs as a Live dataset stores them: each typed by the save-time check, in order. */
export function typedCalcs(columns: CompileEnv['columns'], list = CALC_STEPS): LiveCalc[] {
  const out: LiveCalc[] = [];
  for (const c of list) {
    const v = formulaSql.checkCalc(c.expression, columns, out);
    if (!v.ok) throw new Error(`${c.name}: ${v.error}`);
    out.push({ ...c, type: v.type });
  }
  return out;
}

/** `typed` with `calcs` as the dataset's calculated fields (the columns a record shows after `applyLive`). */
export function withCalcs(typed: CompileEnv, calcs: LiveCalc[]): CompileEnv {
  return { ...typed, source: { ...typed.source, calcs }, columns: [...typed.columns, ...liveCalcs.calcColumns(calcs)] };
}

/** A filter step moved onto a calc: `cat` → Band (text), `amt` → Margin (number); the rest as they are. */
function moved(steps: FilterStep[]): FilterStep[] {
  return steps.map((f) => (f.column === 'cat' ? { ...f, column: 'Band' } : f.column === 'amt' ? { ...f, column: 'Margin' } : f));
}

export async function calcCase(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>, typed: CompileEnv, ok: Ok, opts: { stride?: number; label?: string } = {}): Promise<void> {
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  const label = (s: string): string => (opts.label ? `${opts.label}: ${s}` : s);
  const ds = await datasets.saveDataset(x.pid, { name: 'Fixture with calcs', sourceKind: 'csv', ...fx.importTyped(fx.COLUMNS, x.rows) });
  const stepped = ds ? await datasets.updateSteps(x.pid, ds.id, CALC_STEPS.map((c) => ({ type: 'calculated_field', ...c }))) : null;
  if (!ds || !stepped || stepped.output.warnings.length) { ok(label('calcs: the copy with Prepare steps saved'), false, show(stepped?.output.warnings)); return; }
  const copy: Extract = { ...x, did: ds.id, stored: { columns: stepped.dataset.columns, rows: stepped.dataset.rows } };
  const calcs = typedCalcs(typed.columns);
  const env = withCalcs(typed, calcs);
  const kit = mx.parityKit(copy, run);
  ok(label('calcs: the copy types each calc as Live stores it'), calcs.every((c) => copy.stored.columns.find((k) => k.name === c.name)?.type === c.type),
    show([calcs.map((c) => c.type), copy.stored.columns.slice(-calcs.length).map((c) => c.type)]));

  const LOCK = rowLock.lockStep('region', ['North', 'South']);
  const encodings: VizEncoding[] = [
    ...NUMBERS.flatMap((n) => AGGS.map((a) => ({ category: 'cat', values: [M(n, a)] }))),
    ...TEXTS.flatMap((t) => [{ category: t, values: [M('amt', 'sum')] }, { category: t, values: [M('Margin', 'avg'), M(t, 'count')] }]),
    { category: 'Margin', values: [M('qty', 'count')] }, { category: 'Margin', bins: 20, values: [M('amt', 'sum')] }, { category: 'R1', values: [M('Margin2', 'max')] },
    { category: 'cat', series: 'Band', values: [M('Margin', 'sum')] }, { category: 'Band', series: 'region', values: [M('R1', 'avg')] },
    { category: 'Yr', values: [M('Either', 'count')] },
    ...[...NUMBERS, ...TEXTS].map((c) => ({ category: 'cat', values: [M(c, 'countd')] })), { category: 'Band', values: [M('Margin', 'countd'), M('amt', 'sum')] },
  ] as VizEncoding[];
  let n = 0;
  let bad = 0;
  let k = 0;
  for (const enc of encodings) {
    for (const filters of [[], [LOCK], moved(mx.FILTERS[k % mx.FILTERS.length])]) {
      if (++k % stride !== 0) continue;
      const p = await kit.chartProblems(enc, filters, env);
      n += 1;
      if (p.length && ++bad <= 12) ok(label(`calcs: ${show(enc)} ${show(filters)}`), false, p.join(' | '));
    }
  }
  ok(label(`calcs: ${n} charts agree with the Prepare-stepped copy (a measure, a category, bins, a split; plain, locked, filtered)`), bad === 0, `${bad} disagree`);

  // Every filter op, moved onto a calc, on a chart and two KPIs — at any stride, and under the lock.
  let fbad = 0;
  for (const f of mx.FILTERS) {
    for (const steps of [moved(f), [...moved(f), LOCK]]) {
      const p = (await kit.chartProblems({ category: 'region', values: [M('Margin', 'sum'), M('Band', 'count')] }, steps, env))
        .concat(await kit.metricProblems({ column: 'Margin', aggregation: 'sum' }, steps, env))
        .concat(await kit.metricProblems({ column: 'Band', aggregation: 'count' }, steps, env));
      if (p.length && ++fbad <= 8) ok(label(`calcs: filter ${show(steps)}`), false, p.join(' | '));
    }
  }
  ok(label(`calcs: every filter op (${mx.FILTERS.length}) moved onto Band and Margin agrees, plain and locked`), fbad === 0, `${fbad} disagree`);

  let mbad = 0;
  let mn = 0;
  const kpis: [string, import('../src/analysis/metricValue').MetricAggregation][] = [
    ...NUMBERS.flatMap((c) => (['sum', 'avg', 'min', 'max', 'count'] as const).map((a) => [c, a] as [string, typeof a])),
    ...TEXTS.map((c) => [c, 'count'] as [string, 'count']),
    ...[...NUMBERS, ...TEXTS].map((c) => [c, 'countd'] as [string, 'countd']),
  ];
  for (const [i, [column, aggregation]] of kpis.entries()) {
    for (const filters of [[], [LOCK], moved(mx.FILTERS[(i * 7) % mx.FILTERS.length])]) {
      if (++k % stride !== 0) continue;
      const p = await kit.metricProblems({ column, aggregation }, filters, env);
      mn += 1;
      if (p.length && ++mbad <= 8) ok(label(`calcs: KPI ${aggregation}(${column}) ${show(filters)}`), false, p.join(' | '));
    }
  }
  ok(label(`calcs: ${mn} KPIs over calcs agree with computeCardMetric`), mbad === 0, `${mbad} disagree`);

  // NEGATIVE CONTROL: the comparison sees a wrong formula.
  const wrong = withCalcs(typed, typedCalcs(typed.columns, [{ name: 'Margin', expression: '[amt] + [qty]' }, ...CALC_STEPS.slice(1)]));
  ok(label('calcs NEGATIVE CONTROL: Live with Margin as [amt] + [qty] disagrees with the copy'),
    (await kit.chartProblems({ category: 'cat', values: [M('Margin', 'sum')] }, [], wrong)).length > 0);
  ok(label('calcs NEGATIVE CONTROL: …and so does a distinct count of it'), (await kit.chartProblems({ category: 'cat', values: [M('Margin', 'countd')] }, [], wrong)).length > 0
    && (await kit.metricProblems({ column: 'Margin', aggregation: 'countd' }, [], wrong)).length > 0);
  ok(label('calcs NEGATIVE CONTROL: …and a wrong filter value on a calc is seen too'),
    (await kit.metricProblems({ column: 'Margin', aggregation: 'sum' }, [F('Band', '=', 'mid')], withCalcs(typed, typedCalcs(typed.columns, [
      ...CALC_STEPS.slice(0, 2), { name: 'Band', expression: "IF [amt] > 100 THEN 'high' ELSEIF [amt] > 11 THEN 'mid' ELSE 'low' END" }, ...CALC_STEPS.slice(3)])))).length > 0);

  // Under the base filters: the copy's Prepare steps are BASE_P, then the calcs; Live puts the base innermost.
  const { BASE_P } = require('./liveParityBase') as typeof import('./liveParityBase');
  const bds = await datasets.saveDataset(x.pid, { name: 'Fixture with base filters and calcs', sourceKind: 'csv', ...fx.importTyped(fx.COLUMNS, x.rows) });
  const bStepped = bds ? await datasets.updateSteps(x.pid, bds.id, [...BASE_P, ...CALC_STEPS.map((c) => ({ type: 'calculated_field' as const, ...c }))]) : null;
  const b = liveBase.liveBaseOf(BASE_P, typed.columns);
  if (!bds || !bStepped || bStepped.output.warnings.length || !b.ok) { ok(label('calcs under base: the copy saved and the base adapts'), false, show([bStepped?.output.warnings, b])); return; }
  const bKit = mx.parityKit({ ...x, did: bds.id, stored: { columns: bStepped.dataset.columns, rows: bStepped.dataset.rows } }, run);
  const bEnv: CompileEnv = { ...env, base: b.base };
  let bn = 0;
  let bbad = 0;
  for (const enc of encodings) {
    for (const filters of [[], [LOCK], moved(mx.FILTERS[k % mx.FILTERS.length])]) {
      if (++k % stride !== 0) continue;
      const p = await bKit.chartProblems(enc, filters, bEnv);
      bn += 1;
      if (p.length && ++bbad <= 8) ok(label(`calcs under base: ${show(enc)} ${show(filters)}`), false, p.join(' | '));
    }
  }
  for (const [column, aggregation] of kpis) {
    for (const filters of [[], [LOCK]]) {
      if (++k % stride !== 0) continue;
      const p = await bKit.metricProblems({ column, aggregation }, filters, bEnv);
      bn += 1;
      if (p.length && ++bbad <= 8) ok(label(`calcs under base: KPI ${aggregation}(${column}) ${show(filters)}`), false, p.join(' | '));
    }
  }
  ok(label(`calcs under base: ${bn} charts and KPIs agree with the copy stepped [...BASE_P, ...calcs] (plain, locked, filtered)`), bn > 0 && bbad === 0, `${bbad} disagree`);
  ok(label('calcs under base NEGATIVE CONTROL: the same questions without the base disagree with that copy'),
    (await bKit.chartProblems({ category: 'Band', values: [M('Margin', 'sum')] }, [], env)).length > 0);
}
