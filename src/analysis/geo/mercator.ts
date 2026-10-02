// Web Mercator in NORMALISED WORLD UNITS — PURE, main process.
//
// The world is the unit square: x runs 0 → 1 west to east from −180° to 180°,
// y runs 0 → 1 north to south from +MAX_LAT to −MAX_LAT, exactly the space a
// MapLibre tile pyramid lives in (a map at zoom z is 512·2^z px across it).
//
// Every constant a SQL twin needs is exported, so `src/engine/geoResident.ts`
// binds the SAME doubles as parameters instead of re-deriving them — `lat *
// DEG` in SQL multiplies by the byte-identical number `lat * DEG` does here.

/** Degrees → radians, as one bound double. */
export const DEG = Math.PI / 180;
/** 4π, the denominator of the Mercator y. */
export const FOUR_PI = 4 * Math.PI;
/**
 * The latitude where Web Mercator's square world ends (atan(sinh(π)) in
 * degrees). A point beyond it cannot be drawn on a Mercator map, so the hex
 * grid EXCLUDES it (counted as skipped) rather than clamping it onto the edge
 * row, which would invent density at the top of the map.
 */
export const MAX_LAT = 85.05112878;

export function mercX(lng: number): number {
  return (lng + 180) / 360;
}

export function mercY(lat: number): number {
  const s = Math.sin(lat * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / FOUR_PI;
}

export function lngOfX(x: number): number {
  return x * 360 - 180;
}

export function latOfY(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
}

/** A finite JS number, else null — the declared-number cell rule every engine shares. */
export function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A latitude/longitude pair the hex grid can place: finite, |lat| ≤ MAX_LAT, |lng| ≤ 180. */
export function onMercator(lat: number | null, lng: number | null): boolean {
  return lat !== null && lng !== null && Math.abs(lat) <= MAX_LAT && Math.abs(lng) <= 180;
}

/** A latitude/longitude pair on the globe: finite, |lat| ≤ 90, |lng| ≤ 180. */
export function onGlobe(lat: number | null, lng: number | null): boolean {
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Degrees rounded to 1e-6 (~0.1 m) for drawing — geometry sent to a renderer, never a figure. */
export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
