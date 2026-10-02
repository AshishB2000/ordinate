// LINKED HOVER: point at a category or a date on one dashboard chart and every
// other chart that shares that dimension marks the same value — a crosshair,
// its own marks at that value lit, and its own tooltip with ITS figure there.
// A region map lights the region.
//
// Classic global-scope renderer script (no import/export). One tiny event bus
// (lhPublish / lhSubscribe / lhClear) and the two things on it: `lhPlugin`, an
// inline Chart.js plugin buildChart adds to every chart, and `lhWireMap`, which
// mapRender calls once a region or bubble map is drawn.
//
// "Shares the dimension" = the same dataset column on the category axis. The
// visual card stamps that onto its area as `data-lh-field` (`lhFieldOf`);
// a chart or map outside such an area never publishes and never listens. A
// date axis of a different grain shares the column but not its labels, so it
// simply finds no matching value — nothing is lit rather than the wrong thing.
//
// A listener goes when its chart is destroyed (afterDestroy) or, should a
// chart ever be dropped without destroy(), the first time it is told anything
// while detached — so a re-render or a tab switch never leaves one behind.

interface LhEvent { field: string; value: string | null; source: unknown }

const lhSubs = new Set<(e: LhEvent) => void>();
let lhCurrent: LhEvent | null = null;

function lhSubscribe(fn: (e: LhEvent) => void): () => void {
  lhSubs.add(fn);
  return () => { lhSubs.delete(fn); };
}

function lhPublish(e: LhEvent): void {
  lhCurrent = e.value == null ? null : e;
  [...lhSubs].forEach((fn) => { try { fn(e); } catch (_) { /* one broken listener never stops the rest */ } });
}

/** `source` stopped hovering: every listener lets go of the value it lit. */
function lhClear(source: unknown): void {
  if (!lhCurrent || lhCurrent.source !== source) return;
  lhPublish({ field: lhCurrent.field, value: null, source });
}

/** The dimension a visual's category axis is: dataset + column. */
function lhFieldOf(visual: any): string {
  const enc = (visual && visual.encoding) || {};
  return enc.category ? String(enc.categoryDatasetId || visual.datasetId || '') + '|' + String(enc.category) : '';
}

function lhFieldAt(el: Element | null): string {
  const host = el ? el.closest('[data-lh-field]') as HTMLElement | null : null;
  return host ? host.dataset.lhField || '' : '';
}

/** Labels line up with marks one-to-one (bars, lines, slices) — the charts that can link. */
function lhLinkable(chart: any): boolean {
  const labels = chart.data && chart.data.labels;
  const ds = chart.data && chart.data.datasets && chart.data.datasets[0];
  return Array.isArray(labels) && !!ds && Array.isArray(ds.data) && ds.data.length === labels.length;
}

/** Light index `j` of `chart` (or nothing, j < 0) as if the pointer were there. */
function lhShow(chart: any, j: number): void {
  const idx = j < 0 ? null : j;
  if (chart.$lhIndex === idx) return;
  chart.$lhIndex = idx;
  const act = idx === null ? [] : chart.data.datasets
    .map((_: unknown, d: number) => ({ datasetIndex: d, index: idx }))
    .filter((a: any) => chart.isDatasetVisible(a.datasetIndex) && chart.getDatasetMeta(a.datasetIndex).data[idx]);
  chart.setActiveElements(act);
  if (chart.tooltip) {
    const el = act.length ? chart.getDatasetMeta(act[0].datasetIndex).data[idx] : null;
    chart.tooltip.setActiveElements(act, el ? { x: el.x, y: el.y } : { x: 0, y: 0 });
  }
  chart.render();
}

