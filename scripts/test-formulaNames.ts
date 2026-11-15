// A formula metric's figure reads only the metrics it names (docs/assistant/00-design.md, "Scale rules": no question
// lists the whole project): ../src/analysis/metricNames looks the names up through step 3's index
// (../src/ipc/specVocabulary metricsNamed), and metricsByName, the reference where every metric is needed, reads them all
// in ONE pass (../src/analysis/metrics). Each is held Object.is-equal to its reference.
//
// Always (records are files):
//   1. ONE PASS: metricsByName — its keys, their order and every field of every Metric — is the old listMetrics then
//      getMetric each, Object.is, over three names differing only in case and space, a corrupt record, one past the
//      record cap (named like the others), a record holding another metric's id, one holding an id with no file, one in
//      upper case, one whose id is no UUID, one with no dataset, a stray file and a retired metric; and it reads no
//      record but the listing and the two ids no listed file has. Without a database metricNames gives what
//      metricsByName holds.
// With DATABASE_URL (scripts/columnAccessHarness.ts's world: Orders' rows by region, Staff's salary hidden from east):
//   2. ONE PASS again, records in Postgres: the same, in fewer queries.
//   3. THE DIFFERENTIAL (figures): formula chains (A = [B] + [C], B = [D] * 2), a period metric over a metric and a
//      formula naming it, a period of a formula, names differing in case (the first in listMetrics' order wins), a name
//      inside another ("Revenue", "Net revenue"), a cycle, a chain past MAX_DEPTH, a Live metric and a layer's metric
//      named, a filtered one, a name said bare, a name a parameter binds, a name nothing has, a retired one, one reading a
//      hidden column: every figure path, the index on === off (the full map), for boss (admin) and east (restricted by
//      rows and by a column): resolveMetric (plain, under a date control, with a parameter), the Assistant's factMetrics (additivity,
//      targets), measureAdditivity, planMetricMeasures, metricScope, checkTimeColumn, pinOf, targetFor, checkTarget,
//      driversFor, splitSegments, scenarioTargets. With the index on no metric list is read (spied); off, it is. Then
//      one referenced metric renamed and one deleted: the same.
//   4. NEGATIVE CONTROL: Units' name key out of the index: the differential FAILS; a rebuild mends it.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-formulaNames.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client } from 'pg';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';
import { captureLogs } from './logCapture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_TODAY = '2024-09-30'; // the period metrics' windows, pinned
const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const names: typeof import('../src/analysis/metricNames') = require('../src/analysis/metricNames');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const statusStore: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const factMetrics: typeof import('../src/ipc/factMetrics') = require('../src/ipc/factMetrics');
const additivity: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
const measures: typeof import('../src/analysis/metricMeasures') = require('../src/analysis/metricMeasures');
const timeScope: typeof import('../src/analysis/metricTimeScope') = require('../src/analysis/metricTimeScope');
const statusPin: typeof import('../src/analysis/statusPin') = require('../src/analysis/statusPin');
const targets: typeof import('../src/ipc/targetResolve') = require('../src/ipc/targetResolve');
const drivers: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
const driverScope: typeof import('../src/analysis/driverScope') = require('../src/analysis/driverScope');
const treeSplit: typeof import('../src/ipc/metricTreeSplit') = require('../src/ipc/metricTreeSplit');
const scenarios: typeof import('../src/analysis/scenarioResolve') = require('../src/analysis/scenarioResolve');
const params: typeof import('../src/analysis/params') = require('../src/analysis/params');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');

type Metric = import('../src/analysis/metrics').Metric;

/**
 * A value as text, numbers by Object.is (-0, NaN), Maps and Sets in order, key order kept: equal text ⇔ equal value. A
 * Live figure's `asOf` keeps its mode and staleness: its time, and whether the cache answered, are when it was asked.
 */
