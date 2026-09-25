// The Stories tab — the third tab of the Dashboards section, beside Dashboards
// and Reports (reportList.ts owns the strip; rbSelectTab calls stRefreshList).
//
// Lists stories as cards (title, the first line of prose, length, last edit),
// creates one — blank, or drafted by the Assistant — and deletes one. Opening
// a card hands over to storyPage.ts (stOpen); that call is the whole seam.
//
// Classic global-scope script — NO import/export. textContent only.

function stEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function stRefreshList(): Promise<void> {
  const grid = stEl('st-grid');
  const empty = stEl('st-empty');
  if (!grid) return;
  let items: any[] = [];
  try {
    items = currentProjectId ? await window.hub.listStories(currentProjectId) : [];
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  grid.textContent = '';
  items.forEach((s) => grid.appendChild(stCard(s)));
  grid.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  // The empty state carries the same two buttons; one set on screen, not two.
  const bar = document.querySelector('#st-list-wrap .st-list-bar') as HTMLElement | null;
  if (bar) bar.hidden = items.length === 0;
}

function stCard(s: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'st-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.storyId = String(s.id);
  // Record identity for the rest of the hub (⌘-click to a tab, catalog chips).
  card.dataset.recKind = 'story';
  card.dataset.recId = String(s.id);

  const page = document.createElement('div');
  page.className = 'st-card-page';
  page.setAttribute('aria-hidden', 'true');
  ['st-card-line st-card-line--h', 'st-card-line', 'st-card-line', 'st-card-line st-card-line--short'].forEach((cls) => {
    const l = document.createElement('span');
    l.className = cls;
    page.appendChild(l);
  });
  card.appendChild(page);

  const body = document.createElement('div');
  body.className = 'st-card-body';
  const title = document.createElement('div');
  title.className = 'st-card-title';
  title.textContent = String(s.name || 'Untitled story');
  body.appendChild(title);
  const ex = document.createElement('div');
  ex.className = 'st-card-excerpt';
  ex.textContent = s.excerpt ? String(s.excerpt) : 'No prose yet.';
  body.appendChild(ex);
  const meta = document.createElement('div');
  meta.className = 'st-card-meta';
  const n = Number(s.blockCount) || 0;
  meta.textContent = `${n} block${n === 1 ? '' : 's'} · ${formatSidebarTime(s.updatedAt)}`;
  body.appendChild(meta);
  card.appendChild(body);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn st-card-more';
  iconOnly(more, 'more-horizontal', 'Story actions');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      const add = (label: string, run: () => void): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item';
        b.textContent = label;
        b.addEventListener('click', () => { close(); run(); });
        menu.appendChild(b);
      };
      add('Open', () => { void stOpen(String(s.id)); });
      add('Rename', () => { void stRenameFromList(s); });
      add('Delete', () => { void stDeleteFromList(s); });
    });
  });
  card.appendChild(more);

  const open = (): void => { void stOpen(String(s.id)); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return card;
}

async function stNewStory(): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Name the story', 'Untitled story', 'Create');
  if (name === null) return;
  let s: any = null;
  try {
    s = await window.hub.createStory(currentProjectId, { name: name.trim() || 'Untitled story' });
  } catch (_) {
    s = null;
  }
  if (!s || s.ok === false || !s.id) { showToast('Could not create the story.'); return; }
  await stOpen(String(s.id), { focusEnd: true });
}

async function stRenameFromList(s: any): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename story', String(s.name || ''), 'Rename');
  if (!name || !name.trim()) return;
  await window.hub.updateStory(currentProjectId, String(s.id), { name: name.trim() });
  void stRefreshList();
}

async function stDeleteFromList(s: any): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(`Delete “${s.name}”? The charts and metrics it shows are not deleted.`)) return;
  await window.hub.deleteStory(currentProjectId, String(s.id));
  void stRefreshList();
}

/** "Draft with the Assistant" from the list: ask what it is about, then the same proposal the dock's story action shows. */
async function stDraftFromList(): Promise<void> {
  const intent = await promptModal('What should the story be about?', '', 'Draft');
  if (!intent || !intent.trim()) return;
  dkSetOpen(true);
  await dkRefresh();
  await stProposeStory(intent.trim(), '');
}

/**
 * The Dashboards section re-shows its list on every visit (refreshAnalysisList →
 * anShowList un-hides the dashboards table), which on the Reports or Stories tab
 * put a second list under the one the strip says is showing. Watching the two
 * dashboard-list elements keeps whatever tab is selected the only one on screen.
 */
function stGuardTabs(): void {
  const guard = (el: HTMLElement | null): void => {
    if (!el) return;
    new MutationObserver(() => {
      if (!el.hidden && rbCurrentTab !== 'dashboards') el.hidden = true;
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  };
  guard(stEl('an-table'));
  guard(stEl('an-list-empty'));
}

function initStoryList(): void {
  const tab = stEl('rp-tab-stories');
  if (tab) tab.addEventListener('click', () => rbSelectTab('stories'));
  ['st-new-btn', 'st-empty-new'].forEach((id) => {
    const b = stEl(id);
    if (b) b.addEventListener('click', () => { void stNewStory(); });
  });
  ['st-draft-btn', 'st-empty-draft'].forEach((id) => {
    const b = stEl(id);
    if (b) b.addEventListener('click', () => { void stDraftFromList(); });
  });
  stGuardTabs();
}
