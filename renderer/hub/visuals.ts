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
// The pivot shelves, mounted BESIDE the encoding form and shown instead of its
// chart fields when the chart type is `pivot` (pivotBuilder.ts).
let vizPivotForm: PivotBuilderApi | null = null;
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
  // COMMENT PIN HOOK — this visual's pinned comments ride to buildChart as overrides.commentPins.
  vizEntry.chartOverrides = { ['v:' + type]: cmtWithPins(vizOverrides, 'visual', vizEditingId) };
  // The drill context is the SAME identity `source` carries — the project,
  // dataset, encoding and filters this `data` was computed from — so the rows
  // the panel lists are the rows behind the figure on screen, including while
  // the builder is still an unsaved draft. Absent it, the ⋯ menu simply has no
  // "Show underlying rows" item.
  // A draft has no stored name yet, so the panel gets the same descriptive
  // label the Save prompt would suggest ("price by region").
  vizEntry.drill = source ? { name: suggestVisualName(source.encoding || {}, type), ...source, asOf: snapVizAsOf } : null; // snapshotAsOf.ts
  renderVizInArea(area, data, type, vizEntry, 'v', source);
  if (source) wireDrillClick(area, vizEntry.drill);
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

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initVisuals(): void {
  // Two "+ New visual" buttons — header and empty state. Whichever is on screen
  // runs the same handler, exactly as the Dashboards section does with its
  // Create buttons.
  ['viz-new-btn', 'viz-empty-new-btn'].forEach((btnId) => {
    const b = vizEl(btnId);
    if (b) b.addEventListener('click', () => handleNewVisual());
  });

  // "Start with AI" is the same flow with the AI step opened first, not a
  // second path — handleNewVisual owns resolving the project either way.
  const emptyAi = vizEl('viz-empty-ai');
  if (emptyAi) emptyAi.addEventListener('click', () => handleNewVisual({ startAtSuggest: true }));

  const seeAll = vizEl('viz-start-all');
  if (seeAll) seeAll.addEventListener('click', () => {
    if (typeof selectSection === 'function') selectSection('datasets');
  });

  // "← Back": leave the builder and repaint the gallery, so a delete
  // or a rename made while the builder was open shows immediately.
  const cancelBtn = vizEl('viz-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    closeVisualBuilder();
    refreshVisualList();
  });

  const saveBtn = vizEl('viz-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveVisual());

  const suggestBtn = vizEl('viz-suggest-btn');
  if (suggestBtn) suggestBtn.addEventListener('click', () => handleSuggestVisual());

  const dsSel = vizSelect('viz-dataset-select');
  if (dsSel) dsSel.addEventListener('change', () => {
    // Switching dataset starts a fresh build — clear the open visual + its styling/filters.
    vizEditingId = '';
    if (typeof dkSync === 'function') dkSync(); // dock.ts — context line falls back off the cleared visual
    vizCurrentChartType = '';
    vizOverrides = {};
    const nameEl = vizEl('viz-builder-name');
    if (nameEl) nameEl.textContent = 'New visual';
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
  vizForm = createEncodingForm(mount, {
    onChange: () => scheduleRecompute(),
    // Resolved at click time: the builder's dataset changes under the form.
    dataset: () =>
      currentProjectId && vizDatasetId ? { projectId: currentProjectId, datasetId: vizDatasetId } : null,
  });
  // Mounted BEFORE the encoding form's own root so the shelves sit where
  // Category/Measures sit, with Filters still below them.
  vizPivotForm = createPivotBuilder(mount, { onChange: () => scheduleRecompute() });
  mount.insertBefore(vizPivotForm.el, vizForm.el);
  vizPivotForm.show(false);
}
