// The dashboard-wide filter UI: the toolbar chips, and click-a-bar-to-filter.
//
// NAMED …Ui ON PURPOSE. src/dashboardFilters.ts is the rule module — pure,
// node-tested, and the thing that decides what a filter MEANS. This is only the
// surface that collects one. The two must never be confusable at a glance.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── Click-to-filter ──────────────────────────────────────────────────────────
// Opt-in per visual (overrides.crossFilter, default off): clicking a bar/slice
// applies that category value as a DASHBOARD filter, so every other card on the
// sheet narrows with it. Off by default because a click that silently refilters
// every other card is a surprise, and the sheet already has an explicit filter
// bar for the deliberate case.
//
// The hit-test itself is `chartMarkAt` (chartControls.ts), shared with the
// drill-down panel — a DOM listener over the stored Chart instance, NOT
// options.onClick: buildChart is shared with the capture surface and the Visuals
// builder, and neither of those should grow a dashboard behaviour.
//
// Returns true when this card claimed the plain click, so the caller can wire
// drill-down on it instead. Cross-filter WRITES a filter and drill only READS,
// so when both are possible the write keeps the gesture and drilling moves to
// the ⋯ menu — one click never does two things.
function wireCrossFilter(area: HTMLElement, visual: any): boolean {
  const ov = (visual && visual.overrides) || {};
  if (!ov.crossFilter || dashReadOnly) return false;
  const column = visual && visual.encoding && visual.encoding.category;
  if (!column) return false; // nothing to filter ON — a click would mean nothing
  area.classList.add('is-crossfilter');
  area.addEventListener('click', (e) => {
    // Maps and tables draw no Chart.js instance, so `chartMarkAt` is null and a
    // click on one does nothing rather than throwing.
    const mark = chartMarkAt(area, e);
    if (!mark) return; // a click on empty canvas is not a filter
    applyCrossFilter(String(column), mark.category, mark.facet ? mark.facet.steps : []);
  });
  return true;
}

/** Toggle the clicked value on the sheet's filter list, then redraw everything. */
function applyCrossFilter(column: string, value: unknown, facetSteps: any[] = []): void {
  if (!dashCurrent || dashReadOnly) return; // a published snapshot is not editable
  dashCurrent.filters = toggleCrossFilterSteps(dashCurrent.filters, column, value);
  // A small-multiples panel's own value filters too ("Other" is a list, not a click).
  for (const f of facetSteps) if (f && f.op === '=') dashCurrent.filters = toggleCrossFilterSteps(dashCurrent.filters, f.column, f.value);
  markDashDirty('Cross-filter');
  renderDashFilterBar();
  renderDashGrid();
}

// Renderer-side mirror of src/dashboardFilters.toggleCrossFilter — same rule,
// same shape. That module is the node-tested one; this is the live grid's copy,
// exactly as mergeDashFilters above mirrors mergeDashboardFilters.
function toggleCrossFilterSteps(filters: any, column: string, value: unknown): any[] {
  const list = (Array.isArray(filters) ? filters : []).filter((s: any) => s && s.type === 'filter');
  if (!column) return list.slice();
  const v = value == null ? '' : String(value);
  const same = (s: any): boolean => s.column === column && s.op === '=';
  const already = list.some((s: any) => same(s) && String(s.value == null ? '' : s.value) === v);
  const rest = list.filter((s: any) => !same(s));
  return already ? rest : rest.concat([{ type: 'filter', column, op: '=', value: v }]);
}

