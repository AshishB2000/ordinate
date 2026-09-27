'use strict';

// The command palette — one box that reaches everything: the commands in the
// registry (commands.ts) and the records in every project (search:query).
//
// It replaces the top bar's own results dropdown rather than sitting beside it.
// That box searched records only, so "where is Present?" had no answer anywhere
// in the app, and the ⌘K it advertised merely moved the caret. Focusing the
// same input now opens this, so the chrome keeps its promise and there is ONE
// answer to "find me a thing" instead of two half-answers.
//
// Prefixes: `>` commands only, `/` records only, `@` the open dataset's columns
// (and, on an open dashboard, a typed filter: `@west technology`).
//
// This file is the BOX — open, close, keyboard, paint — plus the shortcuts
// sheet, which is the same overlay block reading the same registry. What a row
// says and does is paletteRows.ts.
//
// Classic global-scope renderer <script>: no import/export.

const CP_DEBOUNCE_MS = 120;
/** Enough to fill the box without scrolling past what a glance takes in. */
const CP_MAX_COMMANDS = 8;

let cpGroups: CpGroup[] = [];
let cpFlat: CpRow[] = [];
let cpSel = 0;
let cpSeq = 0;
let cpTimer: number | null = null;
/** The record whose secondary actions are showing, if any (→ opened them). */
let cpActionsFor: CpRecord | null = null;

function cpEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── Open / close ─────────────────────────────────────────────────────────────

function paletteIsOpen(): boolean {
  const o = cpEl('cp-overlay');
  return !!o && !o.hidden;
}

function paletteOpen(prefill = ''): void {
  const overlay = cpEl('cp-overlay');
  const input = cpEl<HTMLInputElement>('cp-input');
  if (!overlay || !input) return;
  cpActionsFor = null;
  overlay.hidden = false;
  input.value = prefill;
  input.focus();
  input.select();
  void cpRefresh();
}

