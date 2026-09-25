'use strict';

// Self-check for the alert RULE — src/analysis/alerts.ts.
//
// This is the half of alerts that decides things, and every way it can be wrong
// is quiet. A rule that fires twice is noise and gets switched off; a rule that
// never fires looks exactly like a rule with nothing to report. So the
// properties pinned here are the ones nobody would notice breaking:
//
//   1. A THRESHOLD FIRES ONCE PER CROSSING. It says its piece when the metric
//      goes into breach and then stays quiet for as long as it is still in
//      breach — and it re-arms when the metric comes back, so the NEXT crossing
//      is heard. This is ./anomalyWatch's lesson applied to a number.
//   2. A CHANGE RULE IS NOT EDGE-TRIGGERED, deliberately. It compares two points
//      in time, so every refresh that meets the condition is a new fact.
//   3. QUIET HOURS AND SNOOZE SUPPRESS THE MESSAGE, NEVER THE STATE. A threshold
//      that crossed at 3am must not fire a stale alert at 9am as though it had
//      just happened — so the edge still advances while the banner is held back.
//   4. THE MESSAGE CARRIES THE APP'S OWN NUMBER, formatted exactly as the KPI
//      card formats it. An alert saying "4.9M" under a card reading "5.2M" is
//      worse than no alert, so `fmtMetric` is asserted against a local copy of
//      the renderer's `_fmtVal` — the differential that keeps the mirror honest.
//   5. THE EVALUATED METRIC IS THE DASHBOARD'S METRIC. `computeMetric` is the
//      reference every metric path in this app is measured against, and the
//      figure that reaches an event must be `Object.is` to it — not rounded, not
//      re-derived, not recomputed on the way through.
//
//   npm run build:ts && node scripts/test-alerts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled siblings, required (not imported) so this file does not
// pull Electron in through the module graph. alerts.ts and metricValue.ts are
// both pure; alertStore.ts (which touches disk) is deliberately NOT loaded here.
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const {
  alertMessage, changeHit, changePct, digestMessage, evaluateRule, fmtMetric, fmtPct,
  inQuietHours, isSnoozed, sanitizeEvent, sanitizeRule, suggestRuleName, thresholdBreached,
  wouldFire, MAX_HISTORY,
} = alerts;

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const DS_ID = '22222222-2222-4222-8222-222222222222';
const EV_ID = '44444444-4444-4444-8444-444444444444';
const NOON = Date.parse('2026-09-20T12:00:00.000Z');

function rule(over: any = {}): any {
  return sanitizeRule({
    id: RULE_ID,
    name: 'Revenue below 6M',
    datasetId: DS_ID,
    metric: { column: 'revenue', aggregation: 'sum' },
    compare: 'threshold',
    threshold: { op: '<', value: 6_000_000 },
    enabled: true,
    ...over,
  });
}

/** One evaluation at `now`, with a fresh event id. */
function step(r: any, value: number | null, now = NOON, extra: any = {}): any {
  return evaluateRule({ rule: r, value, now, eventId: EV_ID, ...extra });
}

// ── Sanitizing ───────────────────────────────────────────────────────────────

ok('a well-formed threshold rule survives', Boolean(rule()));
ok('a rule with a non-UUID id is rejected', sanitizeRule({ ...rule(), id: 'nope' }) === null);
ok('a rule with a non-UUID dataset is rejected', sanitizeRule({ ...rule(), datasetId: '../etc' }) === null);
ok('an unknown aggregation is rejected',
  sanitizeRule({ ...rule(), metric: { column: 'revenue', aggregation: 'median' } }) === null);
ok('a threshold rule with no threshold is rejected',
  sanitizeRule({ ...rule(), threshold: undefined }) === null);
ok('a threshold rule with an unknown operator is rejected',
  sanitizeRule({ ...rule(), threshold: { op: '~', value: 1 } }) === null);
ok('a change rule with a zero percent is rejected — it would fire on everything',
  sanitizeRule({ ...rule(), compare: 'change', threshold: undefined, change: { pct: 0, direction: 'down', vs: 'previous_refresh' } }) === null);
