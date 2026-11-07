// Whether a verified question still runs, and whether its spec is hidden from the caller (semantic part 3 D5, D7).
//
// Worked out on EVERY read, from metadata, the catalog and the term records — never `getDataset`, never a
// warehouse. A question that no longer runs says why and is never repaired: a quiet repair is a number that
// changes silently. It is never matched, marked or used as an example either.

import { answerNames } from '../engine/live/liveMissing';
import { refineSpec } from '../ai/answerRefine';
import { parseAgg, validateAnswerSpec } from '../ai/answerSpec';
import type { SpecDataset, SpecMetric } from '../ai/answerSpec';
import type { SpecTerm } from '../ai/termFacts';
import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import { mentionsHidden } from '../data/columnAccess';
import { hasValueFilter, type VerifiedQuestion } from '../analysis/verifiedRules';
import { listTagged } from '../analysis/verifiedQuestions';
import * as msg from '../analysis/verifiedMessages';
import { listMetrics } from '../analysis/metrics';
import { pendingMetric } from '../analysis/pendingKinds';
import { specDatasets, specMetrics, specTerms } from './answers';

/** `pending`: the ids of metrics of a kind this release cannot draw (part 5): `computeCard` refuses those in its own words. */
export interface VerifiedEnv { datasets: SpecDataset[]; metrics: SpecMetric[]; terms: SpecTerm[]; pending: ReadonlySet<string> }

/** What a spec may name in the project: metadata, the catalog and the term records. */
export async function verifiedEnv(projectId: string): Promise<VerifiedEnv> {
  const [datasets, metrics, terms, all] = await Promise.all([specDatasets(projectId), specMetrics(projectId), specTerms(projectId), listMetrics(projectId)]);
  return { datasets, metrics, terms, pending: new Set(all.filter(pendingMetric).map((m) => m.id)) };
}

/** Why `q` no longer runs, in a sentence, or null. The same check a follow-up makes of the previous answer (./answers `previousAnswer`). */
export function verifiedProblem(q: VerifiedQuestion, env: VerifiedEnv): string | null {
  const ds = env.datasets.find((d) => d.id === q.spec.datasetId);
  if (!ds) return msg.verifiedDatasetGone();
  const gone = answerNames(q.spec).find((n) => !ds.columns.some((c) => c.name === n)); // by exact name, as computeCard reads it
  if (gone !== undefined) return msg.verifiedColumnGone(gone, ds.name);
  if (q.spec.filters.some((f) => 'term' in f && !env.terms.some((t) => t.id === f.term))) return msg.verifiedTermGone();
  // A measure named by a metric is the metric as verified (refineSpec's carried check): redefined, filtered or deleted,
  // the figure under the mark is no longer the metric's. A retired metric is still in env.metrics, and still runs.
  const drifted = q.spec.measures.some((m) => {
    if (!m.metricId || env.pending.has(m.metricId)) return false; // a kind this release cannot draw: computeCard says so
    const x = env.metrics.find((s) => s.id === m.metricId);
    return !x || x.datasetId !== ds.id || !!x.hasFilters || x.column !== m.column || (parseAgg(x.aggregation) || 'sum') !== m.aggregation;
  });
  if (drifted) return msg.verifiedMetricChanged();
  const v = validateAnswerSpec(refineSpec(q.spec, {}, ds), [ds], { metrics: env.metrics, terms: env.terms }); // a term by its id
  return v.ok ? null : v.reason;
}

/** `tag`: the stored record's edit-conflict tag (../app/editConflict). */
export interface VerifiedState { q: VerifiedQuestion; problem: string | null; hidden: boolean; tag: string }

/**
 * Every question of the project with whether it runs, and whether it is HIDDEN from the caller (D5): its dataset
 * is closed to them by row access rules and its spec compares with a row value. One env; one row-rules check per dataset.
 * A question whose spec names a column hidden from the caller (part 4, D18) is left out for them altogether.
 */
export async function verifiedStates(projectId: string): Promise<VerifiedState[]> {
  const [list, env] = await Promise.all([listTagged(projectId), verifiedEnv(projectId)]);
  const left = await leftOutFor(projectId, list.map((x) => x.rec));
  const closed = new Map<string, boolean>();
  const out: VerifiedState[] = [];
  for (const { rec: q, tag } of list) {
    const id = q.spec.datasetId;
    if (left.has(q.id)) continue;
    if (!closed.has(id)) closed.set(id, await closedToCaller(projectId, id));
    out.push({ q, problem: verifiedProblem(q, env), hidden: !!closed.get(id) && hasValueFilter(q.spec), tag });
  }
  return out;
}

/** The ids of the questions left out for the caller: each names a column hidden from them (part 4, D18). One check per dataset. */
export async function leftOutFor(projectId: string, questions: readonly VerifiedQuestion[]): Promise<Set<string>> {
  const hiddenOf = new Map<string, ReadonlySet<string>>();
  const left = new Set<string>();
  for (const q of questions) {
    const id = q.spec.datasetId;
    if (!hiddenOf.has(id)) hiddenOf.set(id, await hiddenColumnsFor(projectId, id));
    if (mentionsHidden(q.spec, hiddenOf.get(id)!)) left.add(q.id);
  }
  return left;
}
