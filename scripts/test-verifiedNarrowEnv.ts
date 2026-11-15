// Checking verified questions against only what their charts name (src/ipc/verifiedState.ts `verifiedEnvFor`), and
// MCP answer_verified_question by the index (src/ipc/verifiedLookup.ts `verifiedNamed`). Records are files; with
// DATABASE_URL (a scratch database it may CREATE DATABASE on) every leg runs again over Postgres, and the MCP leg
// takes the index.
//
//   1. THE DIFFERENTIAL: for every candidate set (each question alone, every pair, all, all reversed), as an admin and
//      as a restricted viewer, `verifiedProblem` against the narrow env, and `statesOf`'s problem, hidden flag and tag,
//      are Object.is-equal to the whole env's. The world: a dataset gone, a column gone, a term gone, a term of another
//      dataset, a working term; a metric redefined, filtered, deleted, moved to another dataset, retired; a pending
//      kind; a layer metric on its dataset and on another; two metrics of one name on a dataset (the first is the
//      one the name means) and one of that name elsewhere; a column hidden from the viewer, and a metric reading it;
//      a dataset closed to the viewer by row rules, with and without a value filter.
//   2. NEGATIVE CONTROLS: a narrow env that drops a named metric, or the earlier metric of the same name, FAILS it.
//   3. READS: 20 candidates on a project of 300 more datasets, 600 metrics and 300 terms read about what their charts
//      name. NEGATIVE CONTROL: the whole env reads more records than the project holds.
//   4. MCP answer_verified_question: the same outcome (the answer, or the error code and message) as the reference
//      (every record checked) for an id, a question, a phrasing, a hidden one, a broken one, one left out, a wording
//      two share, and misses. With a database it takes the index: an id reads one record and lists none. NEGATIVE
//      CONTROL: the reference lists them all.
//   5. With a database, inside a read memo, readMany and readFile share what they read. NEGATIVE CONTROL: outside one
//      each reads again.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-verifiedNarrowEnv.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-narrowenv-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const statusStore: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const vs: typeof import('../src/ipc/verifiedState') = require('../src/ipc/verifiedState');
const lookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');
const tools: typeof import('../src/automation/verifiedTools') = require('../src/automation/verifiedTools');

type Identity = import('../src/server/context').Identity;
type VerifiedQuestion = import('../src/analysis/verifiedRules').VerifiedQuestion;
type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;
type Tagged = import('../src/app/editConflict').Tagged<VerifiedQuestion>;
type EnvFor = (projectId: string, qs: readonly VerifiedQuestion[]) => Promise<import('../src/ipc/verifiedState').VerifiedEnv>;

const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const HR_TEAM = '11111111-1111-4111-8111-111111111111';
let req = 0;
const as = <T>(who: Identity, fn: () => Promise<T>): Promise<T> => context.runInContext(who, `n${++req}`, fn);

interface World { P: string; orders: string; rev: string; unitsFirst: string; ids: Record<string, string> }

