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

  // The empty-sheet block's three add buttons delegate to the head strip's, so
  // each action keeps exactly one handler.
  ([
    ['dash-starter-visual', 'dash-add-visual'],
    ['dash-starter-metric', 'dash-add-metric'],
    ['dash-starter-text', 'dash-add-text'],
  ] as Array<[string, string]>).forEach(([id, target]) => {
    const b = dashEl(id);
    const t = dashEl(target) as HTMLButtonElement | null;
    if (b && t) b.addEventListener('click', () => t.click());
  });

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
