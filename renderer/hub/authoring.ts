// The analysis AUTHORING WORKBENCH — Data + Visuals on the left, the sheet grid
// in the middle, Properties on the right.
//
// Classic global-scope renderer <script>: NO import/export. Loaded after
// dashboards.js and encodingForm.js, so dashCurrent / dashCurrentPage /
// renderDashGrid / markDashDirty / createEncodingForm / buildVizPicker all
// resolve at call time.
//
// THE MODEL. Ordinate's editor is a grid of CARDS; QuickSight's is a
// single-visual IDE. The bridge between them is SELECTION: click a card, and
// these panels edit that card. Nothing about Page/Card changes, so publishing,
// cross-visual filters and the Phase B–E snapshot design keep working —
// see docs/analysis/01-authoring-surface.md.
//
// WHAT THE WELLS EDIT. A visual card references a project-level Visual by id, so
// changing its encoding writes the VISUAL (visual:update), not the card. That is
// the existing sharing semantic, and it is safe for readers precisely because
// publishing denormalises: a published dashboard holds a copy by value and does
// not move when the visual is edited (00-model.md, decision 1). It does mean an
// edit here shows up in every analysis using that visual, which the panel says.
//
// THE INVARIANT. These panels exist in the Analyses section only. In dashboard
// mode there is no workbench in the DOM at all — a published dashboard is
// read-only, and a panel that can mutate a card plus the 600 ms autosave debounce
// would clobber a snapshot.

let anSelectedCardId: string | null = null;
let anForm: EncodingFormApi | null = null;
let anPicker: any = null;
// The Visual record behind the selected card, and its dataset's columns. Held so
// a well edit can write back without re-reading either.
let anVisual: any = null;
let anColumns: Array<{ name: string; type: string }> = [];
let anSaveTimer: number | null = null;

const AN_PANE_KEY = 'anPanes'; // collapsed pane ids, comma-separated

function anEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Collapse ────────────────────────────────────────────────────────────────
// Collapsed panes keep their header (a labelled way back), so nothing is ever
// unreachable — this is a disclosure, not a hidden feature.
function anReadCollapsed(): Set<string> {
  try {
    return new Set((localStorage.getItem(AN_PANE_KEY) || '').split(',').filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function anApplyCollapsed(): void {
  const set = anReadCollapsed();
  [
    { pane: 'an-pane-data', toggle: 'an-data-toggle' },
    { pane: 'an-pane-visuals', toggle: 'an-viz-toggle' },
    { pane: 'an-pane-props', toggle: 'an-props-toggle' },
  ].forEach(({ pane, toggle }) => {
    const el = anEl(pane);
    const btn = anEl(toggle);
    if (!el || !btn) return;
    const off = set.has(pane);
    el.classList.toggle('is-collapsed', off);
    btn.setAttribute('aria-expanded', off ? 'false' : 'true');
  });
}

function anToggleCollapsed(paneId: string): void {
  const set = anReadCollapsed();
  if (set.has(paneId)) set.delete(paneId);
  else set.add(paneId);
  try {
    localStorage.setItem(AN_PANE_KEY, [...set].join(','));
  } catch (_) { /* private mode — the panes still toggle, they just forget */ }
  anApplyCollapsed();
}

// ── Selection ───────────────────────────────────────────────────────────────
function anCardById(id: string | null): any {
  if (!id) return null;
  const page = dashCurrentPage();
  const cards = page && Array.isArray(page.cards) ? page.cards : [];
  return cards.find((c: any) => c && c.id === id) || null;
}

/** Paint the selection ring. Called after every grid render, which rebuilds cards. */
function anPaintSelection(): void {
  document.querySelectorAll('#dash-grid .dash-card').forEach((el) => {
    el.classList.toggle('is-selected', (el as HTMLElement).dataset.cardId === anSelectedCardId);
  });
}

/**
 * Bind the panels to a card. `null` clears them.
 *
 * Only ever does anything in analysis mode — see the invariant at the top.
 */
async function anSelectCard(cardId: string | null): Promise<void> {
  if (dashMode !== 'analysis') return;
  anSelectedCardId = cardId;
  anPaintSelection();

  const card = anCardById(cardId);
  anRenderProps(card);

  // Fields + wells are a VISUAL card's business. A text or metric card still
  // selects, and still gets Properties — it just has no encoding to edit.
  if (!card || card.type !== 'visual' || !card.visualId || !currentProjectId) {
    anVisual = null;
    anColumns = [];
    anShowEncoding(false, card ? 'That card has no fields to edit.' : 'Select a visual card to see its fields.');
    return;
  }

  let visual: any = null;
  try {
    visual = await window.hub.getVisual(currentProjectId, String(card.visualId));
  } catch (_) {
    visual = null;
  }
  if (!visual) {
    anVisual = null;
    anShowEncoding(false, 'That visual could not be loaded.');
    return;
  }
  // The click may have moved on while the two awaits ran; a stale bind would
  // show one card's fields against another's selection ring.
  if (anSelectedCardId !== cardId) return;

  anVisual = visual;
  let meta: any = null;
  try {
    meta = await window.hub.getDatasetMeta(currentProjectId, String(visual.datasetId || ''));
  } catch (_) {
    meta = null;
  }
  if (anSelectedCardId !== cardId) return;
  anColumns = meta && Array.isArray(meta.columns)
    ? meta.columns.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];

  anRenderFields();
  // Repaint Properties now that anVisual is loaded: the first call above ran
  // before the awaits, so the title field had no name to show.
  anRenderProps(card);
  anEnsureForm();
  anForm!.setColumns(anColumns, visual.encoding, Array.isArray(visual.filters) ? visual.filters : []);
  anShowEncoding(true, '');
  await anRenderAiSlot();
  await anRenderSwitcher();
}

function anShowEncoding(on: boolean, hint: string): void {
  const inner = anEl('an-viz-inner');
  const vizHint = anEl('an-viz-hint');
  const fields = anEl('an-fields');
  const dataHint = anEl('an-data-hint');
  if (inner) inner.hidden = !on;
  if (vizHint) { vizHint.hidden = on; vizHint.textContent = hint || 'Nothing selected.'; }
  if (fields) fields.hidden = !on;
  const search = anEl('an-field-search');
  if (search) search.hidden = !on;
  if (dataHint) { dataHint.hidden = on; dataHint.textContent = hint || 'Select a visual card to see its fields.'; }
  if (!on && fields) fields.innerHTML = '';
}

// ── The Data panel ──────────────────────────────────────────────────────────
// Fields are draggable AND clickable. Drag is what the design asks for; click is
// what makes the panel usable without a mouse, and a drag-only well is simply
// unreachable from the keyboard.
function anRenderFields(): void {
  const host = anEl('an-fields');
  if (!host) return;
  host.innerHTML = '';
  const box = anEl('an-field-search') as HTMLInputElement | null;
  const q = (box?.value || '').trim().toLowerCase();
  const shown = q ? anColumns.filter((c) => c.name.toLowerCase().includes(q)) : anColumns;
  if (!shown.length) {
    const none = document.createElement('p');
    none.className = 'an-pane-hint';
    none.textContent = 'No field matches “' + (box?.value || '').trim() + '”.';
    host.appendChild(none);
    return;
  }
  shown.forEach((col) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'an-field an-field--' + col.type;
    item.draggable = true;
    item.dataset.column = col.name;
    const icon = document.createElement('span');
    icon.className = 'an-field-ic';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = col.type === 'number' ? '#' : col.type === 'date' ? '🗓' : 'A';
    const name = document.createElement('span');
    name.className = 'an-field-name';
    name.textContent = col.name;
    item.appendChild(icon);
    item.appendChild(name);
    item.title = col.name + ' · ' + col.type;

    item.addEventListener('dragstart', (e) => {
      // text/plain so the payload survives; the class is what marks the drag as
      // ours, since any text drag would otherwise satisfy a bare drop handler.
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', col.name);
        e.dataTransfer.effectAllowed = 'copy';
      }
      document.body.classList.add('an-dragging');
    });
    item.addEventListener('dragend', () => document.body.classList.remove('an-dragging'));
    // Click = drop into the well the column best fits. Same call the drop makes.
    item.addEventListener('click', () => {
      anDropInto(col.type === 'number' ? 'values' : 'category', col.name);
    });
    host.appendChild(item);
  });
}

