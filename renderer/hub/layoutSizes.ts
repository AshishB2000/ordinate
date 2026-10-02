'use strict';

// LAYOUTS FOR EVERY SIZE — which size the open dashboard shows, and drawing it.
// Classic global-scope renderer <script>; the model is renderer/hub/sizeLayout.ts
// (pure, shared with main and Publish), edits are layoutEdit.ts, the phone
// "Filters (N)" sheet is layoutFilters.ts.
//
// WHICH SIZE. By default the DASHBOARD CONTAINER's width picks it — the editor
// pane, not the window — so a narrow window, the Assistant docked beside it or
// a split pane all show the tablet (or phone) layout, and whatever is on screen
// is what an edit changes. The header's Desktop / Tablet / Phone switcher pins a
// size; pinning tablet or phone previews it at a device width in a frame.
// Clicking the size the pane would pick anyway goes back to following the
// pane. Present mode ignores a pin, follows the pane and never shows phone. A
// pin belongs to one open dashboard and is forgotten when another opens.
//
// THE HOOKS. dashGrid.renderDashGrid asks `lyGridTiles` which tiles to draw and
// in what order, then calls `lyAfterGrid` once they are in the DOM, after
// authoringAfterGrid (which positions groups for desktop) — so a small size's
// cells are the last word. dashShare.fitDashPresentRows asks `lyPresentRows`,
// dashCardChrome's ⋯ menu asks `lyMenuItems`. On desktop every hook is a no-op
// and the editor is exactly what it was.

/** The size the author clicked, or null to follow the pane. */
let lyPinned: string | null = null;
/** Which dashboard that pin belongs to. */
let lyPinnedFor: string | null = null;
/** The size the last grid render drew. */
let lyShown = 'desktop';
/** That render's `sizeLayout.resolve` — null on desktop. */
let lyPlaced: any = null;
let lyObserver: ResizeObserver | null = null;

/** The switcher's device marks (icons.ts). */
const LY_ICON: Record<string, string> = { desktop: 'monitor', tablet: 'tablet', phone: 'smartphone' };

function lyLabel(size: string): string {
  return sizeLayout.LABELS[size] || t('layoutSizes.desktop');
}

/**
 * The dashboard container's width — 0 while it is not laid out. The sheet's
 * own content box, plus the authoring flyout (Properties, Data, Filters) when
 * one is open: that panel is a tool laid over the pane for a moment, and
 * opening it must not flip the layout being edited. The window, a split pane
 * and the docked Assistant all still count.
 */
function lyEditorWidth(): number {
  const ed = dashEl('dash-editor');
  if (!ed || ed.hidden) return 0;
  const cs = getComputedStyle(ed);
  let w = ed.getBoundingClientRect().width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const bench = ed.parentElement;
  if (bench && bench.classList.contains('is-active')) {
    for (const el of Array.from(bench.children)) {
      if (el.classList.contains('an-side') && (el as HTMLElement).getClientRects().length) w += el.getBoundingClientRect().width;
    }
  }
  return w;
}

function lyAutoSize(): string {
  return sizeLayout.pickSize(lyEditorWidth());
}

/** The size the open dashboard shows right now. */
function lyShownSize(): string {
  if (!dashCurrent) return 'desktop';
  if (dashPresenting) return sizeLayout.presentSize(lyEditorWidth());
  if (lyPinnedFor !== dashCurrent.id) { lyPinned = null; lyPinnedFor = dashCurrent.id; }
  return lyPinned || lyAutoSize();
}

/** A pinned tablet / phone is a device preview, drawn in a frame. */
function lyFramed(): boolean {
  return !!lyPinned && lyPinned !== 'desktop' && !dashPresenting;
}

function lyStored(page: any, size: string): any {
  return page && page.layouts ? page.layouts[size] : undefined;
}

function lyEdited(page: any, size: string): boolean {
  const s = lyStored(page, size);
  return !!s && Array.isArray(s.items) && s.items.length > 0;
}

/**
 * The cards the VIEW hides right now: a folded container's, an inactive tab's.
 * The same rule authoringAfterGrid (layoutKinds.ts) applies on desktop, taken
 * before placement here so a small size packs its rows without the gaps.
 */
function lyViewHidden(cards: any[]): Set<string> {
  const out = new Set<string>();
  for (const g of cards || []) {
    if (!g || !cardModel.GROUP_TYPES.includes(g.type)) continue;
    const folded = g.type === 'container' && g.container && g.container.collapsible && groupFolded.has(g.id);
    const tab = g.type === 'tabs' ? cardModel.activeTab(g, groupTab.get(g.id)) : '';
    for (const c of cardModel.childrenOf(cards, g.id)) {
      if (folded || (g.type === 'tabs' && c.tabId !== tab)) out.add(c.id);
    }
  }
  return out;
}

