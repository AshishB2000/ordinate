// Result rendering — turns an analysis result into DOM: the viz area
// (renderVizInArea / renderSmallMultiples), metrics / headline / details, the
// chart-type eligibility helpers, and renderTurnResult. Extracted from hub.js
// as a pure structural move (no logic changes). The result *controller*
// (showAnalyzeResult, followups, IPC handlers, the entries/currentEntryId state
// machine) stays in hub.js. Classic script sharing global scope: buildChart,
// renderMapInArea, captureChartPNG/openExportDialog, hub helpers — all call-time.

// ── Render a viz of the given type into a container div. Destroys any prior chart/map. ──
// entry + turnIdx are optional; when provided they enable the ⋯ chart menu.
// `source` is optional dataset IDENTITY ({projectId, datasetId, encoding, filters}),
// passed only by callers that HAVE one — the Visuals builder and dashboard cards.
// It is what the Mosaic/vgplot engine needs and `data` cannot carry: Mosaic issues
// its own SQL against the dataset's view instead of consuming a computed
// {labels, series}. Omitting it (the capture result surface, the export preview,
// every chartControls re-render) simply keeps the Chart.js path, unchanged.
function renderVizInArea(container, data, type, entry, turnIdx, source?) {
  const old = chartInstances.get(container);
  // A small-multiples render stores an array of charts; single charts store one.
  if (old) { (Array.isArray(old) ? old : [old]).forEach(c => { try { c.destroy(); } catch (_) {} }); chartInstances.delete(container); }
  destroyMapInContainer(container);
  container.innerHTML = '';
  // The Values / ⋯ cluster of a surface with a header slot lives OUTSIDE the
  // container, so clearing the container never cleared it — every redraw of the
  // builder stacked one more cluster in the stage head.
  const slot = controlsSlotFor(container);
  if (slot) slot.innerHTML = '';

  // ── The Mosaic seam: ONE branch, default off (localStorage 'scMosaic'). ──
  // Any miss — flag off, no identity, a type or encoding vgplot can't express,
  // a view that won't resolve, a query that errors — falls through to Chart.js
  // below, silently but observably (plotRender.js records it on the container
  // and at console.debug). See renderer/hub/plotRender.ts.
  if (mosaicEnabled() && mosaicCanRender(type, source)) {
    renderMosaicViz(container, type, source, () => renderChartJsInArea(container, data, type, entry, turnIdx, source))
      .then(drawn => { if (!drawn) renderChartJsInArea(container, data, type, entry, turnIdx, source); });
    return;
  }
  renderChartJsInArea(container, data, type, entry, turnIdx, source);
}

/**
 * Re-sort a pivot: ask main for the grid again with the new sort, then draw it.
 *
 * `source.encoding` is not mutated — the patched copy travels with the redraw
 * so a second click sorts the grid that is actually on screen, while the SAVED
 * visual keeps whatever its author chose in the builder's own Sort control.
 * The builder hears about it through `onPivotSorted`, which it defines; on a
 * dashboard tile nothing defines it and the sort is simply a look.
 */
async function resortPivot(container, source, sort, entry, turnIdx) {
  const encoding = Object.assign({}, source.encoding, {
    pivot: Object.assign({}, source.encoding && source.encoding.pivot, { sort }),
  });
  let res;
  try {
    res = await window.hub.computeVisualData(source.projectId, source.datasetId, encoding, source.filters || []);
  } catch (_) { return; }
  if (!res || res.ok === false || !res.data || !res.data.pivot) return;
  renderVizInArea(container, res.data, 'pivot', entry, turnIdx, Object.assign({}, source, { encoding }));
  if (typeof onPivotSorted === 'function') onPivotSorted(source, sort);
}

// The Chart.js/MapLibre/table ladder — everything renderVizInArea did before the
// Mosaic seam, minus the teardown its caller already performed.
function renderChartJsInArea(container, data, type, entry, turnIdx, source?) {
  container.innerHTML = '';
  // Which columns this chart's labels and series are, for the project's colour
  // map (fmtColors.ts). The identity rides on `source`, or on the entry's drill
  // context when a Customize re-render passes no source.
  const colorSrc = source || (entry && entry.drill) || null;

  // Grouped share/magnitude charts (pie, donut, gauge, treemap, funnel, histogram)
  // can't stack series into one chart — render one mini per period instead.
  if (entry && chartIsSmallMultiple(type, chartSeries(data).length)) {
    renderSmallMultiples(container, data, type, entry, turnIdx, colorSrc);
    return;
  }

  // A PIVOT is a <table> over `data.pivot`, which main computed. One dispatch,
  // as early as the map one, because nothing below it applies: no canvas, no
  // Chart.js instance, no Values/Customize cluster (its own header row IS the
  // control surface). A pivot chart type WITHOUT a grid means the encoding is
  // not a pivot — fall through and draw whatever the data actually is.
  if (type === 'pivot' && data && data.pivot) {
    renderPivotTable(container, data.pivot, {
      interactive: true,
      // Sorting reorders the hierarchy over figures only MAIN has, so a header
      // click RECOMPUTES rather than rearranging the DOM. It needs the dataset
      // identity to do that; without one (the export preview, a frozen
      // snapshot) the headers stay plain labels rather than dead buttons.
      onSort: source ? (next) => { void resortPivot(container, source, next, entry, turnIdx); } : undefined,
    });
    return;
  }

  // Cohort and event funnel: DOM over `data.cohort` / `data.eventFunnel`, which
  // main computed — the pivot's arrangement (cohortRender.ts).
  if (type === 'cohort' || type === 'event_funnel') { renderEngineViz(container, data, type, source); return; }

  if (type === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'cv-col-body';
    const table = document.createElement('table');
    table.className = 'cv-data-table';
    const tableKey = entry ? `${turnIdx}:${type}` : null;
    const tableOv = (entry && entry.chartOverrides && tableKey && entry.chartOverrides[tableKey]) || {};
    buildDataTable(table, data, fmtWithScope(tableOv, colorSrc));
    wrap.appendChild(table);
    container.appendChild(wrap);
    return;
  }

  if (isMapChartType(type)) { // mapKinds.ts
    renderMapInArea(container, data, type);
    return;
  }

  const wrap = document.createElement('div');
  // `is-fresh` is the one-shot fade-in: hub.css runs a 220ms opacity keyframe
  // on it, and since this wrapper is built new for every draw the fade happens
  // once per mount. Nothing removes the class — a keyframe does not replay on a
  // live element, so it costs nothing to leave on.
  wrap.className = 'cv-canvas-wrap is-fresh';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Chart');
  wrap.appendChild(canvas);

  // Wrap canvas + menu button in a relative-positioned group.
  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'cv-chart-wrapper';
  chartWrapper.appendChild(wrap);
  container.appendChild(chartWrapper);

  const overrideKey = entry ? `${turnIdx}:${type}` : null;
  const overrides = (entry && entry.chartOverrides && overrideKey && entry.chartOverrides[overrideKey]) || {};
  const chart = buildChart(canvas, data, type, fmtWithScope(overrides, colorSrc));
  if (chart) {
    chartInstances.set(container, chart);
    if (entry && overrideKey) {
      // Controls (Values menu, period filter, ⋯) need an entry to persist overrides.
      addChartControls(controlsSlotFor(container) || chartWrapper, container, canvas, data, type, entry, turnIdx, overrideKey);
    }
  } else {
    container.innerHTML = '<div class="cv-chart-fallback">Couldn\'t draw a chart from this data.</div>';
  }
}

