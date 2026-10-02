'use strict';

// "As of" — view a dashboard or a chart against a kept snapshot time, and a
// metric's value across its snapshots. Classic global-scope renderer <script>:
// no import/export. Loads after snapshots.js (snapEl / snapWhen).
//
// VIEW STATE ONLY. The chosen time lives in two variables here, is sent along
// with each read (src/data/asOf.ts resolves every dataset as of it in main), is
// never saved with the dashboard or the visual, and goes back to Latest every
// time a dashboard or the builder opens. The pickers are built here, at load,
// and put in the two headers; the surfaces that read data call the wrappers
// below (one-line hooks in dashGrid.ts, dashFiltersUi.ts, drill.ts, kpiCompare.ts
// and vizBuilder.ts).

/** The open dashboard's time (ISO), or null for Latest. */
let snapDashAsOf: string | null = null;
/** The visual builder's time (ISO), or null for Latest. */
let snapVizAsOf: string | null = null;
/** The dataset the builder's picker was filled for. */
let snapVizDataset = '';
/** The datasets and metrics the open dashboard has asked about — its picker's scope. */
const snapDashSeen = { datasets: new Set<string>(), metrics: new Set<string>() };
let snapDashTimer = 0;

function snapPicker(id: string): { wrap: HTMLLabelElement; sel: HTMLSelectElement } {
  const wrap = snapEl<HTMLLabelElement>('label', 'snap-asof');
  wrap.id = id + '-wrap';
  wrap.hidden = true;
  wrap.appendChild(snapEl('span', 'snap-asof-label', 'As of'));
  const sel = snapEl<HTMLSelectElement>('select', 'snap-asof-select');
  sel.id = id;
  sel.setAttribute('aria-label', 'Show the data as of');
  const latest = snapEl<HTMLOptionElement>('option', '', 'Latest');
  latest.value = '';
  sel.appendChild(latest);
  wrap.appendChild(sel);
  return { wrap, sel };
}

/** Refill a picker from `snapshots:stamps`, keeping the choice. Hidden when there is nothing to pick. */
async function snapFill(wrap: HTMLElement, sel: HTMLSelectElement, datasetIds: string[], metricIds: string[]): Promise<void> {
  if (!currentProjectId || !window.hubSnapshots) return;
  let r: any = null;
  try { r = await window.hubSnapshots.stamps(currentProjectId, datasetIds, metricIds); } catch (_) { r = null; }
  const items: any[] = r && r.ok && Array.isArray(r.items) ? r.items : [];
  const keep = sel.value;
  sel.length = 1; // Latest stays
  const many = datasetIds.length + metricIds.length > 1;
  const labels = snapWhenAll(items.map((it) => it.at));
  for (const [i, it] of items.entries()) {
    const o = snapEl<HTMLOptionElement>('option', '', labels[i] + (many ? ' — ' + it.datasets.join(', ') : ''));
    o.value = it.at;
    sel.appendChild(o);
  }
  if (keep && !items.some((it) => it.at === keep)) {
    const o = snapEl<HTMLOptionElement>('option', '', snapWhen(keep));
    o.value = keep;
    sel.appendChild(o);
  }
  sel.value = keep;
  wrap.hidden = items.length === 0 && !keep;
}

// ── The dashboard ────────────────────────────────────────────────────────────

const snapDash = snapPicker('dash-asof');

function snapDashRefill(): void {
  window.clearTimeout(snapDashTimer);
  snapDashTimer = window.setTimeout(() => {
    void snapFill(snapDash.wrap, snapDash.sel, [...snapDashSeen.datasets], [...snapDashSeen.metrics]);
  }, 250);
}

function snapDashSet(v: string | null): void {
  snapDashAsOf = v || null;
  snapDash.sel.value = snapDashAsOf || '';
  snapDash.wrap.classList.toggle('is-on', Boolean(snapDashAsOf));
  document.getElementById('dash-editor')?.classList.toggle('is-asof', Boolean(snapDashAsOf));
}

(function snapMountDash(): void {
  const editor = document.getElementById('dash-editor');
  const anchor = document.getElementById('dash-refresh-data');
  if (!editor || !anchor) return;
  anchor.after(snapDash.wrap);
  snapDash.sel.addEventListener('change', () => {
    snapDashSet(snapDash.sel.value);
    renderDashGrid();
  });
  // Closing a dashboard puts it back on Latest and forgets its datasets, so the
  // next one opens on Latest with a scope its own reads fill. (On CLOSE, not
  // open: the cards may already be reading by the time the editor is shown.)
  new MutationObserver(() => {
    if (!editor.hidden) return;
    snapDashSet(null);
    snapDashSeen.datasets.clear();
    snapDashSeen.metrics.clear();
    snapDash.wrap.hidden = true;
  }).observe(editor, { attributes: true, attributeFilter: ['hidden'] });
})();

function snapSeeDataset(id: string): void {
  if (id && !snapDashSeen.datasets.has(id)) { snapDashSeen.datasets.add(id); snapDashRefill(); }
}

