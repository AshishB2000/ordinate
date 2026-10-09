// Preload for scripts/test-refreshLock.ts — `node -r scripts/refreshLockPodPreload.js
// src/server/main.js`. NOT a suite (no `test-` prefix): it turns a real server
// process into an observable pod for the cross-pod refresh lock (L0.4), without
// one line of test code in src/:
//
//   • every dataset refresh appends `start` / `end` lines to REFRESH_TEST_PROBE
//     (O_APPEND; the file both pods share) and is held REFRESH_TEST_SLOW_MS
//     between them, so two pods' refreshes of one dataset WOULD overlap;
//   • while the file REFRESH_TEST_FAIL exists, a refresh fails after its hold
//     (the lock must still be released);
//   • REFRESH_TEST_LOCK_OFF=1 keeps the pod from ever taking the lock — the
//     negative control: two such pods both refresh.

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';

const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const lock: typeof import('../src/server/jobs/refreshLock') = require('../src/server/jobs/refreshLock');

const env = process.env;
const PROBE = env.REFRESH_TEST_PROBE ?? '';
const FAIL = env.REFRESH_TEST_FAIL ?? '';
const SLOW_MS = Number(env.REFRESH_TEST_SLOW_MS) || 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (o: Record<string, unknown>): void => fs.appendFileSync(PROBE, JSON.stringify({ pod: process.pid, at: Date.now(), ...o }) + '\n');

const real = refresh.refreshDataset;
// refreshJob calls it through the module's exports, so this wins.
(refresh as { refreshDataset: typeof real }).refreshDataset = async (projectId, id, walk) => {
  line({ kind: 'start', id });
  await sleep(SLOW_MS);
  if (FAIL && fs.existsSync(FAIL)) {
    line({ kind: 'end', id, ok: false });
    throw new Error('simulated refresh failure');
  }
  const r = await real(projectId, id, walk);
  line({ kind: 'end', id, ok: r.ok });
  return r;
};

if (env.REFRESH_TEST_LOCK_OFF === '1') {
  // app.ts calls it through the module's exports at onReady: the pool never arrives.
  (lock as { useRefreshLockDb: typeof lock.useRefreshLockDb }).useRefreshLockDb = () => undefined;
}
