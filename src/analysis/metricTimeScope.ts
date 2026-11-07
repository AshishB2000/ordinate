// The date a metric counts by (semantic layer D9): the READS around `Metric.timeColumn`. The pure rewrite of a
// control's period is ./metricTime; this file asks the dataset. Schema only: a Live dataset is never read for rows.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import * as metrics from './metrics';
import { isFormulaDefinition, metricsByName, sanitizeDefinition } from './metrics';
import type { Metric, MetricDefinition } from './metrics';
import { compileMetricFormula } from './metricFormula';
import { bindFormulaText } from './params';
import { relatedColumnNames } from '../ipc/relationships';
import * as msg from './metricCheckMessages';
import { controlPeriodMoved, controlPeriodsConflict, rewriteControlPeriods } from './metricTime';
import { drawnMeasures } from './metricMeasures';
import { measureLabel } from './vizData';
import type { VizEncoding, VizMeasure } from './visuals';

type Columns = { columns: { name: string; type: string }[] } | null;
const isDate = (meta: Columns, column: string): boolean => !!meta && meta.columns.some((c) => c.name === column && c.type === 'date');

/**
 * The date column a metric counts by, or `''` when it has none or the column is no longer a date column of its dataset.
 * A period metric (part 5, D8) counts by its base's: a base on its own dataset that is not itself a period metric. A funnel
 * metric counts by `funnel.time` when it is a date column.
 */