// Surfaces that give the Values / ⋯ cluster a home OUTSIDE the plot.
//
// The cluster is position:absolute at the top-right of .cv-chart-wrapper, which
// is directly over where Chart.js draws its top-right data labels — on a
// dashboard tile it sat on the last bar's own number. Where a surface offers a
// header row it says so with an empty .cv-controls-slot, and the cluster is
// appended there in normal flow instead. Surfaces with no header (the Ask
// thread, the export preview) are unchanged and keep the overlay.
const CONTROLS_HOSTS = '.dash-card, .viz-builder-stage';

function controlsSlotFor(container) {
  if (!container || typeof container.closest !== 'function') return null;
  const host = container.closest(CONTROLS_HOSTS);
  return host ? host.querySelector('.cv-controls-slot') : null;
}

// Render a grouped share/magnitude chart as small multiples: one mini chart per
// period (series), side by side. Each mini is buildChart() fed a single-series
// slice of the data, so it reuses every renderer + Values/Customize override.
function renderSmallMultiples(container, data, type, entry, turnIdx, colorSrc?) {
  const series = chartSeries(data);
  const overrideKey = `${turnIdx}:${type}`;
  const overrides = (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {};
  const hidden = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);

  const chartWrapper = document.createElement('div');
  chartWrapper.className = 'cv-chart-wrapper';
  const grid = document.createElement('div');
  grid.className = 'cv-small-multiples';
  chartWrapper.appendChild(grid);
  container.appendChild(chartWrapper);

  // Per-mini overrides drop series-level keys that don't apply to a 1-series slice:
  // hiddenSeries is handled here (which minis render), title would repeat on each.
  const miniOv = Object.assign({}, fmtWithScope(overrides, colorSrc));
  delete miniOv.hiddenSeries;
  delete miniOv.title; delete miniOv.commentPins; // a pin names ONE chart's point, not every mini's
  miniOv._smallMultiple = true;   // per-mini caption already names the period
  // A bottom legend on every small mini repeats the same categories N times and
  // crowds the tiny chart — rely on the on-slice labels instead (unless forced on).
  if (miniOv.showLegend === undefined) miniOv.showLegend = false;

  const charts = [];
  series.forEach((s, i) => {
    if (hidden.has(i)) return;
    const cell = document.createElement('div');
    cell.className = 'cv-sm-cell';
    const cap = document.createElement('div');
    cap.className = 'cv-sm-title';
    cap.textContent = s.name || ('Series ' + (i + 1));
    cell.appendChild(cap);
    const wrap = document.createElement('div');
    wrap.className = 'cv-canvas-wrap is-fresh';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', cap.textContent + ' chart');
    wrap.appendChild(canvas);
    cell.appendChild(wrap);
    grid.appendChild(cell);
    const c = buildChart(canvas, Object.assign({}, data, { series: [s], analytics: null }), type, miniOv);
    if (c) charts.push(c);
  });

  if (!charts.length) {
    container.innerHTML = '<div class="cv-chart-fallback">Couldn\'t draw a chart from this data.</div>';
    return;
  }
  chartInstances.set(container, charts);
  // One shared control cluster for the whole grid (no single canvas → null).
  addChartControls(controlsSlotFor(container) || chartWrapper, container, null, data, type, entry, turnIdx, overrideKey);
}

// Build a DOM turn element showing analysis + optional viz switcher for a result.
// entry + turnIdx are threaded through so renderVizInArea can attach the ⋯ menu.
// Step 2: the metrics OUR code computed from the AI's extracted numbers
// (result.metrics.selected). Plain list — fancy formatting is step 3. The lines
// are the engine's display-ready strings, so what shows == what was computed.
// Returns a DOM node or null when there's nothing to show.
function renderMetrics(result) {
  const metrics = result && result.metrics;
  const selected = metrics && Array.isArray(metrics.selected) ? metrics.selected : [];
  if (!selected.length) return null;

  const box = document.createElement('div');
  box.className = 'cv-metrics';
  const head = document.createElement('div');
  head.className = 'cv-metrics-head';
  head.textContent = 'Computed from the extracted data';
  box.appendChild(head);

  selected.forEach(m => {
    const card = document.createElement('div');
    card.className = 'cv-metric';
    const t = document.createElement('div');
    t.className = 'cv-metric-title';
    t.textContent = m.title || m.id;
    card.appendChild(t);
    const ul = document.createElement('ul');
    ul.className = 'cv-metric-lines';
    (m.lines || []).forEach(line => {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    });
    card.appendChild(ul);
    box.appendChild(card);
  });
  return box;
}

