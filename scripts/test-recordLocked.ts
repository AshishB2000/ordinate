// recordFs.locked — one read-modify-write at a time per (org, path)
// (src/app/recordFs.ts, docs/record-locks/00-design.md).
//
// FILE leg (always):
//   (a) 100 concurrent appends inside `locked` are all kept — NEGATIVE
//       CONTROL: the same appends without it lose some;
//   (b) re-entry and a nested key resolve at once;
//   (c) one org's hold never delays another org's same path;
//   a wait past the lock wait is ERECORDBUSY, the busy sentence.
// DB leg (with DATABASE_URL; a scratch database, dropped after):
//   (a)–(c) again, on Postgres;
//   (d) a memo read is stale (CONTROL) while a locked read sees the write;
//   (e) a RAW pg session holding the advisory key holds `comments.add` back
//       until its COMMIT — CONTROL: another project is not delayed — and past
//       the wait the add answers {ok:false} with the busy sentence, no Postgres text;
//   (f) a swallowed failing statement makes `locked` reject and the good write
//       is gone — CONTROL: the same writes unlocked keep it — while a failure
//       nested in a SAVEPOINT leaves the outer save whole;
//   (g) on a max:1 pool nested locks finish — CONTROL: `pool.connect` inside a
//       hold times out; 20 keys on max:2 finish; holds that each take a second
//       client (an S3 save's newObject) do not starve the pool — CONTROL:
//       the same without the per-pod cap deadlocks;
//   (h) as an ordinary role, under the table's forced RLS.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-recordLocked.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID, randomBytes }: typeof import('crypto') = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-locked-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const msgs: typeof import('../src/app/recordLockMessages') = require('../src/app/recordLockMessages');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const comments: typeof import('../src/app/comments') = require('../src/app/comments');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let req = 0;
const as = <T>(org: string, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `u@${org}.test`, role: 'admin' }, org: { id: org } }, `r${++req}`, fn);
const rec = (org: string, rel: string): Promise<string> => as(org, async () => path.join(appPaths.userData(), rel));

/** A gate: `open()` releases everyone awaiting `wait`. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

async function readList(file: string): Promise<number[]> {
  try { return JSON.parse(await recordFs.readFile(file, 'utf8')) as number[]; } catch { return []; }
}
async function writeList(file: string, list: number[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await recordFs.writeFile(tmp, JSON.stringify(list));
  await recordFs.rename(tmp, file);
}
/** One read-modify-write, with a yield in the middle so unlocked ones interleave. */
async function append(file: string, n: number): Promise<void> {
  const list = await readList(file);
  await new Promise((r) => setImmediate(r));
  list.push(n);
  await writeList(file, list);
}

/** (a), (b), (c) and the busy refusal — the same on either backend. */
async function common(leg: string): Promise<void> {
  const pid = randomUUID();
  const file = await rec('acme', `projects/${pid}/list.json`);
  await as('acme', () => Promise.all(Array.from({ length: 100 }, (_, i) => recordFs.locked(file, () => append(file, i)))));
  const kept = await as('acme', () => readList(file));
  ok(`${leg} (a): 100 concurrent appends inside locked — all 100 kept`, kept.length === 100 && new Set(kept).size === 100, String(kept.length));
  const bare = await rec('acme', `projects/${pid}/bare.json`);
  await as('acme', () => Promise.all(Array.from({ length: 100 }, (_, i) => append(bare, i))));
  const lost = 100 - (await as('acme', () => readList(bare))).length;
  ok(`${leg} (a) NEGATIVE CONTROL: the same appends without locked lose some (${lost} of 100)`, lost > 0, String(lost));

  const other = await rec('acme', `projects/${pid}/other.json`);
  const t0 = Date.now();
  const got = await as('acme', () => recordFs.locked(file, () => recordFs.locked(file, () =>
    recordFs.locked(other, async () => { await append(other, 1); return recordFs.locked(file, () => readList(file)); }))));
  ok(`${leg} (b): re-entry and a nested key resolve within 2 s (${Date.now() - t0} ms)`, Date.now() - t0 < 2_000 && got.length === 100);

  const g = gate();
  const shared = path.join(TMP, 'outside-userdata.json'); // the same path string in both orgs
  const aHolds = as('acme', () => recordFs.locked(shared, () => g.wait));
  const aRec = await rec('acme', `projects/${pid}/same.json`);
  const aHoldsRec = as('acme', () => recordFs.locked(aRec, () => g.wait));
  const t1 = Date.now();
  await as('globex', () => recordFs.locked(shared, async () => undefined));
  await as('globex', async () => recordFs.locked(path.join(appPaths.userData(), `projects/${pid}/same.json`), async () => undefined));
  ok(`${leg} (c): another org's same path is never held back by this org's hold (${Date.now() - t1} ms)`, Date.now() - t1 < 1_000);

  recordFs._setLockWaitMs(200);
  const t2 = Date.now();
  const refused = await as('acme', () => recordFs.locked(aRec, async () => 'ran')).catch((e: Error & { code?: string }) => e);
  recordFs._setLockWaitMs(0);
  ok(`${leg}: a wait past the lock wait is refused ERECORDBUSY with the busy sentence (${Date.now() - t2} ms)`,
    refused instanceof Error && refused.code === 'ERECORDBUSY' && refused.message === msgs.recordBusy() && Date.now() - t2 >= 190, String(refused));
  g.open();
  await Promise.all([aHolds, aHoldsRec]);
  const after = await as('acme', () => recordFs.locked(aRec, async () => 'ran'));
  ok(`${leg}: …and the refused waiter left the queue: the next one runs`, after === 'ran');
}

