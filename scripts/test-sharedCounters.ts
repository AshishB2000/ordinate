// The abuse limits hold across pods (src/server/counters.ts, docs/any-pod/00-design.md §3.8).
//
//   1. the helper, scripted against BOTH stores (memory, then Postgres): the same
//      answers — charge, refuse at the limit, all or none across buckets (a
//      refusal charges nothing), refund into its window, the window ends, clear,
//      orgs apart (differential);
//   2. 10 takes fired at once at limit − 1: exactly one goes through (Postgres);
//   3. two password-mode pods on one database: 11 wrong passwords split across
//      them lock the account (control: 9, then the right one signs in), and 30
//      wrong attempts fired at once across both run at most 10 scrypts;
//   4. two header-mode pods: the 10-per-hour test email holds across them.
//
// Parts 2–4 need a Postgres it may CREATE DATABASE on; without DATABASE_URL they
// print one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-sharedCounters.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import * as H from './podHarness';
import { startFake } from './smtpFake';

const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

/** One scripted run of the helper; the answers, in order. */
async function script(): Promise<unknown[]> {
  const W = 600;
  const a = { key: 'a', limit: 3, windowMs: W };
  const b = { key: 'b', limit: 5, windowMs: W };
  const out: unknown[] = [];
  const t = async (org: string, list: Array<typeof a>, by = 1): Promise<boolean> => (await counters.take(org, list, by)).ok;
  out.push(await t('acme', [a], 2));          // 2 of 3
  const held = await counters.take('acme', [a], 1); // 3 of 3
  out.push(held.ok);
  out.push(await t('acme', [a]));              // refused
  out.push(await t('acme', [a, b]));           // refused as a whole…
  out.push(await t('acme', [b], 5));           // …so b got nothing: all 5 fit
  if (held.ok) await counters.give('acme', held.windows, 1);
  out.push(await t('acme', [a]));              // the refund made room for one
  out.push(await t('acme', [a]));              // and only one
  out.push(await t('acme', [a], 4));           // more than the limit: never
  out.push(await t('globex', [a], 3));         // another org's own window
  await H.sleep(W + 150);
  out.push(await t('acme', [a], 3));           // the window ended: a full one again
  await counters.clear('acme', 'a');
  out.push(await t('acme', [a], 3));           // cleared: full again
  const r = await counters.take('acme', [a]);
  out.push(!r.ok && r.retryAfterSec >= 1);     // a refusal says how long
  return out;
}
const EXPECT = [true, true, false, false, true, true, false, false, true, true, true, true];

