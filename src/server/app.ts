// The Fastify app factory. Builds routes and the logger; never listens —
// `main.ts` does that, and tests drive the app through `inject()`.
//
// The server runs in a plain Node pod; scripts/test-server-boot.ts spawns it the
// same way, so a module in this graph that cannot load there breaks the build's
// tests, not a deploy.

import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { probe, shutdown as duckShutdown } from '../engine/duckdb';
import { contractFor } from '../api/index';
import { proxyList, type ServerEnv } from './env';
import { ctx, runInContext, type Identify } from './context';
import { authorize, grantCreator, orgAllows, readable } from './authz/index';
import { audit, targetIds, type Outcome } from './authz/audit';
import { registerAuth } from './auth/index';
import { isIdpManaged } from './auth/idpGroups';
import { hashId } from './auth/store';
import { cookieNames } from './auth/cookies';
import { registerSecurityHeaders } from './headers';
import { registerCsrf } from './csrf';
import { registerLimits, RPC_ROUTE, RpcTimeout, untilAborted } from './limits';
import { isDraining, isRestarting, trackRequest } from './lifecycle';
import { useLogger } from '../app/logger';
import { migrate } from './db/migrate';
import { createPool, ping, scrubbed } from './db/pool';
import { useRecordDb } from '../app/recordFs';
import { useOrgDb } from './db/inOrg';
import { useBlobDb } from '../app/blobStore';
import { useMaskSaltStore } from '../app/privacyStore';
import { useSecretStore } from '../app/configSecrets';
import { createSecretStore } from './secrets/store';
import { useAiKeys } from './aiKeys';
import * as orgConfig from './orgConfig';
import { useRefreshLockDb } from './jobs/refreshLock';
import { useLiveUsageDb } from './live/usageStore';
import { handlers } from './rpc';
import { maskFileToken, registerFileRoutes } from './files';
import { clientFor, registerEvents } from './sse';
import { fromWire, encode } from './wire';
import { registerStatic, WEB_DIST } from './static';
import { uploadCapMb } from './admin/org';
import { registerMcpRoute } from '../automation/serverMcp';
import { registerGeoRoutes } from './geo';
import { registerRequestMetrics, watchPgPool } from './metrics';
import { registerPublishedRoutes } from './published';
import { maskEmbedTokens, maskEmbedUrl, registerEmbedRoutes } from './embed/route';
import { useEmbedDb } from './embed/settings';
import { isLiveDatasetError, LIVE_DATASET_CODE, liveRefusalsRaised, tagLiveRefusals } from '../data/liveDataset';
import { isLiveFigureError } from '../engine/live/liveFigureError';
import { isRowPolicyError, ROW_POLICY_CODE, rowPolicyRaised, tagRowPolicyRefusals } from '../data/rowAccess';
import { seedRank, register as registerCaller } from './authz/caller';
import { isRecordChanged } from '../app/editConflict';
import { HOOK_ROUTE, maskHookTokens, maskHookUrl, registerRefreshHookRoute } from './hooks/route';
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';

/** The `event` a handler receives over HTTP. It has no `sender`: handlers ask `senderOf(e)` (./context). */
const SERVER_EVENT = Object.freeze({});

/** Field names whose values never reach a log line, matched at any depth below. */
const SECRET_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'password',
  'token',
  'secret',
  'key',
  // T3.4: a personal API token under the names a handler would give it.
  'apiToken',
  'api_token',
  'accessToken',
  'bearer',
  // A Slack / Teams channel's webhook URL (src/app/channels.ts): whoever has it can post there.
  'webhookUrl',
  'webhook',
];

// ponytail: pino matches exact names at fixed depths (`*.k` is ONE level), so
// each key is listed at depths 0–4 — enough for `req.headers.x` and a nested
// config object. Deeper secrets need a deeper list, or a walking serializer.
const MAX_DEPTH = 4;
export const REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((k) => {
  const leaf = /^[a-z]+$/.test(k) ? k : `["${k}"]`;
  return Array.from({ length: MAX_DEPTH + 1 }, (_, d) => '*.'.repeat(d) + leaf);
});

// ponytail: one pool per process (a pod builds one app); the sharing handlers
// registered once by registerHandlers() read it per call. Tests building two
// apps in one process must point both at the same database (and env).
// How often each org's S3 garbage pass runs (T5.2). An unreferenced version
// goes at the first pass a grace period after a pass first saw it unreferenced.
const STORAGE_GC_EVERY_MS = 15 * 60_000;
let dbPool: Pool | null = null;
let appEnv: ServerEnv | null = null;
/** The scheduled-job runner, the cross-pod bus and the stream sweep, once started: ./shutdown.ts stops them in its own order. */
let bg: { runner: { stop(): Promise<void> } | null; bus: { stop(): Promise<void> } | null; sweep: { stop(): void } | null } = { runner: null, bus: null, sweep: null };

