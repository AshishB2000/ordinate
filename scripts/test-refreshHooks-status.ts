// How a refresh URL's last call ENDED: `GET /api/hooks/refresh/<token>`, so a
// pipeline that POSTed can wait for the refresh and fail its own run when the
// refresh failed. Real Postgres, real HTTP, two pods (scripts/hookHarness.ts).
//
//   idle       never called → {status: idle}
//   running    POSTed on one pod, asked on the OTHER while the source is still
//              answering → running, with calledAt
//   ok         … then ok, with finishedAt, once the rows have landed
//   failed     the source fails → failed; the reply is three keys and never
//              the reason (which can quote the source) — a canary in the
//              source's error is in no GET reply
//   joined     a call that found SOMEBODY ELSE's refresh running started
//              nothing → already_running, at once
//   own        a second POST that joins the refresh this URL's first POST
//              started stays running, and ends as that refresh does
//   unknown    no outcome on record → idle; an outcome recorded before the
//              last call is not that call's → running, never a stale ok
//   live       a Live dataset's cache reset is done when the POST is answered
//              → ok
//   connection every dataset must land: one failing → failed; all → ok
//   a read     GET is not a call: it is never a 429, moves no "last called",
//              leaves no audit row, and starts nothing
//   gate       unknown and revoked → the POST's 404, byte for byte; a creator
//              without her grant → 403; other methods → 405
//   stale      a call nobody settled (its pod died mid-refresh) reads failed
//              once it is older than PENDING_STALE_SEC. NEGATIVE CONTROL: the
//              same row while a refresh of the dataset holds the lock is
//              still running
//   the list   the panel's rows carry lastResult and lastFinishedAt
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-refreshHooks-status.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { sleep, until, withHookPods, type Hit } from './hookHarness';
import { Client } from 'pg';

const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const store: typeof import('../src/server/hooks/store') = require('../src/server/hooks/store');
const lock: typeof import('../src/server/jobs/refreshLock') = require('../src/server/jobs/refreshLock');

const CANARY = 'db-7f3a.internal.example:5432';
// The source: per table, how long it takes and whether it fails.
const src = { delayMs: 0, failing: new Set<string>(), asked: [] as string[] };
connectionRun.runConnection = (async (_c: unknown, _v: unknown, _s: unknown, sel: { table?: string }) => {
  const table = sel.table ?? '?';
  src.asked.push(table);
  await sleep(src.delayMs);
  if (src.failing.has(table)) return { ok: false, error: `could not connect to ${CANARY}` };
  return { ok: true, truncated: false, result: { columns: [{ name: 'region', type: 'text' }], rows: [['north'], ['south'], ['east']], rowCount: 3, warnings: [] } };
}) as unknown as typeof connectionRun.runConnection;

