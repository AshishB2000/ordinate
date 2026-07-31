// Map rendering (Leaflet) — bubble + choropleth maps, geo period building,
// the map period/values menus, and legends. Extracted from hub.js as a pure
// structural move (no logic changes). Classic script sharing global scope:
// window.L, geoMatch.js helpers, window.hub.loadGeo, and hub.js's _fmtVal /
// getCSSVar / buildChart all resolve at call time.

// ── Map rendering (Leaflet) ─────────────────────────────────────────────────

// Sequential choropleth palette: 5 stops from surface-2 → accent
const CHOROPLETH_STOPS_LIGHT = ['#d6e4f5', '#8aaedd', '#5279bb', '#3d6bc9', '#2d529e'];
const CHOROPLETH_STOPS_DARK  = ['#1a3366', '#1d44b0', '#3d6bc9', '#5278cf', '#8aaedd'];

function getChoroplethColor(t: number): string {
  const stops = document.documentElement.dataset.theme === 'dark'
    ? CHOROPLETH_STOPS_DARK : CHOROPLETH_STOPS_LIGHT;
  const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(stops.length - 1, lo + 1);
  const frac = scaled - lo;
  if (frac === 0) return stops[lo];
  // Interpolate hex colors
  const parse = (hex: string) => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const [r1,g1,b1] = parse(stops[lo]);
  const [r2,g2,b2] = parse(stops[hi]);
  const r = Math.round(r1 + frac*(r2-r1));
  const g = Math.round(g1 + frac*(g2-g1));
  const b = Math.round(b1 + frac*(b2-b1));
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

// normalizeName + matchGeoItem are provided as globals by geoMatch.js, loaded
// before this script (and require()'d directly by the Node self-check).

function destroyMapInContainer(container: HTMLElement): void {
  const old = mapInstances.get(container);
  if (old) { try { old.remove(); } catch (_) {} mapInstances.delete(container); }
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
    try {
      const c = L.geoJSON(feat).getBounds().getCenter();
      item.lat = c.lat;
      item.lng = c.lng;
    } catch (_) {}
  });
}

async function renderMapInArea(container: HTMLElement, data: any, type: string): Promise<void> {
  // Need Leaflet loaded and geo data on the result
  if (typeof L === 'undefined') {
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

  const map = L.map(mapDiv, {
    zoomControl: true,
    attributionControl: true,
    // Note: tiles fetch from OpenStreetMap servers — the one planned external call for maps
  });

  // TODO: replace with bundled/offline tiles for fully local operation
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  }).addTo(map);

  mapInstances.set(container, map);

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