// The ONE app-computed number (main-only; never the model, never the renderer).
async function renderMetricCard(card: any, body: HTMLElement): Promise<void> {
  const m = card.metric || {};
  body.innerHTML = '';
  const valEl = document.createElement('div');
  valEl.className = 'dash-metric-value tnum';
  valEl.textContent = kpiHold(card.id) || '…'; // kpiTicker.ts — the last figure while the next computes
  const labelEl = document.createElement('div');
  labelEl.className = 'dash-metric-label';
  labelEl.textContent = m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  body.appendChild(valEl);
  body.appendChild(labelEl);

  // A card that names a saved Metric shows THE METRIC: resolved by main (which
  // is the only thing that can evaluate a formula definition) and formatted by
  // the metric's own format, so the same metric reads identically here, in the
  // Metrics table and in an alert. A metric that has since been deleted
  // resolves to nothing and the card falls through to its own stored
  // column/aggregation below — the same graceful degrade a dangling visualId
  // already gets.
  //
  // BEFORE the column guard below, deliberately: a FORMULA metric has no column
  // at all, so a card showing one would fail that guard and render "—" without
  // ever asking main for the figure it is displaying.
  if (currentProjectId && m.metricId) {
    // A what-if scenario on the card (scenarioCard.ts) paints its own figure.
    if (m.scenarioId && typeof snPaintScenarioCard === 'function' && await snPaintScenarioCard(card, body, valEl, labelEl)) return;
    let mr: any;
    try {
      mr = await snapMetricValue(currentProjectId, m.metricId, effectiveFilters(), dashParamPayload()); // snapshotAsOf.ts
    } catch (_) {
      mr = null;
    }
    if (mr && mr.ok !== false) {
      kpiTick(valEl, card.id, mr.value, mr.display || '—', (v) => (OrdFormat as any).formatMetric(v, mr.format));
      if (!m.label && mr.name) labelEl.textContent = mr.name;
      paintParamErrors(body, mr.paramErrors);
      fxPaintTileNote(body, mr.fx); // fxUi.ts
      void paintMetricCalc(card, body); // "Calculate as" (calcMenu.ts)
      void paintMetricCompare(card, body);
      return;
    }
    // "No data as of <time>" is the answer, not a reason to fall through to the column.
    if (mr && mr.asOfMissing) { dashCardMissing(body, mr.error, true); return; }
  }

  if (!currentProjectId || !m.datasetId || !m.column || !m.aggregation) { valEl.textContent = '—'; return; }
  let r: any;
  try {
    // Dashboard-wide filters + every control's live selection (effectiveFilters,
    // dashboards.ts) are applied over the dataset in MAIN before the number is
    // computed (still 100% app-computed; the renderer never does the math).
    r = await snapComputeMetric( // snapshotAsOf.ts — the "As of" picker
      currentProjectId, m.datasetId, m.column, m.aggregation,
      effectiveFilters(), dashParamPayload(),
    );
  } catch (_) {
    r = { ok: false };
  }
  if (!r || r.ok === false) { dashCardMissing(body, (r && r.error) || t('common.source_removed'), true); return; }
  paintParamErrors(body, r.paramErrors);
  if (r.value == null) { valEl.textContent = '—'; return; }
  // Reuse the shared chart number formatter (auto/plain/thousands/compact/…).
  const kpiFmt = r.fx && (!m.format || m.format === 'auto') ? 'currency' : (m.format || 'auto');
  kpiTick(valEl, card.id, r.value, fmtWith(r.value, kpiFmt), (v) => fmtWith(v, kpiFmt));
  fxPaintTileNote(body, r.fx); // converted money: rows with no rate, the sample label (fxUi.ts)
  void paintMetricCalc(card, body); // "Calculate as" (calcMenu.ts)
  void paintMetricCompare(card, body);
}

// The heading is NOT drawn here. dashCardTitle (dashGrid.ts) already puts it in
// the card head, and that file's own comment states the rule this card was the
// only one breaking: "every other card type's 'what is this' text lives there,
// not duplicated in the body". The duplicate was invisible for as long as the
// body overflowed its two-row card and scrolled the first copy out of sight.
function renderTextCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  if (card.text) {
    const p = document.createElement('p');
    p.className = 'dash-card-p';
    p.textContent = dashSubst(card.text);
    body.appendChild(p);
  }
  if (!card.heading && !card.text) {
    const p = document.createElement('p');
    p.className = 'dash-card-p';
    p.textContent = t('dashFiltersUi.empty_text_card');
    body.appendChild(p);
  }
  // The bundled sample's note card carries a real Remove, because the note
  // promises the sample can be taken out. `action` is a closed enum that only
  // src/app/sampleProject.ts ever writes — a plan cannot produce one, so no
  // model-authored dashboard can grow this button.
  if (card.action === 'delete-sample') body.appendChild(dashSampleDeleteBtn());
}

function dashSampleDeleteBtn(): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm dash-sample-delete';
  btn.textContent = t('dashFiltersUi.remove_the_sample_data');
  btn.addEventListener('click', () => { void handleDeleteSampleProject(); });
  return btn;
}

