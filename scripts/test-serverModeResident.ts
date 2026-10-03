// Self-check for T4.1/T4.2 — server mode and the async resident layer.
//
// 1. THE GUARD. `duck.forbidSyncOnMainThread()` makes the sync `query()`/`exec()`
//    THROW on the main thread (a parked event loop freezes every request on the
//    server), leaves the async bridge working, and exempts worker threads.
// 2. WITH THE GUARD ON, every path T4.1 moved to the async bridge still answers
//    RESIDENT through its shipped IPC handler: residentTrace records `resident`
//    and never `failed`, `datasets.getDataset` is never called (the table was
//    never hydrated), and the answer is Object.is-equal to the JS reference over
//    the same round-tripped rows. A sync call left on one of these paths would
//    throw, fall back, and fail here loudly — not pass green and inert.
// 3. T4.2's paths, the same way: a PIVOT and a COHORT through visual:data,
//    dataset:stats (column summaries + quality issues), stats:run,
//    dataset:median and insights:list (anomalies + the insights aggregator, run
//    INLINE on this thread — ORDINATE_COMPUTE_INLINE=1 — so the guard sees them).
//
// 4. T5.2 — with STORAGE_URL=s3://… (MinIO) and DATABASE_URL: the routed pass
//    again with the tables as versioned S3 objects and the records (and their
//    version pointers) in Postgres — once with the cache off (every read
//    through httpfs in the org worker) and once read from the local cache.
//    Without both variables it prints one `skip` line (scripts/s3TestEnv.ts).
//
//   npm run build:ts && node scripts/test-serverModeResident.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, ok as okBase, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');
const { Worker }: typeof import('worker_threads') = require('worker_threads');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

// Run the compute pool's ops on THIS thread, where the guard applies — the
// pool's own threads are exempt and would hide a sync call.
process.env.ORDINATE_COMPUTE_INLINE = '1';
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-server-mode-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: ReadonlyMap<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      net: {},
      nativeImage: {},
      shell: {},
      dialog: {},
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const context: typeof import('../src/server/context') = require('../src/server/context');
const computePool: typeof import('../src/engine/computePool') = require('../src/engine/computePool');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const dp: typeof import('../src/engine/datasetPage') = require('../src/engine/datasetPage');
const dv: typeof import('../src/engine/datasetView') = require('../src/engine/datasetView');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const filterCatalog: typeof import('../src/analysis/filterCatalog') = require('../src/analysis/filterCatalog');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const datasetStats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');
const columnProfile: typeof import('../src/data/columnProfile') = require('../src/data/columnProfile');
const statsJob: typeof import('../src/engine/statsJob') = require('../src/engine/statsJob');
const vectorsJs: typeof import('../src/analysis/stats/vectorsJs') = require('../src/analysis/stats/vectorsJs');
const statsSpec: typeof import('../src/analysis/stats/spec') = require('../src/analysis/stats/spec');
const storage: typeof import('../src/engine/storage') = require('../src/engine/storage');
const parquetCache: typeof import('../src/engine/parquetCache') = require('../src/engine/parquetCache');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const s3Test: typeof import('./s3TestEnv') = require('./s3TestEnv');
require('../src/ipc/datasets').register();
require('../src/ipc/visuals').register();
require('../src/ipc/dashboards').register();
require('../src/ipc/stats').register();
require('../src/ipc/insights').register();

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'zip', type: 'text' },
  { name: 'day', type: 'date' },
];
// Over the 1,000-row floor of dashboards' cost model, so the metric goes resident.
const ROWS: Cell[][] = Array.from({ length: 2000 }, (_, i) => [
  i % 9 === 0 ? '' : `r${i % 5}`,
  i % 11 === 0 ? null : (i % 17) - 4 + i * 0.25,
  String(i % 40).padStart(3, '0'),
  i % 13 === 0 ? '' : new Date(Date.UTC(2024, 0, 1) + ((i * 7) % 300) * 86_400_000).toISOString().slice(0, 10),
]);

/** '' when equal with Object.is at every leaf, else the first difference's path. */
function firstDiff(a: unknown, b: unknown, at = '$'): string {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: length`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) { const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`); if (d) return d; } // any: structural walk
    return '';
  }
  return Object.is(a, b) ? '' : `${at}: ${String(a)} vs ${String(b)}`;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** The sync bridge from inside a worker thread, with the guard switched on THERE. */
