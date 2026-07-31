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

// ── Types (renderer-local twins of src/visuals.ts shapes) ─────────────────────
type VizAgg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';
interface VizMeasureUI { column: string; aggregation: VizAgg }
interface VizCol { name: string; type: string }

// ── Module-local state (one builder at a time) ───────────────────────────────
let vizDatasetId = ''; // dataset currently loaded into the builder
let vizColumns: VizCol[] = []; // its columns (name + type)
let vizMeasures: VizMeasureUI[] = []; // the measure rows
let vizEditingId = ''; // open saved visual's id ('' = building a new one)
let vizCurrentChartType = ''; // the type currently shown / to be saved
let vizPicker: any = null; // last buildVizPicker() instance (owns the chip row)
let vizRecomputeTimer: number | null = null;
let vizOverrides: any = {}; // the SAME override object buildChart accepts (title/color/…)
let vizFilters: any[] = []; // visual-level row filters (transforms `filter` steps)
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
function renderVizViaEntry(area: HTMLElement, data: any, type: string): void {
  vizEntry.id = vizEditingId || 'draft';
  vizEntry.chartOverrides = { ['v:' + type]: vizOverrides };
  renderVizInArea(area, data, type, vizEntry, 'v');
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

const VIZ_AGGS: VizAgg[] = ['sum', 'avg', 'count', 'min', 'max', 'none'];
const VIZ_AGG_LABELS: Record<VizAgg, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max', none: 'Raw (no aggregation)',
};

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

function vizNumberCols(): VizCol[] {
  const nums = vizColumns.filter((c) => c.type === 'number');
  return nums.length ? nums : vizColumns.slice(); // fall back to all if no numeric col
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
  vizFilters = [];
  const datasets = await loadDatasetOptions('');
  vizShow('viz-builder', true);
  if (!datasets.length) {
    // No datasets to build from — show the builder shell with a clear hint.
    vizShow('viz-encoding', false);
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
  vizColumns = [];
  vizMeasures = [];
  vizCurrentChartType = '';
  vizOverrides = {};
  vizFilters = [];
  vizPicker = null;
  const fl = vizEl('viz-filters-list');
  if (fl) fl.innerHTML = '';
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
    ds = await window.hub.getDataset(currentProjectId, datasetId);
  } catch (_) {
    ds = null;
  }
  if (!ds) {
    vizShow('viz-encoding', false);
    setVizWarnings(['That dataset could not be loaded.']);
    clearVizArea();
    return;
  }
  vizDatasetId = String(ds.id || datasetId);
  vizColumns = Array.isArray(ds.columns)
    ? ds.columns.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];

  // Category options: all columns, text/date listed before numbers.
  const catItems = vizColumns
    .slice()
    .sort((a, b) => (a.type === 'number' ? 1 : 0) - (b.type === 'number' ? 1 : 0))
    .map((c) => ({ value: c.name, label: c.name }));
  const presetCat = preset && typeof preset.category === 'string' ? preset.category : '';
  const catValue = presetCat || (catItems[0] ? catItems[0].value : '');
  fillSelect(vizSelect('viz-category-select'), catItems, catValue);

  // Split/series options: None + text columns.
  const textCols = vizColumns.filter((c) => c.type !== 'number');
  const serItems = [{ value: '', label: 'None' }].concat(textCols.map((c) => ({ value: c.name, label: c.name })));
  const presetSeries = preset && typeof preset.series === 'string' ? preset.series : '';
  fillSelect(vizSelect('viz-series-select'), serItems, presetSeries);

  // Geo level.
  const geoSel = vizSelect('viz-geo-level');
  if (geoSel) geoSel.value = preset && preset.geo && typeof preset.geo.level === 'string' ? preset.geo.level : '';

  // Measures: restore from preset, else one default (first numeric column, sum).
  if (preset && Array.isArray(preset.values) && preset.values.length) {
    vizMeasures = preset.values.map((v: any) => ({
      column: v && typeof v.column === 'string' ? v.column : '',
      aggregation: VIZ_AGGS.indexOf(v && v.aggregation) >= 0 ? (v.aggregation as VizAgg) : 'sum',
    }));
  } else {
    const nums = vizNumberCols();
    vizMeasures = [{ column: nums[0] ? nums[0].name : '', aggregation: 'sum' }];
  }
  renderMeasureRows();
  renderFilterRows();

  vizShow('viz-encoding', true);
  await recomputeVisual();
}

