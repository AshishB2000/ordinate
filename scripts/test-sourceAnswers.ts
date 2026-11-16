// Answers straight from a source table, keeping them, and a missing link (docs/assistant/00-design.md, phase D:
// outcomes C and E; src/ipc/sourceAnswers.ts, src/data/sourceView.ts, src/ipc/sourceKeep.ts, src/ipc/answerLink.ts).
// Through the real `copilot:ask` (the model stubbed, the prompt captured) and the real RPC route; the warehouse is the
// Live fake (./liveFakeConnector), so everything above the connector is the real thing.
//
// Both modes (no database: signed in as an org admin; DATABASE_URL: real grants, ./rowPolicyHarness):
//   1. PROMPT: an editor's Home question about a documented table gets the SOURCE TABLES block with its columns, typed
//      from the table's facts; one on a connection not asked live is marked "copy first".
//   2. DIFFERENTIAL: the answer read from the table — its card's every figure — is Object.is-equal to the same question
//      on a Live dataset of that table and to the extract of the same rows; no dataset is created; the turn names the
//      table. The figure went through the Live door: one warehouse statement, counted by the daily limit (liveBudget)
//      under the view's id; asked again, the cache answers it (orgKey). NEGATIVE CONTROL: a daily limit refuses it.
//   3. COPY: an answer naming a table on a connection that is not live-capable replies `needs: 'copy'` and its sentence,
//      with no warehouse call.
//   4. SAFETY NET: inside the view, getDataset throws LiveDatasetError and a write is refused; outside it the id is no
//      dataset.
//   5. KEEP: `answer:keepTable` re-points the turn (no `table`) at the Live dataset already over the table on its
//      connection (the fixture's twin; one is made when there is none: test-exploreSourceTables); a second keep makes
//      none; the kept answer's figures are the view's. Save as visual and Verify of a table's
//      answer are refused until it is kept.
//   6. LINK (outcome E): an answer naming a column of an unlinked dataset gets the checked-link card (the key pair, names
//      and types, the sampled share found, TO's key unique), kept on the turn; Approve (`relationship:save`) saves one
//      relationship, after which the same answer is no missing link.
// DATABASE_URL only:
//   7. VIEWERS: the project viewer's prompt never names a source table nor any column-only fact of it; a spec naming one
//      is answered as a dataset that does not exist; keep and Approve are refused (403); the link refusal is the plain
//      sentence with `needs: 'link'` and no card. NEGATIVE CONTROL: the editor's prompt and card have them.
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-sourceAnswers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import type { TableFacts } from '../src/connectors/tableFacts';

const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const view: typeof import('../src/data/sourceView') = require('../src/data/sourceView');
const sources: typeof import('../src/ipc/sourceAnswers') = require('../src/ipc/sourceAnswers');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const say: typeof import('../src/ai/sourceAnswerMessages') = require('../src/ai/sourceAnswerMessages');
const missing: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');

const TABLE = 'canary_returns_5d1';
const COPY_TABLE = 'canary_tickets_5d1';
const COLUMNS = [{ name: 'reason', type: 'text' as const }, { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }];
const ROWS = [['Damaged', 12.5, '2026-01-02'], ['Late', 7, '2026-01-03'], ['Damaged', 0.1, '2026-02-01'], ['Wrong size', 3.25, '2026-02-04'], ['Late', 0.2, '2026-03-01']];
/** A column only the table's facts hold (no dataset has it): a fact no viewer may read. */
const FACT_CANARY = 'canary_note_5d1';
const FACTS: TableFacts = { columns: [{ name: 'reason', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }, { name: 'day', type: 'DATE' }, { name: FACT_CANARY, type: 'VARCHAR' }], rowEstimate: 5 };
const QUESTION = 'returns amount by reason';
const ASK = (dataset: string) => ({ kind: 'answer', intent: 'Returns amount by reason', spec: { dataset, category: 'reason', measures: [{ column: 'amount', aggregation: 'sum' }] } });

