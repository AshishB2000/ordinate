// Great-circle distance — PURE, main process. The ONE definition behind the
// formula function `distance_km`, the `within_km` radius filter and every
// distance the app reports.
//
// EARTH RADIUS: 6371.0088 km, the IUGG MEAN radius (R1 = (2a + b) / 3 of
// WGS-84) — the conventional choice for a spherical model, and within 0.3% of
// the true geodesic anywhere. Tests pin known distances computed with THIS
// radius, never a figure copied from a website that used another.
//
// The haversine form is used because it stays accurate for short distances
// (the law of cosines loses digits below ~1 km). `sqrt(a)` is clamped to 1 so
// rounding at the antipodes can never hand asin a value just over 1 (NaN).
//
// The SQL twin (`src/engine/geoResident.ts` `sqlHaversine`) is the same
// expression, operation for operation, with DEG and the radius bound as the
// same doubles. It is NOT bit-identical: DuckDB's sin/cos/asin come from the
// platform libm and V8's from its own port, and they disagree in the last bit
// on a few percent of inputs (measured). A distance can therefore differ by
// ~1e-12 km between the two engines — pinned by scripts/test-geoRadius.ts —
// which matters only to a point a nanometre from a radius boundary.

import { DEG } from './mercator';

export const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A coordinate the distance functions accept: finite, |lat| ≤ 90, |lon| ≤ 180. */
export function validCoord(lat: unknown, lon: unknown): boolean {
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
