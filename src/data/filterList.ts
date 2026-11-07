// The ONE sanitizer for a `filters` list (a visual's, a dashboard's, a metric's, a story block's, a
// saved view's, an alert's): it keeps what this pod cannot read. A glossary `term` step (and any
// step a later release adds) is a reference an older pod must carry through every save and merge
// untouched; dropping it would delete the reference, and applying around it would widen a figure.
// Prepare is NOT this list: `sanitizeSteps` still drops an unknown type, and only a filter list keeps.

import { sanitizeFilterStep } from './filterStepSanitize';
import { STEP_TYPES } from './transforms';
import type { FilterStep } from './transforms';
import { isTermStep } from './termStep';

/** A kept (unreadable) step is plain JSON this big at most, serialized — a record is untrusted. */
export const MAX_KEPT_STEP_BYTES = 2048;
const KEPT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * An object whose `type` is a string other than `'filter'` that this pod does not know as a Prepare
 * step — one this list carries without reading it. A KNOWN Prepare step (dedupe, group_aggregate, ...)
 * is no citizen of a filter list and is dropped, as it always was: a filter list is row predicates, never
 * a column-mutating transform.
 */
export function isKeptStep(s: unknown): boolean {
  return isObject(s) && typeof s.type === 'string' && s.type !== 'filter' && !STEP_TYPES.has(s.type);
}

/** The step as plain JSON, or null when it is not (BigInt, a cycle), is too big, or has a type that is not a name. */
function plainJson(s: Record<string, unknown>): Record<string, unknown> | null {
  if (!KEPT_TYPE_RE.test(s.type as string)) return null;
  let json: string;
  try {
    json = JSON.stringify(s);
  } catch (_) {
    return null;
  }
  return typeof json === 'string' && Buffer.byteLength(json) <= MAX_KEPT_STEP_BYTES ? JSON.parse(json) : null;
}

/**
 * Every `filter` step `sanitizeFilterStep` accepts, and every other step within the kept-step limits
 * (verbatim), in order. A non-array is `[]`; a filter the whitelist refuses is dropped, never kept.
 */
// shortcut: a kept/term step rides in FilterStep[] until expandTerms at the door; widening the type touches ~290 sites — the term-site inventory test is the check
export function sanitizeFilterList(raw: unknown): FilterStep[] {
  const out: FilterStep[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item)) continue;
    const step = item.type === 'filter' ? sanitizeFilterStep(item) : isKeptStep(item) ? plainJson(item) : null;
    if (step) out.push(step as unknown as FilterStep);
  }
  return out;
}

/**
 * A dashboard's scope (its filters, controls and selection) with each glossary term marked `fromControl`: a term
 * that does not apply to a tile there is left out with a note on the tile, where the tile's own term is refused
 * (../analysis/termExpand). Every other step comes back as it was. Like a date control's mark, no security property.
 */
export function markScopeTerms(steps: readonly FilterStep[]): FilterStep[] {
  return steps.map((s) => {
    const o: unknown = s;
    return isTermStep(o) && o.fromControl !== true ? ({ ...o, fromControl: true } as unknown as FilterStep) : s;
  });
}
