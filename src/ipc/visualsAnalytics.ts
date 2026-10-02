// A chart's ANALYTICS OVERLAYS, resolved onto its `visual:data` reply. MAIN.
//
// The same shape as ./visualsOverlay's period overlay: a post-processing step on
// a reply the ordinary path already produced, never a second computation of the
// chart. The overlays are resolved by the pure analysis/analytics.ts against the
// reply's own `{labels, series}`; the ONE thing it cannot do purely is a metric,
// so each metric an overlay names is resolved here first — through the metrics
// layer (`resolveMetric`), under the chart's OWN scope (the filters and
// parameters the chart itself was computed under), so a "Revenue target" line
// on a West-filtered chart is West's target, the same figure a KPI card under
// that filter shows.

import type { FilterStep } from '../data/transforms';
import type { ParamValues } from '../analysis/params';
import { resolveOverlays } from '../analysis/analytics';
import type { Overlay, ResolvedOverlay } from '../analysis/analytics';
import type { CategoryInfo } from '../analysis/categoryKey';
import type { ChartData } from '../analysis/vizData';
import { resolveMetric } from './metrics';
import type { VizDataReply } from './visuals';

/** Every metric the overlays name → its figure under the scope. */
async function overlayMetrics(
  projectId: string, overlays: Overlay[], filters: FilterStep[], params?: ParamValues,
): Promise<Map<string, { name: string; value: number | null }>> {
  const out = new Map<string, { name: string; value: number | null }>();
  for (const ov of overlays) {
    if (ov.hidden) continue;
    for (const src of [ov.value, ov.from, ov.to]) {
      if (!src || src.type !== 'metric' || out.has(src.metricId)) continue;
      const r = await resolveMetric(projectId, src.metricId, { filters, params }).catch(() => null);
      out.set(src.metricId, r ? { name: r.name, value: r.value } : { name: 'Missing metric', value: null });
    }
  }
  return out;
}

/** Resolve overlays against chart data — the shared core of the reply hook and buildFacts. */
export async function resolveChartOverlays(
  projectId: string, data: ChartData, category: CategoryInfo | null | undefined,
  overlays: Overlay[], filters: FilterStep[], params?: ParamValues,
): Promise<ResolvedOverlay[]> {
  if (!overlays.length) return [];
  const metrics = await overlayMetrics(projectId, overlays, filters, params);
  return resolveOverlays(data, overlays, { category: category || null, metrics });
}

/** `reply` with `data.analytics` attached, or untouched when there is nothing to attach. Never throws. */
export async function withAnalytics(
  reply: VizDataReply, projectId: string, overlays: Overlay[], filters: FilterStep[], params?: ParamValues,
): Promise<VizDataReply> {
  try {
    if (!reply.ok || !overlays.length || reply.data.pivot || reply.data.geo) return reply;
    // Small multiples: each panel's overlays from its OWN figures, a metric
    // under the panel's own filter — an average line is that panel's average.
    const grid = reply.data.facets;
    if (grid) {
      // Copied, never mutated: the reply may be the answer cache's own object.
      const panels = await Promise.all(grid.panels.map(async (p) => {
        if (p.empty) return p;
        const analytics = await resolveChartOverlays(projectId, p, reply.category, overlays, filters.concat(p.steps), params);
        return analytics.length ? { ...p, analytics } : p;
      }));
      return { ...reply, data: { ...reply.data, facets: { ...grid, panels } } };
    }
    const analytics = await resolveChartOverlays(projectId, reply.data, reply.category, overlays, filters, params);
    return analytics.length ? { ...reply, data: { ...reply.data, analytics } } : reply;
  } catch (_) {
    return reply;
  }
}
