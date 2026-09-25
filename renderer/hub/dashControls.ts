// THE THREE CONTROL WIDGETS — a native dropdown, a checkbox-list popover and a
// date pair — plus the value helpers around them. A control's live selection
// feeds `effectiveFilters()` (dashboards.ts) and therefore every other card's
// compute. Split out of dashGrid.ts because a checkbox-list popover is real UI
// code, not a one-branch dispatch.
//
// WHERE a widget sits is dashControlBar.ts's job, not this file's. Controls
// used to be grid tiles and each widget rendered into a card body; they are
// chips in the filter bar above the grid now, and `makeControlChip` there calls
// the same three functions below with the same (card, wrap) contract. Nothing
// here knows which it is.
//
// Classic global-scope renderer <script>: no import/export. Loads AFTER
// dashFiltersUi.js (shares dashEl/dashShow/dashCardMissing/renderDashGrid/
// controlState/dashCurrent, and the `.fd-*` checkbox-list classes this file's
// multi popover reuses) and before dashControlBar.js.
//
// INTERACTION HERE IS NEVER GATED BY dashReadOnly. A published dashboard's
// controls stay fully usable — filtering is a read, not a mutation of the
// snapshot. Only card STRUCTURE (Edit / Set as default / Remove, in the chip's
// ⋯ menu) is gated, by the `.dash-editor--readonly .dash-fb-chip-menu` rule in
// hub.css — the same rule `.dash-card-ctrls` already follows.
//
// Changing a control's value NEVER calls markDashDirty(): `controlState` is a
// plain in-memory Map (dashboards.ts), reset every time a sheet opens or
// closes, and must never reach a persisted dashboard/analysis record. The
// pattern mirrors dashFiltersUi.ts's afterDashFilterChange minus the
// dirty/save half: write the Map, then renderDashGrid() — synchronous, no
// debounce, exactly like cross-filter's click handler.

// ── Value helpers ────────────────────────────────────────────────────────────
// The kind-shaped "nothing selected" ControlValue — what an unset control
// reads as, and what a kind falls back to when it has no author-set default.
function controlEmptyValue(kind: string): any {
  if (kind === 'multi') return { values: [] };
  if (kind === 'date_range') return {};
  return { value: '' };
}

function controlDefaultValue(control: any): any {
  return (control && control.default) || controlEmptyValue(control && control.kind);
}

function controlCurrentValue(card: any): any {
  const v = controlState.get(card.id);
  return v === undefined ? controlEmptyValue(card.control && card.control.kind) : v;
}

// Whether the card's live selection matches its published default (or the
// kind's empty value, when it has none) — what "Reset controls" asks, as
// against the filter bar's "is anything selected at all". `controlState` never
// held anything but plain JSON-shaped objects (ControlValue), so a stringify
// compare is enough — no deep-equal library earns its keep for three fields.
function controlIsAtDefault(card: any): boolean {
  const cur = controlState.get(card.id);
  if (cur === undefined) return true;
  return JSON.stringify(cur) === JSON.stringify(controlDefaultValue(card.control));
}

// Every control card on the OPEN record, across all pages — a control is
// dashboard-wide (mirrors effectiveFilters/dashSheetDatasetIds' "every page"
// scan), even though the widget itself only ever sits on one page.
function allControlCards(): any[] {
  if (!dashCurrent || !Array.isArray(dashCurrent.pages)) return [];
  const out: any[] = [];
  for (const page of dashCurrent.pages) {
    const cards = page && Array.isArray(page.cards) ? page.cards : [];
    for (const card of cards) {
      if (card && card.type === 'control' && card.control) out.push(card);
    }
  }
  return out;
}

function anyControlNonDefault(): boolean {
  return allControlCards().some((c) => !controlIsAtDefault(c));
}

/** One click back to the published view: every control card reverts to its
 *  author-set default (or unset, if it has none). */
function resetAllControls(): void {
  allControlCards().forEach((card) => {
    if (card.control.default) controlState.set(card.id, card.control.default);
    else controlState.delete(card.id);
  });
  renderDashGrid();
}

// Called at the end of every renderDashGrid() (dashGrid.ts): whether ANY
// control differs from its default can change on any card's interaction, so
// this stays a derived read rather than tracked state of its own.
//
// The `some(default)` half is not a subtlety — it is what stops two buttons
// saying the same thing. The filter bar's "Clear all" clears every control to
// All; this one returns them to what the AUTHOR published. When no control HAS
// a published default the two are the same click, and showing both is clutter
// that makes the reader guess which is which. So this appears only once a
// default exists to go back to.
function updateResetControlsBtn(): void {
  const cards = allControlCards();
  dashShow('dash-reset-controls', anyControlNonDefault() && cards.some((c) => c.control && c.control.default));
}

