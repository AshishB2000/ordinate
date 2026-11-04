// How the Assistant is told a chart's FILTERED metric measures — MAIN PROCESS. Reads the metrics store.
//
// A bar over "Tier 3 qty" is drawn under that metric's filters (analysis/metricMeasures). Told only
// `sum(qty)`, a model would narrate those figures as the column's total. So a followed simple metric with
// filters is worded as its name, its definition and its filters, in the words a metric is worded in everywhere
// else (analysis/metricFormat.describeFilter). Any other measure gets no text here and keeps its bare
// `aggregation(column)` line (ai/copilotFacts.visualFacts).

import * as metrics from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { describeFilter } from '../analysis/metricFormat';
import { resolveFilterParams } from '../analysis/params';
import type { VizEncoding } from '../analysis/visuals';
import type { Cell, FilterStep } from '../data/transforms';
import { WITHHELD, withheldColumns } from '../ai/columnNotes';
import type { FactColumnDoc } from '../ai/columnNotes';
import { quoted } from '../ai/liveFacts';

// A text cell value is data a person wrote, so it is quoted the way the other facts quote data.
const quote = (c: Cell): Cell => (typeof c === 'string' ? quoted(c) : c);

/** By `encoding.values` index: the measure's line, or undefined when its bare `aggregation(column)` is the truth. */
export async function followedMeasureTexts(projectId: string, datasetId: string, encoding: VizEncoding, docs: Record<string, FactColumnDoc>): Promise<(string | undefined)[]> {
  const withheld = withheldColumns(docs);
  // A value of a column the user marked personal or financial is never shown (columnNotes.withheldColumns).
  const say = (s: FilterStep): string => (withheld.has(s.column) ? `${s.column} ${WITHHELD}`
    : describeFilter({ ...s, ...(s.value !== undefined && { value: quote(s.value) }), ...(s.values && { values: s.values.map(quote) }) }));
  return Promise.all((encoding.values || []).map(async (v) => {
    const m = v.metricId ? await metrics.getMetric(projectId, v.metricId) : null;
    if (!m || m.datasetId !== datasetId || isFormulaDefinition(m.definition) || !m.definition.column) return undefined;
    // The filters the chart draws it under: the door follows a metric with no parameters set (planMetricMeasures).
    const steps = resolveFilterParams(m.filters, new Map()).steps;
    if (!steps.length) return undefined;
    return `"${m.name}" = ${m.definition.aggregation}(${m.definition.column}) where ${steps.map(say).join(' and ')}`;
  }));
}
