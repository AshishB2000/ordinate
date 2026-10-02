'use strict';

// SAVED VIEWS on an open dashboard — the header's Views menu, opening a
// dashboard on a view (its default, a ⌘K row, an ordinate:// link), and a
// report generated per view. Classic global-scope renderer <script>: no
// import/export; everything it reaches across files (dashCurrent, controlState,
// paramState, dashSel, dashTileSel, groupTab, snapDashSet, …) resolves at call
// time.
//
// This file only GATHERS and APPLIES live state. What a view may hold — and the
// check of every pick against the record — is main's (src/analysis/savedViews.ts),
// which whitelists a view on every save and every load. So a view on
// `dashCurrent.views` is already clean, and applying it is plain assignment.

/** The view the open dashboard was last put on (saved or applied), or ''. */
let svActive = '';
/** The view the next open should land on — a ⌘K row or a deep link. */
let svRequested: string | null = null;

function svViews(): any[] {
  return dashCurrent && Array.isArray(dashCurrent.views) ? dashCurrent.views : [];
}

// ── Gather / apply ───────────────────────────────────────────────────────────

/** The reader's state right now, in main's ViewState shape. */
function svCapture(): any {
  const page = dashCurrentPage();
  const controls: Record<string, any> = {};
  for (const card of allControlCards()) {
    if (card.control.kind === 'parameter') continue;
    controls[card.id] = controlState.has(card.id) ? controlState.get(card.id) : null;
  }
  return {
    page: page ? page.id : '',
    controls,
    params: Object.fromEntries(paramState),
    selection: dashSel.slice(),
    tiles: Object.fromEntries(dashTileSel),
    groupTabs: Object.fromEntries(groupTab),
    asOf: snapDashAsOf,
  };
}

/** Put the open dashboard into `state`. The caller repaints. */
function svApplyState(state: any): void {
  if (!dashCurrent || !state) return;
  controlState = new Map();
  const live = new Set<string>();
  for (const card of allControlCards()) {
    live.add(card.id);
    if (card.control.default) controlState.set(card.id, card.control.default);
  }
  // A view may keep picks for cards not on the board now (main holds them so an
  // Undo that brings a card back brings its pick back too); they apply to nothing.
  for (const [id, v] of Object.entries(state.controls || {})) {
    if (!live.has(id)) continue;
    if (v === null) controlState.delete(id); else controlState.set(id, v);
  }
  paramState = new Map(Object.entries(state.params || {}));
  dashSel = (state.selection || []).slice();
  const cardIds = new Set<string>(dashCurrent.pages.flatMap((p: any) => (p && p.cards ? p.cards.map((c: any) => c.id) : [])));
  dashTileSel = new Map((Object.entries(state.tiles || {}) as Array<[string, any[]]>).filter(([id]) => cardIds.has(id)));
  for (const [id, tab] of Object.entries(state.groupTabs || {})) groupTab.set(id, String(tab));
  const i = state.page ? dashCurrent.pages.findIndex((p: any) => p && p.id === state.page) : -1;
  if (i >= 0) dashPageIdx = i;
  svSetAsOf(state.asOf || null);
}

/** The As of picker may not list a time yet (its stamps load lazily). */
function svSetAsOf(v: string | null): void {
  snapDashSet(v);
  if (v && snapDash.sel.value !== v) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = snapWhen(v);
    snapDash.sel.appendChild(o);
    snapDash.sel.value = v;
    snapDash.wrap.hidden = false;
  }
}

function svRepaint(): void {
  renderDashSelStrip();
  renderDashPages();
  renderDashGrid();
  svPaintButton();
}

/** Apply a saved view from the menu. */
function svApply(view: any): void {
  svApplyState(view.state);
  svActive = view.id;
  svRepaint();
  showToast('Showing “' + view.name + '”');
}

/**
 * Called by openEditorWith (dashGrid.ts) once a dashboard is bound: land on the
 * view asked for, else the default — unless a navigation carried a selection
 * here, which is the reader's own context and wins over the author's default.
 */
function svOnOpen(): void {
  const req = svRequested;
  svRequested = null;
  const views = svViews();
  const view = (req && views.find((v) => v.id === req))
    || (!dashCrumb && views.find((v) => v.id === dashCurrent.defaultViewId))
    || null;
  svActive = view ? view.id : '';
  if (view) svApplyState(view.state);
  svPaintButton();
}

