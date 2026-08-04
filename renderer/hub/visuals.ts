// Visuals section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts. A "Visual" is a
// saved chart/map: a dataset + a user encoding (a dimension + one or more
// measures + an optional split + an optional geo level) + a chart type. This file
// owns ONLY the builder form and the saved list; it adds NOTHING to the chart/map
// renderers — it hands the encoding to main (window.hub.computeVisualData), gets
// back the EXACT { labels, series } (+ geo) shape the result surface uses, and
// calls the EXISTING buildVizPicker + renderVizInArea to draw it.
//
// Reuses shared globals at call time: currentProjectId (workspace.ts), promptModal
// (projects.ts), formatSidebarTime (hub.ts), and buildVizPicker / renderVizInArea /
// eligibleChartTypes / countNumericSeries / ALL_CHART_TYPE_IDS / VIZ_LABELS
// (renderResult.ts). Consumes window.hub.* (the visual:* + dataset:* bridge). All
// names/values render as textContent only (no HTML injection); no inline style=.

// The measure/aggregation/column shapes moved to encodingForm.ts with the form
// that owns them (EncAgg / EncMeasure / EncCol). This file no longer names a
// column or an aggregation anywhere — it hands the dataset's columns over and
// reads back an encoding.

// ── Module-local state (one builder at a time) ───────────────────────────────
let vizDatasetId = ''; // dataset currently loaded into the builder
// The encoding form (encodingForm.ts) owns columns, measures and filters now.
// Created on first open, because the template it clones must be in the DOM and
// this file's top level runs before that is guaranteed.
let vizForm: EncodingFormApi | null = null;
let vizEditingId = ''; // open saved visual's id ('' = building a new one)
let vizCurrentChartType = ''; // the type currently shown / to be saved
let vizPicker: any = null; // last buildVizPicker() instance (owns the chip row)
let vizRecomputeTimer: number | null = null;
let vizOverrides: any = {}; // the SAME override object buildChart accepts (title/color/…)
let vizSaveTimer: number | null = null; // debounce for auto-persisting override edits

// The adapter "entry" handed to renderVizInArea so the ⋯ Customize menu +
// Values/Periods controls light up in the builder exactly as on the result surface.
// Its saveOverride reroutes persistence to visual:update (see persistOverride in
// chartControls.ts) instead of the history thread. One object → overrides survive a
// chart-type switch (§4): before each render we point chartOverrides['v:'+type] at
// the single vizOverrides object.
const vizEntry: any = {
  id: 'draft',
  chartOverrides: {},
  saveOverride: (merged: any) => {
    vizOverrides = merged || {};
    scheduleSaveVisualOverrides();
  },
};

// Render the current data/type through the adapter entry, mapping the one
// vizOverrides object onto whatever key renderVizInArea derives ('v:'+type).
// `source` is the dataset identity the Mosaic engine needs (it queries the
// dataset's view rather than the computed data); omitting it just keeps
// Chart.js. See the seam in renderResult.ts.
function renderVizViaEntry(area: HTMLElement, data: any, type: string, source?: any): void {
  vizEntry.id = vizEditingId || 'draft';
  vizEntry.chartOverrides = { ['v:' + type]: vizOverrides };
  renderVizInArea(area, data, type, vizEntry, 'v', source);
}

// Debounced persist of override edits. Only a saved visual writes to disk; an
// unsaved draft keeps overrides in memory until the first Save.
function scheduleSaveVisualOverrides(): void {
  if (vizSaveTimer !== null) window.clearTimeout(vizSaveTimer);
  vizSaveTimer = window.setTimeout(() => {
    vizSaveTimer = null;
    if (vizEditingId && currentProjectId) {
      window.hub.updateVisual(currentProjectId, vizEditingId, { overrides: vizOverrides }).catch(() => {});
    }
  }, 300);
}

// ── Small DOM helpers ────────────────────────────────────────────────────────
function vizEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function vizShow(id: string, show: boolean): void {
  const el = vizEl(id);
  if (el) el.hidden = !show;
}
function vizSelect(id: string): HTMLSelectElement | null {
  return vizEl(id) as HTMLSelectElement | null;
}

