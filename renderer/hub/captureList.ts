'use strict';

// The Data page's TAB STRIP — Datasets · Captures · Metrics — plus the Captures
// tab itself. Classic global-scope renderer <script>: no import/export.
//
// The strip lives here because Captures was the second tab and built it; the
// third (metricsPage.ts) joins the same table rather than growing a strip of
// its own.
//
// Captures used to have a sidebar of their own in a shell of their own. They
// are project records now, so they live where the project's other data lives:
// a second tab on the Data page, a card grid of screenshots, and a click opens
// the capture PAGE (hubCapture.ts).
//
// Nothing here is capture-specific design: the tab strip is `.ds-tabs`/`.ds-tab`
// (the dataset page's), the grid is `.viz-grid`/`.viz-card*` (the Visuals
// gallery's, whose tile is already 16:10 — the shape a screenshot wants), and
// the empty state is `.ws-empty`. Only `.cap-card-img` is new, and it is the
// image frame.

let clActive: 'datasets' | 'captures' | 'metrics' | 'catalog' = 'datasets';

function clEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Show one of the two tabs.
 *
 * The Data header's copy and its actions belong to Datasets — "Import file",
 * "Paste data", "Connect data" are all ways to make a dataset, and none of them
 * makes a capture. So the tab switch swaps the sentence and hides that row
 * rather than leaving four buttons that do nothing for what is on screen.
 */
const CL_TABS: Array<{ id: 'datasets' | 'captures' | 'metrics' | 'catalog'; tab: string; panel: string; sub: string }> = [
  {
    id: 'datasets', tab: 'ds-tab-datasets', panel: 'ds-saved',
    sub: 'Import CSV, JSON, or Excel — or paste data — to save a structured dataset in this project.',
  },
  {
    id: 'captures', tab: 'ds-tab-captures', panel: 'cap-grid-wrap',
    sub: 'Screenshots you analyzed in this project. Save the ones that carry a table as a dataset.',
  },
  {
    id: 'metrics', tab: 'ds-tab-metrics', panel: 'mp-wrap',
    sub: 'The numbers this project is about, defined once and shown the same way everywhere.',
  },
  {
    id: 'catalog', tab: 'ds-tab-catalog', panel: 'ct-wrap',
    sub: 'Everything in this project — what it is, who owns it, what uses it and whether it is fresh.',
  },
];

