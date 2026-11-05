// Fan-out charts (semantic layer part 8, step 06): a chart on Customers with measures from its many sides
// (Orders, Returns) is ONE question per table, each on the path D10 pins, lined up by label.
//
//   § plan     the pure planner: which questions, on which pinned paths (categoryVia, a filter's via),
//              which filters narrow which measures, and every D13 refusal with its own sentence
//
//   npm run build:ts && node scripts/test-fanOut.js

import { ok, finish } from './selfcheck';
import type { VizEncoding } from '../src/analysis/visuals';
import type { FilterStep } from '../src/data/transforms';
import * as fx from './fanOutFixture';
import * as fp from '../src/analysis/fanOutPlan';
import * as msg from '../src/analysis/fanOutMessages';

const { CUSTOMERS, ORDERS, RETURNS, REGIONS, R_OC, R_OR, R_RC, R_CR, RELS, infos, M, F } = fx;
const C = CUSTOMERS.id;
const O = ORDERS.id;
const R = RETURNS.id;
const G = REGIONS.id;
const show = (v: unknown): string => JSON.stringify(v);
const plan = (enc: VizEncoding, filters: FilterStep[] = []): fp.FanOutPlan => {
  const p = fp.planFanOut(C, enc, filters, RELS, infos);
  if (!p || !p.ok) throw new Error(`does not plan: ${show(p)}`);
  return p.plan;
};

