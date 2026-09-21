// Alert PERSISTENCE and EVALUATION — MAIN PROCESS ONLY.
//
// ./alerts.ts is the pure half: it decides whether a rule fired and what the
// sentence says, and it can be driven under bare `node`. This is the half that
// touches disk, reads the dataset and runs the clock. The split is the file-size
// rule's "one file = one job", and it is also what keeps the decision testable.
//
// STORAGE: one `alerts.json` per project, beside `project.json` —
// `userData/projects/<id>/alerts.json`, holding `{ rules, events, digest }`.
// One file rather than a directory per rule because the whole set is read on
// every evaluation anyway (every rule for the refreshed dataset has to be
// considered), and rules are counted in tens, not thousands. Atomic write,
// UUID-checked ids, corrupt file skipped — the conventions src/app/projects.ts
// and src/analysis/analysis.ts already hold.
//
// THE NUMBER IS NEVER COMPUTED HERE. `computeCardMetric` (src/ipc/dashboards.ts)
// is imported and called, which is the SAME function behind `dashboard:metric`.
// An alert that said 4.9M under a card reading 5.2M would be worse than no
// alert, so there is deliberately no second implementation to disagree with.
//
// NO MODEL IS INVOLVED in firing. The message is composed by ./alerts.ts out of
// app-computed figures. A model may be asked to EXPLAIN an event afterwards
// (`explainEvent`), and the notification never waits for it.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';

import * as alerts from './alerts';
import type { AlertEvent, AlertRule } from './alerts';
import * as datasets from '../data/datasets';
import * as projects from '../app/projects';
import { computeCardMetric } from '../ipc/dashboards';
import { sanitizeDashboardFilters } from './dashboards';
import { detectAnomalies } from './anomalies';
import { detectAnomaliesResident } from '../engine/anomaliesResident';
import { readDistinctPage, distinctValuesPageJs } from '../engine/datasetPage';
import { periodPlan, orderPeriods } from './insightsAgg';
import type { FilterStep } from '../data/transforms';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many distinct period values are read to find "this period" and "the one before". */
const PERIOD_SCAN = 2000;

export interface AlertFile {
  rules: AlertRule[];
  events: AlertEvent[];
  /** Per-project: batch a tick's events into ONE notification instead of N. */
  digest: boolean;
}

const EMPTY: AlertFile = { rules: [], events: [], digest: false };

// ── Disk ─────────────────────────────────────────────────────────────────────

