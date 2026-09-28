// The HEX GRID — flat-top hexagons over Web Mercator world units. PURE, main
// process. An H3-LIKE grid computed in app code, with no library: a fixed set of
// resolutions, axial (q, r) coordinates, and cube rounding.
//
// RESOLUTIONS. Resolution k is drawn at map zoom 2k, where each hexagon's
// circumradius is HEX_PX screen pixels; its size in world units is therefore
// HEX_PX / (512 · 2^(2k)). A map at zoom Z shows resolution floor((Z + 1) / 2),
// so on screen a hexagon stays between HEX_PX/2 and 2·HEX_PX as the map zooms,
// and the grid only changes when the zoom crosses a bucket boundary. The set is
// small and fixed so an answer can be cached and computed for every level at
// once (the reply carries all of them, which is also what lets an exported or
// published map stay right at any zoom without asking main again).
//
// ASSIGNMENT. A point's world (x, y) goes to fractional axial coordinates
//   qf = (2/3 · x) / size        rf = (−1/3 · x + √3/3 · y) / size
// and is rounded in CUBE space (q, r, s = −q − r):
//   1. round each component with floor(v + 0.5) — halves go UP, towards +∞
//      (never Math.round's sign rules or SQL round()'s half-away-from-zero);
//   2. recompute the component with the LARGEST rounding error from the other
//      two, testing q, then r, with STRICT `>`, so on a tie the later axis
//      (s, then r) is the one recomputed.
// That rule is the documented TIE-BREAK for a point exactly on an edge or a
// vertex: it lands in exactly one hexagon, always the same one, on every path.
// `src/engine/geoResident.ts` spells the identical arithmetic in SQL with the
// constants below bound as parameters.
//
// HEX ID. "res:q:r" — stable, readable, and the key both engines group on.

import { lngOfX, latOfY, round6 } from './mercator';

/** Circumradius of a hexagon on screen at its own zoom, in CSS pixels. */
export const HEX_PX = 14;
/** Resolutions 0..HEX_LEVELS-1, drawn at zooms 0, 2, 4, … 14. */
export const HEX_LEVELS = 8;
/** A level with more hexagons than this is not sent — the map keeps the finest level under it. */
export const MAX_HEXES = 4000;

export const TWO_THIRDS = 2 / 3;
export const NEG_THIRD = -1 / 3;
export const SQRT3 = Math.sqrt(3);
export const SQRT3_3 = Math.sqrt(3) / 3;
export const SQRT3_2 = Math.sqrt(3) / 2;

/** Hexagon circumradius in world units at resolution `res`. */
export function hexSize(res: number): number {
  return HEX_PX / (512 * Math.pow(2, 2 * res));
}

/** Every level's size, index-aligned with the resolution — bound into SQL as-is. */
export const HEX_SIZES: readonly number[] = Array.from({ length: HEX_LEVELS }, (_, k) => hexSize(k));

/** The map zoom resolution `res` is drawn at. */
export function hexZoom(res: number): number {
  return 2 * res;
}

/** The resolution a map at `zoom` shows, clamped to the fixed set. */
export function resForZoom(zoom: number): number {
  const r = Math.floor((zoom + 1) / 2);
  return Math.max(0, Math.min(HEX_LEVELS - 1, Number.isFinite(r) ? r : 0));
}

/** -0 → 0, so an id never prints "-0" and Object.is agrees with SQL's integers. */
function z(v: number): number {
  return v + 0;
}

/** Cube rounding with the tie-break in the header. Returns integer axial (q, r). */
export function cubeRound(qf: number, rf: number): { q: number; r: number } {
  const sf = -qf - rf;
  let q = Math.floor(qf + 0.5);
  let r = Math.floor(rf + 0.5);
  const s = Math.floor(sf + 0.5);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: z(q), r: z(r) };
}

/** World (x, y) → the hexagon containing it at resolution `res`. */
export function hexOfWorld(x: number, y: number, res: number): { q: number; r: number } {
  const size = HEX_SIZES[res];
  const qf = (TWO_THIRDS * x) / size;
  const rf = (NEG_THIRD * x + SQRT3_3 * y) / size;
  return cubeRound(qf, rf);
}

export function hexId(res: number, q: number, r: number): string {
  return `${res}:${q}:${r}`;
}

/** A hexagon's centre in world units. */
export function hexCenterWorld(res: number, q: number, r: number): { x: number; y: number } {
  const size = HEX_SIZES[res];
  return { x: size * 1.5 * q, y: size * (SQRT3_2 * q + SQRT3 * r) };
}

/** A hexagon's centre in degrees, rounded for drawing. */
export function hexCenter(res: number, q: number, r: number): { lat: number; lng: number } {
  const c = hexCenterWorld(res, q, r);
  return { lat: round6(latOfY(c.y)), lng: round6(lngOfX(c.x)) };
}

/**
 * The six corners, flat-top (0°, 60°, … 300° from the centre), as ONE flat
 * array [lng0, lat0, lng1, lat1, …] in degrees rounded to 1e-6 — twelve numbers
 * per hexagon instead of seven nested pairs, because a fine level carries
 * thousands of them across IPC. The renderer closes the ring.
 */
export function hexRing(res: number, q: number, r: number): number[] {
  const size = HEX_SIZES[res];
  const c = hexCenterWorld(res, q, r);
  const out: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i;
    out.push(round6(lngOfX(c.x + size * Math.cos(a))), round6(latOfY(c.y + size * Math.sin(a))));
  }
  return out;
}
