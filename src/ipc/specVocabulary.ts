// The words a chart spec may name, entry by entry. MAIN PROCESS. Built the same way for the whole project
// (./answers `specDatasets`, `specMetrics`, `specTerms`) and for the few a verified question names
// (./verifiedState `verifiedEnvFor`), so the two agree entry for entry (scripts/test-verifiedNarrowEnv.ts).

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import { hiddenColumnsFor } from '../data/rowAccess';
import { dropHidden } from '../ai/hiddenFacts';
import { metricHidden } from '../analysis/columnHidden';
import { loadShared as loadCatalog } from '../app/catalog';
import { shownNames, taughtNames } from '../app/columnNames';
import { pendingMetric } from '../analysis/pendingKinds';
import { vocabularyOrder } from '../analysis/statusNotes';
import { statusFor, type StatusState } from '../analysis/statusStore';
import type { SpecDataset, SpecMetric } from '../ai/answerSpec';
import type { SpecTerm } from '../ai/termFacts';
import type { TermSummary } from '../analysis/terms';

/** The datasets `ids` (a missing one left out), for the caller: a hidden column is no word of theirs. ONE catalog read. */
export async function specDatasetsOf(projectId: string, ids: readonly string[]): Promise<SpecDataset[]> {
  const metas = await Promise.all(ids.map((id) => datasets.getDatasetMeta(projectId, id)));
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
