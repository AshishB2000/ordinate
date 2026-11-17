// The read budget of ONE Assistant question (docs/assistant/00-design.md, "Scale rules"): a project of 2,000 datasets,
// 5,000 metrics, 2,000 terms and 5,000 verified questions, and one `copilot:ask` through the real handler, the model
// stubbed (as test-verifiedAsk.ts) so no network call is made. Counted during that one ask: Postgres queries (every
// statement a pg client runs) and record reads (recordFs.readFile calls, the paths passed to readMany, readdir calls).
//
// Cases, each in a conversation of its own: (a) from Home, (b) with a dataset open, (c) through an agent with a topic of
// three datasets, (e) with a dashboard open (four tiles on two datasets), all as an admin; (d) case (a) as a restricted
// viewer, one column hidden from them; (f) a conversation of 15 chart answers reopened (`copilot:history`): every card
// comes with it, and NO figure query runs (the answer door, a hydration and the Live door spied) — NEGATIVE CONTROL:
// with the snapshots removed, the web's reopen computes all 15. (g) An SQL answer (src/ipc/answerSql.ts): the gate names
// tables off ONE listing of the project and reads a dataset's record only for what the statement reads and the answer
// picked (getDatasetMeta spied) — NEGATIVE CONTROL: the Query tab's sidebar catalog reads every dataset's record. (h) A
// joined chart answer (docs/assistant "Joins, as built"): case (a) with one link, then its category read from the linked
// dataset, through the chart door (the link made and removed inside the case, so no other case follows it).
//
// Always (no database; records are files):
//   1. The parsed catalog (../src/app/catalog `loadShared`) is one object inside a read memo, forgotten by a write, and
//      a new one each time outside it — NEGATIVE CONTROL.
//   2. A catalog.json past 4 MiB is logged once per org and project, by its size only; one under it is not.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on); without it, a skip line:
//   3. THE BUDGET: each case's counts ≤ its ceilings (printed). The value index (src/ipc/valueIndex.ts) answers each case's
//      values: one DuckDB lookup over the datasets' sidecars, no scan (none on the dashboard), no Postgres statement.
//   4. NEGATIVE CONTROL: case (c) with the question's read memo off (../src/ipc/askMemo `_setAskMemo`) is over them, and
//      cases (a) and (d) with step 3's index off (../src/ipc/assistantSearch `_setIndexed`, the reference paths) are too.
//      The open dataset of case (b) loads no table: datasets.getDataset is called no more often than from Home, where
//      the one call is the answer chart's (../src/ipc/answers computeCardWith hydrates by design); Orders is past
//      every door's 1,000-row cost model. NEGATIVE CONTROL: with the resident read off (../src/ipc/copilotTable
//      `residentTable`) the facts load Orders too. The dashboard of case (e) loads at most QUESTION_METRICS tables more:
//      the metrics step 3 finds for its question on other datasets (Q12), clones with no Parquet.
//   6. Q8: the facts of one Home question, built alone (no model call), timed and printed with their parts.
//   5. SAME REPLY: in every case, memo on and off, the model is sent the same facts, and the reply's answer, chart,
//      provenance, action, ledger, audit and guidance are the same, with Object.is.
//   8. SHARED FOLDERS (docs/team-folders E4): case (d) again with Orders in a folder Ops the viewer's team opens and 50
//      datasets in one only admins open: it answers, under its ceiling, and the indexes' WHERE condition (D13) costs no
//      statement — the same ask with it off makes as many (NEGATIVE CONTROL: off, the index hands the viewer a closed dataset).
//   7. MEANING ON (PR 7c; pgvector, ORDINATE_EXPECT_PGVECTOR=1 fails without it): a fake fingerprint model, every item
//      fingerprinted by the job, then cases (a) to (e) again: ONE embed call each, and their own ceilings; (d) once more
//      with every batched record read 200 ms late (a slow run's interleaving): no more statements than at full speed.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-askBudget.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';
import { randomUUID } from 'crypto';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askbudget-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const askLinks: typeof import('../src/ipc/askLinks') = require('../src/ipc/askLinks');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
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
const factMetricsMod: typeof import('../src/ipc/factMetrics') = require('../src/ipc/factMetrics');
const homeFacts: typeof import('../src/ipc/homeFacts') = require('../src/ipc/homeFacts');
const searchMod: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const cmdK: typeof import('../src/ipc/search') = require('../src/ipc/search');
const copilotTable: typeof import('../src/ipc/copilotTable') = require('../src/ipc/copilotTable');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const askMemo: typeof import('../src/ipc/askMemo') = require('../src/ipc/askMemo');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const valueIndex: typeof import('../src/ipc/valueIndex') = require('../src/ipc/valueIndex');
const valueResident: typeof import('../src/engine/valueIndexResident') = require('../src/engine/valueIndexResident');
const rowDoors: Record<string, unknown> = require('../src/ipc/rowDoors');
const liveAnswers: Record<string, unknown> = require('../src/ipc/liveAnswers');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const { logger }: typeof import('../src/app/logger') = require('../src/app/logger');
const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
import { clearFolders, plantFolder } from './folderFixture';

