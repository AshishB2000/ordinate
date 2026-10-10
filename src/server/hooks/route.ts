// /api/hooks/refresh/<token> — a refresh URL (live data L0.5) for a dbt run or
// an Airflow DAG: POST it when new data has landed; GET it to learn how that
// call ended.
//
// IT AUTHORISES ITSELF, as /p/ does (../published.ts): the token in the path
// is the whole credential. No session, cookie or proxy header is looked up
// (app.ts: `routeAccess` answers 'self', and its gate skips the route); CSRF
// exempts it (a cross-site page holds no ambient credential here — it would
// need the token); the sign-in limit's numbers bound it per client IP
// (../limits.ts).
//
// What a POST can do is exactly one thing: refresh the hook's dataset (or, on
// a Live dataset, reset its cache — ./act.ts). A CONNECTION's URL does that to
// every dataset that came from the connection. The answers:
//
//   202 {status}   'queued' | 'already_running' (a refresh of it was running
//                  here or on another pod; this call joined it) | 'cache_reset'
//                  (a Live dataset: its cache was reset; nothing to fetch).
//                  A connection's URL adds `datasets`: how many of each — and
//                  its `status` is the first of the three that any dataset got
//   404            unknown OR revoked token — one answer, one shape (./store.ts)
//   429            called again inside REFRESH_HOOK_MIN_INTERVAL_SEC (Retry-After)
//   403            the hook's creator can no longer refresh it: disabled,
//                  removed, or without write on the project any more
//   404 dataset    its dataset is gone (in the Trash, or deleted); a
//                  connection's URL: no dataset comes from the connection
//
// A GET is a read, not a call: it claims nothing, is never a 429 of the
// interval, leaves no audit row and starts nothing. 200 {status, calledAt,
// finishedAt} — how the LAST POST ended:
//
//   idle             no call's outcome is known (never called)
//   running          what it started has not all landed yet
//   ok               all of it landed (a cache reset: at once)
//   failed           a refresh it started failed, or the call was refused. The
//                    reason is NOT here — it can quote the source — but on the
//                    dataset, for the people who may open it
//   already_running  it joined a refresh somebody else started and started
//                    nothing: POST again for a refresh that begins now. (It
//                    joined one this URL's own earlier call started? Then it
//                    stays `running`, and that refresh's end is the answer.)
//
// with the POST's 404 and 403. The result is written by the pod that ran the
// refreshes (./store.ts beginHook, settleHook), so any pod can answer.
//
// AS WHOM. The refresh runs as the hook's CREATOR, with their current role,
// in a request context for the hook's org (ctx(), orgKey(), the org's DuckDB
// worker), checked by the same rule the ↻ button's channel is
// (`dataset:refresh`, write). A hook is a credential a person minted, like a
// personal token — so it is never worth more than that person is now, and
// the refresh job shows in their Jobs list. (A scheduled refresh is the
// dataset's own setting and belongs to nobody: it runs as `jobs@system`.)
// Under AUTH_MODE=dev everyone is the dev admin, so is the creator.
//
// THE TOKEN NEVER REACHES A LOG. The request logger masks the path after
// /api/hooks/refresh/ (app.ts), every log message is masked for `ordh_…`, and
// the route matches every method and every deeper path, so no "route not
// found" line can carry one.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { authorize } from '../authz/index';
import { audit, type Outcome } from '../authz/audit';
import { runInContext, type Identity, type Role } from '../context';
import { scrubbed } from '../db/pool';
import { beginHook, claimHook, HOOK_ROUTE, isHookToken, PENDING_STALE_SEC, readHook, settleHook, type ClaimedHook, type HookResult, type HookState } from './store';
import { runHookAction, targetDatasets, type HookStatus } from './act';

