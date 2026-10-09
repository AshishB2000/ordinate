// Live usage on Postgres (docs/live-data/00-plan.md L2.7, R-L2): the count and
// the daily limit shared by every pod. Two "pods" are two pools on one
// database — the admission is the only state they share — plus the apps
// (header sign-in) for the admin channel and the event streams.
//
//   atomic     N admissions racing on two pools → exactly N on the row; bytes
//              from both pools add up exactly. NEGATIVE CONTROL: a
//              read-then-write count on two pools loses increments
//   limit      2 pools × 10 at once with 7 left → exactly 7 admitted, 13
//              refused, exactly ONE refusal the day's first. NEGATIVE
//              CONTROL: check-then-count without the lock lets both pools past
//   executor   the real executor (fake warehouse) counts its statements and the
//              warehouse's bytes on the connection's row in Postgres; past the
//              limit it refuses, typed, with no statement sent
//   notice     a burst of refusals → one `live:daily-limit` event on the org
//              admin's stream, none on a viewer's; a second burst sends none
//   RLS        as an ordinary role: nothing without `ordinate.org`, one org's
//              rows with it, a write for another org refused — and the store's
//              own statements pass under it
//   admin      admin:liveUsage: per-connection rows named from the records, the
//              limit and today's count; another org's admin sees none of them
//   measured   one admission's round trip, with and without a limit
//
// Needs a Postgres it may CREATE DATABASE (and ROLE) on; without DATABASE_URL
// it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-liveUsage-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const { randomBytes, randomUUID }: typeof import('crypto') = require('crypto');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const usage: typeof import('../src/server/live/usageStore') = require('../src/server/live/usageStore');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const msg: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

