// Insights' calls (src/api/analyticsB.ts → src/ipc/insights.ts) and the reply
// shape, mirrored from src/analysis/insightsAgg.ts `Insight`. NOTHING HERE
// COMPUTES A NUMBER: every figure a card prints is one of `facts`, and its
// sparkline is the insight's own chart through the same `visual:data` a tile
// uses, so a card and the tile you save from it cannot disagree.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';

export interface Insight {
  id: string;
  kind: string;
  title: string;
  detail: string;
  severity: 'info' | 'warn';
  datasetId: string;
  column?: string;
  facts: Record<string, string | number>;
  chart?: { type: string; encoding: { category: string; values: Array<{ column: string; aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none' }> } & Record<string, unknown>; filters?: Array<{ type: string } & Record<string, unknown>> };
  periodKey?: string;
}

/** How long a project's findings are reused before they are asked for again. */
export const STALE_MS = 5 * 60_000;

type Reply = { ok: true; insights: Insight[] } | { ok: false; error: string };

export const insightsKey = (projectId: string, datasetId?: string) => ['insights:list', projectId, datasetId ?? null] as const;

/** One dataset's findings, or (no dataset) the project's strongest across its newest datasets. */
export function useInsights(projectId: string | undefined, datasetId?: string) {
  return useQuery({
    queryKey: insightsKey(projectId ?? '', datasetId),
    // A scan, cached on the server too: switching back to a project (Home follows the switcher) re-uses it.
    staleTime: STALE_MS,
    queryFn: projectId
      ? async () => {
          const r = (await rpc('insights:list', datasetId ? { projectId, datasetId } : { projectId })) as Reply;
          if (!r.ok) throw new Error(r.error || 'Could not read the insights.');
          return r.insights;
        }
      : skipToken,
  });
}

/** Dismiss a card for the whole project; every list drops it at once. */
export function useDismiss(projectId: string) {
  const qc = useQueryClient();
  return async (id: string) => {
    const r = (await rpc('insights:dismiss', { projectId, id })) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error || 'Could not dismiss the insight.');
    qc.setQueriesData<Insight[]>({ queryKey: ['insights:list', projectId] }, (list) => list?.filter((x) => x.id !== id));
  };
}

/** The desktop's kind headings, in its order (insights.ts INS_KIND_LABELS). */
export const KIND_LABELS: ReadonlyArray<[string, string]> = [
  ['mover', 'Biggest movers'],
  ['trend', 'Trends'],
  ['concentration', 'Concentration'],
  ['period_change', 'Period changes'],
  ['numeric_outlier', 'Outliers'],
  ['dominant_category', 'Dominant values'],
  ['empty_heavy', 'Mostly empty'],
  ['constant_column', 'Never changes'],
];
