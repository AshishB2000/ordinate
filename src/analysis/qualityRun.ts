// Data-quality checks: WHEN they run, WHICH engine answers, and WHAT is kept —
// MAIN PROCESS ONLY.
//
// ./qualityRules.ts says what a rule means (and is the JS reference);
// ../engine/qualityResident.ts answers the same thing off the Parquet. This file
// is the join: resident first, the JS reference on any `null` (traced as
// `qualityRules` in engine/residentTrace), results written to the dataset
// record METADATA-ONLY (`datasets.writeQuality` — never a table rewrite, never
// an `updatedAt` bump), and a FAIL rule that has just started failing raised
// as an alert event.
//
// THE HOOK is `runQualityChecks(projectId, datasetId)`. It is called after
// every save, refresh (manual and scheduled), pipeline change, column
// rename/retype and rule edit, and it NEVER throws into its caller: a quality
// check that breaks must not break the refresh it rode in on.
//
// ALERTS ARE OPTIONAL. The alerts module is feature-detected at call time
// (`alertSink`), so this feature neither loads it eagerly nor depends on it
// existing: without it, checks still run and results are still kept.

import { randomUUID } from 'crypto';
import * as datasets from '../data/datasets';
import * as trace from '../engine/residentTrace';
import { evaluateRulesResident, failingRowSql } from '../engine/qualityResident';
import * as computePool from '../engine/computePool';
import type { QualitySource } from '../engine/qualityResident';
import type { RowFilter } from '../engine/datasetPage';
import { isValidId } from '../app/ids';
import * as q from './qualityRules';
import type { DatasetQuality, QualityRule, RefTable, RuleResult } from './qualityRules';
import type { AlertEvent } from './alerts';

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Every rule's result for one dataset — resident when the dataset (and the other
 * side of each `references` rule) is Parquet-backed, else the JS reference over
 * hydrated tables. Null when the dataset is gone.
 */
export async function evaluateRules(
  projectId: string,
  datasetId: string,
  rules: QualityRule[],
): Promise<RuleResult[] | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  if (!rules.length) return [];
  const refIds = [...new Set(rules.filter((r) => r.kind === 'references').map((r) => r.args.datasetId as string))];

  const src = await datasets.residentSource(projectId, datasetId);
  let allResident = Boolean(src);
  const refSrc = new Map<string, QualitySource | null>();
  for (const id of refIds) {
    if (!(await datasets.getDatasetMeta(projectId, id))) { refSrc.set(id, null); continue; }
    const s = await datasets.residentSource(projectId, id);
    if (s) refSrc.set(id, s);
    else allResident = false;
  }
  if (src && allResident) {
    // In a compute worker when threads are available: the rules' SQL parks
    // that thread, not the one every window and the hotkey run on.
    const fast = computePool.available()
      ? await computePool.run<RuleResult[] | null>('quality', { src, rules, refs: [...refSrc] }).catch(() => null)
      : await evaluateRulesResident(src, rules, refSrc);
    if (fast) {
      trace.record('qualityRules', 'resident');
      return fast;
    }
    trace.record('qualityRules', 'failed', `${rules.length} rules, ${src.columns.length} cols`);
  } else {
    trace.record('qualityRules', 'skipped');
  }

  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  const refs = new Map<string, RefTable | null>();
  for (const id of refIds) {
    const other = id === datasetId ? ds : await datasets.getDataset(projectId, id);
    refs.set(id, other ? { columns: other.columns, rows: other.rows } : null);
  }
  return rules.map((rule) =>
    q.evaluateRuleJs(rule, ds.columns, ds.rows, rule.kind === 'references' ? refs.get(rule.args.datasetId ?? '') ?? null : undefined));
}

// ── Alerts (feature-detected) ────────────────────────────────────────────────

export interface AlertSink {
  record: (projectId: string, events: AlertEvent[]) => Promise<unknown>;
  deliver: (projectId: string, events: AlertEvent[]) => Promise<unknown>;
}

let sinkOverride: AlertSink | null | undefined;

/** Test hook: a sink, `null` for "no alerts module", `undefined` to feature-detect again. */
export function setAlertSinkForTest(sink: AlertSink | null | undefined): void {
  sinkOverride = sink;
}

