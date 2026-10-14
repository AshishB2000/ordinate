// The VALUES an answer's filters name, against the values the data holds —
// MAIN PROCESS, PURE: no fs, no model.
//
// A model (or a person) writes a filter value from memory: "tech" for
// Technology, "Tecnology", "west" for West. A value the column does not hold
// gives an empty chart that reads like an answer, so the app reads the said
// value against the column's own cells, in three steps:
//
//   1. the same value ignoring case and surrounding space — the STEP is fixed,
//      the spec and its label stay as asked (`canonicaliseTextFilters`);
//   2. else the ONE stored value it is a prefix of, or one edit from
//      (analysis/valueMatch `oneNearValue`) — the SPEC is rewritten to the stored
//      value and remembers what was said, so the card can say what it did and a
//      reload draws the same chart (`matchValues`);
//   3. else nothing changes; and when the chart then has no rows, the nearest
//      stored values are offered, each as a complete spec (`nearestValueFixes`).
//
// Steps 2 and 3 only on a column of at most LOOSE_MAX_DISTINCT distinct values.
// For `=`, `!=`, `in` and `not in` on a text column. Extract datasets only: a
// Live dataset keeps its own bound-parameter case lookup (ipc/liveAnswers).

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { exactKey, nearValues, oneNearValue, valueKeys } from '../analysis/valueMatch';
import type { ValueKeys } from '../analysis/valueMatch';
import type { AnswerChip, AnswerFilter, AnswerSpec } from './answerSpec';

/** A filter value the app matched loosely: what was said, and the stored value the spec now holds. */
export interface ValueMatch { column: string; said: string; value: string }

/** A chart with no rows because of one filter value, and the stored values it may have meant. */
export interface NoMatch { column: string; op: '=' | 'in'; said: string; options: AnswerChip[] }

/** column → the stored text by its key (trimmed, lower case); the first spelling met wins, in row order. */
export type Held = Map<string, Map<string, string>>;

const MATCH_OPS: ReadonlySet<string> = new Set(['=', '!=', 'in', 'not in']);
const MAX_SAID = 80;
const MAX_MATCHED = 16;
const MAX_OPTIONS = 3;

/**
 * A column with more distinct values than this is not matched loosely, nor offered from: it is
 * id-like, where one edit away is another record rather than a typo. It is also the cost model —
 * each said value is read against every distinct one, on the request thread. Measured (node 24,
 * a laptop): 10,000 distinct values index in ~5 ms and answer a said value in ~1 ms (20 unheld
 * values, matched and offered: ~19 ms); 1,000,000 take ~810 ms to index and ~64 ms per said value
 * — and, before the index was built once per column, ~480 ms per said value.
 */
export const LOOSE_MAX_DISTINCT = 10_000;

/** What each text column under a value filter holds. One pass over the rows per such column. */
export function heldValues(filters: AnswerFilter[], columns: ParsedColumn[], rows: Cell[][]): Held {
  const held: Held = new Map();
  for (const f of filters) {
    if ('period' in f || !MATCH_OPS.has(f.op) || held.has(f.column)) continue;
    const ci = columns.findIndex((c) => c.name === f.column);
    if (ci < 0 || columns[ci].type !== 'text') continue;
    const byKey = new Map<string, string>();
    for (const r of rows) {
      const v = r ? r[ci] : null;
      if (v === null || v === undefined) continue;
      const t = String(v);
      const k = exactKey(t);
      if (!byKey.has(k)) byKey.set(k, t);
    }
    held.set(f.column, byKey);
  }
  return held;
}

/**
 * A text filter value → the cell text the data actually holds, matched without
 * regard to case or surrounding space. "west" asked for is "West" stored; a
 * filter that matched nothing because of a capital letter would be an empty
 * chart that looks like an answer.
 */
export function canonicaliseTextFilters(steps: FilterStep[], held: Held): void {
  for (const s of steps) {
    const byKey = MATCH_OPS.has(s.op) ? held.get(s.column) : undefined;
    if (!byKey) continue;
    const fix = (v: Cell): Cell => (typeof v === 'string' ? byKey.get(exactKey(v)) ?? v : v);
    if (s.value !== undefined) s.value = fix(s.value);
    if (s.values) s.values = s.values.map(fix);
  }
}