// Step 3: the highlighted headline paragraph — OUR prose with the engine's
// verified numbers bolded (result.headlineProse). Returns a DOM node or null.
function renderHeadline(result) {
  const prose = result && result.headlineProse;
  if (!prose || !Array.isArray(prose.segments) || !prose.segments.length) return null;
  const p = document.createElement('p');
  p.className = 'cv-headline';
  prose.segments.forEach(s => {
    if (s.bold) {
      const strong = document.createElement('strong');
      strong.textContent = s.text;
      p.appendChild(strong);
    } else {
      p.appendChild(document.createTextNode(s.text));
    }
  });
  return p;
}

// Step 3: collapsed "Show details" — the full computed-metric lists, moved out of
// the default view so it's available but not overwhelming. Returns node or null.
function renderDetails(result) {
  const metricsEl = renderMetrics(result);
  if (!metricsEl) return null;
  const det = document.createElement('details');
  det.className = 'cv-details';
  const sum = document.createElement('summary');
  sum.className = 'cv-details-summary';
  sum.textContent = 'Show details';
  det.appendChild(sum);
  det.appendChild(metricsEl);
  return det;
}

// Single source of truth for chip labels (production chips + the debug toggle).
// Chip display names — keep these consistent and conventional (orientation said
// once, "100% stacked <orientation>", maps disambiguated). Renaming only; which
// types are offered is decided by SHAPE_CHARTS/eligibility below.
const VIZ_LABELS = {
  column: 'Column', bar: 'Bar', clustered_column: 'Clustered column', clustered_bar: 'Clustered bar',
  stacked_column: 'Stacked column', stacked_bar: 'Stacked bar',
  pct_stacked_column: '100% stacked column', pct_stacked_bar: '100% stacked bar',
  line: 'Line', line_markers: 'Line with markers', area: 'Area', stacked_area: 'Stacked area',
  pie: 'Pie', donut: 'Donut', scatter: 'Scatter', gauge: 'Gauge',
  combo: 'Line + column', bubble: 'Bubble', treemap: 'Treemap', heatmap: 'Heatmap',
  funnel: 'Funnel', histogram: 'Histogram',
  sankey: 'Sankey', candlestick: 'Candlestick', boxplot: 'Box plot',
  waterfall: 'Waterfall', bullet: 'Bullet', calendar: 'Calendar heatmap', radar: 'Radar', pareto: 'Pareto',
  pivot: 'Pivot table', cohort: 'Cohort', event_funnel: 'Event funnel',
  table: 'Table', map_bubble: 'Bubble map', map_choropleth: 'Region map',
  word_cloud: 'Word cloud',
  map_hexbin: 'Hexbin map', map_flow: 'Flow map',
};

