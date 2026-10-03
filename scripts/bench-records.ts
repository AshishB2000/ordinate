// Records on JSON files vs Postgres (T5.1): save, get and list 1,000 visuals
// through the real store, server mode, one org per backend.
//
//   npm run build:ts && DATABASE_URL=… node scripts/bench-records.js [n]

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const N = Number(process.argv[2]) || 1000;
const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'electron') return { app: { getPath: () => { throw new Error('server mode'); } } };
  return origLoad.apply(this, [request, ...rest]);
};
const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

async function bench(org: string): Promise<Record<string, string>> {
  return context.runInContext({ user: { email: 'b', role: 'admin' }, org: { id: org } }, org, async () => {
    const p = await projects.createProject('Bench');
    const d = await datasets.saveDataset(p.id, { name: 'D', sourceKind: 'csv', columns: [{ name: 'x', type: 'text' }, { name: 'y', type: 'number' }], rows: [['a', 1]] } as never);
    const save: number[] = [];
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const v = await visuals.saveVisual(p.id, { name: 'V' + i, datasetId: d!.id, chartType: 'bar', encoding: { category: 'x', values: [{ column: 'y', aggregation: 'sum' }] } });
      save.push(performance.now() - t);
      ids.push(v!.id);
    }
    const get: number[] = [];
    for (const id of ids) {
      const t = performance.now();
      await visuals.getVisual(p.id, id);
      get.push(performance.now() - t);
    }
    const list: number[] = [];
    let n = 0;
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      n = (await visuals.listVisuals(p.id)).length;
      list.push(performance.now() - t);
    }
    if (n !== N) throw new Error(`listed ${n}, expected ${N}`);
    // A version per visual too (the IPC layer records one on every save), then
    // the Home list: projects/ is one range over every row of the org.
    for (const id of ids) await versions.record(p.id, 'visual', await visuals.getVisual(p.id, id));
    const home: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      await projects.listProjects();
      home.push(performance.now() - t);
    }
    return {
      'save (median / p95 ms)': `${median(save).toFixed(2)} / ${p95(save).toFixed(2)}`,
      'get (median / p95 ms)': `${median(get).toFixed(2)} / ${p95(get).toFixed(2)}`,
      [`list ${N} (median of 5, ms)`]: median(list).toFixed(1),
      [`projects.list over ${2 * N + 3} records (median of 5, ms)`]: median(home).toFixed(1),
    };
  });
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is required');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-records-'));
  context.enterServerMode(tmp);
  const dbName = `ordinate_t51b_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await mig.migrate(pool);
    const json = await bench('bench-json');
    recordFs.useRecordDb(pool);
    const pg = await bench('bench-pg');
    recordFs.useRecordDb(null);
    console.log(`${N} visuals through visuals.ts, server mode, local disk vs local Postgres 17:`);
    console.table(Object.fromEntries(Object.keys(json).map((k) => [k, { json: json[k], postgres: pg[k] }])));
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
