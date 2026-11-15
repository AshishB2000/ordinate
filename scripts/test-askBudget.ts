// The read budget of ONE Assistant question (docs/assistant/00-design.md, "Scale rules"): a project of 2,000 datasets,
// 5,000 metrics, 2,000 terms and 5,000 verified questions, and one `copilot:ask` through the real handler, the model
// stubbed (as test-verifiedAsk.ts) so no network call is made. Counted during that one ask: Postgres queries (every
// statement a pg client runs) and record reads (recordFs.readFile calls, the paths passed to readMany, readdir calls).
//
// Cases, each in a conversation of its own: (a) from Home, (b) with a dataset open, (c) through an agent with a topic of
// three datasets, (e) with a dashboard open (four tiles on two datasets), all as an admin; (d) case (a) as a restricted
// viewer, one column hidden from them. A reopened conversation joins this suite with the PR that budgets it.
//
// Always (no database; records are files):
//   1. The parsed catalog (../src/app/catalog `loadShared`) is one object inside a read memo, forgotten by a write, and
//      a new one each time outside it — NEGATIVE CONTROL.
//   2. A catalog.json past 4 MiB is logged once per org and project, by its size only; one under it is not.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on); without it, a skip line:
//   3. THE BUDGET: each case's counts ≤ its ceilings (printed).
//   4. NEGATIVE CONTROL: case (c) with the question's read memo off (../src/ipc/askMemo `_setAskMemo`) is over them.
//      The open dataset of case (b) loads no table: datasets.getDataset is called no more often than from Home, where
//      the one call is the answer chart's (../src/ipc/answers computeCardWith hydrates by design); Orders is past
//      every door's 1,000-row cost model. NEGATIVE CONTROL: with the resident read off (../src/ipc/copilotTable
//      `residentTable`) the facts load Orders too.
//   5. SAME REPLY: in every case, memo on and off, the model is sent the same facts, and the reply's answer, chart,
//      provenance, action, ledger, audit and guidance are the same, with Object.is.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-askBudget.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askbudget-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const copilotTable: typeof import('../src/ipc/copilotTable') = require('../src/ipc/copilotTable');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const askMemo: typeof import('../src/ipc/askMemo') = require('../src/ipc/askMemo');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const { logger }: typeof import('../src/app/logger') = require('../src/app/logger');

type Role = import('../src/server/context').Identity['user']['role'];
const HR_TEAM = '11111111-1111-4111-8111-111111111111';
let req = 0;
const as = <T>(role: Role, fn: () => Promise<T>, org = 'acme'): Promise<T> =>
  context.runInContext({ user: { email: `${role}@${org}.test`, role }, org: { id: org } }, `b${++req}`, fn);

const SCALE = { datasets: 2_000, metrics: 5_000, terms: 2_000, verified: 5_000 };

// The ceilings: the counts measured with PR 3 (a store's list reads its records a page at a time) plus 10%. A record
// read is a call into recordFs, one the memo answers included; a query is what reached Postgres. Before PR 2, (a) was
// 129,540 queries and 43,188 reads, (c) about 300,000 and 100,000; after PR 2, about 27,000 queries each. Later PRs
// lower them: PR 4 an open dataset and dashboard, PR 6 the step 3 index. PR 5 checks a verified question against only
// what its chart names, its records in one readMany (measured with it); with the memo off, (a) no longer builds the
// whole vocabulary twice, so the control is (c). PR 4: (e), a dashboard open, resolved every metric in the project
// (5,000 tables loaded); now only its datasets' metrics, one table (the answer chart's). (b) loads no table for its facts.
const at = (queries: number, reads: number) => ({ queries: Math.ceil(queries * 1.1), reads: Math.ceil(reads * 1.1) });
const CEILING: Record<string, { queries: number; reads: number }> = {
  home: at(330, 7_131),
  dataset: at(339, 7_115),
  agent: at(333, 7_110),
  viewer: at(330, 14_132),
  dashboard: at(345, 7_109),
};

interface World { P: string; orders: string; agent: string; board: string }

