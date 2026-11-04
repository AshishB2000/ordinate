// How the Assistant is told a chart's FILTERED metric measures — MAIN PROCESS. Reads the metrics store.
//
// A bar over "Tier 3 qty" is drawn under that metric's filters (analysis/metricMeasures). Told only
// `sum(qty)`, a model would narrate those figures as the column's total. So a followed simple metric with
// filters is worded as its name, its definition and its filters, in the words a metric is worded in everywhere
// else (analysis/metricFormat.describeFilter). Any other measure gets no text here and keeps its bare
// `aggregation(column)` line (ai/copilotFacts.visualFacts).

import * as metrics from '../analysis/metrics';
import { describeFilter } from '../analysis/metricFormat';
import { followedDefinition, needsMetricPlan } from '../analysis/metricMeasures';
import { listRelationships } from '../analysis/relationships';
import { assistantColumnDocs } from '../app/sharePolicy';
import { resolveFilterParams } from '../analysis/params';
import type { VizEncoding } from '../analysis/visuals';
import { isKeptStep } from '../data/filterList';
import type { Cell, FilterStep } from '../data/transforms';
import { WITHHELD, withheldColumns } from '../ai/columnNotes';
import type { FactColumnDoc } from '../ai/columnNotes';
import { quoted } from '../ai/liveFacts';

// A text cell value is data a person wrote, so it is quoted the way the other facts quote data.
const quote = (c: Cell): Cell => (typeof c === 'string' ? quoted(c) : c);

/** By `encoding.values` index: the measure's line, or undefined when its bare `aggregation(column)` is the truth. */
export async function followedMeasureTexts(projectId: string, datasetId: string, encoding: VizEncoding, docs: Record<string, FactColumnDoc>): Promise<(string | undefined)[]> {
  const withheld = withheldColumns(docs);
  // A step with `via` names a column of the RELATED dataset: its mark is that dataset's, and a relationship we cannot resolve withholds.
  const withholds = async (s: FilterStep): Promise<boolean> => {
    if (!s.via) return withheld.has(s.column);
    const rel = (await listRelationships(projectId)).find((r) => r.id === s.via);
    const ends = rel ? [rel.from.datasetId, rel.to.datasetId].filter((id) => id !== datasetId) : [];
    if (!ends.length) return true;
    return (await Promise.all(ends.map(async (id) => withheldColumns(await assistantColumnDocs(projectId, id))))).some((w) => w.has(s.column));
  };
  // A value of a column the user marked personal or financial is never shown (columnNotes.withheldColumns).
  const say = async (s: FilterStep): Promise<string> => (isKeptStep(s) ? describeFilter(s) // a step this pod cannot read: named by its kind, it holds no value we show
    : (await withholds(s)) ? `${s.column} ${WITHHELD}`
    : describeFilter({ ...s, ...(s.value !== undefined && { value: quote(s.value) }), ...(Array.isArray(s.values) && { values: s.values.map(quote) }) }));
  return Promise.all((encoding.values || []).map(async (v, i) => {
    const m = v.metricId ? await metrics.getMetric(projectId, v.metricId) : null;
    const def = followedDefinition(m, datasetId, encoding, i);
    if (!m || !def || !needsMetricPlan(m)) return undefined;
    // The filters the chart draws it under: the door follows a metric with no parameters set (planMetricMeasures).
    const steps = resolveFilterParams(m.filters, new Map()).steps;
    if (!steps.length) return undefined;
    return `"${m.name}" = ${def.aggregation}(${def.column}) where ${(await Promise.all(steps.map(say))).join(' and ')}`;
  }));
}