/** The dataset(s) the OPEN dashboard is built on, read off its own cards.
 *  Metric cards carry `metric.datasetId` outright; a visual card carries only a
 *  visualId, so the saved visual supplies it. Both are read, because a sheet of
 *  nothing but charts would otherwise yield nothing to remove. */
async function dashSampleDatasetIds(pid: string, cards: any[]): Promise<string[]> {
  const ids = new Set<string>();
  cards.forEach((c) => { if (c && c.type === 'metric' && c.metric && c.metric.datasetId) ids.add(String(c.metric.datasetId)); });
  const visualIds = cards.filter((c) => c && c.type === 'visual' && c.visualId).map((c) => String(c.visualId));
  if (visualIds.length) {
    let all: any[] = [];
    try { const res = await window.hub.listVisuals(pid); all = Array.isArray(res) ? res : []; } catch (_) { all = []; }
    all.filter((v) => visualIds.includes(String(v.id)) && v.datasetId).forEach((v) => ids.add(String(v.datasetId)));
  }
  return [...ids];
}

/**
 * Remove the sample: its dashboard, the visuals drawn on its dataset, and the
 * dataset itself. THE PROJECT STAYS.
 *
 * It used to delete the whole project, which was right when the sample had a
 * project of its own — one recursive rm in main took the records and their
 * Parquet with it. The sample now lives in the user's FIRST project (see
 * src/app/sampleProject.ts's header), so deleting the project would delete
 * everything they had put beside it, and on a fresh install would leave them
 * with no project at all.
 *
 * Every visual on the sample dataset goes, not just the three that were seeded:
 * the dataset is leaving, so a visual still pointing at it is a broken card, and
 * the honest thing is to say so in the confirm and take them.
 *
 * All of it goes to the TRASH (src/app/trash.ts), not oblivion: the dataset's
 * delete takes its visuals along, so restoring the dataset brings them back,
 * and the Starred pin is left alone so a restored dashboard is pinned again.
 */
async function handleDeleteSampleProject(): Promise<void> {
  const pid = (dashCurrent && dashCurrent.projectId) || currentProjectId;
  const analysisId = dashCurrent && dashCurrent.id ? String(dashCurrent.id) : '';
  if (!pid || !analysisId) return;
  const cards = typeof dashCards === 'function' ? dashCards() : [];
  const datasetIds = await dashSampleDatasetIds(String(pid), cards);

  let visualIds: string[] = [];
  try {
    const all = await window.hub.listVisuals(String(pid));
    visualIds = (Array.isArray(all) ? all : [])
      .filter((v: any) => v && datasetIds.includes(String(v.datasetId)))
      .map((v: any) => String(v.id));
  } catch (_) { visualIds = []; }

  const name = (dashCurrent && dashCurrent.name) || t('common.this_dashboard');
  if (!window.confirm(
    t('dashFiltersUi.remove_the_sample_data_this_moves', { name, visualIdsCount: visualIds.length }))) return;

  // Dashboard first: it is the only one of the three the user is looking at, so
  // a failure part-way leaves the least confusing state (a dashboard whose cards
  // report a missing source is worse than a dataset with nothing drawn on it).
  try {
    const res = await window.hub.deleteAnalysis(String(pid), analysisId);
    if (!res || res.ok === false) { showToast(t('dashFiltersUi.could_not_remove_the_sample_data')); return; }
  } catch (_) { showToast(t('dashFiltersUi.could_not_remove_the_sample_data')); return; }
  // The dataset's own delete takes its visuals along (deletedWith), which is
  // what lets one Restore bring the sample's charts back with it.
  for (const did of datasetIds) {
    try { await window.hub.deleteDataset(String(pid), did); } catch (_) { /* next */ }
  }
  closeDashboardEditor();
  selectSection('home');
  if (typeof refreshHome === 'function') void refreshHome();
  showToast(t('dashFiltersUi.sample_data_moved_to_trash'), { action: { label: t('dashFiltersUi.open_trash'), onClick: () => selectSection('trash') } });
}