function lyResolve(size: string): any {
  const page = dashCurrentPage();
  if (!page) return null;
  const cards = Array.isArray(page.cards) ? page.cards : [];
  return sizeLayout.resolve(cards, lyStored(page, size), size, lyViewHidden(cards));
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** renderDashGrid: the tiles to draw, in the shown size's order (desktop: unchanged). */
function lyGridTiles(tiles: any[]): any[] {
  lyShown = lyShownSize();
  lyPlaced = lyShown === 'desktop' ? null : lyResolve(lyShown);
  if (!lyPlaced) return tiles;
  const byId = new Map(tiles.map((c: any) => [c && c.id, c]));
  return lyPlaced.items.map((it: any) => byId.get(it.id)).filter(Boolean);
}

/** renderDashGrid, last: place the cells, then everything around the grid. */
function lyAfterGrid(): void {
  const grid = dashEl('dash-grid');
  const ed = dashEl('dash-editor');
  if (!grid || !ed) return;
  const small = !!lyPlaced;
  grid.classList.toggle('ly-grid--tablet', small && lyShown === 'tablet');
  grid.classList.toggle('ly-grid--phone', small && lyShown === 'phone');
  ed.classList.toggle('ly-small', small);
  ed.classList.toggle('ly-frame', small && lyFramed());
  ed.dataset.lySize = lyShown;
  ed.style.setProperty('--ly-frame-w', (sizeLayout.FRAME_WIDTH[lyShown] || 0) + 'px');
  if (small) {
    lyPosition(grid);
    lyWireCards(grid); // layoutEdit.ts
    if (!lyPlaced.items.length && lyPlaced.hidden.length) grid.appendChild(lyAllHidden());
  }
  lyPaintHead();
  lyPaintNote();
  lyPaintTray();
  lyPaintFilterBar(); // layoutFilters.ts
  lyObserve();
}

/** dashShare.fitDashPresentRows: the shown size's row count, or null on desktop. */
function lyPresentRows(): number | null {
  const size = lyShownSize();
  if (size === 'desktop') return null;
  const r = lyResolve(size);
  return r ? r.rows : null;
}

/**
 * Put every placed card in its cell, and the DOM in reading order — Tab order
 * follows the DOM, not the grid. Walked from the end so a card is only moved
 * when it is not already where it belongs: a reorder moves the one card, not a
 * sheet of live charts and maps.
 */
function lyPosition(grid: HTMLElement): void {
  let next: HTMLElement | null = null;
  for (let i = lyPlaced.items.length - 1; i >= 0; i--) {
    const it = lyPlaced.items[i];
    const el = grid.querySelector('.dash-card[data-card-id="' + it.id + '"]') as HTMLElement | null;
    if (!el) continue;
    el.style.gridColumn = (it.x + 1) + ' / span ' + it.w;
    el.style.gridRow = (it.y + 1) + ' / span ' + it.h;
    if (next ? el.nextElementSibling !== next : el.parentElement !== grid) grid.insertBefore(el, next);
    next = el;
  }
}

/** Every card hidden on this size: say so where the grid would be. */
function lyAllHidden(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ly-empty';
  box.appendChild(icon('eye-off', 20));
  const h = document.createElement('p');
  h.className = 'ly-empty-h';
  h.textContent = t('layoutSizes.every_card_is_hidden_on', { p0: lyLabel(lyShown).toLowerCase() });
  const p = document.createElement('p');
  p.className = 'ly-empty-p';
  p.textContent = t('layoutSizes.show_one_from_the_list_below');
  box.append(h, p);
  return box;
}

/** Re-pick the size when the pane is resized across a breakpoint. */
function lyObserve(): void {
  if (lyObserver || typeof ResizeObserver === 'undefined') return;
  const ed = dashEl('dash-editor');
  if (!ed) return;
  let raf = 0;
  // Deferred a frame: re-rendering inside the observer callback is how you get
  // "ResizeObserver loop completed with undelivered notifications".
  lyObserver = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (dashCurrent && !ed.hidden && lyShownSize() !== lyShown) renderDashGrid();
    });
  });
  lyObserver.observe(ed);
}

// ── The header switcher; the note above the grid (state, Reset) ─────────────

function lySetSize(size: string): void {
  if (!dashCurrent) return;
  lyPinnedFor = dashCurrent.id;
  lyPinned = size === lyAutoSize() ? null : size;
  renderDashGrid();
}

const LY_WHAT: Record<string, string> = {
  desktop: t('layoutSizes.the_12_column_grid'),
  tablet: t('layoutSizes.8_columns'),
  phone: t('layoutSizes.one_column_kpis_two_up'),
};

