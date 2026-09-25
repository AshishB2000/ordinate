// PUSH refresh: when a dataset changes, re-run every SQL dataset built on it.
// MAIN PROCESS ONLY.
//
// A `sql` dataset records the datasets it read (`origin.deps`). A combined or
// composed dataset PULLS its parents when it is refreshed; a query cannot know
// when its inputs moved, so the input's change pushes instead. ONE entry point,
// called wherever a dataset's rows change — a manual or scheduled refresh, a
// prepare-step edit (which is also how the composer's initial mapping lands),
// and a retype/rename:
//
//   refreshDependents(projectId, changedId)
//
// It NEVER throws or rejects, so a caller may await it or drop it. A failure is
// recorded on the dependent through the ordinary refresh markers
// (refreshDataset → markRefresh), which is where the list's red dot reads it.
//
// ORDER. The whole downstream set is collected first and refreshed in
// dependency order, so in a diamond (A → B → C and A → C) C runs once, AFTER B.
// A dependent whose own input failed is not run over stale data; it is marked
// with the reason instead. Cycles cannot be saved (a query can only name
// datasets that already exist), but a hand-edited record could make one, so the
// walk is visited-set guarded and depth-limited, and anything left unordered is
// marked rather than looped on.
//
// Serial per project: two edits in quick succession queue, so an older run can
// never finish last and leave a dependent on stale input.

import { runQualityChecks } from '../analysis/qualityRun';
import * as datasets from './datasets';
import { refreshDataset } from './datasetRefresh';

/** How many SQL hops downstream one change may reach. */
const MAX_DEPTH = 8;

const queues = new Map<string, Promise<void>>();

export function refreshDependents(projectId: string, changedId: string): Promise<void> {
  const prev = queues.get(projectId) || Promise.resolve();
  const next = prev.then(() => pushFrom(projectId, changedId)).catch(() => { /* never reject */ });
  queues.set(projectId, next);
  void next.then(() => {
    if (queues.get(projectId) === next) queues.delete(projectId);
  });
  return next;
}

async function pushFrom(projectId: string, rootId: string): Promise<void> {
  const list = await datasets.listDatasets(projectId);
  const inputs = new Map<string, string[]>(); // sql dataset → the datasets it reads
  const names = new Map<string, string>();
  for (const d of list) {
    names.set(d.id, d.name);
    if (d.originKind === 'sql') inputs.set(d.id, d.originDeps || []);
  }

  // Everything downstream of the root, breadth-first, depth-limited.
  const down = new Set<string>();
  let frontier = [rootId];
  for (let depth = 0; frontier.length && depth < MAX_DEPTH; depth += 1) {
    const nextFrontier: string[] = [];
    for (const [id, deps] of inputs) {
      if (down.has(id) || id === rootId) continue;
      if (deps.some((d) => frontier.includes(d))) {
        down.add(id);
        nextFrontier.push(id);
      }
    }
    frontier = nextFrontier;
  }
  if (frontier.length) {
    for (const [id, deps] of inputs) {
      if (!down.has(id) && id !== rootId && deps.some((d) => frontier.includes(d))) {
        await datasets.markRefresh(projectId, id, 'error',
          `Not refreshed: it is more than ${MAX_DEPTH} queries downstream of the change. Refresh it directly.`);
      }
    }
  }

  // Dependency order: a dataset runs once every input inside the set is done.
  const failed = new Set<string>();
  while (down.size) {
    const ready = [...down].filter((id) => (inputs.get(id) || []).every((d) => !down.has(d)));
    if (!ready.length) {
      for (const id of down) {
        await datasets.markRefresh(projectId, id, 'error', 'Not refreshed: its queries read each other in a circle.');
      }
      return;
    }
    for (const id of ready) {
      down.delete(id);
      const brokenInput = (inputs.get(id) || []).find((d) => failed.has(d));
      if (brokenInput) {
        failed.add(id);
        await datasets.markRefresh(projectId, id, 'error',
          `Not refreshed: "${names.get(brokenInput) || 'an input'}" failed to refresh, so this was left as it was.`);
        continue;
      }
      const res = await refreshDataset(projectId, id);
      if (!res.ok) failed.add(id);
      // Its rows changed, so its OWN quality rules run too (they would on any
      // other refresh). Delivered like a manual refresh's; never throws.
      else await runQualityChecks(projectId, id);
    }
  }
}