function alertSink(): AlertSink | null {
  if (sinkOverride !== undefined) return sinkOverride;
  try {
    // any: a lazy, optional require — this feature must load without alerts.
    const store: any = require('./alertStore');
    const ipc: any = require('../ipc/alerts');
    if (typeof store.recordEvents !== 'function' || typeof ipc.deliver !== 'function') return null;
    return { record: store.recordEvents, deliver: ipc.deliver };
  } catch {
    return null;
  }
}

function eventMessage(rule: QualityRule, result: RuleResult, datasetName: string): string {
  const sig = `"${q.ruleSignature(rule)}"`;
  if (result.error) return `Data quality: ${sig} could not run in ${datasetName} — ${result.error}`;
  if (rule.kind === 'row_count') return `Data quality: ${sig} failing in ${datasetName}`;
  const n = result.failing;
  return `Data quality: ${sig} failing on ${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'} in ${datasetName}`;
}

// ── The hook ─────────────────────────────────────────────────────────────────

/**
 * Run every rule on a dataset, keep the result (latest + a 30-run history), and
 * raise one alert per FAIL rule that has just started failing. Returns the
 * events raised. `deliver: false` records them without notifying — the
 * scheduler batches a whole tick into one delivery. Never throws.
 */
export async function runQualityChecks(
  projectId: string,
  datasetId: string,
  opts: { deliver?: boolean } = {},
): Promise<AlertEvent[]> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta || !meta.quality || !meta.quality.rules.length) return [];
    const results = await evaluateRules(projectId, datasetId, meta.quality.rules);
    if (!results) return [];
    const at = new Date().toISOString();
    let before: RuleResult[] | undefined;
    const saved = await datasets.writeQuality(projectId, datasetId, (cur) => {
      before = cur && cur.latest ? cur.latest.results : undefined;
      return cur ? q.appendRun(cur, results, at) : undefined;
    });
    if (!saved || !saved.latest) return [];
    const flipped = q.newlyFailing(saved.rules, before, saved.latest.results);
    if (!flipped.length) return [];
    const sink = alertSink();
    if (!sink) return [];
    const events: AlertEvent[] = flipped.map(({ rule, result, previous }) => ({
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: 'Data quality',
      datasetId,
      at,
      value: result.failing,
      previous: previous ? previous.failing : null,
      delta: null,
      deltaPct: null,
      message: eventMessage(rule, result, meta.name),
      seen: false,
    }));
    await sink.record(projectId, events);
    if (opts.deliver !== false) await sink.deliver(projectId, events);
    return events;
  } catch (err: any) {
    console.error('[quality] checks failed:', err && err.message);
    return [];
  }
}

// ── Rules CRUD (each change re-runs the checks) ──────────────────────────────

/** The dataset's rules, latest run and history; `{ rules: [] }` before the first rule. */
export async function listQuality(projectId: string, datasetId: string): Promise<DatasetQuality | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return meta ? meta.quality ?? { rules: [] } : null;
}

/** What makes two versions of a rule "the same question". Severity is not part of it. */
function conditionKey(r: QualityRule): string {
  return JSON.stringify([r.kind, r.column ?? '', r.args]);
}

function withId(raw: unknown): Record<string, unknown> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { ...o, id: isValidId(o.id) ? o.id : randomUUID() };
}

/** Add or edit one rule, then run the checks. The error is a sentence for the editor. */
export async function saveRule(
  projectId: string,
  datasetId: string,
  raw: unknown,
): Promise<{ ok: true; rule: QualityRule; quality: DatasetQuality } | { ok: false; error: string }> {
  const check = q.checkRule(withId(raw));
  if (!check.ok) return check;
  const rule = check.rule;
  let full = false;
  const written = await datasets.writeQuality(projectId, datasetId, (cur) => {
    const rules = cur ? cur.rules.slice() : [];
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i < 0 && rules.length >= q.MAX_RULES) {
      full = true;
      return cur;
    }
    let latest = cur && cur.latest;
    if (i >= 0) {
      // A changed CONDITION is a new question: the old result — and with it the
      // "already failing, already told" edge — no longer applies.
      if (latest && conditionKey(rules[i]) !== conditionKey(rule)) {
        latest = { at: latest.at, results: latest.results.filter((r) => r.ruleId !== rule.id) };
      }
      rules[i] = rule;
    } else {
      rules.push(rule);
    }
    return { rules, latest, history: cur && cur.history };
  });
  if (full) return { ok: false, error: `A dataset can carry at most ${q.MAX_RULES} rules` };
  if (written === false) return { ok: false, error: 'Dataset not found' };
  await runQualityChecks(projectId, datasetId);
  return { ok: true, rule, quality: (await listQuality(projectId, datasetId)) ?? { rules: [] } };
}

