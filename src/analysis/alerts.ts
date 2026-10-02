// Alert RULES and EVENTS — MAIN PROCESS, PURE logic. No Electron, no fs, no DOM,
// so scripts/test-alerts.ts can drive every decision here under bare `node`.
//
// WHAT THIS MODULE IS FOR. Three pieces already existed and never met: a dataset
// can auto-refresh on a schedule, a "watch for anomalies" toggle fired a bare OS
// notification, and a dashboard computes its KPIs on the fly. What nobody could
// say was "tell me when revenue drops more than 10%". This is the rule that says
// it, the decision about whether it fired, and the sentence the user reads.
//
// THE APP DOES THE MATH, here as everywhere. `value` and `previous` arrive
// already computed by src/ipc/alerts.ts through the SAME metric path a KPI card
// uses. Nothing in this file calls a model, and `alertMessage` composes its
// sentence out of those app-computed figures — a model may later be asked to
// EXPLAIN an event, never to produce one.
//
// ── The one rule that decides whether people keep alerts on ──────────────────
//
// FIRING IS EDGE-TRIGGERED. A threshold rule fires the moment the metric crosses
// and then stays quiet until it has gone back to normal; it does not re-fire on
// every refresh for as long as the condition holds. That is the same lesson
// ./anomalyWatch already learned ("a watch that re-reports the same finding every
// hour is a watch people turn off"), and `armed` is the whole of it: one boolean
// carried on the rule saying "we have already said this".
//
// A CHANGE rule is deliberately NOT edge-triggered in that sense — it compares
// two points in time, so every refresh that meets the condition is a genuinely
// new fact ("it fell another 12% today"), not a repeat of yesterday's.
//
// An ANOMALY rule delegates the whole question to ./anomalyWatch's key diff,
// which is the edge-trigger it already implements.

import { formatCompact } from '../app/format';
import type { MetricAggregation } from './metricValue';
import type { FilterStep } from '../data/transforms';
import type { Anomaly } from './anomalies';
import { diffAnomalies } from './anomalyWatch';
import { t } from '../app/i18n';

// ── Shapes ───────────────────────────────────────────────────────────────────

export type AlertCompare = 'threshold' | 'change' | 'anomaly';
export type ThresholdOp = '>' | '<' | '>=' | '<=';
export type ChangeDirection = 'up' | 'down' | 'either';
export type ChangeVs = 'previous_refresh' | 'previous_period';

/** Local-clock hours [from, to). from === to means "no quiet hours". */
export interface QuietHours { from: number; to: number }

export interface AlertMetric {
  column: string;
  aggregation: MetricAggregation;
  filters?: FilterStep[];
  /**
   * What the surface the rule was born on CALLS this number ("Revenue"), not
   * what the column is named ("revenue").
   *
   * Carried because the message is read next to that surface: an alert saying
   * "revenue is 5.2M" under a card headed "Revenue" is the app using its own
   * vocabulary instead of the user's. Optional — a rule written against a bare
   * column falls back to the column name, which is what it is called there.
   */
  label?: string;
  /**
   * The saved Metric this rule watches, when it was created from the metric
   * picker rather than from a bare column.
   *
   * ADDITIVE: `column`/`aggregation` stay required and stay filled from the
   * metric's definition, so `alertStore.metricFor` and the whole evaluator are
   * untouched and a rule whose metric is deleted keeps firing on the same
   * figure. What the id buys is the metric's NAME and FORMAT in the alert
   * message, and a row in `metric:usage`.
   */
  metricId?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  datasetId: string;
  metric: AlertMetric;
  compare: AlertCompare;
  threshold?: { op: ThresholdOp; value: number };
  change?: {
    pct: number;
    direction: ChangeDirection;
    vs: ChangeVs;
    /** Required for vs:'previous_period' — the date column the periods come from. */
    periodColumn?: string;
  };
  enabled: boolean;
  /** Where the rule was created FROM, so the inbox can offer "Open dashboard". */
  createdFrom?: { analysisId: string; cardId: string };
  /** True for the rule that backs a dataset's "watch for anomalies" toggle. */
  fromWatch?: boolean;
  quietHours?: QuietHours;
  /** ISO. Set by Snooze; the rule still evaluates, it just cannot fire. */
  snoozedUntil?: string;
  lastEvaluatedAt?: string;
  lastValue?: number | null;
  lastFiredAt?: string;
  /**
   * Threshold edge state: true once the rule has fired and while the metric is
   * still in breach. Cleared when the metric returns to normal, which is what
   * re-arms it.
   */
  armed?: boolean;
  /** The last `MAX_HISTORY` evaluated values, oldest first — the inbox sparkline. */
  history?: number[];
  /** Anomaly edge state, exactly ./anomalyWatch's `keep`. */
  anomalyKeys?: string[];
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  datasetId: string;
  at: string;
  value: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  message: string;
  seen: boolean;
  /** Carried from the rule so the inbox can offer "Open dashboard" without a second read. */
  analysisId?: string;
}