type Role = import('../src/server/context').Identity['user']['role'];
const HR_TEAM = '11111111-1111-4111-8111-111111111111';
let req = 0;
/** The project rank the RPC route seeds from `authorize` for a non-admin (8 only: the other cases' viewer has none). */
let seeded: { P: string; rank: number } | null = null;
const as = <T>(role: Role, fn: () => Promise<T>, org = 'acme'): Promise<T> =>
  context.runInContext({ user: { email: `${role}@${org}.test`, role }, org: { id: org } }, `b${++req}`, async () => {
    if (seeded && role !== 'admin') caller.seedRank(seeded.P, seeded.rank);
    return fn();
  });

const SCALE = { datasets: 2_000, metrics: 5_000, terms: 2_000, verified: 5_000 };

// The ceilings: the counts measured plus 10%. A record read is a call into recordFs, one the memo answers included; a
// query is what reached Postgres. Before PR 2, (a) was 129,540 queries and 43,188 reads, (c) about 300,000 and 100,000;
// after PR 2, about 27,000 queries each; after PRs 3 to 6a (lists one paged query, verified checks narrowed, a dataset's
// stats, a dashboard's own metrics), 345 queries and about 7,100 reads each, (d) 14,135 reads. PR 6b, step 3's index on
// the ask path (no question lists the whole project): Home counts and the 12 datasets the index ranks, a dataset's metrics
// and terms by index, the names a model's answer says looked up by index. (d), a caller with a hidden column, then still
// read every dataset (hiddenAnywhere) and every metric (metricsByName): 311 queries and 11,153 reads. Now only the datasets
// the index says may hide a column, the metrics a formula names by their name keys, each result page's dataset records
// in one query, and the counts' metric and term checks a thousand records a query: what is left is those checks.
const at = (queries: number, reads: number) => ({ queries: Math.ceil(queries * 1.1), reads: Math.ceil(reads * 1.1) });
const CEILING: Record<string, { queries: number; reads: number }> = {
  // Table facts in the prompt (src/ipc/askTableFacts.ts): the ask's datasets read again, every one a memo hit, no query.
  // Follow the links (src/ipc/askLinks.ts): relationships.json, one record (no link here, so nothing more); a memo hit
  // where a metric's figure read it first (a dataset), a transaction of 3 queries where nothing had (Home). An agent follows none.
  // The value search (src/ipc/askValues.ts): no statement, and two record reads a copy it searches, both memo hits (the
  // dataset's record, for its marked columns and its Parquet): +2 where Orders alone is searched, +6 for the agent's three.
  // Its DuckDB statements are counted apart (VALUE_SEARCHES): with the value index (sidecars built for the three datasets
  // with rows), ONE lookup statement an ask and no scan, where the scan sent 1 a case, 3 for the agent; none for the dashboard.
  home: at(92, 169), // was at(92, 167), at(89, 166), at(89, 154), at(345, 7_134) before that
  dataset: at(88, 127), // was at(88, 125), at(88, 124), at(88, 123), at(345, 7_121) before that
  agent: at(75, 152), // was at(75, 146), at(75, 136), at(339, 7_113) before that
  // Shared folders (docs/team-folders E2): the restricted viewer's folder access, one transaction (BEGIN, the tree, COMMIT).
  viewer: at(120, 7_314), // was at(120, 7_312), at(117, 7_312), at(114, 7_311), at(114, 7_299), at(359, 11_153) and at(345, 14_135) before that
  dashboard: at(112, 183), // was at(354, 7_112)
  // PR 2b: 15 answers reopened, no figure query. Before it, the web drew each card with `answer:card`: 15 computes,
  // each card's "✓ Verified" also listing every verified question of the project (5,000 records).
  reopen: at(22, 4),
  // (g) An SQL answer: Home's facts, one listing of the project's datasets for the gate's names (kept for the question),
  // and the records of Orders only. Before, the gate and the second call's facts each read every dataset's record
  // (projectCatalog): 151 queries (the list's pages fill the read memo) and 4,164 record reads, 4,125 getDatasetMeta calls.
  sql: at(151, 171), // was at(151, 165) before the value search
  // E4: case (d) in a project with folders (8), measured 132–138 here. Over the bare viewer's 120: the datasets' placements
  // (E2, one transaction: 3 statements) and five records read one at a time (5 transactions: 15); the indexes' folder
  // WHERE none (8 counts their statements with it and without). No other case moved with E4 (E3: 92 / 88 / 75 / 120 / 112 / 22).
  opsViewer: at(138, 7_141), // was at(138, 7_139) before the value search
  // (h) Answers that join (docs/assistant "Joins, as built"), new. Measured LAST, with meaning on (the suite's state by
  // then): writing the case's link drops the project's answer cache, which moved the cases after it (dataset, meaning on:
  // 122 → 127 reads) when it ran before them. Home's chart with one link in the project (Orders → Stores): 109 queries and
  // 185 reads (Home with meaning on, 106 / 169, and the link followed: the relationships record in a transaction, Stores'
  // record and table facts). Then the same ask, its category read from Stores through THE chart door: no query more, 19
  // record reads more, every one a memo hit (the join plan's relationships record and the records it names, read by each
  // gate the door passes, and the snapshot's print over both tables). Meaning off, the two measured 95 / 185 and 95 / 204.
  linked: at(109, 185),
  joined: at(109, 204),
};
// PR 7c, meaning search ON (a fake fingerprint model, all 19,998 items and questions fingerprinted): ONE embed call a
// question; per search one nearest-items query beside the words one, and the examples' nearest questions; once an ask,
// whether the project has fingerprints. Off (above), the counts are the same as before 7c.
const CEILING_ON: Record<string, { queries: number; reads: number }> = {
  home: at(107, 169), // off: 92 / 169; was at(107, 153), before the table facts, the links and the value search
  dataset: at(94, 118), // off: 88 / 123
  agent: at(84, 152), // off: 75 / 152; was at(84, 136), before the links and the value search
  // Shared folders (E2): +3 for the restricted viewer, its folder access in one transaction (BEGIN, the tree, COMMIT), as off.
  // CI's ~18 more were a race, not S3: the picks' checks reading singly what the counts' batches had in flight (below).
  viewer: at(134, 7_350), // off: 120 / 7,312; was at(142, 7_350) (CI's raced count), at(139, 7_350), at(135, 7_350)
  dashboard: at(119, 182), // off: 112 / 183
};

