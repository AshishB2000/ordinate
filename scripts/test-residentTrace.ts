// Self-check for src/residentTrace.ts — the fallback counter. Pure module, no
// Electron/fs stub needed. Same house style: ok() counter, no framework,
// process.exit(1) on failure.
//
// The property under test is NOT "it counts". It is the distinction the module
// exists for: a fallback that was DECIDED ('skipped') must stay silent, and a
// fallback that happened after the SQL path was actually attempted ('failed')
// must warn — once, so a systematic failure does not flood the log into
// uselessness.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/residentTrace.ts.
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');


// Capture console.warn so the assertions can be about what a user would see.
const realWarn = console.warn;
let warnings: string[] = [];
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), warnings: warnings.slice() };
  } finally {
    console.warn = realWarn;
  }
}

// ── Counting ─────────────────────────────────────────────────────────────────
trace.reset();
trace.record('metric', 'resident');
trace.record('metric', 'resident');
trace.record('metric', 'skipped');
let snap = trace.snapshot();
ok('counts resident hits', snap.metric.resident === 2);
ok('counts skips', snap.metric.skipped === 1);
ok('no failureCount() yet', snap.metric.failed === 0);
ok('failureCount agrees', trace.failureCount() === 0);

trace.reset();
trace.record('metric', 'resident');
trace.record('anomalies', 'skipped');
snap = trace.snapshot();
ok('ops are counted separately', snap.metric.resident === 1 && snap.anomalies.skipped === 1);
ok('an untouched op has no slot', snap.datasetPage === undefined);

// ── snapshot() hands out a copy, not the live state ──────────────────────────
trace.reset();
trace.record('metric', 'resident');
const taken = trace.snapshot();
taken.metric.resident = 999;
ok('snapshot is a copy — mutating it cannot corrupt the counters',
  trace.snapshot().metric.resident === 1);

// ── The distinction: 'skipped' is silent, 'failed' warns ─────────────────────
trace.reset();
let cap = captureWarnings(() => {
  trace.record('metric', 'skipped');
  trace.record('metric', 'skipped');
  trace.record('metric', 'resident');
});
ok("a decided fallback ('skipped') never warns — most datasets are small and " +
  'a log nobody reads is worse than no log', cap.warnings.length === 0);

trace.reset();
cap = captureWarnings(() => trace.record('metric', 'failed', 'aggregation=sum'));
ok("an attempted-then-null fallback ('failed') warns", cap.warnings.length === 1);
ok('the warning names the op', cap.warnings[0].includes('metric'));
ok('the warning carries the detail', cap.warnings[0].includes('aggregation=sum'));
ok('the warning says what it costs, not just that it happened',
  /slower/.test(cap.warnings[0]));

// ── Rate limit: one per op per process ───────────────────────────────────────
// The failure being caught is systematic — every call fails, not one — so the
// first line carries everything the thousandth would.
trace.reset();
cap = captureWarnings(() => {
  for (let i = 0; i < 500; i += 1) trace.record('metric', 'failed', 'call ' + i);
});
ok('500 identical failureCount() warn exactly once', cap.warnings.length === 1);
ok('...but all 500 are still counted', trace.snapshot().metric.failed === 500);
ok('...and the LAST detail is retained, not the first',
  trace.snapshot().metric.lastFailure === 'call 499');

trace.reset();
cap = captureWarnings(() => {
  trace.record('metric', 'failed');
  trace.record('anomalies', 'failed');
  trace.record('datasetPage', 'failed');
});
ok('the rate limit is PER OP — a second broken path is not hidden by the first',
  cap.warnings.length === 3);
ok('failureCount sums across ops', trace.failureCount() === 3);

// ── detail is optional ───────────────────────────────────────────────────────
trace.reset();
cap = captureWarnings(() => trace.record('anomalies', 'failed'));
ok('a detail-free failure still warns', cap.warnings.length === 1);
ok('...with no empty parens', !cap.warnings[0].includes('()'));
ok('lastFailure is null when no detail was given',
  trace.snapshot().anomalies.lastFailure === null);

// ── reset() clears the warn latch too ────────────────────────────────────────
// Otherwise a test suite that resets counts would silently stop warning.
trace.reset();
captureWarnings(() => trace.record('metric', 'failed'));
trace.reset();
cap = captureWarnings(() => trace.record('metric', 'failed'));
ok('reset() re-arms the warning, not just the counters', cap.warnings.length === 1);

trace.reset();

if (failureCount()) {
  console.error('\n' + failureCount() + ' resident-trace check(s) FAILED');
  process.exit(1);
}
console.log('\nAll resident-trace checks passed.');
