// Dashboards section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts (loaded AFTER
// visuals.js, BEFORE hub.js, so buildChart / renderVizInArea / VIZ_LABELS /
// fmtWith / promptModal / formatSidebarTime / currentProjectId are all in scope
// at call time). A "Dashboard" is a grid of cards across one or more pages,
// saved per project (src/dashboards.ts). Cards come in three types: a saved
// Visual (drawn by REUSING the visual:data → renderVizInArea path — this file
// adds ZERO charting code), a computed metric (its ONE number produced only by
// main via window.hub.computeMetric — never the model, never the renderer), and
// free text (heading + body). Layout is a plain 12-column CSS grid; add / resize
// / move are button controls (with native HTML5 drag as a light enhancement) —
// NO grid library.
//
// ponytail: dashboard/card/page shapes are the big JSON envelopes owned by
// src/dashboards.ts; the renderer forwards them, so they're typed `any` here
// rather than re-declaring twins that would just drift.

// The fixed column count — MUST stay in sync with `.dash-grid` in hub.css and
// GRID_COLS in src/dashboards.ts.
const DASH_GRID_COLS = 12;
// One grid row's height in px (mirrors `.dash-grid { grid-auto-rows }`) + the
// gap, used only to map a drop pointer to whole grid units for native drag.
const DASH_ROW_PX = 48;
const DASH_GAP_PX = 12;

type DashAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';
const DASH_AGGS: DashAgg[] = ['sum', 'avg', 'count', 'min', 'max'];
const DASH_AGG_LABELS: Record<DashAgg, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max',
};

// ── Module-local state ────────────────────────────────────────────────────────
let dashList: any[] = [];          // summaries (list view)
let dashCurrent: any = null;       // the open Dashboard (full), or null on the list
// WHICH RECORD the editor is bound to. Phase D: an Analysis is the authoring
// container and its `sheets` ARE dashboard `pages` (src/analysis.ts reuses the
// type), so ONE editor drives both — the mode only decides which channel the
// save goes down and which list Back returns to.
let dashMode: 'dashboard' | 'analysis' = 'dashboard';
// A PUBLISHED dashboard (Dashboard.analysisId !== null) is a snapshot. Main
// refuses every non-publish write to it (src/dashboards.ts updateDashboard), so
// the editor must not offer edits that will fail — this flag removes them.
let dashReadOnly = false;
let dashPageIdx = 0;               // active page index within dashCurrent.pages
let dashDirty = false;             // unsaved layout/card edits
let dashSaveTimer: number | null = null; // debounced autosave
let dashDragId: string | null = null;    // id of the card being dragged (native HTML5)

// ── Small DOM helpers ─────────────────────────────────────────────────────────
function dashEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function dashShow(id: string, show: boolean): void {
  const el = dashEl(id);
  if (el) el.hidden = !show;
}

// A pick-one modal (promptModal only takes text). Mirrors promptModal's overlay
// + .ws-modal* classes; resolves to the chosen value, or null if cancelled.
function dashChooseModal(
  title: string,
  options: Array<{ value: string; label: string }>,
  okLabel: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = title;
    const sel = document.createElement('select');
    sel.className = 'ws-modal-input';
    options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = okLabel;
    ok.disabled = options.length === 0;

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: string | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release(); // return focus to the trigger
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!ok.disabled) close(sel.value); }
      else if (a11y) a11y.onTabKey(e); // trap Tab within the dialog
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(sel.value));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    if (options.length) box.appendChild(sel);
    else {
      const empty = document.createElement('p');
      empty.className = 'dash-modal-empty';
      empty.textContent = 'Nothing to pick — create one in its section first.';
      box.appendChild(empty);
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // Empty state has no select — focus Cancel so keyboard focus lands inside the dialog.
    a11y = makeModalAccessible(box, title, options.length ? sel : cancel);
  });
}

// ── List view ───────────────────────────────────────────────────────────────
async function refreshDashboardList(): Promise<void> {
  // Flush any pending debounced edit before tearing the editor down, so a quick
  // section switch never drops the last few edits.
  if (dashDirty && dashCurrent) await persistDashboard();
  // Always show the list (not a half-open editor) when the section refreshes.
  closeDashboardEditor();
  const list = dashEl('dash-list');
  const empty = dashEl('dash-list-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listDashboards(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  dashList = items;
  if (empty) empty.hidden = items.length > 0;
  items.forEach((d) => list.appendChild(makeDashListItem(d)));
}

function makeDashListItem(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dash-list-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dash-list-open';
  const name = document.createElement('span');
  name.className = 'dash-list-name';
  name.textContent = d && d.name ? String(d.name) : 'Untitled dashboard';
  // A published dashboard is read-only. Say so BEFORE it is opened — the
  // summary carries analysisId precisely so this costs no extra read.
  const published = Boolean(d && d.analysisId);
  if (published) {
    const badge = document.createElement('span');
    badge.className = 'dash-list-badge';
    badge.textContent = 'Published · read-only';
    name.appendChild(badge);
  }
  const meta = document.createElement('span');
  meta.className = 'dash-list-meta';
  const pages = d && typeof d.pageCount === 'number' ? d.pageCount : 1;
  meta.textContent = pages + (pages === 1 ? ' page · ' : ' pages · ') +
    (published && d.publishedAt
      ? 'published ' + formatSidebarTime(d.publishedAt)
      : formatSidebarTime(d && d.updatedAt));
  open.appendChild(name);
  open.appendChild(meta);
  open.addEventListener('click', () => openDashboard(String(d.id)));

  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'dash-list-btn';
  ren.setAttribute('aria-label', 'Rename dashboard');
  ren.textContent = '✎';
  ren.addEventListener('click', (e) => { e.stopPropagation(); handleRenameDashboard(String(d.id), name.textContent || ''); });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'dash-list-btn';
  del.setAttribute('aria-label', 'Delete dashboard');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteDashboard(String(d.id)); });

  row.appendChild(open);
  // Renaming a published snapshot is a write main refuses — offering the button
  // would just fail. Deleting is still allowed: a snapshot can be discarded.
  if (!published) row.appendChild(ren);
  row.appendChild(del);
  return row;
}

async function handleNewDashboard(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const name = await promptModal('New dashboard', 'Untitled dashboard', 'Create');
  if (name === null) return;
  let res: any;
  try {
    res = await window.hub.saveDashboard({ projectId: currentProjectId, name });
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.id) {
    window.alert((res && res.error) || 'Failed to create the dashboard.');
    return;
  }
  await refreshDashboardList();
  openDashboardFrom(res);
}

async function handleRenameDashboard(id: string, currentName: string): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename dashboard', currentName || 'Untitled dashboard', 'Save');
  if (name === null) return;
  try {
    await window.hub.updateDashboard(currentProjectId, id, { name });
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashCurrent.id === id) {
    dashCurrent.name = name.trim() || dashCurrent.name;
    const nameEl = dashEl('dash-name');
    if (nameEl) nameEl.textContent = dashCurrent.name;
  }
  await refreshDashboardListKeepEditor();
}

// Refresh only the summaries list without tearing down an open editor.
async function refreshDashboardListKeepEditor(): Promise<void> {
  if (!currentProjectId) return;
  try {
    dashList = await window.hub.listDashboards(currentProjectId);
  } catch (_) { /* ignore */ }
}

async function handleDeleteDashboard(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this dashboard? This cannot be undone.')) return;
  try {
    await window.hub.deleteDashboard(currentProjectId, id);
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashCurrent.id === id) closeDashboardEditor();
  await refreshDashboardList();
}

// ── Editor: open / close ──────────────────────────────────────────────────────
async function openDashboard(id: string): Promise<void> {
  if (!currentProjectId) return;
  let d: any = null;
  try {
    d = await window.hub.getDashboard(currentProjectId, id);
  } catch (_) {
    d = null;
  }
  if (!d) {
    window.alert('That dashboard could not be loaded.');
    await refreshDashboardList();
    return;
  }
  openDashboardFrom(d);
}

// Re-parent the ONE editor element into the host of whichever section owns it.
// Both hosts are `display: contents` (hub.css), so the editor stays a direct
// flex item of its .ws-panel and the layout is unchanged. Cheaper and far less
// error-prone than a second copy of the editor markup, which would need a second
// copy of every id and every listener.
function mountDashEditor(hostId: string): void {
  const ed = dashEl('dash-editor');
  const host = dashEl(hostId);
  if (ed && host && ed.parentElement !== host) host.appendChild(ed);
}

function openDashboardFrom(d: any): void {
  dashMode = 'dashboard';
  // A published dashboard carries the id of the analysis it was snapshotted
  // from. That is PROVENANCE, never a lookup (nothing here loads the analysis to
  // render) — it only tells us the record is read-only.
  dashReadOnly = Boolean(d && d.analysisId);
  mountDashEditor('dash-editor-host');
  openEditorWith(d, d && d.name ? d.name : 'Untitled dashboard');
  renderDashReadOnlyNote(d);
}

// Open an ANALYSIS in the same editor. `sheets` and `pages` are the same type
// (src/analysis.ts reuses dashboards.Page), so the array is ALIASED rather than
// copied: every existing page/card/filter handler keeps working on
// `dashCurrent.pages`, and the save reads it back out as `sheets`.
function openAnalysisFrom(a: any): void {
  dashMode = 'analysis';
  dashReadOnly = false;
  mountDashEditor('an-editor-host');
  if (!Array.isArray(a.sheets) || a.sheets.length === 0) {
    a.sheets = [{ id: dashUuid(), name: 'Sheet 1', cards: [] }];
  }
  a.pages = a.sheets; // alias, NOT a copy — one array, two names
  dashShow('an-list-view', false);
  openEditorWith(a, a && a.name ? a.name : 'Untitled analysis');
  renderDashReadOnlyNote(null);
  renderAnalysisPubState();
}

