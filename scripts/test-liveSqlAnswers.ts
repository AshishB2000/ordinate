// SQL answers on Live datasets, F3 (docs/live-data/01-live-sql.md, "The PR plan"): the lane (src/ipc/answerSql.ts) routes
// a statement over Live datasets to the executor (src/engine/live/liveSql.ts), which translates it, prints it under each
// table's lock without the caller's hidden columns, and asks the warehouse through the one door. Through the real
// handlers; both model calls stubbed and spied (as test-answerSql).
//
// File leg (JSON records, the fake warehouse scripts/liveFakeConnector.ts):
//   1. DIFFERENTIAL: the channel's table (copilot:ask) is Object.is-equal, cell for cell, to F2's reference
//      (scripts/liveSqlDiff.ts `reference`: DuckDB running the model's own text over the extract twin) — every corpus
//      statement for an admin; a set for an editor and for a viewer from whom a column is hidden.
//   2. COUNTS: one counted statement per answer (the fake's calls = the live_usage count); a cache hit none; an editor
//      and a viewer asking what an admin asked share the entry (no lock: the same statement).
//   3. COST: a dry run over the byte ceiling sends nothing (CONTROL: under it, it runs); the daily limit refuses
//      (CONTROL: lifted, it runs); the 31st answer in an hour is refused before the model writes (CONTROL: another
//      member's is not).
//   4. REFUSALS, each with a passing twin and nothing sent: two connections, a Live and a copied dataset, WITH RECURSIVE,
//      a qualified name, a hidden column (the column gate's own sentence), a statement DuckDB's binder refuses.
//   5. SNAPSHOTS: reopening runs nothing and brings the table back; Refresh is one counted statement past the cache.
//   6. CANARY (R-L6, R-L17): the warehouse's table names, a defining query and the connection's secret are in no reply
//      and no prompt; the secret in no log line, though a warehouse error carried it.
//   9. PRECISE COLUMN GATE: a column hidden from a viewer and named `sum` no longer refuses `sum()` (NEGATIVE CONTROL: F3's
//      words-as-question check refuses it); every real reference — bare, qualified, aliased, quoted, through `*`, in
//      WHERE or an aggregate — is still the column gate's sentence with nothing sent.
//  10. A REQUIRED DATE FILTER (a partition BigQuery requires a filter on, from the table's doc): as a chart's, a statement
//      that filters no `d` gets Last 12 months in the view, bound, with the chart's sentence, ≡ the reference with it by
//      hand; the second call is told. NEGATIVE CONTROLS: one filtering `d` itself, and a table with no such fact, as before.
//      Only a WHERE restricting THAT table's `d` by bound values counts: `d` only in a correlation (`t2.d = o.d`), in an
//      OR with an unrestricted branch, or under NOT gets the range (NEGATIVE CONTROLS: a real `o.d >= '2025-01-01'`
//      beside the same correlation, and an OR whose every branch restricts `d`, do not).
// Database leg (DATABASE_URL: scripts/rowPolicyHarness.ts, real grants over the real RPC route):
//   7. A LOCKED viewer's table is Object.is-equal to the reference locked to East; another viewer's lock (West) is a
//      second statement, equal to the reference locked to West; the first asked again is a cache hit; the editor's is
//      the whole table. Nothing of West reaches East.
//   8. POSTGRES as Redshift (the leg F2 uses): the corpus through the channel on the real `amazon-redshift` connector,
//      each table Object.is-equal to the reference; no reply carries the host, the database or the password.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-liveSqlAnswers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';
import { captureLogs } from './logCapture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesqlanswers-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const rowPolicy: typeof import('../src/data/rowPolicyError') = require('../src/data/rowPolicyError');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const usage: typeof import('../src/server/live/usageStore') = require('../src/server/live/usageStore');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const liveSql: typeof import('../src/engine/live/liveSql') = require('../src/engine/live/liveSql');
const lmsg: typeof import('../src/engine/liveSqlMessages') = require('../src/engine/liveSqlMessages');
const qmsg: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');
const bq: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
const tree: typeof import('../src/engine/live/sql/tree') = require('../src/engine/live/sql/tree');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
const rowDoors: typeof import('../src/ipc/rowDoors') = require('../src/ipc/rowDoors');
const lexer: typeof import('../src/engine/sqlLex') = require('../src/engine/sqlLex');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const dateRange: typeof import('../src/engine/live/liveDateRange') = require('../src/engine/live/liveDateRange');

type Role = import('../src/server/context').Identity['user']['role'];
type Table = import('./liveSqlDiff').Table;
const fake = fakeMod.fake;

// ── the two model calls, stubbed and spied ─────────────────────────────────
const calls = { ask: 0, sql: [] as Array<{ system: string; text: string }> };
let nextAction: unknown = { kind: 'none', intent: '' };
let nextSql = '';
(execConfig as { executionReady: unknown }).executionReady = async () => true;
(execConfig as { assistantOn: unknown }).assistantOn = () => true;
(analyze as { askCopilot: unknown }).askCopilot = async () => { calls.ask++; return { ok: true, text: 'These are the ones.', suggestedAction: nextAction }; };
(analyze as { dispatch: unknown }).dispatch = async (system: string, messages: Array<{ text: string }>) => {
  calls.sql.push({ system, text: messages.map((m) => m.text).join('\n') });
  return { rawText: nextSql };
};
// The secrets store over a Map, as liveQueryHarness keeps it: per (org, kind, ref).
const vault = new Map<string, string>();
configSecrets.useSecretStore({
  get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
  put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
  delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
});

