// No Assistant question lists the whole project (docs/assistant/00-design.md, "Scale rules", Q9 and Q15): its facts
// come from step 3's index (src/ipc/assistantSearch.ts) and from what is open, and the names a model's answer says are
// resolved through the same index (src/ipc/specVocabulary.ts vocabularyFor). Through the real `copilot:ask` handler, the
// model stubbed (as test-askBudget.ts), with every whole-project list spied: datasets.listDatasets, metrics.listMetrics
// and metricsByName, terms.listFullTerms and listTerms, visuals.listVisuals, analysis.listAnalyses, topics.listTopics, agents.listAgents,
// verifiedQuestions.listTagged, and recordFs.listRecords on a directory of the project.
//
// With DATABASE_URL (a scratch database it may CREATE DATABASE on); without it, a skip line (no database: the lists ARE
// the reference path, by design):
//   1. ZERO whole-project lists for one ask: from Home, with a dataset open, with a Live dataset open whose source table has
//      facts (their block is in the prompt, from Home too: src/ipc/askTableFacts.ts), on a dashboard, through an agent with a
//      topic (an answer inside it; the model saying it is outside; an answer on a dataset outside it), a model answer
//      with a typo ("Did you mean"), a follow-up that refines the previous answer, and a restricted viewer from Home with
//      a column hidden from them (Orders' cost: their checks read the few datasets that may hide one, and only the metrics
//      a formula names, ../src/data/rowAccess hiddenAnywhere, ../src/analysis/columnHidden). A formula metric sits on
//      Orders, which the dataset and dashboard cases compute: its figure and additivity read only the metrics it names
//      (../src/analysis/metricNames). Each reply is checked too.
//   2. NEGATIVE CONTROL: the same asks with the index off (assistantSearch._setIndexed(false), the reference paths) DO
//      call them, each case; the formula's figure through metricsByName.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-askNoProjectLists.js   (ASK_LIST_TRACE=1 prints each caller)

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-asknolists-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const verifiedQuestions: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const assistantSearch: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const msg: typeof import('../src/ai/agentMessages') = require('../src/ai/agentMessages');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const sourceDocs: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');

type Role = import('../src/server/context').Identity['user']['role'];
let req = 0;
const as = <T>(role: Role, fn: () => Promise<T>): Promise<T> => context.runInContext({ user: { email: `${role}@acme.test`, role }, org: { id: 'acme' } }, `n${++req}`, fn);

interface World { P: string; orders: string; returns: string; agent: string; board: string; live: string }

