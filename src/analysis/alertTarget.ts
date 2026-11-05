// A `target` alert's comparison point (semantic layer part 5, D14): the metric's target in the scope the rule reads its
// figure in, worked out by the same resolver the tile uses. `'gone'` when the metric was deleted: the rule is left as it is.

import type { AlertRule } from './alerts';
import { getMetric } from './metrics';
import type { FilterStep } from '../data/transforms';
import { metricTarget } from '../ipc/targetResolve';

export async function ruleTarget(projectId: string, rule: AlertRule, filters: FilterStep[], value: number | null): Promise<number | null | 'gone'> {
  const m = rule.metric.metricId ? await getMetric(projectId, rule.metric.metricId) : null;
  if (!m) return 'gone';
  return (await metricTarget(projectId, m, filters, value))?.value ?? null;
}

/** The rules a deleted metric leaves unchecked (the inbox says so): a target rule, or one that has no column of its own to fall back on. */
export async function metricGoneIds(projectId: string, rules: AlertRule[]): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const r of rules) {
    const id = r.metric.metricId;
    if (id && (r.compare === 'target' || !r.metric.column) && !(await getMetric(projectId, id))) gone.add(r.id);
  }
  return gone;
}
