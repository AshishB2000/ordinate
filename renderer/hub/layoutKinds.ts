'use strict';

// The LAYOUT card kinds — Image, Divider, Container, Tabs — and the pass after
// every grid render that makes groups behave as groups. Classic global-scope
// renderer <script>; the model and geometry are renderer/hub/cardModel.ts.
//
// A group is drawn BEHIND its children: it is a card like any other, filling
// its rect, and its children are cards on the same grid whose rects sit inside
// it. Which tab is showing and which containers are folded are VIEW state —
// kept here, never saved, never undone.

const groupTab = new Map<string, string>();
const groupFolded = new Set<string>();

// ── Image ────────────────────────────────────────────────────────────────────

function renderImageCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  const img = card.image || {};
  const box = document.createElement('div');
  box.className = 'img-card img-card--' + (img.fit || 'contain');
  body.appendChild(box);
  if (!currentProjectId) return;
  void window.hubAuthoring.readProjectImage(currentProjectId, img.assetId, img.ext).then((res: any) => {
    if (!res || !res.ok) {
      box.textContent = 'This image is missing from the project.';
      box.classList.add('is-missing');
      return;
    }
    const el = document.createElement('img');
    el.src = res.dataUrl;
    el.alt = img.alt || '';
    if (!img.alt) el.setAttribute('role', 'presentation');
    box.appendChild(el);
  });
}

async function handleAddImage(): Promise<void> {
  if (!currentProjectId) return;
  const res = await window.hubAuthoring.pickProjectImage(currentProjectId);
  if (!res || !res.ok) {
    if (res && res.error) showToast(res.error, { kind: 'error' });
    return;
  }
  const a = res.asset;
  const card: any = {
    id: dashUuid(), type: 'image',
    layout: { ...dashFindSlot(dashCards(), 4, 4), w: 4, h: 4 },
    image: { assetId: a.id, ext: a.ext, fit: 'contain', alt: '', lockAspect: true, aspect: a.aspect },
  };
  pushCard(card);
  imgLockAspect(card);
  void anSelectCard(card.id);
}

/** Height from width, for an image whose aspect is locked. */
function imgLockAspect(card: any): void {
  const img = card.image;
  const grid = document.getElementById('dash-grid');
  if (!img || !img.lockAspect || !img.aspect || !grid) return;
  const pitch = anColPitch(grid);
  const widthPx = card.layout.w * pitch - dashGapPx();
  const rows = Math.max(1, Math.round((widthPx / img.aspect + dashGapPx()) / (dashRowPx() + dashGapPx())));
  if (rows !== card.layout.h) {
    card.layout.h = rows;
    reapplyCardStyle(card);
  }
}

function renderImageProps(card: any, host: HTMLElement): void {
  const live = (): any => dashCardAnywhere(card.id) || card;
  const set = (patch: any, label: string): void => {
    live().image = Object.assign({}, live().image, patch);
    if (patch.lockAspect) imgLockAspect(live());
    markDashDirty(label, true);
    renderDashGrid();
    anPaintSelection();
  };
  host.appendChild(aeInput('Alt text', live().image.alt || '', 'Describe the image', 'What a screen reader says. Leave empty only for decoration.', (v) => set({ alt: v }, 'Edit alt text')));
  host.appendChild(aeSelect('Fit', [['contain', 'Fit inside'], ['cover', 'Fill and crop'], ['fill', 'Stretch']], live().image.fit, (v) => set({ fit: v }, 'Change image fit')));
  const lock = document.createElement('label');
  lock.className = 'an-prop-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = live().image.lockAspect !== false;
  cb.disabled = !live().image.aspect;
  cb.addEventListener('change', () => set({ lockAspect: cb.checked }, 'Lock aspect'));
  const t = document.createElement('span');
  t.textContent = 'Lock aspect ratio';
  lock.append(cb, t);
  host.appendChild(lock);
}

// ── Divider ──────────────────────────────────────────────────────────────────

function renderDividerCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  if (card.divider && card.divider.style === 'spacer') return;
  const hr = document.createElement('hr');
  hr.className = 'divider-line';
  body.appendChild(hr);
}

function handleAddDivider(): void {
  pushCard({ id: dashUuid(), type: 'divider', layout: { ...dashFindSlot(dashCards(), 12, 1), w: 12, h: 1 }, divider: { style: 'line' } });
}

function renderDividerProps(card: any, host: HTMLElement): void {
  const live = (): any => dashCardAnywhere(card.id) || card;
  host.appendChild(aeSelect('Style', [['line', 'A line'], ['spacer', 'Empty space']], live().divider.style, (v) => {
    live().divider = { style: v };
    markDashDirty('Change divider', true);
    renderDashGrid();
    anPaintSelection();
  }));
}

