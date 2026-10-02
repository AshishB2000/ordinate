'use strict';

// Tabs — SPLIT VIEW: two records side by side, with a draggable divider.
//
// Every record page is a singleton living in its own section panel
// (.ws-panel), so two records side by side is two PANELS shown at once in the
// .hub-body row — placed by CSS `order`, sized by `flex` from the ratio, the
// divider between them. Nothing is re-parented or cloned, so each pane keeps
// its own module state: selections and filters stay per pane for free. Two
// records on the SAME page (two dashboards; a dashboard and a report) cannot
// both be open, and the user is told so rather than shown half of it.
//
// What would otherwise tear a split down, and why it doesn't:
//  - selectSection() hides every panel but one. The focused pane IS the current
//    section, and tabApplySplit() — run by every tab sync, which the dkSync()
//    at the end of selectSection triggers — shows the other one again.
//  - selectSection() also REFRESHES the section, and the Dashboards refresh
//    closes the open editor. So a pane taking focus never calls it:
//    tabFocusPane() moves currentSection, the nav and the dock by hand.
//  - body.an-focus (an open dashboard) hides the sidebar: harmless here, and
//    the sync's focus-mode guard stands down while split.
//
// Classic global-scope renderer <script>: NO import/export.

let tabWasSplit = false;
let tabDropEl: HTMLElement | null = null;

function tabHubBody(): HTMLElement | null {
  return document.querySelector('.hub-body');
}

function tabSectionOf(key: string | null): string {
  const k = tabKindOf(tabFind(key));
  return k ? k.section : '';
}

/** Lay the panels out for the current split — or put them back after one. */
function tabApplySplit(): void {
  const body = tabHubBody();
  if (!body) return;
  const sp = tabState.split;
  const secL = sp ? tabSectionOf(sp.left) : '';
  const secR = sp ? tabSectionOf(sp.right) : '';
  const on = !!sp && !!secL && !!secR && secL !== secR;
  if (!on && !tabWasSplit) return; // never touch the panels outside a split
  body.classList.toggle('tab-split', on);
  const divider = tabDivider(body);
  divider.hidden = !on;
  document.querySelectorAll('.ws-panel').forEach((el) => {
    const p = el as HTMLElement;
    const sec = p.dataset.section || '';
    const side = on ? (sec === secL ? 'l' : sec === secR ? 'r' : '') : '';
    // Unsplit restores selectSection's own rule: exactly the current section.
    p.hidden = on ? !side : sec !== currentSection;
    p.classList.toggle('is-pane', !!side);
    p.classList.toggle('is-pane-focus', !!side && sec === currentSection);
    p.style.order = side === 'l' ? '1' : side === 'r' ? '3' : '';
    p.style.flex = side && sp ? `${side === 'l' ? sp.ratio : 1 - sp.ratio} 1 0` : '';
  });
  if (on && sp) divider.setAttribute('aria-valuenow', String(Math.round(sp.ratio * 100)));
  if (on !== tabWasSplit) {
    tabWasSplit = on;
    requestAnimationFrame(() => dkNudgeCanvasResize());
  }
}

/** Give a pane focus without selectSection (see the header). */
function tabFocusPane(key: string): void {
  const sec = tabSectionOf(key);
  if (!sec) return;
  if (currentSection !== sec) {
    currentSection = sec;
    const body = tabHubBody();
    if (body) body.dataset.section = sec;
    wsMarkNav(sec);
    dkSync(); // the dock now answers about this pane's record
  }
  tabSet(tabActivate(tabState, key));
}

function tabRefuseSplit(a: TabRec, b: TabRec): void {
  const la = (tabKindOf(a)?.label || 'record').toLowerCase();
  const lb = (tabKindOf(b)?.label || 'record').toLowerCase();
  const what = la === lb ? t('tabSplit.two_s', { la }) : t('tabSplit.a_and_a', { la, lb });
  showToast(t('tabSplit.share_one_page_so_they_can', { what }));
}

/**
 * Show `left` and `right` side by side with `focus` focused. The unfocused side
 * opens first, so the focused one is opened last and ends up as the current
 * section. Callers run it inside tabDrive().
 */
async function tabShowSplit(left: string, right: string, focus: string, ratio = 0.5): Promise<void> {
  const L = tabFind(left);
  const R = tabFind(right);
  if (!L || !R || left === right) return;
  if (!tabFits(L, R)) { tabRefuseSplit(L, R); return; }
  const other = focus === left ? right : left;
  tabSet({ ...tabState, active: other, split: null });
  if (!(await tabShow(other))) return;
  tabSet({ ...tabState, active: focus, split: { left, right, ratio: tabClampRatio(ratio) } });
  await tabShow(focus);
}

/** ⌘\ — split with the next tab that can sit beside this one, or unsplit. */
async function tabSplitCommand(): Promise<void> {
  const s = tabState;
  if (s.split) {
    tabSet(tabSplitToggle(s));
    tabSyncNow();
    return;
  }
  if (!s.active) return;
  const partner = tabSplitPartner(s, tabFits);
  if (!partner) {
    showToast(t('tabSplit.open_a_record_from_another_page'));
    return;
  }
  const active = s.active;
  await tabDrive(() => tabShowSplit(active, partner, partner));
}

