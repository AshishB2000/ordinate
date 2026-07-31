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

function openCardMenu(trigger: HTMLElement, p: any): void {
  closeProjectMenu();
  const menu = document.createElement('div');
  menu.className = 'project-card-popup';

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'project-card-popup-item';
  rename.textContent = 'Rename';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    closeProjectMenu();
    handleRenameProject(String(p.id), p.name || '');
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'project-card-popup-item project-card-popup-danger';
  del.textContent = 'Delete';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    closeProjectMenu();
    handleDeleteProject(String(p.id));
  });

  menu.appendChild(rename);
  menu.appendChild(del);
  document.body.appendChild(menu);

  const rect = trigger.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
  openProjectMenu = menu;

  // Close on the next outside click (capture phase, after this click settles).
  setTimeout(() => document.addEventListener('click', closeProjectMenu, true), 0);
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

// Wire the two "New project" buttons and paint the initial gallery.
function initHome(): void {
  const newBtn = document.getElementById('home-new-project');
  if (newBtn) newBtn.addEventListener('click', () => handleNewProject());
  const emptyNew = document.getElementById('home-empty-new');
  if (emptyNew) emptyNew.addEventListener('click', () => handleNewProject());
  renderHomeGallery();
}
