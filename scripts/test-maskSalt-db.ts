// Each project's masking key follows it to every pod (src/app/privacyStore.ts,
// the 'privacy.salt' secret). A hash step is HMAC under the project's key and
// promises the same token for the same value everywhere in the project
// (src/data/maskSteps.ts); with the key minted into each pod's own disk, two
// pods — or one pod after its emptyDir was wiped — hashed differently.
//
// Each "pod" is a fresh process (scripts/maskSaltPod.ts) on its own DATA_DIR
// against one database:
//
//   1. two pods on different disks hash Object.is-equal; one row, no salt.key;
//      a wiped disk hashes the same — NEGATIVE CONTROL: two pods without the
//      store (a file each) differ;
//   2. a valid salt.key an earlier version left seeds the row and wins;
//   3. a damaged salt.key is refused: the hash step throws and no row is
//      written; so is a pod on the wrong master key, and the row is untouched;
//   4. CANARY: the salt, in hex or base64, is in no output, no log line and no
//      row_to_json of the secrets table.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-maskSalt-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-masksalt-'));
const ORG = 'acme';
const KEY = randomBytes(32).toString('base64');
const WRONG_KEY = randomBytes(32).toString('base64');
const disk = (name: string): string => fs.mkdtempSync(path.join(TMP, name + '-'));

interface PodOut { tokens: string[] | null; threw: string | null; saltFile: boolean }
const logs: string[] = [];
function pod(mode: 'store' | 'nostore', dataDir: string, url: string, pid: string, key = KEY): Promise<PodOut> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, 'maskSaltPod.js'), mode, dataDir, url, key, ORG, pid], (e, out, err) => {
      logs.push(out, err);
      if (e) reject(new Error(`pod failed: ${err}`));
      else resolve(JSON.parse(out) as PodOut);
    });
  });
}
const same = (a: PodOut, b: PodOut): boolean =>
  !!a.tokens && !!b.tokens && a.tokens.length === b.tokens.length && a.tokens.every((t, i) => Object.is(t, b.tokens![i]));

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip masking-key DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_masksalt_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const url = u.toString();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: url, max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const secrets: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
  const { parseMasterKey }: typeof import('../src/server/env') = require('../src/server/env');
  const { maskToken }: typeof import('../src/data/maskSteps') = require('../src/data/maskSteps');
  const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
  try {
    await mig.migrate(pool);
    // The projects are records (rows), so every pod sees them whatever its disk.
    const home = disk('home');
    context.enterServerMode(home);
    recordFs.useRecordDb(pool);
    const who = { user: { email: 'a@t', role: 'admin' as const }, org: { id: ORG } };
    const [p1, p2, p3, p4] = await context.runInContext(who, 'setup', async () => [
      (await projects.createProject('Shared')).id, (await projects.createProject('Legacy')).id,
      (await projects.createProject('Damaged')).id, (await projects.createProject('No store')).id,
    ]);
    const saltRows = async (pid: string): Promise<number> =>
      Number((await pool.query(`SELECT count(*) AS n FROM secrets WHERE org_id = $1 AND kind = 'privacy.salt' AND ref = $2`, [ORG, pid])).rows[0].n);
    const plant = (dir: string, pid: string, text: string): void => {
      const f = path.join(dir, 'orgs', ORG, 'userData', 'projects', pid, 'privacy', 'salt.key');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };

    // ── 1. Every pod, every disk ──────────────────────────────────────────
    const [a, b] = await Promise.all([pod('store', disk('a'), url, p1), pod('store', disk('b'), url, p1)]);
    ok('two pods on different disks hash Object.is-equal tokens', same(a, b) && a.tokens![0] !== 'ana@example.com', JSON.stringify([a, b]));
    ok('…one row in the secrets store, and no salt.key on either disk', (await saltRows(p1)) === 1 && !a.saltFile && !b.saltFile);
    const wiped = await pod('store', disk('wiped'), url, p1);
    ok('a pod on a wiped disk hashes the same', same(a, wiped));
    const [n1, n2] = await Promise.all([pod('nostore', disk('n1'), url, p4), pod('nostore', disk('n2'), url, p4)]);
    ok('NEGATIVE CONTROL: two pods without the store each mint a file and hash differently',
      !!n1.tokens && !!n2.tokens && n1.saltFile && n2.saltFile && n1.tokens[0] !== n2.tokens[0] && (await saltRows(p4)) === 0, JSON.stringify([n1, n2]));

    // ── 2. A legacy salt.key seeds the row ────────────────────────────────
    const legacySalt = randomBytes(32).toString('hex');
    const withFile = disk('legacy');
    plant(withFile, p2, legacySalt + '\n');
    const l1 = await pod('store', withFile, url, p2);
    const l2 = await pod('store', disk('legacy-other'), url, p2);
    ok('a valid legacy salt.key wins: its tokens, on its own pod and on another', l1.tokens?.[0] === maskToken(legacySalt, 'ana@example.com') && same(l1, l2), JSON.stringify([l1, l2]));
    ok('…as the one stored row', (await saltRows(p2)) === 1);

    // ── 3. Refusals ─────────────────────────────────────────────────────────
    const damaged = disk('damaged');
    plant(damaged, p3, 'not-a-key');
    const d = await pod('store', damaged, url, p3);
    ok('a damaged legacy salt.key: no tokens, the hash step throws', d.tokens === null && d.threw === 'MaskKeyUnavailableError', JSON.stringify(d));
    ok('…and no row is written for it', (await saltRows(p3)) === 0);
    const ct = async (): Promise<string> =>
      (await pool.query(`SELECT encode(ciphertext, 'hex') AS c FROM secrets WHERE org_id = $1 AND kind = 'privacy.salt' AND ref = $2`, [ORG, p1])).rows[0].c;
    const before = await ct();
    const wrong = await pod('store', disk('wrong'), url, p1, WRONG_KEY);
    ok('a pod on the wrong master key: the hash step throws, no key is minted', wrong.tokens === null && wrong.threw === 'MaskKeyUnavailableError' && !wrong.saltFile, JSON.stringify(wrong));
    ok('…and the stored row\'s ciphertext is unchanged', (await ct()) === before && (await saltRows(p1)) === 1);

    // ── 4. CANARY ───────────────────────────────────────────────────────────
    const store = secrets.createSecretStore(pool, parseMasterKey('key', KEY));
    const salts = [await store.get(ORG, 'privacy.salt', p1), legacySalt];
    ok('the stored salt is a 64-hex key', /^[0-9a-f]{64}$/.test(salts[0] ?? ''));
    const dump = (await pool.query('SELECT row_to_json(s)::text AS j FROM secrets s')).rows.map((r) => r.j as string).join('\n');
    const forms = salts.flatMap((s) => [s!, Buffer.from(s!, 'hex').toString('base64'), Buffer.from(s!, 'utf8').toString('base64')]);
    const out = logs.join('\n');
    ok('CANARY: no pod output or log line holds a salt, in hex or base64', forms.every((f) => !out.includes(f)) && out.length > 0);
    ok('CANARY: no row_to_json of the secrets table holds one', forms.every((f) => !dump.includes(f)) && dump.includes('privacy.salt'));
    ok('CANARY CONTROL: the check would see one (the planted file holds it)', fs.readFileSync(path.join(withFile, 'orgs', ORG, 'userData', 'projects', p2, 'privacy', 'salt.key'), 'utf8').includes(forms[3]));
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('masking-key DB suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
