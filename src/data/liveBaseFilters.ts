// A Live dataset's "base filters": plain filter steps every question over it must carry
// (semantic layer part 1, PR 08). PURE.
//
// Stored at the TOP LEVEL of the dataset record, beside `rowPolicy`, never inside `live`: every Live
// writer rebuilds `raw.live` from `sanitizeLive`, which never reads this key, so none can erase it or
// copy it. `applyLive` reads it into `meta.live.baseFilters` (in memory only).

import type { FilterStep } from './transforms';
import { sanitizeFilterStep } from './filterStepSanitize';
import { RADIUS_OP } from '../analysis/geo/radius';

/** The most base filters a dataset keeps. */
export const MAX_BASE_FILTERS = 20;
/** The most values one base filter's list holds (the write refuses more; a stored step with more is unreadable). */
export const MAX_BASE_FILTER_VALUES = 1000;

/**
 * Does this Live block carry base filters this pod must honour: some it read, or a stored list it could
 * not read in full (`applyLive` marks it)? The ONE test the guards share, so none can drift apart.
 */
export function hasBaseFilters(live: { baseFilters?: readonly unknown[]; baseFiltersUnreadable?: true } | undefined): boolean {
  return !!live && (live.baseFiltersUnreadable === true || (live.baseFilters?.length ?? 0) > 0);
}

/**
 * The steps as a caller row access rules restrict may see them (REDACT, as the sample values): the
 * column and the operator, never a value — a base filter can name the rows it keeps out.
 */
export function redactBaseFilters(steps: readonly FilterStep[], closed: boolean): FilterStep[] {
  return closed ? steps.map(({ type, column, op }) => ({ type, column, op })) : steps.slice();
}

/**
 * The plain `filter` steps of an untrusted stored list, rebuilt with the keys a base filter may carry:
 * no `lock`, `context` or `via`, no radius, and nothing that is not a filter step (a term, a stray
 * value). Capped at MAX_BASE_FILTERS; a step listing more than MAX_BASE_FILTER_VALUES is dropped, never cut.
 */
export function sanitizeBaseFilters(raw: unknown): FilterStep[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterStep[] = [];
  for (const o of raw) {
    if (out.length >= MAX_BASE_FILTERS) break;
    if (!o || typeof o !== 'object' || (o as { type?: unknown }).type !== 'filter') continue;
    const s = sanitizeFilterStep(o as Record<string, unknown>);
    if (!s || s.op === RADIUS_OP || (s.values?.length ?? 0) > MAX_BASE_FILTER_VALUES) continue;
    const step: FilterStep = { type: 'filter', column: s.column, op: s.op };
    if (s.value !== undefined) step.value = s.value;
    if (s.values !== undefined) step.values = s.values;
    if (s.period !== undefined) step.period = s.period;
    out.push(step);
  }
  return out;
}
