// Preload for scripts/test-jobs-pods.ts — `node -r scripts/jobsPodPreload.js
// src/server/main.js`. NOT a suite (no `test-` prefix): it turns a real server
// process into an observable pod, without one line of test code in src/:
//
//   • Electron is blocked, as in test-server-boot;
//   • dev auth reads the caller from x-test-org / x-test-user, so streams can be
//     bound to different orgs and users;
//   • a short poll and lease (JOBS_TEST_POLL_MS / JOBS_TEST_LEASE_MS);
//   • two test kinds and an after-tick hook, each appending one JSON line per
//     side effect to JOBS_TEST_PROBE (O_APPEND; the counter both pods share):
//       test:probe  logs a run, then publishes the event matrix the suite checks;
//       test:slow   logs start, sleeps JOBS_TEST_SLOW_MS, logs end (the kill test);
//       tick        the REAL scheduler tick's afterTick hook logs each tick, per org.

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';

const Module: any = require('module'); // any: the loader hook has no public type
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');

const env = process.env;
const PROBE = env.JOBS_TEST_PROBE ?? '';
const CLIENTS = (env.JOBS_TEST_CLIENTS ?? '').split(',').filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = (): number => performance.timeOrigin + performance.now();
const line = (o: Record<string, unknown>): void => fs.appendFileSync(PROBE, JSON.stringify({ pod: process.pid, at: now(), ...o }) + '\n');
const header = (v: string | string[] | undefined, dflt: string): string => (typeof v === 'string' && v ? v : dflt);

// main.ts calls `identityFor(cfg)` through the module's exports, so this wins.
(context as { identityFor: typeof context.identityFor }).identityFor = () => (h) => ({
  user: { email: header(h['x-test-user'], 'dev@local'), role: 'admin' },
  org: { id: header(h['x-test-org'], 'default') },
});

runner.setTimingForTest({ pollMs: Number(env.JOBS_TEST_POLL_MS), leaseMs: Number(env.JOBS_TEST_LEASE_MS) });

runner.defineJob('test:probe', {
  everyMs: 3_600_000,
  run: async () => {
    const org = context.ctx().org.id;
    line({ kind: 'probe', org });
    sse.publish({ org }, 'test:org', { pod: process.pid });
    sse.publish({ org, user: 'dev@local' }, 'test:user', { pod: process.pid });
    for (const client of CLIENTS) sse.publish({ org, user: 'dev@local', client }, 'test:client', { client });
    // A real tab id with the WRONG user: its stream is bound to dev@local.
    for (const client of CLIENTS) sse.publish({ org, user: 'other@local', client }, 'test:spoof', { client });
    sse.publish({ org }, 'test:big', { blob: 'x'.repeat(20_000) }); // > 8000 bytes: goes by reference
    for (let i = 0; i < 50; i++) {
      sse.publish({ org }, 'test:lat', { i, pod: process.pid, sentAt: now() });
      await sleep(5);
    }
  },
});

runner.defineJob('test:slow', {
  everyMs: 3_600_000,
  run: async () => {
    line({ kind: 'slow-start', org: context.ctx().org.id });
    await sleep(Number(env.JOBS_TEST_SLOW_MS));
    line({ kind: 'slow-end', org: context.ctx().org.id });
  },
});

scheduler.afterTick(() => line({ kind: 'tick', org: context.ctx().org.id }));
