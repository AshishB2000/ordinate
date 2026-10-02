// The RADIUS filter — `within_km`: keep the rows whose point lies within `km`
// of a centre. PURE, main process. The JS reference the resident SQL
// (`src/engine/geoResident.ts` `sqlRadiusPredicate`) is held to.
//
// A FilterStep with op `within_km` names the LATITUDE column in `column` (so
// every existing "unknown column → skipped" rule applies to it unchanged) and
// carries the rest in `radius`: the longitude column, the centre and the
// distance. A row is kept when both of its cells are finite numbers on the
// globe and the haversine distance to the centre is ≤ km. A cell that is text,
// empty or out of range is never within any radius.

import type { Cell, FilterStep } from '../../data/transforms';
import { finiteNum, onGlobe } from './mercator';
import { haversineKm } from './haversine';

export const RADIUS_OP = 'within_km';
/** Half the Earth's circumference: every point is within it. */
export const MAX_RADIUS_KM = 20_016;

export interface RadiusSpec {
  /** The longitude column (the latitude one is the step's `column`). */
  lngColumn: string;
  /** The centre. */
  lat: number;
  lng: number;
  km: number;
  /** What the centre was typed as — "Austin, TX" — for summaries only. */
  place?: string;
}

/** Whitelist an untrusted radius, or null (the step is then dropped by sanitizeSteps). */
export function sanitizeRadius(raw: unknown): RadiusSpec | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const lngColumn = typeof o.lngColumn === 'string' ? o.lngColumn : '';
  const lat = finiteNum(o.lat);
  const lng = finiteNum(o.lng);
  const km = finiteNum(o.km);
  if (!lngColumn || !onGlobe(lat, lng) || km === null || km <= 0 || km > MAX_RADIUS_KM) return null;
  const out: RadiusSpec = { lngColumn, lat: lat as number, lng: lng as number, km };
  if (typeof o.place === 'string' && o.place.trim()) out.place = o.place.trim().slice(0, 200);
  return out;
}

/** The row test, given the two cells. */
export function withinKm(latCell: Cell | undefined, lngCell: Cell | undefined, r: RadiusSpec): boolean {
  const la = finiteNum(latCell);
  const lo = finiteNum(lngCell);
  if (!onGlobe(la, lo)) return false;
  return haversineKm(la as number, lo as number, r.lat, r.lng) <= r.km;
}

/**
 * A `radius` DASHBOARD CONTROL's selection (analysis/dashboards.ts): a centre
 * resolved from the offline places table, and a distance. `value` is the
 * sentence the chip and the export header show ("within 25 km of Austin, TX"),
 * so every existing "is anything selected" test that reads `value` works on it
 * unchanged.
 */
export interface RadiusValue { value: string; place: string; lat: number; lng: number; km: number }

export function sanitizeRadiusValue(raw: unknown): RadiusValue | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const r = sanitizeRadius({ lngColumn: '-', lat: o.lat, lng: o.lng, km: o.km, place: o.place });
  if (!r) return undefined;
  const place = r.place || '';
  return { value: radiusText(r), place, lat: r.lat, lng: r.lng, km: r.km };
}

/** The step a radius control's selection becomes — none while nothing is picked. */
export function radiusControlSteps(latColumn: string, lngColumn: string | undefined, state: unknown): FilterStep[] {
  const v = sanitizeRadiusValue(state);
  if (!v || !lngColumn) return [];
  const radius: RadiusSpec = { lngColumn, lat: v.lat, lng: v.lng, km: v.km };
  if (v.place) radius.place = v.place;
  return [{ type: 'filter', column: latColumn, op: 'within_km', radius }];
}

/** "within 25 km of Austin, TX" — the chip, the step list and the export header say this. */
export function radiusText(r: RadiusSpec): string {
  const km = Number.isInteger(r.km) ? String(r.km) : String(Math.round(r.km * 10) / 10);
  const at = r.place || `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`;
  return `within ${km} km of ${at}`;
}
