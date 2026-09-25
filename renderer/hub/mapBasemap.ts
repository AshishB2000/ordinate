// The map BASEMAP: OSM raster tiles, or none — a flat land/water fill drawn
// from the bundled world GeoJSON, with no network at all. Classic global-scope
// renderer <script>; mapRender.ts calls these at render time.
//
// "none" is the default in EXPORTS (a capture container), so a PDF or PNG of a
// map never waits on — or silently lacks — tiles, and never makes the one
// external request the privacy notice allows. A visual that chose OSM
// explicitly keeps it.

function mapBasemapFor(geo: any, container: HTMLElement): 'osm' | 'none' {
  if (geo && (geo.basemap === 'osm' || geo.basemap === 'none')) return geo.basemap;
  return container.closest('.export-map-capture') ? 'none' : 'osm';
}

/** The inline style for a basemap. OSM's is mapRender's own; "none" is water, with land added on load. */
function mapStyleFor(basemap: 'osm' | 'none', wrap: HTMLElement): any {
  if (basemap === 'osm') return null;
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'cv-water', type: 'background', paint: { 'background-color': getCSSVar('--inset', wrap) || '#eef1f5' } }],
  };
}

/** Land and borders for the "none" basemap, beneath everything the data adds. */
function mapAddOfflineLand(map: any, wrap: HTMLElement): void {
  const world = (window as any).__GEO_WORLD__;
  if (!world || map.getSource('cv-land')) return;
  try {
    map.addSource('cv-land', { type: 'geojson', data: world });
    map.addLayer({ id: 'cv-land-fill', type: 'fill', source: 'cv-land', paint: { 'fill-color': getCSSVar('--surface', wrap) || '#ffffff' } });
    map.addLayer({ id: 'cv-land-line', type: 'line', source: 'cv-land', paint: { 'line-color': getCSSVar('--border-2', wrap) || '#d6dae1', 'line-width': 0.6 } });
    wrap.dataset.basemap = 'none';
  } catch (_) { /* a style still loading — the data layers draw either way */ }
}

/** A custom boundary set for a choropleth: fetched from the project, `name` set from the join property. */
async function mapCustomBoundary(geo: any): Promise<any> {
  if (!geo || !geo.boundaryId || !currentProjectId) return null;
  const res = await window.hub.getBoundary(currentProjectId, geo.boundaryId, geo.property).catch(() => null);
  return res && res.ok ? res.collection : null;
}

/**
 * A click on a map mark means what a click on a bar means: the value, as a
 * `cv-mark-click` on the viz area, which a dashboard tile turns into an action
 * or a selection (tileActions.ts). A builder has no listener, so it is a no-op there.
 */
function mapMarkClick(container: HTMLElement, column: unknown, category: unknown): void {
  if (category === undefined || category === null || category === '') return;
  container.dispatchEvent(new CustomEvent('cv-mark-click', { bubbles: false, detail: { category, column } }));
}