/** The value search (src/ipc/askValues.ts): at most one DuckDB statement a dataset the ask is about, Home's 12 and the linked. */
const VALUE_SEARCHES = homeFacts.HOME_DATASETS + askLinks.LINKED_MAX;

/** (g)'s getDatasetMeta calls beyond a chart answer's from Home: the pick's and the statement's (pick, gate, card); never one per dataset. */
const SQL_METAS = 12;

interface World { P: string; orders: string; stores: string; agent: string; board: string; withRows: string[] }

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
    return { P, orders, stores, agent: agent.id, board: board.id, withRows: [orders, stores, visits] };
  });
}

/**
 * What one ask costs: Postgres statements, record reads, tables loaded (datasets.getDataset) and the value search's DuckDB
 * statements (src/ipc/askValues.ts) while `fn` runs. `slowBatches`: ms each batched record read (readMany) waits before it is sent.
 */
async function counted<T>(fn: () => Promise<T>, slowBatches = 0): Promise<{ out: T; queries: number; reads: number; tables: number; values: number; lookups: number; ms: number; sqls: string[] }> {
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown }; // the pool's clients are pg Clients
  const [query, readFile, readMany, readdir, getDataset, queryAsync] = [proto.query, recordFs.readFile, recordFs.readMany, recordFs.readdir, datasets.getDataset, duck.queryAsync];
  let queries = 0, reads = 0, tables = 0, values = 0, lookups = 0;
  (duck as { queryAsync: unknown }).queryAsync = (sql: string, ...a: unknown[]) => {
    if (sql.includes('AND regexp_matches(v, ?)')) values++;
    if (sql.startsWith(valueResident.LOOKUP_MARK)) lookups++;
    return (queryAsync as (...x: unknown[]) => unknown)(sql, ...a);
  };
  const sqls: string[] = [];
  (datasets as { getDataset: unknown }).getDataset = (...a: Parameters<typeof getDataset>) => { tables++; return getDataset(...a); };
  proto.query = function (this: unknown, ...a: unknown[]) {
    queries++;
    const q = a[0] as string | { text?: string } | undefined;
    sqls.push(String(typeof q === 'string' ? q : q?.text ?? '?'));
    const text = sqls[sqls.length - 1];
    if (slowBatches && text.includes('ANY($2::text[])')) return new Promise((r) => setTimeout(r, slowBatches)).then(() => query.apply(this, a));
    return query.apply(this, a);
  };
  const spy = recordFs as unknown as Record<'readFile' | 'readMany' | 'readdir', unknown>;
  spy.readFile = (...a: unknown[]) => { reads++; return (readFile as (...x: unknown[]) => unknown)(...a); };
  spy.readMany = (ps: readonly string[], perQuery?: number) => { reads += ps.length; return readMany(ps, perQuery); };
  spy.readdir = (...a: unknown[]) => { reads++; return (readdir as (...x: unknown[]) => unknown)(...a); };
  const t0 = Date.now();
  try {
    return { out: await fn(), queries, reads, tables, values, lookups, ms: Date.now() - t0, sqls };
  } finally {
    proto.query = query;
    (duck as { queryAsync: unknown }).queryAsync = queryAsync;
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
  // The value index of the three datasets with rows (the clones have none), as their writes build it where the app wires it.
  valueIndex.wireValueIndex();
  for (const id of w.withRows) if (!(await as('admin', () => valueIndex.buildValueIndex(w.P, id)))) throw new Error('fixture: the value index');
  copilotIpc.register();
  require('../src/ipc/assistantSearch').register(); // what src/server/app.ts registers at startup: the two indexes' describers
  require('../src/ipc/search').register();
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
  const once = async (role: Role, extra: object, agentId: string | undefined, slowBatches = 0) => {
    const threadId = await fresh(role, agentId);
    sent.length = 0;
    const c = await counted(() => ask(role, { ...extra, threadId }), slowBatches);
    return { ...c, facts: sent.slice() };
  };
  const factsOf = new Map<string, string>();
  const tablesOf = new Map<string, number>();
  const line = (name: string, c: { queries: number; reads: number; tables: number; values?: number; ms: number }) =>
    console.log(`  ${name.padEnd(18)} ${String(c.queries).padStart(7)} queries ${String(c.reads).padStart(7)} record reads ${String(c.tables).padStart(3)} tables loaded ${String(c.values ?? 0).padStart(3)} value searches ${String(c.ms).padStart(6)} ms`);
  for (const [name, role, extra, agentId, right] of cases) {
    const on = await once(role, extra, agentId);
    line(name, on);
    ok(`${name}: the ask answers with the chart, as asked`, on.out.ok === true && on.out.turns.at(-1)?.answer?.datasetId === w.orders && right(on.out), JSON.stringify(on.out).slice(0, 300));
    ok(`${name}: ${on.queries} queries ≤ ${CEILING[name].queries} and ${on.reads} record reads ≤ ${CEILING[name].reads}`, on.queries <= CEILING[name].queries && on.reads <= CEILING[name].reads);
    if (on.queries * 1.1 > CEILING[name].queries || process.env.ORDINATE_BUDGET_SQL) histogram(name, on.sqls); // over, or into its 10%
    tablesOf.set(name, on.tables);
    ok(`${name}: ${on.values} value-search DuckDB statements ≤ one a dataset the ask is about (${VALUE_SEARCHES})`, on.values <= VALUE_SEARCHES);
    ok(`${name}: the value index answers it: ${on.lookups} DuckDB lookup (at most one an ask), ${on.values} scans`, on.lookups <= 1 && on.values === 0 && (name === 'dashboard' || on.lookups === 1));
    // Before PR 4 the dashboard resolved all 5,000 metrics, a table loaded for each clone's (they have no Parquet). Since
    // PR 6b it also resolves the few metrics step 3 finds for the question elsewhere (Q12): "Revenue" on five clones.
    if (name === 'dashboard') {
      const most = (tablesOf.get('home') ?? 0) + factMetricsMod.QUESTION_METRICS;
      ok(`dashboard: it resolves its datasets' metrics and at most ${factMetricsMod.QUESTION_METRICS} the question finds (${on.tables} getDataset calls ≤ ${most})`, on.tables <= most);
    }
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
    if (name === 'home' || name === 'viewer') {
      searchMod._setIndexed(false); // the reference paths, as without a database: every list of the project
      try {
        const ref = await once(role, extra, agentId);
        line(name + ' (index off)', ref);
        ok(`NEGATIVE CONTROL: ${name} with the index off is over both ceilings`, ref.queries > CEILING[name].queries && ref.reads > CEILING[name].reads, `${ref.queries} queries, ${ref.reads} reads`);
      } finally {
        searchMod._setIndexed(true);
      }
    }
    factsOf.set(name, on.facts[0]);
    const [a, b] = [replyOf(on.out), replyOf(off.out)];
    ok(`${name}: memo on and off, the model is sent the same facts`, on.facts.length === 1 && off.facts.length === 1 && Object.is(on.facts[0], off.facts[0]));
    ok(`${name}: …and the reply is the same, field for field`, a.every((x, i) => Object.is(x, b[i])), JSON.stringify([a, b]).slice(0, 600));
  }
  await homeTiming(w);
  ok('NEGATIVE CONTROL: the comparison can tell facts apart (Home, a dataset and the agent\'s topic differ)',
    !Object.is(factsOf.get('home'), factsOf.get('dataset')) && !Object.is(factsOf.get('home'), factsOf.get('agent')));
  await reopenCase(w, fresh, line);
  await sqlCase(w, fresh, line); // before meaningOn, which leaves its fake model on
  await foldersCase(pool, w, once, line);
  await meaningOn(cases, once, line);
  await joinedCase(w, fresh, line); // last: writing its link drops the project's answer cache, which would move every case after it
}