function syncInWorker(): Promise<unknown> {
  const file = require.resolve('../src/engine/duckdb');
  const src =
    `const d = require(${JSON.stringify(file)}); const { parentPort } = require('worker_threads');` +
    `d.forbidSyncOnMainThread(); let out; try { out = d.query('SELECT 7 AS x')[0].x; } catch (e) { out = String(e.message); }` +
    `d.shutdown(); parentPort.postMessage(out);`;
  const w = new Worker(src, { eval: true });
  return new Promise((resolve, reject) => {
    w.once('message', (m) => { resolve(m); void w.terminate(); });
    w.once('error', reject);
  });
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function sameCells(a: Cell[][], b: Cell[][]): boolean {
  return a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((c, j) => Object.is(c, b[i][j])));
}

async function main(): Promise<void> {
  if (!duck.isAvailable()) {
    ok('DuckDB bridge unavailable — nothing was verified', false);
    return;
  }

  // ── 1. The guard ───────────────────────────────────────────────────────────
  duck.forbidSyncOnMainThread();
  const qe = thrown(() => duck.query('SELECT 1 AS x')) as { code?: string } | null;
  ok('server mode: sync query() on the main thread THROWS', qe instanceof duck.DuckDBError && qe.code === 'sync', String(qe));
  const ee = thrown(() => duck.exec('SELECT 1')) as { code?: string } | null;
  ok('server mode: sync exec() on the main thread THROWS', ee instanceof duck.DuckDBError && ee.code === 'sync', String(ee));
  ok('server mode: queryAsync still answers', (await duck.queryAsync('SELECT 42 AS x'))[0].x === 42);
  ok('server mode: isAvailable() still answers', duck.isAvailable() === true);
  ok('server mode: a worker thread keeps its sync bridge', (await syncInWorker()) === 7);
  ok('server mode: the test-only sync Parquet writer is caught by the guard (it throws)',
    (thrown(() => pqSync.writeTable(path.join(tmpUserData, 'guard.parquet'), [{ name: 'a', type: 'text' }], [['x']])) as { code?: string } | null)?.code === 'sync');
  duck.forbidSyncOnMainThread(false);
  ok('lifted: sync query() answers again', duck.query('SELECT 1 AS x')[0].x === 1);

  // Sections 2–3 run twice: on the desktop's single bridge, then ROUTED (T4.3)
  // — server mode, the caller's org worker picked by ctx(), locked to its org
  // directory, with compute ops on their own threads talking to that worker
  // over a leased port. The same answers, Object.is, both ways.
  await differential('');
  duck.shutdown();
  context.enterServerMode(path.join(tmpUserData, 'server-data'));
  const pool = poolMod.routeByOrg({ dataDir: path.join(tmpUserData, 'server-data'), maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  delete process.env.ORDINATE_COMPUTE_INLINE;
  await context.runInContext({ user: { email: 'u@acme', role: 'admin' }, org: { id: 'acme' } }, 'routed', () => differential('routed: '));
  process.env.ORDINATE_COMPUTE_INLINE = '1';
  ok("routed: the answers came from org acme's worker", JSON.stringify(pool.orgs()) === '["acme"]', JSON.stringify(pool.orgs()));

  // ── 4. T5.2 — the same, with the tables on S3 ──────────────────────────────
  const t = await s3Test.setup('smr');
  if (typeof t === 'string') {
    console.log(`skip S3 pass: ${t}`);
    return;
  }
  pool.shutdown();
  const dataDir = path.join(tmpUserData, 'server-data');
  recordFs.useRecordDb(t.pool);
  storage.useStorageDb(t.pool);
  const s3Pool = poolMod.routeByOrg({ dataDir, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000, s3: t.s3 });
  try {
    const acme = { user: { email: 'u@acme', role: 'admin' as const }, org: { id: 'acme' } };
    delete process.env.ORDINATE_COMPUTE_INLINE;
    storage.configure(dataDir, t.s3, 0);
    await context.runInContext(acme, 's3', () => differential('s3, httpfs: '));
    storage.configure(dataDir, t.s3, 64 * 2 ** 20);
    await context.runInContext(acme, 's3c', () => differential('s3, cached: '));
    process.env.ORDINATE_COMPUTE_INLINE = '1';
    const c = parquetCache.stats();
    ok('s3, cached: reads were served from the local cache', c.hits > 0 && c.fills > 0 && c.fillErrors === 0, JSON.stringify(c));
  } finally {
    s3Pool.shutdown();
    recordFs.useRecordDb(null);
    storage.useStorageDb(null);
    storage.configure(dataDir, null, 0);
    await t.teardown();
  }
}

async function differential(mode: string): Promise<void> {
  const ok = (label: string, cond: boolean, extra?: unknown): void => okBase(mode + label, cond, extra);
  // ── 2. Fixture (set up with the desktop rules), then the guard back on ─────
  await projects.init();
  await datasets.init();
  const projectId = (await projects.createProject('Server mode')).id;
  const saved = await datasets.saveDataset(projectId, { name: 'sales', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
  if (!saved) throw new Error('saveDataset failed');
  const back = await datasets.getDataset(projectId, saved.id);
  if (!back) throw new Error('getDataset failed');
  let src = await datasets.residentSource(projectId, saved.id);
  ok('fixture is Parquet-backed', !!src);
  if (!src) return;
  if (storage.isS3()) {
    const meta = await datasets.getDatasetMeta(projectId, saved.id);
    ok('the record carries the S3 version pointer', /^[0-9a-f-]{36}$/.test(meta?.storageVersion ?? ''), JSON.stringify(meta?.storageVersion));
    ok('no Parquet file was written beside the record',
      !fs.existsSync((require('../src/data/datasetRecord') as typeof import('../src/data/datasetRecord')).parquetPath(projectId, saved.id)));
    ok('the S3 round trip is lossless (every cell Object.is)', sameCells(back.rows, ROWS));
    await parquetCache.settle();
    src = (await datasets.residentSource(projectId, saved.id))!;
    const cached = parquetCache.stats().capBytes > 0;
    ok(cached ? 'once fetched, reads resolve to the local cached copy' : 'with the cache off, every read stays s3://',
      cached ? src.parquetPath.startsWith(path.join(tmpUserData, 'server-data', 'orgs', 'acme', 'cache')) : src.parquetPath.startsWith('s3://'), src.parquetPath);
  }

  const realGet = datasets.getDataset;
  let hydrations = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => {
    hydrations += 1;
    return (realGet as any)(...args);
  };
  duck.forbidSyncOnMainThread();
  trace.reset();
  queryCache.clear();
  const call = (ch: string, arg: unknown): Promise<any> => (handlers.get(ch) as IpcHandler)(null, arg);
  const filters = [{ type: 'filter' as const, column: 'region', op: 'in' as const, values: ['r1', 'r3', ''] }];

  // dataset:page — a sorted, searched, filtered window.
  const pageReq = { offset: 3, limit: 20, search: '0', sortColumn: 'sales', sortDir: 'desc' as const, filters };
  const page = await call('dataset:page', { projectId, datasetId: saved.id, ...pageReq });
  const pageJs = dp.pageRowsJs(back.columns, back.rows, pageReq);
  ok('dataset:page answers in server mode', page && page.ok === true, JSON.stringify(page).slice(0, 200));
  ok('dataset:page === pageRowsJs (every cell Object.is)', !!page && sameCells(page.rows, pageJs.rows) && page.total === pageJs.total);

  // dataset:distinct — searched, with the pre-cap total.
  const distinct = await call('dataset:distinct', { projectId, datasetId: saved.id, column: 'zip', limit: 7, search: '1' });
  const distinctJs = dp.distinctValuesPageJs(back.columns, back.rows, 'zip', { limit: 7, search: '1' });
  ok('dataset:distinct === distinctValuesPageJs', same(distinct, distinctJs), JSON.stringify({ distinct, distinctJs }));

  // visual:data — the aggregated chart (category key pre-query + aggregate).
  const enc = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' as const }, { column: 'zip', aggregation: 'count' as const }] };
  const chart = await call('visual:data', { projectId, datasetId: saved.id, encoding: enc, filters });
  const chartJs = vizData.buildVizData(back.columns, back.rows, enc, filters).data;
  ok('visual:data answers in server mode', !!chart && chart.ok !== false && !!chart.data, JSON.stringify(chart).slice(0, 200));
  ok('visual:data labels === buildVizData', !!chart?.data && chart.data.labels.length === chartJs.labels.length
    && chart.data.labels.every((l: unknown, i: number) => Object.is(l, chartJs.labels[i])));
  ok('visual:data values === buildVizData (Object.is)', !!chart?.data && chartJs.series.every((s, i) =>
    s.values.every((v, j) => Object.is(v, chart.data.series[i].values[j]))));

  // dashboard:metric — one figure, filtered.
  for (const aggregation of ['sum', 'avg', 'count', 'min', 'max'] as const) {
    queryCache.clear();
    const m = await call('dashboard:metric', { projectId, datasetId: saved.id, column: 'sales', aggregation, filters });
    const filtered = (require('../src/data/transforms') as typeof import('../src/data/transforms'))
      .applyPipeline({ columns: back.columns, rows: back.rows }, filters).rows;
    const want = metricValue.computeMetric(back.columns, filtered, { column: 'sales', aggregation });
    ok(`dashboard:metric ${aggregation} === computeMetric (${want})`, !!m && m.ok === true && Object.is(m.value, want), JSON.stringify(m));
  }

  // ── 3. T4.2 — the rest of the resident layer, through the shipped handlers ──
  // visual:data, PIVOT — Top N, grouping sets over a quarter grain, the shared fold.
  const pivotEnc = {
    category: 'region', values: [{ column: 'sales', aggregation: 'sum' }],
    pivot: {
      rows: [{ column: 'region' }], columns: [{ column: 'day', grain: 'quarter' }],
      values: [{ column: 'sales', aggregation: 'sum' }, { column: 'sales', aggregation: 'avg' }, { column: 'zip', aggregation: 'count' }],
      totals: { rows: true, columns: true, grand: true }, topN: { n: 3, byValueIdx: 0 },
    },
  };
  const pv = await call('visual:data', { projectId, datasetId: saved.id, encoding: pivotEnc, filters });
  const pvJs = vizData.buildVizData(back.columns, back.rows, visuals.sanitizeEncoding(pivotEnc), filters).data;
  ok('visual:data PIVOT answers in server mode', !!pv?.data?.pivot, JSON.stringify(pv).slice(0, 200));
  const pvDiff = firstDiff(pv?.data?.pivot, pvJs.pivot);
  ok('visual:data PIVOT grid === buildPivotGrid (Object.is, leaf by leaf)', !!pvJs.pivot && pvDiff === '', pvDiff);

  // visual:data, COHORT — monthly retention by first-seen zip.
  const cohortEnc = { category: 'day', values: [], cohort: { entity: 'zip', date: 'day', grain: 'month', show: 'retention' } };
  const co = await call('visual:data', { projectId, datasetId: saved.id, encoding: cohortEnc, filters });
  const coJs = vizData.buildVizData(back.columns, back.rows, visuals.sanitizeEncoding(cohortEnc), filters).data;
  const coDiff = firstDiff({ labels: co?.data?.labels, series: co?.data?.series, cohort: co?.data?.cohort },
    { labels: coJs.labels, series: coJs.series, cohort: coJs.cohort });
  ok('visual:data COHORT === buildVizData (Object.is, leaf by leaf)', !!coJs.cohort && coDiff === '', coDiff);

  // dataset:stats — every column summary and the quality issues.
  const st = await call('dataset:stats', { projectId, datasetId: saved.id });
  const stJs = {
    summaries: back.columns.map((col, c) => datasetStats.computeColumnSummary(col, back.rows.map((r) => r[c] ?? null))),
    issues: datasetStats.findQualityIssues(back.columns, back.rows),
  };
  const stDiff = firstDiff({ summaries: st?.summaries, issues: st?.issues }, stJs);
  ok('dataset:stats answers in server mode', !!st && st.ok === true, JSON.stringify(st).slice(0, 200));
  ok('dataset:stats === computeColumnSummary + findQualityIssues (Object.is)', stDiff === '', stDiff);

  // stats:run — a distribution and a correlation, filtered (a dashboard tile's call).
  for (const raw of [
    { kind: 'distribution', datasetId: saved.id, columns: ['sales'] },
    { kind: 'groups', datasetId: saved.id, columns: [], group: 'region', outcome: 'sales' },
  ]) {
    const spec = statsSpec.sanitizeStatsSpec(raw);
    if (!spec) { ok(`stats:run ${raw.kind}: spec sanitizes`, false); continue; }
    const r = await call('stats:run', { projectId, spec: raw, filters });
    const need = statsSpec.vectorNeeds(spec, back.columns);
    const v = 'error' in need ? null : vectorsJs.loadVectorsJs(back.columns, back.rows, need.needs, filters);
    const want = v ? statsJob.finishStats(spec, v) : null;
    const d = firstDiff(r?.result, want);
    ok(`stats:run ${raw.kind} answers in server mode`, !!r && r.ok === true, JSON.stringify(r).slice(0, 200));
    ok(`stats:run ${raw.kind} === the JS reference (Object.is)`, !!want && d === '', d);
  }

  // dataset:median — the column profile's median.
  const med = await call('dataset:median', { projectId, datasetId: saved.id, column: 'sales' });
  const medJs = columnProfile.medianOf(back.columns, back.rows, 'sales');
  ok(`dataset:median === medianOf (${medJs})`, !!med && med.ok === true && Object.is(med.median, medJs), JSON.stringify(med));

  // insights:list — anomalies + the insights aggregator, inline on this thread.
  const ins = await call('insights:list', { projectId, datasetId: saved.id });
  ok('insights:list answers in server mode', !!ins && ins.ok === true && Array.isArray(ins.insights) && ins.insights.length > 0,
    JSON.stringify(ins).slice(0, 200));
  const ix: typeof import('../src/analysis/insights') = require('../src/analysis/insights');
  const an: typeof import('../src/analysis/anomalies') = require('../src/analysis/anomalies');
  const insJs = ix.rankInsights([
    ...(await ix.detectInsights(saved.id, back.columns, ix.jsAgg(back.columns, back.rows))),
    ...an.detectAnomalies(back.columns, back.rows).map((a) => ix.fromAnomaly(saved.id, a, back.columns))
      .filter((i): i is NonNullable<typeof i> => !!i),
  ]);
  const pick = (l: Array<{ id: string; kind: string; facts: unknown }>): unknown => l.map((i) => ({ id: i.id, kind: i.kind, facts: i.facts }));
  const insDiff = firstDiff(pick(ins?.insights || []), pick(insJs));
  ok(`insights:list === the JS reference: ids, kinds, every figure (${insJs.length})`, insDiff === '', insDiff);

  // The module-level async paths with no IPC in front of them.
  const catalog = await filterCatalog.catalogResident(src, saved.id);
  ok('catalogResident === catalogJs in server mode', same(catalog, filterCatalog.catalogJs(back.columns, back.rows, saved.id)));
  const view = 'ds_server_mode_view';
  ok('ensureView creates the view in server mode', (await dv.ensureView({ name: view, parquetPath: src.parquetPath, columns: src.columns })) === true);
  const viewed = await duck.queryAsync(`SELECT count(*)::DOUBLE AS n FROM ${view};`);
  ok('…and it reads back every row', viewed[0].n === ROWS.length);
  ok('dropView drops it in server mode', (await dv.dropView(view)) === true);

  // Which path ran: resident everywhere, never failed, nothing hydrated.
  const snap = trace.snapshot();
  for (const op of ['datasetPage', 'datasetDistinct', 'vizCategoryKey', 'vizAggregate', 'metric',
    'vizPivot', 'vizCohort', 'datasetStats', 'stats', 'datasetMedian', 'insights']) {
    const c = snap[op];
    ok(`trace ${op}: resident, never failed`, !!c && c.resident > 0 && c.failed === 0, JSON.stringify(c));
  }
  ok('no table was hydrated (getDataset never called)', hydrations === 0, `hydrations=${hydrations}`);

  duck.forbidSyncOnMainThread(false);
  (datasets as any).getDataset = realGet;
}

main()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    duck.shutdown();
    void computePool.shutdown().finally(() => {
      try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
      finish();
    });
  });
