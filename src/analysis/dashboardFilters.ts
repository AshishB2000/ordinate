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
// Clicking a mark on a chart filters every OTHER card on the sheet. The clicks
// are a reader's view state (never the record), one entry per (card, column):
// `origin` is the card that was clicked, so that card can be left whole and
// show its selection while the rest filter. Pure, so the rules are node-testable
// (scripts/test-crossFilter.ts) rather than only reachable through a chart
// click; web/src/features/analyses/editor/filters.ts mirrors them and
// filters.test.ts holds the two together.
//
//   plain click      that mark alone (replaces this card's selection); on the
//                    only selected mark it clears — the second click is the undo
//   additive click   (⌘/Ctrl) adds the mark, or takes a selected one away
//   a series chart   the click carries category AND series, one entry each
//
// One column, one click-filter: a click on a column another card already
// selected takes it over — two predicates on one column narrowing to nothing
// reads as "the chart broke", not as "you filtered twice".
//
// ponytail: filter steps are ANDed and there is no OR, so several marks picked
// across series filter to (picked categories) × (picked series) — the chips and
// the dimming show exactly that rectangle. Exact pairs need an OR group op.
export interface ClickFilter {
  /** The card whose mark was clicked — exempt from this filter. */
  origin: string;
  column: string;
  /** Selected values, as text, in click order. Never empty. */
  values: string[];
}
export interface ClickMark {
  column: string;
  value: unknown;
  seriesColumn?: string;
  series?: unknown;
}

const clickText = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Whether a click on a visual filters the sheet: the sheet's switch turns it on
 * for every visual that has not opted out; without it (a sheet saved before the
 * switch existed) only a visual that opted in — exactly as before.
 */
export function clickFilterOn(sheet: unknown, visual: unknown): boolean {
  return sheet === true ? visual !== false : visual === true;
}

export function toggleClickFilter(
  clicks: readonly ClickFilter[] | null | undefined,
  origin: string,
  mark: ClickMark,
  additive = false,
): ClickFilter[] {
  const list = (Array.isArray(clicks) ? clicks : []).filter((c) => c && c.origin && c.column && Array.isArray(c.values) && c.values.length > 0);
  if (!origin || !mark || !mark.column) return list.slice();
  const picks: [string, string][] = [[mark.column, clickText(mark.value)]];
  if (mark.seriesColumn && mark.seriesColumn !== mark.column && mark.series !== undefined) picks.push([mark.seriesColumn, clickText(mark.series)]);
  const mine = (column: string): string[] => list.find((c) => c.origin === origin && c.column === column)?.values ?? [];
  const selected = picks.every(([column, v]) => mine(column).includes(v));
  const next = new Map<string, string[]>();
  if (!additive) {
    // The only selected mark, clicked again, clears; anything else becomes the selection.
    if (!(selected && picks.every(([column]) => mine(column).length === 1))) for (const [column, v] of picks) next.set(column, [v]);
  } else if (!selected) {
    for (const [column, v] of picks) next.set(column, mine(column).includes(v) ? mine(column) : mine(column).concat(v));
  } else {
    // Take the mark away along the first axis that has another value left; the last mark clears.
    const at = picks.findIndex(([column]) => mine(column).length > 1);
    if (at >= 0) picks.forEach(([column, v], i) => next.set(column, i === at ? mine(column).filter((x) => x !== v) : mine(column)));
  }
  const touched = new Set(picks.map(([column]) => column));
  const out = list.filter((c) => !touched.has(c.column));
  for (const [column, values] of next) out.push({ origin, column, values });
  return out;
}

/** The click-filters as filter steps — `=` for one value, `in` for several — leaving out the card that is exempt. */
export function clickFilterSteps(clicks: readonly ClickFilter[] | null | undefined, exceptOrigin?: string): FilterStep[] {
  const out: FilterStep[] = [];
  for (const c of Array.isArray(clicks) ? clicks : []) {
    if (!c || !c.column || !Array.isArray(c.values) || !c.values.length || c.origin === exceptOrigin) continue;
    out.push(c.values.length === 1 ? { type: 'filter', column: c.column, op: '=', value: c.values[0] } : { type: 'filter', column: c.column, op: 'in', values: c.values.slice() });
  }
  return out;
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