/** 8. Case (d) with folders: Orders in Ops (the viewer's team: view), 50 clones in Finance (admins only). The WHERE costs nothing. */
async function foldersCase(pool: Pool, w: World, once: (role: Role, extra: object, agentId: string | undefined) => Promise<{ queries: number; reads: number; tables: number; ms: number; out: any; sqls: string[] }>,
  line: (name: string, c: { queries: number; reads: number; tables: number; ms: number }) => void): Promise<void> {
  const clones = (await pool.query<{ id: string }>(`SELECT substring(path from '([0-9a-f-]{36})\\.json$') AS id FROM records WHERE org_id = 'acme' AND path LIKE $1 AND path NOT LIKE $2 ORDER BY path LIMIT 50`,
    [`projects/${w.P}/datasets/%.json`, `%${w.orders}%`])).rows.map((r) => r.id);
  await plantFolder(pool, w.P, { name: 'Ops', members: ['viewer@acme.test'], items: [['dataset', w.orders]] });
  await plantFolder(pool, w.P, { name: 'Finance', items: clones.map((id): ['dataset', string] => ['dataset', id]) });
  seeded = { P: w.P, rank: 1 }; // a project viewer, as the route seeds it: a folder level is capped by the project role (D5)
  try {
    const on = await once('viewer', {}, undefined);
    line('opsViewer', on);
    ok(`opsViewer (folders): the ask answers with the chart on Orders, ${on.queries} queries ≤ ${CEILING.opsViewer.queries} and ${on.reads} record reads ≤ ${CEILING.opsViewer.reads}`,
      on.out.ok === true && on.out.turns.at(-1)?.answer?.datasetId === w.orders && on.queries <= CEILING.opsViewer.queries && on.reads <= CEILING.opsViewer.reads, JSON.stringify(on.out).slice(0, 400));
    if (on.queries * 1.1 > CEILING.opsViewer.queries || process.env.ORDINATE_BUDGET_SQL) histogram('opsViewer', on.sqls);
    const closed = new Set(clones);
    const found = async () => as('viewer', async () => (await searchMod.searchModel(w.P, 'clone', { limit: 60, kinds: ['dataset'] })).filter((h) => closed.has(h.id)).length);
    // The WHERE rides inside the index's own statements: as many of them with it as without. (The ask's total moves with
    // what it finds: without the WHERE the top datasets are closed ones, whose records the stores never read.)
    const indexed = (sqls: readonly string[]): number => sqls.filter((q) => /\b(FROM|JOIN)\s+(assistant_search|assistant_search_vectors|verified_keys|search_entries)\b/i.test(q)).length;
    gate.setIndexWhereForTest(false);
    let off: Awaited<ReturnType<typeof once>>;
    try {
      off = await once('viewer', {}, undefined);
      line('opsViewer (no WHERE)', off);
      ok('NEGATIVE CONTROL: without it the index hands the viewer a dataset of the closed folder', (await found()) > 0);
    } finally {
      gate.setIndexWhereForTest(true);
    }
    ok(`opsViewer: the indexes' folder WHERE adds no statement (${indexed(on.sqls)} index statements with it, ${indexed(off.sqls)} without)`, indexed(on.sqls) === indexed(off.sqls) && indexed(on.sqls) > 0);
    ok('…with it, none', (await found()) === 0);
  } finally {
    seeded = null;
    await clearFolders(pool, w.P);
  }
}

