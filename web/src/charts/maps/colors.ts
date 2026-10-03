// Map colour — the sequential choropleth ramp (also the hexbin's and a numeric
// point colour's), the categorical point palette and the flow width scale.
// PURE: the theme arrives as values read off the map's own element (a
// dashboard preset can remap tokens on a container, so never off :root).

const STOPS_LIGHT = ['#d6e4f5', '#8aaedd', '#5279bb', '#3d6bc9', '#2d529e'];
const STOPS_DARK = ['#1a3366', '#1d44b0', '#3d6bc9', '#5278cf', '#8aaedd'];

/** The fallback chart palette (renderer/hub/chartPalette.ts) when a --chart-N token is unset. */
export const CHART_PALETTE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b', '#b45309', '#be185d', '#4d7c0f'];

/** Is a surface colour dark? ponytail: 6-digit hex only (every token is); anything else reads light. */
export function isDarkHex(surface: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(surface.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

export function rampStops(dark: boolean): readonly string[] {
  return dark ? STOPS_DARK : STOPS_LIGHT;
}

/** The ramp at t ∈ [0, 1], interpolated between the five stops. */
export function choroplethColor(t: number, dark: boolean): string {
  const stops = rampStops(dark);
  const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(stops.length - 1, lo + 1);
  const frac = scaled - lo;
  if (frac === 0) return stops[lo];
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const to = parse(stops[hi]);
  return '#' + parse(stops[lo]).map((v, i) => Math.round(v + frac * (to[i] - v)).toString(16).padStart(2, '0')).join('');
}

/** Where a value sits in [min, max]; 0.5 when the range is flat. */
export const unit = (v: number, min: number, max: number): number => (max > min ? (v - min) / (max - min) : 0.5);

export const POINT_MAX_COLORS = 8;

export interface PointColors {
  of(item: { color?: string | number }): string;
  /** Category → colour rows ("N more" last), or null for a ramp / no colour column. */
  legend: Array<[string, string]> | null;
  ramp: [number, number] | null;
}

/**
 * A point map's colours: a number column → the ramp over its range; text →
 * the chart palette in first-seen order, the tail as one muted colour; no
 * colour column → the accent. ponytail: the project's own category colours
 * (fmtColors.ts on the desktop) are not served yet — the palette stands in.
 */
export function pointColors(
  items: ReadonlyArray<{ color?: string | number }>,
  theme: { accent: string; muted: string; palette: readonly string[]; dark: boolean },
): PointColors {
  const vals = items.map((i) => i.color).filter((c): c is string | number => c !== undefined && c !== null && c !== '');
  if (!vals.length) return { of: () => theme.accent, legend: null, ramp: null };
  if (vals.every((v) => typeof v === 'number')) {
    const nums = vals as number[];
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return {
      of: (it) => (typeof it.color === 'number' ? choroplethColor(unit(it.color, lo, hi), theme.dark) : theme.accent),
      legend: null,
      ramp: [lo, hi],
    };
  }
  const order: string[] = [];
  for (const v of vals) {
    const k = String(v);
    if (!order.includes(k)) order.push(k);
  }
  const color = new Map(order.slice(0, POINT_MAX_COLORS).map((k, i) => [k, theme.palette[i % theme.palette.length]]));
  const legend: Array<[string, string]> = order.slice(0, POINT_MAX_COLORS).map((k) => [k, color.get(k) as string]);
  if (order.length > POINT_MAX_COLORS) legend.push([`${order.length - POINT_MAX_COLORS} more`, theme.muted]);
  return { of: (it) => color.get(String(it.color)) || (it.color == null ? theme.accent : theme.muted), legend, ramp: null };
}

export const FLOW_W_MIN = 1.2;
export const FLOW_W_MAX = 9;

/** Route width on a square-root scale (area-like: twice the value reads ~1.4× as wide). */
export function flowWidth(v: number | null, max: number): number {
  if (typeof v !== 'number' || !(max > 0) || v <= 0) return FLOW_W_MIN;
  return FLOW_W_MIN + Math.sqrt(v / max) * (FLOW_W_MAX - FLOW_W_MIN);
}
