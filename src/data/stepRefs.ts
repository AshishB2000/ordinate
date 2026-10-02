// Load the OTHER datasets a pipeline's union / lookup steps read — MAIN PROCESS.
//
// The fold stays pure: it never reads a file. Every caller that runs a
// dataset's pipeline loads its references here first and hands the result in as
// the PipelineContext. A reference is withheld, with the reason the step will
// skip with, when it is this dataset itself, when it would close a cycle (the
// other dataset already builds on this one — through its own steps or its
// origin), or when it no longer exists.
//
// The referenced table is the other dataset's CURRENT stored output. It is not
// re-derived here, so there is no recursion to guard beyond the cycle check;
// when that dataset changes, datasetDependents re-runs this one.

import * as datasets from './datasets';
import type { PipelineContext } from './stepTypes';
import { stepRefIds } from './stepTypes';
import { originParents } from './datasetSummary';
import { loadSpatialRefs } from './spatialRefs';

/** How far the cycle walk follows references before it calls the chain a loop. */
const MAX_DEPTH = 16;

/** True when `fromId` builds on `targetId`, through steps or origin, within MAX_DEPTH hops. */
export async function buildsOn(projectId: string, fromId: string, targetId: string): Promise<boolean> {
  const seen = new Set<string>();
  let frontier = [fromId];
  for (let depth = 0; frontier.length && depth < MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = await datasets.getDatasetMeta(projectId, id);
      if (meta) next.push(...stepRefIds(meta.steps), ...originParents(meta.origin));
    }
    frontier = next;
  }
  return frontier.length > 0; // ran out of depth: treat as a loop rather than trust it
}

export async function loadStepRefs(projectId: string, selfId: string, steps: unknown): Promise<PipelineContext> {
  const ctx: PipelineContext = { tables: {}, errors: {} };
  const errors = ctx.errors as Record<string, string>;
  for (const id of stepRefIds(Array.isArray(steps) ? steps : [])) {
    if (id === selfId) {
      errors[id] = 'a dataset cannot read its own rows';
      continue;
    }
    if (await buildsOn(projectId, id, selfId)) {
      errors[id] = 'that dataset already builds on this one, so reading it would make a cycle';
      continue;
    }
    const ds = await datasets.getDataset(projectId, id);
    if (!ds) {
      errors[id] = 'the other dataset was not found (was it deleted?)';
      continue;
    }
    ctx.tables[id] = { columns: ds.columns, rows: ds.rows };
  }
  const boundaries = await loadSpatialRefs(projectId, steps); // r6:geo — spatial_join's regions
  if (boundaries) ctx.boundaries = boundaries;
  return ctx;
}