// Small monochrome glyph per chart type for the viz chips. currentColor so each icon
// inherits the chip's state color (muted → accent on hover → white when active).
//
// These 36 stay hand-drawn rather than moving into the icons.ts sprite: they
// are a CHART TAXONOMY, one mark per renderable type, not UI actions, and they
// are generated from this table alongside VIZ_LABELS. What they do take from
// the sprite is its geometry — 16px at stroke 1.5 with `class="ic"`, so a
// chart-type mark in a picker is the same weight and size as the plus beside
// it. They were 13px at 1.8, which is why they read heavier and smaller than
// every other icon on the same row.
const _vi = (inner) => '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true">' + inner + '</svg>';
const VIZ_ICONS = {
  column: _vi('<rect x="4" y="11" width="4" height="9" fill="currentColor"/><rect x="10" y="7" width="4" height="13" fill="currentColor"/><rect x="16" y="13" width="4" height="7" fill="currentColor"/>'),
  bar: _vi('<rect x="4" y="5" width="9" height="4" fill="currentColor"/><rect x="4" y="11" width="14" height="4" fill="currentColor"/><rect x="4" y="17" width="6" height="4" fill="currentColor"/>'),
  clustered_column: _vi('<rect x="4" y="10" width="2.6" height="10" fill="currentColor"/><rect x="7.2" y="7" width="2.6" height="13" fill="currentColor"/><rect x="14" y="12" width="2.6" height="8" fill="currentColor"/><rect x="17.2" y="9" width="2.6" height="11" fill="currentColor"/>'),
  clustered_bar: _vi('<rect x="4" y="5" width="10" height="2.6" fill="currentColor"/><rect x="4" y="8.2" width="13" height="2.6" fill="currentColor"/><rect x="4" y="14" width="7" height="2.6" fill="currentColor"/><rect x="4" y="17.2" width="11" height="2.6" fill="currentColor"/>'),
  stacked_column: _vi('<rect x="6" y="5" width="5" height="15" rx="0.5"/><line x1="6" y1="12" x2="11" y2="12"/><rect x="14" y="9" width="5" height="11" rx="0.5"/><line x1="14" y1="14" x2="19" y2="14"/>'),
  stacked_bar: _vi('<rect x="4" y="6" width="15" height="5" rx="0.5"/><line x1="11" y1="6" x2="11" y2="11"/><rect x="4" y="14" width="11" height="5" rx="0.5"/><line x1="9" y1="14" x2="9" y2="19"/>'),
  pct_stacked_column: _vi('<rect x="6" y="4" width="5" height="16" rx="0.5"/><line x1="6" y1="10" x2="11" y2="10"/><rect x="14" y="4" width="5" height="16" rx="0.5"/><line x1="14" y1="13" x2="19" y2="13"/>'),
  pct_stacked_bar: _vi('<rect x="4" y="6" width="16" height="5" rx="0.5"/><line x1="12" y1="6" x2="12" y2="11"/><rect x="4" y="14" width="16" height="5" rx="0.5"/><line x1="9" y1="14" x2="9" y2="19"/>'),
  line: _vi('<polyline points="3 17 9 11 13 14 21 6"/>'),
  line_markers: _vi('<polyline points="3 17 9 11 13 14 21 6"/><circle cx="3" cy="17" r="1.6" fill="currentColor"/><circle cx="9" cy="11" r="1.6" fill="currentColor"/><circle cx="13" cy="14" r="1.6" fill="currentColor"/><circle cx="21" cy="6" r="1.6" fill="currentColor"/>'),
  area: _vi('<path d="M3 17l6-5 4 2 8-7v15H3z" fill="currentColor"/>'),
  stacked_area: _vi('<path d="M3 18l6-3 4 2 8-4v7H3z" fill="currentColor"/><path d="M3 12l6-4 4 2 8-5v6l-8 4-4-2-6 3z" fill="currentColor" opacity="0.5"/>'),
  pie: _vi('<circle cx="12" cy="12" r="8"/><path d="M12 12V4"/><path d="M12 12l7 3.5"/>'),
  donut: _vi('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>'),
  gauge: _vi('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-4"/>'),
  scatter: _vi('<path d="M4 4v16h16"/><circle cx="9" cy="14" r="1.5" fill="currentColor"/><circle cx="13" cy="9" r="1.5" fill="currentColor"/><circle cx="17" cy="13" r="1.5" fill="currentColor"/><circle cx="11" cy="16" r="1.5" fill="currentColor"/>'),
  bubble: _vi('<path d="M4 4v16h16"/><circle cx="9" cy="14" r="2.4"/><circle cx="15.5" cy="9" r="3.2"/><circle cx="18" cy="15.5" r="1.6"/>'),
  combo: _vi('<rect x="5" y="12" width="3" height="8" fill="currentColor"/><rect x="11" y="9" width="3" height="11" fill="currentColor"/><rect x="17" y="13" width="3" height="7" fill="currentColor"/><path d="M5 9l6-3 6 4"/>'),
  treemap: _vi('<rect x="4" y="4" width="10" height="10" rx="0.5"/><rect x="15" y="4" width="5" height="6" rx="0.5"/><rect x="15" y="11" width="5" height="9" rx="0.5"/><rect x="4" y="15" width="10" height="5" rx="0.5"/>'),
  heatmap: _vi('<rect x="4" y="4" width="5" height="5"/><rect x="10" y="4" width="5" height="5" fill="currentColor"/><rect x="16" y="4" width="4" height="5"/><rect x="4" y="10" width="5" height="5" fill="currentColor"/><rect x="10" y="10" width="5" height="5"/><rect x="16" y="10" width="4" height="5" fill="currentColor"/><rect x="4" y="16" width="5" height="4"/><rect x="10" y="16" width="5" height="4" fill="currentColor"/><rect x="16" y="16" width="4" height="4"/>'),
  funnel: _vi('<path d="M4 5h16l-3 5H7z" fill="currentColor"/><path d="M7 12h10l-2 4H9z" fill="currentColor"/><path d="M9.5 18h5l-1 2h-3z" fill="currentColor"/>'),
  histogram: _vi('<path d="M4 4v16h16"/><rect x="4.5" y="14" width="3.6" height="6" fill="currentColor"/><rect x="8.2" y="10" width="3.6" height="10" fill="currentColor"/><rect x="11.9" y="7" width="3.6" height="13" fill="currentColor"/><rect x="15.6" y="11" width="3.6" height="9" fill="currentColor"/>'),
  sankey: _vi('<rect x="3" y="5" width="2.4" height="6" fill="currentColor"/><rect x="3" y="13" width="2.4" height="6" fill="currentColor"/><rect x="18.6" y="8" width="2.4" height="8" fill="currentColor"/><path d="M5.4 8c6 0 7 4 13 4"/><path d="M5.4 16c6 0 7-4 13-4"/>'),
  candlestick: _vi('<line x1="8" y1="4" x2="8" y2="20"/><rect x="6" y="8" width="4" height="7" fill="currentColor"/><line x1="16" y1="6" x2="16" y2="21"/><rect x="14" y="10" width="4" height="6"/>'),
  boxplot: _vi('<line x1="7" y1="4" x2="7" y2="20"/><rect x="4" y="9" width="6" height="7"/><line x1="4" y1="12.5" x2="10" y2="12.5"/><line x1="16" y1="6" x2="16" y2="20"/><rect x="13" y="10" width="6" height="6"/><line x1="13" y1="13" x2="19" y2="13"/>'),
  waterfall: _vi('<rect x="3" y="12" width="3.6" height="8" fill="currentColor"/><rect x="8" y="6" width="3.6" height="6" fill="currentColor"/><rect x="13" y="6" width="3.6" height="4"/><rect x="18" y="10" width="3.4" height="10" fill="currentColor"/><path d="M6.6 12H8M11.6 6H13M16.6 10H18"/>'),
  bullet: _vi('<rect x="3" y="4.5" width="18" height="6" fill="currentColor" opacity="0.3" stroke="none"/><rect x="3" y="6.5" width="11" height="2" fill="currentColor" stroke="none"/><line x1="16.5" y1="3.5" x2="16.5" y2="11.5"/><rect x="3" y="13.5" width="18" height="6" fill="currentColor" opacity="0.3" stroke="none"/><rect x="3" y="15.5" width="15" height="2" fill="currentColor" stroke="none"/><line x1="13" y1="12.5" x2="13" y2="20.5"/>'),
  calendar: _vi('<rect x="3" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/><rect x="3" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="3" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/><rect x="8.2" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="8.2" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/><rect x="8.2" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="13.4" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/><rect x="13.4" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="13.4" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/><rect x="18.6" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/><rect x="18.6" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>'),
  radar: _vi('<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/><path d="M12 7.5l4.6 3.1-1.4 5.4H9.4l-2.6-5z" fill="currentColor" opacity="0.45"/>'),
  pareto: _vi('<rect x="4" y="9" width="3.4" height="11" fill="currentColor" stroke="none"/><rect x="8.6" y="13" width="3.4" height="7" fill="currentColor" stroke="none"/><rect x="13.2" y="16" width="3.4" height="4" fill="currentColor" stroke="none"/><rect x="17.8" y="18" width="3.4" height="2" fill="currentColor" stroke="none"/><polyline points="5.7 8 10.3 5.2 14.9 4 19.5 3.4"/>'),
  table: _vi('<rect x="4" y="5" width="16" height="14" rx="1"/><line x1="4" y1="9.5" x2="20" y2="9.5"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="4" y1="14.5" x2="20" y2="14.5"/>'),
  pivot: _vi('<rect x="4" y="5" width="16" height="14" rx="1"/><rect x="4" y="5" width="16" height="4.5" fill="currentColor"/><rect x="4" y="9.5" width="5" height="9.5" fill="currentColor" opacity="0.35"/><line x1="9" y1="5" x2="9" y2="19"/><line x1="14.5" y1="5" x2="14.5" y2="19"/><line x1="4" y1="14.5" x2="20" y2="14.5"/>'),
  cohort: _vi('<path d="M4 4h16v4h-4v4h-4v4H8v4H4z"/><rect x="4" y="4" width="4" height="16" fill="currentColor"/><rect x="8" y="4" width="4" height="12" fill="currentColor" opacity="0.5"/>'),
  event_funnel: _vi('<rect x="4" y="4" width="16" height="3.5" rx="0.5" fill="currentColor"/><rect x="4" y="10.25" width="11" height="3.5" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="4" y="16.5" width="6" height="3.5" rx="0.5" fill="currentColor" opacity="0.45"/><path d="M20 9.5l-4 2M15 15.75l-4 2"/>'),
  map_bubble: _vi('<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="14" r="2.2" fill="currentColor"/>'),
  map_choropleth: _vi('<path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2z"/><path d="M9 4v14M15 6v14"/>'),
  word_cloud: _vi('<path d="M6 11h9" stroke-width="2.6"/><path d="M4 15.5h5M11.5 15.5h8"/><path d="M8 7h6M16.5 7h3M7 19.5h4M13.5 19.5h4.5" stroke-width="1.2"/><path d="M17 11h2.5" stroke-width="1.8"/>'),
  map_hexbin: _vi('<path d="M7.5 3.5 11 5.5v4L7.5 11.5 4 9.5v-4z" fill="currentColor"/><path d="M16.5 3.5 20 5.5v4l-3.5 2L13 9.5v-4z"/><path d="M12 11.5l3.5 2v4L12 19.5l-3.5-2v-4z" fill="currentColor" opacity="0.5"/>'),
  map_flow: _vi('<circle cx="5" cy="17" r="2" fill="currentColor"/><circle cx="19" cy="7" r="2" fill="currentColor"/><path d="M6.5 15.5C9 8 14 6 17.2 6.6"/><path d="M6.8 18.2C11 19 16 15.5 18.2 9"/>'),
};