// Fill a native <select> with { value, label } options (textContent only).
function fillSelect(sel: HTMLSelectElement | null, items: Array<{ value: string; label: string }>, value: string): void {
  if (!sel) return;
  sel.innerHTML = '';
  items.forEach((it) => {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    if (it.value === value) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── Saved-visual list ────────────────────────────────────────────────────────
async function refreshVisualList(): Promise<void> {
  const list = vizEl('viz-saved-list');
  const empty = vizEl('viz-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listVisuals(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((v) => list.appendChild(makeSavedVisualItem(v)));
}

function makeSavedVisualItem(v: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'viz-saved-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'viz-saved-open';
  const name = document.createElement('span');
  name.className = 'viz-saved-name';
  name.textContent = v && v.name ? String(v.name) : 'Untitled visual';
  const meta = document.createElement('span');
  meta.className = 'viz-saved-meta';
  const typeLabel = (v && v.chartType && VIZ_LABELS[v.chartType]) || (v && v.chartType) || 'Chart';
  meta.textContent = typeLabel + ' · ' + formatSidebarTime(v && v.updatedAt);
  open.appendChild(name);
  open.appendChild(meta);
  open.addEventListener('click', () => openSavedVisual(String(v.id)));

  const dup = document.createElement('button');
  dup.type = 'button';
  dup.className = 'viz-saved-dup';
  dup.setAttribute('aria-label', 'Duplicate visual');
  dup.textContent = '⧉';
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDuplicateVisual(String(v.id));
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'viz-saved-del';
  del.setAttribute('aria-label', 'Delete visual');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteVisual(String(v.id));
  });

  row.appendChild(open);
  row.appendChild(dup);
  row.appendChild(del);
  return row;
}

async function handleDuplicateVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  try {
    await window.hub.duplicateVisual(currentProjectId, id);
  } catch (_) {
    /* ignore */
  }
  await refreshVisualList();
}

async function handleDeleteVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this visual? This cannot be undone.')) return;
  try {
    await window.hub.deleteVisual(currentProjectId, id);
  } catch (_) {
    /* ignore */
  }
  if (vizEditingId === id) closeVisualBuilder();
  await refreshVisualList();
}

// ── Builder open / close ─────────────────────────────────────────────────────
async function loadDatasetOptions(selectedId: string): Promise<any[]> {
  let items: any[] = [];
  if (currentProjectId) {
    try {
      items = await window.hub.listDatasets(currentProjectId);
    } catch (_) {
      items = [];
    }
  }
  if (!Array.isArray(items)) items = [];
  const sel = vizSelect('viz-dataset-select');
  fillSelect(
    sel,
    items.map((d) => ({ value: String(d.id), label: (d && d.name ? String(d.name) : 'Untitled dataset') })),
    selectedId,
  );
  return items;
}

async function openVisualBuilder(): Promise<void> {
  if (!currentProjectId) {
    window.alert('Open a project first.');
    return;
  }
  vizEditingId = '';
  vizCurrentChartType = '';
  vizOverrides = {};
  ensureVizForm();
  const datasets = await loadDatasetOptions('');
  vizShow('viz-builder', true);
  if (!datasets.length) {
    // No datasets to build from — show the builder shell with a clear hint.
    if (vizForm) vizForm.show(false);
    setVizWarnings(['Import a dataset in the Datasets section first, then build a visual from it.']);
    clearVizArea();
    return;
  }
  const sel = vizSelect('viz-dataset-select');
  await onDatasetChange(sel ? sel.value : String(datasets[0].id));
}

function closeVisualBuilder(): void {
  vizShow('viz-builder', false);
  vizEditingId = '';
  vizDatasetId = '';
  vizCurrentChartType = '';
  vizOverrides = {};
  vizPicker = null;
  if (vizForm) vizForm.show(false);
  const sh = vizEl('viz-suggest-hint');
  if (sh) sh.hidden = true;
  clearVizArea();
  setVizWarnings([]);
}

// Load a dataset's columns and (re)build the encoding controls. When restoring a
// saved visual, `preset` carries its stored encoding so the form matches it.
async function onDatasetChange(datasetId: string, preset?: any): Promise<void> {
  if (!currentProjectId || !datasetId) return;
  let ds: any = null;
  try {
    ds = await window.hub.getDatasetMeta(currentProjectId, datasetId);
  } catch (_) {
    ds = null;
  }
  if (!ds) {
    if (vizForm) vizForm.show(false);
    setVizWarnings(['That dataset could not be loaded.']);
    clearVizArea();
    return;
  }
  vizDatasetId = String(ds.id || datasetId);
  const cols = Array.isArray(ds.columns)
    ? ds.columns.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];
  ensureVizForm();
  // The form decides the default category, the default measure and the sort
  // order of the options. Restoring a saved visual is the same call with a
  // preset, so "new" and "reopened" cannot drift apart.
  vizForm!.setColumns(cols, preset, preset && Array.isArray(preset.filters) ? preset.filters : []);

  vizForm!.show(true);
  await recomputeVisual();
}

// ── Encoding → recompute → render ────────────────────────────────────────────
function scheduleRecompute(): void {
  if (vizRecomputeTimer !== null) window.clearTimeout(vizRecomputeTimer);
  vizRecomputeTimer = window.setTimeout(() => {
    vizRecomputeTimer = null;
    recomputeVisual();
  }, 160);
}

