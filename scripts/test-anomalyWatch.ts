'use strict';

// Self-check for the anomaly WATCH diff — src/anomalyWatch.ts.
//
// The watch's whole value is that it tells you about something once. A diff that
// gets this wrong does not fail loudly; it just becomes noise, and a person
// turns the feature off. So the three properties pinned here are the ones that
// decide whether it stays useful:
//
//   1. A FIRST run alerts everything. There is no previous set, and every
//      finding really is new to the person reading it.
//   2. A SECOND run alerts only what appeared since. Re-reporting a standing
//      anomaly every hour is exactly the failure mode.
//   3. A RESOLVED anomaly drops out of storage. If it lingered, the day it came
//      back would not register as new — the alert would be silently lost — and
//      the stored list would grow forever.
//
// The key is deliberately NOT the detail string. `Anomaly.detail` embeds
// app-computed figures, so it changes on every refresh even when the finding is
// the same one; keying on it would report everything as new, every time. That is
// asserted directly below, because it is the mistake a future edit is most
// likely to make.
//
//   npm run build:ts && node scripts/test-anomalyWatch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const watch: typeof import('../src/analysis/anomalyWatch') = require('../src/analysis/anomalyWatch');
const { anomalyKey, diffAnomalies, sanitizeAnomalyKeys, watchMessage, MAX_KEYS } = watch;


function anom(kind: string, column?: string, detail = 'x', severity: 'info' | 'warn' = 'warn'): any {
  return { kind, column, severity, detail, facts: {} };
}

// ── The key ──────────────────────────────────────────────────────────────────

ok('the key is kind + column + severity',
  anomalyKey(anom('outlier', 'amount')) === 'outlier|amount|warn');
ok('a column-less anomaly still gets a stable key',
  anomalyKey(anom('row_spike')) === 'row_spike||warn');
ok('severity is part of it, so a warn and an info on one column are distinct',
  anomalyKey(anom('outlier', 'amount', 'x', 'warn')) !== anomalyKey(anom('outlier', 'amount', 'x', 'info')));

// THE trap: detail carries the numbers, which move on every single refresh.
ok('the key IGNORES detail, so the same finding survives its figures changing',
  anomalyKey(anom('outlier', 'amount', '3 values above 1,204'))
    === anomalyKey(anom('outlier', 'amount', '5 values above 2,860')));

// ── First run, second run ────────────────────────────────────────────────────

const runOne = [anom('outlier', 'amount'), anom('dominant', 'region')];
const first = diffAnomalies(runOne, undefined);
ok('a first run alerts everything', first.newKeys.length === 2);
ok('…and stores exactly what it found', first.keep.length === 2);

const second = diffAnomalies(runOne, first.keep);
ok('an unchanged second run alerts nothing', second.newKeys.length === 0);
ok('…and still stores them, so they stay known', second.keep.length === 2);

const withNew = diffAnomalies([...runOne, anom('gap', 'date')], first.keep);
ok('only the genuinely new finding is alerted', withNew.newKeys.join(',') === 'gap|date|warn',
  withNew.newKeys.join(','));
ok('…and all three are stored', withNew.keep.length === 3);

// The figures moved but the findings did not: still silent. This is the assertion
// that would fail if the key ever went back to including `detail`.
const sameFindingsNewNumbers = [anom('outlier', 'amount', 'now 91 values'), anom('dominant', 'region', 'now 72%')];
ok('a run whose numbers moved but whose findings did not is silent',
  diffAnomalies(sameFindingsNewNumbers, first.keep).newKeys.length === 0);

// ── Resolved anomalies drop out ──────────────────────────────────────────────

const resolved = diffAnomalies([anom('outlier', 'amount')], withNew.keep);
ok('a resolved anomaly is not alerted', resolved.newKeys.length === 0);
ok('…and drops out of storage rather than lingering', resolved.keep.length === 1,
  resolved.keep.join(','));
ok('…so when it comes back it counts as new again',
  diffAnomalies([anom('outlier', 'amount'), anom('gap', 'date')], resolved.keep).newKeys.join(',')
    === 'gap|date|warn');

// ── Degenerate inputs ────────────────────────────────────────────────────────

ok('no anomalies at all is silent and stores nothing',
  diffAnomalies([], first.keep).newKeys.length === 0 && diffAnomalies([], first.keep).keep.length === 0);
ok('a non-array current is handled, not thrown', diffAnomalies(undefined as any, []).newKeys.length === 0);
ok('a non-array previous is treated as no previous',
  diffAnomalies(runOne, 'nope' as any).newKeys.length === 2);
ok('duplicate findings collapse to one key',
  diffAnomalies([anom('outlier', 'amount'), anom('outlier', 'amount')], []).keep.length === 1);

// ── The cap ──────────────────────────────────────────────────────────────────

const many = Array.from({ length: MAX_KEYS + 50 }, (_, i) => anom('outlier', 'c' + i));
ok(`storage is capped at ${MAX_KEYS}`, diffAnomalies(many, []).keep.length === MAX_KEYS);
ok('sanitize caps a stored list too', (sanitizeAnomalyKeys(many.map(anomalyKey)) || []).length === MAX_KEYS);
ok('sanitize drops non-strings and duplicates',
  (sanitizeAnomalyKeys(['a', 'a', 1, null, 'b']) || []).join(',') === 'a,b');
ok('sanitize turns an empty or non-array list into undefined',
  sanitizeAnomalyKeys([]) === undefined && sanitizeAnomalyKeys('x') === undefined);

// ── The sentence ─────────────────────────────────────────────────────────────

ok('one anomaly reads as singular', watchMessage('Q3 Sales', 1) === '1 new anomaly in "Q3 Sales".');
ok('more than one reads as plural', watchMessage('Q3 Sales', 3) === '3 new anomalies in "Q3 Sales".');

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} anomaly-watch check(s) FAILED.`);
  process.exit(1);
}
console.log('All anomaly-watch checks passed.');
