// Boundary shapes for region maps and thumbnails. The three bundled levels are
// static files the server hashes (src/server/geo.ts: /api/geo/index.json names
// them, each URL immutable), fetched once per page and shared by every map
// and thumbnail on it; a project's own imported set comes over `boundary:get`.
// Point, city and ZIP levels have no polygons: null, and the caller falls back.

import { rpc } from '../../api/client';
import type { FeatureCollection, MapGeo } from './types';

let index: Promise<Record<string, string>> | null = null;
const levels = new Map<string, Promise<FeatureCollection | null>>();

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Map boundaries could not be loaded (${res.status}).`);
  return res.json();
}

/** Forget a failed load so the next render (a Retry) asks again. */
function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = load().catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  return p;
}

/** A bundled level's FeatureCollection (country, us_state, us_county), or null when the server has none. */
export function bundledBoundaries(level: string): Promise<FeatureCollection | null> {
  return once(levels, level, async () => {
    index ??= (getJson('/api/geo/index.json') as Promise<Record<string, string>>).catch((err: unknown) => {
      index = null;
      throw err;
    });
    const url = (await index)[level];
    if (!url) return null;
    const fc = (await getJson(url)) as FeatureCollection;
    return fc && Array.isArray(fc.features) && fc.features.length ? fc : null;
  });
}

/** The shapes a region map of `geo` draws on: a project's custom set, or the level's bundled one. */
export async function boundariesFor(geo: MapGeo, projectId: string | undefined): Promise<FeatureCollection | null> {
  if (geo.level === 'custom') {
    if (!geo.boundaryId || !projectId) return null;
    const res = (await rpc('boundary:get', { projectId, id: geo.boundaryId, property: geo.property })) as {
      ok: boolean;
      collection?: FeatureCollection;
    };
    return res.ok && res.collection ? res.collection : null;
  }
  return bundledBoundaries(geo.level);
}

/** Test seam: start from an empty cache. */
export function resetBoundaryCache(): void {
  index = null;
  levels.clear();
}