// A previous-period rule with no date column cannot be evaluated at ALL, so it
// must not reach the evaluator and fail there once per refresh, forever.
ok('a previous-period rule with no date column is rejected',
  sanitizeRule({ ...rule(), compare: 'change', threshold: undefined, change: { pct: 10, direction: 'down', vs: 'previous_period' } }) === null);
ok('…and is accepted once it names one',
  Boolean(sanitizeRule({ ...rule(), compare: 'change', threshold: undefined, change: { pct: 10, direction: 'down', vs: 'previous_period', periodColumn: 'order_date' } })));
// The whole-dataset anomaly scan the watch toggle always did — the ONE compare
// allowed an empty column.
ok('an anomaly rule may have no column (the whole-table scan)',
  Boolean(sanitizeRule({ ...rule(), compare: 'anomaly', threshold: undefined, metric: { column: '', aggregation: 'count' } })));
ok('…but a threshold rule may not',
  sanitizeRule({ ...rule(), metric: { column: '', aggregation: 'sum' } }) === null);
ok('a non-object is not a rule', sanitizeRule(null) === null && sanitizeRule(7) === null);
ok('an event with a non-UUID ruleId is rejected',
  sanitizeEvent({ id: EV_ID, ruleId: 'x', at: '', message: '' }) === null);

// ── The conditions ───────────────────────────────────────────────────────────

ok('< fires under the target', thresholdBreached(rule(), 5_000_000) === true);
ok('< does not fire above it', thresholdBreached(rule(), 7_000_000) === false);
ok('< does not fire ON it — that is what <= is for',
  thresholdBreached(rule(), 6_000_000) === false);
ok('<= does fire on it',
  thresholdBreached(rule({ threshold: { op: '<=', value: 6_000_000 } }), 6_000_000) === true);
ok('> and >= are the mirror image',
  thresholdBreached(rule({ threshold: { op: '>', value: 10 } }), 11) === true
  && thresholdBreached(rule({ threshold: { op: '>', value: 10 } }), 10) === false
  && thresholdBreached(rule({ threshold: { op: '>=', value: 10 } }), 10) === true);
// A metric that could not be computed is NOT a breach. Treating null as 0 would
// make every "below" rule fire the moment a source broke.
ok('a null metric never breaches a threshold', thresholdBreached(rule(), null) === false);

ok('the percent change is signed and relative to the previous value',
  changePct(90, 100) === -10 && changePct(110, 100) === 10);
// Infinity is not a sentence, and a 10%-rule firing on every move away from zero
// is noise. The absolute delta still rides on the event.
ok('a previous of zero yields null, never Infinity', changePct(5, 0) === null);
ok('a null on either side yields null', changePct(null, 100) === null && changePct(100, null) === null);
ok('a negative previous still gives a sensible magnitude — |previous| is the base',
  changePct(-90, -100) === 10);

const fall = rule({ compare: 'change', threshold: undefined, change: { pct: 10, direction: 'down', vs: 'previous_refresh' } });
ok('a down rule fires on a 12% fall', changeHit(fall, 88, 100) === true);
ok('…not on a 12% rise', changeHit(fall, 112, 100) === false);
ok('…and not on a 9% fall — the threshold is a floor, not a hint', changeHit(fall, 91, 100) === false);
ok('…but exactly 10% does fire', changeHit(fall, 90, 100) === true);
const either = rule({ compare: 'change', threshold: undefined, change: { pct: 10, direction: 'either', vs: 'previous_refresh' } });
ok('an "either" rule fires both ways',
  changeHit(either, 88, 100) === true && changeHit(either, 112, 100) === true);

// ── Threshold edge-triggering across a value series ──────────────────────────
//
// The series walks in, stays in, comes out, and goes back in. A correct rule
// speaks exactly twice: once per CROSSING.