/** Open a dashboard (in any project) on one of its views — ⌘K and deep links. */
async function svOpenDashboardView(projectId: string, analysisId: string, viewId: string): Promise<void> {
  if (projectId && projectId !== currentProjectId) await openWorkspace(projectId);
  selectSection('analyses');
  if (dashCurrent && dashCurrent.id === analysisId) {
    const view = svViews().find((v) => v.id === viewId);
    if (view) svApply(view);
    return;
  }
  if (dashCurrent && dashDirty) await persistDashboard();
  svRequested = viewId || null;
  await openAnalysis(analysisId);
  svRequested = null;
}

// ── Edits (all through main) ─────────────────────────────────────────────────

async function svEdit(op: any): Promise<any> {
  if (!dashCurrent || !currentProjectId) return null;
  // Write pending edits first: main checks a view against the STORED sheets.
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  if (dashDirty) await persistDashboard();
  let res: any = null;
  try { res = await window.hubViews.edit(currentProjectId, dashCurrent.id, op); } catch (_) { res = null; }
  if (!res || !res.ok) {
    showToast((res && res.error) || 'Could not save the view', { kind: 'error' });
    return null;
  }
  dashCurrent.views = res.views;
  dashCurrent.defaultViewId = res.defaultViewId;
  svPaintButton();
  return res;
}

async function svSaveNew(): Promise<void> {
  const name = await promptModal('Save current view', '', 'Save view');
  if (name === null) return;
  const res = await svEdit({ op: 'create', name, state: svCapture() });
  if (!res) return;
  svActive = res.viewId;
  svPaintButton();
  showToast('Saved view “' + name.trim() + '”', { kind: 'success' });
}

async function svRename(view: any): Promise<void> {
  const name = await promptModal('Rename view', view.name, 'Rename');
  if (name === null || name.trim() === view.name) return;
  if (await svEdit({ op: 'rename', viewId: view.id, name })) showToast('Renamed to “' + name.trim() + '”');
}

async function svUpdate(view: any): Promise<void> {
  if (!(await svEdit({ op: 'update', viewId: view.id, state: svCapture() }))) return;
  svActive = view.id;
  svPaintButton();
  showToast('Updated “' + view.name + '” to what is on screen', { kind: 'success' });
}

async function svToggleDefault(view: any): Promise<void> {
  const on = dashCurrent.defaultViewId !== view.id;
  if (!(await svEdit({ op: 'default', viewId: on ? view.id : '' }))) return;
  showToast(on ? '“' + view.name + '” opens by default' : 'No default view — the dashboard opens as authored');
}

async function svDelete(view: any): Promise<void> {
  const wasDefault = dashCurrent.defaultViewId === view.id;
  if (!(await svEdit({ op: 'delete', viewId: view.id }))) return;
  if (svActive === view.id) svActive = '';
  svPaintButton();
  showToast('Deleted view “' + view.name + '”', {
    action: {
      label: 'Undo',
      onClick: async () => {
        const res = await svEdit({ op: 'create', name: view.name, state: view.state });
        if (res && wasDefault) await svEdit({ op: 'default', viewId: res.viewId });
      },
    },
  });
}

function svCopyLink(view: any): void {
  window.hub.copyText(`ordinate://dashboard/${dashCurrent.id}?view=${view.id}`);
  showToast('Link copied — it opens this dashboard on “' + view.name + '”');
}

// ── The header button and its menu ───────────────────────────────────────────

function svPaintButton(): void {
  const label = document.getElementById('dash-views-name');
  const btn = document.getElementById('dash-views-btn');
  const view = svViews().find((v) => v.id === svActive);
  if (label) { label.textContent = view ? view.name : ''; label.hidden = !view; }
  if (btn) btn.classList.toggle('is-on', Boolean(view));
}

function svActButton(iconName: string, label: string, run: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sv-act' + (extra ? ' ' + extra : '');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(iconName, 16));
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
}