/** A tab dropped on the right edge: it becomes the right pane. */
async function tabSplitWith(key: string): Promise<void> {
  const s = tabState;
  const left = s.active && s.active !== key ? s.active : tabSplitPartner({ ...s, active: key }, tabFits);
  const R = tabFind(key);
  if (!left || !R) {
    showToast(t('tabSplit.open_a_record_from_another_page_2'));
    return;
  }
  await tabDrive(() => tabShowSplit(left, key, key, s.split ? s.split.ratio : 0.5));
}

// ── The divider ──────────────────────────────────────────────────────────────

function tabSetRatio(ratio: number, save: boolean): void {
  tabState = tabSplitSetRatio(tabState, ratio);
  if (save) tabSet(tabState);
  else tabApplySplit();
}

function tabDivider(body: HTMLElement): HTMLElement {
  const existing = document.getElementById('tab-divider');
  if (existing) return existing;
  const d = document.createElement('div');
  d.id = 'tab-divider';
  d.className = 'tab-divider';
  d.hidden = true;
  d.tabIndex = 0;
  d.title = t('tabSplit.drag_to_resize_double_click_to');
  d.setAttribute('role', 'separator');
  d.setAttribute('aria-orientation', 'vertical');
  d.setAttribute('aria-label', t('tabSplit.resize_split_view'));
  d.setAttribute('aria-valuemin', String(TAB_RATIO_MIN * 100));
  d.setAttribute('aria-valuemax', String(TAB_RATIO_MAX * 100));

  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    document.body.classList.add('tab-resizing');
    const move = (ev: PointerEvent): void => {
      const panes = Array.from(body.querySelectorAll('.ws-panel.is-pane')) as HTMLElement[];
      if (panes.length !== 2) return;
      const rects = panes.map((p) => p.getBoundingClientRect());
      const left = Math.min(rects[0].left, rects[1].left);
      const right = Math.max(rects[0].right, rects[1].right);
      if (right - left > 0) tabSetRatio((ev.clientX - left) / (right - left), false);
    };
    const end = (): void => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', end);
      d.removeEventListener('pointercancel', end);
      document.body.classList.remove('tab-resizing');
      tabSetRatio(tabState.split ? tabState.split.ratio : 0.5, true);
      dkNudgeCanvasResize();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
  });
  d.addEventListener('dblclick', () => { tabSetRatio(0.5, true); dkNudgeCanvasResize(); });
  // Keyboard-complete: ←/→ by 5%, Home/End to the limits.
  d.addEventListener('keydown', (e) => {
    const r = tabState.split ? tabState.split.ratio : 0.5;
    const next = e.key === 'ArrowLeft' ? r - 0.05 : e.key === 'ArrowRight' ? r + 0.05
      : e.key === 'Home' ? TAB_RATIO_MIN : e.key === 'End' ? TAB_RATIO_MAX : NaN;
    if (Number.isNaN(next)) return;
    e.preventDefault();
    tabSetRatio(next, true);
    dkNudgeCanvasResize();
  });
  body.appendChild(d);
  return d;
}

// ── Drag a tab to the right edge ─────────────────────────────────────────────

/** While a tab is dragged, the right third of the content is a drop target. */
function tabDropTrack(e: DragEvent): void {
  const body = tabHubBody();
  if (!body || !tabDragKey) return;
  const r = body.getBoundingClientRect();
  const w = Math.max(180, Math.round(r.width * 0.3));
  const inside = e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.right - w && e.clientX <= r.right;
  if (!inside) { if (tabDropEl && e.target !== tabDropEl) tabDropHide(); return; }
  if (tabDropEl) return;
  const el = document.createElement('div');
  el.className = 'tab-drop';
  el.appendChild(icon('columns', 16));
  const label = document.createElement('span');
  label.textContent = t('tabSplit.drop_to_open_side_by_side');
  el.appendChild(label);
  el.style.top = r.top + 8 + 'px';
  el.style.left = r.right - w + 'px';
  el.style.width = w - 8 + 'px';
  el.style.height = r.height - 16 + 'px';
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    el.classList.add('is-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const key = tabDragKey;
    tabDropHide();
    if (key) void tabRun(() => tabSplitWith(key));
  });
  document.body.appendChild(el);
  tabDropEl = el;
}

function tabDropHide(): void {
  if (tabDropEl) tabDropEl.remove();
  tabDropEl = null;
}

function initTabSplit(): void {
  const body = tabHubBody();
  if (!body) return;
  // A pointer (or keyboard focus) landing in the other pane moves focus there.
  const follow = (e: Event): void => {
    const sp = tabState.split;
    if (!sp) return;
    const panel = (e.target as Element | null)?.closest?.('.ws-panel.is-pane') as HTMLElement | null;
    const sec = panel ? panel.dataset.section : '';
    if (!sec || sec === currentSection) return;
    const key = [sp.left, sp.right].find((k) => tabSectionOf(k) === sec);
    if (key) tabFocusPane(key);
  };
  body.addEventListener('pointerdown', follow, true);
  body.addEventListener('focusin', follow);
  document.addEventListener('dragover', tabDropTrack);
}
