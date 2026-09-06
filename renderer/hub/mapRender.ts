// Map rendering (MapLibre GL) — bubble + choropleth maps, geo period building,
// the map period/values menus, and legends. Classic script sharing global scope:
// the maplibregl CSP-build UMD global, geoMatch.js helpers, window.hub.loadGeo,
// and hub.js's _fmtVal / getCSSVar / buildChart all resolve at call time.
//
// PRIVACY INVARIANT: the ONLY external hosts this file may ever contact are the
// three OpenStreetMap raster tile hosts below (the single declared external fetch
// in PRIVACY.md, and the only http(s) hosts the hub CSP allows). The MapLibre
// style is an INLINE object — never a style URL — and it deliberately declares no
// `glyphs` and no `sprite`, both of which would be extra network fetches. That is
// why map text labels are DOM markers, not symbol layers (symbol text needs glyph
// PBFs). Do not add a style URL, a vector tile source, or a demo tile server.

// ── Map rendering (MapLibre GL) ─────────────────────────────────────────────

// Sequential choropleth palette: 5 stops from surface-2 → accent
const CHOROPLETH_STOPS_LIGHT = ['#d6e4f5', '#8aaedd', '#5279bb', '#3d6bc9', '#2d529e'];
const CHOROPLETH_STOPS_DARK  = ['#1a3366', '#1d44b0', '#3d6bc9', '#5278cf', '#8aaedd'];

// The three OSM hosts allowed by the hub CSP. MapLibre round-robins over them the
// way Leaflet's {s} subdomain placeholder did.
const OSM_TILE_URLS = [
  'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
];
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

// ponytail: MapLibre GL (CSP build) UMD global, resolved at call time like the
// other vendor globals. Typed `any` — typing the full API isn't worth it, and it
// is read off `window` rather than declared in globals.d.ts so the script-tag
// wiring stays the only place that knows how the library gets loaded.
function _mlgl(): any {
  return (window as any).maplibregl;
}

// Is the surface `el` sits on a dark one? The root's `data-theme` is no longer the
// right question: a style preset remaps the theme tokens on a CONTAINER class, so a
// dark dashboard can live inside a light app, and four preset thumbnails can be on
// screen at once. ponytail: 6-digit hex only (every token here is); else reads light.
function isDarkSurface(el?: Element | null): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(getCSSVar('--surface', el)), n = m ? parseInt(m[1], 16) : 0xffffff;
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

function getChoroplethColor(t: number, el?: Element | null): string {
  const stops = isDarkSurface(el) ? CHOROPLETH_STOPS_DARK : CHOROPLETH_STOPS_LIGHT;
  const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(stops.length - 1, lo + 1), frac = scaled - lo;
  if (frac === 0) return stops[lo];
  const parse = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));   // hex → [r,g,b]
  const to = parse(stops[hi]);
  return '#' + parse(stops[lo]).map((v, i) => Math.round(v + frac * (to[i] - v)).toString(16).padStart(2, '0')).join('');
}

// normalizeName + matchGeoItem are provided as globals by geoMatch.js, loaded
// before this script (and require()'d directly by the Node self-check).

function destroyMapInContainer(container: HTMLElement): void {
  const old = mapInstances.get(container);
  if (old) { try { old.remove(); } catch (_) {} mapInstances.delete(container); }
}

// ── Export hooks ────────────────────────────────────────────────────────────
// The live MapLibre map for a viz container, or null. The export path uses this
// to reach `map.getCanvas()` (the map is created with preserveDrawingBuffer so
// the WebGL buffer is still readable at toDataURL time).
function getMapInContainer(container: HTMLElement): any {
  return (container && mapInstances.get(container)) || null;
}

// Resolves true once the map in `container` has finished loading tiles and
// settled ('idle'), false on timeout or when there is no map. Replaces the old
// DOM tile-counting wait — MapLibre knows when it is done.
function waitForMapIdle(container: HTMLElement, timeoutMs: number = 8000): Promise<boolean> {
  const map = getMapInContainer(container);
  if (!map) return Promise.resolve(false);
  const settled = () => {
    try { return !!(map.loaded() && map.areTilesLoaded() && !map.isMoving()); } catch (_) { return false; }
  };
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { map.off('idle', onIdle); } catch (_) {}
      resolve(ok);
    };
    const onIdle = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    try { map.on('idle', onIdle); } catch (_) { return finish(false); }
    // 'idle' only fires on the busy→idle transition; if we're already there it
    // would never fire again, so check once up front.
    if (settled()) finish(true);
  });
}