// VERIFY/TEST ONLY: every wired chart type, ordered for a sensible click-through.
// Exposed as chips when localStorage 'scAllCharts' === '1'. Default off.
const ALL_CHART_TYPE_IDS = [
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'scatter', 'gauge', 'combo', 'bubble',
  'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
  'waterfall', 'bullet', 'calendar', 'radar', 'pareto',
  // A pivot draws from the SAME `visual:data` reply as every id above it, so it
  // belongs in the one list every picker pools from — even though the thing it
  // draws is a <table>, like 'table' and unlike the other thirty.
  'pivot',
  // Their own shelves, like the pivot's; picked from "+ More" (cohortBuilder.ts).
  'cohort', 'event_funnel',
  'word_cloud',
];

// PART 1: CODE-DRIVEN eligibility. dataShape (still returned by the AI) + the real
// data structure decide which chips appear — NOT the AI's visualizations list.
// Each shape's list is best-first, so the first eligible entry is the default.
const SHAPE_CHARTS = {
  time_series:   ['line', 'line_markers', 'area', 'stacked_area', 'column', 'clustered_column', 'combo', 'heatmap', 'calendar', 'pivot', 'table'],
  part_to_whole: ['pie', 'donut', 'treemap', 'pct_stacked_column', 'pct_stacked_bar', 'stacked_column', 'funnel', 'pareto', 'pivot', 'table'],
  categorical:   ['column', 'bar', 'clustered_column', 'clustered_bar', 'heatmap', 'pareto', 'waterfall', 'bullet', 'radar', 'pivot', 'table', 'word_cloud'],
  single_metric: ['gauge', 'table'],
  matrix:        ['heatmap', 'pivot', 'table'],
  unstructured:  ['table'],
};

// Minimum series a type needs to be meaningful; everything else needs >= 1.
const CHART_SERIES_MIN = {
  clustered_column: 2, clustered_bar: 2, stacked_column: 2, stacked_bar: 2,
  pct_stacked_column: 2, pct_stacked_bar: 2, stacked_area: 2, combo: 2,
  scatter: 2, bubble: 3, heatmap: 2,
  radar: 3, // three measures is the first polygon; axes are measures
};