function clSelectTab(tab: 'datasets' | 'captures' | 'metrics' | 'catalog'): void {
  clActive = tab;

  // A table, not a chain of booleans: this started as two tabs and an
  // `isCaptures`, and a third would have meant a second boolean and six
  // combinations of two that only three are legal.
  for (const t of CL_TABS) {
    const on = t.id === tab;
    const btn = clEl(t.tab);
    if (btn) {
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    const panel = clEl(t.panel);
    if (panel) panel.hidden = !on;
  }

  // The Data header's copy and its actions belong to Datasets — "Import file",
  // "Paste data", "Connect data" are all ways to make a dataset, and none of
  // them makes a capture or a metric. So the tab switch swaps the sentence and
  // hides that row rather than leaving four buttons that do nothing for what is
  // on screen.
  const actions = document.querySelector('.ds-head-actions') as HTMLElement | null;
  if (actions) actions.hidden = tab !== 'datasets';
  const metricActions = clEl('mp-actions-row');
  if (metricActions) metricActions.hidden = tab !== 'metrics';

  const sub = clEl('ds-sub');
  const entry = CL_TABS.find((t) => t.id === tab);
  if (sub && entry) sub.textContent = entry.sub;

  if (tab === 'captures') void refreshCaptureList();
  if (tab === 'metrics') void refreshMetricsList();
  if (tab === 'catalog') void ctRefreshCatalog();
}

/** Land on the Data page with the Captures tab showing — where "‹ Back" goes. */
function showCaptureList(): void {
  if (typeof selectSection === 'function') selectSection('datasets');
  clSelectTab('captures');
}

/** One capture card: thumbnail, title from the analysis, time, hover actions. */
// ponytail: a summary row straight off disk — any.
function clMakeCard(c: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'viz-card cap-card';
  card.dataset.captureId = String(c.id);
  card.dataset.recKind = 'capture'; card.dataset.recId = String(c.id); // ⌘-click → background tab (tabStrip.ts)

  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'viz-card-body';
  body.addEventListener('click', () => openCaptureFromSummary(c));

  const tile = document.createElement('div');
  tile.className = 'viz-card-tile';
  if (c.cropPath) {
    const img = document.createElement('img');
    img.className = 'cap-card-img';
    img.src = 'file://' + c.cropPath;
    img.alt = '';
    img.draggable = false;
    tile.appendChild(img);
  }
  body.appendChild(tile);

  const name = document.createElement('span');
  name.className = 'viz-card-name';
  name.textContent = c.title || 'Capture';
  body.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'viz-card-meta';
  meta.textContent = formatSidebarTime(c.updatedAt || null);
  body.appendChild(meta);
  card.appendChild(body);

  // "Dataset" says this capture already became one — the same badge the capture
  // page's header shows, so the two surfaces agree at a glance.
  if (c.datasetId) {
    const badge = document.createElement('span');
    badge.className = 'ds-source-badge cap-card-badge';
    badge.textContent = 'Dataset';
    card.appendChild(badge);
  }

  const acts = document.createElement('div');
  acts.className = 'cap-card-acts';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn-sm';
  open.textContent = 'Open';
  open.addEventListener('click', (e) => { e.stopPropagation(); openCaptureFromSummary(c); });
  acts.appendChild(open);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm';
  save.textContent = 'Save as dataset';
  // Saving needs the extracted table, which only the full record carries — so
  // this opens the capture and lets its own (gated) button do the work, rather
  // than loading every capture's result to decide whether to draw a button.
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    openCaptureFromSummary(c);
  });
  acts.appendChild(save);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-sm';
  del.textContent = 'Delete';
  del.addEventListener('click', (e) => { e.stopPropagation(); void clDelete(String(c.id)); });
  acts.appendChild(del);
  card.appendChild(acts);

  return card;
}

async function clDelete(id: string): Promise<void> {
  if (!window.confirm('Delete this capture and its analysis? This can\'t be undone.')) return;
  try {
    await window.hub.deleteThread(id);
  } catch (_) { /* the refresh below tells the truth either way */ }
  await refreshCaptureList();
}

/** Repaint the grid from disk for the active project. */
async function refreshCaptureList(): Promise<void> {
  const grid = clEl('cap-grid');
  const empty = clEl('cap-empty');
  if (!grid) return;
  let list: any[] = [];
  if (currentProjectId) {
    try {
      const res = await window.hub.listCaptures(currentProjectId);
      list = Array.isArray(res) ? res : [];
    } catch (_) { list = []; }
  }
  grid.innerHTML = '';
  list.forEach((c) => grid.appendChild(clMakeCard(c)));
  grid.hidden = list.length === 0;
  if (empty) empty.hidden = list.length > 0;
}

// ── Boot wiring (once) ────────────────────────────────────────────────────
function initCaptureList(): void {
  const dsTab = clEl('ds-tab-datasets');
  if (dsTab) dsTab.addEventListener('click', () => clSelectTab('datasets'));
  const capTab = clEl('ds-tab-captures');
  if (capTab) capTab.addEventListener('click', () => clSelectTab('captures'));
  const metricTab = clEl('ds-tab-metrics');
  if (metricTab) metricTab.addEventListener('click', () => clSelectTab('metrics'));
  const emptyNew = clEl('cap-empty-new');
  if (emptyNew) emptyNew.addEventListener('click', () => doCapture());
  // Settings → "Delete capture history" wipes the files under main; without
  // this the grid would keep showing cards whose crops no longer exist.
  if (window.hub && typeof window.hub.onCapturesCleared === 'function') {
    window.hub.onCapturesCleared(() => { void refreshCaptureList(); });
  }
  clSelectTab('datasets');
}
