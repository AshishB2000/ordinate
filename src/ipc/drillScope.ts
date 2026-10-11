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
import { resolveDrill, vizDataFor } from './visuals';
import type { DrillMark, DrillResolution } from './visuals';

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

  if (typeof req.metricId === 'string' && req.metricId) {
    const metric = await metrics.getMetric(projectId, req.metricId);
    if (!metric || metric.datasetId !== datasetId) return { available: false, reason: 'That metric no longer exists.' };
    if ('formula' in metric.definition) {
      // ponytail: every formula is refused; one whose operands share their filters could list those rows — add when asked for.
      return { available: false, reason: `"${metric.name}" is calculated from other metrics, so no one set of rows adds up to it. Open a metric it is built from to see its rows.` };
    }
    filters = resolveFilterParams(metric.filters || [], values).steps.concat(filters);
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
  return resolveDrill(columns, enc, filters, mark, grain);
}