// The part both entry points share: bind state, paint the editor.
function openEditorWith(rec: any, title: string): void {
  dashCurrent = rec;
  dashPageIdx = 0;
  dashDirty = false;
  if (!Array.isArray(dashCurrent.pages) || dashCurrent.pages.length === 0) {
    dashCurrent.pages = [{ id: dashUuid(), name: 'Page 1', cards: [] }];
  }
  // Week 10: dashboard-wide filters (a v1 dashboard has none → []).
  if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
  dashShow('dash-list-view', false);
  dashShow('dash-editor', true);
  applyDashEditorMode();
  const aiOut = dashEl('dash-ai-out');
  if (aiOut) { aiOut.hidden = true; aiOut.innerHTML = ''; }
  const nameEl = dashEl('dash-name');
  if (nameEl) nameEl.textContent = title;
  renderDashFilterBar();
  renderDashPages();
  renderDashGrid();
}

// Mode + read-only are expressed as CLASSES on the editor (hub CSP forbids
// inline style=); hub.css hides `.dash-edit-only` / `.dash-db-only` / the card
// and page controls from there.
function applyDashEditorMode(): void {
  const ed = dashEl('dash-editor');
  if (!ed) return;
  ed.classList.toggle('dash-editor--analysis', dashMode === 'analysis');
  ed.classList.toggle('dash-editor--readonly', dashReadOnly);
  // The workbench columns light up for an open ANALYSIS only. In dashboard mode
  // this turns them off, which is the invariant: a published dashboard is a
  // snapshot, and a panel that can mutate a card plus the 600 ms autosave would
  // clobber it.
  anSyncWorkbench();
}

// The read-only explanation, with the route back to the authoring surface.
// `d` null (or an unpublished record) hides it.
function renderDashReadOnlyNote(d: any): void {
  const note = dashEl('dash-readonly');
  const txt = dashEl('dash-readonly-text');
  const btn = dashEl('dash-open-analysis');
  const wrap = dashEl('dash-legacy-wrap-btn');
  if (!note || !txt || !btn) return;
  // A LEGACY standalone dashboard (no analysisId) stays editable exactly as it
  // was, and gets the one-way "wrap it in an analysis" affordance — the explicit
  // user action §4.1 of docs/analysis/00-model.md names as the migration trigger.
  if (wrap) wrap.hidden = !(d && !d.analysisId);
  if (!d || !d.analysisId) { note.hidden = true; return; }
  note.hidden = false;
  txt.textContent =
    'This dashboard is a published snapshot' +
    (d.publishedAt ? ' from ' + formatSidebarTime(d.publishedAt) : '') +
    '. It cannot be edited here — change its analysis and publish again. Its figures are still recomputed from live data every time you open it.';
  btn.hidden = false;
}

function closeDashboardEditor(): void {
  exitDashPresent(); // never leave the app stuck in chrome-hidden mode
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  dashCurrent = null;
  dashPageIdx = 0;
  dashDirty = false;
  dashDragId = null;
  destroyDashCharts(); // tear down card charts/maps before wiping the grid (no leak)
  const grid = dashEl('dash-grid');
  if (grid) grid.innerHTML = '';
  const pages = dashEl('dash-pages');
  if (pages) pages.innerHTML = '';
  dashShow('dash-editor', false);
  // dashCurrent is null now, so this drops the workbench columns and clears the
  // selection — closing an analysis must not leave panels bound to a dead card.
  anSyncWorkbench();
  dashShow('dash-list-view', true);
  dashShow('an-list-view', true);
  dashMode = 'dashboard';
  dashReadOnly = false;
  applyDashEditorMode();
  const note = dashEl('dash-readonly');
  if (note) note.hidden = true;
  const pub = dashEl('an-pubstate');
  if (pub) pub.hidden = true;
}

// Browsers expose crypto.randomUUID in the renderer; used for local page/card
// keys (main re-generates any invalid id on save, so this is only a UI hint).
function dashUuid(): string {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch (_) { /* fall through */ }
  // Fallback (should never run in Electron): a v4-shaped random id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function dashCurrentPage(): any {
  if (!dashCurrent || !Array.isArray(dashCurrent.pages)) return null;
  if (dashPageIdx < 0 || dashPageIdx >= dashCurrent.pages.length) dashPageIdx = 0;
  return dashCurrent.pages[dashPageIdx] || null;
}

function markDashDirty(): void {
  // A published dashboard is read-only. Nothing in the UI should reach here (the
  // controls are hidden), but the 600 ms autosave is exactly the mechanism that
  // would quietly overwrite a snapshot, so it is stopped at the source too.
  if (dashReadOnly) return;
  dashDirty = true;
  scheduleDashSave();
}

// ── Pages (tabs) ────────────────────────────────────────────────────────────
function renderDashPages(): void {
  const strip = dashEl('dash-pages');
  if (!strip || !dashCurrent) return;
  strip.innerHTML = '';
  (dashCurrent.pages || []).forEach((p: any, i: number) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'dash-page-tab' + (i === dashPageIdx ? ' active' : '');
    tab.textContent = p && p.name ? String(p.name) : 'Page ' + (i + 1);
    tab.addEventListener('click', () => { dashPageIdx = i; renderDashPages(); renderDashGrid(); });
    tab.addEventListener('dblclick', () => handleRenamePage(i));
    strip.appendChild(tab);
  });
  // Rename / remove controls for the active page.
  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'dash-page-ctrl';
  ren.setAttribute('aria-label', 'Rename page');
  ren.textContent = '✎';
  ren.addEventListener('click', () => handleRenamePage(dashPageIdx));
  strip.appendChild(ren);

  if ((dashCurrent.pages || []).length > 1) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dash-page-ctrl';
    del.setAttribute('aria-label', 'Remove page');
    del.textContent = '×';
    del.addEventListener('click', () => handleRemovePage(dashPageIdx));
    strip.appendChild(del);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'dash-page-add';
  add.textContent = '＋ Page';
  add.addEventListener('click', () => handleAddPage());
  strip.appendChild(add);
}

function handleAddPage(): void {
  if (!dashCurrent) return;
  const n = (dashCurrent.pages || []).length + 1;
  dashCurrent.pages.push({ id: dashUuid(), name: 'Page ' + n, cards: [] });
  dashPageIdx = dashCurrent.pages.length - 1;
  markDashDirty();
  renderDashPages();
  renderDashGrid();
}

async function handleRenamePage(i: number): Promise<void> {
  if (!dashCurrent || !dashCurrent.pages[i]) return;
  const name = await promptModal('Rename page', dashCurrent.pages[i].name || 'Page ' + (i + 1), 'Save');
  if (name === null) return;
  dashCurrent.pages[i].name = name.trim() || dashCurrent.pages[i].name;
  markDashDirty();
  renderDashPages();
}

function handleRemovePage(i: number): void {
  if (!dashCurrent || dashCurrent.pages.length <= 1) return;
  if (!window.confirm('Remove this page and its cards?')) return;
  dashCurrent.pages.splice(i, 1);
  if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = dashCurrent.pages.length - 1;
  markDashDirty();
  renderDashPages();
  renderDashGrid();
}

// ── Grid + cards ──────────────────────────────────────────────────────────────
// Destroy the Chart.js / MapLibre instances living in the current grid's card
// areas BEFORE their DOM is wiped. Without this, grid.innerHTML='' detaches the
// canvases but leaves their Chart instances (and ResizeObservers/rAF handlers) in
// the registry — a real leak that accrues on every page switch / add / remove /
// close. chartInstances/mapInstances are the same script-global WeakMaps the
// capture flow uses (renderResult.ts / mapRender.ts).
function destroyDashCharts(): void {
  const grid = dashEl('dash-grid');
  if (!grid) return;
  grid.querySelectorAll('.dash-viz-area').forEach((c) => {
    try {
      const inst = chartInstances.get(c as HTMLElement);
      if (inst && typeof inst.destroy === 'function') inst.destroy();
      chartInstances.delete(c as HTMLElement);
    } catch (_) { /* already gone */ }
    try { if (typeof destroyMapInContainer === 'function') destroyMapInContainer(c as HTMLElement); } catch (_) {}
  });
}

function renderDashGrid(): void {
  const grid = dashEl('dash-grid');
  if (!grid) return;
  destroyDashCharts();
  grid.innerHTML = '';
  const page = dashCurrentPage();
  const cards = (page && Array.isArray(page.cards)) ? page.cards : [];
  dashShow('dash-starters', cards.length === 0);
  // Append every card element first (so each body has layout size), then kick
  // off the async body render into each — charts size to their grid cell.
  cards.forEach((card: any) => {
    const el = makeDashCardEl(card);
    grid.appendChild(el);
    const body = el.querySelector('.dash-card-body') as HTMLElement | null;
    if (body) renderDashCardBody(card, body);
  });
  // Grid-level drop target for native drag rearrange.
  grid.ondragover = (e) => { if (dashDragId) e.preventDefault(); };
  grid.ondrop = (e) => onDashGridDrop(e, grid);
  // The cards were just rebuilt, so the authoring workbench has to repaint its
  // selection ring and drop a selection whose card no longer exists.
  anSyncWorkbench();
  // Which datasets the sheet reads can change with any card edit, so the
  // freshness line is derived from the cards on every grid render.
  refreshDashFreshness();
}

// ── Freshness of the data behind the open sheet ──────────────────────────────
//
// An analysis and a published dashboard are only as fresh as their STALEST
// input, so the header reports the OLDEST lastRefreshedAt across every dataset
// the sheet reads. Reporting the newest would be a number that is wrong in
// exactly the direction that matters — it would tell someone their figures are
// current when half of them are a week old.
//
// Nothing is recomputed here: dashboards already recompute every figure from
// stored data on render, so a refresh that lands is picked up by re-rendering
// the sheet and no downstream plumbing changes.

