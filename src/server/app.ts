// The Fastify app factory. Builds routes and the logger; never listens —
// `main.ts` does that, and tests drive the app through `inject()`.
//
// This module and everything it imports must load WITHOUT Electron: the server
// runs in a plain Node pod. scripts/test-server-boot.ts spawns the server with
// `require('electron')` made to fail, so an Electron import anywhere in this
// graph breaks the build's tests, not a deploy.

import { fastify, type FastifyInstance } from 'fastify';
import { isAvailable, shutdown } from '../engine/duckdb';
import { contractFor } from '../api/index';
import type { ServerEnv } from './env';
import { migrate } from './db/migrate';
import { createPool, ping, scrubbed } from './db/pool';
import { handlers } from './rpc';
import { fromWire, encode } from './wire';

/** The `event` a handler receives over HTTP. `event.sender` arrives with T0.3/T0.5 (`ctx().client`). */
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
];

// ponytail: pino matches exact names at fixed depths (`*.k` is ONE level), so
// each key is listed at depths 0–4 — enough for `req.headers.x` and a nested
// config object. Deeper secrets need a deeper list, or a walking serializer.
const MAX_DEPTH = 4;
export const REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((k) => {
  const leaf = /^[a-z]+$/.test(k) ? k : `["${k}"]`;
  return Array.from({ length: MAX_DEPTH + 1 }, (_, d) => '*.'.repeat(d) + leaf);
});

export function buildApp(cfg: ServerEnv, logStream?: NodeJS.WritableStream): FastifyInstance {
  const app = fastify({
    logger: {
      level: cfg.logLevel,
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
      ...(logStream ? { stream: logStream } : {}),
    },
  });

  // Liveness: the process is up and serving. Checks nothing else on purpose —
  // a failing dependency must not make Kubernetes restart a healthy pod.
  app.get('/healthz', async () => ({ ok: true }));

  // Postgres, when DATABASE_URL is set: migrations run in `ready()` — before
  // `listen()` binds — so a pod whose schema is not current never serves, and
  // a failure (DB down, edited migration) rejects listen and exits main.ts 1.
  const dbUrl = cfg.databaseUrl;
  const pool = dbUrl ? createPool(dbUrl, (err) => app.log.warn({ err }, 'postgres idle client error')) : null;
  if (pool && dbUrl) {
    app.addHook('onReady', async () => {
      try {
        const r = await migrate(pool);
        app.log.info({ applied: r.applied, total: r.total, ms: Math.round(r.ms) }, 'migrations current');
      } catch (err) {
        throw scrubbed(err, dbUrl);
      }
    });
    app.addHook('onClose', async () => pool.end());
  }

  // Readiness: can this pod answer queries? DuckDB, plus Postgres when
  // configured. The first call starts the DuckDB worker (~115 ms, blocking) —
  // later calls are a state check.
  app.get('/readyz', async (_req, reply) => {
    const duckdb = isAvailable();
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
  app.post<{ Params: { channel: string } }>('/api/rpc/:channel', async (req, reply) => {
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

    const handler = handlers.get(channel);
    if (!handler) return reply.code(501).send({ error: 'channel not available on this server' });
    try {
      const result: unknown = await handler(SERVER_EVENT, ...(args.length ? [parsed.data] : []));
      return reply.type('application/json').send(encode(result));
    } catch (err) {
      // The message can carry a path or a value; it goes to the log, not the wire.
      req.log.error({ err, channel }, 'rpc handler failed');
      return reply.code(500).send({ error: 'handler failed' });
    }
  });

  app.addHook('onClose', async () => shutdown());

  return app;
}

/**
 * Registers the handler modules whose channels have contracts.
 *
 * NOT called by main.ts yet: these modules still reach Electron at load or
 * call time (ipc/projects imports `dialog`; src/app/* call `app.getPath`), and
 * the server must boot with no Electron at all (scripts/test-server-boot.ts).
 * T0.3 replaces `app.getPath` with src/app/paths.ts; then main.ts calls this
 * and the boot test covers it. Until then scripts/test-rpc.ts calls it under
 * the test-suite's Electron stub. The requires are lazy so loading app.ts
 * never loads a handler module.
 */
export function registerHandlers(): void {
  for (const mod of ['../ipc/projects', '../ipc/datasets', '../ipc/recent']) {
    (require(mod) as { register: () => void }).register();
  }
}
