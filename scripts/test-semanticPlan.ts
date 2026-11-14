'use strict';

// Self-check for the semantic-layer side of the Live engine (semantic layer part 7, b1): the IR's
// `{ metric }` measure, the layer refusals, and the PLAN that turns an IR into the questions a
// layer can answer (docs/semantic-layer/07-portability.md D12, D16, D17). Pure: no layer, no DuckDB.
//
//   npm run build:ts && node scripts/test-semanticPlan.js

import { ok, finish } from './selfcheck';
import type { LiveIR, LiveRefusal } from '../src/engine/live/liveSpec';

const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const shape: typeof import('../src/engine/live/shape') = require('../src/engine/live/shape');
const msg: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const sr: typeof import('../src/engine/live/semantic/semanticRefusals') = require('../src/engine/live/semantic/semanticRefusals');
const i18n: typeof import('../src/app/i18n') = require('../src/app/i18n');
const plan: typeof import('../src/engine/live/semantic/semanticPlan') = require('../src/engine/live/semantic/semanticPlan');

const show = (v: unknown): string => JSON.stringify(v);
const ENV = { dialect: 'duckdb' as const, source: { kind: 'table' as const, parts: ['orders'] }, columns: [{ name: 'amount', type: 'number' as const }] };

/** The refusal renders its own catalog key with its own parameters. */
const rendered = (r: LiveRefusal): boolean => i18n.t(r.key, r.params) === r.message && !r.message.includes('{');

function ir1(): void {
  const ir = { kind: 'metric', measures: [{ metric: 'revenue' }], filters: [], order: 'natural', weekCal: null } as LiveIR;
  const r = comp.compileMetric(ir, ENV);
  ok('the relational compiler refuses a metric measure', !r.ok && r.code === 'metricOnTable', show(r));
  ok('…in a sentence naming the metric', !r.ok && r.message.includes('revenue') && rendered(r), show(r));
  const chart = comp.compileChart({ kind: 'chart', category: { column: 'amount', kind: 'text' }, measures: [{ column: 'amount', aggregation: 'sum' }, { metric: 'revenue' }], filters: [], order: 'natural', weekCal: null }, { kind: 'text' }, ENV);
  ok('…and on a chart, whichever measure it is', !chart.ok && chart.code === 'metricOnTable');
  ok('isMetricMeasure tells the two measures apart', spec.isMetricMeasure({ metric: 'revenue' }) && !spec.isMetricMeasure({ column: 'amount', aggregation: 'sum' }));
  ok('a metric measure reads its one part', shape.measureValue({ metric: 'revenue' }, { s: null, c: null, n: null, x: null, d: null, v: 12 }) === 12);
  ok('…which is its own', show(comp.partsOf({ metric: 'revenue' })) === '["v"]' && show(comp.partsOf({ column: 'amount', aggregation: 'avg' })) === '["s","c"]');
  ok('a metric measure is named by the metric', shape.measureName({ metric: 'Gross margin' }) === 'Gross margin' && shape.measureName({ column: 'amount', aggregation: 'sum' }) === 'sum of amount');

  const r2 = sr.refuseLayer('pivot', { dataset: 'Sales', layer: 'Snowflake' });
  ok('a row-needing refusal keeps its code and names the layer', r2.code === 'pivot' && r2.message === 'A pivot table can\'t be drawn from Sales: Snowflake computes its metrics and returns totals, not rows.', show(r2));
  ok('metricMissing names the metric and the layer', sr.refuseLayer('metricMissing', { dataset: 'Sales', layer: 'dbt', metric: 'Revenue' }).message === 'Revenue is no longer defined in dbt.');
  ok('NEGATIVE CONTROL: plain refusals are byte-identical', spec.refuse('pivot').message === msg.livePivotRefused() && spec.refuse('pivot').key === 'liveRefusals.a_pivot_table_cannot_be_drawn');
  const every = sr.LAYER_CODES.map((code) => sr.refuseLayer(code, { dataset: 'Sales', layer: 'Cube', metric: 'Revenue', column: 'region' }));
  ok(`every layer refusal (${every.length}) renders its catalog key with its parameters`, every.length === 19 && every.every(rendered), show(every.filter((r) => !rendered(r))));
  ok('…each names the layer or the metric it is about', every.every((r) => r.message.includes('Cube') || r.message.includes('Revenue')), show(every.map((r) => r.message)));
  ok('a layer is named by its backend; an unknown one is "another tool"', sr.layerLabel('snowflake') === 'Snowflake' && sr.layerLabel('cube') === 'Cube' && sr.layerLabel('dbt') === 'dbt' && sr.layerLabel('acme') === 'another tool');
  sr.registerLayerLabel('fake', 'Fake layer (tests)');
  ok('…and a test adapter by the label it registers', sr.layerLabel('fake') === 'Fake layer (tests)');
}

