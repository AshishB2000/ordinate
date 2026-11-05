// An alert rule watched through its METRIC (semantic layer part 5, D14): a period or funnel metric has no
// `{column, aggregation}` copy that says what it is, so its rule (stored with no column) is evaluated by
// `resolveMetric`, the tile's own figure. Every other rule keeps its stored copy, as before.

import type { AlertRule } from './alerts';
import { getMetric, isFunnelDefinition, isPeriodDefinition } from './metrics';
import { daysFromCivil } from './civilDays';
import { isoFromDays, periodDay } from './dateIntel';
import type { DateRange } from './dateIntel';
import type { FilterStep } from '../data/transforms';
import { resolveMetric } from '../ipc/metrics';

/**
 * A recent period's key (alertStore.recentPeriods: a day's cell by `=`, or a month `YYYY-MM` by `contains`) as the
 * days it covers. A RANGE, never the label filter: under one, "Revenue, year to date" would be that month alone.
 */
function keyRange(key: string, op: '=' | 'contains'): DateRange | null {
  if (op === '=') {
    const d = periodDay(key);
    return d === null ? null : { from: isoFromDays(d), to: isoFromDays(d) };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  return { from: isoFromDays(daysFromCivil(y, mo, 1)), to: isoFromDays(daysFromCivil(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1) - 1) };
}

export type MetricWatch = (period?: { column: string; key: string; op: '=' | 'contains' }) => Promise<number | null>;

/** The figure of a rule watched through its metric (optionally in one recent period), `'gone'` when that metric is deleted, null for a rule its copy answers. */
export async function metricWatch(projectId: string, rule: AlertRule): Promise<MetricWatch | 'gone' | null> {
  const id = rule.metric.metricId;
  if (typeof id !== 'string') return null;
  const m = await getMetric(projectId, id);
  if (!m) return rule.metric.column ? null : 'gone';
  if (rule.metric.column && !isPeriodDefinition(m.definition) && !isFunnelDefinition(m.definition)) return null;
  const stored = (rule.metric.filters || []) as FilterStep[];
  return async (period) => {
    const range = period ? keyRange(period.key, period.op) : null;
    if (period && !range) return null;
    const extra: FilterStep[] = range ? [{ type: 'filter', column: period!.column, op: 'period', period: { preset: 'custom', ...range } } as FilterStep] : [];
    return (await resolveMetric(projectId, id, { filters: stored.concat(extra) }))?.value ?? null;
  };
}
