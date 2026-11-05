// THE ROWS BEHIND A FIGURE — what `visual:rows` and `visual:rowsDownload` read.
//
// One function, so the panel and its CSV can never select different rows. It
// runs the same two whitelists and the same parameter resolution `visual:data`
// runs, then adds the two things `resolveDrill` (./visuals, pure) cannot know
// on its own:
//
//   · a saved METRIC's own filters. "Revenue, excluding refunds" is part of
//     what Revenue means (analysis/metrics), so the rows behind a KPI that
//     shows it are the card's filters AND the metric's. A formula metric
//     ([Profit] / [Revenue]) is refused: no one set of rows adds up to a ratio
//     of two rollups, and this panel never shows an approximate set.
//
//   · a CHART'S followed metric. A bar over a measure that names "Tier 3 qty"
//     is drawn under that metric's filters (analysis/metricMeasures), so the
//     rows behind it carry them too, or they would not add up to the bar. A
//     chart whose measures need different filter lists (a per-measure plan)
//     keeps the chart's own rows: no one set of rows adds up to two lists.
//
//   · a dashboard date control's period on the date the figure counts by
//     (analysis/metricTimeScope): the chart's, or the KPI's metric's. A chart
//     the door refuses for it has no rows either.
//
//   · the GRAIN of a dated axis. A month's bar is every row dated in that
//     month, but only the chart's own answer says the axis was bucketed by
//     month — so the chart is asked (the cached answer the tile was drawn from)
//     and the label becomes the exact range "Explain this change" compares.

import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParsedColumn } from '../data/parse';
import type { DateGrain } from '../analysis/categoryKey';
import { isLive } from '../data/liveDataset';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { planMetricMeasures } from '../analysis/metricMeasures';
import { chartScope, metricScope } from '../analysis/metricTimeScope';
import { resolveDrill, vizDataFor } from './visuals';
import type { DrillMark, DrillResolution } from './visuals';
import { externalPending } from '../analysis/externalMetricMessages';

export interface DrillRequest {
  encoding: unknown;
  filters: unknown;
  mark: unknown;
  params: unknown;
  /** A KPI card's saved metric, when the figure is one. */
  metricId?: unknown;
}

export async function drillFilters(projectId: string, datasetId: string, meta: { columns: ParsedColumn[]; mode?: unknown }, req: DrillRequest): Promise<DrillResolution> {
  const columns = meta.columns;
  const enc = visuals.sanitizeEncoding(req.encoding);
  const values = paramValues(req.params);
  let filters = resolveFilterParams(visuals.sanitizeFilters(req.filters), values).steps;
  // A followed metric's filters lead the ROWS' scope only: the grain question below is the tile's, so it keeps the filters as the tile asked them (its cached answer).
  let followed: FilterStep[] = [];

  if (typeof req.metricId === 'string' && req.metricId) {
    const metric = await metrics.getMetric(projectId, req.metricId);
    if (!metric || metric.datasetId !== datasetId) return { available: false, reason: 'That metric no longer exists.' };
    if (metrics.isExternalDefinition(metric.definition)) return { available: false, reason: externalPending(metric.name) }; // only its layer has its rows
    if ('formula' in metric.definition) {
      // ponytail: every formula is refused; one whose operands share their filters could list those rows — add when asked for.
      return { available: false, reason: `"${metric.name}" is calculated from other metrics, so no one set of rows adds up to it. Open a metric it is built from to see its rows.` };
    }
    const scoped = await metricScope(projectId, metric, filters);
    if (!scoped.ok) return { available: false, reason: scoped.error };
    filters = resolveFilterParams(metric.filters || [], values).steps.concat(scoped.filters);
  } else {
    const scoped = await chartScope(projectId, datasetId, enc, filters);
    if (!scoped.ok) return { available: false, reason: scoped.error };
    filters = scoped.filters;
    const plan = await planMetricMeasures(projectId, datasetId, enc, values);
    if (plan?.ok && !plan.plan) followed = plan.filters;
  }

  // resolveDrill reads a mark's two fields by type (its markValue), so the shape is all that is asserted here.
  const mark = (req.mark && typeof req.mark === 'object' ? req.mark : undefined) as DrillMark | undefined;
  let grain: DateGrain | undefined;
  const dated = mark && mark.category !== undefined && columns.some((c) => c.name === enc.category && c.type === 'date');
  // Not for a Live dataset: its rows cannot be listed (D6), so the warehouse is not asked a question only to refuse after.
  if (dated && !isLive(meta)) {
    const chart = await vizDataFor(projectId, datasetId, enc, filters, { params: values });
    if (chart.ok && chart.category && chart.category.kind === 'date') grain = chart.category.grain;
  }
  return resolveDrill(columns, enc, followed.concat(filters), mark, grain);
}

/** A category (or split) from a related dataset is not this table's column, even under the same name: no rows of this table are behind it. */
export function joinedCategoryRefusal(encoding: VizEncoding): string | null {
  const column = encoding.categoryDatasetId ? encoding.category : encoding.series && encoding.seriesDatasetId ? encoding.series : null;
  return column ? `“${column}” comes from a related dataset, so the rows behind this mark cannot be listed here.` : null;
}
