// Preload for the multi-pod suites (test-anyPod, test-sharedCounters) —
// `node -r scripts/anyPodPreload.js src/server/main.js`. NOT a suite. It makes a
// real server process observable, and lets a suite switch a guard OFF for its
// negative control, without one line of test code in src/. Each switch is an
// env var; unset, the pod is the real thing.
//
//   ANYPOD_IDENTITY=1         dev auth reads the caller from x-test-user / x-test-org
//   ANYPOD_FAST_RUNNER=1      scheduled jobs poll every 200 ms
//   ANYPOD_MEMORY_COUNTERS=1  NEGATIVE CONTROL: the abuse counters stay in this process
//
// Later steps add their own switches here.

export {}; // module scope — sibling scripts share top-level names

const env = process.env;
const context: typeof import('../src/server/context') = require('../src/server/context');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');

const header = (v: string | string[] | undefined, dflt: string): string => (typeof v === 'string' && v ? v : dflt);

if (env.ANYPOD_IDENTITY === '1') {
  // main.ts calls `identityFor(cfg)` through the module's exports, so this wins.
  (context as { identityFor: typeof context.identityFor }).identityFor = () => (h) => ({
    user: { email: header(h['x-test-user'], 'dev@local'), role: 'admin' },
    org: { id: header(h['x-test-org'], 'default') },
  });
}

if (env.ANYPOD_FAST_RUNNER === '1') runner.setTimingForTest({ pollMs: 200, leaseMs: 5_000 });

if (env.ANYPOD_MEMORY_COUNTERS === '1') {
  const real = counters.useCounterDb;
  (counters as { useCounterDb: typeof real }).useCounterDb = () => real(null);
}
