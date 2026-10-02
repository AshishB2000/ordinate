'use strict';

// The Data page's NOTEBOOKS tab — the list, and the switch between it and an
// open notebook (nbPage.ts). Classic global-scope renderer <script>: no
// import/export. textContent only.
//
// The tab and its panel are BUILT here, beside Query, rather than spelled in
// index.html — the arrangement relationshipsPage.ts uses — and the switch is
// handled here too: the strip's other tabs belong to captureList.ts, which
// hides only the panels it knows. A click on any of them bubbles to the strip,
// and any of them becoming selected (a click or a `clSelectTab` call) stands
// this panel down.
//
// The list is the Stories card grid (`.st-card*` — a notebook is a document
// too), with a preview strip drawn from the notebook's own cell kinds.

const NB_SUB = t('nbList.sql_formulas_charts_and_notes_in');
let nbListSeq = 0;

function nbEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function nbKindIcon(kind: string): string {
  return kind === 'sql' ? 'code' : kind === 'formula' ? 'function' : kind === 'chart' ? 'chart-bar'
    : kind === 'param' ? 'sliders' : 'type-text';
}

function nbKindLabel(kind: string): string {
  return kind === 'sql' ? 'SQL' : kind === 'formula' ? t('common.formula') : kind === 'chart' ? 'Chart'
    : kind === 'param' ? t('common.parameter') : t('common.text');
}

/** The empty state's picture: a small page of three cells — a query, its result, a chart. */
function nbEmptyArt(): HTMLElement {
  const art = document.createElement('div');
  art.className = 'nb-empty-art';
  art.setAttribute('aria-hidden', 'true');
  for (const k of ['sql', 'table', 'chart']) {
    const cell = document.createElement('span');
    cell.className = 'nb-empty-cell nb-empty-cell--' + k;
    const n = k === 'chart' ? 6 : k === 'table' ? 3 : 2;
    for (let i = 0; i < n; i += 1) cell.appendChild(document.createElement('i'));
    art.appendChild(cell);
  }
  return art;
}

// ── The tab ──────────────────────────────────────────────────────────────────

function nbShowTab(on: boolean): void {
  const tab = nbEl('ds-tab-notebooks');
  const panel = nbEl('nb-wrap');
  if (!tab || !panel) return;
  tab.setAttribute('aria-selected', String(on));
  tab.tabIndex = on ? 0 : -1;
  panel.hidden = !on;
  if (!on) return;
  const strip = tab.parentElement as HTMLElement;
  strip.querySelectorAll('[role="tab"]').forEach((t) => {
    if (t === tab) return;
    t.setAttribute('aria-selected', 'false');
    (t as HTMLElement).tabIndex = -1;
    const other = nbEl(t.getAttribute('aria-controls') || '');
    if (other) other.hidden = true;
  });
  const actions = document.querySelector('.ds-head-actions') as HTMLElement | null;
  if (actions) actions.hidden = true;
  const metricActions = nbEl('mp-actions-row');
  if (metricActions) metricActions.hidden = true;
  const sub = nbEl('ds-sub');
  if (sub) sub.textContent = NB_SUB;
  if (!nbDoc || nbDocProject !== currentProjectId) nbShowList();
}

