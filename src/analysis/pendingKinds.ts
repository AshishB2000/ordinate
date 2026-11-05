// The shapes part 5 writes and this release keeps but cannot compute (semantic layer part 5, step 01): a funnel or
// period metric, a per-entity snapshot. Every reader asks here, so the release that computes one removes its refusal
// in one place. KPI doors show no figure; chart and answer doors refuse with a sentence. A count distinct is computed
// from step 02 (analysis/countDistinct), but no writer is offered it before step 04 (unofferedMetric).

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

/** A funnel or period kind, or a per-entity snapshot: no chart or card writer on this release (a period metric's KPI and alerts are computed from step 05; its charts are step 06). */
export function pendingMetric(m: Pick<Metric, 'definition'>): boolean {
  const d = m.definition;
  return isNewerKind(d) || (metrics.isSimpleDefinition(d) && !!d.snapshot?.per);
}

/** Not offered to a template role, which reads a metric as its bare column: pending, or a count distinct (a role's picker is plain). */
export function unofferedMetric(m: Pick<Metric, 'definition'>): boolean {
  return pendingMetric(m) || (metrics.isSimpleDefinition(m.definition) && m.definition.aggregation === 'countd');
}

/** Why a pending metric has no figure (pendingMetric must hold). */
export function pendingSentence(m: Pick<Metric, 'definition' | 'name'>): string {
  return msg.metricKindPending(m.name);
}

/** The sentence refusing a chart whose drawn measure (values[0] under a split; every pivot value) names a pending metric, or null. */
export async function pendingMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined): Promise<string | null> {
  for (const v of snapshotDrawn(encoding)) {
    const m = v && typeof v.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
    if (m && pendingMetric(m)) return pendingSentence(m);
  }
  return null;
}

/**
 * Why an alert rule is not evaluated on this release, or null: a rule it cannot evaluate (alerts.canEvaluate), or one
 * on a saved metric that is pending. Such a rule is skipped whole — no value, no `lastEvaluatedAt`, no edge state —
 * so a newer pod's evaluation of it is never overwritten.
 */
export async function alertSkipped(projectId: string, rule: AlertRule): Promise<string | null> {
  const m = canEvaluate(rule) && rule.metric.metricId ? await metrics.getMetric(projectId, rule.metric.metricId) : null;
  return !canEvaluate(rule) || (m && pendingMetric(m) && !metrics.isPeriodDefinition(m.definition)) ? msg.alertPending() : null; // a period metric's figure is computed (step 05)
}
