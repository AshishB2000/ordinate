// The parent picks of a cascading filter picker, cleaned for `dataset:distinct` — MAIN PROCESS.
//
// A picker lists one column's values given what its parent controls already hold (Region = West, so
// Store lists West's stores). The browser sends those picks as plain filter steps. They go through
// the same whitelist every stored filter does, and only a plain filter qualifies: a related dataset's
// step (`datasetId`, `via`) is not a parent of this column, and a glossary term cannot ride here.
// A step that does not qualify is dropped — the list narrows less, never more.

import { sanitizeFilterStep } from '../data/filterStepSanitize';
import type { FilterStep } from '../data/transforms';

/** The contract's `.max()` too: a picker has a handful of parents, never a table's worth. */
export const MAX_PARENT_STEPS = 6;

export function narrowSteps(raw: unknown): FilterStep[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterStep[] = [];
  for (const o of raw.slice(0, MAX_PARENT_STEPS)) {
    if (typeof o !== 'object' || o === null || (o as { type?: unknown }).type !== 'filter') continue;
    // Raw object: `sanitizeFilterStep` neither reads `datasetId` nor keeps it, so test it before sanitizing.
    if ('datasetId' in o || 'via' in o) continue;
    const step = sanitizeFilterStep(o as Record<string, unknown>);
    if (step) out.push(step);
  }
  return out;
}