/** Every dataset id the OPEN sheet reads, across visual and metric cards. */
async function dashSheetDatasetIds(): Promise<string[]> {
  const page = dashCurrentPage();
  const cards = (page && Array.isArray(page.cards)) ? page.cards : [];
  const ids = new Set<string>();
  for (const card of cards) {
    if (card && card.type === 'metric' && card.metric && card.metric.datasetId) {
      ids.add(String(card.metric.datasetId));
      continue;
    }
    if (card && card.type === 'visual') {
      // Resolves a published card's inline snapshot first, exactly as the
      // renderer does — a published dashboard reads the dataset its FROZEN
      // definition names, not whatever the source visual points at today.
      const resolved = await resolveCardVisual(card);
      if (resolved && resolved.visual && resolved.visual.datasetId) {
        ids.add(String(resolved.visual.datasetId));
      }
    }
  }
  return [...ids];
}

// Paint (or hide) the header's freshness line + Refresh data button.
async function refreshDashFreshness(): Promise<void> {
  const label = dashEl('dash-fresh');
  const btn = dashEl('dash-refresh-data') as HTMLButtonElement | null;
  if (!label || !btn) return;
  if (!currentProjectId || !dashCurrent) {
    label.hidden = true;
    btn.hidden = true;
    return;
  }

  const ids = await dashSheetDatasetIds();
  let summaries: any[] = [];
  try {
    summaries = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    summaries = [];
  }
  if (!Array.isArray(summaries)) summaries = [];
  const byId = new Map<string, any>(summaries.map((d: any) => [String(d.id), d]));

  let oldest: number | null = null;
  let anyRefreshable = false;
  ids.forEach((id) => {
    const d = byId.get(id);
    if (!d) return;
    if (d.originKind) anyRefreshable = true;
    const stamp = Date.parse(d.lastRefreshedAt || d.updatedAt || '');
    if (!Number.isFinite(stamp)) return;
    if (oldest === null || stamp < oldest) oldest = stamp;
  });

  if (oldest === null) {
    label.hidden = true;
    btn.hidden = true;
    return;
  }
  label.hidden = false;
  label.textContent = 'Data as of ' + formatSidebarTime(new Date(oldest).toISOString());
  // Say WHY it is the oldest, so a header that disagrees with a single dataset's
  // own line is explicable rather than a bug report.
  label.title = ids.length > 1
    ? 'The oldest of the ' + ids.length + ' datasets this sheet reads.'
    : '';
  btn.hidden = !anyRefreshable;
}

// Refresh exactly the datasets this sheet reads, then re-render it.
async function handleDashRefreshData(): Promise<void> {
  if (!currentProjectId) return;
  const btn = dashEl('dash-refresh-data') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
  }
  const ids = await dashSheetDatasetIds();
  let okCount = 0;
  // Sequential for the same reasons as the Data section's Refresh all: one bad
  // source must not stall the rest, and one table in flight keeps memory flat.
  for (const id of ids) {
    let res: any;
    try {
      res = await window.hub.refreshDataset(currentProjectId, id);
    } catch (_) {
      res = { ok: false };
    }
    if (res && res.ok) okCount += 1;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = '↻ Refresh data';
  }
  const failed = ids.length - okCount;
  if (typeof showToast === 'function') {
    showToast('Refreshed ' + okCount + ' of ' + ids.length + (failed > 0 ? ' · ' + failed + ' failed' : ''));
  }
  // Every figure is recomputed from stored data on render, so re-rendering IS
  // the propagation — there is nothing else downstream to update.
  renderDashGrid();
  await refreshDashFreshness();
}

// The first grid row below everything already placed. Defaults to the OPEN
// page's cards; visuals.ts passes an arbitrary sheet's card list so adding a
// card from the gallery lands where the editor would have put it — one rule for
// where the next card goes, not two.
function nextFreeRow(cardList?: any[]): number {
  let cards: any[];
  if (Array.isArray(cardList)) {
    cards = cardList;
  } else {
    const page = dashCurrentPage();
    cards = (page && Array.isArray(page.cards)) ? page.cards : [];
  }
  let max = 0;
  cards.forEach((c: any) => {
    const y = (c.layout && c.layout.y) || 0;
    const h = (c.layout && c.layout.h) || 1;
    if (y + h > max) max = y + h;
  });
  return max;
}

function applyDashCardStyle(el: HTMLElement, layout: any): void {
  const x = clampInt(layout && layout.x, 0, DASH_GRID_COLS - 1, 0);
  const w = clampInt(layout && layout.w, 1, DASH_GRID_COLS - x, 1);
  const y = Math.max(0, clampInt(layout && layout.y, 0, 100000, 0));
  const h = clampInt(layout && layout.h, 1, 100000, 1);
  el.style.gridColumn = (x + 1) + ' / span ' + w;
  el.style.gridRow = (y + 1) + ' / span ' + h;
}

function clampInt(v: any, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function makeDashCardEl(card: any): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-card dash-card--' + card.type;
  el.dataset.cardId = card.id;
  applyDashCardStyle(el, card.layout);

  // Header: drag handle + title + layout controls + remove.
  const head = document.createElement('div');
  head.className = 'dash-card-head';
  head.draggable = !dashReadOnly; // a snapshot cannot be rearranged
  head.addEventListener('dragstart', (e) => {
    dashDragId = card.id;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  head.addEventListener('dragend', () => { dashDragId = null; });

  const title = document.createElement('span');
  title.className = 'dash-card-title';
  title.textContent = dashCardTitle(card);
  head.appendChild(title);

  const ctrls = document.createElement('div');
  ctrls.className = 'dash-card-ctrls';
  // Move.
  ctrls.appendChild(dashCtrlBtn('◀', 'Move left', () => nudgeCard(card, -1, 0)));
  ctrls.appendChild(dashCtrlBtn('▶', 'Move right', () => nudgeCard(card, 1, 0)));
  ctrls.appendChild(dashCtrlBtn('▲', 'Move up', () => nudgeCard(card, 0, -1)));
  ctrls.appendChild(dashCtrlBtn('▼', 'Move down', () => nudgeCard(card, 0, 1)));
  // Resize.
  ctrls.appendChild(dashCtrlBtn('W−', 'Narrower', () => resizeCard(card, -1, 0)));
  ctrls.appendChild(dashCtrlBtn('W+', 'Wider', () => resizeCard(card, 1, 0)));
  ctrls.appendChild(dashCtrlBtn('H−', 'Shorter', () => resizeCard(card, 0, -1)));
  ctrls.appendChild(dashCtrlBtn('H+', 'Taller', () => resizeCard(card, 0, 1)));
  // Remove.
  const rm = dashCtrlBtn('🗑', 'Remove card', () => removeCard(card));
  rm.classList.add('dash-card-rm');
  ctrls.appendChild(rm);
  head.appendChild(ctrls);
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dash-card-body';
  el.appendChild(body);
  return el;
}

function dashCtrlBtn(label: string, aria: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dash-card-btn';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function dashCardTitle(card: any): string {
  if (card.type === 'visual') return 'Visual';
  if (card.type === 'metric') {
    const m = card.metric || {};
    return m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  }
  return card.heading || 'Text';
}

// Re-apply a card's grid position in place (no full re-render, so a chart isn't
// destroyed just because it moved/resized).
function reapplyCardStyle(card: any): void {
  const grid = dashEl('dash-grid');
  if (!grid) return;
  const el = grid.querySelector('.dash-card[data-card-id="' + card.id + '"]') as HTMLElement | null;
  if (el) applyDashCardStyle(el, card.layout);
}

function nudgeCard(card: any, dx: number, dy: number): void {
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  l.x = clampInt(l.x + dx, 0, DASH_GRID_COLS - (l.w || 1), l.x);
  l.y = Math.max(0, (l.y || 0) + dy);
  reapplyCardStyle(card);
  markDashDirty();
}

function resizeCard(card: any, dw: number, dh: number): void {
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  l.w = clampInt((l.w || 1) + dw, 1, DASH_GRID_COLS - (l.x || 0), l.w);
  l.h = clampInt((l.h || 1) + dh, 1, 100000, l.h);
  reapplyCardStyle(card);
  markDashDirty();
}

function removeCard(card: any): void {
  const page = dashCurrentPage();
  if (!page) return;
  const i = page.cards.indexOf(card);
  if (i >= 0) page.cards.splice(i, 1);
  markDashDirty();
  renderDashGrid();
}

function onDashGridDrop(e: DragEvent, grid: HTMLElement): void {
  if (!dashDragId) return;
  e.preventDefault();
  const page = dashCurrentPage();
  if (!page) return;
  const card = page.cards.find((c: any) => c.id === dashDragId);
  dashDragId = null;
  if (!card) return;
  const rect = grid.getBoundingClientRect();
  const colW = rect.width / DASH_GRID_COLS;
  const rowH = DASH_ROW_PX + DASH_GAP_PX;
  const nx = clampInt(Math.floor((e.clientX - rect.left) / colW), 0, DASH_GRID_COLS - (card.layout.w || 1), card.layout.x);
  const ny = Math.max(0, Math.floor((e.clientY - rect.top) / rowH));
  card.layout.x = nx;
  card.layout.y = ny;
  reapplyCardStyle(card);
  markDashDirty();
}

// ── Card body renderers ─────────────────────────────────────────────────────
function renderDashCardBody(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  if (card.type === 'visual') { renderVisualCard(card, body); return; }
  if (card.type === 'metric') { renderMetricCard(card, body); return; }
  renderTextCard(card, body);
}

// Resolve the definition a visual card draws from. A card is TWO-SHAPED:
//
//   • PUBLISHED — `card.visual` is an inline by-value snapshot of the Visual,
//     taken when the analysis was published. IT WINS, and `card.visualId` is
//     NEVER resolved: the source visual may have been edited or deleted since,
//     and a published dashboard must not move until it is published again.
//   • AUTHORING / LEGACY — `card.visualId` only, resolved from disk as before.
//
// Returns { visual, inline } so callers can tell a frozen definition from a
// live one (a published card must not write chart styling back to a source it
// no longer follows).
async function resolveCardVisual(card: any): Promise<{ visual: any; inline: boolean } | null> {
  if (card && card.visual && card.visual.datasetId) return { visual: card.visual, inline: true };
  if (!currentProjectId || !card || !card.visualId) return null;
  try {
    const v = await window.hub.getVisual(currentProjectId, card.visualId);
    return v ? { visual: v, inline: false } : null;
  } catch (_) {
    return null;
  }
}

// REUSE the existing visual render path — no charting code lives here. Resolve
// the definition (inline snapshot first, then the saved Visual) for its
// datasetId/encoding/chartType/overrides/filters, compute the renderer-ready
// data in main, then hand it to renderVizInArea exactly like the Visuals
// builder does.
async function renderVisualCard(card: any, body: HTMLElement): Promise<void> {
  if (!currentProjectId || (!card.visualId && !card.visual)) { dashCardMissing(body, 'No visual selected.'); return; }
  const resolved = await resolveCardVisual(card);
  if (!resolved) { dashCardMissing(body, 'This visual was deleted.', true); return; }
  const visual = resolved.visual;

  // Merge dashboard-wide filters (first) with the visual's own filters, then pass the
  // combined list through the UNCHANGED visual:data channel — it sanitizes + applies
  // filters (in order, missing-column-tolerant) before aggregation, so one dashboard
  // filter drives every card. Mirrors mergeDashboardFilters (src/dashboardFilters.ts).
  const merged = mergeDashFilters(dashCurrent && dashCurrent.filters, visual.filters);
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, visual.datasetId, visual.encoding, merged);
  } catch (_) {
    res = { ok: false };
  }
  if (!res || res.ok === false) { dashCardMissing(body, (res && res.error) || 'Could not draw this visual.', true); return; }

  const data = res.data || { labels: [], series: [] };
  const type = typeof visual.chartType === 'string' && visual.chartType ? visual.chartType : 'column';
  // Adapter entry: same shape the Visuals builder uses so the ⋯ Customize /
  // Values controls attach; edits persist back to the underlying visual (the
  // dashboard never owns chart styling — the visual does).
  // What a drill from this card reads. It is built from `visual` — the
  // definition `resolveCardVisual` chose — so a PUBLISHED card drills against
  // its frozen `card.visual` snapshot and never a later edit of the source
  // visual, exactly as the chart above it is drawn from that snapshot. `merged`
  // is the same filter list that computed the figure, which is what makes the
  // rows and the number agree.
  const drill: any = {
    name: dashCardTitle(card) === 'Visual' ? visual.name : dashCardTitle(card),
    projectId: currentProjectId,
    datasetId: visual.datasetId,
    encoding: visual.encoding,
    filters: merged,
  };
  const entry: any = {
    id: card.id,
    drill,
    chartOverrides: { ['v:' + type]: visual.overrides || {} },
    // On a PUBLISHED card this is a no-op: the snapshot is read-only, and
    // writing back would edit a source visual this card no longer follows —
    // the styling would silently move somewhere else's chart and not this one.
    saveOverride: (merged: any) => {
      if (resolved.inline) return;
      if (currentProjectId && card.visualId) {
        window.hub.updateVisual(currentProjectId, card.visualId, { overrides: merged || {} }).catch(() => {});
      }
    },
  };
  const area = document.createElement('div');
  area.className = 'dash-viz-area cv-viz-area';
  body.innerHTML = '';
  body.appendChild(area);
  // The trailing argument is dataset IDENTITY for the Mosaic engine — the same
  // project/dataset/encoding/filters that produced `data`, so the two engines
  // can never disagree about what this card shows. With the 'scMosaic' flag off
  // (the default) it is ignored and Chart.js draws exactly as before.
  renderVizInArea(area, data, type, entry, 'v', {
    projectId: currentProjectId, datasetId: visual.datasetId, encoding: visual.encoding, filters: merged,
  });
  // Cross-filter first: when it is on it owns the plain click (it writes), and
  // drilling stays available through the ⋯ menu. Otherwise the click drills.
  // Drilling is a READ, so it is offered on a published snapshot too.
  if (!wireCrossFilter(area, visual)) wireDrillClick(area, drill);
}

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
    applyCrossFilter(String(column), mark.category);
  });
  return true;
}

