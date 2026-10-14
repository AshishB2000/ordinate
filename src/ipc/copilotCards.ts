// The KPI figures in a dashboard's facts — MAIN.
//
// Each metric card's ONE number, as its tile shows it on the dashboard AS SAVED:
// under the dashboard-wide filters, every filter control at its default and the
// parameters at their saved values (savedViews.viewScope — what the page is
// computed under when it is opened), and through the doors `analysis:tiles`
// answers through, in its order. A card that names a saved metric is that metric
// (resolveMetric, as `metric:value`); one with no metric — none named, deleted,
// or no figure to give — is its own column and aggregation (computeCardMetric,
// as `dashboard:metric`). So a figure the Assistant narrates is the figure on
// screen, the page's own answer cache serves it, a Live dataset's comes from its
// warehouse, and `getDataset` is never called from this file
// (scripts/test-copilot-analysis-facts.ts compares each with `analysis:tiles`'
// own reply, Object.is; scripts/test-liveRouteAnswers.ts does on a Live dataset).

import type { Analysis } from '../analysis/analysis';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import { paramValues, resolveFilterParams, type ParamValues } from '../analysis/params';
import { viewScope } from '../analysis/savedViews';
import type { FilterStep } from '../data/transforms';
import { computeCardMetric } from './dashboards';
import { isLiveFigureError } from './liveRoute';
import { resolveMetric } from './metrics';

export interface SavedScope {
  filters: FilterStep[];
  params: ParamValues;
}

/** The dashboard as saved, as a query — sanitized and bound the way `dashboard:metric` and `metric:value` bind what a page sends. */
export function savedScope(a: Analysis): SavedScope {
  const scope = viewScope(null, a);
  const params = paramValues(scope.params);
  return { filters: resolveFilterParams(sanitizeDashboardFilters(scope.filters), params).steps, params };
}

/** A door's answer — or null where a Live figure could not be given: n/a, never a guess (L2.4). Anything else is a real failure. */
async function orNone<T>(asked: Promise<T>): Promise<T | null> {
  try {
    return await asked;
  } catch (err) {
    if (isLiveFigureError(err)) return null;
    throw err;
  }
}

/** One figure per metric card, in sheet order; null where the app has no number (a missing dataset, a Live figure its warehouse could not give). */
export async function metricCardFigures(projectId: string, a: Analysis, scope: SavedScope): Promise<{ label: string; value: number | null }[]> {
  const out: { label: string; value: number | null }[] = [];
  for (const page of a.sheets || []) {
    for (const card of page.cards || []) {
      if (card.type !== 'metric' || !card.metric) continue;
      const m = card.metric;
      const saved = m.metricId ? await orNone(resolveMetric(projectId, m.metricId, scope)) : null;
      const own = !saved && m.column
        ? await orNone(computeCardMetric(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, scope.filters, scope.params))
        : null;
      out.push({ label: m.label || (saved ? saved.name : '') || `${m.aggregation}(${m.column})`, value: saved ? saved.value : own ? own.value : null });
    }
  }
  return out;
}
