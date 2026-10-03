// Self-check for records in Postgres (src/app/recordFs.ts, T5.1).
//
//  1. Routing: which userData paths are records (pure).
//  2. Differential: scripts/recordsScenario.ts drives EVERY record store's
//     public API — projects, datasets, visuals, dashboards, metrics, reports,
//     versions, alerts, stories, scorecards, scenarios, notebooks, events,
//     relationships, fx, comments, catalog, pipelines, privacy, copilot,
//     publish config, connections, boundaries, capture history, themes,
//     templates, trash, bundle export — once on JSON files and once on
//     Postgres, each in a fresh process with a frozen clock and counted ids.
//     Every call's result and the final record state must be identical, and
//     the Postgres run must leave no record file on disk.
//  3. Tenancy: org B, holding org A's ids, reads/updates/deletes nothing of
//     A's through the stores (app-level `org_id = $1`; the test role is a
//     superuser, so RLS is not what stops it) — and, as an ordinary role
//     with the WHERE left out, the RLS policy alone hides, protects and
//     refuses A's rows.
//
// The DB half needs a Postgres it may CREATE DATABASE (and ROLE) on; without
// DATABASE_URL it prints one `skip` line and runs only the routing checks.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-records.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { Client, Pool } from 'pg';

const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'electron') return { app: { getVersion: () => '0.0.0-test', getPath: () => { throw new Error('server mode: no Electron paths'); } } };
  return origLoad.apply(this, [request, ...rest]);
};

const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const context: typeof import('../src/server/context') = require('../src/server/context');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-records-'));

function routing(): void {
  const yes = [
    'projects/p/project.json', 'projects/p/visuals/v.json', 'projects/p/alerts.json', 'projects/p/trash/visual/v.json',
    'projects/p/history/visual/v/2026-01-01T00-00-00-000Z.json', 'projects/p/visuals/v.json.abc.tmp', 'projects/p/comments.json.corrupt',
    'projects/p/datasets/d.snapshots.json', 'history/1/thread.json', 'templates/t.json', 'themes.json', 'themes.json.x.tmp',
  ];
  const no = [
    'config.json', 'jobs.json', 'projects/p/datasets/d.parquet', 'projects/p/datasets/d.source.parquet', 'projects/p/privacy/salt.key',
    'projects/p/datasets/d.search.json', 'history/1/crop.png', 'projects/p/assets/a.png', 'backups/x.json', 'projects', 'projects/p',
  ];
  ok('routing: every record path is a record', yes.every(recordFs.isRecordPath), yes.filter((r) => !recordFs.isRecordPath(r)).join());
  ok('routing: settings, Parquet, keys, caches, images and directories are not', !no.some(recordFs.isRecordPath), no.filter(recordFs.isRecordPath).join());
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, 'recordsScenario.js'), ...args], { maxBuffer: 64 << 20 }, (e, out, err) =>
      resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out, err }));
  });
}

interface Pass {
  steps: Array<[string, unknown]>;
  records: Record<string, string>;
  files: string[];
}

async function differential(url: string): Promise<void> {
  for (const d of ['json', 'pg']) fs.mkdirSync(path.join(TMP, d));
  const [j, p] = await Promise.all([run(['json', path.join(TMP, 'json')]), run(['pg', path.join(TMP, 'pg'), url])]);
  ok('differential: the JSON run completes', j.code === 0, j.err.slice(-2000));
  ok('differential: the Postgres run completes', p.code === 0, p.err.slice(-2000));
  if (j.code || p.code) return;
  const J = JSON.parse(j.out) as Pass;
  const P = JSON.parse(p.out) as Pass;
  ok(`differential: both runs made the same ${J.steps.length} calls`, isDeepStrictEqual(J.steps.map((s) => s[0]), P.steps.map((s) => s[0])));
  // One line per store, so a failure names it.
  const stores = new Map<string, number>();
  for (const [label] of J.steps) stores.set(label.split(/[. ]/)[0], (stores.get(label.split(/[. ]/)[0]) || 0) + 1);
  for (const [store, n] of stores) {
    const bad = J.steps.filter(([l], i) => l.split(/[. ]/)[0] === store && !isDeepStrictEqual(J.steps[i][1], P.steps[i][1]));
    ok(`differential: ${store} — ${n} calls, identical results on JSON and Postgres`, bad.length === 0,
      bad.map(([l]) => `${l}\n  json ${JSON.stringify(J.steps.find((s) => s[0] === l)![1]).slice(0, 400)}\n  pg   ${JSON.stringify(P.steps.find((s) => s[0] === l)![1]).slice(0, 400)}`).join('\n'));
  }
  const nonTrivial = J.steps.filter(([, v]) => v !== null && v !== undefined && v !== false && !(v && typeof v === 'object' && 'threw' in v)).length;
  ok(`differential: the scenario is not vacuous (${nonTrivial} of ${J.steps.length} calls returned something, none threw)`,
    nonTrivial > J.steps.length * 0.85 && !J.steps.some(([, v]) => v && typeof v === 'object' && 'threw' in (v as object)));
  const keys = Object.keys(J.records).sort();
  ok(`differential: the final ${keys.length} records are byte-identical (files vs rows)`,
    isDeepStrictEqual(J.records, P.records) && keys.length >= 20,
    [...new Set([...keys, ...Object.keys(P.records)])].filter((k) => J.records[k] !== P.records[k]).join('\n'));
  ok('differential: the same non-record files (Parquet) on disk, same sizes', isDeepStrictEqual(J.files, P.files) && J.files.some((f) => f.includes('.parquet')),
    JSON.stringify({ json: J.files, pg: P.files }));
}

