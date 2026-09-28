// Point in polygon, and a bounding-box GRID INDEX over a boundary set — PURE,
// main process. What the `spatial_join` prepare step runs for every row.
//
// THE TEST is even-odd ray casting over EVERY ring of a polygon — the outer
// ring and its holes together — so a point inside a hole crosses the outer ring
// and the hole's ring and comes out even: outside. A MultiPolygon contains a
// point when ANY of its polygons does.
//
// BOUNDARY RULE (documented, deterministic): the crossing test is half-open —
// an edge counts when exactly one endpoint lies strictly above the point, and
// the crossing must lie strictly to the point's EAST. So a point exactly on an
// edge two polygons share belongs to exactly ONE of them: the polygon to its
// east across a vertical edge, the polygon to its north across a horizontal
// one. Never both, never neither. When feature bboxes overlap (a sloppy
// custom file), the FIRST feature in file order that contains the point wins.
//
// THE INDEX cuts the set's bounding box into a uniform grid; each cell lists,
// in file order, the features whose bbox touches it. A lookup reads one cell,
// then tests bboxes, then rings — so a million points over 3,221 counties test
// a handful of polygons each instead of scanning all of them.

export type Ring = number[][]; // [lng, lat][] — GeoJSON order
export type PolygonCoords = Ring[]; // [outer, ...holes]

export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outer ring minus holes: even-odd over all of them. */
export function pointInPolygon(lng: number, lat: number, poly: PolygonCoords): boolean {
  let inside = false;
  for (const ring of poly) if (Array.isArray(ring) && pointInRing(lng, lat, ring)) inside = !inside;
  return inside;
}

type BBox = [number, number, number, number]; // west, south, east, north

interface IndexedPolygon { bbox: BBox; rings: PolygonCoords }
interface IndexedFeature { name: string; bbox: BBox; polys: IndexedPolygon[] }

export interface BoundaryIndex {
  features: IndexedFeature[];
  bbox: BBox;
  cols: number;
  rows: number;
  cells: number[][];
}

function ringsBBox(rings: PolygonCoords, into: BBox | null): BBox | null {
  let b = into;
  for (const ring of rings) {
    for (const p of Array.isArray(ring) ? ring : []) {
      const x = p[0];
      const y = p[1];
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!b) b = [x, y, x, y];
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  return b;
}

/** A GeoJSON geometry's polygons, as rings. Anything but Polygon / MultiPolygon has none. */
function polygonsOf(geom: unknown): PolygonCoords[] {
  const g = geom && typeof geom === 'object' ? (geom as { type?: unknown; coordinates?: unknown }) : null;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === 'Polygon') return [g.coordinates as PolygonCoords];
  if (g.type === 'MultiPolygon') return g.coordinates as PolygonCoords[];
  return [];
}

/** How many grid cells per side: about two per feature overall, within [4, 256]. */
function gridSide(n: number): number {
  return Math.max(4, Math.min(256, Math.ceil(Math.sqrt(n) * 2)));
}

/**
 * Index a FeatureCollection. `nameOf` turns a feature's properties into the
 * value the join writes ('' leaves the feature out — it could only ever write
 * an empty region). Features with no polygon are skipped.
 */
export function buildBoundaryIndex(
  fc: unknown,
  nameOf: (props: Record<string, unknown>) => string,
): BoundaryIndex | null {
  const raw = fc && typeof fc === 'object' ? (fc as { features?: unknown }).features : null;
  const list = Array.isArray(raw) ? raw : [];
  const features: IndexedFeature[] = [];
  let all: BBox | null = null;
  for (const f of list) {
    const o = f && typeof f === 'object' ? (f as { properties?: unknown; geometry?: unknown }) : null;
    if (!o) continue;
    const props = o.properties && typeof o.properties === 'object' ? (o.properties as Record<string, unknown>) : {};
    const name = nameOf(props);
    if (!name) continue;
    const polys: IndexedPolygon[] = [];
    let fb: BBox | null = null;
    for (const rings of polygonsOf(o.geometry)) {
      const pb = ringsBBox(rings, null);
      if (!pb) continue;
      polys.push({ bbox: pb, rings });
      fb = ringsBBox(rings, fb);
    }
    if (!fb || !polys.length) continue;
    features.push({ name, bbox: fb, polys });
    all = all ? [Math.min(all[0], fb[0]), Math.min(all[1], fb[1]), Math.max(all[2], fb[2]), Math.max(all[3], fb[3])] : [...fb];
  }
  if (!all || !features.length) return null;
  const cols = gridSide(features.length);
  const rows = cols;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  const w = Math.max(1e-12, all[2] - all[0]);
  const h = Math.max(1e-12, all[3] - all[1]);
  const cx = (x: number): number => Math.max(0, Math.min(cols - 1, Math.floor(((x - all![0]) / w) * cols)));
  const cy = (y: number): number => Math.max(0, Math.min(rows - 1, Math.floor(((y - all![1]) / h) * rows)));
  features.forEach((f, i) => {
    for (let y = cy(f.bbox[1]); y <= cy(f.bbox[3]); y += 1) {
      for (let x = cx(f.bbox[0]); x <= cx(f.bbox[2]); x += 1) cells[y * cols + x].push(i);
    }
  });
  return { features, bbox: all, cols, rows, cells };
}

function inBox(lng: number, lat: number, b: BBox): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

/** The index of the first feature (file order) containing the point, or -1. */
export function locateIndex(idx: BoundaryIndex, lng: number, lat: number): number {
  if (!inBox(lng, lat, idx.bbox)) return -1;
  const w = Math.max(1e-12, idx.bbox[2] - idx.bbox[0]);
  const h = Math.max(1e-12, idx.bbox[3] - idx.bbox[1]);
  const x = Math.max(0, Math.min(idx.cols - 1, Math.floor(((lng - idx.bbox[0]) / w) * idx.cols)));
  const y = Math.max(0, Math.min(idx.rows - 1, Math.floor(((lat - idx.bbox[1]) / h) * idx.rows)));
  for (const i of idx.cells[y * idx.cols + x]) {
    const f = idx.features[i];
    if (!inBox(lng, lat, f.bbox)) continue;
    for (const p of f.polys) if (inBox(lng, lat, p.bbox) && pointInPolygon(lng, lat, p.rings)) return i;
  }
  return -1;
}

/** The name of the region containing the point, or null. */
export function locate(idx: BoundaryIndex, lng: number, lat: number): string | null {
  const i = locateIndex(idx, lng, lat);
  return i < 0 ? null : idx.features[i].name;
}

/** The same answer by scanning every feature — the reference the index is tested against. */
export function locateScan(idx: BoundaryIndex, lng: number, lat: number): string | null {
  for (const f of idx.features) {
    for (const p of f.polys) if (pointInPolygon(lng, lat, p.rings)) return f.name;
  }
  return null;
}
