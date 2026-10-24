// Self-check: the shutdown waits for detached work that STARTS while it waits
// (docs/pod-lifecycle, step 5). A refresh URL's job lands, then its follow-ups
// (afterRefresh) are tracked, and those start refreshDependents — each tracked
// only once the one before it has settled. A wait over a snapshot of the set
// returned with them still running, the pool ended under them, and the pods
// logged "Cannot use a pool after calling end on the pool".
//
//   npm run build:ts && node scripts/test-shutdownWork.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const lifecycle: typeof import('../src/server/lifecycle') = require('../src/server/lifecycle');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // NEGATIVE CONTROL: the snapshot wait misses work tracked by work it waited for.
  let late = false;
  lifecycle.trackWork(sleep(20).then(() => lifecycle.trackWork(sleep(150).then(() => { late = true; }))));
  await Promise.allSettled(lifecycle.pendingWork());
  ok('NEGATIVE CONTROL: a wait over a snapshot returns with the nested work still running', !late && lifecycle.pendingWork().length === 1);
  await lifecycle.settleWork();

  // The shutdown itself.
  const { shutdown } = require('../src/server/shutdown') as typeof import('../src/server/shutdown');
  const { fastify } = require('fastify') as typeof import('fastify');
  const app = fastify({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  let done = false;
  lifecycle.trackWork(sleep(20).then(() => lifecycle.trackWork(sleep(20).then(() => lifecycle.trackWork(sleep(150).then(() => { done = true; }))))));
  const t0 = Date.now();
  const left = await shutdown(app, 5000, app.log);
  ok(`shutdown: work tracked while it waited (three hops deep) finished before it returned (${Date.now() - t0} ms)`,
    done && left.length === 0 && lifecycle.pendingWork().length === 0, `${done} ${JSON.stringify(left)} ${lifecycle.pendingWork().length}`);
}

main()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(finish);
