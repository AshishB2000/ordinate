// Live chart thumbnails for the Visuals gallery cards. Classic global-scope
// renderer <script>: no import/export. Loads BEFORE vizGallery.js (see
// index.html), which calls vizThumbsReset()/vizThumbObserve(); buildChart comes
// from chartRender.js and currentProjectId from workspace.js, both shared
// top-level globals.
//
// THUMBNAILS ARE RENDERED LIVE, NEVER STORED. A visual record is metadata-only
// (CLAUDE.md) — persisting a preview image would be a new storage decision, so
// each card renders a small real chart from live data at gallery paint time,
// exactly like dashboard cards do: getVisual → the same visual:data channel the
// dash grid uses (computeVisualData, resident fast path in main) → buildChart.
//
// Deliberate exclusions: MAP types keep the card glyph (MapLibre needs WebGL2
// and the visible window — never render map thumbs) and TABLE visuals keep the
// glyph (a shrunken table is unreadable). ANY fetch or render failure falls
// back to the glyph silently — a broken card is worse than a plain one.
//
// Perf: thumbnails render lazily (IntersectionObserver, small concurrency cap)
// and every Chart instance is tracked in vizThumbCharts and destroyed by
// vizThumbsReset() before the gallery repaints — the same discipline as
// chartRender.ts's chartInstances WeakMap, made explicit here because a repaint
// discards the DOM nodes and a WeakMap alone would leave the charts' RAF/resize
// hooks alive until GC. No leaks across repeated section switches.

const VIZ_THUMB_SKIP = new Set(['table', 'map_bubble', 'map_choropleth']);
const VIZ_THUMB_CONCURRENCY = 3;

let vizThumbObserver: IntersectionObserver | null = null;
let vizThumbQueue: HTMLElement[] = [];
let vizThumbActive = 0;
// tile → the visual SUMMARY it should render (id/chartType/datasetId — the
// encoding is fetched on demand, the summary deliberately doesn't carry it).
const vizThumbVisual = new WeakMap<HTMLElement, any>();
// Every live thumbnail chart, so reset can destroy them all.
const vizThumbCharts = new Set<any>();

// Can this chart type be thumbnailed at all? (Exclusions in the header.)
function vizThumbEligible(chartType: string): boolean {
  return Boolean(chartType) && !VIZ_THUMB_SKIP.has(chartType);
}

// Called by refreshVisualList BEFORE it clears #viz-grid: destroy every live
// thumbnail chart and drop all pending work, so a repaint never leaks canvases
// or renders into a detached tile.
function vizThumbsReset(): void {
  vizThumbCharts.forEach((c) => { try { c.destroy(); } catch (_) { /* torn down already */ } });
  vizThumbCharts.clear();
  if (vizThumbObserver) vizThumbObserver.disconnect();
  vizThumbQueue = [];
}

// Register a card tile for a lazy thumbnail. Ineligible types are not observed
// at all — their glyph IS the presentation.
function vizThumbObserve(tile: HTMLElement, v: any): void {
  if (!tile || !vizThumbEligible(String((v && v.chartType) || ''))) return;
  vizThumbVisual.set(tile, v);
  if (!vizThumbObserver) {
    vizThumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        vizThumbObserver!.unobserve(e.target);
        vizThumbQueue.push(e.target as HTMLElement);
      }
      vizThumbPump();
    }, { rootMargin: '160px' });
  }
  vizThumbObserver.observe(tile);
}

// Drain the queue, at most VIZ_THUMB_CONCURRENCY renders in flight — each one
// is two IPC round-trips, and a burst of twenty at once would contend with the
// gallery paint itself.
function vizThumbPump(): void {
  while (vizThumbActive < VIZ_THUMB_CONCURRENCY && vizThumbQueue.length) {
    const tile = vizThumbQueue.shift() as HTMLElement;
    vizThumbActive += 1;
    vizThumbRender(tile).catch(() => { /* glyph stays */ }).then(() => {
      vizThumbActive -= 1;
      vizThumbPump();
    });
  }
}

async function vizThumbRender(tile: HTMLElement): Promise<void> {
  const v = vizThumbVisual.get(tile);
  const projectId = currentProjectId;
  if (!v || !projectId || !tile.isConnected) return;

  // The same two channels the card's Export and the dashboard grid use: load
  // the record (the summary has no encoding), have MAIN compute the data.
  const visual = await window.hub.getVisual(projectId, String(v.id));
  if (!visual || !tile.isConnected) return;
  const res = await window.hub.computeVisualData(
    projectId, String(visual.datasetId || ''), visual.encoding, visual.filters || []);
  // Repaints/section switches race this fetch: a stale tile or a switched
  // project just drops the result on the floor.
  if (!res || res.ok === false || !res.data || !tile.isConnected || currentProjectId !== projectId) return;

  const host = document.createElement('span');
  host.className = 'viz-thumb';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true'); // decoration — the card's name/meta carry the semantics
  host.appendChild(canvas);
  tile.appendChild(host);

  // The visual's own saved overrides (colour, sort, …) so the thumb previews
  // what actually opens, then the thumbnail presentation forced on top:
  // no animation (paint the final frame), no legend, no gridlines, no value
  // labels, no title. Chart.js picks up devicePixelRatio itself, so the canvas
  // is crisp on retina without an explicit override.
  const stored = visual.overrides && typeof visual.overrides === 'object' ? visual.overrides : {};
  const overrides = Object.assign({}, stored, {
    noAnimate: true, showLegend: false, showGridlines: false, valueMode: 'off', title: '',
  });
  const chart = buildChart(canvas, res.data, String(visual.chartType || v.chartType || 'column'), overrides);
  if (!chart) { host.remove(); return; } // undrawable data — the glyph stays

  vizThumbTrim(chart);
  vizThumbCharts.add(chart);
  tile.classList.add('viz-card-tile--thumb'); // CSS hides the glyph under the thumb
}

// Post-build trim to the thumbnail presentation buildChart's overrides can't
// express: axis ticks/titles off and no pointer events (tooltips/hover). A
// call-site adjustment on the returned instance, NOT a change to buildChart —
// chartRender.ts is allowlisted at exactly 999 lines and must not grow.
function vizThumbTrim(chart: any): void {
  try {
    const o = chart.options || {};
    o.events = []; // a thumbnail is inert — no hover, no tooltip work
    if (o.plugins && o.plugins.tooltip) o.plugins.tooltip.enabled = false;
    const scales = o.scales || {};
    Object.keys(scales).forEach((k) => {
      const s = scales[k];
      if (!s) return;
      s.ticks = Object.assign({}, s.ticks, { display: false });
      s.grid = Object.assign({}, s.grid, { display: false, drawOnChartArea: false });
      s.border = Object.assign({}, s.border, { display: false });
      if (s.title) s.title.display = false;
    });
    chart.update('none');
  } catch (_) { /* the un-trimmed thumb still renders — never break the card */ }
}
