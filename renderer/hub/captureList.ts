'use strict';

// The Captures tab, under Data, beside Datasets. Classic global-scope renderer
// <script>: no import/export.
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

let clActive: 'datasets' | 'captures' = 'datasets';

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
function clSelectTab(tab: 'datasets' | 'captures'): void {
  clActive = tab;
  const isCaptures = tab === 'captures';

  const dsTab = clEl('ds-tab-datasets');
  const capTab = clEl('ds-tab-captures');
  if (dsTab) {
    dsTab.setAttribute('aria-selected', String(!isCaptures));
    dsTab.tabIndex = isCaptures ? -1 : 0;
  }
  if (capTab) {
    capTab.setAttribute('aria-selected', String(isCaptures));
    capTab.tabIndex = isCaptures ? 0 : -1;
  }

  const saved = clEl('ds-saved');
  if (saved) saved.hidden = isCaptures;
  const grid = clEl('cap-grid-wrap');
  if (grid) grid.hidden = !isCaptures;
  const actions = document.querySelector('.ds-head-actions') as HTMLElement | null;
  if (actions) actions.hidden = isCaptures;

  const sub = clEl('ds-sub');
  if (sub) {
    sub.textContent = isCaptures
      ? 'Screenshots you analyzed in this project. Save the ones that carry a table as a dataset.'
      : 'Import CSV, JSON, or Excel — or paste data — to save a structured dataset in this project.';
  }

  if (isCaptures) void refreshCaptureList();
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
  const emptyNew = clEl('cap-empty-new');
  if (emptyNew) emptyNew.addEventListener('click', () => doCapture());
  // Settings → "Delete capture history" wipes the files under main; without
  // this the grid would keep showing cards whose crops no longer exist.
  if (window.hub && typeof window.hub.onCapturesCleared === 'function') {
    window.hub.onCapturesCleared(() => { void refreshCaptureList(); });
  }
  clSelectTab('datasets');
}