/** Toggle the clicked value on the sheet's filter list, then redraw everything. */
function applyCrossFilter(column: string, value: unknown): void {
  if (!dashCurrent || dashReadOnly) return; // a published snapshot is not editable
  dashCurrent.filters = toggleCrossFilterSteps(dashCurrent.filters, column, value);
  markDashDirty();
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
  valEl.className = 'dash-metric-value';
  valEl.textContent = '…';
  const labelEl = document.createElement('div');
  labelEl.className = 'dash-metric-label';
  labelEl.textContent = m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  body.appendChild(valEl);
  body.appendChild(labelEl);

  if (!currentProjectId || !m.datasetId || !m.column || !m.aggregation) { valEl.textContent = '—'; return; }
  let r: any;
  try {
    // Dashboard-wide filters are applied over the dataset in MAIN before the number is
    // computed (still 100% app-computed; the renderer never does the math).
    r = await window.hub.computeMetric(
      currentProjectId, m.datasetId, m.column, m.aggregation,
      (dashCurrent && Array.isArray(dashCurrent.filters)) ? dashCurrent.filters : [],
    );
  } catch (_) {
    r = { ok: false };
  }
  if (!r || r.ok === false) { dashCardMissing(body, (r && r.error) || 'Source removed', true); return; }
  if (r.value == null) { valEl.textContent = '—'; return; }
  // Reuse the shared chart number formatter (auto/plain/thousands/compact/…).
  valEl.textContent = fmtWith(r.value, m.format || 'auto');
}

function renderTextCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  if (card.heading) {
    const h = document.createElement('div');
    h.className = 'dash-card-h';
    h.textContent = String(card.heading);
    body.appendChild(h);
  }
  if (card.text) {
    const p = document.createElement('p');
    p.className = 'dash-card-p';
    p.textContent = String(card.text);
    body.appendChild(p);
  }
  if (!card.heading && !card.text) {
    const p = document.createElement('p');
    p.className = 'dash-card-p';
    p.textContent = '(empty text card)';
    body.appendChild(p);
  }
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
    badge.textContent = 'Source removed';
    // Sit the badge right after the title so it reads before the controls.
    const title = head.querySelector('.dash-card-title');
    if (title && title.nextSibling) head.insertBefore(badge, title.nextSibling);
    else head.appendChild(badge);
  }
}

// Renderer-side mirror of src/dashboardFilters.mergeDashboardFilters: dashboard filters
// FIRST, then the card's own, dropping byte-identical steps. Kept tiny + local (the
// pure main module is node-tested; this is the same rule for the live grid).
function mergeDashFilters(dashFilters: any, cardFilters: any): any[] {
  const dash = Array.isArray(dashFilters) ? dashFilters : [];
  const card = Array.isArray(cardFilters) ? cardFilters : [];
  const out: any[] = [];
  const seen = new Set<string>();
  dash.concat(card).forEach((s: any) => {
    if (!s || s.type !== 'filter') return;
    const k = JSON.stringify([s.column, s.op, s.value == null ? null : s.value]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  });
  return out;
}

// ── Add-card flows ────────────────────────────────────────────────────────────
function pushCard(card: any): void {
  const page = dashCurrentPage();
  if (!page) return;
  if (!Array.isArray(page.cards)) page.cards = [];
  page.cards.push(card);
  markDashDirty();
  renderDashGrid();
}

async function handleAddVisual(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  let visuals: any[] = [];
  try {
    visuals = await window.hub.listVisuals(currentProjectId);
  } catch (_) {
    visuals = [];
  }
  if (!Array.isArray(visuals)) visuals = [];

  const pick = await openVisualPicker(visuals);
  if (!pick) return;

  if (pick.kind === 'existing') {
    pushCard({ id: dashUuid(), type: 'visual', visualId: pick.visualId, layout: { x: 0, y: nextFreeRow(), w: 6, h: 6 } });
    return;
  }

  // 'new' | 'ai' — create a visual WITHOUT leaving the analysis. The create
  // popup (visuals.ts) only RESOLVES a choice; the navigation to the Visuals
  // builder was always its caller's doing, so from here we simply do something
  // else with the same resolution:
  //   suggested → the user already SAW the drawn chart they picked, so it is
  //     saved as a visual (name derived the same way the builder's Save
  //     suggests one) and lands on the sheet;
  //   manual → a BLANK visual on the chosen dataset lands on the sheet and is
  //     selected, which opens Properties — the wells ARE the analysis's own
  //     builder, exactly what the old Add-panel hint promised ("a new visual
  //     card starts blank — pick its fields under Properties").
  const choice = await openNewVisualModal(pick.kind === 'ai' ? { aiOnly: true } : {});
  if (!choice) return;
  const suggested = choice.kind === 'suggested';
  const chartType = suggested ? (choice.chartType || 'column') : 'column';
  let visual: any = null;
  try {
    visual = await window.hub.saveVisual({
      projectId: currentProjectId,
      datasetId: choice.datasetId,
      name: suggested ? suggestVisualName(choice.encoding || {}, chartType) : 'Untitled visual',
      chartType,
      encoding: suggested ? choice.encoding : { category: '', values: [] },
      overrides: {},
      filters: [],
    });
  } catch (_) {
    visual = null;
  }
  if (!visual || visual.ok === false || !visual.id) {
    showToast('Could not create the visual.');
    return;
  }
  const card = { id: dashUuid(), type: 'visual', visualId: String(visual.id), layout: { x: 0, y: nextFreeRow(), w: 6, h: 6 } };
  pushCard(card);
  // Select it so Properties binds (and, for a blank one, opens on the wells the
  // user fills next). Analysis mode only — a dashboard has no workbench.
  if (dashMode === 'analysis' && typeof anSelectCard === 'function') await anSelectCard(card.id);
}

/**
 * The add-visual picker: a GALLERY of the saved visuals — the same tile
 * vocabulary as the Visuals section's cards (glyph, name, type · time) — plus
 * the two ways to make a new one, which is what kills the old dead-end where an
 * empty name-list was the whole dialog.
 *
 * Resolves what to do, does nothing itself: 'existing' carries the picked id;
 * 'new' / 'ai' hand off to `openNewVisualModal` in the caller (sequential
 * dialogs, never stacked). The create actions are offered in ANALYSIS mode
 * only: a standalone dashboard has no wells to author a blank visual with.
 */
function openVisualPicker(
  visuals: any[],
): Promise<{ kind: 'existing'; visualId: string } | { kind: 'new' } | { kind: 'ai' } | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal vn-pick-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'Add a visual';

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: { kind: 'existing'; visualId: string } | { kind: 'new' } | { kind: 'ai' } | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (a11y) a11y.onTabKey(e);
    }

    const canCreate = dashMode === 'analysis';
    const actions = document.createElement('div');
    actions.className = 'vn-pick-actions';
    if (canCreate) {
      const mk = (label: string, kind: 'new' | 'ai'): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        b.addEventListener('click', () => close({ kind }));
        actions.appendChild(b);
        return b;
      };
      mk('+ New visual', 'new');
      const ai = mk('✨ Suggest with AI', 'ai');
      // The standard not_ready treatment: disabled, with the standard sentence.
      // Painted async — the dialog opens instantly and the button un-disables
      // if a model turns out to be configured.
      ai.disabled = true;
      const note = document.createElement('p');
      note.className = 'vn-pick-note';
      note.hidden = true;
      note.textContent = 'Connect a model in Execution settings to suggest a chart.';
      actions.appendChild(note);
      window.hub.getKeyStatus().then((st: any) => {
        if (done) return;
        if (st && st.isReady) ai.disabled = false;
        else note.hidden = false;
      }).catch(() => { if (!done) note.hidden = false; });
    }

    const grid = document.createElement('div');
    grid.className = 'vn-pick-grid';
    visuals.forEach((v) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'vn-pick-tile';
      const art = document.createElement('span');
      art.className = 'vn-pick-glyph';
      // The ONLY innerHTML here: VIZ_ICONS is the trusted static SVG constant
      // set (renderResult.ts), never user or model input.
      art.innerHTML = VIZ_ICONS[v && v.chartType] || VIZ_ICONS.column;
      const nm = document.createElement('span');
      nm.className = 'vn-pick-name';
      nm.textContent = v && v.name ? String(v.name) : 'Untitled visual';
      const meta = document.createElement('span');
      meta.className = 'vn-pick-meta';
      meta.textContent =
        ((v && VIZ_LABELS[v.chartType]) || (v && v.chartType) || 'Chart') + ' · ' + formatSidebarTime(v && v.updatedAt);
      tile.appendChild(art);
      tile.appendChild(nm);
      tile.appendChild(meta);
      tile.addEventListener('click', () => close({ kind: 'existing', visualId: String(v.id) }));
      grid.appendChild(tile);
    });

    const footer = document.createElement('div');
    footer.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(null));
    footer.appendChild(cancel);

    box.appendChild(h);
    box.appendChild(actions);
    if (visuals.length) {
      box.appendChild(grid);
    } else if (canCreate) {
      // No saved visuals: the two create actions ARE the content, large and
      // centred — the dead-end this picker replaces was an empty list here.
      box.classList.add('vn-pick-modal--empty');
      const p = document.createElement('p');
      p.className = 'vn-pick-empty';
      p.textContent = 'No saved visuals yet — make one right here.';
      box.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.className = 'dash-modal-empty';
      p.textContent = 'Nothing to pick — create one in its section first.';
      box.appendChild(p);
    }
    box.appendChild(footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Add a visual', null);
  });
}