/** Points kept for the inbox sparkline. Twelve is what the row is 96px wide for. */
export const MAX_HISTORY = 12;
/** Events kept per project. The inbox is a recent list, not an audit log. */
export const MAX_EVENTS = 200;
/** Rules per project. Far past the point where a person wants a rules TABLE. */
export const MAX_RULES = 100;

const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const OPS: ReadonlySet<string> = new Set(['>', '<', '>=', '<=']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Number formatting ────────────────────────────────────────────────────────

/**
 * The compact figure an alert message carries.
 *
 * A DELIBERATE MIRROR of the renderer's `_fmtVal` (hub.ts), not a second opinion
 * about formatting: the alert is ABOUT a KPI card, and a notification that says
 * "5.19M" under a card reading "5.2M" reads as two different numbers. Same
 * thresholds, same one decimal. (The renderer mirrors main in the other
 * direction too — see dashFiltersUi.toggleCrossFilterSteps.)
 */
export function fmtMetric(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return formatCompact(v);
}

/** A percentage for prose: one decimal, no trailing ".0", never signed. */
export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const f = Math.abs(n).toFixed(1);
  return f.replace(/\.0$/, '') + '%';
}

// ── Sanitizers (untrusted: renderer input AND hand-edited disk) ──────────────

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function sanitizeQuietHours(raw: any): QuietHours | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const from = num(raw.from);
  const to = num(raw.to);
  if (from == null || to == null) return undefined;
  const f = Math.max(0, Math.min(23, Math.floor(from)));
  const t = Math.max(0, Math.min(23, Math.floor(to)));
  if (f === t) return undefined; // "no quiet hours", stored as absent
  return { from: f, to: t };
}

function sanitizeHistory(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const v of raw) {
    const n = num(v);
    if (n != null) out.push(n);
  }
  return out.length ? out.slice(-MAX_HISTORY) : undefined;
}

function sanitizeKeys(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const k of raw) if (typeof k === 'string' && k && out.indexOf(k) < 0) out.push(k);
  return out.length ? out.slice(0, 200) : undefined;
}

/**
 * One rule, clamped onto the shape above. Returns null for input that could not
 * be a rule at all — a missing id/dataset, an unknown aggregation, a threshold
 * rule with no threshold. A rule that cannot be evaluated must never reach the
 * evaluator, where it would be a per-refresh exception instead of a skipped row.
 *
 * `filters` are NOT sanitized here: they are `FilterStep`s and the one sanitizer
 * for those lives in src/data/transforms.ts, which the IPC layer calls. A second
 * copy of a filter whitelist is how filter whitelists drift.
 */