// Maximum series for types that ONLY make sense single-series. A plain column/bar
// with 2+ series renders identically to its clustered_* sibling (a multi-series
// column IS a clustered column), so we cap it at 1 — otherwise two chips draw the
// same chart and "Column" mislabels a grouped one. With 1 series the clustered_*
// entries are hidden by CHART_SERIES_MIN, so each chip's name always matches what
// is drawn: 1 series -> Column/Bar, 2+ series -> Clustered column/Clustered bar.
// The five newer families read a fixed number of series (value + target, the
// two ends of a bridge, one day's figure, six radar axes), so they are only
// SUGGESTED where the data has that shape.
// A word cloud reads a size measure and, optionally, a colour (sentiment) one.
const CHART_SERIES_MAX = { column: 1, bar: 1, pareto: 1, calendar: 1, waterfall: 2, bullet: 2, radar: 6, word_cloud: 2 };

// Minimum labels (categories) a type needs to be meaningful; everything else >= 1.
// A radar normalises each axis by its largest value, so ONE category is always
// a regular polygon — it needs two to compare.
const CHART_LABELS_MIN = {
  pie: 2, donut: 2, treemap: 2, heatmap: 2, funnel: 3,
  pareto: 2, waterfall: 2, radar: 2, calendar: 7,
  word_cloud: 3,
};

// Pure: which of a shape's chart ids the actual data can support, best-first.
function eligibleChartTypes(dataShape, seriesCount, labelCount) {
  const base = SHAPE_CHARTS[dataShape] || SHAPE_CHARTS.unstructured;
  return base.filter(type => {
    // A table and a pivot render ANY shape — there is no series or label
    // minimum that stops a grid from being a legible grid.
    if (type === 'table' || type === 'pivot') return true;
    if (seriesCount < (CHART_SERIES_MIN[type] || 1)) return false;
    if (seriesCount > (CHART_SERIES_MAX[type] || Infinity)) return false;
    if (labelCount < (CHART_LABELS_MIN[type] || 1)) return false;
    return true;
  });
}

/**
 * Can `type` physically draw THIS data? The one rule, module-level so it has one
 * home rather than one per caller.
 *
 * It used to live only inside buildVizPicker, where the chip row needs it. But
 * vizBuilder.ts needs the same answer for a different and more consequential
 * question — whether a REOPENED visual keeps the chart type its author chose —
 * and had its own `canShow()`, a hand-written list returning true for exactly
 * `table`, `map_bubble` and `map_choropleth`. Every other saved type survived
 * reopening only by also being in `recommended`.
 *
 * That silently downgraded saved work. `gauge` is recommended for the
 * `single_metric` shape alone, so a gauge saved over a categorical encoding came
 * back as a column — and saving again wrote `column` to disk, losing the type.
 * A gauge sets neither CHART_SERIES_MIN nor CHART_LABELS_MIN, so by the real
 * rule one series and one label were always enough for it to draw.
 *
 * Deliberately NOT consulting CHART_SERIES_MAX. That cap exists so the chip row
 * cannot offer both "Column" and "Clustered column" for the same 2-series data
 * and mislabel one of them; it is about which types to SUGGEST, not which can
 * draw. A saved single-series column that later gained a measure still renders,
 * and honouring the author's choice beats renaming it for them.
 */
function chartCanRender(type, data, hasGeo) {
  // A cohort / event funnel draws its own "pick a column" state when its shelves are empty.
  if (type === 'table' || type === 'pivot' || type === 'cohort' || type === 'event_funnel') return true;
  if (isMapChartType(type)) return !!hasGeo && geoMapFits(type, (data && data.geo) || {});
  const d = data || {};
  if (countNumericSeries(d) < (CHART_SERIES_MIN[type] || 1)) return false;
  if (((d.labels || []).length) < (CHART_LABELS_MIN[type] || 1)) return false;
  return true;
}

// Count series that actually carry at least one number.
function countNumericSeries(data) {
  if (!data || !Array.isArray(data.series)) return 0;
  return data.series.filter(s => Array.isArray(s.values) && s.values.some(v => typeof v === 'number')).length;
}