{
  const series = [7_000_000, 5_200_000, 5_100_000, 5_000_000, 6_500_000, 4_000_000];
  let r = rule();
  const said: number[] = [];
  series.forEach((v, i) => {
    const res = step(r, v, NOON + i * 3600_000);
    r = res.rule;
    if (res.event) said.push(i);
  });
  ok('a threshold fires on the crossing and not again while it holds',
    said.join(',') === '1,5', said.join(','));
  ok('…which is two alerts for two crossings, not four for four breaches',
    said.length === 2);
  ok('…and the rule is left armed while still in breach', r.armed === true);

  // The re-arm is the half that is easy to forget, and forgetting it loses
  // every crossing after the first — silently.
  const out = step(r, 9_000_000, NOON);
  ok('coming back to normal clears the arm', out.rule.armed === undefined);
  ok('…and fires nothing on the way out', out.event === null);
  const back = step(out.rule, 1_000_000, NOON);
  ok('…so the next crossing is heard', back.event !== null);
}

ok('a disabled rule never fires however far it crosses',
  step(rule({ enabled: false }), 1, NOON).event === null);

// ── Change: per refresh, not per crossing ────────────────────────────────────

{
  let r = fall;
  const r1 = step(r, 88, NOON, { previous: 100 });
  r = r1.rule;
  const r2 = step(r, 77, NOON + 3600_000, { previous: 88 });
  ok('a change rule fires on EVERY refresh that meets it — it compares two moments',
    Boolean(r1.event) && Boolean(r2.event));
  const r3 = step(r2.rule, 77, NOON + 7200_000, { previous: 77 });
  ok('…and stays quiet on an unchanged refresh', r3.event === null);
  ok('…which is the case a dashboard refresh hits most often', r3.suppressed === false);
}

// ── Change vs the previous PERIOD, on a fixture with dates ───────────────────
//
// The period values are computed the way `alertStore.metricFor` computes them:
// the SAME `computeMetric` a KPI card uses, over the rows of one period. That is
// what makes "the previous period" mean the same thing here as it does on a card.

{
  const columns = [
    { name: 'order_date', type: 'date' as const },
    { name: 'revenue', type: 'number' as const },
  ];
  const rows: any[][] = [
    ['2026-09-18', 100], ['2026-09-18', 200],   // 300
    ['2026-09-19', 500], ['2026-09-19', 400],   // 900
    ['2026-09-20', 300], ['2026-09-20', 120],   // 420
  ];
  const at = (day: string): number | null => metricValue.computeMetric(
    columns,
    rows.filter((r) => r[0] === day),
    { column: 'revenue', aggregation: 'sum' },
  );
  const now = at('2026-09-20');
  const prev = at('2026-09-19');
  ok('the fixture periods fold to the app-computed sums', now === 420 && prev === 900);

  const periodRule = rule({
    compare: 'change',
    threshold: undefined,
    change: { pct: 50, direction: 'down', vs: 'previous_period', periodColumn: 'order_date' },
  });
  ok('a 53% period-over-period fall clears a 50% rule', changeHit(periodRule, now, prev) === true);
  ok('…and the same pair does not clear a 60% rule',
    changeHit(rule({
      compare: 'change', threshold: undefined,
      change: { pct: 60, direction: 'down', vs: 'previous_period', periodColumn: 'order_date' },
    }), now, prev) === false);

  const res = step(periodRule, now, NOON, { previous: prev });
  ok('the event carries the absolute delta as well as the percentage',
    res.event.delta === -480 && Math.abs(res.event.deltaPct + 53.333333333333336) < 1e-9,
    `${res.event.delta} / ${res.event.deltaPct}`);
  ok('…and names the previous PERIOD, not the previous refresh',
    res.event.message.indexOf('the previous period') >= 0, res.event.message);
}

// ── Anomaly delegation ───────────────────────────────────────────────────────
//
// The anomaly compare owns no diffing of its own: it hands the whole question to
// ./anomalyWatch, which already knows that "new" means BY KEY and that a
// resolved finding has to drop out of storage.

