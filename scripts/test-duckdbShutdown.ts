// Self-check for the DuckDB half of the server's shutdown (docs/pod-lifecycle):
// how src/server/shutdown.ts stops every org worker without `terminate()`.
//
// 1. A query with NO abort signal — what a scheduled-job claim, a subscription
//    or a republish runs — keeps its worker busy: `closeEvery(deadline)` does
//    not wait past its deadline and names the org that is still alive
//    (NEGATIVE CONTROL: the close alone cannot stop a running query).
// 2. `interruptAll()` stops it at once — the running call is interrupted, the
//    queued ones are skipped — and the queued close then exits the worker well
//    before closeEvery's deadline.
// 3. After it, a call rejects `unavailable` and starts no worker; a compute
//    lease is refused too (a thread must never fall back to its own DuckDB).
//
// One process, one switch: interruptAll() is final, so it gets its own suite.
//
//   npm run build:ts && node scripts/test-duckdbShutdown.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const context: typeof import('../src/server/context') = require('../src/server/context');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-duckstop-'));
const LONG = 'SELECT count(*) AS n FROM range(10000000000) t(x) WHERE x % 7 = 3';
const who = { user: { email: 'jobs@system', role: 'admin' as const }, org: { id: 'a' } };
// No signal: the runner's `runInContext(systemIdentity(org), …)` has none either.
const asJob = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(who, 'job:test', fn);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  // A 60 s per-query limit, as in production: only the shutdown can explain a prompt stop.
  const pool = poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '256MiB', threads: 1, queryTimeoutMs: 60_000, idleMs: 60_000 });
  await asJob(() => duck.queryAsync('SELECT 1 AS warm'));

  // 0. A job's Cancel interrupts the DuckDB call it is in (jobs.start → context.withAbort).
  const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
  const long = asJob(async () => jobs.submit({ kind: 'sql-save', label: 'a long query', run: () => duck.queryAsync(LONG) }));
  const job = await long;
  job.done.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
  ok('NEGATIVE CONTROL: left alone, the job is still running at 1 s (its query does not just finish)', jobs.get(job.id)?.state === 'running');
  let t0 = Date.now();
  jobs.cancel(job.id);
  await job.done.catch(() => undefined);
  ok(`a job's Cancel interrupts its query: cancelled in ${Date.now() - t0} ms`, jobs.get(job.id)?.state === 'cancelled' && Date.now() - t0 < 500, JSON.stringify(jobs.get(job.id)));

  const running = codeOf(asJob(() => duck.queryAsync(LONG)));
  const queued = codeOf(asJob(() => duck.execAsync('CREATE TABLE never_made AS SELECT 1 AS x')));
  await new Promise((r) => setTimeout(r, 300));

  // 1. The close alone: queued behind a query nobody can cancel.
  t0 = Date.now();
  const control = await (require('../src/engine/duckdbClose') as typeof import('../src/engine/duckdbClose')).closeEvery(Date.now() + 400);
  const controlMs = Date.now() - t0;
  ok(`NEGATIVE CONTROL: a close queued behind a signal-less query is still waiting at the deadline (${controlMs} ms), naming the org`,
    JSON.stringify(control) === '["a"]' && controlMs >= 350 && controlMs < 1500, `${JSON.stringify(control)} ${controlMs} ms`);

  // 2. interruptAll, then the close the shutdown sequence makes.
  t0 = Date.now();
  duck.interruptAll();
  const survivors = await duck.closeAll(Date.now() + 10_000);
  const closeMs = Date.now() - t0;
  ok(`interruptAll + closeAll: every worker gone in ${closeMs} ms, far inside the 10 s deadline`, survivors.length === 0 && closeMs < 3000, `${JSON.stringify(survivors)} ${closeMs} ms`);
  ok('…the signal-less query settled (no caller is left waiting)', (await running) !== 'RESOLVED', await running);
  ok('…and the queued call was refused, never run', (await queued) !== 'RESOLVED', await queued);

  // 3. Nothing starts again.
  const late = await codeOf(asJob(() => duck.queryAsync('SELECT 1 AS late')));
  ok("a call after interruptAll rejects 'unavailable'", late === 'unavailable', late);
  ok('…and started no worker', pool.orgs().length === 0, JSON.stringify(pool.orgs()));
  const leaseCode = await codeOf(asJob(async () => duck.leasePort()));
  ok("a compute lease after interruptAll is refused 'unavailable' (a thread never falls back to its own DuckDB)", leaseCode === 'unavailable', leaseCode);

  // 4. The S3 credential instance runs on the MAIN thread (src/engine/s3.ts): a lookup
  //    still running at the deadline is a survivor, never exited around (review C2).
  const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
  const { shutdown } = require('../src/server/shutdown') as typeof import('../src/server/shutdown');
  const { fastify } = require('fastify') as typeof import('fastify');
  const app = fastify({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  s3.setResolvingForTest(new Promise(() => undefined)); // a lookup that never settles
  t0 = Date.now();
  const left = await shutdown(app, 1000, app.log);
  ok(`shutdown: an S3 credential lookup still running at the deadline is a survivor (exit 1), not an exit 0 (${Date.now() - t0} ms)`,
    left.includes('s3') && Date.now() - t0 < 2500, `${JSON.stringify(left)} ${Date.now() - t0}`);
  s3.setResolvingForTest(null);
  ok('NEGATIVE CONTROL: with no lookup running, the S3 close leaves no survivor', await s3.close(Date.now() + 100));
}

main()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
