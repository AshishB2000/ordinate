'use strict';

// Explore's context picker — WHAT the next question is about. Classic
// global-scope renderer <script>; no import/export. Split from explore.ts
// (which owns the surface, the state and the ask) because this is a separate
// job: choosing one entity out of the whole workspace.
//
// It searches with window.hub.searchWorkspace — the SAME `search:query` channel
// the sidebar's search box uses (src/ipc/search.ts, names only, no row contents
// read). CONNECTIONS ARE FILTERED OUT: a saved connection is a route to data,
// not data, so there is nothing to ask about it and offering it would only
// produce a project-inventory answer under a chip claiming otherwise.
//
// Empty query shows the most recent handful instead of nothing, from explore.ts's
// xpRecentItems() — the one recent-list loader the jump strip already uses — cut
// to THIS project, because copilot:ask is scoped to currentProjectId and an
// entity from another project would resolve to nothing.
//
// Rows reuse the .gs-* row classes and GS_GLYPH from globalSearch.ts: one hit-row
// look and one kind-glyph vocabulary across the app, not two.

/** Same debounce as the sidebar's box — a picker that searches per keystroke is
 *  a picker that flickers. */
const XP_PICK_DEBOUNCE_MS = 150;

/** Empty-query suggestions. A handful, not a list to scroll. */
const XP_PICK_RECENT = 6;

interface XpPickRow { kind: string; id: string; name: string; sub: string }

/** The always-available clear, pinned at the top of every result set. */
const XP_WHOLE_PROJECT: XpPickRow = {
  kind: '', id: '', name: 'Whole project', sub: 'everything in this project',
};

let xpPickTimer: number | null = null;
let xpPickSeq = 0;
let xpPickRows: XpPickRow[] = [];
let xpPickActive = 0;

function xpClosePicker(): void {
  const box = xpEl('xp-picker');
  if (box) box.hidden = true;
  xpPickRows = [];
  xpPickActive = 0;
  xpPickSeq++; // any in-flight search that lands after this is discarded
}

function xpPickPaint(): void {
  const host = xpEl('xp-picker-rows');
  if (!host) return;
  host.textContent = '';
  xpPickRows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'gs-hit' + (i === xpPickActive ? ' is-active' : '');
    row.id = 'xp-pick-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === xpPickActive));

    const glyph = document.createElement('span');
    glyph.className = 'gs-glyph';
    glyph.textContent = (r.kind && GS_GLYPH[r.kind]) || '◈';
    const name = document.createElement('span');
    name.className = 'gs-name';
    name.textContent = r.name;
    const sub = document.createElement('span');
    sub.className = 'gs-sub';
    sub.textContent = r.kind ? (r.sub ? r.kind + ' · ' + r.sub : r.kind) : r.sub;

    row.append(glyph, name, sub);
    // mousedown, not click: the input's blur would otherwise close the list out
    // from under the pointer.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); xpPickChoose(i); });
    host.appendChild(row);
  });

  const input = xpEl('xp-picker-q');
  if (input) input.setAttribute('aria-activedescendant', 'xp-pick-' + xpPickActive);
}

/** Whole project + whatever matched, with the active row reset to the top. */
function xpPickShow(rows: XpPickRow[]): void {
  xpPickRows = [XP_WHOLE_PROJECT].concat(rows);
  xpPickActive = 0;
  xpPickPaint();
}

/** Empty query — the most recent handful in THIS project. */
async function xpPickRecent(): Promise<void> {
  const seq = ++xpPickSeq;
  const items = await xpRecentItems();
  if (seq !== xpPickSeq) return;
  xpPickShow(
    items
      .filter((it: any) => String(it && it.projectId ? it.projectId : '') === currentProjectId)
      .slice(0, XP_PICK_RECENT)
      .map((it: any) => ({
        kind: String(it.type || ''),
        id: String(it.id || ''),
        name: String(it.name || 'Untitled'),
        sub: 'recent',
      }))
      .filter((r: XpPickRow) => r.kind !== '' && r.id !== ''),
  );
}

async function xpPickSearch(query: string): Promise<void> {
  const seq = ++xpPickSeq;
  let res: any;
  try {
    res = await window.hub.searchWorkspace(currentProjectId, query);
  } catch (_) {
    res = { ok: false };
  }
  if (seq !== xpPickSeq) return; // a later keystroke already won
  const hits: XpPickRow[] = res && res.ok && Array.isArray(res.results) ? res.results : [];
  xpPickShow(hits.filter((h) => h.kind !== 'connection'));
}

/** Commit row i as Explore's scope and close. */
function xpPickChoose(i: number): void {
  const r = xpPickRows[i];
  if (!r) return;
  xpSetContext(r.kind, r.id, r.name);
  xpClosePicker();
  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (input && !input.disabled) input.focus();
}

/** Open the picker from the context chip. Called by explore.ts. */
async function xpOpenContextPicker(): Promise<void> {
  const box = xpEl('xp-picker');
  const input = xpEl<HTMLInputElement>('xp-picker-q');
  if (!box || !input) return;
  if (!box.hidden) { xpClosePicker(); return; } // a second click closes it
  input.value = '';
  box.hidden = false;
  xpPickShow([]); // the pinned clear is on screen before the first await
  input.focus();
  await xpPickRecent();
}

function initExplorePicker(): void {
  const box = xpEl('xp-picker');
  const input = xpEl<HTMLInputElement>('xp-picker-q');
  if (!box || !input) return;

  input.addEventListener('input', () => {
    if (xpPickTimer) window.clearTimeout(xpPickTimer);
    const q = input.value;
    if (!q.trim()) { void xpPickRecent(); return; }
    xpPickTimer = window.setTimeout(() => {
      xpPickTimer = null;
      void xpPickSearch(q);
    }, XP_PICK_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); xpClosePicker(); return; }
    if (!xpPickRows.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      xpPickActive = (xpPickActive + 1) % xpPickRows.length;
      xpPickPaint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      xpPickActive = (xpPickActive - 1 + xpPickRows.length) % xpPickRows.length;
      xpPickPaint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      xpPickChoose(xpPickActive);
    }
  });

  // Clicking anywhere else dismisses. Capture, so a click that also does
  // something else still closes the picker first — which is exactly why the
  // CHIP is excluded: this handler runs before the chip's own, so without the
  // exclusion a second click on the chip would close and immediately reopen the
  // picker instead of toggling it shut.
  document.addEventListener('click', (e) => {
    if (box.hidden) return;
    const t = e.target as Node;
    const chip = xpEl('xp-context-chip');
    if (box.contains(t) || (chip && chip.contains(t))) return;
    xpClosePicker();
  }, true);
}