async function world(): Promise<World> {
  return as(ADMIN, async () => {
    await projects.init();
    const P = (await projects.createProject('Narrow env'))!.id;
    const make = async (name: string, columns: Array<[string, 'text' | 'number']>, rows: unknown[][]) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: columns.map(([n, type]) => ({ name: n, type })), rows: rows as never }))!.id;
    const orders = await make('Orders', [['region', 'text'], ['amount', 'number'], ['cost', 'number'], ['qty', 'text']], [['West', 10, 4, '2'], ['East', 20, 9, '3']]);
    const customers = await make('Customers', [['segment', 'text'], ['spend', 'number']], [['Retail', 5], ['Trade', 7]]);
    const layer = await make('Layer', [['region', 'text']], [['West']]);
    const gone = await make('Gone', [['k', 'text'], ['v', 'number']], [['a', 1]]);
    const metric = async (name: string, datasetId: string, definition: unknown, filters?: unknown) => {
      const m = await metrics.saveMetric(P, { name, datasetId, definition, filters });
      if (!m) throw new Error('fixture: metric ' + name);
      return m.id;
    };
    const sum = (column: string) => ({ column, aggregation: 'sum' });
    const rev = await metric('Revenue', orders, sum('amount'));
    const redefined = await metric('Average amount', orders, sum('amount')); // its question says avg
    const filtered = await metric('West amount', orders, sum('amount'), [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
    const deleted = await metric('Deleted', orders, sum('amount'));
    const moved = await metric('Moved', customers, sum('amount')); // its question is on Orders
    const retired = await metric('Old revenue', orders, sum('amount'));
    const pending = await metric('Revenue YTD', orders, { base: rev, window: { to_date: 'year' } });
    const mirror = await metric('Layer revenue', layer, { external: 'revenue' });
    const costly = await metric('Cost total', orders, sum('cost'));
    // Two of one name on Orders, both sum(qty) over a TEXT column: by name ("Units") it is the first of them, which
    // charts; as the column (`byName` refused because another comes first) it is a sum of text, which is refused.
    const units = [await metric('Units', orders, sum('qty')), await metric('units', orders, sum('qty'))];
    await metric('Revenue', customers, sum('spend')); // the same name on another dataset: no bearing
    await metrics.deleteMetric(P, deleted);
    await statusStore.retire(P, `metric:${retired}`, undefined, 'replaced');
    const order = (await answers.specMetrics(P)).map((m) => m.id);
    const [unitsFirst, unitsLater] = order.indexOf(units[0]) < order.indexOf(units[1]) ? units : [units[1], units[0]];
    const term = async (name: string, datasetId: string, column: string, value: string) =>
      (await terms.saveTerm(P, { name, datasetId, filters: [{ type: 'filter', column, op: '=', value }] }))!.id;
    const tWest = await term('West', orders, 'region', 'West');
    const tRetail = await term('Retail', customers, 'segment', 'Retail');

    // Hidden from the viewer: `cost` on Orders (no team of theirs may see it); Customers by its row rules (unreadable: closed).
    const hid = await rec.serialized(rec.datasetFilePath(P, orders), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'cost', visibleTo: [{ teamId: HR_TEAM }] }], ADMIN.user.email, new Date().toISOString());
      return true;
    });
    const closed = await rec.serialized(rec.datasetFilePath(P, customers), (raw) => { raw.rowPolicy = { unreadable: true }; return true; });
    if (!hid || !closed) throw new Error('fixture: access rules');

    const m = (column: string, aggregation: string, metricId?: string) => ({ column, aggregation, ...(metricId ? { metricId } : {}) });
    const spec = (datasetId: string, category: string, measures: unknown[], filters: unknown[] = []) => ({ datasetId, category, measures, filters, chartType: 'column', title: '' }) as AnswerSpec;
    const SAME_TIME = '2026-11-08T10:00:00.000Z';
    const rows: Array<[string, AnswerSpec, string[]?, string?]> = [
      ['Revenue by region', spec(orders, 'region', [m('amount', 'sum')]), ['revenue per region']],
      ['Profit by region', spec(orders, 'region', [m('profit', 'sum')])],
      ['Gone by k', spec(gone, 'k', [m('v', 'sum')])],
      ['West revenue', spec(orders, 'region', [m('amount', 'sum')], [{ term: tWest }])],
      ['Gone term revenue', spec(orders, 'region', [m('amount', 'sum')], [{ term: crypto.randomUUID() }])],
      ['Retail revenue on orders', spec(orders, 'region', [m('amount', 'sum')], [{ term: tRetail }])],
      ['Revenue metric by region', spec(orders, 'region', [m('amount', 'sum', rev)])],
      ['Average amount by region', spec(orders, 'region', [m('amount', 'avg', redefined)])],
      ['West amount by region', spec(orders, 'region', [m('amount', 'sum', filtered)])],
      ['Deleted by region', spec(orders, 'region', [m('amount', 'sum', deleted)])],
      ['Moved by region', spec(orders, 'region', [m('amount', 'sum', moved)])],
      ['Old revenue by region', spec(orders, 'region', [m('amount', 'sum', retired)])],
      ['Revenue YTD by region', spec(orders, 'region', [m('amount', 'sum', pending)])],
      ['Layer revenue by region', spec(layer, 'region', [m('', 'sum', mirror)])],
      ['Layer revenue on orders', spec(orders, 'region', [m('', 'sum', mirror)])],
      ['Cost by region', spec(orders, 'region', [m('cost', 'sum')])],
      ['Cost total by region', spec(orders, 'region', [m('cost', 'sum', costly)])],
      ['Units by region', spec(orders, 'region', [m('qty', 'sum', unitsLater)])],
      ['Retail spend by segment', spec(customers, 'segment', [m('spend', 'sum')], [{ column: 'segment', op: '=', value: 'Retail' }]), [], SAME_TIME],
      ['Spend by segment', spec(customers, 'segment', [m('spend', 'sum')]), ['retail spend by segment'], SAME_TIME], // a wording the one above has
    ];
    const ids: Record<string, string> = {};
    for (const [i, [question, s, phrasings = [], t = `2026-11-0${1 + (i % 7)}T1${i % 10}:00:00.000Z`]] of rows.entries()) {
      const q: VerifiedQuestion = { id: crypto.randomUUID(), projectId: P, question, phrasings, spec: s, verifiedBy: ADMIN.user.email, verifiedAt: t, createdAt: t, updatedAt: t, schemaVersion: 1 };
      if (!(await store.writeVerified(P, q))) throw new Error('fixture: verified ' + question);
      ids[question] = q.id;
    }
    await datasets.deleteDataset(P, gone);
    return { P, orders, rev, unitsFirst, ids };
  });
}

