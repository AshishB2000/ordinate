// Self-check for secrets at rest (src/server/secrets/, T5.3).
//
// The proof this file exists for: a known canary secret written through the
// store appears NOWHERE — not in a dump of the database (pg_dump when one is
// installed, and a SELECT of every table always), not in any log line this
// process, the server or the rotation command prints — in plain, URL-encoded,
// hex or base64 form. The same grep covers the master keys and the plaintext
// data key. Then: a row moved to another org or ref fails to decrypt, and
// rotation keeps every secret readable while the old master key stops working.
//
// Without DATABASE_URL it prints one `skip` line and runs only the pure checks.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-secrets.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { execFileSync, spawn } from 'child_process';
import { randomBytes, randomUUID, createSecretKey } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { inspect } from 'util';
import { Client, Pool } from 'pg';

// ── Capture every byte this process prints ─────────────────────────────────
let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

// config.ts reads userData from ORDINATE_LOCAL_DIR outside server mode; point it at a temp dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-secrets-'));
process.env.ORDINATE_LOCAL_DIR = userData;

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const store: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const rot: typeof import('../src/server/secrets/rotate') = require('../src/server/secrets/rotate');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const { BYOK_PROVIDERS, PROVIDERS }: typeof import('../src/app/config') = require('../src/app/config');

const ROOT = path.join(__dirname, '..');
const CANARY = `Canary/S3cr3t+${randomBytes(6).toString('hex')}=x y`;
const keyBytes = (): Buffer => randomBytes(32);
const MK_A = keyBytes();
const MK_B = keyBytes();

/** Every spelling of `v` a leak could take: plain, URL-encoded, hex, base64/base64url at all 3 alignments. */
function spellings(v: string | Buffer): string[] {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
  const out = new Set<string>([b.toString('hex')]);
  if (!Buffer.isBuffer(v)) [v, encodeURIComponent(v), encodeURI(v), v.replace(/ /g, '+')].forEach((x) => out.add(x));
  for (let off = 0; off < 3; off++) {
    const sub = b.subarray(off);
    const whole = sub.subarray(0, sub.length - (sub.length % 3)); // full groups: no padding artefacts
    out.add(whole.toString('base64'));
    out.add(whole.toString('base64url'));
  }
  return [...out].filter((x) => x.length >= 8).map((x) => x.toLowerCase());
}
const NEEDLES: Record<string, string[]> = { canary: spellings(CANARY), 'master key A': spellings(MK_A), 'master key B': spellings(MK_B) };
/** Which needle sets occur in `hay` (case-insensitive). */
function leaks(hay: string, needles: Record<string, string[]> = NEEDLES): string[] {
  const h = hay.toLowerCase();
  return Object.entries(needles).filter(([, list]) => list.some((n) => h.includes(n))).map(([name]) => name);
}

/** Every SecretError message seen, and every structured log line the app logger wrote. */
const errors: string[] = [];
let appLog = '';
const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'trace', ORDINATE_MASTER_KEY: MK_A.toString('base64') }),
  new Writable({ write(c: Buffer, _e, cb) { appLog += c.toString(); cb(); } }));

async function rejects(label: string, p: Promise<unknown>, needle?: RegExp): Promise<void> {
  try {
    await p;
    ok(label, false, 'resolved');
  } catch (err) {
    const e = err as Error;
    errors.push(e.message);
    app.log.error({ err: e }, 'secret failure');
    ok(label, e.name === 'SecretError' && (!needle || needle.test(e.message)), e.message);
  }
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  const child = spawn(process.execPath, args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (out += c.toString()));
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
}

