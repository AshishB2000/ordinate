// A row-restricted viewer's per-entity snapshot is computed inside their lock (semantic layer part 5, step 07), as
// real users with real grants in a scratch Postgres (scripts/rowPolicyHarness.ts). East's "each customer's latest
// sales" over Orders equals the boss's same metric over the physical East subset, with Object.is: a customer whose
// last row the lock hides counts its last row East may see, never a hidden one and never nothing.
//
// NEGATIVE CONTROLS: the boss's figure over all of Orders is another one, and so is "the boss's kept rows, then East's"
// (the lock applied after the snapshot). A chart is refused them, as every chart with a metric measure is (part 1).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-snapshotPerRowLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const snapshot: typeof import('../src/analysis/snapshot') = require('../src/analysis/snapshot');
const { computeMetric }: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
type Cell = import('../src/data/transforms').Cell;

const S = { column: 'day', take: 'last', per: 'customer' } as const;
// MRR by month, January to June 2024. k1 moves from East to West in April and k3 to North in June (the lock hides
// their last months from East); k0 and k5 stay East, k2 West, k4 North. Some customers report every month, some not.
const COLS = [{ name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'customer', type: 'text' as const }];
const REGION = (k: number, m: number): string => [() => 'East', () => (m < 4 ? 'East' : 'West'), () => 'West', () => (m < 6 ? 'East' : 'North'), () => 'North', () => 'East'][k]();
const ROWS: Cell[][] = [];
for (let m = 1; m <= 6; m += 1) for (let k = 0; k < 6; k += 1) if (!(k === 5 && m > 2)) ROWS.push([REGION(k, m), 10 * k + m, `2024-0${m}-01`, `k${k}`]);

void (async () => {
  const W = await H.world('per-entity snapshots under a row lock');
  if (!W) return finish();
  try {
    const { P } = W;
    const mk = (name: string, rows: Cell[][]) => W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: COLS, rows } as never))!.id);
    const orders = await mk('MRR', ROWS);
    const east = await mk('MRR East', ROWS.filter((r) => r[0] === 'East'));
    const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: orders, policy: { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } });
    if (set.body?.ok !== true) throw new Error(`setRowPolicy failed: ${set.text}`);
    const save = async (datasetId: string, name: string): Promise<string> => {
      const r = await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId, definition: { column: 'sales', aggregation: 'sum', snapshot: S } } });
      if (r.body?.ok !== true) throw new Error(`save ${name}: ${r.text}`);
      return r.body.metric.id;
    };
    const all = await save(orders, 'Latest sales all');
    const sub = await save(east, 'Latest sales east');
    const value = async (who: string, id: string): Promise<unknown> => {
      const r = await W.call(who, 'metric:values', { projectId: P, ids: [id], filters: [] });
      return r.body?.[0]?.ok === true ? r.body[0].value : r.text;
    };

    const mine = await value('east', all);
    const theirs = await value('boss', sub);
    ok('east: each customer\'s latest over Orders is the boss\'s over the East subset', typeof mine === 'number' && Object.is(mine, theirs), JSON.stringify([mine, theirs]));
    const boss = await value('boss', all);
    ok('NEGATIVE CONTROL: the boss\'s over every row of Orders is another figure', typeof boss === 'number' && !Object.is(boss, mine), JSON.stringify([boss, mine]));
    const after = computeMetric(COLS, snapshot.snapshotRows(COLS, ROWS, S).filter((r) => r[0] === 'East'), { column: 'sales', aggregation: 'sum' });
    const inside = computeMetric(COLS, snapshot.snapshotRows(COLS, ROWS.filter((r) => r[0] === 'East'), S), { column: 'sales', aggregation: 'sum' });
    ok('east: k1 and k3 count their last East months (March, May): the reference inside the lock', Object.is(mine, inside) && inside === 6 + 13 + 35 + 52, JSON.stringify([mine, inside]));
    ok('NEGATIVE CONTROL: the lock after the snapshot (the boss\'s kept rows, then East\'s) is another figure', !Object.is(after, mine), JSON.stringify([after, mine]));
    const chart = (who: string) => W.call(who, 'visual:data', { projectId: P, datasetId: orders, encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum', metricId: all }] }, filters: [] });
    const refused = await chart('east');
    ok('east: a per-entity snapshot chart is refused, never drawn over every row', refused.body?.ok === false && refused.body?.code === 'row_policy', refused.text.slice(0, 300));
    ok('NEGATIVE CONTROL: the boss draws it', (await chart('boss')).body?.ok === true);
  } finally {
    await W.close();
  }
  finish();
})();