/** Remove one rule, its latest result and its history column. */
export async function deleteRule(projectId: string, datasetId: string, ruleId: string): Promise<boolean> {
  let found = false;
  const written = await datasets.writeQuality(projectId, datasetId, (cur) => {
    if (!cur || !cur.rules.some((r) => r.id === ruleId)) return cur;
    found = true;
    return {
      rules: cur.rules.filter((r) => r.id !== ruleId),
      latest: cur.latest && { at: cur.latest.at, results: cur.latest.results.filter((r) => r.ruleId !== ruleId) },
      history: cur.history && cur.history.map((h) => {
        const failing = { ...h.failing };
        delete failing[ruleId];
        return { ...h, failing };
      }),
    };
  });
  return written !== false && found;
}

/** The editor's live "would fail N rows now" — a draft rule, evaluated, not stored. */
export async function previewRule(
  projectId: string,
  datasetId: string,
  raw: unknown,
): Promise<{ ok: true; passed: boolean; failing: number; error?: string } | { ok: false; error: string }> {
  const check = q.checkRule(withId(raw));
  if (!check.ok) return check;
  const res = await evaluateRules(projectId, datasetId, [check.rule]);
  if (!res || !res[0]) return { ok: false, error: 'Dataset not found' };
  const out: { ok: true; passed: boolean; failing: number; error?: string } = { ok: true, passed: res[0].passed, failing: res[0].failing };
  if (res[0].error) out.error = res[0].error;
  return out;
}

// ── "Show failing rows" ──────────────────────────────────────────────────────

/**
 * A stored rule as a `datasetPage` row filter, so the grid's own search, sort
 * and paging serve the failing rows. The SQL half is the resident predicate;
 * the JS half is `failingPredicateJs` — the same two definitions the counts
 * come from, so the rows shown are the rows counted.
 */
export async function failingRowFilter(
  projectId: string,
  datasetId: string,
  ruleId: string,
): Promise<RowFilter | { error: string }> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const rule = meta && meta.quality ? meta.quality.rules.find((r) => r.id === ruleId) : undefined;
  if (!meta || !rule) return { error: 'That rule no longer exists' };
  if (rule.kind === 'row_count') return { error: 'A row-count rule has no failing rows to show' };
  const refId = rule.kind === 'references' ? (rule.args.datasetId as string) : null;
  const refMeta = refId ? await datasets.getDatasetMeta(projectId, refId) : null;
  const bound = q.resolveRule(rule, meta.columns, refId ? (refMeta ? { columns: refMeta.columns } : null) : undefined);
  if (!bound.ok) return { error: bound.error };

  const src = await datasets.residentSource(projectId, datasetId);
  const refSrc = refId ? await datasets.residentSource(projectId, refId) : null;
  const fast = src && (!refId || refSrc) ? failingRowSql(src, rule, refSrc) : null;
  // The JS half of a references rule needs the other table's rows. They are read
  // only when the SQL half cannot answer — then the fallback is certain.
  let refTable: RefTable | null | undefined;
  if (refId && !fast) {
    const other = await datasets.getDataset(projectId, refId);
    refTable = other ? { columns: other.columns, rows: other.rows } : null;
  }
  return {
    sql: fast ? fast.sql : null,
    params: fast ? fast.params : [],
    keepFor: (columns, rows) => {
      if (refId && refTable === undefined) throw new Error('The referenced dataset could not be read');
      const p = q.failingPredicateJs(rule, columns, rows, refTable);
      if ('error' in p) throw new Error(p.error);
      return p.test;
    },
  };
}
