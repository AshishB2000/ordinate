// Verified SQL on Live datasets, F4 (docs/live-data/01-live-sql.md, "Verify, verified questions and snapshots"): an
// editor's Verify on a Live SQL answer keeps phase B's record (`sql: {text, datasetIds}`, the datasets the translator
// resolved, never the browser's); asked word for word it is translated again for the ASKER and printed under their
// lock, one statement per lock; the Verified page's check translates, binds and prints only. Through the real handlers,
// both model calls stubbed and spied (as test-liveSqlAnswers).
//
// File leg (JSON records, the fake warehouse scripts/liveFakeConnector.ts):
//   1. VERIFY: one statement through phase F; the record holds the model's text and the datasets the translator read
//      (a word naming another dataset, an alias, is not one); the browser sends no list.
//   2. ASKED WORD FOR WORD: no model call, the card Object.is-equal to F2's reference, marked verified; for a viewer from
//      whom a column is hidden too. A verified question naming that column: the column gate's own sentence for them, not
//      "no longer runs" (CONTROL: the admin gets the table).
//   3. THE VERIFIED PAGE: the check sends nothing (the fake's calls and dry runs unchanged).
//   4. A COLUMN DROPPED BY A SCHEMA SYNC: the Verified page says which, and asking it says why, with NO warehouse call
//      (the fake's call count stays 0). CONTROL: before the sync it ran; after it, a question not naming it still runs.
//   5. MCP's answer_verified_question still refuses an SQL question.
// Database leg (DATABASE_URL: scripts/rowPolicyHarness.ts, real grants over the real RPC route):
//   6. TWO VIEWERS, TWO LOCKS: the verified question asked by East, then West: two statements, each Object.is-equal to
//      the reference under its own lock; East again a cache hit. CONTROL: serving West the entry East's statement left
//      fails the comparison. The Verified page's check under a lock sends nothing.
//   7. POSTGRES as Redshift (the leg F2 uses): verified, then asked word for word through the real `amazon-redshift`
//      connector, Object.is-equal to the reference; the page's check runs no statement.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-liveSqlVerified.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesqlverified-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const rowPolicy: typeof import('../src/data/rowPolicyError') = require('../src/data/rowPolicyError');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const lmsg: typeof import('../src/engine/liveSqlMessages') = require('../src/engine/liveSqlMessages');
const sqlMsg: typeof import('../src/ai/answerSqlMessages') = require('../src/ai/answerSqlMessages');
const vStore: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const mcp: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');

type Role = import('../src/server/context').Identity['user']['role'];
type Table = import('./liveSqlDiff').Table;
const fake = fakeMod.fake;

// ── the two model calls, stubbed and spied ─────────────────────────────────
const calls = { ask: 0, sql: 0 };
let nextSql = '';
(execConfig as { executionReady: unknown }).executionReady = async () => true;
(execConfig as { assistantOn: unknown }).assistantOn = () => true;
(analyze as { askCopilot: unknown }).askCopilot = async () => { calls.ask++; return { ok: true, text: 'These.', suggestedAction: { kind: 'sql', intent: 'a question one chart cannot say', datasets: ['orders', 'targets'] } }; };
(analyze as { dispatch: unknown }).dispatch = async () => { calls.sql++; return { rawText: nextSql }; };
// The secrets store over a Map, as liveQueryHarness keeps it: per (org, kind, ref).
const vault = new Map<string, string>();
configSecrets.useSecretStore({
  get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
  put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
  delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
});

const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 400) ?? String(v);
const TARGETS_STORE = corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const }));

/** Where a delivered card and F2's reference differ: empty when they agree (width, rows, every cell in order, Object.is). P2: one leading U+FEFF dropped from Live's. */
function problems(card: any, ref: Table | { error: string }, approx: readonly number[] = []): string[] { // any: a delivered card
  if ('error' in ref) return [`the reference failed: ${ref.error}`];
  if (!card || card.kind !== 'sql') return [`no table: ${show(card)}`];
  const out: string[] = [];
  if (card.columns.length !== ref.columns.length || card.rows.length !== ref.rows.length) out.push(`shape ${card.columns.length}×${card.rows.length} vs ${ref.columns.length}×${ref.rows.length}`);
  ref.rows.forEach((r, i) => r.forEach((v, j) => {
    let w = card.rows[i]?.[j];
    if (typeof w === 'string' && w.startsWith('﻿')) w = w.slice(1);
    const near = approx.includes(j) && typeof v === 'number' && typeof w === 'number' && Math.abs(v - w) <= 1e-13 * Math.max(1, Math.abs(v));
    if (!Object.is(v, w) && !near) out.push(`row ${i} col ${j}: ${JSON.stringify(v)} vs ${JSON.stringify(w)}`);
  }));
  return out.slice(0, 6);
}

