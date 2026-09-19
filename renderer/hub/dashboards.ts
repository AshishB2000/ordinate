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
// One grid row's height in px + the gap, used only to map a drop pointer to
// whole grid units for native drag. These are READ BACK from the live grid
// rather than frozen as constants: a density preset (dashStyle.ts) remaps
// --dash-gap / --dash-row, and a constant here would leave drag-and-resize hit
// testing measuring a grid that is no longer on screen. The fallbacks are the
// comfortable values, for the window between a call and the grid existing.
function dashGridPx(prop: string, fallback: number): number {
  const grid = dashEl('dash-grid');
  if (!grid) return fallback;
  const v = parseFloat(getComputedStyle(grid).getPropertyValue(prop));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function dashRowPx(): number { return dashGridPx('--dash-row', 48); }
function dashGapPx(): number { return dashGridPx('--dash-gap', 12); }

type DashAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';
const DASH_AGGS: DashAgg[] = ['sum', 'avg', 'count', 'min', 'max'];
const DASH_AGG_LABELS: Record<DashAgg, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max',
};

// ── Module-local state ────────────────────────────────────────────────────────
let dashList: any[] = [];          // summaries (list view)
let dashCurrent: any = null;       // the open Dashboard (full), or null on the list
// A control card's CURRENT reader selection: cardId -> ControlValue
// (src/dashboards.ts's `{value}` / `{values}` / `{from,to}`, same shape as
// `CardControl.default`). Renderer memory ONLY — never persisted, never sent
// as part of a dashboard/analysis record, cleared every time a sheet opens or
// closes so one reader's picks never leak into the next dashboard opened.
let controlState: Map<string, any> = new Map();
// WHICH RECORD the editor is bound to. The editor now only ever holds an
// Analysis (the single Dashboards surface); its `sheets` ARE the card `pages`.
// ponytail: `dashMode` is vestigial — it is always 'analysis' now that the
// published-snapshot mode is gone. The union type is kept so lingering
// comparisons stay valid; do not churn 18 files to remove it.
let dashMode: 'dashboard' | 'analysis' = 'analysis';
// Kept for the dock/editor-mode class toggle; always false now that there is no
// read-only published snapshot.
let dashReadOnly = false;
let dashPageIdx = 0;               // active page index within dashCurrent.pages
let dashDirty = false;             // unsaved layout/card edits
let dashSaveTimer: number | null = null; // debounced autosave
let dashDragId: string | null = null;    // id of the card being dragged (native HTML5)

// ── Effective filters (dashboard filters + every control's live selection) ────
//
// Renderer-side mirror of src/dashboardFilters.controlSteps: same rule, same
// shape. That module is the node-tested one; src/dashboardFilters.js compiles
// as CommonJS (tsconfig.main.json, NodeNext) so it defines a bare `exports.*` —
// loading it via a renderer <script> tag throws (`exports` doesn't exist in
// that world), exactly why mergeDashFilters above is ALSO a hand-kept mirror
// rather than a loaded copy. Kept tiny + local on purpose.
function controlStepsRenderer(control: any, state: any): any[] {
  if (!control || !state) return [];
  const column = control.column;
  if (control.kind === 'dropdown' && 'value' in state) {
    const value = state.value;
    if (!value) return [];
    return [{ type: 'filter', column, op: '=', value }];
  }
  if (control.kind === 'multi' && 'values' in state) {
    const values = state.values;
    if (!Array.isArray(values) || values.length === 0) return [];
    // .slice(): `state` may be the SAME array card.control.default.values
    // seeded, so this must not hand back a reference into the record.
    return [{ type: 'filter', column, op: 'in', values: values.slice() }];
  }
  if (control.kind === 'date_range') {
    const from = 'from' in state ? state.from : undefined;
    const to = 'to' in state ? state.to : undefined;
    const steps: any[] = [];
    if (from) steps.push({ type: 'filter', column, op: '>=', value: from });
    if (to) steps.push({ type: 'filter', column, op: '<=', value: to });
    return steps;
  }
  return [];
}

