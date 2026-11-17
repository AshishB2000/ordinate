// "Alert me" on an Assistant answer (docs/assistant/00-design.md, The flow step 8) — MAIN PROCESS.
//
// The answer's ONE measure, under the answer's filters, as the alert dialog's subject: the very
// fields a KPI card's "Alert me…" hands the dialog by hand (web AlertDialog `subjectOf`), so the rule
// saved is the rule the same fields make there, through the same alerts:save. The figure the rule
// would read now and a threshold to start from are computed here, through the rule's own path
// (alertStore.testRule: the row-access and column guards, Live, a saved metric), never in the browser.
//
// An answer is an alert only when one number stands for it: one measure, a plain total (no "Calculate
// as", no top-N). Its category is not a filter: the alert watches the measure across every category,
// under the answer's filters, and says so. A relative period stays a period (`op: 'period'`), so the
// alert moves with the clock as the answer does; a glossary term is expanded to its steps as it stands
// now. Anything else is refused with the reason. A SQL answer has no spec, so it never gets here.

import type { FilterStep } from '../data/transforms';
import { PERIOD_OP } from '../data/filterOps';
import { AGGREGATIONS } from '../data/aggregations';
import { sanitizeStoredSpec, type AnswerSpec } from '../ai/answerSpec';
import { filterOn } from '../ai/answerJoin';
import { expandAnswerTerms } from '../analysis/termExpand';
import { getMetric } from '../analysis/metrics';
import { testRule } from '../analysis/alertStore';
import { isRowPolicyError, rowPolicyRefusal } from '../data/rowAccess';
import { isTermNotExpandedError, termRefusal } from '../data/termStep';
import * as say from '../analysis/answerAlertMessages';

const AGGS: ReadonlySet<string> = new Set<string>(AGGREGATIONS);

export interface AlertSubject {
  datasetId: string;
  column: string;
  aggregation: string;
  label?: string;
  metricId?: string;
  filters: FilterStep[];
}

export type AnswerAlert =
  | { ok: true; subject: AlertSubject; value: number | null; suggest: { op: '<'; value: number } | null; scope: string }
  | { ok: false; reason: string };

/** "Falls below" a tenth under the figure now (a tenth further below a negative one), to two significant figures; none without a figure. */
export function suggestThreshold(value: number | null): { op: '<'; value: number } | null {
  if (value === null || !Number.isFinite(value)) return null;
  return { op: '<', value: Number((value < 0 ? value * 1.1 : value * 0.9).toPrecision(2)) };
}

/** The answer's own filters as an alert's steps (its terms are expanded by the caller). */
function alertSteps(filters: AnswerSpec['filters']): FilterStep[] {
  const out: FilterStep[] = [];
  for (const f of filters) {
    if ('term' in f) continue;
    if ('period' in f) out.push({ type: 'filter', column: f.column, op: PERIOD_OP, period: { preset: f.period, ...(f.n !== undefined ? { n: f.n } : {}) } });
    else out.push({ type: 'filter', column: f.column, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}), ...(f.values ? { values: f.values } : {}) });
  }
  return out;
}

async function draft(projectId: string, raw: unknown): Promise<AnswerAlert> {
  const spec = sanitizeStoredSpec(raw);
  if (!spec) return { ok: false, reason: say.alertAnswerUnreadable() };
  if (spec.measures.length !== 1) return { ok: false, reason: say.alertOneMeasure(spec.measures.length) };
  const m = spec.measures[0];
  if (m.calc) return { ok: false, reason: say.alertNoCalc() };
  if (spec.top) return { ok: false, reason: say.alertNoTop() };
  if (!AGGS.has(m.aggregation)) return { ok: false, reason: say.alertNoTotal() };
  if (spec.filters.some((f) => 'period' in f && f.yearsBack)) return { ok: false, reason: say.alertNoYearsBack() };
  // A subject names its column on its own dataset, unpinned (a metric reads a bare one at its nearest owner): a linked one is refused.
  if (m.datasetId || spec.filters.some((f) => filterOn(f))) return { ok: false, reason: say.alertNoLinked() };
  const x = await expandAnswerTerms(projectId, spec); // a term it cannot apply throws, typed
  const filters = [...alertSteps(x.spec.filters), ...x.steps];
  const label = m.metricId ? (await getMetric(projectId, m.metricId))?.name : undefined;
  const subject: AlertSubject = {
    datasetId: spec.datasetId, column: m.column, aggregation: m.aggregation,
    ...(label && label !== m.column ? { label } : {}), ...(m.metricId ? { metricId: m.metricId } : {}), filters,
  };
  // The figure the rule would read now, by the rule's own path. Any threshold reads it; this one is never saved.
  const probe = await testRule(projectId, {
    datasetId: subject.datasetId, compare: 'threshold', threshold: { op: '<', value: 0 },
    metric: { column: subject.column, aggregation: subject.aggregation, filters, ...(subject.metricId ? { metricId: subject.metricId } : {}) },
  });
  if (!probe.ok) return { ok: false, reason: say.alertNoTotal() };
  return { ok: true, subject, value: probe.value, suggest: suggestThreshold(probe.value), scope: say.alertAcross(spec.category) };
}

/** `alerts:fromAnswer`: never throws; a row-access or term refusal is its own sentence. */
export async function alertFromAnswer(projectId: string, raw: unknown): Promise<AnswerAlert> {
  try {
    return await draft(projectId, raw);
  } catch (err) {
    if (isRowPolicyError(err)) return { ok: false, reason: rowPolicyRefusal(err.reason).error };
    if (isTermNotExpandedError(err)) return { ok: false, reason: termRefusal(err).error };
    return { ok: false, reason: err instanceof Error && err.message ? err.message : say.alertAnswerUnreadable() };
  }
}
