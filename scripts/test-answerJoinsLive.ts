// Joined answers on a LIVE asked dataset (docs/assistant/00-design.md, "Joins in the chart form, as built"; the Live join
// is docs/live-data/log.md "Live charts across a saved link"): the Assistant's card on a Live dataset whose category or
// split is a related Live dataset's column, over the real RPC route against the fake warehouse (DuckDB dialect).
//
// One fixture is loaded twice, as Live datasets on ONE fake connection and as copies, with the same relationships.
//   1. ONE DOOR: the joined Assistant card on Live Orders (a related category; a related split; through the labelled
//      link; with an own filter and a top-N) is Object.is figure for figure to the same encoding's Live chart through
//      the chart door (`visual:data`), AND to the copy path's card over the same rows; dated live; ranked and cut as
//      the copy's card. Asked again, the executor's own cache answers it: no statement.
//   2. THE MIX: Live Orders with its category from a copy, and a copy with its category from Live Customers, each get
//      the door's own typed sentence (`live_refused`, the same words `visual:data` says), never `live_dataset`, and
//      send nothing. NEGATIVE CONTROL: the all-Live card answers (1).
//   1b. A RELATED MEASURE gets the door's typed sentence (the executor's `relatedMeasure`, live_refused), a related
//      glossary term its typed `term` sentence, each word for word what visual:data says, never live_dataset, nothing
//      sent; a related FILTER (pinned to Live Customers) is the door's Live chart and the copy card's figures (Object.is).
//   3. THE ASK: a model's answer naming the linked Live dataset is the chart form, ONE model call; Save as visual keeps
//      the join and the visual draws the card's figures; the snapshot's print reads both Live tables; the turn's
//      `factsFrom` names the related one.
//   Throughout, no Live dataset is ever hydrated (the `getDataset` spy).
//
//   npm run build:ts && node scripts/test-answerJoinsLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';
import type { Cell } from '../src/data/transforms';

const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const fixture: typeof import('./liveParityFixture') = require('./liveParityFixture');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const J: typeof import('../src/ai/answerJoin') = require('../src/ai/answerJoin');
const joined: typeof import('../src/ipc/answerJoined') = require('../src/ipc/answerJoined');
const snapshots: typeof import('../src/ipc/answerSnapshots') = require('../src/ipc/answerSnapshots');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const { fake, fakeMod, liveRecord, datasets, ORG_A } = H;

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x))?.slice(0, 600) ?? String(v);
const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);

type Col = { name: string; type: 'text' | 'number' | 'date' };
const CUST_COLS: Col[] = [{ name: 'cid', type: 'text' }, { name: 'region', type: 'text' }, { name: 'seg', type: 'text' }];
const CUST: Cell[][] = [['c1', 'North', 'A'], ['c2', 'South', 'B'], ['c2', 'South', 'B'], ['c4', 'East', null], ['', 'Blank', 'Z'], ['C1', 'Upper', 'B']];
const ORDER_COLS: Col[] = [{ name: 'oid', type: 'text' }, { name: 'cid', type: 'text' }, { name: 'ship', type: 'text' }, { name: 'status', type: 'text' }, { name: 'amt', type: 'number' }];
const ORDERS: Cell[][] = [
  ['o1', 'c1', 'c2', 'open', 10], ['o2', 'c1', 'c1', 'shipped', 20], ['o3', 'c1', 'c4', 'open', 5], ['o4', 'c2', 'c2', 'open', 7],
  ['o5', 'c2', 'c9', 'shipped', 3], ['o6', 'c4', 'c4', 'open', 13], ['o7', 'c9', 'c2', 'open', 19], ['o8', null, 'c1', 'shipped', 23],
  ['o9', '', 'C1', 'open', 29], ['o10', 'C1', 'c1', 'shipped', 37], ['o11', 'c2', 'c1', 'open', -0],
];
const SUM = [{ column: 'amt', aggregation: 'sum' as const }];

/** Every figure of a chart by what it is of, so a ranked card and a chart in its own order compare. */
const figures = (d: { labels: unknown[]; series: Array<{ name: string; values: unknown[] }> }): Map<string, unknown> =>
  new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, unknown] => [`${s.name}\u0000${String(l)}`, s.values[i]])));