export function sanitizeRule(raw: any): AlertRule | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!UUID_RE.test(String(raw.id || ''))) return null;
  if (!UUID_RE.test(String(raw.datasetId || ''))) return null;
  const m = raw.metric || {};
  const column = str(m.column);
  const aggregation = String(m.aggregation || '');
  if (!AGGS.has(aggregation)) return null;
  const compare: AlertCompare =
    raw.compare === 'change' ? 'change' : raw.compare === 'anomaly' ? 'anomaly' : 'threshold';
  // An anomaly rule is the one kind allowed an empty column: it means "scan the
  // whole dataset", which is exactly what the watch toggle used to do.
  if (!column && compare !== 'anomaly') return null;

  const rule: AlertRule = {
    id: String(raw.id),
    name: str(raw.name) || t('common.alert'),
    datasetId: String(raw.datasetId),
    metric: { column, aggregation: aggregation as MetricAggregation },
    compare,
    enabled: raw.enabled !== false,
  };
  if (Array.isArray(m.filters) && m.filters.length) rule.metric.filters = m.filters;
  const label = str(m.label);
  if (label) rule.metric.label = label;
  // UUID-shaped only — same guard, same reason as sanitizeCard's.
  if (UUID_RE.test(String(m.metricId || ''))) rule.metric.metricId = String(m.metricId);

  if (compare === 'threshold') {
    const t = raw.threshold || {};
    const value = num(t.value);
    if (value == null || !OPS.has(String(t.op))) return null;
    rule.threshold = { op: String(t.op) as ThresholdOp, value };
  }
  if (compare === 'change') {
    const c = raw.change || {};
    const pct = num(c.pct);
    if (pct == null || pct <= 0) return null;
    const direction: ChangeDirection =
      c.direction === 'up' ? 'up' : c.direction === 'down' ? 'down' : 'either';
    const vs: ChangeVs = c.vs === 'previous_period' ? 'previous_period' : 'previous_refresh';
    rule.change = { pct, direction, vs };
    // A previous-period rule with no date column cannot be evaluated at all.
    const periodColumn = str(c.periodColumn);
    if (vs === 'previous_period') {
      if (!periodColumn) return null;
      rule.change.periodColumn = periodColumn;
    }
  }

  if (raw.createdFrom && typeof raw.createdFrom === 'object'
      && UUID_RE.test(String(raw.createdFrom.analysisId || ''))) {
    rule.createdFrom = {
      analysisId: String(raw.createdFrom.analysisId),
      cardId: str(raw.createdFrom.cardId, 64),
    };
  }
  if (raw.fromWatch === true) rule.fromWatch = true;
  const quiet = sanitizeQuietHours(raw.quietHours);
  if (quiet) rule.quietHours = quiet;
  if (str(raw.snoozedUntil, 40)) rule.snoozedUntil = str(raw.snoozedUntil, 40);
  if (str(raw.lastEvaluatedAt, 40)) rule.lastEvaluatedAt = str(raw.lastEvaluatedAt, 40);
  if (str(raw.lastFiredAt, 40)) rule.lastFiredAt = str(raw.lastFiredAt, 40);
  const last = num(raw.lastValue);
  if (last != null) rule.lastValue = last;
  if (raw.armed === true) rule.armed = true;
  const history = sanitizeHistory(raw.history);
  if (history) rule.history = history;
  const keys = sanitizeKeys(raw.anomalyKeys);
  if (keys) rule.anomalyKeys = keys;
  return rule;
}

export function sanitizeEvent(raw: any): AlertEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!UUID_RE.test(String(raw.id || '')) || !UUID_RE.test(String(raw.ruleId || ''))) return null;
  const ev: AlertEvent = {
    id: String(raw.id),
    ruleId: String(raw.ruleId),
    ruleName: str(raw.ruleName) || t('common.alert'),
    datasetId: UUID_RE.test(String(raw.datasetId || '')) ? String(raw.datasetId) : '',
    at: str(raw.at, 40) || new Date(0).toISOString(),
    value: num(raw.value),
    previous: num(raw.previous),
    delta: num(raw.delta),
    deltaPct: num(raw.deltaPct),
    message: str(raw.message, 400),
    seen: raw.seen === true,
  };
  if (raw.analysisId && UUID_RE.test(String(raw.analysisId))) ev.analysisId = String(raw.analysisId);
  return ev;
}

// ── The conditions ───────────────────────────────────────────────────────────

/** Is the metric currently in breach of a threshold rule? */
export function thresholdBreached(rule: AlertRule, value: number | null): boolean {
  if (rule.compare !== 'threshold' || !rule.threshold || value == null) return false;
  const t = rule.threshold.value;
  switch (rule.threshold.op) {
    case '>': return value > t;
    case '<': return value < t;
    case '>=': return value >= t;
    case '<=': return value <= t;
    default: return false;
  }
}

/**
 * The signed percentage change from `previous` to `value`, or null when it
 * cannot be expressed as one.
 *
 * A previous of 0 returns null RATHER THAN Infinity: "revenue rose ∞%" is not a
 * sentence, and a 10%-change rule firing on every move away from zero is noise.
 * The absolute delta is still carried on the event, so nothing is lost.
 */
export function changePct(value: number | null, previous: number | null): number | null {
  if (value == null || previous == null || previous === 0) return null;
  return ((value - previous) / Math.abs(previous)) * 100;
}

/** Does a change rule's condition hold for this pair of values? */
export function changeHit(rule: AlertRule, value: number | null, previous: number | null): boolean {
  if (rule.compare !== 'change' || !rule.change) return false;
  const pct = changePct(value, previous);
  if (pct == null) return false;
  if (Math.abs(pct) < rule.change.pct) return false;
  if (rule.change.direction === 'up') return pct > 0;
  if (rule.change.direction === 'down') return pct < 0;
  return true;
}

// ── Quiet hours and snooze ───────────────────────────────────────────────────

/**
 * Is `date` inside the rule's quiet window, in the LOCAL clock?
 *
 * Local on purpose: "don't wake me between 22:00 and 07:00" is about the user's
 * night, not UTC's. A window that wraps midnight (22 → 7) is the common case, so
 * it is the one spelled out rather than the one left to a caller.
 */