export { HOOK_ROUTE };
const HOOK_PATH = /^(\/api\/hooks\/refresh\/)[^?#]*/;
const TOKEN_ANYWHERE = /ordh_[A-Za-z0-9_-]+/g;
/** The body is ignored (dbt and Airflow send JSON, curl -d sends a form); this caps what is read of it. */
const BODY_MAX = 64 * 1024;

/** `s` with any refresh-URL token in it masked — for a message string. */
export function maskHookTokens(s: string): string {
  return s.replace(TOKEN_ANYWHERE, 'ordh_[redacted]');
}

/** A request URL with the refresh URL's credential masked — what the request logger writes. */
export function maskHookUrl(url: string): string {
  return maskHookTokens(url.replace(HOOK_PATH, '$1[redacted]'));
}

export interface HookRouteOptions {
  readonly pool: () => Pool | null;
  readonly minIntervalSec: number;
  /** AUTH_MODE=dev: every caller is the dev admin, the creator included. */
  readonly devAuth: boolean;
  readonly dbUrl: string;
}

const UNKNOWN = { error: 'unknown refresh URL' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;
type Hook = Pick<ClaimedHook, 'orgId' | 'projectId' | 'target' | 'createdBy'>;

/** The creator as the identity the refresh runs as — their CURRENT org role — or null when they are not an enabled member. */
async function creator(pool: Pool, hook: Hook, devAuth: boolean): Promise<Identity | null> {
  if (devAuth) return { user: { email: hook.createdBy, role: 'admin' }, org: { id: hook.orgId } };
  const r = await pool.query<{ role: Role }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [hook.orgId, hook.createdBy]);
  return r.rows[0] ? { user: { email: hook.createdBy, role: r.rows[0].role }, org: { id: hook.orgId } } : null;
}

/** May the creator still refresh in the hook's project? `dataset:refresh` is scoped by its project alone, so one check covers every dataset of a connection's URL. */
async function mayRefresh(pool: Pool, hook: Hook, who: Identity): Promise<boolean> {
  const refresh = contractFor('dataset:refresh');
  return !!refresh && (await authorize(refresh, { projectId: hook.projectId }, who, pool)).ok;
}

/** How many of the hook's datasets got each answer. */
type Counts = Record<HookStatus, number>;
/** `ends`: one per dataset, resolved when its part of the call is over. */
type Fired = { code: 202; status: HookStatus; datasets?: Counts; ends: Promise<HookResult>[] } | { code: 403 | 404; error: string; outcome: Outcome };
const GONE: Fired = { code: 404, error: 'dataset not found', outcome: 'error' };

/** A call's outcome from its datasets': any failed → failed; else any joined → already_running (call again to refresh those); else ok. */
const worst = (rs: readonly HookResult[]): HookResult => (rs.includes('failed') ? 'failed' : rs.includes('already_running') ? 'already_running' : 'ok');

/** Inside the hook's request context: may the creator refresh it, does it exist — then do it. */
async function fire(pool: Pool, hook: ClaimedHook, who: Identity): Promise<Fired> {
  if (!(await mayRefresh(pool, hook, who))) return { code: 403, error: 'forbidden', outcome: 'denied' };
  const datasets = require('../../data/datasets') as typeof import('../../data/datasets');
  const counts: Counts = { queued: 0, already_running: 0, cache_reset: 0 };
  const ends: Promise<HookResult>[] = [];
  // ponytail: every copy is queued at once and the jobs run three at a time per pod (src/app/jobs.ts); chunk the calls if one connection ever feeds hundreds of datasets.
  for (const id of await targetDatasets(hook.projectId, hook.target)) {
    const meta = await datasets.getDatasetMeta(hook.projectId, id);
    if (!meta) continue;
    const started = await runHookAction(hook.projectId, id, meta);
    if (started.status === 'gone') continue;
    counts[started.status]++;
    ends.push(started.end);
  }
  const status = (['queued', 'already_running', 'cache_reset'] as const).find((k) => counts[k] > 0);
  if (!status) return GONE;
  return 'connId' in hook.target ? { code: 202, status, datasets: counts, ends } : { code: 202, status, ends };
}

/** Inside the hook's request context: how its last call ended — or null when its creator may no longer refresh it. */
async function outcome(pool: Pool, hook: HookState, who: Identity): Promise<{ status: HookResult | 'idle' | 'running'; calledAt?: string; finishedAt?: string } | null> {
  if (!(await mayRefresh(pool, hook, who))) return null;
  // No outcome was ever recorded: never called, or called by a release that kept none.
  if (!hook.calledAt || !hook.result) return { status: 'idle' };
  // An outcome older than the last call is not that call's: its pod died before recording any. Unsettled, like `running`.
  if (hook.result !== 'running' && !hook.settledBeforeCall) return { status: hook.result, calledAt: hook.calledAt, finishedAt: hook.finishedAt ?? hook.calledAt };
  if (hook.ageSec > PENDING_STALE_SEC) {
    // Nobody settled it in all this time. Still refreshing, on any pod? Then it is only slow.
    // Otherwise the pod that ran it is gone, and so is whatever it had not finished.
    // ponytail: a job still QUEUED on another pod holds no lock and reads as failed here; settle from the jobs table if refreshes ever wait this long for a slot.
    const refreshJob = require('../../data/refreshJob') as typeof import('../../data/refreshJob');
    let running = false;
    for (const id of await targetDatasets(hook.projectId, hook.target)) {
      running = (await refreshJob.refreshRunning(hook.projectId, id)) !== null;
      if (running) break;
    }
    if (!running) return { status: 'failed', calledAt: hook.calledAt };
  }
  return { status: 'running', calledAt: hook.calledAt };
}

export function registerRefreshHookRoute(app: FastifyInstance, o: HookRouteOptions): void {
  // Its own plugin, so the catch-all body parser is this route's only.
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_req, _body, done) => done(null, undefined));

    hooks.all(HOOK_ROUTE, { bodyLimit: BODY_MAX }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.method !== 'POST' && req.method !== 'GET') return reply.code(405).header('allow', 'GET, POST').send({ error: 'use POST' });
      const pool = o.pool();
      const token = (req.params as { '*'?: string })['*'];
      // No database, no hooks: there is nothing a token could name.
      if (!pool || !isHookToken(token)) return reply.code(404).send(UNKNOWN);
      const requestId = String(req.id);

      if (req.method === 'GET') {
        const state = await readHook(pool, token);
        if (!state) return reply.code(404).send(UNKNOWN);
        const reader = await creator(pool, state, o.devAuth);
        const answer = reader && (await runInContext(reader, requestId, () => outcome(pool, state, reader)));
        return answer ? reply.send(answer) : reply.code(403).send(FORBIDDEN);
      }

      const claim = await claimHook(pool, token, o.minIntervalSec);
      if (claim.kind === 'unknown') return reply.code(404).send(UNKNOWN);
      if (claim.kind === 'too_soon') {
        return reply.code(429).header('retry-after', claim.retryAfterSec).send({ error: 'too soon', retryAfter: claim.retryAfterSec });
      }
      const hook = claim.hook;
      const who = await creator(pool, hook, o.devAuth);
      const fired: Fired = who
        ? await runInContext(who, requestId, () => fire(pool, hook, who))
        : { code: 403, error: 'forbidden', outcome: 'denied' };
      // Who: the identity it ran as. Ids: the hook and its dataset or connection — never the token, nor its prefix.
      await audit(pool, {
        org: hook.orgId, actor: hook.createdBy, action: 'hook_refresh', projectId: hook.projectId,
        targets: [hook.id, 'connId' in hook.target ? hook.target.connId : hook.target.datasetId], outcome: fired.code === 202 ? 'ok' : fired.outcome, requestId,
      }).catch((err: unknown) => req.log.error({ err: scrubbed(err, o.dbUrl) }, 'audit write failed'));

      // How the call ended, for a GET on any pod (./store.ts settleHook). A write that fails leaves the hook as it
      // was, which reads `running` and then meets the stale rule — all there is to do, too, when the pod is shutting
      // down under a refresh (its pool is ending).
      const unrecorded = (err: unknown) => {
        if (!pool.ending) req.log.error({ err: scrubbed(err, o.dbUrl) }, 'refresh URL outcome not recorded');
      };
      if (fired.code !== 202) {
        await settleHook(pool, hook, 'failed', 'at once').catch(unrecorded);
        return reply.code(fired.code).send({ error: fired.error });
      }
      if (fired.status === 'queued') {
        // `running` before the answer, so a GET right behind it says so; the refreshes it queued end it.
        await beginHook(pool, hook).catch(unrecorded);
        void Promise.all(fired.ends).then((results) => settleHook(pool, hook, worst(results), 'landed').catch(unrecorded));
      } else {
        // Nothing queued: all of it is over already.
        await settleHook(pool, hook, worst(await Promise.all(fired.ends)), 'at once').catch(unrecorded);
      }
      return reply.code(202).send(fired.datasets ? { status: fired.status, datasets: fired.datasets } : { status: fired.status });
    });
  });
}