/** A dashboard card's chart data — `visual:data`, as of the picker's time. */
function snapVisualData(projectId: string, datasetId: string, encoding: any, filters: any, params: any, analytics?: any): Promise<any> {
  snapSeeDataset(datasetId);
  const fx = fxDashRead('visualData', { projectId, datasetId, encoding, filters, params, analytics, asOf: snapDashAsOf || undefined }); // fxUi.ts
  if (fx) return fx;
  return snapDashAsOf && window.hubSnapshots
    ? window.hubSnapshots.visualData(projectId, datasetId, encoding, filters, params, snapDashAsOf, analytics)
    : window.hub.computeVisualData(projectId, datasetId, encoding, filters, params, analytics);
}

/** A dashboard metric card naming a saved Metric — `metric:value`, as of the picker's time. */
function snapMetricValue(projectId: string, metricId: string, filters: any, params: any): Promise<any> {
  if (metricId && !snapDashSeen.metrics.has(metricId)) { snapDashSeen.metrics.add(metricId); snapDashRefill(); }
  const fx = fxDashRead('metricValue', { projectId, id: metricId, filters, params, asOf: snapDashAsOf || undefined }); // fxUi.ts
  if (fx) return fx;
  return snapDashAsOf && window.hubSnapshots
    ? window.hubSnapshots.metricValue(projectId, metricId, filters, params, snapDashAsOf)
    : window.hub.metricValue(projectId, metricId, filters, params);
}

/** A dashboard metric card over a column — `dashboard:metric`, as of the picker's time. */
function snapComputeMetric(projectId: string, datasetId: string, column: string, aggregation: string, filters: any, params: any): Promise<any> {
  snapSeeDataset(datasetId);
  const fx = fxDashRead('computeMetric', { projectId, datasetId, column, aggregation, filters, params, asOf: snapDashAsOf || undefined }); // fxUi.ts
  if (fx) return fx;
  return snapDashAsOf && window.hubSnapshots
    ? window.hubSnapshots.computeMetric(projectId, datasetId, column, aggregation, filters, params, snapDashAsOf)
    : window.hub.computeMetric(projectId, datasetId, column, aggregation, filters, params);
}

// ── The visual builder ───────────────────────────────────────────────────────

const snapViz = snapPicker('viz-asof');

(function snapMountViz(): void {
  const builder = document.getElementById('viz-builder');
  const anchor = document.getElementById('viz-dataset-select');
  if (!builder || !anchor) return;
  anchor.after(snapViz.wrap);
  snapViz.sel.addEventListener('change', () => {
    snapVizAsOf = snapViz.sel.value || null;
    snapViz.wrap.classList.toggle('is-on', Boolean(snapVizAsOf));
    void recomputeVisual();
  });
  new MutationObserver(() => {
    if (!builder.hidden) return; // on close — the next open refills from its first draw
    snapVizAsOf = null;
    snapVizDataset = '';
    snapViz.sel.value = '';
    snapViz.wrap.classList.remove('is-on');
    snapViz.wrap.hidden = true;
  }).observe(builder, { attributes: true, attributeFilter: ['hidden'] });
})();

/**
 * The builder's chart as of the picker's time, or null on Latest (the builder's
 * own preview path runs). A new dataset puts the picker back on Latest.
 */
function snapVizData(projectId: string, datasetId: string, encoding: any, filters: any, analytics?: any): Promise<any> | null {
  if (datasetId !== snapVizDataset) {
    snapVizDataset = datasetId;
    snapVizAsOf = null;
    snapViz.sel.value = '';
    snapViz.wrap.classList.remove('is-on');
    void snapFill(snapViz.wrap, snapViz.sel, datasetId ? [datasetId] : [], []);
  }
  return snapVizAsOf && window.hubSnapshots
    ? window.hubSnapshots.visualData(projectId, datasetId, encoding, filters, null, snapVizAsOf, analytics)
    : null;
}

// ── A metric across its snapshots (the metric editor) ────────────────────────

/** "How the number changed as data arrived": the metric on each snapshot, then now. */
function snapMetricHistory(metricId: string): HTMLElement {
  const sec = snapEl('div', 'snap-mh');
  sec.appendChild(snapEl('div', 'snap-mh-h', 'Across snapshots'));
  const note = snapEl('p', 'snap-mh-note', 'Loading…');
  const area = snapEl('div', 'snap-mh-chart');
  area.hidden = true;
  sec.append(note, area);
  void (async () => {
    let r: any = null;
    try { r = await window.hubSnapshots.metricHistory(currentProjectId, metricId); } catch (_) { r = null; }
    const points: any[] = r && r.ok && Array.isArray(r.points) ? r.points : [];
    if (points.length < 2) {
      note.textContent = 'No snapshots yet. Each time this metric’s dataset refreshes with snapshots on, its value is plotted here.';
      return;
    }
    note.textContent = 'How the number changed as data arrived — the value on each kept snapshot, then now.';
    area.hidden = false;
    // Drawn once mounted (buildChart reads its theme off the canvas); an editor
    // closed before the reply came back simply draws nothing.
    if (!area.isConnected) return;
    const when = snapWhenAll(points.map((p) => p.at));
    renderVizInArea(area, {
      labels: points.map((p, i) => (p.latest ? 'Now' : when[i])),
      series: [{ name: 'Value', values: points.map((p) => p.value) }],
    }, 'line_markers', null, '');
  })();
  return sec;
}