/**
 * The switcher lives in the editor head, the busiest strip in the app, so it
 * is three icon segments — and in a head too narrow for them (the docked
 * Assistant beside a small window) one button showing the current size, whose
 * menu offers all three (layouts.css, the dash-head container query). The
 * state and Reset live in the note above the grid, beside the layout they
 * describe.
 */
function lyHeadEl(): HTMLElement | null {
  let wrap = document.getElementById('ly-head');
  if (wrap) return wrap;
  const head = document.querySelector('.dash-editor-head');
  if (!head) return null;
  wrap = document.createElement('div');
  wrap.id = 'ly-head';
  wrap.className = 'ly-head';
  const sw = document.createElement('div');
  sw.id = 'ly-switch';
  sw.className = 'seg ly-switch';
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', t('layoutSizes.layout_size'));
  for (const size of sizeLayout.SIZES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-opt ly-seg';
    b.dataset.size = size;
    b.appendChild(icon(LY_ICON[size]));
    const dot = document.createElement('span');
    dot.className = 'ly-seg-dot';
    dot.hidden = true;
    b.appendChild(dot);
    b.addEventListener('click', () => lySetSize(size));
    sw.appendChild(b);
  }
  const compact = document.createElement('button');
  compact.type = 'button';
  compact.id = 'ly-size-btn';
  compact.className = 'btn btn-sm ly-size-btn';
  compact.setAttribute('aria-haspopup', 'menu');
  compact.addEventListener('click', () => lySizeMenu(compact));
  wrap.append(sw, compact);
  head.insertBefore(wrap, head.querySelector('.dash-head-zone--commit'));
  return wrap;
}

function lySizeMenu(anchor: HTMLElement): void {
  const page = dashCurrentPage();
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    for (const size of sizeLayout.SIZES) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chart-menu-item ly-size-item';
      row.appendChild(icon(size === lyShown ? 'check' : LY_ICON[size], 14));
      row.append(lyLabel(size) + (size !== 'desktop' && lyEdited(page, size) ? t('layoutSizes.edited') : ''));
      row.addEventListener('click', () => { close(); lySetSize(size); });
      menu.appendChild(row);
    }
  });
}

function lyPaintHead(): void {
  const wrap = lyHeadEl();
  if (!wrap) return;
  const page = dashCurrentPage();
  const auto = !lyPinned;
  wrap.querySelectorAll('.ly-seg').forEach((node) => {
    const b = node as HTMLButtonElement;
    const size = b.dataset.size || 'desktop';
    const edited = size !== 'desktop' && lyEdited(page, size);
    const on = size === lyShown;
    b.setAttribute('aria-pressed', String(on));
    const dot = b.querySelector('.ly-seg-dot') as HTMLElement | null;
    if (dot) dot.hidden = !edited;
    const state = size === 'desktop' ? '' : edited ? t('layoutSizes.edited_2') : t('layoutSizes.derived');
    b.setAttribute('aria-label', lyLabel(size) + t('layoutSizes.layout') + state);
    b.title = lyLabel(size) + ' — ' + LY_WHAT[size] + (size === 'desktop' ? '' : edited ? ' (edited)' : ' (derived)')
      + (on && auto ? t('layoutSizes.picked_for_this_pane_s_width') : '');
  });
  const compact = document.getElementById('ly-size-btn');
  if (compact) {
    compact.textContent = '';
    compact.append(icon(LY_ICON[lyShown]), icon('chevron-down', 14));
    compact.setAttribute('aria-label', t('layoutSizes.layout_size_2', { lyShown: lyLabel(lyShown) }));
    compact.title = t('layoutSizes.layout_size_2', { lyShown: lyLabel(lyShown) });
  }
}

// ── Around the grid: the note above it, the hidden-card tray below it ───────

function lyNoteEl(): HTMLElement | null {
  let note = document.getElementById('ly-note');
  if (!note) {
    const bar = dashEl('dash-control-bar');
    if (!bar || !bar.parentElement) return null;
    note = document.createElement('div');
    note.id = 'ly-note';
    note.className = 'ly-note';
    bar.parentElement.insertBefore(note, bar);
  }
  return note;
}

