// MapLibre GL, loaded on first use, and the few things every map kind does
// with it. Port of mapRender.ts's map half + mapWorker.ts + mapBasemap.ts.
//
// CSP. The `-csp` build keeps its worker as a separate file instead of a blob:
// URL, so the page needs no `worker-src blob:` and no 'unsafe-eval'; Vite emits
// that file into assets/ (same origin, so `script-src 'self'` covers the
// worker) and setWorkerUrl() is told where, before any map exists.
//
// PRIVACY INVARIANT: the only external host a map may contact is OpenStreetMap's
// tile servers below — the one declared external fetch, and the only http(s)
// host in the web CSP (web/vite.config.ts). The style is an INLINE object with
// no `glyphs` and no `sprite` (each would add a host), which is why value labels
// and cluster counts are DOM markers, never a symbol layer. Never add a style
// URL, a vector source or a demo tile server.

import type * as ML from 'maplibre-gl';
import type { BBox } from './types';

export type MapLibre = typeof ML;
export type MlMap = ML.Map;

export const OSM_TILE_URLS = [
  'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
];
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

let lib: Promise<MapLibre> | null = null;

/** The library, once per page (≈730 KB + its 350 KB worker, fetched only when a map is first shown). */
export function loadMapLibre(): Promise<MapLibre> {
  lib ??= (async () => {
    const [mod, worker] = await Promise.all([
      import('maplibre-gl/dist/maplibre-gl-csp.js'),
      import('maplibre-gl/dist/maplibre-gl-csp-worker.js?url'),
    ]);
    // A UMD bundle: Vite hands its `exports` object over as the default.
    const ml = ((mod as { default?: MapLibre }).default ?? mod) as MapLibre;
    ml.setWorkerUrl(worker.default);
    return ml;
  })().catch((err: unknown) => {
    lib = null;
    throw err;
  });
  return lib;
}

/** WebGL2, which MapLibre 4 needs — false in a browser or sandbox without it. */
export function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/** OSM raster tiles, or (`water`) the offline basemap: a flat water fill, land added after load. */
function styleFor(water: string | null): ML.StyleSpecification {
  if (water !== null) return { version: 8, sources: {}, layers: [{ id: 'cv-water', type: 'background', paint: { 'background-color': water } }] };
  return {
    version: 8,
    sources: { osm: { type: 'raster', tiles: OSM_TILE_URLS.slice(), tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION } },
    layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm' }],
  };
}

/** A north-up map (no rotate or pitch — the desktop's Leaflet heritage, and stable exports). */
export function createMap(ml: MapLibre, container: HTMLElement, offlineWater: string | null): MlMap {
  const map = new ml.Map({
    container,
    style: styleFor(offlineWater),
    center: [0, 20],
    zoom: 1,
    maxZoom: 18,
    // Canvas → PNG export reads the WebGL buffer after the frame is drawn.
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
  return map;
}

/** Resolves once the inline style is up (or after a timeout, so a wedged GL context cannot hang a render). */
export function whenLoaded(map: MlMap, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    if (map.loaded()) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    void map.once('load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** fitBounds without animation — deterministic pixels for an export. */
export function fitBBox(map: MlMap, bbox: BBox, padding: number, maxZoom: number): void {
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding, maxZoom, animate: false, duration: 0 },
  );
}

/** Land and borders for the offline basemap, beneath everything the data adds. */
export function addOfflineLand(map: MlMap, world: unknown, fill: string, line: string): void {
  if (!world || map.getSource('cv-land')) return;
  map.addSource('cv-land', { type: 'geojson', data: world as GeoJSON.FeatureCollection });
  map.addLayer({ id: 'cv-land-fill', type: 'fill', source: 'cv-land', paint: { 'fill-color': fill } });
  map.addLayer({ id: 'cv-land-line', type: 'line', source: 'cv-land', paint: { 'line-color': line, 'line-width': 0.6 } });
}

/** A tooltip's content as DOM — a bold head, then lines; a muted line is [text, true]. Text only, never markup. */
export function tipContent(head: string, lines: ReadonlyArray<string | [string, true]>): HTMLElement {
  const box = document.createElement('div');
  if (head) {
    const strong = document.createElement('strong');
    strong.textContent = head;
    box.append(strong);
  }
  for (const l of lines) {
    if (box.childNodes.length) box.append(document.createElement('br'));
    if (typeof l === 'string') box.append(l);
    else {
      const span = document.createElement('span');
      span.className = 'cv-map-tt-muted';
      span.textContent = l[0];
      box.append(span);
    }
  }
  return box;
}

/** A hover tooltip that follows the cursor over one layer (Leaflet's `sticky: true`). */
export function hoverPopup(ml: MapLibre, map: MlMap, layerId: string, content: (props: Record<string, unknown>) => HTMLElement): void {
  const popup = new ml.Popup({ closeButton: false, closeOnClick: false, className: 'cv-map-tooltip', offset: 12, maxWidth: '260px' });
  map.on('mousemove', layerId, (e) => {
    const feat = e.features && e.features[0];
    if (!feat) return;
    map.getCanvas().style.cursor = 'pointer';
    popup
      .setLngLat(e.lngLat)
      .setDOMContent(content((feat.properties || {}) as Record<string, unknown>))
      .addTo(map);
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
}

/** A permanent "CA 1.2M" label at a point — a DOM marker (symbol text would need a glyphs URL). */
export function valueMarker(ml: MapLibre, map: MlMap, lng: number, lat: number, text: string): ML.Marker {
  const el = document.createElement('div');
  el.className = 'cv-map-value-label';
  el.textContent = text;
  return new ml.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
}

/** The theme token `name` as resolved ON `el` (a dashboard preset can remap tokens on a container). */
export function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}
