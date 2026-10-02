'use strict';

// LAYOUTS FOR EVERY SIZE — editing a tablet or phone layout. Classic
// global-scope renderer <script>; loads after layoutSizes.js.
//
// Three edits, each only ever touching the size on screen: ORDER (drag a card
// by its header, arrow keys, or the ⋯ menu), HIDDEN (the eye in the card head,
// the menu, and Show in the tray under the grid) and HEIGHT (drag the bottom
// edge, shift+arrows, or the menu). Widths stay derived — a phone is one column
// and a tablet pairs what fits — so no edit can leave a row half empty.
//
// The FIRST edit on a derived size materialises it: sizeLayout.materialize
// writes the order on screen as the size's own layout, and every later desktop
// change folds into it (a new card at its derived position, a removed one gone).
// Every edit goes through markDashDirty, so undo, redo and the autosave treat it
// exactly as they treat a desktop move — `layouts` rides on the page.
//
// On a small size the desktop gestures (authoringSelect.ts) are intercepted in
// the CAPTURE phase on the card, so a drag here can never move the desktop grid
// underneath. Only the head and the resize handles are taken: the body is the
// chart's, and a map still pans.

function lyCanEdit(): boolean {
  return !!dashCurrent && !dashReadOnly && !dashPresenting && lyShown !== 'desktop' && !!lyPlaced;
}

/** The shown size's layout, ready to edit — materialised from the derivation on the first edit. */
function lyDraft(): any {
  const page = dashCurrentPage();
  if (!page || !lyCanEdit()) return null;
  return sizeLayout.materialize(page.cards, lyStored(page, lyShown));
}

/** Store an edited size on the open page, file it for undo, and redraw. */
function lyCommit(draft: any, label: string, reflow: boolean): void {
  const page = dashCurrentPage();
  if (!page) return;
  page.layouts = Object.assign({}, page.layouts, { [lyShown]: draft });
  markDashDirty(label + ' (' + lyLabel(lyShown).toLowerCase() + ')');
  if (reflow) lyReflow();
  else renderDashGrid();
}

/**
 * Re-place the cards without rebuilding them — a reorder or a height change
 * keeps every chart and map as it is. Anything that changes WHICH cards show
 * falls back to a full render.
 */
function lyReflow(): void {
  const grid = dashEl('dash-grid');
  const next = lyShown === 'desktop' ? null : lyResolve(lyShown);
  const same = !!grid && !!next && !!lyPlaced && next.items.length === lyPlaced.items.length
    && next.items.every((it: any) => lyPlaced.items.some((p: any) => p.id === it.id));
  if (!same) { renderDashGrid(); return; }
  lyPlaced = next;
  lyPosition(grid as HTMLElement);
  lyPaintHead();
  lyPaintNote();
  lyPaintTray();
}

/** Move a card one place earlier (-1) or later (+1) among the cards showing. */
function lyStep(id: string, dir: number): void {
  if (!lyPlaced) return;
  const vis: string[] = lyPlaced.items.map((i: any) => i.id);
  const i = vis.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= vis.length) return;
  const draft = lyDraft();
  if (draft && sizeLayout.moveItem(draft, id, vis[j], dir > 0)) lyCommit(draft, t('layoutEdit.reorder_card'), true);
}

function lyNudgeHeight(id: string, dh: number): void {
  const it = lyPlaced && lyPlaced.items.find((i: any) => i.id === id);
  const draft = it ? lyDraft() : null;
  if (draft && sizeLayout.setHeight(draft, id, it.h + dh)) lyCommit(draft, t('layoutEdit.change_height'), true);
}

function lyHide(id: string, on: boolean): void {
  const draft = lyDraft();
  if (draft && sizeLayout.setHidden(draft, id, on)) lyCommit(draft, on ? t('layoutEdit.hide_card') : t('layoutEdit.show_card'), false);
}

function lyReset(): void {
  const page = dashCurrentPage();
  const size = lyShown;
  if (!page || size === 'desktop' || dashReadOnly || !lyEdited(page, size)) return;
  const name = lyLabel(size).toLowerCase();
  if (!window.confirm(t('layoutEdit.reset_the_layout_of_this_page', { name }))) return;
  const next = Object.assign({}, page.layouts);
  delete next[size];
  if (Object.keys(next).length) page.layouts = next;
  else delete page.layouts;
  markDashDirty(t('layoutEdit.reset_layout', { name }));
  renderDashGrid();
}

/** dashCardChrome's ⋯ menu on a small size: this size's edits instead of the desktop nudges. */
function lyMenuItems(card: any): Array<[string, () => void]> | null {
  if (lyShown === 'desktop' || !lyPlaced) return null;
  const name = lyLabel(lyShown).toLowerCase();
  return [
    [t('layoutEdit.move_earlier'), () => lyStep(card.id, -1)],
    [t('layoutEdit.move_later'), () => lyStep(card.id, 1)],
    [t('common.taller'), () => lyNudgeHeight(card.id, 1)],
    [t('common.shorter'), () => lyNudgeHeight(card.id, -1)],
    [t('layoutEdit.hide_on', { name }), () => lyHide(card.id, true)],
    [t('common.remove'), () => removeCard(card)],
  ];
}

// ── Gestures ────────────────────────────────────────────────────────────────

let lyDrag: any = null;

