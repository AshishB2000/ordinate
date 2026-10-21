// The datasets a dataset is built from, transitively — PURE given its reader.
// docs/row-policy/00-design.md D14.
//
// A dataset's direct parents are its origin's (a SQL or notebook dataset's deps,
// a combined or composed dataset's inputs) and the datasets its prepare steps
// union or look up (`stepRefIds`). THE one definition: row access rules close a
// dataset built from one with rules over this closure, and the lineage graph
// (src/analysis/lineage.ts) — so item 4's `figureDatasets` and the pipeline —
// draws its dataset edges from `parentsOfRecord` too.

import { isValidId } from '../app/ids';
import { stepRefIds } from './stepTypes';

/** How far the walk follows parents, as `stepRefs.buildsOn` does. */
export const MAX_DEPTH = 16;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The parents an origin names, read LENIENTLY — as stored, never through
 * sanitizeOrigin: an origin that would not sanitize (one bad join entry drops it
 * whole) still names its parents, so the closure over-approximates and fails closed.
 */
function originParentIds(origin: unknown): unknown[] {
  if (!origin || typeof origin !== 'object') return [];
  const o = origin as Record<string, unknown>;
  if (o.kind === 'sql' || o.kind === 'notebook') return list(o.deps);
  if (o.kind === 'combined') return [o.leftId, o.rightId];
  if (o.kind === 'composed') return [o.baseId, ...list(o.joins).map((j) => (j && typeof j === 'object' ? (j as { datasetId?: unknown }).datasetId : null))];
  return [];
}

/** The direct parents a dataset record names (origin and union/lookup steps), de-duplicated, valid ids only. */
export function parentsOfRecord(raw: unknown): string[] {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as { origin?: unknown; steps?: unknown };
  const steps = Array.isArray(rec.steps) ? (rec.steps as { type?: unknown; datasetId?: unknown }[]) : [];
  return [...new Set([...stepRefIds(steps), ...originParentIds(rec.origin)].filter((id): id is string => typeof id === 'string' && isValidId(id)))];
}

/**
 * Every dataset `id` is built from, not counting itself. `complete` is false when
 * the walk ran out of depth with parents still unread — a caller that decides
 * access must then treat the chain as unknown, never as clean.
 */
export async function upstreamIds(id: string, parentsOf: (id: string) => Promise<readonly string[]>, maxDepth = MAX_DEPTH): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>();
  const seen = new Set<string>([id]);
  let frontier = [...(await parentsOf(id))];
  for (let depth = 0; frontier.length && depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const p of frontier) {
      if (seen.has(p)) continue;
      seen.add(p);
      ids.add(p);
      next.push(...(await parentsOf(p)));
    }
    frontier = next.filter((p) => !seen.has(p));
  }
  return { ids, complete: frontier.length === 0 };
}