function canon(v: unknown, key = ''): string {
  if (key === 'asOf' && v && typeof v === 'object') return canon({ mode: (v as { mode?: unknown }).mode, stale: (v as { stale?: unknown }).stale });
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (v === undefined || typeof v === 'function') return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (v instanceof Map) return `Map{${[...v].map(([k, x]) => `${canon(k)}=>${canon(x)}`).join(',')}}`;
  if (v instanceof Set) return `Set{${[...v].map((x) => canon(x)).join(',')}}`;
  if (Array.isArray(v)) return `[${v.map((x) => canon(x)).join(',')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${canon(x, k)}`).join(',')}}`;
}
const outcome = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    return canon(await fn());
  } catch (e) {
    const err = e as { code?: unknown; name?: unknown; message?: unknown };
    return `threw ${String(err.code ?? err.name)}: ${String(err.message)}`;
  }
};

// ── 1, 2: metricsByName in one pass ─────────────────────────────────────────

/** metricsByName as it was: the list, then each record read again by its id. */
async function oldByName(P: string): Promise<Map<string, Metric>> {
  const out = new Map<string, Metric>();
  for (const s of await metrics.listMetrics(P)) {
    const key = s.name.toLowerCase();
    if (out.has(key)) continue;
    const full = await metrics.getMetric(P, s.id);
    if (full) out.set(key, full);
  }
  return out;
}

/** The odd records of a metrics directory, written as found on disk (or in `records`). `big`: stores a record past the cap. */
async function oddWorld(P: string, datasetId: string, big: (file: string, body: string) => Promise<void>): Promise<string[]> {
  const ids: string[] = [];
  const put = async (id: string, body: unknown): Promise<void> => {
    await fs.promises.mkdir(path.dirname(metrics.metricFilePath(P, id)), { recursive: true });
    await recordFs.writeFile(metrics.metricFilePath(P, id), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  };
  const rec = (id: string, name: string, definition: object = { column: 'sales', aggregation: 'sum' }) => ({ id, datasetId, name, definition, filters: [], createdAt: '2024-01-01T00:00:00.000Z' });
  for (const name of ['Revenue', 'revenue', '  REVENUE  ', 'Margin', 'Retired one']) {
    const id = randomUUID();
    ids.push(id);
    await put(id, rec(id, name, name === 'Margin' ? { formula: '[Revenue] / 2' } : undefined));
  }
  await put(randomUUID(), '{ not json');
  const capped = randomUUID();
  await big(metrics.metricFilePath(P, capped), JSON.stringify({ ...rec(capped, 'Revenue'), pad: Array.from({ length: 1_100_000 }, () => 0) }));
  const other = randomUUID();
  await put(other, rec(ids[0], 'Aardvark')); // holds Revenue's id: listed as Aardvark, read as Revenue
  const ghost = randomUUID();
  await put(ghost, rec(randomUUID(), 'Zebra')); // an id with no file
  const upper = randomUUID();
  await put(upper, rec(ids[1].toUpperCase(), 'Upper')); // revenue's id in upper case
  const badId = randomUUID();
  await put(badId, rec('not-a-uuid', 'Bad id'));
  const noDs = randomUUID();
  await put(noDs, { id: noDs, name: 'No dataset' });
  await recordFs.writeFile(path.join(path.dirname(metrics.metricFilePath(P, noDs)), 'notes.json'), JSON.stringify(rec(randomUUID(), 'Stray')), 'utf8');
  await statusStore.retire(P, `metric:${ids[4]}`, undefined, 'old');
  return ids;
}

/** Metric record reads (readFile, a readMany path) while `fn` runs. */
async function metricReads<T>(fn: () => Promise<T>): Promise<{ out: T; reads: number }> {
  const { readFile, readMany } = recordFs;
  let reads = 0;
  const isMetric = (p: unknown): boolean => /[\\/]metrics[\\/]/.test(String(p));
  (recordFs as { readFile: unknown }).readFile = (p: string, enc?: BufferEncoding) => { if (isMetric(p)) reads++; return (readFile as (p: string, e?: BufferEncoding) => Promise<unknown>)(p, enc); };
  (recordFs as { readMany: unknown }).readMany = (ps: readonly string[], perQuery?: number) => { reads += ps.filter(isMetric).length; return readMany(ps, perQuery); };
  try {
    return { out: await fn(), reads };
  } finally {
    Object.assign(recordFs, { readFile, readMany });
  }
}

async function onePass(label: string, P: string, queries?: () => number): Promise<void> {
  const logs = captureLogs(); // the corrupt and over-cap records, logged as skipped by both
  const q0 = queries?.() ?? 0;
  const before = await metricReads(() => oldByName(P));
  const q1 = queries?.() ?? 0;
  const after = await metricReads(() => metrics.metricsByName(P));
  const q2 = queries?.() ?? 0;
  logs.restore();
  const [a, b] = [canon([...before.out]), canon([...after.out])];
  ok(`${label}: metricsByName is the old list-then-read, key for key and field for field (${after.out.size} names)`, Object.is(a, b) && after.out.size >= 4, `${a}\n${b}`);
  const keys = [...after.out.keys()];
  ok(`${label}: …and the world is what it says: one Revenue of three, Aardvark read as Revenue, no Zebra, no record past the cap`,
    keys.filter((k) => k === 'revenue').length === 1 && after.out.get('aardvark')?.name === 'Revenue' && !after.out.has('zebra') && !after.out.has('stray') && !after.out.has('no dataset') && after.out.has('retired one'), keys);
  ok(`${label}: it reads no metric record but the listing, and the two whose id names no listed file (${after.reads}; the old read ${before.reads})`, after.reads === 2 && before.reads > after.out.size);
  ok(`${label}: …and logs the corrupt and over-cap records as the list always did`, logs.at('error').filter((l) => l.includes('Skipping corrupt')).length === 4, logs.lines.slice(0, 6).join('\n'));
  if (queries) ok(`${label}: …in fewer queries (${q2 - q1}, the old ${q1 - q0})`, q2 - q1 < q1 - q0);
}

async function fileLeg(): Promise<void> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-formulanames-'));
  context.enterServerMode(DATA);
  try {
    await context.runInContext({ user: { email: 'admin@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'f1', async () => {
      await projects.init();
      const P = (await projects.createProject('One pass'))!.id;
      await oddWorld(P, randomUUID(), (file, body) => fs.promises.writeFile(file, body, 'utf8'));
      await onePass('1. files', P);
      const logs = captureLogs();
      const want = await metrics.metricsByName(P);
      const lookup = names.metricNames(P);
      const asked = ['revenue', 'margin', 'aardvark', 'zebra', 'nothing'];
      const got = await Promise.all(asked.map((k) => lookup.get(k)));
      const lists = logs.at('error').filter((l) => l.includes('Skipping corrupt')).length / 2; // two skipped records a listing
      logs.restore();
      ok(`1. without a database metricNames gives what metricsByName holds, listing once for five names asked at a time (${lists - 1})`, canon(got) === canon(asked.map((k) => want.get(k))) && !!got[0] && lists === 2);
    });
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

// ── 3, 4: the figures ───────────────────────────────────────────────────────

type W = C.ColumnWorld;
const WHO = ['boss', 'east'] as const;
const K = params.paramValues([{ name: 'k', kind: 'number', value: 2 }]);
const CONTROL = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-03-01', to: '2024-06-30' }, fromControl: true }] as never[];

async function figureWorld(W: W): Promise<{ ids: Record<string, string>; live: string }> {
  const { P, orders, staff } = W;
  fakeMod.registerLiveFake();
  const live = await W.as('boss', async () => {
    await fakeMod.loadWarehouseTable('fn_orders', H.COLUMNS, H.ROWS);
    const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
    return (await liveRecord.saveLiveRecord(P, { name: 'Live orders', columns: H.COLUMNS, origin: { kind: 'connection', connId: conn!.id, table: 'fn_orders' } }))!.id;
  });
  const ids: Record<string, string> = {};
  const save = async (name: string, definition: object, extra: object = {}, datasetId = orders): Promise<void> => {
    const m = await W.as('boss', () => metrics.saveMetric(P, { name, datasetId, definition, ...extra }));
    if (!m) throw new Error(`fixture: ${name}`);
    ids[name] = m.id;
  };
  const sum = (column: string) => ({ column, aggregation: 'sum' });
  const month = { target: { source: { value: 100 }, per: 'month' } };
  await save('Revenue', sum('sales'), { timeColumn: 'day', ...month });
  await save('revenue', { column: 'qty', aggregation: 'count' });
  await save('Net revenue', { formula: '[Revenue] - sum(qty)' }, { timeColumn: 'day', target: { source: { value: 50 } } });
  await save('Units', sum('qty'), { timeColumn: 'day' });
  await save('D', { formula: '[Revenue]' });
  await save('B', { formula: '[D] * 2' });
  await save('C', { formula: '[Units]' });
  await save('A', { formula: '[B] + [C]' }, month);
  await save('Revenue YTD', { base: ids.Revenue, window: { to_date: 'year' } }, { target: { source: { value: 900 } } });
  await save('YTD share', { formula: '[Revenue YTD] / [Revenue]' });
  await save('Net 90d', { base: ids['Net revenue'], window: { last: 90, unit: 'day' } });
  await save('Loop A', { formula: '[Loop B] + 1' });
  await save('Loop B', { formula: '[Loop A] + 1' });
  await save('Step 0', { formula: '[Revenue]' });
  for (let i = 1; i <= 12; i++) await save(`Step ${i}`, { formula: `[Step ${i - 1}] + 0` });
  await save('Live sales', sum('sales'), {}, live);
  await save('Uses live', { formula: '[Live sales] / 2' });
  await save('Layer sales', { external: 'total_sales', additive: true });
  await save('Uses layer', { formula: '[Layer sales] + 1' });
  await save('West revenue', sum('sales'), { filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] });
  await save('West share', { formula: '[West revenue] / [Revenue]' });
  await save('Rev 2', sum('qty'));
  await save('Bound name', { formula: '[Rev [[k]]] + [Revenue] * [[k]]' });
  await save('Names nothing', { formula: '[Nobody here] + 1' });
  await save('Bare', { formula: 'Units * 2' }); // a name said without brackets, and by no other formula it reaches
  await save('Old name', sum('qty'));
  await save('Uses old', { formula: '[Old name] + [Units]' });
  await save('Gone', sum('qty'));
  await save('Uses gone', { formula: '[Gone] * 3' });
  await save('Pay', sum('salary'), {}, staff);
  await save('Heads', { column: 'employee_id', aggregation: 'count' }, {}, staff);
  await save('Pay per head', { formula: '[Pay] / [Heads]' }, {}, staff);
  await W.as('boss', () => statusStore.retire(P, `metric:${ids.B}`, undefined, 'kept'));
  return { ids, live };
}

/** Every figure path, for one caller: label → outcome. */
async function figures(W: W, ids: Record<string, string>, who: string): Promise<Map<string, string>> {
  const { P, orders, staff } = W;
  const out = new Map<string, string>();
  const at = async (label: string, fn: () => Promise<unknown>): Promise<void> => { out.set(label, await W.as(who, () => outcome(fn))); };
  await at('factMetrics', () => factMetrics.factMetrics(P, new Set([orders, staff]), { filters: [], params: K }));
  for (const [name, id] of Object.entries(ids)) {
    const m = await W.as('boss', () => metrics.getMetric(P, id));
    if (!m) continue;
    const measure = { metricId: id, column: 'sales', aggregation: 'sum' as const };
    await at(`${name}: resolveMetric`, () => metricsIpc.resolveMetric(P, id));
    await at(`${name}: resolveMetric, a date control`, () => metricsIpc.resolveMetric(P, id, { filters: CONTROL }));
    await at(`${name}: resolveMetric, k = 2`, () => metricsIpc.resolveMetric(P, id, { params: K }));
    await at(`${name}: measureAdditivity`, () => additivity.measureAdditivity(P, m.datasetId, measure, K));
    await at(`${name}: planMetricMeasures`, () => measures.planMetricMeasures(P, m.datasetId, { category: 'region', values: [measure] }, K));
    await at(`${name}: metricScope`, () => timeScope.metricScope(P, m, CONTROL));
    await at(`${name}: checkTimeColumn`, () => timeScope.checkTimeColumn(P, { name: `${m.name} copy`, datasetId: m.datasetId, definition: m.definition, timeColumn: 'day' }));
    await at(`${name}: pinOf`, () => statusPin.pinOf(P, `metric:${id}`));
    await at(`${name}: targetFor`, () => targets.targetFor(P, id, CONTROL, 10));
    await at(`${name}: checkTarget`, () => targets.checkTarget(P, m, { source: { value: 1 }, per: 'month' }));
    await at(`${name}: scenarioTargets`, () => scenarios.scenarioTargets(P, [id]));
    if (m.datasetId !== orders) continue;
    const spec = driverScope.sanitizeDriversSpec({ datasetId: orders, metric: { metricId: id }, compare: { mode: 'previous_period' } }, CONTROL);
    await at(`${name}: driversFor`, () => drivers.driversFor(P, spec!, [{ name: 'k', kind: 'number', value: 2 }]));
    await at(`${name}: splitSegments`, async () => treeSplit.splitSegments(P, m, (await datasets.getDatasetMeta(P, orders))!.columns, 'region', { current: CONTROL, previous: [] }, K));
  }
  return out;
}

async function differential(W: W, ids: Record<string, string>): Promise<{ bad: string[]; seen: number; on: Record<string, Map<string, string>> }> {
  const bad: string[] = [];
  let seen = 0;
  const seenOn: Record<string, Map<string, string>> = {};
  for (const who of WHO) {
    const on = await figures(W, ids, who);
    search._setIndexed(false);
    let off: Map<string, string>;
    try {
      off = await figures(W, ids, who);
    } finally {
      search._setIndexed(true);
    }
    for (const [label, x] of on) {
      seen++;
      if (!Object.is(x, off.get(label))) bad.push(`${who} ${label}: ${x} vs ${String(off.get(label))}`);
    }
    seenOn[who] = on;
  }
  return { bad, seen, on: seenOn };
}

/** Metric directories listed while `fn` runs. */
async function metricLists<T>(fn: () => Promise<T>): Promise<number> {
  const real = recordFs.listRecords;
  let lists = 0;
  (recordFs as { listRecords: unknown }).listRecords = (dir: string) => { if (/[\\/]metrics$/.test(dir)) lists++; return real(dir); };
  try {
    await fn();
    return lists;
  } finally {
    (recordFs as { listRecords: unknown }).listRecords = real;
  }
}

async function figureLeg(W: W): Promise<void> {
  const { P } = W;
  const { ids } = await figureWorld(W);
  let r = await differential(W, ids);
  ok(`3. every figure path is the full map's, Object.is (${r.seen} outcomes, boss and east)`, r.bad.length === 0 && r.seen > 500, r.bad.slice(0, 6).join('\n'));
  const value = (name: string, label = 'resolveMetric', who = 'boss', on = r.on): unknown => {
    const x = on[who].get(`${name}: ${label}`) ?? '';
    const v = /^\{"ok":true,"id":"[^"]+","name":"(?:[^"\\]|\\.)*","value":([^,}]+)/.exec(x)?.[1]; // a ResolvedMetric's value, canon'd
    return v === undefined ? x : v === 'null' ? null : Number(v);
  };
  ok('3. …and the world is what it says: a chain, a period, a filtered share, a bound name and the Live one have figures; a cycle, past the depth and a missing name none',
    [value('A'), value('YTD share'), value('Net 90d'), value('West share'), value('Uses live'), value('Bare'), value('Bound name', 'resolveMetric, k = 2')].every((v) => typeof v === 'number')
    && [value('Loop A'), value('Step 12'), value('Names nothing')].every((v) => v === null), ['A', 'YTD share', 'Net 90d', 'West share', 'Uses live', 'Loop A', 'Step 12', 'Names nothing'].map((n) => `${n}=${String(value(n))}`).join(' '));
  ok('3. …east\'s Revenue is not boss\'s (row rules), and Pay per head is refused them (a hidden column)',
    typeof value('Revenue', 'resolveMetric', 'east') === 'number' && value('Revenue', 'resolveMetric', 'east') !== value('Revenue') && typeof value('Pay per head') === 'number' && typeof value('Pay per head', 'resolveMetric', 'east') !== 'number',
    [value('Revenue', 'resolveMetric', 'east'), value('Revenue'), value('Pay per head'), value('Pay per head', 'resolveMetric', 'east')].map(String).join(' | '));

  const on = await metricLists(() => figures(W, ids, 'east'));
  search._setIndexed(false);
  let off = 0;
  try {
    off = await metricLists(() => figures(W, ids, 'east'));
  } finally {
    search._setIndexed(true);
  }
  ok(`3. with the index on, no figure path lists the metrics (${on})`, on === 0);
  ok(`3. NEGATIVE CONTROL: with it off, they do (${off})`, off > 0);

  await W.as('boss', () => metrics.updateMetric(P, ids['Old name'], { name: 'New name' }));
  await W.as('boss', () => metrics.deleteMetric(P, ids.Gone));
  r = await differential(W, ids);
  ok('3. Old name renamed and Gone deleted: the same, and their formulas no longer read them', r.bad.length === 0 && value('Uses gone', 'resolveMetric', 'boss', r.on) === null && value('Uses old', 'resolveMetric', 'boss', r.on) === null, r.bad.slice(0, 6).join('\n'));

  await W.pool.query("UPDATE assistant_search SET keys = array_remove(keys, $1) WHERE project_id = $2 AND base AND kind = 'metric' AND id = $3", [search.lowerKey('Units'), P, ids.Units]);
  r = await differential(W, ids);
  ok(`4. NEGATIVE CONTROL: with Units' name key out of the index, the differential FAILS (${r.bad.length} outcomes differ)`, r.bad.length > 0 && r.bad.some((b) => b.includes('C: resolveMetric')), r.bad.slice(0, 3).join('\n'));
  await W.pool.query('DELETE FROM assistant_search_built WHERE project_id = $1', [P]);
  ok('4. …and a rebuild mends it', (await differential(W, ids)).bad.length === 0);
}

async function dbOnePass(W: W): Promise<void> {
  const P = await W.as('boss', async () => (await projects.createProject('One pass'))!.id);
  await W.as('boss', () => oddWorld(P, W.orders, async (file, body) => {
    await W.pool.query("INSERT INTO records (org_id, path, body) VALUES ('acme', $1, $2)", [path.relative(appPaths.userData(), file).split(path.sep).join('/'), body]);
  }));
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const real = proto.query;
  let queries = 0;
  proto.query = function (this: unknown, ...a: unknown[]) { queries++; return real.apply(this, a); };
  try {
    await W.as('boss', () => onePass('2. Postgres', P, () => queries));
  } finally {
    proto.query = real;
  }
}

(async () => {
  await fileLeg();
  const W = await C.columnWorld('formula names');
  if (!W) return;
  try {
    await dbOnePass(W);
    await figureLeg(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('formula names suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => finish());