withHookPods('a refresh URL\'s outcome', async (h) => {
  const { podA, podB, P } = h;
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const cols = [{ name: 'region', type: 'text' as const }];
  const fx = await h.asBoss(async () => {
    const values = { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' };
    const conn = async (name: string) => (await conns.saveConnection(P, { name, connectorId: 'postgres', values }))!.id;
    const [K, K2] = [await conn('Warehouse'), await conn('Lake')];
    const copy = async (connId: string, table: string) => (await datasets.saveDataset(P, { name: table, sourceKind: 'postgres', columns: cols, rows: [['old']], origin: { kind: 'connection', connId, table } }))!.id;
    return {
      K, K2, A: await copy(K, 'a'), B: await copy(K, 'b'), F: await copy(K2, 'f'), S: await copy(K2, 's'), R: await copy(K2, 'r'),
      L: (await liveRecord.saveLiveRecord(P, { name: 'Orders live', columns: cols, origin: { kind: 'connection', connId: K2, table: 'orders' } }))!.id,
    };
  });
  const rowsOf = async (id: string) => (await h.asBoss(() => datasets.getDatasetMeta(P, id)))?.rowCount;
  const make = async (target: { datasetId: string } | { connId: string }) => (await h.call(podA, 'carol@acme.test', 'refreshHook:create', { projectId: P, ...target })).body as { token: string; hook: { id: string } };
  const gets: Hit[] = [];
  const peek = async (at: string, token: string) => { const r = await h.hit(at, token, 'GET'); gets.push(r); return r; };
  const settles = (token: string, status: string) => until(async () => (await peek(podB, token)).json?.status === status);

  // ── Idle, running, ok ─────────────────────────────────────────────────────
  const a = await make({ datasetId: fx.A });
  const idle = await peek(podA, a.token);
  ok('idle: never called → 200 {status: idle}, nothing else', idle.status === 200 && JSON.stringify(idle.json) === '{"status":"idle"}', `${idle.status} ${idle.text}`);
  src.delayMs = 700;
  const posted = await h.hit(podA, a.token);
  const during = await peek(podB, a.token);
  ok('running: POSTed on one pod, asked on the OTHER while the source answers → running, with calledAt', posted.json?.status === 'queued'
    && during.status === 200 && during.json?.status === 'running' && !Number.isNaN(Date.parse(during.json.calledAt)) && !('finishedAt' in during.json), during.text);
  ok('ok: … then ok once the rows have landed (1 → 3)', (await settles(a.token, 'ok')) && (await rowsOf(fx.A)) === 3);
  const done = (await peek(podA, a.token)).json;
  ok('ok: calledAt ≤ finishedAt, and no other key', Object.keys(done).sort().join() === 'calledAt,finishedAt,status' && Date.parse(done.calledAt) <= Date.parse(done.finishedAt), JSON.stringify(done));
  src.delayMs = 0;

  // ── A read, not a call ────────────────────────────────────────────────────
  const audits = async () => Number((await h.q<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'hook_refresh'`))[0].n);
  const [auditsBefore, askedBefore] = [await audits(), src.asked.length];
  const stamp = async () => (await h.q<{ t: string }>(`SELECT last_used_at::text AS t FROM refresh_hooks WHERE id = $1`, [a.hook.id]))[0].t;
  const stampBefore = await stamp();
  const reads = [await peek(podA, a.token), await peek(podB, a.token), await peek(podA, a.token)];
  ok('a read: three GETs inside the interval are all 200 (never a 429)', reads.every((r) => r.status === 200), reads.map((r) => r.status).join());
  ok('a read: …and move no "last called", leave no audit row, start nothing', (await stamp()) === stampBefore && (await audits()) === auditsBefore && src.asked.length === askedBefore);

  // ── Failed, without the reason ────────────────────────────────────────────
  const f = await make({ datasetId: fx.F });
  src.failing.add('f');
  await h.hit(podA, f.token);
  ok('failed: the source fails → failed, with finishedAt', await settles(f.token, 'failed'));
  const failed = (await peek(podA, f.token)).json;
  ok('failed: three keys — never the reason', Object.keys(failed).sort().join() === 'calledAt,finishedAt,status', JSON.stringify(failed));
  ok('failed: the dataset kept its row and recorded why (for the app, not the URL)', (await rowsOf(fx.F)) === 1
    && String((await h.asBoss(() => datasets.getDatasetMeta(P, fx.F)))?.lastRefreshError).includes(CANARY));

  // ── Joined, and Live ──────────────────────────────────────────────────────
  const s = await make({ datasetId: fx.S });
  const other = new Client({ connectionString: h.dbUrl });
  await other.connect();
  await other.query('SELECT pg_advisory_lock(hashtext($1))', [lock.lockKey('acme', fx.S)]);
  const joined = await h.hit(podA, s.token);
  const afterJoin = await peek(podB, s.token);
  ok('joined: a refresh was already running → the POST and the GET both say already_running', joined.json?.status === 'already_running'
    && afterJoin.json?.status === 'already_running' && typeof afterJoin.json.finishedAt === 'string', `${joined.text} ${afterJoin.text}`);
  const l = await make({ datasetId: fx.L });
  const reset = await h.hit(podA, l.token);
  ok('live: a cache reset is done when the POST is answered → ok at once', reset.json?.status === 'cache_reset' && (await peek(podB, l.token)).json?.status === 'ok', reset.text);

  // ── Its own refresh, joined: the same pipeline POSTing again ──────────────
  const r = await make({ datasetId: fx.R });
  src.delayMs = 3200; // longer than the interval: the second POST finds the first one's refresh still running
  await h.hit(podA, r.token);
  await h.rest();
  const retry = await h.hit(podB, r.token);
  ok('own: a second POST joins the refresh this URL\'s first POST started → already_running, yet the GET stays running', retry.json?.status === 'already_running'
    && (await peek(podA, r.token)).json?.status === 'running', retry.text);
  ok('own: …and ends ok when that refresh lands (NEGATIVE CONTROL: "joined" above — somebody else\'s refresh — is already_running)', (await settles(r.token, 'ok')) && (await rowsOf(fx.R)) === 3);
  src.delayMs = 0;

  // ── No outcome on record, and one older than the call ─────────────────────
  await h.pool.query(`UPDATE refresh_hooks SET last_result = NULL, last_finished_at = NULL WHERE id = $1`, [r.hook.id]);
  ok('unknown: called by a release that kept no outcome → idle, not a made-up result', JSON.stringify((await peek(podA, r.token)).json) === '{"status":"idle"}');
  await h.pool.query(`UPDATE refresh_hooks SET last_result = 'ok', last_finished_at = last_used_at - interval '1 hour' WHERE id = $1`, [r.hook.id]);
  ok('unknown: an ok recorded BEFORE the last call is not that call\'s → running, never ok', (await peek(podA, r.token)).json?.status === 'running');

  // ── Stale: a call nobody settled ──────────────────────────────────────────
  await h.pool.query(`UPDATE refresh_hooks SET last_used_at = now() - $2 * interval '1 second', last_result = 'running', last_finished_at = NULL WHERE id = $1`, [s.hook.id, store.PENDING_STALE_SEC + 5]);
  ok('stale (NEGATIVE CONTROL): unsettled and old, but a refresh of the dataset holds the lock → still running', (await peek(podA, s.token)).json?.status === 'running');
  await other.query('SELECT pg_advisory_unlock(hashtext($1))', [lock.lockKey('acme', fx.S)]);
  await other.end();
  const stale = (await peek(podA, s.token)).json;
  ok('stale: unsettled, old, and nothing running anywhere → failed (its pod died mid-refresh)', stale.status === 'failed' && !('finishedAt' in stale), JSON.stringify(stale));
  await h.pool.query(`UPDATE refresh_hooks SET last_used_at = now() - interval '5 second' WHERE id = $1`, [s.hook.id]);
  ok('stale (NEGATIVE CONTROL): the same unsettled row five seconds old is running', (await peek(podA, s.token)).json?.status === 'running');

  // ── A connection: every dataset must land ─────────────────────────────────
  const k = await make({ connId: fx.K });
  src.failing.add('b');
  await h.hit(podA, k.token);
  ok('connection: one of its two datasets fails → failed', await settles(k.token, 'failed'));
  ok('connection: …the other one still landed (3 rows)', (await rowsOf(fx.A)) === 3 && (await rowsOf(fx.B)) === 1);
  src.failing.delete('b');
  await h.rest();
  src.delayMs = 400;
  await h.hit(podA, k.token);
  ok('connection: running while its datasets refresh', (await peek(podB, k.token)).json?.status === 'running');
  ok('connection: both land → ok', (await settles(k.token, 'ok')) && (await rowsOf(fx.B)) === 3);
  src.delayMs = 0;

  // ── The list ──────────────────────────────────────────────────────────────
  const listed = (await h.call(podA, 'carol@acme.test', 'refreshHook:list', { projectId: P, datasetId: fx.F })).body.hooks[0];
  ok('the list: a row carries lastResult and lastFinishedAt — and still no hash or token', listed.lastResult === 'failed' && typeof listed.lastFinishedAt === 'string'
    && Object.keys(listed).sort().join() === 'createdAt,createdBy,id,lastFinishedAt,lastResult,lastUsedAt,prefix,revokedAt', JSON.stringify(listed));

  // ── The gate ──────────────────────────────────────────────────────────────
  const stranger = store.newHookToken();
  const [unknownGet, unknownPost] = [await peek(podA, stranger), await h.hit(podA, stranger)];
  ok('gate: an unknown token → the POST\'s 404, byte for byte', unknownGet.status === 404 && unknownGet.text === unknownPost.text, unknownGet.text);
  await h.call(podA, 'carol@acme.test', 'refreshHook:revoke', { projectId: P, id: l.hook.id });
  const revoked = await peek(podA, l.token);
  ok('gate: a revoked URL → the same 404', revoked.status === 404 && revoked.text === unknownGet.text, revoked.text);
  const put = await fetch(`${podA}/api/hooks/refresh/${a.token}`, { method: 'PUT' });
  ok('gate: another method → 405, Allow: GET, POST', put.status === 405 && put.headers.get('allow') === 'GET, POST', `${put.status} ${put.headers.get('allow')}`);
  await h.pool.query(`DELETE FROM project_grants WHERE user_id = (SELECT id FROM users WHERE email = 'carol@acme.test')`);
  const lost = await peek(podA, a.token);
  ok('gate: a creator without her grant → 403', lost.status === 403 && lost.json?.error === 'forbidden', `${lost.status} ${lost.text}`);

  ok(`canary: the source's error is in none of ${gets.length} GET replies`, gets.length > 20 && gets.every((r) => !r.text.includes(CANARY) && !r.text.includes('internal')));
})
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
