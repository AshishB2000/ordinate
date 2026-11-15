// Explore on a source table, no dataset (docs/assistant/00-design.md, phase D, "Explore, as built"): the channels Explore
// calls take a table target — `datasetId` the table doc's id, `table` its connection's — and run inside the table's Live
// view (src/ipc/sourceAnswers.ts onSourceTable, src/data/sourceView.ts). Over the real RPC route; the warehouse is the
// Live fake (./liveFakeConnector), so everything above the connector is the real thing.
//
// Both modes (no database: signed in as an org admin; DATABASE_URL: real grants, ./rowPolicyHarness, as the editor):
//   0. The picker's list (`sourceTable:list`): a connection asked live is marked `live`; one that is not, not.
//   1. FIELDS: `explore:suggest` on the table is the same reply as on a Live dataset of that table (its facts typed as
//      the Live dataset's columns are declared), and its suggestions are sane (each names fields it lists).
//   2. FIGURES (DIFFERENTIAL): `visual:data` and `visual:dataBatch` on the table are Object.is, figure by figure, the same
//      question on the Live dataset and on the extract of the same rows; dated live. ONE warehouse statement, counted by
//      the daily limit (liveBudget) under the view's id; asked again, the cache (orgKey) answers. Nothing hydrated
//      (getDataset never asked for the table or the Live dataset), no dataset created. NEGATIVE CONTROL: a spent daily
//      limit refuses the table's chart, typed.
//   3. FILTER VALUES: `dataset:distinct` on the table is the typed refusal of a Live dataset of it with no sample (same
//      code, same reason; never a list), in the table's own sentence, with no warehouse call. A drill
//      (`visual:drillDown`) is the Live dataset's, step for step.
//   4. COPY FIRST: a table on a connection not asked live: every input refuses with `needs: 'copy'`, no warehouse call.
//   5. KEEP: `explore:keepTable` makes exactly one Live dataset of the table; its fields and figures are the table's.
// DATABASE_URL only:
//   6. VIEWERS: every table-target input from a project viewer is "This dataset no longer exists." before ANY read: no
//      doc read, no connection read, no warehouse statement, nothing counted; no reply holds the table's name, its
//      connection's, a column only its facts have, or a figure. Keep is 403. NEGATIVE CONTROL: the editor's same calls
//      read the doc and carry those names.
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-exploreSourceTables.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import type { TableFacts } from '../src/connectors/tableFacts';

const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const say: typeof import('../src/ai/sourceAnswerMessages') = require('../src/ai/sourceAnswerMessages');
const missing: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');

const TABLE = 'canary_refunds_7e2';
const COPY_TABLE = 'canary_cases_7e2';
const CONN = 'Canary warehouse 7e2';
/** A column the table's facts (and the warehouse) hold: in an editor's fields, in no viewer's reply. */
const FACT_CANARY = 'canary_memo_7e2';
const COLUMNS = [{ name: 'reason', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: FACT_CANARY, type: 'text' as const }];
const ROWS = [['Damaged', 12.5, '2026-01-02', 'm'], ['Late', 7, '2026-01-03', 'm'], ['Damaged', 0.1, '2026-02-01', 'm'], ['Wrong size', 3.25, '2026-02-04', 'm'], ['Late', 0.2, '2026-03-01', 'm']];
const FACTS: TableFacts = { columns: [{ name: 'reason', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }, { name: 'day', type: 'DATE' }, { name: FACT_CANARY, type: 'VARCHAR' }], rowEstimate: 5 };
const ENC = { category: 'reason', values: [{ column: 'amount', aggregation: 'sum' }] };
const BY_MONTH = { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] };