async function world(pool: Pool): Promise<World> {
  return as('admin', async () => {
    await projects.init();
    const P = (await projects.createProject('Ask budget'))!.id;
    const num = (name: string) => ({ name, type: 'number' as const });
    const txt = (name: string) => ({ name, type: 'text' as const });
    const orders = (await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [txt('region'), num('amount'), num('cost')], rows: Array.from({ length: 1_200 }, (_, i) => [['West', 'East', 'North'][i % 3], 5 + (i % 17), 1 + (i % 5)]) }))!.id;
    const stores = (await datasets.saveDataset(P, { name: 'Stores', sourceKind: 'csv', columns: [txt('city'), num('sales')], rows: [['Austin', 7], ['Reno', 2]] }))!.id;
    const visits = (await datasets.saveDataset(P, { name: 'Visits', sourceKind: 'csv', columns: [txt('page'), num('views')], rows: [['home', 3]] }))!.id;
    const metric = await metrics.saveMetric(P, { name: 'Revenue', datasetId: orders, definition: { column: 'amount', aggregation: 'sum' } });
    const term = await terms.saveTerm(P, { name: 'West', datasetId: orders, filters: [{ column: 'region', op: 'eq', value: 'West' }] });
    const spec = { datasetId: orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'Revenue by region' };
    const vq = await verified.saveVerifiedQuestion(P, { question: 'Revenue by region', spec });
    await catalog.setColumn(P, orders, 'region', { displayName: 'Sales region' });
    const topic = await topics.saveTopic(P, { name: 'Retail', datasets: [{ id: orders }, { id: stores }, { id: visits }] });
    const agent = topic && (await agents.saveAgent(P, { name: 'Retail assistant', topicId: topic.id, model: null, build: true, teamIds: [] }));
    // A dashboard of four tiles on two datasets: a chart of Orders, the Revenue KPI, a chart of Stores and a note.
    const chart = async (name: string, datasetId: string, category: string, column: string) => (await visuals.saveVisual(P, { name, datasetId, chartType: 'column', encoding: { category, values: [{ column, aggregation: 'sum' }] } }))?.id;
    const [byRegion, byCity] = [await chart('Revenue by region', orders, 'region', 'amount'), await chart('Sales by city', stores, 'city', 'sales')];
    const tile = (x: number, card: object) => ({ layout: { x, y: 0, w: 3, h: 3 }, ...card });
    const board = byRegion && byCity && metric && (await analysis.saveAnalysis(P, { name: 'Retail board', sheets: [{ name: 'S1', cards: [
      tile(0, { type: 'visual', visualId: byRegion }), tile(3, { type: 'metric', metric: { datasetId: orders, column: 'amount', aggregation: 'sum', metricId: metric.id } }),
      tile(6, { type: 'visual', visualId: byCity }), tile(9, { type: 'text', heading: 'Notes' }),
    ] }] }));
    if (!metric || !term || !vq.ok || !agent || !board) throw new Error('fixture: seed');

    // The rest by cloning rows in SQL: each clone of Orders is its own dataset (`Clone n`, ids md5-made), and each cloned
    // metric, term and verified question sits on one of them in turn. A verified question keeps a key of its own.
    const base = `projects/${P}/`;
    const cloneOf = (kind: string, id: string) => `${base}${kind}/${id}.json`;
    const dsId = (n: string) => `md5('ds' || ${n})::uuid::text`;
    await pool.query(
      `INSERT INTO records (org_id, path, body) SELECT org_id, replace(path, $2, ${dsId('g')}), replace(replace(body, $2, ${dsId('g')}), '"name": "Orders"', '"name": "Clone ' || g || '"')
       FROM records, generate_series(1, $3::int) g WHERE org_id = 'acme' AND path = $1`, [cloneOf('datasets', orders), orders, SCALE.datasets - 3]);
    const onClones = async (kind: string, id: string, count: number, extra = (s: string) => s) => pool.query(
      `INSERT INTO records (org_id, path, body) SELECT org_id, replace(path, $2, c.id), ${extra(`replace(replace(body, $2, c.id), $4, ${dsId(`(g % ($5::int) + 1)`)})`)}
       FROM records, generate_series(1, $3::int) g, LATERAL (SELECT md5($6 || g)::uuid::text AS id) c WHERE org_id = 'acme' AND path = $1`,
      [cloneOf(kind, id), id, count, orders, SCALE.datasets - 3, kind]);
    await onClones('metrics', metric.id, SCALE.metrics - 1);
    await onClones('terms', term.id, SCALE.terms - 1);
    await onClones('verified', vq.q.id, SCALE.verified - 1, (body) => `replace(${body}, '"question": "Revenue by region"', '"question": "Revenue by region ' || c.id || '"')`);

    // One column hidden from viewers, on Orders only: case (d)'s caller is in no team.
    const planted = await rec.serialized(rec.datasetFilePath(P, orders), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'cost', visibleTo: [{ teamId: HR_TEAM }] }], 'admin@acme.test', new Date().toISOString());
      return true;
    });
    if (!planted) throw new Error('fixture: column rule');
    const count = async (kind: string) => Number((await pool.query(`SELECT count(*) AS n FROM records WHERE org_id = 'acme' AND path >= $1 AND path < $2`, [base + kind + '/', base + kind + '0'])).rows[0].n);
    const seeded = { datasets: await count('datasets'), metrics: await count('metrics'), terms: await count('terms'), verified: await count('verified') };
    ok('the project is seeded at scale', JSON.stringify(seeded) === JSON.stringify(SCALE), JSON.stringify(seeded));
    return { P, orders, agent: agent.id, board: board.id };
  });
}

