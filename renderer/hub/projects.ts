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
// Resolve a project to work in (a source/analysis/dashboard is only meaningful
// inside one) and open its workspace. Reuse the most-recently-updated project, or
// create one. Projects stay on disk as a grouping — the user just never has to
// pick one to start. Returns false only if main refused to create one.
async function ensureProjectAndOpen(): Promise<boolean> {
  let id = '';
  try {
    const list = await window.hub.listProjects();
    // Newest-first from main, so [0] is the one the user most likely means.
    if (Array.isArray(list) && list.length) id = String(list[0].id || '');
  } catch (_) { /* fall through and create one */ }

  if (!id) {
    const created = await window.hub.createProject('Untitled project');
    if (!created || !created.id) return false; // main refused — leave the user on home
    id = String(created.id);
  }

  await openWorkspace(id); // workspace.ts — lands on the Sources section
  return true;
}

async function startFromSource(kind: string): Promise<void> {
  if (!(await ensureProjectAndOpen())) return;
  runSourceAction(kind);
}

// ── "+ New" menu (front door) ────────────────────────────────────────────────
// Projects were demoted, so the primary button no longer creates one. It opens a
// menu of what a user actually makes; each resolves a project implicitly, opens
// its workspace, and lands on the create flow.
async function newAnalysis(): Promise<void> {
  if (!(await ensureProjectAndOpen())) return;
  selectSection('analyses'); // workspace.ts
  if (typeof anCreateWizard === 'function') anCreateWizard(); // analyses.ts
}

async function newDashboard(): Promise<void> {
  if (!(await ensureProjectAndOpen())) return;
  selectSection('dashboards'); // workspace.ts
  if (typeof handleNewDashboard === 'function') handleNewDashboard(); // dashboards.ts
}

// Open the +New menu anchored to the button, reusing the shared row-menu popup.
function openNewMenu(trigger: HTMLElement): void {
  openRowMenu(trigger, [
    { label: 'Analysis', onClick: () => newAnalysis() },
    { label: 'Dashboard', onClick: () => newDashboard() },
    { label: 'Data source', onClick: () => startFromSource('catalog') },
  ]);
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
  // "Screenshot" is a destination, not an action: openWorkspace() has already
  // landed on Sources (the capture surface), and this turns that surface into a
  // full-screen workspace — no nav, captures column kept. Entering focus mode is
  // the ONLY thing this branch does; the capture pipeline is untouched, and the
  // global ⌘⌥S hotkey is registered in main and unaffected.
  if (kind === 'capture') {
    if (typeof setCaptureFocus === 'function') setCaptureFocus(true); // workspace.ts
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

// Print the REAL capture hotkey on the "Grab it off your screen" card. The
// markup carries ⌘⌥S as a default; this replaces it with whatever the user
// actually bound, so the card never instructs them to press the wrong keys.
//
// This used to fill a second line under the cards ("…AI is optional. Your data
// stays on this machine.") and the key-status half of it went with that line.
// The hotkey half did not, because the card still shows a shortcut.
async function fillDiscover(): Promise<void> {
  const keyEl = document.getElementById('home-disc-hotkey');
  if (!keyEl) return;
  try {
    // `hotkey:label` resolves { label, accelerator } — not a bare string.
    const res: any = await window.hub.getHotkeyLabel();
    const label = res && typeof res === 'object' ? res.label : res;
    if (label) keyEl.textContent = String(label);
  } catch (_) { /* keep the default printed in the markup */ }
}

// ── Recent + Starred (cross-project) ─────────────────────────────────────────

// How many Recent rows show before "Show all"; the main-process list is already
// capped (recent.ts). Purely a view limit, so expanding never re-reads disk.
const RECENT_COLLAPSED = 8;
let recentExpanded = false;
let recentItems: any[] = [];
let starredSet = new Set<string>();

// The pin key stored in config.starred — matches "type:id" (e.g. "analysis:<id>").
function starKey(it: any): string {
  return String(it.type || '') + ':' + String(it.id || '');
}

// Fetch the recent list AND the starred pins, then paint both Home sections.
// Called on boot and whenever Home is (re)shown (selectSection).
async function renderRecent(): Promise<void> {
  const [list, starred] = await Promise.all([
    window.hub.recentItems().catch(() => []),
    window.hub.getStarred().catch(() => []),
  ]);
  recentItems = Array.isArray(list) ? list : [];
  starredSet = new Set(Array.isArray(starred) ? starred : []);
  paintHome();
}

// Split the one recent list into Starred (pinned) and Recent (the rest). Starred
// hides entirely when empty; the first-run block shows only when there is
// nothing at all.
function paintHome(): void {
  const starredSec = document.getElementById('home-starred');
  const starredRows = document.getElementById('home-starred-rows');
  const recentSec = document.getElementById('home-recent');
  const recentRows = document.getElementById('home-recent-rows');
  const firstrun = document.getElementById('home-firstrun');
  const showall = document.getElementById('home-showall') as HTMLButtonElement | null;

  const starred = recentItems.filter((it) => starredSet.has(starKey(it)));
  const rest = recentItems.filter((it) => !starredSet.has(starKey(it)));

  // Starred and Recent ALWAYS render — a heading plus a muted placeholder when
  // empty. Hiding them left a large void under the first-run cards; a structured
  // "nothing here yet" reads as waiting rather than broken.
  if (starredSec) starredSec.hidden = false;
  if (starredRows) {
    starredRows.innerHTML = '';
    if (starred.length) starred.forEach((it) => starredRows.appendChild(makeRecentRow(it)));
    else starredRows.appendChild(makeEmptyRow('Star anything to pin it here.'));
  }

  const shown = recentExpanded ? rest : rest.slice(0, RECENT_COLLAPSED);
  if (recentSec) recentSec.hidden = false;
  if (recentRows) {
    recentRows.innerHTML = '';
    if (rest.length) shown.forEach((it) => recentRows.appendChild(makeRecentRow(it)));
    else
      recentRows.appendChild(
        makeEmptyRow('Nothing yet. Datasets, analyses and dashboards you open will show up here.'),
      );
  }
  if (showall) {
    const more = rest.length > RECENT_COLLAPSED;
    showall.hidden = !more;
    showall.textContent = recentExpanded ? 'Show less' : 'Show all →';
  }

  // The quick-start cards + capture hint stay on EVERY visit (above Starred),
  // not just first-run — they are the primary "bring data in" doors, so they
  // remain reachable even once Starred and Recent have content.
  if (firstrun) firstrun.hidden = false;
}

// One row: star toggle · name · type chip · project · relative time. The whole
// row opens the item; the star toggles the pin without opening.
function makeRecentRow(it: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home-row';
  row.dataset.type = String(it.type || '');
  row.dataset.id = String(it.id || '');
  row.dataset.projectId = String(it.projectId || '');

  const on = starredSet.has(starKey(it));
  const star = document.createElement('span');
  star.className = 'home-row-star' + (on ? ' is-on' : '');
  star.setAttribute('role', 'button');
  star.setAttribute('tabindex', '0');
  star.setAttribute('aria-label', on ? 'Unstar' : 'Star');
  star.setAttribute('aria-pressed', on ? 'true' : 'false');
  star.textContent = on ? '★' : '☆';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStar(it);
  });
  star.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggleStar(it);
    }
  });

  const name = document.createElement('span');
  name.className = 'home-row-name';
  name.textContent = it.name || 'Untitled';

  const chip = document.createElement('span');
  chip.className = 'home-row-chip home-chip-' + row.dataset.type;
  chip.textContent =
    it.type === 'dataset' ? 'Dataset' : it.type === 'analysis' ? 'Analysis' : 'Dashboard';

  const proj = document.createElement('span');
  proj.className = 'home-row-proj';
  proj.textContent = it.projectName || '';

  const time = document.createElement('span');
  time.className = 'home-row-time';
  time.textContent = formatSidebarTime(it.updatedAt || null); // hub.ts

  row.append(star, name, chip, proj, time);
  row.addEventListener('click', () => openRecentItem(it));
  return row;
}