export function inQuietHours(rule: AlertRule, date: Date): boolean {
  const q = rule.quietHours;
  if (!q || q.from === q.to) return false;
  const h = date.getHours();
  return q.from < q.to ? (h >= q.from && h < q.to) : (h >= q.from || h < q.to);
}

export function isSnoozed(rule: AlertRule, now: number): boolean {
  if (!rule.snoozedUntil) return false;
  const until = Date.parse(rule.snoozedUntil);
  return Number.isFinite(until) && now < until;
}

// ── The sentence ─────────────────────────────────────────────────────────────

// Functions, not constants: read at call time, so the words follow Settings → Language.
function opWord(op: ThresholdOp): string {
  const words: Record<ThresholdOp, string> = {
    '>': t('alerts.above'), '<': t('alerts.below'), '>=': t('alerts.at_or_above'), '<=': t('alerts.at_or_below'), // i18n-text
  };
  return words[op];
}

function vsWord(vs: ChangeVs): string {
  const words: Record<ChangeVs, string> = {
    previous_refresh: t('alerts.the_previous_refresh'),
    previous_period: t('alerts.the_previous_period'),
  };
  return words[vs];
}

/**
 * What the user reads, composed from the app's own figures.
 *
 * Every number in here came from `computeMetric` (or its proven-equivalent
 * resident twin) — the sentence is a template around them, never a model's
 * paraphrase of them, which is the same contract ./anomalyWatch.watchMessage
 * and src/ai/headline.ts hold.
 */
export function alertMessage(
  rule: AlertRule,
  value: number | null,
  previous: number | null,
  newAnomalies = 0,
): string {
  // The surface's own word for this number, falling back to the column it is
  // computed over — see AlertMetric.label.
  const label = rule.metric.label || rule.metric.column || rule.name;
  if (rule.compare === 'anomaly') {
    const where = rule.metric.column ? ` in ${label}` : '';
    return t('alerts.new', { newAnomalies, where });
  }
  if (rule.compare === 'threshold' && rule.threshold) {
    return t('alerts.is', { label, value: fmtMetric(value), op: opWord(rule.threshold.op), value2: fmtMetric(rule.threshold.value) });
  }
  const pct = changePct(value, previous);
  const verb = pct != null && pct < 0 ? 'fell' : 'rose';
  const vs = vsWord(rule.change ? rule.change.vs : 'previous_refresh');
  return t('alerts.to_since', { label, verb, pct: fmtPct(pct), value: fmtMetric(value), vs });
}

/**
 * One sentence for a whole tick's events — the "digest instead of individual"
 * option. Names as many rules as fit and counts the rest, so a tick that fired
 * eleven rules is still one line a person can read from a notification banner.
 */