// ponytail: map/geo/periodInfo params are any — Leaflet is untyped (see globals.d.ts)
// and geo items are part of the model's JSON envelope.
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
  const accent = getCSSVar('--accent') || '#3b82f6';

  let periodIdx = usePeriods ? periodInfo.periods.length - 1 : 0;   // latest period
  let valueMode = 'maxmin';   // default: label the highest & lowest region
  let circleLayer: any = null, labelLayer: any = null, didFit = false;

  const itemsNow = () => {
    const base = usePeriods ? periodInfo.itemsForPeriod(periodIdx) : geo.items;
    return base.filter((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number');
  };

  function drawCircles() {
    if (circleLayer) { map.removeLayer(circleLayer); }
    const lg = L.layerGroup();
    const bounds: Array<[number, number]> = [];
    itemsNow().forEach((item: any) => {
      const t = maxVal > minVal ? (item.value - minVal) / (maxVal - minVal) : 0.5;
      const radius = MIN_RADIUS + Math.max(0, Math.min(1, t)) * (MAX_RADIUS - MIN_RADIUS);
      const circle = L.circleMarker([item.lat, item.lng], {
        radius, color: accent, fillColor: accent, fillOpacity: 0.55, weight: 1.5, opacity: 0.8,
      });
      circle.bindTooltip(`<strong>${item.name}</strong><br>${typeof item.value === 'number' ? item.value.toLocaleString() : 'n/a'}`,
        { direction: 'top', sticky: true });
      circle.addTo(lg);
      bounds.push([item.lat, item.lng]);
    });
    circleLayer = lg.addTo(map);
    if (!didFit && bounds.length) {
      didFit = true;
      try { map.fitBounds(L.latLngBounds(bounds), { padding: [20, 20], maxZoom: 6 }); } catch (_) {}
    }
  }

  function rebuildLabels() {
    if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
    if (valueMode === 'off') return;
    const entries = itemsNow().filter((i: any) => typeof i.value === 'number');
    const keys = valueLabelKeys(valueMode, [entries.map((e: any) => e.value)]);
    const lg = L.layerGroup();
    entries.forEach((item: any, i: number) => {
      if (!keys.has('0:' + i)) return;
      L.tooltip({ permanent: true, direction: 'center', className: 'cv-map-value-label', interactive: false })
        .setLatLng([item.lat, item.lng]).setContent(`${abbrevFor(item, {}, geo.level)} ${_fmtVal(item.value)}`).addTo(lg);
    });
    labelLayer = lg.addTo(map);
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
function _renderChoroplethMap(map: any, wrap: HTMLElement, geo: any, geoData: any, periodInfo: any, data: any): number {
  const usePeriods = !!(periodInfo && periodInfo.periods && periodInfo.periods.length >= 2);
  let minVal: number, maxVal: number;
  if (periodInfo) { minVal = periodInfo.minVal; maxVal = periodInfo.maxVal; }   // fixed global scale
  else {
    const vs = geo.items.map((i: any) => i.value).filter((v: any) => typeof v === 'number');
    minVal = vs.length ? Math.min(...vs) : 0;
    maxVal = vs.length ? Math.max(...vs) : 1;
  }

  const noData = getCSSVar('--surface-3') || '#e5e7eb';
  const noDataBorder = getCSSVar('--border-2') || '#d1d5db';
  const borderColor = getCSSVar('--border') || '#e5e7eb';

  let periodIdx = usePeriods ? periodInfo.periods.length - 1 : 0;   // latest period
  let valueMode = 'maxmin';   // default: label the highest & lowest region
  let dataLayer: any = null, labelLayer: any = null, matchedCount = 0, didFit = false;

  const itemsNow = () => usePeriods ? periodInfo.itemsForPeriod(periodIdx) : geo.items;

  function drawData() {
    if (dataLayer) { map.removeLayer(dataLayer); }
    const items = itemsNow();
    const matchedNames = new Set<string>();
    const matchedBounds: any[] = [];
    dataLayer = L.geoJSON(geoData, {
      style: (feat: any) => {
        const item = matchGeoItem(items, feat.properties);
        if (item && typeof item.value === 'number') {
          const t = maxVal > minVal ? (item.value - minVal) / (maxVal - minVal) : 0.5;
          return { fillColor: getChoroplethColor(t), fillOpacity: 0.75, color: borderColor, weight: 0.5 };
        }
        return { fillColor: noData, fillOpacity: 0.4, color: noDataBorder, weight: 0.4 };
      },
      onEachFeature: (feat: any, lyr: any) => {
        const item = matchGeoItem(items, feat.properties);
        const name = feat.properties.name || '';
        if (item) {
          matchedNames.add(normalizeName(item.name));
          try { matchedBounds.push(lyr.getBounds()); } catch (_) {}
          lyr.bindTooltip(`<strong>${name}</strong><br>${typeof item.value === 'number' ? item.value.toLocaleString() : 'n/a'}`,
            { sticky: true, direction: 'top' });
        } else {
          lyr.bindTooltip(`<strong>${name}</strong><br><span class="cv-map-tt-muted">No data</span>`,
            { sticky: true, direction: 'top' });
        }
      },
    }).addTo(map);
    matchedCount = matchedNames.size;

    if (!didFit) {   // fit once; keep the user's zoom when switching periods
      didFit = true;
      try {
        if (matchedBounds.length) {
          const b = matchedBounds.reduce((acc, bb) => acc.extend(bb),
            L.latLngBounds(matchedBounds[0].getSouthWest(), matchedBounds[0].getNorthEast()));
          map.fitBounds(b, { padding: [12, 12], maxZoom: 8 });
        } else if (geo.level === 'us_state' || geo.level === 'us_county') {
          map.setView([39, -95], 4);
        } else {
          map.fitBounds(dataLayer.getBounds(), { padding: [8, 8], maxZoom: 5 });
        }
      } catch (_) {}
    }
    return matchedNames;
  }

  // Permanent ABBR + value labels at each region centroid (separate layer so it never
  // collides with the per-region hover tooltip, which is bound to the polygon itself).
  function rebuildLabels() {
    if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
    if (valueMode === 'off' || !dataLayer) return;
    const items = itemsNow();
    const entries: Array<{ center: any; item: any; props: any }> = [];
    dataLayer.eachLayer((lyr: any) => {
      const props = lyr.feature && lyr.feature.properties;
      if (!props) return;
      const item = matchGeoItem(items, props);
      if (!item || typeof item.value !== 'number') return;
      let center; try { center = lyr.getBounds().getCenter(); } catch (_) { return; }
      entries.push({ center, item, props });
    });
    const keys = valueLabelKeys(valueMode, [entries.map(e => e.item.value)]);
    const lg = L.layerGroup();
    entries.forEach((e, i) => {
      if (!keys.has('0:' + i)) return;
      L.tooltip({ permanent: true, direction: 'center', className: 'cv-map-value-label', interactive: false })
        .setLatLng(e.center).setContent(`${abbrevFor(e.item, e.props, geo.level)} ${_fmtVal(e.item.value)}`).addTo(lg);
    });
    labelLayer = lg.addTo(map);
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
  if (L.DomEvent) { L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box); }
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
  if (L.DomEvent) L.DomEvent.disableClickPropagation(btn);
  parent.appendChild(btn);
  sync();
}

// Minimal ⋯ menu for maps — just Copy data (Leaflet maps have no PNG/axis/color options).
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
  if (L.DomEvent) L.DomEvent.disableClickPropagation(btn);
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
  const stops = document.documentElement.dataset.theme === 'dark'
    ? CHOROPLETH_STOPS_DARK : CHOROPLETH_STOPS_LIGHT;
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
