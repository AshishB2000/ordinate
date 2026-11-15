// An answer action's spec, checked (./answers answerFromAction) — MAIN PROCESS ONLY. Every dataset, column, metric and
// term it names must be real, else the validator's reason and "Did you mean" (docs/assistant/00-design.md, step 5).
// What it may name is read off step 3's index, only the few it says (./specVocabulary vocabularyFor); without a
// database, or when a lookup fails, the whole project's vocabulary, the reference. scripts/test-askIndex.ts holds the
// two Object.is-equal over a corpus of model answers.

import * as visuals from '../analysis/visuals';
import { validateAnswerSpec } from '../ai/answerSpec';
import type { AnswerSpec } from '../ai/answerSpec';
import { suggestFixes } from '../ai/answerSuggest';
import { isRefine, refineSpec, sameChart } from '../ai/answerRefine';
import type { SuggestedAction } from '../ai/suggestedAction';
import { specDatasets, specMetrics, specNames, specTerms, vocabularyFor, type Vocabulary, type VocabularyWant } from './specVocabulary';
import { searchModel } from './assistantSearch';
import type { Failure } from './answers';

/**
 * What `want` may name: off step 3's index (./specVocabulary vocabularyFor), else the whole vocabulary, the reference
 * (no database, or an index query that failed), cut to an agent's topic as the index's is.
 */
export async function vocabulary(projectId: string, want: VocabularyWant): Promise<Vocabulary> {
  const narrow = await vocabularyFor(projectId, want);
  if (narrow) return narrow;
  const only = want.only;
  return { datasets: (await specDatasets(projectId)).filter((d) => !only || only.has(d.id)), metrics: await specMetrics(projectId), terms: await specTerms(projectId) };
}

/** At most this many datasets step 3 finds for a dataset name that missed: "Did you mean"'s candidates. */
const NEAR_DATASETS = 20;

/**
 * The datasets step 3 finds for `said` (a dataset name that resolved to none), inside `only` when there is one: by its
 * words only (score > 0). "Did you mean" offers them, and meaning may reorder what the words found, not offer more.
 */
async function nearDatasets(projectId: string, said: string, only?: ReadonlySet<string>): Promise<string[]> {
  const hits = await searchModel(projectId, said, { kinds: ['dataset'], limit: NEAR_DATASETS, ...(only ? { datasetIds: [...only] } : {}) });
  return hits.flatMap((h) => (h.score > 0 ? [h.id] : []));
}

/**
 * The spec an `answer` action's chart is drawn from — merged onto `previous` for a refine — or the reason it is not
 * (with "Did you mean" options). `base`: the previous answer a refine was laid over. Metadata only: nothing computed.
 */
export async function checkAction(
  projectId: string, context: { kind?: string; id?: string }, action: SuggestedAction, question: string,
  previous?: AnswerSpec, withheld?: ReadonlySet<string>, only?: ReadonlySet<string>,
): Promise<{ ok: true; spec: AnswerSpec; base: AnswerSpec | null } | Failure> {
  let defaultDatasetId: string | undefined;
  if (context && context.kind === 'dataset' && context.id) defaultDatasetId = context.id;
  if (context && context.kind === 'visual' && context.id) {
    const v = await visuals.getVisual(projectId, context.id);
    if (v) defaultDatasetId = v.datasetId;
  }
  // What the spec and the answer it continues may name: off step 3's index, the few they say (./specVocabulary).
  const want = { specs: [action.spec, previous], datasetIds: [defaultDatasetId, previous?.datasetId].filter((x): x is string => !!x), metricIds: previous?.measures.flatMap((m) => m.metricId ?? []) ?? [], only: only ?? null };
  const unnamed = (x: unknown) => !specNames([x]).datasets.length;
  // With no default, an unnamed spec means the project's one dataset, if it has one (a previous answer's dataset may be gone).
  let { datasets: all, metrics: defined, terms } = await vocabulary(projectId, { ...want, anyDataset: !defaultDatasetId && unnamed(action.spec) });
  const on = previous ? all.find((d) => d.id === previous.datasetId) : undefined;
  // The answer a refine is laid over — none for a new subject, or once its dataset is gone.
  const base = previous && on && isRefine(action.spec) ? previous : null;
  const raw = base && on ? refineSpec(base, action.spec, on, defined, withheld) : action.spec;
  const opts = { defaultDatasetId: defaultDatasetId ?? on?.id, title: action.intent || question, terms };
  const v = validateAnswerSpec(raw, all, { ...opts, metrics: defined });
  if (!v.ok) {
    // A name that does not exist: what it may have meant, picked by the app from the names alone
    // (ai/answerSuggest) and laid over the same raw spec — the MERGED one, so a follow-up's option
    // keeps its carried filters. An option that is the previous chart again is not one. A dataset's
    // candidates are what step 3 finds for the name said (`nearDatasets`), with the vocabulary's.
    if (v.miss?.part === 'dataset') ({ datasets: all, metrics: defined, terms } = await vocabulary(projectId, { ...want, datasetIds: [...want.datasetIds, ...await nearDatasets(projectId, v.miss.said, only)] }));
    const options = v.miss ? suggestFixes(raw, v.miss, all, defined, { ...opts, terms }).filter((o) => !base || !sameChart(base, o.spec)) : [];
    return v.miss && options.length
      ? { ok: false, reason: v.reason, suggest: { part: v.miss.part, said: v.miss.said, options } }
      : { ok: false, reason: v.reason };
  }
  if (base && sameChart(base, v.spec)) return { ok: false, reason: 'The follow-up changed nothing the app could apply.' };
  return { ok: true, spec: v.spec, base };
}
