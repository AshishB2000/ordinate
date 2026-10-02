'use strict';

// Arranging cards on the sheet: ⇧-click MULTI-SELECTION with align and
// distribute, SNAP GUIDES while dragging, and what a finished drag means for
// groups (children move with their container; a card dropped inside a group
// joins it, dragged out of it leaves). Classic global-scope renderer <script>.
//
// Every change goes through markDashDirty, so undo covers all of it; the
// geometry itself is cardModel's, pure and unit-tested.

const anMulti = new Set<string>();

function anPaintMulti(): void {
  document.querySelectorAll('#dash-grid .dash-card').forEach((el) => {
    el.classList.toggle('is-multi', anMulti.has((el as HTMLElement).dataset.cardId || ''));
  });
  renderArrangeBar();
}

function anMultiClear(): void {
  if (!anMulti.size) return;
  anMulti.clear();
  anPaintMulti();
}

function arrangeLive(): any[] {
  return [...anMulti].map((id) => dashCardAnywhere(id)).filter((c) => c && c.layout);
}

/** After layouts moved: pull children along, refit their groups, repaint in place. */
function arrangeCommit(moved: any[], label: string): void {
  const cards = dashCards();
  for (const c of moved) {
    if (c.parentId) cardModel.fitGroup(cards, c.parentId);
  }
  for (const c of cards) reapplyCardStyle(c);
  markDashDirty(label);
  authoringAfterGrid();
}

function renderArrangeBar(): void {
  let bar = document.getElementById('an-arrange');
  if (!bar) {
    const grid = document.getElementById('dash-grid');
    if (!grid) return;
    bar = document.createElement('div');
    bar.id = 'an-arrange';
    bar.className = 'an-arrange';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('gridArrange.arrange_selected_cards'));
    grid.before(bar);
  }
  const n = arrangeLive().length;
  bar.hidden = n < 2 || dashMode !== 'analysis';
  if (bar.hidden) return;
  bar.innerHTML = '';
  const count = document.createElement('span');
  count.className = 'an-arrange-count';
  count.textContent = t('gridArrange.cards_selected', { n });
  bar.appendChild(count);
  const group = (label: string, items: Array<[string, string, () => void, boolean?]>): void => {
    const g = document.createElement('span');
    g.className = 'an-arrange-group';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    const l = document.createElement('span');
    l.className = 'an-arrange-label';
    l.textContent = label;
    g.appendChild(l);
    for (const [text, title, run, disabled] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.textContent = text;
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', run);
      g.appendChild(b);
    }
    bar.appendChild(g);
  };
  const align = (mode: string): void => {
    const cs = arrangeLive();
    cardModel.alignLayouts(cs.map((c) => c.layout), mode);
    arrangeCommit(cs, t('gridArrange.align_cards'));
  };
  const spread = (axis: 'x' | 'y'): void => {
    const cs = arrangeLive();
    cardModel.distributeLayouts(cs.map((c) => c.layout), axis);
    arrangeCommit(cs, t('gridArrange.distribute_cards'));
  };
  group(t('gridArrange.align'), [
    [t('common.left'), t('gridArrange.align_left_edges'), () => align('left')],
    [t('common.centre'), t('gridArrange.align_centres'), () => align('center')],
    [t('common.right'), t('gridArrange.align_right_edges'), () => align('right')],
    [t('common.top'), t('gridArrange.align_top_edges'), () => align('top')],
    [t('gridArrange.middle'), t('gridArrange.align_middles'), () => align('middle')],
    [t('common.bottom'), t('gridArrange.align_bottom_edges'), () => align('bottom')],
  ]);
  group(t('gridArrange.distribute'), [
    [t('gridArrange.across'), t('gridArrange.equal_gaps_left_to_right'), () => spread('x'), n < 3],
    [t('common.down'), t('gridArrange.equal_gaps_top_to_bottom'), () => spread('y'), n < 3],
  ]);
  group(t('common.group'), [
    [t('common.container'), t('gridArrange.put_the_selected_cards_in_a'), () => handleAddGroup('container')],
    [t('common.tabs'), t('gridArrange.put_the_selected_cards_in_the'), () => handleAddGroup('tabs')],
  ]);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm btn-ghost';
  clear.textContent = t('common.done');
  clear.addEventListener('click', anMultiClear);
  bar.appendChild(clear);
}