async function handleAddMetric(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  let datasets: any[] = [];
  try {
    datasets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    datasets = [];
  }
  if (!Array.isArray(datasets)) datasets = [];
  const metric = await openMetricDialog(datasets);
  if (!metric) return;
  pushCard({ id: dashUuid(), type: 'metric', metric, layout: { x: 0, y: nextFreeRow(), w: 3, h: 2 } });
}

/**
 * ONE dialog for the whole metric — dataset, column, aggregation, label — where
 * adding one used to be FOUR chained modals, each of which forgot the last.
 *
 * The preview is the number the card will show, computed by the SAME call the
 * metric card on the sheet makes (`window.hub.computeMetric`, main-only, with
 * the sheet's current filters) — not a second compute that could disagree with
 * it. Nothing is ever computed in the renderer and nothing is stored: the card
 * recomputes on every render exactly as before; this just shows the user what
 * they are adding before they add it.
 *
 * Same modal shell as `dashChooseModal`: backdrop, Escape, focus trapped and
 * returned via the shared `makeModalAccessible`.
 */
function openMetricDialog(
  datasets: any[],
): Promise<{ datasetId: string; column: string; aggregation: string; label?: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-metric-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'Add a metric';

    const field = (labelText: string, control: HTMLElement): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'dm-field';
      const span = document.createElement('span');
      span.className = 'dm-field-label';
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(control);
      return row;
    };

    const dsSel = document.createElement('select');
    dsSel.className = 'ws-modal-input';
    datasets.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      dsSel.appendChild(opt);
    });

    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';

    // Aggregation as a segmented row, not a fifth dropdown — five options with
    // one always active is a radio group, and seeing them all is what makes
    // "Count of a text column" discoverable.
    const aggRow = document.createElement('div');
    aggRow.className = 'dm-aggs';
    aggRow.setAttribute('role', 'radiogroup');
    aggRow.setAttribute('aria-label', 'Aggregation');
    let aggregation: DashAgg = 'sum';
    const paintAggs = (): void => {
      aggRow.querySelectorAll('.dm-agg').forEach((b) => {
        const on = (b as HTMLElement).dataset.agg === aggregation;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    DASH_AGGS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-agg';
      b.dataset.agg = a;
      b.setAttribute('role', 'radio');
      b.textContent = DASH_AGG_LABELS[a];
      b.addEventListener('click', () => { aggregation = a; paintAggs(); onChange(); });
      aggRow.appendChild(b);
    });

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'ws-modal-input';
    labelInput.placeholder = 'Label';
    // The label follows the other three fields until the user edits it by hand —
    // after that it is theirs and no change below may clobber it.
    let labelTouched = false;
    labelInput.addEventListener('input', () => { labelTouched = true; });
    const autoLabel = (): string => DASH_AGG_LABELS[aggregation] + ' of ' + (colSel.value || '');

    // The live preview: label + value, the same pair the card renders.
    const preview = document.createElement('div');
    preview.className = 'dm-preview';
    const prevVal = document.createElement('div');
    prevVal.className = 'dash-metric-value';
    prevVal.textContent = '—';
    const prevLabel = document.createElement('div');
    prevLabel.className = 'dash-metric-label';
    preview.appendChild(prevVal);
    preview.appendChild(prevLabel);

    // Debounced, generation-counted: a slow reply for the previous column must
    // not paint over the current one.
    let previewTimer = 0;
    let previewSeq = 0;
    const runPreview = async (): Promise<void> => {
      const seq = ++previewSeq;
      const dsId = dsSel.value;
      const column = colSel.value;
      prevLabel.textContent = labelInput.value.trim() || autoLabel();
      if (!dsId || !column || !currentProjectId) { prevVal.textContent = '—'; return; }
      prevVal.textContent = '…';
      let r: any;
      try {
        r = await window.hub.computeMetric(
          currentProjectId, dsId, column, aggregation,
          (dashCurrent && Array.isArray(dashCurrent.filters)) ? dashCurrent.filters : [],
        );
      } catch (_) {
        r = { ok: false };
      }
      if (done || seq !== previewSeq) return;
      if (!r || r.ok === false || r.value == null) { prevVal.textContent = '—'; return; }
      prevVal.textContent = fmtWith(r.value, 'auto');
    };
    const onChange = (): void => {
      if (!labelTouched) labelInput.value = autoLabel();
      prevLabel.textContent = labelInput.value.trim() || autoLabel();
      if (previewTimer) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => { previewTimer = 0; void runPreview(); }, 200);
    };

    // Columns for the picked dataset, NUMERIC FIRST — sum/avg/min/max only mean
    // something on a number column, so those are the likely picks. A stable sort
    // keeps the dataset's own order within each group.
    const loadColumns = async (): Promise<void> => {
      colSel.innerHTML = '';
      let meta: any = null;
      try {
        meta = currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, dsSel.value) : null;
      } catch (_) {
        meta = null;
      }
      if (done) return;
      const cols: any[] = meta && Array.isArray(meta.columns) ? meta.columns : [];
      const ordered = cols
        .map((c, i) => ({ c, i }))
        .sort((a, b) => Number(b.c && b.c.type === 'number') - Number(a.c && a.c.type === 'number') || a.i - b.i);
      ordered.forEach(({ c }) => {
        const opt = document.createElement('option');
        opt.value = String(c.name);
        opt.textContent = String(c.name) + (c.type ? ' (' + c.type + ')' : '');
        colSel.appendChild(opt);
      });
      ok.disabled = colSel.options.length === 0;
      onChange();
    };
    dsSel.addEventListener('change', () => { void loadColumns(); });
    colSel.addEventListener('change', onChange);
    labelInput.addEventListener('input', onChange);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'Add';
    ok.disabled = datasets.length === 0;

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: { datasetId: string; column: string; aggregation: string; label?: string } | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function submit(): void {
      if (ok.disabled || !dsSel.value || !colSel.value) return;
      const out: { datasetId: string; column: string; aggregation: string; label?: string } = {
        datasetId: dsSel.value, column: colSel.value, aggregation,
      };
      // A hand-written label is kept; the auto one is not stored, so the card
      // keeps deriving it and a later column rename stays truthful.
      if (labelTouched && labelInput.value.trim()) out.label = labelInput.value.trim();
      close(out);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    if (datasets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'dash-modal-empty';
      empty.textContent = 'Import a dataset first — a metric reads one.';
      box.appendChild(empty);
    } else {
      box.appendChild(field('Dataset', dsSel));
      box.appendChild(field('Column', colSel));
      box.appendChild(field('Aggregation', aggRow));
      box.appendChild(field('Label', labelInput));
      box.appendChild(preview);
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Add a metric', datasets.length ? dsSel : cancel);
    paintAggs();
    if (datasets.length) void loadColumns();
  });
}