// ── Small pure geometry helpers (replace Leaflet's getBounds/getCenter) ─────
type BBox = [number, number, number, number];   // [west, south, east, north]

function _geoBBox(geometry: any): BBox | null {
  if (!geometry) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (coords: any): void => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const lng = coords[0], lat = coords[1];
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      return;
    }
    for (const c of coords) walk(c);
  };
  if (Array.isArray(geometry.geometries)) geometry.geometries.forEach((g: any) => walk(g && g.coordinates));
  else walk(geometry.coordinates);
  return isFinite(w) && isFinite(s) ? [w, s, e, n] : null;
}

function _extendBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function _bboxCenter(b: BBox): { lat: number; lng: number } {
  return { lng: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

// fitBounds without animation — deterministic pixels for the PNG export path.
function _fitBBox(map: any, bbox: BBox, padding: number, maxZoom: number): void {
  try {
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { padding, maxZoom, animate: false, duration: 0 });
  } catch (_) {}
}

// Tooltip/label text comes from the model's JSON envelope; it goes through
// setHTML, so escape it.
function _escGeo(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Resolve the boundary GeoJSON for a choropleth level. Small sets are eager
// window globals; us_county is lazy-loaded from main via IPC. us_city/us_zip have
// no bundled polygons (nationwide data is too large), so they return null and the
// caller falls back to a bubble map or bar chart.
async function loadChoroplethData(level: string): Promise<any> {
  if (level === 'country')  return window.__GEO_WORLD__ || null;
  if (level === 'us_state') return window.__GEO_US_STATES__ || null;
  if (level === 'us_county') {
    if (window.hub && typeof window.hub.loadGeo === 'function') {
      try { return await window.hub.loadGeo('us_county'); } catch (_) { return null; }
    }
  }
  return null;
}

// When a choropleth can't render (no boundaries for the level, or zero matches),
// degrade gracefully: bubble map if items have coordinates, else a column chart.
// Never falls back to the world map — that was the original blank-globe bug.
function renderGeoFallback(container: HTMLElement, data: any, note: string): void {
  destroyMapInContainer(container);
  container.innerHTML = '';
  const noteEl = document.createElement('div');
  noteEl.className = 'cv-chart-fallback';
  noteEl.textContent = note;
  container.appendChild(noteEl);

  const geo = data && data.geo;
  const hasCoords = geo && geo.items.some((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number');
  if (hasCoords) {
    renderMapInArea(container, data, 'map_bubble');
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'cv-canvas-wrap';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    container.appendChild(wrap);
    buildChart(canvas, data, 'column', {});
  }
}

// ponytail: the bundled us-states GeoJSON carries only a "name" property (no postal
// code), and there's no other abbreviation source — so this small lookup exists to
// label states as "CA" etc. Keyed by normalizeName() output (lowercased, suffixes
// stripped) so it matches both AI item names and feature names.
const US_STATE_ABBR: Record<string, string> = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA',
  'michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT',
  'nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM',
  'new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC','puerto rico':'PR',
};

// Short label for a region: USPS code for US states, iso2 for countries, else the name.
function abbrevFor(item: any, featProps: any, level: string): string {
  featProps = featProps || {};
  if (level === 'us_state') {
    return US_STATE_ABBR[normalizeName(item.name)]
        || US_STATE_ABBR[normalizeName(featProps.name || '')]
        || (item.name || '').slice(0, 3).toUpperCase();
  }
  if (level === 'country') {
    return String(featProps.iso2 || item.code || (item.name || '').slice(0, 2)).toUpperCase();
  }
  return item.name || featProps.name || '';
}

// Build per-period geo values from chart data (labels = region names, one series per
// period). Returns period names, an items-for-period accessor (geo.items with the value
// swapped to that period, falling back to the static value when a region isn't in the
// chart labels), and the GLOBAL min/max across all periods for a fixed color scale.
function buildPeriodGeo(labels: any[], series: any[], geoItems: any[]) {
  const idxByName = new Map<string, number>();
  (labels || []).forEach((lab, i) => idxByName.set(normalizeName(String(lab)), i));
  const periods = (series || []).map(s => (s && s.name) || '');
  // perItem[k] = array of this region's value per period, or null if unmatched.
  const perItem = geoItems.map(item => {
    const key = normalizeName(item.name);
    if (!idxByName.has(key)) return null;
    const i = idxByName.get(key)!;
    return series.map(s => (Array.isArray(s.values) && typeof s.values[i] === 'number') ? s.values[i] : null);
  });
  let minVal = Infinity, maxVal = -Infinity;
  perItem.forEach(arr => { if (arr) arr.forEach(v => { if (typeof v === 'number') { if (v < minVal) minVal = v; if (v > maxVal) maxVal = v; } }); });
  if (!isFinite(minVal)) {                     // nothing matched — fall back to static values
    const sv = geoItems.map(i => i.value).filter(v => typeof v === 'number');
    minVal = sv.length ? Math.min(...sv) : 0;
    maxVal = sv.length ? Math.max(...sv) : 1;
  }
  const itemsForPeriod = (idx: number) => geoItems.map((item, k) => {
    const arr = perItem[k];
    const v = (arr && typeof arr[idx] === 'number') ? arr[idx] : item.value;
    return Object.assign({}, item, { value: v });
  });
  return { periods, itemsForPeriod, minVal, maxVal };
}

// Bubble maps need point coordinates. Region items (states/counties/countries)
// arrive as names only, so place each bubble at its region's centroid (the
// bounding-box centre of the matched boundary). Mutates items in place — period
// items inherit it via buildPeriodGeo's per-item spread. No-op for items that
// already carry lat/lng (point data) or regions with no matched boundary.
function fillCentroidsFromBoundaries(items: any[], geoData: any): void {
  if (!geoData || !Array.isArray(geoData.features)) return;
  geoData.features.forEach((feat: any) => {
    const item = matchGeoItem(items, (feat && feat.properties) || {});
    if (!item || (typeof item.lat === 'number' && typeof item.lng === 'number')) return;
    const bb = _geoBBox(feat && feat.geometry);
    if (!bb) return;
    const c = _bboxCenter(bb);
    item.lat = c.lat;
    item.lng = c.lng;
  });
}

// Create the MapLibre map. The style is an inline object over the three CSP-allowed
// OSM raster hosts — no style URL, no glyphs, no sprite, so no extra network host.
function _createMap(mapDiv: HTMLElement): any {
  const mlgl = _mlgl();
  const map = new mlgl.Map({
    container: mapDiv,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: OSM_TILE_URLS.slice(),
          tileSize: 256,
          maxzoom: 19,
          attribution: OSM_ATTRIBUTION,
        },
      },
      layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm' }],
    },
    center: [0, 20],
    zoom: 1,
    maxZoom: 18,
    // Canvas → PNG export reads the WebGL buffer after the frame is drawn.
    preserveDrawingBuffer: true,
    fadeDuration: 0,          // no cross-fade — deterministic pixels for export
    // Leaflet had no rotate/pitch; keep the map north-up so exports look the same.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  try { map.touchZoomRotate.disableRotation(); } catch (_) {}
  try { map.addControl(new mlgl.NavigationControl({ showCompass: false }), 'top-left'); } catch (_) {}
  return map;
}

// Resolve once the style + first tiles are up (or after a hard timeout, so a
// wedged GL context can't hang the export path forever).
function _whenMapLoaded(map: any, timeoutMs: number = 10000): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    try {
      if (map.loaded()) return finish();
      map.once('load', finish);
    } catch (_) { finish(); }
  });
}

