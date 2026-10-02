'use strict';

// Tabs — the STRIP: one row under the top bar holding a tab per open record
// (icon, name, dirty dot, ×), and everything the pointer and the keyboard can
// do to it. Painted from tabState by tabRender(); it holds no state of its own
// beyond the drag in flight. Also here: ⌘-click on a list row, which opens that
// record as a background tab.
//
//   click          switch            middle-click / ×   close
//   drag           reorder           drag to right edge split (tabSplit.ts)
//   right-click    Close · Close others · Split right · Open in new window
//   ←/→ Home/End   move between tabs, Enter/Space switch, ⇧F10 the menu
//
// Classic global-scope renderer <script>: NO import/export.

let tabDragKey: string | null = null;
let tabFlashKey: string | null = null;

function tabStripEl(): HTMLElement | null {
  return document.getElementById('tab-strip');
}

function tabDisplayName(tv: TabRec): string {
  const k = tabKindOf(tv);
  return tv.name || (k ? t('tabStrip.untitled', { p0: k.label.toLowerCase() }) : t('common.untitled'));
}

function tabDirty(t: TabRec | null): boolean {
  const k = tabKindOf(t);
  return !!k && tabIsOpen(t) && k.isDirty();
}

/** Mark a freshly added background tab so it animates in once. */
function tabFlash(key: string): void {
  tabFlashKey = key;
  tabRender();
  window.setTimeout(() => { if (tabFlashKey === key) tabFlashKey = null; }, 400);
}

function tabMakeItem(tv: TabRec, i: number): HTMLElement {
  const s = tabState;
  const key = tabKeyOf(tv);
  const k = tabKindOf(tv);
  const name = tabDisplayName(tv);
  const active = s.active === key;
  const el = document.createElement('div');
  el.className = 'tab-item';
  el.classList.toggle('is-active', active);
  el.classList.toggle('is-split', !!s.split && (s.split.left === key || s.split.right === key));
  el.classList.toggle('is-dirty', tabDirty(tv));
  el.classList.toggle('is-new', key === tabFlashKey);
  el.dataset.key = key;
  el.dataset.index = String(i);
  el.setAttribute('role', 'tab');
  el.setAttribute('aria-selected', String(active));
  el.draggable = true;
  el.tabIndex = -1;
  el.title = k ? `${name} — ${k.label}` : name;
  el.appendChild(icon(k ? k.icon : 'file-text', 16));
  const label = document.createElement('span');
  label.className = 'tab-name';
  label.textContent = name;
  el.appendChild(label);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.tabIndex = -1;
  close.setAttribute('aria-label', t('tabStrip.close', { name }));
  close.title = active ? tooltipFor('tab.close', t('common.close')) : t('common.close');
  close.appendChild(icon('x', 16));
  const dot = document.createElement('span');
  dot.className = 'tab-dirty';
  dot.setAttribute('aria-hidden', 'true');
  close.appendChild(dot);
  el.appendChild(close);
  return el;
}

function tabRender(): void {
  const strip = tabStripEl();
  if (!strip) return;
  const s = tabState;
  const show = s.tabs.length > 0;
  strip.hidden = !show;
  document.body.classList.toggle('has-tabs', show);
  // Keyboard focus survives a repaint: note which tab had it.
  const had = strip.contains(document.activeElement)
    ? ((document.activeElement as HTMLElement).closest('.tab-item') as HTMLElement | null)?.dataset.key
    : null;
  strip.textContent = '';
  s.tabs.forEach((t, i) => strip.appendChild(tabMakeItem(t, i)));
  // Roving tabindex: ONE tab stop for the whole strip — the active tab, else the first.
  const items = Array.from(strip.querySelectorAll('.tab-item')) as HTMLElement[];
  const stop = items.find((el) => el.dataset.key === (had || s.active)) || items[0];
  if (stop) stop.tabIndex = 0;
  if (had && stop) stop.focus();
  const on = strip.querySelector('.tab-item.is-active') as HTMLElement | null;
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Repaint the dirty dots and pick up renames on the open record(s). */
function tabRefreshLive(): void {
  const strip = tabStripEl();
  if (!strip || strip.hidden || document.visibilityState !== 'visible') return;
  const s = tabState;
  let next = s;
  for (const key of [s.active, s.split ? s.split.left : null, s.split ? s.split.right : null]) {
    const t = tabFind(key);
    const k = tabKindOf(t);
    const cur = k ? k.current() : null;
    if (t && cur && cur.id === t.id && cur.name && cur.name !== t.name) next = tabOpen(next, { ...t, name: cur.name }, true);
  }
  if (next !== s) { tabSet(next); return; }
  strip.querySelectorAll('.tab-item').forEach((el) => {
    const it = el as HTMLElement;
    it.classList.toggle('is-dirty', tabDirty(tabFind(it.dataset.key || null)));
  });
}

// ── The tab menu ─────────────────────────────────────────────────────────────

function tabOpenMenu(el: HTMLElement): void {
  const key = el.dataset.key || '';
  if (!tabFind(key)) return;
  const s = tabState;
  const inSplit = !!s.split && (s.split.left === key || s.split.right === key);
  openMiniMenu(el, (menu: HTMLElement, close: () => void) => {
    menu.classList.add('tab-menu');
    menu.setAttribute('aria-label', 'Tab');
    const row = (label: string, ic: string, fn: () => Promise<void>, keys?: string, disabled?: boolean): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-menu-item';
      b.setAttribute('role', 'menuitem');
      b.disabled = !!disabled;
      b.appendChild(icon(ic, 16));
      b.appendChild(document.createTextNode(label));
      if (keys) {
        const k = document.createElement('span');
        k.className = 'menu-shortcut';
        k.textContent = keyLabel(keys);
        b.appendChild(k);
      }
      b.addEventListener('click', () => { close(); void tabRun(fn); });
      menu.appendChild(b);
    };
    const sep = (): void => {
      const d = document.createElement('div');
      d.className = 'chart-menu-sep';
      menu.appendChild(d);
    };
    const mine = s.active === key;
    row(t('common.close'), 'x', () => tabCloseKey(key).then(() => undefined), mine ? 'mod+w' : undefined);
    row(t('tabStrip.close_others'), 'minus', () => tabCloseOthersKey(key), undefined, s.tabs.length < 2);
    sep();
    if (inSplit) row(t('tabStrip.close_split_view'), 'columns', () => tabSplitCommand(), 'mod+\\');
    else row(t('tabStrip.split_right'), 'columns', () => tabSplitWith(key), mine ? 'mod+\\' : undefined, s.tabs.length < 2);
    row(t('tabStrip.open_in_new_window'), 'external-link', () => tabToNewWindow(key));
    // ↑/↓ walk the rows; Escape is openMiniMenu's own.
    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const rows = Array.from(menu.querySelectorAll('button:not([disabled])')) as HTMLElement[];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const n = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
      if (n) n.focus();
    });
  }, () => { if (document.body.contains(el)) el.focus(); });
  const first = document.querySelector('.tab-menu button:not([disabled])') as HTMLElement | null;
  if (first) first.focus();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function tabItemOf(e: Event): HTMLElement | null {
  return ((e.target as Element | null)?.closest?.('.tab-item') as HTMLElement | null) || null;
}