// A muted, non-interactive placeholder row for an empty Starred/Recent section.
function makeEmptyRow(text: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'home-row home-row-empty';
  const span = document.createElement('span');
  span.className = 'home-row-emptytext';
  span.textContent = text;
  row.appendChild(span);
  return row;
}

// Toggle a pin, persist the whole list (one setter), and repaint. No re-fetch of
// the recent list — only the star state changed.
function toggleStar(it: any): void {
  const key = starKey(it);
  if (starredSet.has(key)) starredSet.delete(key);
  else starredSet.add(key);
  if (window.hub.setStarred) window.hub.setStarred([...starredSet]);
  paintHome();
}

// Opening a Recent/Starred item sets the active project implicitly from the
// record's own project id (the whole point of dropping the project front door),
// then lands on the item — best-effort open of the exact record if its opener
// exists.
async function openRecentItem(it: any): Promise<void> {
  await openWorkspace(String(it.projectId)); // workspace.ts — sets currentProjectId
  if (it.type === 'dataset') {
    selectSection('datasets');
    if (typeof openSavedDataset === 'function') openSavedDataset(String(it.id));
  } else if (it.type === 'analysis') {
    selectSection('analyses');
    if (typeof openAnalysis === 'function') openAnalysis(String(it.id));
  } else if (it.type === 'dashboard') {
    selectSection('dashboards');
    if (typeof openDashboard === 'function') openDashboard(String(it.id));
  }
}

// Fill the Connect "More…" count from the LIVE connectors:catalog, never a
// literal — the shortlist is five, but the real number of sources is whatever
// the registry currently exposes. connections.ts owns the same contract and
// degrades gracefully; here a missing/failing catalog just leaves "More…" bare.
async function fillConnectorCount(): Promise<void> {
  const countEl = document.getElementById('as-connect-count');
  if (!countEl) return;
  try {
    const cat = await window.hub.connectorCatalog();
    const n = Array.isArray(cat) ? cat.length : 0;
    if (n > 0) countEl.textContent = String(n);
    // First-run card 3 names Postgres + MySQL explicitly, so "and N more" is the
    // rest of the live catalog. Leave the markup fallback if the count is odd.
    const dbCount = document.getElementById('firstrun-db-count');
    if (dbCount && n > 2) dbCount.textContent = String(n - 2);
  } catch (_) {
    /* leave "More…" without a count if the catalog channel is unavailable */
  }
}

// Wire the Home section and the persistent sidebar's source entries.
function fillHomeSourceLogos(): void {
  document.querySelectorAll<HTMLElement>('.as-source-logo[data-logo-id]').forEach((host) => {
    const id = host.dataset.logoId || '';
    const label = host.dataset.logoLabel || '';
    const logo = connMakeLogoFor(id, label);
    host.replaceChildren(...logo.childNodes);
    host.setAttribute('aria-hidden', 'true');
  });
}

function initHome(): void {
  fillHomeSourceLogos();
  const newBtn = document.getElementById('home-new-project');
  if (newBtn) newBtn.addEventListener('click', () => openNewMenu(newBtn));

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

  const showall = document.getElementById('home-showall');
  if (showall) {
    showall.addEventListener('click', () => {
      recentExpanded = !recentExpanded;
      paintHome();
    });
  }

  fillDiscover();
  fillConnectorCount();
  renderRecent();
}