function initNotebooksTab(): void {
  const query = nbEl('ds-tab-query');
  const queryPanel = nbEl('qt-wrap');
  if (!query || !queryPanel || nbEl('ds-tab-notebooks')) return;

  const tab = document.createElement('button');
  tab.className = 'ds-tab';
  tab.type = 'button';
  tab.id = 'ds-tab-notebooks';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', 'nb-wrap');
  tab.tabIndex = -1;
  tab.textContent = t('common.notebooks');
  query.after(tab);

  const panel = document.createElement('div');
  panel.id = 'nb-wrap';
  panel.className = 'nb-wrap';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'ds-tab-notebooks');
  panel.hidden = true;
  queryPanel.after(panel);

  const list = document.createElement('div');
  list.id = 'nb-list-view';
  list.className = 'nb-list-view';
  const bar = document.createElement('div');
  bar.className = 'nb-list-bar';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-primary';
  add.id = 'nb-new';
  iconLabel(add, 'plus', t('nbList.new_notebook'));
  add.addEventListener('click', () => { void nbNew(); });
  const count = document.createElement('span');
  count.className = 'viz-count';
  count.id = 'nb-count';
  bar.append(add, count);
  const grid = document.createElement('div');
  grid.className = 'st-grid nb-grid';
  grid.id = 'nb-grid';
  grid.setAttribute('role', 'list');
  grid.setAttribute('aria-label', t('common.notebooks'));
  const empty = document.createElement('div');
  empty.id = 'nb-empty';
  empty.className = 'nb-empty';
  empty.hidden = true;
  const es = makeEmptyState({
    variant: 'notebooks',
    iconName: 'file-text',
    title: t('nbList.no_notebooks_yet'),
    line: t('nbList.a_notebook_is_one_page_of'),
    actionLabel: t('nbList.new_notebook'),
    onAction: () => { void nbNew(); },
  });
  es.querySelector('.ws-empty-icon')?.replaceWith(nbEmptyArt());
  const facts = document.createElement('ul');
  facts.className = 'nb-empty-facts';
  for (const [ic, text] of [
    ['code', t('nbList.query_a_cell_above_by_its')],
    ['sliders', t('nbList.a_parameter_feeds_every_cell_that')],
    ['refresh', t('nbList.an_edit_marks_every_cell_it')],
  ]) {
    const li = document.createElement('li');
    li.append(icon(ic, 16), Object.assign(document.createElement('span'), { textContent: text }));
    facts.appendChild(li);
  }
  es.querySelector('.ws-empty-p')?.after(facts);
  empty.appendChild(es);
  list.append(bar, grid, empty);

  const page = document.createElement('div');
  page.id = 'nb-page';
  page.className = 'nb-page';
  page.hidden = true;
  panel.append(list, page);

  tab.addEventListener('click', () => nbShowTab(true));
  const strip = query.parentElement as HTMLElement;
  strip.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[role="tab"]');
    if (t && t !== tab) nbShowTab(false);
  });
  // A programmatic switch (clSelectTab from "View query", the composer's
  // close) selects another tab without a click: stand down then too.
  new MutationObserver(() => {
    if (panel.hidden) return;
    const other = [...strip.querySelectorAll('[role="tab"]')].some((t) => t !== tab && t.getAttribute('aria-selected') === 'true');
    if (other) nbShowTab(false);
  }).observe(strip, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
}

// ── The list ─────────────────────────────────────────────────────────────────

/** Back to the list: flush the open notebook first, so nothing typed is lost. */
async function nbShowList(): Promise<void> {
  await nbClose();
  const list = nbEl('nb-list-view');
  const page = nbEl('nb-page');
  if (list) list.hidden = false;
  if (page) page.hidden = true;
  await nbRefreshList();
}

async function nbRefreshList(): Promise<void> {
  const grid = nbEl('nb-grid');
  const empty = nbEl('nb-empty');
  if (!grid || !currentProjectId) return;
  const seq = ++nbListSeq;
  let items: any[] = [];
  try {
    const res = await window.hubNotebooks.list(currentProjectId);
    items = res && res.ok && Array.isArray(res.notebooks) ? res.notebooks : [];
  } catch (_) {
    items = [];
  }
  if (seq !== nbListSeq) return;
  grid.textContent = '';
  items.forEach((n) => grid.appendChild(nbCard(n)));
  grid.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  const bar = document.querySelector('#nb-list-view .nb-list-bar') as HTMLElement | null;
  if (bar) bar.hidden = items.length === 0;
  const count = nbEl('nb-count');
  if (count) count.textContent = items.length === 1 ? t('nbList.1_notebook') : `${items.length} notebooks`;
}