const SECRET = 'pw-canary-livesql-3e81';
const TABLE_CANARY = 'canary_tbl_51d0';
const DEFQ_CANARY = 'CANARY_DEFQ_4b1e';
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 400) ?? String(v);
const sqlAction = (names: string[]) => ({ kind: 'sql', intent: 'a question one chart cannot say', datasets: names });
const close = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(a), Math.abs(b));

/** Where the channel's card and F2's reference differ: empty when they agree (types, then every cell, in order). P2: one leading U+FEFF dropped from Live's. */
function problems(card: any, ref: Table | { error: string }, approx: readonly number[] = []): string[] { // any: a delivered card
  if ('error' in ref) return [`the reference failed: ${ref.error}`];
  if (!card || card.kind !== 'sql') return [`no table: ${show(card)}`];
  const out: string[] = [];
  if (card.truncated !== ref.truncated) out.push(`truncated ${card.truncated} vs ${ref.truncated}`);
  if (card.columns.length !== ref.columns.length) out.push(`width ${card.columns.length} vs ${ref.columns.length}`);
  // A column of only NULLs (`NULL AS z`) has no kind to compare: DuckDB calls it INTEGER, the IR text.
  ref.sqlTypes.forEach((t, i) => { if (card.columns[i]?.type !== sqlDatasets.columnKind(t) && ref.rows.some((r) => r[i] !== null)) out.push(`column ${i}: ${card.columns[i]?.type} vs ${t}`); });
  if (card.rows.length !== ref.rows.length) out.push(`rows ${card.rows.length} vs ${ref.rows.length}`);
  ref.rows.forEach((r, i) => r.forEach((v, j) => {
    let w = card.rows[i]?.[j];
    if (typeof w === 'string' && w.startsWith('﻿')) w = w.slice(1);
    if (!Object.is(v, w) && !(approx.includes(j) && close(v, w))) out.push(`row ${i} col ${j}: ${JSON.stringify(v)} vs ${JSON.stringify(w)}`);
  }));
  return out.slice(0, 6);
}

/** The Live datasets of one project over one connection: `orders` (a table) and `targets` (a defining query), as `diff`'s reference names them. */
async function liveTables(P: string, prefix: string, connectorId: string, values: Record<string, unknown>, secrets: Record<string, string>, src: { orders: string; targets: string }) {
  const conn = await connections.saveConnection(P, { name: 'Warehouse', connectorId, values });
  if (!conn) throw new Error('connection not saved');
  await secretsIpc.storeSecrets(conn.id, secrets);
  const orders = await liveRecord.saveLiveRecord(P, { name: `${prefix}orders`, columns: fx.COLUMNS, origin: { kind: 'connection', connId: conn.id, table: src.orders } });
  const targets = await liveRecord.saveLiveRecord(P, {
    name: `${prefix}targets`, columns: corpus.TARGET_COLUMNS, origin: { kind: 'connection', connId: conn.id, sql: `SELECT * FROM ${src.targets} WHERE '${DEFQ_CANARY}' <> ''` },
  });
  if (!orders || !targets) throw new Error('live datasets not saved');
  return { conn: conn.id, orders: orders.id, targets: targets.id };
}

