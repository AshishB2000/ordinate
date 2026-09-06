// The gallery — the default Visuals view: the chart-glyph motif each card
// wears, the empty state that starts you from a dataset, the cards themselves,
// and the per-card actions (export one visual, add one to an analysis).
//
// Split verbatim out of visuals.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER visuals.js,
// which keeps the module-local state every function here reads.

// ── The chart-glyph motif ────────────────────────────────────────────────────
// The Analyses hero draws five CSS bars. Visuals is about 28 chart TYPES, so
// its motif is a cluster of real chart glyphs instead — still no image asset,
// still nothing to ship: VIZ_ICONS (renderResult.ts) is already in the bundle.
//
// Those SVG strings are the ONE innerHTML allowed in this file: a trusted
// hand-written constant, never user or model input. Everything else is
// textContent.
const VIZ_ART_TYPES = ['column', 'line', 'donut', 'treemap'];
// Which glyph reads as the bright one, mirroring how --4 is the tall bar in the
// Analyses motif.
const VIZ_ART_FOCUS = 1;

// The five chart tokens from renderer/theme.css. Deliberately the SAME palette
// the charts themselves draw with, so a card's tile colour and the chart it
// opens are from one family rather than two.
const VIZ_ACCENTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

/**
 * A stable colour for a chart type: same type, same colour, every render and
 * every session. A random or index-based pick would reshuffle the grid whenever
 * a visual was added or renamed, which is exactly the noise this is meant to
 * avoid.
 */
function vizAccentFor(chartType: string): string {
  let h = 0;
  for (let i = 0; i < chartType.length; i += 1) {
    h = (h * 31 + chartType.charCodeAt(i)) >>> 0;
  }
  return 'var(' + VIZ_ACCENTS[h % VIZ_ACCENTS.length] + ')';
}

// Mirrors the Analyses hero's dismissal: same localStorage scheme, its own key.
const VIZ_HERO_KEY = 'vizHeroDismissed';
function vizHeroDismissed(): boolean {
  try {
    return localStorage.getItem(VIZ_HERO_KEY) === '1';
  } catch (_) {
    return false; // private mode — show it rather than crash
  }
}

// Fill every .viz-glyph-art host (hero + empty state) with the glyph cluster.
// Idempotent: re-running replaces the children rather than appending.
function paintVizGlyphArt(): void {
  document.querySelectorAll('.viz-glyph-art').forEach((host) => {
    host.innerHTML = '';
    VIZ_ART_TYPES.forEach((type, i) => {
      const cell = document.createElement('span');
      cell.className = 'viz-glyph' + (i === VIZ_ART_FOCUS ? ' viz-glyph--focus' : '');
      // Trusted static SVG constant — see the note above.
      cell.innerHTML = VIZ_ICONS[type] || '';
      host.appendChild(cell);
    });
  });
}

// ── "Start from a dataset" (empty state only) ────────────────────────────────
// What actually fixes a blank page: the next real action, drawn from the
// project rather than from decoration. Six most-recent datasets as cards that
// open the create flow with that dataset already chosen; with none, one wide
// card pointing at the import, which is the honest next step for a user who has
// nothing at all.
const VIZ_START_MAX = 6;

async function renderVizStartBand(): Promise<void> {
  const band = vizEl('viz-start');
  const grid = vizEl('viz-start-grid');
  const seeAll = vizEl('viz-start-all');
  if (!band || !grid) return;
  grid.innerHTML = '';
  band.hidden = false;

  // Adopt an EXISTING project if the session has not got one yet — arriving via
  // the nav rather than by opening a project leaves currentProjectId null, and
  // showing "No data yet" to someone who has data would be a lie. `create:false`
  // matters: painting a page must never bring a project into being.
  const projectId = currentProjectId || (await resolveProjectId({ create: false }));

  let sets: any[] = [];
  if (projectId) {
    try {
      sets = await window.hub.listDatasets(projectId);
    } catch (_) {
      sets = [];
    }
  }
  if (!Array.isArray(sets)) sets = [];

  if (seeAll) seeAll.hidden = sets.length <= VIZ_START_MAX;

  if (sets.length === 0) {
    grid.appendChild(makeVizNoDataCard());
    return;
  }
  // listDatasets is already newest-updated first, so this is "the six you most
  // likely mean" without a second sort that could disagree with the Data list.
  sets.slice(0, VIZ_START_MAX).forEach((d) => grid.appendChild(makeVizDatasetCard(d)));
}

