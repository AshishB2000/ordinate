// Home — the workspace front page: Explore, quick-start, Starred and Recent.
//
// Split out of projects.ts, which was 639 lines and owns a different job (the
// project gallery, the +New menu, and resolving a project before an action).
// This file owns what the Home SURFACE shows; projects.ts still owns what the
// buttons on it do. Classic global-scope script — NO import/export; it is
// loaded before projects.js so initHome() can call into it.
//
// THE HIERARCHY THIS RENDERS, in weight order, because the CSS alone will not
// tell you why:
//   1. Explore — one dominant element. The fastest route to an answer, and the
//      only place the accent colour is allowed to shout.
//   2. Quick-start — one compact row of icon buttons. Day-one furniture that
//      used to take a third of the page on every visit, forever.
//   3. Recent — the tall, dense region that carries the page to the bottom.
//      Rows show what the record IS (rows x columns, sheets, tiles), not just
//      a name and a timestamp.
// Starred sits between 2 and 3, compact, because it is empty until the user
// makes it otherwise.
//
// Nothing here stores or renders a thumbnail: no preview is persisted today, so
// a tile grid would be a new feature rather than a redesign.

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

// Print the REAL capture hotkey on the quick-start capture button. The markup
// carries a default; this replaces it with whatever the user actually bound, so
// it never instructs them to press the wrong keys.
//
// #home-disc-hotkey moved with the capture affordance when the quick-start
// cards collapsed into a row — the id is deliberately unchanged, because it is
// the only place on Home that shows a shortcut and this function is its only
// writer.
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

// ── Row rendering ────────────────────────────────────────────────────────────

const HOME_TYPE_LABEL: Record<string, string> = {
  dataset: 'Dataset',
  analysis: 'Analysis',
  dashboard: 'Dashboard',
};

// One inline SVG path per record type. Inline, not an icon library: no new
// runtime dependency, and currentColor lets one asset serve both themes. Built
// with createElementNS because the hub CSP forbids inline style and these are
// created from script, never parsed from a markup string.
const HOME_TYPE_PATH: Record<string, string> = {
  dataset: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 5c0 1.7 3.6 3 8 3s8-1.3 8-3M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
  analysis: 'M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-6',
  dashboard: 'M4 4h7v7H4V4Zm9 0h7v4h-7V4ZM4 13h7v7H4v-7Zm9-3h7v10h-7V10Z',
};

function homeTypeIcon(type: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', HOME_TYPE_PATH[type] || HOME_TYPE_PATH.dataset);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// Thousands separators without Intl options juggling — the same shape the rest
// of the app prints counts in.
function homeNum(n: number): string {
  return Number(n).toLocaleString();
}

/**
 * The second line of a row: what the record IS, from metadata the app already
 * had. Everything here comes off recent.ts's RecentMeta, which is assembled
 * from summaries the listers already return — no extra read, nothing opened.
 *
 * Returns '' when a record carries no counts (an older record, or a lister that
 * stopped supplying them). The caller then omits the line entirely rather than
 * rendering a stray separator or the word "undefined".
 *
 * NOTE ON VISUALS: the brief asked for a chart type on visual rows. There are
 * none — recent.ts flattens datasets, analyses and dashboards only, so a saved
 * visual never reaches this list. Analyses take that third slot and show their
 * sheet count. Putting visuals in Recent is a main-process change to
 * listRecent, not a Home redesign.
 */
function homeMetaText(it: any): string {
  const m = (it && it.meta) || {};
  const parts: string[] = [];
  if (it.type === 'dataset') {
    if (typeof m.rowCount === 'number') parts.push(homeNum(m.rowCount) + (m.rowCount === 1 ? ' row' : ' rows'));
    if (typeof m.columnCount === 'number') parts.push(homeNum(m.columnCount) + (m.columnCount === 1 ? ' column' : ' columns'));
    // "1,240 rows x 5 columns" reads as one fact, so these two join with x
    // rather than the middot that separates independent facts below.
    return parts.join(' × ');
  }
  if (it.type === 'analysis') {
    if (typeof m.sheetCount === 'number') parts.push(homeNum(m.sheetCount) + (m.sheetCount === 1 ? ' sheet' : ' sheets'));
    return parts.join(' · ');
  }
  if (it.type === 'dashboard') {
    if (typeof m.cardCount === 'number') parts.push(homeNum(m.cardCount) + (m.cardCount === 1 ? ' tile' : ' tiles'));
    if (typeof m.pageCount === 'number' && m.pageCount > 1) parts.push(homeNum(m.pageCount) + ' pages');
    return parts.join(' · ');
  }
  return '';
}

// One row: type glyph · name over a meta line · time · star. The whole row opens
// the item; the star toggles the pin without opening.
function makeRecentRow(it: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home-row';
  row.dataset.type = String(it.type || '');
  row.dataset.id = String(it.id || '');
  row.dataset.projectId = String(it.projectId || '');

  const icon = document.createElement('span');
  icon.className = 'home-row-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(homeTypeIcon(row.dataset.type));

  const body = document.createElement('span');
  body.className = 'home-row-body';

  const name = document.createElement('span');
  name.className = 'home-row-name';
  name.textContent = it.name || 'Untitled';
  body.appendChild(name);

  // Line 2 carries type, size and project — the three questions a name alone
  // leaves open. Built from spans so the separators are CSS, not text nodes
  // that a screen reader has to read as punctuation.
  const meta = document.createElement('span');
  meta.className = 'home-row-meta';
  const kind = document.createElement('span');
  kind.className = 'home-row-kind';
  kind.textContent = HOME_TYPE_LABEL[row.dataset.type] || 'Record';
  meta.appendChild(kind);

  const size = homeMetaText(it);
  if (size) {
    const sizeEl = document.createElement('span');
    sizeEl.className = 'home-row-size';
    sizeEl.textContent = size;
    meta.appendChild(sizeEl);
  }
  if (it.projectName) {
    const proj = document.createElement('span');
    proj.className = 'home-row-proj';
    proj.textContent = it.projectName;
    meta.appendChild(proj);
  }
  body.appendChild(meta);

  const time = document.createElement('span');
  time.className = 'home-row-time';
  time.textContent = formatSidebarTime(it.updatedAt || null); // hub.ts

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

  // The row is ONE button made of five boxes, and its accessible name is
  // otherwise the concatenation of them all — "Dataset3 rows x 1 columnSeed",
  // because the separators between the meta spans are CSS ::before content
  // (correctly not announced) and flex gaps are not whitespace. An explicit
  // label is what makes it read as a sentence instead of a run-on.
  const parts = [it.name || 'Untitled', HOME_TYPE_LABEL[row.dataset.type] || 'Record'];
  if (size) parts.push(size);
  if (it.projectName) parts.push('in ' + it.projectName);
  parts.push(time.textContent || '');
  row.setAttribute('aria-label', parts.filter(Boolean).join(', '));

  row.append(icon, body, time, star);
  row.addEventListener('click', () => openRecentItem(it));
  return row;
}

/**
 * A DESIGNED empty state, not a muted sentence in a box.
 *
 * Empty is what every user sees on day one, so it is a first impression rather
 * than an error path: a glyph, a headline in the same tier as a section, one
 * line of guidance, and — where there is something useful to press — an action
 * that is the actual next step.
 *
 * `onAction` is wired as a real listener rather than markup, because the hub CSP
 * forbids inline handlers just as it forbids inline style.
 */
function makeEmptyState(opts: {
  variant: string;
  glyph: string;
  title: string;
  line: string;
  actionLabel?: string;
  onAction?: () => void;
}): HTMLElement {
  const box = document.createElement('div');
  box.className = 'home-empty home-empty--' + opts.variant;

  const art = document.createElement('span');
  art.className = 'home-empty-art';
  art.setAttribute('aria-hidden', 'true');
  art.textContent = opts.glyph;

  const title = document.createElement('span');
  title.className = 'home-empty-title';
  title.textContent = opts.title;

  const line = document.createElement('span');
  line.className = 'home-empty-line';
  line.textContent = opts.line;

  box.append(art, title, line);

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-empty-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', opts.onAction);
    box.appendChild(btn);
  }
  return box;
}

