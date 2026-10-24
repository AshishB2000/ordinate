// One-at-a-time work held as a lease record, not a connection (src/app/runLease.ts),
// and the pipeline runs on it (src/app/pipelineRunner.ts; docs/any-pod/00-design.md §3.12):
//
//   1. a held lease refuses a second holder; a lease whose `until` has passed is taken over;
//      release lets go only of the caller's own lease;
//   2. this pod runs at most MAX_PIPELINE_RUNS pipelines at once — the rest wait their turn;
//   3. THE CRASH (review H1): with every database call failing, a due pipeline's tick and a
//      manual run both RESOLVE (`ok: false`), and nothing rejects unhandled. Before the fix,
//      tick's `void runFrom(…)` rejected out of a failing advisory-lock connect and Node exited.
//
// No database needed (the failing pool is a stub).
//
//   npm run build:ts && node scripts/test-runLease.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-runlease-'));
process.env.ORDINATE_LOCAL_DIR = TMP;

const lease: typeof import('../src/app/runLease') = require('../src/app/runLease');
const runner: typeof import('../src/app/pipelineRunner') = require('../src/app/pipelineRunner');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const pstore: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
const refreshLock: typeof import('../src/server/jobs/refreshLock') = require('../src/server/jobs/refreshLock');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

(async () => {
  // 1. The lease.
  const file = path.join(TMP, 'projects', 'lease-test.json');
  let release!: () => void;
  const held = lease.withLease(file, () => new Promise<string>((r) => { release = () => r('first'); }));
  await sleep(50);
  const second = await lease.withLease(file, async () => 'second');
  release();
  const first = await held;
  const third = await lease.withLease(file, async () => 'third');
  ok('a held lease refuses a second holder; once released, the next one runs', first.ran && !second.ran && third.ran && third.value === 'third');
  fs.writeFileSync(file, JSON.stringify({ v: 1, claim: 'gone-pod', until: 0 }));
  const taken = await lease.withLease(file, async () => 'taken');
  ok('a lease whose pod went away (until passed) is taken over', taken.ran);
  fs.writeFileSync(file, JSON.stringify({ v: 1, claim: 'live-pod', until: Date.now() + 60_000 }));
  ok('control: a live lease is not', !(await lease.withLease(file, async () => 'x')).ran);
  await lease.release(file, 'not-mine');
  ok('release lets go only of the caller\'s own lease', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).claim === 'live-pod');

  // 2. The per-pod slots.
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => runner.inPipelineSlot(async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(40);
    active--;
  })));
  ok(`at most ${runner.MAX_PIPELINE_RUNS} pipeline runs at once on a pod; the rest wait and still run (peak ${peak})`, peak === runner.MAX_PIPELINE_RUNS && active === 0);

  // 3. The crash: every database call fails — the lease clock, and (the old design) the advisory-lock pool.
  const failing = {
    query: async () => { throw new Error('connection pool exhausted'); },
    connect: async () => { throw new Error('timeout exceeded when trying to connect'); },
  } as unknown as import('pg').Pool;
  lease.useLeaseDb(failing);
  refreshLock.useRefreshLockDb(failing);
  const p = await projects.createProject('Due pipeline');
  await pstore.update(p.id, (s) => { s.schedule = { cron: '* * * * *', tz: 'UTC', paused: false, since: new Date(Date.now() - 3_600_000).toISOString() }; });
  const manual = await runner.runFrom(p.id, [], 'manual').catch((e: Error) => ({ rejected: e.message }));
  ok('a manual run with the database down answers ok:false — it never rejects', 'ok' in manual && manual.ok === false, JSON.stringify(manual));
  const ticked = await runner.tick(Date.now()).then(() => 'resolved', (e: Error) => 'rejected: ' + e.message);
  await sleep(300); // the tick's own `void runFrom(…)`
  ok('a due pipeline\'s tick with the database down resolves, and nothing rejects unhandled (the pod lives)', ticked === 'resolved' && unhandled === 0, JSON.stringify({ ticked, unhandled }));
  lease.useLeaseDb(null);
  refreshLock.useRefreshLockDb(null);
})()
  .catch((err) => ok('the suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