// Hover tooltip for a data layer. MapLibre has no bindTooltip; one shared Popup
// that follows the cursor reproduces Leaflet's `sticky: true` behaviour.
function _attachHoverPopup(map: any, layerId: string, htmlFor: (props: any) => string): void {
  const mlgl = _mlgl();
  const popup = new mlgl.Popup({
    closeButton: false, closeOnClick: false, className: 'cv-map-tooltip',
    offset: 12, maxWidth: '260px',
  });
  map.on('mousemove', layerId, (e: any) => {
    const feat = e.features && e.features[0];
    if (!feat) return;
    try { map.getCanvas().style.cursor = 'pointer'; } catch (_) {}
    popup.setLngLat(e.lngLat).setHTML(htmlFor(feat.properties || {})).addTo(map);
  });
  map.on('mouseleave', layerId, () => {
    try { map.getCanvas().style.cursor = ''; } catch (_) {}
    popup.remove();
  });
}

// A permanent "ABBR 1,234" label pinned at a point. MapLibre symbol layers can't
// draw text without a `glyphs` URL (a network fetch we refuse), so these are DOM
// markers — same as Leaflet's permanent tooltips were DOM nodes.
function _addValueLabelMarker(map: any, lng: number, lat: number, text: string): any {
  const el = document.createElement('div');
  el.className = 'cv-map-value-label';
  el.textContent = text;
  return new (_mlgl().Marker)({ element: el, anchor: 'center' })
    .setLngLat([lng, lat]).addTo(map);
}

