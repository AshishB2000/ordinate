// Does this column hold PLACES the app can actually draw?
//
// The templates catalogue has a `geo` role (Sales' "Region"), and a role that
// resolves to a real geography gets a choropleth while one that does not gets a
// bar chart. That decision cannot be made from the column NAME — a column called
// `region` holding "East/West/Central" is not a map, and a column called `state`
// holding full state names is — so it is made from the VALUES, against the same
// boundary assets and the same name matcher `map_choropleth` renders with.
//
// REUSE, not a second matcher: `normalizeName` comes from renderer/hub/geoMatch,
// the pure join layer mapRender.ts uses, and the feature names come from the
// SHIPPED assets/geo files rather than a hand-copied list. If a boundary set
// changes, this changes with it. (scripts/test-geoLevels.ts loads the same two
// assets the same way, for the same reason.)
//
// MAIN PROCESS. Synchronous fs, once per level per process — the assets are
// 59 KB and 172 KB of JSON and this runs once per wizard, not per row.

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// geoMatch.js is a renderer global-script, not a TS module: it detects
// module.exports and exports there for exactly this kind of caller (and for
// scripts/test-geoLevels.ts, which has required it since Phase 0). Loose types.
const { normalizeName } = require('../../renderer/hub/geoMatch') as {
  normalizeName: (n: string | null | undefined) => string;
};

/**
 * The levels a bundled boundary set can draw WITHOUT a second column.
 *
 * `us_county` is deliberately absent: county names are not unique without a
 * state ("Washington" is a county in 30 of them), so resolving one from a single
 * column's values would be a guess. `us_city`/`us_zip` have no bundled polygons
 * at all (mapRender.loadChoroplethData returns null for them).
 */
export type ResolvedGeoLevel = 'us_state' | 'country';

const ASSETS: Record<ResolvedGeoLevel, { file: string; global: string }> = {
  us_state: { file: 'us-states.js', global: '__GEO_US_STATES__' },
  country: { file: 'world-countries.js', global: '__GEO_WORLD__' },
};

/** level → the normalized feature names in that boundary set. */
const nameCache = new Map<ResolvedGeoLevel, Set<string>>();

/**
 * Normalized feature names for a level, or an empty set when the asset is
 * missing or unreadable — a missing boundary file means "no map", never a throw.
 *
 * The world/state sets ship as `window.__GEO_X__ = {...};` script assets (they
 * are eager <script> tags in the hub), so they are evaluated in a throwaway vm
 * context rather than parsed by hand.
 */
function featureNames(level: ResolvedGeoLevel): Set<string> {
  const cached = nameCache.get(level);
  if (cached) return cached;
  const out = new Set<string>();
  try {
    const { file, global } = ASSETS[level];
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'geo', file), 'utf8');
    const sandbox: any = { window: {} }; // ponytail: postinstall-fetched build output, untyped
    vm.runInNewContext(src, sandbox);
    const features = sandbox.window[global]?.features;
    if (Array.isArray(features)) {
      for (const f of features) {
        const n = normalizeName(f?.properties?.name);
        if (n) out.add(n);
      }
    }
  } catch {
    // Leave the set empty: every hit rate against it is 0, so the caller draws a
    // bar chart instead of a map. That is the right answer, not a failure.
  }
  nameCache.set(level, out);
  return out;
}

/** Share of a level's own features these values cover, ignoring order. */
function hitRate(level: ResolvedGeoLevel, distinct: string[]): number {
  const names = featureNames(level);
  if (names.size === 0 || distinct.length === 0) return 0;
  let hits = 0;
  for (const v of distinct) if (names.has(normalizeName(v))) hits += 1;
  return hits / distinct.length;
}

/** Below this share of matched values a column is a category, not a map. */
export const GEO_MIN_HIT_RATE = 0.6;

/**
 * The best geography these sample values belong to, or null.
 *
 * Deterministic in `values`: distinct-and-sorted first, so a different row order
 * from the same column cannot produce a different level. Ties go to `us_state`
 * — declaration order in ASSETS — which only bites for a value that is both a
 * state and a country, of which there are none in the shipped sets.
 */
export function resolveGeoLevel(
  values: (string | number | null)[],
): { level: ResolvedGeoLevel; hitRate: number } | null {
  const distinct = Array.from(
    new Set(
      values
        .map((v) => (v == null ? '' : String(v).trim()))
        .filter((v) => v !== ''),
    ),
  ).sort();
  if (distinct.length === 0) return null;
  let best: { level: ResolvedGeoLevel; hitRate: number } | null = null;
  for (const level of Object.keys(ASSETS) as ResolvedGeoLevel[]) {
    const rate = hitRate(level, distinct);
    if (rate >= GEO_MIN_HIT_RATE && (!best || rate > best.hitRate)) best = { level, hitRate: rate };
  }
  return best;
}

/**
 * Resolve a whole dataset's sampled columns at once — the one call the IPC layer
 * and the tests make, so the boundary sets are read once per process and every
 * caller resolves them the same way.
 *
 * Columns that resolve to nothing are simply absent from the result, which is
 * what `templateRoles.GeoHits` means by "not a place".
 */
export function resolveGeoHits(
  samples: Record<string, (string | number | null)[]>,
): Record<string, { level: ResolvedGeoLevel; hitRate: number }> {
  const out: Record<string, { level: ResolvedGeoLevel; hitRate: number }> = {};
  for (const col of Object.keys(samples)) {
    const hit = resolveGeoLevel(samples[col]);
    if (hit) out[col] = hit;
  }
  return out;
}
