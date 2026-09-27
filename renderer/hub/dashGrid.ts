// The editor canvas: opening and closing a sheet, its page tabs, the 12-column
// grid, every card element (move / resize / remove), the three card bodies, and
// the freshness line that reports the OLDEST lastRefreshedAt across the datasets
// the sheet reads.
//
// This file adds ZERO charting code — a visual card draws by reusing the
// visual:data → renderVizInArea path, and a metric card's one number comes only
// from window.hub.computeMetric in main.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── Editor: open / close ──────────────────────────────────────────────────────
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

// Open an ANALYSIS in the same editor. `sheets` and `pages` are the same type
// (src/analysis.ts reuses dashboards.Page), so the array is ALIASED rather than
// copied: every existing page/card/filter handler keeps working on
// `dashCurrent.pages`, and the save reads it back out as `sheets`.
function openAnalysisFrom(a: any): void {
  if (typeof vhReset === 'function') vhReset(); // versionsPanel.ts — the live record ends a version preview
  dashMode = 'analysis';
  dashReadOnly = false;
  mountDashEditor('an-editor-host');
  if (!Array.isArray(a.sheets) || a.sheets.length === 0) {
    a.sheets = [{ id: dashUuid(), name: 'Sheet 1', cards: [] }];
  }
  a.pages = a.sheets; // alias, NOT a copy — one array, two names
  dashShow('an-list-view', false);
  openEditorWith(a, a && a.name ? a.name : 'Untitled dashboard');
  if (typeof cmMaybeStart === 'function') void cmMaybeStart(String(a.id)); // coachMarks.ts — the sample's one-time tour
}

// The part both entry points share: bind state, paint the editor.
function openEditorWith(rec: any, title: string): void {
  dashCurrent = rec;
  // dock.ts — context line now names this dashboard (dkContextRef only
  // resolves a DASHBOARD, not an analysis, to a copilot context; either way
  // the label must not lag behind what dashMode/dashCurrent just became).
  if (typeof dkSync === 'function') dkSync();
  dashPageIdx = 0;
  dashDirty = false;
  if (!Array.isArray(dashCurrent.pages) || dashCurrent.pages.length === 0) {
    dashCurrent.pages = [{ id: dashUuid(), name: 'Page 1', cards: [] }];
  }
  // Week 10: dashboard-wide filters (a v1 dashboard has none → []).
  if (!Array.isArray(dashCurrent.filters)) dashCurrent.filters = [];
  // Fresh reader session: no carry-over from whatever sheet was open before,
  // then seed each control's author-set default (`CardControl.default` and a
  // reader selection are the same `ControlValue` shape, so this is a direct
  // set — no conversion). A control with no default stays unset, which
  // `controlSteps` already treats as "filters nothing".
  controlState = new Map();
  paramState = new Map(); // every parameter opens on its saved default
  if (!Array.isArray(dashCurrent.parameters)) dashCurrent.parameters = [];
  for (const page of dashCurrent.pages) {
    for (const card of (page && Array.isArray(page.cards) ? page.cards : [])) {
      if (card && card.type === 'control' && card.control && card.control.default) {
        controlState.set(card.id, card.control.default);
      }
    }
  }
  dashShow('dash-editor', true);
  applyDashEditorMode();
  syncDashStyle(); // before the first renderDashGrid, so charts build in-palette
  const nameEl = dashEl('dash-name');
  if (nameEl) nameEl.textContent = title;
  dashHistReset(); // this state is the floor — nothing before it is undoable
  dashSelOnOpen(); // dashSelection.ts — a navigation's carried selection, or none
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
  // In focus mode the head is lifted OUT of the editor (authoring.ts
  // anMountTopStrip), so the read-only class has to travel with it or Save and
  // Undo stay up over a version being previewed.
  const head = document.querySelector('.dash-editor-head');
  if (head) head.classList.toggle('dash-editor--readonly', dashReadOnly);
  // The workbench columns light up for an open ANALYSIS only. In dashboard mode
  // this turns them off, which is the invariant: a published dashboard is a
  // snapshot, and a panel that can mutate a card plus the 600 ms autosave would
  // clobber it.
  anSyncWorkbench();
}