function lyWireCards(grid: HTMLElement): void {
  grid.querySelectorAll('.dash-card').forEach((node) => {
    const el = node as HTMLElement;
    if (el.dataset.lyWired === '1') return;
    el.dataset.lyWired = '1';
    el.addEventListener('pointerdown', lyOnPointerDown, true);
    el.addEventListener('keydown', lyOnKey, true);
    const ctrls = el.querySelector('.dash-card-ctrls');
    if (ctrls) {
      const id = el.dataset.cardId || '';
      const hide = dashCtrlBtn('eye-off', t('layoutEdit.hide_on_2', { p0: lyLabel(lyShown).toLowerCase() }), () => lyHide(id, true));
      hide.classList.add('ly-hide-btn');
      ctrls.insertBefore(hide, ctrls.firstChild);
    }
  });
  if (!grid.dataset.lyGestures) {
    grid.dataset.lyGestures = '1';
    window.addEventListener('pointermove', lyOnMove);
    window.addEventListener('pointerup', lyOnUp);
    window.addEventListener('pointercancel', lyOnUp);
  }
}

function lyOnPointerDown(e: PointerEvent): void {
  if (lyShown === 'desktop' || e.button !== 0 || e.shiftKey) return;
  const el = e.currentTarget as HTMLElement;
  const t = e.target as Element;
  const handle = t.closest('.an-resize');
  if (!handle && !t.closest('.dash-card-head')) return;
  // From here the desktop gesture must not start, whatever happens next.
  e.stopPropagation();
  if (!lyCanEdit() || handle && handle.classList.contains('an-resize--e')) return;
  // A button in the head keeps its click; it just does not drag.
  if (!handle && t.closest('button, a, input, select, textarea, [role="tab"]')) return;
  const id = el.dataset.cardId || '';
  const it = lyPlaced.items.find((i: any) => i.id === id);
  if (!it) return;
  void anSelectCard(id);
  lyDrag = {
    mode: handle ? 'height' : 'move', id, el, it, h: it.h,
    grid: dashEl('dash-grid'), x0: e.clientX, y0: e.clientY, active: false, target: null, after: false,
  };
  try {
    (t as HTMLElement).setPointerCapture(e.pointerId);
  } catch (_) { /* no active pointer for that id — the window listeners carry it */ }
  e.preventDefault();
}

function lyClearDrop(): void {
  document.querySelectorAll('#dash-grid .ly-drop-before, #dash-grid .ly-drop-after').forEach((n) => {
    n.classList.remove('ly-drop-before', 'ly-drop-after', 'ly-drop-x');
  });
}

/** The card a dragged one would land beside, and on which side of it. */
function lyDropTarget(x: number, y: number, skip: string): { id: string; el: HTMLElement; after: boolean; side: boolean } | null {
  const grid = dashEl('dash-grid');
  if (!grid || !lyPlaced) return null;
  let best: any = null;
  let bestD = Infinity;
  for (const it of lyPlaced.items) {
    if (it.id === skip) continue;
    const el = grid.querySelector('.dash-card[data-card-id="' + it.id + '"]') as HTMLElement | null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      const side = it.w < lyPlaced.cols; // shares its row: before/after is left/right
      best = { id: it.id, el, side, after: side ? x > r.left + r.width / 2 : y > r.top + r.height / 2 };
    }
  }
  return best;
}

function lyOnMove(e: PointerEvent): void {
  const d = lyDrag;
  if (!d) return;
  const dx = e.clientX - d.x0;
  const dy = e.clientY - d.y0;
  if (!d.active) {
    if (Math.hypot(dx, dy) < 4) return;
    d.active = true;
    d.el.classList.add('is-dragging');
    document.body.classList.add('an-grabbing');
  }
  if (d.mode === 'height') {
    d.h = Math.max(1, Math.min(sizeLayout.MAX_H, d.it.h + Math.round(dy / (dashRowPx() + dashGapPx()))));
    anShowGhost(d.grid, d.it.x, d.it.y, d.it.w, d.h);
    return;
  }
  lyClearDrop();
  const hit = lyDropTarget(e.clientX, e.clientY, d.id);
  d.target = hit ? hit.id : null;
  d.after = !!hit && hit.after;
  if (hit) hit.el.classList.add(hit.after ? 'ly-drop-after' : 'ly-drop-before', ...(hit.side ? ['ly-drop-x'] : []));
}

function lyOnUp(): void {
  const d = lyDrag;
  if (!d) return;
  lyDrag = null;
  d.el.classList.remove('is-dragging');
  document.body.classList.remove('an-grabbing');
  anClearGhost();
  lyClearDrop();
  if (!d.active) return;
  const draft = lyDraft();
  if (!draft) return;
  if (d.mode === 'height') {
    if (d.h !== d.it.h && sizeLayout.setHeight(draft, d.id, d.h)) lyCommit(draft, t('layoutEdit.change_height'), true);
    return;
  }
  if (d.target && sizeLayout.moveItem(draft, d.id, d.target, d.after)) lyCommit(draft, t('layoutEdit.reorder_card'), true);
}

/** Arrows reorder, shift+up/down change the height — the keyboard path for both gestures. */
function lyOnKey(e: KeyboardEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (lyShown === 'desktop' || e.target !== el) return;
  const k = e.key;
  const earlier = k === 'ArrowUp' || k === 'ArrowLeft';
  if (!earlier && k !== 'ArrowDown' && k !== 'ArrowRight') return;
  e.preventDefault();
  e.stopImmediatePropagation(); // the desktop nudge on the same card must not run
  if (!lyCanEdit()) return;
  const id = el.dataset.cardId || '';
  void anSelectCard(id);
  if (e.shiftKey) {
    if (k === 'ArrowUp' || k === 'ArrowDown') lyNudgeHeight(id, k === 'ArrowDown' ? 1 : -1);
  } else {
    lyStep(id, earlier ? -1 : 1);
  }
  const again = document.querySelector('#dash-grid .dash-card[data-card-id="' + id + '"]') as HTMLElement | null;
  if (again && document.activeElement !== again) again.focus();
}