(async () => {
  // ── The grep itself (negative control: it must SEE each spelling) ─────────
  const b = Buffer.from(CANARY);
  const planted = [CANARY, encodeURIComponent(CANARY), b.toString('hex').toUpperCase(), b.toString('base64'), b.subarray(1).toString('base64'), b.subarray(2).toString('base64url'), `\\x${b.toString('hex')}`];
  ok('grep: every planted spelling of the canary is found', planted.every((p) => leaks(`prefix ${p} suffix`).includes('canary')), planted.filter((p) => !leaks(p).length).join(' | '));
  ok('grep: an unrelated string is clean', leaks('nothing to see ' + randomBytes(32).toString('base64')).length === 0);

  // ── ORDINATE_MASTER_KEY validation ────────────────────────────────────────
  const kid = (raw: string): string => store.kidOf(envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_MASTER_KEY: raw }).masterKey!);
  ok('env: unset → null', envMod.parseEnv({ AUTH_MODE: 'dev' }).masterKey === null);
  const kids = [MK_A.toString('hex'), MK_A.toString('hex').toUpperCase(), MK_A.toString('base64'), MK_A.toString('base64url'), MK_A.toString('base64') + '\n'].map(kid);
  ok('env: hex, HEX, base64, base64url and a trailing newline all read the same key', new Set(kids).size === 1, kids.join());
  ok('env: a different key has a different fingerprint', kid(MK_B.toString('hex')) !== kids[0]);
  const badKeys = ['short', MK_A.toString('hex').slice(0, 62), randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'g'.repeat(64), `${MK_A.toString('base64')}x`];
  for (const bad of badKeys) {
    try {
      envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_MASTER_KEY: bad });
      ok(`env: a bad key (${bad.length} chars) is rejected`, false);
    } catch (err) {
      const m = (err as Error).message;
      ok(`env: a bad key (${bad.length} chars) is rejected naming the variable, value not echoed`,
        (err as Error).name === 'EnvError' && m.includes('ORDINATE_MASTER_KEY') && !m.includes(bad), m);
    }
  }
  const prodDb = { ORDINATE_ENV: 'prod', DATA_DIR: '/srv/o', DATABASE_URL: 'postgres://h/db' };
  try {
    envMod.parseEnv(prodDb);
    ok('env: prod + DATABASE_URL without a master key is refused', false);
  } catch (err) {
    ok('env: prod + DATABASE_URL without a master key is refused', (err as Error).message.includes('ORDINATE_MASTER_KEY is required'), (err as Error).message);
  }
  ok('env: prod without a database needs no master key', envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'prod', DATA_DIR: '/srv/o' }).masterKey === null);
  ok('env: dev + DATABASE_URL without a master key starts (secrets unavailable)', envMod.parseEnv({ AUTH_MODE: 'dev', DATABASE_URL: 'postgres://h/db' }).masterKey === null);
  const cfg = envMod.parseEnv({ AUTH_MODE: 'dev', ...prodDb, ORDINATE_MASTER_KEY: MK_A.toString('hex') });
  const shown = JSON.stringify(cfg) + inspect(cfg, { showHidden: true, depth: null }) + String(cfg.masterKey);
  ok('env: the parsed config never prints the key (JSON, inspect, String)', leaks(shown).length === 0, leaks(shown).join());
  app.log.info({ cfg }, 'config object logged on purpose');

  // ── Primitives, and their cost ────────────────────────────────────────────
  const mk = createSecretKey(MK_A);
  const aad = Buffer.from('aad');
  const sealed = store.seal(mk, Buffer.from(CANARY), aad);
  ok('seal/open round-trips', store.open(mk, sealed, aad).toString() === CANARY);
  ok('ciphertext is not the plaintext', leaks(sealed.ct.toString('latin1') + sealed.ct.toString('hex')).length === 0);
  let threw = 0;
  for (const tamper of [() => store.open(mk, sealed, Buffer.from('other')), () => store.open(mk, { ...sealed, ct: Buffer.from(sealed.ct.map((x, i) => (i ? x : x ^ 1))) }, aad), () => store.open(createSecretKey(MK_B), sealed, aad)]) {
    try { tamper(); } catch { threw++; }
  }
  ok('open refuses another AAD, a flipped bit and another key', threw === 3, threw);
  const N = 20_000;
  let t = performance.now();
  const many: import('../src/server/secrets/store').Sealed[] = [];
  for (let i = 0; i < N; i++) many.push(store.seal(mk, Buffer.from(CANARY), aad));
  const sealUs = ((performance.now() - t) * 1000) / N;
  t = performance.now();
  for (const s of many) store.open(mk, s, aad);
  const openUs = ((performance.now() - t) * 1000) / N;
  console.log(`     AES-256-GCM on a ${Buffer.byteLength(CANARY)}-byte secret: seal ${sealUs.toFixed(2)} µs, open ${openUs.toFixed(2)} µs (mean of ${N})`);

  // ── publicConfig()/publicByok() strip every secret ────────────────────────
  for (const p of BYOK_PROVIDERS) execConfig.setByokProvider(p, { apiKey: CANARY });
  for (const p of PROVIDERS) if (p !== 'ollama') await execConfig.setApiKey(CANARY, p);
  const connId = randomUUID();
  configSecrets.setConnectionSecret(connId, { password: CANARY, token: CANARY });
  ok('config: the canary really is stored (main can read it back)', (await execConfig.getApiKey('anthropic')) === CANARY && configSecrets.getConnectionSecret(connId).password === CANARY);
  const views = { publicConfig: execConfig.publicConfig(), publicByok: execConfig.publicByok() };
  ok('config: the views still report hasKey (not vacuously empty)', views.publicByok.providers.anthropic.hasKey && views.publicConfig.providerStatus.openai.hasKey === true);
  for (const [name, v] of Object.entries(views)) {
    const text = JSON.stringify(v) + inspect(v, { depth: null, showHidden: true });
    ok(`config: ${name}() carries the canary in no spelling`, leaks(text).length === 0, leaks(text).join());
  }

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    await app.close();
    return;
  }

  // ── A scratch database with the real migrations ──────────────────────────
  const dbName = `ordinate_t53_${process.pid}_${Date.now()}`;
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = '/' + dbName;
  const scratch = scratchUrl.toString();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch, max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const childOut: string[] = [];
  try {
    await mig.migrate(pool);
    const A = store.createSecretStore(pool, createSecretKey(MK_A));
    const ORG = 'default';
    const ORG2 = randomUUID();

    // In server mode the same secrets live in the store; the views above never read it.
    await A.put(ORG, 'connection.password', connId, CANARY);
    await A.put(ORG, 'connection.token', connId, CANARY);
    await A.put(ORG, 'ai.apiKey', 'anthropic', CANARY);
    ok('store: get returns what put stored', (await A.get(ORG, 'connection.password', connId)) === CANARY);
    ok('store: config views still clean with the store populated', leaks(JSON.stringify([execConfig.publicConfig(), execConfig.publicByok()])).length === 0);
    ok('store: an unknown ref is null', (await A.get(ORG, 'connection.password', randomUUID())) === null);
    await A.put(ORG, 'ai.apiKey', 'openai', 'first');
    await A.put(ORG, 'ai.apiKey', 'openai', 'second');
    ok('store: put replaces', (await A.get(ORG, 'ai.apiKey', 'openai')) === 'second');
    ok('store: delete removes, then reports nothing to remove', (await A.delete(ORG, 'ai.apiKey', 'openai')) && !(await A.delete(ORG, 'ai.apiKey', 'openai')) && (await A.get(ORG, 'ai.apiKey', 'openai')) === null);
    await rejects('store: an over-long value is refused without echoing it', A.put(ORG, 'ai.apiKey', 'x', CANARY.repeat(5000)), /at most/);
    await rejects('store: a bad org id is refused', A.get('../etc', 'ai.apiKey', 'x'), /orgId/);
    await rejects('store: an unknown kind is refused', A.get(ORG, 'password' as 'ai.apiKey', 'x'), /kind/);

    // Two pods racing to create a new org's first data key keep exactly one.
    const B2 = store.createSecretStore(pool, createSecretKey(MK_A));
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? A : B2).put('race', 'ai.apiKey', `p${i}`, `v${i}`)));
    const nRace = (await pool.query(`SELECT count(*)::int AS n FROM secret_data_keys WHERE org_id = 'race'`)).rows[0].n as number;
    const raceOk = (await Promise.all(Array.from({ length: 8 }, (_, i) => A.get('race', 'ai.apiKey', `p${i}`)))).every((v, i) => v === `v${i}`);
    ok('store: 8 concurrent first puts from 2 stores → one data key, every value readable', nRace === 1 && raceOk, nRace);

    // ── AAD binding: a row moved to another org or ref does not decrypt ──
    await A.put(ORG2, 'ai.apiKey', 'anthropic', 'org2-own');
    const copy = (org: string, ref: string, keyFrom: string): Promise<unknown> => pool.query(
      `INSERT INTO secrets (org_id, kind, ref, key_id, ciphertext, iv, tag)
       SELECT $1, kind, $2, (SELECT id FROM secret_data_keys WHERE org_id = $4), ciphertext, iv, tag FROM secrets
        WHERE org_id = $3 AND kind = 'connection.password' AND ref = $5`, [org, ref, ORG, keyFrom, connId]);
    await copy(ORG2, connId, ORG);
    await rejects('aad: a row copied to another org (keeping its data key) fails', A.get(ORG2, 'connection.password', connId));
    await pool.query(`DELETE FROM secrets WHERE org_id = $1 AND kind = 'connection.password'`, [ORG2]);
    await copy(ORG2, connId, ORG2);
    await rejects('aad: a row copied to another org (re-pointed at that org\'s key) fails', A.get(ORG2, 'connection.password', connId));
    const ref2 = randomUUID();
    await copy(ORG, ref2, ORG);
    await rejects('aad: a row copied to another ref in the same org fails', A.get(ORG, 'connection.password', ref2));
    await pool.query(`DELETE FROM secrets WHERE ref = $1 OR (org_id = $2 AND kind = 'connection.password')`, [ref2, ORG2]);
    await pool.query(`UPDATE secret_data_keys SET org_id = 'moved' WHERE org_id = $1`, [ORG]);
    await pool.query(`UPDATE secrets SET org_id = 'moved' WHERE org_id = $1`, [ORG]);
    await rejects('aad: an org\'s key AND rows moved together under another org id fail', A.get('moved', 'connection.password', connId), /data key/);
    await pool.query(`UPDATE secret_data_keys SET org_id = $1 WHERE org_id = 'moved'`, [ORG]);
    await pool.query(`UPDATE secrets SET org_id = $1 WHERE org_id = 'moved'`, [ORG]);
    await pool.query(`UPDATE secrets SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) WHERE org_id = $1 AND ref = $2 AND kind = 'connection.token'`, [ORG, connId]);
    await rejects('aad: a flipped ciphertext bit fails', A.get(ORG, 'connection.token', connId));
    await A.put(ORG, 'connection.token', connId, CANARY);
    ok('aad: the original rows still decrypt after all that', (await A.get(ORG, 'connection.password', connId)) === CANARY && (await A.get(ORG, 'connection.token', connId)) === CANARY);
    await rejects('master: a store on another master key fails, naming both fingerprints', store.createSecretStore(pool, createSecretKey(MK_B)).get(ORG, 'ai.apiKey', 'anthropic'), /wrapped by master key [0-9a-f]{16} but ORDINATE_MASTER_KEY is [0-9a-f]{16}/);

    // ── Cost of a round trip through Postgres ────────────────────────────
    const R = 200;
    t = performance.now();
    for (let i = 0; i < R; i++) await A.put(ORG, 'ai.apiKey', 'bench', CANARY);
    const putMs = (performance.now() - t) / R;
    t = performance.now();
    for (let i = 0; i < R; i++) await A.get(ORG, 'ai.apiKey', 'bench');
    const getMs = (performance.now() - t) / R;
    console.log(`     store round trip on local Postgres: put ${putMs.toFixed(3)} ms, get ${getMs.toFixed(3)} ms (mean of ${R})`);

    // ── The dump ─────────────────────────────────────────────────────────
    const keyRow = (await pool.query<import('../src/server/secrets/store').DataKeyRow>('SELECT * FROM secret_data_keys WHERE org_id = $1', [ORG])).rows[0];
    const dataKey = store.unwrapDataKey(createSecretKey(MK_A), keyRow, ORG).export();
    const needles = { ...NEEDLES, 'plaintext data key': spellings(dataKey) };
    const tables = (await pool.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map((r) => r.t);
    let selectDump = '';
    for (const tbl of tables) for (const r of (await pool.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM "${tbl}" x`)).rows) selectDump += r.j + '\n';
    ok(`dump: SELECT * of all ${tables.length} tables holds the secret rows`, tables.includes('secrets') && selectDump.includes('connection.password'), tables.join());
    ok('dump: the SELECT dump contains no canary, master key or data key', leaks(selectDump, needles).length === 0, leaks(selectDump, needles).join());
    const pgDump = [process.env.PG_DUMP, '/opt/homebrew/opt/postgresql@17/bin/pg_dump', 'pg_dump'].find((p) => p && (p === 'pg_dump' || fs.existsSync(p)))!;
    let dump = '';
    try {
      dump = execFileSync(pgDump, ['--no-owner', scratch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    } catch (err) {
      console.log(`     note: ${pgDump} did not run (${String((err as Error).message).split('\n')[0]}); the SELECT dump above stands alone`);
    }
    if (dump) {
      ok('dump: pg_dump holds the secrets table data', dump.includes('COPY public.secrets'), dump.length);
      ok('dump: pg_dump contains no canary, master key or data key', leaks(dump, needles).length === 0, leaks(dump, needles).join());
    }

    // ── A real server boots with the master key and never prints it ──────
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-secrets-srv-'));
    const srv = spawn(process.execPath, [path.join(ROOT, 'src/server/main.js')], {
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORDINATE_ENV: 'dev', LOG_LEVEL: 'trace', DATABASE_URL: scratch, ORDINATE_MASTER_KEY: MK_A.toString('base64') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvOut = '';
    const listening = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 30_000);
      const onData = (c: Buffer): void => {
        srvOut += c.toString();
        const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(srvOut);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      };
      srv.stdout.on('data', onData);
      srv.stderr.on('data', onData);
      srv.on('exit', () => resolve(null));
    });
    if (listening) await fetch(listening + '/readyz');
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    ok('server: boots with ORDINATE_MASTER_KEY and DATABASE_URL (0002 applied)', listening !== null && srvOut.includes('migrations current'), srvOut.slice(-500));
    childOut.push(srvOut);
    fs.rmSync(dataDir, { recursive: true, force: true });

    // ── Rotation ─────────────────────────────────────────────────────────
    const ROTATE = path.join(ROOT, 'src/server/secrets/rotate.js');
    const before = (await pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>('SELECT ciphertext, iv, tag FROM secrets ORDER BY org_id, kind, ref')).rows;
    const allRefs = (await pool.query<{ org_id: string; kind: 'ai.apiKey'; ref: string }>('SELECT org_id, kind, ref FROM secrets ORDER BY org_id, kind, ref')).rows;
    const valuesA = await Promise.all(allRefs.map((r) => A.get(r.org_id, r.kind, r.ref)));
    const nKeys = (await pool.query('SELECT 1 FROM secret_data_keys')).rowCount ?? 0;
    const r1 = await run([ROTATE], { DATABASE_URL: scratch, ORDINATE_MASTER_KEY_OLD: MK_A.toString('hex'), ORDINATE_MASTER_KEY_NEW: MK_B.toString('base64') });
    childOut.push(r1.out);
    ok(`rotate: exits 0 and re-wraps all ${nKeys} data keys`, r1.code === 0 && r1.out.includes(`re-wrapped ${nKeys} data key(s)`), r1.out);
    console.log(`     ${r1.out.trim()}`);
    const B = store.createSecretStore(pool, createSecretKey(MK_B));
    const valuesB = await Promise.all(allRefs.map((r) => B.get(r.org_id, r.kind, r.ref)));
    ok(`rotate: all ${allRefs.length} secrets read the same under the new key`, valuesB.every((v, i) => v === valuesA[i] && v !== null), JSON.stringify(valuesB.map((v) => v?.length)));
    const after = (await pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>('SELECT ciphertext, iv, tag FROM secrets ORDER BY org_id, kind, ref')).rows;
    ok('rotate: secret payloads were not re-encrypted (byte-identical rows)', after.length === before.length && after.every((r, i) => r.ciphertext.equals(before[i].ciphertext) && r.iv.equals(before[i].iv) && r.tag.equals(before[i].tag)));
    await rejects('rotate: the old master key no longer reads a secret', A.get(ORG, 'connection.password', connId), /wrapped by master key/);
    const rotatedRow = (await pool.query<import('../src/server/secrets/store').DataKeyRow>('SELECT * FROM secret_data_keys WHERE org_id = $1', [ORG])).rows[0];
    let oldOpens = false;
    try { store.open(createSecretKey(MK_A), { iv: rotatedRow.iv, ct: rotatedRow.wrapped, tag: rotatedRow.tag }, store.dataKeyAad(ORG, rotatedRow.id)); oldOpens = true; } catch { /* expected */ }
    ok('rotate: the old master key cannot unwrap a re-wrapped data key (GCM, not just the fingerprint check)', !oldOpens);
    const r2 = await run([ROTATE], { DATABASE_URL: scratch, ORDINATE_MASTER_KEY_OLD: MK_A.toString('base64'), ORDINATE_MASTER_KEY_NEW: MK_B.toString('hex') });
    childOut.push(r2.out);
    ok('rotate: a second run re-wraps nothing', r2.code === 0 && r2.out.includes(`re-wrapped 0 data key(s)`) && r2.out.includes(`(${nKeys} already`), r2.out);
    const wrappedBefore = JSON.stringify((await pool.query('SELECT * FROM secret_data_keys ORDER BY id')).rows);
    const r3 = await run([ROTATE], { DATABASE_URL: scratch, ORDINATE_MASTER_KEY_OLD: keyBytes().toString('hex'), ORDINATE_MASTER_KEY_NEW: keyBytes().toString('hex') });
    childOut.push(r3.out);
    const wrappedAfter = JSON.stringify((await pool.query('SELECT * FROM secret_data_keys ORDER BY id')).rows);
    ok('rotate: unknown OLD key → exit 1, one line, nothing changed', r3.code === 1 && /neither the old key/.test(r3.out) && r3.out.trim().split('\n').length === 1 && wrappedBefore === wrappedAfter, r3.out);
    const r4 = await run([ROTATE], { DATABASE_URL: scratch, ORDINATE_MASTER_KEY_OLD: MK_B.toString('hex'), ORDINATE_MASTER_KEY_NEW: 'nope' });
    childOut.push(r4.out);
    ok('rotate: a malformed NEW key → exit 1 naming the variable', r4.code === 1 && r4.out.includes('ORDINATE_MASTER_KEY_NEW must be 32 bytes'), r4.out);
    const r5 = await run([ROTATE], { DATABASE_URL: scratch, ORDINATE_MASTER_KEY_OLD: MK_B.toString('hex'), ORDINATE_MASTER_KEY_NEW: MK_B.toString('base64') });
    childOut.push(r5.out);
    ok('rotate: the same key twice is refused', r5.code === 1 && r5.out.includes('same key'), r5.out);
    try {
      await rot.rotate(pool, createSecretKey(MK_A), createSecretKey(MK_B));
      ok('rotate(): in-process, an already-rotated DB with the old key as OLD is a no-op', true);
    } catch (err) {
      ok('rotate(): in-process, an already-rotated DB with the old key as OLD is a no-op', false, (err as Error).message);
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  // ── Every log line: this process, the app logger, the server, the CLI ───
  await app.close();
  ok(`logs: ${errors.length} SecretError messages carry no canary or key`, errors.length > 0 && leaks(errors.join('\n')).length === 0, leaks(errors.join('\n')).join());
  ok('logs: the app logger wrote the failures (so the grep is not vacuous)', appLog.includes('secret failure') && appLog.includes('config object logged'), appLog.length);
  ok('logs: the app logger (trace level) carries no canary or key', leaks(appLog).length === 0, leaks(appLog).join());
  ok(`logs: ${childOut.length} child processes (server, rotate ×5) print no canary or key`, leaks(childOut.join('\n')).length === 0, leaks(childOut.join('\n')).join());
  ok('logs: everything this test printed carries no canary or key', leaks(captured).length === 0, leaks(captured).join());
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    finish();
  });
