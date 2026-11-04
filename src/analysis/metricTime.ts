// The date a metric counts by (semantic layer D9): a dashboard date control's period lands on the
// metric's `timeColumn`, not on the column the control names. A control marks the period steps it
// makes (`fromControl: true`); the figure doors call this rewrite once, before the Live split and the
// answer-cache key, so JS, resident and Live receive the same plain steps and no mark reaches an
// engine. PURE: no reads.

import type { FilterStep } from '../data/transforms';
import { isKeptStep } from '../data/filterList';
import { stepKey } from './dashboardFilters';

/**
 * A step a dashboard control made. A kept step (a term, a newer release's step) carries its own flag
 * verbatim, and a row lock is never one: the mark is no security property.
 */
const marked = (s: FilterStep): boolean => s.fromControl === true && s.lock !== true && !isKeptStep(s);
const controlPeriod = (s: FilterStep): boolean => marked(s) && s.op === 'period';

/** Whether a date control's period is in `filters`. */
export const hasControlPeriod = (filters: FilterStep[]): boolean => filters.some(controlPeriod);

/** Whether the rewrite moves a control's period: it names a column other than the metric's set date. */
export const controlPeriodMoved = (filters: FilterStep[], timeColumn: string): boolean =>
  !!timeColumn && filters.some((s) => controlPeriod(s) && s.column !== timeColumn);

/**
 * `filters` with each control period on `timeColumn` (left on its column when that is `''`, unset),
 * every filter step's mark stripped, and a step identical to an earlier one dropped only when one of
 * the two was a control's: a tile's own date filter equal to the control's survives a move, and the
 * pair collapses to one as today when nothing moves. The same array when nothing is marked.
 */
export function rewriteControlPeriods(filters: FilterStep[], timeColumn: string): FilterStep[] {
  if (!filters.some((s) => s.fromControl === true && !isKeptStep(s))) return filters;
  const out: FilterStep[] = [];
  const seen = new Map<string, boolean>(); // stepKey → whether the first step kept under it was a control's
  for (const s of filters) {
    if (isKeptStep(s)) {
      out.push(s);
      continue;
    }
    const step: FilterStep = { ...s };
    delete step.fromControl;
    if (timeColumn && controlPeriod(s)) step.column = timeColumn;
    const k = stepKey(step);
    const first = seen.get(k);
    if (first !== undefined && (first || marked(s))) continue;
    if (first === undefined) seen.set(k, marked(s));
    out.push(step);
  }
  return out;
}