async function world(): Promise<World> {
  return as('admin', async () => {
    await projects.init();
    const P = (await projects.createProject('No lists'))!.id;
    const num = (name: string) => ({ name, type: 'number' as const });
    const txt = (name: string) => ({ name, type: 'text' as const });
    const save = async (name: string, columns: Array<{ name: string; type: 'text' | 'number' }>, rows: unknown[][]) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows: rows as never }))!.id;
    const orders = await save('Orders', [txt('region'), num('amount'), num('cost')], [['West', 5, 1], ['East', 7, 2], ['North', 3, 1]]);
    const stores = await save('Stores', [txt('city'), num('sales')], [['Austin', 7], ['Reno', 2]]);
    const returns = await save('Returns', [txt('reason'), num('refunds')], [['damaged', 2], ['late', 1]]);
    for (let i = 0; i < 16; i++) await save(`Clone ${i}`, [txt('page'), num('views')], [['home', i]]); // more than Home's 12
    const revenue = (await metrics.saveMetric(P, { name: 'Revenue', datasetId: orders, definition: { column: 'amount', aggregation: 'sum' } }))!;
    await metrics.saveMetric(P, { name: 'Refund total', datasetId: returns, definition: { column: 'refunds', aggregation: 'sum' } });
    const west = (await terms.saveTerm(P, { name: 'West', datasetId: orders, filters: [{ column: 'region', op: 'eq', value: 'West' }] }))!;
    const spec = { datasetId: orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const, metricId: revenue.id }], filters: [], chartType: 'column', title: 'Revenue by region' };
    const vq = await verified.saveVerifiedQuestion(P, { question: 'Revenue by region', spec });
    const topic = (await topics.saveTopic(P, { name: 'Retail', datasets: [{ id: orders }, { id: stores }], metricIds: [revenue.id], termIds: [west.id] }))!;
    const agent = (await agents.saveAgent(P, { name: 'Retail assistant', topicId: topic.id, model: null, build: true, teamIds: [] }))!;
    const chart = async (name: string, datasetId: string, category: string, column: string) => (await visuals.saveVisual(P, { name, datasetId, chartType: 'column', encoding: { category, values: [{ column, aggregation: 'sum' }] } }))!.id;
    const [byRegion, byCity] = [await chart('Revenue by region', orders, 'region', 'amount'), await chart('Sales by city', stores, 'city', 'sales')];
    const tile = (x: number, card: object) => ({ layout: { x, y: 0, w: 3, h: 3 }, ...card });
    const board = (await analysis.saveAnalysis(P, { name: 'Retail board', sheets: [{ name: 'S1', cards: [
      tile(0, { type: 'visual', visualId: byRegion }), tile(3, { type: 'metric', metric: { datasetId: orders, column: 'amount', aggregation: 'sum', metricId: revenue.id } }), tile(6, { type: 'visual', visualId: byCity }),
    ] }] }))!;
    if (!vq.ok) throw new Error('fixture: verified question');
    // Orders' cost is hidden from a viewer in no team; a formula metric names Revenue (the viewer's checks walk it), on
    // Orders, which the dataset and dashboard cases compute: its figure and its additivity read Revenue by name alone.
    await metrics.saveMetric(P, { name: 'Order share', datasetId: orders, definition: { formula: '[Revenue] / 3' } });
    const ruled = await rec.serialized(rec.datasetFilePath(P, orders), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'cost', visibleTo: [{ teamId: '11111111-1111-4111-8111-111111111111' }] }], 'admin@acme.test', new Date().toISOString());
      return true;
    });
    if (!ruled) throw new Error('fixture: column rule');
    // A Live dataset whose source table has a doc with facts: the prompt's table facts, read by id (no list of docs or connections).
    fakeMod.registerLiveFake();
    const conn = (await connections.saveConnection(P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const live = (await liveRecord.saveLiveRecord(P, { name: 'Sales live', columns: [txt('region'), num('amount')], origin: { kind: 'connection', connId: conn.id, table: 'sales_live' } }))!.id;
    const doc = await sourceDocs.createSourceDoc(P, conn.id, 'sales_live', { guide: 'Use amount for revenue' });
    if (!doc.ok) throw new Error('fixture: source doc');
    await sourceDocs.updateSourceDoc(P, conn.id, doc.docId, (d) => ({ ...d, facts: { columns: [], partition: { columns: ['region'], required: true }, rowEstimate: 5000, readAt: new Date().toISOString(), readBy: 'admin@acme.test' } }));
    return { P, orders, returns, agent: agent.id, board: board.id, live };
  });
}

/** Every whole-project list called while `fn` runs, by name (and the directory, for listRecords). */
async function listed<T>(P: string, fn: () => Promise<T>): Promise<{ out: T; calls: string[] }> {
  const calls: string[] = [];
  const spied: Array<[Record<string, unknown>, string, unknown]> = [];
  const spy = (mod: object, name: string, label = name, counts: (a: unknown[]) => boolean = () => true): void => {
    const m = mod as Record<string, unknown>;
    const real = m[name] as (...a: unknown[]) => unknown;
    spied.push([m, name, real]);
    m[name] = (...a: unknown[]) => {
      if (counts(a)) {
        calls.push(label === 'listRecords' ? `listRecords ${path.relative(DATA, String(a[0]))}` : label);
        if (process.env.ASK_LIST_TRACE) console.log(`  ${calls.at(-1)}\n${new Error().stack?.split('\n').slice(2, 9).join('\n')}`);
      }
      return real(...a);
    };
  };
  spy(datasets, 'listDatasets');
  spy(metrics, 'listMetrics');
  spy(metrics, 'metricsByName');
  spy(terms, 'listFullTerms');
  spy(terms, 'listTerms');
  spy(visuals, 'listVisuals');
  spy(analysis, 'listAnalyses');
  spy(topics, 'listTopics');
  spy(agents, 'listAgents');
  spy(verifiedQuestions, 'listTagged');
  // A directory of the project's records (datasets/, metrics/, terms/, visuals/, topics/, …): a store's whole list.
  spy(recordFs, 'listRecords', 'listRecords', (a) => String(a[0]).includes(path.join('projects', P) + path.sep));
  try {
    return { out: await fn(), calls };
  } finally {
    for (const [m, name, real] of spied) m[name] = real;
  }
}