async function handleAddText(): Promise<void> {
  const heading = await promptModal('Text card — heading (optional)', '', 'Next');
  if (heading === null) return;
  const text = await promptModal('Text card — body (optional)', '', 'Add');
  if (text === null) return;
  if (!heading.trim() && !text.trim()) return; // a card with no content is dropped anyway
  const card: any = { id: dashUuid(), type: 'text', layout: { x: 0, y: nextFreeRow(), w: 6, h: 2 } };
  if (heading.trim()) card.heading = heading.trim();
  if (text.trim()) card.text = text.trim();
  pushCard(card);
}

// ── Starter layouts (scaffolding only — the user still picks each card's source) ─
async function applyStarter(kind: string): Promise<void> {
  const page = dashCurrentPage();
  if (!page) return;
  if (!Array.isArray(page.cards)) page.cards = [];
  if (page.cards.length && !window.confirm('Add starter cards to this page?')) return;

  if (kind === 'kpis') {
    // Add a note prompting the user to fill in metrics, plus a wide visual slot.
    page.cards.push({ id: dashUuid(), type: 'text', heading: 'KPIs', text: 'Add metric cards here (+ Metric), then a chart below.', layout: { x: 0, y: 0, w: 12, h: 2 } });
    // The visual card needs a real visualId — offer the picker for the wide slot.
    await addStarterVisual({ x: 0, y: 2, w: 12, h: 6 });
  } else if (kind === 'twoup') {
    await addStarterVisual({ x: 0, y: 0, w: 6, h: 6 });
    await addStarterVisual({ x: 6, y: 0, w: 6, h: 6 });
    page.cards.push({ id: dashUuid(), type: 'text', heading: 'Notes', text: 'Add your notes here.', layout: { x: 0, y: 6, w: 12, h: 2 } });
  }
  markDashDirty();
  renderDashPages();
  renderDashGrid();
}

// Offer the visual picker for a starter slot; skips the slot if cancelled or if
// the project has no visuals yet (the user can add one later with + Visual).
async function addStarterVisual(layout: any): Promise<void> {
  const page = dashCurrentPage();
  if (!page || !currentProjectId) return;
  let visuals: any[] = [];
  try {
    visuals = await window.hub.listVisuals(currentProjectId);
  } catch (_) {
    visuals = [];
  }
  if (!Array.isArray(visuals) || !visuals.length) return;
  const visualId = await dashChooseModal(
    'Pick a visual for this slot',
    visuals.map((v) => ({ value: String(v.id), label: v && v.name ? String(v.name) : 'Untitled visual' })),
    'Add',
  );
  if (visualId === null) return;
  page.cards.push({ id: dashUuid(), type: 'visual', visualId, layout });
}

// ── Save ────────────────────────────────────────────────────────────────────
function scheduleDashSave(): void {
  if (dashSaveTimer !== null) window.clearTimeout(dashSaveTimer);
  dashSaveTimer = window.setTimeout(() => {
    dashSaveTimer = null;
    persistDashboard();
  }, 600);
}

async function persistDashboard(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  // A PUBLISHED dashboard is a read-only snapshot: main refuses the write
  // (src/dashboards.ts updateDashboard), so don't fire the autosave at it. This
  // check is a courtesy that keeps the debounce quiet — the guarantee is the
  // main-process one, not this line.
  if (dashMode === 'dashboard' && dashCurrent.analysisId) { dashDirty = false; return; }
  if (dashMode === 'analysis') { await persistAnalysis(); return; }
  try {
    const res = await window.hub.updateDashboard(currentProjectId, dashCurrent.id, {
      name: dashCurrent.name,
      pages: dashCurrent.pages,
      filters: Array.isArray(dashCurrent.filters) ? dashCurrent.filters : [],
    });
    if (res && res.ok && res.dashboard) {
      // Adopt main's sanitized copy (dropped/clamped cards) without a full
      // re-render if nothing visibly changed; keep the open page index.
      dashCurrent = res.dashboard;
      if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
      if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = 0;
    }
    dashDirty = false;
  } catch (_) { /* keep dashDirty so an explicit Save can retry */ }
}

// The analysis half of persistDashboard: same edits, different channel. Sheets
// are read straight out of `pages` because they are the same array.
async function persistAnalysis(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  try {
    const res = await window.hub.updateAnalysis(currentProjectId, dashCurrent.id, {
      name: dashCurrent.name,
      sheets: dashCurrent.pages,
      filters: Array.isArray(dashCurrent.filters) ? dashCurrent.filters : [],
    });
    if (res && res.ok && res.analysis) {
      // Adopt main's sanitized copy, keeping the pages/sheets alias intact.
      dashCurrent = res.analysis;
      dashCurrent.pages = dashCurrent.sheets;
      if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
      if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = 0;
    }
    dashDirty = false;
    renderAnalysisPubState(); // an edit means "unpublished changes" — say so
  } catch (_) { /* keep dashDirty so an explicit Save can retry */ }
}

async function handleSaveDashboard(): Promise<void> {
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  await persistDashboard();
  if (dashMode === 'analysis') await refreshAnalysisListKeepEditor();
  else await refreshDashboardListKeepEditor();
}

async function handleBackToList(): Promise<void> {
  const wasAnalysis = dashMode === 'analysis';
  if (dashDirty) await persistDashboard();
  closeDashboardEditor();
  if (wasAnalysis) await refreshAnalysisList();
  else await refreshDashboardList();
}

// ── Embedded AI actions (Week 12) ─────────────────────────────────────────────
// Shared across every embedded AI panel (calc field, summary, anomalies) so all
// look identical: a badge + a label marking the block as AI interpretation, clearly
// distinct from the app-computed facts. Returns the head row; callers append a body.
function mkAiPanel(labelText: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'ai-interp-head';
  const badge = document.createElement('span');
  badge.className = 'ai-badge';
  badge.textContent = 'AI';
  const label = document.createElement('span');
  label.className = 'ai-interp-label';
  label.textContent = labelText;
  head.appendChild(badge);
  head.appendChild(label);
  return head;
}

// Render a labeled AI-interpretation panel (badge/label + prose body) into `out`.
function renderAiPanel(out: HTMLElement, labelText: string, bodyText: string): void {
  out.hidden = false;
  out.innerHTML = '';
  out.appendChild(mkAiPanel(labelText));
  const body = document.createElement('div');
  body.className = 'ai-interp-body';
  body.textContent = bodyText;
  out.appendChild(body);
}

// Render the anomaly panel: AI prose (interpretation) PLUS a visually separate
// block of the app-detected, app-computed anomaly facts.
function renderAnomaliesPanel(out: HTMLElement, anomalies: any[], proseText: string): void {
  out.hidden = false;
  out.innerHTML = '';
  out.appendChild(mkAiPanel('AI interpretation — figures are app-computed'));
  if (proseText) {
    const body = document.createElement('div');
    body.className = 'ai-interp-body';
    body.textContent = proseText;
    out.appendChild(body);
  }
  const list = Array.isArray(anomalies) ? anomalies : [];
  if (list.length) {
    const facts = document.createElement('div');
    facts.className = 'ai-facts';
    const flabel = document.createElement('div');
    flabel.className = 'ai-facts-label';
    flabel.textContent = 'App-detected (computed)';
    facts.appendChild(flabel);
    list.forEach((a: any) => {
      const item = document.createElement('div');
      item.className = 'ai-facts-item' + (a && a.severity === 'warn' ? ' ai-facts-warn' : '');
      item.textContent = a && a.detail ? String(a.detail) : '';
      facts.appendChild(item);
    });
    out.appendChild(facts);
  }
}

// The AI draft now lands on the ANALYSIS surface — see handleDraftAnalysis in
// analyses.ts. The channel (analysis:draft) always returned `sheets`; what was
// missing was somewhere to put them, and `dashboard:draft` no longer exists.

// Executive summary (editor): persist pending edits, then main recomputes every
// card's figure and feeds them as FACTS; the model only narrates. Prose renders as
// clearly-labeled AI interpretation above the grid.
async function handleDashSummary(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  if (dashDirty) await persistDashboard();
  const out = dashEl('dash-ai-out');
  if (!out) return;
  const lbl = 'AI interpretation — figures are app-computed';
  renderAiPanel(out, lbl, 'Thinking…');
  let res: any;
  try {
    res = await window.hub.summarizeDashboard(currentProjectId, dashCurrent.id);
  } catch (_) {
    res = { ok: false, error: 'Could not summarize the dashboard.' };
  }
  if (res && res.notReady) {
    renderAiPanel(out, lbl, 'Connect a model in Execution settings to summarize the dashboard.');
    return;
  }
  if (!res || res.ok === false) {
    renderAiPanel(out, lbl, (res && res.error) || 'Could not summarize the dashboard.');
    return;
  }
  renderAiPanel(out, lbl, res.text || 'No summary produced.');
}

// Explain anomalies (editor): the APP detects anomalies (pure, computed) and the
// model only contextualizes them. Show the AI prose plus the separate app-computed
// facts list. Empty → "No unusual changes detected." (no model needed).
async function handleDashAnomalies(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  if (dashDirty) await persistDashboard();
  const out = dashEl('dash-ai-out');
  if (!out) return;
  const lbl = 'AI interpretation — figures are app-computed';
  renderAiPanel(out, lbl, 'Thinking…');
  let res: any;
  try {
    res = await window.hub.explainDashboardAnomalies(currentProjectId, dashCurrent.id);
  } catch (_) {
    res = { ok: false, error: 'Could not explain anomalies.' };
  }
  if (res && res.notReady) {
    // The app may still have detected anomalies with no model configured — show the
    // computed facts alongside a gentle hint in place of the AI prose.
    renderAnomaliesPanel(out, res.anomalies, 'Connect a model in Execution settings to interpret these anomalies.');
    return;
  }
  if (!res || res.ok === false) {
    renderAiPanel(out, lbl, (res && res.error) || 'Could not explain anomalies.');
    return;
  }
  const list = Array.isArray(res.anomalies) ? res.anomalies : [];
  if (!res.text && list.length === 0) {
    renderAiPanel(out, lbl, 'No unusual changes detected.');
    return;
  }
  renderAnomaliesPanel(out, list, res.text || '');
}

