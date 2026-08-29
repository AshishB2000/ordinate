// Workspace / project view router (SHELL). Classic global-scope renderer
// <script> — NO import/export; symbols are shared with the other hub scripts
// (projects.ts owns the gallery, hub.ts the capture/result surface).
//
// The sidebar is persistent and Home is just another section, so navigation is
// ONE attribute: hub.css shows exactly one section body per
// .hub-body[data-section]. There is no home/workspace view toggle any more —
// opening an item sets the active project implicitly; the user never has to
// pick a project to reach their work. The capture→result surface (the Sources
// section) is unchanged.

// ── Session state (renderer-only; launch always starts on HOME) ──────────────
let currentProjectId: string | null = null;
let currentSection = 'home';
// Where a "Close" should return to. Only updated on a real change, so repeated
// clicks on the same nav item cannot make a section its own predecessor.
let previousSection = 'home';

function wsBodyEl(): HTMLElement | null {
  return document.querySelector('.hub-body');
}

// Return to the Home section. Projects are no longer the front door, so this is
// just a section switch that also drops the active project.
function showHome(): void {
  currentProjectId = null;
  selectSection('home');
}

// Enter a project's workspace context. Validates via main first; if the project
// is gone (deleted/corrupt), fall back to HOME rather than a dangling context.
// Lands on Sources (the capture surface); callers that open a specific item
// select their own section afterwards.
async function openWorkspace(id: string): Promise<void> {
  if (!(await adoptProject(id))) {
    console.warn('[workspace] openProject returned null for', id);
    showHome();
    return;
  }
  selectSection('sources');
}

/**
 * Make `id` the session's active project, WITHOUT changing section.
 *
 * The half of openWorkspace that is about identity rather than navigation.
 * Split out because a section the user is already standing in (Visuals,
 * Analyses, Dashboards) needs a project context but must not be bounced to
 * Sources to acquire one. Still validates through main first, so a deleted or
 * corrupt project is refused here rather than becoming a dangling context that
 * fails on the next call.
 *
 * Returns false when main refuses; the caller decides what that means.
 */
async function adoptProject(id: string): Promise<boolean> {
  let project: any = null;
  try {
    project = await window.hub.openProject(id);
  } catch (_) {
    return false;
  }
  if (!project) return false;
  currentProjectId = project.id;
  // #ws-project-name was removed with the old nav; keep the guarded write so any
  // future header stays in sync without a hard dependency.
  const nameEl = document.getElementById('ws-project-name');
  if (nameEl) nameEl.textContent = project.name || 'Untitled project';
  // A project can be adopted with no section change (e.g. "+New → Data
  // source"), which dkSync()'s other call sites never see — without this the
  // dock keeps showing the PREVIOUS project's transcript until the next
  // entity-open or section-switch.
  if (typeof dkSync === 'function') dkSync();
  return true;
}

// Switch which workspace section is visible. Flips the .hub-body[data-section]
// attribute (CSS shows exactly one body) and toggles nav + placeholder state.
function selectSection(section: string): void {
  if (section !== currentSection) previousSection = currentSection;
  // Leaving the Capture workspace by ANY route drops focus mode — the nav has to
  // come back even when the user left via a global search hit or a capture
  // landing rather than the Back button. Tying it to the section change instead
  // of to the Back handler is what makes that hold for routes added later.
  if (section !== 'sources') setCaptureFocus(false);
  currentSection = section;
  const body = wsBodyEl();
  if (body) body.dataset.section = section;
  // A nav item lights for its own section OR any it lists in data-section-alt.
  // That is what keeps "Data" (data-section="datasets") highlighted while the
  // Connect panel (section "connect") is showing: connecting a source is an
  // action inside the Data area, not a place of its own, so the nav must not go
  // dark when it opens. Without the alias, changing "Data" to point at datasets
  // would leave NOTHING highlighted on the Connect section.
  document.querySelectorAll('.as-nav-item').forEach((item) => {
    const el = item as HTMLElement;
    const alt = (el.dataset.sectionAlt || '').split(/\s+/).filter(Boolean);
    el.classList.toggle('active', el.dataset.section === section || alt.indexOf(section) >= 0);
  });
  // Only the matching non-Sources placeholder is shown; Sources uses the
  // existing sidebar+main (handled entirely in CSS off [data-section]).
  document.querySelectorAll('.ws-panel').forEach((panel) => {
    (panel as HTMLElement).hidden = (panel as HTMLElement).dataset.section !== section;
  });
  // Repaint Home when it becomes active: the cross-project Recent/Starred list
  // (homePage.ts) and the greeting + ask bar + data/visuals column (homeAsk.ts's
  // refreshHome, which also drives homeData.ts).
  if (section === 'home') {
    if (typeof renderRecent === 'function') renderRecent();
    if (typeof refreshHome === 'function') void refreshHome();
  }
  // Refresh the datasets list when its section becomes active (datasets.ts).
  if (section === 'datasets' && typeof refreshDatasetList === 'function') refreshDatasetList();
  // Refresh the saved-connections list when Sources becomes active (connections.ts).
  if (section === 'sources' && typeof refreshConnectionList === 'function') refreshConnectionList();
  // Refresh the saved-visuals list when the Visuals section becomes active (visuals.ts).
  if (section === 'visuals' && typeof refreshVisualList === 'function') refreshVisualList();
  // Refresh the dashboards list when the Dashboards section becomes active
  // (analyses.ts — the section id stays "analyses" internally).
  if (section === 'analyses' && typeof refreshAnalysisList === 'function') refreshAnalysisList();
  // Reload the connector catalogue when Connect becomes active (connections.ts).
  if (section === 'connect' && typeof refreshConnPanel === 'function') void refreshConnPanel();
  // Recompute the AI dock's visibility for the new section (dock.ts) — this is
  // what forces it closed on Explore and re-shows it everywhere else.
  if (typeof dkSync === 'function') dkSync();
}