let projectsBase: string | null = null;
function baseDir(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

function alertsFile(projectId: string): string {
  return path.join(baseDir(), projectId, 'alerts.json');
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique temp per write: a fixed name lets two overlapping writes share one
  // path and interleave into a corrupt file. Same reasoning as projects.ts.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

/**
 * Read one project's alerts, sanitized. A missing file is an empty set, not an
 * error — most projects have no alerts and must not pay for a try/catch at every
 * call site.
 */
export async function load(projectId: string): Promise<AlertFile> {
  if (!UUID_RE.test(String(projectId || ''))) return { ...EMPTY };
  let raw: any;
  try {
    raw = JSON.parse(await fs.promises.readFile(alertsFile(projectId), 'utf8'));
  } catch (_) {
    return { ...EMPTY }; // missing, unreadable or corrupt — never fatal
  }
  const rules: AlertRule[] = [];
  for (const r of Array.isArray(raw?.rules) ? raw.rules : []) {
    const clean = alerts.sanitizeRule(r);
    if (clean) rules.push(clean);
    if (rules.length >= alerts.MAX_RULES) break;
  }
  const events: AlertEvent[] = [];
  for (const e of Array.isArray(raw?.events) ? raw.events : []) {
    const clean = alerts.sanitizeEvent(e);
    if (clean) events.push(clean);
    if (events.length >= alerts.MAX_EVENTS) break;
  }
  return { rules, events, digest: raw?.digest === true };
}

async function save(projectId: string, file: AlertFile): Promise<boolean> {
  if (!UUID_RE.test(String(projectId || ''))) return false;
  try {
    await fs.promises.mkdir(path.join(baseDir(), projectId), { recursive: true });
    await writeJsonAtomic(alertsFile(projectId), {
      rules: file.rules.slice(0, alerts.MAX_RULES),
      // Newest first on disk too, so the cap drops the OLDEST event rather than
      // whichever end the writer happened to append to.
      events: file.events.slice(0, alerts.MAX_EVENTS),
      digest: file.digest === true,
    });
    return true;
  } catch (err: any) {
    console.error('[alerts] Could not write alerts.json:', err && err.message);
    return false;
  }
}

// ── Rules CRUD ───────────────────────────────────────────────────────────────

/** Create or replace one rule. Returns the STORED rule (sanitized), or null. */
export async function saveRule(projectId: string, raw: any): Promise<AlertRule | null> {
  const withId = { ...(raw || {}), id: UUID_RE.test(String(raw?.id || '')) ? raw.id : randomUUID() };
  // The filter whitelist is a security control and lives in ONE place; the pure
  // sanitizer deliberately leaves `metric.filters` alone so this stays the only
  // copy (see the note in alerts.sanitizeRule).
  if (withId.metric && Array.isArray(withId.metric.filters)) {
    withId.metric = { ...withId.metric, filters: sanitizeDashboardFilters(withId.metric.filters) };
  }
  const clean = alerts.sanitizeRule(withId);
  if (!clean) return null;
  const file = await load(projectId);
  const i = file.rules.findIndex((r) => r.id === clean.id);
  // An EDIT keeps the edge state (armed / anomalyKeys / history): changing a
  // rule's name or its quiet hours must not make a standing breach fire again.
  if (i >= 0) {
    const prev = file.rules[i];
    file.rules[i] = {
      ...clean,
      armed: prev.armed,
      anomalyKeys: prev.anomalyKeys,
      history: prev.history,
      lastValue: prev.lastValue,
      lastFiredAt: prev.lastFiredAt,
      lastEvaluatedAt: prev.lastEvaluatedAt,
    };
    // …unless the CONDITION itself changed, in which case the old edge state is
    // about a question nobody is asking any more.
    if (JSON.stringify(prev.threshold) !== JSON.stringify(clean.threshold)
        || JSON.stringify(prev.change) !== JSON.stringify(clean.change)
        || prev.compare !== clean.compare) {
      delete file.rules[i].armed;
    }
  } else {
    if (file.rules.length >= alerts.MAX_RULES) return null;
    file.rules.push(clean);
  }
  if (!(await save(projectId, file))) return null;
  return file.rules[i >= 0 ? i : file.rules.length - 1];
}

/** Apply a small patch (enabled, quiet hours, snooze) without a round trip through the dialog. */
export async function patchRule(projectId: string, ruleId: string, patch: any): Promise<AlertRule | null> {
  const file = await load(projectId);
  const i = file.rules.findIndex((r) => r.id === ruleId);
  if (i < 0) return null;
  const merged = alerts.sanitizeRule({ ...file.rules[i], ...(patch || {}) });
  if (!merged) return null;
  // `quietHours: null` is how the dialog CLEARS a window — sanitizeRule drops an
  // unusable one, but a spread would otherwise keep the old value.
  if (patch && patch.quietHours === null) delete merged.quietHours;
  if (patch && patch.snoozedUntil === null) delete merged.snoozedUntil;
  file.rules[i] = merged;
  if (!(await save(projectId, file))) return null;
  return merged;
}

/**
 * Delete one rule, and its events with it — an inbox row whose rule is gone
 * offers Snooze and Open on nothing.
 *
 * A WATCH-DERIVED rule also turns the dataset's "watch for anomalies" toggle
 * off. Without that, `syncWatchRules` would faithfully re-create the rule the
 * user just deleted on the very next refresh.
 */
export async function deleteRule(projectId: string, ruleId: string): Promise<boolean> {
  const file = await load(projectId);
  const rule = file.rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  file.rules = file.rules.filter((r) => r.id !== ruleId);
  file.events = file.events.filter((e) => e.ruleId !== ruleId);
  const ok = await save(projectId, file);
  if (ok && rule.fromWatch) {
    try { await datasets.setAutoRefresh(projectId, rule.datasetId, { watch: false }); } catch (_) { /* best effort */ }
  }
  return ok;
}

export async function setDigest(projectId: string, on: boolean): Promise<boolean> {
  const file = await load(projectId);
  file.digest = Boolean(on);
  return save(projectId, file);
}

/** Mark one event seen, or every event when `eventId` is omitted. */
export async function markSeen(projectId: string, eventId?: string): Promise<boolean> {
  const file = await load(projectId);
  let touched = false;
  file.events = file.events.map((e) => {
    if (e.seen || (eventId && e.id !== eventId)) return e;
    touched = true;
    return { ...e, seen: true };
  });
  return touched ? save(projectId, file) : true;
}

// ── Reading the numbers ──────────────────────────────────────────────────────

/**
 * The metric for one rule, and the value it is compared against.
 *
 * `previous` is only meaningful for a `change` rule:
 *   · previous_refresh → the value stored by the LAST evaluation, which is what
 *     "since yesterday's refresh" means in an app with no daemon;
 *   · previous_period  → the metric recomputed over the period before the latest
 *     one, which is a second `computeCardMetric` call with one extra filter
 *     rather than a fold, so EVERY aggregation is right (a mean of means is not
 *     a mean, and a fold would have shipped one).
 */
export async function metricFor(
  projectId: string,
  rule: AlertRule,
): Promise<{ value: number | null; previous: number | null }> {
  const filters = (rule.metric.filters || []) as FilterStep[];
  const spec = { column: rule.metric.column, aggregation: rule.metric.aggregation };
  if (rule.compare === 'anomaly') return { value: null, previous: null };

  if (rule.compare === 'change' && rule.change?.vs === 'previous_period' && rule.change.periodColumn) {
    const periods = await recentPeriods(projectId, rule.datasetId, rule.change.periodColumn);
    if (!periods) return { value: null, previous: null };
    const [prevKey, nowKey] = periods.keys;
    const at = async (key: string): Promise<number | null> => {
      const res = await computeCardMetric(projectId, rule.datasetId, spec,
        filters.concat([{ type: 'filter', column: rule.change!.periodColumn!, op: periods.op, value: key }] as FilterStep[]));
      return res.ok ? res.value : null;
    };
    return { value: await at(nowKey), previous: await at(prevKey) };
  }

  const res = await computeCardMetric(projectId, rule.datasetId, spec, filters);
  const value = res.ok ? res.value : null;
  return { value, previous: rule.lastValue ?? null };
}

/**
 * The two most recent PERIODS of a date column, and the filter operator that
 * selects one.
 *
 * Periods are exactly what `insightsAgg` already defines them to be — distinct
 * values of the column, rolled up to year-months once there are too many raw
 * ones — because two definitions of "the previous period" in one app is one too
 * many. `periodPlan` also hands back the operator that makes the roll-up exact
 * (`contains '2024-12'` on an ISO date), which is what keeps this equal to what
 * the Insights cards would say.
 *
 * Returns null when there are fewer than two periods: there is nothing to
 * compare against, and a rule that fired on a dataset's first day would be a
 * lie about a change.
 */
async function recentPeriods(
  projectId: string,
  datasetId: string,
  column: string,
): Promise<{ keys: [string, string]; op: '=' | 'contains' } | null> {
  const labels = await distinctValues(projectId, datasetId, column);
  if (!labels || labels.length < 2) return null;
  const plan = periodPlan(labels);
  const rolled = orderPeriods(Array.from(new Set(labels.map((l) => plan.of(l)))));
  if (rolled.length < 2) return null;
  return { keys: [rolled[rolled.length - 2], rolled[rolled.length - 1]], op: plan.op };
}

/** Distinct cells of one column — resident first, hydrate-and-fold as the reference. */
async function distinctValues(projectId: string, datasetId: string, column: string): Promise<string[] | null> {
  try {
    const src = await datasets.residentSource(projectId, datasetId);
    if (src) {
      const fast = readDistinctPage(src, column, { limit: PERIOD_SCAN, search: '' });
      if (fast) return fast.values;
    }
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return null;
    return distinctValuesPageJs(ds.columns, ds.rows, column, { limit: PERIOD_SCAN, search: '' }).values;
  } catch (_) {
    return null; // a rule that cannot read its period column simply does not fire
  }
}

/**
 * This run's anomalies for an anomaly rule, scoped to its column when it has one.
 *
 * Resident fast path, JS reference as the fallback — the pairing this codebase
 * uses everywhere, and for the same reason: a resident `null` means "fall back",
 * never "no anomalies".
 */
async function anomaliesFor(projectId: string, rule: AlertRule) {
  const col = rule.metric.column;
  const opts = col ? { measureCol: col } : undefined;
  try {
    const src = await datasets.residentSource(projectId, rule.datasetId);
    if (src) {
      const fast = detectAnomaliesResident(src, opts);
      if (fast) return fast;
    }
    const ds = await datasets.getDataset(projectId, rule.datasetId);
    if (!ds) return [];
    return detectAnomalies(ds.columns, ds.rows, opts);
  } catch (_) {
    return [];
  }
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Evaluate every enabled rule in a project — or only those on `datasetId`, which
 * is what a refresh asks for.
 *
 * Every rule's new state is written whether or not it fired: `history` feeds the
 * inbox sparkline and `armed` is what re-arms a threshold, so a quiet evaluation
 * is still a write. One save at the end, not one per rule.
 */
export async function evaluateProject(
  projectId: string,
  datasetId?: string,
  now = Date.now(),
): Promise<AlertEvent[]> {
  const file = await load(projectId);
  const fired: AlertEvent[] = [];
  let changed = false;

  for (let i = 0; i < file.rules.length; i += 1) {
    const rule = file.rules[i];
    if (datasetId && rule.datasetId !== datasetId) continue;
    // A disabled rule is not evaluated at all — not evaluated and then dropped.
    // Its history would otherwise keep growing while it was supposed to be off.
    if (!rule.enabled) continue;
    const { value, previous } = await metricFor(projectId, rule);
    const res = alerts.evaluateRule({
      rule,
      value,
      previous,
      anomalies: rule.compare === 'anomaly' ? await anomaliesFor(projectId, rule) : undefined,
      now,
      eventId: randomUUID(),
    });
    file.rules[i] = res.rule;
    changed = true;
    if (res.event) fired.push(res.event);
  }

  if (fired.length) file.events = fired.concat(file.events).slice(0, alerts.MAX_EVENTS);
  if (changed) await save(projectId, file);
  return fired;
}

/**
 * The dialog's Test button: evaluate a rule that may not exist yet, and report
 * what WOULD happen with the numbers behind it.
 *
 * Runs the real metric path, so "would fire, 5.2M" is the same 5.2M the card
 * shows and the same one a real firing would carry.
 */
export async function testRule(projectId: string, raw: any): Promise<{
  ok: boolean; fire: boolean; message: string; value: number | null; previous: number | null;
}> {
  const rule = alerts.sanitizeRule({ ...(raw || {}), id: raw?.id && UUID_RE.test(String(raw.id)) ? raw.id : randomUUID() });
  if (!rule) return { ok: false, fire: false, message: '', value: null, previous: null };
  const { value, previous } = await metricFor(projectId, rule);
  const anomalies = rule.compare === 'anomaly' ? await anomaliesFor(projectId, rule) : undefined;
  // `wouldFire` ignores the stored anomaly keys on purpose here: the question is
  // "does this dataset have anomalies", not "are any of them new since a run the
  // user has not made yet".
  const probe: AlertRule = rule.compare === 'anomaly' ? { ...rule, anomalyKeys: undefined } : rule;
  const out = alerts.wouldFire(probe, value, previous, anomalies);
  return { ok: true, fire: out.fire, message: out.message, value, previous };
}

// ── The watch toggle, as a rule ──────────────────────────────────────────────

/**
 * Keep each dataset's "watch for anomalies" toggle and its anomaly rule in step.
 *
 * There is ONE alerting mechanism now, and the toggle is a shortcut into it: a
 * watched dataset gets an `anomaly` rule with no column (the whole-table scan the
 * watch always did), and an unwatched one loses it. The toggle itself is
 * untouched — it still writes `autoRefresh.watch`, which is what makes this a
 * migration rather than a flag day: an existing watch adopts its stored
 * `lastAnomalyKeys` on first sync, so the day alerts ship nobody gets re-told
 * about anomalies they already saw.
 *
 * Idempotent and writes only when something actually differs.
 *
 * ponytail: a full `listDatasets` scan per call, and it is called once per
 * refreshed dataset in a tick. That is metadata-only JSON and a project holds
 * tens of datasets, so it is nothing today; cache it per tick if a project ever
 * grows enough datasets for the scan to show up.
 */
export async function syncWatchRules(projectId: string): Promise<void> {
  let summaries;
  try {
    summaries = await datasets.listDatasets(projectId);
  } catch (_) {
    return;
  }
  const file = await load(projectId);
  let changed = false;

  const watched = new Map<string, string[] | undefined>();
  for (const s of summaries) {
    if (s.autoRefresh && s.autoRefresh.watch) watched.set(s.id, s.autoRefresh.lastAnomalyKeys);
  }

  // A watch that was turned off loses its rule.
  const before = file.rules.length;
  file.rules = file.rules.filter((r) => !r.fromWatch || watched.has(r.datasetId));
  if (file.rules.length !== before) changed = true;

  for (const [id, keys] of watched) {
    if (file.rules.some((r) => r.fromWatch && r.datasetId === id)) continue;
    if (file.rules.length >= alerts.MAX_RULES) break;
    const name = summaries.find((s) => s.id === id)?.name || 'this dataset';
    const rule = alerts.sanitizeRule({
      id: randomUUID(),
      name: `Anomalies in ${name}`,
      datasetId: id,
      // `count` over an empty column is the shape an anomaly rule carries: the
      // detector scans the table itself, so the metric is never computed for it
      // (metricFor short-circuits) and the aggregation is only there to satisfy
      // the one rule shape every compare shares.
      metric: { column: '', aggregation: 'count' },
      compare: 'anomaly',
      enabled: true,
      fromWatch: true,
      anomalyKeys: keys,
    });
    if (!rule) continue;
    file.rules.push(rule);
    changed = true;
  }

  if (changed) await save(projectId, file);
}

/** Every project id, for the "evaluate everything" path. */
export async function allProjectIds(): Promise<string[]> {
  try {
    return (await projects.listProjects()).map((p) => p.id);
  } catch (_) {
    return [];
  }
}
