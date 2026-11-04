// The date a metric counts by (semantic layer D9): the READS around `Metric.timeColumn`. The pure rewrite of a
// control's period is ./metricTime; this file asks the dataset. Schema only: a Live dataset is never read for rows.

import * as datasets from '../data/datasets';
import { isFormulaDefinition, metricsByName, sanitizeDefinition } from './metrics';
import type { Metric, MetricDefinition } from './metrics';
import { compileMetricFormula } from './metricFormula';
import { bindFormulaText } from './params';
import { relatedColumnNames } from '../ipc/relationships';
import * as msg from './metricCheckMessages';

type Columns = { columns: { name: string; type: string }[] } | null;
const isDate = (meta: Columns, column: string): boolean => !!meta && meta.columns.some((c) => c.name === column && c.type === 'date');

/** The date column a metric counts by, or `''` when it has none or the column is no longer a date column of its dataset. */
export async function metricDate(projectId: string, m: Pick<Metric, 'datasetId' | 'timeColumn'>): Promise<string> {
  return m.timeColumn && isDate(await datasets.getDatasetMeta(projectId, m.datasetId), m.timeColumn) ? m.timeColumn : '';
}

interface TimeInput {
  name: string;
  datasetId: string;
  definition: MetricDefinition;
  /** The date as the caller names it: `undefined` and `''` are both "none named". */
  timeColumn?: string;
}

/** What a save or an update does about the date: the sentence refusing it (beside the `timeColumn` field), or the date to store when the formula took its parts'. */
export type TimeVerdict = { error: string } | { timeColumn?: string };

const ownDate = (input: TimeInput): string => (input.timeColumn ?? '').trim();
const shown = (date: string): string => date || msg.dashboardDate();

/** The metrics a formula names (`[Revenue]`), each with the dataset and the date it counts by; unknown names are the formula's own problem. */
async function partsOf(projectId: string, input: TimeInput, meta: NonNullable<Columns>): Promise<Map<string, { name: string; date: string }[]>> {
  const byDataset = new Map<string, { name: string; date: string }[]>();
  if (!isFormulaDefinition(input.definition)) return byDataset;
  const columns = meta.columns.map((c) => c.name).concat(await relatedColumnNames(projectId, input.datasetId));
  const compiled = compileMetricFormula(bindFormulaText(input.definition.formula, new Map()).text, columns);
  if (!compiled.ok) return byDataset;
  const byName = await metricsByName(projectId);
  for (const ref of new Set(compiled.program.metricRefs.map((r) => r.toLowerCase()))) {
    const part = byName.get(ref);
    if (!part) continue;
    byDataset.set(part.datasetId, [...(byDataset.get(part.datasetId) ?? []), { name: part.name, date: await metricDate(projectId, part) }]);
  }
  return byDataset;
}

/**
 * The verdict on a metric's date, from one read of its dataset and of its parts.
 *
 * A date is a date column of the metric's own dataset. A formula counts by one date per dataset, so the metrics it
 * names on one dataset must count by the same date (its own, when it names one): parts on different datasets never
 * conflict, each counts by its own. A formula that names no date takes the date its parts on ITS dataset share, which
 * is a date column of that dataset because `metricDate` checked it there, and none when they have none. Asked when the
 * metric is saved, never afterwards: a part whose date moves later leaves the formula as it was.
 */
async function judge(projectId: string, input: TimeInput): Promise<TimeVerdict> {
  const meta = await datasets.getDatasetMeta(projectId, input.datasetId);
  if (!meta) return {}; // the save says the dataset is gone
  const own = ownDate(input);
  if (own && !isDate(meta, own)) return { error: msg.notADateColumn(own) };
  const parts = await partsOf(projectId, input, meta);
  for (const [datasetId, group] of parts) {
    const mine = !!own && datasetId === input.datasetId;
    const off = group.find((p) => p.date !== (mine ? own : group[0].date));
    if (off) {
      return { error: mine ? msg.formulaDatesDiffer(input.name, off.name, shown(off.date), own) : msg.formulaPartsDiffer(input.name, group[0].name, shown(group[0].date), off.name, shown(off.date)) };
    }
  }
  const inherited = own ? '' : (parts.get(input.datasetId)?.[0].date ?? '');
  return inherited ? { timeColumn: inherited } : {};
}

/** The sentence refusing a metric's date, or null. */
export async function checkTimeColumn(projectId: string, input: TimeInput): Promise<string | null> {
  const v = await judge(projectId, input);
  return 'error' in v ? v.error : null;
}

/** `metric:save`: the date of the input as it arrived. */
export function settleOnSave(projectId: string, raw: Record<string, any>): Promise<TimeVerdict> { // any: the zod-checked input, read field by field
  return judge(projectId, { name: String(raw.name).trim(), datasetId: raw.datasetId, definition: sanitizeDefinition(raw.definition), timeColumn: raw.timeColumn });
}

/**
 * `metric:update`: asked only when the patch can change the answer (its definition or its date). The stored date is
 * not consulted: a patch that names none leaves it alone, unless the formula's new parts share one, which replaces it
 * (and a stored date whose column is gone never blocks the edit). Naming one checks it against the parts as they are.
 */
export async function settleOnUpdate(projectId: string, before: Metric, patch: Record<string, any>): Promise<TimeVerdict> { // any: the zod-checked patch
  if (patch.definition === undefined && patch.timeColumn === undefined) return {};
  return judge(projectId, {
    name: String(patch.name ?? before.name).trim(),
    datasetId: before.datasetId,
    definition: patch.definition !== undefined ? sanitizeDefinition(patch.definition) : before.definition,
    timeColumn: patch.timeColumn,
  });
}