async function dbLeg(): Promise<void> {
  const w = await world();
  require('../src/ipc/copilot').register();
  assistantSearch.register(); // what src/server/app.ts registers at startup: the two indexes' describers
  require('../src/ipc/search').register();
  const replies: unknown[] = [];
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  let facts = '';
  (analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, sent: string) => { facts = sent; return replies.shift() ?? { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } }; };
  (analyze as { dispatch: unknown }).dispatch = async () => { throw new Error('no model call in this suite'); };
  const call = (ch: string, payload: object, who: Role = 'admin'): Promise<any> => as(who, () => handlers.get(ch)!({}, { projectId: w.P, ...payload }));
  const thread = async (agentId?: string, who: Role = 'admin'): Promise<string> => (await call('copilot:newThread', agentId ? { agentId } : {}, who)).thread.id;
  const answer = (spec: object) => ({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'revenue', spec } });
  const onOrders = { dataset: 'Orders', category: 'region', measures: [{ column: 'Revenue' }] }; // a metric by name

  // Each question is worded unlike the verified one ("Revenue by region"), which the app answers with no model call.
  const Q = 'revenue by region last year';
  // Warm both indexes (built lazily, once); a follow-up's conversation gets its first answer the same way, uncounted.
  const started = async (): Promise<string> => {
    replies.push(answer(onOrders));
    const first = await call('copilot:ask', { threadId: await thread(), context: {}, question: Q });
    if (!(first.ok && first.turns.at(-1)?.answer?.datasetId === w.orders && first.provenance?.kind === 'project')) throw new Error('fixture: a first answer ' + JSON.stringify(first).slice(0, 300));
    return first.threadId as string;
  };
  ok('fixture: an ask from Home answers with the chart, from the model', !!(await started()));

  type Case = { name: string; reply: unknown; ask: () => Promise<object>; right: (r: any) => boolean; who?: Role; formula?: true; prompted?: string };
  const shared = /Order share\b[^\n]*\b5\b/; // its figure in the facts: Revenue (15) / 3
  const FACTS_LINE = '- sales_live (source table of "Sales live" · ~5.0K rows)';
  const cases: Case[] = [
    { name: 'home', reply: answer(onOrders), ask: async () => ({ threadId: await thread(), context: {}, question: Q }), right: (r) => r.provenance?.kind === 'project' && r.turns.at(-1)?.answer?.datasetId === w.orders },
    { name: 'Live dataset open, with table facts', reply: { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } }, ask: async () => ({ threadId: await thread(), context: { kind: 'dataset', id: w.live }, question: 'amount by region' }), right: (r) => r.provenance?.kind === 'dataset', prompted: FACTS_LINE },
    { name: 'dataset open', formula: true, reply: answer({ category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }] }), ask: async () => ({ threadId: await thread(), context: { kind: 'dataset', id: w.orders }, question: 'amount by region' }), right: (r) => r.provenance?.kind === 'dataset' && r.turns.at(-1)?.answer?.datasetId === w.orders },
    { name: 'dashboard', formula: true, reply: answer(onOrders), ask: async () => ({ threadId: await thread(), context: { kind: 'analysis', id: w.board }, question: Q }), right: (r) => r.provenance?.kind === 'analysis' && r.turns.at(-1)?.answer?.datasetId === w.orders },
    { name: 'agent, inside', reply: answer(onOrders), ask: async () => ({ threadId: await thread(w.agent), context: {}, question: Q }), right: (r) => r.agent?.id === w.agent && r.turns.at(-1)?.answer?.datasetId === w.orders },
    { name: 'agent, outside', reply: { ok: true, text: 'Not here.', suggestedAction: { kind: 'outside', intent: 'refunds' } }, ask: async () => ({ threadId: await thread(w.agent), context: {}, question: 'refunds by reason' }), right: (r) => r.turns.at(-1)?.outside?.dataset === 'Returns' && r.turns.at(-1)?.text === `${msg.outsideTopic('Retail')}\n${msg.outsideOffer('Returns')}` },
    { name: 'agent, answer outside', reply: answer({ dataset: 'Returns', category: 'reason', measures: [{ column: 'refunds', aggregation: 'sum' }] }), ask: async () => ({ threadId: await thread(w.agent), context: {}, question: 'refunds by reason' }), right: (r) => r.turns.at(-1)?.outside?.dataset === 'Returns' && !r.turns.at(-1)?.answer },
    { name: 'typo (Did you mean)', reply: answer({ dataset: 'Order', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }] }), ask: async () => ({ threadId: await thread(), context: {}, question: 'amount by region' }), right: (r) => r.turns.at(-1)?.suggest?.part === 'dataset' && r.turns.at(-1)?.suggest?.options?.[0]?.spec?.datasetId === w.orders },
    { name: 'follow-up', reply: answer({ refine: true, filters: [{ column: 'region', op: '=', value: 'West' }] }), ask: async () => ({ threadId: await started(), context: {}, question: 'only West' }), right: (r) => r.turns.at(-1)?.answer?.filters?.length === 1 && r.turns.at(-1)?.answer?.datasetId === w.orders },
    { name: 'viewer, a hidden column', who: 'viewer', reply: answer(onOrders), ask: async () => ({ threadId: await thread(undefined, 'viewer'), context: {}, question: 'order share by region' }), right: (r) => r.provenance?.kind === 'project' && r.turns.at(-1)?.answer?.datasetId === w.orders },
  ];
  ok('fixture: the viewer is restricted, and Orders\' cost is hidden from them', (await as('viewer', async () => [...await rowAccess.hiddenAnywhere(w.P)])).join() === 'cost');
  const run = async (c: Case) => {
    replies.length = 0;
    const payload = await c.ask();
    replies.length = 0;
    replies.push(structuredClone(c.reply));
    return listed(w.P, () => call('copilot:ask', payload, c.who));
  };
  for (const c of cases) {
    const r = await run(c);
    ok(`${c.name}: the ask answers as it should`, r.out.ok === true && c.right(r.out), JSON.stringify(r.out).slice(0, 400));
    ok(`${c.name}: no whole-project list (${r.calls.length})`, r.calls.length === 0, r.calls.join(', '));
    if (c.formula) ok(`${c.name}: …and the formula metric was computed: Order share's figure is in the facts`, shared.test(facts), facts.split('\n').filter((l) => l.includes('Order share')).join(' | ') || facts.slice(0, 300));
    if (c.prompted) ok(`${c.name}: the Live dataset's table facts are in the prompt`, facts.includes(c.prompted), facts.slice(facts.indexOf('SOURCE TABLE'), facts.indexOf('SOURCE TABLE') + 300));
  }
  assistantSearch._setIndexed(false);
  try {
    for (const c of cases) {
      const r = await run(c);
      ok(`NEGATIVE CONTROL: ${c.name}, the index off: the reference lists (${r.calls.length}: ${[...new Set(r.calls)].slice(0, 4).join(', ')})`, r.calls.length > 0 && r.out.ok === true && c.right(r.out), JSON.stringify(r.out).slice(0, 300));
      if (c.formula) ok(`NEGATIVE CONTROL: ${c.name}, the index off: …the formula's figure reads every metric by name`, r.calls.includes('metricsByName') && shared.test(facts));
    }
  } finally {
    assistantSearch._setIndexed(true);
  }
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    ok('without a database the index is never asked: every ask takes its reference path, the lists', !assistantSearch.indexedFor('11111111-1111-4111-8111-111111111111'));
    console.log('skip the no-list ask: DATABASE_URL is unset (without a database the lists are the path)');
    return;
  }
  const dbName = `ordinate_asknolists_${process.pid}_${Date.now()}`;
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
    await dbLeg();
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('no-list ask suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