// A card whose source (visual / dataset) is gone. `broken` marks it with a clear badge
// (visible in presentation + exports) so a stale link is obvious at a glance rather than
// a bare dash. Never throws — the card degrades to a placeholder, the rest keep working.
function dashCardMissing(body: HTMLElement, msg: string, broken?: boolean): void {
  body.innerHTML = '';
  const m = document.createElement('div');
  m.className = 'dash-card-missing';
  m.textContent = msg;
  body.appendChild(m);
  if (!broken) return;
  const cardEl = body.closest('.dash-card') as HTMLElement | null;
  if (!cardEl) return;
  cardEl.classList.add('dash-card--broken');
  const head = cardEl.querySelector('.dash-card-head') as HTMLElement | null;
  if (head && !head.querySelector('.dash-card-broken-badge')) {
    const badge = document.createElement('span');
    badge.className = 'dash-card-broken-badge';
    badge.textContent = t('common.source_removed');
    // Sit the badge right after the title so it reads before the controls.
    const title = head.querySelector('.dash-card-title');
    if (title && title.nextSibling) head.insertBefore(badge, title.nextSibling);
    else head.appendChild(badge);
  }
}

// Renderer-side mirror of src/dashboardFilters.mergeDashboardFilters: dashboard filters
// FIRST, then the card's own, dropping byte-identical steps. Kept tiny + local (the
// pure main module is node-tested; this is the same rule for the live grid).
//
// The dedup key includes `values` (mirrors src/dashboardFilters.stepKey, and
// dashStepKey below) — omitting it, as an earlier version of this function
// did, made every `in`/`not in` step on one column collide on the SAME key
// regardless of which values it carried, so a multi-select control's `in`
// filter could silently drop (or be dropped by) an unrelated card-level `in`
// filter on that column. Flagged in Task 2's review, live now that a control
// card actually emits `in` steps (dashControls.ts).
function mergeDashFilters(dashFilters: any, cardFilters: any): any[] {
  const dash = Array.isArray(dashFilters) ? dashFilters : [];
  const card = Array.isArray(cardFilters) ? cardFilters : [];
  const out: any[] = [];
  const seen = new Set<string>();
  dash.concat(card).forEach((s: any) => {
    if (!s || s.type !== 'filter') return;
    const k = dashStepKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  });
  return out;
}


// ── Dashboard-wide filters (toolbar) ──────────────────────────────────────────
// Filter steps reuse the Week 6 FilterStep vocabulary. Value-less operators need no
// value input.
const DASH_FILTER_OPS: Array<{ value: string; label: string }> = [
  { value: '=', label: 'equals' },
  { value: '!=', label: t('dashFiltersUi.not_equals') },
  { value: '>', label: t('common.greater_than') },
  { value: '<', label: t('common.less_than') },
  { value: '>=', label: t('common.at_least') },
  { value: '<=', label: t('common.at_most') },
  { value: 'contains', label: 'contains' },
  { value: 'is_empty', label: t('common.is_empty') },
  { value: 'not_empty', label: t('common.is_not_empty') },
  { value: 'in', label: t('common.is_any_of') },
  { value: 'not in', label: t('common.is_none_of') },
];
const DASH_VALUELESS_OPS = new Set(['is_empty', 'not_empty']);

function dashFilters(): any[] {
  if (!dashCurrent) return [];
  if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
  return dashCurrent.filters;
}

function dashFilterLabel(step: any): string {
  return dashParamRefLabel(dashFilterLabelRaw(step));
}

function dashFilterLabelRaw(step: any): string {
  if (step.op === 'period') return `${step.column}: ${periodLabel(step.period)}`;
  const opLabel = (DASH_FILTER_OPS.find((o) => o.value === step.op) || { label: step.op }).label;
  if (DASH_VALUELESS_OPS.has(step.op)) return `${step.column} ${opLabel}`;
  if (isListFilterOp(step.op)) {
    const vals = Array.isArray(step.values) ? step.values : [];
    // Long lists are summarised — a chip carrying 40 values is unreadable and
    // pushes every other chip off the bar.
    const shown = vals.length > 3 ? `${formatFilterValues(vals.slice(0, 3))} +${vals.length - 3}` : formatFilterValues(vals);
    return `${step.column} ${opLabel} ${shown || '(none)'}`.trim();
  }
  return `${step.column} ${opLabel} ${step.value == null ? '' : String(step.value)}`.trim();
}

