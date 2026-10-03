// Server entry point: `npm run server` → `node src/server/main.js`.
// Reads the environment once, listens, and closes cleanly on SIGTERM/SIGINT
// (what Kubernetes and Compose send on a rollout).

import { buildApp, registerHandlers } from './app';
import { enterServerMode, identityFor } from './context';
import { env, type ServerEnv } from './env';
import { forbidSyncOnMainThread } from '../engine/duckdb';

let cfg: ServerEnv;
try {
  cfg = env();
  // The gate on dev sign-in: refuses prod with AUTH_MODE=dev or unset.
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
registerHandlers();
const app = buildApp(cfg);

// dev binds loopback only: dev mode runs every request as an admin (context.ts),
// which must not be reachable from the LAN. prod runs in a container behind an
// ingress, so it binds every interface.
const host = cfg.env === 'dev' ? '127.0.0.1' : '0.0.0.0';

app.listen({ port: cfg.port, host }).catch((err: unknown) => {
  app.log.fatal({ err }, 'listen failed');
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    app.log.info({ signal: sig }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