/** The runner, bus and stream sweep of the app built last (./shutdown.ts). */
export function background(): typeof bg {
  return bg;
}

/** The Postgres pool of the app built last, or null without DATABASE_URL (./shutdown.ts ends it, last). Never nulled: a null pool reads as no database. */
export function appPool(): Pool | null {
  return dbPool;
}

/**
 * The org role a non-RPC /api/ route needs: uploading stages data (write); the
 * event stream is for any member. `self`: the route authorises itself and no
 * sign-in is looked up — a refresh URL, whose token in the path is its whole
 * credential (./hooks/route.ts).
 */
function routeAccess(method: string, route: string | undefined): 'read' | 'write' | 'self' | null {
  if (route === HOOK_ROUTE) return 'self';
  if (method === 'POST' && route === '/api/files') return 'write';
  if (route === '/api/files/:token' || route === '/api/events') return 'read';
  return null;
}

const NOT_PAGES = new Set(['/healthz', '/readyz', '/sign-in', '/metrics']);
const CHANGE_PASSWORD = '/change-password';

/** A browser opening an app route — not a file (`.js`, `.svg`), a probe or the sign-in page. */
function isPageNavigation(method: string, path: string, accept: string | undefined): boolean {
  return method === 'GET' && (accept ?? '').includes('text/html') && !NOT_PAGES.has(path) && !/\.[A-Za-z0-9]+$/.test(path);
}

/**
 * `identify` replaces the AUTH_MODE's own (tests). Without it, dev mode is the
 * dev admin and password/oidc/header resolve through ./auth/ against Postgres.
 */
