// An ask through step 3's index answers as through every list of the project (docs/assistant/00-design.md, "Scale
// rules", PR 6b). Each pair runs the SAME code with the index on and off (../src/ipc/assistantSearch `_setIndexed`: off
// is the reference path, as without a database), compared with Object.is on the whole outcome, for an admin and a viewer
// one column is hidden from (and a metric on it, so neither is ever a word of theirs).
//
// Always (no database): the exact-lookup keys compare names as the answer validator does (trimmed and lowercased; squashed).
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   1. Home's picks (../src/ipc/homeFacts picksFrom: the 12 datasets step 3 ranks, the newest after them, the metrics and
//      terms that match), index === reference, over questions that match many, few or no names. The counts of visuals and
//      dashboards (⌘K's index) === the lists', for an editor and a viewer who sees only what is published.
//   2. An agent's outside-the-topic check (../src/ipc/agentAsk matchOutside), index === reference, questions × topics.
//   3. THE VALIDATION DIFFERENTIAL: a corpus of model answers (valid; names in the wrong case; squashed; by id; an unknown
//      dataset; an unknown column; a metric by name, the first of two of that name; a metric of another dataset; a
//      term by an other name; a term of another dataset; a typo needing "Did you mean"; two datasets one name cannot tell
//      apart; no dataset named; a hidden column; a hidden metric; a follow-up carrying a metric) × context (Home, a
//      dataset open, an agent's topic) through ../src/ipc/answerCheck checkAction: the outcome and every suggestion are
//      the whole vocabulary's. The same for answers.namedDataset and answers.previousAnswer. The exact lookups
//      (keyedModel, newestModel) === their references.
//   4. NEGATIVE CONTROLS: the corpus is told apart (ok, refused, with suggestions); with the said names' squashed key
//      left out, the differential FAILS (a squashed name is no longer found); the hidden column is the admin's word only.
//   5. A write from the release before 0028 (0027's flag, not the keys') drops that source's marker; the next lookup
//      rebuilds it. NEGATIVE CONTROL: a write with both flags drops none.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-askIndex.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askindex-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const columnAccess: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const cmdK: typeof import('../src/ipc/search') = require('../src/ipc/search');
const homeFacts: typeof import('../src/ipc/homeFacts') = require('../src/ipc/homeFacts');
const agentAsk: typeof import('../src/ipc/agentAsk') = require('../src/ipc/agentAsk');
const answerCheck: typeof import('../src/ipc/answerCheck') = require('../src/ipc/answerCheck');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const sv: typeof import('../src/ipc/specVocabulary') = require('../src/ipc/specVocabulary');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const WHO: Array<[string, Identity]> = [['admin', ADMIN], ['viewer', VIEWER]];

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `x${++req}`, async () => {
    if (P && who === VIEWER) caller.seedRank(P, 1); // what the RPC route seeds from `authorize`
    return fn();
  });

/** `fn` with the index on, then off (the reference), as JSON: what must be Object.is-equal. */
async function both(who: Identity, P: string, fn: () => Promise<unknown>): Promise<[string, string]> {
  const on = JSON.stringify(await as(who, P, () => recordFs.withReadMemo(fn)));
  search._setIndexed(false);
  try {
    return [on, JSON.stringify(await as(who, P, () => recordFs.withReadMemo(fn)))];
  } finally {
    search._setIndexed(true);
  }
}

function keysLeg(): void {
  ok('keys: a name trimmed and lowercased is one key', search.lowerKey(' Orders ') === search.lowerKey('orders') && search.lowerKey('Orders') !== search.lowerKey('Order'));
  ok('keys: squashed, "Order lines" and "order_lines" are one', search.squashKey('Order lines')[0] === search.squashKey('order_lines')[0] && search.squashKey('Order lines').length === 1);
  ok('keys: a name of symbols only has no squashed key (the validator matches nothing by it)', search.squashKey('--').length === 0);
  ok('keys: a key never holds a space (stored joined)', ![search.lowerKey('a b c'), ...search.squashKey('a b'), search.onKey('x')].some((k) => k.includes(' ')));
}

interface World { P: string; orders: string; lines: string; stores: string; returns: string; revenue: string; revenueOld: string; costTotal: string }

