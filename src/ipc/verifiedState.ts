// Whether a verified question still runs, and whether its spec is hidden from the caller (semantic part 3 D5, D7).
//
// Worked out on EVERY read, from metadata, the catalog and the term records — never `getDataset`, never a
// warehouse. A question that no longer runs says why and is never repaired: a quiet repair is a number that
// changes silently. It is never matched, marked or used as an example either.

import { answerNames } from '../engine/live/liveMissing';
import { refineSpec } from '../ai/answerRefine';
import { isJoined, ownNames, relatedIds } from '../ai/answerJoin';
import { parseAgg, validateAnswerSpec } from '../ai/answerSpec';
import type { SpecDataset, SpecMetric } from '../ai/answerSpec';
import type { SpecTerm } from '../ai/termFacts';
import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import { mentionsHidden } from '../data/columnAccess';
import { hasValueFilter, type VerifiedQuestion } from '../analysis/verifiedRules';
import { listTagged } from '../analysis/verifiedQuestions';
import type { Tagged } from '../app/editConflict';
import * as msg from '../analysis/verifiedMessages';
import { listMetrics, type MetricSummary } from '../analysis/metrics';
import { getTerm, termFile } from '../analysis/terms';
import { datasetFilePath } from '../data/datasetRecord';
import { isValidId } from '../app/ids';
import * as recordFs from '../app/recordFs';
import { pendingMetric } from '../analysis/pendingKinds';
import { metricsNamedAs, specDatasets, specDatasetsOf, specMetrics, specMetricsFrom, specTermOf, specTerms } from './specVocabulary';
import { perAsk } from './askMemo';

/** `pending`: the ids of metrics of a kind this release cannot draw (part 5): `computeCard` refuses those in its own words. */
export interface VerifiedEnv { datasets: SpecDataset[]; metrics: SpecMetric[]; terms: SpecTerm[]; pending: ReadonlySet<string> }

/** What a spec may name in the project: metadata, the catalog and the term records. Once per question (./askMemo); its readers never change it. */
export function verifiedEnv(projectId: string): Promise<VerifiedEnv> {
  return perAsk(`verifiedEnv\0${projectId}`, async () => {
    const [datasets, metrics, terms, all] = await Promise.all([specDatasets(projectId), specMetrics(projectId), specTerms(projectId), listMetrics(projectId)]);
    return { datasets, metrics, terms, pending: new Set(all.filter(pendingMetric).map((m) => m.id)) };
  });
}

/**
 * `verifiedEnv` cut to what `questions` name, to check a few (an index lookup's candidates, a draft, a card's mark):
 * their datasets, the terms their filters name, the metrics their measures name and, on each one's dataset, every
 * metric of its name (refineSpec's `byName`: the FIRST of a name is the one the name means). For each of `questions`,
 * `verifiedProblem` reads the same here as in the whole env (scripts/test-verifiedNarrowEnv.ts). `pending` holds those
 * metrics' pending ones: only a named metric is looked up in it.
 */
export async function verifiedEnvFor(projectId: string, questions: readonly VerifiedQuestion[]): Promise<VerifiedEnv> {
  const ids = (of: (q: VerifiedQuestion) => Array<string | undefined>): string[] => [...new Set(questions.flatMap(of))].filter((id): id is string => !!id);
  const named = new Set(ids((q) => q.spec.measures.map((m) => m.metricId)));
  // A measure naming a metric: the metrics of its name, off step 3's index (the project's list without one), to find those on its dataset.
  const all = named.size ? ((await metricsNamedAs(projectId, [...named])) ?? (await perAsk(`metricSummaries\0${projectId}`, () => listMetrics(projectId)))) : [];
  const nameOn = (s: MetricSummary): string => `${s.datasetId}\0${s.name.trim().toLowerCase()}`;
  const same = new Set(all.filter((s) => named.has(s.id)).map(nameOn));
  const [dsIds, termIds] = [ids((q) => [q.spec.datasetId, ...relatedIds(q.spec)]), ids((q) => q.spec.filters.map((f) => ('term' in f ? f.term : undefined)))]; // a related category's or split's too (../ai/answerJoin)
  const read = (id: string): boolean => isValidId(projectId) && isValidId(id); // the getters read no other: null
  const [dsFile, tFile] = [(id: string) => datasetFilePath(projectId, id), (id: string) => termFile(projectId, id)];
  const bodies = await recordFs.readMany([...dsIds.filter(read).map(dsFile), ...termIds.filter(read).map(tFile)]); // ONE query for both
  // Each getter parses that text as it parses what readFile gives; a record readMany left out reads as readFile's ENOENT.
  const textOf = (file: (id: string) => string) => (id: string) => (): string => {
    const body = bodies.get(file(id));
    if (body === undefined) throw Object.assign(new Error('no such record'), { code: 'ENOENT' });
    return body;
  };
  const [datasets, metrics, terms] = await Promise.all([
    specDatasetsOf(projectId, dsIds, textOf(dsFile)),
    specMetricsFrom(projectId, async () => all.filter((s) => same.has(nameOn(s)))), // in the list's order: `find` takes the first
    Promise.all(termIds.map((id) => getTerm(projectId, id, textOf(tFile)(id)))),
  ]);
  return { datasets, metrics, terms: terms.flatMap((t) => (t ? [specTermOf(t)] : [])), pending: new Set(all.filter(pendingMetric).map((m) => m.id)) };
}

