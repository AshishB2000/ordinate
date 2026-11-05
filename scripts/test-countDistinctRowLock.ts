// A row-restricted viewer's distinct count is counted inside their lock (semantic layer part 5, step 02), as real
// users with real grants in a scratch Postgres (scripts/rowPolicyHarness.ts). East's KPI and chart of "customers"
// over Orders equal the boss's over the physical East subset, with Object.is: the lock filters the rows BEFORE the
// distinct count, never a count of every customer. The doors are called in-process as each person (no picker offers
// countd before step 04, so the RPC contracts do not take it yet).
//
// NEGATIVE CONTROL: the boss's count over all of Orders is a different figure.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-countDistinctRowLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: the visual:data reply, read field by field
const { countDistinct }: typeof import('../src/analysis/countDistinct') = require('../src/analysis/countDistinct');

void (async () => {
  const W = await H.world('count distinct under a row lock');
  if (!W) return finish();
  try {
    const { P, orders, east } = W;
    const M = { column: 'customer', aggregation: 'countd' } as const;
    const kpi = (who: string, datasetId: string) => W.as(who, async () => (await dashboards.computeCardMetric(P, datasetId, M)).value);
    const chart = (who: string, datasetId: string) => W.as(who, () => handlers.get('visual:data')!(null, { projectId: P, datasetId, encoding: { category: 'day', grain: 'month', values: [M] } }));
    const ref = countDistinct(H.only('East').map((r) => r[3]), 'text');
    const eastKpi = await kpi('east', orders);
    ok('east: the KPI is the distinct count of East\'s rows', Object.is(eastKpi, ref) && Object.is(eastKpi, await kpi('boss', east)), JSON.stringify([eastKpi, ref]));
    const [mine, theirs] = [await chart('east', orders), await chart('boss', east)];
    ok('east: the chart is the boss\'s chart of the East subset, byte for byte', mine.ok === true && JSON.stringify(mine.data) === JSON.stringify(theirs.data), JSON.stringify([mine, theirs]).slice(0, 400));
    const all = await kpi('boss', orders);
    ok('NEGATIVE CONTROL: the boss counts every customer of Orders, a different figure', Object.is(all, countDistinct(H.ROWS.map((r) => r[3]), 'text')) && all !== eastKpi, JSON.stringify([all, eastKpi]));
  } finally {
    await W.close();
  }
  finish();
})();
