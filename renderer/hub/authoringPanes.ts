// The two rail panes that define what a card CONTAINS: Data (browse the
// fields, read-only) and Visuals (the wells, the chart type, the AI
// suggestion, and the gallery of saved visuals).
//
// The field list has ONE home, beside the wells; the Data pane renders its own
// browse copy from the same state through the same anFieldItem(). Nothing is
// re-parented between panels.
//
// Split verbatim out of authoring.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── The Data panel ──────────────────────────────────────────────────────────
// Fields are draggable AND clickable. Drag is what the design asks for; click is
// what makes the panel usable without a mouse, and a drag-only well is simply
// unreachable from the keyboard.
function anRenderFields(): void {
  const host = anEl('an-fields');
  if (!host) return;
  host.innerHTML = '';
  const ds = anEl('an-ds');
  const kind = anEl('an-ds-kind');
  const dsName = anEl('an-ds-name');
  if (ds && kind && dsName) {
    ds.hidden = !anDataset;
    if (anDataset) {
      kind.textContent = anDataset.kind.toUpperCase();
      dsName.textContent = anDataset.name;
      dsName.title = anDataset.name;
    }
  }
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
  shown.forEach((col) => host.appendChild(anFieldItem(col, true)));
  anRenderBrowseFields();
}

/**
 * One field row — icon, name, click-to-assign — shared by the two renders of
 * the list: the PROPERTIES one (draggable; the wells are right below it) and
 * the DATA flyout's browse one (drag reaches nothing there, so it does not
 * offer it). One builder, so the two cannot drift.
 */
function anFieldItem(col: { name: string; type: string }, draggable: boolean): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'an-field an-field--' + col.type;
  item.draggable = draggable;
  item.dataset.column = col.name;
  const icon = document.createElement('span');
  icon.className = 'an-field-ic';
  icon.setAttribute('aria-hidden', 'true');
  if (col.type === 'date') {
    // Inline SVG, not an emoji: 🗓 renders at a different size and weight to
    // the letterforms next to it on every platform.
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="14" rx="2" stroke="currentColor" stroke-width="2"/>'
      + '<path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  } else {
    icon.textContent = col.type === 'number' ? '#' : 'A';
  }
  const name = document.createElement('span');
  name.className = 'an-field-name';
  name.textContent = col.name;
  item.appendChild(icon);
  item.appendChild(name);
  item.title = col.name + ' · ' + col.type + (draggable ? ' — drag or click to add' : ' — click to add');

  if (draggable) {
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
  }
  // Click = fill the next EMPTY well. Same call a drop makes, so the two routes
  // cannot drift; it is also what keeps the browse list ASSIGNING rather than
  // inert, and the wells reachable from the keyboard.
  item.addEventListener('click', () => anDropInto(anNextWell(col.type), col.name));
  return item;
}

/**
 * The Data flyout's read-only render of the same list — its own elements, its
 * own search, painted from the same anColumns/anDataset state whenever the
 * canonical render runs. Two renders of one list; nothing is ever re-parented.
 */
function anRenderBrowseFields(): void {
  const host = anEl('an-browse');
  if (!host) return;
  host.innerHTML = '';
  const on = !!anVisual && anColumns.length > 0;

  const hint = anEl('an-browse-hint');
  if (hint) hint.hidden = on;
  const search = anEl('an-browse-search') as HTMLInputElement | null;
  if (search) search.hidden = !on;
  const ds = anEl('an-browse-ds');
  if (ds) ds.hidden = !(on && anDataset);
  if (on && anDataset) {
    const kind = anEl('an-browse-kind');
    const dsName = anEl('an-browse-name');
    if (kind) kind.textContent = anDataset.kind.toUpperCase();
    if (dsName) {
      dsName.textContent = anDataset.name;
      dsName.title = anDataset.name;
    }
  }
  if (!on) return;

  const q = (search?.value || '').trim().toLowerCase();
  const shown = q ? anColumns.filter((c) => c.name.toLowerCase().includes(q)) : anColumns;
  if (!shown.length) {
    const none = document.createElement('p');
    none.className = 'an-pane-hint';
    none.textContent = 'No field matches “' + (search?.value || '').trim() + '”.';
    host.appendChild(none);
    return;
  }
  shown.forEach((col) => host.appendChild(anFieldItem(col, false)));
}

