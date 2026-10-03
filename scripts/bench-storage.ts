// Parquet on S3 vs local disk (T5.2): one 1,000,000-row dataset, saved once on
// DATA_DIR and once on S3 (MinIO), then a PAGE (dataset:page, 100 rows at
// offset 500,000) and a CHART (visual:data, sum by category) through the real
// handlers in the org's locked worker — local disk, S3 read through httpfs
// (cache off), and S3 served from the local cache. Medians of N interleaved
// runs; the answer cache is cleared before every call. Prints the cache's hit
// rate over the run.
//
//   npm run build:ts && STORAGE_URL=s3://ordinate-test S3_ENDPOINT=http://localhost:9000 \
//     AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin DATABASE_URL=… \
//     node scripts/bench-storage.js [runs]

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUNS = Number(process.argv[2]) || 11;
const ROWS = 1_000_000;
const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'electron') return { app: { getPath: () => { throw new Error('server mode'); } } };
  return origLoad.apply(this, [request, ...rest]);
};
const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const storage: typeof import('../src/engine/storage') = require('../src/engine/storage');
const cache: typeof import('../src/engine/parquetCache') = require('../src/engine/parquetCache');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const s3Test: typeof import('./s3TestEnv') = require('./s3TestEnv');
const handlers: ReadonlyMap<string, (e: unknown, p?: unknown) => Promise<{ ok?: boolean }>> = require('../src/server/rpc').handlers;
require('../src/ipc/datasets').register();
require('../src/ipc/visuals').register();

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const columns = [
  { name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const },
  { name: 'id', type: 'text' as const }, { name: 'day', type: 'date' as const }, { name: 'qty', type: 'number' as const },
];
// Hash-spread values so the file is not a few runs ZSTD folds to nothing.
const h = (i: number): number => Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
const rows = Array.from({ length: ROWS }, (_, i) => [
  REGIONS[h(i) % 5], (h(i + 1) % 10_000_000) / 100, String(h(i + 2)).padStart(10, '0'),
  new Date(Date.UTC(2020, 0, 1) + (h(i + 3) % 2000) * 86_400_000).toISOString().slice(0, 10), h(i + 4) % 500,
]);

(async () => {
  const t = await s3Test.setup('bench');
  if (typeof t === 'string') throw new Error(`needs MinIO and Postgres: ${t}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-s3-'));
  context.enterServerMode(dataDir);
  recordFs.useRecordDb(t.pool);
  storage.useStorageDb(t.pool);
  const poolCfg = { dataDir, maxWorkers: 2, memoryLimit: '2GiB', threads: 4, queryTimeoutMs: 120_000, idleMs: 600_000, s3: t.s3 };
  let pool = poolMod.routeByOrg(poolCfg);
  const call = (ch: string, arg: unknown) => handlers.get(ch)!(null, arg);
  try {
    await context.runInContext({ user: { email: 'b@bench', role: 'admin' }, org: { id: 'bench' } }, 'bench', async () => {
      const p = (await projects.createProject('Bench')).id;
      const save = async (mode: 'disk' | 's3'): Promise<{ id: string; ms: number }> => {
        storage.configure(dataDir, mode === 's3' ? t.s3 : null, 0);
        const t0 = performance.now();
        const d = await datasets.saveDataset(p, { name: mode, sourceKind: 'csv', columns, rows });
        return { id: d!.id, ms: performance.now() - t0 };
      };
      const disk = await save('disk');
      const s3 = await save('s3');
      console.log(`save 1M rows: disk ${disk.ms.toFixed(0)} ms, S3 ${s3.ms.toFixed(0)} ms`);

      const page = (id: string) => call('dataset:page', { projectId: p, datasetId: id, offset: 500_000, limit: 100 });
      const chart = (id: string) => call('visual:data', { projectId: p, datasetId: id, encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] } });
      const timed = async (mode: string, id: string, fn: (id: string) => Promise<{ ok?: boolean }>): Promise<number> => {
        storage.configure(dataDir, t.s3, mode === 's3 cached' ? 1 << 30 : 0);
        queryCache.clear();
        const t0 = performance.now();
        const r = await fn(id);
        const ms = performance.now() - t0;
        if (!r || r.ok === false) throw new Error(`${mode} failed: ${JSON.stringify(r).slice(0, 200)}`);
        return ms;
      };
      const cases: Array<[string, string]> = [['disk', disk.id], ['s3 httpfs', s3.id], ['s3 cached', s3.id]];
      // Cold: a fresh worker per case (no DuckDB buffer or external-file cache), the cached copy already on disk.
      storage.configure(dataDir, t.s3, 1 << 30);
      await datasets.residentSource(p, s3.id); // start the fill
      await cache.settle();
      console.log(`file sizes: ${fs.readdirSync(cache.dirFor(dataDir, 'bench')).map((n) => (fs.statSync(path.join(cache.dirFor(dataDir, 'bench'), n)).size / 2 ** 20).toFixed(1) + ' MiB').join(', ')}`);
      const first: Record<string, number> = {};
      for (const [mode, id] of cases) {
        pool.shutdown();
        pool = poolMod.routeByOrg(poolCfg);
        first[mode] = await timed(mode, id, page);
      }
      cache.resetCounts();
      const out: Record<string, { page: number[]; chart: number[] }> = {};
      for (const [m] of cases) out[m] = { page: [], chart: [] };
      for (let r = 0; r < RUNS; r++) {
        for (const [mode, id] of cases) {
          out[mode].page.push(await timed(mode, id, page));
          out[mode].chart.push(await timed(mode, id, chart));
        }
      }
      console.log(`first page in a fresh worker (cold) ms: ${Object.entries(first).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ')}`);
      for (const [mode] of cases) {
        console.log(`${mode.padEnd(10)} page median ${median(out[mode].page).toFixed(1)} ms · chart median ${median(out[mode].chart).toFixed(1)} ms (n=${RUNS})`);
      }
      const c = cache.stats();
      console.log(`cache over the timed runs: ${c.hits} hits / ${c.hits + c.misses} lookups = ${(100 * c.hits / Math.max(1, c.hits + c.misses)).toFixed(1)}% (misses are the cache-off runs), ${(c.bytes / 2 ** 20).toFixed(1)} MiB cached`);
    });
  } finally {
    pool.shutdown();
    recordFs.useRecordDb(null);
    storage.useStorageDb(null);
    await t.teardown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