function closeDashboardEditor(): void {
  if (typeof vhReset === 'function') vhReset(); // versionsPanel.ts — no preview outlives its page
  if (typeof cmEnd === 'function') cmEnd(); // coachMarks.ts — nor a tour
  exitDashPresent(); // never leave the app stuck in chrome-hidden mode
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  dashCurrent = null;
  controlState = new Map(); // no reader session carries into the next sheet opened
  paramState = new Map();
  dashPageIdx = 0;
  dashDirty = false;
  dashDragId = null;
  dashHistClear(); // one dashboard's undo stack never reaches the next one
  destroyDashCharts(); // tear down card charts/maps before wiping the grid (no leak)
  const grid = dashEl('dash-grid');
  if (grid) grid.innerHTML = '';
  const pages = dashEl('dash-pages');
  if (pages) pages.innerHTML = '';
  // Drop the style classes too: the editor is ONE re-parented element, so a
  // dark dashboard closed without this would tint the next one opened.
  applyDashStyleTo(dashEl('dash-editor'), DASH_STYLE_DEFAULT);
  dashShow('dash-editor', false);
  // dashCurrent is null now, so this drops the workbench columns and clears the
  // selection — closing an analysis must not leave panels bound to a dead card.
  anSyncWorkbench();
  dashShow('an-list-view', true);
  dashMode = 'analysis';
  dashReadOnly = false;
  // dkSync() runs AFTER dashReadOnly is reset, not before. Syncing while it was
  // still true hid the dock and then immediately re-showed it via
  // applyDashEditorMode() -> anSyncWorkbench() -> dkSync(), and that round trip
  // re-ran a full history reload, a resize nudge, and a focus steal.
  if (typeof dkSync === 'function') dkSync(); // dock.ts — context line falls back off this dashboard/analysis
  applyDashEditorMode();
  const note = dashEl('dash-readonly');
  if (note) note.hidden = true;
  const pub = dashEl('an-pubstate');
  if (pub) pub.hidden = true;
  dashShow('dash-reset-controls', false); // controlState is gone; nothing left to reset
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

/**
 * THE one write hook for this surface: every mutation of the open record ends
 * here, which is why the undo history is filed here too rather than at twenty
 * call sites (dashHistory.ts explains the shape). `label` is what the Undo
 * button will offer to reverse; an unlabelled caller still gets an undo step,
 * just a generic one. `coalesce` is for callers that fire per KEYSTROKE — they
 * are one edit, not thirty.
 */
function markDashDirty(label?: string, coalesce?: boolean): void {
  // A published dashboard is read-only. Nothing in the UI should reach here (the
  // controls are hidden), but the 600 ms autosave is exactly the mechanism that
  // would quietly overwrite a snapshot, so it is stopped at the source too.
  if (dashReadOnly) return;
  dashDirty = true;
  dashHistCommit(label || 'Change', coalesce);
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
    tab.className = 'dash-page-tab seg-opt' + (i === dashPageIdx ? ' active' : '');
    tab.textContent = p && p.name ? String(p.name) : 'Page ' + (i + 1);
    tab.addEventListener('click', () => { dashPageIdx = i; renderDashPages(); renderDashGrid(); });
    tab.addEventListener('dblclick', () => handleRenamePage(i));
    strip.appendChild(tab);
  });
  // Rename / remove controls for the active page.
  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'dash-page-ctrl';
  iconOnly(ren, 'pencil', 'Rename page');
  ren.addEventListener('click', () => handleRenamePage(dashPageIdx));
  strip.appendChild(ren);

  if ((dashCurrent.pages || []).length > 1) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dash-page-ctrl';
    iconOnly(del, 'x', 'Remove page');
    del.addEventListener('click', () => handleRemovePage(dashPageIdx));
    strip.appendChild(del);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'dash-page-add';
  iconLabel(add, 'plus', 'Page');
  add.addEventListener('click', () => handleAddPage());
  strip.appendChild(add);
}

function handleAddPage(): void {
  if (!dashCurrent) return;
  const n = (dashCurrent.pages || []).length + 1;
  dashCurrent.pages.push({ id: dashUuid(), name: 'Page ' + n, cards: [] });
  dashPageIdx = dashCurrent.pages.length - 1;
  markDashDirty('Add page');
  renderDashPages();
  renderDashGrid();
}

