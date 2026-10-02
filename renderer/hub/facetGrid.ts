// Small multiples — the trellis grid. Classic global-scope renderer script.
//
// THE one implementation of a chart drawn as panels. Two things arrive here:
//   • a faceted visual — `data.facets`, the grid MAIN computed (src/analysis/
//     facets.ts): panels, titles, the filter steps behind each, axis domains;
//   • a share/magnitude chart (pie, donut, gauge, treemap, funnel, histogram)
//     over 2+ series — reshaped here into the same grid, one panel per series,
//     because those types cannot stack series in one chart.
// Every panel is `buildChart` over that panel's `{labels, series}`, so Values,
// Customize, analytics overlays and anything else buildChart draws apply to
// each panel unchanged. This file lays panels out, shares axes, and composes
// the export image; it computes no figure.

/** Panels never narrower than this; the grid wraps to fit. */
const FACET_MIN_W = 220;

interface FacetPanelShape {
  row: number;
  col: number;
  title: string;
  steps: any[];
  labels: any[];
  series: ChartSeriesShape[];
  empty: boolean;
  domain: { min: number; max: number; stackMin: number; stackMax: number } | null;
  analytics?: any[];
  pivot?: any;
  /** A share-type panel: the series it IS (drill names that period). */
  seriesName?: string;
}
interface FacetGridShape {
  rows: string[];
  cols: string[];
  rowField?: string;
  colField?: string;
  scale: 'shared' | 'independent';
  domain: FacetPanelShape['domain'];
  panels: FacetPanelShape[];
  folded?: boolean;
}

