// Every SHAPE of question the semantic plan asks a layer (semantic layer part 7): each built by the plan itself
// (../src/engine/live/semantic/semanticPlan), so a backend's golden requests cover exactly what the doors ask.
// c1 wrote them for Snowflake (scripts/test-semanticSnowflake.ts); e1 shares them with Cube. Helper; not a suite.
//
// The environment names dimensions region, many (text), amt, tier (number) and d (date), and metrics revenue,
// orders and avg_amount. `qualified` adds Snowflake's TABLE.NAME members (a dimension and a metric); Cube has none.

import type { LiveIR } from '../src/engine/live/liveSpec';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const plan: typeof import('../src/engine/live/semantic/semanticPlan') = require('../src/engine/live/semantic/semanticPlan');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');

export const chartIr = (over: Partial<LiveIR> = {}): LiveIR =>
  ({ kind: 'chart', measures: [{ metric: 'revenue' }], category: { column: 'region', kind: 'text' }, filters: [], order: 'natural', weekCal: null, ...over });
export const KEPT = ['Zanzibar', 'Quokka'];

export function charted(ir: LiveIR, env: SemanticEnv): NonNullable<ReturnType<typeof plan.planChart>> & { ok: true } {
  const p = plan.planChart(ir, env);
  if (spec.isRefusal(p)) throw new Error(`the plan refused: ${p.code}`);
  return p;
}

/** Every shape of question the plan asks a layer, each from the plan itself. */
export function shapes(ENV: SemanticEnv, qualified?: { dimension: string; metric: string }): Array<[string, SemanticQuery]> {
  const out: Array<[string, SemanticQuery]> = [];
  const text = charted(chartIr(), ENV);
  out.push(['text axis, top 51', text.ranks], ['"Other", the 50 kept excluded', text.other!(KEPT)]);
  out.push(['text axis, every metric', charted(chartIr({ measures: [...ENV.metrics.keys()].map((metric) => ({ metric })) }), ENV).ranks]);
  for (const g of ck.DATE_GRAINS) out.push([`date axis by ${g}`, charted(chartIr({ category: { column: 'd', kind: 'date', grain: g } }), ENV).ranks]);
  const split = charted(chartIr({ category: { column: 'many', kind: 'text' }, series: 'region' }), ENV);
  out.push(['split: category ranks', split.ranks], ['split: series ranks', split.seriesRanks!], ['split: the kept cells', split.cells!(KEPT)], ['split: "Other" by series', split.other!(KEPT)]);
  out.push(['split by a number', charted(chartIr({ series: 'tier' }), ENV).cells!(KEPT)]);
  out.push(['date split', charted(chartIr({ category: { column: 'd', kind: 'date', grain: 'month' }, series: 'region' }), ENV).ranks]);
  const kpi = (filters: LiveIR['filters']): SemanticQuery => {
    const p = plan.planMetric({ kind: 'metric', measures: [{ metric: 'avg_amount' }], filters, order: 'natural', weekCal: null }, ENV);
    if (spec.isRefusal(p)) throw new Error(p.code);
    return p.query;
  };
  out.push(['KPI', kpi([])]);
  const FILTERS: Array<[string, LiveIR['filters'][number]]> = [
    ['text =', { kind: 'compare', column: 'region', op: '=', value: 'Zanzibar' }],
    ['text !=', { kind: 'compare', column: 'region', op: '!=', value: 'Zanzibar' }],
    ['text <', { kind: 'compare', column: 'region', op: '<', value: 'Quokka' }],
    ['number >', { kind: 'compare', column: 'amt', op: '>', value: 1234.5 }],
    ['number <=', { kind: 'compare', column: 'amt', op: '<=', value: 77.25 }],
    ['number >=', { kind: 'compare', column: 'tier', op: '>=', value: 3 }],
    ['date >', { kind: 'compare', column: 'd', op: '>', value: '2024-06-30' }],
    ['text in', { kind: 'in', column: 'region', values: ['Zanzibar', 'Quokka'], negate: false }],
    ['text not in', { kind: 'in', column: 'region', values: ['Zanzibar'], negate: true }],
    ['number in', { kind: 'in', column: 'amt', values: [1234.5, 77.25], negate: false }],
    ['contains', { kind: 'contains', column: 'many', value: 'wombat%_!' }],
    ['empty', { kind: 'empty', column: 'region', negate: false }],
    ['not empty', { kind: 'empty', column: 'amt', negate: true }],
    ['range', { kind: 'range', column: 'd', from: '2024-03-31', to: '2024-12-31' }],
    ['range from only', { kind: 'range', column: 'd', from: '2023-02-14' }],
    ...(qualified ? [['qualified name =', { kind: 'compare', column: qualified.dimension, op: '=', value: 'Shipped' }] as [string, LiveIR['filters'][number]]] : []),
  ];
  for (const [name, f] of FILTERS) out.push([`filter ${name}`, kpi([f])]);
  out.push(['two filters, a chart', charted(chartIr({ filters: FILTERS.slice(0, 2).map(([, f]) => f) }), ENV).ranks]);
  out.push(['an answer: top 5 by value', charted(chartIr({ order: 'value', top: 5 }), ENV).ranks]);
  out.push(['base filters lead the question', charted(chartIr(), { ...ENV, base: [{ kind: 'compare', column: 'tier', op: '=', value: 2 }] }).ranks]);
  if (qualified) out.push(['qualified names: a dimension and a metric', charted(chartIr({ category: { column: qualified.dimension, kind: 'text' }, measures: [{ metric: qualified.metric }] }), ENV).ranks]);
  const latest = plan.planLatest({ ...chartIr(), filters: [{ kind: 'latest', column: 'd', period: 'last_quarter', yearsBack: 0 } as LiveIR['filters'][number]] }, ENV);
  if (spec.isRefusal(latest)) throw new Error(latest.code);
  out.push(['lookup: the latest day', latest.queries[0].query]);
  const values = plan.planValues('many', [], ENV, { limit: 200 });
  const days = plan.planValues('d', [], ENV, { desc: true, limit: 1 });
  if (spec.isRefusal(values) || spec.isRefusal(days)) throw new Error('values refused');
  out.push(['lookup: a dimension\'s values', values], ['lookup: a date\'s values, latest first', days]);
  return out;
}

/** Every filter value a question carries (the empty string and null are in every text, so they say nothing). */
export function valuesOf(q: SemanticQuery): Array<string | number> {
  const out: Array<string | number> = [];
  const add = (v: unknown): void => { if ((typeof v === 'string' && v !== '') || typeof v === 'number') out.push(v); };
  for (const f of q.where) {
    if (f.kind === 'compare' || f.kind === 'contains') add(f.value);
    if (f.kind === 'in') f.values.forEach(add);
    if (f.kind === 'range') { add(f.from); add(f.to); }
  }
  q.exclude?.values.forEach(add);
  return out;
}
