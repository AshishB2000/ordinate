// The Fastify app factory. Builds routes and the logger; never listens —
// `main.ts` does that, and tests drive the app through `inject()`.
//
// The server runs in a plain Node pod; scripts/test-server-boot.ts spawns it the
// same way, so a module in this graph that cannot load there breaks the build's
// tests, not a deploy.

import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { probe, shutdown } from '../engine/duckdb';
import { contractFor } from '../api/index';
import { proxyList, type ServerEnv } from './env';
import { ctx, runInContext, type Identify } from './context';
import { authorize, grantCreator, orgAllows, readable } from './authz/index';
import { audit, targetIds, type Outcome } from './authz/audit';
import { registerAuth } from './auth/index';
import { cookieNames } from './auth/cookies';
import { registerSecurityHeaders } from './headers';
import { registerCsrf } from './csrf';
import { registerLimits, RPC_ROUTE, RpcTimeout, untilAborted } from './limits';
import { migrate } from './db/migrate';
import { createPool, ping, scrubbed } from './db/pool';
import { useRecordDb } from '../app/recordFs';
import { useSecretStore } from '../app/configSecrets';
import { createSecretStore } from './secrets/store';
import { useAiKeys } from './aiKeys';
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
import { registerRequestMetrics } from './metrics';
import { registerPublishedRoutes } from './published';
import { isLiveDatasetError, LIVE_DATASET_CODE, liveRefusalsRaised, tagLiveRefusals } from '../data/liveDataset';
import { isLiveFigureError } from '../engine/live/liveFigureError';
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
          url: maskHookUrl(maskFileToken(req.url.split('?')[0])),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
      // And in every message: Fastify writes "Route POST:<url> not found" as
      // text, which no serializer sees — a refresh URL's token never gets there.
      hooks: {
        logMethod(args, method) {
          return method.apply(this, args.map((a: unknown) => (typeof a === 'string' ? maskHookTokens(a) : a)) as typeof args);
        },
      },
      ...(logStream ? { stream: logStream } : {}),
    },
  });

  // T6.2, in this order and before sign-in's hook below: security headers on
  // every response, the CSRF check on every non-GET, the per-IP rate limits —
  // all three refuse without a database query.
  registerSecurityHeaders(app, cfg.env === 'prod');
  registerCsrf(app, { cookie: cookieNames(cfg.env === 'prod').csrf, secure: cfg.env === 'prod', bearerDecides: !!cfg.databaseUrl && !identifyOverride });
  const limits = registerLimits(app, cfg.limits, proxyList(cfg.auth.trustedProxies));
  // Request counts and latency for GET /metrics, which itself is served only on METRICS_PORT (./metrics.ts).
  registerRequestMetrics(app);

  // Liveness: the process is up and serving. Checks nothing else on purpose —
  // a failing dependency must not make Kubernetes restart a healthy pod.
  app.get('/healthz', async () => ({ ok: true }));

  // Postgres, when DATABASE_URL is set: migrations run in `ready()` — before
  // `listen()` binds — so a pod whose schema is not current never serves, and
  // a failure (DB down, edited migration) rejects listen and exits main.ts 1.
  const dbUrl = cfg.databaseUrl;
  const pool = dbUrl ? createPool(dbUrl, (err) => app.log.warn({ err }, 'postgres idle client error')) : null;
  dbPool = pool;
  appEnv = cfg;
  if (pool && dbUrl) {
    // Scheduled jobs and cross-pod events (./jobs/): started once the schema
    // is current, stopped on close after the job in flight finishes and
    // reschedules. Lazy requires: nothing loads them without a DB.
    let jobs: { stop(): Promise<void> } | null = null;
    let bus: { stop(): Promise<void> } | null = null;
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
      // One refresh of a dataset at a time across pods (L0.4): an advisory lock per (org, dataset).
      useRefreshLockDb(pool);
      // Live warehouse statements counted per org per day across pods (L2.7): the daily limit holds org-wide.
      useLiveUsageDb(pool, cfg.auth.mode === 'dev');
      // Connection passwords/tokens: the encrypted store (T5.3), never the
      // per-org config.json. Without a master key there is no store, and a
      // connection secret is refused (src/app/configSecrets.ts).
      if (cfg.masterKey) useSecretStore(createSecretStore(pool, cfg.masterKey));
      // AI provider keys go to the encrypted secrets store (T5.3) — with no master key, nowhere (T2.12).
      useAiKeys(pool, cfg.masterKey);
      (require('./jobs/schedules') as typeof import('./jobs/schedules')).wireSchedules(pool, cfg.auth.mode === 'dev');
      // S3 (T5.2): objects are registered in Postgres; old versions are collected by a job.
      if (cfg.storage.s3) {
        const storage = require('../engine/storage') as typeof import('../engine/storage');
        storage.useStorageDb(pool);
        (require('./jobs/runner') as typeof import('./jobs/runner')).defineJob('storage:gc', {
          everyMs: STORAGE_GC_EVERY_MS,
          run: async () => { await storage.collectGarbage(cfg.storage.gcGraceMs); },
        });
      }
      bus = await (require('./jobs/bus') as typeof import('./jobs/bus')).startBus(pool, dbUrl, app.log);
      jobs = (require('./jobs/runner') as typeof import('./jobs/runner')).startRunner(pool, cfg.dataDir, app.log);
    });
    // preClose, not onClose: onClose hooks run last-registered first, so
    // DuckDB's shutdown (below) would close under a tick still running.
    app.addHook('preClose', async () => {
      await jobs?.stop();
      await bus?.stop();
    });
    app.addHook('onClose', async () => {
      useRecordDb(null);
      useRefreshLockDb(null);
      useLiveUsageDb(null);
      if (cfg.storage.s3) (require('../engine/storage') as typeof import('../engine/storage')).useStorageDb(null);
      useSecretStore(null);
      useAiKeys(null, null);
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
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0];
    const api = path.startsWith('/api/');
    // A published site (/p/…, ./published.ts) decides its own access: members, or anyone when public.
    // So does a refresh URL (`self`, ./hooks/route.ts): its token is the credential.
    const route = req.routeOptions.url;
    if (api ? route?.startsWith('/api/auth/') || routeAccess(req.method, route) === 'self' : !isPageNavigation(req.method, path, req.headers.accept) || path.startsWith('/p/')) {
      return done();
    }
    Promise.resolve(identify(req.headers, req.socket.remoteAddress)).then(
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
        reply.raw.once('close', () => {
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

  registerEvents(app);

  // Readiness: can this pod answer queries? DuckDB, plus Postgres when
  // configured. With per-org workers (T4.3) the first call starts a locked,
  // empty probe worker and asks it (awaited, not blocking); once any worker has
  // started it is a state check.
  app.get('/readyz', async (_req, reply) => {
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

    const handler = handlers.get(channel);
    if (!handler) return reply.code(501).send({ error: 'channel not available on this server' });
    try {
      // Raced against the request's signal: past RPC_TIMEOUT_SECONDS → 504, and
      // the same signal has interrupted the handler's DuckDB queries (T4.3).
      const refusals = liveRefusalsRaised();
      let result: unknown = await untilAborted(Promise.resolve(handler(SERVER_EVENT, ...(args.length ? [parsed.data] : []))), who.signal);
      const created = 'creates' in contract && contract.creates ? contract.creates(result) : undefined;
      if (created) await grantCreator(pool, who, created);
      if ('visible' in contract && contract.visible) result = contract.visible(result, await readable(pool, who));
      // D6: a Live refusal a handler caught keeps its type (src/data/liveDataset.ts).
      if (liveRefusalsRaised() !== refusals) tagLiveRefusals(result);
      const body = encode(result);
      await record('ok', decision.projectId, created ? [created] : []);
      return reply.type('application/json').send(body);
    } catch (err) {
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

  app.addHook('onClose', async () => shutdown());

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
  // Admin and personal API tokens (T3.4). The env is read per call, like the pool.
  const env = (): ServerEnv => {
    if (!appEnv) throw new Error('no app built');
    return appEnv;
  };
  (require('./admin/people') as typeof import('./admin/people')).register(() => dbPool, () => env().auth.allowedDomains);
  (require('./admin/passwords') as typeof import('./admin/passwords')).register(() => dbPool, () => (appEnv ?? env()).auth.mode, () => env().auth.allowedDomains);
  (require('./admin/org') as typeof import('./admin/org')).register(() => dbPool, () => env().maxUploadMb);
  // Admin → Live usage (live data L2.7): Postgres's counts, or this pod's without it.
  (require('./admin/liveUsage') as typeof import('./admin/liveUsage')).register();
  (require('./auth/tokens') as typeof import('./auth/tokens')).register(() => dbPool);
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

  // Prepare and pipelines (T2.6). Pipelines' cron rides the server's own tick job (./jobs/schedules.ts), so headless here.
  for (const mod of ['../ipc/preparePower', '../ipc/text', '../ipc/formula']) (require(mod) as { register: () => void }).register();
  (require('../ipc/pipelines') as typeof import('../ipc/pipelines')).register({ headless: true });

  // Analytics workbenches A (T2.10): statistics, key drivers, scenarios, segments.
  for (const mod of ['../ipc/stats', '../ipc/drivers', '../ipc/scenarios', '../ipc/segments']) {
    (require(mod) as { register: () => void }).register();
  }

  // Settings, themes, privacy, the palette's record search and the calendar
  // preview (T2.14). Each module once; the registry throws on a second.
  for (const mod of ['../ipc/settingsServer', '../ipc/themes', '../ipc/privacy', '../ipc/search', '../ipc/periods']) {
    (require(mod) as { register: () => void }).register();
  }
  // Analyses and authoring, metrics (T2.8). `periods` (metric:compare) is T2.14's registration above.
  for (const mod of ['../ipc/analyses', '../ipc/templates', '../ipc/dashboards', '../ipc/metrics', '../ipc/analysesServer']) {
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
  for (const mod of ['../ipc/comments', '../ipc/summary', '../ipc/dashboardsServer', '../ipc/fx']) (require(mod) as { register: () => void }).register();
  (require('../ipc/alerts') as typeof import('../ipc/alerts')).register();
  // Live datasets (docs/live-data/00-plan.md L2.1): the mode switch.
  (require('../ipc/liveDatasets') as typeof import('../ipc/liveDatasets')).register();
  // …its schema sync and column profile (L2.5).
  (require('../ipc/liveProfile') as typeof import('../ipc/liveProfile')).register();
  // Incremental refresh settings (the desktop panel's web port): what 5/15-minute cadences and fresh on ask need.
  (require('../ipc/incremental') as typeof import('../ipc/incremental')).register();
}
