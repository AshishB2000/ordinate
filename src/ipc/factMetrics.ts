// The defined metrics an ask's facts state, resolved (./copilot buildFacts) — MAIN PROCESS ONLY. A dataset's metrics
// are found through step 3's index (./assistantSearch keyedModel, `d:` keys) and read by id: never every metric of the
// project (docs/assistant/00-design.md, "Scale rules"). Without a database, the list.

import * as metrics from '../analysis/metrics';
import { metricHidden } from '../analysis/columnHidden';
import { metricAdditivity } from '../analysis/additivity';
import { metricNames, metricsReached } from '../analysis/metricNames';
import { metricDate } from '../analysis/metricTimeScope';
import { statusFor } from '../analysis/statusStore';
import { namedIn, vocabularyOrder } from '../analysis/statusNotes';
import { kpiHidden } from '../publish/kpiPolicy';
import type { SharePath } from '../app/privacyStore';
import { assistantColumnDocs as catalogColumns } from '../app/sharePolicy';
import { bodyOf, readTexts } from '../app/recordTexts';
import { isValidId } from '../app/ids';
import type { FactMetric } from '../ai/copilotFacts';
import { resolveMetric, type MetricRead } from './metrics';
import { metricDefinitionText } from './copilotMeasures';
import { isLiveFigureError } from './liveRoute';
import { targetField, targetHidden } from './targetResolve';
import type { SavedScope } from './copilotCards';
import { keyedModel, onKey, searchModel } from './assistantSearch';

/** At most this many metrics a dashboard question adds to the dashboard's own (Q12): each is a query, a Live one in the warehouse. */
export const QUESTION_METRICS = 5;

/** listMetrics' order: by name (locale-aware, case-insensitive), then as the store lists them (by id). */
const listOrder = (a: metrics.MetricSummary, b: metrics.MetricSummary): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The metrics on `on`'s datasets, and `also` by id, in listMetrics' order: one index query and one read of their records. */
export async function metricsOn(projectId: string, on: ReadonlySet<string>, also: readonly string[] = []): Promise<metrics.MetricSummary[]> {
  const hits = await keyedModel(projectId, 'metric', [...on].map(onKey));
  if (hits === null) return (await metrics.listMetrics(projectId)).filter((s) => on.has(s.datasetId) || also.includes(s.id));
  const ids = [...new Set([...hits.map((h) => h.id), ...also])].filter((id) => isValidId(projectId) && isValidId(id));
  const file = (id: string) => metrics.metricFilePath(projectId, id);
  const textOf = await readTexts(ids.map(file));
  const out: metrics.MetricSummary[] = [];
  for (const id of ids) {
    const body = bodyOf(textOf, file(id));
    let s: metrics.MetricSummary | null = null;
    try {
      s = body === null ? null : metrics.summaryOf(projectId, body);
    } catch (_) { /* corrupt: the list skips it too */ }
    if (s && (on.has(s.datasetId) || also.includes(s.id))) out.push(s);
  }
  return out.sort(listOrder);
}

/** The metrics step 3 finds for a dashboard's question that are on none of `own` (the dashboard's datasets), best first. */
export async function questionMetrics(projectId: string, question: string | undefined, own: ReadonlySet<string>): Promise<string[]> {
  if (!question) return [];
  const hits = await searchModel(projectId, question, { kinds: ['metric'], limit: QUESTION_METRICS, exceptDatasetIds: [...own] }).catch(() => []);
  return hits.map((h) => h.id);
}

/**
 * The project's DEFINED metrics, resolved.
 *
 * Only the metrics on the datasets in `on`: the open dataset, or the datasets a
 * dashboard's tiles use — never every metric in the project (docs/assistant
 * "Scale rules": each is a query, a Live one in the warehouse). Exported for
 * scripts/test-askDatasetFacts.ts. Each figure comes back from the ordinary
 * resolver, so it is the same number the card shows, formatted the same way —
 * and both go into the facts ledger at the call site. `scope`: the dashboard's saved filters and
 * parameters, so a metric reads here as its KPI card does on that dashboard. `also`: metrics by id, wherever they are
 * (`questionMetrics`, a dashboard's question).
 *
 * Never throws: a project whose metrics cannot be read simply hands the model
 * no metric vocabulary, which is exactly the state every project was in before
 * this layer existed.
 */
export async function factMetrics(projectId: string, on: ReadonlySet<string>, scope?: SavedScope, question?: string, share?: SharePath, also: readonly string[] = []): Promise<FactMetric[]> {
  try {
    const status = statusFor(projectId); // once per request (part 4)
    const list = await metricsOn(projectId, on, also);
    // Only a formula or a period metric reads other metrics by name (../analysis/additivity): only the names it reaches, each read once.
    const names = metricNames(projectId);
    const namesFor = async (d: metrics.MetricDefinition) => (metrics.isFormulaDefinition(d) || metrics.isPeriodDefinition(d) ? metricsReached(projectId, [d], scope?.params, names) : new Map<string, metrics.Metric>());
    const out: FactMetric[] = [];
    const notes: Record<string, Awaited<ReturnType<typeof catalogColumns>>> = {}; // each dataset's column notes, read once
    for (const s of list) {
      // A layer's metric is the layer's figure, as a Live one is the warehouse's; one reading a hidden column is not the caller's vocabulary (part 4).
      if (!(on.has(s.datasetId) || also.includes(s.id)) || (await metricHidden(projectId, s.id))) continue;
      // A Live metric its warehouse could not give is left out (L2.4) — never a guess, and never the others with it.
      const reads: MetricRead[] = [];
      const r = await resolveMetric(projectId, s.id, share ? { ...scope, reads } : scope).catch((err: unknown) => {
        if (isLiveFigureError(err)) return null;
        throw err;
      });
      if (!r) continue;
      if (share && (await kpiHidden(projectId, reads, share))) continue; // leaving by a share path: a figure the policy withholds there is not the model's
      const additivity = (await metricAdditivity(projectId, s.id, await namesFor(s.definition), scope?.params)) ?? undefined;
      // Its filters are worded as the Assistant is told a chart's: a value of a column marked personal or financial is withheld.
      const stored = await metrics.getMetric(projectId, s.id);
      if (!stored) continue;
      const definitionText = await metricDefinitionText(projectId, stored, (notes[s.datasetId] ??= await catalogColumns(projectId, s.datasetId)));
      const date = await metricDate(projectId, s); // a date column that is gone counts as none (D9)
      const snapshot = metrics.isSimpleDefinition(s.definition) ? s.definition.snapshot : undefined;
      const st = await status(`metric:${s.id}`);
      out.push({ name: r.name, definitionText, value: r.value, display: r.display, additivity, description: s.description, ...(date ? { timeColumn: date } : {}), ...(snapshot ? { snapshot } : {}), ...(st ? { status: st, ...(st.replacedBy ? { replacedBy: st.replacedBy.name } : {}) } : {}), ...(await targetField(projectId, s.id, scope?.filters ?? [], r.value, await targetHidden(projectId, s.id, share))) });
    }
    return vocabularyOrder(out, (m) => namedIn(question, [m.name]));
  } catch (_) {
    return [];
  }
}