async function renderMapInArea(container: HTMLElement, data: any, type: string): Promise<void> {
  // MapLibre (714K) + the bundled GeoJSON (212K) are fetched on first map, not
  // at hub open — see renderer/hub/lazyScript.ts. The bundle also carries
  // mapWorker.js, whose setWorkerUrl() must run after the UMD and before any
  // map is constructed, which the bundle's declared order guarantees.
  await ensureBundle('map');

  // Need MapLibre loaded and geo data on the result
  if (!_mlgl()) {
    container.innerHTML = '<div class="cv-chart-fallback">Map library not loaded.</div>';
    return;
  }
  const geo = data && data.geo;
  if (!geo || !Array.isArray(geo.items) || geo.items.length === 0) {
    container.innerHTML = '<div class="cv-chart-fallback">No geographic data available for this map.</div>';
    return;
  }

  // For a choropleth, resolve boundary data for the level before drawing anything.
  let geoData: any = null;
  if (type === 'map_choropleth') {
    geoData = await loadChoroplethData(geo.level);
    if (!geoData || !geoData.features || geoData.features.length === 0) {
      renderGeoFallback(container, data, "No map boundaries for this level — showing the data instead.");
      return;
    }
  }

  // Bubble maps need point coords; region data (names only) has none. Derive each
  // region's centroid from the level's boundaries so the bubbles have a home.
  if (type === 'map_bubble' && geo.items.some((i: any) => typeof i.lat !== 'number' || typeof i.lng !== 'number')) {
    const boundaries = await loadChoroplethData(geo.level);
    if (boundaries) fillCentroidsFromBoundaries(geo.items, boundaries);
  }

  // Build the map wrapper (positioned relative for the legend/note overlays)
  const wrap = document.createElement('div');
  wrap.className = 'cv-map-wrap';
  const mapDiv = document.createElement('div');
  mapDiv.className = 'cv-map-container';
  wrap.appendChild(mapDiv);
  container.appendChild(wrap);

  let map: any;
  try {
    // Note: tiles fetch from OpenStreetMap servers — the one planned external call for maps
    // TODO: replace with bundled/offline tiles for fully local operation
    map = _createMap(mapDiv);
  } catch (e) {
    wrap.remove();
    container.innerHTML = '<div class="cv-chart-fallback">This map needs WebGL, which isn\'t available here.</div>';
    return;
  }

  mapInstances.set(container, map);

  // Sources and layers can only be added once the (inline) style is up.
  await _whenMapLoaded(map);
  if (mapInstances.get(container) !== map) return;   // torn down while loading
  try { map.resize(); } catch (_) {}

  // Time-series maps: derive per-period region values from data.labels + data.series
  // (one series per period for a time_series shape), so the map can step through years.
  const isTimeSeries = data && data.dataShape === 'time_series'
    && Array.isArray(data.series) && data.series.length >= 2
    && Array.isArray(data.labels) && data.labels.length > 0;
  const periodInfo = isTimeSeries ? buildPeriodGeo(data.labels, data.series, geo.items) : null;

  if (type === 'map_bubble') {
    _renderBubbleMap(map, wrap, geo, periodInfo, data);
  } else if (type === 'map_choropleth') {
    const matched = _renderChoroplethMap(map, wrap, geo, geoData, periodInfo, data);
    if (matched === 0) {
      renderGeoFallback(container, data, "Couldn't place these regions on the map — showing the data instead.");
    }
  }
}

