// A semantic dataset's value lists (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D16, D17) —
// MAIN PROCESS. A layer keeps no sample, so a picker's values, the Assistant's stored spellings and a scorecard's
// latest day are each ONE dimension-only question to the layer (engine/live/semantic/semanticPlan `planValues`),
// cached and counted at the one door (engine/live/liveQuery `liveLookup`). A backend without lookups refuses
// `layerLookup`; the caller's row lock reaches the question and is refused `layerRowPolicy` unless the backend
// compares exactly (D17); a caller from whom a column rule hides a field is refused there too.

import type { FilterStep } from '../data/transforms';
import { rowLockFor, withLockSteps } from '../data/rowAccess';
import { liveLookup } from '../engine/live/liveQuery';
import type { LiveFailure } from '../engine/live/liveQuery';
import { adaptFilters, isRefusal, refuse } from '../engine/live/liveSpec';
import type { LiveTarget } from '../engine/live/liveTarget';
import { planValues } from '../engine/live/semantic/semanticPlan';

/** A layer's lookup of one dimension under `steps` (the lock first, when the caller has one), or why not. */
function lookup(t: LiveTarget, column: string, steps: FilterStep[], opts: { limit?: number; desc?: boolean }) {
  if (!t.semantic) return refuse('badQuery'); // callers ask semantic datasets only
  const f = adaptFilters(steps, t.columns, {});
  if (!f.ok) return f;
  const q = planValues(column, f.filters, t.semantic.env, opts);
  return isRefusal(q) ? q : { ok: true as const, semantic: q };
}

/** `dataset:distinct` on a semantic dataset: the layer's values, in its order (by value), under the caller's lock and the picker's parents. */
export async function semanticDistinct(projectId: string, datasetId: string, column: string, req: { limit?: number; search?: string; filters?: FilterStep[] }): Promise<{ values: string[]; total: number; more?: true } | LiveFailure> {
  const lock = await rowLockFor(projectId, datasetId); // a refusal THROWS, typed (the route answers row_policy)
  const steps = lock ? withLockSteps(lock, req.filters ?? []) : (req.filters ?? []);
  const limit = Math.max(1, Math.floor(req.limit ?? 200));
  // shortcut: a search is the extract's case-blind substring, matched here over every value; ask the layer once a backend can match case-blind
  const needle = typeof req.search === 'string' ? req.search.toLowerCase() : '';
  const r = await liveLookup(projectId, datasetId, (t) => lookup(t, column, steps, needle ? {} : { limit: limit + 1 }));
  if (!r.ok) return r;
  const values = r.rows.map((row) => row[0]).filter((v) => v !== null && v !== undefined && v !== '').map(String).filter((v) => !needle || v.toLowerCase().includes(needle));
  return values.length > limit ? { values: values.slice(0, limit), total: limit, more: true } : { values, total: values.length };
}

/** Every stored spelling of one text dimension under `lock` (the Assistant's case fix, ipc/liveAnswers). */
export function semanticSpellings(t: LiveTarget, column: string, lock: readonly FilterStep[]) {
  // shortcut: every value of the column, matched here; ask the layer for the keys alone if a backend gains a case-blind `in`
  return lookup(t, column, [...lock], {});
}

/** The latest day with a value in `column` (a scorecard's anchor, an empty answer's note), or null. A refusal is null too: the anchor is then today. */
export async function semanticLatestDay(projectId: string, datasetId: string, column: string): Promise<string | null> {
  let lock;
  try {
    lock = await rowLockFor(projectId, datasetId);
  } catch {
    return null; // a caller refused the rows asks nothing: the anchor is today
  }
  const r = await liveLookup(projectId, datasetId, (t) => lookup(t, column, lock ? [...lock.steps] : [], { limit: 1, desc: true }));
  const v = r.ok ? r.rows[0]?.[0] : null;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}
