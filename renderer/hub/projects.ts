// Home ACTIONS (SHELL). Classic global-scope renderer <script> — NO
// import/export. Owns the +New menu, the data-source doors and resolving a
// project implicitly before an action (projects are demoted — the old gallery of
// project cards, with rename/delete/search, is gone). What Home SHOWS lives in
// homePage.ts / homeAsk.ts / homeData.ts. Shares symbols with workspace.ts
// (openWorkspace, adoptProject, currentProjectId) and hub.ts (promptModal via
// makeModalAccessible). All names are rendered as textContent only.

// ── Row ⋯ menu (shared popup) ────────────────────────────────────────────────
// The project gallery (cards, rename/delete, name search) is gone — projects
// are demoted to an implicit grouping (resolveProjectId), so nothing renders a
// project card any more. What survives here is the shared row-menu popup below,
// still used by the +New menu (openNewMenu) and the Analyses row menu.
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
  const id = await resolveProjectId();
  if (!id) return false; // main refused — leave the user on home
  await openWorkspace(id); // workspace.ts — lands on the Sources section
  return true;
}

/**
 * Resolve a project to work in WITHOUT navigating: reuse the most-recently-
 * updated one, or create it. Returns '' only if main refused to create one.
 *
 * Split out of ensureProjectAndOpen because a section that is ALREADY the place
 * the user wants to be (Visuals, Analyses, Dashboards) needs the project but
 * must not be thrown to Sources to get it. Sharing the resolution keeps one
 * answer to "which project am I in" — a second copy would be a second way to
 * pick, and the two would disagree the moment ordering changed.
 *
 * Projects are demoted by design: they stay on disk as a grouping and are
 * created implicitly, so the user never has to pick one to start. That is why
 * this exists at all rather than an "Open a project first" dead end — there is
 * no project picker in the nav to send anyone to.
 */
async function resolveProjectId(opts: { create?: boolean } = {}): Promise<string> {
  if (currentProjectId) return currentProjectId;
  // `create: false` is for READ paths — a section painting what already exists
  // must never bring a project into being as a side effect of being looked at.
  const mayCreate = opts.create !== false;

  let id = '';
  try {
    const list = await window.hub.listProjects();
    // Newest-first from main, so [0] is the one the user most likely means.
    if (Array.isArray(list) && list.length) id = String(list[0].id || '');
  } catch (_) { /* fall through and create one */ }

  if (!id && mayCreate) {
    try {
      const created = await window.hub.createProject('Untitled project');
      id = created && created.id ? String(created.id) : '';
    } catch (_) {
      return '';
    }
  }
  if (!id) return '';

  // Adopt it as the session's project so the caller's very next window.hub.*
  // call has a context — WITHOUT a section change.
  return (await adoptProject(id)) ? id : '';
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

// Open the +New menu anchored to the button, reusing the shared row-menu popup.
function openNewMenu(trigger: HTMLElement): void {
  openRowMenu(trigger, [
    { label: 'Dashboard', onClick: () => newAnalysis() },
    { label: 'Data source', onClick: () => startFromSource('catalog') },
  ]);
}

// The source-specific step, once the workspace is open. Each branch is guarded:
// these are globals owned by sibling scripts, and a missing one must be a no-op
// — the user is already on Sources and can carry on by hand — rather than a
// ReferenceError that kills the whole click.
function runSourceAction(kind: string): void {
  // openWorkspace() lands on Sources, but importing belongs to the DATASETS
  // panel — the paste surface and the composer both live there, so land the user
  // on it first. (This is also what lights the "Data" nav item for the result.)
  if (kind === 'file' || kind === 'paste') {
    if (typeof selectSection === 'function') selectSection('datasets'); // workspace.ts
  }

  // CSV / Excel imports a FILE: straight to the native picker, no chooser modal.
  // Paste opens the paste surface, which focuses its own box. openImportDialog
  // (dataSection.ts) routes both; the handleImportFile fallback covers the panel
  // script not having loaded.
  if (kind === 'file') {
    if (typeof openImportDialog === 'function') openImportDialog('file');
    else if (typeof handleImportFile === 'function') handleImportFile(); // datasets.ts
    return;
  }
  if (kind === 'paste') {
    if (typeof openImportDialog === 'function') openImportDialog('paste');
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
    // The connect panel IS the connectors:catalog picker. A NAMED entry
    // preselects its connector and lands on that form; only "More…"
    // (kind: 'catalog') opens the full grid. Before this, all four opened the
    // same 35-source grid — so clicking "PostgreSQL" made you go find
    // PostgreSQL, which is the one thing the shortlist exists to save.
    //
    // The kind IS the connector id, so passing it through needs no mapping and
    // no switch over connector names here: src/connectors/ is a registry, the
    // catalog comes from it live, and an id missing from it falls back to the
    // picker inside openConnPanel rather than opening a dead panel.
    const id = kind === 'catalog' ? '' : kind;
    if (typeof openConnPanel === 'function') {
      openConnPanel(id); // connections.ts
      return;
    }
    // The panel's own button is the fallback if connections.ts has not loaded —
    // it opens the picker, which is worse than a preselect but never nothing.
    const open = document.getElementById('conn-connect-btn') as HTMLButtonElement | null;
    if (open) open.click();
  }
}

// Home's own surface — Starred, Recent, the quick-start hotkey and the row
// rendering — moved to homePage.ts when this file passed 600 lines. That file
// owns what Home SHOWS; this one still owns what its buttons DO (resolving a
// project, the +New menu, the data-source doors), which is why initHome() below
// calls initHomePage() rather than the other way round.

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
    // The quick-start Database button reads "Database — N sources", so N is the
    // WHOLE catalog. It used to be n - 2, because the card it replaced named
    // Postgres and MySQL first and said "and N more"; carrying that subtraction
    // over to the new copy would have quietly under-reported the catalog by two.
    const dbCount = document.getElementById('firstrun-db-count');
    if (dbCount && n > 0) dbCount.textContent = String(n);
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

/**
 * The project switcher, behind the sidebar's project block and the top bar's
 * project button. ONE function for both: two triggers, one list, because the
 * sidebar is hidden in body.cap-focus / body.an-focus and the top bar is not.
 *
 * It only SWITCHES. Creating a project stays implicit (resolveProjectId) and
 * renaming/deleting stays out — the gallery that owned those is deliberately
 * gone, and re-growing it behind a chevron would bring it back one item at a
 * time. Reuses openRowMenu, so positioning, dismissal and the one-menu-open
 * slot are the same as every other popup.
 */
async function openProjectSwitcher(trigger: HTMLElement): Promise<void> {
  let list: any[] = [];
  try {
    list = (await window.hub.listProjects()) || [];
  } catch (_) {
    list = [];
  }
  if (!list.length) return;
  openRowMenu(
    trigger,
    list.map((p: any) => ({
      label: String(p && p.name ? p.name : 'Untitled project'),
      onClick: () => {
        void (async () => {
          if (await adoptProject(String(p.id))) {
            // Home is cross-project, but every OTHER section is showing the
            // previous project's contents until it repaints.
            selectSection(currentSection === 'home' ? 'home' : currentSection);
          }
        })();
      },
    })),
  );
}

function wireProjectSwitcher(id: string): void {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void openProjectSwitcher(btn);
  });
}

function initHome(): void {
  fillHomeSourceLogos();
  wireProjectSwitcher('as-project-btn');
  wireProjectSwitcher('topbar-user');
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

  // homePage.ts: Show all/less, the capture hotkey, and the first paint of
  // Starred + Recent.
  if (typeof initHomePage === 'function') initHomePage();
  fillConnectorCount();
}