// ponytail: map/geo/periodInfo params are any — MapLibre is read off window as an
// untyped global, and geo items are part of the model's JSON envelope.
function _renderBubbleMap(map: any, wrap: HTMLElement, geo: any, periodInfo: any, data: any): void {
  const placeable = geo.items.filter((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number');
  const unplaceable = geo.items.filter((i: any) => typeof i.lat !== 'number' || typeof i.lng !== 'number');

  if (placeable.length === 0) {
    const fb = document.createElement('div');
    fb.className = 'cv-chart-fallback';
    fb.textContent = 'No lat/lng coordinates in geo data for bubble map.';
    wrap.appendChild(fb);
    return;
  }

  const usePeriods = !!(periodInfo && periodInfo.periods && periodInfo.periods.length >= 2);
  let minVal: number, maxVal: number;
  if (periodInfo) { minVal = periodInfo.minVal; maxVal = periodInfo.maxVal; }   // fixed global scale
  else { const vs = placeable.map((i: any) => i.value); minVal = Math.min(...vs); maxVal = Math.max(...vs); }
  const MAX_RADIUS = 30, MIN_RADIUS = 5;
  const accent = getCSSVar('--accent', wrap) || '#3b82f6';

  const SRC = 'cv-bubbles', LAYER = 'cv-bubbles-circles';

  let periodIdx = usePeriods ? periodInfo.periods.length - 1 : 0;   // latest period
  let valueMode = 'maxmin';   // default: label the highest & lowest region
  let labelMarkers: any[] = [];
  let didFit = false;

  const itemsNow = () => {
    const base = usePeriods ? periodInfo.itemsForPeriod(periodIdx) : geo.items;
    return base.filter((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number');
  };

  function drawCircles() {
    const items = itemsNow();
    let bbox: BBox | null = null;
    const features = items.map((item: any) => {
      const t = maxVal > minVal ? (item.value - minVal) / (maxVal - minVal) : 0.5;
      const radius = MIN_RADIUS + Math.max(0, Math.min(1, t)) * (MAX_RADIUS - MIN_RADIUS);
      bbox = _extendBBox(bbox, [item.lng, item.lat, item.lng, item.lat]);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
        properties: {
          __r: radius,
          __name: String(item.name == null ? '' : item.name),
          __val: typeof item.value === 'number' ? item.value : null,
        },
      };
    });
    const fc = { type: 'FeatureCollection', features };

    const existing = map.getSource(SRC);
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource(SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: LAYER, type: 'circle', source: SRC,
        paint: {
          'circle-radius': ['to-number', ['get', '__r'], MIN_RADIUS],
          'circle-color': accent,
          'circle-opacity': 0.55,
          'circle-stroke-color': accent,
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.8,
        },
      });
      _attachHoverPopup(map, LAYER, (p) => {
        const v = p.__val;
        return `<strong>${_escGeo(p.__name)}</strong><br>${typeof v === 'number' ? v.toLocaleString() : 'n/a'}`;
      });
    }

    if (!didFit && bbox) {
      didFit = true;
      _fitBBox(map, bbox, 20, 6);
    }
  }

  function rebuildLabels() {
    labelMarkers.forEach(m => { try { m.remove(); } catch (_) {} });
    labelMarkers = [];
    if (valueMode === 'off') return;
    const entries = itemsNow().filter((i: any) => typeof i.value === 'number');
    const keys = valueLabelKeys(valueMode, [entries.map((e: any) => e.value)]);
    entries.forEach((item: any, i: number) => {
      if (!keys.has('0:' + i)) return;
      labelMarkers.push(_addValueLabelMarker(map, item.lng, item.lat,
        `${abbrevFor(item, {}, geo.level)} ${_fmtVal(item.value)}`));
    });
  }

  drawCircles();
  _addUnmatchedNote(wrap, unplaceable.map((i: any) => i.name));
  _addBubbleLegend(wrap, minVal, maxVal, accent, MIN_RADIUS, MAX_RADIUS);
  const controls = document.createElement('div');
  controls.className = 'cv-graph-controls';
  wrap.appendChild(controls);
  _addMapValuesMenu(controls, () => valueMode, (mode) => { valueMode = mode; rebuildLabels(); });
  if (usePeriods) {
    _addMapPeriodDropdown(controls, periodInfo.periods, periodIdx, (idx) => { periodIdx = idx; drawCircles(); rebuildLabels(); });
  }
  _addMapMenuButton(controls, data);
  rebuildLabels();   // show the default min/max labels on load
}

// Draws the choropleth into `map` using the supplied boundary `geoData`.
// With periodInfo, adds a year dropdown (fixed global color scale) so the map can step
// through periods. Returns the number of matched regions (0 → caller triggers fallback).
//
// Colors are computed per feature in JS (so getChoroplethColor stays the single source
// of truth, theme interpolation and all) and stamped onto a copy of each feature's
// properties; the paint expressions just read them back.
function _renderChoroplethMap(map: any, wrap: HTMLElement, geo: any, geoData: any, periodInfo: any, data: any): number {
  const usePeriods = !!(periodInfo && periodInfo.periods && periodInfo.periods.length >= 2);
  let minVal: number, maxVal: number;
  if (periodInfo) { minVal = periodInfo.minVal; maxVal = periodInfo.maxVal; }   // fixed global scale
  else {
    const vs = geo.items.map((i: any) => i.value).filter((v: any) => typeof v === 'number');
    minVal = vs.length ? Math.min(...vs) : 0;
    maxVal = vs.length ? Math.max(...vs) : 1;
  }

  const noData = getCSSVar('--surface-3', wrap) || '#e5e7eb';
  const noDataBorder = getCSSVar('--border-2', wrap) || '#d1d5db';
  const borderColor = getCSSVar('--border', wrap) || '#e5e7eb';

  const SRC = 'cv-choropleth', FILL = 'cv-choropleth-fill', LINE = 'cv-choropleth-line';

  let periodIdx = usePeriods ? periodInfo.periods.length - 1 : 0;   // latest period
  let valueMode = 'maxmin';   // default: label the highest & lowest region
  let labelMarkers: any[] = [];
  // Label anchors for the current period, in feature order (Leaflet used the layer
  // order of the GeoJSON layer — same thing, so valueLabelKeys indices line up).
  let labelEntries: Array<{ lng: number; lat: number; text: string; value: number }> = [];
  let matchedCount = 0, didFit = false;

  const itemsNow = () => usePeriods ? periodInfo.itemsForPeriod(periodIdx) : geo.items;

  function drawData(): Set<string> {
    const items = itemsNow();
    const matchedNames = new Set<string>();
    let matchedBBox: BBox | null = null;
    let allBBox: BBox | null = null;
    labelEntries = [];

    const features = geoData.features.map((feat: any) => {
      const props = (feat && feat.properties) || {};
      const item = matchGeoItem(items, props);
      const hasValue = !!(item && typeof item.value === 'number');
      const bb = _geoBBox(feat && feat.geometry);
      allBBox = _extendBBox(allBBox, bb);
      let color = noData;
      if (hasValue) {
        const t = maxVal > minVal ? (item.value - minVal) / (maxVal - minVal) : 0.5;
        color = getChoroplethColor(t, wrap);
      }
      if (item) {
        matchedNames.add(normalizeName(item.name));
        matchedBBox = _extendBBox(matchedBBox, bb);
      }
      if (hasValue && bb) {
        const c = _bboxCenter(bb);
        labelEntries.push({
          lng: c.lng, lat: c.lat, value: item.value,
          text: `${abbrevFor(item, props, geo.level)} ${_fmtVal(item.value)}`,
        });
      }
      return {
        type: 'Feature',
        geometry: feat.geometry,
        properties: Object.assign({}, props, {
          __color: color,
          __has: hasValue,
          __matched: !!item,
          __name: String(props.name || ''),
          __val: hasValue ? item.value : null,
        }),
      };
    });
    const fc = { type: 'FeatureCollection', features };

    const existing = map.getSource(SRC);
    if (existing) {
      existing.setData(fc);
    } else {
      map.addSource(SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: FILL, type: 'fill', source: SRC,
        paint: {
          'fill-color': ['to-color', ['get', '__color'], noData],
          'fill-opacity': ['case', ['to-boolean', ['get', '__has']], 0.75, 0.4],
        },
      });
      map.addLayer({
        id: LINE, type: 'line', source: SRC,
        paint: {
          'line-color': ['case', ['to-boolean', ['get', '__has']], borderColor, noDataBorder],
          'line-width': ['case', ['to-boolean', ['get', '__has']], 0.5, 0.4],
        },
      });
      _attachHoverPopup(map, FILL, (p) => {
        const head = `<strong>${_escGeo(p.__name)}</strong><br>`;
        if (!p.__matched) return head + '<span class="cv-map-tt-muted">No data</span>';
        return head + (typeof p.__val === 'number' ? p.__val.toLocaleString() : 'n/a');
      });
    }
    matchedCount = matchedNames.size;

    if (!didFit) {   // fit once; keep the user's zoom when switching periods
      didFit = true;
      if (matchedBBox) {
        _fitBBox(map, matchedBBox, 12, 8);
      } else if (geo.level === 'us_state' || geo.level === 'us_county') {
        try { map.jumpTo({ center: [-95, 39], zoom: 4 }); } catch (_) {}
      } else if (allBBox) {
        _fitBBox(map, allBBox, 8, 5);
      }
    }
    return matchedNames;
  }

  // Permanent ABBR + value labels at each region centroid (DOM markers, so they never
  // collide with the per-region hover popup bound to the fill layer).
  function rebuildLabels() {
    labelMarkers.forEach(m => { try { m.remove(); } catch (_) {} });
    labelMarkers = [];
    if (valueMode === 'off') return;
    const keys = valueLabelKeys(valueMode, [labelEntries.map(e => e.value)]);
    labelEntries.forEach((e, i) => {
      if (!keys.has('0:' + i)) return;
      labelMarkers.push(_addValueLabelMarker(map, e.lng, e.lat, e.text));
    });
  }

  const matchedNames = drawData();

  const unmatchedNames = geo.items
    .filter((item: any) => !matchedNames.has(normalizeName(item.name)))
    .map((item: any) => item.name);
  _addUnmatchedNote(wrap, unmatchedNames);
  _addChoroplethLegend(wrap, minVal, maxVal);

  const controls = document.createElement('div');
  controls.className = 'cv-graph-controls';
  wrap.appendChild(controls);
  _addMapValuesMenu(controls, () => valueMode, (mode) => { valueMode = mode; rebuildLabels(); });
  if (usePeriods) {
    _addMapPeriodDropdown(controls, periodInfo.periods, periodIdx, (idx) => { periodIdx = idx; drawData(); rebuildLabels(); });
  }
  _addMapMenuButton(controls, data);
  rebuildLabels();   // show the default min/max labels on load

  return matchedCount;
}