async function handleRenamePage(i: number): Promise<void> {
  if (!dashCurrent || !dashCurrent.pages[i]) return;
  const name = await promptModal('Rename page', dashCurrent.pages[i].name || 'Page ' + (i + 1), 'Save');
  if (name === null) return;
  dashCurrent.pages[i].name = name.trim() || dashCurrent.pages[i].name;
  markDashDirty('Rename page');
  renderDashPages();
}

function handleRemovePage(i: number): void {
  if (!dashCurrent || dashCurrent.pages.length <= 1) return;
  if (!window.confirm('Remove this page and its cards?')) return;
  dashCurrent.pages.splice(i, 1);
  if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = dashCurrent.pages.length - 1;
  markDashDirty('Remove page');
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

// A theme flip changes every token a chart baked in, so the open sheet is
// rebuilt exactly as a style change rebuilds it. Registered once at load.
document.addEventListener('themechange', () => {
  if (dashCurrent) renderDashGrid();
});

function renderDashGrid(): void {
  const grid = dashEl('dash-grid');
  if (!grid) return;
  // The multi control's popover (dashControls.ts) is body-mounted OUTSIDE the
  // grid specifically to escape a card's clipping ancestor, so wiping the grid
  // below does not remove it — left open, its `anchor` goes stale the instant
  // its card is torn down, and the next scroll/resize would reposition it off
  // a detached element. Any card's change (a DIFFERENT control, a drag, a
  // resize, an add) can trigger this render, so it is closed unconditionally,
  // not just when a second popover is about to open.
  if (openControlPopover) openControlPopover();
  destroyDashCharts();
  grid.innerHTML = '';
  const page = dashCurrentPage();
  const cards = (page && Array.isArray(page.cards)) ? page.cards : [];
  // A control card draws no cell: it is a chip in the filter bar above the grid
  // (dashControlBar.ts). It is still a card on the page, so the record, the
  // export and effectiveFilters() are untouched — this is the one place that
  // decides a control is not a tile.
  const tiles = cards.filter((c: any) => !c || c.type !== 'control');
  dashShow('dash-starters', tiles.length === 0);
  renderDashControlBar();
  // A filter chip can name a parameter's CURRENT value ("threshold (2,500)"),
  // so it repaints with everything else that reads one.
  if (dashParams().length) renderDashFilterBar();
  // Append every card element first (so each body has layout size), then kick
  // off the async body render into each — charts size to their grid cell.
  tiles.forEach((card: any) => {
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
  authoringAfterGrid(); // layoutKinds.ts — groups under their children, the active tab, folds
  // Which datasets the sheet reads can change with any card edit, so the
  // freshness line is derived from the cards on every grid render.
  refreshDashFreshness();
  // Whether ANY control differs from its default (dashControls.ts) can change
  // on every render too — derived, never tracked state of its own.
  updateResetControlsBtn();
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
  // "· filtered" whenever a control is narrowing the figures below. Without it
  // the header states a data time over numbers that are a subset, with nothing
  // on screen saying so once the chips scroll out of view.
  label.textContent = 'Data as of ' + formatSidebarTime(new Date(oldest).toISOString())
    + (anyControlActive() ? ' · filtered' : '');
  // Say WHY it is the oldest, so a header that disagrees with a single dataset's
  // own line is explicable rather than a bug report.
  label.title = ids.length > 1
    ? 'The oldest of the ' + ids.length + ' datasets this sheet reads.'
    : '';
  btn.hidden = !anyRefreshable;
  dqPaintDashFlag(label, ids, byId); // dsRules.ts — "· Data quality: N rules failing"
}

// Refresh exactly the datasets this sheet reads, then re-render it.
async function handleDashRefreshData(): Promise<void> {
  if (!currentProjectId) return;
  const btn = dashEl('dash-refresh-data') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    iconLabel(btn, 'refresh', 'Refreshing…');
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
    iconLabel(btn, 'refresh', 'Refresh data');
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
/**
 * Where a new `w`x`h` card goes: the first cell it fits without overlapping
 * anything, scanning left-to-right then down.
 *
 * Every add path used to hardcode `x: 0, y: nextFreeRow()`, which put every card
 * in column 0 on a brand new row — add a 3-wide KPI beside a 9-column gap and it
 * still started a row of its own, leaving columns 3-11 empty until someone
 * dragged something into them. A dashboard built by clicking "+ Metric" four
 * times was a vertical ribbon down the left edge.
 *
 * Deliberately NOT shared with the packer in src/analysis/planBuild.ts: that one
 * lays out a whole batch from an empty grid and can carry a cursor, this one
 * answers "given these cards, where does ONE more go". Same idea, different
 * question — merging them would mean a stateful packer pretending to be pure.
 */
/** The open page's cards, or [] — the usual argument to dashFindSlot. */
function dashCards(): any[] {
  const page = dashCurrentPage();
  return page && Array.isArray(page.cards) ? page.cards : [];
}

function dashFindSlot(cards: any[], w: number, h: number): { x: number; y: number } {
  const width = clampInt(w, 1, DASH_GRID_COLS, 1);
  const height = Math.max(1, clampInt(h, 1, 100000, 1));
  const placed = (Array.isArray(cards) ? cards : [])
    // A control card is a filter-bar chip, not a tile (dashControlBar.ts), and
    // its zeroed layout would otherwise reserve the top-left cell against every
    // card added after it.
    .filter((c: any) => !c || c.type !== 'control')
    .map((c: any) => c && c.layout)
    .filter(Boolean)
    .map((l: any) => ({
      x: clampInt(l.x, 0, DASH_GRID_COLS - 1, 0),
      y: Math.max(0, clampInt(l.y, 0, 100000, 0)),
      w: clampInt(l.w, 1, DASH_GRID_COLS, 1),
      h: Math.max(1, clampInt(l.h, 1, 100000, 1)),
    }));
  const hits = (x: number, y: number): boolean => placed.some((p) =>
    x < p.x + p.w && p.x < x + width && y < p.y + p.h && p.y < y + height);
  // Bounded by the grid's own height: one row past the bottom is always free.
  const limit = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  for (let y = 0; y <= limit; y += 1) {
    for (let x = 0; x + width <= DASH_GRID_COLS; x += 1) {
      if (!hits(x, y)) return { x, y };
    }
  }
  return { x: 0, y: limit };
}

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


// Re-apply a card's grid position in place (no full re-render, so a chart isn't
// destroyed just because it moved/resized).
function reapplyCardStyle(card: any): void {
  const grid = dashEl('dash-grid');
  if (!grid) return;
  const el = grid.querySelector('.dash-card[data-card-id="' + card.id + '"]') as HTMLElement | null;
  if (el) applyDashCardStyle(el, card.layout);
}

// Each of these three looks the card up again by id: the menu and key handlers
// that call them captured the card when the grid was drawn, and the autosave
// has since swapped in main's copy — the old object moves nothing that is saved.
function nudgeCard(card: any, dx: number, dy: number): void {
  card = dashCardAnywhere(card.id) || card;
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  const x0 = l.x;
  const y0 = l.y;
  l.x = clampInt(l.x + dx, 0, DASH_GRID_COLS - (l.w || 1), l.x);
  l.y = Math.max(0, (l.y || 0) + dy);
  reapplyCardStyle(card);
  authoringAfterGesture(card, 'move', l.x - x0, l.y - y0);
  markDashDirty('Move card');
}

function resizeCard(card: any, dw: number, dh: number): void {
  card = dashCardAnywhere(card.id) || card;
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  l.w = clampInt((l.w || 1) + dw, 1, DASH_GRID_COLS - (l.x || 0), l.w);
  l.h = clampInt((l.h || 1) + dh, 1, 100000, l.h);
  reapplyCardStyle(card);
  authoringAfterGesture(card, 'resize', 0, 0);
  markDashDirty('Resize card');
}

function removeCard(card: any): void {
  const page = dashCurrentPage();
  if (!page) return;
  const i = page.cards.findIndex((c: any) => c && c.id === card.id);
  if (i >= 0) page.cards.splice(i, 1);
  authoringAfterRemove(card.id); // gridArrange.ts — a group's children stay, ungrouped
  markDashDirty('Remove card');
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
  const rowH = dashRowPx() + dashGapPx();
  const nx = clampInt(Math.floor((e.clientX - rect.left) / colW), 0, DASH_GRID_COLS - (card.layout.w || 1), card.layout.x);
  const ny = Math.max(0, Math.floor((e.clientY - rect.top) / rowH));
  card.layout.x = nx;
  card.layout.y = ny;
  reapplyCardStyle(card);
  markDashDirty('Move card');
}

// ── Card body renderers ─────────────────────────────────────────────────────
function renderDashCardBody(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  if (renderAuthoringCard(card, body)) return; // cardKinds.ts — navigation and the other added kinds
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
// A tile is two IPC round-trips away from anything to draw (resolve the visual,
// then compute its data), so the card paints a skeleton of its own shape first
// and every exit path — drawn, missing, broken — replaces it. The `finally` is
// what takes aria-busy back off; the nodes themselves go when the body is
// rewritten, but an un-cleared aria-busy would leave the card announced as
// loading forever.
async function renderVisualCard(card: any, body: HTMLElement): Promise<void> {
  skelChart(body);
  try { await renderVisualCardInto(card, body); } finally { skelClear(body); }
}

async function renderVisualCardInto(card: any, body: HTMLElement): Promise<void> {
  if (!currentProjectId || (!card.visualId && !card.visual)) { dashCardMissing(body, 'No visual selected.'); return; }
  const resolved = await resolveCardVisual(card);
  if (!resolved) { dashCardMissing(body, 'This visual was deleted.', true); return; }
  const visual = resolved.visual;
  // Name the card after the visual it draws. dashCardTitle() runs when the head
  // is built, before this resolve, so it can only guess; this is where the name
  // is actually known, and it costs nothing — the fetch already happened.
  const titleEl = body.closest('.dash-card')?.querySelector('.dash-card-title');
  if (titleEl && visual.name) titleEl.textContent = dashSubst(visual.name);

  // Merge dashboard-wide filters + every control's live selection (effectiveFilters,
  // dashboards.ts) with the visual's own filters, then pass the combined list through
  // the UNCHANGED visual:data channel — it sanitizes + applies filters (in order,
  // missing-column-tolerant) before aggregation, so one dashboard filter drives every
  // card. Mirrors mergeDashboardFilters (src/dashboardFilters.ts).
  const merged = mergeDashFilters(effectiveFilters(), visual.filters).concat(dashTileSteps(card.id));
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, visual.datasetId, visual.encoding, merged, dashParamPayload(), visual.analytics);
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
    name: dashCardTitle(card) === 'Visual' ? dashSubst(visual.name) : dashCardTitle(card),
    projectId: currentProjectId,
    datasetId: visual.datasetId,
    encoding: visual.encoding,
    filters: merged,
    params: dashParamPayload(),
  };
  const entry: any = {
    id: card.id,
    drill,
    chartOverrides: { ['v:' + type]: cmtWithPins(visual.overrides, 'card', card.id) }, // COMMENT PIN HOOK
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
  setPivotGridOnCard(body.closest('.dash-card'), type === 'pivot' ? data.pivot : null, drill);
  // The trailing argument is dataset IDENTITY for the Mosaic engine — the same
  // project/dataset/encoding/filters that produced `data`, so the two engines
  // can never disagree about what this card shows. With the 'scMosaic' flag off
  // (the default) it is ignored and Chart.js draws exactly as before.
  renderVizInArea(area, data, type, entry, 'v', {
    projectId: currentProjectId, datasetId: visual.datasetId, encoding: visual.encoding, filters: merged,
  });
  paintOverlayCaption(area, res, type);
  paintParamErrors(body, res.paramErrors);
  // Cross-filter first: when it is on it owns the plain click (it writes), and
  // drilling stays available through the ⋯ menu. Otherwise the click drills.
  // Drilling is a READ, so it is offered on a published snapshot too.
  // A tile's own click ACTION (tileActions.ts) outranks both.
  if (!wireTileActions(area, card, visual) && !wireCrossFilter(area, visual)) wireDrillClick(area, drill);
}

