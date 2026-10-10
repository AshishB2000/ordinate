// Refresh URLs (live data L0.5) against a real Postgres, over real HTTP, on
// two "pods" — two apps, each with its own pool, one database and DATA_DIR.
//
//   access     viewers, members without a grant and another org's admin get
//              403 on every channel; a pasted dataset cannot have one; a
//              personal API token cannot mint one
//   at rest    sha256 + a 13-character prefix; the list never carries more
//   one thing  a URL for dataset A refreshes A — a query string or a body
//              naming B changes nothing, and B is untouched
//   interval   a second call inside REFRESH_HOOK_MIN_INTERVAL_SEC → 429 with
//              Retry-After, from the other pod too; both pods at the same
//              instant → exactly one 202, every round. NEGATIVE CONTROL: a
//              check-then-act claim on two pools lets both through
//   coalesce   another pod holding the dataset's refresh lock, or a refresh of
//              it running here → `already_running`, nothing queued
//   no oracle  revoked and unknown: the same status, body, headers and SQL
//              statements; neither leaves an audit row
//   creator    the refresh runs as the hook's creator (their Jobs list); one
//              who lost the grant or was disabled → 403 + a `denied` row
//   live       on a Live dataset the URL bumps the cache epoch:
//              `cache_reset`, no refresh job
//   audit      `hook_refresh` (creator, hook + dataset ids) and, closing the
//              old gap, `scheduled_refresh` (the jobs identity)
//   RLS        an ordinary role sees nothing without an org or the token's
//              hash, exactly one row with the hash, and nothing of another org
//   canary     no token in any log line, audit row, database row, or reply
//              other than its one create
//   gate       an admin's proxy header changes nothing on the route; the same
//              cookie-less cross-site call to /api/rpc is refused (control)
//
// Two real server PROCESSES racing one URL: scripts/test-refreshHooks-pods.ts.
// Needs a Postgres it may CREATE DATABASE (and ROLE) on; without DATABASE_URL
// it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-refreshHooks-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { createHash, randomBytes }: typeof import('crypto') = require('crypto');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const store: typeof import('../src/server/hooks/store') = require('../src/server/hooks/store');
const pgMod: typeof import('pg') = require('pg');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-hooks-db-'));
const EN: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
const INTERVAL = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const sink = new Writable({ write(chunk: Buffer, _e, cb) { log.push(...chunk.toString('utf8').split('\n').filter(Boolean)); cb(); } });

