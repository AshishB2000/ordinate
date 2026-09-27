// Boundaries a published map draws — MAIN PROCESS.
//
// A published page has no network, so a map carries its own shapes: the SAME
// bundled boundary files the hub draws from (assets/geo, fetched by postinstall
// and shipped in the app), and a project's own imported boundaries. The
// "offline basemap" is the world land layer from those same files — what the
// hub's mapBasemap.ts draws when the basemap is off.
//
// Coordinates are rounded to 3 decimals (~100 m) on the way out: a published
// dashboard is read, not surveyed, and the world file halves in size.

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { getBoundary } from '../app/projectBoundaries';

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'geo');
const SCRIPT_ASSETS: Record<string, { file: string; global: string }> = {
  country: { file: 'world-countries.js', global: '__GEO_WORLD__' },
  us_state: { file: 'us-states.js', global: '__GEO_US_STATES__' },
};

function round(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1000) / 1000;
  return Array.isArray(v) ? v.map(round) : v;
}

function slim(fc: any): any { // any: GeoJSON off disk; sanitize.sanitizeBoundary clamps it later
  const features = Array.isArray(fc && fc.features) ? fc.features : [];
  return {
    type: 'FeatureCollection',
    features: features.map((f: any) => ({
      properties: f && f.properties ? f.properties : {},
      geometry: f && f.geometry ? { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } : null,
    })).filter((f: any) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')),
  };
}

/** A bundled level's boundaries, or null when the asset is missing. */
export function bundledLevel(level: string): any { // any: a GeoJSON FeatureCollection, or null
  try {
    if (SCRIPT_ASSETS[level]) {
      const { file, global } = SCRIPT_ASSETS[level];
      const sandbox: any = { window: {} }; // any: postinstall-fetched build output, evaluated in a throwaway context
      vm.runInNewContext(fs.readFileSync(path.join(ASSET_DIR, file), 'utf8'), sandbox);
      return slim(sandbox.window[global]);
    }
    if (level === 'us_county') return slim(JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'us-counties.json'), 'utf8')));
  } catch (_) { /* no asset: the map says it has no shapes, the rest of the page draws */ }
  return null;
}

/** Which bundled set a map level draws on: point / city / zip maps sit on the world land. */
export function baseLevelFor(level: string): string {
  if (level === 'us_state' || level === 'us_city' || level === 'us_zip') return 'us_state';
  if (level === 'us_county') return 'us_county';
  return 'country';
}

/**
 * Every boundary set the given maps need, keyed as the page looks them up:
 * a level name, or `custom:<boundaryId>`. The world is always included when
 * any map is, because it is the offline basemap under points.
 */
export async function geoFor(projectId: string, levels: string[], boundaryIds: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const want = new Set(levels.map(baseLevelFor));
  if (levels.length || boundaryIds.length) want.add('country');
  for (const level of want) {
    const fc = bundledLevel(level);
    if (fc) out[level] = fc;
  }
  for (const id of boundaryIds) {
    const fc = await getBoundary(projectId, id).catch(() => null);
    if (fc) out['custom:' + id] = slim(fc);
  }
  return out;
}
