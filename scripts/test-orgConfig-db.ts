// An org's settings follow it to every pod (first-run pass) — 0014_org_config,
// src/server/orgConfig.ts.
//
// The settings document (formats, branding, starred items, …) was a
// `config.json` under DATA_DIR. With S3 storage DATA_DIR is each pod's own
// scratch disk, so pods disagreed and a restarted pod started from defaults.
// Here: REAL server processes, each with its own DATA_DIR, one Postgres.
//
//   1. a change made on pod A is what pod B answers, and what a brand-new pod
//      with an empty disk answers — NEGATIVE CONTROL: two pods without a
//      database (the file) never agree;
//   2. each member's starred items too, and they stay that member's;
//   3. a `config.json` an earlier version left on disk is imported once, and a
//      key or password in it never reaches the table (canary);
//   4. the row is the org's own (RLS, as an ordinary role);
//   5. a write that fails is not reported saved — NEGATIVE CONTROL for the
//      flush before the reply;
//   6. a write stores only what IT changed (orgConfig diffDoc/applyPatch): pure,
//      both changes kept and no key in a merged body — CONTROL: a whole-document
//      replace loses the star; in process, a write from a stale document after
//      another pod moved the row keeps both — SQL CONTROL: the old
//      unconditional upsert drops a star; and 20 members starring alternately
//      on two pods, neither re-reading, keep all 20 lists.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-orgConfig-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { ChildProcess } from 'child_process';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawn }: typeof import('child_process') = require('child_process');
const { randomBytes }: typeof import('crypto') = require('crypto');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const config: typeof import('../src/app/config') = require('../src/app/config');
const orgConfig: typeof import('../src/server/orgConfig') = require('../src/server/orgConfig');
const context: typeof import('../src/server/context') = require('../src/server/context');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const CANARY = 'c4nary-org-config-must-never-hold-this';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-orgconfig-${name}-`));

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
/** Polls until `read()` is `want`, or 5 s. Returns what it last read. */
async function eventually<T>(read: () => Promise<T>, want: T): Promise<T> {
  let got = await read();
  for (let i = 0; i < 50 && got !== want; i++) { await sleep(100); got = await read(); }
  return got;
}

/** This process as a pod of org 'merge': config.ts over orgConfig, no fresh() between writes. */
async function inProcess(pool: Pool): Promise<void> {
  const dir = tmp('inproc');
  context.enterServerMode(dir);
  orgConfig.useOrgConfig(pool, dir);
  const as = <T>(fn: () => T): T => context.runInContext({ user: { email: 'boss@merge.test', role: 'admin' }, org: { id: 'merge' } }, 'merge', fn);
  const row = async (): Promise<Record<string, any>> => JSON.parse((await pool.query<{ body: string }>(`SELECT body FROM org_config WHERE org_id = 'merge'`)).rows[0].body); // any: the settings document
  try {
    await as(() => orgConfig.fresh('merge'));
    as(() => config.setStarredFor('ann', ['analysis:a']));
    await as(() => orgConfig.flushed('merge'));
    const stale = JSON.stringify(await row()); // what a pod that missed what follows still holds
    // Another pod moves the row: a format change, its own whole write.
    const other = await row();
    other.formats = { ...other.formats, currency: 'EUR' };
    await pool.query(`UPDATE org_config SET body = $1, version = version + 1 WHERE org_id = 'merge'`, [JSON.stringify(other)]);
    // This pod has not re-read (no fresh()): its document still says USD.
    as(() => config.setStarredFor('bob', ['analysis:b']));
    await as(() => orgConfig.flushed('merge'));
    const after = await row();
    ok('in process: a write from a stale document keeps the other pod\'s change and adds its own', after.formats.currency === 'EUR' && after.starredBy.ann?.[0] === 'analysis:a' && after.starredBy.bob?.[0] === 'analysis:b', JSON.stringify({ c: after.formats.currency, s: after.starredBy }));
    ok('…and this pod now answers the merged document without a re-read', as(() => config.get().formats.currency) === 'EUR' && as(() => config.starredFor('bob'))[0] === 'analysis:b');
    // SQL CONTROL: the old flush, an unconditional upsert of the stale document.
    await pool.query(`INSERT INTO org_config (org_id, body) VALUES ('merge', $1)
      ON CONFLICT (org_id) DO UPDATE SET body = EXCLUDED.body, version = org_config.version + 1, updated_at = now()`, [stale]);
    const lost = await row();
    ok('SQL CONTROL: the old unconditional upsert of a stale document drops bob\'s star and the format change', !lost.starredBy.bob && lost.formats.currency !== 'EUR');
  } finally {
    orgConfig.useOrgConfig(null);
  }
}

(async () => {
  // ── 0. What may leave the pod at all ───────────────────────────────────
  const planted = config.storable({
    formats: { currency: 'USD' },
    providers: { anthropic: { apiKey: CANARY, model: 'm' } },
    byok: { activeProvider: 'anthropic', providers: { anthropic: { apiKey: CANARY, baseUrl: '', maxTokens: '', model: 'm', verified: true } } },
    connectionSecrets: { 'a-connection': { password: CANARY, token: CANARY } },
  } as never);
  ok('storable: keys and connection passwords are blanked, the rest kept', !planted.includes(CANARY) && JSON.parse(planted).byok.providers.anthropic.verified === true);

  // ── 6a. The patch, pure ─────────────────────────────────────────────────
  const doc = (over: Record<string, unknown>): string => config.storable({
    formats: { currency: 'USD' }, starred: [], starredBy: { ann: ['analysis:a'] },
    providers: { anthropic: { apiKey: CANARY, model: 'm' } }, connectionSecrets: { c: { password: CANARY } }, ...over,
  } as never);
  const base = doc({});
  const fmt = doc({ formats: { currency: 'EUR' } }); // pod A: a format change
  const star = doc({ starredBy: { ann: ['analysis:a'], sam: ['analysis:s'] } }); // pod B, from the same base: sam's star
  const rowA = orgConfig.applyPatch(base, orgConfig.diffDoc(base, fmt));
  const merged = orgConfig.applyPatch(rowA, orgConfig.diffDoc(base, star));
  const m = JSON.parse(merged);
  ok('patch: pod A\'s format change and pod B\'s star from the same base are both kept', m.formats.currency === 'EUR' && m.starredBy.sam?.[0] === 'analysis:s' && m.starredBy.ann?.[0] === 'analysis:a', merged.slice(0, 200));
  ok('patch CONTROL: a whole-document replace of the same two writes loses the format change', JSON.parse(star).formats.currency === 'USD');
  ok('patch CANARY: no key or password in any merged body', ![rowA, merged].some((b) => b.includes(CANARY)));
  ok('patch: with no race the round trip is the write itself', isDeepStrictEqual(JSON.parse(rowA), JSON.parse(fmt)));
  const unstar = doc({ starredBy: {} });
  ok('patch: a member\'s list removed is removed, another member\'s kept', JSON.stringify(JSON.parse(orgConfig.applyPatch(merged, orgConfig.diffDoc(base, unstar))).starredBy) === JSON.stringify({ sam: ['analysis:s'] }));
  ok('patch: no base means the whole document', orgConfig.applyPatch(merged, orgConfig.diffDoc(undefined, fmt)) === fmt);

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip org settings DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_orgconfig_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const role = `orgconfig_reader_${process.pid}`;
  let rolePool: Pool | null = null;
  try {
    const db = { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' };
    const acme = { ...db, ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test' };
    const BOSS = 'boss@acme.test';
    const currency = async (base: string, email: string | null = BOSS): Promise<string> => (await call(base, email, 'prefs:get')).body?.formats?.currency;
    const A = await pod({ ...acme, DATA_DIR: tmp('a') });
    const dirB = tmp('b');
    const B = await pod({ ...acme, DATA_DIR: dirB });

    // ── 1. A change on one pod is every pod's ────────────────────────────
    ok('both pods start on the default currency', (await currency(A)) === 'USD' && (await currency(B)) === 'USD');
    const set = await call(A, BOSS, 'formats:set', { currency: 'EUR' });
    ok('pod A: the admin sets the currency', set.status === 200 && set.body.formats.currency === 'EUR', `${set.status} ${JSON.stringify(set.body).slice(0, 120)}`);
    ok('pod B answers it within a few seconds', (await eventually(() => currency(B), 'EUR')) === 'EUR');
    ok('…and not from its disk: pod B wrote no config.json', !fs.existsSync(path.join(dirB, 'orgs', 'acme', 'userData', 'config.json')));
    const C = await pod({ ...acme, DATA_DIR: tmp('c') });
    ok('a brand-new pod with an empty disk answers it', (await currency(C)) === 'EUR');
    const back = await call(B, BOSS, 'formats:set', { currency: 'GBP' });
    ok('a change on pod B reaches pod A', back.status === 200 && (await eventually(() => currency(A), 'GBP')) === 'GBP');
    const row = await pool.query<{ version: string; body: string }>(`SELECT version, body FROM org_config WHERE org_id = 'acme'`);
    ok('one row, its version counting the writes', row.rows.length === 1 && Number(row.rows[0].version) === 2 && JSON.parse(row.rows[0].body).formats.currency === 'GBP', JSON.stringify(row.rows.map((r) => r.version)));

    // NEGATIVE CONTROL: without a database the document is each pod's own file.
    const F1 = await pod({ AUTH_MODE: 'dev', DATA_DIR: tmp('f1') });
    const F2 = await pod({ AUTH_MODE: 'dev', DATA_DIR: tmp('f2') });
    await call(F1, null, 'formats:set', { currency: 'JPY' });
    await sleep(1500);
    ok('NEGATIVE CONTROL: two pods on files never agree', (await currency(F1, null)) === 'JPY' && (await currency(F2, null)) === 'USD');

    // ── 2. Starred items: every pod, and each member's own ──────────────────
    await call(A, 'sam@acme.test', 'projects:list'); // provisions sam
    const pin = `analysis:${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`;
    await call(A, 'sam@acme.test', 'starred:set', { ids: [pin] });
    const starred = async (base: string, email: string): Promise<string> => JSON.stringify((await call(base, email, 'starred:get')).body);
    ok('sam\'s starred item, set on pod A, is there on pod B', (await eventually(() => starred(B, 'sam@acme.test'), JSON.stringify([pin]))) === JSON.stringify([pin]));
    ok('…and the boss\'s list is still empty', (await starred(B, BOSS)) === '[]');

    // ── 6b. 20 members starring at once on two pods ──────────────────────
    const members = Array.from({ length: 20 }, (_, i) => `m${i}@acme.test`);
    for (const who of members) await call(A, who, 'projects:list'); // provisions each
    const pinOf = (i: number): string => `analysis:${String(i).padStart(8, '0')}-1111-4111-8111-${'1'.repeat(12)}`;
    // Both pods freshly read, then the stars alternate A, B, A, B… inside the one
    // second neither re-reads: each pod writes from a document missing the other's.
    await Promise.all([currency(A), currency(B)]);
    const sets: Array<{ status: number }> = [];
    for (const [i, who] of members.entries()) sets.push(await call(i % 2 ? B : A, who, 'starred:set', { ids: [pinOf(i)] }));
    ok('20 members star, alternately on pods A and B: every write answered 200', sets.every((r) => r.status === 200), sets.map((r) => r.status).join());
    const lists = JSON.parse((await pool.query<{ body: string }>(`SELECT body FROM org_config WHERE org_id = 'acme'`)).rows[0].body).starredBy as Record<string, string[]>;
    const kept = members.filter((who, i) => JSON.stringify(lists[who]) === JSON.stringify([pinOf(i)])).length;
    ok(`…and the row keeps all 20 lists (${kept})`, kept === 20, JSON.stringify(Object.keys(lists)));
    const onB = await eventually(async () => (await Promise.all(members.map((who) => starred(B, who)))).filter((x, i) => x === JSON.stringify([pinOf(i)])).length, 20);
    ok(`…and pod B answers all 20 (${onB})`, onB === 20);

    // ── 3. A config.json from before the table, imported once, without its secrets ──
    const dirL = tmp('legacy');
    fs.mkdirSync(path.join(dirL, 'orgs', 'legacy', 'userData'), { recursive: true });
    fs.writeFileSync(path.join(dirL, 'orgs', 'legacy', 'userData', 'config.json'), JSON.stringify({
      formats: { currency: 'CAD' },
      providers: { anthropic: { apiKey: CANARY, model: 'm' } },
      byok: { activeProvider: 'anthropic', providers: { anthropic: { apiKey: CANARY, baseUrl: '', maxTokens: '', model: 'm', verified: true } } },
      connectionSecrets: { 'a-connection': { password: CANARY } },
    }));
    const legacy = { ...db, ORDINATE_ORG: 'legacy', ORDINATE_ADMIN_EMAIL: 'boss@legacy.test' };
    const L1 = await pod({ ...legacy, DATA_DIR: dirL });
    ok('the pod that has the old file answers from it', (await currency(L1, 'boss@legacy.test')) === 'CAD');
    const L2 = await pod({ ...legacy, DATA_DIR: tmp('legacy2') });
    ok('a pod without the file answers the same: it was imported', (await currency(L2, 'boss@legacy.test')) === 'CAD');
    const all = await pool.query<{ org_id: string; body: string }>('SELECT org_id, body FROM org_config ORDER BY org_id');
    ok('two orgs, two rows', all.rows.map((r) => r.org_id).join() === 'acme,legacy');
    ok('CANARY: the key and the password in the old file never reached the table', all.rows.every((r) => !r.body.includes(CANARY)));
    ok('another org\'s pods are untouched', (await currency(A)) === 'GBP');

    // ── 4. RLS, as an ordinary role ─────────────────────────────────────────
    const pw = randomBytes(12).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await pool.query(`GRANT SELECT ON org_config TO ${role}`);
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
        const r = await c.query<{ org_id: string }>('SELECT org_id FROM org_config ORDER BY 1');
        await c.query('COMMIT');
        return r.rows.map((x) => x.org_id).join();
      } finally {
        c.release();
      }
    };
    ok('RLS: an ordinary role sees its org\'s row only, and none with no org set', (await see('acme')) === 'acme' && (await see('legacy')) === 'legacy' && (await see(null)) === '', `${await see('acme')}|${await see('legacy')}|${await see(null)}`);

    // ── 6c. In process: a stale document's write on a row another pod moved ──
    await inProcess(pool);

    // ── 5. A write that fails is not reported saved ─────────────────────────
    ok('before the fault: a change is answered 200', (await call(A, BOSS, 'formats:set', { currency: 'CHF' })).status === 200);
    await pool.query('ALTER TABLE org_config RENAME TO org_config_gone');
    const lost = await call(A, BOSS, 'formats:set', { currency: 'SEK' });
    ok('NEGATIVE CONTROL: with the table gone, the same change is refused, not reported saved', lost.status >= 500, `${lost.status} ${String(lost.body).slice(0, 120)}`);
    await pool.query('ALTER TABLE org_config_gone RENAME TO org_config');
    ok('…and once the table is back, the pod answers what the database holds', (await eventually(() => currency(A), 'CHF')) === 'CHF');
  } finally {
    await Promise.all(pods.map(stop));
    await rolePool?.end();
    await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('org settings DB suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
