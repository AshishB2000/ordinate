// HEXBIN MAPS — density in hexagons, drawn from what MAIN computed
// (src/analysis/geo/geoAgg.ts via visual:data): every level of the fixed hex
// grid at once, each hexagon with its count, sum or average and its six corners.
// Classic global-scope renderer <script>, called from mapRender.renderMapInArea.
//
// ZOOM. The reply carries the levels; this file only chooses one — the finest
// level drawn at or below the map's zoom + 1 — and swaps the source's data when
// a zoom crosses into another bucket (debounced, so a pinch does not rebuild
// the layer twelve times). Nothing is recomputed here, and the same payload
// drawn in an export or a published page shows the same hexagons at the same
// zoom. Levels main left out (over its hexagon cap) fall back to the finest one
// kept, and the note says so.
//
// Colour is the choropleth's sequential ramp over the level's own min..max, so
// a zoomed-in city is not washed out by the coarse level's totals.

const HEX_SRC = 'cv-hex';
const HEX_FILL = 'cv-hex-fill';
const HEX_LINE = 'cv-hex-line';

/** The level to draw at `zoom`: the finest whose drawing zoom is ≤ zoom + 1, else the coarsest. */
function hexLevelFor(levels: any[], zoom: number): any {
  let pick = levels[0] || null;
  for (const l of levels) if (l.zoom <= zoom + 1 && (!pick || l.zoom > pick.zoom)) pick = l;
  return pick;
}

function hexFeatures(level: any, wrap: HTMLElement): { fc: any; min: number; max: number } {
  const vals = level.hexes.map((h: any) => h.value).filter((v: any) => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const none = getCSSVar('--surface-3', wrap) || '#e5e7eb';
  const features = level.hexes.map((h: any) => {
    const ring: number[][] = [];
    for (let i = 0; i < h.ring.length; i += 2) ring.push([h.ring[i], h.ring[i + 1]]);
    ring.push(ring[0]);
    const has = typeof h.value === 'number';
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        __id: h.id, __n: h.n, __val: has ? h.value : null,
        __color: has ? getChoroplethColor(max > min ? (h.value - min) / (max - min) : 0.5, wrap) : none,
      },
    };
  });
  return { fc: { type: 'FeatureCollection', features }, min, max };
}

