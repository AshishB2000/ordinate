// The project switcher — the popover behind the sidebar's project name (and
// the top bar's project button). Classic global-scope renderer <script>.
//
// Projects used to be demoted to an implicit grouping with a bare list of names
// behind this chevron. It is now the place projects are managed: each row
// says what is in the project and when it was last opened, and its ⋯ carries
// Rename, Export project… and Archive; New project and Import project… sit
// under the list, and archived projects fold away at the bottom with Restore.
// The sync-folder pieces — the Synced badge, Move to sync folder… / Move back,
// Open from folder… and the "open somewhere else" check — live in projectSync.ts.
//
// SWITCHING IS IN PLACE: adoptProject() makes the project current, whatever
// record page was open (it belongs to the old project) is closed, and the
// section repaints for the new one — no reload.

let pjPop: HTMLElement | null = null;
let pjAnchor: HTMLElement | null = null;
let pjShowArchived = false;

function pjClose(): void {
  if (!pjPop) return;
  pjPop.remove();
  pjPop = null;
  if (pjAnchor) pjAnchor.setAttribute('aria-expanded', 'false');
  pjAnchor = null;
  document.removeEventListener('mousedown', pjOnOutside, true);
  document.removeEventListener('keydown', pjOnKey, true);
}

function pjOnOutside(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  // A row's ⋯ opens a mini menu on top of this one; clicking it is not "outside".
  if (!pjPop || pjPop.contains(t) || (pjAnchor && pjAnchor.contains(t)) || t.closest('.chart-menu, .ws-modal-overlay')) return;
  pjClose();
}

function pjOnKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !pjPop || wsLayerOpen()) return;
  e.preventDefault();
  pjClose();
}

/** "opened 2h ago" — or "never opened" for a project nobody has switched to. */
function pjAgo(iso: string | null): string {
  if (!iso) return 'never opened';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'opened just now';
  if (s < 3600) return `opened ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `opened ${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `opened ${Math.floor(s / 86400)}d ago`;
  return 'opened ' + new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function pjPlural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** The initial in a tinted square — a project's face in the switcher and rail. */
function pjAvatar(name: string): HTMLElement {
  const a = document.createElement('span');
  a.className = 'pj-avatar';
  a.textContent = (name.trim()[0] || '?').toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  a.dataset.tint = String(h % 4);
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/** Most recently opened first; never-opened ones by their last edit. */
function pjSort(list: any[]): any[] {
  const key = (p: any): string => String(p.lastOpenedAt || p.updatedAt || '');
  return list.slice().sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

async function openProjectSwitcher(trigger: HTMLElement): Promise<void> {
  if (pjPop) { const same = pjAnchor === trigger; pjClose(); if (same) return; }
  let list: any[] = [];
  try { list = (await window.hub.projectsOverview()) || []; } catch (_) { list = []; }
  pjAnchor = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  const pop = document.createElement('div');
  pop.className = 'pj-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Projects');
  pjPop = pop;
  pjPaint(list);
  document.body.appendChild(pop);
  // Under the trigger: left-aligned for the sidebar's name, right-aligned for
  // the top bar's icon, never off-screen.
  const r = trigger.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = r.left + w > window.innerWidth - 8 ? Math.max(8, r.right - w) : r.left;
  pop.style.left = left + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', pjOnOutside, true);
    document.addEventListener('keydown', pjOnKey, true);
  }, 0);
  const current = pop.querySelector('.pj-row.is-current') as HTMLElement | null;
  (current || (pop.querySelector('.pj-row') as HTMLElement | null))?.focus();
}

function pjPaint(list: any[]): void {
  const pop = pjPop;
  if (!pop) return;
  pop.textContent = '';
  const live = pjSort(list.filter((p) => !p.archived));
  const archived = pjSort(list.filter((p) => p.archived));

  const head = document.createElement('div');
  head.className = 'pj-head';
  const h = document.createElement('span');
  h.className = 'pj-head-h';
  h.textContent = 'Projects';
  const n = document.createElement('span');
  n.className = 'pj-head-n';
  n.textContent = String(live.length);
  head.append(h, n);
  pop.appendChild(head);

  const rows = document.createElement('div');
  rows.className = 'pj-rows';
  for (const p of live) rows.appendChild(pjRow(p, live.length));
  pop.appendChild(rows);

  const actions = document.createElement('div');
  actions.className = 'pj-actions';
  const act = (ic: string, label: string, run: () => void, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pj-action ' + cls;
    iconLabel(b, ic, label);
    b.addEventListener('click', run);
    actions.appendChild(b);
    return b;
  };
  act('plus', 'New project', () => void pjNew(), 'pj-new');
  act('upload', 'Import project…', () => void pjImport(), 'pj-import');
  if (typeof syOpenFromFolder === 'function') act('folder', 'Open from folder…', () => void syOpenFromFolder(), 'pj-open-folder');
  pop.appendChild(actions);

  if (archived.length) {
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'pj-fold';
    fold.setAttribute('aria-expanded', String(pjShowArchived));
    fold.appendChild(icon(pjShowArchived ? 'chevron-down' : 'chevron-right', 14));
    const t = document.createElement('span');
    t.textContent = `Archived (${archived.length})`;
    fold.appendChild(t);
    fold.addEventListener('click', () => { pjShowArchived = !pjShowArchived; pjPaint(list); });
    pop.appendChild(fold);
    if (pjShowArchived) {
      const box = document.createElement('div');
      box.className = 'pj-archived';
      for (const p of archived) {
        const row = document.createElement('div');
        row.className = 'pj-arow';
        row.append(pjAvatar(p.name));
        const name = document.createElement('span');
        name.className = 'pj-arow-name';
        name.textContent = p.name;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'btn btn-sm pj-restore';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => void pjArchive(p, false));
        row.append(name, restore);
        box.appendChild(row);
      }
      pop.appendChild(box);
    }
  }
}

