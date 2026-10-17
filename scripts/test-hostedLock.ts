// A refresh-driven re-publish never undoes the owner (src/publish/hosted.ts,
// docs/record-locks/00-design.md).
//
// `buildPages` is parked on a gate — a re-publish computing its figures. During
// the park:
//   - setAccess('org') resolves, and the re-published site is still 'org' —
//     NEGATIVE CONTROL: the old shape (the manifest read before the build,
//     written back after it) restores 'link';
//   - removeSite resolves, the re-publish is refused, and nothing of the site
//     comes back — NEGATIVE CONTROL: the old shape brings the manifest back.
//
// On files always; on Postgres too with DATABASE_URL (a scratch database).
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-hostedLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-hostedlock-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const publish: typeof import('../src/publish/publish') = require('../src/publish/publish');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');

// The pages every build returns, after the gate (when one is up).
let gate: Promise<void> | null = null;
let building = 0;
(publish as { buildPages: unknown }).buildPages = async () => {
  building++;
  if (gate) await gate;
  return { pages: [{ file: 'sales.html', kind: 'dashboard', name: 'Sales', html: '<p>sales</p>' }], index: '<p>index</p>', combos: 1 };
};
function park(): () => void {
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  building = 0;
  return () => { gate = null; open(); };
}
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } }, `r${++req}`, fn);
const manifest = (id: string): Promise<string> => as(async () => path.join(appPaths.userData(), 'published', id, 'manifest.json'));

async function leg(name: string): Promise<void> {
  const p = await as(() => projects.createProject('Publish ' + name));
  const config = { projectId: p.id, dashboardIds: [randomUUID()], storyIds: [], scorecardIds: [], options: { afterRefresh: true } };
  const site = await as(() => hosted.publishHosted(config, 'ana@acme.test', { access: 'link' }));
  ok(`${name}: a site is published, open to anyone with the link`, site.access === 'link' && (await as(() => hosted.getSite(site.id)))?.access === 'link');

  // ── The owner narrows access while a re-publish builds ──────────────────
  let release = park();
  const republish = as(() => hosted.publishHosted(config, site.publishedBy, { id: site.id }));
  await until(() => building > 0);
  const narrowed = await as(() => hosted.setAccess(site.id, 'org'));
  ok(`${name}: setAccess('org') resolves while the re-publish is building`, narrowed?.access === 'org');
  release();
  const rebuilt = await republish;
  const stored = await as(() => hosted.getSite(site.id));
  ok(`${name}: the re-published site keeps the owner's 'org' — not the 'link' it started from`, rebuilt.access === 'org' && stored?.access === 'org', `${rebuilt.access} ${stored?.access}`);

  // NEGATIVE CONTROL: read before the build, write after it.
  await as(() => hosted.setAccess(site.id, 'link'));
  const before = await as(() => hosted.getSite(site.id));
  await as(() => hosted.setAccess(site.id, 'org'));
  await as(async () => recordFs.writeFile(await manifest(site.id), JSON.stringify({ ...before, publishedAt: new Date().toISOString() })));
  ok(`${name} NEGATIVE CONTROL: the old read-build-write restores 'link' over the owner's 'org'`, (await as(() => hosted.getSite(site.id)))?.access === 'link');

  // ── The owner takes the site down while a re-publish builds ─────────────
  release = park();
  const late = as(() => hosted.publishHosted(config, site.publishedBy, { id: site.id })).then(() => 'published', (e: Error) => e.message);
  await until(() => building > 0);
  const removed = await as(() => hosted.removeSite(site.id));
  ok(`${name}: removeSite resolves while the re-publish is building`, removed === true);
  release();
  const outcome = await late;
  ok(`${name}: the late re-publish is refused`, outcome === 'That published link no longer exists.', outcome);
  const left = await as(async () => (await recordFs.readdir(path.join(appPaths.userData(), 'published')).catch((): string[] => [])).includes(site.id));
  ok(`${name}: …and nothing of the site came back — no manifest, no pages`, !(await as(() => hosted.getSite(site.id))) && !left
    && !(await as(() => hosted.getPage(site.id, 'sales.html'))), String(left));

  // NEGATIVE CONTROL: a whole-manifest write after the removal brings the site back.
  await as(async () => {
    await fs.promises.mkdir(path.dirname(await manifest(site.id)), { recursive: true }); // the old write's own mkdir
    await recordFs.writeFile(await manifest(site.id), JSON.stringify(before));
  });
  ok(`${name} NEGATIVE CONTROL: the old write after the build brings the removed site back`, !!(await as(() => hosted.getSite(site.id))));
}

(async () => {
  await leg('file');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_hostedlock_${process.pid}_${Date.now()}`;
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
    await leg('db');
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('hosted lock suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