function paletteClose(): void {
  const overlay = cpEl('cp-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  cpSeq++; // a reply still in flight must not repaint a closed box
  cpGroups = [];
  cpFlat = [];
  cpActionsFor = null;
  const input = cpEl<HTMLInputElement>('cp-input');
  if (input) input.value = '';
  // The top bar's input is what opens this on focus, so leaving focus there
  // would re-open it the moment the user pressed anything.
  const search = cpEl<HTMLInputElement>('global-search');
  if (search && document.activeElement === search) search.blur();
}

/**
 * Close the top-most layer this file owns, and say whether it closed one.
 * Escape is shared with the dock and every modal, so an unclaimed Escape has to
 * fall through unprevented (commands.ts).
 */
function paletteCloseTop(): boolean {
  if (cpSheetIsOpen()) { paletteHideShortcuts(); return true; }
  if (paletteIsOpen()) {
    // → opened an action list; Escape steps back out of it first.
    if (cpActionsFor) { cpActionsFor = null; void cpRefresh(); return true; }
    paletteClose();
    return true;
  }
  return false;
}

// ── The refresh ──────────────────────────────────────────────────────────────

async function cpRefresh(): Promise<void> {
  const input = cpEl<HTMLInputElement>('cp-input');
  if (!input) return;
  const seq = ++cpSeq;

  if (cpActionsFor) { cpPaint(cpActionGroups(cpActionsFor)); return; }

  const raw = input.value;
  const prefix = raw.charAt(0);
  const mode = prefix === '>' ? 'commands' : prefix === '/' ? 'records' : prefix === '@' ? 'columns' : 'all';
  const q = (mode === 'all' ? raw : raw.slice(1)).trim();

  if (mode === 'columns') {
    // With a dashboard open, `@west` is first a typed filter (filterTypeApply.ts).
    const typed = typeof ftPaletteGroups === 'function' ? await ftPaletteGroups(q) : [];
    if (seq !== cpSeq) return;
    cpPaint(typed.concat(cpColumnGroups(q)));
    return;
  }

  const groups: CpGroup[] = [];

  if (!q) {
    // Nothing typed: what you were just working on, then what you can do here.
    const ctx = cpContextGroup();
    if (ctx) groups.push(ctx);
    const chart = cpChartSuggestions();
    if (chart) groups.push(chart);
    if (mode !== 'commands') {
      const recent = await cpRecent();
      if (seq !== cpSeq) return;
      if (recent.length) groups.push({ label: 'Recent', rows: recent.map(cpRecordRow) });
    }
    groups.push({ label: 'Commands', rows: searchCommands('').slice(0, CP_MAX_COMMANDS).map(cpCommandRow) });
    cpPaint(groups);
    return;
  }

  if (mode !== 'records') {
    const cmds = searchCommands(q).slice(0, CP_MAX_COMMANDS);
    if (cmds.length) groups.push({ label: 'Commands', rows: cmds.map(cpCommandRow) });
  }

  // `#sales` — the tag itself first, then (below) the records that carry it.
  if (mode === 'all' && q.charAt(0) === '#') {
    await ctLoadTags();
    if (seq !== cpSeq) return;
    const tags = cpTagGroup(q);
    if (tags) groups.push(tags);
  }

  // Paint the synchronous half at once — the records arrive a round trip later,
  // and a box that shows nothing until then reads as a freeze.
  cpPaint(groups.slice());

  if (mode !== 'commands') {
    const hits = await cpSearchRecords(q);
    if (seq !== cpSeq) return;
    if (hits.length) groups.push({ label: 'Results', rows: hits.map(cpRecordRow) });
    cpPaint(groups);
  }
}

async function cpRecent(): Promise<CpRecord[]> {
  try {
    const list = await window.hub.recentItems(6);
    return (Array.isArray(list) ? list : []).map(cpToRecord);
  } catch (_) { return []; }
}

async function cpSearchRecords(q: string): Promise<CpRecord[]> {
  try {
    // '' scopes to EVERY project — the palette opens on Home too, where there
    // is no active one (src/ipc/search.ts).
    const res: any = await window.hub.searchWorkspace(currentProjectId || '', q);
    const hits = res && res.ok && Array.isArray(res.results) ? res.results : [];
    return hits.map(cpToRecord);
  } catch (_) { return []; }
}

// ── Painting ─────────────────────────────────────────────────────────────────

function cpPaint(groups: CpGroup[]): void {
  const box = cpEl('cp-results');
  if (!box) return;
  cpGroups = groups.filter((g) => g.rows.length);
  cpFlat = [];
  box.innerHTML = '';

  if (!cpGroups.length) {
    const none = makeEmptyState({
      variant: 'search',
      iconName: 'search',
      title: 'No matches',
      line: 'Try a shorter word, or > for commands, / for your data and # for tags.',
    });
    none.classList.add('cp-none');
    box.appendChild(none);
    cpSel = 0;
    return;
  }

  cpGroups.forEach((g) => {
    const label = document.createElement('div');
    label.className = 'cp-group';
    label.textContent = g.label;
    box.appendChild(label);
    g.rows.forEach((r) => {
      const i = cpFlat.length;
      cpFlat.push(r);
      box.appendChild(cpRowEl(r, i));
    });
  });

  if (cpSel >= cpFlat.length) cpSel = 0;
  cpHighlight();
}

function cpRowEl(r: CpRow, i: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cp-row';
  row.id = 'cp-row-' + i;
  row.setAttribute('role', 'option');
  row.appendChild(icon(r.icon, 16));

  const title = document.createElement('span');
  title.className = 'cp-row-title';
  title.textContent = r.title;
  row.appendChild(title);

  if (r.chips && r.chips.length) row.appendChild(ctTagChips(r.chips, 3));

  const meta = document.createElement('span');
  meta.className = 'cp-row-meta';
  meta.textContent = r.meta;
  row.appendChild(meta);

  if (r.keys) {
    const k = document.createElement('span');
    k.className = 'kbd cp-row-key';
    k.textContent = r.keys;
    row.appendChild(k);
  } else if (r.record) {
    const more = document.createElement('span');
    more.className = 'cp-row-more';
    more.textContent = '→';
    more.title = 'More actions';
    row.appendChild(more);
  }

  // mousedown, not click: the input's blur would tear the list down first.
  row.addEventListener('mousedown', (e) => { e.preventDefault(); cpSel = i; cpRun(); });
  row.addEventListener('mousemove', () => { if (cpSel !== i) { cpSel = i; cpHighlight(); } });
  return row;
}

function cpHighlight(): void {
  const box = cpEl('cp-results');
  const input = cpEl('cp-input');
  if (!box) return;
  const rows = box.querySelectorAll('.cp-row');
  rows.forEach((el, i) => {
    const on = i === cpSel;
    el.classList.toggle('is-sel', on);
    el.setAttribute('aria-selected', String(on));
    if (on) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
  if (input) {
    if (cpFlat.length) input.setAttribute('aria-activedescendant', 'cp-row-' + cpSel);
    else input.removeAttribute('aria-activedescendant');
  }
}

function cpMove(delta: number): void {
  if (!cpFlat.length) return;
  cpSel = (cpSel + delta + cpFlat.length) % cpFlat.length;
  cpHighlight();
}

function cpRun(): void {
  const row = cpFlat[cpSel];
  if (row) row.run();
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

function cpKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') { e.preventDefault(); cpMove(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); cpMove(-1); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const row = cpFlat[cpSel];
    if (row && row.record && (e.metaKey || e.ctrlKey)) {
      const rec = row.record;
      paletteClose();
      void paletteOpenInDock(rec);
      return;
    }
    cpRun();
    return;
  }
  if (e.key === 'ArrowRight') {
    const row = cpFlat[cpSel];
    const input = cpEl<HTMLInputElement>('cp-input');
    // Only when the caret is at the end — otherwise → is still how you move
    // through what you typed.
    if (row && row.record && input && input.selectionStart === input.value.length) {
      e.preventDefault();
      cpActionsFor = row.record;
      cpSel = 0;
      void cpRefresh();
    }
    return;
  }
  if (e.key === 'ArrowLeft' && cpActionsFor) {
    const input = cpEl<HTMLInputElement>('cp-input');
    if (input && input.selectionStart === 0) {
      e.preventDefault();
      cpActionsFor = null;
      cpSel = 0;
      void cpRefresh();
    }
  }
}

// ── The shortcuts sheet ──────────────────────────────────────────────────────
// Rendered from the registry, so it cannot describe a binding the app does not
// have. Every command, not just the available ones: the sheet is documentation.

function cpSheetIsOpen(): boolean {
  const s = cpEl('cp-sheet');
  return !!s && !s.hidden;
}

function paletteShowShortcuts(): void {
  const sheet = cpEl('cp-sheet');
  if (!sheet) return;
  paletteClose();
  sheet.hidden = false;
  const search = cpEl<HTMLInputElement>('cp-sheet-search');
  if (search) { search.value = ''; search.focus(); }
  cpPaintSheet('');
}

function paletteHideShortcuts(): void {
  const sheet = cpEl('cp-sheet');
  if (sheet) sheet.hidden = true;
}

function cpPaintSheet(query: string): void {
  const body = cpEl('cp-sheet-body');
  if (!body) return;
  body.innerHTML = '';
  const all = listCommands(false).filter((c) => (query ? cmdScore(query, c) >= 0 : true));
  let printed = 0;
  CMD_GROUPS.forEach((group) => {
    const rows = all.filter((c) => c.group === group);
    if (!rows.length) return;
    const label = document.createElement('div');
    label.className = 'cp-group';
    label.textContent = group;
    body.appendChild(label);
    rows.forEach((c) => {
      printed++;
      const row = document.createElement('div');
      row.className = 'cp-sheet-row';
      const name = document.createElement('span');
      name.className = 'cp-sheet-name';
      name.textContent = c.title;
      row.appendChild(name);
      const keys = keyLabel(c.keys);
      if (keys) {
        const k = document.createElement('span');
        k.className = 'kbd';
        k.textContent = keys;
        row.appendChild(k);
      }
      body.appendChild(row);
    });
  });
  if (!printed) {
    const none = document.createElement('div');
    none.className = 'cp-sheet-none';
    none.textContent = 'No command matches that.';
    body.appendChild(none);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initPalette(): void {
  const input = cpEl<HTMLInputElement>('cp-input');
  const overlay = cpEl('cp-overlay');
  if (!input || !overlay) return;

  input.addEventListener('input', () => {
    if (cpTimer) window.clearTimeout(cpTimer);
    cpSel = 0;
    // The prefix modes and the empty state answer from memory, so they repaint
    // at once; only a record query is worth waiting a beat for.
    const wait = input.value.trim() && input.value.charAt(0) !== '>' && input.value.charAt(0) !== '@';
    if (!wait) { void cpRefresh(); return; }
    cpTimer = window.setTimeout(() => { cpTimer = null; void cpRefresh(); }, CP_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', cpKeydown);

  // Clicking the backdrop dismisses; clicking the box does not.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) paletteClose(); });

  // The top bar's search input IS the palette's other door: focusing it opens
  // this. The input itself is untouched (it keeps its placeholder, its ⌘K hint
  // and its styling) — only what happens when you land in it changed.
  const search = cpEl<HTMLInputElement>('global-search');
  if (search) {
    search.addEventListener('focus', () => { if (!paletteIsOpen()) paletteOpen(''); });
    search.addEventListener('mousedown', (e) => {
      // Without this a click focuses the input, opens the palette, and then the
      // same click lands in the box behind it.
      e.preventDefault();
      paletteOpen('');
    });
  }

  const sheetSearch = cpEl<HTMLInputElement>('cp-sheet-search');
  if (sheetSearch) sheetSearch.addEventListener('input', () => cpPaintSheet(sheetSearch.value));
  const sheetX = cpEl('cp-sheet-x');
  if (sheetX) sheetX.addEventListener('click', () => paletteHideShortcuts());
  const sheet = cpEl('cp-sheet');
  if (sheet) sheet.addEventListener('mousedown', (e) => { if (e.target === sheet) paletteHideShortcuts(); });
}
