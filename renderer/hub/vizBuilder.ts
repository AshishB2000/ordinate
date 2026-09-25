// The builder: open and close it, turn an encoding into a rendered chart,
// reopen a saved visual into it, save, and ask for an AI suggestion (structure
// only — the app computes every number).
//
// Split verbatim out of visuals.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

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

// `datasetId` preselects the dataset (the create popup already asked which one);
// omitted, the builder falls back to the first in the list, as it always did.
async function openVisualBuilder(datasetId?: string): Promise<void> {
  if (!currentProjectId) {
    window.alert('Open a project first.');
    return;
  }
  vizEditingId = '';
  if (typeof dkSync === 'function') dkSync(); // dock.ts — no visual open (yet) to base context on
  vizCurrentChartType = '';
  vizOverrides = {};
  const nameEl = vizEl('viz-builder-name');
  if (nameEl) nameEl.textContent = 'New visual';
  ensureVizForm();
  const datasets = await loadDatasetOptions(datasetId || '');
  showVizGallery(false);
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
  if (typeof vhReset === 'function') vhReset(); // versionsPanel.ts — no preview outlives its page
  showVizGallery(true);
  vizEditingId = '';
  const histBtn = vizEl('viz-history-btn');
  if (histBtn) histBtn.hidden = true;
  if (typeof dkSync === 'function') dkSync(); // dock.ts — context line falls back off this visual
  vizDatasetId = '';
  vizCurrentChartType = '';
  vizOverrides = {};
  vizPicker = null;
  if (vizForm) vizForm.show(false);
  const sh = vizEl('viz-suggest-hint');
  if (sh) sh.hidden = true;
  const nameEl = vizEl('viz-builder-name');
  if (nameEl) nameEl.textContent = 'New visual';
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
  // The pivot shelves take the SAME preset, so restoring a saved pivot and
  // opening a new one are one code path here too. `pivotFromEncoding` fills
  // them from the chart fields when the preset has no pivot of its own —
  // which is what makes switching chart type carry the work over.
  vizPivotForm!.setColumns(cols, (preset && preset.pivot) || pivotFromEncoding(preset || {}));
  applyPivotMode(vizCurrentChartType === 'pivot');

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
// Same reason as the dashboard: the chart on screen baked in the old tokens.
// Guarded on the builder actually being open — recomputeVisual() early-returns
// without a dataset, but re-entering it from a background section is pointless.
document.addEventListener('themechange', () => {
  const area = document.getElementById('viz-area');
  if (area && area.offsetParent && vizDatasetId) void recomputeVisual();
});

/**
 * Show the pivot shelves instead of Category / Measures / Split by / Map
 * regions, or put them back. Filters stay put either way — see
 * `EncodingFormApi.showFields`.
 */
function applyPivotMode(on: boolean): void {
  if (!vizForm || !vizPivotForm) return;
  vizForm.showFields(!on);
  vizPivotForm.show(on);
}

/**
 * The encoding for the type currently selected.
 *
 * A pivot carries BOTH: its own `pivot` block, and the mirrored chart fields
 * (`category` / `series` / `values`) that every encoding-reading surface which
 * knows nothing about pivots still expects — the drill panel, the AI prompt,
 * the name suggester, and the switch back to a column chart.
 */
function vizEncodingForType(): any {
  if (vizCurrentChartType !== 'pivot') return vizForm!.getEncoding();
  const pivot = vizPivotForm!.getPivot();
  return Object.assign(encodingFromPivot(pivot), { pivot });
}

async function recomputeVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) return;
  const encoding = vizEncodingForType();
  const loadingArea = vizEl('viz-area');
  if (loadingArea) loadingArea.classList.add('is-loading');
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, vizDatasetId, encoding, vizForm!.getFilters());
  } catch (_) {
    res = { ok: false, error: 'Could not compute the visual.' };
  } finally {
    if (loadingArea) loadingArea.classList.remove('is-loading');
  }
  if (!res || res.ok === false) {
    setVizWarnings([(res && res.error) || 'Could not compute the visual.']);
    vizForm!.applyCategoryInfo(null);
    clearVizArea();
    return;
  }
  const data = res.data || { labels: [], series: [] };
  setVizWarnings(Array.isArray(res.warnings) ? res.warnings : []);
  // What main did to the dimension: the date grain it settled on, and the note
  // when it capped a long tail. Only main knows — both need the rows.
  vizForm!.applyCategoryInfo(res.category);

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
    // The ONLY innerHTML here: VIZ_ICONS is a trusted static constant of
    // hand-written SVG in renderResult.ts, never user or model input. `column`
    // is a generic stand-in glyph — the empty state has no chart type yet.
    const glyph = document.createElement('div');
    glyph.className = 'cv-chart-fallback-glyph';
    glyph.innerHTML = VIZ_ICONS.column;
    m.appendChild(glyph);
    const text = document.createElement('span');
    text.textContent = 'Pick a category and at least one measure to draw a chart.';
    m.appendChild(text);
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
      const wasPivot = vizCurrentChartType === 'pivot';
      vizCurrentChartType = type;
      // Entering or leaving pivot mode changes what the encoding IS, so the
      // panel swaps and the visual is recomputed rather than redrawn from data
      // built for the other shape.
      if ((type === 'pivot') !== wasPivot) {
        if (type === 'pivot') vizPivotForm!.setColumns(vizForm!.getColumns(), pivotFromEncoding(vizForm!.getEncoding()));
        else vizForm!.setEncoding(encodingFromPivot(vizPivotForm!.getPivot()));
        applyPivotMode(type === 'pivot');
        void recomputeVisual();
        return;
      }
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

