// Row access rules and hidden columns on a Live chart across a link (docs/live-data/00-plan.md L4; src/ipc/liveJoin.ts).
// Over the real route, as real users with real grants, in a scratch Postgres (scripts/rowPolicyHarness.ts), against
// the fake warehouse: Orders → Customers, both Live on one connection, and the same rows as copies.
//
//   1. RULES ON THE RELATED TABLE: east (a team viewer) asking Orders by Customers' region is refused `related`, with the
//      code and reason the copy's twin gets. NEGATIVE CONTROL: with the related gate off, the body runs, and its nested
//      `withLockOf` on Customers compiles east's lock into Customers' scan: the chart equals joinJs over east's
//      customers only (the rest unmatched), while the editor's equals joinJs over every customer.
//   2. A HIDDEN COLUMN on the related table, read as the category: refused `hidden` at the door, as the copy's.
//      NEGATIVE CONTROL: the editor gets the figure.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyLiveJoins.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import type { Cell } from '../src/data/transforms';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const doors: typeof import('../src/ipc/rowDoors') = require('../src/ipc/rowDoors');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 300)}`;
const ORDER_COLS = [{ name: 'oid', type: 'text' as const }, { name: 'cust', type: 'text' as const }, { name: 'amt', type: 'number' as const }];
const CUST_COLS = [{ name: 'cid', type: 'text' as const }, { name: 'region', type: 'text' as const }, { name: 'tier', type: 'text' as const }];
const ORDERS: Cell[][] = [['o1', 'c1', 3], ['o2', 'c2', 5], ['o3', 'c3', 7], ['o4', 'c1', 11], ['o5', 'c9', 13]];
const CUST: Cell[][] = [['c1', 'East', 'Gold'], ['c2', 'West', 'Gold'], ['c3', 'East', 'Lead']];

/** The figure by region, as joinJs draws it over `customers` (rule 1–2: the first row per key; no match is the blank category). */
function byRegion(customers: Cell[][]): Map<string, number> {
  const region = new Map(customers.map((c) => [c[0] as string, (c[1] as string) ?? '']));
  const out = new Map<string, number>();
  for (const o of ORDERS) out.set(region.get(o[1] as string) ?? '', (out.get(region.get(o[1] as string) ?? '') ?? 0) + (o[2] as number));
  return out;
}

/** The reply's (label → value), or null. */
function figures(r: H.Reply): Map<string, number> | null {
  const d = r.body?.ok === true ? r.body.data : null;
  return d ? new Map(d.labels.map((l: string, i: number) => [l, d.series[0].values[i]])) : null;
}
const same = (a: Map<string, number> | null, b: Map<string, number>): boolean => !!a && a.size === b.size && [...b].every(([k, v]) => Object.is(a.get(k), v));

void (async () => {
  const W = await H.world('row access on a Live chart across a link');
  if (!W) return finish();
  try {
    const { P } = W;
    fakeMod.registerLiveFake();
    const ids = await W.as('boss', async () => {
      await fakeMod.loadWarehouseTable('rpj_orders', ORDER_COLS, ORDERS);
      await fakeMod.loadWarehouseTable('rpj_customers', CUST_COLS, CUST);
      const conn = (await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
      const live = async (name: string, table: string, columns: typeof ORDER_COLS | typeof CUST_COLS) => (await liveRecord.saveLiveRecord(P, { name, columns, origin: { kind: 'connection', connId: conn.id, table } }))!.id;
      const copy = async (name: string, columns: typeof ORDER_COLS | typeof CUST_COLS, rows: Cell[][]) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows }))!.id;
      const out = { lo: await live('Orders live', 'rpj_orders', ORDER_COLS), lc: await live('Customers live', 'rpj_customers', CUST_COLS), xo: await copy('Orders copy', ORDER_COLS, ORDERS), xc: await copy('Customers copy', CUST_COLS, CUST) };
      // The store directly: relationship:save counts the keys (two Live datasets on one connection count in the warehouse: test-sourceAnswers).
      for (const [f, t] of [[out.lo, out.lc], [out.xo, out.xc]]) await rels.saveRelationship(P, { from: { datasetId: f, column: 'cust' }, to: { datasetId: t, column: 'cid' }, cardinality: 'many_to_one' });
      return out;
    });
    const chart = (who: string, d: string, by: string, column = 'region') => W.call(who, 'visual:data', { projectId: P, datasetId: d, encoding: { category: column, categoryDatasetId: by, values: [{ column: 'amt', aggregation: 'sum' }] } });
    const policy = (d: string, on: boolean) => W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: on ? { column: 'region', rules: [{ teamId: W.team, values: ['East'] }] } : null });

    // ── 1. Rules on the related table ───────────────────────────────────
    const everyone = byRegion(CUST);
    const eastOnly = byRegion(CUST.filter((c) => c[1] === 'East'));
    const ed = await chart('ed', ids.lo, ids.lc);
    ok('the editor\'s Live chart across the link: joinJs over every customer', same(figures(ed), everyone), show(ed));
    ok('setup: rules on both Customers', (await policy(ids.lc, true)).body?.ok === true && (await policy(ids.xc, true)).body?.ok === true);
    const [live, copy] = [await chart('east', ids.lo, ids.lc), await chart('east', ids.xo, ids.xc)];
    ok('east, with rules on the related Live table: refused related — the code and reason the copy\'s twin gets', H.refused(live, 'related') && H.refused(copy, 'related'), `${show(live)} | ${show(copy)}`);
    doors.setRelatedGateForTest(false);
    try {
      const locked = await chart('east', ids.lo, ids.lc);
      ok('NEGATIVE CONTROL: with the related gate off, liveJoin\'s withLockOf puts east\'s lock in Customers\' scan — joinJs over east\'s customers', same(figures(locked), eastOnly) && !same(figures(locked), everyone), show(locked));
      ok('…and the editor, whom nothing restricts, still gets every customer', same(figures(await chart('ed', ids.lo, ids.lc)), everyone));
    } finally {
      doors.setRelatedGateForTest(true);
    }
    ok('setup: the rules removed', (await policy(ids.lc, false)).body?.ok === true && (await policy(ids.xc, false)).body?.ok === true);

    // ── 2. A hidden column on the related table ─────────────────────────
    const hide = (d: string, on: boolean) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, d), (raw) => {
      if (on) raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'tier', visibleTo: [] }], 'boss@acme.test', new Date().toISOString());
      else delete raw.columnAccess;
      return true;
    }));
    await hide(ids.lc, true);
    await hide(ids.xc, true);
    const [hidLive, hidCopy] = [await chart('east', ids.lo, ids.lc, 'tier'), await chart('east', ids.xo, ids.xc, 'tier')];
    ok('a column hidden on the related Live table, read as the category: refused hidden, as the copy\'s', H.refused(hidLive, 'hidden') && H.refused(hidCopy, 'hidden'), `${show(hidLive)} | ${show(hidCopy)}`);
    ok('NEGATIVE CONTROL: the editor gets it', (await chart('ed', ids.lo, ids.lc, 'tier')).body?.ok === true);
    await hide(ids.lc, false);
    await hide(ids.xc, false);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
