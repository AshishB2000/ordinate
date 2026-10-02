// The dashboards list (internally the analyses list): the card grid and its
// count.
//
// Split verbatim out of analyses.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER analyses.js,
// which keeps the module-local state every function here reads, and AFTER
// vizThumbs.js, whose engine draws the card previews.
//
// A DASHBOARD IS MOSTLY PICTURES, so its list shows them. This was a four-column
// text table — Name / Sheets / Last updated / Action — which made the app's
// flagship output the plainest surface in it, while Visuals next door was a card
// grid of live charts. Each card now previews the first sheet's first one or two
// visuals through THAT SAME ENGINE (vizThumbs.ts): the same .viz-card-tile, the
// same lazy IntersectionObserver render, the same concurrency cap, and the same
// destroy-on-repaint discipline. There is no second thumbnail engine here.

// ── List view ───────────────────────────────────────────────────────────────
async function refreshAnalysisList(): Promise<void> {
  // Flush a pending debounced edit before the editor is torn down, so a quick
  // section switch never drops the last few edits.
  if (dashDirty && dashCurrent) await persistDashboard();
  closeDashboardEditor();
  const list = dashEl('an-list');
  if (!list) return;
  if (!currentProjectId) {
    anPaintList(list, []);
    anShowList(0);
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listAnalyses(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  await anPaintList(list, items);
  anShowList(items.length);
  anRenderCount(items.length);
  if (!items.length) void anRenderEmptyChips();
}

/** How many of a sheet's visuals one card previews. Two: enough to say what the
 *  dashboard is about, few enough that each thumbnail stays legible at card
 *  width. */
const AN_PREVIEW_MAX = 2;

/**
 * Repaint the grid.
 *
 * vizThumbsReset() FIRST, before the cards it drew are discarded: a repaint
 * throws away the canvases, and a Chart instance that outlives its canvas keeps
 * its RAF and resize hooks alive (vizThumbs.ts). Same call, same reason, as
 * refreshVisualList and hdRenderViz.
 */
let anPaintGen = 0;
async function anPaintList(list: HTMLElement, items: any[]): Promise<void> {
  const gen = ++anPaintGen;
  const projectId = currentProjectId;
  const previews = await anPreviewVisuals(projectId, items);
  // A project switch mid-fetch: drop this paint rather than filling the new
  // project's grid with the old project's dashboards. And only the LATEST
  // paint writes: two overlapping refreshes (a section switch and a save
  // landing together) used to both clear, both await, and both append — every
  // dashboard twice.
  if (gen !== anPaintGen || currentProjectId !== projectId || !list.isConnected) return;
  if (typeof vizThumbsReset === 'function') vizThumbsReset();
  list.innerHTML = '';
  items.forEach((a) => list.appendChild(makeAnListItem(a, previews.get(String(a.id)) || [])));
  void ctAfterPaint(list); // catalog tag bar + chips
}

/**
 * analysisId → the visual SUMMARIES its first sheet leads with.
 *
 * A summary from listAnalyses carries no sheets, and a sheet card carries only a
 * visualId — so the preview needs one listVisuals for the project (id → summary,
 * which is where the chartType eligibility check comes from) plus one getAnalysis
 * per row. Both are small JSON reads and both resolve BEFORE the paint; the
 * expensive half — computeVisualData + buildChart — stays lazy inside vizThumbs.
 *
 * Every failure path yields an empty list, which is a glyph card. A broken card
 * is worse than a plain one.
 */
async function anPreviewVisuals(projectId: string, items: any[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!projectId || !items.length) return out;

  const byId = new Map<string, any>();
  try {
    const vs = await window.hub.listVisuals(projectId);
    if (Array.isArray(vs)) vs.forEach((v: any) => byId.set(String(v && v.id), v));
  } catch (_) { /* every card falls back to its glyph */ }

  await Promise.all(items.map(async (a: any) => {
    let full: any = null;
    try {
      full = await window.hub.getAnalysis(projectId, String(a && a.id));
    } catch (_) {
      full = null;
    }
    const sheet = full && Array.isArray(full.sheets) ? full.sheets[0] : null;
    const cards = sheet && Array.isArray(sheet.cards) ? sheet.cards : [];
    const picked: any[] = [];
    for (const c of cards) {
      if (!c || c.type !== 'visual') continue;
      // A dangling visualId is a hole in the sheet, not a card to draw.
      const v = byId.get(String(c.visualId || ''));
      if (v) picked.push(v);
      if (picked.length >= AN_PREVIEW_MAX) break;
    }
    out.set(String(a && a.id), picked);
  }));
  return out;
}

/** How many build-intent chips the empty state offers. Three: enough to show
 *  the shape of the thing, few enough that they read as examples. */
const AN_CHIP_MAX = 3;

/**
 * Build intents over the project's REAL datasets.
 *
 * The empty state used to offer exactly two doors, and the AI one fired a draft
 * with NO intent — the model got the project inventory and guessed. A chip names
 * a dataset the user actually has and opens the Assistant with that sentence, so
 * the draft starts from something they chose. The dock then runs the ordinary
 * ask → suggestedAction → proposal path; nothing here talks to a model.
 */
async function anRenderEmptyChips(): Promise<void> {
  const host = dashEl('an-empty-chips');
  if (!host) return;
  host.innerHTML = '';
  host.hidden = true;
  if (!currentProjectId) return;

  let sets: any[] = [];
  try {
    sets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    sets = [];
  }
  // No datasets means no honest suggestion to make — "build a dashboard from
  // nothing" is not a starting point, and the two buttons above still stand.
  if (!Array.isArray(sets) || !sets.length) return;

  sets.slice(0, AN_CHIP_MAX).forEach((d: any) => {
    const name = d && d.name ? String(d.name) : 'my data';
    const text = 'Build an overview of ' + name;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ws-empty-chip';
    chip.textContent = text;
    chip.addEventListener('click', () => { if (typeof dkAsk === 'function') void dkAsk(text); });
    host.appendChild(chip);
  });
  host.hidden = false;
}

/** How many analyses, beside the heading. Hidden at zero — the empty state
 *  already says there are none, and "0" next to a title reads as an error. */
function anRenderCount(n: number): void {
  const chip = dashEl('an-count');
  if (!chip) return;
  chip.hidden = n === 0;
  chip.textContent = n + (n === 1 ? ' dashboard' : ' dashboards');
}

// Refresh the summaries without tearing down an open editor.
async function refreshAnalysisListKeepEditor(): Promise<void> {
  if (!currentProjectId) return;
  const list = dashEl('an-list');
  if (!list) return;
  try {
    const items = await window.hub.listAnalyses(currentProjectId);
    if (!Array.isArray(items)) return;
    await anPaintList(list, items);
    anShowList(items.length);
    anRenderCount(items.length);
  } catch (_) { /* ignore */ }
}

// One card: a preview of what the dashboard actually looks like, then its name,
// sheet count and last-updated. There is deliberately no Owner line (QuickSight
// has a column for it) — every dashboard in a local-first, single-user app is
// owned by the person reading the screen, so it would say "Me" forever.
//
// The body, name and meta wear the .viz-card-* classes verbatim: one card shape
// across Visuals and Dashboards, so a change to one is a change to both. Only
// the preview strip is this section's own.
function makeAnListItem(a: any, previews: any[]): HTMLElement {
  const card = document.createElement('div');
  card.className = 'an-card';
  card.dataset.recKind = 'analysis'; card.dataset.recId = String(a.id); // ⌘-click → background tab (tabStrip.ts)

  // The whole card is ONE button, so a card is a single Tab stop; the ⋯ trigger
  // is a sibling positioned over the preview (nested buttons are invalid HTML).
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'viz-card-body an-card-body';
  open.addEventListener('click', () => openAnalysis(String(a.id)));

  const prev = document.createElement('span');
  prev.className = 'an-card-prev' + (previews.length > 1 ? ' an-card-prev--2' : '');
  if (previews.length) previews.forEach((v) => prev.appendChild(anPreviewTile(v)));
  else prev.appendChild(anPreviewBars());
  open.appendChild(prev);

  const name = document.createElement('span');
  name.className = 'viz-card-name';
  name.textContent = a && a.name ? String(a.name) : 'Untitled dashboard';

  const sheets = a && typeof a.sheetCount === 'number' ? a.sheetCount : 1;
  const meta = document.createElement('span');
  meta.className = 'viz-card-meta';
  meta.textContent = sheets + (sheets === 1 ? ' sheet · ' : ' sheets · ')
    + formatSidebarTime(a && a.updatedAt);

  open.appendChild(name);
  open.appendChild(meta);
  ctDecorate(card, 'analysis', String(a.id), open); // catalog tag chips

  // One ⋯ trigger, opening the shared row menu from projects.ts. Rename and
  // Delete live inside it: two glyphs on a card read as content competing with
  // the preview rather than as controls.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'viz-card-menu an-row-menu';
  menuBtn.setAttribute('aria-haspopup', 'menu');
  iconOnly(menuBtn, 'more-horizontal', 'Dashboard options');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openRowMenu(menuBtn, [
      { label: 'Open', onClick: () => { openAnalysis(String(a.id)); } },
      {
        label: 'Rename',
        onClick: () => handleRenameAnalysis(String(a.id), a && a.name ? String(a.name) : ''),
      },
      { label: 'History', onClick: () => void vhOpen('dashboard', String(a.id), a && a.name ? String(a.name) : '') },
      { label: 'Lineage', onClick: () => void lnOpen('dashboard', String(a.id), a && a.name ? String(a.name) : '') },
      { label: 'Save as template…', onClick: () => void utSaveAsTemplate(String(a.id)) }, // r7:templates
      { label: 'Delete', danger: true, onClick: () => handleDeleteAnalysis(String(a.id)) },
    ]);
  });

  card.appendChild(open);
  card.appendChild(menuBtn);
  return card;
}

