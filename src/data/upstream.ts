// The datasets a dataset is built from, transitively — PURE given its reader.
// docs/row-policy/00-design.md D14.
//
// A dataset's direct parents are its origin's (a SQL or notebook dataset's deps,
// a combined or composed dataset's inputs: `originParents`) and the datasets its
// prepare steps union or look up (`stepRefIds`) — the same two edges
// `stepRefs.buildsOn` walks. Row access rules use the closure to close a dataset
// built from one with rules; the fan-out paths share it.

import { originParents } from './datasetSummary';
import { sanitizeOrigin } from './datasetOrigin';
import { stepRefIds } from './stepTypes';

/** How far the walk follows parents, as `stepRefs.buildsOn` does. */
export const MAX_DEPTH = 16;

/** The direct parents a raw dataset record names (origin and union/lookup steps), de-duplicated. */
export function parentsOfRecord(raw: unknown): string[] {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as { origin?: unknown; steps?: unknown };
  const steps = Array.isArray(rec.steps) ? (rec.steps as { type?: unknown; datasetId?: unknown }[]) : [];
  return [...new Set([...stepRefIds(steps), ...originParents(sanitizeOrigin(rec.origin))])];
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