type Identity = import('../src/server/context').Identity;
type Admission = import('../src/server/live/usageStore').Admission;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-liveusage-db-'));
const ACME: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
const BETA: Identity = { user: { email: 'boss@beta.test', role: 'admin' }, org: { id: 'beta' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown): string => JSON.stringify(v);
let reqN = 0;
const as = <T>(who: Identity, fn: () => Promise<T>): Promise<T> => context.runInContext(who, `t${++reqN}`, fn);
const key = () => ({ projectId: randomUUID(), connectionId: randomUUID() });
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

interface Tab { events: { channel: string; data: unknown }[]; close(): void }

/** /api/events on `base` as `email` — a browser tab's EventSource. */
function openTab(base: string, email: string): Promise<Tab> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path: `/api/events?client=${randomUUID()}`, headers: { 'x-forwarded-email': email } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`/api/events ${res.statusCode}`));
      const tab: Tab = { events: [], close: () => req.destroy() };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          tab.events.push({ channel: ev ? ev[1] : 'message', data: data ? wire.decode(data[1]) : undefined });
        }
      });
      res.on('error', () => { /* a destroyed test socket */ });
      resolve(tab);
    });
    req.on('error', reject);
  });
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip live-usage DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_l27_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const podA = new Pool({ connectionString: scratch.toString(), max: 10 });
  const podB = new Pool({ connectionString: scratch.toString(), max: 10 });
  for (const p of [podA, podB]) p.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const apps: FastifyInstance[] = [];
  const tabs: Tab[] = [];
  const role = `ordinate_l27_${process.pid}_${randomBytes(3).toString('hex')}`;
  let rolePool: Pool | null = null;
  try {
    context.enterServerMode(DATA);
    poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
    fakeMod.registerLiveFake();
    appMod.registerHandlers();
    const base: Record<string, string> = {};
    for (const org of ['acme', 'beta']) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`, RATE_LIMIT_RPC_PER_MINUTE: '100000',
      }));
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base[org] = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    }
    const call = async (org: string, email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base[org]}/api/rpc/${channel}`, {
        method: 'POST', headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }), body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await podA.query<T>(sql, args)).rows;
    const today = usage.utcDay();
    const sums = async (org: string) => (await q<{ queries: string; refused: string }>(
      'SELECT coalesce(sum(queries), 0)::text AS queries, coalesce(sum(refused), 0)::text AS refused FROM live_usage WHERE org_id = $1 AND day = $2::date', [org, today]))[0];
    ok('migration: live_usage exists with forced RLS', (await q<{ f: boolean }>(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'live_usage'`))[0]?.f === true);

    // ── Atomic: N racing admissions on two pools → exactly N ────────────────
    const k1 = key();
    const N = 60;
    const raced = await as(ACME, () => Promise.all(Array.from({ length: N }, (_, i) => usage.admit(i % 2 ? podB : podA, k1, 0))));
    const row1 = (await q<{ queries: string; refused: string; project_id: string }>('SELECT queries::text, refused::text, project_id::text FROM live_usage WHERE connection_id = $1', [k1.connectionId]))[0];
    ok(`atomic: ${N} admissions racing on two pools are exactly ${N} on one row, all admitted (no limit)`, raced.every((a) => a.admitted) && row1?.queries === String(N) && row1.refused === '0' && row1.project_id === k1.projectId, show(row1));
    const tickets = raced.flatMap((a) => (a.admitted ? [a.ticket] : []));
    await Promise.all(tickets.map((t, i) => usage.addBytes({ ...t, pool: i % 2 ? podA : podB }, 1000 + i)));
    const bytes1 = (await q<{ b: string }>('SELECT bytes::text AS b FROM live_usage WHERE connection_id = $1', [k1.connectionId]))[0]?.b;
    const want = Array.from({ length: N }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
    ok(`atomic: ${N} byte figures added from both pools sum exactly (${want})`, bytes1 === String(want), bytes1);
    // NEGATIVE CONTROL: the same race as a read-then-write — what `queries = queries + 1` in one statement avoids.
    const k0 = key();
    await podA.query(`INSERT INTO live_usage (org_id, day, connection_id, project_id, queries) VALUES ('acme', $1::date, $2, $3, 0)`, [today, k0.connectionId, k0.projectId]);
    const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? podB : podA).query<{ n: string }>('SELECT queries::text AS n FROM live_usage WHERE connection_id = $1', [k0.connectionId])));
    await Promise.all(reads.map((r, i) => (i % 2 ? podB : podA).query('UPDATE live_usage SET queries = $2 WHERE connection_id = $1', [k0.connectionId, Number(r.rows[0].n) + 1])));
    const lost = (await q<{ n: string }>('SELECT queries::text AS n FROM live_usage WHERE connection_id = $1', [k0.connectionId]))[0].n;
    ok(`atomic NEGATIVE CONTROL: 20 read-then-write counts on two pools leave ${lost}, not 20`, Number(lost) < 20, lost);
    await podA.query('DELETE FROM live_usage WHERE connection_id = $1', [k0.connectionId]);

    // ── The limit holds across pods ─────────────────────────────────────────
    const have = Number((await sums('acme')).queries);
    const LIMIT = have + 7;
    const k2 = key();
    const burst: Admission[] = await as(ACME, () => Promise.all(Array.from({ length: 20 }, (_, i) => usage.admit(i % 2 ? podB : podA, k2, LIMIT))));
    const admitted = burst.filter((a) => a.admitted).length;
    const firsts = burst.filter((a) => !a.admitted && a.first).length;
    const s2 = await sums('acme');
    ok(`limit: 20 at once on two pods with 7 left → exactly 7 admitted, 13 refused (limit ${LIMIT})`, admitted === 7 && Number(s2.queries) === LIMIT && s2.refused === '13', show({ admitted, s2 }));
    ok('limit: exactly ONE of the 13 refusals is the day\'s first — the one notice, whichever pod', firsts === 1, firsts);
    const late = await as(ACME, () => usage.admit(podB, key(), LIMIT));
    ok('limit: the next one, on either pod, is refused and is not a first', !late.admitted && !late.first);
    // NEGATIVE CONTROL: check, then count — no lock — on two pools at limit − 1.
    const naive = async (pool: Pool, k: { projectId: string; connectionId: string }, limit: number) => {
      const n = Number((await pool.query<{ n: string }>(`SELECT coalesce(sum(queries), 0)::text AS n FROM live_usage WHERE org_id = 'naive' AND day = $1::date`, [today])).rows[0].n);
      return { n, k, pool, admitted: n < limit };
    };
    const checks = await Promise.all([naive(podA, key(), 1), naive(podB, key(), 1)]);
    for (const c of checks.filter((x) => x.admitted)) {
      await c.pool.query(`INSERT INTO live_usage (org_id, day, connection_id, project_id, queries) VALUES ('naive', $1::date, $2, $3, 1)`, [today, c.k.connectionId, c.k.projectId]);
    }
    const over = Number((await q<{ n: string }>(`SELECT coalesce(sum(queries), 0)::text AS n FROM live_usage WHERE org_id = 'naive'`))[0].n);
    const held = await as({ ...ACME, org: { id: 'held' } }, () => Promise.all([usage.admit(podA, key(), 1), usage.admit(podB, key(), 1)]));
    ok(`limit NEGATIVE CONTROL: check-then-count on two pools at limit 1 lets ${over} through; the store's admission lets ${held.filter((a) => a.admitted).length}`,
      over === 2 && held.filter((a) => a.admitted).length === 1, show({ over }));

    // ── The executor, counted in Postgres ───────────────────────────────────
    const P = (await call('acme', 'boss@acme.test', 'projects:create', { name: 'Warehouse costs' })).body.id as string;
    const seeded = await as(ACME, () => fakeMod.seedLiveFake(P));
    await as(ACME, () => liveDataset.setMaxCacheAge(P, seeded.datasetId, 0));
    queryCache.clear();
    fakeMod.resetFake();
    fakeMod.fake.billedBytes = 5_000;
    process.env.LIVE_DAILY_QUERY_LIMIT = '0';
    for (let i = 0; i < 3; i++) await as(ACME, () => lq.liveMetric(P, seeded.datasetId, { column: 'amount', aggregation: 'sum' }, []));
    await sleep(100); // the byte figure is added when the connector settles, after the reply
    const ex = (await q<{ queries: string; bytes: string; project_id: string }>('SELECT queries::text, bytes::text, project_id::text FROM live_usage WHERE connection_id = $1 AND day = $2::date', [seeded.connId, today]))[0];
    ok('executor: 3 warehouse statements → 3 queries and 15,000 bytes on the connection\'s row, in Postgres', fakeMod.fake.calls.length === 3 && ex?.queries === '3' && ex.bytes === '15000' && ex.project_id === P, show(ex));
    process.env.LIVE_DAILY_QUERY_LIMIT = String(Number((await sums('acme')).queries));
    const refused = await as(ACME, () => lq.liveMetric(P, seeded.datasetId, { column: 'amount', aggregation: 'max' }, []));
    ok('executor: at the org\'s limit — reached on the other "pod" — the next question is refused, typed, with no statement sent',
      !refused.ok && refused.reason === 'dailyLimit' && refused.error === msg.liveDailyLimit(Number(process.env.LIVE_DAILY_QUERY_LIMIT).toLocaleString('en-US')) && fakeMod.fake.calls.length === 3, show(refused));

    // ── One notice, to the admins' streams ──────────────────────────────────
    await call('beta', 'boss@beta.test', 'projects:list'); // signs the admin in (ORDINATE_ADMIN_EMAIL)
    await call('beta', 'vic@beta.test', 'projects:list'); // and a viewer
    const bossTab = await openTab(base.beta, 'boss@beta.test');
    const vicTab = await openTab(base.beta, 'vic@beta.test');
    tabs.push(bossTab, vicTab);
    await sleep(100);
    process.env.LIVE_DAILY_QUERY_LIMIT = '2';
    const bk = key();
    const use = { org: 'beta', datasetId: randomUUID(), ...bk };
    const burst1 = await as(BETA, () => Promise.all(Array.from({ length: 8 }, () => budget.checkDaily(use))));
    const until = async (cond: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(20); return cond(); };
    const notices = (t: Tab) => t.events.filter((e) => e.channel === 'live:daily-limit');
    await until(() => notices(bossTab).length > 0);
    await sleep(300);
    ok('notice: 8 checks at limit 2 → 2 admitted, 6 refused, and ONE `live:daily-limit` event on the org admin\'s stream',
      burst1.filter((d) => d.ok).length === 2 && notices(bossTab).length === 1 && show(notices(bossTab)[0].data) === show({ day: today, limit: 2 }), show(bossTab.events));
    ok('notice: …none on a viewer\'s stream (the limit is the admins\' to raise)', notices(vicTab).length === 0, show(vicTab.events));
    await as(BETA, () => Promise.all(Array.from({ length: 4 }, () => budget.checkDaily(use))));
    await sleep(300);
    ok('notice NEGATIVE CONTROL: a second burst of refusals the same day sends nothing', notices(bossTab).length === 1);
    delete process.env.LIVE_DAILY_QUERY_LIMIT;

    // ── RLS, as an ordinary role ────────────────────────────────────────────
    const pw = randomBytes(12).toString('hex');
    await podA.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await podA.query(`GRANT SELECT, INSERT, UPDATE ON live_usage TO ${role}`);
    const asRole = new URL(scratch.toString());
    asRole.username = role;
    asRole.password = pw;
    rolePool = new Pool({ connectionString: asRole.toString(), max: 2 });
    rolePool.on('error', () => undefined);
    const rp = rolePool;
    const see = async (org: string | null) => {
      const c = await rp.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
        const r = await c.query<{ org_id: string }>('SELECT org_id FROM live_usage');
        await c.query('COMMIT');
        return r.rows;
      } finally {
        c.release();
      }
    };
    const acmeRows = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM live_usage WHERE org_id = 'acme'`))[0].n);
    const seenAcme = await see('acme');
    ok('rls: as acme the ordinary role sees exactly acme\'s rows (not vacuous)', seenAcme.length === acmeRows && acmeRows >= 3 && seenAcme.every((r) => r.org_id === 'acme'), `${seenAcme.length} of ${acmeRows}`);
    ok('rls: with no setting, nothing', (await see(null)).length === 0);
    ok('rls: as beta, beta\'s rows and none of acme\'s', (await see('beta')).every((r) => r.org_id === 'beta') && (await see('beta')).length >= 1);
    let checkRefused = false;
    const c = await rp.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('ordinate.org', 'beta', true)`);
      await c.query(`INSERT INTO live_usage (org_id, day, connection_id, project_id, queries) VALUES ('acme', $1::date, $2, $3, 1)`, [today, randomUUID(), randomUUID()]);
    } catch (e) {
      checkRefused = /row-level security/.test((e as Error).message);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    ok('rls: a write for another org is refused (WITH CHECK)', checkRefused);
    const viaRole = await as(ACME, () => usage.admit(rp, key(), 0));
    ok('rls: the store\'s own admission passes under it, as an ordinary role', viaRole.admitted);

    // ── admin:liveUsage over HTTP ───────────────────────────────────────────
    process.env.LIVE_DAILY_QUERY_LIMIT = '5000';
    const reply = await call('acme', 'boss@acme.test', 'admin:liveUsage');
    const body = reply.body as import('../src/server/admin/liveUsage').LiveUsage;
    const mine = body.rows?.find((r) => r.connectionId === seeded.connId);
    const s3 = await sums('acme');
    ok('admin: the executor\'s connection is a row of its own — named from the records, with its project, queries and bytes',
      reply.status === 200 && !!mine && mine.connection === 'Fake warehouse' && mine.connector === 'Fake warehouse (tests)' && mine.project === 'Warehouse costs'
        && mine.queries === 3 && mine.bytes === 15_000 && mine.bytesLabel === '14.6 KB' && mine.day === today, show(mine));
    ok('admin: the limit, today\'s org-wide count and refusals, from Postgres (not per pod)',
      body.limit === 5000 && body.todayQueries === Number(s3.queries) && body.todayRefused === Number(s3.refused) && body.perPod === false, show({ ...body, rows: body.rows.length }));
    ok('admin: a connection the records do not know reads as deleted, its count kept', body.rows.some((r) => r.connectionId === k1.connectionId && r.connection === null && r.queries === N));
    const betaReply = (await call('beta', 'boss@beta.test', 'admin:liveUsage')).body as import('../src/server/admin/liveUsage').LiveUsage;
    ok('admin: another org\'s admin sees its own rows and none of acme\'s', betaReply.rows.length >= 1 && betaReply.rows.every((r) => !body.rows.some((x) => x.connectionId === r.connectionId)));
    ok('admin: a viewer is refused (403)', (await call('beta', 'vic@beta.test', 'admin:liveUsage')).status === 403);
    delete process.env.LIVE_DAILY_QUERY_LIMIT;

    // ── Measured ────────────────────────────────────────────────────────────
    const time = async (limit: number) => {
      const ms: number[] = [];
      const k = key();
      for (let i = 0; i < 100; i++) {
        const t0 = performance.now();
        await as({ ...ACME, org: { id: 'bench' } }, () => usage.admit(podA, k, limit));
        ms.push(performance.now() - t0);
      }
      return median(ms);
    };
    const locked = await time(1_000_000);
    const free = await time(0);
    console.log(`  measured: one admission, median of 100 sequential — with a limit (advisory lock + sum + upsert) ${locked.toFixed(2)} ms, without ${free.toFixed(2)} ms`);
    ok('measured: an admission is a few ms — small beside a warehouse statement', locked < 50 && free < 50, show({ locked, free }));
  } finally {
    for (const t of tabs) t.close();
    for (const app of apps) await app.close().catch(() => undefined);
    await rolePool?.end().catch(() => undefined);
    await podA.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await podA.end();
    await podB.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