// Leave `section` for whatever was showing before it, falling back to Home.
// Guarding on `section` matters: without it, opening Connect twice in a row
// would set Connect as its own previous section and Close would go nowhere.
function leaveSection(section: string): void {
  selectSection(previousSection && previousSection !== section ? previousSection : 'home');
}

// Wire the persistent sidebar nav (once, on boot). The AI tool button toggles
// the dock; the connect items and "More…" are wired in projects.ts (they
// resolve a project first).
function initWorkspaceRouter(): void {
  document.querySelectorAll('.as-nav-item').forEach((item) => {
    const el = item as HTMLElement;
    item.addEventListener('click', () => {
      // The "Assistant" nav item is not a section any more — the standalone Ask
      // page was deleted and its chat now lives in the dock. It carries
      // `data-dock-toggle` and toggles the dock in place instead of navigating
      // (dkToggle checks dkAllowed() itself).
      if (el.dataset.dockToggle !== undefined) {
        if (typeof dkToggle === 'function') dkToggle();
        return;
      }
      selectSection(el.dataset.section || 'home');
    });
  });
  // The Agent toggle (top bar, right cell) toggles the DOCK (dock.ts), not
  // Explore.
  //
  // 498d647 pointed it at Explore, which left two chat surfaces sharing one
  // button — except Explore already has its own top-level nav item, first in
  // the nav. So this was never Explore's only door; it was a SECOND door to
  // a place that already had one, while the dock had no chrome presence at
  // all. Pointing it at the dock deletes the duplicate rather than adding a
  // second thing labelled "AI": Explore keeps its nav item (blank page, pick
  // a dataset, start cold) and the Agent toggle is the contextual one that
  // works on what you're already looking at (its tooltip says so).
  //
  // dkToggle() checks dkAllowed() itself, and dkSync() disables this button
  // wherever the dock is suppressed — the predicate is NOT duplicated here.
  const ai = document.getElementById('side-ai-btn');
  if (ai && typeof dkToggle === 'function') ai.addEventListener('click', () => dkToggle());
  // The only way out of the Capture workspace while the nav is hidden. Reuses
  // leaveSection() — the same helper Connect's Close uses — rather than adding a
  // second notion of "where was I".
  const capBack = document.getElementById('cap-back');
  if (capBack) capBack.addEventListener('click', () => leaveSection('sources'));
}

/**
 * Enter/leave the full-screen Capture workspace.
 *
 * Same mechanism the analysis authoring surface already uses (`body.an-focus`,
 * authoring.ts) rather than a second one: a body class, everything else in
 * hub.css. The capture surface itself is untouched — this only decides which
 * chrome renders around it.
 *
 * The default strapline is REPLACED, not hidden, because hub.ts writes real
 * status into the same element ("Analyzing…", "Ready") as a capture progresses.
 * Blanking it lets `:empty` collapse the line now and lets that status appear
 * normally later; a `display:none` rule would have silently eaten it.
 */
function setCaptureFocus(on: boolean): void {
  document.body.classList.toggle('cap-focus', on);
  if (typeof dkSync === 'function') dkSync(); // dock.ts — cap-focus suppresses the dock
  if (!on) return;
  const h = document.getElementById('main-title-h');
  const sub = document.getElementById('main-title-sub');
  if (h) h.textContent = 'Capture';
  if (sub) sub.textContent = '';
}

// Quick-capture guarantee: a capture fired from HOME (or before any project
// exists) transparently lands the user in a workspace with the Sources surface
// showing the fresh analysis. Uses only list/create/open — no new IPC, and the
// main capture pipeline is untouched. A default project is auto-created once
// then reused (most-recent first), never spammed.
async function ensureWorkspaceForCapture(): Promise<void> {
  // Project setup is best-effort and must NEVER throw or drop to HOME: a
  // failure in the project layer must not suppress the captured result. So we
  // resolve/create the project defensively, then ALWAYS force the workspace +
  // Sources surface visible so the fresh analysis renders (even if setup below
  // failed and currentProjectId is still null).
  try {
    if (!currentProjectId) {
      let proj: any = null;
      try {
        const list = await window.hub.listProjects();
        proj = (Array.isArray(list) && list[0]) || null;
      } catch (_) { /* ignore — fall through to create */ }
      if (!proj) {
        try { proj = await window.hub.createProject('My workspace'); } catch (_) { /* ignore */ }
      }
      if (proj && proj.id) {
        currentProjectId = String(proj.id);
        const nameEl = document.getElementById('ws-project-name');
        if (nameEl) nameEl.textContent = proj.name || 'Untitled project';
      }
    }
  } catch (_) { /* never let project setup abort the capture render */ }
  // Do NOT call openWorkspace()/showHome() here — openWorkspace falls back to
  // HOME on failure, which hides the result surface. Force Sources visible.
  selectSection('sources');
}