function setVizWarnings(warnings: string[]): void {
  const box = vizEl('viz-warnings');
  if (!box) return;
  box.innerHTML = '';
  (warnings || []).forEach((w) => {
    const line = document.createElement('div');
    line.className = 'viz-warning';
    line.textContent = String(w);
    box.appendChild(line);
  });
  box.hidden = !warnings || warnings.length === 0;
}

function clearVizArea(): void {
  const area = vizEl('viz-area');
  if (area) area.innerHTML = '';
  const mount = vizEl('viz-switcher-mount');
  if (mount) mount.innerHTML = '';
  vizPicker = null;
}

// Ask main for the renderer-ready data, then (re)build the shared chart-type
// picker + draw the current type. Mirrors renderTurnResult's picker wiring.
async function recomputeVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) return;
  const encoding = vizForm!.getEncoding();
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, vizDatasetId, encoding, vizForm!.getFilters());
  } catch (_) {
    res = { ok: false, error: 'Could not compute the visual.' };
  }
  if (!res || res.ok === false) {
    setVizWarnings([(res && res.error) || 'Could not compute the visual.']);
    clearVizArea();
    return;
  }
  const data = res.data || { labels: [], series: [] };
  setVizWarnings(Array.isArray(res.warnings) ? res.warnings : []);

  const area = vizEl('viz-area');
  const mount = vizEl('viz-switcher-mount');
  if (!area || !mount) return;
  mount.innerHTML = '';

  // Chart chips come from the underlying data shape so charts stay offered even
  // for a geo encoding; the map is appended AFTER (never the default).
  let shape = res.recommendedShape;
  if (data.geo) {
    const catCol = vizForm!.getColumns().find((c) => c.name === encoding.category);
    shape = catCol && catCol.type === 'date' ? 'time_series' : 'categorical';
  }
  const recommended = eligibleChartTypes(shape, countNumericSeries(data), (data.labels || []).length);
  if (data.geo) recommended.push('map_choropleth'); // maps after charts, never first

  if (!recommended.length) {
    area.innerHTML = '';
    const m = document.createElement('div');
    m.className = 'cv-chart-fallback';
    m.textContent = 'Pick a category and at least one measure to draw a chart.';
    area.appendChild(m);
    vizPicker = null;
    return;
  }

  const initial =
    vizCurrentChartType && (recommended.indexOf(vizCurrentChartType) >= 0 || canShow(vizCurrentChartType, data))
      ? vizCurrentChartType
      : recommended[0];

  const picker = buildVizPicker({
    recommended,
    pool: ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']),
    data,
    hasGeo: !!data.geo,
    initial,
    onSelect: (type: string, info: any) => {
      vizCurrentChartType = type;
      if (!info.canRender) {
        area.innerHTML = '';
        const m = document.createElement('div');
        m.className = 'cv-chart-fallback';
        m.textContent = (VIZ_LABELS[type] || type) + ' needs ' + info.needs + " — it doesn't fit this data.";
        area.appendChild(m);
        return;
      }
      // Render through the adapter entry so the ⋯ Customize menu + Values/Periods
      // controls attach; overrides persist via the entry's saveOverride (§4/§6).
      // The identity (same project/dataset/encoding/filters this data came from)
      // rides along for the Mosaic engine; with the flag off it is ignored.
      renderVizViaEntry(area, data, type, {
        projectId: currentProjectId, datasetId: vizDatasetId, encoding, filters: vizForm!.getFilters(),
      });
    },
  });
  vizPicker = picker;
  mount.appendChild(picker.switcher);
  requestAnimationFrame(() => picker.select(initial));
}

// A saved map type is valid to restore even if it's not in `recommended` (which
// lists charts first); a map is showable whenever the data carries geo.
function canShow(type: string, data: any): boolean {
  if (type === 'map_bubble' || type === 'map_choropleth') return !!data.geo;
  if (type === 'table') return true;
  return false;
}

