// SQL answers for viewers on the tables their teams were given, F6 (docs/live-data/01-live-sql.md, "The PR plan" and
// "F6 as built"; docs/team-folders/00-design.md, "Connection tables, as built (E8)"). A project viewer's SQL lane reads
// a given, labelled table through the view `sourceView` builds for them — named by the label, declaring only the
// columns their teams leave visible — and F3's executor prints the statement over that view. Through the real
// handlers, both model calls stubbed and spied; the warehouse is the Live fake (./liveFakeConnector).
//
// Both modes. Without a database the org admin is the editor and an org viewer the viewer, whose teams' rows are the
// rule's own fold (`givenFrom`) of fixture rows: only the one read `givenOn` makes is stubbed. With DATABASE_URL a real
// team holds the viewer role, its rows written by `teamTables:set`, every call through the RPC route (./rowPolicyHarness).
//   1. DIFFERENTIAL: the corpus over the two given tables by their labels: the viewer's table Object.is-equal to the
//      editor's on the same tables by their warehouse names, and to F2's reference; each statement naming the hidden
//      column refused as a made-up name, nothing sent (CONTROL: the editor's answers). The turn keeps the docs and the
//      connection; the card names the labels; Show SQL is the model's text.
//   2. THE VIEW: both prompts name the tables by their labels, without the hidden column (NEGATIVE CONTROL: the
//      editor's hold it); `SELECT *` prints a view without it (CONTROL: unhidden, it is printed and returned).
//   3. UNKNOWN NAMES: an unticked table the first call names is refused with no doc of it read (CONTROL: ticked, it
//      answers); a statement naming it, a warehouse name, a qualified one or an editor's slug is refused without the
//      name, nothing sent (NEGATIVE CONTROL: the editor's qualified name is quoted, their slug answers).
//   4. NO KEEP, NO VERIFY: both refused to the viewer, nothing made or saved.
//   5. REOPEN, REFRESH: the viewer's kept table comes back with the conversation and Refresh runs it again, inside their
//      view (CONTROL: the table unticked, neither sends a figure).
//   6. CANARY: no reply or prompt the viewer got names a warehouse table, the schema or the connection (NEGATIVE
//      CONTROL: the editor's do).
//
//   npm run build:ts && [DATABASE_URL=… ORDINATE_EXPECT_PGVECTOR=1] node scripts/test-liveSqlViewers.js

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
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const verifiedQs: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const teamTables: typeof import('../src/server/authz/teamTables') = require('../src/server/authz/teamTables');
const lmsg: typeof import('../src/engine/liveSqlMessages') = require('../src/engine/liveSqlMessages');
const amsg: typeof import('../src/ai/answerSqlMessages') = require('../src/ai/answerSqlMessages');
const missing: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');

type Role = import('../src/server/context').Identity['user']['role'];
type Table = import('./liveSqlDiff').Table;
type Kit = import('./liveSqlDiff').Kit;
type Given = { schema: string; table?: string; include: boolean; hidden?: string[] };
const fake = fakeMod.fake;

/** The warehouse: one schema, three tables, one connection — names no reply to a viewer may hold. */
const SCHEMA = 'f6_wh_canary';
const ORDERS_T = 'f6_orders_canary';
const TARGETS_T = 'f6_targets_canary';
const PAY_T = 'f6_pay_canary';
const CONN_NAME = 'F6 warehouse canary';
const CANARY = /f6_wh_canary|f6_orders_canary|f6_targets_canary|f6_pay_canary|F6 warehouse canary/;
const HIDDEN = 'tier';
const Q = 'orders against targets';
/** The viewer's names are the labels' slugs (`orders`, `targets`: the corpus as written); the editor's the tables' own. */
const LABELS = ['Orders', 'Targets'];
const TABLES = [`${SCHEMA}.${ORDERS_T}`, `${SCHEMA}.${TARGETS_T}`];
const ED_ORDERS = `${SCHEMA}_${ORDERS_T}`;
const asEditor = (sql: string): string => sql.replace(/\borders\b/g, ED_ORDERS).replace(/\btargets\b/g, `${SCHEMA}_${TARGETS_T}`);
const GIVEN = (hidden: string[], pay = false): Given[] => [
  { schema: SCHEMA, table: ORDERS_T, include: true, ...(hidden.length ? { hidden } : {}) },
  { schema: SCHEMA, table: TARGETS_T, include: true },
  ...(pay ? [{ schema: SCHEMA, table: PAY_T, include: true }] : []),
];
const ORDERS_LAYOUT = fx.layout(fx.COLUMNS).map((c) => (c.name === 'bigid' ? { ...c, store: 'text' as const } : c));
const TARGETS_LAYOUT = corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const }));