const pairs = <T>(xs: readonly T[]): T[][] => xs.flatMap((x, i) => xs.slice(i + 1).map((y) => [x, y]));

/** The narrow env (`envFor`) and the whole one agree on every candidate set, problem for problem and state for state. */
async function differential(w: World, who: Identity, envFor: EnvFor, label: string): Promise<boolean> {
  return as(who, async () => {
    const all = await store.listTagged(w.P);
    const full = await vs.verifiedEnv(w.P);
    let same = true;
    for (const set of [all, [...all].reverse(), ...all.map((t) => [t]), ...pairs(all)] as Tagged[][]) {
      const narrow = await envFor(w.P, set.map((t) => t.rec));
      for (const { rec: q } of set) {
        const [a, b] = [vs.verifiedProblem(q, narrow), vs.verifiedProblem(q, full)];
        if (!Object.is(a, b)) { same = false; if (set.length === 1) console.log(`  ${label}: "${q.question}" narrow ${a} / whole ${b}`); }
      }
      const [x, y] = [await vs.statesOf(w.P, set, narrow), await vs.statesOf(w.P, set, full)];
      const differs = x.length !== y.length || x.some((s, i) => !Object.is(s.q.id, y[i].q.id) || !Object.is(s.problem, y[i].problem) || !Object.is(s.hidden, y[i].hidden) || !Object.is(s.tag, y[i].tag));
      if (differs) same = false;
    }
    return same;
  });
}

/** The world is what the differential claims to cover: each case reads as it should under the whole env. */
async function fixtureLeg(w: World, mode: string): Promise<void> {
  const of = (who: Identity) => as(who, async () => {
    const full = await vs.verifiedEnv(w.P);
    const list = await store.listTagged(w.P);
    const states = await vs.statesOf(w.P, list, full);
    return { problems: new Map(list.map((t) => [t.rec.question, vs.verifiedProblem(t.rec, full)])), states: new Map(states.map((s) => [s.q.question, s])) };
  });
  const admin = await of(ADMIN);
  const runs = [...admin.problems].filter(([, p]) => p === null).map(([q]) => q).sort();
  const expected = ['Cost by region', 'Cost total by region', 'Layer revenue by region', 'Old revenue by region', 'Retail spend by segment', 'Revenue YTD by region',
    'Revenue by region', 'Revenue metric by region', 'Spend by segment', 'West revenue'];
  ok(`${mode}: fixture: under the whole env, exactly the working questions run (each other case is refused)`, JSON.stringify(runs) === JSON.stringify(expected), JSON.stringify([...admin.problems]));
  ok(`${mode}: fixture: the later of two same-name metrics is refused as a sum of text (the first one is what its name means)`, /text/.test(admin.problems.get('Units by region') ?? ''), admin.problems.get('Units by region') ?? 'null');
  const viewer = await of(VIEWER);
  ok(`${mode}: fixture: the viewer loses the questions on a hidden column; one on a closed dataset with a value filter is hidden, one without is not`,
    !viewer.states.has('Cost by region') && !viewer.states.has('Cost total by region') && viewer.states.get('Retail spend by segment')?.hidden === true
      && viewer.states.get('Spend by segment')?.hidden === false && admin.states.get('Retail spend by segment')?.hidden === false,
    JSON.stringify([...viewer.states].map(([q, s]) => [q, s.problem, s.hidden])));
}