{
  const anom = (kind: string, column: string, detail: string): any =>
    ({ kind, column, severity: 'warn', detail, facts: {} });
  let r = rule({ compare: 'anomaly', threshold: undefined, metric: { column: 'revenue', aggregation: 'sum' } });

  const first = step(r, null, NOON, { anomalies: [anom('outlier', 'revenue', 'a')] });
  r = first.rule;
  ok('a first run reports everything — it is all new to the reader', Boolean(first.event));
  ok('…and stores the key', (r.anomalyKeys || []).join(',') === 'outlier|revenue|warn');

  // The detail string carries figures that move on every refresh. Keying on it
  // would report the same finding as new forever, which is the exact failure the
  // watch exists to avoid — so the SAME finding with new numbers is silent.
  const second = step(r, null, NOON, { anomalies: [anom('outlier', 'revenue', 'DIFFERENT numbers')] });
  ok('the same finding with different figures is not new', second.event === null);
  r = second.rule;

  const third = step(r, null, NOON, { anomalies: [anom('outlier', 'revenue', 'a'), anom('gap', 'revenue', 'b')] });
  ok('a genuinely new finding does fire', Boolean(third.event));
  ok('…and the message counts only the new one',
    third.event.message === '1 new anomaly in revenue.', third.event.message);
  r = third.rule;

  const fourth = step(r, null, NOON, { anomalies: [] });
  ok('a run with nothing found is silent', fourth.event === null);
  ok('…and drops the resolved keys, so their return counts as new',
    fourth.rule.anomalyKeys === undefined);
  const fifth = step(fourth.rule, null, NOON, { anomalies: [anom('outlier', 'revenue', 'a')] });
  ok('…which it does', Boolean(fifth.event));
}

// ── Quiet hours ──────────────────────────────────────────────────────────────
//
// LOCAL clock, because "don't wake me between 22:00 and 07:00" is about the
// user's night. Dates are constructed from local parts for the same reason.

{
  const local = (h: number): Date => new Date(2026, 8, 20, h, 0, 0);
  const night = rule({ quietHours: { from: 22, to: 7 } });
  ok('a wrapping window covers late evening', inQuietHours(night, local(23)) === true);
  ok('…and the small hours', inQuietHours(night, local(3)) === true);
  ok('…and stops at the `to` hour', inQuietHours(night, local(7)) === false);
  ok('…and starts at the `from` hour', inQuietHours(night, local(22)) === true);
  ok('…leaving the working day alone', inQuietHours(night, local(13)) === false);

  const lunch = rule({ quietHours: { from: 12, to: 14 } });
  ok('a same-day window is the plain half-open interval',
    inQuietHours(lunch, local(12)) === true
    && inQuietHours(lunch, local(13)) === true
    && inQuietHours(lunch, local(14)) === false);

  // from === to is stored as ABSENT, so it can never mean "quiet all day" —
  // which is what a naive `h >= from || h < to` would make it.
  ok('from === to means no quiet hours at all',
    rule({ quietHours: { from: 9, to: 9 } }).quietHours === undefined);
  ok('a rule with no window is never quiet', inQuietHours(rule(), local(3)) === false);

  // Suppression must advance the edge. Otherwise a 3am crossing fires a stale
  // alert at 9am claiming it just happened — and the real crossing is lost.
  const at3am = new Date(2026, 8, 20, 3, 0, 0).getTime();
  const held = step(night, 5_000_000, at3am);
  ok('a breach inside quiet hours sends nothing', held.event === null);
  ok('…and says so, rather than looking like a miss', held.suppressed === true);
  ok('…but still arms the rule, so 9am does not replay it', held.rule.armed === true);
  const morning = step(held.rule, 5_000_000, new Date(2026, 8, 20, 9, 0, 0).getTime());
  ok('…which it does not', morning.event === null);
}

// ── Snooze ───────────────────────────────────────────────────────────────────

{
  const until = new Date(NOON + 3600_000).toISOString();
  const snoozed = rule({ snoozedUntil: until });
  ok('a snoozed rule is snoozed', isSnoozed(snoozed, NOON) === true);
  ok('…and stops being so afterwards', isSnoozed(snoozed, NOON + 7200_000) === false);
  ok('an unparseable stamp is not a snooze', isSnoozed(rule({ snoozedUntil: 'soon' }), NOON) === false);
  const quiet = step(snoozed, 5_000_000, NOON);
  ok('a snooze suppresses the banner', quiet.event === null && quiet.suppressed === true);
  ok('…and, like quiet hours, still advances the edge', quiet.rule.armed === true);
}

// ── History, for the inbox sparkline ─────────────────────────────────────────

