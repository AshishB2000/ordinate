// SQL answers on source tables, F5 (docs/live-data/01-live-sql.md, "The PR plan"): an editor's Home question offers
// documented warehouse tables (the SOURCE TABLES block), the SQL lane's first call names one where no dataset has the
// name, and its in-memory Live view (src/data/sourceView.ts) is read as a Live dataset by phase F's executor. Through
// the real handlers, both model calls stubbed and spied; the warehouse is the Live fake (./liveFakeConnector).
//
// Both modes (no database: the org admin is the editor, an org viewer the viewer; DATABASE_URL: real project grants
// through the RPC route, ./rowPolicyHarness):
//   1. DIFFERENTIAL: an editor's table answer is Object.is-equal, cell for cell, to F2's reference (./liveSqlDiff:
//      DuckDB running the model's own text over the extract twin); the second call holds the tables' columns typed from
//      their stored facts; the turn keeps the doc ids and the connection (`sql.table`).
//   2. THE DOOR: one counted statement, under a view's id; asked again, the cache; nothing hydrated (a spy on
//      getDataset); no dataset made.
//   3. ONE CONNECTION: a table and a Live dataset on the SAME connection answer together, equal to the reference; a table
//      and a Live dataset on two connections are refused before any SQL is written (CONTROL: the first).
//   4. COPY FIRST: a table on a connection not asked live replies needs "copy", with no second call and no statement.
//   5. VIEWERS: with a model that can only name what it was told, the viewer's prompts and replies hold no table name and
//      their answer reads a dataset (CONTROL: as an editor, they hold it and the answer reads the table); a model naming
//      one anyway is refused in the lane's own words, with no table's doc read, no second call and no statement; Keep is
//      refused (403 off the route).
//   6. KEEP, THEN VERIFY: Verify before Keep saves nothing; Keep makes one Live dataset per table read and re-points the
//      turn (no `table`, the text unchanged); a second Keep makes none, nor does Keep of another turn over the same tables
//      (re-pointed at the kept ones; NEGATIVE CONTROL: the two tables make two); Verify then saves the SQL against the kept
//      datasets; asked word for word it runs with no model call, equal to the reference. ATOMIC: a Keep whose second table
//      cannot be kept (gone from the warehouse) makes nothing: the first, made, is deleted for good (not left in the
//      Trash) and the turn is unchanged (NEGATIVE CONTROL: the Keep after it, both tables there, makes two and re-points).
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-liveSqlSources.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const verifiedQs: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const lmsg: typeof import('../src/engine/liveSqlMessages') = require('../src/engine/liveSqlMessages');
const amsg: typeof import('../src/ai/answerSqlMessages') = require('../src/ai/answerSqlMessages');
const say: typeof import('../src/ai/sourceAnswerMessages') = require('../src/ai/sourceAnswerMessages');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');

type Role = import('../src/server/context').Identity['user']['role'];
type Table = import('./liveSqlDiff').Table;
type Kit = import('./liveSqlDiff').Kit;
const fake = fakeMod.fake;

/** The warehouse tables, documented on the project's connections: names no reply to a viewer may hold. */
const ORDERS_T = 'f5_orders_canary';
const TARGETS_T = 'f5_targets_canary';
const COPY_T = 'f5_tickets_canary';
/** The warehouse table the Live datasets `targets` and `far_targets` read: no doc. */
const LIVE_T = 'f5_live_targets_canary';
const QUESTION = 'canary orders against targets';
/** The corpus's statements read `orders` and `targets`: over the tables they read the tables' names (the slugs the second call is given). */
const onTables = (sql: string): string => sql.replace(/\borders\b/g, ORDERS_T).replace(/\btargets\b/g, TARGETS_T);
const onTableAndLive = (sql: string): string => sql.replace(/\borders\b/g, ORDERS_T); // `targets` the Live dataset
/** The fixture as a warehouse holds it, the long id as text: what the table's facts and its catalog both say. */
const ORDERS_LAYOUT = fx.layout(fx.COLUMNS).map((c) => (c.name === 'bigid' ? { ...c, store: 'text' as const } : c));
const TARGETS_LAYOUT = corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const }));