/** Record reads (readFile calls, readMany paths, readdir calls, records a store's list read) while `fn` runs. */
async function reads<T>(fn: () => Promise<T>): Promise<{ out: T; reads: number; lists: number }> {
  const [readFile, readMany, readdir, listRecords, listTagged] = [recordFs.readFile, recordFs.readMany, recordFs.readdir, recordFs.listRecords, store.listTagged];
  let n = 0, lists = 0;
  const spy = recordFs as unknown as Record<'readFile' | 'readMany' | 'readdir' | 'listRecords', unknown>;
  spy.readFile = (...a: unknown[]) => { n++; return (readFile as (...x: unknown[]) => unknown)(...a); };
  spy.readMany = (ps: readonly string[]) => { n += ps.length; return readMany(ps); };
  spy.readdir = (...a: unknown[]) => { n++; return (readdir as (...x: unknown[]) => unknown)(...a); };
  spy.listRecords = async (dir: string) => {
    const listed = await listRecords(dir);
    return (async function* () { for await (const r of listed) { n++; yield r; } })();
  };
  (store as { listTagged: unknown }).listTagged = (p: string) => { lists++; return listTagged(p); };
  try {
    return { out: await fn(), reads: n, lists };
  } finally {
    Object.assign(spy, { readFile, readMany, readdir, listRecords });
    (store as { listTagged: unknown }).listTagged = listTagged;
  }
}

const SCALE = { datasets: 300, metrics: 600, terms: 300 };

/** Clones of Orders, its Revenue and its West term, and 40 questions on 20 clones: 20 by a term, 20 by a metric. */
async function seedScale(w: World): Promise<{ byTerm: VerifiedQuestion[]; byMetric: VerifiedQuestion[] }> {
  return as(ADMIN, async () => {
    const base = path.join(appPaths.userData(), 'projects', w.P);
    const read = async (p: string) => JSON.parse(await recordFs.readFile(p, 'utf8'));
    const [ds, metric, term] = [await read(rec.datasetFilePath(w.P, w.orders)), await read(path.join(base, 'metrics', w.rev + '.json')), (await terms.listFullTerms(w.P))[0]];
    const put = (p: string, body: unknown) => recordFs.writeFile(p, JSON.stringify(body), 'utf8');
    const dsIds = Array.from({ length: SCALE.datasets }, () => crypto.randomUUID());
    const metricIds: string[] = [], termIds: string[] = [];
    for (const [i, id] of dsIds.entries()) await put(rec.datasetFilePath(w.P, id), { ...ds, id, name: `Clone ${i}` });
    for (let i = 0; i < SCALE.metrics; i++) {
      const id = crypto.randomUUID();
      metricIds.push(id);
      await put(path.join(base, 'metrics', id + '.json'), { ...metric, id, name: `Revenue ${i}`, datasetId: dsIds[i % SCALE.datasets] });
    }
    for (let i = 0; i < SCALE.terms; i++) {
      const id = crypto.randomUUID();
      termIds.push(id);
      await put(path.join(base, 'terms', id + '.json'), { ...term, id, name: `West ${i}`, datasetId: dsIds[i] });
    }
    const question = async (n: number, measure: object, filters: unknown[]): Promise<VerifiedQuestion> => {
      const t = '2026-10-01T10:00:00.000Z';
      const q: VerifiedQuestion = { id: crypto.randomUUID(), projectId: w.P, question: `Clone question ${n}`, phrasings: [], verifiedBy: ADMIN.user.email, verifiedAt: t, createdAt: t, updatedAt: t, schemaVersion: 1,
        spec: { datasetId: dsIds[n % 20], category: 'region', measures: [measure as AnswerSpec['measures'][number]], filters: filters as AnswerSpec['filters'], chartType: 'column', title: '' } };
      return (await store.writeVerified(w.P, q))!;
    };
    const byTerm: VerifiedQuestion[] = [], byMetric: VerifiedQuestion[] = [];
    for (let i = 0; i < 20; i++) byTerm.push(await question(i, { column: 'amount', aggregation: 'sum' }, [{ term: termIds[i % 20] }]));
    for (let i = 0; i < 20; i++) byMetric.push(await question(20 + i, { column: 'amount', aggregation: 'sum', metricId: metricIds[i] }, []));
    return { byTerm, byMetric };
  });
}