function renderDashFilterBar(): void {
  const chips = dashEl('dash-filter-chips');
  if (!chips) return;
  chips.innerHTML = '';
  const list = dashFilters();
  list.forEach((step: any, i: number) => {
    const chip = document.createElement('span');
    chip.className = 'dash-filter-chip chip';
    // The chip's text is the edit affordance — a button, not a span, so it is
    // keyboard-reachable and announces itself.
    const txt = document.createElement('button');
    txt.type = 'button';
    txt.className = 'dash-filter-chip-txt';
    txt.textContent = dashFilterLabel(step);
    txt.setAttribute('aria-label', t('dashFiltersUi.edit_filter', { step: dashFilterLabel(step) }));
    txt.addEventListener('click', () => { void handleEditDashFilter(i); });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dash-filter-chip-x';
    x.setAttribute('aria-label', t('common.remove_filter'));
    x.textContent = '×';
    x.addEventListener('click', () => removeDashFilterAt(i));
    chip.appendChild(txt);
    const ctxTag = lodContextTag(step); // r7:lod — "Apply before LOD"
    if (ctxTag) chip.appendChild(ctxTag);
    chip.appendChild(x);
    chips.appendChild(chip);
  });
  if (list.length === 0) {
    const none = document.createElement('span');
    none.className = 'dash-filter-none';
    none.textContent = t('common.none');
    chips.appendChild(none);
  }
  dashShow('dash-clear-filters', list.length > 0);
}

// Any filter change re-renders every card with the merged filters, then debounce-saves.
function afterDashFilterChange(): void {
  markDashDirty(t('dashFiltersUi.change_filters'));
  renderDashFilterBar();
  renderDashGrid();
}

function removeDashFilterAt(i: number): void {
  const list = dashFilters();
  if (i < 0 || i >= list.length) return;
  list.splice(i, 1);
  afterDashFilterChange();
}

function handleClearDashFilters(): void {
  if (!dashCurrent) return;
  dashCurrent.filters = [];
  afterDashFilterChange();
}

// Replace any existing filter on the same column (category/period quick controls upsert),
// else append.
function upsertDashFilter(step: any): void {
  const list = dashFilters();
  const at = list.findIndex((s: any) => s.column === step.column);
  if (at >= 0) list[at] = step;
  else list.push(step);
  afterDashFilterChange();
}

// Shared picker: choose a project dataset, then a column from it. Returns the loaded
// dataset + column name, or null if cancelled / nothing to pick. A dashboard filter
// references a column BY NAME and applies to any card whose dataset has it (skipped
// elsewhere), so sourcing names/values from one dataset is enough.
async function pickDatasetAndColumn(
  columnFilter?: (c: any) => boolean,
): Promise<{ ds: any; column: string } | null> {
  if (!currentProjectId) { window.alert(t('common.open_a_project_first')); return null; }
  let datasets: any[] = [];
  try { datasets = await window.hub.listDatasets(currentProjectId); } catch (_) { datasets = []; }
  if (!Array.isArray(datasets)) datasets = [];
  const dsId = await dashChooseModal(
    t('dashFiltersUi.filter_pick_a_dataset'),
    datasets.map((d) => ({ value: String(d.id), label: d && d.name ? String(d.name) : t('common.untitled_dataset') })),
    t('common.next'),
  );
  if (dsId === null) return null;
  let ds: any = null;
  try { ds = await window.hub.getDatasetMeta(currentProjectId, dsId); } catch (_) { ds = null; }
  let cols = ds && Array.isArray(ds.columns) ? ds.columns : [];
  if (columnFilter) cols = cols.filter(columnFilter);
  const column = await dashChooseModal(
    t('dashFiltersUi.filter_pick_a_column'),
    cols.map((c: any) => ({ value: String(c.name), label: String(c.name) + (c.type ? ' (' + c.type + ')' : '') })),
    t('common.next'),
  );
  if (column === null) return null;
  return { ds, column };
}

// Distinct non-empty values of a column, as chooser options (capped so the select stays
// usable). Values are kept as strings — filters compare type-aware in MAIN.
//
// Computed in MAIN off the Parquet (`dataset:distinct`). This used to scan
// `ds.rows` here, which meant hydrating the entire table into the renderer to
// collect at most 200 options — ~4 s at the 1,000,000-row cap, inside a
// modal-open path. `src/datasetPage.distinctValuesJs` is the reference this loop
// became; it kept the same rules, including that "empty" is only `null` and `''`
// (a whitespace-only value is a legitimate option).
async function distinctColumnOptions(
  datasetId: string,
  column: string,
): Promise<Array<{ value: string; label: string }>> {
  if (!currentProjectId || !datasetId || !column) return [];
  try {
    const res = await window.hub.datasetDistinct(currentProjectId, datasetId, column, 200);
    const values = res && Array.isArray(res.values) ? res.values : [];
    return values.map((v: string) => ({ value: String(v), label: String(v) }));
  } catch (_) {
    return [];
  }
}