async function tenancy(url: string, admin: Client): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  context.enterServerMode(path.join(TMP, 'tenancy'));
  recordFs.useRecordDb(pool);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const trash: typeof import('../src/app/trash') = require('../src/app/trash');
  const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
  const as = <T>(org: string, fn: () => Promise<T>): Promise<T> =>
    context.runInContext({ user: { email: org + '@t', role: 'admin' }, org: { id: org } }, org, fn);

  try {
    const a = await as('org-a', async () => {
      const p = await projects.createProject('A secret');
      const d = await datasets.saveDataset(p.id, { name: 'Payroll', sourceKind: 'csv', columns: [{ name: 'n', type: 'number' }], rows: [[1]] } as never);
      const v = await visuals.saveVisual(p.id, { name: 'A chart', datasetId: d!.id, chartType: 'bar', encoding: { category: 'n', values: [] } });
      return { pid: p.id, did: d!.id, vid: v!.id, file: path.join(appPaths.userData(), 'projects', p.id, 'project.json') };
    });
    const before = await as('org-a', async () => JSON.stringify([await projects.getProject(a.pid), await datasets.listDatasets(a.pid), await visuals.listVisuals(a.pid)]));

    const b = await as('org-b', async () => ({
      list: await projects.listProjects(),
      get: await projects.getProject(a.pid),
      ds: await datasets.listDatasets(a.pid),
      dsGet: await datasets.getDatasetMeta(a.pid, a.did),
      vis: await visuals.getVisual(a.pid, a.vid),
      rename: await projects.renameProject(a.pid, 'pwned'),
      update: await visuals.updateVisual(a.pid, a.vid, { name: 'pwned' } as never),
      trash: await trash.trashRecord(a.pid, 'visual', a.vid),
      delDs: await datasets.deleteDataset(a.pid, a.did),
      delProject: await projects.deleteProject(a.pid),
      // A's absolute path is not under B's userData: plain disk, where A's record is not.
      readA: await recordFs.readFile(a.file, 'utf8').then(() => 'read', (e: NodeJS.ErrnoException) => e.code),
    }));
    ok('tenancy: org B lists no projects', b.list.length === 0, JSON.stringify(b.list));
    ok('tenancy: org B cannot read A\'s project, datasets or visual by id', b.get === null && b.ds.length === 0 && b.dsGet === null && b.vis === null);
    ok('tenancy: org B cannot rename A\'s project or update A\'s visual', b.rename === null && b.update === null);
    // deleteDataset is idempotent (a missing id is success), so the proof is A's rows below, not its return.
    ok('tenancy: org B cannot trash A\'s visual', !b.trash.ok, JSON.stringify(b.trash));
    ok('tenancy: org B cannot read A\'s record by its absolute path', b.readA === 'ENOENT', b.readA);
    const after = await as('org-a', async () => JSON.stringify([await projects.getProject(a.pid), await datasets.listDatasets(a.pid), await visuals.listVisuals(a.pid)]));
    ok('tenancy: org A\'s project, dataset and visual are untouched afterwards', after === before && JSON.parse(after)[0] !== null);
    ok('tenancy: B\'s "deleteProject" left A\'s rows in place',
      Number((await pool.query('SELECT count(*) AS n FROM records WHERE org_id = $1', ['org-a'])).rows[0].n) >= 3);

    // The same ids in two orgs (an import, a crafted bundle): each org's caches answer for itself.
    const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
    const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
    const rel = path.join('projects', a.pid);
    const seed = (org: string, target: string): Promise<void> => as(org, async () => {
      await recordFs.writeFile(path.join(appPaths.userData(), rel, 'project.json'), JSON.stringify({ id: a.pid, name: org, schemaVersion: 1, createdAt: 'x', updatedAt: 'x' }));
      await recordFs.writeFile(path.join(appPaths.userData(), rel, 'fx.json'), JSON.stringify({ target }));
    });
    await seed('org-a', 'EUR');
    await seed('org-b', 'JPY');
    const fxA = await as('org-a', () => fxStore.getFx(a.pid));
    const fxB = await as('org-b', () => fxStore.getFx(a.pid));
    ok('tenancy: the same project id in two orgs — each reads its own fx settings (cache is per org)', fxA.target === 'EUR' && fxB.target === 'JPY', JSON.stringify([fxA, fxB]));
    const parts = { datasetId: a.did, updatedAt: 'u', pipelineHash: 'h' };
    const kA = await as('org-a', async () => queryCache.cacheKey('aggregate', parts, {}));
    const kB = await as('org-b', async () => queryCache.cacheKey('aggregate', parts, {}));
    ok('tenancy: the answer cache keys the same dataset id differently per org', kA !== kB);
    const bNames = await as('org-b', async () => (await projects.listProjects()).map((p) => p.name));
    ok('tenancy: org B now lists only its own copy', JSON.stringify(bNames) === '["org-b"]', JSON.stringify(bNames));

    // RLS alone: an ordinary role, queries WITHOUT an org filter.
    const role = `ordinate_rls_${process.pid}_${randomBytes(3).toString('hex')}`;
    const pw = randomBytes(12).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    try {
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON records TO ${role}`);
      const u = new URL(url);
      u.username = role;
      u.password = pw;
      const c = new Client({ connectionString: u.toString() });
      await c.connect();
      try {
        const asOrg = async (org: string | null, q: string, params: unknown[] = []): Promise<{ n: number; err?: string }> => {
          await c.query('BEGIN');
          try {
            if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
            const r = await c.query(q, params);
            await c.query('COMMIT');
            return { n: r.rowCount ?? 0 };
          } catch (err) {
            await c.query('ROLLBACK');
            return { n: -1, err: (err as Error).message };
          }
        };
        const seeA = await asOrg('org-a', 'SELECT * FROM records');
        ok('rls: as org A the ordinary role sees A\'s rows (not vacuous)', seeA.n >= 3, JSON.stringify(seeA));
        ok('rls: as org B, SELECT naming org A returns none of its rows', (await asOrg('org-b', `SELECT * FROM records WHERE org_id = 'org-a'`)).n === 0);
        ok('rls: as org B, SELECT with no WHERE returns only B\'s own rows', (await asOrg('org-b', `SELECT * FROM records WHERE org_id <> 'org-b'`)).n === 0
          && (await asOrg('org-b', 'SELECT * FROM records')).n > 0);
        ok('rls: with no org set, nothing is visible', (await asOrg(null, 'SELECT * FROM records')).n === 0);
        ok('rls: as org B, UPDATE naming org A changes nothing', (await asOrg('org-b', `UPDATE records SET body = 'pwned' WHERE org_id = 'org-a'`)).n === 0);
        ok('rls: as org B, DELETE naming org A removes nothing', (await asOrg('org-b', `DELETE FROM records WHERE org_id = 'org-a'`)).n === 0);
        const ins = await asOrg('org-b', `INSERT INTO records (org_id, path, body) VALUES ('org-a', 'projects/x/project.json', '{}')`);
        ok('rls: as org B, writing a row into org A is refused', ins.n === -1 && /row-level security/.test(ins.err || ''), JSON.stringify(ins));
        ok('rls: A\'s rows survived all of it', (await asOrg('org-a', `SELECT * FROM records WHERE body <> 'pwned'`)).n === seeA.n);
      } finally {
        await c.end();
      }
    } finally {
      await pool.query(`REVOKE ALL ON records FROM ${role}`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
  } finally {
    recordFs.useRecordDb(null);
    await pool.end().catch(() => undefined);
  }
}

(async () => {
  routing();
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_t51_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const url = u.toString();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    const pool = new Pool({ connectionString: url, max: 2 });
    pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
    const r = await mig.migrate(pool);
    await pool.end();
    ok('migrate: 0007_records.sql applies', r.applied.includes('0007_records.sql'), r.applied.join());
    await differential(url);
    await tenancy(url, admin);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