// ── Task 2: the plan ─────────────────────────────────────────────────────────

type Env = import('../src/engine/live/semantic/semanticQuery').SemanticEnv;
const SENV: Env = {
  dataset: 'Sales', layer: 'Cube',
  columns: [{ name: 'region', type: 'text' }, { name: 'order_date', type: 'date' }, { name: 'tier', type: 'number' }, { name: 'shipped', type: 'date' }],
  metrics: new Map([['revenue', { additive: true }], ['avg_basket', { additive: false }]]),
  grains: new Map([['order_date', ['day', 'month', 'quarter']]]),
  caps: { lookups: false, binaryCompare: false },
};
const chart = (over: Partial<LiveIR> = {}): LiveIR => ({ kind: 'chart', category: { column: 'region', kind: 'text' }, measures: [{ metric: 'revenue' }], filters: [], order: 'natural', weekCal: null, ...over });
const code = (r: unknown): string | undefined => (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false ? (r as LiveRefusal).code : undefined);
const WEEKS = { kind: '445', weekStart: 1, fiscalYearStart: 1, yearEnd: 'nearest' } as unknown as LiveIR['weekCal'];

function plans(): void {
  const text = plan.planChart(chart(), SENV);
  ok('a text axis: the top 51 by the first metric, ties by the key', text.ok && show(text.ranks) === show({ dimensions: [{ name: 'region' }], metrics: ['revenue'], where: [], order: [{ by: 'revenue', desc: true }, { by: 'region', desc: false }], limit: 51 }), show(text));
  const kept = ['North', null];
  ok('"Other" excludes the kept categories and has no limit', text.ok && !!text.other && show(text.other(kept)) === show({ dimensions: [], metrics: ['revenue'], where: [], order: [], exclude: { dimension: 'region', values: ['North', null] } }) && !('limit' in text.other(kept)), show(text.ok && text.other?.(kept)));
  const many = plan.planChart(chart({ measures: [{ metric: 'revenue' }, { metric: 'avg_basket' }] }), SENV);
  ok('every metric rides in one question; the first ranks', many.ok && show(many.ranks.metrics) === '["revenue","avg_basket"]' && many.ranks.order[0].by === 'revenue');

  const month = plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'month' } }), SENV);
  ok('a date axis at a listed grain: no limit, ordered by the dimension, no "Other"', month.ok && show(month.ranks) === show({ dimensions: [{ name: 'order_date', grain: 'month' }], metrics: ['revenue'], where: [], order: [{ by: 'order_date', desc: false }] }) && !month.other, show(month));
  ok('a date axis with no grain → autoGrain', code(plan.planChart(chart({ category: { column: 'order_date', kind: 'date' } }), SENV)) === 'autoGrain');
  ok('…with a grain the layer does not list → autoGrain', code(plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'week' } }), SENV)) === 'autoGrain');
  ok('…on a date dimension with no grains listed → autoGrain', code(plan.planChart(chart({ category: { column: 'shipped', kind: 'date', grain: 'day' } }), SENV)) === 'autoGrain');
  ok('a week calendar at month → weekRollup', code(plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'month' }, weekCal: WEEKS }), SENV)) === 'weekRollup');
  ok('…at day no calendar is needed: planned', plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'day' }, weekCal: WEEKS }), SENV).ok);
  ok('number bins → bins', code(plan.planChart(chart({ category: { column: 'tier', kind: 'bins' } }), SENV)) === 'bins');
  ok('a date axis is never ranked', code(plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'month' }, order: 'value', top: 3 }), SENV)) === 'rankOnDate');

  const lock = { kind: 'in' as const, column: 'region', values: ['North'], negate: false, binary: true as const };
  ok('a row lock (binary) → layerRowPolicy', code(plan.planChart(chart({ filters: [lock] }), SENV)) === 'layerRowPolicy');
  ok('…on a KPI too', code(plan.planMetric({ kind: 'metric', measures: [{ metric: 'revenue' }], filters: [lock], order: 'natural', weekCal: null }, SENV)) === 'layerRowPolicy');
  const exact = plan.planChart(chart({ filters: [lock] }), { ...SENV, caps: { lookups: false, binaryCompare: true } });
  ok('NEGATIVE CONTROL: planned when the backend compares exactly, the lock kept', exact.ok && show(exact.ranks.where) === show([lock]));
  const inF = { kind: 'in' as const, column: 'region', values: ['North', null, 'e\u0301'], negate: true };
  const withIn = plan.planChart(chart({ filters: [inF, { kind: 'range', column: 'order_date', from: '2024-01-01' }] }), SENV);
  ok('an `in` filter becomes a SemanticFilter verbatim', withIn.ok && show(withIn.ranks.where) === show([inF, { kind: 'range', column: 'order_date', from: '2024-01-01' }]));
  ok('a filter on a name the layer does not declare → unknownColumn', code(plan.planChart(chart({ filters: [{ kind: 'empty', column: 'gone', negate: false }] }), SENV)) === 'unknownColumn');
  const based = plan.planChart(chart({ filters: [inF] }), { ...SENV, base: [{ kind: 'compare', column: 'region', op: '!=', value: 'Test' }] });
  ok('the dataset\'s base filters lead every question\'s filters', based.ok && show(based.ranks.where) === show([{ kind: 'compare', column: 'region', op: '!=', value: 'Test' }, inF]) && show(based.other!([]).where) === show(based.ranks.where));

  const col = plan.planChart(chart({ measures: [{ column: 'region', aggregation: 'count' }] }), SENV);
  ok('a column measure → columnOnLayer, naming the field', code(col) === 'columnOnLayer' && !col.ok && col.message.includes('region') && rendered(col));
  const gone = plan.planChart(chart({ measures: [{ metric: 'margin' }] }), SENV);
  ok('an unknown metric → metricMissing, naming it', code(gone) === 'metricMissing' && !gone.ok && gone.message === 'margin is no longer defined in Cube.');

  const split = plan.planChart(chart({ series: 'region', category: { column: 'region', kind: 'text' }, measures: [{ metric: 'revenue' }] }), SENV);
  ok('a text split: category ranks, series ranks, the kept cells and "Other" by series — four questions',
    split.ok && show(split.ranks) === show({ dimensions: [{ name: 'region' }], metrics: ['revenue'], where: [], order: [{ by: 'revenue', desc: true }, { by: 'region', desc: false }], limit: 51 })
      && show(split.seriesRanks) === show({ dimensions: [{ name: 'region' }], metrics: ['revenue'], where: [], order: [{ by: 'revenue', desc: true }, { by: 'region', desc: false }] })
      && show(split.cells!(['A'])) === show({ dimensions: [{ name: 'region' }, { name: 'region' }], metrics: ['revenue'], where: [{ kind: 'in', column: 'region', values: ['A'], negate: false }], order: [{ by: 'region', desc: false }, { by: 'region', desc: false }] })
      && show(split.other!(['A'])) === show({ dimensions: [{ name: 'region' }], metrics: ['revenue'], where: [], order: [{ by: 'region', desc: false }], exclude: { dimension: 'region', values: ['A'] } }), show(split));
  const numSplit = plan.planChart(chart({ series: 'tier' }), SENV);
  ok('a number split has no series ranks: its series run in key order', numSplit.ok && !numSplit.seriesRanks && !!numSplit.cells);
  const dateSplit = plan.planChart(chart({ category: { column: 'order_date', kind: 'date', grain: 'quarter' }, series: 'region' }), SENV);
  ok('a date split: one question for every cell, plus the series ranks', dateSplit.ok && dateSplit.ranks.dimensions.length === 2 && !dateSplit.cells && !dateSplit.other && !!dateSplit.seriesRanks);
  ok('a split by a date → dateSeries', code(plan.planChart(chart({ series: 'order_date' }), SENV)) === 'dateSeries');

  const kpi = plan.planMetric({ kind: 'metric', measures: [{ metric: 'avg_basket' }], filters: [inF], order: 'natural', weekCal: null }, SENV);
  ok('a KPI: no dimension, no order', kpi.ok && show(kpi.query) === show({ dimensions: [], metrics: ['avg_basket'], where: [inF], order: [] }));

  const latest = (caps: typeof SENV.caps) => plan.planValues('order_date', [], { ...SENV, caps }, { desc: true, limit: 1 });
  ok('the latest day (an empty answer\'s note) without lookups → layerLookup', code(latest({ lookups: false, binaryCompare: false })) === 'layerLookup');
  ok('…with them: the latest non-empty day, one row',
    show(latest({ lookups: true, binaryCompare: false })) === show({ dimensions: [{ name: 'order_date', grain: 'day' }], metrics: [], where: [{ kind: 'empty', column: 'order_date', negate: true }], order: [{ by: 'order_date', desc: true }], limit: 1 }), show(latest({ lookups: true, binaryCompare: false })));
}

