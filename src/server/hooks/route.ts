// POST /api/hooks/refresh/<token> — a refresh URL (live data L0.5) for a dbt
// run or an Airflow DAG to call when new data has landed.
//
// IT AUTHORISES ITSELF, as /p/ does (../published.ts): the token in the path
// is the whole credential. No session, cookie or proxy header is looked up
// (app.ts's gate skips the route, ./routeAccess 'self'); CSRF exempts it (a
// cross-site page holds no ambient credential here — it would need the token);
// the sign-in limit's numbers bound it per client IP (../limits.ts).
//
// What a call can do is exactly one thing: refresh the hook's dataset (or, on
// a Live dataset, reset its cache — ./act.ts). The answers:
//
//   202 {status}   'queued' | 'already_running' (a refresh of it was running
//                  here or on another pod; this call joined it) | 'cache_reset'
//                  (a Live dataset: its cache was reset; nothing to fetch)
//   404            unknown OR revoked token — one answer, one shape (./store.ts)
//   429            called again inside REFRESH_HOOK_MIN_INTERVAL_SEC (Retry-After)
//   403            the hook's creator can no longer refresh it: disabled,
//                  removed, or without write on the project any more
//   404 dataset    its dataset is gone (in the Trash, or deleted)
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
import { claimHook, HOOK_ROUTE, isHookToken, type ClaimedHook } from './store';
import { runHookAction, type HookStatus } from './act';

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

/** The creator as the identity the refresh runs as — their CURRENT org role — or null when they are not an enabled member. */
async function creator(pool: Pool, hook: ClaimedHook, devAuth: boolean): Promise<Identity | null> {
  if (devAuth) return { user: { email: hook.createdBy, role: 'admin' }, org: { id: hook.orgId } };
  const r = await pool.query<{ role: Role }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [hook.orgId, hook.createdBy]);
  return r.rows[0] ? { user: { email: hook.createdBy, role: r.rows[0].role }, org: { id: hook.orgId } } : null;
}

type Fired = { code: 202; status: HookStatus } | { code: 403 | 404; error: string; outcome: Outcome };

/** Inside the hook's request context: may the creator refresh it, does it exist — then do it. */
async function fire(pool: Pool, hook: ClaimedHook, who: Identity): Promise<Fired> {
  const refresh = contractFor('dataset:refresh');
  const input = { projectId: hook.projectId, id: hook.datasetId };
  if (!refresh || !(await authorize(refresh, input, who, pool)).ok) return { code: 403, error: 'forbidden', outcome: 'denied' };
  const datasets = require('../../data/datasets') as typeof import('../../data/datasets');
  const meta = await datasets.getDatasetMeta(hook.projectId, hook.datasetId);
  if (!meta) return { code: 404, error: 'dataset not found', outcome: 'error' };
  const status = await runHookAction(hook.projectId, hook.datasetId, meta);
  return status === 'gone' ? { code: 404, error: 'dataset not found', outcome: 'error' } : { code: 202, status };
}

export function registerRefreshHookRoute(app: FastifyInstance, o: HookRouteOptions): void {
  // Its own plugin, so the catch-all body parser is this route's only.
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_req, _body, done) => done(null, undefined));

    hooks.all(HOOK_ROUTE, { bodyLimit: BODY_MAX }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send({ error: 'use POST' });
      const pool = o.pool();
      const token = (req.params as { '*'?: string })['*'];
      // No database, no hooks: there is nothing a token could name.
      if (!pool || !isHookToken(token)) return reply.code(404).send(UNKNOWN);

      const claim = await claimHook(pool, token, o.minIntervalSec);
      if (claim.kind === 'unknown') return reply.code(404).send(UNKNOWN);
      if (claim.kind === 'too_soon') {
        return reply.code(429).header('retry-after', claim.retryAfterSec).send({ error: 'too soon', retryAfter: claim.retryAfterSec });
      }
      const hook = claim.hook;
      const who = await creator(pool, hook, o.devAuth);
      const requestId = String(req.id);
      const fired: Fired = who
        ? await runInContext(who, requestId, () => fire(pool, hook, who))
        : { code: 403, error: 'forbidden', outcome: 'denied' };
      // Who: the identity it ran as. Ids: the hook and its dataset — never the token, nor its prefix.
      await audit(pool, {
        org: hook.orgId, actor: hook.createdBy, action: 'hook_refresh', projectId: hook.projectId,
        targets: [hook.id, hook.datasetId], outcome: fired.code === 202 ? 'ok' : fired.outcome, requestId,
      }).catch((err: unknown) => req.log.error({ err: scrubbed(err, o.dbUrl) }, 'audit write failed'));
      if (fired.code === 202) return reply.code(202).send({ status: fired.status });
      return reply.code(fired.code).send({ error: fired.error });
    });
  });
}