(async () => {
  counters.useCounterDb(null);
  counters.resetMemoryForTest();
  const mem = await script();
  ok('memory store: charge, refuse, all-or-none, refund, window end, clear, orgs apart', JSON.stringify(mem) === JSON.stringify(EXPECT), JSON.stringify(mem));

  const db = await H.scratchDb('counters');
  if (!db) {
    console.log('skip shared-counter Postgres and pod checks: DATABASE_URL is unset');
    return finish();
  }
  const fake = await startFake({ mode: 'none' });
  try {
    await mig.migrate(db.pool);
    counters.useCounterDb(db.pool);
    const pg = await script();
    ok('DIFFERENTIAL: Postgres answers the same script exactly as memory', pg.length === mem.length && pg.every((v, i) => Object.is(v, mem[i])), JSON.stringify(pg));
    const refusedWrote = await db.pool.query(`SELECT n FROM shared_counters WHERE org_id = 'acme' AND key = 'a'`);
    ok('a refusal wrote nothing: the row still holds the 3 the window allows', Number(refusedWrote.rows[0]?.n) === 3, JSON.stringify(refusedWrote.rows));

    // 2. A real race: 10 takes at once at limit − 1.
    const race = { key: 'race', limit: 10, windowMs: 60_000 };
    await counters.take('acme', [race], 9);
    const fired = await Promise.all(Array.from({ length: 10 }, () => counters.take('acme', [race])));
    ok('10 takes at once at limit − 1: exactly one goes through', fired.filter((x) => x.ok).length === 1, fired.map((x) => x.ok).join());
    counters.useCounterDb(null);

    // 3. Password mode, two pods, one database.
    const dataDir = H.tmp('counters-pw');
    const pwEnv = { DATABASE_URL: db.url, AUTH_MODE: 'password', DATA_DIR: dataDir, RATE_LIMIT_LOGIN_PER_MINUTE: '100000', ORDINATE_ORG: 'acme' };
    const A = await H.startPod(pwEnv);
    const code = /First-run setup code: ([A-Z0-9-]{14})/.exec(A.out())?.[1] ?? '';
    const EMAIL = 'boss@acme.test';
    const GOOD = 'correct horse battery 42';
    const post = async (base: string, route: string, body: unknown) => {
      const res = await fetch(`${base}/api/auth/password/${route}`, { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
      return { retry: res.headers.get('retry-after'), body: (await res.json()) as { ok: boolean; error?: string } };
    };
    const setup = await post(A.base, 'setup', { code, email: EMAIL, password: GOOD });
    ok('setup: the first admin, through the code pod A logged', setup.body.ok === true, JSON.stringify(setup.body));
    const B = await H.startPod({ ...pwEnv, DATA_DIR: H.tmp('counters-pw-b') });
    const pods = [A, B];
    const reset = () => db.pool.query(`DELETE FROM shared_counters WHERE key LIKE 'login:%'`);

    const nine: string[] = [];
    for (let i = 0; i < 9; i++) nine.push(String((await post(pods[i % 2].base, 'login', { email: EMAIL, password: 'wrong password ' + i })).body.error));
    const after9 = await post(B.base, 'login', { email: EMAIL, password: GOOD });
    ok('control: 9 wrong passwords across A and B, then the right one signs in', nine.every((e) => e === 'invalid') && after9.body.ok === true, JSON.stringify([nine, after9.body]));

    await reset();
    const ten: string[] = [];
    for (let i = 0; i < 10; i++) ten.push(String((await post(pods[i % 2].base, 'login', { email: EMAIL, password: 'wrong password ' + i })).body.error));
    const eleventh = await post(B.base, 'login', { email: EMAIL, password: GOOD });
    ok('11 sign-ins split across two pods lock the account: the 11th is `locked` with Retry-After, even with the right password',
      ten.every((e) => e === 'invalid') && eleventh.body.ok === false && eleventh.body.error === 'locked' && Number(eleventh.retry) > 0, JSON.stringify([ten, eleventh]));

    await reset();
    const verified = (): number => pods.reduce((n, p) => n + p.lines().filter((l) => l.msg === 'password sign-in refused: wrong email or password').length, 0);
    const before = verified();
    const storm = await Promise.all(Array.from({ length: 30 }, (_, i) => post(pods[i % 2].base, 'login', { email: EMAIL, password: 'storm ' + i })));
    await H.sleep(300); // the last log lines
    const ran = verified() - before;
    const locked = storm.filter((r) => r.body.error === 'locked').length;
    const busy = storm.filter((r) => r.body.error === 'busy').length; // charged, then past a pod's sign-ins hashing at once (src/server/auth/password.ts)
    ok(`30 wrong attempts at once across A and B: at most 10 scrypt verifications (${ran}), the rest locked (${locked}) or busy (${busy})`,
      ran <= 10 && locked >= 20 && ran + locked + busy === 30, JSON.stringify(storm.map((r) => r.body.error)));
    await A.stop();
    await B.stop();

    // NEGATIVE CONTROL: the same pods with the counter kept in each process (the preload) let all 11 through to scrypt.
    await reset();
    const PRE = require('path').join(__dirname, 'anyPodPreload.js');
    const MA = await H.startPod({ ...pwEnv, ANYPOD_MEMORY_COUNTERS: '1' }, PRE);
    const MB = await H.startPod({ ...pwEnv, DATA_DIR: H.tmp('counters-pw-c'), ANYPOD_MEMORY_COUNTERS: '1' }, PRE);
    const perPod: string[] = [];
    for (let i = 0; i < 11; i++) perPod.push(String((await post([MA, MB][i % 2].base, 'login', { email: EMAIL, password: 'wrong password ' + i })).body.error));
    ok('NEGATIVE CONTROL: with per-pod counters, 11 wrong passwords split across two pods never lock', perPod.every((e) => e === 'invalid'), JSON.stringify(perPod));
    await MA.stop();
    await MB.stop();

    // 4. The test-email limit across pods (header mode: the proxy names the caller).
    const mailDb = await H.scratchDb('counters_mail');
    if (mailDb) {
      try {
        const env = {
          DATABASE_URL: mailDb.url, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: EMAIL,
          SMTP_HOST: '127.0.0.1', SMTP_PORT: String(fake.port), SMTP_SECURITY: 'plaintext', SMTP_FROM: 'Acme <bi@acme.test>', RATE_LIMIT_RPC_PER_MINUTE: '100000',
        };
        const MA = await H.startPod({ ...env, DATA_DIR: H.tmp('counters-mail-a') });
        const MB = await H.startPod({ ...env, DATA_DIR: H.tmp('counters-mail-b') });
        const boss = { 'x-forwarded-email': EMAIL };
        await H.rpc(MA.base, boss, 'channel:list');
        const uid = (await mailDb.pool.query(`SELECT id FROM users WHERE email = $1`, [EMAIL])).rows[0]?.id as string;
        const saved = await H.rpc(MA.base, boss, 'channel:save', { name: 'Leads', kind: 'email', to: { userIds: [uid], teamIds: [] } });
        const id = saved.body?.channel?.id as string;
        const sent: boolean[] = [];
        for (let i = 0; i < 11; i++) sent.push((await H.rpc([MA, MB][i % 2].base, boss, 'channel:test', { id })).body?.ok === true);
        ok('the test-email limit holds across pods: 10 go (control), the 11th is refused', sent.slice(0, 10).every(Boolean) && sent[10] === false && fake.txns.length === 10,
          JSON.stringify({ sent, txns: fake.txns.length, saved: saved.body?.ok }));
        await MA.stop();
        await MB.stop();
      } finally {
        await mailDb.drop();
      }
    }
  } finally {
    await H.stopAll();
    await fake.close();
    await db.drop();
  }
  finish();
})().catch((err) => {
  ok('the suite ran to the end', false, err instanceof Error ? err.stack : err);
  void H.stopAll().then(finish);
});