function makeVizDatasetCard(d: any): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'viz-ds-card';

  const name = document.createElement('span');
  name.className = 'viz-ds-name';
  name.textContent = d && d.name ? String(d.name) : 'Untitled dataset';

  const meta = document.createElement('span');
  meta.className = 'viz-ds-meta';
  const rows = typeof d.rowCount === 'number' ? d.rowCount.toLocaleString() : '—';
  const cols = typeof d.columnCount === 'number' ? String(d.columnCount) : '—';
  meta.textContent = rows + ' rows · ' + cols + ' columns';

  const kind = document.createElement('span');
  kind.className = 'viz-ds-kind';
  kind.textContent = d && d.sourceKind ? String(d.sourceKind) : 'csv';

  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(kind);
  // Straight into the builder on this dataset — the popup's step 1 is exactly
  // the question this card just answered.
  card.addEventListener('click', () => handleNewVisual({ datasetId: String(d.id) }));
  return card;
}

function makeVizNoDataCard(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'viz-ds-none';
  const h = document.createElement('h4');
  h.className = 'viz-ds-none-h';
  h.textContent = 'No data yet';
  const p = document.createElement('p');
  p.className = 'viz-ds-none-p';
  p.textContent = 'Import a CSV, paste a table, or connect a source — then build your first visual.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Import data';
  btn.addEventListener('click', () => {
    if (typeof selectSection === 'function') selectSection('datasets');
  });
  box.appendChild(h);
  box.appendChild(p);
  box.appendChild(btn);
  return box;
}

// ── Gallery (the default view: saved visuals as cards) ───────────────────────
// Same name and same contract as the Week 7 list refresh — only the DOM it
// produces changed, so workspace.selectSection and every save/delete/duplicate
// caller is unaffected.
async function refreshVisualList(): Promise<void> {
  const grid = vizEl('viz-grid');
  const empty = vizEl('viz-empty-wrap');
  if (!grid) return;
  // Destroy the previous paint's live thumbnail charts BEFORE their canvases
  // are discarded (vizThumbs.ts) — repeated section switches must not leak.
  vizThumbsReset();
  grid.innerHTML = '';
  let items: any[] = [];
  if (currentProjectId) {
    try {
      items = await window.hub.listVisuals(currentProjectId);
    } catch (_) {
      items = [];
    }
  }
  if (!Array.isArray(items)) items = [];
  grid.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  items.forEach((v) => grid.appendChild(makeVisualCard(v)));

  // Count chip beside the heading — hidden at zero, where the empty state is
  // already saying it.
  const count = vizEl('viz-count');
  if (count) {
    count.hidden = items.length === 0;
    count.textContent = items.length + (items.length === 1 ? ' visual' : ' visuals');
  }
  // First-run hero: only alongside real content, and only until dismissed —
  // the same rule and the same storage key scheme the Analyses hero uses.
  const hero = vizEl('viz-hero');
  if (hero) hero.hidden = items.length === 0 || vizHeroDismissed();
  paintVizGlyphArt();
  // The dataset band belongs to the empty state only — once there are visuals,
  // the grid IS the content and a second card grid under it would compete.
  if (items.length === 0) await renderVizStartBand();
}

// Flip between the gallery and the (now full-panel) builder. They are mutually
// exclusive: the builder is no longer an inline editor sitting above a list.
function showVizGallery(show: boolean): void {
  vizShow('viz-gallery', show);
  vizShow('viz-builder', !show);
}

