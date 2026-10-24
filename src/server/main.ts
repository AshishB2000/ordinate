// Server entry point: `npm run server` → `node src/server/main.js`.
// Reads the environment once, listens, and on SIGTERM/SIGINT (what Kubernetes
// and Compose send on a rollout) runs the one shutdown sequence (./shutdown.ts)
// inside SHUTDOWN_GRACE_SECONDS. It never exits around a live DuckDB worker.

import * as path from 'path';
import { buildApp, registerHandlers } from './app';
import { enterServerMode, identityFor } from './context';
import { env, type ServerEnv } from './env';
import { startMetricsServer } from './metrics';
import { shutdown } from './shutdown';
import { sweepLeftovers } from './files';
import { closeAll, forbidSyncOnMainThread } from '../engine/duckdb';
import * as s3 from '../engine/s3';
import { routeByOrg } from '../engine/duckdbPool';
import * as storage from '../engine/storage';

let cfg: ServerEnv;
try {
  cfg = env();
  // The gate on dev sign-in: refuses prod with AUTH_MODE=dev.
  if (cfg.auth.mode === 'dev') identityFor(cfg);
} catch (err) {
  // One line, no stack: the operator needs the variable name, not a trace.
  process.stderr.write(`ordinate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// From here on paths resolve per org under DATA_DIR and ctx() outside a
// request throws (./context.ts).
enterServerMode(cfg.dataDir);
// One process serves every request, so a sync DuckDB call would park all of
// them: from here on `duck.query()`/`exec()` on this thread THROW (worker
// threads are exempt). scripts/test-asyncReach.ts proves no handler reaches one.
forbidSyncOnMainThread();
// Every async DuckDB call runs in the caller's org worker, locked to that org's
// directory (src/engine/duckdbPool.ts); the process-wide worker never starts.
// STORAGE_URL=s3://…: Parquet is versioned objects there, read through each
// org worker's scoped httpfs secret and a local LRU cache (src/engine/storage.ts).
storage.configure(cfg.dataDir, cfg.storage.s3, cfg.storage.cacheBytes);
routeByOrg({ dataDir: cfg.dataDir, ...cfg.duckdb, s3: cfg.storage.s3 });
registerHandlers();
// The test harness's fake warehouse for Live datasets (docs/live-data/00-plan.md
// L2.3, L2.6): ORDINATE_TEST_LIVE_FAKE=1 only, which env.ts refuses in prod —
// and the image ships no scripts/, so there it could not load anyway.
if (cfg.testLiveFake) {
  const load: (id: string) => unknown = require;
  (load(path.join(__dirname, '..', '..', 'scripts', 'liveFakeConnector.js')) as { registerLiveFake(): void }).registerLiveFake();
}
const app = buildApp(cfg);
// What a crashed pod left in the org temp dirs (a bundle's staging, a backup…), a day old or more.
const swept = sweepLeftovers(cfg.dataDir);
if (swept) app.log.info({ swept }, 'removed temp files a crash left behind');

// dev binds loopback only: dev mode runs every request as an admin (context.ts),
// which must not be reachable from the LAN. prod runs in a container behind an
// ingress, so it binds every interface.
const host = cfg.env === 'dev' ? '127.0.0.1' : '0.0.0.0';

app.listen({ port: cfg.port, host }).catch((err: unknown) => {
  app.log.fatal({ err }, 'listen failed');
  process.exit(1);
});

// Prometheus metrics on their own port (./metrics.ts) — never through the
// ingress that routes PORT.
// Left open through the shutdown, so `ordinate_draining 1` can be scraped.
if (cfg.metricsPort !== null) {
  startMetricsServer(cfg.metricsPort, host).then(
    () => {
      app.log.info({ port: cfg.metricsPort }, 'metrics listening');
    },
    (err: unknown) => {
      app.log.fatal({ err }, 'metrics listen failed');
      process.exit(1);
    },
  );
}

let stopping = false;
let budgetEnds = 0;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) {
      // A second signal before the budget is spent would be the native abort the
      // sequence avoids; after it (a wedged worker, a local Ctrl-C), it ends the process.
      if (Date.now() >= budgetEnds) process.exit(process.exitCode ?? 1);
      app.log.warn({ signal: sig }, 'already shutting down');
      return;
    }
    stopping = true;
    budgetEnds = Date.now() + cfg.pod.shutdownGraceMs;
    void shutdown(app, cfg.pod.shutdownGraceMs, app.log).then((survivors) => {
      if (!survivors.length) process.exit(0);
      // Never process.exit around a live worker: that IS the abort. Exit 1 once it
      // has gone; the kubelet's SIGKILL after its grace ends a wedged one first.
      app.log.error({ orgs: survivors }, 'DuckDB still running at the shutdown deadline (an org worker, or `s3` for the credential lookup); waiting for it');
      process.exitCode = 1;
      void Promise.all([closeAll(Date.now() + 3_600_000), s3.close(Date.now() + 3_600_000)]).then(() => process.exit(1));
    });
  });
}
