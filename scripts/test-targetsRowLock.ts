// A metric's target for a row-restricted viewer (semantic layer part 5, step 09): the actuals and the plan are both
// restricted or neither — a target restricted on one side only is never shown (it would compare a slice to a whole).
// Real users with real grants in a scratch Postgres (scripts/rowPolicyHarness.ts).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-targetsRowLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import type { Cell, FilterStep } from '../src/data/transforms';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const targetResolve: typeof import('../src/ipc/targetResolve') = require('../src/ipc/targetResolve');
const tm: typeof import('../src/analysis/targetMessages') = require('../src/analysis/targetMessages');

const step = (column: string, op: string, value: string): FilterStep => ({ type: 'filter', column, op, value } as FilterStep);
const NOV = [step('day', '>=', '2024-11-01'), step('day', '<=', '2024-11-30')];

void (async () => {
  const W = await H.world('targets under a row lock');
  if (!W) return finish();
  try {
    const { P } = W;
    process.env.ORDINATE_TODAY = '2024-11-20';
    const SALES = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }];
    const PLAN = [{ name: 'month', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }];
    const sales: Cell[][] = [];
    for (let d = 1; d <= 20; d++) sales.push([`2024-11-${String(d).padStart(2, '0')}`, d % 2 ? 'West' : 'East', 100]);
    const mk = (name: string, columns: unknown[], rows: Cell[][]) => W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows } as never))!.id);
    const S = await mk('Target sales', SALES, sales);
    const PD = await mk('Target plan', PLAN, [['2024-11-01', 'East', 600_000], ['2024-11-01', 'West', 600_000]]);
    const plan = await W.as('boss', async () => metricsMod.saveMetric(P, { name: 'Plan', datasetId: PD, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'month' }));
    const rev = await W.as('boss', async () => metricsMod.saveMetric(P, { name: 'Rev', datasetId: S, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day', target: { source: { metricId: plan!.id }, per: 'month' } }));
    const rules = (on: boolean) => (on ? { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } : null);
    const setRules = async (datasetId: string, on: boolean): Promise<void> => {
      const r = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId, policy: rules(on) });
      if (r.body?.ok !== true) throw new Error(`setRowPolicy: ${r.text}`);
    };
    const target = (who: string) => W.as(who, async () => targetResolve.metricTarget(P, (await metricsMod.getMetric(P, rev!.id))!, NOV, 1000));
    const cases: [string, boolean, boolean, boolean][] = [['both restricted', true, true, true], ['neither', false, false, true], ['actuals only', true, false, false], ['plan only', false, true, false]];
    for (const [who, onSales, onPlan, shown] of cases) {
      await setRules(S, onSales);
      await setRules(PD, onPlan);
      const t = await target('east');
      ok(`east, row rules ${who}: ${shown ? 'shown' : 'not shown'}`, shown ? t?.none === undefined && t?.value !== null : t?.none === tm.targetRowRules() && t?.value === null, JSON.stringify(t));
    }
    // An alert reaches every reader (fan-out): a target rule that reads a dataset with row rules, actuals or plan, is refused whole.
    const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
    const rule = { id: '6b1c2f00-0000-4000-8000-000000000001', name: 'Rev off plan', datasetId: S, enabled: true, compare: 'target', targetPct: { op: 'below', pct: 90 }, metric: { column: '', aggregation: 'sum', metricId: rev!.id, filters: NOV } };
    const refused = (): Promise<boolean> => W.as('boss', () => alertStore.testRule(P, rule)).then(() => false, () => true);
    await setRules(S, false);
    await setRules(PD, false);
    ok('NEGATIVE CONTROL: with no row rules the target rule would fire', (await W.as('boss', () => alertStore.testRule(P, rule))).fire === true);
    await W.as('boss', () => alertStore.restoreRule(P, rule));
    await setRules(PD, true);
    ok('a plan with row rules: the target rule is refused, not compared with a slice', await refused());
    ok('…and a tick fires nothing and leaves the rule as it was', (await W.as('boss', () => alertStore.evaluateProject(P, S))).length === 0 && (await W.as('boss', () => alertStore.load(P))).rules.find((r) => r.id === rule.id)?.lastEvaluatedAt === undefined);
    await setRules(PD, false);
    await setRules(S, true);
    ok('a dataset with row rules: the target rule is refused', await refused());
    await setRules(S, true);
    await setRules(PD, true);
    const east = await target('east');
    const boss = await target('boss');
    ok('both restricted: the plan is East\'s alone (600000 × 20/30), computed inside the lock', Object.is(east?.value, 600_000 * (20 / 30)), JSON.stringify(east));
    const chartOf = async (who: string) => (await W.call(who, 'visual:data', { projectId: P, datasetId: S, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum', metricId: rev!.id }] }, filters: NOV })).body;
    const hasTarget = (r: { data?: { series?: { target?: boolean }[] } }): boolean => !!r?.data?.series?.some((x) => x.target);
    // A metric chart is refused outright under a row lock (the door), so a restricted viewer never gets a target series beside it.
    const eastChart = await chartOf('east');
    ok('east, both restricted: the chart is the door\'s own refusal, with no target and no West', eastChart?.ok === false && eastChart.code === 'row_policy' && !hasTarget(eastChart) && !JSON.stringify(eastChart).includes('West'), JSON.stringify(eastChart).slice(0, 300));
    const bossChart = await chartOf('boss');
    ok('NEGATIVE CONTROL: the boss\'s chart carries both regions\' plans', bossChart.data.series.find((x: { target?: boolean }) => x.target)?.values.every((v: number) => Object.is(v, 600_000 * (20 / 30))), JSON.stringify(bossChart).slice(0, 300));
    await setRules(S, false);
    const planOnly = await chartOf('east');
    ok('east, plan restricted only: the chart is drawn without a target, and says the rules treat them differently', planOnly.ok === true && !hasTarget(planOnly) && planOnly.notes?.includes(tm.targetRowRules()), JSON.stringify(planOnly).slice(0, 300));
    await setRules(S, true);
    ok('NEGATIVE CONTROL: the boss\'s target is the whole plan', Object.is(boss?.value, 1_200_000 * (20 / 30)), JSON.stringify(boss));
  } finally {
    await W.close();
  }
  finish();
})();