/** Each question that can be checked is checked before any is asked: a split's series ranks first, its "Other" before its cells. */
async function checkedFirst(): Promise<void> {
  const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
  const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
  type Q = import('../src/engine/live/semantic/semanticQuery').SemanticQuery;
  const env: Env = { ...SENV, columns: [...SENV.columns, { name: 'seg', type: 'text' }] };
  const split = chart({ series: 'seg' });
  const refused = sr.refuseLayer('layerFilter', { dataset: 'Sales', layer: 'Cube', column: 'seg' });
  const evaluate = async (refuses: (q: Q) => boolean): Promise<{ code: string | undefined; asked: number }> => {
    let asked = 0;
    const run: import('../src/engine/live/semantic/evaluateSemantic').SemanticRunner = async (q) => {
      if (refuses(q)) return refused;
      asked += 1;
      const ranks = q.dimensions.length === 1 && q.dimensions[0].name === 'region';
      return { columns: sq.answerColumns(q), rows: ranks ? Array.from({ length: 60 }, (_v, i) => [`r${String(i).padStart(2, '0')}`, 60 - i]) : [] };
    };
    run.check = (q) => (refuses(q) ? refused : null);
    const r = await es.evaluateSemantic(split, env, run);
    return { code: code(r), asked };
  };
  const seriesRanks = (q: Q): boolean => q.dimensions.length === 1 && q.dimensions[0].name === 'seg' && !q.exclude;
  ok('a split whose series ranks the layer refuses is refused before any question is asked', show(await evaluate(seriesRanks)) === show({ code: 'layerFilter', asked: 0 }), show(await evaluate(seriesRanks)));
  ok('…one whose "Other" it refuses, after the ranks only (its cells not asked)', show(await evaluate((q) => !!q.exclude)) === show({ code: 'layerFilter', asked: 1 }), show(await evaluate((q) => !!q.exclude)));
  ok('NEGATIVE CONTROL: …refusing nothing, the four questions are asked', show(await evaluate(() => false)) === show({ code: undefined, asked: 4 }), show(await evaluate(() => false)));
}

void (async () => {
  ir1();
  plans();
  await checkedFirst();
  finish();
})();