/** `orders` (a table) and `targets` (a defining query) of one project over one Live connection, as the reference names them. */
async function liveTables(P: string, connectorId: string, values: Record<string, unknown>, secrets: Record<string, string>, table: string) {
  const conn = await connections.saveConnection(P, { name: 'Warehouse', connectorId, values });
  if (!conn) throw new Error('connection not saved');
  await secretsIpc.storeSecrets(conn.id, secrets);
  const orders = await liveRecord.saveLiveRecord(P, { name: 'orders', columns: fx.COLUMNS, origin: { kind: 'connection', connId: conn.id, table: `${table}_orders` } });
  const targets = await liveRecord.saveLiveRecord(P, { name: 'targets', columns: corpus.TARGET_COLUMNS, origin: { kind: 'connection', connId: conn.id, sql: `SELECT * FROM ${table}_targets` } });
  if (!orders || !targets) throw new Error('live datasets not saved');
  return { conn: conn.id, orders: orders.id, targets: targets.id };
}

// Verified on Live: `targets` is an alias here, a word naming the other dataset that the statement does not read.
const S = 'SELECT region AS targets, count(*) AS n, sum(qty) AS q FROM orders WHERE tier > 0 GROUP BY region ORDER BY region';
const Q = 'Orders and quantity by region, tiered only';