// ── The Visuals panel: wells + chart type ───────────────────────────────────
function anEnsureForm(): void {
  if (anForm) return;
  const mount = anEl('an-wells');
  if (!mount) return;
  anForm = createEncodingForm(mount, { onChange: () => anScheduleWrite(), variant: 'wells' });
  anForm.show(true);
  anWireWells(anForm.el);
}

// Every `[data-well]` row in the mounted form is a drop target. The form stays
// DnD-agnostic and just exposes dropField(); the listeners live here.
function anWireWells(root: HTMLElement): void {
  root.querySelectorAll('[data-well]').forEach((well) => {
    const el = well as HTMLElement;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.dropEffect = 'copy';
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop');
      const column = (e as DragEvent).dataTransfer?.getData('text/plain') || '';
      if (column) anDropInto(el.dataset.well || '', column);
    });
  });
}

function anDropInto(well: string, column: string): void {
  if (!anForm) return;
  const okDrop = anForm.dropField(well, column);
  if (!okDrop) showToast('“' + column + '” is not a column of this visual’s dataset.');
}

// ── AI in the Visuals panel ─────────────────────────────────────────────────
// TWO MECHANISMS, TWO LABELS. This button is a model call (suggestVisual). The
// "Recommended" marks on the chips below are app-computed shape eligibility and
// involve no model at all. Conflating them would credit the app's own logic to
// an LLM and, worse, make the chip row look broken when no model is configured —
// it works perfectly without one, which is why the note below says so.
let anAiReady: boolean | null = null; // null = not asked yet
// Only the newest anRenderSwitcher call may paint. Selecting a card and writing
// a well edit both rebuild the chips, and each clears the mount BEFORE its await
// — so two in flight clear twice and then append twice, leaving two chip rows.
let anSwitcherSeq = 0;