export async function metricDate(projectId: string, m: Pick<Metric, 'datasetId' | 'timeColumn'> & { definition?: MetricDefinition }): Promise<string> {
  if (m.definition && metrics.isPeriodDefinition(m.definition)) {
    const base = await metrics.getMetric(projectId, m.definition.base);
    return base && base.datasetId === m.datasetId && !metrics.isPeriodDefinition(base.definition) ? metricDate(projectId, base) : '';
  }
  if (m.definition && metrics.isFunnelDefinition(m.definition)) return isDate(await datasets.getDatasetMeta(projectId, m.datasetId), m.definition.funnel.time) ? m.definition.funnel.time : ''; // part 5, D5: by its entries' time
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

/**
 * The metrics a formula names (`[Revenue]`), each with the dataset and the date it counts by; unknown names are the formula's own problem.
 * `excused` (lower-cased): names a model import writes before this save, so their stored form is not the one the save meets.
 */
async function partsOf(projectId: string, input: TimeInput, meta: NonNullable<Columns>, excused: ReadonlySet<string>): Promise<Map<string, { name: string; date: string }[]>> {
  const byDataset = new Map<string, { name: string; date: string }[]>();
  if (!isFormulaDefinition(input.definition)) return byDataset;
  const columns = meta.columns.map((c) => c.name).concat(await relatedColumnNames(projectId, input.datasetId));
  const compiled = compileMetricFormula(bindFormulaText(input.definition.formula, new Map()).text, columns);
  if (!compiled.ok) return byDataset;
  const byName = await metricsByName(projectId);
  for (const ref of new Set(compiled.program.metricRefs.map((r) => r.toLowerCase()))) {
    const part = byName.get(ref);
    if (!part || excused.has(ref)) continue;
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
async function judge(projectId: string, input: TimeInput, excused: ReadonlySet<string> = new Set()): Promise<TimeVerdict> {
  const meta = await datasets.getDatasetMeta(projectId, input.datasetId);
  if (!meta) return {}; // the save says the dataset is gone
  const own = ownDate(input);
  if (own && !isDate(meta, own)) return { error: msg.notADateColumn(own) };
  const parts = await partsOf(projectId, input, meta, excused);
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

/** `metric:save`: the date of the input as it arrived. `excused`: as `partsOf` says (a model import's plan). */
export function settleOnSave(projectId: string, raw: Record<string, any>, excused?: ReadonlySet<string>): Promise<TimeVerdict> { // any: the zod-checked input, read field by field
  return judge(projectId, { name: String(raw.name).trim(), datasetId: raw.datasetId, definition: sanitizeDefinition(raw.definition), timeColumn: raw.timeColumn }, excused);
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

// ── At draw time: a dashboard date control's period on the date a figure counts by ─────────────────────

/** The filters a figure is drawn under, each control period on its date (`periodOn` when one moved), or the sentence refusing it. */
export type DateScope = { ok: true; filters: FilterStep[]; periodOn?: string } | { ok: false; error: string };

/** One part of a figure and the date it counts by (`''`: the dashboard's); `of`, the formula it is a part of. */
interface Dated {
  name: string;
  date: string;
  of?: Dated;
}

/** How deep `[A]` → `[B]` is followed: ipc/metrics.ts's MAX_FORMULA_DEPTH. */
const MAX_DEPTH = 10;

/**
 * `m` and every metric its formula names on m's dataset, each with its date. Parts on another dataset never share a
 * date with it (Task 3's per-dataset rule): a chart refuses them (metricMeasures.otherDataset) and a KPI counts each by its own.
 */
async function datedOf(projectId: string, m: Metric): Promise<Dated[]> {
  const own: Dated = { name: m.name, date: await metricDate(projectId, m) };
  const out = [own];
  if (!isFormulaDefinition(m.definition)) return out;
  const meta = await datasets.getDatasetMeta(projectId, m.datasetId);
  if (!meta) return out;
  const columns = meta.columns.map((c) => c.name).concat(await relatedColumnNames(projectId, m.datasetId));
  const byName = await metricsByName(projectId);
  const seen = new Set([m.name.toLowerCase()]);
  const walk = async (f: Metric, depth: number): Promise<void> => {
    if (!isFormulaDefinition(f.definition) || depth > MAX_DEPTH) return;
    const compiled = compileMetricFormula(bindFormulaText(f.definition.formula, new Map()).text, columns);
    if (!compiled.ok) return; // the figure says why
    for (const ref of compiled.program.metricRefs) {
      const part = byName.get(ref.toLowerCase());
      if (!part || seen.has(ref.toLowerCase()) || part.datasetId !== m.datasetId) continue;
      seen.add(ref.toLowerCase());
      out.push({ name: part.name, date: await metricDate(projectId, part), of: own });
      await walk(part, depth + 1);
    }
  };
  await walk(m, 0);
  return out;
}

/**
 * ONE filter list for every part of a figure: each part's control periods moved onto its date (./metricTime), and
 * every part must come out with the same list, or the figure is refused (D9: conflicts are refused, never guessed).
 * So a part with no date beside one whose date the control already sits on agrees: nothing moves for either.
 */
function settle(filters: FilterStep[], dated: Dated[]): DateScope {
  const parts: Dated[] = dated.length ? dated : [{ name: '', date: '' }];
  const head = parts[0];
  const moved = rewriteControlPeriods(filters, head.date);
  const key = JSON.stringify(moved);
  for (const d of parts) {
    if (controlPeriodsConflict(filters, d.date)) return { ok: false, error: msg.controlPeriodsDisagree() };
    if (d === head || JSON.stringify(rewriteControlPeriods(filters, d.date)) === key) continue;
    // A part comes after its formula, which agreed: the part is what differs.
    return { ok: false, error: d.of ? msg.formulaDatesDiffer(d.of.name, d.name, shown(d.date), shown(d.of.date)) : msg.measuresCountByDifferentDates(head.name, shown(head.date), d.name, shown(d.date)) };
  }
  const on = parts.find((d) => controlPeriodMoved(filters, d.date));
  return on ? { ok: true, filters: moved, periodOn: on.date } : { ok: true, filters: moved };
}

/** Whether any step carries a control's mark: the rewrite hands back the same array when none does. */
const unmarked = (filters: FilterStep[]): boolean => rewriteControlPeriods(filters, '') === filters;

/** A metric's figure (a KPI, a reference line, a drill) under `filters`: the metric and its parts on their date. */
export async function metricScope(projectId: string, m: Metric, filters: FilterStep[]): Promise<DateScope> {
  if (unmarked(filters)) return { ok: true, filters };
  return settle(filters, await datedOf(projectId, m));
}

/** The saved metric a chart measure draws from on `datasetId`, or null (none, gone, another dataset's). */
async function measureMetric(projectId: string, datasetId: string, v: VizMeasure | { metricId?: string } | undefined): Promise<Metric | null> {
  const m = v && typeof v.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
  return m && m.datasetId === datasetId ? m : null;
}

/** The date one chart measure counts by: its metric's, `''` for anything else (the dashboard's). */
export async function measureDate(projectId: string, datasetId: string, v: VizMeasure | undefined): Promise<string> {
  const m = await measureMetric(projectId, datasetId, v);
  return m ? metricDate(projectId, m) : '';
}

/**
 * A chart's filters under a dashboard date control: one date for every measure it draws (`values[0]` under a split),
 * the metric's for a metric measure on this dataset and `''` for anything else. No mark: the filters as they came, no read.
 *
 * Two tiles keep release 1's answer. A pivot draws its stored copy, so a value whose metric has a date the control
 * is not on is refused. A drivers tile's question settles its own metric's date (ipc/drivers.driversFor), so its
 * filters reach it marked. A cohort or a funnel draws no metric, so it only loses the marks.
 */
export async function chartScope(projectId: string, datasetId: string, encoding: VizEncoding | null | undefined, filters: FilterStep[]): Promise<DateScope> {
  if (unmarked(filters) || encoding?.drivers) return { ok: true, filters };
  if (encoding?.pivot) {
    for (const v of encoding.pivot.values) {
      const m = await measureMetric(projectId, datasetId, v);
      if (m && controlPeriodMoved(filters, await metricDate(projectId, m))) return { ok: false, error: msg.pivotOwnDate(m.name) };
    }
    return settle(filters, []);
  }
  const dated: Dated[] = [];
  for (const v of drawnMeasures(encoding)) {
    const m = await measureMetric(projectId, datasetId, v);
    dated.push(...(m ? await datedOf(projectId, m) : [{ name: measureLabel(v), date: '' }]));
  }
  return settle(filters, dated);
}