// ── Visual-level filters (reuse the transforms `filter` step; app computes all
// numbers by filtering rows BEFORE aggregation in buildVizData) ───────────────
// FILTER_OPS is the shared list from prepare.ts (same global script scope).
function renderFilterRows(): void {
  const list = vizEl('viz-filters-list');
  if (!list) return;
  list.innerHTML = '';
  vizFilters.forEach((f, i) => list.appendChild(makeVizFilterRow(f, i)));
}

function makeVizFilterRow(step: any, i: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'viz-filter-row';

  const colSel = document.createElement('select');
  colSel.className = 'viz-select';
  colSel.setAttribute('aria-label', 'Filter column');
  fillSelect(colSel, vizColumns.map((c) => ({ value: c.name, label: c.name })), step.column || '');
  colSel.addEventListener('change', () => { vizFilters[i].column = colSel.value; scheduleRecompute(); });
  row.appendChild(colSel);

  const opSel = document.createElement('select');
  opSel.className = 'viz-select';
  opSel.setAttribute('aria-label', 'Filter condition');
  fillSelect(opSel, FILTER_OPS.map((o) => ({ value: o, label: o })), step.op || '=');
  row.appendChild(opSel);

  const valIn = document.createElement('input');
  valIn.type = 'text';
  valIn.className = 'viz-filter-val';
  valIn.value = step.value != null ? String(step.value) : '';
  valIn.setAttribute('aria-label', 'Filter value');
  valIn.addEventListener('input', () => { vizFilters[i].value = valIn.value; scheduleRecompute(); });
  row.appendChild(valIn);

  const syncVal = () => { valIn.hidden = opSel.value === 'is_empty' || opSel.value === 'not_empty'; };
  opSel.addEventListener('change', () => { vizFilters[i].op = opSel.value; syncVal(); scheduleRecompute(); });
  syncVal();

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'viz-value-del';
  del.setAttribute('aria-label', 'Remove filter');
  del.textContent = '×';
  del.addEventListener('click', () => { vizFilters.splice(i, 1); renderFilterRows(); scheduleRecompute(); });
  row.appendChild(del);

  return row;
}

function handleAddFilter(): void {
  vizFilters.push({ type: 'filter', column: vizColumns[0] ? vizColumns[0].name : '', op: '=', value: '' });
  renderFilterRows();
}

// Read the filter rows as transforms `filter` steps (main-side sanitizeFilters
// validates/whitelists again). Rows with no column are dropped.
function readFilters(): any[] {
  return vizFilters
    .filter((f) => f && f.column)
    .map((f) => {
      const s: any = { type: 'filter', column: f.column, op: f.op || '=' };
      if (f.op !== 'is_empty' && f.op !== 'not_empty') s.value = f.value != null ? f.value : '';
      return s;
    });
}

// ── Measure rows ─────────────────────────────────────────────────────────────
function renderMeasureRows(): void {
  const list = vizEl('viz-values-list');
  if (!list) return;
  list.innerHTML = '';
  const numCols = vizNumberCols();
  vizMeasures.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'viz-value-row';

    const colSel = document.createElement('select');
    colSel.className = 'viz-select viz-value-col';
    colSel.setAttribute('aria-label', 'Measure column');
    fillSelect(colSel, numCols.map((c) => ({ value: c.name, label: c.name })), m.column);
    colSel.addEventListener('change', () => {
      vizMeasures[i].column = colSel.value;
      scheduleRecompute();
    });
    row.appendChild(colSel);

    const aggSel = document.createElement('select');
    aggSel.className = 'viz-select viz-value-agg';
    aggSel.setAttribute('aria-label', 'Aggregation');
    fillSelect(aggSel, VIZ_AGGS.map((a) => ({ value: a, label: VIZ_AGG_LABELS[a] })), m.aggregation);
    aggSel.addEventListener('change', () => {
      vizMeasures[i].aggregation = aggSel.value as VizAgg;
      scheduleRecompute();
    });
    row.appendChild(aggSel);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'viz-value-del';
    del.setAttribute('aria-label', 'Remove measure');
    del.textContent = '×';
    del.disabled = vizMeasures.length <= 1; // keep at least one measure
    del.addEventListener('click', () => {
      vizMeasures.splice(i, 1);
      renderMeasureRows();
      scheduleRecompute();
    });
    row.appendChild(del);

    list.appendChild(row);
  });
}