/** Why `q` no longer runs, in a sentence, or null. The same check a follow-up makes of the previous answer (./answers `previousAnswer`). */
export function verifiedProblem(q: VerifiedQuestion, env: VerifiedEnv): string | null {
  const ds = env.datasets.find((d) => d.id === q.spec.datasetId);
  if (!ds) return msg.verifiedDatasetGone();
  const mirror = (id: string | undefined): boolean => !!id && !!env.metrics.find((s) => s.id === id)?.external; // a layer's metric: its `column` is no field
  const spec = { ...q.spec, measures: q.spec.measures.filter((m) => !mirror(m.metricId)) };
  const named = isJoined(q.spec) ? ownNames(spec) : answerNames(spec);
  const gone = named.find((n) => !ds.columns.some((c) => c.name === n)); // by exact name, as computeCard reads it
  if (gone !== undefined) return msg.verifiedColumnGone(gone, ds.name);
  // A related category or split (../ai/answerJoin): its dataset still there, with that column.
  const related: SpecDataset[] = [];
  for (const [id, column] of [[q.spec.categoryDatasetId, q.spec.category], [q.spec.seriesDatasetId, q.spec.series]] as const) {
    if (!id || !column) continue;
    const on = env.datasets.find((d) => d.id === id);
    if (!on) return msg.verifiedDatasetGone();
    if (!on.columns.some((c) => c.name === column)) return msg.verifiedColumnGone(column, on.name);
    related.push(on);
  }
  if (q.spec.filters.some((f) => 'term' in f && !env.terms.some((t) => t.id === f.term))) return msg.verifiedTermGone();
  // A measure named by a metric is the metric as verified (refineSpec's carried check): redefined, filtered or deleted,
  // the figure under the mark is no longer the metric's. A retired metric is still in env.metrics, and still runs.
  const drifted = q.spec.measures.some((m) => {
    if (!m.metricId || env.pending.has(m.metricId)) return false; // a kind this release cannot draw: computeCard says so
    const x = env.metrics.find((s) => s.id === m.metricId);
    if (x?.external) return x.datasetId !== ds.id; // a layer's metric is the layer's to define: judged by existing on its dataset
    return !x || x.datasetId !== ds.id || !!x.hasFilters || x.column !== m.column || (parseAgg(x.aggregation) || 'sum') !== m.aggregation;
  });
  if (drifted) return msg.verifiedMetricChanged();
  const v = validateAnswerSpec(refineSpec(q.spec, {}, ds, env.metrics), [ds, ...related], { metrics: env.metrics, terms: env.terms }); // a term by its id, a mirror by its name
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
  return statesOf(projectId, list, env);
}

/** `verifiedStates` of some questions only, in their order (../ipc/verifiedLookup: the few an index lookup returned). */
export async function statesOf(projectId: string, list: readonly Tagged<VerifiedQuestion>[], env: VerifiedEnv): Promise<VerifiedState[]> {
  const left = await leftOutFor(projectId, list.map((x) => x.rec));
  const closed = new Map<string, boolean>();
  const out: VerifiedState[] = [];
  for (const { rec: q, tag } of list) {
    const id = q.spec.datasetId;
    if (left.has(q.id)) continue;
    if (!closed.has(id)) closed.set(id, await closedToCaller(projectId, id, { rowsOnly: true })); // a hidden column: leftOutFor
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