const sameFigures = (a: Reply | undefined, b: Reply | undefined): boolean => {
  if (!a?.labels || !b?.labels) return false;
  const [fa, fb] = [figures(a as never), figures(b as never)];
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && Object.is(v, fb.get(k)));
};

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const ids = await as(async () => {
    await fakeMod.loadWarehouseTable('aj_orders', ORDER_COLS, ORDERS);
    await fakeMod.loadWarehouseTable('aj_customers', CUST_COLS, CUST);
    const live = async (name: string, table: string, columns: Col[]) => (await liveRecord.saveLiveRecord(P, { name, columns, origin: { kind: 'connection', connId: s.connId, table } }))!.id;
    const copy = async (name: string, columns: Col[], rows: Cell[][]) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', ...fixture.importTyped(columns, rows) }))!.id;
    const L = { orders: await live('Orders', 'aj_orders', ORDER_COLS), customers: await live('Customers', 'aj_customers', CUST_COLS) };
    const X = { orders: await copy('Orders copy', ORDER_COLS, ORDERS), customers: await copy('Customers copy', CUST_COLS, CUST) };
    const link = async (from: string, column: string, to: string, label?: string) => (await rels.saveRelationship(P, { from: { datasetId: from, column }, to: { datasetId: to, column: 'cid' }, cardinality: 'many_to_one', ...(label ? { label } : {}) }))!.id;
    const shipL = (await link(L.orders, 'cid', L.customers), await link(L.orders, 'ship', L.customers, 'Ship to'));
    const shipX = (await link(X.orders, 'cid', X.customers), await link(X.orders, 'ship', X.customers, 'Ship to'));
    return { L, X, shipL, shipX };
  });
  const { L, X } = ids;
  const liveIds = new Set([L.orders, L.customers]);
  const hydratedBefore = hydrated.length;
  const spec = (orders: string, customers: string, extra: object = {}) => ({ datasetId: orders, category: 'region', categoryDatasetId: customers, measures: SUM, filters: [], chartType: 'column', title: 'Amount by region', ...extra });
  const card = async (sp: object): Promise<Reply> => (await post('answer:card', { projectId: P, spec: sp })).value;
  const chart = async (d: string, encoding: object, filters: unknown[] = []): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding, filters })).value;

  // ── 1. One door: the Live card = the Live chart through the door = the copy path's card ──
  type Side = { orders: string; customers: string; ship: string };
  const sideL: Side = { orders: L.orders, customers: L.customers, ship: ids.shipL };
  const sideX: Side = { orders: X.orders, customers: X.customers, ship: ids.shipX };
  const cases: Array<[string, (x: Side) => object]> = [
    ['a related category (a repeated key, an empty key, unmatched and case-variant keys)', () => ({})],
    ['a related split under an own category', (x) => ({ category: 'status', categoryDatasetId: undefined, series: 'seg', seriesDatasetId: x.customers, chartType: 'stacked_column' })],
    ['through the labelled "Ship to" link', (x) => ({ categoryVia: x.ship })],
    ['an own filter and a top 2', () => ({ filters: [{ column: 'status', op: '=', value: 'open' }], top: 2 })],
  ];
  for (const [label, extra] of cases) {
    const ls = spec(L.orders, L.customers, extra(sideL));
    const before = fake.calls.length;
    const live = await card(ls);
    const asked = fake.calls.length - before;
    const door = await chart(L.orders, J.specEncoding(A.sanitizeStoredSpec(ls)!), live.steps ?? []); // the card's own steps, as Save as visual keeps them
    const copy = await card(spec(X.orders, X.customers, extra(sideX)));
    ok(`one door, ${label}: the Live card answers, dated live, keeping the join`, live.ok === true && live.asOf?.mode === 'live' && (live.spec.categoryDatasetId === L.customers || live.spec.seriesDatasetId === L.customers), show(live));
    // A top-N card is the door's chart cut to its N largest (the copy card's rule): figure for figure within it.
    const cut = (ls as { top?: number }).top;
    const doorDrawn = door?.ok ? (cut ? joined.ranked({ labels: door.data.labels, series: door.data.series }, cut) : door.data) : undefined;
    ok(`…${label}: Object.is the same encoding's Live chart through the door${cut ? ' (its largest ' + cut + ')' : ''}, and the copy path's card over the same rows`,
      sameFigures(live.data, doorDrawn) && sameFigures(live.data, copy?.data) && live.data.labels.length === copy.data.labels.length && (!cut || door.data.labels.length > cut), show([live.data, door?.data, copy?.data]));
    ok(`…${label}: the warehouse was asked (the card's chart; a case fix's lookup at most beside it)`, asked >= 1 && asked <= 2, String(asked));
  }
  const top = await card(spec(L.orders, L.customers, { top: 2 }));
  const topCopy = await card(spec(X.orders, X.customers, { top: 2 }));
  ok('ranked and cut as the copy\'s card: the same two labels, in the same order', top.ok && JSON.stringify(top.data.labels) === JSON.stringify(topCopy.data.labels) && top.data.labels.length === 2, show([top.data, topCopy.data]));
  const sent = fake.calls.length;
  const hit = await card(spec(L.orders, L.customers));
  ok('asked again, the executor\'s own cache answers: no statement', hit.ok === true && fake.calls.length === sent, String(fake.calls.length - sent));

  // ── 1b. A measure, a filter or a term from the related Live dataset (scripts/test-answerJoinMeasures on copies) ──
  // A related measure: the Live join's executor refuses it (`relatedMeasure`, its fan-in mask is a copy's) in the door's
  // typed sentence, never live_dataset. A pinned filter: the door's Live chart, in the warehouse.
  {
    const before = fake.calls.length;
    const m = await post('answer:card', { projectId: P, spec: spec(L.orders, L.customers, { category: 'status', categoryDatasetId: undefined, measures: [{ column: 'seg', aggregation: 'count', datasetId: L.customers }] }) });
    const mDoor = await chart(L.orders, { category: 'status', values: [{ column: 'seg', aggregation: 'count', datasetId: L.customers }] });
    ok('live: a related measure gets the door\'s typed sentence (live_refused), word for word visual:data\'s, never live_dataset, nothing sent',
      m.value.ok === false && m.value.code === 'live_refused' && mDoor.ok === false && m.value.reason === mDoor.error && !/live_dataset/.test(m.body) && fake.calls.length === before, show([m.value, mDoor]));
    const fSpec = spec(L.orders, L.customers, { category: 'status', categoryDatasetId: undefined, filters: [{ column: 'region', op: '=', value: 'North', datasetId: L.customers }] });
    const f = await card(fSpec);
    const fDoor = await chart(L.orders, { category: 'status', values: SUM }, [{ type: 'filter', column: 'region', op: '=', value: 'North', datasetId: L.customers }]);
    const fCopy = await card(spec(X.orders, X.customers, { category: 'status', categoryDatasetId: undefined, filters: [{ column: 'region', op: '=', value: 'North', datasetId: X.customers }] }));
    ok('live: a related filter (pinned to Live Customers) is the door\'s Live chart in the warehouse (Object.is), and the copy path\'s card over the same rows',
      f.ok === true && f.asOf?.mode === 'live' && sameFigures(f.data, fDoor?.data) && sameFigures(f.data, fCopy?.data), show([f, fDoor, fCopy]));
    // A glossary term of Live Customers: a term reaches another table only on copies (analysis/termExpand), refused typed.
    const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
    const north = (await as(() => terms.saveTerm(P, { name: 'North customers', datasetId: L.customers, filters: [{ type: 'filter', column: 'region', op: '=', value: 'North' }] } as never)))!;
    const tSent = fake.calls.length;
    const t = await post('answer:card', { projectId: P, spec: { ...fSpec, filters: [{ term: north.id, datasetId: L.customers }] } });
    const tDoor = await chart(L.orders, { category: 'status', values: SUM }, [{ type: 'term', term: north.id }]);
    ok('live: a related glossary term is refused in the door\'s typed sentence (term), word for word visual:data\'s, never live_dataset, nothing sent',
      t.value.ok === false && t.value.code === 'term' && tDoor.ok === false && t.value.reason === tDoor.error && !/live_dataset/.test(t.body) && fake.calls.length === tSent, show([t.value, tDoor]));
  }

  // ── 2. The mix: the door's own typed sentence, never live_dataset, nothing sent ──
  await as(async () => {
    await rels.saveRelationship(P, { from: { datasetId: L.orders, column: 'oid' }, to: { datasetId: X.customers, column: 'cid' }, cardinality: 'many_to_one' });
    await rels.saveRelationship(P, { from: { datasetId: X.orders, column: 'oid' }, to: { datasetId: L.customers, column: 'cid' }, cardinality: 'many_to_one' });
  });
  for (const [label, o, c] of [['Live Orders, its category from a copy', L.orders, X.customers], ['a copy, its category from Live Customers', X.orders, L.customers]] as const) {
    const before = fake.calls.length;
    const got = await post('answer:card', { projectId: P, spec: spec(o, c) });
    const door = await chart(o, { category: 'region', categoryDatasetId: c, values: SUM });
    ok(`mix, ${label}: the door's own typed sentence (live_refused), word for word what visual:data says, nothing sent`,
      got.status === 200 && got.value.ok === false && got.value.code === 'live_refused' && door.ok === false && got.value.reason === door.error && fake.calls.length === before, show([got.value, door]));
    ok(`…${label}: never live_dataset`, !/live_dataset/.test(got.body), got.body.slice(0, 200));
  }

  // ── 3. The ask, Save as visual, the snapshot, factsFrom ──
  const real = { ask: analyze.askCopilot, ready: execConfig.executionReady, on: execConfig.assistantOn };
  let calls = 0;
  (analyze as { askCopilot: unknown }).askCopilot = async () => {
    calls++;
    return { ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'amount by region', spec: { dataset: 'Orders', category: 'region', categoryDataset: 'Customers', measures: SUM } } };
  };
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  try {
    const threadId = (await post('copilot:newThread', { projectId: P })).value.thread.id;
    const r = (await post('copilot:ask', { projectId: P, threadId, context: { kind: 'dataset', id: L.orders }, question: 'amount by region' })).value;
    const t = r.turns?.at(-1);
    ok('ask: a model\'s answer naming the linked Live dataset is the chart form, in ONE model call', r.ok === true && calls === 1 && t?.answer?.datasetId === L.orders && t.answer.categoryDatasetId === L.customers && !t.sql, show(r));
    ok('ask: …its card the Live card\'s figures, dated live', sameFigures(t?.card?.data, hit.data) && t.card.asOf?.mode === 'live', show(t?.card));
    const stored = await as(async () => (await copilot.loadHistory(P, threadId)).filter((x) => x.role === 'assistant').at(-1));
    ok('ask: the turn\'s factsFrom names the related Live dataset', !!stored?.factsFrom?.includes(L.customers), show(stored?.factsFrom));
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = real.ask;
    (execConfig as { executionReady: unknown }).executionReady = real.ready;
    (execConfig as { assistantOn: unknown }).assistantOn = real.on;
  }
  const saved = (await post('answer:saveVisual', { projectId: P, spec: spec(L.orders, L.customers) })).value;
  const v = saved.ok ? (await post('visual:get', { projectId: P, id: saved.visual.id })).value : null;
  const vData = v ? await chart(v.datasetId, v.encoding, v.filters) : null;
  ok('save: the visual keeps the join, and draws the card\'s figures through the door (Object.is)', v?.encoding?.categoryDatasetId === L.customers && sameFigures(vData?.data, hit.data), show([v?.encoding, vData]));
  await as(async () => {
    const sp = A.sanitizeStoredSpec(spec(L.orders, L.customers))!;
    const reads = await joined.answerReads(P, sp);
    ok('snapshot: the print of a Live joined card reads both Live tables', JSON.stringify(reads) === JSON.stringify([L.orders, L.customers])
      && (await snapshots.answerAccessPrint(P, sp)) === (await snapshots.sqlAccessPrint(P, [L.orders, L.customers])), show(reads));
  });

  ok('no Live dataset was ever hydrated', !hydrated.slice(hydratedBefore).some((id) => liveIds.has(id)), show(hydrated.slice(hydratedBefore)));
})()
  .catch((e) => ok('joined Live answers suite threw', false, e && (e as Error).stack))
  .then(() => close())
  .finally(() => finish());