// ── Container and Tabs ───────────────────────────────────────────────────────

function groupTitle(card: any): string {
  return card.type === 'container' ? (card.container && card.container.title) || 'Container' : 'Tabs';
}

/** An empty group (or empty tab) says how to fill it rather than showing a blank box. */
function groupEmptyHint(card: any, body: HTMLElement, tabId?: string): void {
  const kids = cardModel.childrenOf(dashCards(), card.id).filter((c: any) => !tabId || c.tabId === tabId);
  if (kids.length) return;
  const p = document.createElement('p');
  p.className = 'grp-empty';
  p.textContent = tabId ? 'Drag cards into this tab.' : 'Drag cards in here — they move with it.';
  body.appendChild(p);
}

function renderContainerCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  const el = body.closest('.dash-card') as HTMLElement | null;
  if (!el) return;
  const c = card.container || {};
  el.classList.add('grp-bg--' + (c.background || 'subtle'));
  groupEmptyHint(card, body);
  if (c.collapsible) {
    const head = el.querySelector('.dash-card-head') as HTMLElement | null;
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'grp-fold';
    const folded = groupFolded.has(card.id);
    fold.setAttribute('aria-expanded', String(!folded));
    iconOnly(fold, folded ? 'chevron-right' : 'chevron-down', (folded ? 'Expand ' : 'Collapse ') + groupTitle(card));
    fold.addEventListener('pointerdown', (e) => e.stopPropagation());
    fold.addEventListener('click', (e) => {
      e.stopPropagation();
      if (groupFolded.has(card.id)) groupFolded.delete(card.id); else groupFolded.add(card.id);
      renderDashGrid();
    });
    if (head) head.insertBefore(fold, head.firstChild);
  }
}

function renderTabsCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  const el = body.closest('.dash-card') as HTMLElement | null;
  const head = el && (el.querySelector('.dash-card-head') as HTMLElement | null);
  if (!el || !head) return;
  const items: any[] = (card.tabs && card.tabs.items) || [];
  const active = cardModel.activeTab(card, groupTab.get(card.id));
  const list = document.createElement('div');
  list.className = 'grp-tabs';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Tabs');
  items.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'grp-tab';
    b.id = 'grp-tab-' + t.id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.id === active));
    b.tabIndex = t.id === active ? 0 : -1;
    b.dataset.tabId = t.id;
    b.textContent = t.name;
    b.addEventListener('pointerdown', (e) => e.stopPropagation()); // a tab click is not a drag
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      groupTab.set(card.id, t.id);
      renderDashGrid();
      requestAnimationFrame(() => (document.getElementById('grp-tab-' + t.id) as HTMLElement | null)?.focus());
    });
    b.addEventListener('keydown', (e) => {
      const i = items.findIndex((x) => x.id === t.id);
      const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      (list.querySelectorAll('.grp-tab')[(next + items.length) % items.length] as HTMLElement).click();
    });
    list.appendChild(b);
  });
  const title = head.querySelector('.dash-card-title');
  if (title) title.replaceWith(list);
  else head.insertBefore(list, head.firstChild);
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', 'grp-tab-' + active);
  groupEmptyHint(card, body, active);
}

/** New group: around the multi-selection when there is one, else empty at a free slot. */
function handleAddGroup(kind: 'container' | 'tabs'): void {
  const page = dashCurrentPage();
  if (!page) return;
  const g: any = { id: dashUuid(), type: kind, layout: { x: 0, y: 0, w: 12, h: 5 } };
  if (kind === 'container') g.container = { title: 'Container', background: 'subtle', padding: 'md', collapsible: true };
  else g.tabs = { items: [{ id: dashUuid(), name: 'Tab 1' }, { id: dashUuid(), name: 'Tab 2' }] };
  const picked = [...anMulti].filter((id) => page.cards.some((c: any) => c.id === id));
  if (picked.length) cardModel.wrapGroup(page.cards, picked, g);
  else g.layout = { ...dashFindSlot(page.cards, kind === 'tabs' ? 12 : 6, 5), w: kind === 'tabs' ? 12 : 6, h: 5 };
  // A group sits BEFORE its children in the list, so it draws beneath them.
  const first = page.cards.findIndex((c: any) => picked.includes(c.id));
  page.cards.splice(first >= 0 ? first : page.cards.length, 0, g);
  anMultiClear();
  markDashDirty('Add ' + kind);
  renderDashGrid();
  void anSelectCard(g.id);
}