function makeVisualCard(v: any): HTMLElement {
  const id = String(v && v.id ? v.id : '');
  const chartType = (v && v.chartType) ? String(v.chartType) : 'column';
  const card = document.createElement('div');
  card.className = 'viz-card' + (v && v.favorite === true ? ' viz-card--fav' : '');

  // The whole card is ONE button, so a card is a single Tab stop. The star and
  // the ⋯ menu are siblings of it (nested buttons are invalid HTML) positioned
  // over the tile by CSS.
  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'viz-card-body';

  const tile = document.createElement('span');
  tile.className = 'viz-card-tile';
  // Per-type accent, deterministic: the same chart type always gets the same
  // colour, so a grid of cards reads as a palette instead of as noise. Set as a
  // custom property from JS — element.style is fine under the hub's CSP; an
  // inline style ATTRIBUTE in the HTML would not be.
  tile.style.setProperty('--viz-accent', vizAccentFor(chartType));
  const glyph = document.createElement('span');
  glyph.className = 'viz-card-glyph';
  // The ONLY innerHTML here: VIZ_ICONS is a trusted static constant of
  // hand-written SVG in renderResult.ts, never user or model input.
  glyph.innerHTML = VIZ_ICONS[chartType] || VIZ_ICONS.column;
  tile.appendChild(glyph);
  // Live thumbnail (vizThumbs.ts): rendered lazily when the tile scrolls into
  // view; maps and tables keep the glyph, and any failure leaves it in place.
  vizThumbObserve(tile, v);

  const name = document.createElement('span');
  name.className = 'viz-card-name';
  name.textContent = v && v.name ? String(v.name) : 'Untitled visual';

  const meta = document.createElement('span');
  meta.className = 'viz-card-meta';
  const typeLabel = VIZ_LABELS[chartType] || chartType || 'Chart';
  meta.textContent = typeLabel + ' · ' + formatSidebarTime(v && v.updatedAt);

  body.appendChild(tile);
  body.appendChild(name);
  body.appendChild(meta);
  body.addEventListener('click', () => openSavedVisual(id));

  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'viz-card-star';
  star.textContent = '★';
  const fav = v && v.favorite === true;
  star.setAttribute('aria-pressed', fav ? 'true' : 'false');
  star.setAttribute('aria-label', fav ? 'Unfavourite' : 'Favourite');
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    handleToggleFavorite(id, !fav, star);
  });

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'viz-card-menu';
  menuBtn.textContent = '⋯';
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', 'More actions');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openVisualCardMenu(menuBtn, v);
  });

  card.appendChild(body);
  card.appendChild(star);
  card.appendChild(menuBtn);
  return card;
}

// The card's ⋯ popover. Reuses the hub's shared mini-menu (chartControls.ts) —
// positioning, outside-click and Esc are already solved there.
function openVisualCardMenu(anchor: HTMLButtonElement, v: any): void {
  const id = String(v && v.id ? v.id : '');
  anchor.setAttribute('aria-expanded', 'true');
  openMiniMenu(
    anchor,
    (el: HTMLElement, close: () => void) => {
      // hub.ts keeps ONE permanent .chart-menu[role=menu] in the document for the
      // per-graph ⋯ cluster, so `.chart-menu` alone does not identify this
      // popover. Its own class is what lets a test address it.
      el.classList.add('viz-card-pop');
      const add = (label: string, run: (() => void) | null): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item';
        b.textContent = label;
        b.disabled = !run;
        if (run) b.addEventListener('click', () => { close(); run(); });
        el.appendChild(b);
      };
      add('Open', () => openSavedVisual(id));
      add('Rename', () => handleRenameVisual(id, v && v.name ? String(v.name) : ''));
      add('Duplicate', () => handleDuplicateVisual(id));
      add('Add to dashboard', () => handleAddVisualToAnalysis(id));
      add('Export', () => handleExportVisual(id));
      add('Delete', () => handleDeleteVisual(id));
    },
    () => anchor.setAttribute('aria-expanded', 'false'),
  );
}

// ── Export a single saved visual ─────────────────────────────────────────────
// Loads the visual, has MAIN compute its data, and hands the SAME argument
// object the result surface builds to the SAME openExportDialog — PDF/PPTX/DOCX/
// HTML/PNG for one chart, with no export path of its own to drift.
//
// `entry` is the adapter shape vizEntry already uses, with the visual's stored
// overrides mapped onto the key the dialog derives ('v:' + type), so an exported
// chart carries the styling the builder saved. This runs in the VISIBLE hub
// window, which is where a map must render — the offscreen report window is not
// touched.
async function handleExportVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  let visual: any = null;
  try {
    visual = await window.hub.getVisual(currentProjectId, id);
  } catch (_) {
    visual = null;
  }
  if (!visual) {
    showToast('That visual could not be loaded');
    return;
  }

  let res: any;
  try {
    res = await window.hub.computeVisualData(
      currentProjectId, String(visual.datasetId || ''), visual.encoding, visual.filters || []);
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.data) {
    showToast((res && res.error) || 'Could not compute this visual');
    return;
  }
  const data = res.data;

  // The saved type FIRST so the dialog opens on what the user saved, then the
  // rest of what this data can actually support.
  const eligible = eligibleChartTypes(res.recommendedShape, countNumericSeries(data), (data.labels || []).length);
  if (data.geo) eligible.push('map_choropleth');
  const saved = String(visual.chartType || '');
  const recommended = saved ? [saved].concat(eligible.filter((t) => t !== saved)) : eligible;

  const overrides = visual.overrides && typeof visual.overrides === 'object' ? visual.overrides : {};
  const entry = { id: String(visual.id), chartOverrides: { ['v:' + saved]: overrides } };

  openExportDialog({
    recommended,
    selectedExtra: [],
    current: saved,
    vizData: data,
    entry,
    turnIdx: 'v', // the override-key prefix the builder already writes under
    hasGeo: !!data.geo,
    analysis: '',
    title: String(visual.name || 'Visual'),
    headlineSegments: [],
  });
}