/**
 * The spec with each filter value the column does not hold replaced by the ONE
 * stored value it means, and `matched` saying so. A value that is stored (in any
 * case), or that two stored values could be, is left exactly as asked — and the
 * very spec comes back when nothing was matched.
 */
export function matchValues(spec: AnswerSpec, held: Held): AnswerSpec {
  const matched: ValueMatch[] = [];
  // Bounded WORK, not only bounded columns: at most this many loose lookups per spec, each against at
  // most LOOSE_MAX_DISTINCT values (~1 ms). A long `in` list — a client may send any spec to
  // answer:rerun — leaves the rest as said instead of holding the event loop, and every value the
  // app does rewrite still gets its "Matched …" note (`matched` never passes MAX_MATCHED).
  let budget = MAX_MATCHED - (spec.matched?.length ?? 0);
  const filters = spec.filters.map((f): AnswerFilter => {
    if ('period' in f || !MATCH_OPS.has(f.op)) return f;
    const column = f.column;
    const byKey = held.get(column);
    if (!byKey || byKey.size > LOOSE_MAX_DISTINCT) return f;
    let keys: ValueKeys | undefined; // the column read once, and only if a value needs it
    const fix = (v: Cell): Cell => {
      if (typeof v !== 'string' || byKey.has(exactKey(v)) || budget <= 0) return v;
      budget -= 1;
      keys ??= valueKeys(byKey.values());
      const near = oneNearValue(v, keys);
      if (!near) return v;
      matched.push({ column, said: v.slice(0, MAX_SAID), value: near.value });
      return near.value;
    };
    const out = { ...f };
    if (f.value !== undefined) out.value = fix(f.value);
    if (f.values) out.values = f.values.map(fix);
    return out;
  });
  return matched.length ? { ...spec, filters, matched: [...(spec.matched ?? []), ...matched].slice(0, MAX_MATCHED) } : spec;
}

/**
 * A stored `matched` list, re-read: whitelisted, bounded, and only the entries
 * a filter of the spec still bears out — a value filter on that column holding
 * that value. Anything else would be a note about a match nobody made.
 */
export function sanitizeMatched(raw: unknown, filters: AnswerFilter[]): ValueMatch[] {
  const out: ValueMatch[] = [];
  for (const m of Array.isArray(raw) ? (raw as Array<Record<string, unknown> | null>) : []) {
    if (!m || typeof m !== 'object' || out.length >= MAX_MATCHED) continue;
    const { column, said, value } = m;
    if (typeof column !== 'string' || typeof said !== 'string' || typeof value !== 'string') continue;
    const borne = filters.some((f) => !('period' in f) && f.column === column && MATCH_OPS.has(f.op)
      && (f.value === value || (f.values ?? []).includes(value)));
    if (borne) out.push({ column, said: said.slice(0, MAX_SAID), value });
  }
  return out;
}

/**
 * For a chart with NO ROWS: the first `=` / `in` filter whose value its column
 * does not hold, with up to three stored values it may have meant (prefix, one
 * edit, containment — nearest first), each as the complete spec with that value
 * in its place. Null when no such filter has a near value.
 *
 * Never for a column in `withheld`: its values are personal or financial, and
 * a suggestion is a list of them.
 */
export function nearestValueFixes(spec: AnswerSpec, held: Held, withheld: ReadonlySet<string>): NoMatch | null {
  for (const [i, f] of spec.filters.entries()) {
    if ('period' in f || (f.op !== '=' && f.op !== 'in') || withheld.has(f.column)) continue;
    const byKey = held.get(f.column);
    if (!byKey || byKey.size > LOOSE_MAX_DISTINCT) continue;
    const said = [f.value, ...(f.values ?? [])].find((v): v is string => typeof v === 'string' && !byKey.has(exactKey(v)));
    if (said === undefined) continue;
    const options = nearValues(said, byKey.values()).slice(0, MAX_OPTIONS).map((n): AnswerChip => {
      const fixed = { ...f };
      if (f.value === said) fixed.value = n.value;
      if (f.values) fixed.values = f.values.map((v) => (v === said ? n.value : v));
      return { label: n.value.slice(0, MAX_SAID), spec: { ...spec, filters: spec.filters.map((x, j) => (j === i ? fixed : x)) } };
    });
    if (options.length) return { column: f.column, op: f.op === 'in' ? 'in' : '=', said: said.slice(0, MAX_SAID), options };
  }
  return null;
}
