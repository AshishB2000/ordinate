// Names on Admin → Audit log (src/server/admin/auditNames.ts) and the batched
// record read under it (recordFs.readMany), against a real Postgres.
//
// What an id names comes from the CALLER's org only: another org's record,
// user or team with an id on the page stays unnamed (negative control: the
// other org's own admin does see it). A live record wins over its Trash copy;
// a corrupt record and an id that names nothing get no entry. readMany is
// checked against readFile, path by path, with Object.is.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-auditNames.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const paths: typeof import('../src/app/paths') = require('../src/app/paths');
const migrateMod: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const { auditNames }: typeof import('../src/server/admin/auditNames') = require('../src/server/admin/auditNames');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1), D = id(2), V = id(3), V2 = id(4), C = id(5), X = id(6), B = id(7), CARD = id(8), D2 = id(9), U = id(10), T = id(11), BU = id(12);
const as = <R>(org: string, fn: () => Promise<R>) => context.runInContext({ user: { email: `boss@${org}.test`, role: 'admin' }, org: { id: org } }, `req-${org}`, fn);
const file = (...parts: string[]) => path.join(paths.userData(), 'projects', ...parts);
const put = (rel: string[], body: unknown) => recordFs.writeFile(file(...rel), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip audit names checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_auditnames_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await migrateMod.migrate(pool);
    context.enterServerMode(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-audit-names-')));
    recordFs.useRecordDb(pool);
    await pool.query(`INSERT INTO orgs (id, name) VALUES ('acme', 'Acme'), ('beta', 'Beta')`);
    await pool.query(`INSERT INTO users (id, org_id, email) VALUES ($1, 'acme', 'ana@acme.test'), ($2, 'beta', 'bo@beta.test')`, [U, BU]);
    await pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, 'acme', 'Ops')`, [T]);

    await as('acme', async () => {
      await put([P, 'project.json'], { id: P, name: 'Test' });
      await put([P, 'datasets', D + '.json'], { id: D, name: '  Sales Q3  ' });
      await put([P, 'datasets', D2 + '.json'], { id: D2, name: 'Orders' });
      await put([P, 'trash', 'visual', V + '.json'], { id: V, name: 'Revenue', deletedAt: '2026-10-24T00:00:00Z' });
      await put([P, 'visuals', V2 + '.json'], { id: V2, name: 'Live copy' });
      await put([P, 'trash', 'visual', V2 + '.json'], { id: V2, name: 'Old copy', deletedAt: '2026-10-01T00:00:00Z' });
      await put([P, 'connections', C + '.json'], { id: C, name: 'Warehouse' });
      await put([P, 'analyses', X + '.json'], '{"name": "unterminated');
    });
    // The same project id in another org, holding a record whose id the acme page also shows.
    await as('beta', async () => {
      await put([P, 'project.json'], { id: P, name: 'Beta project' });
      await put([P, 'datasets', B + '.json'], { id: B, name: 'Beta secret' });
    });

    const rows = [
      { projectId: P, targets: [D, V, V2, C, X, B, CARD] },
      { projectId: null, targets: [P, D2, U, T, BU] }, // an org-level call names its project among its ids
    ];
    const got = await as('acme', () => auditNames(pool, 'acme', rows));
    const want = {
      [U]: { kind: 'user', name: 'ana@acme.test' },
      [T]: { kind: 'team', name: 'Ops' },
      [P]: { kind: 'project', name: 'Test' },
      [D]: { kind: 'dataset', name: 'Sales Q3' },
      [V]: { kind: 'visual', name: 'Revenue', trashed: true },
      [V2]: { kind: 'visual', name: 'Live copy' },
      [C]: { kind: 'connection', name: 'Warehouse' },
      [D2]: { kind: 'dataset', name: 'Orders' },
    };
    const sorted = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
    ok('names: users, teams, the project, live and Trash records, connections, through either way a row names its project', sorted(got) === sorted(want), got);
    ok('names: a live record wins over its Trash copy', got[V2]?.name === 'Live copy');
    ok('names: a corrupt record and an id that names nothing get no entry', !(X in got) && !(CARD in got));
    ok('isolation: another org\'s record and user with ids on the page stay unnamed', !(B in got) && !(BU in got) && !JSON.stringify(got).includes('Beta'));
    const beta = await as('beta', () => auditNames(pool, 'beta', [{ projectId: P, targets: [B, BU] }]));
    ok('isolation (control): beta\'s own admin sees beta\'s names', beta[B]?.name === 'Beta secret' && beta[BU]?.name === 'bo@beta.test' && beta[P]?.name === 'Beta project');
    ok('names: an empty page asks nothing', JSON.stringify(await as('acme', () => auditNames(pool, 'acme', []))) === '{}');

    // readMany against readFile, path by path: present, missing, corrupt, another org's.
    await as('acme', async () => {
      const probe = [file(P, 'project.json'), file(P, 'datasets', D + '.json'), file(P, 'analyses', X + '.json'), file(P, 'datasets', B + '.json'), file(P, 'visuals', id(99) + '.json')];
      const many = await recordFs.readMany(probe);
      const one = await Promise.all(probe.map((p) => recordFs.readFile(p, 'utf8').then((t) => t, () => undefined)));
      ok('readMany: each path reads exactly as readFile does (absent where it throws)', probe.every((p, i) => Object.is(many.get(p), one[i])), { many: [...many.keys()].length });
      ok('readMany: another org\'s record is absent', !many.has(file(P, 'datasets', B + '.json')));
    });
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})().catch((e: unknown) => ok('audit names suite ran', false, e)).finally(finish);
