// How the Assistant is told a chart's FILTERED metric measures — MAIN PROCESS. Reads the metrics store.
//
// A bar over "Tier 3 qty" is drawn under that metric's filters (analysis/metricMeasures). Told only
// `sum(qty)`, a model would narrate those figures as the column's total. So a followed simple metric with
// filters is worded as its name, its definition and its filters, in the words a metric is worded in everywhere
// else (analysis/metricFormat.describeFilter). Any other measure gets no text here and keeps its bare
// `aggregation(column)` line (ai/copilotFacts.visualFacts).

import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import { describeDefinition, describeFilter } from '../analysis/metricFormat';
import { followedDefinition, needsMetricPlan } from '../analysis/metricMeasures';
import { listRelationships } from '../analysis/relationships';
import * as datasets from '../data/datasets';
import { columnOwner } from './relationships';
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

/**
 * Whether the Assistant must not be told this filter step's value: the column's owner marks it personal or financial
 * (columnNotes.withheldColumns), or its owner cannot be read. `datasetId` is the dataset the filter runs on and `docs`
 * its column notes. A bare column is whoever the engine reads it from: that dataset, else the NEAREST related one. A step
 * with `via` names the RELATED end of that relationship. A step this pod cannot read holds no value we show.
 */
export function stepWithholder(projectId: string, datasetId: string, docs: Record<string, FactColumnDoc>): (s: FilterStep) => Promise<boolean> {
  const withheld = withheldColumns(docs);
  // The datasets whose marks decide a step's column. None: unresolvable.
  const owners = async (s: FilterStep): Promise<string[]> => {
    if (!s.via) {
      const owner = await columnOwner(projectId, datasetId, s.column);
      return owner ? [owner] : [];
    }
    const rel = (await listRelationships(projectId)).find((r) => r.id === s.via);
    return rel ? [rel.from.datasetId, rel.to.datasetId].filter((id) => id !== datasetId) : [];
  };
  // Withheld when ANY owner marks it, and when an owner cannot be read (a dataset that is gone, a column nobody has).
  return async (s) => {
    if (isKeptStep(s)) return false;
    const ids = await owners(s);
    if (!ids.length) return true;
    return (await Promise.all(ids.map(async (id) => {
      if (id === datasetId) return withheld.has(s.column);
      return !(await datasets.getDatasetMeta(projectId, id)) || withheldColumns(await assistantColumnDocs(projectId, id)).has(s.column);
    }))).some(Boolean);
  };
}

const withheldWords = (s: FilterStep): string => `${s.column} ${WITHHELD}`;

/** `describeDefinition` of a stored metric as the Assistant is told it: a withheld filter names its column and not its value. */
export async function metricDefinitionText(projectId: string, m: Pick<Metric, 'datasetId' | 'definition' | 'filters'>, docs: Record<string, FactColumnDoc>): Promise<string> {
  const filters = Array.isArray(m.filters) ? m.filters : [];
  const withholds = stepWithholder(projectId, m.datasetId, docs);
  const hidden = new Set(await Promise.all(filters.map(async (s) => ((await withholds(s)) ? s : null))));
  return describeDefinition(m, (s) => (hidden.has(s) ? withheldWords(s) : describeFilter(s)));
}

/** By `encoding.values` index: the measure's line, or undefined when its bare `aggregation(column)` is the truth. */
export async function followedMeasureTexts(projectId: string, datasetId: string, encoding: VizEncoding, docs: Record<string, FactColumnDoc>): Promise<(string | undefined)[]> {
  const withholds = stepWithholder(projectId, datasetId, docs);
  // A value of a column the user marked personal or financial is never shown (columnNotes.withheldColumns).
  const say = async (s: FilterStep): Promise<string> => ((await withholds(s)) ? withheldWords(s)
    : isKeptStep(s) ? describeFilter(s) // a step this pod cannot read: named by its kind, it holds no value we show
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