async function world(): Promise<World> {
  return as(ADMIN, null, async () => {
    await projects.init();
    const P = (await projects.createProject('Ask index')).id;
    const num = (name: string) => ({ name, type: 'number' as const });
    const txt = (name: string) => ({ name, type: 'text' as const });
    const save = async (name: string, columns: Array<{ name: string; type: 'text' | 'number' }>) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows: [columns.map((c) => (c.type === 'number' ? 1 : 'x'))] as never }))!.id;
    const orders = await save('Orders', [txt('region'), num('amount'), num('cost'), txt('channel')]);
    const lines = await save('Order lines', [txt('sku'), num('quantity'), txt('region')]);
    const stores = await save('Stores', [txt('city'), num('sales')]);
    const returns = await save('Returns', [txt('reason'), num('refunds'), txt('region')]);
    await save('Sales', [txt('rep'), num('total')]);
    await save('SALES', [txt('rep'), num('total')]); // two datasets one name cannot tell apart
    await save('Customer data', [txt('segment'), num('lifetime_value')]);
    for (let i = 0; i < 14; i++) await save(`Clone ${i}`, [txt('page'), num('views')]); // more than Home's 12
    await catalog.setColumn(P, orders, 'region', { aliases: ['territory'], displayName: 'Sales region', description: 'Where the order shipped' });
    await catalog.setDoc(P, `dataset:${returns}`, { description: 'Refunds and their reasons' });
    const metric = async (name: string, datasetId: string, column: string) => (await metrics.saveMetric(P, { name, datasetId, definition: { column, aggregation: 'sum' } }))!.id;
    const revenueOld = await metric('revenue', orders, 'cost'); // the same name twice on Orders: the first in list order is the one meant
    const revenue = await metric('Revenue', orders, 'amount');
    await metric('Revenue', returns, 'refunds'); // and on another dataset
    await metric('Refund total', returns, 'refunds');
    const costTotal = await metric('Cost total', orders, 'cost'); // reads the column hidden from the viewer
    await terms.saveTerm(P, { name: 'West', aliases: ['Western region'], datasetId: orders, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] });
    await terms.saveTerm(P, { name: 'Damaged', aliases: [], datasetId: returns, filters: [{ type: 'filter', column: 'reason', op: '=', value: 'damaged' }] });
    await record.serialized(record.datasetFilePath(P, orders), (raw) => {
      raw.columnAccess = columnAccess.buildColumnAccess(raw, [{ column: 'cost', visibleTo: [{ userId: '33333333-3333-4333-8333-333333333333' }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    const v = (await visuals.saveVisual(P, { name: 'Revenue by region', datasetId: orders, chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } }))!;
    await analysis.saveAnalysis(P, { name: 'Draft board', sheets: [{ name: 'S1', cards: [{ type: 'visual', layout: { x: 0, y: 0, w: 3, h: 3 }, visualId: v.id }] }] }); // a draft: editors only
    return { P, orders, lines, stores, returns, revenue, revenueOld, costTotal };
  });
}

async function homeLeg(w: World): Promise<void> {
  const indexed: import('../src/ipc/homeFacts').PickSources = {
    search: async (p, q, o) => { const r = await search.indexedModel(p, q, o); if (!r) throw new Error('no index'); return r; },
    newest: async (p, n) => { const r = await search.newestModel(p, 'dataset', n); if (!r) throw new Error('no index'); return r; },
  };
  const reference: import('../src/ipc/homeFacts').PickSources = { search: search.referenceModel, newest: (p, n) => search.newestReference(p, 'dataset', n) };
  const unequal: string[] = [];
  const seen = new Set<string>();
  for (const [who, id] of WHO) for (const q of ['what data do we have?', 'revenue by region', 'orders', 'cost by region', 'refunds by reason', 'territory', 'zzz', '']) {
    const [a, b] = [JSON.stringify(await as(id, w.P, () => homeFacts.picksFrom(w.P, q, indexed))), JSON.stringify(await as(id, w.P, () => homeFacts.picksFrom(w.P, q, reference)))];
    if (!Object.is(a, b)) unequal.push(`${who} "${q}": ${a} vs ${b}`);
    seen.add(a);
  }
  ok('1. Home\'s picks: the index\'s are the reference\'s, every question, admin and viewer', unequal.length === 0, unequal.join('\n'));
  ok('…NEGATIVE CONTROL: the questions pick differently (the comparison can tell)', seen.size >= 4, seen.size);
  const picks = await as(ADMIN, w.P, () => homeFacts.picksFrom(w.P, 'what data do we have?', indexed));
  ok('…a question that names nothing still sees 12 datasets, the newest', picks.datasetIds.length === homeFacts.HOME_DATASETS, JSON.stringify(picks));
  const [costV, costA] = [await as(VIEWER, w.P, () => homeFacts.picksFrom(w.P, 'cost total', indexed)), await as(ADMIN, w.P, () => homeFacts.picksFrom(w.P, 'cost total', indexed))];
  ok('…a metric on a column hidden from the viewer is never picked for them; NEGATIVE CONTROL: the admin\'s', !costV.metricIds.includes(w.costTotal) && costA.metricIds.includes(w.costTotal), JSON.stringify([costV.metricIds, costA.metricIds]));
  for (const [who, id] of WHO) {
    const [a, b] = [await as(id, w.P, () => cmdK.countNamed(w.P)), await as(id, w.P, () => cmdK.countListed(w.P))];
    ok(`…${who}: the visuals and dashboards counted off ⌘K's index are the lists' (${JSON.stringify(a)})`, Object.is(JSON.stringify(a), JSON.stringify(b)) && a.dashboards === (who === 'admin' ? 1 : 0));
  }
}

async function outsideLeg(w: World): Promise<void> {
  const unequal: string[] = [];
  const seen = new Set<string>();
  const indexedSearch = async (p: string, q: string, o: import('../src/ipc/assistantSearch').SearchOptions) => { const r = await search.indexedModel(p, q, o); if (!r) throw new Error('no index'); return r; };
  for (const [who, id] of WHO) for (const only of [[w.orders], [w.orders, w.returns], [w.stores]]) for (const q of ['refunds by reason', 'revenue by region and channel', 'territory', 'quantity of sku', 'cost', 'weather']) {
    const set = new Set(only);
    const [a, b] = [await as(id, w.P, () => agentAsk.matchOutside(w.P, q, set, undefined, indexedSearch)), await as(id, w.P, () => agentAsk.matchOutside(w.P, q, set, undefined, search.referenceModel))];
    if (!Object.is(JSON.stringify(a), JSON.stringify(b))) unequal.push(`${who} "${q}" ${only.length}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    seen.add(JSON.stringify(a));
  }
  ok('2. the outside-the-topic check: the index\'s match is the reference\'s, every question and topic, admin and viewer', unequal.length === 0, unequal.join('\n'));
  ok('…NEGATIVE CONTROL: it finds different datasets, and none for the weather', seen.size >= 3 && seen.has('null'), [...seen].join(' '));
  const outside = await as(ADMIN, w.P, () => agentAsk.matchOutside(w.P, 'refunds by reason', new Set([w.orders])));
  ok('…"refunds by reason" outside a topic of Orders is Returns; inside one holding Returns, never Returns', outside?.id === w.returns && (await as(ADMIN, w.P, () => agentAsk.matchOutside(w.P, 'refunds by reason', new Set([w.orders, w.returns]))))?.id !== w.returns);
}

/** The corpus: a model's answer action, and the follow-up's previous answer when there is one. */
function corpus(w: World): Array<{ name: string; spec: Record<string, unknown>; previous?: import('../src/ai/answerSpec').AnswerSpec }> {
  const by = (dataset: unknown, category: string, measures: unknown[], extra: object = {}) => ({ ...(dataset === undefined ? {} : { dataset }), category, measures, ...extra });
  const sum = (column: string) => ({ column, aggregation: 'sum' });
  return [
    { name: 'valid', spec: by('Orders', 'region', [sum('amount')]) },
    { name: 'wrong case', spec: by(' ORDERS ', 'REGION', ['sum(Amount)']) },
    { name: 'squashed', spec: by('order-lines', 'sku', [sum('quantity')]) },
    { name: 'by id', spec: by(w.stores, 'city', [sum('sales')]) },
    { name: 'unknown dataset', spec: by('Inventory', 'sku', [sum('quantity')]) },
    { name: 'unknown column', spec: by('Orders', 'regoin', [sum('amount')]) },
    { name: 'unknown measure', spec: by('Orders', 'region', [sum('amout')]) },
    { name: 'metric by name (first of two)', spec: by('Orders', 'region', [{ column: 'Revenue' }]) },
    { name: 'metric of another dataset', spec: by('Stores', 'city', [{ column: 'Refund total' }]) },
    { name: 'term by other name', spec: by('Orders', 'region', [sum('amount')], { filters: [{ term: 'western REGION' }] }) },
    { name: 'term of another dataset', spec: by('Orders', 'region', [sum('amount')], { filters: [{ term: 'Damaged' }] }) },
    { name: 'unknown term', spec: by('Orders', 'region', [sum('amount')], { filters: [{ term: 'Eastern' }] }) },
    { name: 'typo: Did you mean', spec: by('Order', 'region', [sum('amount')]) },
    { name: 'typo: refunds', spec: by('Return', 'reason', [sum('refunds')]) },
    { name: 'one name, two datasets', spec: by('sales', 'rep', [sum('total')]) },
    { name: 'no dataset named', spec: by(undefined, 'region', [sum('amount')]) },
    { name: 'hidden column', spec: by('Orders', 'region', [sum('cost')]) },
    { name: 'hidden metric', spec: by('Orders', 'region', [{ column: 'Cost total' }]) },
    { name: 'follow-up carrying a metric', spec: { refine: true, filters: [{ column: 'region', op: '=', value: 'West' }] },
      previous: { datasetId: w.orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum', metricId: w.revenue }], filters: [{ term: '00000000-0000-4000-8000-000000000000' }], chartType: 'column', title: 'Revenue by region' } },
    { name: 'follow-up, a new subject', spec: by('Returns', 'reason', [{ column: 'revenue' }]),
      previous: { datasetId: w.orders, category: 'region', measures: [{ column: 'cost', aggregation: 'sum', metricId: w.revenueOld }], filters: [], chartType: 'column', title: 'Old revenue' } },
  ];
}

async function validationLeg(w: World): Promise<void> {
  const contexts: Array<[string, { kind?: string; id?: string }, ReadonlySet<string> | undefined]> = [
    ['Home', {}, undefined], ['dataset open', { kind: 'dataset', id: w.orders }, undefined], ['agent topic', {}, new Set([w.orders, w.stores])],
  ];
  const unequal: string[] = [];
  const outcomes = new Set<string>();
  const check = (c: ReturnType<typeof corpus>[number], ctx: { kind?: string; id?: string }, only?: ReadonlySet<string>) =>
    answerCheck.checkAction(w.P, ctx, { kind: 'answer', intent: c.name, spec: structuredClone(c.spec) }, c.name, c.previous, undefined, only);
  const run = async (squashed: boolean): Promise<string[]> => {
    const out: string[] = [];
    for (const [who, id] of WHO) for (const [where, ctx, only] of contexts) for (const c of corpus(w)) {
      const [a, b] = await both(id, w.P, () => check(c, ctx, only));
      if (!Object.is(a, b)) out.push(`${who} ${where} ${c.name}:\n  index     ${a}\n  reference ${b}`);
      if (squashed) outcomes.add(JSON.parse(a).ok ? 'ok' : JSON.parse(a).suggest ? 'suggest' : 'refused');
    }
    return out;
  };
  unequal.push(...await run(true));
  ok(`3. THE VALIDATION DIFFERENTIAL: ${corpus(w).length} model answers × ${contexts.length} contexts × admin and viewer, outcome and suggestions === the whole vocabulary's`, unequal.length === 0, unequal.join('\n'));
  ok('…NEGATIVE CONTROL: the corpus is told apart (charted, refused, refused with "Did you mean")', outcomes.size === 3, [...outcomes].join());
  const outcome = async (who: Identity, name: string) => as(who, w.P, () => recordFs.withReadMemo(() => check(corpus(w).find((c) => c.name === name)!, {})));
  const typo = await outcome(ADMIN, 'typo: Did you mean');
  ok('…a typo is offered the dataset step 3 finds for it', !typo.ok && typo.suggest?.options[0]?.spec.datasetId === w.orders, JSON.stringify(typo));
  const first = await outcome(ADMIN, 'metric by name (first of two)');
  const listFirst = [w.revenueOld, w.revenue].sort()[0]; // "revenue" and "Revenue" sort equal by name: then as the store lists them, by id
  ok('…a metric by name is the first of its name on the dataset, as the list orders them', first.ok && first.spec.measures[0].metricId === listFirst, JSON.stringify(first));
  const [hiddenA, hiddenV] = [await outcome(ADMIN, 'hidden column'), await outcome(VIEWER, 'hidden column')];
  ok('…NEGATIVE CONTROL: the hidden column is the admin\'s word, never the viewer\'s (nor offered to them)', hiddenA.ok && !hiddenV.ok && !JSON.stringify(hiddenV).includes('"cost"'), JSON.stringify(hiddenV));

  // namedDataset (an agent's out-of-scope check) and previousAnswer (a follow-up), on and off.
  const named: string[] = [];
  for (const [who, id] of WHO) for (const c of corpus(w)) {
    const [a, b] = await both(id, w.P, () => answers.namedDataset(w.P, { kind: 'answer', intent: c.name, spec: structuredClone(c.spec) }));
    if (!Object.is(a, b)) named.push(`${who} ${c.name}: ${a} vs ${b}`);
    if (c.previous) {
      const turns = [{ id: 't', role: 'assistant', text: '', createdAt: '', answer: c.previous }] as never;
      const [x, y] = await both(id, w.P, () => answers.previousAnswer(w.P, turns));
      if (!Object.is(x, y)) named.push(`${who} previous ${c.name}: ${x} vs ${y}`);
    }
  }
  ok('…namedDataset and previousAnswer: the index\'s answers are the reference\'s', named.length === 0, named.join('\n'));

  // The exact lookups themselves, against their references.
  const lookups: string[] = [];
  for (const [kind, keys] of [['dataset', [search.lowerKey('sales'), ...search.squashKey('order lines')]], ['metric', [search.lowerKey('revenue'), search.onKey(w.returns)]], ['term', [search.lowerKey('western region'), search.onKey(w.orders)]]] as const) {
    const [a, b] = [await as(ADMIN, w.P, () => search.keyedModel(w.P, kind, keys)), await as(ADMIN, w.P, () => search.keyedReference(w.P, kind, keys))];
    if (!Object.is(JSON.stringify(a), JSON.stringify(b)) || !a?.length) lookups.push(`${kind}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  for (const retired of [false, true]) {
    const [a, b] = [await as(ADMIN, w.P, () => search.newestModel(w.P, 'dataset', 5, retired)), await as(ADMIN, w.P, () => search.newestReference(w.P, 'dataset', 5, retired))];
    if (!Object.is(JSON.stringify(a), JSON.stringify(b))) lookups.push(`newest ${retired}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  ok('…the exact lookups (by name, by dataset, the newest) === their references', lookups.length === 0, lookups.join('\n'));

  // NEGATIVE CONTROL: without the squashed key of what was said, "order-lines" is no longer found by the index.
  const real = search.squashKey;
  (search as { squashKey: unknown }).squashKey = () => [];
  try {
    const broken = await run(false);
    ok('…NEGATIVE CONTROL: with the said names\' squashed key left out, the differential FAILS', broken.some((x) => x.includes('squashed')), broken.length);
  } finally {
    (search as { squashKey: unknown }).squashKey = real;
  }
  ok('…and the vocabulary is the index\'s at all (not the reference\'s by accident)', !!(await as(ADMIN, w.P, () => sv.vocabularyFor(w.P, { specs: [corpus(w)[0].spec] }))));
}

/** 5. A write that keeps 0027's rows but no keys (the release before 0028) drops its source's marker; NEGATIVE CONTROL: one with keys does not. */
async function olderPodLeg(pool: Pool, w: World): Promise<void> {
  await as(ADMIN, w.P, () => search.keyedModel(w.P, 'metric', [search.lowerKey('revenue')])); // every source built
  const built = async (): Promise<string[]> => (await pool.query('SELECT source FROM assistant_search_built WHERE project_id = $1 AND version = 2 ORDER BY source', [w.P])).rows.map((r: { source: string }) => r.source);
  const before = await built();
  const write = async (keys: boolean): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SELECT set_config('ordinate.org', 'acme', true), set_config('ordinate.assistant_search', 'on', true)${keys ? ", set_config('ordinate.assistant_search_keys', 'on', true)" : ''}`);
      await c.query(`UPDATE records SET body = body WHERE org_id = 'acme' AND path = $1`, [`projects/${w.P}/metrics/${w.revenue}.json`]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };
  await write(true);
  ok('5. NEGATIVE CONTROL: a write that keeps the keys leaves every marker', JSON.stringify(await built()) === JSON.stringify(before) && before.length === 5, before);
  await write(false);
  const after = await built();
  ok('…one from the release before 0028 (no keys) drops its source\'s marker, and only it', !after.includes('metrics') && after.length === 4, after);
  const again = await as(ADMIN, w.P, () => search.keyedModel(w.P, 'metric', [search.lowerKey('revenue')]));
  ok('…and the next lookup rebuilds it, keys and all', (await built()).length === 5 && !!again?.some((h) => h.id === w.revenue), again);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  keysLeg();
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the index differentials: DATABASE_URL is unset (without a database the reference is the only path)');
    return;
  }
  const dbName = `ordinate_askindex_${process.pid}_${Date.now()}`;
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
    search.register();
    cmdK.register();
    const w = await world();
    await homeLeg(w);
    await outsideLeg(w);
    await validationLeg(w);
    await olderPodLeg(pool, w);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('ask index suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
