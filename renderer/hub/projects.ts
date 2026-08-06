// Home project gallery (SHELL). Classic global-scope renderer <script> — NO
// import/export. Renders project cards and wires create/rename/delete via
// window.hub. Shares symbols with workspace.ts (openWorkspace, showHome,
// currentProjectId) and hub.ts (formatSidebarTime). Project names are rendered
// as textContent only — no HTML injection.

// Rebuild the gallery from disk. Toggles the empty state on project count.
async function renderHomeGallery(): Promise<void> {
  const gallery = document.getElementById('home-gallery');
  const empty = document.getElementById('home-empty');
  if (!gallery) return;
  let list: any[] = [];
  try {
    list = await window.hub.listProjects();
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  if (empty) empty.hidden = list.length > 0;
  gallery.innerHTML = '';
  list.forEach((p) => gallery.appendChild(makeProjectCard(p)));
}

// Build one project card (a <button>, so keyboard/click work for free).
function makeProjectCard(p: any): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'project-card';
  card.dataset.projectId = String(p.id);

  const name = document.createElement('div');
  name.className = 'project-card-name';
  name.textContent = p.name || 'Untitled project';

  const time = document.createElement('div');
  time.className = 'project-card-time';
  time.textContent = formatSidebarTime(p.updatedAt || null); // hub.ts helper

  const menu = document.createElement('span');
  menu.className = 'project-card-menu';
  menu.setAttribute('role', 'button');
  menu.setAttribute('tabindex', '0');
  menu.setAttribute('aria-label', 'Project options');
  menu.textContent = '⋯';
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardMenu(menu, p);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openCardMenu(menu, p);
    }
  });

  card.appendChild(name);
  card.appendChild(time);
  card.appendChild(menu);
  card.addEventListener('click', () => openWorkspace(String(p.id))); // workspace.ts
  return card;
}

// ── Card ⋯ menu (Rename / Delete) ────────────────────────────────────────────
let openProjectMenu: HTMLElement | null = null;

function closeProjectMenu(): void {
  if (openProjectMenu) {
    openProjectMenu.remove();
    openProjectMenu = null;
  }
  document.removeEventListener('click', closeProjectMenu, true);
}

// The popup itself, given the items to put in it. Shared with the Analyses row
// menu (analyses.ts) — same DOM, same positioning, same one-menu-open-at-a-time
// slot, so opening one closes the other.
function openRowMenu(
  trigger: HTMLElement,
  items: Array<{ label: string; danger?: boolean; onClick: () => void }>,
): void {
  closeProjectMenu();
  const menu = document.createElement('div');
  menu.className = 'project-card-popup';

  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'project-card-popup-item' + (it.danger ? ' project-card-popup-danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProjectMenu();
      it.onClick();
    });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);

  // Right-aligned to the trigger, and flipped above it when there is no room
  // below — a row near the bottom of a long list would otherwise open its menu
  // off-screen with no way to reach Delete.
  const rect = trigger.getBoundingClientRect();
  menu.style.position = 'fixed';
  const below = rect.bottom + 4;
  menu.style.top =
    (below + menu.offsetHeight > window.innerHeight - 8
      ? Math.max(8, rect.top - menu.offsetHeight - 4)
      : below) + 'px';
  menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
  openProjectMenu = menu;

  // Close on the next outside click (capture phase, after this click settles).
  setTimeout(() => document.addEventListener('click', closeProjectMenu, true), 0);
}

function openCardMenu(trigger: HTMLElement, p: any): void {
  openRowMenu(trigger, [
    { label: 'Rename', onClick: () => handleRenameProject(String(p.id), p.name || '') },
    { label: 'Delete', danger: true, onClick: () => handleDeleteProject(String(p.id)) },
  ]);
}

// Small in-app text dialog. Electron does NOT implement window.prompt() (it's a
// no-op that returns null), so we build our own. Resolves to the entered string,
// or null if cancelled (Cancel / Escape / backdrop click). CSP-safe: classes
// from hub.css, no inline style attributes.
function promptModal(title: string, defaultValue: string, okLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-modal-input';
    input.value = defaultValue;
    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = okLabel;

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: string | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release(); // return focus to the trigger
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      else if (a11y) a11y.onTabKey(e); // trap Tab within the dialog
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => close(input.value));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    box.appendChild(input);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, title, input); // role/aria-modal + focus in/trap/return
    input.select();
  });
}

// Create a project, refresh the gallery, then jump straight into its workspace.
async function handleNewProject(): Promise<void> {
  const name = await promptModal('New project', 'Untitled project', 'Create');
  if (name === null) return; // cancelled
  const p = await window.hub.createProject(name);
  await renderHomeGallery();
  if (p && p.id) openWorkspace(String(p.id));
}

// Rename via the in-app dialog; keep the workspace header in sync if open.
async function handleRenameProject(id: string, currentName: string): Promise<void> {
  const name = await promptModal('Rename project', currentName || 'Untitled project', 'Save');
  if (name === null) return;
  const updated = await window.hub.renameProject(id, name);
  await renderHomeGallery();
  if (id === currentProjectId && updated) {
    const nameEl = document.getElementById('ws-project-name');
    if (nameEl) nameEl.textContent = updated.name || 'Untitled project';
  }
}

// Delete after a confirm; if it was the open project, return to HOME.
async function handleDeleteProject(id: string): Promise<void> {
  if (!window.confirm('Delete this project? This cannot be undone.')) return;
  await window.hub.deleteProject(id);
  if (id === currentProjectId) showHome();
  else await renderHomeGallery();
}

// ── Start page: Connect rail + Quick start ───────────────────────────────────