export function digestMessage(events: AlertEvent[]): string {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return '';
  if (list.length === 1) return list[0].message;
  const NAMED = 3;
  const names = list.slice(0, NAMED).map((e) => e.ruleName);
  const rest = list.length - names.length;
  const tail = rest > 0 ? t('alerts.and_more', { rest }) : '';
  return t('alerts.alerts_fired', { listCount: list.length, p1: names.join(', '), tail });
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface EvaluateInput {
  rule: AlertRule;
  /** The app-computed metric for this evaluation. null = could not be computed. */
  value: number | null;
  /**
   * The comparison point for a `change` rule. For vs:'previous_refresh' the
   * caller passes `rule.lastValue`; for vs:'previous_period' it passes the
   * metric recomputed over the prior period. Ignored by the other two compares.
   */
  previous?: number | null;
  /** For an `anomaly` rule: this run's findings, already scoped to the column. */
  anomalies?: Anomaly[];
  now: number;
  /** Supplied by the caller so this module never reaches for randomUUID. */
  eventId: string;
}

export interface EvaluateResult {
  /** The rule as it must now be STORED — never mutated in place. */
  rule: AlertRule;
  /** Non-null exactly when the rule fired. */
  event: AlertEvent | null;
  /** True when it met its condition but quiet hours or a snooze held it back. */
  suppressed: boolean;
}

/**
 * Evaluate ONE rule against ONE freshly computed value. Pure: same inputs, same
 * outputs, no clock and no id generator of its own.
 *
 * The returned rule is a COPY carrying the new edge state (`armed`,
 * `anomalyKeys`), the new `lastValue`/`lastEvaluatedAt` and one more point of
 * `history`. Callers persist it whether or not anything fired — the history and
 * the re-arm are the whole reason a quiet evaluation still writes.
 *
 * SUPPRESSION IS NOT A MISS. A rule held back by quiet hours or a snooze still
 * advances its edge state, so a threshold that crossed at 3am does not fire a
 * stale alert at 9am as if it had just happened. It reports `suppressed` instead,
 * and the caller can decide to count it.
 */
export function evaluateRule(input: EvaluateInput): EvaluateResult {
  const { rule, value, now, eventId } = input;
  const at = new Date(now).toISOString();
  const next: AlertRule = { ...rule, lastEvaluatedAt: at, lastValue: value };
  if (value != null) {
    next.history = [...(rule.history || []), value].slice(-MAX_HISTORY);
  }

  let hit = false;
  let newAnomalies = 0;
  let previous: number | null = null;

  if (rule.compare === 'threshold') {
    const breached = thresholdBreached(rule, value);
    // The edge: fire on the transition INTO breach, and re-arm on the way out.
    hit = breached && !rule.armed;
    if (breached) next.armed = true;
    else delete next.armed;
  } else if (rule.compare === 'change') {
    previous = input.previous ?? null;
    hit = changeHit(rule, value, previous);
  } else {
    const diff = diffAnomalies(input.anomalies || [], rule.anomalyKeys);
    // Store the CURRENT set even when nothing is new — ./anomalyWatch's rule: a
    // resolved anomaly has to drop out, or it counts as new the day it returns.
    if (diff.keep.length) next.anomalyKeys = diff.keep;
    else delete next.anomalyKeys;
    newAnomalies = diff.newKeys.length;
    hit = newAnomalies > 0;
  }

  if (!rule.enabled || !hit) return { rule: next, event: null, suppressed: false };

  if (isSnoozed(rule, now) || inQuietHours(rule, new Date(now))) {
    return { rule: next, event: null, suppressed: true };
  }

  const delta = value != null && previous != null ? value - previous : null;
  const event: AlertEvent = {
    id: eventId,
    ruleId: rule.id,
    ruleName: rule.name,
    datasetId: rule.datasetId,
    at,
    value,
    previous,
    delta,
    deltaPct: changePct(value, previous),
    message: alertMessage(rule, value, previous, newAnomalies),
    seen: false,
  };
  if (rule.createdFrom) event.analysisId = rule.createdFrom.analysisId;
  next.lastFiredAt = at;
  return { rule: next, event, suppressed: false };
}

/**
 * The Test button: would this rule fire RIGHT NOW, and with what numbers?
 *
 * Deliberately blind to `enabled`, quiet hours and the snooze — the question the
 * button asks is about the CONDITION, and answering "would not fire" because it
 * happens to be 3am would be a confidently misleading no. It is also blind to
 * `armed`, because a rule that is already in breach would otherwise test as
 * "would not fire" while the card in front of the user plainly breaches it.
 */
export function wouldFire(
  rule: AlertRule,
  value: number | null,
  previous?: number | null,
  anomalies?: Anomaly[],
): { fire: boolean; message: string } {
  if (rule.compare === 'threshold') {
    return { fire: thresholdBreached(rule, value), message: alertMessage(rule, value, null) };
  }
  if (rule.compare === 'change') {
    const prev = previous ?? null;
    // A change rule written seconds ago has no earlier value to compare with,
    // and `alertMessage` would print "rose —% to 5.2M". Say the true thing
    // instead: it cannot fire YET, and why.
    if (prev == null) {
      return {
        fire: false,
        message: t('alerts.nothing_to_compare_against_yet_this', { value: fmtMetric(value) }),
      };
    }
    return { fire: changeHit(rule, value, prev), message: alertMessage(rule, value, prev) };
  }
  const diff = diffAnomalies(anomalies || [], rule.anomalyKeys);
  return { fire: diff.newKeys.length > 0, message: alertMessage(rule, value, null, diff.newKeys.length) };
}

/** The auto-filled name in the dialog. App-composed, like the message. */
export function suggestRuleName(
  rule: Pick<AlertRule, 'compare' | 'metric' | 'threshold' | 'change'>,
  label?: string,
): string {
  const name = label || rule.metric.label || rule.metric.column || t('common.metric');
  if (rule.compare === 'threshold' && rule.threshold) {
    return `${name} ${opWord(rule.threshold.op)} ${fmtMetric(rule.threshold.value)}`;
  }
  if (rule.compare === 'change' && rule.change) {
    const dir = rule.change.direction === 'up' ? 'up' : rule.change.direction === 'down' ? 'down' : 'changes';
    const by = rule.change.direction === 'either' ? 'by ' : '';
    return `${name} ${dir} ${by}${fmtPct(rule.change.pct)}`;
  }
  return t('alerts.anomalies_in_2', { name });
}