function renderHexbinMap(map: any, wrap: HTMLElement, geo: any, data: any): void {
  const hex = geo.hex;
  const levels: any[] = Array.isArray(hex.levels) ? hex.levels.filter((l: any) => l && Array.isArray(l.hexes)) : [];
  wrap.classList.add('geo-map');
  if (!hex.points || !levels.length) {
    geoMapEmpty(wrap, hex.skipped
      ? t('mapHexbin.none_of_the_rows_has_a', { p0: hex.skipped.toLocaleString() })
      : t('mapHexbin.no_rows_to_place_on_the'));
    return;
  }
  const notes = geoMapNotes(wrap);
  let current: any = null;
  let legend: HTMLElement | null = null;

  const draw = (level: any): void => {
    current = level;
    const { fc, min, max } = hexFeatures(level, wrap);
    const src = map.getSource(HEX_SRC);
    if (src) src.setData(fc);
    else {
      map.addSource(HEX_SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: HEX_FILL, type: 'fill', source: HEX_SRC,
        paint: { 'fill-color': ['to-color', ['get', '__color'], '#8aaedd'], 'fill-opacity': 0.78 },
      });
      map.addLayer({
        id: HEX_LINE, type: 'line', source: HEX_SRC,
        paint: { 'line-color': getCSSVar('--surface', wrap) || '#ffffff', 'line-width': 0.6, 'line-opacity': 0.8 },
      });
      _attachHoverPopup(map, HEX_FILL, (p) => {
        const v = p.__val === null || p.__val === undefined || p.__val === 'null' ? t('common.no_data') : _fmtVal(Number(p.__val));
        return `<strong>${_escGeo(hex.label)}: ${_escGeo(v)}</strong><br><span class="cv-map-tt-muted">${Number(p.__n).toLocaleString()} point${Number(p.__n) === 1 ? '' : 's'} in this hexagon</span>`;
      });
    }
    if (legend) legend.remove();
    _addChoroplethLegend(wrap, min, max); // mapOverlays.ts
    legend = wrap.lastElementChild as HTMLElement;
    const title = legend && legend.querySelector('.cv-map-legend-title');
    if (title) title.textContent = hex.label;
    const idx = levels.indexOf(level);
    notes.info.textContent = t('mapHexbin.points_hexagons_level_of', { p0: hex.points.toLocaleString(), p1: level.hexes.length.toLocaleString(), p2: level.res + 1, p3: levels.length + hex.dropped.length });
    // Read by the smoke and by the map's accessible description.
    wrap.dataset.hexes = String(level.hexes.length);
    wrap.dataset.hexRes = String(level.res);
    const capped = hex.dropped.length && idx === levels.length - 1 && map.getZoom() + 1 > level.zoom + 2;
    const parts: string[] = [];
    if (hex.skipped) parts.push(t('mapHexbin.rows_had_no_usable_coordinates', { p0: hex.skipped.toLocaleString() }));
    if (capped) parts.push(t('mapHexbin.finer_levels_exceed_hexagons_this_is', { p0: hex.maxHexes.toLocaleString() }));
    notes.warn.textContent = parts.join(' · ');
    notes.warn.hidden = parts.length === 0;
  };

  // Fit the points (the hexagons of the coarsest level cover them), then draw.
  let bbox: BBox | null = null;
  for (const h of levels[0].hexes) bbox = _extendBBox(bbox, [h.lng, h.lat, h.lng, h.lat]);
  if (bbox) _fitBBox(map, bbox, 32, 12);
  draw(hexLevelFor(levels, map.getZoom()));

  let timer: number | null = null;
  map.on('zoomend', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const next = hexLevelFor(levels, map.getZoom());
      if (next && next !== current) draw(next);
    }, 120);
  });

  const controls = document.createElement('div');
  controls.className = 'cv-graph-controls';
  wrap.appendChild(controls);
  _addMapMenuButton(controls, geoMapTable(data, 'hexbin'));
}

// ── Shared by the hexbin and flow maps ───────────────────────────────────────

/** The bottom-left note pair: an info line, and a warning line shown only when it has something. */
function geoMapNotes(wrap: HTMLElement): { info: HTMLElement; warn: HTMLElement } {
  const box = document.createElement('div');
  box.className = 'geo-map-notes';
  const info = document.createElement('div');
  info.className = 'geo-map-note';
  const warn = document.createElement('div');
  warn.className = 'geo-map-note geo-map-note--warn';
  warn.hidden = true;
  box.append(info, warn);
  wrap.appendChild(box);
  return { info, warn };
}

/** The designed empty state over the (still drawn) basemap. */
function geoMapEmpty(wrap: HTMLElement, text: string): void {
  const box = document.createElement('div');
  box.className = 'geo-map-empty';
  box.appendChild(icon('map-pin', 20));
  const t = document.createElement('span');
  t.textContent = text;
  box.appendChild(t);
  wrap.appendChild(box);
}

/**
 * The ⋯ menu's "Copy data" as a TABLE — the level on screen's hexagons, or the
 * routes — built from the reply's own figures (dataToTSV reads labels/series).
 */
function geoMapTable(data: any, kind: 'hexbin' | 'flow'): any {
  const geo = data && data.geo;
  if (kind === 'flow') {
    const flows = (geo && geo.flow && geo.flow.flows) || [];
    return { labels: flows.map((f: any) => f.name), series: [{ name: geo.flow.label, values: flows.map((f: any) => f.value) }] };
  }
  const items = (geo && geo.items) || [];
  return { labels: items.map((i: any) => i.name), series: [{ name: geo.hex.label, values: items.map((i: any) => i.value) }] };
}
