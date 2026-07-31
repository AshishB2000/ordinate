// Dashboard filter merge — MAIN-PROCESS-safe, PURE logic (no Electron / fs / DOM),
// so it is node-testable by a plain `node` self-check (scripts/test-dashboardFilters.ts)
// AND declarable as a typed global for the renderer.
//
// A Week 10 dashboard carries a cross-visual `filters: FilterStep[]` list that must
// apply to EVERY card before aggregation, on top of a visual's own filters. The rule
// is deliberately simple: concatenate DASHBOARD filters FIRST, then the card's own
// filters, de-duping steps that are byte-for-byte identical (same column/op/value) so
// a dashboard filter and an identical card filter don't run twice. Order matters only
// for readability of warnings — `applyPipeline` folds filters left→right and every
// filter is a pure row predicate, so concatenation is commutative in effect; keeping
// dashboard-first is the single documented precedence and the spot to hang future
// precedence rules. A filter on a column absent from a given card's dataset is skipped
// with a warning by `stepFilter` (never throws), so ONE dashboard filter safely spans
// heterogeneous datasets.
//
// This never computes a figure — it only orders/merges predicates. Every downstream
// number is still produced by the tested pure pipeline (buildVizData / computeMetric),
// so the strict-number rule is untouched.

import type { FilterStep } from './transforms';

// Byte-for-byte identity of a filter step: same column, op, and value (null-normalized).
function stepKey(s: FilterStep): string {
  return JSON.stringify([s.column, s.op, s.value ?? null]);
}

// Merge dashboard-wide filters with a card's own filters into ONE ordered list:
// dashboard filters first, then card filters, dropping exact duplicates. Non-array
// inputs → treated as empty. Only `type === 'filter'` steps survive (defensive — the
// inputs are already sanitized filter lists, but this keeps the helper self-contained).
export function mergeDashboardFilters(
  dashFilters: FilterStep[] | null | undefined,
  cardFilters: FilterStep[] | null | undefined,
): FilterStep[] {
  const dash = Array.isArray(dashFilters) ? dashFilters : [];
  const card = Array.isArray(cardFilters) ? cardFilters : [];
  const out: FilterStep[] = [];
  const seen = new Set<string>();
  for (const s of dash.concat(card)) {
    if (!s || s.type !== 'filter') continue;
    const k = stepKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