function renderGroupProps(card: any, host: HTMLElement): void {
  const live = (): any => dashCardAnywhere(card.id) || card;
  const redraw = (label: string): void => {
    markDashDirty(label, true);
    renderDashGrid();
    anPaintSelection();
  };
  if (card.type === 'container') {
    const c = (): any => live().container;
    host.appendChild(aeInput('Title', c().title || '', 'Container', '', (v) => { c().title = v; redraw('Rename container'); }));
    host.appendChild(aeSelect('Background', [['subtle', 'Subtle'], ['surface', 'Card'], ['accent', 'Accent tint'], ['none', 'None']], c().background, (v) => { c().background = v; redraw('Container background'); }));
    host.appendChild(aeSelect('Padding', [['none', 'None'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], c().padding, (v) => { c().padding = v; redraw('Container padding'); }));
    const l = document.createElement('label');
    l.className = 'an-prop-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!c().collapsible;
    cb.addEventListener('change', () => { c().collapsible = cb.checked; redraw('Container collapsible'); });
    const s = document.createElement('span');
    s.textContent = 'Readers can collapse it';
    l.append(cb, s);
    host.appendChild(l);
  } else {
    const items = (): any[] => live().tabs.items;
    items().forEach((t: any, i: number) => {
      const row = document.createElement('div');
      row.className = 'ae-row-head';
      row.appendChild(aeInput(`Tab ${i + 1}`, t.name, `Tab ${i + 1}`, '', (v) => { items()[i].name = v.trim() || `Tab ${i + 1}`; redraw('Rename tab'); }));
      if (items().length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-sm ae-del';
        iconOnly(del, 'trash', `Remove tab ${t.name}`);
        del.addEventListener('click', () => {
          const page = dashCurrentPage();
          cardModel.removeTab(page ? page.cards : [], live(), t.id);
          redraw('Remove tab');
          renderKindProps(live());
        });
        row.appendChild(del);
      }
      host.appendChild(row);
    });
    if (items().length < 8) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn btn-sm ae-add';
      add.appendChild(icon('plus'));
      add.append('Add tab');
      add.addEventListener('click', () => {
        items().push({ id: dashUuid(), name: `Tab ${items().length + 1}` });
        redraw('Add tab');
        renderKindProps(live());
      });
      host.appendChild(add);
    }
  }
  const p = document.createElement('p');
  p.className = 'an-prop-note an-prop-note--info';
  p.textContent = 'Drag a card inside to add it; drag it out to take it out. Moving the group moves everything in it.';
  host.appendChild(p);
}

// ── After every grid render ─────────────────────────────────────────────────

/**
 * Layer groups under their children, show only the active tab's cards, fold
 * collapsed containers (and close the gap a full-width fold leaves), and pad
 * children the way their container asks. Display only: the record is untouched.
 */
function authoringAfterGrid(): void {
  const page = dashCurrentPage();
  const grid = document.getElementById('dash-grid');
  if (!page || !grid) return;
  const cards: any[] = page.cards || [];
  const elOf = (id: string): HTMLElement | null => grid.querySelector(`.dash-card[data-card-id="${id}"]`) as HTMLElement | null;
  // Full-width folds close their gap: every card below one moves up by the rows it gave back.
  const folds: Array<{ bottom: number; rows: number }> = [];
  for (const g of cards.filter((c) => c && cardModel.GROUP_TYPES.includes(c.type))) {
    const gel = elOf(g.id);
    if (!gel) continue;
    gel.classList.add('is-group');
    const pad = g.type === 'container' ? (g.container && g.container.padding) || 'md' : 'md';
    const folded = g.type === 'container' && g.container && g.container.collapsible && groupFolded.has(g.id);
    const tab = g.type === 'tabs' ? cardModel.activeTab(g, groupTab.get(g.id)) : '';
    for (const c of cardModel.childrenOf(cards, g.id)) {
      const cel = elOf(c.id);
      if (!cel) continue;
      cel.classList.add('in-group', 'in-pad--' + pad);
      cel.dataset.parentId = g.id;
      cel.hidden = folded || (g.type === 'tabs' && c.tabId !== tab);
    }
    if (folded) {
      gel.classList.add('is-folded');
      if (g.layout.x === 0 && g.layout.w === 12) folds.push({ bottom: g.layout.y + g.layout.h, rows: g.layout.h - 1 });
    }
  }
  for (const c of cards) {
    const el = c && c.layout ? elOf(c.id) : null;
    if (!el) continue;
    const lift = folds.reduce((s, f) => s + (c.layout.y >= f.bottom ? f.rows : 0), 0);
    const span = el.classList.contains('is-folded') ? 1 : c.layout.h;
    if (lift || span !== c.layout.h) el.style.gridRow = (c.layout.y + 1 - lift) + ' / span ' + span;
  }
  anPaintMulti();
}
