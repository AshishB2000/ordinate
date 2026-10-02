'use strict';

// The SELECTION layer of an open dashboard, and navigation between dashboards.
// Classic global-scope renderer <script>.
//
// Three pieces of READER state, none of them saved, none of them undoable —
// the same standing as `controlState`:
//
//   dashSel      — sheet-wide filter steps a reader arrived with (a navigate
//                  action's carry) or clicked into (a map mark). They join
//                  `effectiveFilters()`, so every card reads them.
//   dashTileSel  — per-tile narrowing from a `filter_target` action: only the
//                  named tiles read these.
//   dashCrumb    — where a navigate action came FROM, for the "From …" Back.
//
// They draw as their own strip above the control filter bar, as chips, so a
// carried selection is visible and removable where the filters are.

let dashSel: any[] = [];
let dashTileSel = new Map<string, any[]>();
let dashCrumb: { fromId: string; fromName: string; fromPage?: string } | null = null;
let dashPendingNav: { carry: any[]; crumb: any; page?: string } | null = null;

/**
 * The LIVE card with this id, on any page. The autosave swaps `dashCurrent`
 * for main's sanitized copy, so a card object captured when a panel was drawn
 * goes stale ~600 ms later; editors look their card up again at write time.
 */
function dashCardAnywhere(id: string): any {
  for (const page of (dashCurrent && dashCurrent.pages) || []) {
    for (const c of (page && page.cards) || []) if (c && c.id === id) return c;
  }
  return null;
}

/** The sheet-wide selection — `effectiveFilters()` appends these. */
function dashSelectionSteps(): any[] {
  return dashSel.slice();
}

/** The narrowing a `filter_target` action put on ONE tile. */
function dashTileSteps(cardId: string): any[] {
  return dashTileSel.get(cardId) || [];
}

function dashSelStepLabel(s: any): string {
  // A typed filter (filterTypeApply.ts) can put any filter step here, not only a click's `=`.
  if (s.op === 'period') return `${s.column}: ${periodValueText(s.period)}`;
  if (Array.isArray(s.values)) return `${s.column}${s.op === 'not in' ? ' not' : ''}: ${s.values.join(', ')}`;
  const sign: Record<string, string> = { '!=': '≠', '>=': '≥', '<=': '≤' };
  return s.op === '=' ? `${s.column} = ${s.value}` : `${s.column} ${sign[s.op] || s.op} ${s.value ?? ''}`.trim();
}

function dashSelKey(s: any): string {
  return JSON.stringify([s.column, s.op, s.value ?? null, s.values ?? null, s.period ?? null]);
}

/** A fresh sheet opened: take a pending navigation's carry, or start clean. */
function dashSelOnOpen(): void {
  dashTileSel = new Map();
  const nav = dashPendingNav;
  dashPendingNav = null;
  dashSel = nav ? nav.carry.slice() : [];
  dashCrumb = nav ? nav.crumb : null;
  if (nav && nav.page && dashCurrent && Array.isArray(dashCurrent.pages)) {
    const i = dashCurrent.pages.findIndex((p: any) => p && p.id === nav.page);
    if (i >= 0) dashPageIdx = i;
  }
  renderDashSelStrip();
}

/** Add or remove one selection step — a map click, a chip's ×. */
function dashSelToggle(step: any): void {
  const k = dashSelKey(step);
  const at = dashSel.findIndex((s) => dashSelKey(s) === k);
  if (at >= 0) dashSel.splice(at, 1);
  else dashSel = dashSel.filter((s) => !(s.column === step.column && s.op === '=' && step.op === '=')).concat([step]);
  renderDashSelStrip();
  renderDashGrid();
}

/** A filter_target click: narrow `tiles` to `steps`, or lift it when the same steps are already on. */
function dashNarrowTiles(tiles: string[], steps: any[]): void {
  const k = JSON.stringify(steps.map(dashSelKey));
  const on = tiles.length > 0 && tiles.every((t) => JSON.stringify(dashTileSteps(t).map(dashSelKey)) === k);
  for (const t of tiles) {
    if (on || !steps.length) dashTileSel.delete(t);
    else dashTileSel.set(t, steps.slice());
  }
  renderDashSelStrip();
  renderDashGrid();
}

/**
 * Open another dashboard (or a page of this one) carrying `carry` into its
 * selection. Pending edits are saved FIRST — switching dashboards used to drop
 * whatever the 600 ms autosave had not written yet.
 */