// One preview tile: the SAME .viz-card-tile the gallery card uses, so the glyph
// fallback, the per-type accent and vizThumbs' canvas positioning all come for
// free. vizThumbObserve declines the ineligible types itself (map needs WebGL2
// and the visible window; a shrunken table is unreadable) — for those the glyph
// IS the presentation, which is exactly what this tile already shows.
function anPreviewTile(v: any): HTMLElement {
  const chartType = v && v.chartType ? String(v.chartType) : 'column';
  const tile = document.createElement('span');
  tile.className = 'viz-card-tile an-card-tile';
  if (typeof vizAccentFor === 'function') tile.style.setProperty('--viz-accent', vizAccentFor(chartType));
  const glyph = document.createElement('span');
  glyph.className = 'viz-card-glyph';
  // The ONLY innerHTML here: VIZ_ICONS is a trusted static constant of
  // hand-written SVG in renderResult.ts, never user or model input — exactly as
  // vizGallery.ts and homeData.ts use it.
  glyph.innerHTML = VIZ_ICONS[chartType] || VIZ_ICONS.column;
  tile.appendChild(glyph);
  if (typeof vizThumbObserve === 'function') vizThumbObserve(tile, v);
  return tile;
}

// A first sheet with no visual cards at all (metrics and text only) gets the
// section's OWN bar motif rather than borrowing a chart glyph for a chart it
// does not have. Reuses .ws-bars/.ws-bar — no image asset, and the
// fixed-height art element is what makes the bars' percentage heights resolve.
function anPreviewBars(): HTMLElement {
  const tile = document.createElement('span');
  tile.className = 'viz-card-tile an-card-tile an-card-tile--none';
  const art = document.createElement('span');
  art.className = 'ws-bars an-card-bars';
  ['2', '4', '3'].forEach((h) => {
    const bar = document.createElement('span');
    bar.className = 'ws-bar ws-bar--' + h;
    art.appendChild(bar);
  });
  tile.appendChild(art);
  return tile;
}