/** A raw session: BEGIN and hold `key` until `commit()`. */
async function rawHold(url: string, key: string): Promise<{ commit: () => Promise<void> }> {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  return { commit: async () => { await c.query('COMMIT'); await c.end(); } };
}

async function dbLeg(url: string, admin: Client): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on('error', () => undefined);
  await mig.migrate(pool);
  recordFs.useRecordDb(pool);
  try {
    await common('db');

    // (d) the read memo
    const pid = randomUUID();
    const file = await rec('acme', `projects/${pid}/memo.json`);
    await as('acme', () => writeList(file, [1]));
    const seen = await as('acme', () => recordFs.withReadMemo(async () => {
      const first = await readList(file);
      await pool.query(`UPDATE records SET body = '[2]' WHERE org_id = 'acme' AND path = $1`, [`projects/${pid}/memo.json`]);
      return { first, memo: await readList(file), inLock: await recordFs.locked(file, () => readList(file)), after: await readList(file) };
    }));
    ok('db (d) CONTROL: inside withReadMemo a second read is the stale memo', seen.first[0] === 1 && seen.memo[0] === 1, JSON.stringify(seen));
    ok('db (d): a read inside locked sees the write, and the memo is forgotten after it', seen.inLock[0] === 2 && seen.after[0] === 2, JSON.stringify(seen));

    // (e) a raw session holds the key: comments.add waits for its COMMIT
    const p = await as('acme', () => projects.createProject('Locks'));
    const q = await as('acme', () => projects.createProject('Other'));
    const raw = await rawHold(url, `records:acme:projects/${p.id}/comments.json`);
    const t0 = Date.now();
    let landed = 0;
    const add = as('acme', () => comments.add(p.id, { kind: 'dataset', id: p.id }, 'held')).then((r) => { landed = Date.now(); return r; });
    const t1 = Date.now();
    const free = await as('acme', () => comments.add(q.id, { kind: 'dataset', id: q.id }, 'free'));
    const freeMs = Date.now() - t1;
    await sleep(400);
    const pending = landed === 0;
    const released = Date.now();
    await raw.commit();
    const r = await add;
    ok('db (e): comments.add is held while a raw session holds its advisory key (≥ 300 ms)', pending && landed - t0 >= 300 && r.ok, `${landed - t0} ms`);
    ok(`db (e): …and lands right after the raw COMMIT (${landed - released} ms)`, landed - released < 1_000);
    ok(`db (e) CONTROL: another project's add is not delayed (${freeMs} ms)`, free.ok && freeMs < 300);
    const raw2 = await rawHold(url, `records:acme:projects/${p.id}/comments.json`);
    recordFs._setLockWaitMs(200);
    const refused = await as('acme', () => comments.add(p.id, { kind: 'dataset', id: p.id }, 'refused'));
    recordFs._setLockWaitMs(0);
    await raw2.commit();
    ok('db (e): past the wait the add answers {ok:false} with the busy sentence — no Postgres text',
      !refused.ok && refused.error === msgs.recordBusy() && !/lock|timeout|canceling|statement/i.test(refused.error), JSON.stringify(refused));
    const stored = await as('acme', () => comments.list(p.id));
    ok('db (e): the held add is stored, the refused one is not', stored.ok && stored.comments.map((c) => c.body).join() === 'held', JSON.stringify(stored).slice(0, 300));

    // (f) a swallowed failure: Postgres rolls the whole save back
    const good = await rec('acme', `projects/${pid}/good.json`);
    const bad = await rec('acme', `projects/${pid}/bad.json`);
    const swallow = async (): Promise<void> => {
      await writeList(good, [1]);
      try { await recordFs.writeFile(bad, 'a\u0000b'); } catch { /* the store says it never throws */ }
    };
    const res = await as('acme', () => recordFs.locked(good, swallow).then(() => 'resolved', (e: Error & { code?: string }) => e.code));
    ok('db (f): a swallowed failing statement makes locked reject', res === 'ERECORDROLLEDBACK', String(res));
    ok('db (f): …and the good write before it is absent', !(await as('acme', () => recordFs.exists(good))));
    await as('acme', swallow);
    ok('db (f) CONTROL: the same writes outside the lock keep the good one', await as('acme', () => recordFs.exists(good)));
    await as('acme', () => recordFs.rm(good));
    const inner = await rec('acme', `projects/${pid}/history/x`);
    const out = await as('acme', () => recordFs.locked(good, async () => {
      await writeList(good, [1]);
      const n = await recordFs.locked(inner, async () => { await swallow(); return 'inner'; }).catch(() => 'inner failed');
      await writeList(good, [1, 2]);
      return n;
    }).catch((e: Error) => 'outer failed: ' + e.message));
    ok('db (f): a failure nested in a SAVEPOINT fails only the nested part, the outer save is whole',
      out === 'inner failed' && (await as('acme', () => readList(good))).join() === '1,2', `${out} ${(await as('acme', () => readList(good))).join()}`);

    await pools(url);
    await rls(url, admin, pool);
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
  }
}