let req = 0;
const as = <T>(who: string, role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${who}@acme.test`, role }, org: { id: 'acme' } }, `q${++req}`, fn);

async function fileLeg(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
  appMod.registerHandlers();
  fakeMod.registerLiveFake();
  const ADMIN = 'ana', EDITOR = 'eve', VIEWER = 'vic', OTHER = 'oli';
  const ROLE: Record<string, Role> = { [ADMIN]: 'admin', [EDITOR]: 'editor', [VIEWER]: 'viewer', [OTHER]: 'viewer' };
  const replies: string[] = [];
  const call = async (who: string, ch: string, payload: object): Promise<any> => { // any: each handler's reply
    const r = await as(who, ROLE[who], () => handlers.get(ch)!({}, payload));
    replies.push(JSON.stringify(r));
    return r;
  };
  const W = await as(ADMIN, 'admin', async () => {
    const kit = await diff.setupKit(ok); // the reference's project: the extract twins
    if (!kit) throw new Error('no kit');
    await fx.duckEngine.load(`${TABLE_CANARY}_orders`, fx.layout(fx.COLUMNS), kit.rows.orders);
    await fx.duckEngine.load(`${TABLE_CANARY}_targets`, corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const })), kit.rows.targets);
    const P = (await projects.createProject('Live SQL answers')).id;
    const main = await liveTables(P, '', fakeMod.LIVE_FAKE_ID, {}, { password: SECRET }, { orders: `${TABLE_CANARY}_orders`, targets: `${TABLE_CANARY}_targets` });
    const other = await liveTables(P, 'other_', fakeMod.LIVE_FAKE_ID, {}, { password: SECRET }, { orders: `${TABLE_CANARY}_orders`, targets: `${TABLE_CANARY}_targets` });
    const priced = await liveTables(P, 'priced_', fakeMod.LIVE_FAKE_PRICED_ID, {}, { password: SECRET }, { orders: `${TABLE_CANARY}_orders`, targets: `${TABLE_CANARY}_targets` });
    const copied = (await datasets.saveDataset(P, { name: 'copied', sourceKind: 'csv', ...fx.importTyped(fx.COLUMNS, kit.rows.orders) }))!.id;
    // A column hidden from the viewer (and from OTHER): `amt` of orders, visible only to a team neither is in.
    await rec.serialized(rec.datasetFilePath(P, main.orders), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'amt', visibleTo: [{ teamId: '99999999-9999-4999-8999-999999999999' }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    return { kit, P, main, other, priced, copied };
  });
  const { kit, P } = W;
  const thread = async (who: string): Promise<string> => (await call(who, 'copilot:newThread', { projectId: P })).thread.id;
  const ask = async (who: string, sql: string, tables: string[] = ['orders', 'targets'], threadId?: string) => {
    nextAction = sqlAction(tables);
    nextSql = sql;
    const [a0, s0, f0] = [calls.ask, calls.sql.length, fake.calls.length];
    const r = await call(who, 'copilot:ask', { projectId: P, threadId: threadId ?? (await thread(who)), context: {}, question: 'which ones?' });
    return { r, asks: calls.ask - a0, sqls: calls.sql.length - s0, sent: fake.calls.length - f0, prompt: calls.sql[s0]?.text ?? '', turn: r.turns?.at(-1) };
  };
  const refusedWith = (a: Awaited<ReturnType<typeof ask>>, sentence: string): boolean =>
    a.r.ok && !a.turn?.sql && !a.turn?.card && String(a.turn?.text).includes(sentence) && a.sent === 0;
  const fresh = (): void => counters.resetMemoryForTest();
  fresh();

  // 1. The differential, through the channel.
  let agree = 0;
  for (const [i, c] of corpus.CASES.entries()) {
    if (i % 25 === 0) fresh(); // SQL_PER_HOUR is §3's; here every statement is asked
    const a = await ask(ADMIN, c.sql);
    const p = problems(a.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, c.sql, false)), c.approx);
    if (!p.length) agree++;
    else ok(`1. admin: ${c.name}`, false, `${p.join(' | ')} ${show(a.turn)}\n  ${c.sql}`);
  }
  ok(`1. DIFFERENTIAL: the channel's table is Object.is-equal to the reference for an admin, every corpus statement (${agree}/${corpus.CASES.length})`, agree === corpus.CASES.length);
  const first = await ask(ADMIN, corpus.CASES[0].sql);
  ok('1. the turn: the model\'s text, the datasets the translator resolved, the card dated live, Not checked', first.turn?.sql?.text === corpus.CASES[0].sql
    && first.turn.sql.datasetIds.join() === W.main.orders && first.turn.card?.asOf?.mode === 'live' && !first.turn.card.verified && first.turn.card.sql === corpus.CASES[0].sql, show(first.turn));
  ok('1. the second call is told the Live tables (no size), their visible columns as DATE/number/text, and the Live rules', /- orders \(the dataset "orders" · Live\)\n {4}many text, cat text, region text, amt number, qty number, tier number, d date, bigid text/.test(first.prompt)
    && first.prompt.includes('NOTE: A table marked Live'), first.prompt.slice(0, 500));
  const NO_AMT = corpus.CASES.filter((c) => !/\bamt\b/.test(c.sql) && !/\*/.test(c.sql));
  for (const [who, label] of [[EDITOR, 'an editor'], [VIEWER, 'a viewer from whom amt is hidden']] as const) {
    fresh();
    const set = NO_AMT.slice(0, 12);
    let same = 0;
    for (const c of set) {
      const a = await ask(who, c.sql);
      const p = problems(a.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, c.sql, false)), c.approx);
      if (!p.length) same++;
      else ok(`1. ${label}: ${c.name}`, false, `${p.join(' | ')}\n  ${c.sql}`);
    }
    ok(`1. DIFFERENTIAL: ${label}: Object.is-equal to the reference (${same}/${set.length})`, same === set.length && set.length === 12);
  }
  const vStar = await ask(VIEWER, 'SELECT * FROM orders ORDER BY many, cat, region, qty, tier, d, bigid LIMIT 5');
  ok('1. the viewer\'s second call never names amt; their SELECT * is the visible columns only', !/\bamt\b/.test(vStar.prompt) && vStar.turn?.card?.columns?.map((c: { name: string }) => c.name).join() === 'many,cat,region,qty,tier,d,bigid', `${vStar.prompt.slice(0, 300)} ${show(vStar.turn?.card?.columns)}`);

  // 2. Counts: one statement per answer, a cache hit none.
  fresh();
  const row = async (conn: string) => (await as(ADMIN, 'admin', () => usage.readUsage(null, usage.utcDay()))).find((r) => r.connectionId === conn)?.queries ?? 0;
  const COUNT_SQL = 'SELECT region, count(*) AS n FROM orders WHERE qty > 3 GROUP BY region ORDER BY region';
  const [u0, f0] = [await row(W.main.conn), fake.calls.length];
  const c1 = await ask(ADMIN, COUNT_SQL);
  const [u1, f1] = [await row(W.main.conn), fake.calls.length];
  ok('2. one counted statement per answer: the warehouse saw one, the daily count took one', c1.sent === 1 && f1 - f0 === 1 && u1 - u0 === 1, `${f1 - f0} ${u1 - u0}`);
  const c2 = await ask(ADMIN, COUNT_SQL);
  const c3 = await ask(EDITOR, COUNT_SQL);
  const c4 = await ask(VIEWER, COUNT_SQL);
  ok('2. a cache hit sends none and counts none: the admin again, an editor, and the viewer (nothing restricts the columns it reads)',
    [c2, c3, c4].every((a) => a.sent === 0 && a.turn?.card?.asOf?.cached === true) && (await row(W.main.conn)) === u1, show([c2.sent, c3.sent, c4.sent, c4.turn?.card?.asOf]));
  ok('2. …and each is the same table', problems(c4.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, COUNT_SQL, false))).length === 0);

  // 3. Cost: the dry run, the daily limit, SQL_PER_HOUR.
  fake.bytes = 20 * 1024 ** 3;
  const e0 = fake.estimates.length;
  const PRICED = 'SELECT region, count(*) AS n FROM priced_orders GROUP BY region ORDER BY region';
  const dear = await ask(ADMIN, PRICED, ['priced_orders']);
  ok('3. a dry run over the byte ceiling sends NOTHING, in a sentence with both sizes', refusedWith(dear, lmsg.sqlTooCostly(bq.estimateLabel(fake.bytes).slice(1), bq.estimateLabel(10 * 1024 ** 3).slice(1))) && fake.estimates.length - e0 === 1, show(dear.turn?.text));
  fake.bytes = 1024 ** 2;
  const cheap = await ask(ADMIN, PRICED, ['priced_orders']);
  ok('3. CONTROL: under it, it runs: priced, then one statement', cheap.sent === 1 && cheap.turn?.card?.rowCount > 0 && fake.estimates.length - e0 === 2, show(cheap.turn?.card?.caption));
  budget.setDailyCheckForTest(() => ({ ok: false, message: qmsg.liveDailyLimit('10,000') }));
  const daily = await ask(ADMIN, 'SELECT region, max(qty) AS top FROM orders GROUP BY region ORDER BY region');
  budget.setDailyCheckForTest(null);
  ok('3. the daily limit refuses it, in its own sentence, nothing sent', refusedWith(daily, qmsg.liveDailyLimit('10,000')), show(daily.turn?.text));
  ok('3. CONTROL: lifted, the same statement runs', (await ask(ADMIN, 'SELECT region, max(qty) AS top FROM orders GROUP BY region ORDER BY region')).sent === 1);
  fresh();
  let hourly = 0;
  for (let i = 0; i < liveSql.SQL_PER_HOUR; i++) if ((await ask(OTHER, COUNT_SQL)).turn?.card) hourly++;
  const over = await ask(OTHER, COUNT_SQL);
  ok(`3. SQL_PER_HOUR: ${liveSql.SQL_PER_HOUR} answers in an hour, then the next is refused BEFORE the model writes SQL`, hourly === liveSql.SQL_PER_HOUR && over.r.ok && !over.turn?.card
    && over.sqls === 0 && ['59', '60'].some((m) => String(over.turn?.text).includes(lmsg.sqlPerHour('30', m))), `${hourly} ${over.sqls} ${show(over.turn?.text)}`);
  ok('3. CONTROL: another member\'s answer is not refused', !!(await ask(VIEWER, COUNT_SQL)).turn?.card);
  fresh();

  // 4. Refusals, each with a passing twin.
  const two = await ask(ADMIN, 'SELECT region FROM orders', ['orders', 'other_orders']);
  ok('4. two connections: refused before any SQL is written', refusedWith(two, lmsg.sqlTwoConnections()) && two.sqls === 0, show(two.turn?.text));
  ok('4. TWIN: two tables on one connection answer', !!(await ask(ADMIN, 'SELECT o.region, count(*) AS n FROM orders o JOIN targets t ON o.region = t.region GROUP BY o.region ORDER BY o.region')).turn?.card);
  const mixed = await ask(ADMIN, 'SELECT region FROM orders', ['orders', 'copied']);
  ok('4. a Live and a copied dataset: refused before any SQL is written', refusedWith(mixed, lmsg.sqlMixedEngines()) && mixed.sqls === 0, show(mixed.turn?.text));
  const copy = await ask(ADMIN, 'SELECT region, count(*) AS n FROM copied GROUP BY region ORDER BY region', ['copied']);
  ok('4. TWIN: the copy alone answers through the extract lane (no asOf: our Parquet)', !!copy.turn?.card && !copy.turn.card.asOf && copy.sent === 0, show(copy.turn));
  const RECURSIVE = 'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 AS n FROM r WHERE n < 3) SELECT count(*) AS n FROM r';
  const recur = await ask(ADMIN, RECURSIVE);
  ok('4. WITH RECURSIVE: refused, nothing sent', refusedWith(recur, lmsg.sqlConstruct('WITH RECURSIVE')), show(recur.turn?.text));
  ok('4. TWIN: a plain WITH answers', !!(await ask(ADMIN, 'WITH r AS (SELECT region FROM orders) SELECT count(*) AS n FROM r')).turn?.card);
  const qualified = await ask(ADMIN, 'SELECT region FROM analytics.orders');
  ok('4. a qualified name: refused, nothing sent', refusedWith(qualified, lmsg.sqlQualified('analytics.orders')), show(qualified.turn?.text));
  ok('4. TWIN: the bare name answers', !!(await ask(ADMIN, 'SELECT DISTINCT region FROM orders ORDER BY region')).turn?.card);
  const HIDDEN = 'SELECT region, sum(amt) AS total FROM orders GROUP BY region ORDER BY region';
  const hid = await ask(VIEWER, HIDDEN);
  ok('4. a hidden column: the column gate\'s own sentence, before anything is parsed, nothing sent', refusedWith(hid, rowPolicy.rowPolicyRefusal('hidden').error), show(hid.turn?.text));
  const hidAdmin = await ask(ADMIN, HIDDEN);
  ok('4. TWIN: the admin, who sees amt, gets it, equal to the reference', problems(hidAdmin.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, HIDDEN, false))).length === 0, show(hidAdmin.turn));
  const UNBOUND = 'SELECT region, qty FROM orders GROUP BY region';
  const unbound = await ask(ADMIN, UNBOUND);
  ok('4. a statement DuckDB\'s binder refuses (a column neither grouped nor aggregated): refused, nothing sent', refusedWith(unbound, lmsg.sqlBindError('')) && /qty/.test(String(unbound.turn?.text)), show(unbound.turn?.text));
  const alone = await as(ADMIN, 'admin', async () => tree.translate(await tree.parseSql(UNBOUND), { tables: new Map([['orders', { id: W.main.orders, columns: fx.COLUMNS }]]), today: '2026-01-01' }));
  ok('4. NEGATIVE CONTROL: the translator alone takes it — the binder is the guard that refused it', alone.ok === true);
  ok('4. TWIN: aggregated, it runs', (await ask(ADMIN, 'SELECT region, sum(qty) AS q FROM orders GROUP BY region ORDER BY region')).sent === 1);

  // 5. Snapshots.
  const TS = await thread(VIEWER);
  const SNAP = 'SELECT cat, count(*) AS n FROM orders GROUP BY cat ORDER BY cat';
  const s1 = await ask(VIEWER, SNAP, ['orders', 'targets'], TS);
  const sf0 = fake.calls.length;
  const h = await call(VIEWER, 'copilot:history', { projectId: P, threadId: TS });
  ok('5. reopening sends nothing and brings the kept table back, Object.is-equal', fake.calls.length === sf0 && problems(h.turns?.at(-1)?.card, await as(ADMIN, 'admin', () => diff.reference(kit, SNAP, false))).length === 0
    && h.turns.at(-1).card.snapshot?.asOf === s1.turn.card.asOf.at, show(h.turns?.at(-1)?.card?.snapshot));
  await as(ADMIN, 'admin', () => liveDataset.setMaxCacheAge(P, W.main.orders, 0));
  const ru0 = await row(W.main.conn);
  const refreshed = await call(VIEWER, 'answer:refresh', { projectId: P, threadId: TS, turnId: s1.turn.id });
  ok('5. Refresh past the cache: ONE counted statement, kept as of the warehouse\'s answer', refreshed.ok && fake.calls.length - sf0 === 1 && (await row(W.main.conn)) - ru0 === 1
    && refreshed.snapshot?.asOf === refreshed.asOf?.at && refreshed.asOf?.mode === 'live' && !refreshed.asOf.cached, show(refreshed.snapshot));
  await as(ADMIN, 'admin', () => liveDataset.setMaxCacheAge(P, W.main.orders, 300));

  // 6. The canary: a warehouse error carrying the secret, the statement and the table.
  fake.hook = async (c, cx) => ({ ok: false, error: `SQL compilation error (password=${String(cx.secrets.password)}) in ${c.sql}` });
  const cap = captureLogs();
  let boom: Awaited<ReturnType<typeof ask>>;
  try {
    boom = await ask(ADMIN, 'SELECT region, min(qty) AS low FROM orders WHERE tier > 1 GROUP BY region ORDER BY region');
  } finally {
    cap.restore();
    fake.hook = null;
  }
  const logs = cap.at('warn').join('\n');
  ok('6. a warehouse failure is the executor\'s sentence, typed, no table', boom.r.ok && !boom.turn?.card && String(boom.turn?.text).includes(qmsg.liveWarehouseFailed()), show(boom.turn?.text));
  ok('6. R-L6: the planted error reached the log (the canary is live), its secret redacted', logs.includes(TABLE_CANARY) && logs.includes('***') && !logs.includes(SECRET), logs.slice(0, 400));
  ok('6. R-L17: the canary is live: the warehouse was sent the table names and the defining query', fake.calls.some((c) => c.sql.includes(TABLE_CANARY)) && fake.calls.some((c) => c.sql.includes(DEFQ_CANARY)));
  const leaked = replies.concat(calls.sql.map((c) => c.text)).filter((t) => t.includes(TABLE_CANARY) || t.includes(DEFQ_CANARY) || t.includes(SECRET) || /lv_src|\bv0 AS\b/.test(t));
  ok(`6. R-L17: no reply (${replies.length}) and no prompt (${calls.sql.length}) carries a warehouse table, the defining query, the printed SQL or the secret`, leaked.length === 0, leaked[0]?.slice(0, 300));

  // 9. The column gate reads the columns the translator resolves, never words: `sum` is a column hidden from the viewer.
  const fn = await as(ADMIN, 'admin', async () => {
    const d = await liveRecord.saveLiveRecord(P, { name: 'fn_orders', columns: [...fx.COLUMNS, { name: 'sum', type: 'number' }], origin: { kind: 'connection', connId: W.main.conn, sql: `SELECT *, qty AS "sum" FROM ${TABLE_CANARY}_orders` } });
    await rec.serialized(rec.datasetFilePath(P, d!.id), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'sum', visibleTo: [{ teamId: '99999999-9999-4999-8999-999999999999' }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    return d!.id;
  });
  fresh();
  const FN = 'SELECT region, sum(qty) AS total FROM fn_orders GROUP BY region ORDER BY region';
  const fnAsk = await ask(VIEWER, FN, ['fn_orders']);
  ok('9. a hidden column named `sum` no longer refuses sum(): the viewer\'s table is the reference\'s', fnAsk.sent === 1 && problems(fnAsk.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, FN.replace('fn_orders', 'orders'), false))).length === 0, show(fnAsk.turn));
  const words = lexer.lexSql(FN).flatMap((t) => (t.kind === 'word' || t.kind === 'qid' ? [t.text] : []));
  const byWords = await as(VIEWER, 'viewer', () => rowDoors.withLockOf(P, fn, async () => 'ran', words).catch((e: unknown) => (rowPolicy.isRowPolicyError(e) ? e.reason : 'threw')));
  ok('9. NEGATIVE CONTROL: F3\'s check, the statement\'s words as the gate\'s question, refuses that statement (hidden)', byWords === 'hidden', String(byWords));
  const REFS = ['SELECT region, sum FROM fn_orders', 'SELECT f.sum AS s FROM fn_orders f', 'SELECT "SUM" FROM fn_orders', 'SELECT s.sum FROM (SELECT * FROM fn_orders) s',
    'WITH w AS (SELECT * FROM fn_orders) SELECT max(w.sum) AS m FROM w', 'SELECT region FROM fn_orders WHERE sum > 2', 'SELECT region, sum(sum) AS x FROM fn_orders GROUP BY region'];
  const refs = [];
  for (const q of REFS) refs.push({ q, a: await ask(VIEWER, q, ['fn_orders']) });
  const leaky = refs.filter((r) => !refusedWith(r.a, rowPolicy.rowPolicyRefusal('hidden').error));
  ok(`9. every real reference to it — bare, qualified, aliased, quoted in another case, through a * in a subquery or a CTE, in WHERE, in an aggregate — is the gate's sentence, nothing sent (${REFS.length - leaky.length}/${REFS.length})`, leaky.length === 0, leaky.map((r) => `${r.q}: ${show(r.a.turn?.text)}`).join(' | '));
  const adminRef = await ask(ADMIN, 'SELECT f.sum AS s FROM fn_orders f ORDER BY s LIMIT 3', ['fn_orders']);
  ok('9. TWIN: the admin, who sees `sum`, reads it', !!adminRef.turn?.card && adminRef.turn.card.rowCount === 3, show(adminRef.turn));

  // 10. A required date filter, as a chart takes it: `d` of the table `dated` reads is a partition column BigQuery requires a filter on.
  const pinned = process.env.ORDINATE_TODAY;
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates: Last 12 months is [2024-03-01, 2025-02-28]
  try {
    const dated = await as(ADMIN, 'admin', async () => {
      await fx.duckEngine.load(`${TABLE_CANARY}_dated`, fx.layout(fx.COLUMNS), kit.rows.orders);
      const made = await store.createSourceDoc(P, W.main.conn, `${TABLE_CANARY}_dated`, {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await store.updateSourceDoc(P, W.main.conn, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'd', type: 'DATE' }], partition: { columns: ['d'], method: 'DAY', required: true }, readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
      return (await liveRecord.saveLiveRecord(P, { name: 'dated', columns: fx.COLUMNS, origin: { kind: 'connection', connId: W.main.conn, table: `${TABLE_CANARY}_dated` } }))!.id;
    });
    const NOTE = (dateRange.requiredRange({ requiredDates: ['d'] }, []) as { notes: string[] }).notes[0];
    const dates = () => (fake.calls.at(-1)?.params ?? []).filter((p) => p.type === 'date').map((p) => String(p.value));
    const REQ = 'SELECT count(*) AS n, min(d) AS first_day, max(d) AS last_day FROM dated';
    const req0 = await ask(ADMIN, REQ, ['dated']);
    ok('10. the second call is told the table needs a filter on d, and what is read without one', /- dated \(the dataset "dated" · Live · needs a WHERE filter on d \(without one, only last 12 months are read\)\)/.test(req0.prompt), req0.prompt.slice(0, 300));
    ok('10. a statement with no filter on d: its view gets Last 12 months, bound, and the card says so in the chart\'s sentence', req0.sent === 1 && dates().join() === '2024-03-01,2025-02-28' && req0.turn?.card?.bullets?.includes(NOTE), show([dates(), req0.turn?.card?.bullets]));
    const byHand = 'SELECT count(*) AS n, min(d) AS first_day, max(d) AS last_day FROM orders WHERE d BETWEEN DATE \'2024-03-01\' AND DATE \'2025-02-28\'';
    ok('10. …its table is the reference\'s with that range written by hand', problems(req0.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, byHand, false))).length === 0, show(req0.turn?.card?.rows));
    const OWN = 'SELECT count(*) AS n FROM dated WHERE d >= DATE \'2024-01-01\'';
    const own = await ask(ADMIN, OWN, ['dated']);
    ok('10. NEGATIVE CONTROL: a statement that filters d itself is left as it came: its own date only, no sentence, the reference\'s table', own.sent === 1 && dates().join() === '2024-01-01' && !own.turn?.card?.bullets?.includes(NOTE)
      && problems(own.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, OWN.replace('dated', 'orders'), false))).length === 0, show([dates(), own.turn?.card?.bullets]));
    // Only a WHERE restricting THIS table's d by bound values counts (sql/view `whereColumns`), not a column named anywhere.
    const RANGE = 'BETWEEN DATE \'2024-03-01\' AND DATE \'2025-02-28\'';
    const CORR = 'SELECT count(*) AS n FROM dated o WHERE EXISTS (SELECT 1 FROM orders t2 WHERE t2.d = o.d AND t2.qty > 0)';
    const corr = await ask(ADMIN, CORR, ['dated', 'orders']);
    ok('10. d named only in a join condition (a correlation, `t2.d = o.d`) is no filter: the view gets Last 12 months and the sentence, ≡ the reference with it by hand', corr.sent === 1 && dates().join() === '2024-03-01,2025-02-28' && corr.turn?.card?.bullets?.includes(NOTE)
      && problems(corr.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, `SELECT count(*) AS n FROM orders o WHERE o.d ${RANGE} AND EXISTS (SELECT 1 FROM orders t2 WHERE t2.d = o.d AND t2.qty > 0)`, false))).length === 0, show([dates(), corr.turn?.card?.bullets, corr.turn?.card?.rows]));
    const REAL = CORR.replace('WHERE EXISTS', 'WHERE o.d >= \'2025-01-01\' AND EXISTS');
    const real = await ask(ADMIN, REAL, ['dated', 'orders']);
    ok('10. NEGATIVE CONTROL: the same with a real `o.d >= \'2025-01-01\'` is left as it came: its own date only, no sentence', real.sent === 1 && dates().join() === '2025-01-01' && !real.turn?.card?.bullets?.includes(NOTE), show([dates(), real.turn?.card?.bullets]));
    const OR = 'SELECT count(*) AS n FROM dated WHERE d >= \'2025-01-01\' OR qty > 3';
    const or = await ask(ADMIN, OR, ['dated']);
    ok('10. an OR with an unrestricted branch is no filter: the range is added, ≡ the reference with it by hand', or.sent === 1 && dates().sort().join() === '2024-03-01,2025-01-01,2025-02-28' && or.turn?.card?.bullets?.includes(NOTE)
      && problems(or.turn?.card, await as(ADMIN, 'admin', () => diff.reference(kit, `SELECT count(*) AS n FROM orders WHERE (d >= '2025-01-01' OR qty > 3) AND d ${RANGE}`, false))).length === 0, show([dates(), or.turn?.card?.bullets]));
    const both = await ask(ADMIN, 'SELECT count(*) AS n FROM dated WHERE d >= \'2025-02-01\' OR d < \'2024-01-01\'', ['dated']);
    ok('10. …but an OR whose every branch restricts d is a filter (no range, no sentence)', both.sent === 1 && dates().sort().join() === '2024-01-01,2025-02-01' && !both.turn?.card?.bullets?.includes(NOTE), show([dates(), both.turn?.card?.bullets]));
    // (DuckDB's parse already folds `NOT (d < x)` into `d >= x`, a range; a NOT it keeps is none.)
    const not = await ask(ADMIN, 'SELECT count(*) AS n FROM dated WHERE NOT (d BETWEEN \'2024-01-01\' AND \'2024-06-30\')', ['dated']);
    ok('10. …and a restriction under NOT is none (the range is added)', not.sent === 1 && dates().length === 4 && not.turn?.card?.bullets?.includes(NOTE), show([dates(), not.turn?.card?.bullets]));
    const bare = await ask(ADMIN, REQ.replace('dated', 'orders'));
    ok('10. NEGATIVE CONTROL: a table with no such fact gets no range and no sentence', bare.sent === 1 && dates().length === 0 && !bare.turn?.card?.bullets?.includes(NOTE) && !/needs a WHERE filter/.test(bare.prompt), show([dates(), bare.turn?.card?.bullets]));
    const checked = await as(ADMIN, 'admin', () => liveSql.checkLiveSql(P, REQ, [{ id: dated, names: ['dated'] }]));
    ok('10. the translate-only check takes it too (it prints with the range, sends nothing)', checked === null, show(checked));
  } finally {
    if (pinned === undefined) delete process.env.ORDINATE_TODAY;
    else process.env.ORDINATE_TODAY = pinned;
  }
}