// ── Open a saved visual into the builder ─────────────────────────────────────
async function openSavedVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  let visual: any = null;
  try {
    visual = await window.hub.getVisual(currentProjectId, id);
  } catch (_) {
    visual = null;
  }
  if (!visual) {
    window.alert('That visual could not be loaded.');
    await refreshVisualList();
    return;
  }
  vizEditingId = String(visual.id || id);
  vizCurrentChartType = typeof visual.chartType === 'string' ? visual.chartType : '';
  vizOverrides = visual.overrides && typeof visual.overrides === 'object' ? visual.overrides : {};
  const savedFilters = Array.isArray(visual.filters)
    ? visual.filters.map((f: any) => ({
        type: 'filter',
        column: f && f.column != null ? String(f.column) : '',
        op: f && f.op != null ? String(f.op) : '=',
        value: f && f.value != null ? String(f.value) : '',
      }))
    : [];
  await loadDatasetOptions(String(visual.datasetId || ''));
  vizShow('viz-builder', true);
  // Encoding AND filters go in as one preset, so restoring a saved visual is the
  // same code path as opening a new one.
  await onDatasetChange(String(visual.datasetId || ''),
                        { ...(visual.encoding || {}), filters: savedFilters });
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function handleSaveVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const encoding = vizForm!.getEncoding();
  if (!encoding.category || !Array.isArray(encoding.values) || encoding.values.length === 0) {
    window.alert('Pick a category and at least one measure before saving.');
    return;
  }
  const chartType = vizCurrentChartType || 'column';
  const suggested = suggestVisualName(encoding, chartType);
  const name = await promptModal(vizEditingId ? 'Rename this visual' : 'Name this visual', suggested, 'Save');
  if (name === null) return;
  const finalName = name.trim() || suggested;

  let res: any;
  try {
    const filters = vizForm!.getFilters();
    if (vizEditingId) {
      res = await window.hub.updateVisual(currentProjectId, vizEditingId, { name: finalName, chartType, encoding, overrides: vizOverrides, filters });
      res = res && res.ok ? res.visual : res;
    } else {
      res = await window.hub.saveVisual({ projectId: currentProjectId, datasetId: vizDatasetId, name: finalName, chartType, encoding, overrides: vizOverrides, filters });
    }
  } catch (_) {
    window.alert('Failed to save the visual.');
    return;
  }
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Failed to save the visual.');
    return;
  }
  closeVisualBuilder();
  await refreshVisualList();
}

// ── AI chart suggestion (structure only; never numbers; confirm before apply) ──
async function handleSuggestVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const hint = vizEl('viz-suggest-hint');
  const btn = vizEl('viz-suggest-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  if (hint) { hint.hidden = false; hint.textContent = 'Thinking…'; }
  let res: any;
  try {
    res = await window.hub.suggestVisual(currentProjectId, vizDatasetId);
  } catch (_) {
    res = { ok: false };
  }
  if (btn) btn.disabled = false;

  if (res && res.notReady) {
    if (hint) { hint.hidden = false; hint.textContent = 'Connect a model in Execution settings to suggest a chart.'; }
    return;
  }
  if (!res || res.ok === false || !res.encoding) {
    if (hint) { hint.hidden = false; hint.textContent = (res && res.error) || 'Could not suggest a chart.'; }
    return;
  }
  // Confirm before applying — the user reviews and can still adjust before saving.
  if (!window.confirm('Apply the suggested chart? You can still adjust it before saving.')) {
    if (hint) hint.hidden = true;
    return;
  }
  if (hint) hint.hidden = true;
  applySuggestedEncoding(res.encoding, res.chartType);
}

// Populate the builder form from a suggested encoding (never auto-saves). Numbers
// are recomputed by the app on the recompute that follows.
function applySuggestedEncoding(enc: any, chartType: string): void {
  if (!enc || typeof enc !== 'object' || !vizForm) return;
  // Same call the dataset switch and the saved-visual restore make. A suggestion
  // is just another preset, so it cannot support a field the other two do not.
  vizForm.setEncoding(enc);
  if (typeof chartType === 'string' && chartType) vizCurrentChartType = chartType;
  recomputeVisual();
}

function suggestVisualName(encoding: any, chartType: string): string {
  const typeLabel = VIZ_LABELS[chartType] || chartType || 'Chart';
  const measure = encoding.values && encoding.values[0] ? encoding.values[0].column : '';
  const cat = encoding.category || '';
  if (measure && cat) return `${measure} by ${cat}`;
  return `${typeLabel}`;
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initVisuals(): void {
  const newBtn = vizEl('viz-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => openVisualBuilder());

  const cancelBtn = vizEl('viz-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeVisualBuilder());

  const saveBtn = vizEl('viz-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveVisual());

  const suggestBtn = vizEl('viz-suggest-btn');
  if (suggestBtn) suggestBtn.addEventListener('click', () => handleSuggestVisual());

  const dsSel = vizSelect('viz-dataset-select');
  if (dsSel) dsSel.addEventListener('change', () => {
    // Switching dataset starts a fresh build — clear the open visual + its styling/filters.
    vizEditingId = '';
    vizCurrentChartType = '';
    vizOverrides = {};
    onDatasetChange(dsSel.value);
  });
  // Category / Split / Geo / measures / filters are the encoding form's, and it
  // reports every one of them through the single onChange in ensureVizForm().
}

// Mount the encoding form once, into the builder. Its onChange is the ONE place
// an encoding edit becomes a recompute.
function ensureVizForm(): void {
  if (vizForm) return;
  const mount = vizEl('viz-encoding-mount');
  if (!mount) return;
  vizForm = createEncodingForm(mount, { onChange: () => scheduleRecompute() });
}
