// VALIDATE an imported boundary GeoJSON before it is stored. PURE.
//
// A boundary file is untrusted input that the renderer will hand to MapLibre,
// so it is REBUILT rather than passed through: a FeatureCollection of Polygon /
// MultiPolygon features only, every coordinate a finite lon/lat in range,
// properties whitelisted to short string/number values under short keys, and
// hard caps on bytes, features and vertices. Anything else is a refusal with a
// sentence saying which rule it broke.

export const MAX_BOUNDARY_BYTES = 15 * 1024 * 1024;
export const MAX_FEATURES = 5000;
export const MAX_VERTICES = 2_000_000;
const MAX_PROPS = 24;
const MAX_KEY = 64;
const MAX_STR = 200;

export interface BoundarySet {
  type: 'FeatureCollection';
  features: { type: 'Feature'; properties: Record<string, string | number>; geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: any } }[];
}

export interface BoundaryCheck {
  ok: true;
  collection: BoundarySet;
  /** Property keys, with how many features carry each — for the join picker. */
  properties: { key: string; count: number; unique: boolean }[];
  bbox: [number, number, number, number];
}

type Refusal = { ok: false; error: string };

function ring(r: unknown, box: number[], budget: { n: number }): number[][] | null {
  if (!Array.isArray(r) || r.length < 4) return null;
  const out: number[][] = [];
  for (const p of r) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = p[0];
    const lat = p[1];
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    if (--budget.n < 0) return null;
    box[0] = Math.min(box[0], lng); box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lng); box[3] = Math.max(box[3], lat);
    out.push([lng, lat]);
  }
  return out;
}

function polygon(p: unknown, box: number[], budget: { n: number }): number[][][] | null {
  if (!Array.isArray(p) || p.length === 0) return null;
  const out: number[][][] = [];
  for (const r of p) {
    const clean = ring(r, box, budget);
    if (!clean) return null;
    out.push(clean);
  }
  return out;
}

/** Parse and rebuild. `text` is the file's contents. */
export function checkBoundaries(text: string): BoundaryCheck | Refusal {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'That file is empty.' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BOUNDARY_BYTES) return { ok: false, error: 'Boundary files up to 15 MB can be imported.' };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    return { ok: false, error: 'That is not valid JSON.' };
  }
  if (!raw || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    return { ok: false, error: 'A boundary file must be a GeoJSON FeatureCollection.' };
  }
  if (raw.features.length === 0) return { ok: false, error: 'That FeatureCollection has no features.' };
  if (raw.features.length > MAX_FEATURES) return { ok: false, error: `Boundary files up to ${MAX_FEATURES.toLocaleString()} regions can be imported.` };

  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const budget = { n: MAX_VERTICES };
  const counts = new Map<string, number>();
  const values = new Map<string, Set<string>>();
  const features: BoundarySet['features'] = [];
  for (let i = 0; i < raw.features.length; i++) {
    const f = raw.features[i];
    const g = f && f.type === 'Feature' ? f.geometry : null;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) {
      return { ok: false, error: `Region ${i + 1} is not a Polygon or MultiPolygon — only areas can be a choropleth.` };
    }
    const coords = g.type === 'Polygon'
      ? polygon(g.coordinates, box, budget)
      : Array.isArray(g.coordinates) && g.coordinates.length
        ? g.coordinates.map((p: unknown) => polygon(p, box, budget))
        : null;
    if (!coords || (Array.isArray(coords) && coords.some((p: unknown) => p === null))) {
      return budget.n < 0
        ? { ok: false, error: 'That file has too many points to draw — simplify it first.' }
        : { ok: false, error: `Region ${i + 1} has coordinates that are not longitude/latitude.` };
    }
    const props: Record<string, string | number> = {};
    const src = f.properties && typeof f.properties === 'object' ? f.properties : {};
    for (const k of Object.keys(src)) {
      if (Object.keys(props).length >= MAX_PROPS) break;
      if (!k || k.length > MAX_KEY || k.startsWith('__')) continue;
      const v = src[k];
      if (typeof v === 'string') props[k] = v.slice(0, MAX_STR);
      else if (typeof v === 'number' && Number.isFinite(v)) props[k] = v;
      else continue;
      counts.set(k, (counts.get(k) || 0) + 1);
      const seen = values.get(k) || new Set<string>();
      seen.add(String(props[k]));
      values.set(k, seen);
    }
    features.push({ type: 'Feature', properties: props, geometry: { type: g.type, coordinates: coords } });
  }
  if (counts.size === 0) return { ok: false, error: 'The regions have no text or number properties to join a column to.' };
  const properties = [...counts.entries()].map(([key, count]) => ({ key, count, unique: (values.get(key) as Set<string>).size === count }));
  return { ok: true, collection: { type: 'FeatureCollection', features }, properties, bbox: box as [number, number, number, number] };
}
