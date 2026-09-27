// POINT MAPS — rows at their coordinates, sized by a measure and coloured by a
// column, clustered by the app's own grid above 2,000 points (geoCluster.ts,
// recomputed on every zoom), with each cluster's count in its marker. A click
// on a cluster zooms into it; a click on a point selects its value.
// Classic global-scope renderer <script>, called from mapRender.renderMapInArea.
//
// Counts are DOM markers, not a symbol layer: symbol text needs a `glyphs`
// URL, which is a network host this app does not have (see mapRender's header).

const PT_SRC = 'cv-points';
const PT_LAYER = 'cv-points-circles';
const PT_MAX_COLORS = 8;

function ptColorScale(items: any[], wrap: HTMLElement, column?: string): { of: (it: any) => string; legend: Array<[string, string]> | null; ramp: [number, number] | null } {
  const accent = getCSSVar('--accent', wrap) || '#3b82f6';
  const vals = items.map((i) => i.color).filter((c) => c !== undefined && c !== null && c !== '');
  if (!vals.length) return { of: () => accent, legend: null, ramp: null };
  if (vals.every((v) => typeof v === 'number')) {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return {
      of: (it) => (typeof it.color === 'number' ? getChoroplethColor(hi > lo ? (it.color - lo) / (hi - lo) : 0.5, wrap) : accent),
      legend: null,
      ramp: [lo, hi],
    };
  }
  // Categories: the project's colour for each value (fmtColors.ts), else the
  // chart palette in first-seen order; the tail as one muted colour.
  const palette = CHART_PALETTE.map((fallback, i) => getCSSVar(`--chart-${i + 1}`, wrap) || fallback);
  const order: string[] = [];
  for (const v of vals) { const k = String(v); if (!order.includes(k)) order.push(k); }
  const muted = getCSSVar('--text-faint', wrap) || '#aeb4bf';
  const tokens = column && typeof fmtTokensFor === 'function' ? fmtTokensFor(column, order.slice(0, PT_MAX_COLORS)) : null;
  const color = new Map(order.slice(0, PT_MAX_COLORS).map((k, i) =>
    [k, tokens && tokens[i] ? fmtHex(tokens[i], palette) : palette[i % palette.length]]));
  const legend: Array<[string, string]> = order.slice(0, PT_MAX_COLORS).map((k) => [k, color.get(k) as string]);
  if (order.length > PT_MAX_COLORS) legend.push([`${order.length - PT_MAX_COLORS} more`, muted]);
  return { of: (it) => color.get(String(it.color)) || (it.color == null ? accent : muted), legend, ramp: null };
}