// ── the two model calls, stubbed and spied; the source docs read ───────────
type Said = string | ((prompt: string) => string);
const calls = { ask: 0, facts: [] as string[], sql: [] as string[] };
let nextAction: unknown = { kind: 'none', intent: '' };
let nextSql: Said = '';
(execConfig as { executionReady: unknown }).executionReady = async () => true;
(execConfig as { assistantOn: unknown }).assistantOn = () => true;
(analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, facts: string) => {
  calls.ask++;
  calls.facts.push(facts);
  return { ok: true, text: 'These are the ones.', suggestedAction: nextAction };
};
(analyze as { dispatch: unknown }).dispatch = async (_system: string, messages: Array<{ text: string }>) => {
  const text = messages.map((m) => m.text).join('\n');
  calls.sql.push(text);
  return { rawText: typeof nextSql === 'function' ? nextSql(text) : nextSql };
};
const docReads: string[] = [];
const realDocs = store.readSourceDocs;
(store as { readSourceDocs: unknown }).readSourceDocs = (...a: Parameters<typeof realDocs>) => { docReads.push(...a[1].map((r) => r.docId)); return realDocs(...a); };

const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 400) ?? String(v);
const sqlAction = (names: string[]) => ({ kind: 'sql', intent: 'a question one chart cannot say', datasets: names });
const close = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(a), Math.abs(b));

/** Where a delivered card and F2's reference differ (types, then every cell, in order). P2: one leading U+FEFF dropped from Live's. */
function problems(card: any, ref: Table | { error: string }, approx: readonly number[] = []): string[] { // any: a delivered card
  if ('error' in ref) return [`the reference failed: ${ref.error}`];
  if (!card || card.kind !== 'sql') return [`no table: ${show(card)}`];
  const out: string[] = [];
  if (card.truncated !== ref.truncated || card.columns.length !== ref.columns.length || card.rows.length !== ref.rows.length) out.push(`shape ${card.columns.length}×${card.rows.length} vs ${ref.columns.length}×${ref.rows.length}`);
  ref.sqlTypes.forEach((t, i) => { if (card.columns[i]?.type !== sqlDatasets.columnKind(t) && ref.rows.some((r) => r[i] !== null)) out.push(`column ${i}: ${card.columns[i]?.type} vs ${t}`); });
  ref.rows.forEach((r, i) => r.forEach((v, j) => {
    let w = card.rows[i]?.[j];
    if (typeof w === 'string' && w.startsWith('﻿')) w = w.slice(1);
    if (!Object.is(v, w) && !(approx.includes(j) && close(v, w))) out.push(`row ${i} col ${j}: ${JSON.stringify(v)} vs ${JSON.stringify(w)}`);
  }));
  return out.slice(0, 6);
}

/** Where two delivered tables differ, every cell by Object.is: empty when they are the same table. */
function differs(a: any, b: any): string[] { // any: delivered cards
  if (a?.kind !== 'sql' || b?.kind !== 'sql') return [`no table: ${show(a)} | ${show(b)}`];
  if (JSON.stringify(a.columns) !== JSON.stringify(b.columns) || a.truncated !== b.truncated || a.rows.length !== b.rows.length) return [`shape: ${show(a.columns)} vs ${show(b.columns)}`];
  const at = a.rows.findIndex((r: unknown[], i: number) => r.some((v, j) => !Object.is(v, b.rows[i][j])));
  return at < 0 ? [] : [`row ${at}: ${show(a.rows[at])} vs ${show(b.rows[at])}`];
}

interface Bench {
  P: string;
  admin: string;
  editor: string;
  viewer: string;
  as<T>(who: string, fn: () => Promise<T>): Promise<T>;
  /** A channel's reply as `who`, and its HTTP status (200 off the route; always 200 calling the handler). */
  call(who: string, channel: string, payload: object): Promise<{ status: number; body: any }>; // any: each channel's own reply
  /** The viewer's team's rows on `connId`, replaced. */
  give(connId: string, rows: Given[]): Promise<void>;
}

