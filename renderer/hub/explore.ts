// Explore — the conversational front door (Phase 1: the surface).
//
// Classic global-scope renderer <script> — NO import/export; symbols are shared
// with the other hub scripts (workspace.ts owns the section router and
// currentProjectId, projects.ts owns the recent-item router, hub.ts owns
// formatSidebarTime).
//
// Explore is a PLACE, not a panel: a full-bleed stage with a greeting and a
// composer, over a "Jump back in" strip. Phase 1 builds the surface only — the
// composer is deliberately inert until Phase 2 wires copilot:ask. Nothing here
// computes, rounds or formats a figure; that stays main-process work.
//
// NAMING — `xp` is Explore's reserved prefix. `exp*` is the dataset explorer
// (expId/expName), `ex-`/`exec-` is execution mode, `ai-` is the copilot panel.
// A collision with any of those silently breaks an unrelated surface.

function xpEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// How many rows the "Jump back in" strip shows. The recent list itself is
// cross-project and already sorted newest-first in main (src/recent.ts).
const XP_JUMP_LIMIT = 10;

// ── Jump back in ──────────────────────────────────────────────────────────────

// One row per recent item: name, kind, relative time. Clicking routes through
// projects.ts's openRecentItem — the SAME router the Home rows use, so a new
// entity kind added there works here with no change.
function xpMakeJumpRow(it: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'xp-jump-row';
  row.dataset.type = String(it.type || '');
  row.dataset.id = String(it.id || '');

  const name = document.createElement('span');
  name.className = 'xp-jump-name';
  name.textContent = it.name || 'Untitled';

  const kind = document.createElement('span');
  kind.className = 'xp-jump-kind';
  kind.textContent =
    it.type === 'dataset' ? 'Dataset' : it.type === 'analysis' ? 'Analysis' : 'Dashboard';

  const time = document.createElement('span');
  time.className = 'xp-jump-time';
  // formatSidebarTime (hub.ts) is the app's one relative-time formatter.
  time.textContent = typeof formatSidebarTime === 'function'
    ? formatSidebarTime(it.updatedAt || null)
    : '';

  row.append(name, kind, time);
  row.addEventListener('click', () => {
    if (typeof openRecentItem === 'function') openRecentItem(it);
  });
  return row;
}

// Repaint the strip. Empty → ONE muted line, deliberately not a card: an empty
// container with a border reads as a broken feature.
async function xpRenderJump(): Promise<void> {
  const host = xpEl('xp-jump-rows');
  if (!host) return;
  let items: any[] = [];
  try {
    const res = await window.hub.recentItems(XP_JUMP_LIMIT);
    items = Array.isArray(res) ? res : [];
  } catch (_) {
    items = [];
  }
  host.textContent = '';
  const empty = xpEl('xp-jump-empty');
  if (empty) empty.hidden = items.length > 0;
  const jump = xpEl('xp-jump');
  // Hide the whole strip's heading too when there is nothing at all to show.
  if (jump) jump.classList.toggle('xp-jump-bare', items.length === 0);
  items.slice(0, XP_JUMP_LIMIT).forEach((it) => host.appendChild(xpMakeJumpRow(it)));
}

// ── Panel refresh ─────────────────────────────────────────────────────────────

// Called by workspace.ts:selectSection when Explore becomes active. Phase 1 only
// repaints the jump strip; readiness/model/dataset state arrives in Phase 2.
async function refreshExplore(): Promise<void> {
  await xpRenderJump();
}

// ── Boot wiring (once) ────────────────────────────────────────────────────────

function initExplore(): void {
  // The Home band is a door to this section, wired here rather than in
  // projects.ts so every Explore entry point lives in one file.
  const band = xpEl('home-xp-band');
  if (band) band.addEventListener('click', () => selectSection('explore'));
}
