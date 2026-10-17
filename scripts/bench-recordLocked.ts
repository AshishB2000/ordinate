// What a locked read-modify-write costs (docs/record-locks/00-design.md), on
// Postgres, server mode, one org:
//
//   1. 200 sequential `comments.add` — the median and p95 of one save;
//   2. a 20-tile `visual:dataBatch` on a dataset with a declared currency,
//      each batch in a new second, so the fx settings' 1 s freshness is paid
//      once per batch (the worst case: the answers themselves are cached).
//
//   npm run build:ts && DATABASE_URL=… node scripts/bench-recordLocked.js

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-locked-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
poolMod.routeByOrg({ dataDir: TMP, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const comments: typeof import('../src/app/comments') = require('../src/app/comments');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const selfcheck: typeof import('./selfcheck') = require('./selfcheck');

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const as = <T>(fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: 'bench@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'bench', fn);

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_benchlock_${process.pid}`;
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
    appMod.registerHandlers();
    const out = await as(async () => {
      const p = await projects.createProject('Bench');
      const add: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t = performance.now();
        const r = await comments.add(p.id, { kind: 'dataset', id: p.id }, 'Comment ' + i);
        add.push(performance.now() - t);
        if (!r.ok) throw new Error(r.error);
      }
      const d = await datasets.saveDataset(p.id, {
        name: 'Sales', sourceKind: 'csv',
        columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
        rows: Array.from({ length: 1000 }, (_, i) => ['r' + (i % 7), i]),
      } as never);
      await fxStore.setColumnCurrency(p.id, d!.id, 'amount', { kind: 'fixed', code: 'EUR' });
      const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
      const items = Array.from({ length: 20 }, () => ({ datasetId: d!.id, encoding: enc }));
      const batch = rpc.handlers.get('visual:dataBatch')!;
      await batch(null, { projectId: p.id, items }); // warm: DuckDB, the answer cache
      const tiles: number[] = [];
      for (let i = 0; i < 15; i++) {
        await sleep(1_100); // a new fx second
        const t = performance.now();
        const r = (await batch(null, { projectId: p.id, items })) as Array<{ ok: boolean }>;
        tiles.push(performance.now() - t);
        if (!r.every((x) => x.ok)) throw new Error('a tile failed: ' + JSON.stringify(r[0]).slice(0, 200));
      }
      return { add, tiles };
    });
    console.log(JSON.stringify({
      commentsAdd: { n: out.add.length, medianMs: +median(out.add).toFixed(2), p95Ms: +p95(out.add).toFixed(2) },
      dataBatch20: { n: out.tiles.length, medianMs: +median(out.tiles).toFixed(2), p95Ms: +p95(out.tiles).toFixed(2) },
    }));
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(TMP, { recursive: true, force: true });
    selfcheck.finish();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