function tabClearDropMarks(strip: HTMLElement): void {
  strip.querySelectorAll('.drop-before, .drop-after, .is-dragging').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after', 'is-dragging');
  });
}

function initTabStrip(): void {
  const strip = tabStripEl();
  if (strip) {
    strip.addEventListener('click', (e) => {
      const item = tabItemOf(e);
      const key = item && item.dataset.key;
      if (!key) return;
      if ((e.target as Element).closest('.tab-close')) void tabRun(() => tabCloseKey(key).then(() => undefined));
      else void tabRun(() => tabSwitchTo(key));
    });
    // Middle-click closes. mousedown is claimed too, or it starts autoscroll.
    strip.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    strip.addEventListener('auxclick', (e) => {
      const key = e.button === 1 ? tabItemOf(e)?.dataset.key : null;
      if (!key) return;
      e.preventDefault();
      void tabRun(() => tabCloseKey(key).then(() => undefined));
    });
    strip.addEventListener('contextmenu', (e) => {
      const item = tabItemOf(e);
      if (!item) return;
      e.preventDefault();
      tabOpenMenu(item);
    });
    strip.addEventListener('keydown', (e) => {
      const item = tabItemOf(e);
      if (!item) return;
      const items = Array.from(strip.querySelectorAll('.tab-item')) as HTMLElement[];
      const i = items.indexOf(item);
      let to = -1;
      if (e.key === 'ArrowRight') to = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft') to = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = items.length - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const key = item.dataset.key;
        if (key) void tabRun(() => tabSwitchTo(key));
        return;
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        tabOpenMenu(item);
        return;
      }
      if (to < 0) return;
      e.preventDefault();
      items.forEach((el, j) => { el.tabIndex = j === to ? 0 : -1; });
      items[to].focus();
    });

    // Reorder by drag. The insertion mark is drawn on the tab under the
    // pointer, before or after it by which half the pointer is in.
    strip.addEventListener('dragstart', (e) => {
      const item = tabItemOf(e);
      if (!item || !e.dataTransfer) return;
      tabDragKey = item.dataset.key || null;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabDisplayName(tabFind(tabDragKey) as TabRec));
      item.classList.add('is-dragging');
    });
    strip.addEventListener('dragover', (e) => {
      const item = tabItemOf(e);
      if (!tabDragKey || !item) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const r = item.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      strip.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
      if (item.dataset.key !== tabDragKey) item.classList.add(after ? 'drop-after' : 'drop-before');
    });
    strip.addEventListener('drop', (e) => {
      const item = tabItemOf(e);
      if (!tabDragKey || !item) return;
      e.preventDefault();
      const from = tabIndexOf(tabState, tabDragKey);
      const over = Number(item.dataset.index);
      const r = item.getBoundingClientRect();
      let to = e.clientX > r.left + r.width / 2 ? over + 1 : over;
      if (from < to) to -= 1; // the dragged tab leaves a gap behind it
      tabClearDropMarks(strip);
      if (from >= 0) tabSet(tabMove(tabState, from, to));
    });
    strip.addEventListener('dragend', () => {
      tabDragKey = null;
      tabClearDropMarks(strip);
      tabDropHide();
    });
  }

  // ⌘-click (Ctrl-click) on any list row that names a record opens it as a
  // background tab. ONE capture-phase listener reading the data-rec-kind /
  // data-rec-id each list builder stamps on its row, so the rows' own click
  // handlers never see the modified click.
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || !(CMD_IS_MAC ? e.metaKey : e.ctrlKey)) return;
    const row = (e.target as Element | null)?.closest?.('[data-rec-kind][data-rec-id]') as HTMLElement | null;
    const kind = row ? row.dataset.recKind || '' : '';
    if (!row || !TAB_KINDS[kind] || !currentProjectId) return;
    // Tabs are per project: a Home row from ANOTHER project opens normally.
    if (row.dataset.recProject && row.dataset.recProject !== currentProjectId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void tabOpenBackground(kind, row.dataset.recId || '');
  }, true);

  // ponytail: a 1 Hz look at the open record's dirty flag and name, rather
  // than a hook in each kind's setters — one line per new kind instead of
  // one per setter. Hook the setters if it ever shows up in a profile.
  window.setInterval(tabRefreshLive, 1000);
}