export function buildApp(cfg: ServerEnv, logStream?: NodeJS.WritableStream, identifyOverride?: Identify): FastifyInstance {
  const app = fastify({
    // Every JSON body (RPC above all) — files have their own cap (MAX_UPLOAD_MB, ./files.ts). Over → 413.
    bodyLimit: cfg.limits.jsonBodyBytes,
    logger: {
      level: cfg.logLevel,
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
      // Fastify's own request serializer, with two cuts: the query string is
      // dropped (the OIDC callback's carries an authorization code and state,
      // and a query is where a future token would go too), and a token in the
      // path — a file token (GET /api/files/<token>), a refresh URL's
      // (POST /api/hooks/refresh/<token>) — is masked: the URL is a credential there.
      serializers: {
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: maskEmbedUrl(maskHookUrl(maskFileToken(req.url.split('?')[0]))),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
      // And in every message: Fastify writes "Route POST:<url> not found" as
      // text, which no serializer sees — a refresh URL's token never gets there.
      hooks: {
        logMethod(args, method) {
          return method.apply(this, args.map((a: unknown) => (typeof a === 'string' ? maskEmbedTokens(maskHookTokens(a)) : a)) as typeof args);
        },
      },
      ...(logStream ? { stream: logStream } : {}),
    },
  });

  useLogger(app.log); // src/app/logger.ts: every logger.* line in the process goes through pino, redacted

  // T6.2, in this order and before sign-in's hook below: security headers on
  // every response, the CSRF check on every non-GET, the per-IP rate limits —
  // all three refuse without a database query.
  registerSecurityHeaders(app, cfg.env === 'prod');
  registerCsrf(app, { cookie: cookieNames(cfg.env === 'prod').csrf, secure: cfg.env === 'prod', bearerDecides: !!cfg.databaseUrl && !identifyOverride });
  const limits = registerLimits(app, cfg.limits, proxyList(cfg.auth.trustedProxies));
  // Request counts and latency for GET /metrics, which itself is served only on METRICS_PORT (./metrics.ts).
  registerRequestMetrics(app);
  for (const w of cfg.mail?.warnings ?? []) app.log.warn(w); // the SMTP relay's startup warnings (./mail/mailEnv.ts)

  // Liveness: the process is up and serving. Checks nothing else on purpose —
  // a failing dependency must not make Kubernetes restart a healthy pod.
  app.get('/healthz', async () => ({ ok: true }));

  // Postgres, when DATABASE_URL is set: migrations run in `ready()` — before
  // `listen()` binds — so a pod whose schema is not current never serves, and
  // a failure (DB down, edited migration) rejects listen and exits main.ts 1.
  const dbUrl = cfg.databaseUrl;
  const pool = dbUrl ? createPool(dbUrl, (err) => app.log.warn({ err }, 'postgres idle client error'), cfg.pod.databasePoolMax) : null;
  dbPool = pool;
  bg = { runner: null, bus: null }; // this app's, once its onReady starts them
  watchPgPool(pool); // ordinate_pg_pool_clients on /metrics
  appEnv = cfg;
  if (pool && dbUrl) {
    // Scheduled jobs and cross-pod events (./jobs/): started once the schema
    // is current, stopped on close after the job in flight finishes and
    // reschedules. Lazy requires: nothing loads them without a DB.
    let jobs: { stop(): Promise<void> } | null = null;
    let bus: { stop(): Promise<void> } | null = null;
    let sweep: { stop(): void } | null = null;
    app.addHook('onReady', async () => {
      try {
        const r = await migrate(pool);
        app.log.info({ applied: r.applied, total: r.total, ms: Math.round(r.ms) }, 'migrations current');
      } catch (err) {
        throw scrubbed(err, dbUrl);
      }
      // Records (projects, visuals, …) are rows from here on — in server mode
      // only; recordFs ignores the pool under the desktop (T5.1). Before the
      // runner: a job's handler reads records like a request does.
      useRecordDb(pool);
      useOrgDb(pool); // per-member alert inbox, alert post claims, mentions (0020): forced RLS, one org per transaction
      useBlobDb(pool); // logos and Image-card pictures too (0018): nothing durable on this pod's disk
      // One refresh of a dataset at a time across pods (L0.4): an advisory lock per (org, dataset).
      useRefreshLockDb(pool);
      // Live warehouse statements counted per org per day across pods (L2.7): the daily limit holds org-wide.
      useLiveUsageDb(pool, cfg.auth.mode === 'dev');
      // Any pod serves any request (docs/any-pod): the abuse counters, file tokens and staged imports are rows, swept by a job.
      (require('./sharedState') as typeof import('./sharedState')).wireSharedState(pool, app.log);
      // Connection passwords/tokens: the encrypted store (T5.3), never the
      // per-org config.json. Without a master key there is no store, and a
      // connection secret is refused (src/app/configSecrets.ts).
      if (cfg.masterKey) useSecretStore(createSecretStore(pool, cfg.masterKey));
      // Each project's masking key is a secret every pod reads. No master key (never in prod): this pod's file.
      useMaskSaltStore(cfg.masterKey ? createSecretStore(pool, cfg.masterKey) : null);
      if (!cfg.masterKey) app.log.warn('no ORDINATE_MASTER_KEY: each pod keeps its own masking keys, so hash steps differ between pods');
      // AI provider keys go to the encrypted secrets store (T5.3) — with no master key, nowhere (T2.12).
      useAiKeys(pool, cfg.masterKey);
      // Embedding (docs/embed): the org's switch and origins in org_settings, its signing secret in the store — none without a master key.
      useEmbedDb(pool, cfg.masterKey ? createSecretStore(pool, cfg.masterKey) : null);
      // The org's settings document is a row every pod reads, not a file on this pod's disk (0014).
      orgConfig.useOrgConfig(pool, cfg.dataDir);
      await orgConfig.fresh(cfg.auth.org);
      (require('./jobs/schedules') as typeof import('./jobs/schedules')).wireSchedules(pool, cfg.auth.mode === 'dev');
      // Subscriptions: scheduled sends to Slack / Teams (URLs in the encrypted store, none without a master key) and email (cfg.mail).
      (require('./subscriptions/job') as typeof import('./subscriptions/job')).wireSubscriptions(
        pool, cfg, cfg.masterKey ? createSecretStore(pool, cfg.masterKey) : null, app.log);
      // S3 (T5.2): objects are registered in Postgres; old versions are collected by a job.
      if (cfg.storage.s3) {
        const storage = require('../engine/storage') as typeof import('../engine/storage');
        storage.useStorageDb(pool);
        (require('./jobs/runner') as typeof import('./jobs/runner')).defineJob('storage:gc', {
          everyMs: STORAGE_GC_EVERY_MS,
          run: async () => { await storage.collectGarbage(cfg.storage.gcGraceMs); },
        });
      }
      // A SIGTERM during boot (./shutdown.ts has already run past its runner/bus step): start
      // nothing it would have to stop. Everything below this line is background work of that kind.
      if (isDraining()) return;
      bus = await (require('./jobs/bus') as typeof import('./jobs/bus')).startBus(pool, dbUrl, app.log);
      // The backstop for a stream close the bus lost (docs/sso-lifecycle §3.9).
      sweep = (require('./streamSweep') as typeof import('./streamSweep')).startStreamSweep(pool, cfg.auth.sessionIdleMs, cfg.auth.apiTokenMaxDays, app.log);
      jobs = (require('./jobs/runner') as typeof import('./jobs/runner')).startRunner(pool, cfg.dataDir, app.log);
      bg = { runner: jobs, bus, sweep };
    });
    // An app closed on its own (the tests) stops its runner and bus here. A
    // draining server has already (./shutdown.ts), under deadlines this cannot keep.
    app.addHook('preClose', async () => {
      if (isDraining()) return;
      await jobs?.stop();
      await bus?.stop();
      sweep?.stop();
    });
    // …and un-wires its stores. Never while draining: a handler that outlived its
    // reply would then save a record to this pod's disk and lose it. ./shutdown.ts
    // ends the pool last instead, so anything later fails loudly.
    app.addHook('onClose', async () => {
      if (isDraining()) return;
      useRecordDb(null);
      useOrgDb(null);
      useBlobDb(null);
      useMaskSaltStore(null);
      useRefreshLockDb(null);
      useLiveUsageDb(null);
      (require('./sharedState') as typeof import('./sharedState')).unwireSharedState();
      if (cfg.storage.s3) (require('../engine/storage') as typeof import('../engine/storage')).useStorageDb(null);
      useSecretStore(null);
      useEmbedDb(null, null);
      useAiKeys(null, null);
      (require('./subscriptions/job') as typeof import('./subscriptions/job')).unwireSubscriptions();
      orgConfig.useOrgConfig(null);
      await pool.end();
    });
  }

  // Sign-in routes (/api/auth/*) and how every other /api/ request is identified.
  const identify = registerAuth(app, cfg, pool, identifyOverride);

  // Every other /api/ request runs inside its own context (./context.ts): who
  // is asking, for which org — or 401. Callback-style on purpose:
  // `als.run(store, done)` is what carries the store into the route handler
  // and every await below it. The probes stay outside: Kubernetes never signs
  // in; so does /api/auth/* (matched by ROUTE, so no path trick reaches
  // another route through the exemption). The peer handed to identify is the
  // socket's address — X-Forwarded-For never decides who is trusted.
  //
  // A signed-out browser NAVIGATING to the app (a GET that wants HTML, not a
  // file, not the probes or /sign-in itself) is redirected to /sign-in before
  // any of the app loads: no flash of the shell, no burst of 401s.
  // A settings change made by this request is in Postgres before its reply goes out (./orgConfig.ts).
  const orgOf = new WeakMap<object, string>();
  app.addHook('onSend', async (req, reply) => {
    // Draining: every answer closes its socket, so a keep-alive client reconnects elsewhere and close() never waits on it.
    if (isDraining()) void reply.header('connection', 'close');
    const org = orgOf.get(req);
    if (org) await orgConfig.flushed(org);
  });
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0];
    const api = path.startsWith('/api/');
    // A published site (/p/…, ./published.ts) decides its own access: members, or anyone when public.
    // So does a refresh URL (`self`, ./hooks/route.ts): its token is the credential.
    const route = req.routeOptions.url;
    // So does an embed (/embed/<token>, ./embed/route.ts): the signed token is the credential; no cookie reaches a third-party iframe.
    if (api ? route?.startsWith('/api/auth/') || routeAccess(req.method, route) === 'self' : !isPageNavigation(req.method, path, req.headers.accept) || path.startsWith('/p/') || path.startsWith('/embed/')) {
      return done();
    }
    Promise.resolve(identify(req.headers, req.socket.remoteAddress)).then(async (who) => {
      if (who) orgOf.set(req, who.org.id);
      if (who) await orgConfig.fresh(who.org.id); // another pod's settings change, at most a second old
      return who;
    }).then(
      (who) => {
        if (!who && !api) return void reply.redirect(path === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(req.url)}`);
        if (!who) return void reply.code(401).send({ error: 'not signed in' });
        // A temporary password (./auth/password.ts): every page is the change-password page, and
        // every /api/ call but /api/auth/* (exempt above) is refused, until it is changed.
        if (who.mustChangePassword && !api && path !== CHANGE_PASSWORD) {
          return void reply.redirect(path === '/' ? CHANGE_PASSWORD : `${CHANGE_PASSWORD}?next=${encodeURIComponent(req.url)}`);
        }
        if (!api) return done();
        if (who.mustChangePassword) return void reply.code(403).send({ error: 'password change required' });
        // Uploads and the event stream are checked against the org role
        // (./authz/); RPC calls are checked per contract in the route below.
        const need = routeAccess(req.method, route);
        if (need && !orgAllows(who.user.role, need)) return void reply.code(403).send({ error: 'forbidden' });
        // Which tab's event stream a push from the handler goes to:
        // X-Ordinate-Client, honoured only when that stream is bound to this
        // caller (./sse.ts). /api/events itself is behind this gate too.
        // A caller that goes away before its reply (a closed tab, an aborted
        // fetch) aborts the request's signal: its DuckDB queries are interrupted
        // in the org worker instead of running on for nobody (T4.3).
        // An RPC also aborts it past RPC_TIMEOUT_SECONDS (the route answers 504).
        const ac = new AbortController();
        const limit = req.routeOptions.url === RPC_ROUTE ? setTimeout(() => ac.abort(new RpcTimeout()), cfg.limits.rpcTimeoutMs) : undefined;
        const untrack = trackRequest(ac); // the shutdown's HTTP deadline aborts what is still running (./shutdown.ts)
        reply.raw.once('close', () => {
          untrack();
          clearTimeout(limit);
          if (!reply.raw.writableFinished) ac.abort();
        });
        runInContext(who, String(req.id), done, clientFor(req.headers['x-ordinate-client'], who) ?? undefined, ac.signal);
      },
      (err: unknown) => {
        req.log.error({ err }, 'identify failed');
        void reply.code(503).send({ error: 'sign-in unavailable' });
      },
    );
  });

  // Each stream remembers its session (session sign-in modes) and its API token, so the sweep below and a
  // revoke end it with them (docs/sso-lifecycle §3.9).
  const sessionCookie = cookieNames(cfg.env === 'prod').session;
  const sessionModes = cfg.auth.mode === 'oidc' || cfg.auth.mode === 'password';
  registerEvents(app, (req) => {
    const id = sessionModes ? req.cookies?.[sessionCookie] : undefined;
    const bearer = typeof req.headers.authorization === 'string' ? /^Bearer\s+(ord_\S+)\s*$/i.exec(req.headers.authorization)?.[1] : undefined;
    return { session: typeof id === 'string' && id ? hashId(id) : null, token: bearer ? hashId(bearer) : null };
  });

  // Readiness: can this pod answer queries? DuckDB, plus Postgres when
  // configured. With per-org workers (T4.3) the first call starts a locked,
  // empty probe worker and asks it (awaited, not blocking); once any worker has
  // started it is a state check.
  app.get('/readyz', async (_req, reply) => {
    if (isDraining()) return reply.code(503).send({ ok: false, draining: true });
    const duckdb = await probe();
    const checks: Record<string, boolean> = { duckdb };
    if (pool) checks.postgres = await ping(pool);
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  // RPC: POST /api/rpc/<channel> with body `{"args":[payload?]}`, the whole
  // body wire-encoded (./wire.ts); the reply is the handler's result,
  // wire-encoded. A channel needs a contract (src/api/) — none → 404, even
  // when a handler is registered. A failing contract → 400 naming the paths
  // and zod codes only: an input value never comes back in an error.
  // Per-user rate limit first (./limits.ts), then the contract.
  app.post<{ Params: { channel: string } }>(RPC_ROUTE, { onRequest: limits.perUser }, async (req, reply) => {
    const { channel } = req.params;
    const contract = contractFor(channel);
    if (!contract) return reply.code(404).send({ error: 'unknown channel' });

    let body: unknown;
    try {
      body = fromWire(req.body);
    } catch {
      return reply.code(400).send({ error: 'malformed body' });
    }
    const args = body !== null && typeof body === 'object' ? (body as { args?: unknown }).args : undefined;
    if (!Array.isArray(args) || args.length > 1) {
      return reply.code(400).send({ error: 'invalid input', issues: [{ path: 'args', code: 'invalid_args' }] });
    }
    const parsed = contract.input.safeParse(args[0]);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: ['args', 0, ...i.path].map(String).join('.'), code: i.code }));
      return reply.code(400).send({ error: 'invalid input', issues });
    }

    // Authorization (./authz/): the caller's role on the project the input
    // names, or on the org, must reach the contract's access — else 403 and
    // the handler never runs. Writes, admin calls and audited reads leave an
    // audit row: ids only, never an input value (./authz/audit.ts). An admin
    // screen's own lists (`audit: 'denials'`) leave one only when refused.
    const who = ctx();
    const audited = contract.access !== 'read' || contract.audit !== undefined;
    const targets = audited ? targetIds(parsed.data) : [];
    const record = async (outcome: Outcome, projectId: string | null, extra: string[] = []): Promise<void> => {
      if (!audited || (contract.audit === 'denials' && outcome !== 'denied')) return;
      await audit(pool, {
        org: who.org.id, actor: who.user.email, action: 'rpc', channel, projectId,
        targets: [...targets, ...extra], outcome, requestId: who.requestId,
      }).catch((err: unknown) => req.log.error({ err: scrubbed(err, dbUrl ?? ''), channel }, 'audit write failed'));
    };
    const decision = await authorize(contract, parsed.data, who, pool);
    if (!decision.ok) {
      await record('denied', decision.projectId);
      return reply.code(403).send({ error: 'forbidden' });
    }

    if (decision.projectId && typeof decision.rank === 'number') seedRank(decision.projectId, decision.rank); // row access rules ask the same rank
    const handler = handlers.get(channel);
    if (!handler) return reply.code(501).send({ error: 'channel not available on this server' });
    try {
      // Raced against the request's signal: past RPC_TIMEOUT_SECONDS → 504, and
      // the same signal has interrupted the handler's DuckDB queries (T4.3).
      const refusals = liveRefusalsRaised();
      const rowRefusals = rowPolicyRaised();
      let result: unknown = await untilAborted(Promise.resolve(handler(SERVER_EVENT, ...(args.length ? [parsed.data] : []))), who.signal);
      const created = 'creates' in contract && contract.creates ? contract.creates(result) : undefined;
      if (created) await grantCreator(pool, who, created);
      if ('visible' in contract && contract.visible) result = contract.visible(result, await readable(pool, who));
      // D6: a Live refusal a handler caught keeps its type (src/data/liveDataset.ts).
      if (liveRefusalsRaised() !== refusals) tagLiveRefusals(result);
      if (rowPolicyRaised() !== rowRefusals) tagRowPolicyRefusals(result); // a row access refusal a handler caught keeps its type
      const body = encode(result);
      await record('ok', decision.projectId, created ? [created] : []);
      return reply.type('application/json').send(body);
    } catch (err) {
      if (isRestarting(err)) {
        // The pod is stopping (./shutdown.ts): a job it refused, or a request still running at its deadline.
        await record('error', decision.projectId);
        return reply.code(503).send({ error: 'restarting', code: 'restarting', message: err.message });
      }
      if (err instanceof RpcTimeout) {
        req.log.warn({ channel, limitMs: cfg.limits.rpcTimeoutMs }, 'rpc timed out');
        await record('error', decision.projectId);
        return reply.code(504).send({ error: 'timeout' });
      }
      if (isLiveDatasetError(err)) {
        // D6: a reader not yet built for a Live dataset refuses LOUDLY — a typed
        // 409 with the catalog's sentence (no id, no SQL), never a figure from zero rows.
        await record('error', decision.projectId);
        return reply.code(409).send({ error: LIVE_DATASET_CODE, code: LIVE_DATASET_CODE, message: err.message });
      }
      if (isRowPolicyError(err)) {
        // Row access rules (docs/row-policy): a typed 409 with the catalog's sentence — never a figure, never another team's value.
        await record('error', decision.projectId);
        return reply.code(409).send({ error: ROW_POLICY_CODE, code: ROW_POLICY_CODE, reason: err.reason, message: err.message });
      }
      if ((err as { code?: unknown } | null)?.code === 'ERECORDBUSY') {
        // Another save held the record past the lock wait (src/app/recordFs.ts):
        // a typed 409 with the catalog's sentence, never Postgres's text.
        await record('error', decision.projectId);
        return reply.code(409).send({ error: 'record_busy', code: 'record_busy', message: (err as Error).message });
      }
      if (isIdpManaged(err)) {
        // A role or team the identity provider decides (docs/sso-lifecycle): a typed 409 with the catalog's sentence.
        await record('denied', decision.projectId);
        return reply.code(409).send({ error: err.code, code: err.code, message: err.message });
      }
      if (isRecordChanged(err)) {
        // A whole-document save from a stale copy (src/app/editConflict.ts): the record is
        // untouched; the catalog's sentence and the current tag, never the record.
        await record('error', decision.projectId);
        return reply.code(409).send({ error: 'record_changed', code: 'record_changed', message: err.message, tag: err.tag });
      }
      if (isLiveFigureError(err)) {
        // L2.4: a Live KPI the warehouse could not give, thrown past a handler that
        // did not catch it — typed the same way, its catalog sentence only (R-L6).
        const f = err.failure;
        await record('error', decision.projectId);
        return reply.code(409).send({ error: f.code, code: f.code, message: f.error, ...(f.reason ? { reason: f.reason } : {}) });
      }
      // The message can carry a path or a value; it goes to the log, not the wire.
      req.log.error({ err, channel }, 'rpc handler failed');
      await record('error', decision.projectId);
      return reply.code(500).send({ error: 'handler failed' });
    }
  });

  // Uploads and downloads (./files.ts) — the open and save dialogs' replacement.
  // MAX_UPLOAD_MB is the ceiling; an org admin may set a lower cap (Admin → Settings).
  registerFileRoutes(app, cfg.maxUploadMb, () => uploadCapMb(pool, ctx().org.id, cfg.maxUploadMb));

  // MCP for programs, signed in with a personal API token (T3.4).
  registerMcpRoute(app, () => pool, limits.perUser);

  // Refresh URLs for dbt / Airflow (live data L0.5): one dataset, one action, the token in the path.
  registerRefreshHookRoute(app, {
    pool: () => pool, minIntervalSec: cfg.limits.refreshHookMinIntervalSec, devAuth: cfg.auth.mode === 'dev', dbUrl: dbUrl ?? '',
  });

  // The maps' bundled boundary GeoJSON (./geo.ts) — org-independent, immutable by content hash.
  registerGeoRoutes(app);

  // Published dashboards at /p/<publishId>/ (T2.9): signed-in members of the org, or anyone when the site is public.
  registerPublishedRoutes(app, identify, () => pool);

  // Signed embedding at /embed/<token> (docs/embed): off until an org admin turns it on; the only route another site may frame.
  registerEmbedRoutes(app, { pool: () => pool, identify, tokenPerMinute: cfg.limits.embedPerMinute, orgPerMinute: cfg.limits.embedOrgPerMinute });

  // An app closed on its own (the in-process suites) lets its DuckDB go, as it always did: the next
  // app starts a fresh, unhardened worker. A draining server never does this here — detached work may
  // still need DuckDB — ./shutdown.ts interrupts and closes every worker last, and awaits each exit.
  app.addHook('onClose', async () => {
    if (!isDraining()) duckShutdown();
  });

  // The web app, when it has been built (`npm --prefix web run build`). In dev
  // the Vite server serves it instead and proxies /api here.
  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) registerStatic(app, WEB_DIST);

  return app;
}

/**
 * Registers the handler modules whose channels have contracts. main.ts calls
 * it at boot, so scripts/test-server-boot.ts proves their whole import graph
 * loads in a plain Node process. The requires are lazy so loading app.ts never loads
 * a handler module.
 */
export function registerHandlers(): void {
  for (const mod of ['../ipc/projects', '../ipc/datasets', '../ipc/recent', '../ipc/quality', '../ipc/visuals', '../ipc/projectBoundaries', '../ipc/geoAnalysis', '../ipc/connections', '../ipc/trash', '../ipc/versions']) {
    (require(mod) as { register: () => void }).register();
  }
  // The Data section (T2.3): catalog, lineage, relationships, search inside the data, and the browser's dataset views.
  for (const mod of ['../ipc/catalog', '../ipc/lineage', '../ipc/relationships', '../ipc/dataSearch', '../ipc/datasetViews']) {
    (require(mod) as { register: () => void }).register();
  }
  (require('./authz/share') as typeof import('./authz/share')).register(() => dbPool);
  registerCaller(() => dbPool); // row access rules: who is a project viewer
  (require('../ipc/rowPolicy') as typeof import('../ipc/rowPolicy')).register(() => dbPool); // …and the admin's Row access tab
  // Admin and personal API tokens (T3.4). The env is read per call, like the pool.
  const env = (): ServerEnv => {
    if (!appEnv) throw new Error('no app built');
    return appEnv;
  };
  (require('./admin/people') as typeof import('./admin/people')).register(() => dbPool, () => env().auth.allowedDomains, () => env().auth);
  // Identity provider groups (docs/sso-lifecycle): the map, and a re-apply of every synced member when it changes.
  (require('./admin/idpGroups') as typeof import('./admin/idpGroups')).register(() => dbPool, () => env().auth);
  (require('./admin/passwords') as typeof import('./admin/passwords')).register(() => dbPool, () => (appEnv ?? env()).auth.mode, () => env().auth.allowedDomains);
  (require('./admin/org') as typeof import('./admin/org')).register(() => dbPool, () => env().maxUploadMb);
  // Admin → Live usage (live data L2.7): Postgres's counts, or this pod's without it.
  (require('./admin/liveUsage') as typeof import('./admin/liveUsage')).register();
  (require('./auth/tokens') as typeof import('./auth/tokens')).register(() => dbPool, () => env().auth.apiTokenMaxDays);
  // Refresh URLs (live data L0.5): a project writer's, per dataset.
  (require('./hooks/rpc') as typeof import('./hooks/rpc')).register(() => dbPool, () => env().limits.refreshHookMinIntervalSec);
  // The Assistant dock (T2.12): conversations, answers, plans, provider keys.
  for (const mod of ['../ipc/copilot', '../ipc/plan', '../ipc/providersServer', '../ipc/aiModels']) (require(mod) as { register: () => void }).register();
  // Home and the app chrome (T2.1): first-run guidance, workspace prefs, the Jobs popover.
  for (const mod of ['../ipc/onboarding', '../ipc/prefs']) (require(mod) as { register: () => void }).register();
  (require('../ipc/jobs') as typeof import('../ipc/jobs')).registerServer();
  // Import, composer, captures and input tables (T2.4).
  for (const mod of ['../ipc/datasetCompose', '../ipc/input', '../ipc/captureDataset']) {
    (require(mod) as { register: () => void }).register();
  }
  // The Visuals screen (T2.7): the builder's sampled preview, the gallery's thumbnails, the drill
  // panel and period picker, and the project colour map that Format → Colours edits.
  for (const mod of ['../ipc/vizSample', '../ipc/visualsServer', '../ipc/format']) (require(mod) as { register: () => void }).register();
  // Explore (docs/explore): a dataset's fields and suggested questions; every figure it draws is `visual:data`'s.
  (require('../ipc/explore') as typeof import('../ipc/explore')).register();

  // Prepare and pipelines (T2.6). Pipelines' cron rides the server's own tick job (./jobs/schedules.ts), so headless here.
  for (const mod of ['../ipc/preparePower', '../ipc/text', '../ipc/formula']) (require(mod) as { register: () => void }).register();
  (require('../ipc/pipelines') as typeof import('../ipc/pipelines')).register({ headless: true });

  // Analytics workbenches A (T2.10): statistics, key drivers, scenarios, segments.
  for (const mod of ['../ipc/stats', '../ipc/drivers', '../ipc/driversPoint', '../ipc/scenarios', '../ipc/segments']) {
    (require(mod) as { register: () => void }).register();
  }

  // Settings, themes, privacy, the palette's record search and the calendar
  // preview (T2.14). Each module once; the registry throws on a second.
  for (const mod of ['../ipc/settingsServer', '../ipc/themes', '../ipc/privacy', '../ipc/search', '../ipc/periods']) {
    (require(mod) as { register: () => void }).register();
  }
  // Analyses and authoring, metrics (T2.8). `periods` (metric:compare) is T2.14's registration above.
  for (const mod of ['../ipc/analyses', '../ipc/templates', '../ipc/dashboards', '../ipc/metrics', '../ipc/metricCheck', '../ipc/analysesServer']) {
    (require(mod) as { register: () => void }).register();
  }
  // Reports, stories and scorecards (T2.13): the records, the server-resolved pages a file is written from.
  for (const mod of ['../ipc/reports', '../ipc/stories', '../ipc/scorecards', '../ipc/reportsServer']) {
    (require(mod) as { register: () => void }).register();
  }

  // Analytics workbenches B (T2.11): insights, event annotations, data snapshots, SQL over the project's datasets.
  for (const mod of ['../ipc/insights', '../ipc/events', '../ipc/sqlQuery']) (require(mod) as { register: () => void }).register();
  (require('../ipc/snapshots') as typeof import('../ipc/snapshots')).register({ headless: true });
  // Dashboards, sharing, alerts, comments (T2.9): publish to a URL, export, the summary card, the As-of picker.
  (require('../ipc/publishServer') as typeof import('../ipc/publishServer')).register(() => dbPool);
  // Signed embedding (docs/embed): the org's settings and secret, a dashboard's lockable columns, a preview link.
  (require('../ipc/embed') as typeof import('../ipc/embed')).register();
  for (const mod of ['../ipc/comments', '../ipc/summary', '../ipc/dashboardsServer', '../ipc/fx']) (require(mod) as { register: () => void }).register();
  (require('../ipc/alerts') as typeof import('../ipc/alerts')).register();
  // Live datasets (docs/live-data/00-plan.md L2.1): the mode switch.
  (require('../ipc/liveDatasets') as typeof import('../ipc/liveDatasets')).register();
  // …its schema sync and column profile (L2.5).
  (require('../ipc/liveProfile') as typeof import('../ipc/liveProfile')).register();
  // Incremental refresh settings (the desktop panel's web port): what 5/15-minute cadences and fresh on ask need.
  (require('../ipc/incremental') as typeof import('../ipc/incremental')).register();
  // Subscriptions: scheduled sends to Slack / Teams, and the org's channels.
  (require('./subscriptions/rpc') as typeof import('./subscriptions/rpc')).register();
  // Rebuild a dashboard from a screenshot of another BI tool (docs/rebuild-from-screenshot/).
  (require('../ipc/rebuild') as typeof import('../ipc/rebuild')).register();
  // Metric trees (docs/metric-tree): a metric broken into its parts, its change attributed to them.
  (require('../ipc/metricTree') as typeof import('../ipc/metricTree')).register();
  // @mentions (docs/notifications): the picker, the caller's "Mentioned you" and its email setting.
  (require('./mentions/rpc') as typeof import('./mentions/rpc')).register();
}