async function dbLeg(): Promise<void> {
  if (process.env.DATABASE_URL) handlers.clear(); // the world registers every handler itself
  const W = await H.world('the locked leg of SQL answers on Live');
  if (!W) return;
  try {
    fakeMod.registerLiveFake();
    const P2: string = (await W.call('boss', 'projects:create', { name: 'Live SQL, locked' })).body.id;
    for (const member of [{ userId: W.uid.ed }, { teamId: W.team }, { userId: W.uid.west }]) {
      const r = await W.call('boss', 'project:share', { projectId: P2, member, role: 'userId' in member && member.userId === W.uid.ed ? 'editor' : 'viewer' });
      if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
    }
    const { kit, live } = await W.as('boss', async () => {
      const kit = await diff.setupKit(ok);
      if (!kit) throw new Error('no kit');
      await fx.duckEngine.load(`${TABLE_CANARY}_orders`, fx.layout(fx.COLUMNS), kit.rows.orders);
      await fx.duckEngine.load(`${TABLE_CANARY}_targets`, corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const })), kit.rows.targets);
      return { kit, live: await liveTables(P2, '', fakeMod.LIVE_FAKE_ID, {}, {}, { orders: `${TABLE_CANARY}_orders`, targets: `${TABLE_CANARY}_targets` }) };
    });
    const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P2, datasetId: live.orders, policy: { column: 'region', rules: H.RULES(W.team, W.uid.west) } });
    ok('7. the Live orders take row rules (East for the team, West for one viewer)', set.body?.ok === true, set.text.slice(0, 200));
    const ask = async (who: string, sql: string) => {
      nextAction = sqlAction(['orders', 'targets']);
      nextSql = sql;
      const [s0, f0] = [calls.sql.length, fake.calls.length];
      const thread = (await W.call(who, 'copilot:newThread', { projectId: P2 })).body.thread.id as string;
      const r = await W.call(who, 'copilot:ask', { projectId: P2, threadId: thread, context: { kind: '' }, question: 'which ones?' });
      return { r, sqls: calls.sql.length - s0, sent: fake.calls.length - f0, prompt: calls.sql[s0]?.text ?? '', card: r.body?.turns?.at(-1)?.card };
    };
    const ref = (sql: string, lock: boolean | string) => W.as('boss', () => diff.reference(kit, sql, lock));
    const cases = corpus.CASES.filter((c) => /\borders\b/.test(c.sql)).slice(0, 16);
    let east = 0;
    let ed = 0;
    for (const c of cases) {
      const e = await ask('east', c.sql);
      const p = problems(e.card, await ref(c.sql, true), c.approx);
      if (!p.length && !H.leaks(e.r.text)) east++;
      else ok(`7. east: ${c.name}`, false, `${p.join(' | ')}\n  ${c.sql}`);
      if (!problems((await ask('ed', c.sql)).card, await ref(c.sql, false), c.approx).length) ed++;
    }
    ok(`7. DIFFERENTIAL: a LOCKED viewer's table is Object.is-equal to the reference locked to East (${east}/${cases.length}), nothing of West`, east === cases.length && cases.length === 16);
    ok(`7. …and the editor's is the whole table's (${ed}/${cases.length})`, ed === cases.length);
    const S = 'SELECT region, count(*) AS n, sum(qty) AS q FROM orders WHERE tier > 0 GROUP BY region ORDER BY region';
    const e1 = await ask('east', S);
    const w1 = await ask('west', S);
    const e2 = await ask('east', S);
    ok('7. a second lock is a second statement: east, then west each send one; east again none', e1.sent === 1 && w1.sent === 1 && e2.sent === 0, show([e1.sent, w1.sent, e2.sent]));
    ok('7. …each its own table: west\'s equals the reference locked to West, east\'s to East', problems(w1.card, await ref(S, 'West'), [2]).length === 0 && problems(e2.card, await ref(S, true), [2]).length === 0
      && JSON.stringify(e2.card?.rows) !== JSON.stringify(w1.card?.rows), show([e2.card?.rows, w1.card?.rows]));
    ok('7. the lock\'s values are bound parameters: no rule value is in the statement text', fake.calls.slice(-2).every((c) => !/'East'|'West'|WEST_POLICY/.test(c.sql)) && fake.calls.at(-1)!.params.some((p) => p.value === 'West'));
    ok('7. nothing of the rules reaches east, and no warehouse name any reply', !H.leaks(e1.r.text) && !H.leaks(e2.r.text) && ![e1, w1, e2].some((a) => a.r.text.includes(TABLE_CANARY) || a.r.text.includes(DEFQ_CANARY)));
  } finally {
    await W.close();
  }
}