function _addUnmatchedNote(wrap: HTMLElement, names: string[]): void {
  if (!names || names.length === 0) return;
  const note = document.createElement('div');
  note.className = 'cv-map-unmatched';
  note.title = 'Couldn\'t place: ' + names.join(', ');
  note.textContent = 'Couldn\'t place: ' + names.join(', ');
  wrap.appendChild(note);
}

// Top-center period dropdown for time-series maps. onChange(idx) recolors in place.
// (No Leaflet DomEvent guards needed — the controls are siblings of the map
// container, not children of it, so MapLibre never sees their events.)
function _addMapPeriodDropdown(wrap: HTMLElement, periods: string[], defaultIdx: number, onChange: (idx: number) => void): void {
  const box = document.createElement('div');
  box.className = 'cv-map-period';
  const select = document.createElement('select');
  select.className = 'cv-map-period-select';
  select.setAttribute('aria-label', 'Select period');
  periods.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p || ('Period ' + (i + 1));
    if (i === defaultIdx) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => onChange(parseInt(select.value, 10) || 0));
  box.appendChild(select);
  wrap.appendChild(box);
}

// Values ▾ menu for maps (same modes as charts). getMode()/onPick(mode) drive a single
// "series" = the selected period's region values, so Max/Min label the top/bottom region.
function _addMapValuesMenu(parent: HTMLElement, getMode: () => string, onPick: (mode: string) => void): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cv-values-btn';
  btn.textContent = 'Values ▾';
  btn.setAttribute('aria-label', 'Value labels');
  const sync = () => btn.classList.toggle('active', getMode() !== 'off');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openValuesMenu(btn, getMode(), (mode) => { onPick(mode); sync(); });
  });
  parent.appendChild(btn);
  sync();
}

