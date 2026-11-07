// A period metric's figure (semantic layer part 5, D8–D10's first bullet): its base metric resolved under a
// rewritten scope, through the same resolver a KPI takes (./metrics → computeCardMetric), so it is right on every
// aggregation, on Live, under row rules and glossary terms. No arithmetic here beyond the compare's (analysis/periodMath).
//
// The base resolves in a FRESH resolve context: the per-call memo is keyed by name alone, so resolving it inside the
// caller's would hand `[Revenue]` the windowed figure in `[Revenue YTD] - [Revenue]`.

import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import type { MetricPeriodDefinition } from '../analysis/periodMetric';
import { periodValue, windowedScope } from '../analysis/periodMath';
import { compareScope } from '../analysis/periodScope';
import { getCalendar, todayIso } from '../analysis/dateIntel';
import { metricDate } from '../analysis/metricTimeScope';
import * as msg from '../analysis/metricCheckMessages';
import { mergeFx } from '../analysis/fx';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { newCtx, olderAsOf, resolveDefinition } from './metrics';
import type { ResolveCtx } from './metrics';

/** The base, its date column, or the sentence saying why there is no figure. */
export async function baseOf(projectId: string, datasetId: string, def: MetricPeriodDefinition): Promise<{ base: Metric; date: { name: string; type: string } } | { error: string }> {
  const base = await metrics.getMetric(projectId, def.base);
  if (!base) return { error: msg.periodBaseMissing() };
  if (base.datasetId !== datasetId) return { error: msg.periodBaseOtherDataset() };
  if (metrics.isPeriodDefinition(base.definition)) return { error: msg.periodOfPeriod() };
  const name = await metricDate(projectId, base);
  const date = name ? (await datasets.getDatasetMeta(projectId, datasetId))?.columns.find((c) => c.name === name) : undefined; // schema only
  return date ? { base, date } : { error: msg.periodBaseNoDate(base.name) };
}

/** The base under `scope`, in its own context; its money, warehouse time and glossary notes join the caller's. */
async function baseValue(ctx: ResolveCtx, base: Metric, scope: FilterStep[], depth: number): Promise<number | null> {
  const inner = newCtx(ctx.projectId, scope, ctx.params);
  inner.reads = ctx.reads; // the columns its figure is totalled from are the base's: what a Share policy judges (publish/kpiPolicy)
  inner.stack.add(base.name.toLowerCase()); // a base formula naming itself has no value, as at the top
  const value = await resolveDefinition(inner, base.datasetId, base.definition, base.filters, depth + 1);
  ctx.fx = mergeFx(ctx.fx, inner.fx);
  ctx.asOf = olderAsOf(ctx.asOf, inner.asOf);
  for (const n of inner.notes ?? []) if (!(ctx.notes ??= []).includes(n)) ctx.notes.push(n);
  return value;
}

/**
 * The figure of a period metric under `filters` (its own filters, then the caller's scope). At depth 0 (the metric
 * asked for, not a formula's operand) it sets `ctx.periodRange` to the window's days and says in `ctx.notes` why
 * there is no figure.
 */
export async function periodMetricValue(ctx: ResolveCtx, datasetId: string, def: MetricPeriodDefinition, filters: FilterStep[], depth: number): Promise<number | null> {
  const say = (note: string): null => {
    if (depth === 0 && !(ctx.notes ??= []).includes(note)) ctx.notes.push(note);
    return null;
  };
  const found = await baseOf(ctx.projectId, datasetId, def);
  if ('error' in found) return say(found.error);
  const windowed = windowedScope(filters, found.date, def.window, todayIso(), getCalendar());
  if (depth === 0 && def.window && windowed.range) ctx.periodRange = windowed.range;
  const now = await baseValue(ctx, found.base, windowed.filters, depth);
  if (!def.compare) return now;
  const moved = compareScope(windowed.filters, [found.date], { mode: def.compare.vs });
  if (!moved) return say(msg.pickPeriodToCompare());
  return periodValue(def.compare.show, now, await baseValue(ctx, found.base, moved.filters, depth));
}

/** Why a save of `definition` as a period metric on `datasetId` is refused, beside which field; null when it is not one or is fine. */
export async function checkPeriodDefinition(projectId: string, datasetId: string, definition: unknown, timeColumn?: unknown): Promise<{ error: string; field: 'definition' | 'timeColumn' } | null> {
  const def = metrics.sanitizeDefinition(definition);
  if (!metrics.isPeriodDefinition(def)) return null;
  const found = await baseOf(projectId, datasetId, def);
  if ('error' in found) return { error: found.error, field: 'definition' };
  return typeof timeColumn === 'string' && timeColumn.trim() ? { error: msg.periodOwnDate(), field: 'timeColumn' } : null;
}

/** The name of a period metric's base, for its words ("Revenue, year to date"); undefined for any other kind or a base that is gone. */
export async function baseName(projectId: string, definition: metrics.MetricDefinition): Promise<string | undefined> {
  return metrics.isPeriodDefinition(definition) ? (await metrics.getMetric(projectId, definition.base))?.name : undefined;
}