function handleAddMeasure(): void {
  const nums = vizNumberCols();
  vizMeasures.push({ column: nums[0] ? nums[0].name : '', aggregation: 'sum' });
  renderMeasureRows();
  scheduleRecompute();
}

// ── Encoding → recompute → render ────────────────────────────────────────────
function readEncoding(): any {
  const category = (vizSelect('viz-category-select') || ({} as any)).value || '';
  const values = vizMeasures
    .filter((m) => m.column)
    .map((m) => ({ column: m.column, aggregation: m.aggregation }));
  const enc: any = { category, values };
  const series = (vizSelect('viz-series-select') || ({} as any)).value || '';
  if (series) enc.series = series;
  const geoLevel = (vizSelect('viz-geo-level') || ({} as any)).value || '';
  if (geoLevel) enc.geo = { level: geoLevel };
  return enc;
}

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
  const encoding = readEncoding();
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, vizDatasetId, encoding, readFilters());
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
    const catCol = vizColumns.find((c) => c.name === encoding.category);
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
      renderVizViaEntry(area, data, type);
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
  vizFilters = Array.isArray(visual.filters)
    ? visual.filters.map((f: any) => ({
        type: 'filter',
        column: f && f.column != null ? String(f.column) : '',
        op: f && f.op != null ? String(f.op) : '=',
        value: f && f.value != null ? String(f.value) : '',
      }))
    : [];
  await loadDatasetOptions(String(visual.datasetId || ''));
  vizShow('viz-builder', true);
  await onDatasetChange(String(visual.datasetId || ''), visual.encoding);
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function handleSaveVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const encoding = readEncoding();
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
    const filters = readFilters();
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
  if (!enc || typeof enc !== 'object') return;
  const catSel = vizSelect('viz-category-select');
  if (catSel && typeof enc.category === 'string' && enc.category) catSel.value = enc.category;
  const serSel = vizSelect('viz-series-select');
  if (serSel) serSel.value = typeof enc.series === 'string' && enc.series ? enc.series : '';
  if (Array.isArray(enc.values) && enc.values.length) {
    vizMeasures = enc.values.map((v: any) => ({
      column: v && typeof v.column === 'string' ? v.column : '',
      aggregation: VIZ_AGGS.indexOf(v && v.aggregation) >= 0 ? (v.aggregation as VizAgg) : 'sum',
    }));
    renderMeasureRows();
  }
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

  const addValueBtn = vizEl('viz-add-value');
  if (addValueBtn) addValueBtn.addEventListener('click', () => handleAddMeasure());

  const addFilterBtn = vizEl('viz-add-filter');
  if (addFilterBtn) addFilterBtn.addEventListener('click', () => handleAddFilter());

  const suggestBtn = vizEl('viz-suggest-btn');
  if (suggestBtn) suggestBtn.addEventListener('click', () => handleSuggestVisual());

  const dsSel = vizSelect('viz-dataset-select');
  if (dsSel) dsSel.addEventListener('change', () => {
    // Switching dataset starts a fresh build — clear the open visual + its styling/filters.
    vizEditingId = '';
    vizCurrentChartType = '';
    vizOverrides = {};
    vizFilters = [];
    onDatasetChange(dsSel.value);
  });

  const catSel = vizSelect('viz-category-select');
  if (catSel) catSel.addEventListener('change', () => scheduleRecompute());

  const serSel = vizSelect('viz-series-select');
  if (serSel) serSel.addEventListener('change', () => scheduleRecompute());

  const geoSel = vizSelect('viz-geo-level');
  if (geoSel) geoSel.addEventListener('change', () => scheduleRecompute());
}
