// Static mini-maps for gallery cards: a choropleth (or bubble map) drawn onto a
// plain 2D canvas. NO MapLibre, no WebGL2, no tiles, no network, no interaction.
//
// WHY THIS EXISTS. The real map renderer (mapRender.ts) needs WebGL2 and the
// visible hub window, so it cannot draw a thumbnail — which is why vizThumbs.ts
// used to leave map cards on their glyph, reading as failed cards next to two
// real miniatures. Everything a *shape* needs is already local: the boundary
// GeoJSON ships in assets/geo, and geoMatch.js already joins rows to regions.
// So: project the polygons, fill the matched ones from mapRender's own colour
// scale, leave the rest at the empty fill. A shape, not a map — no labels, no
// legend, no basemap, no hover. That runs anywhere a 2D context does, including
// the offscreen report window.
//
// Classic global-scope renderer <script>: no import/export. Loads AFTER
// geoMatch.js and mapRender.js (it borrows matchGeoItem, getChoroplethColor,
// _geoBBox/_extendBBox from them) and BEFORE vizThumbs.js, its only caller.
// The tail `module.exports` is the geoMatch.js trick: it lets the Node
// self-check (scripts/test-mapThumb.js) require the pure functions without a
// DOM. It is a no-op in the browser, where `module` is undefined.

// A level's boundaries are multi-MB (us-counties.json is 1.9 MB): a gallery of
// twenty county maps must read it ONCE. Keyed by level, storing the in-flight
// promise so concurrent cards share one load, and carrying the all-features
// bbox so the 3,221-feature sweep is not repeated per card either.
interface MapThumbLevel { features: any[]; bboxes: any[]; bbox: any }
const _mapThumbGeo = new Map<string, Promise<MapThumbLevel | null>>();

const MAP_THUMB_PAD = 2;          // px inset so a coastline never touches the edge
const MAP_THUMB_BUBBLE_R = [2, 9]; // min/max bubble radius, px

// Boundaries for a choropleth level, cached. Small sets are window globals from
// the `geo` lazy bundle (212K — deliberately NOT the `map` bundle, which would
// drag in MapLibre's 714K for a picture that never uses it); us_county comes
// from main over IPC. Unknown or polygon-less levels (us_city/us_zip/point)
// resolve null and the caller keeps the glyph.
function mapThumbGeo(level: string): Promise<MapThumbLevel | null> {
  const hit = _mapThumbGeo.get(level);
  if (hit) return hit;
  const p = (async () => {
    let data: any = null;
    if (level === 'us_county') {
      if (window.hub && typeof window.hub.loadGeo === 'function') data = await window.hub.loadGeo('us_county');
    } else if (level === 'country' || level === 'us_state') {
      if (await ensureBundle('geo')) {
        data = level === 'country' ? window.__GEO_WORLD__ : window.__GEO_US_STATES__;
      }
    }
    const features = (data && Array.isArray(data.features)) ? data.features : null;
    if (!features || features.length === 0) return null;
    // Per-feature bboxes are cached too: the fit is per-CARD (each map fits its
    // own matched regions) and re-walking 3,221 county rings per card is the
    // difference between a gallery that paints and one that stutters.
    const bboxes = features.map((f: any) => _geoBBox(f && f.geometry));
    let bbox: any = null;
    for (const b of bboxes) bbox = _extendBBox(bbox, b);
    return bbox ? { features, bboxes, bbox } : null;
  })().catch(() => null);
  _mapThumbGeo.set(level, p);
  return p;
}

// lng/lat → canvas px, fitting `bbox` into `width`×`height` with `pad` inset and
// the aspect preserved (never stretched to fill). Equirectangular with the
// standard parallel at the bbox's mid-latitude, i.e. longitudes compressed by
// cos(midLat) — two lines that stop the US looking 30% too wide.
function mapThumbProject(
  bbox: [number, number, number, number], width: number, height: number, pad: number,
): (lng: number, lat: number) => [number, number] {
  const [w, s, e, n] = bbox;
  const kx = Math.cos((s + n) / 2 * Math.PI / 180) || 1;
  const dx = Math.max(1e-9, (e - w) * kx), dy = Math.max(1e-9, n - s);
  const bw = Math.max(1, width - pad * 2), bh = Math.max(1, height - pad * 2);
  const scale = Math.min(bw / dx, bh / dy);
  const ox = pad + (bw - dx * scale) / 2, oy = pad + (bh - dy * scale) / 2;
  return (lng, lat) => [ox + (lng - w) * kx * scale, oy + (n - lat) * scale];
}