// ── the two model calls, stubbed and spied ─────────────────────────────────
type Said = string | ((prompt: string) => string);
const calls = { ask: 0, facts: [] as string[], sql: [] as string[] };
let nextAction: unknown = { kind: 'none', intent: '' };
let nextSql: Said = '';
(execConfig as { executionReady: unknown }).executionReady = async () => true;
(execConfig as { assistantOn: unknown }).assistantOn = () => true;
(analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, facts: string) => {
  calls.ask++;
  calls.facts.push(facts);
  return { ok: true, text: 'These are the ones.', suggestedAction: typeof nextAction === 'function' ? nextAction(facts) : nextAction };
};
(analyze as { dispatch: unknown }).dispatch = async (_system: string, messages: Array<{ text: string }>) => {
  const text = messages.map((m) => m.text).join('\n');
  calls.sql.push(text);
  return { rawText: typeof nextSql === 'function' ? nextSql(text) : nextSql };
};
// Spies: the source docs read (a Live dataset's own facts read its table's doc too), and a hydration (a Live dataset has
// no rows here; neither has a table).
const docReads: string[] = [];
const realDocs = store.readSourceDocs;
(store as { readSourceDocs: unknown }).readSourceDocs = (...a: Parameters<typeof realDocs>) => { docReads.push(...a[1].map((r) => r.docId)); return realDocs(...a); };
let liveSaves = 0; // Live records written: a Keep's made datasets
const realSave = liveRecord.saveLiveRecord;
(liveRecord as { saveLiveRecord: unknown }).saveLiveRecord = (...a: Parameters<typeof realSave>) => { liveSaves++; return realSave(...a); };
let hydrated = 0;
const realGet = datasets.getDataset;
(datasets as { getDataset: unknown }).getDataset = (...a: Parameters<typeof realGet>) => { hydrated++; return realGet(...a); };

const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 400) ?? String(v);
const sqlAction = (names: string[]) => ({ kind: 'sql', intent: 'a question one chart cannot say', datasets: names });
const close = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(a), Math.abs(b));

/** Where a delivered card and F2's reference differ: empty when they agree (types, then every cell, in order). P2: one leading U+FEFF dropped from Live's. */
function problems(card: any, ref: Table | { error: string }, approx: readonly number[] = []): string[] { // any: a delivered card
  if ('error' in ref) return [`the reference failed: ${ref.error}`];
  if (!card || card.kind !== 'sql') return [`no table: ${show(card)}`];
  const out: string[] = [];
  if (card.truncated !== ref.truncated) out.push(`truncated ${card.truncated} vs ${ref.truncated}`);
  if (card.columns.length !== ref.columns.length) out.push(`width ${card.columns.length} vs ${ref.columns.length}`);
  ref.sqlTypes.forEach((t, i) => { if (card.columns[i]?.type !== sqlDatasets.columnKind(t) && ref.rows.some((r) => r[i] !== null)) out.push(`column ${i}: ${card.columns[i]?.type} vs ${t}`); });
  if (card.rows.length !== ref.rows.length) out.push(`rows ${card.rows.length} vs ${ref.rows.length}`);
  ref.rows.forEach((r, i) => r.forEach((v, j) => {
    let w = card.rows[i]?.[j];
    if (typeof w === 'string' && w.startsWith('﻿')) w = w.slice(1);
    if (!Object.is(v, w) && !(approx.includes(j) && close(v, w))) out.push(`row ${i} col ${j}: ${JSON.stringify(v)} vs ${JSON.stringify(w)}`);
  }));
  return out.slice(0, 6);
}

interface Bench {
  P: string;
  admin: string;
  editor: string;
  viewer: string;
  /** In the DB leg the corpus is cut to stay inside SQL_PER_HOUR, which counts in Postgres there. */
  cases: number;
  as<T>(who: string, fn: () => Promise<T>): Promise<T>;
  /** A channel's reply as `who`, and its HTTP status (200 off the route; always 200 calling the handler). */
  call(who: string, channel: string, payload: object): Promise<{ status: number; body: any }>; // any: each channel's own reply
}