async function readsLeg(w: World, mode: string): Promise<void> {
  const { byTerm, byMetric } = await seedScale(w);
  const held = SCALE.datasets + SCALE.metrics + SCALE.terms;
  await as(ADMIN, async () => {
    const full = await reads(() => vs.verifiedEnv(w.P));
    const terms20 = await reads(() => vs.verifiedEnvFor(w.P, byTerm));
    const metrics20 = await reads(() => vs.verifiedEnvFor(w.P, byMetric));
    console.log(`  ${mode}: checking 20 candidates reads ${terms20.reads} records (by a term) and ${metrics20.reads} (by a metric); the whole env ${full.reads}`);
    ok(`${mode}: 20 candidates by a term read only what they name (${terms20.reads} ≤ ${4 * 20 + 10})`, terms20.reads <= 4 * 20 + 10);
    ok(`${mode}: 20 candidates by a metric read the metric list and what they name (${metrics20.reads} ≤ ${SCALE.metrics + 30 + 6 * 20})`, metrics20.reads <= SCALE.metrics + 30 + 6 * 20);
    ok(`${mode}: NEGATIVE CONTROL: the whole env reads more records than the project holds (${full.reads} > ${held})`, full.reads > held);
    const same = (qs: VerifiedQuestion[], env: typeof full.out) => qs.every((q) => Object.is(vs.verifiedProblem(q, env), vs.verifiedProblem(q, full.out)));
    ok(`${mode}: …and the 40 read the same there as against the whole env`, same(byTerm, terms20.out) && same(byMetric, metrics20.out));
  });
}

/** What the tool says: its answer, or its error code and message. */
const outcome = (who: Identity, P: string, asked: string): Promise<string> => as(who, () => tools.answerVerifiedQuestion({ projectId: P } as never, asked).then(
  (r) => JSON.stringify({ ok: true, r }), (e: { code?: string; message?: string }) => JSON.stringify({ ok: false, code: e.code, message: e.message })));

async function mcpLeg(w: World, mode: string, db: boolean): Promise<void> {
  const asked = [w.ids['Revenue by region'], 'Revenue by region', 'REVENUE per region?', w.ids['Profit by region'], 'profit by region', 'Retail spend by segment',
    'Cost by region', w.ids['Cost by region'], 'retail spend by segment', 'nope', '???', '', crypto.randomUUID(), w.ids['Gone by k']];
  let same = true;
  const seen = new Set<string>();
  for (const who of [ADMIN, VIEWER]) for (const a of asked) {
    const got = await outcome(who, w.P, a);
    const named = await as(who, () => lookup.verifiedNamed(w.P, a));
    const reference = await as(who, () => lookup.referenceNamed(w.P, a));
    let old = got;
    if (db) { // the reference path, records still in Postgres: without the org database, `indexedOr` takes it
      inOrg.useOrgDb(null);
      try { old = await outcome(who, w.P, a); } finally { inOrg.useOrgDb(db ? pool! : null); }
    }
    const fields = (s: typeof named) => [s?.q.id ?? null, s?.problem ?? null, s?.hidden ?? null, s?.tag ?? null];
    if (!Object.is(got, old) || !fields(named).every((x, i) => Object.is(x, fields(reference)[i]))) { same = false; console.log(`  ${mode} differs for ${who.user.role} "${a}":`, got.slice(0, 160), old.slice(0, 160)); }
    seen.add(JSON.parse(got).ok ? 'answered' : JSON.parse(got).code);
  }
  ok(`${mode}: MCP answer_verified_question answers as the reference does, outcome for outcome and question for question`, same);
  ok(`${mode}: …over answers, not_found and runtime refusals`, seen.has('answered') && seen.has('not_found') && seen.has('runtime'), [...seen].join());
  const hidden = JSON.parse(await outcome(VIEWER, w.P, w.ids['Retail spend by segment'])); // by id: its wording is another's phrasing
  ok(`${mode}: hidden from the viewer: not_found; broken: the problem as a runtime error`,
    hidden.code === 'not_found' && JSON.parse(await outcome(ADMIN, w.P, 'Profit by region')).code === 'runtime');
  if (!db) return; // a folder of files lists in no fixed order; Postgres's lists by name
  const shared = await as(ADMIN, () => lookup.verifiedNamed(w.P, 'retail spend by segment'));
  const tie = [w.ids['Retail spend by segment'], w.ids['Spend by segment']].sort()[0];
  ok(`${mode}: a wording two questions share, at the same time: the first by id, as their folder lists them`, shared?.q.id === tie);
  const byId = await as(ADMIN, () => reads(() => lookup.indexedNamed(w.P, w.ids['Revenue by region'])));
  ok(`${mode}: by id through the index: that question, no list`, byId.out?.s?.q.id === w.ids['Revenue by region'] && byId.lists === 0, JSON.stringify({ lists: byId.lists, reads: byId.reads }));
  const tool = await reads(() => outcome(ADMIN, w.P, 'REVENUE per region?'));
  ok(`${mode}: …and the tool itself takes the index: answered, no list`, JSON.parse(tool.out).ok === true && tool.lists === 0, JSON.stringify({ lists: tool.lists }));
  const miss = await as(ADMIN, () => reads(() => lookup.indexedNamed(w.P, 'nope')));
  ok(`${mode}: a miss reads no record at all`, miss.out?.s === null && miss.reads === 0 && miss.lists === 0, JSON.stringify({ reads: miss.reads }));
  const ref = await as(ADMIN, () => reads(() => lookup.referenceNamed(w.P, w.ids['Revenue by region'])));
  ok(`${mode}: NEGATIVE CONTROL: the reference lists every question`, ref.lists === 1);
}