// Shared chart-type picker: the chip row + "+ More" three-tier panel (Recommended /
// Selected / Other charts). Used by BOTH the main result view and the export dialog so
// they stay identical and in sync. The caller passes onSelect(type, info) to actually
// render the chosen type (info = { canRender, suited, needs }); the picker owns the chip
// row, the three-tier panel, and selection state.
//   opts: { recommended:[type], pool:[type], data, hasGeo, initial, initialSelected:[type],
//           onSelect(type,info), onPersist(type)? }
//   returns { switcher, select(type), getSelected(), getExtras() }
function buildVizPicker(opts) {
  const recommended = opts.recommended || [];
  const pool = opts.pool || [];
  const data = opts.data || {};
  const hasGeo = !!opts.hasGeo;
  const onSelect = opts.onSelect || function () {};
  const onPersist = opts.onPersist || null;

  const switcher = document.createElement('div');
  switcher.className = 'cv-viz-switcher';
  const suitedSet = new Set(recommended);                   // the auto-suggested chips
  const selectedOthers = new Set(opts.initialSelected || []); // non-suited types pulled into "Selected"
  const numSeries = countNumericSeries(data);
  const numLabels = (data.labels || []).length;
  const isMapType = isMapChartType;
  const fallbackType = recommended[0] || opts.initial;
  let selectedType = opts.initial;
  let morePanel = null;

  // Can `type` physically render with THIS data? Shape-agnostic, so "+ More" can
  // offer any type. Delegates to the module-level rule — vizBuilder.ts asks the
  // same question when deciding whether a reopened visual keeps its saved type,
  // and two answers to one question is how a saved gauge came back as a column.
  function canRenderType(type) {
    return chartCanRender(type, data, hasGeo);
  }
  // Plain-language "what it needs" for the can't-render message.
  function needsText(type) {
    const parts = [];
    const ns = CHART_SERIES_MIN[type] || 1, nl = CHART_LABELS_MIN[type] || 1;
    if (isMapType(type) && !chartCanRender(type, data, hasGeo)) parts.push(geoNeedsText(type, hasGeo));
    if (numSeries < ns) parts.push(`at least ${ns} numeric series`);
    if (numLabels < nl) parts.push(`at least ${nl} categories`);
    return parts.join(' and ') || 'different data';
  }
  function makeChip(type) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cv-viz-chip';
    chip.dataset.type = type;
    chip.innerHTML = VIZ_ICONS[type] || '';                 // trusted static SVG strings
    chip.appendChild(document.createTextNode(VIZ_LABELS[type] || type));  // label as text
    chip.setAttribute('aria-label', VIZ_LABELS[type] || type);
    chip.addEventListener('click', () => select(type, chip));
    return chip;
  }
  function select(type, chip?) {
    chip = chip || switcher.querySelector('.cv-viz-chip[data-type="' + type + '"]');
    selectedType = type;
    switcher.querySelectorAll('.cv-viz-chip').forEach(c => c.classList.remove('active'));
    if (chip) chip.classList.add('active');
    if (onPersist) onPersist(type);
    onSelect(type, { canRender: canRenderType(type), suited: suitedSet.has(type), needs: needsText(type) });
  }
  function pickType(type) {
    closeMorePanel();
    if (canRenderType(type) && !switcher.querySelector('.cv-viz-chip[data-type="' + type + '"]')) {
      switcher.insertBefore(makeChip(type), moreBtn);
    }
    if (canRenderType(type) && !suitedSet.has(type)) selectedOthers.add(type);
    select(type);
  }
  function removeSelected(type) {
    selectedOthers.delete(type);
    const chip = switcher.querySelector('.cv-viz-chip[data-type="' + type + '"]');
    if (chip) chip.remove();
    if (selectedType === type) select(fallbackType);
    if (morePanel) { closeMorePanel(); openMorePanel(); }
  }
  function closeMorePanel() {
    if (!morePanel) return;
    morePanel.remove(); morePanel = null;
    document.removeEventListener('click', onMoreDocClick, true);
  }
  function onMoreDocClick(e) {
    if (morePanel && !morePanel.contains(e.target) && e.target !== moreBtn) closeMorePanel();
  }
  function openMorePanel() {
    if (morePanel) { closeMorePanel(); return; }
    morePanel = document.createElement('div');
    morePanel.className = 'cv-more-panel';
    // Three tiers — a type lives in exactly one: Recommended (auto-suited),
    // Selected (pulled in from Other), or Other (not yet added).
    const groups = [
      { label: 'Recommended', types: recommended },
      { label: 'Selected', types: pool.filter(t => selectedOthers.has(t)), selected: true },
      { label: 'Other charts', types: pool.filter(t => !suitedSet.has(t) && !selectedOthers.has(t)) },
    ];
    groups.forEach(g => {
      if (!g.types.length) return;
      const gl = document.createElement('div');
      gl.className = 'cv-more-group-label';
      gl.textContent = g.label;
      morePanel.appendChild(gl);
      const grid = document.createElement('div');
      grid.className = 'cv-more-grid';
      g.types.forEach(type => {
        const it = document.createElement('button');
        it.type = 'button';
        const fits = canRenderType(type);
        const tier = g.selected ? ' is-selected' : (suitedSet.has(type) ? '' : ' is-other');
        it.className = 'cv-more-item' + tier + (fits ? '' : ' is-unfit');
        it.innerHTML = VIZ_ICONS[type] || '';
        it.appendChild(document.createTextNode(VIZ_LABELS[type] || type));
        if (!fits) it.title = 'Needs ' + needsText(type);
        it.addEventListener('click', (e) => { e.stopPropagation(); pickType(type); });
        if (g.selected) {
          const rm = document.createElement('span');
          rm.className = 'cv-more-remove';
          rm.textContent = '×';
          rm.title = 'Remove';
          rm.setAttribute('aria-label', 'Remove ' + (VIZ_LABELS[type] || type));
          rm.addEventListener('click', (e) => { e.stopPropagation(); removeSelected(type); });
          it.appendChild(rm);
        }
        grid.appendChild(it);
      });
      morePanel.appendChild(grid);
    });
    document.body.appendChild(morePanel);
    // Anchor under the + More button, clamped to the viewport.
    const r = moreBtn.getBoundingClientRect();
    let left = r.left;
    const pw = morePanel.offsetWidth;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    morePanel.style.top = (r.bottom + 6) + 'px';
    morePanel.style.left = left + 'px';
    setTimeout(() => document.addEventListener('click', onMoreDocClick, true), 0);
  }

  // Recommended chips
  recommended.forEach(type => {
    const chip = makeChip(type);
    if (type === selectedType) chip.classList.add('active');
    switcher.appendChild(chip);
  });
  // Pre-populated "Selected" chips (e.g. export carry-over) + a restored exploratory
  // initial type, so the selection survives re-render and reads as a chip.
  if (selectedType && !suitedSet.has(selectedType) && canRenderType(selectedType)) selectedOthers.add(selectedType);
  selectedOthers.forEach(type => {
    if (suitedSet.has(type) || !canRenderType(type)) return;
    if (switcher.querySelector('.cv-viz-chip[data-type="' + type + '"]')) return;
    const chip = makeChip(type);
    if (type === selectedType) chip.classList.add('active');
    switcher.appendChild(chip);
  });

  // + More — opens the all-charts picker.
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'cv-viz-more';
  moreBtn.textContent = '+ More';
  moreBtn.setAttribute('aria-label', 'More chart types');
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMorePanel(); });
  switcher.appendChild(moreBtn);

  return {
    switcher,
    select,
    getSelected: () => selectedType,
    getExtras: () => Array.from(selectedOthers),
  };
}