/** The grid to draw for `data` as `type`, or null for one ordinary chart. */
function facetGridOf(data: any, type: string, overrides?: any): FacetGridShape | null {
  if (type === 'table' || type === 'cohort' || type === 'event_funnel' || isMapChartType(type)) return null;
  const g = data && data.facets;
  if (g && Array.isArray(g.panels) && g.panels.length) return g;
  const series = chartSeries(data);
  if (!chartIsSmallMultiple(type, series.length)) return null;
  // Periods ▾ on a share chart hides PANELS (one per series), as it always did.
  const hidden = new Set(Array.isArray(overrides && overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  const panels: FacetPanelShape[] = [];
  series.forEach((s, i) => {
    if (hidden.has(i)) return;
    const title = s.name || t('common.series_2', { p0: (i + 1) });
    panels.push({ row: 0, col: panels.length, title, steps: [], labels: data.labels || [], series: [s], empty: false, domain: null, seriesName: s.name });
  });
  return { rows: [], cols: panels.map((p) => p.title), scale: 'independent', domain: null, panels };
}

/** One panel's data for buildChart — every other top-level key (an R8 HOOK for event markers etc.) rides along. */
function facetPanelData(data: any, p: FacetPanelShape): any {
  // R8 HOOK: a per-chart payload a sibling adds to `data` (date-axis event
  // markers) reaches every panel through this copy; one that must differ per
  // panel belongs on FacetPanel in src/analysis/facets.ts.
  return Object.assign({}, data, { labels: p.labels, series: p.series, analytics: p.analytics || null, facets: undefined, pivot: p.pivot });
}

/** What the Values / Periods cluster should list: one panel's series, not the flattened set. */
function facetControlsData(data: any): any {
  const g = data && data.facets;
  const p = g && Array.isArray(g.panels) ? g.panels.find((x: FacetPanelShape) => !x.empty) : null;
  return p ? Object.assign({}, data, { labels: p.labels, series: p.series }) : data;
}

/** Draw the grid into `host`. Returns the charts drawn (with their panels) for the caller to keep. */
function facetDrawPanels(host: HTMLElement, grid: FacetGridShape, data: any, type: string, ov: any): any[] {
  const el = document.createElement('div');
  el.className = 'fc-grid';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t('common.small_multiples'));
  const matrix = grid.rows.length > 0;
  if (matrix) {
    el.classList.add('is-matrix');
    el.style.setProperty('--fc-cols', String(grid.cols.length));
    el.appendChild(document.createElement('div')); // the corner
    for (const c of grid.cols) el.appendChild(facetHead('fc-head', c));
  }
  host.appendChild(el);

  const charts: any[] = [];
  let row = -1;
  for (const p of grid.panels) {
    if (matrix && p.row !== row) { row = p.row; el.appendChild(facetHead('fc-rowhead', grid.rows[row] || '')); }
    const cell = document.createElement('div');
    cell.className = 'fc-cell' + (p.empty ? ' is-empty' : '');
    cell.setAttribute('aria-label', p.title);
    if (!matrix) cell.appendChild(facetHead('fc-title', p.title));
    el.appendChild(cell);
    if (p.empty) {
      const none = document.createElement('div');
      none.className = 'fc-none';
      none.textContent = t('chartFamiliesExtra.no_data');
      cell.appendChild(none);
      continue;
    }
    if (p.pivot) {
      const box = document.createElement('div');
      box.className = 'fc-pivot';
      cell.appendChild(box);
      renderPivotTable(box, p.pivot, { interactive: false });
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'cv-canvas-wrap is-fresh';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', p.title + t('facetGrid.chart'));
    wrap.appendChild(canvas);
    cell.appendChild(wrap);
    const chart = buildChart(canvas, facetPanelData(data, p), type, ov);
    if (!chart) continue;
    chart.$facet = { title: p.title, steps: p.steps, series: p.seriesName };
    chart.$cell = cell;
    charts.push(chart);
  }
  facetShareScale(grid, charts);
  return charts;
}

function facetHead(cls: string, text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = cls;
  h.textContent = text;
  h.title = text;
  return h;
}

/** A shared scale: every panel's value axis spans the union domain main computed. */
function facetShareScale(grid: FacetGridShape, charts: any[]): void {
  if (grid.scale !== 'shared' || !grid.domain) return;
  const d = grid.domain;
  for (const ch of charts) {
    const scales = ch.options && ch.options.scales;
    if (!scales) continue;
    const axis = scales[ch.options.indexAxis === 'y' ? 'x' : 'y'];
    if (!axis || axis.type === 'category' || typeof axis.max === 'number') continue; // a 0–100% axis is already shared
    axis.suggestedMin = axis.stacked ? d.stackMin : d.min;
    axis.suggestedMax = axis.stacked ? d.stackMax : d.max;
    try { ch.update('none'); } catch (_) { /* torn down */ }
  }
}

/**
 * With a shared scale the axes are drawn once per row and column: only the
 * left column keeps y ticks and only the bottom of each column keeps x ticks.
 * The others go transparent rather than hidden so every plot area stays the
 * same size and the panels line up. Re-run on reflow — the column count is the
 * layout's, not ours.
 */
function facetAxesOnce(grid: FacetGridShape, charts: any[]): void {
  const cells = charts.map((c) => c.$cell as HTMLElement);
  if (!cells.length || !cells[0].isConnected) return;
  const sameX = charts.every((c) => JSON.stringify(c.data.labels) === JSON.stringify(charts[0].data.labels));
  const minLeft = Math.min(...cells.map((c) => c.offsetLeft));
  charts.forEach((ch, i) => {
    const scales = ch.options && ch.options.scales;
    if (!scales || !scales.x || !scales.y) return;
    const left = cells[i].offsetLeft === minLeft;
    const bottom = !cells.some((c) => c.offsetLeft === cells[i].offsetLeft && c.offsetTop > cells[i].offsetTop);
    const on = grid.scale !== 'shared';
    const muted = 'rgba(0,0,0,0)';
    if (!ch.$tickColor) ch.$tickColor = { x: scales.x.ticks.color, y: scales.y.ticks.color };
    scales.y.ticks.color = on || left ? ch.$tickColor.y : muted;
    scales.x.ticks.color = on || bottom || !sameX ? ch.$tickColor.x : muted;
    try { ch.update('none'); } catch (_) { /* torn down */ }
  });
}

/**
 * Render `grid` into `container` — renderChartJsInArea's small-multiples branch.
 * The panel charts are kept as ONE array in chartInstances, with `destroy` and
 * `resize` on it so a caller that tears down "whatever is there" tears down
 * every panel.
 */
function renderFacetGrid(container: HTMLElement, grid: FacetGridShape, data: any, type: string, entry: any, turnIdx: any, colorSrc?: any): void {
  const overrideKey = entry ? `${turnIdx}:${type}` : null;
  const overrides = (entry && entry.chartOverrides && overrideKey && entry.chartOverrides[overrideKey]) || {};
  const ov = Object.assign({}, fmtWithScope(overrides, colorSrc));
  delete ov.title; delete ov.commentPins; // a pin names ONE chart's point, not every panel's
  if (!data.facets) delete ov.hiddenSeries; // share charts: Periods picked the panels above
  ov._smallMultiple = true; // the panel title already names the value
  // A legend per panel repeats the same entries N times — one, under the grid,
  // says it once. Forced on in Customize, each panel keeps its own (a pie's
  // legend names slices, which one grid legend of series cannot).
  const gridLegend = ov.showLegend === undefined;
  if (gridLegend) ov.showLegend = false;

  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'cv-chart-wrapper fc-wrap';
  const scroller = document.createElement('div');
  scroller.className = 'fc-scroll';
  chartWrapper.appendChild(scroller);
  container.appendChild(chartWrapper);

  const charts = facetDrawPanels(scroller, grid, data, type, ov);
  if (!charts.length && !grid.panels.some((p) => p.pivot || p.empty)) {
    container.innerHTML = '<div class="cv-chart-fallback">Couldn\'t draw a chart from this data.</div>';
    return;
  }
  if (gridLegend && charts[0] && charts[0].data.datasets.length > 1) {
    chartWrapper.appendChild(facetLegend(charts[0]));
  }
  if (grid.folded) {
    const note = document.createElement('p');
    note.className = 'fc-note';
    note.textContent = t('facetGrid.values_past_the_panel_limit_are');
    chartWrapper.appendChild(note);
  }

  let frame = 0;
  const ro = new ResizeObserver(() => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; facetAxesOnce(grid, charts); });
  });
  ro.observe(scroller);
  chartInstances.set(container, Object.assign(charts, {
    destroy() { ro.disconnect(); charts.forEach((c) => { try { c.destroy(); } catch (_) { /* gone */ } }); },
    resize() { charts.forEach((c) => { try { c.resize(); } catch (_) { /* gone */ } }); },
  }));
  if (entry && overrideKey) {
    // One control cluster for the whole grid (no single canvas → null).
    addChartControls(controlsSlotFor(container) || chartWrapper, container, null, data, type, entry, turnIdx, overrideKey);
  }
}