/** What one ask costs: Postgres statements, record reads and tables loaded (datasets.getDataset) while `fn` runs. */
async function counted<T>(fn: () => Promise<T>): Promise<{ out: T; queries: number; reads: number; tables: number; ms: number }> {
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown }; // the pool's clients are pg Clients
  const [query, readFile, readMany, readdir, getDataset] = [proto.query, recordFs.readFile, recordFs.readMany, recordFs.readdir, datasets.getDataset];
  let queries = 0, reads = 0, tables = 0;
  (datasets as { getDataset: unknown }).getDataset = (...a: Parameters<typeof getDataset>) => { tables++; return getDataset(...a); };
  proto.query = function (this: unknown, ...a: unknown[]) { queries++; return query.apply(this, a); };
  const spy = recordFs as unknown as Record<'readFile' | 'readMany' | 'readdir', unknown>;
  spy.readFile = (...a: unknown[]) => { reads++; return (readFile as (...x: unknown[]) => unknown)(...a); };
  spy.readMany = (ps: readonly string[]) => { reads += ps.length; return readMany(ps); };
  spy.readdir = (...a: unknown[]) => { reads++; return (readdir as (...x: unknown[]) => unknown)(...a); };
  const t0 = Date.now();
  try {
    return { out: await fn(), queries, reads, tables, ms: Date.now() - t0 };
  } finally {
    proto.query = query;
    Object.assign(spy, { readFile, readMany, readdir });
    (datasets as { getDataset: unknown }).getDataset = getDataset;
  }
}

const ANSWER = { kind: 'answer', intent: 'revenue by region', spec: { dataset: 'Orders', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }] } };

