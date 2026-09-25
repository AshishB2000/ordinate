// Workspace / project view router (SHELL). Classic global-scope renderer
// <script> — NO import/export; symbols are shared with the other hub scripts
// (projects.ts owns the gallery, hub.ts the capture/result surface).
//
// The sidebar is persistent and Home is just another section, so navigation is
// ONE attribute: hub.css shows exactly one section body per
// .hub-body[data-section]. There is no home/workspace view toggle any more —
// opening an item sets the active project implicitly; the user never has to
// pick a project to reach their work. A capture is a section like any other
// ('capture'), with the same nav and top bar around it — the old 'sources'
// section WAS the capture shell and went with it.

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
  // The sidebar's project block names the active project; dropping the project
  // without clearing the label leaves the last one named under a Home that is
  // cross-project. Same guarded lookup adoptProject() uses.
  const nameEl = document.getElementById('ws-project-name');
  if (nameEl) nameEl.textContent = 'All projects';
  selectSection('home');
}

// Enter a project's workspace context. Validates via main first; if the project
// is gone (deleted/corrupt), fall back to HOME rather than a dangling context.
// Lands on Data — the project's data is what a workspace opens onto, and it is
// where both datasets and captures live; callers that open a specific item
// select their own section afterwards.
async function openWorkspace(id: string): Promise<void> {
  if (!(await adoptProject(id))) {
    console.warn('[workspace] openProject returned null for', id);
    showHome();
    return;
  }
  selectSection('datasets');
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
  if (typeof pjPaintCurrent === 'function') pjPaintCurrent(project.name || 'Untitled project');
  // A project can be adopted with no section change (e.g. "+New → Data
  // source"), which dkSync()'s other call sites never see — without this the
  // dock keeps showing the PREVIOUS project's transcript until the next
  // entity-open or section-switch.
  if (typeof dkSync === 'function') dkSync();
  // Alerts are per project, so the bell's count belongs to THIS project. Same
  // reason as the dkSync above: an adoption with no section change would
  // otherwise leave the previous project's unread count on screen.
  if (typeof aiRefresh === 'function') void aiRefresh();
  // …and so is the Trash badge (trashPage.ts).
  if (typeof trSyncCount === 'function') void trSyncCount();
  // Home's Recent is scoped to the active project (homePage.ts). At launch the
  // list can land before the project is adopted — repaint it from what it
  // already holds, so it is never left showing every project unasked.
  if (currentSection === 'home' && typeof paintHome === 'function') paintHome();
  return true;
}

// Switch which workspace section is visible. Flips the .hub-body[data-section]
// attribute (CSS shows exactly one body) and toggles nav + placeholder state.
function selectSection(section: string): void {
  // The right panel (History, Lineage) is about a record on THIS page; a new
  // section is a new page, so it closes (sidePanel.ts).
  if (section !== currentSection && typeof spClose === 'function') spClose();
  if (section !== currentSection) previousSection = currentSection;
  currentSection = section;
  const body = wsBodyEl();
  if (body) body.dataset.section = section;
  wsMarkNav(section);
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
    if (typeof gsRender === 'function') void gsRender(); // getStarted.ts — the checklist ticks from real records
  }
  // Refresh the datasets list when its section becomes active (datasets.ts),
  // and the Captures grid with it — they are two tabs of one page, and a
  // project switch with the Captures tab showing would otherwise leave the
  // previous project's screenshots on screen (captureList.ts).
  if (section === 'datasets') {
    if (typeof refreshDatasetList === 'function') refreshDatasetList();
    if (typeof refreshCaptureList === 'function') void refreshCaptureList();
  }
  // Refresh the saved-visuals list when the Visuals section becomes active (visuals.ts).
  if (section === 'visuals' && typeof refreshVisualList === 'function') refreshVisualList();
  // Refresh the dashboards list when the Dashboards section becomes active
  // (analyses.ts — the section id stays "analyses" internally).
  if (section === 'analyses' && typeof refreshAnalysisList === 'function') refreshAnalysisList();
  // The Trash page reads the active project's trash each time it is shown.
  if (section === 'trash' && typeof trRefresh === 'function') void trRefresh();
  // Reload the connector catalogue when Connect becomes active (connections.ts).
  if (section === 'connect' && typeof refreshConnPanel === 'function') void refreshConnPanel();
  // Recompute the AI dock's visibility for the new section (dock.ts) — this is
  // what forces it closed on Explore and re-shows it everywhere else.
  if (typeof dkSync === 'function') dkSync();
}

// Light the nav item for `section`. Its own function because a split-view pane
// taking focus (tabSplit.ts) moves the current section WITHOUT selectSection —
// whose refresh would close the dashboard open in the other pane.
//
// A nav item lights for its own section OR any it lists in data-section-alt.
// That is what keeps "Data" (data-section="datasets") highlighted while the
// Connect panel (section "connect") is showing: connecting a source is an
// action inside the Data area, not a place of its own, so the nav must not go
// dark when it opens. Without the alias, changing "Data" to point at datasets
// would leave NOTHING highlighted on the Connect section.
function wsMarkNav(section: string): void {
  document.querySelectorAll('.as-nav-item').forEach((item) => {
    const el = item as HTMLElement;
    const alt = (el.dataset.sectionAlt || '').split(/\s+/).filter(Boolean);
    el.classList.toggle('active', el.dataset.section === section || alt.indexOf(section) >= 0);
  });
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
}

// Quick-capture guarantee: a capture fired from HOME (or before any project
// exists) transparently lands the user in a workspace. Uses only list/create/
// open — no new IPC, and the main capture pipeline is untouched. A default
// project is auto-created once then reused (most-recent first), never spammed.
// The SECTION is chosen by the caller (hubCapture.ts opens the capture page);
// this only guarantees there is a project to open it in.
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
}

/**
 * Paint `#as-ai-status`, the Assistant readiness readout pinned under Settings
 * at the bottom of the rail.
 *
 * `getKeyStatus().isReady` is the SAME signal anNew.ts, dashAdd.ts and
 * authoringPanes.ts already gate their AI actions on — reused deliberately
 * rather than given a second definition, because two answers to "is the
 * Assistant set up?" is exactly how a disabled button ends up sitting next to
 * a green dot.
 *
 * It lives here rather than in dock.ts because it paints SIDEBAR chrome, and
 * because dock.ts is at the 800-line cap. dkSync calls it: that runs on
 * section switches and dock toggles, not in a loop, and getKeyStatus reads an
 * in-memory config in main — so this needs no throttle, and a stale readout
 * would cost more than the call does.
 */
function wsSyncAiStatus(): void {
  const el = document.getElementById('as-ai-status');
  if (!el) return;
  const label = el.querySelector('.as-ai-label');
  const paint = (state: string, text: string): void => {
    el.setAttribute('data-state', state);
    if (label) label.textContent = text;
  };
  window.hub.getKeyStatus().then((st: any) => {
    if (st && st.isReady) paint('ready', 'Assistant ready');
    else paint('not_ready', 'Assistant not set up');
  }).catch(() => paint('not_ready', 'Assistant not set up'));
}