/** The cases again with meaning search on: a fake model (no network), every item fingerprinted by the job first. */
async function meaningOn(cases: Array<[string, Role, object, string | undefined, unknown]>, once: (role: Role, extra: object, agentId: string | undefined, slowBatches?: number) => Promise<{ queries: number; reads: number; tables: number; ms: number; out: any; sqls: string[] }>,
  line: (name: string, c: { queries: number; reads: number; tables: number; ms: number }) => void): Promise<void> {
  const vstore: typeof import('../src/server/vectorStore') = require('../src/server/vectorStore');
  if (!(await vstore.vectorStatus(0)).table) {
    ok('pgvector is installed for the meaning cases (ORDINATE_EXPECT_PGVECTOR=1)', process.env.ORDINATE_EXPECT_PGVECTOR !== '1');
    return console.log('  skip the meaning cases: no pgvector table');
  }
  const fp: typeof import('../src/ai/fingerprints') = require('../src/ai/fingerprints');
  const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');
  const job: typeof import('../src/server/fingerprintJob') = require('../src/server/fingerprintJob');
  const crypto: typeof import('crypto') = require('crypto');
  const dim = (w: string): number => crypto.createHash('sha256').update(w).digest().readUInt32BE(0) % 768;
  const fake = (t: string): Float32Array => { const v = new Float32Array(768); for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[dim(w)] = 1; v[dim(t)] += 1; return fp.unit(Array.from(v)) as Float32Array; };
  let embeds = 0, sent = 0;
  (fp as { fingerprint: unknown }).fingerprint = async (texts: string[], _p: unknown, o: { purpose?: string }) => {
    if (o.purpose === 'query') embeds++;
    else sent += texts.length;
    return { ok: true, vectors: texts.map(fake) };
  };
  (aiConfig as { currentFingerprintModel: unknown }).currentFingerprintModel = () => ({ provider: 'openai', model: 'text-embedding-3-small' });
  const t0 = Date.now();
  while (await as('admin', () => job.fingerprintOrg(Infinity, 5_000)));
  console.log(`  fingerprinted ${sent} items and questions in ${Date.now() - t0} ms`);
  const store: typeof import('../src/server/fingerprintStore') = require('../src/server/fingerprintStore');
  const t1 = Date.now();
  const more = await as('admin', () => job.fingerprintOrg());
  const t2 = Date.now();
  const cover = await as('admin', () => store.coverage('openai:text-embedding-3-small'));
  console.log(`  a job run with nothing to send ${t2 - t1} ms; Admin → AI's coverage (${cover.fingerprinted} of ${cover.items}) ${Date.now() - t2} ms`);
  ok('meaning on: the job, run again, sends nothing; the coverage counts every item', !more && sent === cover.items && cover.fingerprinted === cover.items, JSON.stringify({ sent, cover }));
  for (const [name, role, extra, agentId] of cases) {
    if (!CEILING_ON[name]) continue;
    embeds = 0;
    const on = await once(role, extra, agentId);
    line(name + ' (meaning on)', on);
    ok(`${name}, meaning on: the ask answers, with ONE embed call (${embeds}), ${on.queries} queries ≤ ${CEILING_ON[name].queries} and ${on.reads} record reads ≤ ${CEILING_ON[name].reads}`,
      on.out.ok === true && embeds === 1 && on.queries <= CEILING_ON[name].queries && on.reads <= CEILING_ON[name].reads);
    if (on.queries * 1.1 > CEILING_ON[name].queries || process.env.ORDINATE_BUDGET_SQL) histogram(name + ' (meaning on)', on.sqls); // over, or into its 10%
    if (name === 'viewer') {
      // A slow run (CI) once made 18 more statements: the picks' checks read singly the metrics the counts' batches were
      // still reading. Batches 200 ms late force that interleaving; a batch claims its records first (recordFs.readMany),
      // so nothing more is read. Its NEGATIVE CONTROL is test-recordListBatch's (5.): outside a memo each read queries.
      // Records read one at a time, not every statement: a 2 s ask may also outlive a per-pod probe's TTL (vectorStatus, 30 s).
      const slow = await once(role, extra, agentId, 200);
      const singly = (sqls: readonly string[]): number => sqls.filter((q) => q.startsWith('SELECT body FROM records WHERE org_id = $1 AND path = $2')).length;
      line(name + ' (slow batches)', slow);
      ok(`${name}, meaning on, every batched record read 200 ms late: ${singly(slow.sqls)} records read singly, no more than at full speed (${singly(on.sqls)})`,
        slow.out.ok === true && singly(slow.sqls) <= singly(on.sqls));
      if (singly(slow.sqls) > singly(on.sqls)) histogram(name + ' (slow batches)', slow.sqls);
    }
  }
}

