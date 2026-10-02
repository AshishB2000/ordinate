// Server entry point: `npm run server` → `node src/server/main.js`.
// Reads the environment once, listens, and closes cleanly on SIGTERM/SIGINT
// (what Kubernetes and Compose send on a rollout).

import { buildApp } from './app';
import { env, type ServerEnv } from './env';

let cfg: ServerEnv;
try {
  cfg = env();
} catch (err) {
  // One line, no stack: the operator needs the variable name, not a trace.
  process.stderr.write(`ordinate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const app = buildApp(cfg);

// dev binds loopback only: dev mode will run every request as an admin (T0.3),
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