// ⇧-click adds a card to (or takes it out of) the multi-selection; a plain
// click on a card, or Escape, ends it. Capture phase, so the single-selection
// handler never sees a ⇧-click.
function initGridArrange(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('#dash-grid .dash-card') as HTMLElement | null;
    if (!el || dashMode !== 'analysis') return;
    if ((e.target as HTMLElement).closest('.dash-card-ctrls, .an-card-props, button, a, input, select, textarea')) return;
    const id = el.dataset.cardId || '';
    if (!e.shiftKey) { if (!anMulti.has(id)) anMultiClear(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (!anMulti.size && anSelectedCardId && anSelectedCardId !== id) anMulti.add(anSelectedCardId);
    if (anMulti.has(id)) anMulti.delete(id); else anMulti.add(id);
    anPaintMulti();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') anMultiClear(); });
}

document.addEventListener('DOMContentLoaded', () => initGridArrange());

// ── Snap guides (called from authoringSelect's gesture) ─────────────────────

function authoringClearGuides(): void {
  document.querySelectorAll('#dash-grid .an-guide').forEach((n) => n.remove());
}

/** Snap a MOVE gesture's target to neighbours' edges and centres, and draw the lines it met. */
function authoringSnap(g: any): void {
  authoringClearGuides();
  if (!g || g.mode !== 'move') return;
  const cards = dashCards();
  const skip = new Set([g.card.id, ...cardModel.childrenOf(cards, g.card.id).map((c: any) => c.id)]);
  const others = cards.filter((c: any) => c && c.layout && c.type !== 'control' && !skip.has(c.id)).map((c: any) => c.layout);
  const s = cardModel.snapRect({ x: g.next.x, y: g.next.y, w: g.next.w, h: g.next.h }, others, 1);
  g.next.x = s.x;
  g.next.y = s.y;
  const colP = anColPitch(g.grid);
  const rowP = anRowPitch();
  const gap = dashGapPx();
  for (const guide of s.guides) {
    const line = document.createElement('div');
    line.className = 'an-guide an-guide--' + guide.axis;
    line.setAttribute('aria-hidden', 'true');
    if (guide.axis === 'x') line.style.left = Math.round(guide.at * colP - (Number.isInteger(guide.at) ? gap / 2 : 0)) + 'px';
    else line.style.top = Math.round(guide.at * rowP - (Number.isInteger(guide.at) ? gap / 2 : 0)) + 'px';
    g.grid.appendChild(line);
  }
}

/**
 * A card finished moving or resizing by (dx, dy). A group takes its children
 * along; a card joins the group it was dropped inside, or leaves the one it
 * was dragged out of; a group grows to keep a child that now overhangs it; an
 * image with a locked aspect keeps it. Affected cards are repainted in place.
 */
function authoringAfterGesture(card: any, mode: string, dx: number, dy: number): void {
  const cards = dashCards();
  const live = cards.find((c: any) => c && c.id === card.id) || card;
  let regroup = false;
  if (cardModel.GROUP_TYPES.includes(live.type)) {
    if (mode === 'move') cardModel.moveChildren(cards, live.id, dx, dy);
    if (mode !== 'move') cardModel.fitGroup(cards, live.id);
  } else {
    if (live.type === 'image' && mode !== 'move') imgLockAspect(live);
    const parent = live.parentId ? cards.find((c: any) => c.id === live.parentId) : null;
    const overlapsParent = parent && overlaps(live.layout, cardModel.contentRect(parent));
    const target = mode === 'move' ? cardModel.dropParent(cards, live) : null;
    if (target && target !== live.parentId) {
      live.parentId = target;
      const g = cards.find((c: any) => c.id === target);
      if (g && g.type === 'tabs') live.tabId = cardModel.activeTab(g, groupTab.get(g.id));
      regroup = true;
    } else if (parent && mode === 'move' && !overlapsParent) {
      delete live.parentId;
      delete live.tabId;
      regroup = true;
    } else if (parent) {
      cardModel.fitGroup(cards, parent.id);
    }
  }
  if (regroup) { renderDashGrid(); return; }
  for (const c of cards) reapplyCardStyle(c);
  authoringAfterGrid();
}

function overlaps(a: any, b: any): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A card was removed: a group's children stay, ungrouped. */
function authoringAfterRemove(cardId: string): void {
  cardModel.releaseChildren(dashCards(), cardId);
  anMulti.delete(cardId);
}