interface Seeded { kit: Kit; conn: string; orders: string; targets: string; pay: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(b.admin, async () => {
    fakeMod.registerLiveFake();
    const kit = await diff.setupKit(ok); // the reference's own project: the extract twins
    if (!kit) throw new Error('no kit');
    await duck.execAsync(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    for (const [t, layout, rows] of [[ORDERS_T, ORDERS_LAYOUT, kit.rows.orders], [TARGETS_T, TARGETS_LAYOUT, kit.rows.targets], [PAY_T, TARGETS_LAYOUT, kit.rows.targets]] as const) {
      await fx.duckEngine.load(`${t}_load`, layout, rows);
      await duck.execAsync(`CREATE OR REPLACE TABLE ${SCHEMA}.${t} AS SELECT * FROM "${t}_load"`);
    }
    const conn = (await connections.saveConnection(b.P, { name: CONN_NAME, connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!.id;
    const doc = async (table: string, label: string, layout: readonly import('./liveParityFixture').StoredColumn[]) => {
      const made = await store.createSourceDoc(b.P, conn, `${SCHEMA}.${table}`, { label });
      if (!made.ok) throw new Error('fixture: a source doc');
      const columns = layout.map((c) => ({ name: c.name, type: fx.duckEngine.typeName(c.store) }));
      await store.updateSourceDoc(b.P, conn, made.docId, (d) => ({ ...d, facts: { columns, readAt: new Date().toISOString(), readBy: 'ed@acme.test' } }));
      return made.docId;
    };
    return { kit, conn, orders: await doc(ORDERS_T, 'Orders', ORDERS_LAYOUT), targets: await doc(TARGETS_T, 'Targets', TARGETS_LAYOUT), pay: await doc(PAY_T, 'Pay runs', TARGETS_LAYOUT) };
  });
}

async function legs(b: Bench, s: Seeded): Promise<void> {
  const V = b.viewer;
  const E = b.editor;
  const seen: string[] = []; // every reply and prompt the viewer got
  const edSeen: string[] = [];
  const keep = (who: string, ...texts: string[]) => (who === V ? seen : edSeen).push(...texts);
  const call = async (who: string, ch: string, payload: object) => {
    const r = await b.call(who, ch, payload);
    keep(who, JSON.stringify(r.body));
    return r;
  };
  const ask = async (who: string, names: string[], sql: Said, question = Q) => {
    nextAction = sqlAction(names);
    nextSql = sql;
    const [a0, s0, f0, d0] = [calls.ask, calls.sql.length, fake.calls.length, docReads.length];
    const thread = (await call(who, 'copilot:newThread', { projectId: b.P })).body.thread.id as string;
    const r = (await call(who, 'copilot:ask', { projectId: b.P, threadId: thread, context: { kind: '' }, question })).body;
    const facts = calls.ask > a0 ? calls.facts.at(-1)! : '';
    const prompt = calls.sql[s0] ?? '';
    keep(who, facts, prompt);
    return { r, thread, sqls: calls.sql.length - s0, sent: fake.calls.length - f0, payDocs: docReads.slice(d0).filter((id) => id === s.pay).length, facts, prompt, turn: r?.turns?.at(-1) };
  };
  const refusedWith = (a: Awaited<ReturnType<typeof ask>>, sentence: string): boolean =>
    a.r?.ok === true && !a.turn?.sql && !a.turn?.card && String(a.turn?.text).includes(sentence) && a.sent === 0;
  const ref = (sql: string) => b.as(b.admin, () => diff.reference(s.kit, sql, false));
  const fresh = async (): Promise<void> => { // SQL_PER_HOUR is not these checks'
    counters.resetMemoryForTest();
    await b.as(b.admin, () => counters.forgetForTest('acme', 'livesql:'));
  };
  const [pre, post] = lmsg.sqlUnknownColumn('\u0001').split('\u0001');
  await b.give(s.conn, GIVEN([HIDDEN]));

  // 1. The differential: the viewer by the labels, the editor by the warehouse names, the reference over the extract.
  let agree = 0;
  let hidden = 0;
  const naming = corpus.CASES.filter((c) => new RegExp(`\\b${HIDDEN}\\b`).test(c.sql));
  for (const [i, c] of corpus.CASES.entries()) {
    if (i % 12 === 0) await fresh();
    const v = await ask(V, LABELS, c.sql); // first: the viewer's is the warehouse's answer, never the editor's cache entry
    const e = await ask(E, TABLES, asEditor(c.sql));
    if (naming.includes(c)) {
      const t = String(v.turn?.text);
      if (!v.turn?.card && v.sqls === 1 && v.sent === 0 && t.includes(pre) && t.includes(post) && t.includes(HIDDEN) && e.turn?.card?.kind === 'sql') hidden++;
      else ok(`1. ${c.name} (names ${HIDDEN})`, false, `${show(v.turn)} | ${show(e.turn?.card)}`);
      continue;
    }
    const p = [...differs(v.turn?.card, e.turn?.card), ...problems(v.turn?.card, await ref(c.sql), c.approx)];
    if (!p.length) agree++;
    else ok(`1. ${c.name}`, false, `${p.join(' | ')}\n  ${c.sql}`);
  }
  const compared = corpus.CASES.length - naming.length;
  ok(`1. DIFFERENTIAL: the viewer's answer on the given tables is Object.is-equal to the editor's and to the reference (${agree}/${compared})`, agree === compared && compared >= 50);
  ok(`1. …each statement naming the hidden column is refused as a made-up name, nothing sent, where the editor's answers (${hidden}/${naming.length})`, hidden === naming.length && naming.length >= 3);
  await fresh();
  const first = await ask(V, LABELS, corpus.CASES[0].sql);
  ok('1. the turn keeps the table\'s doc and connection; the card names it by its label, dated live; Show SQL is the model\'s text',
    first.turn?.sql?.table === s.conn && first.turn.sql.datasetIds.join() === s.orders && first.turn.card?.sql === corpus.CASES[0].sql
    && first.turn.card.datasets.join() === 'Orders' && first.turn.card.asOf?.mode === 'live', show(first.turn));

  // 2. The view: the prompts, then what is printed.
  const line = /- Orders: ([^\n]*)/.exec(first.facts)?.[1] ?? '';
  ok('2. PROMPTS: the first call\'s SOURCE TABLES names the given tables by their labels, without the hidden column, no connection, no ungiven table',
    /\bqty \(number\)/.test(line) && !line.includes(HIDDEN) && first.facts.includes('- Targets: ') && !first.facts.includes('Pay runs') && !first.facts.includes(' (on "'), first.facts.slice(first.facts.indexOf('SOURCE TABLES'), first.facts.indexOf('SOURCE TABLES') + 400));
  ok('2. …the second call is told `orders`, the dataset "Orders", Live, its visible columns only', /- orders \(the dataset "Orders" · Live\)\n {4}many text, cat text, region text, amt number, qty number, d date, bigid text\n/.test(first.prompt)
    && !new RegExp(`\\b${HIDDEN}\\b`).test(first.prompt), first.prompt.slice(0, 500));
  const ed0 = await ask(E, TABLES, asEditor(corpus.CASES[0].sql));
  ok('2. NEGATIVE CONTROL: the editor\'s prompts hold the hidden column and the warehouse names', new RegExp(`\\b${HIDDEN} number\\b`).test(ed0.prompt) && ed0.prompt.includes(ED_ORDERS) && ed0.facts.includes(TABLES[0]), ed0.prompt.slice(0, 400));
  const star = await ask(V, LABELS, 'SELECT * FROM orders');
  const printed = fake.calls.at(-1)?.sql ?? '';
  const listed = await ask(E, TABLES, `SELECT many, cat, region, amt, qty, d, bigid FROM ${ED_ORDERS}`);
  ok('2. SELECT *: the viewer\'s statement prints a view without the hidden column, and their table is the editor\'s of the visible ones',
    star.sent === 1 && !new RegExp(`\\b${HIDDEN}\\b`).test(printed) && /\bbigid\b/.test(printed) && star.turn?.card?.columns.map((c: { name: string }) => c.name).join() === 'many,cat,region,amt,qty,d,bigid'
    && differs(star.turn?.card, listed.turn?.card).length === 0, `${printed.slice(0, 300)} ${show(star.turn?.card?.columns)}`);
  await b.give(s.conn, GIVEN([]));
  const open = await ask(V, LABELS, 'SELECT * FROM orders');
  ok('2. CONTROL: unhidden, the view prints it and the table returns it', open.sent === 1 && new RegExp(`\\b${HIDDEN}\\b`).test(fake.calls.at(-1)?.sql ?? '') && open.turn?.card?.columns.length === 8, show(open.turn?.card?.columns));
  await b.give(s.conn, GIVEN([HIDDEN]));

  // 3. Unknown names: an unticked table, a warehouse name, an editor's slug.
  await fresh();
  const unticked = await ask(V, ['Pay runs'], 'SELECT count(*) AS n FROM pay_runs', 'pay runs');
  ok('3. UNTICKED: the first call naming an unticked table is refused as no dataset, no doc of it read, no second call, nothing sent',
    refusedWith(unticked, amsg.sqlNoDataset('Pay runs')) && unticked.sqls === 0 && unticked.payDocs === 0, show({ text: unticked.turn?.text, docs: unticked.payDocs }));
  await b.give(s.conn, GIVEN([HIDDEN], true));
  const ticked = await ask(V, ['Pay runs'], 'SELECT count(*) AS n FROM pay_runs', 'pay runs');
  ok('3. CONTROL: ticked, the same question answers from it', ticked.turn?.card?.rows?.[0]?.[0] === corpus.TARGET_ROWS.length && ticked.turn.sql?.datasetIds.join() === s.pay, show(ticked.turn));
  await b.give(s.conn, GIVEN([HIDDEN]));
  for (const [what, name] of [['the unticked table\'s label', 'pay_runs'], ['a warehouse name', ORDERS_T], ['a qualified warehouse name', `${SCHEMA}.${ORDERS_T}`], ['an editor\'s slug', ED_ORDERS]]) {
    const a = await ask(V, LABELS, `SELECT count(*) AS n FROM ${name}`);
    ok(`3. a statement naming ${what}: refused as an unknown name, the name never echoed, nothing sent`, refusedWith(a, lmsg.sqlUnknownName()) && a.sqls === 1 && !String(a.turn?.text).includes(name), show(a.turn?.text));
  }
  const edQualified = await ask(E, TABLES, `SELECT count(*) AS n FROM ${SCHEMA}.${ORDERS_T}`);
  const edSlug = await ask(E, TABLES, `SELECT count(*) AS n FROM ${ED_ORDERS}`);
  ok('3. NEGATIVE CONTROL: the editor\'s qualified name is quoted back, and their slug answers', refusedWith(edQualified, lmsg.sqlQualified(`${SCHEMA}.${ORDERS_T}`)) && edSlug.turn?.card?.rows?.[0]?.[0] === s.kit.rows.orders.length,
    show({ q: edQualified.turn?.text, slug: edSlug.turn?.card?.rows }));

  // 4. No Keep, no Verify.
  const count = async () => [(await b.as(b.admin, () => datasets.listDatasets(b.P))).length, (await b.as(b.admin, () => verifiedQs.listBoth(b.P))).sql.length];
  const [d0, q0] = await count();
  const kept = await call(V, 'answer:keepTable', { projectId: b.P, threadId: first.thread, turnId: first.turn.id });
  const verified = await call(V, 'verified:save', { projectId: b.P, input: { question: 'f6 orders per region', sql: corpus.CASES[0].sql } });
  const [d1, q1] = await count();
  // Off the route (no database) the handler's own refusal: no catalog read, never a dataset named by the warehouse.
  ok('4. KEEP and VERIFY are refused to the viewer: no dataset made, no question saved', (kept.status === 403 || kept.body?.reason === missing.liveDatasetMissing()) && (verified.status === 403 || verified.body?.ok === false) && d1 === d0 && q1 === q0,
    show({ kept, verified, made: d1 - d0, saved: q1 - q0 }));

  // 5. Reopen and Refresh, inside the viewer's view.
  const REOPEN = 'SELECT region, count(*) AS n FROM orders GROUP BY region ORDER BY region';
  const asked = await ask(V, LABELS, REOPEN);
  const history = async () => (await call(V, 'copilot:history', { projectId: b.P, threadId: asked.thread })).body?.turns?.find((t: { id: string }) => t.id === asked.turn?.id);
  const refresh = async () => (await call(V, 'answer:refresh', { projectId: b.P, threadId: asked.thread, turnId: asked.turn?.id })).body;
  const back = await history();
  const again = await refresh();
  ok('5. REOPEN: the viewer\'s kept table comes back with the conversation; Refresh runs it again, the same table', differs(back?.card, asked.turn?.card).length === 0 && differs(again, asked.turn?.card).length === 0,
    show({ back: back?.card, again }));
  await b.give(s.conn, GIVEN([HIDDEN]).filter((g) => g.table !== ORDERS_T));
  const gone = await history();
  const refused = await refresh();
  ok('5. CONTROL: the table unticked, reopening brings no table and Refresh refuses, no figure sent', gone && !gone.card && refused?.ok === false && !refused.rows, show({ gone, refused }));
  await b.give(s.conn, GIVEN([HIDDEN]));

  // 6. The canary.
  const leaks = seen.filter((t) => CANARY.test(t)).map((t) => t.slice(0, 200));
  ok(`6. CANARY: none of the viewer's ${seen.length} replies and prompts names a warehouse table, the schema or the connection`, seen.length > 200 && leaks.length === 0, leaks.join('\n'));
  ok('6. NEGATIVE CONTROL: the editor\'s name them', edSeen.some((t) => t.includes(TABLES[0])) && edSeen.some((t) => t.includes(CONN_NAME)) && edSeen.some((t) => t.includes(ED_ORDERS)));
}

let req = 0;
async function fileLeg(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesqlviewers-'));
  try {
    context.enterServerMode(DATA);
    poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
    appMod.registerHandlers();
    const ROLE: Record<string, Role> = { ana: 'admin', vic: 'viewer' };
    const as = <T>(who: string, fn: () => Promise<T>): Promise<T> =>
      context.runInContext({ user: { email: `${who}@acme.test`, role: ROLE[who] }, org: { id: 'acme' } }, `q${++req}`, fn);
    const P = await as('ana', async () => {
      await projects.init();
      return (await projects.createProject('Live SQL for viewers')).id;
    });
    // Teams need Postgres: the one read of the viewer's teams' rows is stubbed; the rule that folds them is the real one.
    let rows: import('../src/server/authz/teamTables').TeamTableRow[] = [];
    (teamTables as { givenOn: unknown }).givenOn = async () => teamTables.givenFrom(rows);
    const b: Bench = {
      P, admin: 'ana', editor: 'ana', viewer: 'vic', as,
      call: async (who, ch, payload) => ({ status: 200, body: await as(who, () => handlers.get(ch)!({}, payload)) }),
      give: async (connId, given) => { rows = given.map((g) => ({ teamId: 'f6', connId, schema: g.schema, table: g.table ?? null, include: g.include, hidden: g.hidden ?? [] })); },
    };
    await legs(b, await seed(b));
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function dbLeg(): Promise<void> {
  handlers.clear(); // the world registers every handler itself
  const W = await RP.world('the Postgres leg of SQL answers for viewers');
  if (!W) return;
  try {
    const P: string = (await W.call('boss', 'projects:create', { name: 'Live SQL for viewers' })).body.id;
    for (const [member, role] of [[{ userId: W.uid.ed }, 'editor'], [{ teamId: W.team }, 'viewer']] as const) {
      const r = await W.call('boss', 'project:share', { projectId: P, member, role });
      if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
    }
    const b: Bench = {
      P, admin: 'boss', editor: 'ed', viewer: 'east', as: (who, fn) => W.as(who, fn), call: (who, ch, payload) => W.call(who, ch, payload),
      give: async (connId, rows) => {
        const r = await W.call('boss', 'teamTables:set', { projectId: P, teamId: W.team, connId, rows });
        if (r.body?.ok !== true) throw new Error(`teamTables:set failed: ${r.text}`);
      },
    };
    await legs(b, await seed(b));
  } finally {
    await W.close();
  }
}

(async () => {
  if (!process.env.DATABASE_URL) await fileLeg();
  else await dbLeg();
})()
  .catch((e) => ok('the SQL answers for viewers suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