// ── Dashboard-wide filters (toolbar) ──────────────────────────────────────────
// Filter steps reuse the Week 6 FilterStep vocabulary. Value-less operators need no
// value input.
const DASH_FILTER_OPS: Array<{ value: string; label: string }> = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: '>', label: 'greater than' },
  { value: '<', label: 'less than' },
  { value: '>=', label: 'at least' },
  { value: '<=', label: 'at most' },
  { value: 'contains', label: 'contains' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
  { value: 'in', label: 'is any of' },
  { value: 'not in', label: 'is none of' },
];
const DASH_VALUELESS_OPS = new Set(['is_empty', 'not_empty']);

function dashFilters(): any[] {
  if (!dashCurrent) return [];
  if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
  return dashCurrent.filters;
}

function dashFilterLabel(step: any): string {
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
    chip.className = 'dash-filter-chip';
    // The chip's text is the edit affordance — a button, not a span, so it is
    // keyboard-reachable and announces itself.
    const txt = document.createElement('button');
    txt.type = 'button';
    txt.className = 'dash-filter-chip-txt';
    txt.textContent = dashFilterLabel(step);
    txt.setAttribute('aria-label', 'Edit filter: ' + dashFilterLabel(step));
    txt.addEventListener('click', () => { void handleEditDashFilter(i); });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dash-filter-chip-x';
    x.setAttribute('aria-label', 'Remove filter');
    x.textContent = '×';
    x.addEventListener('click', () => removeDashFilterAt(i));
    chip.appendChild(txt);
    chip.appendChild(x);
    chips.appendChild(chip);
  });
  if (list.length === 0) {
    const none = document.createElement('span');
    none.className = 'dash-filter-none';
    none.textContent = 'None';
    chips.appendChild(none);
  }
  dashShow('dash-clear-filters', list.length > 0);
}

// Any filter change re-renders every card with the merged filters, then debounce-saves.
function afterDashFilterChange(): void {
  markDashDirty();
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
  if (!currentProjectId) { window.alert('Open a project first.'); return null; }
  let datasets: any[] = [];
  try { datasets = await window.hub.listDatasets(currentProjectId); } catch (_) { datasets = []; }
  if (!Array.isArray(datasets)) datasets = [];
  const dsId = await dashChooseModal(
    'Filter — pick a dataset',
    datasets.map((d) => ({ value: String(d.id), label: d && d.name ? String(d.name) : 'Untitled dataset' })),
    'Next',
  );
  if (dsId === null) return null;
  let ds: any = null;
  try { ds = await window.hub.getDatasetMeta(currentProjectId, dsId); } catch (_) { ds = null; }
  let cols = ds && Array.isArray(ds.columns) ? ds.columns : [];
  if (columnFilter) cols = cols.filter(columnFilter);
  const column = await dashChooseModal(
    'Filter — pick a column',
    cols.map((c: any) => ({ value: String(c.name), label: String(c.name) + (c.type ? ' (' + c.type + ')' : '') })),
    'Next',
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
  return JSON.stringify([s.column, s.op, s.value == null ? null : s.value, s.values == null ? null : s.values]);
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
  const value = await dashChooseModal('Category — pick a value', opts, 'Apply');
  if (value === null) return;
  upsertDashFilter({ type: 'filter', column: picked.column, op: '=', value });
}

// Period quick control: like Category but scoped to date columns (falls back to all if a
// dataset has none). Kept intentionally simple (single value, `=`) per the brief.
async function handleDashPeriod(): Promise<void> {
  const picked = await pickDatasetAndColumn((c) => c && c.type === 'date');
  if (!picked) return;
  const opts = await distinctColumnOptions(String(picked.ds && picked.ds.id ? picked.ds.id : ""), picked.column);
  const value = await dashChooseModal('Period — pick a value', opts, 'Apply');
  if (value === null) return;
  upsertDashFilter({ type: 'filter', column: picked.column, op: '=', value });
}

// ── Presentation mode (renderer-only; no window, no IPC) ──────────────────────
let dashPresenting = false;
let dashPresentKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function enterDashPresent(): void {
  if (dashPresenting || !dashCurrent) return;
  dashPresenting = true;
  document.documentElement.classList.add('dash-presenting');
  dashShow('dash-present-exit', true);
  dashPresentKeyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); exitDashPresent(); } };
  document.addEventListener('keydown', dashPresentKeyHandler, true);
  renderDashGrid(); // rebuild so charts refit the fuller viewport (destroy→rebuild, no leak)
}

function exitDashPresent(): void {
  if (!dashPresenting) return;
  dashPresenting = false;
  document.documentElement.classList.remove('dash-presenting');
  dashShow('dash-present-exit', false);
  if (dashPresentKeyHandler) { document.removeEventListener('keydown', dashPresentKeyHandler, true); dashPresentKeyHandler = null; }
  renderDashGrid();
}

// ── Export (HTML / PDF / PNG) ─────────────────────────────────────────────────
// Core Chart.js types that can render LIVE from inlined {labels,series} in the
// self-contained HTML. Ordinate type → Chart.js native type. Anything else
// (clustered/stacked/combo/heatmap/treemap/… + maps + table) is embedded as a PNG.
const DASH_EXPORT_LIVE_TYPES: Record<string, string> = {
  column: 'bar', line: 'line', line_markers: 'line', area: 'line',
  pie: 'pie', donut: 'doughnut', scatter: 'scatter', bubble: 'bubble',
};
function dashIsMapType(t: string): boolean { return t === 'map_bubble' || t === 'map_choropleth'; }

// Build the serializable export bundle. `forCapture` forces EVERY visual to a PNG image
// (the PNG/PDF one-pager is rendered offscreen where Chart.js isn't loaded); the HTML
// export keeps core chart types live. Only computed values + labels + PNGs are emitted —
// never a raw dataset row, never a secret.
async function assembleExportBundle(forCapture: boolean): Promise<any> {
  const pages: any[] = [];
  const srcPages = (dashCurrent && Array.isArray(dashCurrent.pages)) ? dashCurrent.pages : [];
  for (const page of srcPages) {
    const cards: any[] = [];
    const srcCards = Array.isArray(page.cards) ? page.cards : [];
    for (const card of srcCards) {
      const layout = card.layout || { x: 0, y: 0, w: 6, h: 4 };
      if (card.type === 'text') {
        cards.push({ kind: 'text', layout, heading: card.heading || '', text: card.text || '' });
        continue;
      }
      if (card.type === 'metric') {
        const built = await buildMetricExportCard(card, layout);
        cards.push(built);
        continue;
      }
      if (card.type === 'visual') {
        const built = await buildVisualExportCard(card, layout, forCapture);
        cards.push(built);
        continue;
      }
      cards.push({ kind: 'broken', layout, reason: 'Unknown card' });
    }
    pages.push({ name: page.name || 'Page', cards });
  }
  return { name: (dashCurrent && dashCurrent.name) || 'Dashboard', pages };
}

async function buildMetricExportCard(card: any, layout: any): Promise<any> {
  const m = card.metric || {};
  const label = m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  if (!currentProjectId || !m.datasetId || !m.column || !m.aggregation) {
    return { kind: 'broken', layout, reason: 'Metric not configured' };
  }
  let r: any;
  try {
    r = await window.hub.computeMetric(
      currentProjectId, m.datasetId, m.column, m.aggregation,
      Array.isArray(dashCurrent.filters) ? dashCurrent.filters : [],
    );
  } catch (_) { r = { ok: false }; }
  if (!r || r.ok === false) return { kind: 'broken', layout, reason: 'Source removed' };
  const value = r.value == null ? null : fmtWith(r.value, m.format || 'auto');
  return { kind: 'metric', layout, label, value, format: m.format || 'auto' };
}

async function buildVisualExportCard(card: any, layout: any, forCapture: boolean): Promise<any> {
  if (!currentProjectId || (!card.visualId && !card.visual)) return { kind: 'broken', layout, reason: 'No visual selected' };
  // Same two-shaped resolution as renderVisualCard: an inline publish-time
  // snapshot wins, so an export of a published dashboard carries the frozen
  // definition — and still exports fine after the source visual is deleted.
  const resolved = await resolveCardVisual(card);
  if (!resolved) return { kind: 'broken', layout, reason: 'Source removed' };
  const visual = resolved.visual;
  const merged = mergeDashFilters(dashCurrent && dashCurrent.filters, visual.filters);
  let res: any;
  try { res = await window.hub.computeVisualData(currentProjectId, visual.datasetId, visual.encoding, merged); }
  catch (_) { res = { ok: false }; }
  if (!res || res.ok === false) return { kind: 'broken', layout, reason: 'Could not draw this visual' };
  const data = res.data || { labels: [], series: [] };
  const type = typeof visual.chartType === 'string' && visual.chartType ? visual.chartType : 'column';
  const title = visual.name || '';

  // Live-chartable core type in the HTML export → inline data (interactive).
  if (!forCapture && !dashIsMapType(type) && DASH_EXPORT_LIVE_TYPES[type]) {
    return {
      kind: 'chart', layout, chartType: DASH_EXPORT_LIVE_TYPES[type], title,
      data: {
        labels: Array.isArray(data.labels) ? data.labels : [],
        series: (Array.isArray(data.series) ? data.series : []).map((s: any) => ({
          label: s && s.name ? String(s.name) : '',
          values: Array.isArray(s.values) ? s.values : [],
        })),
      },
    };
  }
  // Everything else (maps / plugin charts / table, and ALL visuals in a capture) → PNG,
  // captured through the EXISTING report-capture helpers (reuse, no new dependency).
  let png: string | null = null;
  try {
    png = dashIsMapType(type)
      ? await captureMapPNG(data, type)
      : await captureChartPNG(type, data, visual.overrides || {});
  } catch (_) { png = null; }
  if (!png) return { kind: 'broken', layout, reason: 'Chart could not be rendered' };
  return { kind: 'image', layout, png, title };
}