// ── always: the shared catalog and its size line ────────────────────────
async function fileLeg(): Promise<void> {
  const ds = '22222222-2222-4222-8222-222222222222';
  await as('admin', async () => {
    await projects.init();
    const P = (await projects.createProject('Shared catalog'))!.id;
    await catalog.setColumn(P, ds, 'region', { displayName: 'Area' });
    const seen = await recordFs.withReadMemo(async () => {
      const a = await catalog.loadShared(P);
      const b = await catalog.loadShared(P, true);
      await catalog.setColumn(P, ds, 'region', { displayName: 'Zone' }); // a write inside the memo
      const c = await catalog.loadShared(P);
      return { same: Object.is(a, b), after: !Object.is(a, c) && c.columns[ds].region.displayName === 'Zone' && a.columns[ds].region.displayName === 'Area' };
    });
    ok('inside a read memo, the catalog is parsed once: one object for every reader', seen.same);
    ok('…and a write forgets it: the next read is the new file', seen.after);
    ok('NEGATIVE CONTROL: outside a memo, each read parses again', !Object.is(await catalog.loadShared(P), await catalog.loadShared(P)));
  });

  const warned: string[] = [];
  const warn = logger.warn;
  logger.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
  try {
    // `P`: the same project id in another org (an import repeats ids): its own line, since the set is keyed by org.
    const big = async (org: string, mib: number, P?: string): Promise<string> => as('admin', async () => {
      await projects.init();
      const id = P ?? (await projects.createProject('Big catalog'))!.id;
      const file = path.join(appPaths.userData(), 'projects', id, 'catalog.json');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await recordFs.writeFile(file, JSON.stringify({ schemaVersion: 1, records: {}, columns: {}, pad: 's3cret'.repeat(Math.ceil(mib * 1024 * 1024 / 6)) }), 'utf8');
      for (let i = 0; i < 3; i++) await catalog.load(id);
      return id;
    }, org);
    const P1 = await big('acme', 4.5);
    const once1 = warned.filter((w) => w.includes(P1)).length;
    await big('beta', 4.5, P1);
    const P3 = await big('acme', 3.9);
    const of = (P: string) => warned.filter((w) => w.includes(P));
    ok('a catalog past 4 MiB is logged once, by its size', once1 === 1 && /4\.5 MiB/.test(of(P1)[0]), JSON.stringify(warned));
    ok('…once for each org and project: the same id in another org is its own line', of(P1).length === 2, JSON.stringify(warned));
    ok('…and never its content', !warned.some((w) => w.includes('s3cret')));
    ok('NEGATIVE CONTROL: one under 4 MiB is not logged', of(P3).length === 0);
  } finally {
    logger.warn = warn;
  }
}

/** The reply fields an ask's answer is made of, as text: what memo on and off must agree on. */
const replyOf = (r: any): string[] => [r.answer, r.turns?.at(-1)?.answer, r.provenance, r.suggestedAction, r.ledger, r.numberAudit, r.guidance].map((x) => JSON.stringify(x));