/** One legend for the grid: the series colours, read off the first panel's datasets. */
function facetLegend(chart: any): HTMLElement {
  const box = document.createElement('div');
  box.className = 'fc-legend';
  for (const ds of chart.data.datasets) {
    if (!ds || typeof ds.label !== 'string') continue;
    const item = document.createElement('span');
    item.className = 'fc-legend-item';
    const sw = document.createElement('span');
    sw.className = 'fc-swatch';
    const c = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.borderColor || ds.backgroundColor;
    if (typeof c === 'string') sw.style.background = c;
    const t = document.createElement('span');
    t.textContent = ds.label;
    item.append(sw, t);
    box.appendChild(item);
  }
  return box;
}

/**
 * The panel under the pointer — `chartMarkAt`'s answer for a grid: the Chart
 * instance to hit-test, and the facet the mark belongs to.
 */
function facetPanelAt(charts: any[], e: Event): { chart: any; facet: { title: string; steps: any[]; series?: string } } | null {
  const t = e && (e.target as HTMLElement);
  const ch = charts.find((c) => c && c.canvas && (c.canvas === t || (t && c.$cell && c.$cell.contains(t))));
  return ch ? { chart: ch, facet: ch.$facet } : null;
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * The grid as ONE PNG: drawn off-screen exactly as on screen (2x, no
 * animation), then every panel canvas and title composited onto a solid
 * background. `captureChartPNG` routes here for any data that draws as a grid.
 */
function captureFacetPNG(type: string, grid: FacetGridShape, data: any, overrides?: any, frame?: any): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const holder = document.createElement('div');
    holder.className = 'export-capture-holder fc-capture';
    applyCaptureFrame(holder, frame);
    if (frame && frame.width) holder.style.width = Math.max(320, Math.round(frame.width)) + 'px';
    document.body.appendChild(holder);
    const ov = Object.assign({}, overrides || {}, { noAnimate: true, devicePixelRatio: 2, _smallMultiple: true, showLegend: false });
    delete ov.title; delete ov.commentPins;
    if (!data.facets) delete ov.hiddenSeries;
    let charts: any[] = [];
    const finish = (url: string | null): void => {
      charts.forEach((c) => { try { c.destroy(); } catch (_) { /* gone */ } });
      holder.remove();
      resolve(url);
    };
    try {
      charts = facetDrawPanels(holder, grid, data, type, ov);
      if (!charts.length) { finish(null); return; }
      facetAxesOnce(grid, charts);
      requestAnimationFrame(() => {
        try {
          const box = holder.getBoundingClientRect();
          const out = document.createElement('canvas');
          out.width = Math.round(holder.scrollWidth * 2);
          out.height = Math.round(holder.scrollHeight * 2);
          const ctx = out.getContext('2d')!;
          ctx.fillStyle = getCSSVar('--surface', holder) || '#ffffff';
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.scale(2, 2);
          // Titles and headers are DOM text; draw them where the layout put them.
          ctx.fillStyle = getCSSVar('--text-strong', holder) || '#111111';
          ctx.font = `600 12px ${getCSSVar('--font-ui', holder) || 'system-ui, sans-serif'}`;
          ctx.textBaseline = 'top';
          holder.querySelectorAll('.fc-title, .fc-head, .fc-rowhead, .fc-none').forEach((n) => {
            const r = (n as HTMLElement).getBoundingClientRect();
            ctx.fillText((n as HTMLElement).textContent || '', r.left - box.left, r.top - box.top + 2, r.width);
          });
          for (const c of charts) {
            const r = c.canvas.getBoundingClientRect();
            ctx.drawImage(c.canvas, r.left - box.left, r.top - box.top, r.width, r.height);
          }
          finish(out.toDataURL('image/png'));
        } catch (_) { finish(null); }
      });
    } catch (_) { finish(null); }
  });
}