{
  let r = rule();
  for (let i = 0; i < MAX_HISTORY + 5; i += 1) r = step(r, 7_000_000 + i, NOON).rule;
  ok('history is capped', r.history.length === MAX_HISTORY);
  ok('…keeping the MOST RECENT values, oldest first',
    r.history[r.history.length - 1] === 7_000_000 + MAX_HISTORY + 4);
  // A quiet evaluation still writes, which is the whole reason the caller
  // persists a rule that did not fire.
  ok('a non-firing evaluation still records its point',
    step(rule(), 9_000_000, NOON).rule.history.join(',') === '9000000');
  ok('a metric that could not be computed records no point',
    step(rule(), null, NOON).rule.history === undefined);
}

// ── Formatting: the SAME formatter as the card ─────────────────────────────
//
// THE CHECK THAT MATTERS MOST TO A READER. The alert is about a KPI card, and a
// banner reading "5.19M" under a card reading "5.2M" is two numbers. There used
// to be a hand-kept copy of the renderer's _fmtVal here; both sides now call
// src/app/format.ts, so this pins that they still do, and what it prints.

{
  const { formatCompact } = require('../src/app/format') as typeof import('../src/app/format');
  const fs: typeof import('fs') = require('fs');
  const path: typeof import('path') = require('path');
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'hub.ts'), 'utf8');
  const fmtVal = hubSrc.slice(hubSrc.indexOf('function _fmtVal('), hubSrc.indexOf('\n}', hubSrc.indexOf('function _fmtVal(')));
  ok('the renderer\'s _fmtVal is OrdFormat.formatCompact', /return OrdFormat\.formatCompact\(v\);/.test(fmtVal), fmtVal);
  const cases = [
    0, 1, 7, 999, 1000, 1500, 9999, 10_000, 999_999, 1_000_000,
    5_194_598.73, 6_000_000, 999_999_999, 1_000_000_000, 4.5e9,
    -1500, -5_194_598.73, 0.5, 12.25,
  ];
  ok(`fmtMetric is formatCompact (${cases.length} cases)`, cases.every((v) => Object.is(fmtMetric(v), formatCompact(v))),
    cases.filter((v) => fmtMetric(v) !== formatCompact(v)).join(', '));
  const want: Array<[number, string]> = [
    [5_194_598.73, '5.2M'], [1500, '1.5K'], [-1500, '-1.5K'], [999, '999'], [12.25, '12.25'],
    // Rounding up to the next unit names that unit: never "1000.0K".
    [999_999, '1.0M'], [999_999_999, '1.0B'],
  ];
  for (const [v, text] of want) ok(`fmtMetric(${v}) is "${text}"`, fmtMetric(v) === text, fmtMetric(v));
  ok('…except for null, where a sentence needs a dash and a card does not',
    fmtMetric(null) === '—' && formatCompact(null) === '');
  ok('…and for a non-finite number, which is never a figure', fmtMetric(NaN) === '—');

  ok('a percentage is one decimal with no trailing zero', fmtPct(12.4) === '12.4%' && fmtPct(10) === '10%');
  ok('…and is unsigned — the verb carries the direction', fmtPct(-12.4) === '12.4%');
}

// ── The message, with the exact numbers ──────────────────────────────────────

