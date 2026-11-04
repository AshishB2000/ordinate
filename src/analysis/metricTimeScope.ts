// The date a metric counts by (semantic layer D9): the READS around `Metric.timeColumn`. The pure rewrite of a
// control's period is ./metricTime; this file asks the dataset. Schema only: a Live dataset is never read for rows.

import * as datasets from '../data/datasets';
import { isFormulaDefinition, metricsByName, sanitizeDefinition } from './metrics';
import type { Metric, MetricDefinition } from './metrics';
import { compileMetricFormula } from './metricFormula';
import { bindFormulaText } from './params';
import { relatedColumnNames } from '../ipc/relationships';
import * as msg from './metricCheckMessages';

/** Whether `column` is a date column of the dataset. */
async function isDateColumn(projectId: string, datasetId: string, column: string): Promise<boolean> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return !!meta && meta.columns.some((c) => c.name === column && c.type === 'date');
}

/** The date column a metric counts by, or `''` when it has none or the column is no longer a date column of its dataset. */
export async function metricDate(projectId: string, m: Pick<Metric, 'datasetId' | 'timeColumn'>): Promise<string> {
  return m.timeColumn && (await isDateColumn(projectId, m.datasetId, m.timeColumn)) ? m.timeColumn : '';
}

interface TimeInput {
  name: string;
  datasetId: string;
  definition: MetricDefinition;
  timeColumn?: string;
}

/** The metrics a formula names (`[Revenue]`), with the date each counts by; unknown names are the formula's own problem. */
async function partDates(projectId: string, input: TimeInput): Promise<{ name: string; date: string }[]> {
  if (!isFormulaDefinition(input.definition)) return [];
  const meta = await datasets.getDatasetMeta(projectId, input.datasetId);
  const columns = (meta ? meta.columns.map((c) => c.name) : []).concat(await relatedColumnNames(projectId, input.datasetId));
  const compiled = compileMetricFormula(bindFormulaText(input.definition.formula, new Map()).text, columns);
  if (!compiled.ok) return [];
  const byName = await metricsByName(projectId);
  const out: { name: string; date: string }[] = [];
  for (const ref of new Set(compiled.program.metricRefs.map((r) => r.toLowerCase()))) {
    const part = byName.get(ref);
    if (part) out.push({ name: part.name, date: await metricDate(projectId, part) });
  }
  return out;
}

const OWN_DATE = (input: TimeInput): string => (input.timeColumn ?? '').trim();
const shown = (date: string): string => date || msg.dashboardDate();

/**
 * The sentence refusing a metric's date, or null. A date is a date column of the dataset; a formula counts by one
 * date, so every metric it names counts by that same date (a formula with none of its own needs its parts to agree,
 * and `inheritedDate` hands it theirs). Checked when the metric is saved, never afterwards: a part whose date moves
 * later leaves the formula as it was.
 */
export async function checkTimeColumn(projectId: string, input: TimeInput): Promise<string | null> {
  const own = OWN_DATE(input);
  if (own && !(await isDateColumn(projectId, input.datasetId, own))) return msg.notADateColumn(own);
  const parts = await partDates(projectId, input);
  if (own) {
    const off = parts.find((p) => p.date !== own);
    return off ? msg.formulaDatesDiffer(input.name, off.name, shown(off.date), own) : null;
  }
  const off = parts.find((p) => p.date !== parts[0].date);
  return off ? msg.formulaPartsDiffer(input.name, parts[0].name, shown(parts[0].date), off.name, shown(off.date)) : null;
}

/** The date a formula with none of its own takes: the one its parts share, `''` when they have none. Run after `checkTimeColumn` accepts it. */
export async function inheritedDate(projectId: string, input: TimeInput): Promise<string> {
  if (OWN_DATE(input)) return '';
  return (await partDates(projectId, input))[0]?.date ?? '';
}

/** What a save or an update does about the date: the sentence refusing it (beside the `timeColumn` field), or the date to store when the formula took its parts'. */
export type TimeVerdict = { error: string } | { timeColumn?: string };

async function settle(projectId: string, input: TimeInput): Promise<TimeVerdict> {
  const error = await checkTimeColumn(projectId, input);
  if (error) return { error };
  const timeColumn = await inheritedDate(projectId, input);
  return timeColumn ? { timeColumn } : {};
}

/** `metric:save`: the date of the input as it arrived. */
export function settleOnSave(projectId: string, raw: Record<string, any>): Promise<TimeVerdict> { // any: the zod-checked input, read field by field
  return settle(projectId, { name: String(raw.name).trim(), datasetId: raw.datasetId, definition: sanitizeDefinition(raw.definition), timeColumn: raw.timeColumn });
}

/** `metric:update`: the record as the patch leaves it, asked only when the patch can change the answer (its definition or its date). */
export async function settleOnUpdate(projectId: string, before: Metric, patch: Record<string, any>): Promise<TimeVerdict> { // any: the zod-checked patch
  if (patch.definition === undefined && patch.timeColumn === undefined) return {};
  return settle(projectId, {
    name: String(patch.name ?? before.name).trim(),
    datasetId: before.datasetId,
    definition: patch.definition !== undefined ? sanitizeDefinition(patch.definition) : before.definition,
    timeColumn: patch.timeColumn !== undefined ? patch.timeColumn : before.timeColumn,
  });
}