// Minimal ⋯ menu for maps — just Copy data (maps have no PNG/axis/color options).
function _addMapMenuButton(parent: HTMLElement, data: any): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cv-chart-menu-btn';
  btn.setAttribute('aria-label', 'Map options');
  btn.textContent = '⋯';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(btn, (el, close) => {
      const sec = document.createElement('div');
      sec.className = 'chart-menu-section';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chart-menu-item';
      row.textContent = 'Copy data';
      row.addEventListener('click', () => {
        close();
        if (window.hub) { window.hub.copyText(dataToTSV(data)); showToast('Data copied to clipboard'); }
      });
      sec.appendChild(row);
      el.appendChild(sec);
    });
  });
  parent.appendChild(btn);
}

function _addBubbleLegend(wrap: HTMLElement, minVal: number, maxVal: number, color: string, minR: number, maxR: number): void {
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend';

  const title = document.createElement('div');
  title.className = 'cv-map-legend-title';
  title.textContent = 'Size = value';
  leg.appendChild(title);

  [[minR, minVal], [maxR, maxVal]].forEach(([r, v]) => {
    const row = document.createElement('div');
    row.className = 'cv-map-legend-row';
    const sw = document.createElement('span');
    sw.className = 'cv-map-legend-bubble';
    sw.dataset.r = String(r);  // used in CSS via --r custom prop
    // Build a small inline SVG circle — avoids inline style
    sw.innerHTML = `<svg width="${r*2+2}" height="${r*2+2}" viewBox="0 0 ${r*2+2} ${r*2+2}" aria-hidden="true">` +
      `<circle cx="${r+1}" cy="${r+1}" r="${r}" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-width="1.5"/>` +
      `</svg>`;
    const label = document.createElement('span');
    label.textContent = _fmtVal(v);
    row.appendChild(sw);
    row.appendChild(label);
    leg.appendChild(row);
  });

  wrap.appendChild(leg);
}