/** Which size this is and why, whether it is derived or edited, and Reset. */
function lyPaintNote(): void {
  const note = lyNoteEl();
  if (!note) return;
  const size = lyShown;
  note.hidden = size === 'desktop' || dashPresenting || !dashCurrent;
  if (note.hidden) return;
  note.innerHTML = '';
  note.appendChild(icon(LY_ICON[size]));
  const text = document.createElement('span');
  text.className = 'ly-note-text';
  text.setAttribute('role', 'status');
  const name = lyLabel(size).toLowerCase();
  const b = document.createElement('strong');
  if (lyFramed()) {
    b.textContent = t('layoutSizes.preview_px', { size: lyLabel(size), p1: sizeLayout.FRAME_WIDTH[size] });
    text.append(b, t('layoutSizes.drag_a_card_by_its_header', { name }));
  } else {
    b.textContent = t('layoutSizes.showing_the_layout', { name });
    text.append(b, t('layoutSizes.this_pane_is_narrower_than_px', { p0: (size === 'phone' ? sizeLayout.BREAKPOINTS.phone : sizeLayout.BREAKPOINTS.tablet), name }));
  }
  note.appendChild(text);
  const acts = document.createElement('span');
  acts.className = 'ly-note-acts';
  const edited = lyEdited(dashCurrentPage(), size);
  const state = document.createElement('span');
  state.id = 'ly-state';
  state.className = 'ly-state' + (edited ? ' is-edited' : '');
  state.textContent = edited ? t('layoutSizes.edited_3') : t('layoutSizes.derived_2');
  state.title = edited
    ? t('layoutSizes.this_page_has_a_layout_of', { name })
    : t('layoutSizes.laid_out_from_the_desktop_grid', { name });
  acts.appendChild(state);
  if (edited && !dashReadOnly) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.id = 'ly-reset';
    reset.className = 'btn btn-sm dash-edit-only ly-note-btn';
    iconLabel(reset, 'rotate-ccw', t('layoutSizes.reset_to_derived'));
    reset.addEventListener('click', () => lyReset()); // layoutEdit.ts
    acts.appendChild(reset);
  }
  if (!lyFramed()) {
    const desk = document.createElement('button');
    desk.type = 'button';
    desk.className = 'btn btn-sm ly-note-btn';
    iconLabel(desk, 'monitor', t('layoutSizes.edit_desktop_layout'));
    desk.addEventListener('click', () => lySetSize('desktop'));
    acts.appendChild(desk);
  }
  note.appendChild(acts);
}

function lyTrayEl(): HTMLElement | null {
  let tray = document.getElementById('ly-tray');
  if (!tray) {
    const grid = dashEl('dash-grid');
    if (!grid) return null;
    tray = document.createElement('section');
    tray.id = 'ly-tray';
    tray.className = 'ly-tray';
    grid.after(tray);
  }
  return tray;
}

function lyPaintTray(): void {
  const tray = lyTrayEl();
  if (!tray) return;
  const hidden: string[] = lyPlaced ? lyPlaced.hidden : [];
  tray.hidden = !hidden.length || dashPresenting;
  if (tray.hidden) return;
  tray.innerHTML = '';
  const name = lyLabel(lyShown).toLowerCase();
  tray.setAttribute('aria-label', t('layoutSizes.cards_hidden_on', { name }));
  const head = document.createElement('div');
  head.className = 'ly-tray-head';
  head.appendChild(icon('eye-off'));
  const title = document.createElement('span');
  title.className = 'ly-tray-title';
  title.textContent = t('layoutSizes.hidden_on', { name });
  const count = document.createElement('span');
  count.className = 'ly-tray-count';
  count.textContent = String(hidden.length);
  const hint = document.createElement('span');
  hint.className = 'ly-tray-hint';
  hint.textContent = t('layoutSizes.still_on_desktop_unless_hidden_there', { p0: !!(lyShown === 'phone') });
  head.append(title, count, hint);
  tray.appendChild(head);
  const list = document.createElement('div');
  list.className = 'ly-tray-list';
  for (const id of hidden) {
    const card = dashCardAnywhere(id);
    if (!card) continue;
    const chip = document.createElement('div');
    chip.className = 'ly-tray-chip';
    chip.dataset.cardId = id;
    chip.appendChild(icon(card.type === 'metric' ? 'target' : card.type === 'visual' ? 'chart-bar' : card.type === 'text' ? 'file-text' : 'grid'));
    const label = document.createElement('span');
    label.className = 'ly-tray-name';
    label.textContent = dashCardTitle(card);
    // A visual card only knows its name once the visual is read (renderVisualCard does the same).
    if (card.type === 'visual' && !card.visual) {
      void resolveCardVisual(card).then((r) => { if (r && r.visual && r.visual.name) label.textContent = dashSubst(r.visual.name); });
    }
    chip.appendChild(label);
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn btn-sm dash-edit-only ly-tray-show';
    iconLabel(show, 'eye', t('common.show'));
    show.setAttribute('aria-label', t('layoutSizes.show_on', { card: dashCardTitle(card), name }));
    show.addEventListener('click', () => lyHide(id, false)); // layoutEdit.ts
    chip.appendChild(show);
    list.appendChild(chip);
  }
  tray.appendChild(list);
}
