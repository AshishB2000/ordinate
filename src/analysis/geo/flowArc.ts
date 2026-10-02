// The ARC a flow map draws between an origin and a destination — PURE, main
// process. Geometry for a renderer, never a figure.
//
// A quadratic Bézier in Web Mercator world units, bowed to the RIGHT of the
// direction of travel by ARC_BEND of its length. Two consequences worth having:
// the curve reads as movement rather than as a border, and A → B and B → A bow
// to opposite sides, so a route and its return never draw on top of each other.
// The short way round the globe is taken: a route over the antimeridian keeps
// going past ±180° (MapLibre draws longitudes beyond it on the next world copy).

import { MAX_LAT, lngOfX, latOfY, mercX, mercY, round6 } from './mercator';

const ARC_BEND = 0.18;
export const ARC_POINTS = 24;

const clampLat = (lat: number): number => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** The arc as flat [lng, lat, …], ARC_POINTS + 1 points, rounded for drawing. */
export function flowArc(oLat: number, oLng: number, dLat: number, dLng: number): number[] {
  const x0 = mercX(oLng);
  const y0 = mercY(clampLat(oLat));
  let x2 = mercX(dLng);
  const y2 = mercY(clampLat(dLat));
  if (x2 - x0 > 0.5) x2 -= 1;
  else if (x0 - x2 > 0.5) x2 += 1;
  const dx = x2 - x0;
  const dy = y2 - y0;
  // Right of travel on screen (y grows south): the direction turned clockwise.
  const x1 = (x0 + x2) / 2 - dy * ARC_BEND;
  const y1 = (y0 + y2) / 2 + dx * ARC_BEND;
  const out: number[] = [];
  for (let i = 0; i <= ARC_POINTS; i += 1) {
    const t = i / ARC_POINTS;
    const u = 1 - t;
    const x = u * u * x0 + 2 * u * t * x1 + t * t * x2;
    const y = u * u * y0 + 2 * u * t * y1 + t * t * y2;
    out.push(round6(lngOfX(x)), round6(latOfY(y)));
  }
  return out;
}