/** Postgres statements while `fn` runs. */
async function statements<T>(fn: () => Promise<T>): Promise<number> {
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const query = proto.query;
  let n = 0;
  proto.query = function (this: unknown, ...a: unknown[]) { n++; return query.apply(this, a); };
  try { await fn(); } finally { proto.query = query; }
  return n;
}

/** The narrow env's one readMany shares the question's read memo: what it read, readFile reads from there, and back. */
async function memoLeg(w: World): Promise<void> {
  const [a, b] = [rec.datasetFilePath, (id: string) => path.join(appPaths.userData(), 'projects', w.P, 'metrics', id + '.json')];
  await as(ADMIN, async () => {
    const after = await recordFs.withReadMemo(async () => {
      await recordFs.readMany([a(w.P, w.orders)]);
      return statements(() => recordFs.readFile(a(w.P, w.orders), 'utf8'));
    });
    const before = await recordFs.withReadMemo(async () => {
      await recordFs.readFile(b(w.rev), 'utf8');
      return statements(() => recordFs.readMany([b(w.rev)]));
    });
    const outside = await statements(async () => { await recordFs.readMany([a(w.P, w.orders)]); await recordFs.readFile(a(w.P, w.orders), 'utf8'); });
    ok('postgres: inside a read memo, a record readMany read is readFile\'s with no query, and one readFile read is readMany\'s', after === 0 && before === 0, JSON.stringify({ after, before }));
    ok('postgres: NEGATIVE CONTROL: outside a memo, each reads it again', outside > 0);
  });
}

async function legs(mode: string, db: boolean): Promise<void> {
  const w = await world();
  await fixtureLeg(w, mode);
  for (const who of [ADMIN, VIEWER]) {
    ok(`${mode}: THE DIFFERENTIAL as ${who.user.role}: narrow env === whole env, for every candidate set`, await differential(w, who, vs.verifiedEnvFor, `${mode} ${who.user.role}`));
  }
  const dropping = (id: string): EnvFor => async (p, qs) => { const e = await vs.verifiedEnvFor(p, qs); return { ...e, metrics: e.metrics.filter((m) => m.id !== id) }; };
  ok(`${mode}: NEGATIVE CONTROL: a narrow env without a named metric FAILS the differential`, !(await differential(w, ADMIN, dropping(w.rev), 'without Revenue (expected)')));
  ok(`${mode}: NEGATIVE CONTROL: …and one without the earlier metric of the same name`, !(await differential(w, ADMIN, dropping(w.unitsFirst), 'without the first Units (expected)')));
  await mcpLeg(w, mode, db);
  if (db) await memoLeg(w);
  await readsLeg(w, mode);
}

let pool: Pool | null = null;

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  await legs('files', false);
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_narrowenv_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool);
    await legs('postgres', true);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('narrow env suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
