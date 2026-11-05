// A row-restricted viewer's funnel metric is computed inside their lock (semantic layer part 5, step 08), as real
// users with real grants in a scratch Postgres (scripts/rowPolicyHarness.ts). The lock is a security boundary, not a
// scope (D6): it filters EVERY event, so East — who may see only the store's rows — gets "Buyers" over the store's
// visits, carts and buys, with Object.is the boss's same metric over the physical store subset.
//
// NEGATIVE CONTROLS: the boss's figure over every row is another one, and so is the lock applied to the entry alone
// (store visitors who bought on the web would count).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-funnelMetricsRowLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import { eq, SHOP_COLS, SHOP_FUNNEL, shopRows } from './funnelShop';

const fe: typeof import('../src/analysis/funnelEvents') = require('../src/analysis/funnelEvents');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
type Cell = import('../src/data/transforms').Cell;

const ROWS = shopRows();
const STORE = 4; // the channel column

void (async () => {
  const W = await H.world('funnel metrics under a row lock');
  if (!W) return finish();
  try {
    const { P } = W;
    const mk = (name: string, rows: Cell[][]) => W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: SHOP_COLS, rows } as never))!.id);
    const shop = await mk('Shop', ROWS);
    const store = await mk('Shop store', ROWS.filter((r) => r[STORE] === 'store'));
    const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: shop, policy: { column: 'channel', rules: [{ teamId: W.team, values: ['store'] }] } });
    if (set.body?.ok !== true) throw new Error(`setRowPolicy failed: ${set.text}`);
    const save = async (datasetId: string, name: string): Promise<string> => {
      const r = await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId, definition: { funnel: SHOP_FUNNEL, show: 'converted' } } });
      if (r.body?.ok !== true) throw new Error(`save ${name}: ${r.text}`);
      return r.body.metric.id;
    };
    const all = await save(shop, 'Buyers');
    const sub = await save(store, 'Store buyers');
    const value = async (who: string, id: string, filters: unknown[] = []): Promise<unknown> => {
      const r = await W.call(who, 'metric:values', { projectId: P, ids: [id], filters });
      return r.body?.[0]?.ok === true ? r.body[0].value : r.text;
    };

    const mine = await value('east', all);
    const theirs = await value('boss', sub);
    const inside = fe.buildEventFunnel(SHOP_COLS, ROWS.filter((r) => r[STORE] === 'store'), SHOP_FUNNEL).funnel.counts[2];
    ok('east: Buyers over Shop is the boss\'s over the store subset, and the reference inside the lock', typeof mine === 'number' && Object.is(mine, theirs) && Object.is(mine, inside) && inside > 0, JSON.stringify([mine, theirs, inside]));
    const boss = await value('boss', all);
    ok('NEGATIVE CONTROL: the boss\'s over every row is another figure', typeof boss === 'number' && !Object.is(boss, mine), JSON.stringify([boss, mine]));
    const entryOnly = fe.buildEventFunnel(SHOP_COLS, ROWS, { ...SHOP_FUNNEL, entry: [eq('channel', 'store')] }).funnel.counts[2];
    ok('NEGATIVE CONTROL: the lock on the entry alone (store visitors buying on the web) is another figure: the lock filters every event', !Object.is(entryOnly, mine) && entryOnly > (mine as number), JSON.stringify([entryOnly, mine]));
    const G = [eq('country', 'Germany')];
    ok('east, scoped to Germany: the boss\'s on the subset under the same scope', Object.is(await value('east', all, G), await value('boss', sub, G)), JSON.stringify([await value('east', all, G), await value('boss', sub, G)]));
  } finally {
    await W.close();
  }
  finish();
})();