// Split the one recent list into Starred (pinned) and Recent (the rest). Both
// ALWAYS render: a section that vanishes when empty is what left a void under
// the old first-run cards.
function paintHome(): void {
  const starredSec = document.getElementById('home-starred');
  const starredRows = document.getElementById('home-starred-rows');
  const recentSec = document.getElementById('home-recent');
  const recentRows = document.getElementById('home-recent-rows');
  const showall = document.getElementById('home-showall') as HTMLButtonElement | null;
  const count = document.getElementById('home-recent-count');

  const starred = recentItems.filter((it) => starredSet.has(starKey(it)));
  const rest = recentItems.filter((it) => !starredSet.has(starKey(it)));

  if (starredSec) starredSec.hidden = false;
  if (starredRows) {
    starredRows.innerHTML = '';
    // .is-empty swaps the bordered row list for a bare container, so the empty
    // state is not a panel inside a panel.
    starredRows.classList.toggle('is-empty', !starred.length);
    if (starred.length) starred.forEach((it) => starredRows.appendChild(makeRecentRow(it)));
    else
      starredRows.appendChild(
        makeEmptyState({
          variant: 'starred',
          glyph: '☆',
          title: 'Nothing pinned yet',
          line: 'Star a dataset, analysis or dashboard and it stays here, across every project.',
        }),
      );
  }

  const shown = recentExpanded ? rest : rest.slice(0, RECENT_COLLAPSED);
  if (recentSec) recentSec.hidden = false;
  if (recentRows) {
    recentRows.innerHTML = '';
    recentRows.classList.toggle('is-empty', !rest.length);
    if (rest.length) shown.forEach((it) => recentRows.appendChild(makeRecentRow(it)));
    else
      recentRows.appendChild(
        makeEmptyState({
          variant: 'recent',
          glyph: '◴',
          title: 'Your work will collect here',
          line: 'Every dataset, analysis and dashboard you open shows up in this list — newest first, across all projects.',
          actionLabel: 'Bring in some data',
          // The same door the quick-start row opens, so the empty state ends in
          // the action it is describing rather than in advice.
          onAction: () => { if (typeof startFromSource === 'function') startFromSource('file'); },
        }),
      );
  }

  // The count is the honest total, not the number of rows on screen — otherwise
  // "Show all" would appear to invent records.
  if (count) count.textContent = rest.length ? String(rest.length) : '';

  if (showall) {
    const more = rest.length > RECENT_COLLAPSED;
    showall.hidden = !more;
    showall.textContent = recentExpanded ? 'Show less' : 'Show all ' + rest.length + ' →';
  }
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

// Wire the Home-surface controls that belong to this file. Called from
// initHome() (projects.ts), which still owns the +New menu and the data-source
// buttons because those resolve a project first.
function initHomePage(): void {
  const showall = document.getElementById('home-showall');
  if (showall) {
    showall.addEventListener('click', () => {
      recentExpanded = !recentExpanded;
      paintHome();
    });
  }
  // The Explore hero is NOT wired here: initExplore() (explore.ts) already
  // binds #home-xp-band, deliberately keeping every Explore entry point in one
  // file. A second listener would fire selectSection twice per click.
  fillDiscover();
  renderRecent();
}