// A saved type is valid to restore whenever it can actually DRAW, not only when
// it is recommended — `recommended` ranks types for a new visual, and a user who
// picked one deliberately has already made that choice.
// Whether a SAVED chart type is still restorable — asked of every visual the
// builder reopens. This was a hand-written list (table + the two map types) and
// therefore a second, wronger answer to a question renderResult.ts already
// answers for the chip row: every other saved type survived reopening only by
// also being in `recommended`, so a gauge saved over a categorical encoding came
// back as a column and the next save wrote that column to disk.
//
// One rule now, in renderResult.ts, used by both. `recommended` stays what it
// always was — advice for a NEW visual, not a filter on someone's saved one.
function canShow(type: string, data: any): boolean {
  return typeof chartCanRender === 'function'
    ? chartCanRender(type, data, !!(data && data.geo))
    : false;
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
  if (typeof vhReset === 'function') vhReset(); // a version preview ends when the live one opens
  await vizOpenRecord(visual, id);
}

/** Paint the builder from a visual RECORD — the saved one, or a version of it
 *  that History is previewing (versionsPanel.ts), which never reaches disk. */
async function vizOpenRecord(visual: any, id?: string): Promise<void> {
  vizEditingId = String(visual.id || id || '');
  const histBtn = vizEl('viz-history-btn');
  if (histBtn) histBtn.hidden = !vizEditingId; // History is a SAVED visual's
  if (typeof dkSync === 'function') dkSync(); // dock.ts — context line now names this visual
  const nameEl = vizEl('viz-builder-name');
  if (nameEl) nameEl.textContent = String(visual.name || 'Visual');
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
  showVizGallery(false);
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
  const encoding = vizEncodingForType();
  if (encoding.pivot) {
    if (!encoding.pivot.rows.length || !encoding.pivot.values.length) {
      window.alert('Pick a row dimension and at least one value before saving.');
      return;
    }
  } else if (!encoding.category || !Array.isArray(encoding.values) || encoding.values.length === 0) {
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

// ── AI chart suggestion (structure only; never numbers; review before apply) ──
// The builder's ✨ Suggest chart opens the SAME modal the create popup uses,
// straight at its results step with an empty intent. A drawn picker replaced the
// old window.confirm: "apply the suggested chart?" asked the user to accept a
// chart they had not seen.
async function handleSuggestVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const hint = vizEl('viz-suggest-hint');
  if (hint) hint.hidden = true;
  const choice = await openNewVisualModal({ datasetId: vizDatasetId, startAtSuggest: true });
  // 'manual' and cancel both mean "leave the builder as it is" — it is already
  // open on this dataset, which is what Build it myself asks for.
  if (choice && choice.kind === 'suggested') applySuggestedEncoding(choice.encoding, choice.chartType || '');
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
  if (encoding && encoding.pivot) {
    const p = encoding.pivot;
    const value = p.values && p.values[0] ? p.values[0].column : '';
    const dim = p.rows && p.rows[0] ? p.rows[0].column : '';
    if (value && dim) return `${value} by ${dim}`;
  }
  const measure = encoding.values && encoding.values[0] ? encoding.values[0].column : '';
  const cat = encoding.category || '';
  if (measure && cat) return `${measure} by ${cat}`;
  return `${typeLabel}`;
}



/**
 * A pivot header click landed (renderResult.resortPivot). The grid on screen is
 * already sorted; this mirrors the choice into the builder's own Sort control
 * so pressing Save keeps it.
 *
 * Defined here rather than called directly from renderResult because the
 * dashboard and the export preview draw pivots too and have no builder to
 * mirror into — `typeof onPivotSorted === 'function'` is the seam.
 */
function onPivotSorted(source: any, sort: { by: 'label' | number; dir: 'asc' | 'desc' }): void {
  if (!vizPivotForm || vizCurrentChartType !== 'pivot') return;
  if (!source || source.datasetId !== vizDatasetId) return;
  vizPivotForm.setSort(sort);
}