// ── Dropdown ─────────────────────────────────────────────────────────────────
// A native <select> — no custom widget earns its keep here (unlike the model
// pickers customDropdown.ts serves, a filter's option list doesn't need
// height-capping or a fixed-position escape from clipping). A native <select>
// has no true "before the popup renders" hook, so this can't be as lazy as the
// multi popover below (which opens on an explicit click into a div this file
// owns) — but `focus`/`mousedown` both fire before the OS paints the native
// list, so starting the fetch there gets meaningfully closer to "on first
// open" than loading unconditionally at render time. A control the reader
// never focuses never queries. One brief loading flash on the very first open
// is the accepted trade-off; loaded once, never re-fetched.
function renderDropdownControl(card: any, wrap: HTMLElement): void {
  const control = card.control;
  const cur = controlCurrentValue(card);

  const sel = document.createElement('select');
  sel.className = 'dash-ctrl-select';
  sel.setAttribute('aria-label', control.label || 'Filter');
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All';
  sel.appendChild(all);
  // The current/default value shows as selected text immediately, even before
  // the real option list loads — never a blank "All" while a real selection
  // is in effect.
  if (cur.value) {
    const cur0 = document.createElement('option');
    cur0.value = cur.value;
    cur0.textContent = cur.value;
    sel.appendChild(cur0);
    sel.value = cur.value;
  }
  wrap.appendChild(sel);

  const note = document.createElement('p');
  note.className = 'fd-note dash-ctrl-note';
  wrap.appendChild(note);

  sel.addEventListener('change', () => {
    controlState.set(card.id, { value: sel.value });
    renderDashGrid();
  });

  let loaded = false;
  function loadOptions(): void {
    if (loaded || !currentProjectId) return;
    loaded = true;
    (async () => {
      let res: any = null;
      try {
        res = await window.hub.datasetDistinct(currentProjectId as string, control.datasetId, control.column, 500);
      } catch (_) {
        res = null;
      }
      // The card may have been torn down (a DIFFERENT control's change
      // re-rendered the whole grid) by the time this resolves — a detached
      // <select> is harmless to keep populating, but there's nothing to show.
      const values: string[] = res && Array.isArray(res.values) ? res.values : [];
      const total = res && typeof res.total === 'number' ? res.total : values.length;
      const keep = sel.value; // the placeholder <option> above, if one was added
      values.forEach((v) => {
        if (v === keep) return; // already present as the placeholder — no duplicate
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });
      // Still might not be among the loaded page (a capped list, or a default
      // set against a value since removed from the data) — the placeholder
      // <option> added at render time already covers that; nothing more to do.
      sel.value = cur.value || '';
      if (total > values.length) note.textContent = 'Showing ' + values.length + ' of ' + total + '.';
    })();
  }
  sel.addEventListener('focus', loadOptions);
  sel.addEventListener('mousedown', loadOptions);
}

// ── Multi (checkbox-list popover) ───────────────────────────────────────────
// A body-mounted, fixed-position popover — same escape-from-clipping
// technique as customDropdown.ts's `.dd-list` (the card body is
// `overflow: auto`, which would otherwise clip an in-flow dropdown), painted
// with the SAME checkbox-list-with-search UX as filterDialog.ts's `values`
// mode (search → debounced dataset:distinct, Select all shown / Clear
// selection, a truncation note) — `paintValues`/`loadValues` there are
// private closures inside that modal's factory, not an exported widget, so
// this is a focused rebuild rather than a refactor into a shared component.
//
// Options load LAZILY, on first popover open — unlike the dropdown above, a
// custom popover has a real "open" moment to hook, so a control the reader
// never touches never costs a query.
let openControlPopover: (() => void) | null = null; // at most one open at a time

function renderMultiControl(card: any, wrap: HTMLElement): void {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'dash-ctrl-chip';
  chip.setAttribute('aria-haspopup', 'dialog');
  wrap.appendChild(chip);

  function paintChip(): void {
    const cur = controlCurrentValue(card);
    const n = Array.isArray(cur.values) ? cur.values.length : 0;
    chip.textContent = n > 0 ? n + ' selected' : 'All';
  }
  paintChip();

  chip.addEventListener('click', () => openMultiControlPopover(card, chip));
}