function svOpenMenu(anchor: HTMLElement): void {
  if (!dashCurrent) return;
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    menu.classList.add('sv-menu');
    const views = svViews();
    const head = document.createElement('div');
    head.className = 'sv-head';
    head.textContent = 'Saved views';
    if (views.length) {
      const n = document.createElement('span');
      n.className = 'sv-count';
      n.textContent = String(views.length);
      head.appendChild(n);
    }
    menu.appendChild(head);

    if (!views.length) {
      const empty = document.createElement('div');
      empty.className = 'sv-empty';
      empty.appendChild(icon('layers', 20));
      const p = document.createElement('p');
      p.textContent = 'No saved views yet — save the current filters, page and selection as a view.';
      empty.appendChild(p);
      menu.appendChild(empty);
    }

    const later = (fn: (v: any) => unknown, v: any) => () => { close(); void fn(v); };
    for (const v of views) {
      const isDefault = dashCurrent.defaultViewId === v.id;
      const row = document.createElement('div');
      row.className = 'sv-row' + (v.id === svActive ? ' is-active' : '');
      row.dataset.viewId = v.id;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chart-menu-item sv-row-main';
      main.appendChild(icon(v.id === svActive ? 'check' : 'layers', 16));
      const name = document.createElement('span');
      name.className = 'sv-name';
      name.textContent = v.name;
      main.appendChild(name);
      if (isDefault) {
        const badge = document.createElement('span');
        badge.className = 'sv-badge';
        badge.textContent = 'Default';
        main.appendChild(badge);
      }
      main.addEventListener('click', () => { close(); svApply(v); });
      const acts = document.createElement('span');
      acts.className = 'sv-acts';
      acts.append(
        svActButton(isDefault ? 'star-filled' : 'star', isDefault ? 'Stop opening on this view' : 'Open the dashboard on this view', later(svToggleDefault, v), isDefault ? 'is-on' : ''),
        svActButton('refresh', 'Update with what is on screen', later(svUpdate, v)),
        svActButton('pencil', 'Rename', later(svRename, v)),
        svActButton('link', 'Copy link', later(svCopyLink, v)),
        svActButton('trash', 'Delete', later(svDelete, v), 'sv-act--rm'),
      );
      row.append(main, acts);
      menu.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.className = 'chart-menu-sep';
    menu.appendChild(sep);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'chart-menu-item sv-save';
    save.id = 'sv-save-btn';
    save.appendChild(icon('plus', 16));
    const t = document.createElement('span');
    t.textContent = 'Save current view…';
    save.appendChild(t);
    save.addEventListener('click', () => { close(); void svSaveNew(); });
    menu.appendChild(save);
  });
}

// ── Reports, per view ────────────────────────────────────────────────────────

/** Fill the report builder's View select: none, each saved view, every view. */
function svFillReportViews(sel: HTMLSelectElement | null, analysis: any, viewId: string): void {
  if (!sel) return;
  sel.textContent = '';
  const views = analysis && Array.isArray(analysis.views) ? analysis.views : [];
  const add = (value: string, label: string): void => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('', 'As saved — no view');
  for (const v of views) add(v.id, v.name);
  if (views.length > 1) add('all', 'Every view — one section each');
  sel.value = views.some((v: any) => v.id === viewId) || (viewId === 'all' && views.length > 1) ? viewId : '';
  sel.disabled = views.length === 0;
}

/**
 * A report's pages under its view: as saved with none, under one view's
 * filters and parameters, or — "every view" — the whole page list once per
 * view, each section's cover subtitled with the view's name. The scope is
 * main's (`views:scope`), the same rule the dashboard applies on screen.
 */
async function svReportPages(ctx: any): Promise<any[]> {
  const report = ctx.report || {};
  const views: any[] = ctx.analysis && Array.isArray(ctx.analysis.views) ? ctx.analysis.views : [];
  const pick = report.viewId === 'all' ? views : views.filter((v) => v.id === report.viewId);
  if (!pick.length) return buildReportPages(ctx);
  const out: any[] = [];
  for (const v of pick) {
    const scope = await window.hubViews.scope(ctx.projectId, ctx.analysis.id, v.id).catch(() => null);
    if (!scope || !scope.ok) continue;
    const cover = { ...(report.cover || {}), subtitle: v.name };
    out.push(...await buildReportPages({ ...ctx, filters: scope.filters, params: scope.params, report: { ...report, cover } }));
  }
  return out;
}

// ── Deep links ───────────────────────────────────────────────────────────────

async function svTakeLink(): Promise<void> {
  let link: any = null;
  try { link = await window.hubViews.takeLink(); } catch (_) { link = null; }
  if (link && link.projectId && link.dashboardId) await svOpenDashboardView(link.projectId, link.dashboardId, link.viewId || '');
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('dash-views-btn');
  if (btn) btn.addEventListener('click', () => svOpenMenu(btn));
  if (!window.hubViews) return;
  window.hubViews.onLink(() => { void svTakeLink(); });
  void svTakeLink(); // a cold start's link
});