{
  const r = rule();
  ok('a threshold message states the value and the target, both app-computed',
    alertMessage(r, 5_194_598.73, null) === 'revenue is 5.2M — below 6.0M.',
    alertMessage(r, 5_194_598.73, null));
  // A rule born on a card called "Revenue" says Revenue, not the column name it
  // happens to be computed over. The alert is read beside that card.
  const labelled = rule({ metric: { column: 'revenue', aggregation: 'sum', label: 'Revenue' } });
  ok('…using the SURFACE\u2019s word for the number when it has one',
    alertMessage(labelled, 5_194_598.73, null) === 'Revenue is 5.2M — below 6.0M.',
    alertMessage(labelled, 5_194_598.73, null));
  ok('…and the auto-name follows it too',
    suggestRuleName(labelled) === 'Revenue below 6.0M', suggestRuleName(labelled));
  ok('…and names the operator in words, not symbols',
    alertMessage(rule({ threshold: { op: '>=', value: 100 } }), 120, null) === 'revenue is 120 — at or above 100.',
    alertMessage(rule({ threshold: { op: '>=', value: 100 } }), 120, null));
  ok('a fall reads as a fall',
    alertMessage(fall, 4_600_000, 5_251_000) === 'revenue fell 12.4% to 4.6M since the previous refresh.',
    alertMessage(fall, 4_600_000, 5_251_000));
  const rise = rule({ compare: 'change', threshold: undefined, change: { pct: 10, direction: 'up', vs: 'previous_refresh' } });
  ok('…and a rise as a rise',
    alertMessage(rise, 110, 100) === 'revenue rose 10% to 110 since the previous refresh.',
    alertMessage(rise, 110, 100));
  ok('an anomaly message is singular for one and plural for more',
    alertMessage(rule({ compare: 'anomaly', threshold: undefined }), null, null, 1) === '1 new anomaly in revenue.'
    && alertMessage(rule({ compare: 'anomaly', threshold: undefined }), null, null, 3) === '3 new anomalies in revenue.');
  ok('a whole-dataset anomaly rule names no column',
    alertMessage(sanitizeRule({ ...rule(), compare: 'anomaly', threshold: undefined, metric: { column: '', aggregation: 'count' } }) as any, null, null, 2)
      === '2 new anomalies.');
}

// ── Digest batching ──────────────────────────────────────────────────────────
//
// "One notification per refresh tick" is only useful if the one sentence is
// readable. A banner listing eleven rule names is a banner nobody finishes.

{
  const ev = (name: string): any => ({
    id: EV_ID, ruleId: RULE_ID, ruleName: name, datasetId: DS_ID,
    at: new Date(NOON).toISOString(), value: 1, previous: null, delta: null, deltaPct: null,
    message: name + ' fired.', seen: false,
  });
  ok('no events is no sentence', digestMessage([]) === '');
  ok('a non-array is no sentence, not a throw', digestMessage(undefined as any) === '');
  // ONE event is its own message: wrapping a single alert in "1 alerts fired —"
  // would be worse than the alert.
  ok('one event is simply its own message', digestMessage([ev('Revenue')]) === 'Revenue fired.');
  ok('two or three are named in full',
    digestMessage([ev('Revenue'), ev('Profit')]) === '2 alerts fired — Revenue, Profit.',
    digestMessage([ev('Revenue'), ev('Profit')]));
  ok('past three, the rest are counted rather than listed',
    digestMessage([ev('A'), ev('B'), ev('C'), ev('D'), ev('E')]) === '5 alerts fired — A, B, C, and 2 more.',
    digestMessage([ev('A'), ev('B'), ev('C'), ev('D'), ev('E')]));
}

// ── The Test button ──────────────────────────────────────────────────────────
//
// It answers a question about the CONDITION. Answering "would not fire" because
// the rule happens to be disabled, snoozed, mid-breach or tested at 3am would be
// a confidently misleading no about the number in front of the user.

{
  const armed = rule({ armed: true, enabled: false, quietHours: { from: 0, to: 23 }, snoozedUntil: new Date(NOON + 1e6).toISOString() });
  const out = wouldFire(armed, 5_000_000);
  ok('Test ignores enabled, armed, quiet hours and the snooze', out.fire === true);
  ok('…and reports the sentence a real firing would have sent',
    out.message === 'revenue is 5.0M — below 6.0M.', out.message);
  ok('…and says no when the condition genuinely does not hold',
    wouldFire(rule(), 9_000_000).fire === false);
  ok('Test on a change rule uses the value pair it is given',
    wouldFire(fall, 88, 100).fire === true && wouldFire(fall, 99, 100).fire === false);
  // A rule written seconds ago has no earlier value. "rose \u2014% to 5.2M" is not
  // an answer; saying it cannot fire yet, and why, is.
  const fresh = wouldFire(fall, 5_194_598.73, null);
  ok('…and says so plainly when there is no comparison point yet',
    fresh.fire === false
    && fresh.message === 'Nothing to compare 5.2M against yet \u2014 this can fire from the next refresh on.',
    fresh.message);
}