// ── The Visuals panel: wells + chart type ───────────────────────────────────
function anEnsureForm(): void {
  if (anForm) return;
  const mount = anEl('an-wells');
  if (!mount) return;
  anForm = createEncodingForm(mount, {
    onChange: () => anScheduleWrite(),
    variant: 'wells',
    // Resolved at click time: the form outlives whichever visual is selected.
    dataset: () =>
      anVisual && currentProjectId
        ? { projectId: currentProjectId, datasetId: String(anVisual.datasetId || '') }
        : null,
  });
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

/**
 * The next empty well a clicked field should fill, respecting type: a number is
 * a measure and Measures is a list that is never "full", so it always takes one;
 * a text/date column fills Category, then Split by, then Filters.
 */
function anNextWell(colType: string): string {
  const enc = anForm ? anForm.getEncoding() : null;
  if (!enc) return colType === 'number' ? 'values' : 'category';
  if (!enc.category) return 'category';
  if (colType === 'number') return 'values';
  if (!enc.series) return 'series';
  return 'filters';
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
  iconLabel(btn, 'sparkles', 'Suggest a visual');
  btn.disabled = !anAiReady;
  btn.addEventListener('click', () => anSuggestVisual(btn));
  slot.appendChild(btn);

  const note = document.createElement('p');
  note.className = 'an-ai-note';
  note.id = 'an-ai-note';
  if (!anAiReady) {
    aiSetupNotice(note, 'The chart types below are recommended by the app itself and work without one.');
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
  // The label is the <span> iconLabel built, not the button's own text.
  const labelEl = btn.querySelector('span');
  const label = labelEl ? labelEl.textContent : '';
  btn.disabled = true;
  iconLabel(btn, 'sparkles', 'Thinking…');
  let res: any;
  try {
    res = await window.hub.suggestVisual(currentProjectId, String(anVisual.datasetId));
  } catch (_) {
    res = { ok: false };
  }
  btn.disabled = false;
  iconLabel(btn, 'sparkles', label || 'Suggest a visual');

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
  // The same encoding the write path composes, so the preview and the record
  // can never disagree about whether this card is a pivot.
  const encoding = anEncodingToWrite();
  if (!encoding.pivot && (!encoding.category || !encoding.values || !encoding.values.length)) return;

  let res: any;
  try {
    res = await window.hub.computeVisualData(
      currentProjectId, String(anVisual.datasetId), encoding, anForm.getFilters(), dashParamPayload());
  } catch (_) {
    res = null;
  }
  // A newer call started while this one was awaiting; that one owns the mount.
  if (seq !== anSwitcherSeq) return;
  if (!res || res.ok === false || !anVisual) return;
  const data = res.data || { labels: [], series: [] };
  // Same reply, same panel treatment as the Visuals builder — the grain main
  // settled on, and its note when the dimension's tail was capped.
  anForm.applyCategoryInfo(res.category);

  let shape = res.recommendedShape;
  if (data.geo) {
    const catCol = anColumns.find((c) => c.name === encoding.category);
    shape = catCol && catCol.type === 'date' ? 'time_series' : 'categorical';
  }
  const recommended = eligibleChartTypes(shape, countNumericSeries(data), (data.labels || []).length);
  if (data.geo) recommended.push('map_choropleth'); // maps after charts, never first
  // The gallery marks the SAME app-computed set, so the two surfaces can never
  // disagree about what fits this data.
  anRecommended = recommended.slice();
  anRenderGallery();
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
  setIcon(chev, 'chevron-right');
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

// ── The Visuals gallery ─────────────────────────────────────────────────────
// A browsable grid of every visual type, built from the SAME vocabulary the
// result-view picker uses (VIZ_LABELS / VIZ_ICONS / ALL_CHART_TYPE_IDS). It is a
// second VIEW of that list, never a second list.
//
// Recommended-first ordering is the whole reason this is a gallery rather than a
// dropdown: eligibility is app-computed from the data's shape (no model), so the
// types that actually fit float to the top and the rest stay browsable below.
let anRecommended: string[] = [];

function anGalleryPool(): string[] {
  const pool = ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']);
  const rec = pool.filter((t) => anRecommended.indexOf(t) >= 0);
  return rec.concat(pool.filter((t) => anRecommended.indexOf(t) < 0));
}

function anRenderGallery(): void {
  const mount = anEl('an-gallery');
  if (!mount) return;
  mount.innerHTML = '';
  const current = anVisual ? String(anVisual.chartType || '') : '';
  anGalleryPool().forEach((type) => {
    const rec = anRecommended.indexOf(type) >= 0;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'an-tile' + (type === current ? ' is-active' : '') + (rec ? ' is-rec' : '');
    tile.dataset.type = type;
    const ic = document.createElement('span');
    ic.className = 'an-tile-ic';
    ic.setAttribute('aria-hidden', 'true');
    ic.innerHTML = VIZ_ICONS[type] || ''; // trusted static SVG, as renderResult.ts
    const nm = document.createElement('span');
    nm.className = 'an-tile-name';
    nm.textContent = VIZ_LABELS[type] || type;
    tile.appendChild(ic);
    tile.appendChild(nm);
    tile.title = (VIZ_LABELS[type] || type) + (rec ? ' · recommended for this data' : '');
    tile.addEventListener('click', () => anGalleryPick(type));
    mount.appendChild(tile);
  });
}

/**
 * Pick a type from the gallery. With a visual card selected this retypes it;
 * with nothing selected it runs the editor's OWN add-visual flow first (same
 * modal, same handler) and applies the type to whatever that added — rather
 * than growing a second way to create a card.
 */
async function anGalleryPick(type: string): Promise<void> {
  let card = anCardById(anSelectedCardId);
  if (!card || card.type !== 'visual') {
    const page = dashCurrentPage();
    const before = new Set(((page && page.cards) || []).map((c: any) => c && c.id));
    await handleAddVisual();
    const after = ((dashCurrentPage() || {}).cards || []).filter((c: any) => c && !before.has(c.id));
    card = after[after.length - 1] || null;
    if (!card) return; // the picker was cancelled — nothing to retype
    await anSelectCard(card.id);
  }
  if (!anVisual) return;
  anVisual.chartType = type;
  anScheduleWrite();
  anRenderGallery();
}