async function main(): Promise<void> {
  // ── § plan ────────────────────────────────────────────────────────────────
  const THREE: VizEncoding = { category: 'zone', categoryDatasetId: G, values: [M('id', 'count'), M('amount', 'sum', O), M('refund', 'sum', R)] };
  const p = plan(THREE, [F('region', '=', 'West'), F('order_date', '>=', '2024-01-01')]);
  ok('three questions: Customers, Orders, Returns', show(p.questions.map((q) => q.datasetId)) === show([C, O, R]), show(p.questions.map((q) => q.datasetId)));
  ok('each question answers its own measures, in the chart\'s order', show(p.questions.map((q) => q.measures)) === show([[0], [1], [2]]));
  ok('Customers\' question is the chart\'s own, minus the many-side measures and the Orders-only filter',
    show(p.questions[0].encoding) === show({ ...THREE, values: [M('id', 'count')] }) && show(p.questions[0].filters) === show([F('region', '=', 'West')]), show(p.questions[0]));
  ok('Orders\' question reaches zone through Customers (R_CR), pinned, never ship_region', p.questions[1].encoding.categoryVia === R_CR
    && p.questions[1].encoding.categoryDatasetId === G && show(p.questions[1].encoding.values) === show([M('amount', 'sum')]), show(p.questions[1].encoding));
  ok('Returns\' question needs no categoryVia: its default path to Regions IS Returns → Customers → Regions',
    p.questions[2].encoding.categoryVia === undefined && p.questions[2].encoding.categoryDatasetId === G, show(p.questions[2].encoding));
  ok('the bare region filter reaches Orders as Customers.region (via R_OC), never Orders.region',
    show(p.questions[1].filters[0]) === show({ ...F('region', '=', 'West'), via: R_OC }), show(p.questions[1].filters));
  ok('…and Returns through R_RC', show(p.questions[2].filters) === show([{ ...F('region', '=', 'West'), via: R_RC }]), show(p.questions[2].filters));
  ok('order_date narrows Revenue only: Orders gets it, Customers and Returns do not, and the note says so',
    show(p.questions[1].filters[1]) === show(F('order_date', '>=', '2024-01-01')) && p.questions[2].filters.length === 1
    && show(p.notes) === show([{ kind: 'ownRows', measures: [1, 2] }, { kind: 'narrows', column: 'order_date', measures: [1] }]), show(p.notes));

  // Many sides alone: no Customers question, and a split rides on values[0] (a split draws one measure).
  const alone = plan({ category: 'segment', values: [M('amount', 'sum', O), M('refund', 'avg', R)] });
  ok('many-side measures alone: no Customers question; the category on Customers is named by id',
    show(alone.questions.map((q) => [q.datasetId, q.encoding.categoryDatasetId, q.encoding.categoryVia ?? null])) === show([[O, C, null], [R, C, null]]));
  const split = plan({ category: 'segment', series: 'tier', values: [M('amount', 'sum', O), M('id', 'count')] });
  ok('a split: one question for values[0], the split on Customers by Orders\' default path',
    split.questions.length === 1 && split.questions[0].encoding.seriesDatasetId === C && show(split.questions[0].encoding.values) === show([M('amount', 'sum')]), show(split));
  const twoPaths = plan({ category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum', O), { ...M('amount', 'max', O), via: R_OC }] });
  ok('the same many side twice by the same path is ONE question', twoPaths.questions.length === 1 && show(twoPaths.questions[0].measures) === show([0, 1]));
  const viaZone = plan({ category: 'zone', categoryDatasetId: G, categoryVia: R_CR, values: [M('amount', 'sum', O)] });
  ok('a categoryVia that IS Customers\' default path plans the same question', show(viaZone.questions[0].encoding) === show({ ...plan({ category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum', O)] }).questions[0].encoding }));
  const onlyMany = plan({ category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O)] }, [F('ship_region', '=', 'East'), F('nope', '=', 1)]);
  ok('a column only Orders has goes to Orders bare; one no table has stays on every question (each skips it as today)',
    show(onlyMany.questions[0].filters) === show([F('nope', '=', 1)]) && show(onlyMany.questions[1].filters) === show([F('ship_region', '=', 'East'), F('nope', '=', 1)])
    && show(onlyMany.notes) === show([{ kind: 'ownRows', measures: [1] }, { kind: 'narrows', column: 'ship_region', measures: [1] }]), show(onlyMany));

  ok('NEGATIVE CONTROL: a chart with only forward measures is not planned', fp.planFanOut(O, { category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum')] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: a chart on Customers with no measure from another table is not planned', fp.planFanOut(C, { category: 'zone', categoryDatasetId: G, values: [M('id', 'count')] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: an unrelated measure is not planned (today\'s sentence answers)',
    fp.planFanOut(C, { category: 'segment', values: [M('amount', 'sum', O), M('x', 'sum', fx.ID(9))] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: a split whose drawn measure is Customers\' own is not planned', fp.planFanOut(C, { category: 'segment', series: 'tier', values: [M('id', 'count'), M('amount', 'sum', O)] }, [], RELS, infos) === null);

  const base: VizEncoding = { category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O)] };
  const REFUSED: [string, VizEncoding, string][] = [
    ['a category from Orders with a Customers count', { ...base, category: 'ship_region', categoryDatasetId: O }, msg.fanOutManySide('ship_region', 'Orders', 'Customers')],
    ['a split from Orders', { category: 'segment', series: 'ship_region', seriesDatasetId: O, values: [M('amount', 'sum', O)] }, msg.fanOutManySide('ship_region', 'Orders', 'Customers')],
    ['a category on Regions reached only from Orders', { ...base, category: 'zone', categoryDatasetId: G, categoryVia: R_OR }, msg.fanOutOffPath('zone', 'Orders', 'Customers')],
    ['a facet', { ...base, facet: { rows: 'tier' } }, msg.fanOutShape()],
    ['a pivot', { ...base, pivot: { rows: ['segment'], columns: [], values: [M('amount', 'sum')] } } as unknown as VizEncoding, msg.fanOutShape()],
    ['a map', { ...base, geo: { level: 'us_state' } }, msg.fanOutShape()],
    ['raw points', { category: 'segment', values: [M('amount', 'none', O)] }, msg.fanOutShape()],
  ];
  for (const [why, enc, sentence] of REFUSED) {
    const r = fp.planFanOut(C, enc, [], RELS, infos);
    ok(`refused, with its sentence: ${why}`, !!r && !r.ok && r.error === sentence, show(r));
  }
  ok('the sentences differ, and none is findPath\'s', new Set(REFUSED.map((x) => x[2])).size === 3 && REFUSED.every((x) => !/inflated/.test(x[2])));

  fx.removeFixture();
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
