// "Start with sample data" on a real install: `sample:seed` over real HTTP,
// against a real Postgres (first-run pass, F1).
//
// A new org has no project, and nothing on the server made one: the bundled
// sample was only ever seeded by the desktop app's first launch. `sample:seed`
// makes the org's first project with the sample dataset and its dashboard,
// through the ordinary save paths — so here the records land in Postgres. It
// is refused once the org has a project, and to an org viewer.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-sampleSeed-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sample-seed-'));

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip sample:seed DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_sample_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const apps: FastifyInstance[] = [];
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();

    // A spy on the handler: a denied call must never reach it.
    let ran = 0;
    const real = rpc.handlers.get('sample:seed');
    ok('contract: sample:seed has a handler', typeof real === 'function');
    if (!real) return;
    rpc.registry.removeHandler('sample:seed');
    rpc.registry.handle('sample:seed', (e, ...args) => { ran += 1; return real(e, ...args); });

    const base: Record<string, string> = {};
    for (const org of ['acme', 'beta', 'gamma']) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`,
      }));
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base[org] = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    }
    const call = async (org: string, email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base[org]}/api/rpc/${channel}`, {
        method: 'POST',
        headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    const list = async (org: string) => ((await call(org, `boss@${org}.test`, 'projects:list')).body as { id: string; name: string }[]);

    // ── A new org is empty, and a viewer cannot change that ────────────────
    ok('a new org has no project', (await list('acme')).length === 0);
    await call('acme', 'vik@acme.test', 'projects:list'); // provisions vik as an org viewer
    const denied = await call('acme', 'vik@acme.test', 'sample:seed');
    ok('an org viewer is refused (403) before the handler runs', denied.status === 403 && ran === 0, `${denied.status} ran=${ran}`);

    // ── The admin starts with the sample ───────────────────────────────────
    const seeded = await call('acme', 'boss@acme.test', 'sample:seed');
    const pid: string = seeded.body?.projectId;
    ok('the admin seeds: ok with a project and its dashboard', seeded.status === 200 && seeded.body.ok === true && typeof pid === 'string' && typeof seeded.body.analysisId === 'string', JSON.stringify(seeded.body));
    const after = await list('acme');
    ok(`the org has one project, "${sample.FIRST_PROJECT_NAME}"`, after.length === 1 && after[0].id === pid && after[0].name === sample.FIRST_PROJECT_NAME, JSON.stringify(after));
    const datasets = (await call('acme', 'boss@acme.test', 'dataset:list', { projectId: pid })).body as { name: string; rowCount: number }[];
    ok(`it holds "${sample.SAMPLE_DATASET_NAME}" with 5,000 rows`, datasets.length === 1 && datasets[0].name === sample.SAMPLE_DATASET_NAME && datasets[0].rowCount === 5000, JSON.stringify(datasets.map((d) => [d.name, d.rowCount])));
    const roles = (await call('acme', 'boss@acme.test', 'projects:roles')).body as Record<string, string>;
    ok('the caller is granted admin on it', roles[pid] === 'admin', JSON.stringify(roles));
    const rows = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM records WHERE org_id = 'acme'`);
    ok('its records are in Postgres, not files', Number(rows.rows[0].n) > 0, `records=${rows.rows[0].n}`);
    ok('the viewer still sees nothing: the sample is not shared by itself', ((await call('acme', 'vik@acme.test', 'projects:list')).body as unknown[]).length === 0);

    // ── Once the org has a project, it is refused ──────────────────────────
    const again = await call('acme', 'boss@acme.test', 'sample:seed');
    ok('a second call is refused: has_projects, still one project', again.status === 200 && again.body.ok === false && again.body.error === 'has_projects' && (await list('acme')).length === 1, JSON.stringify(again.body));
    ok('another org is untouched', (await list('beta')).length === 0);

    // ── Two clicks at once make one project ────────────────────────────────
    const [a, b] = await Promise.all([call('beta', 'boss@beta.test', 'sample:seed'), call('beta', 'boss@beta.test', 'sample:seed')]);
    ok('two calls at once: one project, the same answer to both', a.body.ok === true && b.body.ok === true && a.body.projectId === b.body.projectId && (await list('beta')).length === 1,
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)} projects=${(await list('beta')).length}`);
    // NEGATIVE CONTROL: without the handler's guard the same race makes two.
    await call('gamma', 'boss@gamma.test', 'projects:list');
    const boss = (await pool.query<{ id: string; email: string; role: string }>(`SELECT id, email, role FROM users WHERE org_id = 'gamma'`)).rows[0];
    const twice = await context.runInContext({ org: { id: 'gamma' }, user: boss } as never, 'sample-seed-control', async () => {
      await Promise.all([sample.seedSampleProject({ again: true }), sample.seedSampleProject({ again: true })]);
      return (await projects.listProjects()).length;
    });
    ok('NEGATIVE CONTROL: the unguarded seed, raced, makes two projects', twice === 2, `projects=${twice}`);
  } finally {
    for (const app of apps) await app.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((e) => ok('sample:seed DB suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