/** § 8: the channel on Postgres through the real `amazon-redshift` connector (as test-liveSqlParityPostgres), file records. */
async function redshiftLeg(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip the Redshift leg of SQL answers on Live: DATABASE_URL is unset');
    return;
  }
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const u = new URL(url);
  const reach = await eng.reachableAddress(u.hostname, Number(u.port || 5432));
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  await as('ana', 'admin', async () => {
    const p = await eng.postgresParity(url, reach.address);
    try {
      const kit = await diff.setupKit(ok);
      if (!kit) return;
      await p.engine.load(`${TABLE_CANARY}_orders`, fx.layout(fx.COLUMNS), kit.rows.orders);
      await p.engine.load(`${TABLE_CANARY}_targets`, corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const })), kit.rows.targets);
      const P = (await projects.createProject('Live SQL on Redshift')).id;
      await liveTables(P, '', 'amazon-redshift', p.values, p.secrets, { orders: `${TABLE_CANARY}_orders`, targets: `${TABLE_CANARY}_targets` });
      const out: string[] = [];
      let agree = 0;
      for (const [i, c] of corpus.CASES.entries()) {
        if (i % 25 === 0) counters.resetMemoryForTest();
        nextAction = sqlAction(['orders', 'targets']);
        nextSql = c.sql;
        const thread = (await handlers.get('copilot:newThread')!({}, { projectId: P })).thread.id;
        const r = await handlers.get('copilot:ask')!({}, { projectId: P, threadId: thread, context: {}, question: 'which ones?' });
        out.push(JSON.stringify(r));
        const pr = problems(r.turns?.at(-1)?.card, await diff.reference(kit, c.sql, false), c.approx);
        if (!pr.length) agree++;
        else ok(`8. postgres (redshift dialect): ${c.name}`, false, `${pr.join(' | ')} ${show(r.turns?.at(-1)?.text)}\n  ${c.sql}`);
      }
      ok(`8. DIFFERENTIAL on Postgres through amazon-redshift: the channel's table equals the reference, every corpus statement (${agree}/${corpus.CASES.length})`, agree === corpus.CASES.length);
      const canaries = [String(p.values.database), String(p.values.host), p.secrets.password, TABLE_CANARY, DEFQ_CANARY].filter((x) => x.length > 3);
      ok('8. R-L17: no reply carries the host, the database, the password, a table or the defining query', !out.some((r) => canaries.some((x) => r.includes(x))), String(out.length));
    } finally {
      await p.close();
    }
  });
}

(async () => {
  await fileLeg();
  await redshiftLeg();
  await dbLeg();
})()
  .catch((e) => ok('the SQL answers on Live suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