// Mirrors src/dashboardFilters.stepKey — `values` is part of the identity, or
// two different `in` lists on one column would look like the same chip.
function dashStepKey(s: any): string {
  return JSON.stringify([s.column, s.op, s.value == null ? null : s.value, s.values == null ? null : s.values,
    s.period == null ? null : s.period, s.context === true]);
}

// + Filter: dataset → column → the type-aware dialog. The dialog replaces the
// old operator-pick + value-prompt pair, which asked the user to know that a
// dimension wants `in` and a measure wants a range before it would show them
// anything about the column.
async function handleAddDashFilter(): Promise<void> {
  const picked = await pickDatasetAndColumn();
  if (!picked) return;
  const cols = picked.ds && Array.isArray(picked.ds.columns) ? picked.ds.columns : [];
  const col = cols.find((c: any) => c && String(c.name) === picked.column);
  const steps = await openFilterDialog({
    projectId: currentProjectId || '',
    datasetId: String(picked.ds && picked.ds.id ? picked.ds.id : ''),
    column: picked.column,
    type: col && col.type ? String(col.type) : 'text',
    params: dashParams(),
    lodToggle: true,
  });
  if (steps === null || steps.length === 0) return;

  const list = dashFilters();
  // A min/max range arrives as two steps; each is de-duped on its own.
  for (const step of steps) {
    const k = dashStepKey(step);
    if (!list.some((s: any) => dashStepKey(s) === k)) list.push(step);
  }
  afterDashFilterChange();
}

// Clicking a chip re-opens the dialog on that step. Replacing it in place keeps
// its position in the bar, so an edit does not reshuffle every other chip.
async function handleEditDashFilter(idx: number): Promise<void> {
  const list = dashFilters();
  const step = list[idx];
  if (!step || !currentProjectId) return;
  // The bar spans datasets, so the chip's own dataset is whichever one actually
  // has this column — the same "skip a filter whose column is absent" rule the
  // merge follows. Falling back to the first dataset keeps the dialog usable
  // rather than refusing to open.
  let datasets: any[] = [];
  try { datasets = await window.hub.listDatasets(currentProjectId); } catch (_) { datasets = []; }
  let dsId = '';
  let type = 'text';
  for (const d of Array.isArray(datasets) ? datasets : []) {
    let meta: any = null;
    try { meta = await window.hub.getDatasetMeta(currentProjectId, String(d.id)); } catch (_) { meta = null; }
    const col = meta && Array.isArray(meta.columns)
      ? meta.columns.find((c: any) => c && String(c.name) === step.column)
      : null;
    if (col) { dsId = String(d.id); type = col.type ? String(col.type) : 'text'; break; }
  }
  const steps = await openFilterDialog({
    projectId: currentProjectId,
    datasetId: dsId,
    column: step.column,
    type,
    existing: step,
    params: dashParams(),
    lodToggle: true,
  });
  if (steps === null) return;
  list.splice(idx, 1, ...steps);
  afterDashFilterChange();
}

// Category quick control: dataset → column → a distinct value → upsert `=` on that column.
async function handleDashCategory(): Promise<void> {
  const picked = await pickDatasetAndColumn();
  if (!picked) return;
  const opts = await distinctColumnOptions(String(picked.ds && picked.ds.id ? picked.ds.id : ""), picked.column);
  const value = await dashChooseModal(t('dashFiltersUi.category_pick_a_value'), opts, t('common.apply'));
  if (value === null) return;
  upsertDashFilter({ type: 'filter', column: picked.column, op: '=', value });
}

// Period quick control: like Category but scoped to date columns (falls back to all if a
// dataset has none). Kept intentionally simple (single value, `=`) per the brief.
async function handleDashPeriod(): Promise<void> {
  const picked = await pickDatasetAndColumn((c) => c && c.type === 'date');
  if (!picked) return;
  const opts = await distinctColumnOptions(String(picked.ds && picked.ds.id ? picked.ds.id : ""), picked.column);
  const value = await dashChooseModal(t('dashFiltersUi.period_pick_a_value'), opts, t('common.apply'));
  if (value === null) return;
  upsertDashFilter({ type: 'filter', column: picked.column, op: '=', value });
}

