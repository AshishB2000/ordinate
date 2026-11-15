// The words a chart spec may name, entry by entry. MAIN PROCESS. Built the same way for the whole project
// (./answers `specDatasets`, `specMetrics`, `specTerms`), for the few a verified question names
// (./verifiedState `verifiedEnvFor`) and for what one answer's spec says (`vocabularyFor`, below), so they agree entry
// for entry (scripts/test-verifiedNarrowEnv.ts, scripts/test-askIndex.ts).

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import { hiddenColumnsFor } from '../data/rowAccess';
import { dropHidden } from '../ai/hiddenFacts';
import { mentionable } from '../data/columnAccess';
import { metricHidden } from '../analysis/columnHidden';
import { loadShared as loadCatalog } from '../app/catalog';
import { shownNames, taughtNames } from '../app/columnNames';
import { pendingMetric } from '../analysis/pendingKinds';
import { vocabularyOrder } from '../analysis/statusNotes';
import { statusFor, type StatusState } from '../analysis/statusStore';
import { readMeasure, type SpecDataset, type SpecMetric } from '../ai/answerSpec';
import type { SpecTerm } from '../ai/termFacts';
import * as terms from '../analysis/terms';
import { getTerm, type TermSummary } from '../analysis/terms';
import { datasetFilePath } from '../data/datasetRecord';
import { bodyOf, readTexts } from '../app/recordTexts';
import { isValidId } from '../app/ids';
import { indexedFor, keyedModel, lowerKey, newestModel, squashKey } from './assistantSearch';
import { perAsk } from './askMemo';

/** The datasets `ids` (a missing one left out), for the caller: a hidden column is no word of theirs. ONE catalog read. `textOf`: each record's text, read already. */
export async function specDatasetsOf(projectId: string, ids: readonly string[], textOf?: (id: string) => () => string): Promise<SpecDataset[]> {
  const metas = await Promise.all(ids.map((id) => datasets.getDatasetMeta(projectId, id, false, textOf?.(id))));
  const docs = (await loadCatalog(projectId)).columns;
  const out: SpecDataset[] = [];
  for (const m of metas) {
    if (!m) continue;
    const columns = dropHidden(m.columns, await hiddenColumnsFor(projectId, m.id)); // a hidden column is no word a spec may use (part 4, D21)
    out.push({ id: m.id, name: m.name, columns, names: taughtNames(columns, docs[m.id]), shown: shownNames(columns, docs[m.id]) });
  }
  return out;
}

const statusField = async (status: ReturnType<typeof statusFor>, ref: string): Promise<{ status?: { state: StatusState } }> => {
  const st = await status(ref);
  return st ? { status: { state: st.state } } : {};
};

/** The metrics of `list()` (summaries in `listMetrics` order) a spec may name, certified first. */
export async function specMetricsFrom(projectId: string, list: () => Promise<metrics.MetricSummary[]>): Promise<SpecMetric[]> {
  const out: SpecMetric[] = [];
  try {
    const status = statusFor(projectId);
    for (const s of await list()) {
      // A layer's metric (part 7 mirror): named, it is a measure of its own semantic dataset, by id.
      if (metrics.isExternalDefinition(s.definition)) {
        out.push({ id: s.id, name: s.name, datasetId: s.datasetId, external: true, ...await statusField(status, `metric:${s.id}`) });
        continue;
      }
      // Part 5's shapes are not named by a model on this release; one reading a hidden column is not the caller's (part 4).
      if (!metrics.isSimpleDefinition(s.definition) || pendingMetric(s) || (await metricHidden(projectId, s.id))) continue;
      const full = await metrics.getMetric(projectId, s.id);
      out.push({
        id: s.id, name: s.name, datasetId: s.datasetId,
        column: s.definition.column, aggregation: s.definition.aggregation,
        // A snapshot is not a plain total either: named, it is that metric, never a bare column measure.
        hasFilters: !!(full && (full.filters.length || (metrics.isSimpleDefinition(full.definition) && full.definition.snapshot))),
        ...(s.timeColumn ? { timeColumn: s.timeColumn } : {}),
        ...await statusField(status, `metric:${s.id}`),
      });
    }
  } catch (_) { /* no metric vocabulary — the spec must name columns */ }
  return vocabularyOrder(out, () => true); // certified first; the validator keeps a retired one, which still computes
}

/** A glossary term a spec may name (semantic D10): names and aliases only, no filter value. */
export const specTermOf = (t: Pick<TermSummary, 'id' | 'name' | 'aliases' | 'datasetId'>): SpecTerm => ({ id: t.id, name: t.name, aliases: t.aliases, datasetId: t.datasetId });

// ── The whole project's: the reference, and the vocabulary without a database ──

/**
 * Every dataset a spec may name: its columns, and what people call them — the
 * display names and "Also called" names the facts told the model to use, so a
 * spec written in those words resolves. ONE catalog read for the project;
 * records only, so a Live dataset is listed like any other.
 *
 * The three vocabularies are built once per question (./askMemo `perAsk`), for
 * the caller (a hidden column is no word of theirs). Their readers never change them.
 */
