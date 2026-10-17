// Stored images follow the org to every pod (src/app/blobStore.ts, 0018_blobs).
//
// A logo or an Image-card picture was a file on the pod that took the upload,
// while the org's settings told every pod it existed: on a second pod, or one
// whose emptyDir was wiped, it was silently gone — and export, import, backup
// and restore lost it too. Here: REAL server processes, each with its own
// DATA_DIR, one Postgres.
//
//   1. the workspace logo, a picture and a capture's screenshot, put on pod A,
//      are equal on pod B and on a brand-new pod C, and on pod A after its own
//      disk was wiped — none of them a file under branding/ or assets/ on any
//      pod — NEGATIVE CONTROL: two pods without a database disagree;
//   2. a project exported from one pod and imported on another keeps its
//      picture, and deleting a project leaves no row of it;
//   3. a logo file an earlier version left on one pod's disk is served by a
//      pod that never had it (seeded on first read);
//   4. the rows are the org's own (RLS, as an ordinary role).
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-blobs-pods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { ChildProcess } from 'child_process';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawn }: typeof import('child_process') = require('child_process');
const { randomBytes, randomUUID }: typeof import('crypto') = require('crypto');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-blobpods-${name}-`));
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const png = (w: number, h: number, fill: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(w), u32(h), Buffer.alloc(64, fill)]);
const LOGO = png(4, 1, 1);
const PIC = png(2, 1, 2);
const CROP = png(3, 3, 3);
const dataUrl = (b: Buffer): string => 'data:image/png;base64,' + b.toString('base64');

const pods: ChildProcess[] = [];
/** A real server process on its own DATA_DIR. Resolves to its base URL. */
async function pod(env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '', PORT: '0', ORDINATE_ENV: 'dev', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pods.push(child);
  let out = '';
  let err = '';
  child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pod did not start: ${err || out}`.slice(0, 600))), 30_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`pod exited ${code}: ${err}`.slice(0, 600))); });
  });
}
const stop = (child: ChildProcess): Promise<void> => new Promise((r) => { child.once('exit', () => r()); child.kill(); });

