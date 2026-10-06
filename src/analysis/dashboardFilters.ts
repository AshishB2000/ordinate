// Dashboard filter merge — MAIN-PROCESS-safe, PURE logic (no fs / DOM),
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

import type { FilterStep } from '../data/transforms';
import { sanitizePeriod } from './dateIntel';
import type { CardControl, ControlValue } from './dashboards';
import { radiusControlSteps } from './geo/radius';

// Byte-for-byte identity of a filter step: same column, op, and operand
// (null-normalized). `values` is part of the identity, not just `value` — an
// `in` step carries its operand there, so keying on `value` alone would make
// `state in (CA, WA)` and `state in (NY)` the same key and silently drop the
// second. Order-sensitive by design: this is an identity test, not a set
// comparison, and re-ordering a list produces the same rows but a different
// step, which is cheap to keep and wrong to guess at.
function stepKey(s: FilterStep): string {
  // `period` too: two different relative ranges on one column are two filters.
  // `context` too (r7:lod): the same predicate before and after LODs is two filters.
  return JSON.stringify([s.column, s.op, s.value ?? null, s.values ?? null, s.period ?? null, s.radius ?? null, s.context === true]);
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

// ── Control widgets (dropdown / multi-select / date-range) ────────────────────
// A dashboard `control` card (src/dashboards.ts's `CardControl`) is a
// DEFINITION only — kind/label/dataset/column/default. This turns that
// definition plus a CURRENT selection (never itself persisted — the caller
// owns keeping `state` out of anything written to disk) into 0..2 FilterSteps,
// the same shape `mergeDashboardFilters` above already knows how to fold in.
//
// One rule for all three kinds: an unset/cleared selection filters nothing.
// A half-built selection (no value picked yet, an empty multi-select, a date
// range with neither end set) must not narrow the dashboard to zero rows —
// that reads as "the control is broken", not "no rows match" — so it degrades
// to [] exactly like `emptyListWarning`'s empty `in`/`not in` list does above.
export function controlSteps(
  control: Pick<CardControl, 'kind' | 'column' | 'lngColumn'>,
  state: ControlValue | null | undefined,
): FilterStep[] {
  if (!state) return [];
  const { column } = control;
  // r6:geo — a centre and a distance over two columns (./geo/radius).
  if (control.kind === 'radius') return radiusControlSteps(column, control.lngColumn, state);

  if (control.kind === 'dropdown' && 'value' in state) {
    const { value } = state;
    if (!value) return []; // empty/cleared → no step
    return [{ type: 'filter', column, op: '=', value }];
  }

  if (control.kind === 'multi' && 'values' in state) {
    const { values } = state;
    if (!Array.isArray(values) || values.length === 0) return []; // cleared → no step
    // .slice(): `state` may be the SAME array the persisted record's
    // `card.control.default.values` seeded, so this must not hand back a
    // reference into it.
    return [{ type: 'filter', column, op: 'in', values: values.slice() }];
  }

  if (control.kind === 'date_range') {
    // A relative pick travels as its PRESET — resolved against today when the
    // query runs, so "Last 30 days" is current every time the sheet opens. Two
    // fixed dates travel as a `custom` period, compared as DATES rather than
    // as strings (so `03/01/2024` is not "before" `12/31/2023`).
    if ('preset' in state && typeof state.preset === 'string' && state.preset !== 'custom') {
      const period = sanitizePeriod(state);
      return period ? [{ type: 'filter', column, op: 'period', period }] : [];
    }
    const from = 'from' in state ? state.from : undefined;
    const to = 'to' in state ? state.to : undefined;
    if (!from && !to) return []; // neither end set → []
    const period = sanitizePeriod({ preset: 'custom', from, to });
    return period ? [{ type: 'filter', column, op: 'period', period }] : [];
  }

  return []; // a `state` shape that doesn't match this control's own kind
}