async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip refresh-URL DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_l05_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const apps: FastifyInstance[] = [];
  const tokens: string[] = [];
  const replies: string[] = []; // every reply body but a create's
  const role = `ordinate_l05_${process.pid}_${randomBytes(3).toString('hex')}`;
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();
    const base: string[] = [];
    for (const org of ['acme', 'acme', 'beta']) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'trace', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`, REFRESH_HOOK_MIN_INTERVAL_SEC: String(INTERVAL), RATE_LIMIT_LOGIN_PER_MINUTE: '5000',
      }), sink);
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base.push(`http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`);
    }
    const [podA, podB, beta] = base;
    const call = async (at: string, email: string | null, channel: string, payload?: unknown, bearer?: string) => {
      const h: Record<string, string> = { 'content-type': 'application/json', ...(email ? { 'x-forwarded-email': email } : {}) };
      const res = await fetch(`${at}/api/rpc/${channel}`, {
        method: 'POST', headers: bearer ? { ...h, authorization: `Bearer ${bearer}` } : withCsrf(h), body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      if (channel !== 'refreshHook:create' && channel !== 'tokens:create') replies.push(text);
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    const fire = async (at: string, token: string, opts: { headers?: Record<string, string>; body?: string; query?: string } = {}) => {
      const res = await fetch(`${at}/api/hooks/refresh/${token}${opts.query ?? ''}`, { method: 'POST', headers: opts.headers, body: opts.body });
      const text = await res.text();
      replies.push(text);
      let json: any = null; // any: the route's small JSON body
      try { json = JSON.parse(text); } catch { /* none */ }
      return { status: res.status, text, json, headers: res.headers };
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    const uid = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0].id;

    // ── People, a project, datasets ─────────────────────────────────────────
    for (const p of ['boss', 'carol', 'vic', 'dan']) await call(podA, `${p}@acme.test`, 'projects:list');
    await call(beta, 'boss@beta.test', 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email IN ('carol@acme.test', 'dan@acme.test')`);
    const P = (await call(podA, 'boss@acme.test', 'projects:create', { name: 'Warehouse' })).body.id as string;
    const Q = (await call(podA, 'boss@acme.test', 'projects:create', { name: 'Other' })).body.id as string;
    const grant = (email: string, r: string) => uid(email).then((id) => pool.query(`INSERT INTO project_grants (org_id, project_id, user_id, role) VALUES ('acme', $1, $2, $3)`, [P, id, r]));
    await grant('carol@acme.test', 'editor');
    await grant('vic@acme.test', 'viewer');
    const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const asBoss = <T>(fn: () => Promise<T>) => context.runInContext(BOSS, 'test', fn);
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'revenue', type: 'number' as const }];
    const combined = async (name: string) => {
      const l = await datasets.saveDataset(P, { name: `${name} north`, sourceKind: 'csv', columns: cols, rows: [['north', 10]] });
      const r = await datasets.saveDataset(P, { name: `${name} south`, sourceKind: 'csv', columns: cols, rows: [['south', 20]] });
      return (await datasets.saveDataset(P, { name, sourceKind: 'combined', columns: cols, rows: [['north', 10]], origin: { kind: 'combined', leftId: l!.id, rightId: r!.id, mode: 'append' } }))!.id;
    };
    const { A, B, S, C, L } = await asBoss(async () => ({
      A: await combined('Orders'), B: await combined('Refunds'), S: await combined('Scheduled'),
      C: (await datasets.saveDataset(P, { name: 'Pasted', sourceKind: 'paste', columns: cols, rows: [['x', 1]] }))!.id,
      L: (await liveRecord.saveLiveRecord(P, { name: 'Orders live', columns: cols, origin: { kind: 'connection', connId: '0e6a1f2c-3b4d-4e5f-8a9b-0c1d2e3f4a5b', table: 'orders' } }))!.id,
    }));
    const meta = (id: string) => asBoss(() => datasets.getDatasetMeta(P, id));
    const rowsOf = async (id: string) => (await meta(id))?.rowCount;

    // ── Access ──────────────────────────────────────────────────────────────
    for (const [who, at, email] of [['a project viewer', podA, 'vic@acme.test'], ['an org editor without a grant', podA, 'dan@acme.test'], ["another org's admin", beta, 'boss@beta.test']]) {
      const codes = [await call(at, email, 'refreshHook:list', { projectId: P, datasetId: A }), await call(at, email, 'refreshHook:create', { projectId: P, datasetId: A }),
        await call(at, email, 'refreshHook:revoke', { projectId: P, id: A })].map((r) => r.status);
      ok(`access: ${who} → 403 on list, create and revoke`, codes.every((c) => c === 403), codes.join());
    }
    const empty = (await call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: A })).body;
    ok('list: a project editor gets {available, minIntervalSec, hooks: []}', empty.available === true && empty.minIntervalSec === INTERVAL && empty.hooks.length === 0, JSON.stringify(empty));
    const pasted = (await call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, datasetId: C })).body;
    ok('create: a pasted dataset cannot have one (the catalog sentence)', pasted.ok === false && pasted.error === EN['refreshHookMessages.has_no_source_to_refresh_from'].replace('{name}', 'Pasted'), JSON.stringify(pasted));
    const personal = (await call(podA, 'carol@acme.test', 'tokens:create', { name: 'ci' })).body.token as string;
    const viaToken = (await call(podA, null, 'refreshHook:create', { projectId: P, datasetId: A }, personal)).body;
    ok('create: a personal API token cannot mint one (it would outlive the token\'s revocation)', viaToken.ok === false && viaToken.error === EN['refreshHookMessages.make_a_refresh_url_from_the'], JSON.stringify(viaToken));

    // ── Create, and what is at rest ─────────────────────────────────────────
    const made = (await call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, datasetId: A })).body;
    const tA = made.token as string;
    tokens.push(tA, personal);
    ok('create: ordh_ + 43 chars, once, with its 13-character prefix', made.ok && /^ordh_[A-Za-z0-9_-]{43}$/.test(tA) && made.hook.prefix === tA.slice(0, 13) && made.hook.createdBy === 'carol@acme.test');
    const listed = (await call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: A })).body.hooks as Record<string, unknown>[];
    ok('list: prefix, creator, created, last used and how it ended, revoked — nothing else', listed.length === 1
      && Object.keys(listed[0]).sort().join() === 'createdAt,createdBy,id,lastFinishedAt,lastResult,lastUsedAt,prefix,revokedAt' && listed[0].lastUsedAt === null && listed[0].revokedAt === null, JSON.stringify(listed));
    const row = (await q<{ token_hash: string; prefix: string; org_id: string; dataset_id: string }>('SELECT token_hash, prefix, org_id, dataset_id FROM refresh_hooks'))[0];
    ok('at rest: token_hash = sha256(token), prefix = its first 13 characters, org and dataset', row.token_hash === createHash('sha256').update(tA).digest('hex')
      && row.prefix === tA.slice(0, 13) && row.org_id === 'acme' && row.dataset_id === A);

    // ── One thing: dataset A, whatever the call says ────────────────────────
    const audits0 = (await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'hook_refresh'`))[0].n;
    const bBefore = JSON.stringify(await meta(B));
    const first = await fire(podA, tA, { query: `?datasetId=${B}&projectId=${Q}`, headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ datasetId: B, projectId: P }) });
    ok('fire: 202 {status: queued} — cross-site, no CSRF pair, with a body and a query naming B', first.status === 202 && first.json?.status === 'queued', `${first.status} ${first.text}`);
    ok('fire: no cookie is set on the reply', first.headers.get('set-cookie') === null);
    ok('fire: A was refreshed (1 → 2 rows)', await until(async () => (await rowsOf(A)) === 2), await rowsOf(A));
    ok('fire: B was not (its record unchanged, 1 row)', (await rowsOf(B)) === 1 && JSON.stringify(await meta(B)) === bBefore);
    const jobsMod: typeof import('../src/app/jobs') = require('../src/app/jobs');
    const jobIds = () => new Set([...jobsMod.snapshot().active, ...jobsMod.snapshot().recent].map((j) => j.id));
    const newJobsFor = (known: Set<string>, id: string) => [...jobsMod.snapshot().active, ...jobsMod.snapshot().recent].filter((j) => !known.has(j.id) && j.datasetId === id).length;
    ok('as whom: the refresh job is the creator\'s (her Jobs list)', jobsMod.snapshotFor('acme\ncarol@acme.test').recent.some((j) => j.kind === 'refresh' && j.datasetId === A));
    const again = await fire(podB, tA);
    const after = Number(again.headers.get('retry-after'));
    ok('interval: called again at once, on the OTHER pod → 429 with Retry-After within the interval', again.status === 429 && after >= 1 && after <= INTERVAL && again.json?.retryAfter === after, `${again.status} ${after}`);
    const trail = await q<{ actor: string; target_ids: string[]; project_id: string; outcome: string }>(`SELECT actor, target_ids, project_id, outcome FROM audit_log WHERE action = 'hook_refresh' ORDER BY id`);
    ok('audit: one hook_refresh row (not for the 429): the creator, the hook and A, never B', trail.length === Number(audits0) + 1
      && trail[0].actor === 'carol@acme.test' && trail[0].target_ids.join() === [made.hook.id, A].join() && trail[0].project_id === P && trail[0].outcome === 'ok', JSON.stringify(trail));
    const stamped = (await call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: A })).body.hooks[0];
    ok('list: last used is stamped', typeof stamped.lastUsedAt === 'string');

    // ── Both pods at the same instant ───────────────────────────────────────
    const rounds: string[] = [];
    for (let i = 0; i < 4; i++) {
      await sleep(INTERVAL * 1000 + 150);
      rounds.push((await Promise.all([fire(podA, tA), fire(podB, tA)])).map((r) => r.status).sort().join('+'));
    }
    ok('race: both pods at once, 4 rounds → exactly one 202 and one 429 every round', rounds.every((r) => r === '202+429'), rounds.join(' '));
    // NEGATIVE CONTROL: read last_used_at, then stamp it — two pools, both read before either writes.
    const [c1, c2] = [new Client({ connectionString: scratch.toString() }), new Client({ connectionString: scratch.toString() })];
    await Promise.all([c1.connect(), c2.connect()]);
    await pool.query(`UPDATE refresh_hooks SET last_used_at = now() - interval '1 hour' WHERE id = $1`, [made.hook.id]);
    const naive = async (c: Client) => {
      const seen = (await c.query<{ due: boolean }>(`SELECT last_used_at <= now() - $2 * interval '1 second' AS due FROM refresh_hooks WHERE id = $1`, [made.hook.id, INTERVAL])).rows[0].due;
      await sleep(100);
      if (seen) await c.query('UPDATE refresh_hooks SET last_used_at = now() WHERE id = $1', [made.hook.id]);
      return seen;
    };
    const both = await Promise.all([naive(c1), naive(c2)]);
    ok('race (NEGATIVE CONTROL): a check-then-act claim on two pools lets BOTH through', both.every(Boolean), both.join());
    await Promise.all([c1.end(), c2.end()]);
    await sleep(INTERVAL * 1000 + 150);

    // ── Coalescing ──────────────────────────────────────────────────────────
    const tA2 = (await call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, datasetId: A })).body.token as string;
    tokens.push(tA2);
    const holder = new Client({ connectionString: scratch.toString() });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`acme:${A}`]);
    const known = jobIds();
    const joined = await fire(podA, tA2);
    ok('coalesce: another pod holds A\'s refresh lock → 202 already_running, nothing queued',
      joined.status === 202 && joined.json?.status === 'already_running' && newJobsFor(known, A) === 0, joined.text);
    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [`acme:${A}`]);
    await holder.end();
    const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
    const real = refresh.refreshDataset;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (refresh as { refreshDataset: typeof real }).refreshDataset = async (...a) => { await gate; return real(...a); };
    await sleep(INTERVAL * 1000 + 150);
    const one = await fire(podA, tA);
    const two = await fire(podB, tA2);
    ok('coalesce: a refresh of A running on this process → the second URL answers already_running', one.json?.status === 'queued' && two.json?.status === 'already_running', `${one.text} ${two.text}`);
    release();
    (refresh as { refreshDataset: typeof real }).refreshDataset = real;
    await until(async () => jobsMod.snapshot().active.length === 0);

    // ── Revoke; revoked and unknown are one answer ──────────────────────────
    const id2 = (await call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: A })).body.hooks.find((h: { prefix: string }) => h.prefix === tA2.slice(0, 13)).id as string;
    ok('revoke: a viewer cannot', (await call(podA, 'vic@acme.test', 'refreshHook:revoke', { projectId: P, id: id2 })).status === 403);
    ok('revoke: naming another project changes nothing', (await call(podA, 'boss@acme.test', 'refreshHook:revoke', { projectId: Q, id: id2 })).body.ok === false);
    ok('revoke: a project editor revokes it; again → ok:false', (await call(podA, 'carol@acme.test', 'refreshHook:revoke', { projectId: P, id: id2 })).body.ok === true
      && (await call(podA, 'carol@acme.test', 'refreshHook:revoke', { projectId: P, id: id2 })).body.ok === false);
    ok('list: the revoked one stays listed, marked', typeof (await call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: A })).body.hooks.find((h: { id: string }) => h.id === id2).revokedAt === 'string');
    const seenSql: string[] = [];
    const proto = pgMod.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const realQuery = proto.query;
    proto.query = function (this: unknown, ...a: unknown[]) {
      const text = typeof a[0] === 'string' ? a[0] : '';
      if (/refresh_hooks|ordinate\.hook/.test(text)) seenSql.push(text.replace(/[0-9a-f]{64}/g, 'H'));
      return realQuery.apply(this, a);
    };
    const shape = async (t: string) => { seenSql.length = 0; const r = await fire(podA, t); return { r, sql: [...seenSql] }; };
    const auditsBefore = (await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log`))[0].n;
    const revoked = await shape(tA2);
    const stranger = store.newHookToken();
    tokens.push(stranger);
    const unknown = await shape(stranger);
    proto.query = realQuery;
    const heads = (r: { headers: Headers }) => [...r.headers.keys()].filter((k) => !['date', 'content-length'].includes(k)).sort().join();
    ok('no oracle: revoked and unknown → the same 404 and body', revoked.r.status === 404 && unknown.r.status === 404 && revoked.r.text === unknown.r.text, `${revoked.r.text} | ${unknown.r.text}`);
    ok('no oracle: …the same headers', heads(revoked.r) === heads(unknown.r), `${heads(revoked.r)} | ${heads(unknown.r)}`);
    ok('no oracle: …the same SQL statements, in order', revoked.sql.length === 3 && revoked.sql.join('\n') === unknown.sql.join('\n'), JSON.stringify([revoked.sql, unknown.sql]));
    ok('no oracle: …and neither leaves an audit row', (await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log`))[0].n === auditsBefore);
    const timing = async (t: string) => { const ms: number[] = []; for (let i = 0; i < 15; i++) { const t0 = performance.now(); await fire(podA, t); ms.push(performance.now() - t0); } return ms.sort((x, y) => x - y)[7]; };
    const [mRevoked, mUnknown] = [await timing(tA2), await timing(stranger)];
    console.log(`  (measured: median of 15 calls — revoked ${mRevoked.toFixed(2)} ms, unknown ${mUnknown.toFixed(2)} ms)`);
    const asAdmin = await fire(podA, tA2, { headers: { 'x-forwarded-email': 'boss@acme.test' } });
    ok('gate: an admin\'s proxy header on a revoked URL changes nothing (404)', asAdmin.status === 404 && asAdmin.text === unknown.r.text);
    const rpcCross = await fetch(`${podA}/api/rpc/refreshHook:list`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-forwarded-email': 'carol@acme.test' }, body: wire.encode({ args: [{ projectId: P, datasetId: A }] }) });
    ok('gate (NEGATIVE CONTROL): the same cross-site call to /api/rpc → 403', rpcCross.status === 403);

    // ── The creator loses access ────────────────────────────────────────────
    const made3 = (await call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, datasetId: B })).body;
    const tB = made3.token as string;
    tokens.push(tB);
    await pool.query(`DELETE FROM project_grants WHERE user_id = $1`, [await uid('carol@acme.test')]);
    const lost = await fire(podA, tB);
    ok('creator: without her grant → 403, B untouched', lost.status === 403 && lost.json?.error === 'forbidden' && (await rowsOf(B)) === 1, lost.text);
    const denied = (await q<{ actor: string; outcome: string; target_ids: string[] }>(`SELECT actor, outcome, target_ids FROM audit_log WHERE action = 'hook_refresh' ORDER BY id DESC LIMIT 1`))[0];
    ok('creator: …a denied hook_refresh row', denied.actor === 'carol@acme.test' && denied.outcome === 'denied' && denied.target_ids.includes(B), JSON.stringify(denied));
    await grant('carol@acme.test', 'editor');
    await pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'carol@acme.test'`);
    await sleep(INTERVAL * 1000 + 150);
    ok('creator: disabled → 403', (await fire(podA, tB)).status === 403);
    await pool.query(`UPDATE users SET disabled_at = NULL WHERE email = 'carol@acme.test'`);
    await sleep(INTERVAL * 1000 + 150);
    const back = await fire(podA, tB);
    ok('creator: enabled with her grant again → 202, and B is refreshed', back.status === 202 && (await until(async () => (await rowsOf(B)) === 2)), back.text);

    // ── A Live dataset: the cache is reset, nothing is fetched ──────────────
    const madeL = (await call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, datasetId: L })).body;
    tokens.push(madeL.token);
    const epoch0 = (await meta(L))?.live?.epoch;
    const knownL = jobIds();
    const bumped = await fire(podB, madeL.token);
    ok('live: a Live dataset\'s URL → 202 {status: cache_reset}', madeL.ok && bumped.status === 202 && bumped.json?.status === 'cache_reset', `${JSON.stringify(madeL.ok)} ${bumped.text}`);
    ok('live: …its epoch moved by one, and no refresh job was queued', epoch0 === 0 && (await meta(L))?.live?.epoch === 1 && newJobsFor(knownL, L) === 0,
      `${epoch0} → ${(await meta(L))?.live?.epoch}`);
    ok('live (NEGATIVE CONTROL): the extract\'s URL queued a refresh and has no epoch', first.json?.status === 'queued' && (await meta(A))?.live === undefined);

    // ── A scheduled refresh leaves a row too ────────────────────────────────
    await asBoss(() => datasets.setAutoRefresh(P, S, { every: 'hourly' }));
    const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
    await context.runInContext({ user: { email: 'jobs@system', role: 'admin' }, org: { id: 'acme' } }, 'job:tick:acme', () => scheduler.tickNow());
    ok('audit: a scheduled refresh → scheduled_refresh, as the jobs identity, with its dataset and outcome', await until(async () =>
      Number((await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'scheduled_refresh' AND actor = 'jobs@system' AND $1 = ANY(target_ids) AND outcome = 'ok' AND project_id = $2`, [S, P]))[0].n) >= 1));
    ok('audit (NEGATIVE CONTROL): no scheduled_refresh row for a dataset with no schedule', (await q<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'scheduled_refresh' AND $1 = ANY(target_ids)`, [B]))[0].n === '0');

    // ── RLS, as an ordinary role ────────────────────────────────────────────
    const pw = randomBytes(12).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await pool.query(`GRANT SELECT, UPDATE ON refresh_hooks TO ${role}`);
    const asRole = new URL(scratch.toString());
    asRole.username = role;
    asRole.password = pw;
    const rc = new Client({ connectionString: asRole.toString() });
    await rc.connect();
    const see = async (setting: string | null, value: string, sql = 'SELECT token_hash FROM refresh_hooks') => {
      await rc.query('BEGIN');
      if (setting) await rc.query('SELECT set_config($1, $2, true)', [setting, value]);
      const r = await rc.query<{ token_hash: string }>(sql);
      await rc.query('COMMIT');
      return r.rows;
    };
    const all = Number((await q<{ n: string }>('SELECT count(*) AS n FROM refresh_hooks'))[0].n);
    ok('rls: as acme the ordinary role sees acme\'s hooks (not vacuous)', (await see('ordinate.org', 'acme')).length === all && all >= 4, all);
    ok('rls: with no setting, nothing', (await see(null, '')).length === 0);
    ok('rls: as another org, nothing', (await see('ordinate.org', 'beta')).length === 0);
    const byHash = await see('ordinate.hook', store.hookHash(tA));
    ok('rls: with a token\'s hash, exactly its own row', byHash.length === 1 && byHash[0].token_hash === store.hookHash(tA));
    ok('rls: with a wrong hash, nothing', (await see('ordinate.hook', store.hookHash(stranger))).length === 0);
    const stampedOthers = await see('ordinate.hook', store.hookHash(tA), 'UPDATE refresh_hooks SET last_used_at = now() RETURNING token_hash');
    ok('rls: with a hash, an UPDATE with no WHERE touches only that row', stampedOthers.length === 1 && stampedOthers[0].token_hash === store.hookHash(tA));
    await rc.end();

    // ── The canary ──────────────────────────────────────────────────────────
    await sleep(100);
    const secretOf = (t: string) => [t, t.slice(13)];
    const inLogs = tokens.filter((t) => secretOf(t).some((s) => log.some((l) => l.includes(s))));
    ok(`canary: ${log.length} trace-level log lines, none holding any of ${tokens.length} tokens`, log.length > 100 && inLogs.length === 0, inLogs.length);
    ok('canary: the request lines show the masked path', log.some((l) => l.includes('/api/hooks/refresh/[redacted]')));
    const dump = (await q<{ j: string }>(`SELECT string_agg(r, '') AS j FROM (
      SELECT row_to_json(h)::text AS r FROM refresh_hooks h UNION ALL SELECT row_to_json(a)::text FROM audit_log a
      UNION ALL SELECT row_to_json(x)::text FROM records x UNION ALL SELECT row_to_json(j)::text FROM jobs j
      UNION ALL SELECT row_to_json(e)::text FROM event_payloads e UNION ALL SELECT row_to_json(t)::text FROM api_tokens t) s`))[0].j;
    ok('canary: no token (nor its secret tail) in refresh_hooks, audit_log, records, jobs, event_payloads or api_tokens', tokens.every((t) => secretOf(t).every((s) => !dump.includes(s))));
    ok(`canary: no token in any of ${replies.length} replies but its own create`, replies.length > 40 && tokens.every((t) => !replies.some((r) => r.includes(t.slice(5)))));
  } finally {
    for (const app of apps) await app.close().catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