// ── The auto-filled name ─────────────────────────────────────────────────────

ok('a threshold rule names itself after its condition',
  suggestRuleName(rule(), 'Revenue') === 'Revenue below 6.0M', suggestRuleName(rule(), 'Revenue'));
ok('a change rule too',
  suggestRuleName(fall, 'Revenue') === 'Revenue down 10%', suggestRuleName(fall, 'Revenue'));
ok('and an anomaly rule',
  suggestRuleName(rule({ compare: 'anomaly', threshold: undefined }), 'Revenue') === 'Anomalies in Revenue');

// ── THE DIFFERENTIAL: an event's figure IS the dashboard's figure ────────────
//
// `metricValue.computeMetric` is the reference every metric path in this app is
// measured against — `residentQuery.computeMetricResident` is proven equal to it
// and `ipc/dashboards.computeCardMetric` returns one or the other. An alert
// about a KPI card must carry THAT number, unrounded and unaltered, all the way
// into the event and the sentence. Object.is, not ==: a figure that arrived as
// -0, or rounded "for display" somewhere in the middle, is a different figure.

{
  const columns = [
    { name: 'region', type: 'text' as const },
    { name: 'revenue', type: 'number' as const },
    { name: 'units', type: 'number' as const },
  ];
  const rows: any[][] = [
    ['East', 380.72, 8], ['West', 1204.5, 3], ['East', 99.99, 1],
    ['North', 0, 0], ['West', 7.125, 12], ['South', -50.5, 2],
  ];
  const specs: Array<{ column: string; aggregation: any }> = [
    { column: 'revenue', aggregation: 'sum' },
    { column: 'revenue', aggregation: 'avg' },
    { column: 'revenue', aggregation: 'min' },
    { column: 'revenue', aggregation: 'max' },
    { column: 'revenue', aggregation: 'count' },
    { column: 'units', aggregation: 'sum' },
    { column: 'units', aggregation: 'avg' },
    { column: 'region', aggregation: 'count' },
    // The two answers that must stay null rather than becoming 0.
    { column: 'region', aggregation: 'sum' },
    { column: 'nope', aggregation: 'sum' },
  ];

  let agreed = 0;
  for (const spec of specs) {
    // The DASHBOARD's number: the reference implementation, over the whole table.
    const card = metricValue.computeMetric(columns, rows, spec);
    // The ALERT's number: the same figure, carried through an evaluation.
    const r = sanitizeRule({
      id: RULE_ID,
      name: 'x',
      datasetId: DS_ID,
      metric: { column: spec.column, aggregation: spec.aggregation },
      compare: 'threshold',
      threshold: { op: '>', value: -1e12 }, // always in breach, so an event exists
      enabled: true,
    });
    if (!r) { ok(`a rule exists for ${spec.aggregation}(${spec.column})`, false); continue; }
    const res = step(r, card, NOON);
    const carried = res.event ? res.event.value : res.rule.lastValue;
    if (Object.is(carried, card)) agreed += 1;
    else ok(`the event's figure equals the card's for ${spec.aggregation}(${spec.column})`, false, `${carried} vs ${card}`);
    // …and the sentence prints THAT number, not a second reading of it.
    if (res.event && card != null && res.event.message.indexOf(fmtMetric(card)) < 0) {
      ok(`the message prints the card's figure for ${spec.aggregation}(${spec.column})`, false, res.event.message);
    }
  }
  ok(`an alert's figure is Object.is to the dashboard's own KPI computation (${specs.length} definitions)`,
    agreed === specs.length);

  // The asymmetric empty-table contract, which the whole metric layer holds and
  // an alert must not quietly "fix": count is 0, everything else is null.
  ok('over no rows, count is 0 and the rest are null — and the event agrees',
    Object.is(step(rule(), metricValue.computeMetric(columns, [], { column: 'region', aggregation: 'count' }), NOON).rule.lastValue, 0)
    && Object.is(step(rule(), metricValue.computeMetric(columns, [], { column: 'revenue', aggregation: 'sum' }), NOON).rule.lastValue, null));
}

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} alert check(s) FAILED.`);
  process.exit(1);
}
console.log('All alert checks passed.');
