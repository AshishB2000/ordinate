'use strict';

// The sidebar's global search box. Classic global-scope renderer <script>.
//
// `#global-search` and `#global-search-results` have been in index.html since
// the shell was built, promising "datasets, analyses, dashboards and connectors"
// — and no renderer file referenced either of them. This wires the promise.
//
// NAMES ONLY, decided in main (src/ipc/search.ts).
// ponytail: names only; content search is a different feature with a different cost
//
// Navigation calls the SAME open functions the sections use — openSavedDataset,
// openSavedVisual, openAnalysis, openDashboard, selectSection. Nothing new is
// invented here: a second way to open a dashboard would be a second thing to
// keep working.
//
// It is a real listbox: arrow keys move, Enter opens, Escape closes, and
// aria-activedescendant follows the highlight, so it is not mouse-only.

const GS_DEBOUNCE_MS = 150;

interface GsHit { kind: string; id: string; name: string; sub: string }

let gsTimer: number | null = null;
let gsSeq = 0;
let gsHits: GsHit[] = [];
let gsActive = -1;

/** One glyph per kind, from the vocabulary already used across the app. */
const GS_GLYPH: Record<string, string> = {
  dataset: '▦',
  visual: '▮',
  analysis: '◫',
  dashboard: '▤',
  connection: '⚯',
};

function gsEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function gsClose(): void {
  const box = gsEl('global-search-results');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  gsHits = [];
  gsActive = -1;
  const input = gsEl('global-search');
  if (input) input.removeAttribute('aria-activedescendant');
}

function gsPaint(): void {
  const box = gsEl('global-search-results');
  const input = gsEl('global-search');
  if (!box) return;
  box.innerHTML = '';
  box.setAttribute('role', 'listbox');

  if (!gsHits.length) {
    const none = document.createElement('div');
    none.className = 'gs-none';
    none.textContent = 'No matches.';
    box.appendChild(none);
    box.hidden = false;
    if (input) input.removeAttribute('aria-activedescendant');
    return;
  }

  gsHits.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'gs-hit' + (i === gsActive ? ' is-active' : '');
    row.id = 'gs-hit-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === gsActive));

    const glyph = document.createElement('span');
    glyph.className = 'gs-glyph';
    glyph.textContent = GS_GLYPH[h.kind] || '•';
    const name = document.createElement('span');
    name.className = 'gs-name';
    name.textContent = h.name;
    const sub = document.createElement('span');
    sub.className = 'gs-sub';
    sub.textContent = h.sub ? `${h.kind} · ${h.sub}` : h.kind;

    row.appendChild(glyph);
    row.appendChild(name);
    row.appendChild(sub);
    // mousedown, not click: the input's blur would close the list first.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); void gsOpen(i); });
    box.appendChild(row);
  });

  box.hidden = false;
  if (input && gsActive >= 0) input.setAttribute('aria-activedescendant', 'gs-hit-' + gsActive);
  else if (input) input.removeAttribute('aria-activedescendant');
}

async function gsRun(query: string): Promise<void> {
  const seq = ++gsSeq;
  if (!query.trim() || !currentProjectId) { gsClose(); return; }
  let res: any;
  try {
    res = await window.hub.searchWorkspace(currentProjectId, query);
  } catch (_) {
    res = { ok: false };
  }
  if (seq !== gsSeq) return; // a later keystroke already won
  gsHits = (res && res.ok && Array.isArray(res.results)) ? res.results : [];
  gsActive = gsHits.length ? 0 : -1;
  gsPaint();
}

/** Go where a hit points, through the section's own open function. */
async function gsOpen(i: number): Promise<void> {
  const h = gsHits[i];
  if (!h) return;
  const input = gsEl<HTMLInputElement>('global-search');
  gsClose();
  if (input) input.value = '';
  switch (h.kind) {
    case 'dataset':
      selectSection('datasets');
      await openSavedDataset(h.id);
      break;
    case 'visual':
      selectSection('visuals');
      await openSavedVisual(h.id);
      break;
    case 'analysis':
      selectSection('analyses');
      await openAnalysis(h.id);
      break;
    case 'dashboard':
      selectSection('dashboards');
      await openDashboard(h.id);
      break;
    case 'connection':
      // Connections have no per-record open surface; the panel is the answer.
      selectSection('connections');
      break;
    default:
      break;
  }
}

function initGlobalSearch(): void {
  const input = gsEl<HTMLInputElement>('global-search');
  const box = gsEl('global-search-results');
  if (!input || !box) return;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'global-search-results');

  input.addEventListener('input', () => {
    if (gsTimer) window.clearTimeout(gsTimer);
    const q = input.value;
    if (!q.trim()) { gsSeq++; gsClose(); return; } // empty query → hidden, at once
    gsTimer = window.setTimeout(() => { gsTimer = null; void gsRun(q); }, GS_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { gsClose(); return; }
    if (!gsHits.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      gsActive = (gsActive + 1) % gsHits.length;
      gsPaint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      gsActive = (gsActive - 1 + gsHits.length) % gsHits.length;
      gsPaint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void gsOpen(gsActive < 0 ? 0 : gsActive);
    }
  });

  // Clicking anywhere else closes it. Capture, so a click that also does
  // something else still dismisses first.
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (input.contains(t) || box.contains(t)) return;
    gsClose();
  }, true);

  new MutationObserver(() => {
    input.setAttribute('aria-expanded', String(!box.hidden));
  }).observe(box, { attributes: true, attributeFilter: ['hidden'] });
}