function openMultiControlPopover(card: any, anchor: HTMLElement): void {
  if (openControlPopover) openControlPopover();
  const control = card.control;
  const cur = controlCurrentValue(card);
  // Independent of what the list currently shows — typing in the search box
  // must never silently drop a value picked before the search narrowed it out.
  const selected = new Set<string>(Array.isArray(cur.values) ? cur.values.map((v: any) => String(v)) : []);

  const pop = document.createElement('div');
  pop.className = 'dash-ctrl-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', (control.label || 'Filter') + ' values');

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ws-modal-input fd-search';
  search.placeholder = 'Search values…';
  search.setAttribute('aria-label', 'Search values');
  pop.appendChild(search);

  const bulk = document.createElement('div');
  bulk.className = 'fd-bulk';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'fd-link';
  allBtn.textContent = 'Select all shown';
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'fd-link';
  noneBtn.textContent = 'Clear selection';
  bulk.appendChild(allBtn);
  bulk.appendChild(noneBtn);
  pop.appendChild(bulk);

  const list = document.createElement('div');
  list.className = 'fd-list';
  pop.appendChild(list);

  const note = document.createElement('p');
  note.className = 'fd-note';
  pop.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'dash-ctrl-popover-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary btn-sm';
  applyBtn.textContent = 'Apply';
  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  pop.appendChild(actions);

  let searchTimer: number | null = null;
  let seq = 0;
  let lastTotal = 0;
  let lastShown = 0;

  function paintNote(): void {
    const parts: string[] = [];
    if (lastTotal > lastShown) parts.push('Showing ' + lastShown + ' of ' + lastTotal + ' — search to narrow.');
    if (selected.size > 0) parts.push(selected.size + ' selected.');
    note.textContent = parts.join(' ');
  }

  async function loadValues(): Promise<void> {
    const mySeq = ++seq;
    list.textContent = 'Loading…';
    let res: any = null;
    try {
      res = await window.hub.datasetDistinct(currentProjectId as string, control.datasetId, control.column, 200, search.value);
    } catch (_) {
      res = null;
    }
    if (mySeq !== seq) return; // a slower earlier request must not overwrite a newer answer
    const values: string[] = res && Array.isArray(res.values) ? res.values : [];
    lastTotal = res && typeof res.total === 'number' ? res.total : values.length;
    lastShown = values.length;
    list.innerHTML = '';
    if (values.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'fd-empty';
      empty.textContent = search.value ? 'No values match that search.' : 'This column has no values to filter on.';
      list.appendChild(empty);
    }
    values.forEach((v) => {
      const row = document.createElement('label');
      row.className = 'fd-opt';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = v;
      cb.checked = selected.has(v);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(v);
        else selected.delete(v);
        paintNote();
      });
      const span = document.createElement('span');
      span.className = 'fd-opt-label';
      span.textContent = v;
      row.appendChild(cb);
      row.appendChild(span);
      list.appendChild(row);
    });
    paintNote();
    position();
  }

  search.addEventListener('input', () => {
    // Debounced: every keystroke is a query against main.
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { void loadValues(); }, 250);
  });
  allBtn.addEventListener('click', () => {
    list.querySelectorAll('input[type=checkbox]').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.checked = true;
      selected.add(cb.value);
    });
    paintNote();
  });
  noneBtn.addEventListener('click', () => {
    selected.clear();
    list.querySelectorAll('input[type=checkbox]').forEach((el) => { (el as HTMLInputElement).checked = false; });
    paintNote();
  });

  function position(): void {
    const r = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 8;
    pop.style.minWidth = Math.max(r.width, 220) + 'px';
    const left = Math.min(r.left, vw - margin - 260);
    pop.style.left = Math.max(margin, left) + 'px';
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    if (spaceBelow >= 260 || spaceBelow >= spaceAbove) {
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.bottom = 'auto';
    } else {
      pop.style.bottom = (vh - r.top + 4) + 'px';
      pop.style.top = 'auto';
    }
  }

  function close(): void {
    if (openControlPopover === close) openControlPopover = null;
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position, true);
    window.removeEventListener('scroll', position, true);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
  }
  function onDocDown(e: MouseEvent): void {
    const t = e.target as Node;
    if (pop.contains(t) || anchor.contains(t)) return;
    close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
  }
  cancelBtn.addEventListener('click', () => close());
  applyBtn.addEventListener('click', () => {
    close();
    controlState.set(card.id, { values: [...selected] });
    renderDashGrid(); // re-renders every card body with the updated effectiveFilters()
  });

  document.body.appendChild(pop);
  openControlPopover = close;
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', position, true);
  window.addEventListener('scroll', position, true);
  position();
  void loadValues();
}

// ── Date range ───────────────────────────────────────────────────────────────
// A chip carrying the period's name ("Last 30 days", "Sep 1 – Sep 30, 2026",
// "All dates") that opens the shared period picker (periodPicker.ts): relative
// presets resolved in main at query time, or two fixed dates.
function renderDateRangeControl(card: any, wrap: HTMLElement): void {
  const control = card.control;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'dash-ctrl-chip dash-ctrl-period';
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.appendChild(icon('calendar', 14));
  const txt = document.createElement('span');
  txt.textContent = periodValueText(controlCurrentValue(card));
  chip.appendChild(txt);
  wrap.appendChild(chip);
  chip.addEventListener('click', () => {
    openPeriodPopover(chip, controlCurrentValue(card), control.label || 'Filter', (v) => {
      if (v) controlState.set(card.id, v);
      else controlState.delete(card.id);
      renderDashGrid();
    });
  });
}