function renderTurnResult(result, activeVizType, entry, turnIdx) {
  const el = document.createElement('div');
  el.className = 'cv-turn';

  const analysis = document.createElement('p');
  analysis.className = 'cv-analysis-text';
  analysis.textContent = result.analysis || '';
  el.appendChild(analysis);

  // Step 3: highlighted headline (our prose, verified numbers bolded) up top.
  const headlineEl = renderHeadline(result);
  if (headlineEl) el.appendChild(headlineEl);

  const { data, visualizations, geo } = result;
  // Attach geo + dataShape to data so map renderers can build per-period (time-series) maps
  const vizData = geo ? Object.assign({}, data, { geo, dataShape: result.dataShape }) : data;

  const hasData = data && Array.isArray(data.labels) && data.labels.length > 0
    && Array.isArray(data.series) && data.series.some(s => Array.isArray(s.values) && s.values.length > 0);
  const hasGeo  = geo && Array.isArray(geo.items) && geo.items.length > 0;

  if (hasData || hasGeo) {
    const add = (list, type) => { if (type && !list.find(x => x.type === type)) list.push({ type, label: VIZ_LABELS[type] || type }); };
    let vizList = [];
    const debugAll = hasData && localStorage.getItem('scAllCharts') === '1';
    if (debugAll) {
      // VERIFY/TEST override: show every wired chart type (localStorage 'scAllCharts').
      ALL_CHART_TYPE_IDS.forEach(t => add(vizList, t));
    } else {
      // Charts FIRST (chosen by CODE from dataShape + the real data structure) so a
      // chart — never the map — is the default chip.
      if (hasData) {
        eligibleChartTypes(result.dataShape, countNumericSeries(data), (data.labels || []).length)
          .forEach(t => add(vizList, t));
      }
      // Maps come from the AI's geo payload, appended AFTER charts (never first).
      if (hasGeo) {
        (Array.isArray(visualizations) ? visualizations : [])
          .filter(v => v && (v.type === 'map_bubble' || v.type === 'map_choropleth'))
          .forEach(v => add(vizList, v.type));
      }
    }
    // Always offer the raw table when there's series data.
    if (hasData) add(vizList, 'table');
    if (vizList.length > 0) {
      // Default chip: never a map. Prefer the AI's recommended type (tiebreaker) if it's a
      // non-map type that survived eligibility; otherwise the first non-map chip.
      const isMapType = t => t === 'map_bubble' || t === 'map_choropleth';
      const aiRecType = (Array.isArray(visualizations) ? (visualizations.find(v => v && v.recommended) || {}).type : null);
      const firstNonMap = (vizList.find(v => !isMapType(v.type)) || vizList[0]).type;
      const defaultType = (aiRecType && !isMapType(aiRecType) && vizList.find(v => v.type === aiRecType))
        ? aiRecType : firstNonMap;
      const currentType = activeVizType || defaultType;

      const vizArea = document.createElement('div');
      vizArea.className = 'cv-viz-area';
      const isChartable = (t) => t !== 'table' && !isMapType(t);

      // The chip row + "+ More" three-tier picker (shared with the export dialog).
      const picker = buildVizPicker({
        recommended: vizList.map(v => v.type),
        pool: ALL_CHART_TYPE_IDS.concat(['table'], MAP_CHART_TYPES),
        data, hasGeo, initial: currentType,
        onPersist: (type) => {
          if (!entry) return;
          if (turnIdx === 'main') entry.activeVizType = type;
          else if (entry.turns && entry.turns[turnIdx]) entry.turns[turnIdx].activeVizType = type;
        },
        onSelect: (type, info) => {
          if (!info.canRender) {
            // Physically can't draw → friendly message, not a broken/empty chart.
            vizArea.innerHTML = '';
            const m = document.createElement('div');
            m.className = 'cv-chart-fallback';
            m.textContent = (VIZ_LABELS[type] || type) + ' needs ' + info.needs + " — it doesn't fit this data.";
            vizArea.appendChild(m);
            return;
          }
          renderVizInArea(vizArea, vizData, type, entry, turnIdx);
          // Soft, non-blocking note when the user explores beyond the suggested set.
          if (!info.suited && isChartable(type)) {
            const note = document.createElement('div');
            note.className = 'cv-fit-note';
            note.textContent = 'This chart may not be the best fit for this data.';
            vizArea.appendChild(note);
          }
        },
      });
      const switcher = picker.switcher;

      // Export report — carries over the current selection + the user's "Selected" charts.
      // Exportable = charts AND maps (maps capture via capturePage); only the raw table
      // can't become a report image.
      const isExportable = (t) => t !== 'table';
      const exportableTypes = vizList.filter(v => isExportable(v.type));
      if (exportableTypes.length) {
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'cv-export-btn';
        exportBtn.innerHTML =
          '<svg class="cv-export-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
          'aria-hidden="true" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>' +
          '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>' +
          '<span>Export report</span>';
        exportBtn.addEventListener('click', () => {
          const sel = picker.getSelected();
          openExportDialog({
            recommended: exportableTypes.map(c => c.type),
            selectedExtra: picker.getExtras().filter(isExportable),
            current: isExportable(sel) ? sel : exportableTypes[0].type,
            vizData, entry, turnIdx, hasGeo,
            analysis: result.analysis || '',
            title: result.title || '',
            headlineSegments: (result.headlineProse && result.headlineProse.segments) || [],
          });
        });
        switcher.appendChild(exportBtn);
      }

      el.appendChild(switcher);
      el.appendChild(vizArea);
      requestAnimationFrame(() => picker.select(currentType));
    }
  }

  // Step 3: full computed-metric detail, collapsed by default.
  const detailsEl = renderDetails(result);
  if (detailsEl) el.appendChild(detailsEl);

  return el;
}