let req = 0;
const as = <T>(who: string, role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${who}@acme.test`, role }, org: { id: 'acme' } }, `v${++req}`, fn);

async function fileLeg(): Promise<void> {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
  appMod.registerHandlers();
  fakeMod.registerLiveFake();
  const ROLE: Record<string, Role> = { ana: 'admin', eve: 'editor', vic: 'viewer' };
  const call = (who: string, ch: string, payload: object): Promise<any> => as(who, ROLE[who], () => handlers.get(ch)!({}, payload)); // any: each handler's reply
  const { kit, P, main, shrink } = await as('ana', 'admin', async () => {
    const kit = await diff.setupKit(ok); // the reference's project: the extract twins
    if (!kit) throw new Error('no kit');
    await fx.duckEngine.load('lsv_orders', fx.layout(fx.COLUMNS), kit.rows.orders);
    await fx.duckEngine.load('lsv_targets', TARGETS_STORE, kit.rows.targets);
    await fx.duckEngine.load('lsv_shrink', fx.layout(fx.COLUMNS), kit.rows.orders);
    const P = (await projects.createProject('Verified SQL on Live')).id;
    const main = await liveTables(P, fakeMod.LIVE_FAKE_ID, {}, {}, 'lsv');
    const shrink = (await liveRecord.saveLiveRecord(P, { name: 'shrink_orders', columns: fx.COLUMNS, origin: { kind: 'connection', connId: main.conn, table: 'lsv_shrink' } }))!.id;
    // A column hidden from the viewer: `amt` of orders, visible only to a team the viewer is not in.
    await rec.serialized(rec.datasetFilePath(P, main.orders), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'amt', visibleTo: [{ teamId: '99999999-9999-4999-8999-999999999999' }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    return { kit, P, main, shrink };
  });
  const ref = (sql: string) => as('ana', 'admin', () => diff.reference(kit, sql, false));
  const ask = async (who: string, question: string, sql = 'SELECT 1') => {
    nextSql = sql;
    const [a0, s0, f0] = [calls.ask, calls.sql, fake.calls.length];
    const threadId = (await call(who, 'copilot:newThread', { projectId: P })).thread.id;
    const r = await call(who, 'copilot:ask', { projectId: P, threadId, context: {}, question });
    return { r, models: calls.ask - a0 + calls.sql - s0, sent: fake.calls.length - f0, turn: r.turns?.at(-1) };
  };
  const verify = async (who: string, question: string, sql: string) => {
    const f0 = fake.calls.length;
    const r = await call(who, 'verified:save', { projectId: P, input: { question, sql } });
    return { r, sent: fake.calls.length - f0 };
  };
  const record = async (question: string) => (await as('ana', 'admin', () => vStore.listBoth(P))).sql.find((t) => t.rec.question === question)?.rec;
  const listed = async (who: string) => {
    const [f0, e0] = [fake.calls.length, fake.estimates.length];
    const r = await call(who, 'verified:list', { projectId: P });
    return { rows: (r.questions ?? []) as Array<{ id: string; question: string; runs: boolean; problem?: string }>, sent: fake.calls.length - f0 + fake.estimates.length - e0 };
  };

  // 1. Verify: once through phase F, and what is kept.
  const asked = await ask('eve', 'tiered quantities by region?', S);
  ok('1. the editor\'s Live SQL answer: dated live, Not checked', asked.turn?.card?.asOf?.mode === 'live' && !asked.turn.card.verified && asked.sent === 1, show(asked.turn?.card));
  const v = await verify('eve', Q, S);
  const kept = await record(Q);
  ok('1. VERIFY a Live SQL answer: saved, runs, one statement or a cache hit (the editor just asked it: none)', v.r.ok === true && v.r.question?.runs === true && v.sent === 0, show(v.r));
  ok('1. the record: the model\'s text and the datasets the TRANSLATOR read (orders, not the alias that names targets), no figure',
    kept?.sql.text === S && kept.sql.datasetIds.join() === main.orders && !('spec' in kept) && !JSON.stringify(kept).includes('"rows"'), show(kept));
  const lexed = await as('ana', 'admin', async () => sqlDatasets.extractDeps(S, await sqlDatasets.projectNames(P)));
  ok('1. NEGATIVE CONTROL: the lexer\'s lineage alone would keep targets too', lexed.includes(main.targets) && lexed.includes(main.orders), show(lexed));

  // 2. Asked word for word, for each caller.
  const vid = kept?.id;
  for (const [who, label] of [['ana', 'the admin'], ['vic', 'a viewer from whom amt is hidden']] as const) {
    const hit = await ask(who, Q);
    ok(`2. ${label} asks it word for word: no model call, its SQL again, marked verified, Object.is-equal to the reference`, hit.r.ok && hit.models === 0 && hit.turn?.sql?.text === S
      && hit.turn.sql.datasetIds.join() === main.orders && hit.turn.guidance?.verifiedId === vid && hit.turn.card?.verified?.id === vid && problems(hit.turn.card, await ref(S)).length === 0, show(hit.turn));
  }
  const HQ = 'Amounts by region';
  const HS = 'SELECT region, sum(amt) AS total FROM orders GROUP BY region ORDER BY region';
  ok('2. a verified question naming amt (the admin verifies it)', (await verify('ana', HQ, HS)).r.ok === true);
  const hid = await ask('vic', HQ);
  ok('2. …the viewer from whom amt is hidden: the column gate\'s own sentence, not "no longer runs", no model call, nothing sent',
    hid.r.ok === false && hid.r.error === rowPolicy.rowPolicyRefusal('hidden').error && hid.models === 0 && hid.sent === 0, show(hid.r));
  const hidRow = (await listed('vic')).rows.find((r) => r.question === HQ);
  ok('2. …and their Verified page does not call it broken: that is their access', hidRow?.runs === true, show(hidRow));
  const hidAdmin = await ask('ana', HQ);
  ok('2. CONTROL: the admin asking it gets the table, equal to the reference', problems(hidAdmin.turn?.card, await ref(HS)).length === 0, show(hidAdmin.turn?.card));

  // 3. The Verified page: translated only.
  const page = await listed('ana');
  ok('3. the Verified page checks every Live SQL question and asks the warehouse NOTHING (no statement, no dry run)', page.sent === 0 && page.rows.filter((r) => [Q, HQ].includes(r.question)).every((r) => r.runs), show(page));

  // 4. A column dropped by a schema sync.
  const DQ = 'Tiers by region (shrinking)';
  const DS = 'SELECT region, sum(tier) AS t FROM shrink_orders GROUP BY region ORDER BY region';
  const KQ = 'Counts by region (shrinking)';
  const KS = 'SELECT region, count(*) AS n FROM shrink_orders GROUP BY region ORDER BY region';
  ok('4. two verified questions on shrink_orders', (await verify('ana', DQ, DS)).r.ok === true && (await verify('ana', KQ, KS)).r.ok === true);
  const before = (await listed('ana')).rows.find((r) => r.question === DQ);
  ok('4. CONTROL: before the sync, the one naming tier runs', before?.runs === true, show(before));
  await as('ana', 'admin', async () => {
    await duck.execAsync('ALTER TABLE "lsv_shrink" DROP COLUMN tier');
    const r = await sync.syncLiveSchema(P, shrink);
    ok('4. the schema sync finds tier gone and drops it from the declared columns', r.ok === true && (r as { removed?: string[] }).removed?.join() === 'tier', show(r));
  });
  const f0 = fake.calls.length;
  const after = await listed('ana');
  const dRow = after.rows.find((r) => r.question === DQ);
  const want = sqlMsg.verifiedSqlBroken(lmsg.sqlUnknownColumn('tier'));
  ok('4. the Verified page says it no longer runs, naming the column, with NO warehouse call (the fake\'s call count stays 0)',
    dRow?.runs === false && dRow.problem === want && after.sent === 0 && fake.calls.length === f0, `${after.sent} ${show(dRow)}`);
  ok('4. CONTROL: the question on the same table not naming tier still runs', after.rows.find((r) => r.question === KQ)?.runs === true);
  const dAsk = await ask('ana', DQ);
  ok('4. …and asking it word for word says why: no model call, nothing sent', dAsk.r.ok === false && dAsk.r.error === want && dAsk.models === 0 && dAsk.sent === 0, show(dAsk.r));

  // 5. MCP keeps refusing SQL questions.
  let mcpErr = '';
  await as('ana', 'admin', () => mcp.answerVerifiedQuestion({ projectId: P } as import('../src/automation/registry').Ctx, Q).catch((e: Error) => { mcpErr = e.message; }));
  ok('5. MCP\'s answer_verified_question refuses a Live SQL question, saying so', mcpErr === sqlMsg.verifiedSqlNotOnMcp(), mcpErr);
}

async function dbLeg(): Promise<void> {
  if (process.env.DATABASE_URL) handlers.clear(); // the world registers every handler itself
  const W = await H.world('the locked leg of verified SQL on Live');
  if (!W) return;
  try {
    fakeMod.registerLiveFake();
    const P2: string = (await W.call('boss', 'projects:create', { name: 'Verified SQL, locked' })).body.id;
    for (const member of [{ userId: W.uid.ed }, { teamId: W.team }, { userId: W.uid.west }]) {
      const r = await W.call('boss', 'project:share', { projectId: P2, member, role: 'userId' in member && member.userId === W.uid.ed ? 'editor' : 'viewer' });
      if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
    }
    const { kit, live } = await W.as('boss', async () => {
      const kit = await diff.setupKit(ok);
      if (!kit) throw new Error('no kit');
      await fx.duckEngine.load('lsv_orders', fx.layout(fx.COLUMNS), kit.rows.orders);
      await fx.duckEngine.load('lsv_targets', TARGETS_STORE, kit.rows.targets);
      return { kit, live: await liveTables(P2, fakeMod.LIVE_FAKE_ID, {}, {}, 'lsv') };
    });
    const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P2, datasetId: live.orders, policy: { column: 'region', rules: H.RULES(W.team, W.uid.west) } });
    ok('6. the Live orders take row rules (East for the team, West for one viewer)', set.body?.ok === true, set.text.slice(0, 200));
    const saved = await W.call('ed', 'verified:save', { projectId: P2, input: { question: Q, sql: S } });
    ok('6. the editor verifies the Live SQL answer', saved.body?.ok === true && saved.body.question?.runs === true, saved.text.slice(0, 300));
    const ask = async (who: string) => {
      const f0 = fake.calls.length;
      const thread = (await W.call(who, 'copilot:newThread', { projectId: P2 })).body.thread.id as string;
      const r = await W.call(who, 'copilot:ask', { projectId: P2, threadId: thread, context: { kind: '' }, question: Q });
      return { r, sent: fake.calls.length - f0, card: r.body?.turns?.at(-1)?.card };
    };
    const ref = (lock: boolean | string) => W.as('boss', () => diff.reference(kit, S, lock));
    const realSet = queryCache.set;
    let eastEntry: unknown = null;
    (queryCache as { set: unknown }).set = (key: string, value: unknown, deps: string[], o?: object) => {
      if (key.includes('\u0000livesql\u0000') && eastEntry === null) eastEntry = structuredClone(value);
      return realSet(key, value, deps, o);
    };
    const [m0, s0] = [calls.ask, calls.sql];
    const e1 = await ask('east');
    (queryCache as { set: unknown }).set = realSet;
    const w1 = await ask('west');
    const e2 = await ask('east');
    ok('6. TWO LOCKS, TWO STATEMENTS: east sends one, west one, east again none (a cache hit); no model call', e1.sent === 1 && w1.sent === 1 && e2.sent === 0 && calls.ask === m0 && calls.sql === s0, show([e1.sent, w1.sent, e2.sent]));
    ok('6. …each equal to the reference under its own lock: east\'s to East, west\'s to West', problems(e1.card, await ref(true), [2]).length === 0 && problems(w1.card, await ref('West'), [2]).length === 0
      && problems(e2.card, await ref(true), [2]).length === 0 && e1.card?.verified && w1.card?.verified, show([e1.card?.rows, w1.card?.rows]));
    ok('6. nothing of the rules or of West reaches east', !H.leaks(e1.r.text) && !H.leaks(e2.r.text));
    const realGet = queryCache.get;
    (queryCache as { get: unknown }).get = (op: string, key: string, o?: object) => (key.includes('\u0000livesql\u0000') && eastEntry ? structuredClone(eastEntry) : realGet(op as never, key, o));
    let served: Awaited<ReturnType<typeof ask>>;
    try {
      served = await ask('west');
    } finally {
      (queryCache as { get: unknown }).get = realGet;
    }
    ok('6. CONTROL: serving west the entry east\'s statement left FAILS the comparison with West\'s reference (the check can see it)', eastEntry !== null && served.sent === 0
      && problems(served.card, await ref('West'), [2]).length > 0, show(served.card?.rows));
    const f0 = fake.calls.length;
    const page = await W.call('east', 'verified:list', { projectId: P2 });
    const row = page.body?.questions?.find((r: { question: string }) => r.question === Q);
    ok('6. east\'s Verified page: the question runs, checked under their lock with no warehouse call', row?.runs === true && fake.calls.length === f0, page.text.slice(0, 300));
  } finally {
    await W.close();
  }
}

/** § 7: verified, asked and checked on Postgres through the real `amazon-redshift` connector (as test-liveSqlParityPostgres), file records. */
async function redshiftLeg(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip the Redshift leg of verified SQL on Live: DATABASE_URL is unset');
    return;
  }
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const u = new URL(url);
  const reach = await eng.reachableAddress(u.hostname, Number(u.port || 5432));
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  const realRun = liveRun.runLiveBound;
  let statements = 0;
  (liveRun as { runLiveBound: unknown }).runLiveBound = (...a: Parameters<typeof realRun>) => { statements++; return realRun(...a); };
  try {
    await as('ana', 'admin', async () => {
      const p = await eng.postgresParity(url, reach.address);
      try {
        const kit = await diff.setupKit(ok);
        if (!kit) return;
        await p.engine.load('lsv_orders', fx.layout(fx.COLUMNS), kit.rows.orders);
        await p.engine.load('lsv_targets', TARGETS_STORE, kit.rows.targets);
        const P = (await projects.createProject('Verified SQL on Redshift')).id;
        await liveTables(P, 'amazon-redshift', p.values, p.secrets, 'lsv');
        const h = (ch: string, payload: object) => handlers.get(ch)!({}, payload);
        const n0 = statements;
        const saved = await h('verified:save', { projectId: P, input: { question: Q, sql: S } });
        ok('7. Postgres (redshift dialect): the Live SQL answer is verified, one statement', saved.ok === true && statements - n0 === 1, show(saved));
        const n1 = statements;
        const list = await h('verified:list', { projectId: P });
        ok('7. …the Verified page\'s check runs no statement', list.questions?.[0]?.runs === true && statements === n1, show(list.questions?.[0]));
        const thread = (await h('copilot:newThread', { projectId: P })).thread.id;
        const [a0, s0] = [calls.ask, calls.sql];
        const r = await h('copilot:ask', { projectId: P, threadId: thread, context: {}, question: Q });
        ok('7. …asked word for word: no model call, Object.is-equal to the reference', calls.ask === a0 && calls.sql === s0 && problems(r.turns?.at(-1)?.card, await diff.reference(kit, S, false), [2]).length === 0, show(r.turns?.at(-1)?.card?.rows));
        const canaries = [String(p.values.database), String(p.values.host), p.secrets.password].filter((x) => x.length > 3);
        ok('7. no reply carries the host, the database or the password', ![saved, list, r].some((x) => canaries.some((c) => JSON.stringify(x).includes(c))));
      } finally {
        await p.close();
      }
    });
  } finally {
    (liveRun as { runLiveBound: unknown }).runLiveBound = realRun;
  }
}

(async () => {
  await fileLeg();
  await redshiftLeg();
  await dbLeg();
})()
  .catch((e) => ok('the verified SQL on Live suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