// ── Add a saved visual to an analysis ────────────────────────────────────────
// Appends a visual card to the LAST sheet of the chosen analysis and persists
// it. Deliberately does NOT navigate: the user is browsing the gallery and asked
// to file this away, not to leave.
async function handleAddVisualToAnalysis(id: string): Promise<void> {
  if (!currentProjectId) return;
  let list: any[] = [];
  try {
    list = await window.hub.listAnalyses(currentProjectId);
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const NEW = '__new__';
  const options = list
    .map((a) => ({ value: String(a.id), label: a && a.name ? String(a.name) : 'Untitled dashboard' }))
    .concat([{ value: NEW, label: 'New dashboard…' }]);
  const choice = await dashChooseModal('Add to dashboard', options, 'Add');
  if (choice === null) return;

  let analysis: any = null;
  if (choice === NEW) {
    const name = await promptModal('Name the dashboard', 'Untitled dashboard', 'Create');
    if (name === null) return;
    try {
      analysis = await window.hub.createAnalysis({ projectId: currentProjectId, name: name.trim() || 'Untitled dashboard' });
    } catch (_) {
      analysis = null;
    }
  } else {
    try {
      analysis = await window.hub.getAnalysis(currentProjectId, choice);
    } catch (_) {
      analysis = null;
    }
  }
  if (!analysis || !analysis.id) {
    showToast('That dashboard could not be opened');
    return;
  }

  // An analysis always has at least one sheet; a record that somehow has none
  // gets one rather than dropping the card on the floor.
  const sheets = Array.isArray(analysis.sheets) && analysis.sheets.length
    ? analysis.sheets
    : [{ id: dashUuid(), name: 'Sheet 1', cards: [] }];
  const last = sheets[sheets.length - 1];
  if (!Array.isArray(last.cards)) last.cards = [];
  // Same layout maths the grid editor uses for its own + Visual — nextFreeRow
  // takes the card list so this and the editor cannot disagree about where the
  // next card lands.
  last.cards.push({ id: dashUuid(), type: 'visual', visualId: id, layout: { ...dashFindSlot(last.cards, 6, 6), w: 6, h: 6 } });

  let saved: any = null;
  try {
    saved = await window.hub.updateAnalysis(currentProjectId, String(analysis.id), { sheets });
  } catch (_) {
    saved = null;
  }
  if (!saved || saved.ok === false) {
    showToast('Could not add it to that dashboard');
    return;
  }
  showToast('Added to ' + (analysis.name ? String(analysis.name) : 'the dashboard'));
}

// Optimistic: the star flips immediately, then the list repaints (favourites
// sort to the top, so the card usually moves). A failed write is reverted by the
// refresh, which reads what is actually on disk.
async function handleToggleFavorite(id: string, next: boolean, star: HTMLButtonElement): Promise<void> {
  if (!currentProjectId) return;
  star.setAttribute('aria-pressed', next ? 'true' : 'false');
  star.setAttribute('aria-label', next ? 'Unfavourite' : 'Favourite');
  try {
    await window.hub.updateVisual(currentProjectId, id, { favorite: next });
  } catch (_) {
    /* ignore — the refresh below shows the stored truth */
  }
  await refreshVisualList();
}

async function handleRenameVisual(id: string, current: string): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename this visual', current, 'Rename');
  if (name === null || !name.trim()) return;
  try {
    await window.hub.updateVisual(currentProjectId, id, { name: name.trim() });
  } catch (_) {
    /* ignore */
  }
  await refreshVisualList();
}

async function handleDuplicateVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  try {
    await window.hub.duplicateVisual(currentProjectId, id);
  } catch (_) {
    /* ignore */
  }
  await refreshVisualList();
}

async function handleDeleteVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this visual? This cannot be undone.')) return;
  try {
    await window.hub.deleteVisual(currentProjectId, id);
  } catch (_) {
    /* ignore */
  }
  if (vizEditingId === id) closeVisualBuilder();
  await refreshVisualList();
}