function pjRow(p: any, liveCount: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pj-row' + (p.id === currentProjectId ? ' is-current' : '');
  row.dataset.projectId = p.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-current', p.id === currentProjectId ? 'true' : 'false');
  row.appendChild(pjAvatar(p.name));

  const text = document.createElement('div');
  text.className = 'pj-row-text';
  const top = document.createElement('div');
  top.className = 'pj-row-top';
  const name = document.createElement('span');
  name.className = 'pj-row-name';
  name.textContent = p.name;
  top.appendChild(name);
  const synced = typeof syBadge === 'function' ? syBadge(p) : null;
  if (synced) top.appendChild(synced);
  if (p.sample) {
    const badge = document.createElement('span');
    badge.className = 'pj-badge';
    badge.textContent = 'Sample';
    badge.title = 'Holds the bundled sample data';
    top.appendChild(badge);
  }
  const meta = document.createElement('span');
  meta.className = 'pj-row-meta';
  meta.textContent = `${pjPlural(p.datasets, 'dataset')} · ${pjPlural(p.dashboards, 'dashboard')} · ${pjAgo(p.lastOpenedAt)}`;
  text.append(top, meta);
  row.appendChild(text);

  if (p.id === currentProjectId) {
    const check = document.createElement('span');
    check.className = 'pj-check';
    check.appendChild(icon('check'));
    row.appendChild(check);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pj-more';
  iconOnly(more, 'more-horizontal', `${p.name} options`);
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      menu.classList.add('pj-menu');
      const item = (ic: string, label: string, run: (() => void) | null, danger?: boolean): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item' + (danger ? ' chart-menu-item--danger' : '');
        iconLabel(b, ic, label);
        b.disabled = !run;
        if (run) b.addEventListener('click', () => { close(); run(); });
        menu.appendChild(b);
      };
      item('pencil', 'Rename…', () => void pjRename(p));
      item('package', 'Export project…', () => void pjExport(p));
      if (typeof syMenuItems === 'function') syMenuItems(p, item);
      // The last open project cannot be archived: there would be nowhere to be.
      item('archive', liveCount > 1 ? 'Archive' : 'Archive (the only project)', liveCount > 1 ? () => void pjArchive(p, true) : null);
    });
  });
  row.appendChild(more);

  const go = (): void => { void pjSwitchTo(p.id); };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
      if (sib) sib.focus();
    }
  });
  return row;
}

/**
 * Make `id` the active project and repaint whatever is showing for it. A record
 * page that belongs to the old project is closed on the way — a dirty dashboard
 * saved first, the same path its Back button takes.
 */