// Static one-pager HTML for the PNG/PDF path. Rendered in an OFFSCREEN sandboxed window
// (its own data: origin — the hub CSP does not apply), so inline styles are fine here.
// Every card is an image / metric / text / broken tile (no live Chart.js needed).
function buildDashCaptureHtml(bundle: any): string {
  const esc = (s: any) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cols = DASH_GRID_COLS;
  let body = `<h1 class="d-title">${esc(bundle.name)}</h1>`;
  const multi = Array.isArray(bundle.pages) && bundle.pages.length > 1;
  (bundle.pages || []).forEach((page: any) => {
    if (multi) body += `<h2 class="d-page">${esc(page.name)}</h2>`;
    body += '<div class="d-grid">';
    (page.cards || []).forEach((card: any) => {
      const L = card.layout || { x: 0, y: 0, w: 6, h: 4 };
      const style = `grid-column:${(L.x || 0) + 1} / span ${L.w || 1};grid-row:${(L.y || 0) + 1} / span ${L.h || 1};`;
      let inner = '';
      if (card.kind === 'image') {
        if (card.title) inner += `<div class="d-ct">${esc(card.title)}</div>`;
        inner += `<img class="d-img" src="${esc(card.png)}" alt="${esc(card.title || 'chart')}">`;
      } else if (card.kind === 'metric') {
        if (card.label) inner += `<div class="d-ml">${esc(card.label)}</div>`;
        inner += `<div class="d-mv">${card.value == null ? '—' : esc(card.value)}</div>`;
      } else if (card.kind === 'text') {
        if (card.heading) inner += `<div class="d-th">${esc(card.heading)}</div>`;
        if (card.text) inner += `<div class="d-tb">${esc(card.text)}</div>`;
      } else {
        inner = `<div class="d-bk">Unavailable</div><div class="d-bkr">${esc(card.reason || 'Source removed')}</div>`;
      }
      const cls = card.kind === 'broken' ? 'd-card d-card-broken' : 'd-card';
      body += `<div class="${cls}" style="${style}">${inner}</div>`;
    });
    body += '</div>';
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:#f4f4f5;color:#18181b;
      font-family:-apple-system,system-ui,'Segoe UI',sans-serif}
    .d-root{max-width:1160px;margin:0 auto;padding:24px 20px 40px}
    .d-title{font-size:22px;font-weight:700;margin:0 0 16px}
    .d-page{font-size:14px;font-weight:600;color:#6b7280;margin:18px 0 8px}
    .d-grid{display:grid;grid-template-columns:repeat(${cols},1fr);grid-auto-rows:80px;gap:12px;margin-bottom:24px}
    .d-card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:12px;overflow:hidden;
      display:flex;flex-direction:column;min-height:0}
    .d-ct{font-size:12px;font-weight:600;color:#6b7280;margin-bottom:8px;text-transform:uppercase;letter-spacing:.03em}
    .d-img{max-width:100%;max-height:100%;object-fit:contain;margin:auto}
    .d-ml{font-size:13px;color:#6b7280}
    .d-mv{font-size:30px;font-weight:700;margin-top:auto}
    .d-th{font-size:16px;font-weight:600;margin-bottom:6px}
    .d-tb{font-size:13px;color:#3f3f46;white-space:pre-wrap}
    .d-card-broken{border-style:dashed;border-color:#d4d4d8;background:#fafafa;align-items:center;
      justify-content:center;text-align:center;color:#9ca3af}
    .d-bk{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa}
    .d-bkr{font-size:12px;color:#b4b4bb;margin-top:4px}
  </style></head><body><div class="d-root">${body}</div></body></html>`;
}

async function handleDashExport(): Promise<void> {
  if (!dashCurrent) return;
  const choice = await dashChooseModal(
    'Export dashboard',
    [
      { value: 'html', label: 'Interactive HTML (charts export as images)' },
      { value: 'pdf', label: 'PDF document' },
      { value: 'png', label: 'PNG image' },
    ],
    'Export',
  );
  if (choice === null) return;
  const safe = String(dashCurrent.name || 'dashboard').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'dashboard';
  if (choice === 'html') {
    showToast('Building HTML…');
    try {
      const bundle = await assembleExportBundle(false);
      const res = await window.hub.exportDashboardHtml(bundle, safe + '.html');
      reportExportResult(res, 'HTML');
    } catch (e) { showToast('Export failed'); }
    return;
  }
  // PDF / PNG: build the offscreen one-pager (all visuals as PNGs), then capture in MAIN.
  showToast(choice === 'pdf' ? 'Building PDF…' : 'Building image…');
  try {
    const bundle = await assembleExportBundle(true);
    const html = buildDashCaptureHtml(bundle);
    const res = choice === 'pdf'
      ? await window.hub.exportDashboardPdf(html, 1160, safe + '.pdf')
      : await window.hub.exportDashboardPng(html, 1160, safe + '.png');
    reportExportResult(res, choice === 'pdf' ? 'PDF' : 'PNG');
  } catch (e) { showToast('Export failed'); }
}

function reportExportResult(res: any, kind: string): void {
  if (res && res.ok) showToast(kind + ' saved');
  else if (res && res.canceled) { /* user cancelled the save panel — no toast */ }
  else showToast((res && res.error) || (kind + ' export failed'));
}

// ── Share (reveal the git-shareable, secret-free project folder) ──────────────
function handleDashShare(): void {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal dash-share-modal';
  const h = document.createElement('div');
  h.className = 'ws-modal-title';
  h.textContent = 'Share this project';
  const p1 = document.createElement('p');
  p1.className = 'dash-share-note';
  p1.textContent = 'The project folder holds your datasets, visuals, and dashboards as plain text (JSON) — it is the shareable, git-able artifact. Commit it to a repo and others can open the exact same workspace.';
  const p2 = document.createElement('p');
  p2.className = 'dash-share-note dash-share-note--safe';
  p2.textContent = 'Connection secrets and API keys are NOT in this folder. They stay in a separate, gitignored config file and never leave your machine — so sharing the folder never leaks a secret.';
  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn';
  close.textContent = 'Close';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'btn btn-primary';
  reveal.textContent = 'Reveal folder';
  let done = false;
  function shut(): void {
    if (done) return; done = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') { e.preventDefault(); shut(); } }
  close.addEventListener('click', shut);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  reveal.addEventListener('click', async () => {
    try {
      const res = await window.hub.revealProjectFolder(currentProjectId as string);
      if (!res || res.ok === false) showToast((res && res.error) || 'Could not reveal the folder');
    } catch (_) { showToast('Could not reveal the folder'); }
    shut();
  });
  actions.appendChild(close);
  actions.appendChild(reveal);
  box.appendChild(h);
  box.appendChild(p1);
  box.appendChild(p2);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ── Boot wiring (once) ────────────────────────────────────────────────────────
function initDashboards(): void {
  const newBtn = dashEl('dash-new-btn');
  if (newBtn) newBtn.addEventListener('click', () => handleNewDashboard());
  const summaryBtn = dashEl('dash-summary-btn');
  if (summaryBtn) summaryBtn.addEventListener('click', () => handleDashSummary());
  const anomaliesBtn = dashEl('dash-anomalies-btn');
  if (anomaliesBtn) anomaliesBtn.addEventListener('click', () => handleDashAnomalies());

  const back = dashEl('dash-back-btn');
  if (back) back.addEventListener('click', () => handleBackToList());

  const refreshData = dashEl('dash-refresh-data');
  if (refreshData) refreshData.addEventListener('click', () => handleDashRefreshData());

  const rename = dashEl('dash-rename-btn');
  if (rename) rename.addEventListener('click', () => {
    if (!dashCurrent) return;
    if (dashMode === 'analysis') handleRenameAnalysis(dashCurrent.id, dashCurrent.name || '');
    else handleRenameDashboard(dashCurrent.id, dashCurrent.name || '');
  });

  const addV = dashEl('dash-add-visual');
  if (addV) addV.addEventListener('click', () => handleAddVisual());
  const addM = dashEl('dash-add-metric');
  if (addM) addM.addEventListener('click', () => handleAddMetric());
  const addT = dashEl('dash-add-text');
  if (addT) addT.addEventListener('click', () => handleAddText());

  const save = dashEl('dash-save-btn');
  if (save) save.addEventListener('click', () => handleSaveDashboard());

  const stK = dashEl('dash-starter-kpis');
  if (stK) stK.addEventListener('click', () => applyStarter('kpis'));
  const stT = dashEl('dash-starter-twoup');
  if (stT) stT.addEventListener('click', () => applyStarter('twoup'));

  // ── Week 10 toolbar: filters, quick controls, present, export, share ──
  const addF = dashEl('dash-add-filter');
  if (addF) addF.addEventListener('click', () => handleAddDashFilter());
  const clrF = dashEl('dash-clear-filters');
  if (clrF) clrF.addEventListener('click', () => handleClearDashFilters());
  const catC = dashEl('dash-category-select');
  if (catC) catC.addEventListener('click', () => handleDashCategory());
  const perC = dashEl('dash-period-select');
  if (perC) perC.addEventListener('click', () => handleDashPeriod());
  const pres = dashEl('dash-present-btn');
  if (pres) pres.addEventListener('click', () => enterDashPresent());
  const presX = dashEl('dash-present-exit');
  if (presX) presX.addEventListener('click', () => exitDashPresent());
  const exp = dashEl('dash-export-btn');
  if (exp) exp.addEventListener('click', () => handleDashExport());
  const shr = dashEl('dash-share-btn');
  if (shr) shr.addEventListener('click', () => handleDashShare());
}