export const specDatasets = (projectId: string): Promise<SpecDataset[]> =>
  perAsk(`specDatasets\0${projectId}`, async () => specDatasetsOf(projectId, (await datasets.listDatasets(projectId)).map((d) => d.id)));

/** The saved metrics a spec may name. Exported for scripts/test-snapshot.ts. */
export const specMetrics = (projectId: string): Promise<SpecMetric[]> => perAsk(`specMetrics\0${projectId}`, () => specMetricsFrom(projectId, () => metrics.listMetrics(projectId)));

/** The glossary terms a spec may name (semantic D10): names and aliases only, no filter value. */
export const specTerms = (projectId: string): Promise<SpecTerm[]> => perAsk(`specTerms\0${projectId}`, async () => (await terms.listTerms(projectId)).map(specTermOf));


// ── What ONE validation may name, off step 3's index (docs/assistant "Scale rules") ─────────────────────────────────
//
// The answer validator (../ai/answerSpec validateAnswerSpec) and its "Did you mean" (../ai/answerSuggest) resolve a
// dataset by id, then by name trimmed and lowercased (one only), then squashed (one only); a measure's name against the
// metrics of that name (the first on its dataset; any other dataset's refuses); a term by id, then name or other name
// lowercased, then squashed. So the vocabulary they need is every dataset, metric and term whose name the specs SAY, as
// those rules compare it: the index's exact-lookup keys (./assistantSearch lowerKey, squashKey) find them, a key is only
// a candidate, and the records read are the whole vocabulary's entries, in its order. scripts/test-askIndex.ts holds the
// outcome Object.is-equal to the whole vocabulary, for an admin and a restricted viewer.

export interface Vocabulary { datasets: SpecDataset[]; metrics: SpecMetric[]; terms: SpecTerm[] }