// Every Connect item and Quick-start tile routes through here. A source is only
// meaningful INSIDE a project, so this resolves one first: reuse the most
// recently updated project, or create one. That is the whole point of making
// these real buttons — a rail that looked the part and did nothing would be
// worse than the plain gallery it replaced.
//
// `capture` (Screenchart) used to be the exception here: it fired
// window.hub.takeScreenshot() immediately, so clicking a start-page entry dimmed
// the screen and put the user straight into a drag-to-select overlay. That is
// the right behaviour for the global HOTKEY, which the user presses when they
// are already looking at what they want to grab — but it is the wrong behaviour
// for a button on the start page, which reads as "take me to that feature", not
// "start capturing now".
//
// It now routes like every other source: resolve a project, open the workspace,
// and land on Sources — which IS the Screenchart surface (the capture history
// rail plus the Welcome pane with its own New capture button). The user takes
// the shot from there, or with the hotkey, when they are ready.
async function startFromSource(kind: string): Promise<void> {
  let id = '';
  try {
    const list = await window.hub.listProjects();
    // Newest-first from main, so [0] is the one the user most likely means.
    if (Array.isArray(list) && list.length) id = String(list[0].id || '');
  } catch (_) { /* fall through and create one */ }

  if (!id) {
    const created = await window.hub.createProject('Untitled project');
    if (!created || !created.id) return; // main refused — leave the user on home
    id = String(created.id);
  }

  await openWorkspace(id); // workspace.ts — lands on the Sources section
  runSourceAction(kind);
}

// The source-specific step, once the workspace is open. Each branch is guarded:
// these are globals owned by sibling scripts, and a missing one must be a no-op
// — the user is already on Sources and can carry on by hand — rather than a
// ReferenceError that kills the whole click.
function runSourceAction(kind: string): void {
  // openWorkspace() lands on Sources, but the file picker and the paste box
  // live in the DATASETS panel — acting on them from Sources targets a hidden
  // section, which is how the paste box silently failed to take focus.
  if (kind === 'file' || kind === 'paste') {
    if (typeof selectSection === 'function') selectSection('datasets'); // workspace.ts
  }

  if (kind === 'file') {
    if (typeof handleImportFile === 'function') handleImportFile(); // datasets.ts
    return;
  }
  if (kind === 'paste') {
    const box = document.getElementById('ds-paste-input') as HTMLTextAreaElement | null;
    if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
    return;
  }
  if (kind === 'postgres' || kind === 'url' || kind === 'mysql' || kind === 'catalog') {
    // Open the connect panel — it IS the connectors:catalog picker now, so the
    // server shortlist entries and "More…" all land on the same searchable
    // catalog (connections.ts owns which connector is preselected/searched).
    const open = document.getElementById('conn-connect-btn') as HTMLButtonElement | null;
    if (open) open.click();
  }
}

// Filter the gallery by name. Purely a view filter — it never re-reads disk, so
// typing cannot race renderHomeGallery(). "No matches" is a SEPARATE state from
// "no projects": conflating them tells a first-run user their search is broken.
function applyHomeSearch(): void {
  const input = document.getElementById('home-search') as HTMLInputElement | null;
  const gallery = document.getElementById('home-gallery');
  const none = document.getElementById('home-noresults');
  if (!gallery) return;
  const q = (input ? input.value : '').trim().toLowerCase();
  const cards = Array.from(gallery.querySelectorAll('.project-card')) as HTMLElement[];
  let shown = 0;
  cards.forEach((card) => {
    const nameEl = card.querySelector('.project-card-name');
    const name = (nameEl && nameEl.textContent ? nameEl.textContent : '').toLowerCase();
    const hit = !q || name.indexOf(q) !== -1;
    card.hidden = !hit;
    if (hit) shown++;
  });
  if (none) none.hidden = !(q !== '' && cards.length > 0 && shown === 0);
}

// Fill the Discover panel from state the app already holds. No network call:
// local-first is the reason this panel is not a feed.
async function fillDiscover(): Promise<void> {
  const keyEl = document.getElementById('home-disc-hotkey');
  if (keyEl) {
    try {
      // `hotkey:label` resolves { label, accelerator } — not a bare string.
      const res: any = await window.hub.getHotkeyLabel();
      const label = res && typeof res === 'object' ? res.label : res;
      if (label) keyEl.textContent = String(label);
    } catch (_) { /* keep the default printed in the markup */ }
  }
  const aiEl = document.getElementById('home-disc-ai');
  if (aiEl) {
    let ready = false;
    try {
      const st = await window.hub.getKeyStatus();
      ready = !!(st && (st.hasApiKey || st.ready));
    } catch (_) { ready = false; }
    aiEl.textContent = ready
      ? 'A model is configured. Every figure is still computed by the app — the model only reads pictures and writes prose.'
      : 'No model configured. Everything except the AI features works exactly as it is.';
  }
}

// Wire the Home section and the persistent sidebar's source entries.
function initHome(): void {
  const newBtn = document.getElementById('home-new-project');
  if (newBtn) newBtn.addEventListener('click', () => handleNewProject());

  // One listener covers the sidebar Connect items AND the first-run tiles —
  // both carry data-source, wherever they live in the DOM.
  document.querySelectorAll('[data-source]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = (el as HTMLElement).dataset.source || '';
      if (kind) startFromSource(kind);
    });
  });

  // "More…" opens the full data-source catalog (the connect panel), resolving a
  // project first like any other source.
  const more = document.getElementById('as-connect-more');
  if (more) more.addEventListener('click', () => startFromSource('catalog'));

  fillDiscover();
}