/** (g) the pool: pinned statements, the per-pod cap. */
async function pools(url: string): Promise<void> {
  const one = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1_000 });
  one.on('error', () => undefined);
  recordFs.useRecordDb(one);
  const pid = randomUUID();
  const a = await rec('acme', `projects/${pid}/a.json`);
  const b = await rec('acme', `projects/${pid}/b.json`);
  const nest = await as('acme', () => recordFs.locked(a, () => recordFs.locked(b, async () => {
    await append(b, 1);
    return recordFs.locked(a, async () => { await append(a, 2); return (await readList(a)).concat(await readList(b)); });
  })).catch((e: Error) => e.message));
  ok('db (g): on a max:1 pool, nested locks complete on the one pinned client', Array.isArray(nest) && nest.join() === '2,1', JSON.stringify(nest));
  const starved = await as('acme', () => recordFs.locked(a, async () => {
    const c = await one.connect();
    c.release();
    return 'connected';
  }).catch((e: Error) => e.message));
  ok('db (g) CONTROL: a second pool.connect inside a hold times out on max:1', /timeout/i.test(String(starved)), String(starved));
  await one.end();

  const two = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5_000 });
  two.on('error', () => undefined);
  recordFs.useRecordDb(two);
  const files = await Promise.all(Array.from({ length: 20 }, (_, i) => rec('acme', `projects/${pid}/k${i}.json`)));
  const twenty = await as('acme', () => Promise.all(files.map((f, i) => recordFs.locked(f, () => append(f, i))))).then(() => 'done', (e: Error) => e.message);
  ok('db (g): 20 keys on a max:2 pool all finish', twenty === 'done', twenty);
  await two.end();

  // Each hold takes a SECOND client, briefly, as an S3 input-table save does (storage.newObject → inOrg).
  const six = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 3_000 });
  six.on('error', () => undefined);
  recordFs.useRecordDb(six);
  const newObject = async (): Promise<void> => {
    const c = await six.connect();
    try { await c.query('SELECT pg_sleep(0.05)'); } finally { c.release(); }
  };
  const many = await Promise.all(Array.from({ length: 12 }, (_, i) => rec('acme', `projects/${pid}/s${i}.json`)));
  const capped = await as('acme', () => Promise.all(many.map((f, i) => recordFs.locked(f, async () => { await newObject(); await append(f, i); }))))
    .then(() => 'done', (e: Error) => e.message);
  ok('db (g): 12 holds that each take a second client finish on a max:6 pool (≤ 4 holds per pod)', capped === 'done', capped);
  const uncapped = await Promise.allSettled(Array.from({ length: 12 }, async () => {
    const c = await six.connect();
    try {
      await c.query('BEGIN');
      await newObject();
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }));
  const timedOut = uncapped.filter((s) => s.status === 'rejected' && /timeout/i.test(String((s as PromiseRejectedResult).reason))).length;
  ok(`db (g) CONTROL: the same 12 transactions without the cap starve the pool (${timedOut} timed out)`, timedOut > 0, String(timedOut));
  await six.end();
}

/** (h) as an ordinary role: the pinned transaction carries the RLS org. */
async function rls(url: string, admin: Client, pool: Pool): Promise<void> {
  const role = `ordinate_locked_${process.pid}_${randomBytes(3).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON records TO ${role}`);
  const u = new URL(url);
  u.username = role;
  u.password = pw;
  const asRole = new Pool({ connectionString: u.toString(), max: 2 });
  asRole.on('error', () => undefined);
  recordFs.useRecordDb(asRole);
  try {
    const pid = randomUUID();
    const f = await rec('acme', `projects/${pid}/rls.json`);
    await as('acme', () => Promise.all(Array.from({ length: 10 }, (_, i) => recordFs.locked(f, () => append(f, i)))));
    const mine = await as('acme', () => readList(f));
    const theirs = await as('globex', async () => readList(f));
    const row = await pool.query('SELECT org_id FROM records WHERE path = $1', [`projects/${pid}/rls.json`]);
    ok('db (h): as an ordinary role under RLS, locked saves land in the org (10 of 10)', mine.length === 10 && row.rows.length === 1 && row.rows[0].org_id === 'acme', JSON.stringify(mine));
    ok('db (h): …and another org reads none of it', theirs.length === 0);
  } finally {
    await asRole.end();
    recordFs.useRecordDb(pool);
    await pool.query(`REVOKE ALL ON records FROM ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }
}

(async () => {
  await common('file');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the DB leg: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_locked_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    await dbLeg(u.toString(), admin);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('record lock suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
