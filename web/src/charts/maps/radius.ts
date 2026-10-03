// The radius control's pure half — renderer/hub/geoRadius.ts: "within 25 km of
// Austin, TX" as a sentence and as the one `within_km` filter step the server
// compiles (src/analysis/geo/radius.ts). The chip, popover and add/edit dialog
// are dashboard UI and port with the dashboards (T2.x); the editor they share
// is ./RadiusEditor.tsx.

export const RADIUS_PRESETS = [5, 10, 25, 50, 100] as const;
/** Half the Earth's circumference: no radius past it means anything. */
export const MAX_KM = 20016;

export interface RadiusState {
  /** The sentence — what every "is anything selected" and export-header read shows. */
  value: string;
  place: string;
  lat: number;
  lng: number;
  km: number;
}

export interface RadiusControl {
  /** The latitude column. */
  column: string;
  lngColumn?: string;
}

export function radiusSentence(km: number, place: string): string {
  const k = Number.isInteger(km) ? String(km) : String(Math.round(km * 10) / 10);
  return `within ${k} km of ${place}`;
}

/** One within_km filter step, or none while the control is unset. */
export function radiusSteps(control: RadiusControl, state: Partial<RadiusState> | null | undefined) {
  if (!state || !state.value || typeof state.lat !== 'number' || typeof state.lng !== 'number' || !((state.km ?? 0) > 0)) return [];
  if (!control.lngColumn) return [];
  return [
    {
      type: 'filter' as const,
      column: control.column,
      op: 'within_km',
      radius: { lngColumn: control.lngColumn, lat: state.lat, lng: state.lng, km: state.km as number, place: state.place || '' },
    },
  ];
}