async function dbLeg(pool: Pool): Promise<void> {
  const t0 = Date.now();
  const w = await world(pool);
  console.log(`  seeded in ${Date.now() - t0} ms`);
  copilotIpc.register();
  const sent: string[] = [];
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, facts: string) => { sent.push(facts); return { ok: true, text: 'West leads.', suggestedAction: ANSWER }; };
  (analyze as { dispatch: unknown }).dispatch = async () => { throw new Error('no model call in this suite'); };
  const ask = (role: Role, extra: object) => as(role, () => handlers.get('copilot:ask')!({}, { projectId: w.P, context: {}, question: 'revenue by region last year', ...extra }));
  // Each case asks in a conversation of its own: a question lands in the caller's latest otherwise, and its agent answers.
  const fresh = async (role: Role, agentId?: string): Promise<string> => {
    const t = await as(role, () => handlers.get('copilot:newThread')!({}, { projectId: w.P, ...(agentId ? { agentId } : {}) }));
    if (!t.ok || (t.thread.agentId ?? undefined) !== agentId) throw new Error('fixture: a new conversation ' + JSON.stringify(t));
    return t.thread.id;
  };

  const warm = await ask('admin', { threadId: await fresh('admin') }); // the verified index builds lazily, once
  ok('fixture: an ask answers with the chart', warm.ok && warm.turns.at(-1)?.answer?.datasetId === w.orders, JSON.stringify(warm).slice(0, 400));

  const cases: Array<[string, Role, object, string | undefined, (r: any) => boolean]> = [
    ['home', 'admin', {}, undefined, (r) => r.provenance?.kind === 'project' && r.agent === null],
    ['dataset', 'admin', { context: { kind: 'dataset', id: w.orders } }, undefined, (r) => r.provenance?.kind === 'dataset'],
    ['agent', 'admin', {}, w.agent, (r) => r.agent?.id === w.agent],
    ['viewer', 'viewer', {}, undefined, (r) => r.provenance?.kind === 'project'],
    ['dashboard', 'admin', { context: { kind: 'analysis', id: w.board } }, undefined, (r) => r.provenance?.kind === 'analysis'],
  ];
  const once = async (role: Role, extra: object, agentId: string | undefined) => {
    const threadId = await fresh(role, agentId);
    sent.length = 0;
    const c = await counted(() => ask(role, { ...extra, threadId }));
    return { ...c, facts: sent.slice() };
  };
  const factsOf = new Map<string, string>();
  const tablesOf = new Map<string, number>();
  const line = (name: string, c: { queries: number; reads: number; tables: number; ms: number }) =>
    console.log(`  ${name.padEnd(18)} ${String(c.queries).padStart(7)} queries ${String(c.reads).padStart(7)} record reads ${String(c.tables).padStart(3)} tables loaded ${String(c.ms).padStart(6)} ms`);
  for (const [name, role, extra, agentId, right] of cases) {
    const on = await once(role, extra, agentId);
    line(name, on);
    ok(`${name}: the ask answers with the chart, as asked`, on.out.ok === true && on.out.turns.at(-1)?.answer?.datasetId === w.orders && right(on.out), JSON.stringify(on.out).slice(0, 300));
    ok(`${name}: ${on.queries} queries ≤ ${CEILING[name].queries} and ${on.reads} record reads ≤ ${CEILING[name].reads}`, on.queries <= CEILING[name].queries && on.reads <= CEILING[name].reads);
    tablesOf.set(name, on.tables);
    // Before PR 4 the dashboard resolved all 5,000 metrics, a table loaded for each clone's (they have no Parquet).
    if (name === 'dashboard') ok(`dashboard: it resolves only its datasets' metrics, loading no table for them (${on.tables} getDataset calls, as from Home)`, on.tables === tablesOf.get('home'));
    if (name === 'dataset') {
      const home = tablesOf.get('home') ?? -1;
      ok(`dataset: the open dataset loads no table (${on.tables} getDataset calls, as from Home: the answer chart's)`, on.tables === home, home);
      const real = copilotTable.residentTable;
      (copilotTable as { residentTable: unknown }).residentTable = async () => null;
      try {
        const ref = await once(role, extra, agentId);
        ok(`NEGATIVE CONTROL: with the resident read off, the dataset facts load Orders (${ref.tables} getDataset calls)`, ref.tables > home);
      } finally {
        (copilotTable as { residentTable: unknown }).residentTable = real;
      }
    }

    askMemo._setAskMemo(false);
    let off: Awaited<ReturnType<typeof once>>;
    try {
      off = await once(role, extra, agentId);
    } finally {
      askMemo._setAskMemo(true);
    }
    line(name + ' (memo off)', off);
    if (name === 'agent') {
      ok('NEGATIVE CONTROL: the agent with the memo off is over both ceilings', off.queries > CEILING.agent.queries && off.reads > CEILING.agent.reads, `${off.queries} queries, ${off.reads} reads`);
    }
    factsOf.set(name, on.facts[0]);
    const [a, b] = [replyOf(on.out), replyOf(off.out)];
    ok(`${name}: memo on and off, the model is sent the same facts`, on.facts.length === 1 && off.facts.length === 1 && Object.is(on.facts[0], off.facts[0]));
    ok(`${name}: …and the reply is the same, field for field`, a.every((x, i) => Object.is(x, b[i])), JSON.stringify([a, b]).slice(0, 600));
  }
  ok('NEGATIVE CONTROL: the comparison can tell facts apart (Home, a dataset and the agent\'s topic differ)',
    !Object.is(factsOf.get('home'), factsOf.get('dataset')) && !Object.is(factsOf.get('home'), factsOf.get('agent')));
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  await fileLeg();
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the ask budget: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_askbudget_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool);
    await dbLeg(pool);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('ask budget suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
