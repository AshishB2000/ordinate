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

// Byte-for-byte identity of a filter step: same column, op, and operand
// (null-normalized). `values` is part of the identity, not just `value` — an
// `in` step carries its operand there, so keying on `value` alone would make
// `state in (CA, WA)` and `state in (NY)` the same key and silently drop the
// second. Order-sensitive by design: this is an identity test, not a set
// comparison, and re-ordering a list produces the same rows but a different
// step, which is cheap to keep and wrong to guess at.
function stepKey(s: FilterStep): string {
  return JSON.stringify([s.column, s.op, s.value ?? null, s.values ?? null]);
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

// ── Click-to-filter ─────────────────────────────────────────────────────────
// Clicking a bar/slice on a cross-filter-enabled visual TOGGLES that category
// value as a dashboard-wide filter. Pure, so the construction is node-testable
// (scripts/test-crossFilter.ts) rather than only reachable through a chart click.
//
// Why `=` and why the category column: a click identifies one label on the
// category axis, which is exactly one equality predicate. Anything richer (a
// range from a brushed axis, multi-select) is a different gesture and would need
// its own op — this deliberately does the one thing a click means.
//
// TOGGLE, not push: clicking the same bar twice is the obvious way to undo, and
// without it the only way back is the filter bar's ✕, which is a different
// control in a different place. Clicking a DIFFERENT value on the same column
// REPLACES it — two `=` predicates on one column match nothing, which would read
// as "the chart broke" rather than "you filtered twice".
export function toggleCrossFilter(
  filters: FilterStep[] | null | undefined,
  column: string,
  value: unknown,
): FilterStep[] {
  const list = (Array.isArray(filters) ? filters : []).filter((s) => s && s.type === 'filter');
  if (!column) return list.slice();
  const v = value == null ? '' : String(value);
  const same = (s: FilterStep): boolean => s.column === column && s.op === '=';
  const already = list.some((s) => same(s) && String(s.value ?? '') === v);
  // Drop any existing `=` on this column either way: on toggle-off that removes
  // it, on a different value that replaces rather than stacks.
  const rest = list.filter((s) => !same(s));
  if (already) return rest;
  return rest.concat([{ type: 'filter', column, op: '=', value: v } as FilterStep]);
}