/** "3 SQL · 1 chart · 2 notes" — what a notebook holds, most telling kinds first. */
function nbKindsLine(kinds: Record<string, number>): string {
  const parts: string[] = [];
  const add = (k: string, one: string, many: string): void => {
    const n = Number(kinds && kinds[k]) || 0;
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add('sql', 'query', 'queries');
  add('formula', 'formula', 'formulas');
  add('chart', 'chart', 'charts');
  add('param', 'parameter', 'parameters');
  add('markdown', 'note', 'notes');
  return parts.join(' · ');
}

function nbCard(n: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'st-card nb-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'listitem');
  card.dataset.notebookId = String(n.id);

  // The preview: one stripe per kind it holds, in a fixed order — a code
  // block, a bar row for charts, a line for notes — so two notebooks read
  // differently at a glance.
  const page = document.createElement('div');
  page.className = 'st-card-page nb-card-page';
  page.setAttribute('aria-hidden', 'true');
  for (const k of ['markdown', 'sql', 'formula', 'chart', 'param']) {
    if (!n.kinds || !n.kinds[k]) continue;
    const s = document.createElement('span');
    s.className = 'nb-card-stripe nb-card-stripe--' + k;
    if (k === 'chart') for (let i = 0; i < 5; i += 1) s.appendChild(document.createElement('i'));
    page.appendChild(s);
  }
  card.appendChild(page);

  const body = document.createElement('div');
  body.className = 'st-card-body';
  const title = document.createElement('div');
  title.className = 'st-card-title';
  title.textContent = String(n.name || t('common.untitled_notebook'));
  const ex = document.createElement('div');
  ex.className = 'st-card-excerpt';
  ex.textContent = n.excerpt ? String(n.excerpt) : nbKindsLine(n.kinds) || t('nbList.empty_notebook');
  const meta = document.createElement('div');
  meta.className = 'st-card-meta';
  const c = Number(n.cellCount) || 0;
  meta.textContent = t('nbList.text', { c, p2: n.excerpt && nbKindsLine(n.kinds) ? ' · ' + nbKindsLine(n.kinds) : '', updatedAt: formatSidebarTime(n.updatedAt) });
  body.append(title, ex, meta);
  card.appendChild(body);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn st-card-more';
  iconOnly(more, 'more-horizontal', t('common.notebook_actions'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      const item = (label: string, run: () => void): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item';
        b.textContent = label;
        b.addEventListener('click', () => { close(); run(); });
        menu.appendChild(b);
      };
      item(t('common.open'), () => { void nbOpenById(String(n.id)); });
      item(t('common.rename'), () => { void nbRenameFromList(n); });
      item('Delete', () => { void nbDeleteNotebook(String(n.id), String(n.name || '')); });
    });
  });
  card.appendChild(more);

  const open = (): void => { void nbOpenById(String(n.id)); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  });
  return card;
}

async function nbNew(): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal(t('nbList.name_the_notebook'), t('common.untitled_notebook'), t('common.create'));
  if (name === null) return;
  let res: any = null;
  try {
    res = await window.hubNotebooks.create(currentProjectId, name.trim() || t('common.untitled_notebook'));
  } catch (_) {
    res = null;
  }
  if (!res || !res.ok) { showToast((res && res.error) || t('nbList.could_not_create_the_notebook')); return; }
  nbShowNotebook(res.notebook, res.graph);
  nbFocusCell(res.notebook.cells.length ? res.notebook.cells[res.notebook.cells.length - 1].id : '');
}

async function nbRenameFromList(n: any): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal(t('nbList.rename_notebook'), String(n.name || ''), t('common.rename'));
  if (!name || !name.trim()) return;
  const got = await window.hubNotebooks.get(currentProjectId, String(n.id));
  if (got && got.ok) await window.hubNotebooks.save(currentProjectId, String(n.id), name.trim(), got.notebook.cells);
  void nbRefreshList();
}

async function nbDeleteNotebook(id: string, name: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(t('nbList.delete_datasets_and_visuals_saved_from', { p0: name || t('nbList.this_notebook') }))) return;
  if (nbDoc && nbDoc.id === id) { nbDiscard(); }
  await window.hubNotebooks.remove(currentProjectId, id);
  await nbShowList();
}

/**
 * Open a notebook from anywhere — the list, Lineage, a dataset's "Open
 * notebook" — and optionally scroll to one cell.
 */
async function nbOpenById(id: string, cellId?: string): Promise<void> {
  if (!currentProjectId) return;
  if (typeof selectSection === 'function') selectSection('datasets');
  const close = nbEl('ds-explorer-close') as HTMLButtonElement | null;
  const explorer = nbEl('ds-explorer');
  if (close && explorer && !explorer.hidden) close.click();
  await nbClose();
  nbShowTab(true);
  let res: any = null;
  try {
    res = await window.hubNotebooks.get(currentProjectId, id);
  } catch (_) {
    res = null;
  }
  if (!res || !res.ok) { showToast(t('nbList.that_notebook_could_not_be_opened')); await nbShowList(); return; }
  nbShowNotebook(res.notebook, res.graph);
  if (cellId) nbFocusCell(cellId, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNotebooksTab);
else initNotebooksTab();