export interface VocabularyWant {
  /** The raw specs to validate: the model's, and (a follow-up) the answer it continues. */
  specs: unknown[];
  /** Datasets by id: the default (what is open, the previous answer's) and "Did you mean" candidates. */
  datasetIds?: readonly string[];
  /** Metrics by id: the previous answer's measures (refineSpec carries a metric by name). */
  metricIds?: readonly string[];
  /** An Assistant agent's topic: the only datasets a spec may name, all read. */
  only?: ReadonlySet<string> | null;
  /** A spec names no dataset and nothing is the default: the validator then takes the one dataset, if there is one. */
  anyDataset?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The names `specs` say, as the validator reads them. */
export function specNames(specs: readonly unknown[]): { datasets: string[]; measures: string[]; terms: string[] } {
  const out = { datasets: [] as string[], measures: [] as string[], terms: [] as string[] };
  for (const raw of specs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const ds = str(o.dataset ?? o.datasetId);
    if (ds) out.datasets.push(ds.trim());
    for (const m of Array.isArray(o.measures) ? o.measures : o.measure !== undefined ? [o.measure] : []) {
      const c = readMeasure(m)?.column;
      out.measures.push(typeof c === 'string' ? c : ''); // a name that is no string reads as '' (resolveMeasure)
    }
    for (const f of arr(o.filters)) if (f && typeof f === 'object' && 'term' in f && typeof (f as { term: unknown }).term === 'string') out.terms.push((f as { term: string }).term);
  }
  return out;
}

/** listDatasets' order (newest updated first, then as the store lists them: by id), and listMetrics' (by name, then id). */
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const datasetOrder = (a: datasets.DatasetSummary, b: datasets.DatasetSummary): number => (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) || byId(a, b);
const metricOrder = (a: metrics.MetricSummary, b: metrics.MetricSummary): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byId(a, b);

function parsed<T>(textOf: (path: string) => () => string, path: string, parse: (body: string) => T | null): T | null {
  const body = bodyOf(textOf, path);
  try {
    return body === null ? null : parse(body);
  } catch (_) {
    return null; // corrupt: its list skips it too
  }
}

/**
 * The vocabulary `want` needs, off the index: a few lookups and one read of the records they find. Null without a
 * database or when a lookup fails (logged once): the caller builds the whole vocabulary, the reference.
 */
export async function vocabularyFor(projectId: string, want: VocabularyWant): Promise<Vocabulary | null> {
  if (!indexedFor(projectId)) return null;
  const said = specNames(want.specs);
  const ok = (id: string): boolean => isValidId(projectId) && isValidId(id);
  // Datasets: a topic's are all read; else the ones named, by id or by name, the defaults, and two of the project's when the one dataset may be meant.
  let dsIds: string[];
  if (want.only) dsIds = [...want.only];
  else {
    const named = await keyedModel(projectId, 'dataset', said.datasets.flatMap((r) => [lowerKey(r), ...squashKey(r)]));
    const two = want.anyDataset ? await newestModel(projectId, 'dataset', 2, true) : [];
    if (!named || !two) return null;
    dsIds = [...(want.datasetIds ?? []), ...said.datasets, ...named.map((h) => h.id), ...two.map((h) => h.id)];
  }
  // Metrics: the ones carried by id, then every metric of each name said (those carried are named by theirs too).
  const mFile = (id: string) => metrics.metricFilePath(projectId, id);
  const carried = await readTexts((want.metricIds ?? []).filter(ok).map(mFile));
  const carriedNames = (want.metricIds ?? []).filter(ok).flatMap((id) => parsed(carried, mFile(id), (b) => metrics.summaryOf(projectId, b))?.name ?? []);
  const [mHits, tHits] = await Promise.all([
    keyedModel(projectId, 'metric', [...said.measures, ...carriedNames].map(lowerKey)),
    keyedModel(projectId, 'term', said.terms.flatMap((t) => [lowerKey(t), ...squashKey(t.trim().toLowerCase())])),
  ]);
  if (!mHits || !tHits) return null;
  const ids = (xs: readonly string[]): string[] => [...new Set(xs)].filter(ok);
  const [dIds, mIds, tIds] = [ids(dsIds), ids([...(want.metricIds ?? []), ...mHits.map((h) => h.id)]), ids([...said.terms, ...tHits.map((h) => h.id)])];
  const dFile = (id: string) => datasetFilePath(projectId, id);
  const tFile = (id: string) => terms.termFile(projectId, id);
  const textOf = await readTexts([...dIds.map(dFile), ...mIds.map(mFile), ...tIds.map(tFile)]); // ONE query for all three
  const sets = dIds.flatMap((id) => parsed(textOf, dFile(id), (b) => datasets.summaryOf(projectId, b)) ?? []).sort(datasetOrder);
  const ms = mIds.flatMap((id) => parsed(textOf, mFile(id), (b) => metrics.summaryOf(projectId, b)) ?? []).sort(metricOrder);
  const [specSets, specMs, ts] = await Promise.all([
    specDatasetsOf(projectId, sets.map((s) => s.id), (id) => textOf(dFile(id))),
    specMetricsFrom(projectId, async () => ms),
    Promise.all(tIds.map((id) => getTerm(projectId, id, textOf(tFile(id))).catch(() => null))),
  ]);
  return { datasets: specSets, metrics: specMs, terms: ts.flatMap((t) => (t ? [specTermOf(t)] : [])) };
}

/**
 * The metrics `ids`, and every metric that shares a name (trimmed, lowercased) with one, in listMetrics' order: two
 * reads and one index lookup. Null without the index: the caller lists them all.
 */
export async function metricsNamedAs(projectId: string, ids: readonly string[]): Promise<metrics.MetricSummary[] | null> {
  if (!indexedFor(projectId)) return null;
  const file = (id: string) => metrics.metricFilePath(projectId, id);
  const own = [...new Set(ids)].filter((id) => isValidId(projectId) && isValidId(id));
  const first = await readTexts(own.map(file));
  const names = own.flatMap((id) => parsed(first, file(id), (b) => metrics.summaryOf(projectId, b))?.name ?? []);
  const hits = await keyedModel(projectId, 'metric', names.map(lowerKey));
  if (!hits) return null;
  const all = [...new Set([...own, ...hits.map((h) => h.id)])].filter((id) => isValidId(id));
  const textOf = await readTexts(all.map(file));
  return all.flatMap((id) => parsed(textOf, file(id), (b) => metrics.summaryOf(projectId, b)) ?? []).sort(metricOrder);
}

/** A formula with more stretches than this reads every metric instead (../data/columnAccess mentionable). */
const MAX_SAID = 2_000;

/**
 * What `metricsByName(projectId).values()` holds of the names `formula` says (../analysis/columnHidden: matched as
 * mentionsHidden matches): the first metric of each lower-cased name in listMetrics' order, its full record, in that
 * order. Each stretch of the formula is looked up by its name key, a candidate only; the records read decide, by the
 * rule metricsByName applies, so the metrics a name holds are all read. Null without the index, or for a formula of
 * more than MAX_SAID stretches: the caller reads every metric.
 */
export async function metricsSaidIn(projectId: string, formula: string): Promise<metrics.Metric[] | null> {
  if (!indexedFor(projectId)) return null;
  const said = mentionable(formula, MAX_SAID);
  const hits = said && (said.length ? await keyedModel(projectId, 'metric', said.map(lowerKey)) : []);
  if (!hits) return null;
  const file = (id: string) => metrics.metricFilePath(projectId, id);
  const ids = [...new Set(hits.map((h) => h.id))].filter((id) => isValidId(id));
  const textOf = await readTexts(ids.map(file));
  const byName = new Map<string, metrics.Metric>();
  for (const s of ids.flatMap((id) => parsed(textOf, file(id), (b) => metrics.summaryOf(projectId, b)) ?? []).sort(metricOrder)) {
    const key = s.name.toLowerCase();
    if (byName.has(key)) continue;
    const full = await metrics.getMetric(projectId, s.id, textOf(file(s.id)));
    if (full) byName.set(key, full);
  }
  return [...byName.values()];
}
