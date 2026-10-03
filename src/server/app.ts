// The Fastify app factory. Builds routes and the logger; never listens —
// `main.ts` does that, and tests drive the app through `inject()`.
//
// This module and everything it imports must load WITHOUT Electron: the server
// runs in a plain Node pod. scripts/test-server-boot.ts spawns the server with
// `require('electron')` made to fail, so an Electron import anywhere in this
// graph breaks the build's tests, not a deploy.

import { fastify, type FastifyInstance } from 'fastify';
import { isAvailable, shutdown } from '../engine/duckdb';
import type { ServerEnv } from './env';

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

  // Readiness: can this pod answer queries? DuckDB now; Postgres joins in T3.1.
  // The first call starts the DuckDB worker (~115 ms, blocking) — later calls
  // are a state check.
  app.get('/readyz', async (_req, reply) => {
    const duckdb = isAvailable();
    return reply.code(duckdb ? 200 : 503).send({ ok: duckdb, checks: { duckdb } });
  });

  app.addHook('onClose', async () => shutdown());

  return app;
}