function renderPointMap(map: any, wrap: HTMLElement, container: HTMLElement, geo: any, data: any): void {
  const items: any[] = (geo.items || []).filter((i: any) => typeof i.lat === 'number' && typeof i.lng === 'number');
  if (!items.length) {
    const fb = document.createElement('div');
    fb.className = 'cv-chart-fallback';
    fb.textContent = 'None of these values could be placed on the map.';
    wrap.appendChild(fb);
    if (geo.unmatched) ptUnmatched(wrap, geo.unmatched);
    return;
  }
  const values = items.map((i) => (typeof i.value === 'number' ? i.value : 0));
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const MIN_R = 4;
  const MAX_R = 18;
  const colors = ptColorScale(items, wrap, geo.colorColumn);
  const clusterColor = getCSSVar('--accent', wrap) || '#3b82f6';
  let markers: any[] = [];

  const draw = (): void => {
    const zoom = map.getZoom();
    const cells = geoCluster.gridCluster(items, zoom);
    markers.forEach((m) => { try { m.remove(); } catch (_) { /* gone with the map */ } });
    markers = [];
    let clusters = 0;
    const features = cells.map((c: any) => {
      if (c.count > 1) {
        clusters++;
        const r = Math.min(24, 9 + Math.log2(c.count) * 1.8);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cv-map-cluster';
        el.textContent = _fmtVal(c.count);
        el.setAttribute('aria-label', `${c.count.toLocaleString()} points — zoom in`);
        el.style.width = el.style.height = r * 2 + 'px';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          map.easeTo({ center: [c.lng, c.lat], zoom: Math.min(18, Math.floor(zoom) + 2), duration: 0 });
        });
        markers.push(new (_mlgl().Marker)({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map));
        // After the Marker: its constructor stamps a generic "Map marker" label over ours.
        el.setAttribute('aria-label', `${c.count.toLocaleString()} points — zoom in`);
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { __r: 0, __c: clusterColor } };
      }
      const it = items[c.index];
      const t = maxVal > minVal ? (it.value - minVal) / (maxVal - minVal) : 0.5;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
        properties: {
          __r: MIN_R + Math.max(0, Math.min(1, t)) * (MAX_R - MIN_R),
          __c: colors.of(it),
          __name: it.name,
          __val: it.value,
          __color: it.color == null ? '' : String(it.color),
        },
      };
    });
    const fc = { type: 'FeatureCollection', features };
    const src = map.getSource(PT_SRC);
    if (src) src.setData(fc);
    else {
      map.addSource(PT_SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: PT_LAYER, type: 'circle', source: PT_SRC,
        filter: ['>', ['to-number', ['get', '__r']], 0],
        paint: {
          'circle-radius': ['to-number', ['get', '__r'], MIN_R],
          'circle-color': ['to-color', ['get', '__c'], clusterColor],
          'circle-opacity': 0.72,
          'circle-stroke-color': getCSSVar('--surface', wrap) || '#ffffff',
          'circle-stroke-width': 1,
        },
      });
      _attachHoverPopup(map, PT_LAYER, (p) => {
        const head = p.__name ? `<strong>${_escGeo(p.__name)}</strong><br>` : '';
        const col = p.__color ? `<br><span class="cv-map-tt-muted">${_escGeo(geo.colorColumn || 'colour')}: ${_escGeo(p.__color)}</span>` : '';
        return head + (typeof p.__val === 'number' ? p.__val.toLocaleString() : '') + col;
      });
      map.on('click', PT_LAYER, (e: any) => {
        const f = e.features && e.features[0];
        if (f && f.properties) mapMarkClick(container, data.markColumn, f.properties.__name);
      });
    }
    // Read by the smoke and by the map's accessible description.
    wrap.dataset.points = String(cells.length - clusters);
    wrap.dataset.clusters = String(clusters);
  };

  let bbox: BBox | null = null;
  for (const it of items) bbox = _extendBBox(bbox, [it.lng, it.lat, it.lng, it.lat]);
  if (bbox) _fitBBox(map, bbox, 24, 12);
  draw();
  map.on('zoomend', draw);

  if (maxVal > minVal) _addBubbleLegend(wrap, minVal, maxVal, clusterColor, MIN_R, MAX_R);
  if (colors.legend) ptLegend(wrap, geo.colorColumn || 'Colour', colors.legend);
  if (geo.unmatched && geo.unmatched.count) ptUnmatched(wrap, geo.unmatched);
  else if (geo.skipped) _addUnmatchedNote(wrap, [`${geo.skipped.toLocaleString()} rows with no usable coordinates`]);
  const controls = document.createElement('div');
  controls.className = 'cv-graph-controls';
  wrap.appendChild(controls);
  _addMapMenuButton(controls, data);
}

function ptLegend(wrap: HTMLElement, title: string, rows: Array<[string, string]>): void {
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend cv-map-legend--colors';
  const t = document.createElement('div');
  t.className = 'cv-map-legend-title';
  t.textContent = title;
  leg.appendChild(t);
  for (const [label, color] of rows) {
    const row = document.createElement('div');
    row.className = 'cv-map-legend-row';
    const sw = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sw.setAttribute('width', '10');
    sw.setAttribute('height', '10');
    sw.setAttribute('aria-hidden', 'true');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', '5');
    dot.setAttribute('cy', '5');
    dot.setAttribute('r', '5');
    dot.setAttribute('fill', color);
    sw.appendChild(dot);
    const l = document.createElement('span');
    l.textContent = label;
    row.append(sw, l);
    leg.appendChild(row);
  }
  wrap.appendChild(leg);
}

/** "Couldn't place 3: Atlantis, Gotham, …" — counted AND listed. */
function ptUnmatched(wrap: HTMLElement, u: { count: number; values: string[] }): void {
  const more = u.count > u.values.length ? `, and ${u.count - u.values.length} more` : '';
  const note = document.createElement('div');
  note.className = 'cv-map-unmatched';
  note.textContent = `Couldn't place ${u.count}: ${u.values.join(', ')}${more}`;
  note.title = note.textContent;
  wrap.appendChild(note);
}
