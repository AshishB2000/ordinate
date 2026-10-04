// `node src/server/db/migrateMain.js`: apply the schema migrations and exit —
// the Helm chart's pre-install/pre-upgrade Job (T7.2).
//
// The same `migrate()` the server runs in `onReady` before it listens
// (../app.ts), under the same advisory lock: pods that boot while this runs
// wait on the lock, then find every version recorded and apply nothing. The
// Job only moves the work (and its failure) ahead of the rollout, so a bad
// migration stops `helm upgrade` while the old pods keep serving.
//
// Reads the whole environment through env() like the server: a bad value in
// the release's config fails here, before any pod rolls. Exits 0 when the
// schema is current, 1 with one scrubbed line otherwise.

import { env } from '../env';
import { createPool, scrubbed } from './pool';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const url = env().databaseUrl;
  if (!url) throw new Error('DATABASE_URL is required to migrate');
  const pool = createPool(url, () => undefined);
  try {
    const r = await migrate(pool);
    process.stdout.write(`${JSON.stringify({ msg: 'migrations current', applied: r.applied, total: r.total, ms: Math.round(r.ms) })}\n`);
  } catch (err) {
    throw scrubbed(err, url);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ordinate migrate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