const lhPlugin = {
  id: 'ordLinkedHover',
  afterInit(chart: any): void {
    const field = lhFieldAt(chart.canvas);
    if (!field) return;
    chart.$lhField = field;
    chart.$lhColor = getCSSVar('--muted', chart.canvas) || '#888';
    chart.$lhOff = lhSubscribe((e) => {
      if (!chart.canvas || !chart.canvas.isConnected) { chart.$lhOff(); return; }
      if (e.field !== field || !lhLinkable(chart)) return;
      const j = e.value == null ? -1 : chart.data.labels.findIndex((l: unknown) => String(l) === e.value);
      // The chart under the pointer has Chart.js's own hover; it only takes the crosshair.
      if (e.source === chart) chart.$lhIndex = j < 0 ? null : j;
      else lhShow(chart, j);
    });
  },
  afterEvent(chart: any, args: any): void {
    if (!chart.$lhField || !lhLinkable(chart)) return;
    const e = args.event;
    if (e.type === 'mouseout' || (e.type === 'mousemove' && !args.inChartArea)) {
      if (chart.$lhValue != null) { chart.$lhValue = null; lhClear(chart); args.changed = true; }
      return;
    }
    if (e.type !== 'mousemove') return;
    const hit = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
    const value = hit.length ? String(chart.data.labels[hit[0].index]) : null;
    if (value === chart.$lhValue) return;
    chart.$lhValue = value;
    if (value == null) lhClear(chart);
    else lhPublish({ field: chart.$lhField, value, source: chart });
    args.changed = true;
  },
  // The crosshair, under the marks: across the value axis at the hovered category.
  beforeDatasetsDraw(chart: any): void {
    const j = chart.$lhIndex;
    if (j == null) return;
    const horiz = chart.options.indexAxis === 'y';
    const scale = horiz ? chart.scales.y : chart.scales.x;
    if (!scale || scale.type !== 'category') return;
    const p = scale.getPixelForValue(j);
    const a = chart.chartArea;
    if (!Number.isFinite(p) || !a) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = chart.$lhColor;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (horiz) { ctx.moveTo(a.left, p); ctx.lineTo(a.right, p); } else { ctx.moveTo(p, a.top); ctx.lineTo(p, a.bottom); }
    ctx.stroke();
    ctx.restore();
  },
  afterDestroy(chart: any): void {
    if (chart.$lhValue != null) lhClear(chart);
    if (chart.$lhOff) chart.$lhOff();
  },
};

// The map layers a region can be lit on, and the feature property naming it.
const LH_MAP_LAYERS = [
  { layer: 'cv-choropleth-fill', source: 'cv-choropleth', prop: '__item', kind: 'line' },
  { layer: 'cv-bubbles-circles', source: 'cv-bubbles', prop: '__name', kind: 'circle' },
];

/** Publish a map's hovered region and light the region another chart hovers. */
function lhWireMap(container: HTMLElement, map: any): void {
  const field = lhFieldAt(container);
  const spec = field ? LH_MAP_LAYERS.find((s) => map.getLayer(s.layer)) : null;
  if (!spec) return;
  const accent = getCSSVar('--accent', container) || '#3b82f6';
  // The highlight layer's filter: the hovered region, or a name no region has.
  const only = (v: string | null): any[] => ['==', ['to-string', ['get', spec.prop]], v == null ? '\u0001' : v];
  map.addLayer(spec.kind === 'line'
    ? { id: 'lh-hl', type: 'line', source: spec.source, filter: only(null), paint: { 'line-color': accent, 'line-width': 2.5 } }
    : { id: 'lh-hl', type: 'circle', source: spec.source, filter: only(null),
        paint: { 'circle-radius': ['to-number', ['get', '__r'], 5], 'circle-opacity': 0, 'circle-stroke-color': accent, 'circle-stroke-width': 2.5 } });
  let hovered: string | null = null;
  map.on('mousemove', spec.layer, (e: any) => {
    const f = e.features && e.features[0];
    const v = f && f.properties && f.properties[spec.prop] ? String(f.properties[spec.prop]) : null;
    if (v === hovered) return;
    hovered = v;
    if (v == null) lhClear(map); else lhPublish({ field, value: v, source: map });
  });
  map.on('mouseleave', spec.layer, () => { hovered = null; lhClear(map); });
  const off = lhSubscribe((e) => {
    if (!container.isConnected || mapInstances.get(container) !== map) { off(); return; }
    if (e.field !== field) return;
    try { map.setFilter('lh-hl', only(e.value)); } catch (_) { off(); }
  });
}