type Reply = { status: number; body: any }; // any: each channel's own reply
interface Bench {
  P: string;
  editor: string;
  as<T>(fn: () => Promise<T>): Promise<T>;
  call(who: string, channel: string, payload: object): Promise<Reply>;
}
interface Seeded { connId: string; docId: string; copyConn: string; copyDoc: string; liveId: string; copyId: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(async () => {
    fakeMod.registerLiveFake();
    await fakeMod.loadWarehouseTable(TABLE, COLUMNS, ROWS as never);
    const conn = (await connections.saveConnection(b.P, { name: CONN, connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const copyConn = (await connections.saveConnection(b.P, { name: 'Canary app DB 7e2', connectorId: 'postgres', values: { host: 'db.internal', port: '5432', database: 'app', user: 'ro' } }))!;
    const doc = async (connId: string, table: string) => {
      const made = await store.createSourceDoc(b.P, connId, table, {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await store.updateSourceDoc(b.P, connId, made.docId, (d) => ({ ...d, facts: { ...FACTS, readAt: new Date().toISOString(), readBy: 'ed@acme.test' } }));
      return made.docId;
    };
    const docId = await doc(conn.id, TABLE);
    const copyDoc = await doc(copyConn.id, COPY_TABLE);
    const liveId = (await liveRecord.saveLiveRecord(b.P, { name: 'Refunds live', columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table: TABLE } }))!.id;
    const copyId = (await datasets.saveDataset(b.P, { name: 'Refunds copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS as never }))!.id;
    return { connId: conn.id, docId, copyConn: copyConn.id, copyDoc, liveId, copyId };
  });
}

type Chart = { ok?: boolean; data?: { labels: unknown[]; series: { values: number[] }[] }; asOf?: { mode?: string }; code?: string; error?: string };
const figures = (c: Chart): Map<string, number> => new Map((c.data?.labels ?? []).map((l, i) => [String(l), c.data!.series[0].values[i]]));
function same(a: Chart, b: Chart): boolean {
  const [x, y] = [figures(a), figures(b)];
  return x.size > 0 && x.size === y.size && [...x].every(([k, v]) => y.has(k) && Object.is(v, y.get(k)));
}
/** What a reply says about the fields: everything but who asked. */
const fieldsOf = (r: any) => JSON.stringify({ d: r?.dimensions, t: r?.dates, m: r?.measures, s: r?.suggestions, h: r?.hidden ?? [] });

/** Every id `datasets.getDataset` is asked to hydrate, from now on. */
const hydrated: string[] = [];
const realGet = datasets.getDataset;
(datasets as { getDataset: unknown }).getDataset = (projectId: string, id: string, ...rest: unknown[]) => {
  hydrated.push(id);
  return (realGet as (...a: unknown[]) => unknown)(projectId, id, ...rest);
};

async function editorLegs(b: Bench, s: Seeded): Promise<void> {
  const ed = (channel: string, payload: object) => b.call(b.editor, channel, { projectId: b.P, ...payload });
  const onTable = { datasetId: s.docId, table: s.connId };
  const before = (await b.as(() => datasets.listDatasets(b.P))).length;

  // 0. The picker's list: the Source tables list, its connections marked when asked live.
  const list = (await ed('sourceTable:list', {})).body;
  const head = (id: string) => (list?.connections ?? []).find((c: { connId: string }) => c.connId === id);
  ok('0. the Source tables list marks the warehouse asked live, and the app database not (copy first)', head(s.connId)?.live === true && head(s.copyConn) && !('live' in head(s.copyConn))
    && head(s.connId).rows.some((r: { docId?: string; readAt?: string }) => r.docId === s.docId && r.readAt), JSON.stringify(list).slice(0, 400));

  // 1. Fields.
  const tf = (await ed('explore:suggest', onTable)).body;
  const lf = (await ed('explore:suggest', { datasetId: s.liveId })).body;
  ok('1. FIELDS: explore:suggest on the table answers, its columns typed from its facts', tf?.ok === true && tf.dimensions.some((d: { name: string }) => d.name === FACT_CANARY) && tf.measures.some((m: { name: string }) => m.name === 'amount') && tf.dates.some((d: { name: string }) => d.name === 'day'), JSON.stringify(tf).slice(0, 400));
  ok('1. DIFFERENTIAL: …the same fields and suggestions as on a Live dataset of the table', fieldsOf(tf) === fieldsOf(lf), `${fieldsOf(tf)}\n${fieldsOf(lf)}`);
  const listed = new Set([...tf.dimensions, ...tf.dates, ...tf.measures].map((f: { name: string }) => f.name));
  ok('1. …every suggestion names only fields it lists', tf.suggestions.length > 0 && tf.suggestions.every((sg: { encoding: { category: string; values: { column: string }[] } }) => listed.has(sg.encoding.category) && sg.encoding.values.every((v) => listed.has(v.column))), JSON.stringify(tf.suggestions));

  // 2. Figures, the door, the budget, the cache.
  const counted: string[] = [];
  budget.setDailyCheckForTest((_org, datasetId) => { counted.push(datasetId); return { ok: true }; });
  fakeMod.resetFake();
  hydrated.length = 0;
  const tc = (await ed('visual:data', { ...onTable, encoding: ENC })).body as Chart;
  ok('2. visual:data on the table answers, dated by the warehouse', tc?.ok !== false && tc.asOf?.mode === 'live' && figures(tc).size === 3, JSON.stringify(tc).slice(0, 400));
  ok('2. ONE warehouse statement, through the door, counted by the daily limit under the view\'s id', fakeMod.fake.calls.length === 1 && counted.length === 1 && counted[0] === s.docId, JSON.stringify({ calls: fakeMod.fake.calls.length, counted }));
  ok('2. …its values went as bind parameters, never in the SQL text', fakeMod.fake.calls.every((c) => !c.sql.includes('Damaged')));
  const again = (await ed('visual:data', { ...onTable, encoding: ENC })).body as Chart;
  ok('2. asked again, the cache answers (no second statement)', same(again, tc) && fakeMod.fake.calls.length === 1, JSON.stringify({ calls: fakeMod.fake.calls.length }));
  const lc = (await ed('visual:data', { datasetId: s.liveId, encoding: ENC })).body as Chart;
  const xc = (await ed('visual:data', { datasetId: s.copyId, encoding: ENC })).body as Chart;
  ok('2. DIFFERENTIAL: every figure from the table is Object.is the same question on the Live dataset', same(tc, lc), JSON.stringify([tc.data, lc.data]));
  ok('2. DIFFERENTIAL: …and on the extract of the same rows', same(tc, xc), JSON.stringify([tc.data, xc.data]));
  const filtered = { ...onTable, encoding: ENC, filters: [{ type: 'filter', column: 'reason', op: 'in', values: ['Late', 'Damaged'] }] };
  const batch = (await b.call(b.editor, 'visual:dataBatch', { projectId: b.P, items: [{ ...onTable, encoding: ENC }, filtered, { datasetId: s.liveId, encoding: ENC }] })).body as Chart[];
  const lone = (await ed('visual:data', filtered)).body as Chart;
  ok('2. visual:dataBatch: a table item is its lone visual:data, and sits beside a dataset item', Array.isArray(batch) && same(batch[0], tc) && same(batch[1], lone) && figures(lone).size === 2 && same(batch[2], lc), JSON.stringify(batch).slice(0, 400));
  const seen = [...hydrated];
  await b.as(() => datasets.getDataset(b.P, s.copyId));
  ok('2. THE SPY: nothing asked getDataset for the table or the Live dataset (NEGATIVE CONTROL: a read of the extract is seen)', !seen.includes(s.docId) && !seen.includes(s.liveId) && hydrated.includes(s.copyId), JSON.stringify(hydrated));
  ok('2. no dataset was created, and the view\'s id is no dataset outside the call', (await b.as(() => datasets.listDatasets(b.P))).length === before && (await b.as(() => datasets.getDatasetMeta(b.P, s.docId))) === null);
  budget.setDailyCheckForTest(() => ({ ok: false, message: 'The daily limit is spent.' }));
  const refused = (await ed('visual:data', { ...onTable, encoding: { ...ENC, values: [{ column: 'amount', aggregation: 'avg' }] } })).body as Chart;
  ok('2. NEGATIVE CONTROL: the daily limit refuses a table\'s chart as any Live statement, typed', refused?.ok === false && refused.code === 'live_refused', JSON.stringify(refused));
  budget.setDailyCheckForTest(null);

  // 3. Filter values and a drill. The view carries its facts' types as a profile with no sample read: the Live dataset
  // is given the same sync (types, no sample), so both stand where a Live dataset of the table stands before a sample.
  await b.as(() => liveDataset.writeSchemaSync(b.P, s.liveId, { columns: COLUMNS, profile: { columns: FACTS.columns.map((c) => ({ name: c.name, sourceType: c.type })) }, missingColumns: [], syncedAt: new Date().toISOString(), changed: false }));
  fakeMod.resetFake();
  const td = (await ed('dataset:distinct', { ...onTable, column: 'reason' })).body;
  const ld = (await ed('dataset:distinct', { datasetId: s.liveId, column: 'reason' })).body;
  ok('3. FILTER VALUES: on the table, the unsampled Live dataset\'s typed refusal (same code, same reason), never a list', td?.ok === false && Object.is(td.code, ld?.code) && Object.is(td.reason, ld?.reason) && td.code === 'live_refused' && td.reason === 'notSampled', JSON.stringify([td, ld]));
  ok('3. …in the table\'s own sentence (keep it to list them), with no warehouse call', td?.error === say.tableValuesOnKeep() && ld?.error !== td.error && fakeMod.fake.calls.length === 0, JSON.stringify(td));
  const drillT = (await ed('visual:drillDown', { ...onTable, encoding: BY_MONTH, mark: { category: '2026-01' } })).body;
  const drillL = (await ed('visual:drillDown', { datasetId: s.liveId, encoding: BY_MONTH, mark: { category: '2026-01' } })).body;
  ok('3. a drill on the table is the Live dataset\'s, step for step', drillT?.ok === true && drillT.available === true && JSON.stringify(drillT) === JSON.stringify(drillL), JSON.stringify([drillT, drillL]).slice(0, 500));

  // 4. Copy first.
  fakeMod.resetFake();
  const onCopy = { datasetId: s.copyDoc, table: s.copyConn };
  const copies = [
    (await ed('explore:suggest', onCopy)).body,
    (await ed('visual:data', { ...onCopy, encoding: ENC })).body,
    ((await b.call(b.editor, 'visual:dataBatch', { projectId: b.P, items: [{ ...onCopy, encoding: ENC }] })).body as unknown[])[0],
    (await ed('dataset:distinct', { ...onCopy, column: 'reason' })).body,
    (await ed('visual:drillDown', { ...onCopy, encoding: BY_MONTH, mark: { category: '2026-01' } })).body,
    (await ed('explore:keepTable', onCopy)).body,
  ] as { ok?: boolean; needs?: string; error?: string }[];
  ok('4. COPY FIRST: every input on a table not asked live refuses with needs "copy" and its sentence', copies.every((r) => r?.ok === false && r.needs === 'copy' && r.error === say.copyFirst(COPY_TABLE)), JSON.stringify(copies));
  ok('4. …with no warehouse call and no dataset made', fakeMod.fake.calls.length === 0 && (await b.as(() => datasets.listDatasets(b.P))).length === before);

  // 5. Keep.
  const kept = (await ed('explore:keepTable', onTable)).body;
  const after = await b.as(() => datasets.listDatasets(b.P));
  const made = after.filter((d) => d.id === kept?.datasetId);
  ok('5. KEEP creates exactly one dataset, Live, of the table', kept?.ok === true && after.length === before + 1 && made.length === 1 && made[0].mode === 'live', JSON.stringify({ kept, n: after.length - before }));
  const keptMeta = await b.as(() => datasets.getDatasetMeta(b.P, kept.datasetId));
  ok('5. …its origin is the table on its connection, named as the table', keptMeta?.origin?.kind === 'connection' && keptMeta.origin.connId === s.connId && (keptMeta.origin as { table?: string }).table === TABLE && keptMeta.name === TABLE);
  const kf = (await ed('explore:suggest', { datasetId: kept.datasetId })).body;
  const kc = (await ed('visual:data', { datasetId: kept.datasetId, encoding: ENC })).body as Chart;
  ok('5. …its fields are the table\'s, and its figures', fieldsOf(kf) === fieldsOf(tf) && same(kc, tc), `${fieldsOf(kf)}\n${JSON.stringify(kc).slice(0, 300)}`);
}

/** The table-target inputs Explore sends, as `who` (a question of its own: the editor legs then start with no cache). */
const targetCalls = (b: Bench, s: Seeded, who: string) => {
  const t = { projectId: b.P, datasetId: s.docId, table: s.connId };
  const ENC = { category: 'reason', values: [{ column: 'amount', aggregation: 'max' }] };
  return Promise.all([
    b.call(who, 'explore:suggest', t),
    b.call(who, 'visual:data', { ...t, encoding: ENC }),
    b.call(who, 'visual:dataBatch', { projectId: b.P, items: [{ datasetId: s.docId, table: s.connId, encoding: ENC }] }),
    b.call(who, 'dataset:distinct', { ...t, column: 'reason' }),
    b.call(who, 'visual:drillDown', { ...t, encoding: BY_MONTH, mark: { category: '2026-01' } }),
  ]);
};

async function viewerLegs(b: Bench, s: Seeded, W: RP.World): Promise<void> {
  const reads = { docs: 0, conns: 0 };
  const realDocs = store.readSourceDocs;
  const realConn = connections.getConnection;
  (store as { readSourceDocs: unknown }).readSourceDocs = (...a: Parameters<typeof realDocs>) => { reads.docs++; return realDocs(...a); };
  (connections as { getConnection: unknown }).getConnection = (...a: Parameters<typeof realConn>) => { reads.conns++; return realConn(...a); };
  const counted: string[] = [];
  budget.setDailyCheckForTest((_org, datasetId) => { counted.push(datasetId); return { ok: true }; });
  try {
    fakeMod.resetFake();
    const viewer = await targetCalls(b, s, 'nobody');
    const flat = (r: Reply) => (Array.isArray(r.body) ? r.body[0] : r.body) as { ok?: boolean; error?: string };
    ok('6. VIEWERS: every table-target input is "This dataset no longer exists."', viewer.every((r) => r.status === 200 && flat(r)?.ok === false && flat(r).error === missing.liveDatasetMissing()), JSON.stringify(viewer.map((r) => r.body)));
    ok('6. …refused before ANY read: no doc, no connection, no warehouse statement, nothing counted', reads.docs === 0 && reads.conns === 0 && fakeMod.fake.calls.length === 0 && counted.length === 0, JSON.stringify({ reads, calls: fakeMod.fake.calls.length, counted }));
    const text = JSON.stringify(viewer.map((r) => r.body));
    const hits = [TABLE, CONN, FACT_CANARY, 'Damaged', '12.5'].filter((w) => text.includes(w));
    ok('6. CANARY: no viewer reply holds the table\'s name, its connection\'s, a facts-only column or a figure', hits.length === 0, JSON.stringify(hits));
    const keep = await W.call('nobody', 'explore:keepTable', { projectId: b.P, datasetId: s.docId, table: s.connId });
    ok('6. …and keep is refused before its handler (write)', keep.status === 403, JSON.stringify(keep.status));
    const editor = await targetCalls(b, s, 'ed');
    const said = JSON.stringify(editor.map((r) => r.body));
    ok('6. NEGATIVE CONTROL: the editor\'s same calls read the doc and carry what the viewer\'s did not', reads.docs >= 5 && reads.conns >= 5 && said.includes(FACT_CANARY) && said.includes('Damaged') && editor.every((r) => r.status === 200), JSON.stringify({ reads, said: said.slice(0, 300) }));
  } finally {
    (store as { readSourceDocs: unknown }).readSourceDocs = realDocs;
    (connections as { getConnection: unknown }).getConnection = realConn;
    budget.setDailyCheckForTest(null);
  }
}

async function withoutDatabase(): Promise<void> {
  const R: typeof import('./liveRouteHarness') = require('./liveRouteHarness');
  try {
    const P = await R.H.as(R.H.ORG_A, async () => {
      await R.H.projects.init();
      return (await R.H.projects.createProject('Explore source tables')).id;
    });
    const b: Bench = {
      P, editor: 'admin',
      as: (fn) => R.H.as(R.H.ORG_A, fn),
      call: async (_who, channel, payload) => {
        const r = await R.post(channel, payload);
        return { status: r.status, body: r.value };
      },
    };
    await editorLegs(b, await seed(b));
  } finally {
    await R.close();
  }
}

async function withDatabase(W: RP.World): Promise<void> {
  const b: Bench = { P: W.P, editor: 'ed', as: (fn) => W.as('boss', fn), call: (who, channel, payload) => W.call(who, channel, payload) };
  const s = await seed(b);
  await viewerLegs(b, s, W);
  await editorLegs(b, s);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    await withoutDatabase();
    console.log('skip the viewer legs: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('explore source tables');
  if (!W) return;
  try {
    await withDatabase(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('explore source tables suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
