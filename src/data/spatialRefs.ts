// Load the BOUNDARY SETS a pipeline's spatial_join steps read — MAIN PROCESS.
// The geo twin of stepRefs.loadStepRefs's other-dataset loading, and called
// from it, so every caller that runs a pipeline hands the fold its boundaries
// without knowing this exists.
//
// Bundled sets (US states, countries, US counties) are the files already in
// assets/geo, read through publish/geoData.bundledLevel and indexed ONCE per
// process — 3,221 county polygons are not re-indexed on every recompute. A
// project's own set is read from its store each time: it is small, and a set
// deleted since must say so rather than keep answering from a cache.

import { bundledLevel } from '../publish/geoData';
import { getBoundary } from '../app/projectBoundaries';
import { buildBoundaryIndex } from '../analysis/geo/pip';
import type { BoundaryIndex } from '../analysis/geo/pip';
import { bundledName, spatialKey } from '../analysis/geo/spatialJoin';
import type { SpatialJoinStep } from './stepTypes';

const bundled = new Map<string, BoundaryIndex | null>();

/** The indexed bundled set for a level, or null when its asset is missing. */
export function bundledIndex(level: string): BoundaryIndex | null {
  if (!bundled.has(level)) bundled.set(level, buildBoundaryIndex(bundledLevel(level), (p) => bundledName(level, p)));
  return bundled.get(level) || null;
}

export async function loadSpatialRefs(projectId: string, steps: unknown): Promise<Record<string, BoundaryIndex | string> | undefined> {
  const out: Record<string, BoundaryIndex | string> = {};
  for (const raw of Array.isArray(steps) ? steps : []) {
    if (!raw || (raw as { type?: unknown }).type !== 'spatial_join') continue;
    const s = raw as SpatialJoinStep;
    const key = spatialKey(s);
    if (key in out) continue;
    if (s.boundary !== 'custom') {
      out[key] = bundledIndex(s.boundary) || 'the bundled boundaries are missing — reinstall the app';
      continue;
    }
    const fc = s.boundaryId ? await getBoundary(projectId, s.boundaryId).catch(() => null) : null;
    const prop = s.property || '';
    const index = fc ? buildBoundaryIndex(fc, (p) => (p[prop] == null ? '' : String(p[prop]))) : null;
    out[key] = index || (fc ? `no region in that boundary set has a "${prop}"` : 'that boundary set was not found (was it deleted?)');
  }
  return Object.keys(out).length ? out : undefined;
}
