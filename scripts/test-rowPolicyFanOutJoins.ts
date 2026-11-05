// Row access rules on a fan-out chart (semantic layer part 8, D14): a chart on Customers with measures on
// Orders and Returns is one question per table, each through its own gated door. Over the real route, as
// real users with real grants, in a scratch Postgres (scripts/rowPolicyHarness.ts):
//
//   1. READS: chartReads names every table of every question; a publish records them all.
//   2. LOCKED ON CUSTOMERS: refused `related` by the OUTER gate, before any sub-question runs (a
//      sub-question inside Customers' lock scope would read Customers as open). NEGATIVE CONTROL: without
//      the `values[].datasetId` check in reachesOther, the locked caller gets a figure.
//   3. RESTRICTED ON ORDERS, or CLOSED ON REGIONS (read only by the questions' joins): refused `related`.
//      NEGATIVE CONTROL: with the related gate off, the cached answers reach the caller closed on Regions.
//   4. LIVE: a Live many side is refused, typed, never a figure.
//   5. A HIDDEN MANY-SIDE COLUMN (part 4, cross-part item 6): Orders hides `amount` from viewers; east's chart on
//      Customers with a measure over it is refused `hidden` at the column gate, before any sub-question. NEGATIVE
//      CONTROLS: the editor gets the figure; east's fan-out over Returns' refund answers, Object.is-equal to the editor's.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyFanOutJoins.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import * as fx from './fanOutFixture';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const ipcRels: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
const doors: typeof import('../src/ipc/rowDoors') = require('../src/ipc/rowDoors');
const fan: typeof import('../src/ipc/vizFanOut') = require('../src/ipc/vizFanOut');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 240)}`;
const sorted = (xs: string[]): string => JSON.stringify([...xs].sort());

(async () => {
  const W = await H.world('row access fan-out joins');
  if (!W) {
    fx.removeFixture();
    return finish();
  }
  const real = fan.fanOutVizData;
  try {
    const { P } = W;
    const ids = new Map<string, string>();
    for (const f of fx.ALL) ids.set(f.id, await W.as('boss', async () => (await datasets.saveDataset(P, { name: f.name, sourceKind: 'csv', columns: f.columns, rows: f.rows }))!.id));
    const swap = <T>(v: T): T => JSON.parse([...ids].reduce((s, [a, b]) => s.split(a).join(b), JSON.stringify(v)));
    for (const r of fx.RELS) {
      const saved = await W.call('boss', 'relationship:save', { projectId: P, relationship: { from: swap(r.from), to: swap(r.to), cardinality: r.cardinality } });
      if (saved.body?.ok !== true) throw new Error(`relationship:save failed: ${saved.text}`);
    }
    const [C, O, R, G] = fx.ALL.map((f) => ids.get(f.id) as string);
    const M = (column: string, aggregation: 'sum' | 'count', datasetId?: string) => ({ column, aggregation, ...(datasetId && { datasetId }) });
    const FAN_ZONE = { category: 'zone', categoryDatasetId: G, values: [M('id', 'count'), M('amount', 'sum', O), M('refund', 'sum', R)] };
    const FAN_SEG = { category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O), M('refund', 'sum', R)] };
    const chart = (who: string, encoding: unknown) => W.call(who, 'visual:data', { projectId: P, datasetId: C, encoding });
    const policy = (d: string, column: string | null) => W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: column === null ? null : { column, rules: [{ teamId: W.team, values: ['East'] }] } });
    let subQuestions = 0;
    (fan as { fanOutVizData: typeof real }).fanOutVizData = (p, d, e, f, ask) => real(p, d, e, f, (...a) => { subQuestions++; return ask(...a); });

    // ── 1. Reads ────────────────────────────────────────────────────────
    ok('chartReads names every table of every question', sorted(await W.as('boss', () => ipcRels.chartReads(P, C, FAN_ZONE, []))) === sorted([O, R, G]));
    ok('NEGATIVE CONTROL: a chart with no many-side measure reads only its own join', sorted(await W.as('boss', () => ipcRels.chartReads(P, C, { category: 'zone', categoryDatasetId: G, values: [M('id', 'count')] }, []))) === sorted([G]));
    const edZone = await chart('ed', FAN_ZONE);
    ok('the editor\'s fan-out chart: three questions, with its notes (its answers are now cached)', edZone.body?.ok === true && subQuestions === 3 && edZone.body.notes?.length === 1, show(edZone));
    const vis = await W.call('boss', 'visual:save', { projectId: P, datasetId: C, name: 'Fan', chartType: 'bar', encoding: FAN_ZONE });
    const board = await W.call('boss', 'analysis:create', { projectId: P, name: 'Fan board', sheets: [{ name: 'One', cards: [
      { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: String(vis.body?.visual?.id ?? vis.body?.id) },
    ] }] });
    const site = await W.call('boss', 'publish:run', { projectId: P, dashboardIds: [String(board.body?.id ?? board.body?.analysis?.id)], storyIds: [], scorecardIds: [], options: { title: 'Fan' } });
    ok('a publish of a fan-out tile records Customers, Orders, Returns and Regions', site.body?.ok === true && sorted(site.body.site.datasetIds) === sorted([C, O, R, G]), show(site));

    // ── 2. Locked on Customers ──────────────────────────────────────────
    ok('setup: Customers gets rules', (await policy(C, 'region')).body?.ok === true);
    subQuestions = 0;
    const locked = await chart('east', FAN_SEG);
    ok('locked on Customers: refused related, before any sub-question', H.refused(locked, 'related') && subQuestions === 0, `${subQuestions} ${show(locked)}`);
    doors.setNamedDatasetsCheckForTest(false);
    try {
      const leaky = await chart('east', FAN_SEG);
      ok('NEGATIVE CONTROL: without the datasetId check in reachesOther, the locked caller gets a figure', leaky.body?.ok === true && subQuestions > 0, show(leaky));
    } finally {
      doors.setNamedDatasetsCheckForTest(true);
    }
    ok('setup: Customers\' rules removed', (await policy(C, null)).body?.ok === true);

    // ── 3. Restricted on a many side, closed on a joined table ─────────
    ok('setup: Orders gets rules', (await policy(O, 'region')).body?.ok === true);
    ok('restricted on Orders: refused related', H.refused(await chart('east', FAN_SEG), 'related'));
    const edSeg = await chart('ed', FAN_SEG);
    ok('NEGATIVE CONTROL: the editor gets the figure', edSeg.body?.ok === true, show(edSeg));
    ok('setup: Orders\' rules removed', (await policy(O, null)).body?.ok === true);
    ok('NEGATIVE CONTROL: with nothing restricting east here, east gets the figure', (await chart('east', FAN_SEG)).body?.ok === true);

    ok('setup: Regions gets rules (only the questions\' joins read it)', (await policy(G, 'region')).body?.ok === true);
    const closed = await chart('east', FAN_ZONE);
    ok('closed on Regions: refused related, though every answer is cached', H.refused(closed, 'related'), show(closed));
    doors.setRelatedGateForTest(false);
    try {
      const leaky = await chart('east', FAN_ZONE);
      ok('NEGATIVE CONTROL: with the related gate off, the caller closed on Regions gets the cached figure', leaky.body?.ok === true, show(leaky));
    } finally {
      doors.setRelatedGateForTest(true);
    }
    // The record itself: a visual whose questions read Regions only through a filter (no field names it) loses its
    // stored labels for east. Only chartReads' fan-out reads see that join (visualForCaller runs no question).
    const withOrder = async (filters: unknown[]) => String((await W.call('boss', 'visual:save', { projectId: P, datasetId: C, name: 'Ordered', chartType: 'bar', encoding: FAN_SEG, filters, overrides: { sortOrder: ['SMB', 'Mid'] } })).body?.id ?? '');
    const zoneVis = await withOrder([{ type: 'filter', column: 'zone', op: '=', value: 'W' }]);
    const segVis = await withOrder([]);
    const order = async (id: string) => (await W.call('east', 'visual:get', { projectId: P, id })).body?.overrides?.sortOrder;
    ok('visual:get: a fan-out visual filtered through the closed Regions is sent to east without its stored labels', zoneVis !== '' && (await order(zoneVis)) === undefined, zoneVis);
    ok('NEGATIVE CONTROL: the same visual without that filter keeps them', JSON.stringify(await order(segVis)) === '["SMB","Mid"]');
    ok('setup: Regions\' rules removed', (await policy(G, null)).body?.ok === true);

    // ── 5. A hidden many-side column ────────────────────────────────────
    const hideAmount = (on: boolean) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, O), (raw) => {
      if (on) raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'amount', visibleTo: [] }], 'boss@acme.test', new Date().toISOString());
      else delete raw.columnAccess;
      return true;
    }));
    await hideAmount(true);
    subQuestions = 0;
    const hiddenSeg = await chart('east', FAN_SEG);
    ok('hidden on Orders: east\'s chart with a measure over amount is refused hidden, before any sub-question', H.refused(hiddenSeg, 'hidden') && subQuestions === 0, `${subQuestions} ${show(hiddenSeg)}`);
    ok('NEGATIVE CONTROL: the editor gets the figure', (await chart('ed', FAN_SEG)).body?.ok === true);
    const REFUNDS = { category: 'segment', values: [M('id', 'count'), M('refund', 'sum', R)] };
    const [mine, theirs] = [await chart('east', REFUNDS), await chart('ed', REFUNDS)];
    ok('NEGATIVE CONTROL: east\'s fan-out over Returns\' refund answers, Object.is-equal to the editor\'s', mine.body?.ok === true && H.diff(mine.body.data, theirs.body?.data, {}) === '', show(mine));
    await hideAmount(false);

    // ── 4. Live: a many side on a warehouse refuses, typed ─────────────
    fakeMod.registerLiveFake();
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const liveOrders = await W.as('boss', async () => {
      await duck.execAsync('CREATE OR REPLACE TABLE fan_orders (customer_id VARCHAR, amount DOUBLE)');
      await duck.queryAsync('INSERT INTO fan_orders VALUES ($1, $2), ($3, $4)', ['c1', 2, 'c2', 3]);
      const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
      const id = (await liveRecord.saveLiveRecord(P, { name: 'Live orders', columns: [{ name: 'customer_id', type: 'text' }, { name: 'amount', type: 'number' }], origin: { kind: 'connection', connId: conn!.id, table: 'fan_orders' } }))!.id;
      // relationship:save measures the keys on rows a Live dataset does not keep: the store directly.
      await rels.saveRelationship(P, { from: { datasetId: id, column: 'customer_id' }, to: { datasetId: C, column: 'id' }, cardinality: 'many_to_one' });
      return id;
    });
    const live = await chart('ed', { category: 'segment', values: [M('id', 'count'), M('amount', 'sum', liveOrders)] });
    ok('a Live many side: refused, typed (live_refused), never a figure', live.body?.ok === false && live.body.code === 'live_refused', show(live));
  } finally {
    (fan as { fanOutVizData: typeof real }).fanOutVizData = real;
    await W.close();
    fx.removeFixture();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