async function pjSwitchTo(id: string): Promise<void> {
  pjClose();
  if (id === currentProjectId) return;
  // Asked BEFORE the open page is closed, so Cancel leaves the user where they were.
  if (typeof syConfirmOpen === 'function' && !(await syConfirmOpen(id))) return;
  if (dashCurrent && typeof handleBackToList === 'function') await handleBackToList();
  if (typeof vizDatasetId === 'string' && vizDatasetId && typeof closeVisualBuilder === 'function') closeVisualBuilder();
  if (expId) document.getElementById('ds-explorer-close')?.click();
  if (!(await adoptProject(id))) { showToast('That project could not be opened', { kind: 'error' }); return; }
  selectSection(currentSection === 'capture' || currentSection === 'connect' ? 'datasets' : currentSection);
}

/** The rail's project block: the avatar beside the name. */
function pjPaintCurrent(name: string): void {
  const host = document.getElementById('as-project-avatar');
  if (!host) return;
  host.replaceWith(Object.assign(pjAvatar(name), { id: 'as-project-avatar' }));
}

async function pjNew(): Promise<void> {
  pjClose();
  const name = await promptModal('New project', '', 'Create');
  if (name === null) return;
  const created = await window.hub.createProject(name.trim() || 'Untitled project');
  if (!created || !created.id) { showToast('Could not create the project', { kind: 'error' }); return; }
  await pjSwitchTo(String(created.id));
  showToast(`Created “${created.name}”`, { kind: 'success' });
}

async function pjRename(p: any): Promise<void> {
  pjClose();
  const name = await promptModal('Rename project', p.name, 'Rename');
  if (name === null || !name.trim() || name.trim() === p.name) return;
  const res = await window.hub.renameProject(p.id, name.trim());
  if (!res) { showToast('Could not rename the project', { kind: 'error' }); return; }
  if (p.id === currentProjectId) {
    const el = document.getElementById('ws-project-name');
    if (el) el.textContent = res.name;
    pjPaintCurrent(res.name);
  }
  if (currentSection === 'home' && typeof refreshHome === 'function') void refreshHome();
}

async function pjArchive(p: any, archived: boolean): Promise<void> {
  if (archived && p.id === currentProjectId) {
    // Leave it first: the next most recently opened project becomes current.
    const others = pjSort(((await window.hub.projectsOverview()) || []).filter((x: any) => !x.archived && x.id !== p.id));
    if (!others.length) return;
    await pjSwitchTo(others[0].id);
  }
  pjClose();
  await window.hub.archiveProject(p.id, archived);
  if (archived) {
    showToast(`Archived “${p.name}”`, { action: { label: 'Undo', onClick: () => void pjArchive(p, false) } });
  } else {
    showToast(`Restored “${p.name}”`, { kind: 'success' });
  }
  if (currentSection === 'home' && typeof renderRecent === 'function') void renderRecent();
}

async function pjExport(p: any): Promise<void> {
  pjClose();
  // The Share policy's `bundle` action, for THAT project (the summary asks
  // about every dataset in it). Only the open project can be summarised here —
  // another project's bundle is still shaped in main, just without the line.
  if (p.id === currentProjectId && !(await pvShareGate('bundle', null))) return;
  const res = await window.hub.exportProject(p.id);
  if (!res || res.canceled) return;
  if (!res.ok) { showToast(res.error || 'Export failed', { kind: 'error' }); return; }
  showToast(`Exported “${p.name}” to ${String(res.path).split(/[\\/]/).pop()}`, { kind: 'success' });
}

// `given` is a bundle already imported elsewhere (a dropped .ordinate, dndIn.ts).
async function pjImport(given?: any): Promise<void> {
  pjClose();
  const res = given || await window.hub.importProject();
  if (!res || res.canceled) return;
  if (!res.ok) { showToast(res.error || 'That bundle could not be imported', { kind: 'error' }); return; }
  const c = res.counts || {};
  await pjSwitchTo(String(res.project.id));
  showToast(`Imported “${res.project.name}” — ${pjPlural(c.datasets || 0, 'dataset')}, ${pjPlural(c.visuals || 0, 'visual')}, ${pjPlural(c.dashboards || 0, 'dashboard')}`, { kind: 'success' });
}
