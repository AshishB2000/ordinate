// Part 5's metric kinds that a reader of a metric's bare column can't draw (semantic layer part 5): a funnel or period
// metric has no column whose total is its figure. Their KPIs, alerts and charts are computed (steps 05, 06, 08); an
// answer card, a plan card, a scenario and a template role still refuse them here, in one place. A count distinct is
// computed from step 02 (analysis/countDistinct) and offered to writers from step 04 (unofferedMetric).

import * as metrics from './metrics';
import type { Metric, MetricDefinition } from './metrics';
import type { MetricFunnelDefinition } from './funnelMetric';
import type { MetricPeriodDefinition } from './periodMetric';
import * as msg from './pendingMessages';
import { snapshotDrawn } from './snapshotGuards';
import type { VizEncoding } from './visuals';
import { canEvaluate } from './alerts';
import type { AlertRule } from './alerts';

/** A funnel or period kind: neither a column rolled up nor a formula. */
export function isNewerKind(d: MetricDefinition): d is MetricFunnelDefinition | MetricPeriodDefinition {
  return metrics.isFunnelDefinition(d) || metrics.isPeriodDefinition(d);
}

/** A funnel or period kind: no card writer reads it as a column (its KPI, alerts and chart are computed: ./metricMeasures charts it alone). */
export function pendingMetric(m: Pick<Metric, 'definition'>): boolean {
  return isNewerKind(m.definition);
}

/** Not offered to a template role, which reads a metric as its bare column: pending, or a count distinct (a role's picker is plain). */
export function unofferedMetric(m: Pick<Metric, 'definition'>): boolean {
  return pendingMetric(m) || (metrics.isSimpleDefinition(m.definition) && m.definition.aggregation === 'countd');
}

/** Why a pending metric has no figure (pendingMetric must hold). */
export function pendingSentence(m: Pick<Metric, 'definition' | 'name'>): string {
  return msg.metricKindPending(m.name);
}

/** The sentence refusing a chart (or an answer card) whose drawn measure (values[0] under a split; every pivot value) names a pending metric, or null. */
export async function pendingMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined, pending: (m: Metric) => boolean = pendingMetric): Promise<string | null> {
  for (const v of snapshotDrawn(encoding)) {
    const m = v && typeof v.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
    if (m && pending(m)) return pendingSentence(m);
  }
  return null;
}

/**
 * Why an alert rule is not evaluated on this release, or null: a rule it cannot evaluate (alerts.canEvaluate). Such a
 * rule is skipped whole — no value, no `lastEvaluatedAt`, no edge state — so a newer pod's evaluation of it is never
 * overwritten. A rule on a period or funnel metric is evaluated by its metric (./alertMetric, steps 05 and 08).
 */
export async function alertSkipped(_projectId: string, rule: AlertRule): Promise<string | null> {
  return canEvaluate(rule) ? null : msg.alertPending();
}