async function call(base: string, email: string | null, channel: string, payload?: unknown): Promise<{ status: number; body: any }> { // any: each channel's own reply
  const res = await fetch(`${base}/api/rpc/${channel}`, {
    method: 'POST',
    headers: withCsrf({ 'content-type': 'application/json', ...(email ? { 'x-forwarded-email': email } : {}) }),
    body: wire.encode({ args: payload === undefined ? [] : [payload] }),
  });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
}
async function upload(base: string, email: string | null, bytes: Buffer, name: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: withCsrf(email ? { 'x-forwarded-email': email } : {}) });
  return ((await res.json()) as { fileToken: string }).fileToken;
}
/** Every file under `dir` whose '/'-path matches `re`. */
function filesUnder(dir: string, re: RegExp, rel = ''): string[] {
  let out: string[] = [];
  for (const e of fs.existsSync(path.join(dir, rel)) ? fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) : []) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(filesUnder(dir, re, r));
    else if (re.test(r)) out.push(r);
  }
  return out;
}
const STORED = /^orgs\/[^/]+\/userData\/(branding\/|projects\/[^/]+\/assets\/)/;

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip stored-images pods suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_blobpods_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const role = `blobs_reader_${process.pid}`;
  let rolePool: Pool | null = null;
  try {
    const db = { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_MASTER_KEY: randomBytes(32).toString('base64') };
    const BOSS = 'boss@acme.test';
    const acme = { ...db, ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: BOSS };
    const [dirA, dirB, dirC] = [tmp('a'), tmp('b'), tmp('c')];
    const A = await pod({ ...acme, DATA_DIR: dirA });
    const B = await pod({ ...acme, DATA_DIR: dirB });
    const rows = async (like: string): Promise<string[]> =>
      (await pool.query<{ path: string }>('SELECT path FROM blobs WHERE org_id = $1 AND path LIKE $2 ORDER BY path', ['acme', like])).rows.map((r) => r.path);

    // ── 1. On pod A: a logo, a picture, a capture ──────────────────────────
    const t0 = performance.now();
    const set = await call(A, BOSS, 'branding:setLogo', { fileToken: await upload(A, BOSS, LOGO, 'logo.png') });
    const onB = await call(B, BOSS, 'branding:logo', 'workspace');
    const roundTrip = performance.now() - t0;
    ok('pod A: the admin sets the logo', set.status === 200 && set.body.ok === true && set.body.dataUrl === dataUrl(LOGO), JSON.stringify(set.body).slice(0, 200));
    ok('pod B serves the same logo at once', onB.body.dataUrl === dataUrl(LOGO));
    console.log(`     logo upload on A → read on B: ${roundTrip.toFixed(0)} ms`);
    const pid = (await call(A, BOSS, 'projects:create', { name: 'Pictures' })).body.id as string;
    const img = await call(A, BOSS, 'asset:importImage', { projectId: pid, fileToken: await upload(A, BOSS, PIC, 'pic.png') });
    ok('pod A: a picture is added to a project', img.body.ok === true && img.body.asset.ext === 'png', JSON.stringify(img.body));
    const aid = img.body.asset.id as string;
    // A capture as captureUpload stores it: the thread is a record (a row), the crop.png a file on pod A.
    const cid = randomUUID();
    const thread = { id: cid, projectId: pid, title: 'Shot', createdAt: 'a', updatedAt: 'a', cropPath: 'x', messages: [{ role: 'user', text: 'read', image: CROP.toString('base64') }] };
    await pool.query('INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)', ['acme', `history/${cid}/thread.json`, JSON.stringify(thread)]);
    fs.mkdirSync(path.join(dirA, 'orgs', 'acme', 'userData', 'history', cid), { recursive: true });
    fs.writeFileSync(path.join(dirA, 'orgs', 'acme', 'userData', 'history', cid, 'crop.png'), CROP);

    const three = async (base: string): Promise<string> => JSON.stringify([
      (await call(base, BOSS, 'branding:logo', 'workspace')).body.dataUrl,
      (await call(base, BOSS, 'asset:read', { projectId: pid, id: aid, ext: 'png' })).body.dataUrl,
      (await call(base, BOSS, 'captureDataset:image', { projectId: pid, captureId: cid })).body.dataUrl,
    ]);
    const want = JSON.stringify([dataUrl(LOGO), dataUrl(PIC), dataUrl(CROP)]);
    ok('pod A serves the logo, the picture and the screenshot', (await three(A)) === want);
    ok('pod B serves the same three', (await three(B)) === want, await three(B));
    const C = await pod({ ...acme, DATA_DIR: dirC });
    ok('a brand-new pod C with an empty disk serves the same three', (await three(C)) === want);
    const stray = [dirA, dirB, dirC].flatMap((d) => filesUnder(d, STORED));
    ok('no pod has a file under branding/ or projects/*/assets/', stray.length === 0, stray.join());
    for (const sub of ['branding', 'history', 'projects']) fs.rmSync(path.join(dirA, 'orgs', 'acme', 'userData', sub), { recursive: true, force: true });
    ok('pod A, its disk wiped under it, still serves the three', (await three(A)) === want);
    ok('two rows: the logo and the picture (the screenshot is in its thread record)', JSON.stringify(await rows('%')) === JSON.stringify(['branding/logo.png', `projects/${pid}/assets/${aid}.png`]));

    // NEGATIVE CONTROL: without a database the logo is the uploading pod's file.
    const F1 = await pod({ AUTH_MODE: 'dev', DATA_DIR: tmp('f1') });
    const F2 = await pod({ AUTH_MODE: 'dev', DATA_DIR: tmp('f2') });
    await call(F1, null, 'branding:setLogo', { fileToken: await upload(F1, null, LOGO, 'logo.png') });
    ok('NEGATIVE CONTROL: two pods without a database disagree on the logo',
      (await call(F1, null, 'branding:logo', 'workspace')).body.dataUrl === dataUrl(LOGO) && (await call(F2, null, 'branding:logo', 'workspace')).body.dataUrl === null);

    // ── 2. Export on one pod, import on another, delete ──────────────────────
    const exp = await call(A, BOSS, 'projects:export', { id: pid });
    ok('pod A exports the project, its picture counted', exp.body.ok === true && exp.body.counts?.assets === 1, JSON.stringify(exp.body).slice(0, 200));
    const bundle = Buffer.from(await (await fetch(`${A}/api/files/${exp.body.downloadToken}`, { headers: { 'x-forwarded-email': BOSS } })).arrayBuffer());
    const imp = await call(B, BOSS, 'projects:import', { fileToken: await upload(B, BOSS, bundle, 'p.ordinate') });
    const newPid = imp.body.project?.id as string;
    ok('pod B imports it as a new project', imp.body.ok === true && !!newPid && newPid !== pid, JSON.stringify(imp.body).slice(0, 200));
    const imported = await rows(`projects/${newPid}/assets/%`);
    const newAid = imported[0] ? path.basename(imported[0], '.png') : '';
    ok('the imported picture is a row (its id remapped, being in use here)', imported.length === 1 && newAid !== aid, imported.join());
    ok('pod C serves the imported picture', (await call(C, BOSS, 'asset:read', { projectId: newPid, id: newAid, ext: 'png' })).body.dataUrl === dataUrl(PIC));
    for (const id of [pid, newPid]) await call(C, BOSS, 'projects:delete', { id });
    ok('deleting both projects leaves 0 picture rows', (await rows('projects/%')).length === 0, (await rows('projects/%')).join());
    ok('…and the logo stays', JSON.stringify(await rows('%')) === JSON.stringify(['branding/logo.png']));

    // ── 3. A logo file from before the table ────────────────────────────────
    const dirL = tmp('legacy');
    fs.mkdirSync(path.join(dirL, 'orgs', 'legacy', 'userData', 'branding'), { recursive: true });
    fs.writeFileSync(path.join(dirL, 'orgs', 'legacy', 'userData', 'branding', 'logo.png'), LOGO);
    const legacy = { ...db, ORDINATE_ORG: 'legacy', ORDINATE_ADMIN_EMAIL: 'boss@legacy.test' };
    const L1 = await pod({ ...legacy, DATA_DIR: dirL });
    const L2 = await pod({ ...legacy, DATA_DIR: tmp('legacy2') });
    const legacyLogo = async (base: string): Promise<string | null> => (await call(base, 'boss@legacy.test', 'branding:logo', 'workspace')).body.dataUrl;
    ok('NOT YET: a pod without the old file has no logo before any pod read it', (await legacyLogo(L2)) === null);
    ok('the pod with the old file serves it', (await legacyLogo(L1)) === dataUrl(LOGO));
    ok('…and from then on so does the pod without it: the first read seeded the row', (await legacyLogo(L2)) === dataUrl(LOGO));
    ok('acme\'s logo is untouched', (await call(B, BOSS, 'branding:logo', 'workspace')).body.dataUrl === dataUrl(LOGO));

    // ── 4. RLS, as an ordinary role ─────────────────────────────────────────
    const pw = randomBytes(12).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await pool.query(`GRANT SELECT ON blobs TO ${role}`);
    const asRole = new URL(scratch.toString());
    asRole.username = role;
    asRole.password = pw;
    rolePool = new Pool({ connectionString: asRole.toString(), max: 1 });
    rolePool.on('error', () => undefined);
    const rp = rolePool;
    const see = async (org: string | null): Promise<string> => {
      const c = await rp.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
        const r = await c.query<{ org_id: string }>('SELECT DISTINCT org_id FROM blobs ORDER BY 1');
        await c.query('COMMIT');
        return r.rows.map((x) => x.org_id).join();
      } finally {
        c.release();
      }
    };
    ok('RLS: an ordinary role sees its org\'s rows only, and none with no org set',
      (await see('acme')) === 'acme' && (await see('legacy')) === 'legacy' && (await see(null)) === '', `${await see('acme')}|${await see('legacy')}|${await see(null)}`);
  } finally {
    await Promise.all(pods.map(stop));
    await rolePool?.end();
    await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('stored-images pods suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