let lastPrompt = '';
let nextAction: unknown = { kind: 'none', intent: '' };
function stubModel(): void {
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (execConfig as { assistantOn: unknown }).assistantOn = () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async (prior: unknown, facts: string, q: string) => {
    lastPrompt = `${JSON.stringify(prior)}\n${facts}\n${q}`;
    return { ok: true, text: 'Here it is.', suggestedAction: nextAction };
  };
}

interface Bench {
  P: string;
  editor: string;
  as<T>(fn: () => Promise<T>): Promise<T>;
  call(who: string, channel: string, payload: object): Promise<{ status: number; body: any }>; // any: each channel's own reply
}

interface Seeded { connId: string; docId: string; copyConn: string; copyDoc: string; liveId: string; copyId: string; sales: string; countries: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(async () => {
    fakeMod.registerLiveFake();
    await fakeMod.loadWarehouseTable(TABLE, COLUMNS, ROWS as never);
    const conn = (await connections.saveConnection(b.P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const copyConn = (await connections.saveConnection(b.P, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.internal', port: '5432', database: 'app', user: 'ro' } }))!;
    const doc = async (connId: string, table: string) => {
      const made = await store.createSourceDoc(b.P, connId, table, {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await store.updateSourceDoc(b.P, connId, made.docId, (d) => ({ ...d, facts: { ...FACTS, readAt: new Date().toISOString(), readBy: 'ed@acme.test' } }));
      return made.docId;
    };
    const docId = await doc(conn.id, TABLE);
    const copyDoc = await doc(copyConn.id, COPY_TABLE);
    const liveId = (await liveRecord.saveLiveRecord(b.P, { name: 'Returns live', columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table: TABLE } }))!.id;
    const copyId = (await datasets.saveDataset(b.P, { name: 'Returns copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS as never }))!.id;
    const sales = (await datasets.saveDataset(b.P, {
      name: 'Shipments', sourceKind: 'csv', columns: [{ name: 'country_id', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['c1', 5], ['c2', 7], ['c1', 1], ['c3', 2]] as never,
    }))!.id;
    const countries = (await datasets.saveDataset(b.P, {
      name: 'Countries', sourceKind: 'csv', columns: [{ name: 'country_id', type: 'text' }, { name: 'territory', type: 'text' }],
      rows: [['c1', 'North'], ['c2', 'South'], ['c3', 'North']] as never,
    }))!.id;
    return { connId: conn.id, docId, copyConn: copyConn.id, copyDoc, liveId, copyId, sales, countries };
  });
}

const spec = (datasetId: string, table?: string) => ({ datasetId, ...(table ? { table } : {}), category: 'reason', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Returns amount by reason' });
type Card = { ok: boolean; data?: { labels: string[]; series: { values: number[] }[] }; reason?: string; code?: string };
const figures = (c: Card): Map<string, number> => new Map((c.data?.labels ?? []).map((l, i) => [String(l), c.data!.series[0].values[i]]));
function same(a: Card, b: Card): boolean {
  const [x, y] = [figures(a), figures(b)];
  return x.size > 0 && x.size === y.size && [...x].every(([k, v]) => y.has(k) && Object.is(v, y.get(k)));
}
const lastAssistant = (reply: any) => [...(reply?.turns ?? [])].reverse().find((t: { role: string }) => t.role === 'assistant');

async function editorLegs(b: Bench, s: Seeded): Promise<void> {
  const ask = async (question: string, action: unknown, threadId?: string) => {
    nextAction = action;
    lastPrompt = '';
    const r = await b.call(b.editor, 'copilot:ask', { projectId: b.P, context: { kind: '' }, question, ...(threadId ? { threadId } : {}) });
    return { reply: r.body, prompt: lastPrompt };
  };
  // 1. The prompt.
  const before = (await b.as(() => datasets.listDatasets(b.P))).length;
  const counted: string[] = [];
  budget.setDailyCheckForTest((_org, datasetId) => { counted.push(datasetId); return { ok: true }; });
  fakeMod.resetFake();
  const first = await ask(QUESTION, ASK(TABLE));
  ok('1. prompt: an editor\'s Home question carries SOURCE TABLES with the table and its columns, typed from its facts', first.prompt.includes('SOURCE TABLES')
    && first.prompt.includes(`- ${TABLE} (on "Warehouse"): reason (text), amount (number), day (date), ${FACT_CANARY} (text)`), first.prompt.slice(first.prompt.indexOf('SOURCE TABLES'), first.prompt.indexOf('SOURCE TABLES') + 600));

  // 2. The answer, the door, the budget, the cache.
  const turn = lastAssistant(first.reply);
  ok('2. the answer names the table: its doc as the dataset id, its connection as `table`', first.reply?.ok === true && turn?.answer?.datasetId === s.docId && turn.answer.table === s.connId, JSON.stringify(first.reply).slice(0, 400));
  ok('2. …the turn brings its card (delivered inside the view)', turn?.card?.ok === true && turn.card.answeredFrom?.origin?.includes(TABLE), JSON.stringify(turn?.card ?? null).slice(0, 300));
  ok('2. ONE warehouse statement, through the door, counted by the daily limit under the view\'s id', fakeMod.fake.calls.length === 1 && counted.length === 1 && counted[0] === s.docId, JSON.stringify({ calls: fakeMod.fake.calls.length, counted }));
  ok('2. …its values went as bind parameters, never in the SQL text', fakeMod.fake.calls.every((c) => !c.sql.includes('Damaged')));
  ok('2. no dataset was created, and the view\'s id is no dataset outside the answer', (await b.as(() => datasets.listDatasets(b.P))).length === before && (await b.as(() => datasets.getDatasetMeta(b.P, s.docId))) === null);
  const fromTable = (await b.call(b.editor, 'answer:card', { projectId: b.P, spec: spec(s.docId, s.connId) })).body as Card;
  ok('2. asked again, the cache answers (no second statement)', fromTable.ok === true && fakeMod.fake.calls.length === 1, JSON.stringify({ calls: fakeMod.fake.calls.length, fromTable }).slice(0, 300));
  const onLive = (await b.call(b.editor, 'answer:card', { projectId: b.P, spec: spec(s.liveId) })).body as Card;
  const onCopy = (await b.call(b.editor, 'answer:card', { projectId: b.P, spec: spec(s.copyId) })).body as Card;
  ok('2. DIFFERENTIAL: every figure from the table is Object.is the same question on a Live dataset of it', same(fromTable, onLive), JSON.stringify([fromTable.data, onLive.data]));
  ok('2. DIFFERENTIAL: …and on the extract of the same rows', same(fromTable, onCopy), JSON.stringify([fromTable.data, onCopy.data]));
  ok('2. …and the turn\'s own card', same(turn?.card ?? {}, fromTable));
  const refine = await ask('only Late', { kind: 'answer', intent: 'Returns amount by reason, Late only', spec: { refine: true, filters: [{ column: 'reason', op: '=', value: 'Late' }] } }, first.reply.threadId);
  const refined = lastAssistant(refine.reply);
  ok('2. a follow-up continues it: the PREVIOUS ANSWER is the table\'s, and the refined answer is still read from it', refine.prompt.includes('PREVIOUS ANSWER') && refined?.answer?.datasetId === s.docId && refined.answer.table === s.connId
    && refined.answer.filters?.length === 1 && JSON.stringify(refined.card?.data?.labels) === '["Late"]', JSON.stringify(refined).slice(0, 400));
  budget.setDailyCheckForTest(() => ({ ok: false, message: 'The daily limit is spent.' }));
  const refused = (await b.call(b.editor, 'answer:card', { projectId: b.P, spec: { ...spec(s.docId, s.connId), filters: [{ column: 'reason', op: '=', value: 'Wrong size' }] } })).body as Card;
  ok('2. NEGATIVE CONTROL: the daily limit refuses a table\'s answer as any Live statement', refused.ok === false && refused.code === 'live_refused', JSON.stringify(refused));
  budget.setDailyCheckForTest(null);

  // 3. Copy first.
  fakeMod.resetFake();
  const copy = await ask('tickets amount by reason', ASK(COPY_TABLE));
  const copyTurn = lastAssistant(copy.reply);
  ok('1. …a table on a connection not asked live is marked "copy first"', copy.prompt.includes(`- ${COPY_TABLE} (on "App DB", copy first): reason (VARCHAR), amount (DOUBLE), day (DATE), ${FACT_CANARY} (VARCHAR)`), copy.prompt.slice(copy.prompt.indexOf('SOURCE TABLES'), copy.prompt.indexOf('SOURCE TABLES') + 600));
  ok('3. COPY: a table on a connection not asked live replies needs "copy" and its sentence, with no warehouse call', copyTurn?.needs === 'copy' && !copyTurn.answer && copyTurn.text.includes(say.copyFirst(COPY_TABLE)) && fakeMod.fake.calls.length === 0, JSON.stringify(copyTurn));
  const copyCard = (await b.call(b.editor, 'answer:card', { projectId: b.P, spec: spec(s.copyDoc, s.copyConn) })).body as Card;
  ok('3. …and a spec naming it is refused with the same sentence', copyCard.ok === false && copyCard.reason === say.copyFirst(COPY_TABLE), JSON.stringify(copyCard));

  // 4. The safety net.
  await b.as(async () => {
    const v = await sources.sourceView(b.P, s.connId, s.docId);
    if (!v.ok) throw new Error('fixture: the view');
    await view.withSourceViews(b.P, [v.table.view], async () => {
      let threw: unknown = null;
      try { await datasets.getDataset(b.P, s.docId); } catch (e) { threw = e; }
      ok('4. SAFETY NET: inside the view, getDataset throws LiveDatasetError (no rows here)', liveDataset.isLiveDatasetError(threw));
      const meta = await datasets.getDatasetMeta(b.P, s.docId);
      ok('4. …its record is the in-memory Live view', meta?.mode === 'live' && meta.origin?.kind === 'connection' && (await datasets.residentSource(b.P, s.docId)) === null);
      let write: unknown = null;
      try { await datasets.persist(b.P, { ...(meta as object), rows: [] } as never); } catch (e) { write = e; }
      ok('4. …and it is never written', write instanceof Error && (await b.as(() => datasets.listDatasets(b.P))).every((d) => d.id !== s.docId));
    });
  });

  // 5. Keep.
  const vis = (await b.call(b.editor, 'answer:saveVisual', { projectId: b.P, spec: spec(s.docId, s.connId) })).body;
  ok('5. Save as visual of a table\'s answer is refused until it is kept', vis?.ok === false && vis.reason === say.keepFirst(), JSON.stringify(vis));
  const ver = (await b.call(b.editor, 'verified:save', { projectId: b.P, input: { question: 'Returns by reason', phrasings: [], note: '', spec: spec(s.docId, s.connId) } })).body;
  ok('5. …and so is Verify', ver?.ok === false && ver.error === say.keepFirst(), JSON.stringify(ver));
  const threadId = first.reply.threadId as string;
  const kept = (await b.call(b.editor, 'answer:keepTable', { projectId: b.P, threadId, turnId: turn.id })).body;
  const after = await b.as(() => datasets.listDatasets(b.P));
  ok('5. KEEP re-points at the Live dataset already over that table on that connection ("Returns live"): none made', kept?.ok === true && kept.datasetId === s.liveId && after.length === before, JSON.stringify({ kept, n: after.length - before }));
  const keptMeta = await b.as(() => datasets.getDatasetMeta(b.P, kept.datasetId));
  ok('5. …its origin is the table on its connection', keptMeta?.origin?.kind === 'connection' && keptMeta.origin.connId === s.connId && (keptMeta.origin as { table?: string }).table === TABLE);
  const repointed = (kept?.turns ?? []).find((t: { id: string }) => t.id === turn.id);
  ok('5. …and the turn\'s answer points at it, no longer at the table, its provenance a Live dataset\'s', repointed?.id === turn.id && repointed.answer?.datasetId === kept.datasetId && !repointed.answer.table
    && repointed.provenance?.note === 'chart computed live by the warehouse' && turn.provenance?.note === say.tableNote(), JSON.stringify([repointed?.answer, repointed?.provenance, turn.provenance]));
  const again = (await b.call(b.editor, 'answer:keepTable', { projectId: b.P, threadId, turnId: turn.id })).body;
  ok('5. a second keep makes none', again?.ok === false && (await b.as(() => datasets.listDatasets(b.P))).length === before, JSON.stringify(again));
  const onKept = (await b.call(b.editor, 'answer:refresh', { projectId: b.P, threadId, turnId: turn.id })).body as Card;
  ok('5. the kept answer\'s figures are the table\'s', same(onKept, fromTable), JSON.stringify(onKept).slice(0, 300));

  // 6. A missing link.
  const linkAsk = { kind: 'answer', intent: 'Amount by territory', spec: { dataset: 'Shipments', category: 'territory', measures: [{ column: 'amount', aggregation: 'sum' }] } };
  const unlinked = await ask('shipment amount by territory', linkAsk);
  const lt = lastAssistant(unlinked.reply);
  ok('6. LINK: an answer naming a column of an unlinked dataset gets the checked link, kept on its turn', lt?.needs === 'link' && lt.link?.from?.datasetId === s.sales && lt.link.from.column === 'country_id'
    && lt.link.to.datasetId === s.countries && lt.link.to.column === 'country_id' && lt.link.cardinality === 'many_to_one', JSON.stringify(lt));
  ok('6. …its checks: names and types match, every sampled key found, unique in Countries', lt?.link?.checks?.names === true && lt.link.checks.types === true && Object.is(lt.link.checks.foundPct, 100) && lt.link.checks.unique === true, JSON.stringify(lt?.link?.checks));
  const reopened = (await b.call(b.editor, 'copilot:history', { projectId: b.P, threadId })).body;
  ok('6. …a reload brings the same card', JSON.stringify(lastAssistant(reopened)?.link) === JSON.stringify(lt?.link), JSON.stringify(lastAssistant(reopened)).slice(0, 300));
  const saved = (await b.call(b.editor, 'relationship:save', { projectId: b.P, relationship: { from: { datasetId: s.sales, column: 'country_id' }, to: { datasetId: s.countries, column: 'country_id' }, cardinality: lt.link.cardinality } })).body;
  const list = await b.as(() => rels.listRelationships(b.P));
  ok('6. APPROVE saves exactly one relationship, counted over the full tables', saved?.ok === true && list.length === 1 && list[0].verified.matched === 4, JSON.stringify({ saved, n: list.length }));
  const linked = await ask('shipment amount by territory', linkAsk);
  ok('6. …after which the same answer is no missing link', !lastAssistant(linked.reply)?.needs, JSON.stringify(lastAssistant(linked.reply)));
}

async function viewerLegs(b: Bench, s: Seeded, W: RP.World): Promise<void> {
  nextAction = { kind: 'none', intent: '' };
  lastPrompt = '';
  const asked = await W.call('nobody', 'copilot:ask', { projectId: b.P, context: { kind: '' }, question: QUESTION });
  const p = lastPrompt.toLowerCase();
  const hits = [TABLE, COPY_TABLE, FACT_CANARY, 'source tables —'].filter((w) => p.includes(w));
  ok('7. VIEWERS: the viewer\'s prompt names no source table, holds no fact only a table has, and carries no SOURCE TABLES block (NEGATIVE CONTROL: 1., the editor\'s)', asked.body?.ok === true && p.length > 0 && hits.length === 0, JSON.stringify(hits) + lastPrompt.slice(Math.max(0, p.indexOf(hits[0] ?? '') - 300), p.indexOf(hits[0] ?? '') + 200));
  const card = await W.call('nobody', 'answer:card', { projectId: b.P, spec: spec(s.docId, s.connId) });
  ok('7. …a spec naming a table is answered as a dataset that does not exist', card.body?.ok === false && card.body.reason === missing.liveDatasetMissing() && !card.text.includes(TABLE) && !card.text.includes(FACT_CANARY), card.text);
  const copyCard = await W.call('nobody', 'answer:card', { projectId: b.P, spec: spec(s.copyDoc, s.copyConn) });
  ok('7. …the table to copy too: not even its name', copyCard.body?.ok === false && !copyCard.text.includes(COPY_TABLE) && !copyCard.text.includes('App DB'), copyCard.text);
  const keep = await W.call('nobody', 'answer:keepTable', { projectId: b.P, threadId: asked.body.threadId, turnId: 'x' });
  const approve = await W.call('nobody', 'relationship:save', { projectId: b.P, relationship: { from: { datasetId: s.countries, column: 'country_id' }, to: { datasetId: s.sales, column: 'country_id' }, cardinality: 'many_to_one' } });
  ok('7. …keep and Approve are refused before their handlers (write)', keep.status === 403 && approve.status === 403, JSON.stringify([keep.status, approve.status]));
  // A fresh unlinked pair for the viewer's link refusal.
  const ids = await W.as('boss', async () => [
    (await datasets.saveDataset(b.P, { name: 'Parcels', sourceKind: 'csv', columns: [{ name: 'zone_id', type: 'text' }, { name: 'weight', type: 'number' }], rows: [['z1', 1]] as never }))!.id,
    (await datasets.saveDataset(b.P, { name: 'Zones', sourceKind: 'csv', columns: [{ name: 'zone_id', type: 'text' }, { name: 'zone_name', type: 'text' }], rows: [['z1', 'Inner']] as never }))!.id,
  ]);
  nextAction = { kind: 'answer', intent: 'Weight by zone', spec: { dataset: 'Parcels', category: 'zone_name', measures: [{ column: 'weight', aggregation: 'sum' }] } };
  const v = await W.call('nobody', 'copilot:ask', { projectId: b.P, context: { kind: '' }, question: 'parcel weight by zone name' });
  const vt = lastAssistant(v.body);
  ok('7. …the viewer\'s link refusal is the sentence with needs "link" and no card', vt?.needs === 'link' && !vt.link && vt.text.includes(say.cannotCombine()), JSON.stringify(vt));
  const e = await W.call('ed', 'copilot:ask', { projectId: b.P, context: { kind: '' }, question: 'parcel weight by zone name' });
  ok('7. NEGATIVE CONTROL: the editor\'s same ask gets the card', lastAssistant(e.body)?.link?.to?.datasetId === ids[1], JSON.stringify(lastAssistant(e.body)).slice(0, 300));
}

async function withoutDatabase(): Promise<void> {
  const R: typeof import('./liveRouteHarness') = require('./liveRouteHarness');
  try {
    const P = await R.H.as(R.H.ORG_A, async () => {
      await R.H.projects.init();
      return (await R.H.projects.createProject('Source answers')).id;
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
  await viewerLegs(b, s, W); // first: once kept, the table is a dataset (named as the table) every member may see
  await editorLegs(b, s);
}

(async () => {
  stubModel();
  if (!process.env.DATABASE_URL) {
    await withoutDatabase();
    console.log('skip the viewer legs: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('source answers');
  if (!W) return;
  try {
    await withDatabase(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('source answers suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