// THE ONE place a card compute (or the drill-down's sheet-filter argument)
// reads what filters currently apply: stored dashboard-wide filters, then
// every control card's live selection turned into steps, dashboard-first,
// same precedence `mergeDashFilters` already documents. Scans EVERY page of
// `dashCurrent.pages`, not just the one on screen — a dashboard-wide filter
// already applies across pages today, and a control is dashboard-wide too,
// even though the widget itself sits on one page. Zero control cards →
// exactly `dashCurrent.filters`, unchanged from before this existed.
function effectiveFilters(): any[] {
  const base = dashCurrent && Array.isArray(dashCurrent.filters) ? dashCurrent.filters : [];
  if (!dashCurrent || !Array.isArray(dashCurrent.pages)) return base.slice();
  const out = base.slice();
  for (const page of dashCurrent.pages) {
    const cards = page && Array.isArray(page.cards) ? page.cards : [];
    for (const card of cards) {
      if (card && card.type === 'control' && card.control) {
        out.push(...controlStepsRenderer(card.control, controlState.get(card.id)));
      }
    }
  }
  return out;
}

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
  // The editor only ever holds an analysis now, so this is the analysis save.
  await persistAnalysis();
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
      // Saved WITH the record, not as a view preference: a dashboard's look is
      // part of what gets shared, so it must survive a reopen on another machine.
      style: dashCurrentStyle(),
    });
    if (res && res.ok && res.analysis) {
      // Adopt main's sanitized copy, keeping the pages/sheets alias intact.
      dashCurrent = res.analysis;
      dashCurrent.pages = dashCurrent.sheets;
      if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
      if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = 0;
    }
    dashDirty = false;
  } catch (_) { /* keep dashDirty so an explicit Save can retry */ }
}

async function handleSaveDashboard(): Promise<void> {
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  await persistDashboard();
  await refreshAnalysisListKeepEditor();
}

async function handleBackToList(): Promise<void> {
  if (dashDirty) await persistDashboard();
  closeDashboardEditor();
  await refreshAnalysisList();
}

// ── Boot wiring (once) ────────────────────────────────────────────────────────
function initDashboards(): void {
  const back = dashEl('dash-back-btn');
  if (back) back.addEventListener('click', () => handleBackToList());

  const refreshData = dashEl('dash-refresh-data');
  if (refreshData) refreshData.addEventListener('click', () => handleDashRefreshData());

  const rename = dashEl('dash-rename-btn');
  if (rename) rename.addEventListener('click', () => {
    if (!dashCurrent) return;
    handleRenameAnalysis(dashCurrent.id, dashCurrent.name || '');
  });

  const addV = dashEl('dash-add-visual');
  if (addV) addV.addEventListener('click', () => handleAddVisual());
  const addM = dashEl('dash-add-metric');
  if (addM) addM.addEventListener('click', () => handleAddMetric());
  const addT = dashEl('dash-add-text');
  if (addT) addT.addEventListener('click', () => handleAddText());
  const addC = dashEl('dash-add-control');
  if (addC) addC.addEventListener('click', () => handleAddControl());

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
  // Reset EVERY control card to its published default — unlike Clear all
  // above (dash-edit-only, a structural edit to the persisted record), this
  // must work for a reader on a published dashboard, so it carries no
  // dash-edit-only class and is never gated on dashReadOnly (dashControls.ts).
  const resetCtrls = dashEl('dash-reset-controls');
  if (resetCtrls) resetCtrls.addEventListener('click', () => resetAllControls());
  // The filter bar's own Clear all: every control on the page back to "All".
  // A DIFFERENT question from Reset controls above, which returns them to what
  // the author published — see updateResetControlsBtn (dashControls.ts) for why
  // only one of the two is ever on screen. Not gated on dashReadOnly either:
  // clearing a filter is a read.
  const clrCtrls = dashEl('dash-fb-clear');
  if (clrCtrls) clrCtrls.addEventListener('click', () => clearAllControlsToAll());
  const catC = dashEl('dash-category-select');
  if (catC) catC.addEventListener('click', () => handleDashCategory());
  const perC = dashEl('dash-period-select');
  if (perC) perC.addEventListener('click', () => handleDashPeriod());
  // Not `dash-edit-only`, and never gated on dashReadOnly: restyling is a view
  // decision a reader of a published dashboard is allowed to make, same
  // argument as #dash-reset-controls above.
  const styleBtn = dashEl('dash-style-btn');
  if (styleBtn) styleBtn.addEventListener('click', () => handleDashStyle());
  const pres = dashEl('dash-present-btn');
  if (pres) pres.addEventListener('click', () => enterDashPresent());
  const presX = dashEl('dash-present-exit');
  if (presX) presX.addEventListener('click', () => exitDashPresent());
  const exp = dashEl('dash-export-btn');
  if (exp) exp.addEventListener('click', () => handleDashExport());
  const shr = dashEl('dash-share-btn');
  if (shr) shr.addEventListener('click', () => handleDashShare());
}
