// FLOW MAPS — origin → destination routes, drawn from what MAIN computed
// (src/analysis/geo/geoAgg.ts via visual:data): the top routes by the measure,
// each with its arc already laid out (flowArc.ts bows every route to the right
// of travel, so a route and its return never overlap). Classic global-scope
// renderer <script>, called from mapRender.renderMapInArea.
//
// Line WIDTH is the measure, on a square-root scale between FLOW_W_MIN and
// FLOW_W_MAX px (area-like: twice the value reads as ~1.4× the width, not a
// wall). The ends are dots — origins in the accent, destinations outlined —
// and a hover names the pair and its figure. How many routes are drawn of how
// many exist is always on the map: main caps them, and says so.

const FLOW_SRC = 'cv-flow';
const FLOW_LINE = 'cv-flow-lines';
const FLOW_END_SRC = 'cv-flow-ends';
const FLOW_END = 'cv-flow-ends';
const FLOW_W_MIN = 1.2;
const FLOW_W_MAX = 9;

function flowWidth(v: number | null, max: number): number {
  if (typeof v !== 'number' || !(max > 0) || v <= 0) return FLOW_W_MIN;
  return FLOW_W_MIN + Math.sqrt(v / max) * (FLOW_W_MAX - FLOW_W_MIN);
}

function renderFlowMap(map: any, wrap: HTMLElement, geo: any, data: any): void {
  const flow = geo.flow;
  const flows: any[] = Array.isArray(flow.flows) ? flow.flows : [];
  wrap.classList.add('geo-map');
  if (!flows.length) {
    geoMapEmpty(wrap, flow.skipped
      ? `None of the ${flow.skipped.toLocaleString()} rows has an origin and a destination the map can place.`
      : 'No routes to draw.');
    return;
  }
  const accent = getCSSVar('--accent', wrap) || '#3b82f6';
  const surface = getCSSVar('--surface', wrap) || '#ffffff';
  const max = Math.max(0, ...flows.map((f) => (typeof f.value === 'number' ? f.value : 0)));

  // Heaviest last, so the thick routes draw on top of the thin ones.
  const order = flows.map((f, i) => i).sort((a, b) => (flows[a].value ?? -Infinity) - (flows[b].value ?? -Infinity) || a - b);
  const lines = order.map((i) => {
    const f = flows[i];
    const coords: number[][] = [];
    for (let k = 0; k < f.path.length; k += 2) coords.push([f.path[k], f.path[k + 1]]);
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { __w: flowWidth(f.value, max), __name: f.name, __val: f.value, __n: f.n },
    };
  });
  const ends = new Map<string, any>();
  for (const f of flows) {
    ends.set('o' + f.o.join(','), { type: 'Feature', geometry: { type: 'Point', coordinates: f.o }, properties: { __kind: 'origin', __name: f.from } });
    const dk = 'd' + f.d.join(',');
    if (!ends.has('o' + f.d.join(','))) ends.set(dk, { type: 'Feature', geometry: { type: 'Point', coordinates: f.d }, properties: { __kind: 'dest', __name: f.to } });
  }

  map.addSource(FLOW_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: lines } });
  map.addLayer({
    id: FLOW_LINE, type: 'line', source: FLOW_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': accent, 'line-opacity': 0.62, 'line-width': ['to-number', ['get', '__w'], FLOW_W_MIN] },
  });
  map.addSource(FLOW_END_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [...ends.values()] } });
  map.addLayer({
    id: FLOW_END, type: 'circle', source: FLOW_END_SRC,
    paint: {
      'circle-radius': 4,
      'circle-color': ['case', ['==', ['get', '__kind'], 'origin'], accent, surface],
      'circle-stroke-color': accent,
      'circle-stroke-width': 1.6,
    },
  });
  _attachHoverPopup(map, FLOW_LINE, (p) => {
    const v = p.__val === null || p.__val === undefined || p.__val === 'null' ? 'no data' : _fmtVal(Number(p.__val));
    return `<strong>${_escGeo(p.__name)}</strong><br>${_escGeo(flow.label)}: ${_escGeo(v)}`
      + `<br><span class="cv-map-tt-muted">${Number(p.__n).toLocaleString()} row${Number(p.__n) === 1 ? '' : 's'}</span>`;
  });
  _attachHoverPopup(map, FLOW_END, (p) => `<strong>${_escGeo(p.__name)}</strong><br><span class="cv-map-tt-muted">${p.__kind === 'origin' ? 'Origin' : 'Destination'}</span>`);

  let bbox: BBox | null = null;
  for (const f of flows) bbox = _extendBBox(_extendBBox(bbox, [f.o[0], f.o[1], f.o[0], f.o[1]]), [f.d[0], f.d[1], f.d[0], f.d[1]]);
  if (bbox) _fitBBox(map, bbox, 40, 10);

  flowLegend(wrap, flow.label, max, accent);
  const notes = geoMapNotes(wrap);
  notes.info.textContent = flow.routes > flows.length
    ? `Showing the top ${flows.length.toLocaleString()} of ${flow.routes.toLocaleString()} routes by ${flow.label.toLowerCase()}`
    : `${flows.length.toLocaleString()} route${flows.length === 1 ? '' : 's'} · ${flow.points.toLocaleString()} rows`;
  if (flow.skipped) {
    notes.warn.textContent = `${flow.skipped.toLocaleString()} rows had no usable origin or destination`;
    notes.warn.hidden = false;
  }
  // Read by the smoke and by the map's accessible description.
  wrap.dataset.flows = String(flows.length);

  const controls = document.createElement('div');
  controls.className = 'cv-graph-controls';
  wrap.appendChild(controls);
  _addMapMenuButton(controls, geoMapTable(data, 'flow'));
}

/** Width = value: the thinnest and thickest line, labelled with the figures they stand for. */
function flowLegend(wrap: HTMLElement, label: string, max: number, color: string): void {
  const leg = document.createElement('div');
  leg.className = 'cv-map-legend';
  const title = document.createElement('div');
  title.className = 'cv-map-legend-title';
  title.textContent = label;
  leg.appendChild(title);
  const rows: Array<[number, string]> = max > 0 ? [[FLOW_W_MIN, 'low'], [FLOW_W_MAX, _fmtVal(max)]] : [[FLOW_W_MIN, 'each route']];
  for (const [w, text] of rows) {
    const row = document.createElement('div');
    row.className = 'cv-map-legend-row';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '2'); line.setAttribute('y1', '6'); line.setAttribute('x2', '26'); line.setAttribute('y2', '6');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(w));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-opacity', '0.7');
    svg.appendChild(line);
    const t = document.createElement('span');
    t.textContent = text;
    row.append(svg, t);
    leg.appendChild(row);
  }
  wrap.appendChild(leg);
}
