// Home — the right column: a "Your data" card (the project's datasets) and a
// "Saved visuals" strip of live chart thumbnails. Classic global-scope renderer
// <script>: NO import/export. Loads after vizThumbs.js (reuses vizThumbObserve /
// vizThumbsReset) and homeAsk.js (refreshHome calls hdRender), before hub.js.
//
// The Connect shortcuts the mockup pairs with the datasets are STATIC markup in
// the card (reusing .home-quick*), so projects.ts's one initHome() listener over
// [data-source] wires them with no change — this file only fills the dynamic
// halves: the dataset list and the thumbnail strip.
//
// Every list* call takes the project id passed down from refreshHome (homeAsk),
// which has already adopted it as currentProjectId — the live thumbnails read
// that global directly (vizThumbs.ts), so the strip only renders once a project
// is in scope.
//
// NAMING — `hd` prefix; DOM ids `home-data*` / `home-viz*`.

const HD_VIZ_LIMIT = 4;

// "N rows × M cols" from the DatasetSummary (rowCount/columnCount) — the app
// already had both, so nothing is hydrated to print this.
function hdMeta(d: any): string {
  const r = typeof d.rowCount === 'number' ? d.rowCount : 0;
  const c = typeof d.columnCount === 'number' ? d.columnCount : 0;
  return r.toLocaleString() + (r === 1 ? ' row' : ' rows') + ' × ' + c + (c === 1 ? ' col' : ' cols');
}

function hdMakeDatasetRow(pid: string, d: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home-data-row';
  const name = document.createElement('span');
  name.className = 'home-data-name';
  name.textContent = d && d.name ? String(d.name) : t('common.untitled_dataset');
  const dq = dqDot(d && d.qualityFailing); // dsRules.ts — a failing quality rule
  if (dq) name.prepend(dq);
  const meta = document.createElement('span');
  meta.className = 'home-data-meta';
  meta.textContent = hdMeta(d || {});
  row.append(name, meta);
  row.addEventListener('click', () => void hdOpenDataset(pid, String(d && d.id ? d.id : '')));
  return row;
}

// Deliberate action → adopt the project (a no-op when Home already did), land on
// Data, open the record. Same order homePage.ts's openRecentItem uses.
async function hdOpenDataset(pid: string, id: string): Promise<void> {
  if (!id) return;
  if (currentProjectId !== pid) {
    if (typeof adoptProject === 'function' && !(await adoptProject(pid))) return;
  }
  if (typeof selectSection === 'function') selectSection('datasets');
  if (typeof openSavedDataset === 'function') await openSavedDataset(id);
}

async function hdRenderData(pid: string): Promise<void> {
  const list = document.getElementById('home-data-list');
  if (!list) return;
  list.textContent = '';
  let datasets: any[] = [];
  if (pid) {
    try { const res = await window.hub.listDatasets(pid); datasets = Array.isArray(res) ? res : []; } catch (_) { datasets = []; }
  }
  list.classList.toggle('is-empty', datasets.length === 0);
  if (!datasets.length) {
    const empty = document.createElement('p');
    empty.className = 'home-data-empty';
    empty.textContent = t('homeData.no_datasets_yet_connect_one_below');
    list.appendChild(empty);
    return;
  }
  datasets.forEach((d) => list.appendChild(hdMakeDatasetRow(pid, d)));
}

// ── Saved visuals strip ───────────────────────────────────────────────────────
// Live thumbnails, reusing the gallery's engine: a .viz-card-tile with a glyph
// fallback, registered with vizThumbObserve (which lazily renders a real chart
// for eligible types and leaves map/table on their glyph). vizThumbsReset()
// first, so a repaint never leaks the previous strip's Chart instances.
function hdMakeVizTile(id: string, v: any): HTMLElement {
  const chartType = v && v.chartType ? String(v.chartType) : 'column';
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'home-viz-card';
  card.setAttribute('aria-label', (v && v.name ? String(v.name) : 'Visual'));

  const tile = document.createElement('span');
  tile.className = 'viz-card-tile home-viz-tile';
  if (typeof vizAccentFor === 'function') tile.style.setProperty('--viz-accent', vizAccentFor(chartType));
  const glyph = document.createElement('span');
  glyph.className = 'viz-card-glyph';
  // The ONLY innerHTML here: VIZ_ICONS is trusted static SVG (renderResult.ts),
  // never user or model input — exactly as vizGallery.ts uses it.
  glyph.innerHTML = (typeof VIZ_ICONS !== 'undefined' && VIZ_ICONS[chartType]) || (typeof VIZ_ICONS !== 'undefined' ? VIZ_ICONS.column : '');
  tile.appendChild(glyph);
  if (typeof vizThumbObserve === 'function') vizThumbObserve(tile, v);

  const name = document.createElement('span');
  name.className = 'home-viz-name';
  name.textContent = v && v.name ? String(v.name) : t('common.untitled_visual');

  card.append(tile, name);
  card.addEventListener('click', () => void hdOpenVisual(String((v && v.id) || id), v));
  return card;
}

async function hdOpenVisual(id: string, v: any): Promise<void> {
  const vid = id || String((v && v.id) || '');
  if (!vid) return;
  if (typeof selectSection === 'function') selectSection('visuals');
  if (typeof openSavedVisual === 'function') await openSavedVisual(vid);
}

async function hdRenderViz(pid: string): Promise<void> {
  const strip = document.getElementById('home-viz-strip');
  const card = document.getElementById('home-viz');
  if (!strip) return;
  if (typeof vizThumbsReset === 'function') vizThumbsReset();
  strip.textContent = '';
  let visuals: any[] = [];
  if (pid) {
    try { const res = await window.hub.listVisuals(pid); visuals = Array.isArray(res) ? res : []; } catch (_) { visuals = []; }
  }
  // Hide the whole card when the project has no saved visuals — an empty strip
  // with a heading reads as a broken feature.
  if (card) card.hidden = visuals.length === 0;
  visuals.slice(0, HD_VIZ_LIMIT).forEach((v) => strip.appendChild(hdMakeVizTile(String((v && v.id) || ''), v)));
}

// Paint both halves for a project id (from refreshHome). Called on every Home
// show and at boot.
async function hdRender(pid: string): Promise<void> {
  await hdRenderData(pid);
  await hdRenderViz(pid);
}

// Nothing to wire yet — the Connect buttons are static markup handled by
// projects.ts's initHome(). Kept for symmetry with initHomeAsk() and the boot
// sequence in hub.ts, and as the home for any future data-card control.
function initHomeData(): void { /* listeners, if any, go here */ }