// One fill colour per feature, in feature order. Matched regions take
// colorFor(t) on the SAME 0..1 min/max normalisation the real choropleth uses
// (mapRender._renderChoroplethMap); everything else — unmatched, or matched with
// no numeric value — takes `emptyFill`. Pure: colorFor is injected so the Node
// self-check can assert the scale without a theme.
function mapThumbFills(
  features: any[], items: any[], emptyFill: string, colorFor: (t: number) => string,
): string[] {
  const vs = (items || []).map((i: any) => i && i.value).filter((v: any) => typeof v === 'number');
  const min = vs.length ? Math.min(...vs) : 0;
  const max = vs.length ? Math.max(...vs) : 1;
  return (features || []).map((f: any) => {
    const item = matchGeoItem(items || [], (f && f.properties) || {});
    if (!item || typeof item.value !== 'number') return emptyFill;
    return colorFor(max > min ? (item.value - min) / (max - min) : 0.5);
  });
}

function _mapThumbRings(geometry: any): any[] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
  return [];
}

function _mapThumbTrace(ctx: any, rings: any[], project: (lng: number, lat: number) => [number, number]): void {
  ctx.beginPath();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const p = project(ring[i][0], ring[i][1]);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
  }
}

// Draw the thumbnail. Returns false — silently, always — when anything is
// missing (no geo on the data, no boundaries for the level, no 2D context, a
// zero-size tile): vizThumbs.ts then leaves the card's glyph alone, because a
// broken card is worse than a plain one.
async function drawMapThumb(canvas: HTMLCanvasElement, data: any, chartType: string): Promise<boolean> {
  const geo = data && data.geo;
  if (!geo || !Array.isArray(geo.items) || geo.items.length === 0) return false;
  const loaded = await mapThumbGeo(String(geo.level || ''));
  if (!loaded || !canvas.isConnected) return false;

  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w < 8 || h < 8) return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const empty = getCSSVar('--surface-3', canvas) || '#e5e7eb';
  const line = getCSSVar('--border', canvas) || '#d1d5db';
  const isBubble = chartType === 'map_bubble';

  // '' is the sentinel for "no data", so the fit below can tell a matched region
  // from one that merely happens to share the empty colour.
  const raw = mapThumbFills(loaded.features, geo.items, '', (t) => getChoroplethColor(t, canvas));

  // A bubble map is points, not filled regions — so its polygons stay at the
  // empty fill and the values are circles on top. Never dressed up as a
  // choropleth; the match is used only to frame the picture.
  const fills = isBubble ? loaded.features.map(() => empty) : raw.map((c) => c || empty);

  // Fit the MATCHED regions, exactly as the live map does (_fitBBox over the
  // matched bbox) — fitting the whole level instead let Alaska and the Aleutians
  // push the lower 48 into a corner of the tile. Nothing matched: fall back to
  // the whole level, which is what the live map's jumpTo does.
  let fit: any = null;
  raw.forEach((c, i) => { if (c) fit = _extendBBox(fit, loaded.bboxes[i]); });
  const project = mapThumbProject(fit || loaded.bbox, w, h, MAP_THUMB_PAD);

  ctx.lineWidth = 0.4;
  ctx.strokeStyle = line;
  loaded.features.forEach((f: any, i: number) => {
    const rings = _mapThumbRings(f && f.geometry);
    if (rings.length === 0) return;
    _mapThumbTrace(ctx, rings, project);
    ctx.fillStyle = fills[i];
    ctx.fill('evenodd');
    ctx.stroke();
  });

  if (isBubble) _mapThumbBubbles(ctx, geo, loaded, project, canvas);
  return true;
}

// Value circles for a bubble map, at each item's own lat/lng — or, for named
// regions (which carry no coordinates), at the matched boundary's centroid, the
// same derivation the live bubble map uses.
function _mapThumbBubbles(
  ctx: any, geo: any, loaded: MapThumbLevel,
  project: (lng: number, lat: number) => [number, number], el: Element,
): void {
  // Copy: fillCentroidsFromBoundaries mutates, and geo.items belongs to the
  // caller's data object, which the live map may render next.
  const items = geo.items.map((i: any) => Object.assign({}, i));
  fillCentroidsFromBoundaries(items, { features: loaded.features });
  const placed = items.filter((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number'
    && typeof i.value === 'number');
  if (placed.length === 0) return;
  const vs = placed.map((i: any) => i.value);
  const min = Math.min(...vs), max = Math.max(...vs);
  const [minR, maxR] = MAP_THUMB_BUBBLE_R;
  const accent = getCSSVar('--accent', el) || '#3b82f6';
  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha = 0.55;
  for (const item of placed) {
    const t = max > min ? (item.value - min) / (max - min) : 0.5;
    const p = project(item.lng, item.lat);
    ctx.beginPath();
    ctx.arc(p[0], p[1], minR + t * (maxR - minR), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Node self-check hook (see the header). Undefined in the browser.
if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = { mapThumbProject, mapThumbFills };
}