interface Seeded { kit: Kit; conn: string; ordersDoc: string; targetsDoc: string; copyDoc: string; targets: string; farTargets: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(b.admin, async () => {
    fakeMod.registerLiveFake();
    const kit = await diff.setupKit(ok); // the reference's own project: the extract twins
    if (!kit) throw new Error('no kit');
    await fx.duckEngine.load(ORDERS_T, ORDERS_LAYOUT, kit.rows.orders);
    await fx.duckEngine.load(TARGETS_T, TARGETS_LAYOUT, kit.rows.targets);
    await fx.duckEngine.load(LIVE_T, TARGETS_LAYOUT, kit.rows.targets);
    const conn = (await connections.saveConnection(b.P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!.id;
    const far = (await connections.saveConnection(b.P, { name: 'Far warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!.id;
    const appDb = (await connections.saveConnection(b.P, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.internal', port: '5432', database: 'app', user: 'ro' } }))!.id;
    const doc = async (connId: string, table: string, layout: readonly import("./liveParityFixture").StoredColumn[]) => {
      const made = await store.createSourceDoc(b.P, connId, table, {});
      if (!made.ok) throw new Error('fixture: a source doc');
      const columns = layout.map((c) => ({ name: c.name, type: fx.duckEngine.typeName(c.store) }));
      await store.updateSourceDoc(b.P, connId, made.docId, (d) => ({ ...d, facts: { columns, readAt: new Date().toISOString(), readBy: 'ed@acme.test' } }));
      return made.docId;
    };
    const live = async (name: string, connId: string) =>
      (await liveRecord.saveLiveRecord(b.P, { name, columns: corpus.TARGET_COLUMNS, origin: { kind: 'connection', connId, table: LIVE_T } }))!.id;
    return {
      kit, conn, ordersDoc: await doc(conn, ORDERS_T, ORDERS_LAYOUT), targetsDoc: await doc(conn, TARGETS_T, TARGETS_LAYOUT),
      copyDoc: await doc(appDb, COPY_T, TARGETS_LAYOUT), targets: await live('targets', conn), farTargets: await live('far_targets', far),
    };
  });
}

async function legs(b: Bench, s: Seeded): Promise<void> {
  const replies: Record<string, string[]> = {};
  const call = async (who: string, ch: string, payload: object) => {
    const r = await b.call(who, ch, payload);
    (replies[who] ??= []).push(JSON.stringify(r.body));
    return r;
  };
  const ask = async (who: string, names: string[] | ((facts: string) => unknown), sql: Said, threadId?: string, question = QUESTION) => {
    nextAction = typeof names === 'function' ? names : sqlAction(names);
    nextSql = sql;
    const [a0, s0, f0, d0] = [calls.ask, calls.sql.length, fake.calls.length, docReads.length];
    const thread = threadId ?? ((await call(who, 'copilot:newThread', { projectId: b.P })).body.thread.id as string);
    const r = (await call(who, 'copilot:ask', { projectId: b.P, threadId: thread, context: { kind: '' }, question })).body;
    return { r, thread, asks: calls.ask - a0, sqls: calls.sql.length - s0, sent: fake.calls.length - f0, tableDocs: docReads.slice(d0).filter((id) => [s.ordersDoc, s.targetsDoc, s.copyDoc].includes(id)).length, facts: calls.facts.at(-1) ?? '', prompt: calls.sql[s0] ?? '', turn: r?.turns?.at(-1) };
  };
  const ref = (sql: string) => b.as(b.admin, () => diff.reference(s.kit, sql, false));
  const refusedWith = (a: Awaited<ReturnType<typeof ask>>, sentence: string): boolean =>
    a.r?.ok === true && !a.turn?.sql && !a.turn?.card && String(a.turn?.text).includes(sentence) && a.sent === 0 && a.sqls === 0;
  const fresh = (): void => counters.resetMemoryForTest();
  const datasetCount = async () => (await b.as(b.admin, () => datasets.listDatasets(b.P))).length;
  const E = b.editor;
  fresh();

  // 1. The differential, through the channel, every table answer read straight from its view.
  const before = await datasetCount();
  const h0 = hydrated;
  const cases = corpus.CASES.slice(0, b.cases);
  let agree = 0;
  for (const [i, c] of cases.entries()) {
    if (i % 25 === 0) fresh(); // SQL_PER_HOUR is not this check's
    const a = await ask(E, [ORDERS_T, TARGETS_T], onTables(c.sql));
    const p = problems(a.turn?.card, await ref(c.sql), c.approx);
    if (!p.length) agree++;
    else ok(`1. ${c.name}`, false, `${p.join(' | ')} ${show(a.turn)}\n  ${onTables(c.sql)}`);
  }
  ok(`1. DIFFERENTIAL: an editor's answer from two source tables is Object.is-equal to the reference (${agree}/${cases.length})`, agree === cases.length && cases.length >= 12);
  fresh();
  const first = await ask(E, [ORDERS_T, TARGETS_T], onTables(corpus.CASES[0].sql));
  ok('1. the first call was offered the tables in SOURCE TABLES, typed from their facts', first.facts.includes('SOURCE TABLES') && first.facts.includes(`- ${ORDERS_T} (on "Warehouse"): many (text), cat (text), region (text), amt (number)`), first.facts.slice(first.facts.indexOf('SOURCE TABLES'), first.facts.indexOf('SOURCE TABLES') + 400));
  ok('1. the second call is told each table by its name, Live, its columns from its facts (dates DATE), and the Live rules', new RegExp(`- ${ORDERS_T} \\(the dataset "${ORDERS_T}" · Live\\)\\n {4}many text, cat text, region text, amt number, qty number, tier number, d date, bigid text`).test(first.prompt)
    && first.prompt.includes(`- ${TARGETS_T} (`) && first.prompt.includes('NOTE: A table marked Live'), first.prompt.slice(0, 500));
  ok('1. the turn: the model\'s text, the tables\' doc ids, their connection, the card dated live and naming the tables', first.turn?.sql?.text === onTables(corpus.CASES[0].sql) && first.turn.sql.table === s.conn
    && first.turn.sql.datasetIds.every((id: string) => [s.ordersDoc, s.targetsDoc].includes(id)) && first.turn.card?.asOf?.mode === 'live' && first.turn.card.datasets.includes(ORDERS_T), show(first.turn?.sql));
  const locked = await b.as(b.admin, () => diff.reference(s.kit, corpus.CASES[0].sql, true));
  ok('1. NEGATIVE CONTROL: the same comparison against the reference locked to East disagrees', problems(first.turn?.card, locked).length > 0);

  // 2. The door: one counted statement, the cache, nothing hydrated, nothing made.
  const counted: string[] = [];
  budget.setDailyCheckForTest((_org, datasetId) => { counted.push(datasetId); return { ok: true }; });
  const COUNT = `SELECT region, count(*) AS n FROM ${ORDERS_T} WHERE qty > 2 GROUP BY region ORDER BY region`;
  const c1 = await ask(E, [ORDERS_T], COUNT);
  const c2 = await ask(E, [ORDERS_T], COUNT);
  budget.setDailyCheckForTest(null);
  ok('2. ONE warehouse statement, counted by the daily limit under the table view\'s id; asked again, the cache', c1.sent === 1 && c2.sent === 0 && counted.length === 1 && counted[0] === s.ordersDoc && c2.turn?.card?.asOf?.cached === true, show({ sent: [c1.sent, c2.sent], counted }));
  ok('2. …the statement names the warehouse table, and binds its values', fake.calls.at(-1)!.sql.includes(ORDERS_T) && fake.calls.at(-1)!.params.some((p) => p.value === 2), fake.calls.at(-1)!.sql.slice(0, 300));
  budget.setDailyCheckForTest(() => ({ ok: false, message: 'The daily limit is spent.' }));
  const spent = await ask(E, [ORDERS_T], `SELECT region, min(qty) AS low FROM ${ORDERS_T} GROUP BY region ORDER BY region`);
  budget.setDailyCheckForTest(null);
  ok('2. NEGATIVE CONTROL: the daily limit refuses a table\'s statement as any Live one\'s, nothing sent', spent.r?.ok === true && !spent.turn?.card && String(spent.turn?.text).includes('The daily limit is spent.') && spent.sent === 0, show(spent.turn?.text));
  ok('2. nothing was hydrated and no dataset was made', hydrated === h0 && (await datasetCount()) === before, show({ hydrated: hydrated - h0, made: (await datasetCount()) - before }));

  // 3. One connection: a table and a Live dataset on it; refused across two.
  fresh();
  const mixCases = corpus.CASES.filter((c) => /\btargets\b/.test(c.sql) && /\borders\b/.test(c.sql)).slice(0, 6);
  let mixed = 0;
  for (const c of mixCases) {
    const a = await ask(E, [ORDERS_T, 'targets'], onTableAndLive(c.sql));
    const p = problems(a.turn?.card, await ref(c.sql), c.approx);
    if (!p.length && a.sent <= 1 && a.turn?.sql?.datasetIds.includes(s.targets) && a.turn.sql.table === s.conn) mixed++;
    else ok(`3. ${c.name}`, false, `${p.join(' | ')} ${show(a.turn?.sql)}`);
  }
  ok(`3. a table and a Live dataset on ONE connection answer together, Object.is-equal to the reference (${mixed}/${mixCases.length})`, mixed === mixCases.length && mixCases.length >= 3);
  const two = await ask(E, [ORDERS_T, 'far_targets'], `SELECT count(*) AS n FROM ${ORDERS_T}`);
  ok('3. a table and a Live dataset on two connections: refused before any SQL is written, nothing sent', refusedWith(two, lmsg.sqlTwoConnections()), show(two.turn?.text));

  // 4. Copy first.
  const copy = await ask(E, [COPY_T], `SELECT count(*) AS n FROM ${COPY_T}`);
  ok('4. COPY FIRST: a table on a connection not asked live replies needs "copy", no second call, no statement', copy.r?.ok === true && copy.turn?.needs === 'copy' && !copy.turn.sql
    && String(copy.turn.text).includes(say.copyFirst(COPY_T)) && copy.sqls === 0 && copy.sent === 0, show(copy.turn));

  // 5. Viewers: never a table (before Keep makes the tables datasets every member may open).
  const honest = (facts: string) => sqlAction(facts.includes(ORDERS_T) ? [ORDERS_T] : ['targets']); // it names only what it was told
  const honestSql = (prompt: string) => (prompt.includes(`- ${ORDERS_T} (`) ? `SELECT region, count(*) AS n FROM ${ORDERS_T} GROUP BY region ORDER BY region` : 'SELECT region, max(target) AS top FROM targets GROUP BY region ORDER BY region');
  const leaks = (texts: readonly string[]) => texts.filter((t) => [ORDERS_T, TARGETS_T, COPY_T, LIVE_T, 'SOURCE TABLES'].some((w) => t.includes(w)));
  const V = b.viewer;
  const vr0 = (replies[V] ?? []).length;
  const v = await ask(V, honest, honestSql);
  const vPrompts = [v.facts, v.prompt];
  ok('5. VIEWERS: the viewer\'s prompts hold no table name and no SOURCE TABLES, and their answer reads a dataset', v.asks === 1 && v.sqls === 1 && leaks(vPrompts).length === 0 && v.turn?.card?.kind === 'sql'
    && v.turn.sql?.datasetIds?.join() === s.targets && !v.turn.sql.table && v.tableDocs === 0, show({ leaked: leaks(vPrompts).map((t) => t.slice(0, 200)), turn: v.turn?.sql, docs: v.tableDocs }));
  const e = await ask(E, honest, honestSql);
  ok('5. CONTROL: as an editor, the same model is told the table, names it, and the answer and the reply hold it', leaks([e.facts]).length > 0 && e.prompt.includes(`- ${ORDERS_T} (`) && e.turn?.sql?.table === s.conn
    && (replies[E] ?? []).at(-1)!.includes(ORDERS_T), show(e.turn?.sql));
  const hostile = await ask(V, [ORDERS_T], `SELECT count(*) AS n FROM ${ORDERS_T}`);
  ok('5. a model naming a table to a viewer anyway: the lane\'s own refusal (its word quoted), no doc read, no second call, no statement', refusedWith(hostile, amsg.sqlNoDataset(ORDERS_T)) && hostile.tableDocs === 0, show({ text: hostile.turn?.text, docs: hostile.tableDocs }));
  const vReplies = (replies[V] ?? []).slice(vr0).map((r) => r.split(JSON.stringify(amsg.sqlNoDataset(ORDERS_T)).slice(1, -1)).join(''));
  ok(`5. …and no reply to the viewer (${vReplies.length}) holds a table name but that quote of the model's word`, leaks(vReplies).length === 0, leaks(vReplies)[0]?.slice(0, 300));
  const vKeep = await b.call(V, 'answer:keepTable', { projectId: b.P, threadId: e.thread, turnId: e.turn.id });
  ok('5. …and Keep is refused to a viewer', vKeep.status === 403 || vKeep.body?.ok === false, show(vKeep));
  // 6. Keep, then Verify.
  const KEEP = `SELECT o.region, count(*) AS n, max(t.target) AS goal FROM ${ORDERS_T} o JOIN ${TARGETS_T} t ON o.region = t.region GROUP BY o.region ORDER BY o.region`;
  const asked = await ask(E, [ORDERS_T, TARGETS_T], KEEP);
  const twin = await ask(E, [ORDERS_T, TARGETS_T], KEEP); // another turn over the same tables, asked before either is kept
  const KEEP_REF = await ref(KEEP.replace(new RegExp(ORDERS_T, 'g'), 'orders').replace(new RegExp(TARGETS_T, 'g'), 'targets'));
  ok('6. the table answer to keep is the reference\'s', problems(asked.turn?.card, KEEP_REF).length === 0, show(asked.turn?.card?.rows));
  const VQ = 'canary orders per region against their target';
  const early = (await call(E, 'verified:save', { projectId: b.P, input: { question: VQ, sql: KEEP } })).body;
  ok('6. Verify before Keep saves nothing: a verified question names datasets', early?.ok === false, show(early));
  // Atomic: the second table is gone from the warehouse when Keep runs.
  const broken = await ask(E, [ORDERS_T, TARGETS_T], KEEP);
  const history = async (t: typeof broken) => ((await call(E, 'copilot:history', { projectId: b.P, threadId: t.thread })).body?.turns ?? []).find((x: { id: string }) => x.id === t.turn.id);
  const rename = (a: string, z: string) => b.as(b.admin, () => duck.execAsync(`ALTER TABLE "${a}" RENAME TO "${z}"`));
  const [nb, saves0] = [await datasetCount(), liveSaves];
  await rename(TARGETS_T, `${TARGETS_T}_away`);
  let failed: any; // any: the channel's reply
  try {
    failed = (await call(E, 'answer:keepTable', { projectId: b.P, threadId: broken.thread, turnId: broken.turn.id })).body;
  } finally {
    await rename(`${TARGETS_T}_away`, TARGETS_T);
  }
  const still = await history(broken);
  const binned = (await b.as(b.admin, () => trash.list(b.P))).filter((e) => e.type === 'dataset');
  ok('6. ATOMIC KEEP: a second table that cannot be kept fails the Keep; the first, made, is deleted for good: zero datasets made, none in the Trash', failed?.ok === false && broken.turn?.sql?.datasetIds?.[1] === s.targetsDoc
    && liveSaves - saves0 === 1 && (await datasetCount()) === nb && binned.length === 0, show({ failed, order: broken.turn?.sql?.datasetIds, saves: liveSaves - saves0, made: (await datasetCount()) - nb, binned }));
  ok('6. …and the turn is not re-pointed: its table and its doc ids as they were', still?.sql?.table === s.conn && JSON.stringify(still.sql.datasetIds) === JSON.stringify(broken.turn.sql.datasetIds), show(still?.sql));
  const n0 = await datasetCount();
  const kept = (await call(E, 'answer:keepTable', { projectId: b.P, threadId: asked.thread, turnId: asked.turn.id })).body;
  const repointed = (kept?.turns ?? []).find((t: { id: string }) => t.id === asked.turn.id);
  const keptIds: string[] = repointed?.sql?.datasetIds ?? [];
  ok('6. KEEP makes one Live dataset per table read, and re-points the turn: the kept ids, no table, the text unchanged', kept?.ok === true && (await datasetCount()) === n0 + 2 && keptIds.length === 2
    && keptIds.every((id) => ![s.ordersDoc, s.targetsDoc].includes(id)) && !repointed.sql.table && repointed.sql.text === KEEP, show({ kept, made: (await datasetCount()) - n0 }));
  ok('6. NEGATIVE CONTROL: a different table on the same connection makes a new one — two tables, two datasets', new Set(keptIds).size === 2);
  const names = await b.as(b.admin, () => sqlDatasets.projectNames(b.P));
  ok('6. …each kept dataset takes the name its view had, so the same text reads it', [ORDERS_T, TARGETS_T].every((t) => names.some((e) => e.slug === t && keptIds.includes(e.id))), show(names.filter((e) => keptIds.includes(e.id))));
  const again = (await call(E, 'answer:keepTable', { projectId: b.P, threadId: asked.thread, turnId: asked.turn.id })).body;
  ok('6. a second Keep makes none', again?.ok === false && again.reason === say.notFromTable() && (await datasetCount()) === n0 + 2, show(again));
  const keptTwin = (await call(E, 'answer:keepTable', { projectId: b.P, threadId: twin.thread, turnId: twin.turn.id })).body;
  const twinIds: string[] = (keptTwin?.turns ?? []).find((t: { id: string }) => t.id === twin.turn.id)?.sql?.datasetIds ?? [];
  ok('6. KEEP of another turn over the same tables makes no second dataset: it is re-pointed at the kept ones', keptTwin?.ok === true && (await datasetCount()) === n0 + 2 && twinIds.join() === keptIds.join(), show({ keptTwin: keptTwin?.ok, twinIds, keptIds }));
  const onKept = (await call(E, 'answer:refresh', { projectId: b.P, threadId: asked.thread, turnId: asked.turn.id })).body;
  ok('6. the kept answer, run again on the kept datasets, is the reference\'s', problems(onKept, KEEP_REF).length === 0, show(onKept));
  const saved = (await call(E, 'verified:save', { projectId: b.P, input: { question: VQ, sql: KEEP } })).body;
  const rec = (await b.as(b.admin, () => verifiedQs.listBoth(b.P))).sql.find((t) => t.rec.question === VQ)?.rec;
  ok('6. VERIFY after Keep saves the SQL against the kept datasets', saved?.ok === true && rec?.sql.text === KEEP && [...(rec?.sql.datasetIds ?? [])].sort().join() === [...keptIds].sort().join(), show({ saved, rec }));
  const word = await ask(E, [], 'SELECT 1', undefined, VQ);
  ok('6. …asked word for word it runs with no model call, marked verified, equal to the reference', word.asks === 0 && word.sqls === 0 && problems(word.turn?.card, KEEP_REF).length === 0 && !!word.turn?.card?.verified, show(word.turn));

}

let req = 0;
async function fileLeg(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesqlsources-'));
  try {
    context.enterServerMode(DATA);
    poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
    appMod.registerHandlers();
    const ROLE: Record<string, Role> = { ana: 'admin', vic: 'viewer' };
    const as = <T>(who: string, fn: () => Promise<T>): Promise<T> =>
      context.runInContext({ user: { email: `${who}@acme.test`, role: ROLE[who] }, org: { id: 'acme' } }, `q${++req}`, fn);
    const P = await as('ana', async () => {
      await projects.init();
      return (await projects.createProject('Live SQL on source tables')).id;
    });
    const b: Bench = {
      P, admin: 'ana', editor: 'ana', viewer: 'vic', cases: corpus.CASES.length, as,
      call: async (who, ch, payload) => ({ status: 200, body: await as(who, () => handlers.get(ch)!({}, payload)) }),
    };
    await legs(b, await seed(b));
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function dbLeg(): Promise<void> {
  handlers.clear(); // the world registers every handler itself
  const W = await RP.world('the Postgres leg of SQL answers on source tables');
  if (!W) return;
  try {
    const P: string = (await W.call('boss', 'projects:create', { name: 'Live SQL on source tables' })).body.id;
    for (const [member, role] of [[{ userId: W.uid.ed }, 'editor'], [{ userId: W.uid.nobody }, 'viewer']] as const) {
      const r = await W.call('boss', 'project:share', { projectId: P, member, role });
      if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
    }
    const b: Bench = { P, admin: 'boss', editor: 'ed', viewer: 'nobody', cases: 12, as: (who, fn) => W.as(who, fn), call: (who, ch, payload) => W.call(who, ch, payload) };
    await legs(b, await seed(b));
  } finally {
    await W.close();
  }
}

(async () => {
  if (!process.env.DATABASE_URL) await fileLeg();
  else await dbLeg();
})()
  .catch((e) => ok('the SQL answers on source tables suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