async function anRenderAiSlot(): Promise<void> {
  const slot = anEl('an-ai-slot');
  if (!slot) return;
  slot.innerHTML = '';
  if (anAiReady === null) {
    try {
      const st: any = await window.hub.getKeyStatus();
      anAiReady = !!(st && st.isReady);
    } catch (_) {
      anAiReady = false;
    }
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm an-ai-btn';
  btn.id = 'an-suggest-btn';
  btn.textContent = '✨ Suggest a visual';
  btn.disabled = !anAiReady;
  btn.addEventListener('click', () => anSuggestVisual(btn));
  slot.appendChild(btn);

  const note = document.createElement('p');
  note.className = 'an-ai-note';
  note.id = 'an-ai-note';
  if (!anAiReady) {
    note.textContent =
      'AI suggestions need a model in Settings → Execution. The chart types below are recommended by the app itself and work without one.';
  } else {
    note.hidden = true;
  }
  slot.appendChild(note);
}

function anSetAiNote(text: string): void {
  const note = anEl('an-ai-note');
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

async function anSuggestVisual(btn: HTMLButtonElement): Promise<void> {
  if (!anVisual || !currentProjectId || !anForm) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  let res: any;
  try {
    res = await window.hub.suggestVisual(currentProjectId, String(anVisual.datasetId));
  } catch (_) {
    res = { ok: false };
  }
  btn.disabled = false;
  btn.textContent = label || '✨ Suggest a visual';

  if (res && res.notReady) {
    anAiReady = false;
    await anRenderAiSlot();
    return;
  }
  if (!res || res.ok === false || !res.encoding) {
    anSetAiNote((res && res.error) || 'Could not suggest a visual.');
    return;
  }
  // Confirmed before it touches anything, like every other AI action here: the
  // model proposes STRUCTURE and the user approves it. Every figure that then
  // appears is computed by the app from the same encoding.
  if (!window.confirm('Apply the suggested visual? You can still adjust it before it is saved.')) return;
  anSetAiNote('');
  anForm.setEncoding(res.encoding);
  if (typeof res.chartType === 'string' && res.chartType) anVisual.chartType = res.chartType;
  anScheduleWrite();
}

// The chart-type chips. Eligibility ("Recommended") is APP-COMPUTED from the
// data's shape — no model — and it is derived here exactly as the Visuals
// builder derives it, from the same computeVisualData reply. Re-deriving it
// would let the two surfaces disagree about what fits the same data.
async function anRenderSwitcher(): Promise<void> {
  const mount = anEl('an-switcher');
  if (!mount || !anVisual || !anForm || !currentProjectId) return;
  const seq = ++anSwitcherSeq;
  mount.innerHTML = '';
  const encoding = anForm.getEncoding();
  if (!encoding.category || !encoding.values || !encoding.values.length) return;

  let res: any;
  try {
    res = await window.hub.computeVisualData(
      currentProjectId, String(anVisual.datasetId), encoding, anForm.getFilters());
  } catch (_) {
    res = null;
  }
  // A newer call started while this one was awaiting; that one owns the mount.
  if (seq !== anSwitcherSeq) return;
  if (!res || res.ok === false || !anVisual) return;
  const data = res.data || { labels: [], series: [] };

  let shape = res.recommendedShape;
  if (data.geo) {
    const catCol = anColumns.find((c) => c.name === encoding.category);
    shape = catCol && catCol.type === 'date' ? 'time_series' : 'categorical';
  }
  const recommended = eligibleChartTypes(shape, countNumericSeries(data), (data.labels || []).length);
  if (data.geo) recommended.push('map_choropleth'); // maps after charts, never first
  if (!recommended.length) return;

  const current = String(anVisual.chartType || '');
  const initial = recommended.indexOf(current) >= 0 ? current : recommended[0];

  if (seq !== anSwitcherSeq) return;
  mount.innerHTML = '';
  const h = document.createElement('p');
  h.className = 'an-switcher-h';
  h.textContent = 'Change visual type';
  mount.appendChild(h);

  // ONE row naming the CURRENT type, not a grid of every type — the reference
  // spends its panel space on the wells, and the full picker is one click away.
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'an-typerow';
  row.setAttribute('aria-label', 'Change visual type');
  const ic = document.createElement('span');
  ic.className = 'an-typerow-ic';
  ic.innerHTML = VIZ_ICONS[initial] || ''; // trusted static SVG, as renderResult.ts
  const nm = document.createElement('span');
  nm.className = 'an-typerow-name';
  nm.textContent = VIZ_LABELS[initial] || initial;
  const chev = document.createElement('span');
  chev.className = 'an-typerow-chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '›';
  row.appendChild(ic);
  row.appendChild(nm);
  row.appendChild(chev);
  mount.appendChild(row);

  // "+ More" keeps the full three-tier panel — Recommended / Selected / Other.
  anPicker = buildVizPicker({
    recommended,
    pool: ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']),
    data,
    hasGeo: !!data.geo,
    initial,
    onSelect: (type: string) => {
      if (!anVisual) return;
      anVisual.chartType = type;
      ic.innerHTML = VIZ_ICONS[type] || '';
      nm.textContent = VIZ_LABELS[type] || type;
      anScheduleWrite();
    },
  });
  // The chip row still owns that panel's state, so the row above delegates to it
  // rather than growing a second chart-type vocabulary here.
  row.addEventListener('click', () => {
    const more = anPicker.switcher.querySelector('.cv-viz-more') as HTMLElement | null;
    (more || anPicker.switcher.querySelector('button') as HTMLElement)?.click();
  });
  anPicker.switcher.classList.add('an-switcher-hidden');
  mount.appendChild(anPicker.switcher);
}

// ── Writing back ────────────────────────────────────────────────────────────
// Debounced to match the editor's own 600 ms autosave: dragging a field fires
// several changes and each write re-renders the card.
function anScheduleWrite(): void {
  if (anSaveTimer !== null) window.clearTimeout(anSaveTimer);
  anSaveTimer = window.setTimeout(() => {
    anSaveTimer = null;
    anWriteVisual();
  }, 500);
}

async function anWriteVisual(): Promise<void> {
  if (!anVisual || !anForm || !currentProjectId || dashMode !== 'analysis') return;
  const encoding = anForm.getEncoding();
  if (!encoding.category || !encoding.values || encoding.values.length === 0) {
    setAnPropsNote('Pick a category and at least one measure for this visual to draw.');
    return;
  }
  setAnPropsNote('');
  try {
    await window.hub.updateVisual(currentProjectId, String(anVisual.id), {
      name: anVisual.name,
      chartType: anVisual.chartType || 'column',
      encoding,
      overrides: anVisual.overrides || {},
      filters: anForm.getFilters(),
    });
  } catch (_) {
    return;
  }
  // Redraw the sheet so the card shows the edit. The grid rebuild drops the
  // selection ring, so repaint it.
  renderDashGrid();
  anPaintSelection();
  // Eligibility depends on the data, and the data just changed.
  await anRenderSwitcher();
}

// ── The Properties panel ────────────────────────────────────────────────────
function setAnPropsNote(text: string): void {
  const note = anEl('an-props-note');
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

function anRenderProps(card: any): void {
  const host = anEl('an-props');
  const hint = anEl('an-props-hint');
  if (!host || !hint) return;
  host.innerHTML = '';
  hint.hidden = !!card;
  if (!card) return;

  /** One disclosure row: a header that toggles its body, collapsed by default
   *  unless it is the section you almost always want. */
  const section = (title: string, open: boolean): HTMLElement => {
    const sec = document.createElement('section');
    sec.className = 'an-sec' + (open ? ' is-open' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'an-sec-head';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = document.createElement('span');
    chev.className = 'an-sec-chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '›';
    const t = document.createElement('span');
    t.textContent = title;
    head.appendChild(chev);
    head.appendChild(t);
    const body = document.createElement('div');
    body.className = 'an-sec-body';
    head.addEventListener('click', () => {
      const on = sec.classList.toggle('is-open');
      head.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    sec.appendChild(head);
    sec.appendChild(body);
    host.appendChild(sec);
    return body;
  };

  const display = section('Display settings', true);
  if (card.type === 'visual' && anVisual) {
    const lab = document.createElement('span');
    lab.className = 'an-prop-label';
    lab.textContent = 'Title';
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'an-prop-input';
    nameIn.value = String(anVisual.name || '');
    nameIn.addEventListener('input', () => {
      if (anVisual) anVisual.name = nameIn.value;
      anScheduleWrite();
    });
    display.appendChild(lab);
    display.appendChild(nameIn);
  } else {
    const k = document.createElement('p');
    k.className = 'an-prop-note an-prop-note--info';
    k.textContent = 'A ' + card.type + ' card. Select a visual card to edit fields and a title.';
    display.appendChild(k);
  }

  const layout = section('Layout', false);
  const how = document.createElement('p');
  how.className = 'an-prop-note an-prop-note--info';
  how.textContent =
    'Drag the card to move it, or drag its right/bottom edge to resize. With the card focused, arrow keys move it and shift+arrows resize it.';
  layout.appendChild(how);

  if (card.type === 'visual' && anVisual) {
    const shared = section('Sharing', false);
    const p = document.createElement('p');
    p.className = 'an-prop-note an-prop-note--info';
    p.textContent =
      'This is a saved visual. Editing its fields changes it everywhere it is used — published dashboards keep the copy they were published with.';
    shared.appendChild(p);
  }

  const note = document.createElement('p');
  note.className = 'an-prop-note';
  note.id = 'an-props-note';
  note.hidden = true;
  host.appendChild(note);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-danger an-prop-del';
  del.textContent = 'Remove card';
  del.addEventListener('click', () => {
    removeCard(card);
    anSelectCard(null);
  });
  host.appendChild(del);
}

// ── Direct manipulation: drag to move, drag an edge to resize ───────────────
// QuickSight moves a visual by dragging it and resizes it by its edges, and that
// is what a sheet layout wants — stepper buttons make you aim at a target four
// clicks away.
//
// Pointer Events, not HTML5 drag-and-drop. HTML5 drag gives no continuous
// position (dragover fires coarsely, and the drag image is the browser's), which
// is exactly what a snap-to-grid preview needs. setPointerCapture also keeps the
// gesture alive when the pointer leaves the card, which a fast drag always does.
//
// Nothing moves until the pointer is released: a ghost shows the target cell
// while the card stays put. Re-laying out the real card mid-drag would re-render
// its chart on every frame.
let anGhost: HTMLElement | null = null;
let anGesture: any = null;

/** Column pitch: 12 tracks with 11 gaps between them, so pitch = (w + gap) / 12. */
function anColPitch(grid: HTMLElement): number {
  return (grid.getBoundingClientRect().width + DASH_GAP_PX) / DASH_GRID_COLS;
}

function anRowPitch(): number {
  return DASH_ROW_PX + DASH_GAP_PX;
}

function anShowGhost(grid: HTMLElement, x: number, y: number, w: number, h: number): void {
  if (!anGhost) {
    anGhost = document.createElement('div');
    anGhost.className = 'an-ghost';
    grid.appendChild(anGhost);
  }
  anGhost.style.gridColumn = x + 1 + ' / span ' + w;
  anGhost.style.gridRow = y + 1 + ' / span ' + h;
}

function anClearGhost(): void {
  if (anGhost) anGhost.remove();
  anGhost = null;
}

function anBeginGesture(e: PointerEvent, card: any, el: HTMLElement, mode: string): void {
  const grid = anEl('dash-grid');
  if (!grid || dashMode !== 'analysis') return;
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  anGesture = {
    card, el, mode,
    startX: e.clientX, startY: e.clientY,
    x0: l.x || 0, y0: l.y || 0, w0: l.w || 1, h0: l.h || 1,
    next: { x: l.x || 0, y: l.y || 0, w: l.w || 1, h: l.h || 1 },
    grid,
  };
  el.classList.add('is-dragging');
  document.body.classList.add('an-grabbing');
  // Keeps the gesture alive when the pointer leaves the card, which a fast drag
  // always does. It THROWS for a pointer id the browser has no active pointer
  // for, and capture is an optimisation here — the window listeners carry the
  // gesture either way — so a failure must not take the drag down with it.
  try {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  } catch (_) { /* no active pointer for that id */ }
  e.preventDefault();
}

function anMoveGesture(e: PointerEvent): void {
  if (!anGesture) return;
  const g = anGesture;
  const dx = Math.round((e.clientX - g.startX) / anColPitch(g.grid));
  const dy = Math.round((e.clientY - g.startY) / anRowPitch());
  if (g.mode === 'move') {
    g.next.x = clampInt(g.x0 + dx, 0, DASH_GRID_COLS - g.w0, g.x0);
    g.next.y = Math.max(0, g.y0 + dy);
    g.next.w = g.w0;
    g.next.h = g.h0;
  } else {
    // Resize from the right/bottom edge: x,y are fixed and w,h follow the pointer.
    g.next.x = g.x0;
    g.next.y = g.y0;
    g.next.w = g.mode === 'e' || g.mode === 'se'
      ? clampInt(g.w0 + dx, 1, DASH_GRID_COLS - g.x0, g.w0) : g.w0;
    g.next.h = g.mode === 's' || g.mode === 'se'
      ? Math.max(1, g.h0 + dy) : g.h0;
  }
  anShowGhost(g.grid, g.next.x, g.next.y, g.next.w, g.next.h);
}

function anEndGesture(): void {
  if (!anGesture) return;
  const g = anGesture;
  anGesture = null;
  g.el.classList.remove('is-dragging');
  document.body.classList.remove('an-grabbing');
  anClearGhost();
  const l = g.card.layout;
  const changed = l.x !== g.next.x || l.y !== g.next.y || l.w !== g.next.w || l.h !== g.next.h;
  if (!changed) return;
  l.x = g.next.x; l.y = g.next.y; l.w = g.next.w; l.h = g.next.h;
  reapplyCardStyle(g.card);
  markDashDirty();
}

/**
 * Attach the gesture to every card. Called after each grid render, because
 * renderDashGrid rebuilds the card elements.
 */
function anWireCards(): void {
  if (dashMode !== 'analysis') return;
  const grid = anEl('dash-grid');
  if (!grid) return;
  document.querySelectorAll('#dash-grid .dash-card').forEach((node) => {
    const el = node as HTMLElement;
    if (el.dataset.anWired === '1') return;
    el.dataset.anWired = '1';
    const card = anCardById(el.dataset.cardId || null);
    if (!card) return;

    // The native HTML5 drag the dashboard editor uses would fight the pointer
    // gesture — both start from the same press.
    const head = el.querySelector('.dash-card-head') as HTMLElement | null;
    if (head) {
      head.draggable = false;
      head.addEventListener('pointerdown', (e) => {
        if ((e as PointerEvent).button !== 0) return;
        anSelectCard(card.id);
        anBeginGesture(e as PointerEvent, card, el, 'move');
      });
    }

    // Edge + corner handles. Right = width, bottom = height, corner = both.
    (['e', 's', 'se'] as const).forEach((mode) => {
      const h = document.createElement('span');
      h.className = 'an-resize an-resize--' + mode;
      h.setAttribute('aria-hidden', 'true'); // keyboard resize is on the card itself
      h.addEventListener('pointerdown', (e) => {
        if ((e as PointerEvent).button !== 0) return;
        e.stopPropagation();
        anSelectCard(card.id);
        anBeginGesture(e as PointerEvent, card, el, mode);
      });
      el.appendChild(h);
    });

    // The keyboard path. Dragging is a mouse gesture, and it cannot be the ONLY
    // way to lay out a sheet — arrows move, shift+arrows resize.
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      const d = k === 'ArrowLeft' ? [-1, 0] : k === 'ArrowRight' ? [1, 0]
        : k === 'ArrowUp' ? [0, -1] : k === 'ArrowDown' ? [0, 1] : null;
      if (!d) return;
      e.preventDefault();
      anSelectCard(card.id);
      if ((e as KeyboardEvent).shiftKey) resizeCard(card, d[0], d[1]);
      else nudgeCard(card, d[0], d[1]);
    });
  });

  // One listener pair for the whole gesture, not one per card.
  if (!grid.dataset.anGestures) {
    grid.dataset.anGestures = '1';
    window.addEventListener('pointermove', anMoveGesture);
    window.addEventListener('pointerup', anEndGesture);
    window.addEventListener('pointercancel', anEndGesture);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
/** Called by dashboards.ts after every grid render, and on open/close. */
function anSyncWorkbench(): void {
  const host = anEl('an-editor-host');
  const on = dashMode === 'analysis' && !!dashCurrent;
  if (host) host.classList.toggle('is-active', on);
  // FOCUS MODE. An open analysis takes the whole window: the project nav goes
  // away, as it does in the reference. Four columns competing for 1180px is what
  // made this surface feel stuffed — the nav is 176px of chrome you cannot use
  // while authoring, and "‹ Back" in the editor head already returns to it.
  document.body.classList.toggle('an-focus', on);
  if (dashMode !== 'analysis') {
    anSelectedCardId = null;
    return;
  }
  // The selected card can vanish (deleted, or the sheet changed under us).
  if (anSelectedCardId && !anCardById(anSelectedCardId)) {
    anSelectCard(null);
    return;
  }
  anPaintSelection();
  anWireCards();
}

function initAuthoring(): void {
  anApplyCollapsed();
  [
    ['an-data-toggle', 'an-pane-data'],
    ['an-viz-toggle', 'an-pane-visuals'],
    ['an-props-toggle', 'an-pane-props'],
  ].forEach(([btnId, paneId]) => {
    const b = anEl(btnId);
    if (b) b.addEventListener('click', () => anToggleCollapsed(paneId));
  });

  // Selection, by delegation — the grid rebuilds its cards on every render, so
  // per-card listeners would have to be re-attached each time.
  const grid = anEl('dash-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      if (dashMode !== 'analysis') return;
      const card = (e.target as HTMLElement).closest('.dash-card') as HTMLElement | null;
      // Clicks on the card's own controls are that control's business.
      if ((e.target as HTMLElement).closest('.dash-card-ctrls')) return;
      anSelectCard(card ? card.dataset.cardId || null : null);
    });
  }

  // + Calculated field belongs to the dataset, and the Prepare pipeline already
  // owns authoring one (reversible, safe evaluator, AI suggestion). Sending the
  // user there beats a second formula editor that has to stay in step with it.
  const search = anEl('an-field-search');
  if (search) search.addEventListener('input', () => anRenderFields());

  const calc = anEl('an-calc-btn');
  if (calc) {
    calc.addEventListener('click', () => {
      if (!anVisual || !anVisual.datasetId) {
        window.alert('Select a visual card first — a calculated field is added to its dataset.');
        return;
      }
      // Calculated fields belong to the DATASET, and prepare.ts already owns
      // authoring one (reversible pipeline, safe evaluator, AI suggestion). Send
      // the user to it rather than grow a second formula editor here that has to
      // be kept in step with the first.
      openSavedDataset(String(anVisual.datasetId));
      showToast('Add a calculated field in this dataset’s Prepare steps.');
    });
  }
}