/** The statements a case made, by their first words, most frequent first: what to cut when a case nears its ceiling. */
function histogram(name: string, sqls: readonly string[]): void {
  const by = new Map<string, number>();
  for (const q of sqls) {
    const k = q.replace(/\s+/g, ' ').trim().slice(0, 90);
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  console.log(`  ${name}: ${sqls.length} statements`);
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
}

/** (g) An SQL answer on the budget's project: no dataset record read but the statement's and the pick's. */
async function sqlCase(w: World, fresh: (role: Role) => Promise<string>, line: (name: string, c: { queries: number; reads: number; tables: number; ms: number }) => void): Promise<void> {
  const SQL = 'SELECT region, sum(amount) AS total FROM orders GROUP BY region ORDER BY region';
  const [ask0, dispatch0, meta0] = [analyze.askCopilot, analyze.dispatch, datasets.getDatasetMeta];
  let writes = 0, metas = 0;
  (analyze as { askCopilot: unknown }).askCopilot = async () => ({ ok: true, text: 'Here they are.', suggestedAction: { kind: 'sql', intent: 'revenue by region in SQL', datasets: ['Orders'] } });
  (analyze as { dispatch: unknown }).dispatch = async () => { writes++; return { rawText: SQL }; };
  (datasets as { getDatasetMeta: unknown }).getDatasetMeta = (...a: Parameters<typeof meta0>) => { metas++; return meta0(...a); };
  try {
    // A chart answer from Home first (the suite's own stub), for the metadata a Home question reads anyway: its facts, the chart's dataset.
    const sqlAsk = analyze.askCopilot;
    (analyze as { askCopilot: unknown }).askCopilot = ask0;
    const chartThread = await fresh('admin');
    metas = 0;
    await as('admin', () => handlers.get('copilot:ask')!({}, { projectId: w.P, context: {}, question: 'revenue by region, in SQL', threadId: chartThread }));
    const home = metas;
    (analyze as { askCopilot: unknown }).askCopilot = sqlAsk;
    metas = 0;
    const threadId = await fresh('admin');
    const c = await counted(() => as('admin', () => handlers.get('copilot:ask')!({}, { projectId: w.P, context: {}, question: 'revenue by region, in SQL', threadId })));
    const asked = metas;
    line('sql', c);
    const t = c.out.turns?.at(-1);
    ok('sql: the ask answers with the SQL\'s table, its statement written by one second call', c.out.ok === true && t?.sql?.datasetIds?.join() === w.orders && t?.card?.rowCount === 3 && writes === 1, JSON.stringify(c.out).slice(0, 300));
    ok(`sql: ${asked} getDatasetMeta calls, ${asked - home} more than a chart answer's from Home (${home}) ≤ ${SQL_METAS}: the pick's and the statement's, never one per dataset`, asked - home <= SQL_METAS, `${asked} ${home}`);
    ok(`sql: ${c.queries} queries ≤ ${CEILING.sql.queries} and ${c.reads} record reads ≤ ${CEILING.sql.reads}`, c.queries <= CEILING.sql.queries && c.reads <= CEILING.sql.reads);
    metas = 0;
    const cat = await counted(() => as('admin', () => sqlDatasets.projectCatalog(w.P)));
    line('sql catalog (ref)', cat);
    ok(`NEGATIVE CONTROL: the Query tab's catalog reads every dataset's record (${metas} getDatasetMeta calls, ${cat.reads} record reads)`, metas >= SCALE.datasets && cat.reads > CEILING.sql.reads);
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = ask0;
    (analyze as { dispatch: unknown }).dispatch = dispatch0;
    (datasets as { getDatasetMeta: unknown }).getDatasetMeta = meta0;
  }
}

/**
 * (h) A JOINED chart answer (docs/assistant "Joins, as built"): Home's question, its category read from a linked dataset
 * (Orders.region → Stores.city, linked here and unlinked after, so no other case follows it). Measured beside the same
 * ask with the link there and the plain category, so the difference is the join's own: the chart door's join plan (the
 * relationships record and each dataset's record it names) and its figure, in place of the card's own rows.
 */
async function joinedCase(w: World, fresh: (role: Role) => Promise<string>, line: (name: string, c: { queries: number; reads: number; tables: number; ms: number }) => void): Promise<void> {
  const ask0 = analyze.askCopilot;
  const link = randomUUID();
  await as('admin', () => rels.saveRelationship(w.P, { id: link, from: { datasetId: w.orders, column: 'region' }, to: { datasetId: w.stores, column: 'city' }, cardinality: 'many_to_one', verified: { matched: 0, unmatchedFrom: 1_200 } }));
  try {
    const run = async (spec: object) => {
      (analyze as { askCopilot: unknown }).askCopilot = async () => ({ ok: true, text: 'West leads.', suggestedAction: { ...ANSWER, spec } });
      const threadId = await fresh('admin');
      return counted(() => as('admin', () => handlers.get('copilot:ask')!({}, { projectId: w.P, context: {}, question: 'revenue by region last year', threadId })));
    };
    const plain = await run(ANSWER.spec);
    line('linked', plain);
    const joined = await run({ ...ANSWER.spec, category: 'city', categoryDataset: 'Stores' });
    line('joined', joined);
    const t = joined.out.turns?.at(-1);
    ok('joined: the ask answers with a chart on Orders whose category is Stores\' city', joined.out.ok === true && t?.answer?.datasetId === w.orders && t.answer.categoryDatasetId === w.stores && !!t.card, JSON.stringify(joined.out).slice(0, 300));
    ok('linked: …and the plain ask beside it, its link there, a chart of Orders\' own region', plain.out.ok === true && plain.out.turns?.at(-1)?.answer?.datasetId === w.orders && !plain.out.turns.at(-1).answer.categoryDatasetId);
    for (const [name, c] of [['linked', plain], ['joined', joined]] as const) {
      ok(`${name}: ${c.queries} queries ≤ ${CEILING[name].queries} and ${c.reads} record reads ≤ ${CEILING[name].reads}`, c.queries <= CEILING[name].queries && c.reads <= CEILING[name].reads);
      if (c.queries * 1.1 > CEILING[name].queries || process.env.ORDINATE_BUDGET_SQL) histogram(name, c.sqls);
    }
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = ask0;
    await as('admin', () => rels.deleteRelationship(w.P, link));
  }
}

/**
 * Q8: building the facts of ONE Home question (no model call), at this scale, warm: the median of five, each in a read memo
 * of its own as an ask's is; then the median time of each part, alone. Printed, not a ceiling (a laptop is no CI runner).
 */
async function homeTiming(w: World): Promise<void> {
  const Q = 'revenue by region last year';
  const median = async (fn: () => Promise<unknown>): Promise<number> => {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      await as('admin', () => recordFs.withReadMemo(fn));
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return ms.sort((a, b) => a - b)[2];
  };
  const whole = await median(() => copilotIpc.buildFacts(w.P, {}, undefined, Q));
  const parts: Array<[string, () => Promise<unknown>]> = [
    ['counts (step 3 index)', () => searchMod.countModel(w.P)],
    ['counts (⌘K index)', () => cmdK.countNamed(w.P)],
    ['picks (two searches, newest)', () => homeFacts.picksFrom(w.P, Q, { search: searchMod.searchModel, newest: async (p, n) => (await searchMod.newestModel(p, 'dataset', n)) ?? [] })],
    ['12 datasets read', () => homeFacts.homeDatasets(w.P, Q)],
  ];
  const each: string[] = [];
  for (const [name, fn] of parts) each.push(`${name} ${(await median(fn)).toFixed(1)} ms`);
  console.log(`  Q8: facts for one Home question ${whole.toFixed(1)} ms (median of 5; ${each.join(', ')})`);
  ok(`Q8: the facts of one Home question are built (${whole.toFixed(1)} ms)`, whole > 0);
}

/** (f) A conversation of 15 chart answers, reopened: the figure doors spied (every computeCard enters `withLockOf`). */
async function reopenCase(w: World, fresh: (role: Role) => Promise<string>, line: (name: string, c: { queries: number; reads: number; tables: number; ms: number }) => void): Promise<void> {
  let figures = 0;
  const spy = (mod: Record<string, unknown>, name: string): void => {
    const real = mod[name] as (...a: unknown[]) => unknown;
    mod[name] = (...a: unknown[]) => { figures++; return real(...a); };
  };
  spy(rowDoors, 'withLockOf');
  spy(datasets as unknown as Record<string, unknown>, 'getDataset');
  spy(liveAnswers, 'liveCardFor');
  const T = await fresh('admin');
  const call = (ch: string, payload: object) => as('admin', () => handlers.get(ch)!({}, { projectId: w.P, ...payload }));
  for (let i = 0; i < 15; i++) {
    const r = await call('answer:rerun', { threadId: T, spec: { datasetId: w.orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'amount', op: '>', value: i }], chartType: 'column', title: `Revenue over ${i}` } });
    if (!r.ok) throw new Error('fixture: an answer ' + JSON.stringify(r));
  }
  figures = 0;
  const re = await counted(() => call('copilot:history', { threadId: T }));
  line('reopen (15)', re);
  const answered = (re.out.turns as Array<{ answer?: unknown; card?: unknown }>).filter((t) => t.answer);
  ok('reopen: the conversation brings all 15 answers with their cards', answered.length === 15 && answered.every((t) => !!t.card), `${answered.length}`);
  ok(`reopen: 0 figure queries (${figures}), ${re.queries} queries ≤ ${CEILING.reopen.queries} and ${re.reads} record reads ≤ ${CEILING.reopen.reads}`,
    figures === 0 && re.queries <= CEILING.reopen.queries && re.reads <= CEILING.reopen.reads);
  const turns = await as('admin', () => copilot.loadHistory(w.P, T));
  for (const t of turns) if (t.answer) await as('admin', () => copilot.setSnapshot(w.P, T, t.id, t.answer!, null));
  figures = 0;
  const h = await call('copilot:history', { threadId: T });
  for (const t of h.turns as Array<{ id: string; answer?: unknown; card?: unknown }>) if (t.answer && !t.card) await call('answer:refresh', { threadId: T, turnId: t.id });
  ok(`NEGATIVE CONTROL: with the snapshots removed, the web's reopen computes every card (${figures} figure calls ≥ 15)`, figures >= 15);
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