function _addChoroplethLegend(wrap: HTMLElement, minVal: number, maxVal: number): void {
  const stops = isDarkSurface(wrap) ? CHOROPLETH_STOPS_DARK : CHOROPLETH_STOPS_LIGHT;
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend';

  const title = document.createElement('div');
  title.className = 'cv-map-legend-title';
  title.textContent = 'Value';
  leg.appendChild(title);

  // Gradient bar as inline SVG — no inline CSS needed
  const barW = 96, barH = 8;
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('width', String(barW));
  svgEl.setAttribute('height', String(barH));
  svgEl.setAttribute('viewBox', `0 0 ${barW} ${barH}`);
  svgEl.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.id = 'cv-choro-grad-' + (Math.random() * 1e6 | 0);
  grad.setAttribute('x1', '0%');  grad.setAttribute('x2', '100%');
  grad.setAttribute('y1', '0%');  grad.setAttribute('y2', '0%');
  stops.forEach((c, i) => {
    const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop.setAttribute('offset', (i / (stops.length - 1) * 100) + '%');
    stop.setAttribute('stop-color', c);
    grad.appendChild(stop);
  });
  defs.appendChild(grad);
  svgEl.appendChild(defs);
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '0');  rect.setAttribute('y', '0');
  rect.setAttribute('width', String(barW));  rect.setAttribute('height', String(barH));
  rect.setAttribute('rx', '4');
  rect.setAttribute('fill', `url(#${grad.id})`);
  svgEl.appendChild(rect);
  leg.appendChild(svgEl);

  const labels = document.createElement('div');
  labels.className = 'cv-map-legend-range';
  const lo = document.createElement('span');  lo.textContent = _fmtVal(minVal);
  const hi = document.createElement('span');  hi.textContent = _fmtVal(maxVal);
  labels.appendChild(lo);
  labels.appendChild(hi);
  leg.appendChild(labels);

  wrap.appendChild(leg);
}