async function dashNavigate(target: { analysisId: string; page?: string }, carry: any[], opts: { back?: boolean } = {}): Promise<void> {
  if (!dashCurrent || !target || !target.analysisId) return;
  if (target.analysisId === dashCurrent.id) {
    const i = target.page ? dashCurrent.pages.findIndex((p: any) => p && p.id === target.page) : -1;
    if (i >= 0) dashPageIdx = i;
    const keys = new Set(carry.map(dashSelKey));
    dashSel = dashSel.filter((s) => !keys.has(dashSelKey(s))).concat(carry);
    renderDashPages();
    renderDashSelStrip();
    renderDashGrid();
    return;
  }
  const page = dashCurrentPage();
  const crumb = opts.back ? null : { fromId: dashCurrent.id, fromName: String(dashCurrent.name || t('common.dashboard')), fromPage: page && page.id };
  if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
  if (dashDirty) await persistDashboard();
  dashPendingNav = { carry: carry.slice(), crumb, page: target.page };
  await openAnalysis(target.analysisId);
  dashPendingNav = null; // a failed open must not leak into the next one
}

/** "From Retail overview" → back to where the reader came from, on the page they left. */
function dashNavBack(): void {
  if (!dashCrumb) return;
  void dashNavigate({ analysisId: dashCrumb.fromId, page: dashCrumb.fromPage }, [], { back: true });
}

function dashSelStrip(): HTMLElement | null {
  let strip = document.getElementById('dash-sel-strip');
  if (strip) return strip;
  const anchor = document.getElementById('dash-control-bar');
  if (!anchor) return null;
  strip = document.createElement('div');
  strip.id = 'dash-sel-strip';
  strip.className = 'dash-sel-strip';
  strip.setAttribute('role', 'region');
  strip.setAttribute('aria-label', t('dashSelection.selection'));
  strip.hidden = true;
  anchor.before(strip);
  return strip;
}

function dashSelChip(text: string, removeLabel: string, onRemove: () => void, extra?: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'dash-filter-chip chip dash-sel-chip' + (extra ? ' ' + extra : '');
  const t = document.createElement('span');
  t.className = 'dash-sel-chip-txt';
  t.textContent = text;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dash-filter-chip-x';
  x.setAttribute('aria-label', removeLabel);
  x.title = removeLabel;
  x.textContent = '×';
  x.addEventListener('click', onRemove);
  chip.append(t, x);
  return chip;
}

function renderDashSelStrip(): void {
  const strip = dashSelStrip();
  if (!strip) return;
  strip.innerHTML = '';
  const narrowed = [...dashTileSel.entries()];
  strip.hidden = !dashCrumb && dashSel.length === 0 && narrowed.length === 0;
  if (strip.hidden) return;

  if (dashCrumb) {
    const crumb = document.createElement('nav');
    crumb.className = 'dash-crumb';
    crumb.setAttribute('aria-label', t('dashSelection.breadcrumb'));
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-sm dash-crumb-back';
    back.appendChild(icon('arrow-left', 14));
    const bt = document.createElement('span');
    bt.textContent = t('common.back');
    back.appendChild(bt);
    back.setAttribute('aria-label', t('common.back_to', { fromName: dashCrumb.fromName }));
    back.addEventListener('click', dashNavBack);
    const from = document.createElement('span');
    from.className = 'dash-crumb-from';
    from.textContent = t('dashSelection.from', { fromName: dashCrumb.fromName });
    crumb.append(back, from);
    strip.appendChild(crumb);
  }
  if (dashSel.length || narrowed.length) {
    const label = document.createElement('span');
    label.className = 'dash-toolbar-label';
    label.textContent = t('dashSelection.selection');
    strip.appendChild(label);
  }
  dashSel.forEach((s) => {
    strip.appendChild(dashSelChip(dashSelStepLabel(s), t('dashSelection.remove_selection', { s: dashSelStepLabel(s) }), () => dashSelToggle(s)));
  });
  // One chip per distinct narrowing, naming how many tiles it narrows.
  const groups = new Map<string, { steps: any[]; tiles: string[] }>();
  for (const [tile, steps] of narrowed) {
    const k = JSON.stringify(steps.map(dashSelKey));
    const g = groups.get(k) || { steps, tiles: [] };
    g.tiles.push(tile);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const text = t('dashSelection.text', { p0: g.steps.map(dashSelStepLabel).join(', '), tilesCount: g.tiles.length });
    strip.appendChild(dashSelChip(text, t('dashSelection.stop_narrowing_those_tiles'), () => dashNarrowTiles(g.tiles, []), 'dash-sel-chip--narrow'));
  }
  if (dashSel.length + narrowed.length > 1) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-sm dash-sel-clear';
    clear.textContent = t('common.clear_selection');
    clear.addEventListener('click', () => {
      dashSel = [];
      dashTileSel = new Map();
      renderDashSelStrip();
      renderDashGrid();
    });
    strip.appendChild(clear);
  }
}
