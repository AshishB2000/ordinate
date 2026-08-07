// Visuals section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts. A "Visual" is a
// saved chart/map: a dataset + a user encoding (a dimension + one or more
// measures + an optional split + an optional geo level) + a chart type. This file
// owns ONLY the builder form and the saved list; it adds NOTHING to the chart/map
// renderers — it hands the encoding to main (window.hub.computeVisualData), gets
// back the EXACT { labels, series } (+ geo) shape the result surface uses, and
// calls the EXISTING buildVizPicker + renderVizInArea to draw it.
//
// Reuses shared globals at call time: currentProjectId (workspace.ts), promptModal
// (projects.ts), formatSidebarTime (hub.ts), and buildVizPicker / renderVizInArea /
// eligibleChartTypes / countNumericSeries / ALL_CHART_TYPE_IDS / VIZ_LABELS
// (renderResult.ts). Consumes window.hub.* (the visual:* + dataset:* bridge). All
// names/values render as textContent only (no HTML injection); no inline style=.

// The measure/aggregation/column shapes moved to encodingForm.ts with the form
// that owns them (EncAgg / EncMeasure / EncCol). This file no longer names a
// column or an aggregation anywhere — it hands the dataset's columns over and
// reads back an encoding.

// ── Module-local state (one builder at a time) ───────────────────────────────
let vizDatasetId = ''; // dataset currently loaded into the builder
// The encoding form (encodingForm.ts) owns columns, measures and filters now.
// Created on first open, because the template it clones must be in the DOM and
// this file's top level runs before that is guaranteed.
let vizForm: EncodingFormApi | null = null;
let vizEditingId = ''; // open saved visual's id ('' = building a new one)
let vizCurrentChartType = ''; // the type currently shown / to be saved
let vizPicker: any = null; // last buildVizPicker() instance (owns the chip row)
let vizRecomputeTimer: number | null = null;
let vizOverrides: any = {}; // the SAME override object buildChart accepts (title/color/…)
let vizSaveTimer: number | null = null; // debounce for auto-persisting override edits

// The adapter "entry" handed to renderVizInArea so the ⋯ Customize menu +
// Values/Periods controls light up in the builder exactly as on the result surface.
// Its saveOverride reroutes persistence to visual:update (see persistOverride in
// chartControls.ts) instead of the history thread. One object → overrides survive a
// chart-type switch (§4): before each render we point chartOverrides['v:'+type] at
// the single vizOverrides object.
const vizEntry: any = {
  id: 'draft',
  chartOverrides: {},
  saveOverride: (merged: any) => {
    vizOverrides = merged || {};
    scheduleSaveVisualOverrides();
  },
};

// Render the current data/type through the adapter entry, mapping the one
// vizOverrides object onto whatever key renderVizInArea derives ('v:'+type).
// `source` is the dataset identity the Mosaic engine needs (it queries the
// dataset's view rather than the computed data); omitting it just keeps
// Chart.js. See the seam in renderResult.ts.
function renderVizViaEntry(area: HTMLElement, data: any, type: string, source?: any): void {
  vizEntry.id = vizEditingId || 'draft';
  vizEntry.chartOverrides = { ['v:' + type]: vizOverrides };
  renderVizInArea(area, data, type, vizEntry, 'v', source);
}

// Debounced persist of override edits. Only a saved visual writes to disk; an
// unsaved draft keeps overrides in memory until the first Save.
function scheduleSaveVisualOverrides(): void {
  if (vizSaveTimer !== null) window.clearTimeout(vizSaveTimer);
  vizSaveTimer = window.setTimeout(() => {
    vizSaveTimer = null;
    if (vizEditingId && currentProjectId) {
      window.hub.updateVisual(currentProjectId, vizEditingId, { overrides: vizOverrides }).catch(() => {});
    }
  }, 300);
}

// ── Small DOM helpers ────────────────────────────────────────────────────────
function vizEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function vizShow(id: string, show: boolean): void {
  const el = vizEl(id);
  if (el) el.hidden = !show;
}
function vizSelect(id: string): HTMLSelectElement | null {
  return vizEl(id) as HTMLSelectElement | null;
}

// Fill a native <select> with { value, label } options (textContent only).
function fillSelect(sel: HTMLSelectElement | null, items: Array<{ value: string; label: string }>, value: string): void {
  if (!sel) return;
  sel.innerHTML = '';
  items.forEach((it) => {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    if (it.value === value) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── Gallery (the default view: saved visuals as cards) ───────────────────────
// Same name and same contract as the Week 7 list refresh — only the DOM it
// produces changed, so workspace.selectSection and every save/delete/duplicate
// caller is unaffected.
async function refreshVisualList(): Promise<void> {
  const grid = vizEl('viz-grid');
  const empty = vizEl('viz-empty');
  if (!grid) return;
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
}

// Flip between the gallery and the (now full-panel) builder. They are mutually
// exclusive: the builder is no longer an inline editor sitting above a list.
function showVizGallery(show: boolean): void {
  vizShow('viz-gallery', show);
  vizShow('viz-builder', !show);
}

function makeVisualCard(v: any): HTMLElement {
  const id = String(v && v.id ? v.id : '');
  const card = document.createElement('div');
  card.className = 'viz-card';

  // The whole card is ONE button, so a card is a single Tab stop. The star and
  // the ⋯ menu are siblings of it (nested buttons are invalid HTML) positioned
  // over the tile by CSS.
  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'viz-card-body';

  const tile = document.createElement('span');
  tile.className = 'viz-card-tile';
  const glyph = document.createElement('span');
  glyph.className = 'viz-card-glyph';
  // The ONLY innerHTML here: VIZ_ICONS is a trusted static constant of
  // hand-written SVG in renderResult.ts, never user or model input.
  glyph.innerHTML = VIZ_ICONS[v && v.chartType] || VIZ_ICONS.column;
  tile.appendChild(glyph);

  const name = document.createElement('span');
  name.className = 'viz-card-name';
  name.textContent = v && v.name ? String(v.name) : 'Untitled visual';

  const meta = document.createElement('span');
  meta.className = 'viz-card-meta';
  const typeLabel = (v && v.chartType && VIZ_LABELS[v.chartType]) || (v && v.chartType) || 'Chart';
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
      add('Add to analysis', () => handleAddVisualToAnalysis(id));
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
    .map((a) => ({ value: String(a.id), label: a && a.name ? String(a.name) : 'Untitled analysis' }))
    .concat([{ value: NEW, label: 'New analysis…' }]);
  const choice = await dashChooseModal('Add to analysis', options, 'Add');
  if (choice === null) return;

  let analysis: any = null;
  if (choice === NEW) {
    const name = await promptModal('Name the analysis', 'Untitled analysis', 'Create');
    if (name === null) return;
    try {
      analysis = await window.hub.createAnalysis({ projectId: currentProjectId, name: name.trim() || 'Untitled analysis' });
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
    showToast('That analysis could not be opened');
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
  last.cards.push({ id: dashUuid(), type: 'visual', visualId: id, layout: { x: 0, y: nextFreeRow(last.cards), w: 6, h: 6 } });

  let saved: any = null;
  try {
    saved = await window.hub.updateAnalysis(currentProjectId, String(analysis.id), { sheets });
  } catch (_) {
    saved = null;
  }
  if (!saved || saved.ok === false) {
    showToast('Could not add it to that analysis');
    return;
  }
  showToast('Added to ' + (analysis.name ? String(analysis.name) : 'the analysis'));
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

// ── "+ New visual" popup ─────────────────────────────────────────────────────
// Step 1 asks WHICH dataset, step 2 asks HOW to build it, step 3 shows what the
// model proposed. The modal only RESOLVES a choice — it never creates, saves or
// navigates anything itself, so Escape / the backdrop / Cancel all resolve null
// and leave the project exactly as it was. Cloned from #viz-new-tpl per open, so
// the markup lives with the rest of the hub's HTML and every hook inside it is a
// `js-` class scoped to the clone.
//
// The builder's ✨ Suggest chart button opens this SAME modal straight at step 3
// (`opts.startAtSuggest`). One picker, one code path — not a second flow that
// could disagree with this one about what a proposal looks like.
interface VizNewChoice {
  kind: 'manual' | 'suggested';
  datasetId: string;
  encoding?: any; // 'suggested' only — already sanitized in main
  chartType?: string; // 'suggested' only
}

interface VizNewOpts {
  datasetId?: string; // preselect (the builder already knows its dataset)
  startAtSuggest?: boolean; // open straight at step 3 and ask immediately
}

async function openNewVisualModal(opts: VizNewOpts = {}): Promise<VizNewChoice | null> {
  let sets: any[] = [];
  try {
    sets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    sets = [];
  }
  if (!Array.isArray(sets)) sets = [];

  // Readiness comes from the ONE source main already exposes (publicConfig
  // .isReady = Local CLI OR BYOK) — the same gate analyses.ts asks. No new IPC
  // and no second definition of "ready" that could disagree with it.
  let aiReady = false;
  try {
    const st: any = await window.hub.getKeyStatus();
    aiReady = !!(st && st.isReady);
  } catch (_) {
    aiReady = false;
  }

  const tpl = document.getElementById('viz-new-tpl') as HTMLTemplateElement | null;
  if (!tpl || !tpl.content.firstElementChild) return null;
  const overlay = tpl.content.firstElementChild.cloneNode(true) as HTMLElement;
  const q = (sel: string): any => overlay.querySelector(sel);

  const box = q('.vn-modal');
  const step1 = q('.js-vn-step1');
  const step2 = q('.js-vn-step2');
  const step3 = q('.js-vn-step3');
  const rowsHost = q('.js-vn-rows');
  const noneEl = q('.js-vn-none');
  const backBtn = q('.js-vn-back');
  const intentEl = q('.js-vn-intent') as HTMLTextAreaElement;
  const askBtn = q('.js-vn-ask') as HTMLButtonElement;
  const noteEl = q('.js-vn-note');
  const optionsHost = q('.js-vn-options');
  const statusEl = q('.js-vn-status');
  const regenBtn = q('.js-vn-regen') as HTMLButtonElement;

  return new Promise<VizNewChoice | null>((resolve) => {
    let done = false;
    let selectedId = String(opts.datasetId || '');
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;

    function close(val: VizNewChoice | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release(); // hand focus back to the trigger
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (a11y) {
        a11y.onTabKey(e); // trap Tab inside the dialog
      }
    }

    // Step 1 is re-enterable: step 2's ← Back comes straight back here. When the
    // builder opened us at step 3 there is no step 1 to return to, so ← Back
    // goes to step 2 instead of stranding the user on a dataset list they were
    // never shown.
    function showStep(n: number): void {
      step1.hidden = n !== 1;
      step2.hidden = n !== 2;
      step3.hidden = n !== 3;
      backBtn.hidden = n === 1 || (n === 2 && !!opts.startAtSuggest);
      let first: HTMLElement | null = null;
      if (n === 1) {
        first = (rowsHost.querySelector('.vn-row') as HTMLElement | null) || (q('.js-vn-import') as HTMLElement);
      } else if (n === 2) {
        first = aiReady ? intentEl : (q('.js-vn-manual') as HTMLElement);
      } else {
        // Regenerate is disabled while the model is thinking, and focusing a
        // disabled button is a no-op that would strand focus outside the dialog.
        first = regenBtn.disabled ? (q('.js-vn-manual2') as HTMLElement) : regenBtn;
      }
      if (first) first.focus();
    }

    // ── Step 3: ask, then DRAW each proposal ────────────────────────────────
    // Every figure on screen here comes from window.hub.computeVisualData —
    // app-computed in main, off the stored Parquet. The model contributed the
    // encoding, the chart type and the caption, and no number at all.
    async function runSuggest(): Promise<void> {
      if (!selectedId) return;
      showStep(3);
      regenBtn.disabled = true;
      optionsHost.innerHTML = '';
      statusEl.textContent = 'Thinking…';

      let res: any;
      try {
        res = await window.hub.suggestVisual(currentProjectId, selectedId, intentEl.value.trim());
      } catch (_) {
        res = { ok: false };
      }
      if (done) return; // the user closed the modal while the model was thinking
      regenBtn.disabled = false;

      if (res && res.notReady) {
        statusEl.textContent = 'Connect a model in Execution settings to suggest a chart.';
        return;
      }
      const options = res && res.ok && Array.isArray(res.options) ? res.options : [];
      if (!options.length) {
        statusEl.textContent = (res && res.error) || 'Could not suggest a chart.';
        return;
      }
      statusEl.textContent = 'Pick one to open it in the builder. Nothing is saved until you save it.';
      // Draw them concurrently: each is a resident query of a few ms, and a
      // serial loop would make three of them feel like one slow one.
      await Promise.all(options.map((o: any) => renderOption(o)));
    }

    async function renderOption(option: any): Promise<void> {
      const card = document.createElement('div');
      card.className = 'vn-option';
      const art = document.createElement('div');
      art.className = 'vn-option-art';
      const why = document.createElement('p');
      why.className = 'vn-option-why';
      why.textContent = String(option.why || '') || 'Suggested chart';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn btn-sm';
      use.textContent = 'Use this chart';
      use.disabled = true; // until it provably draws
      card.appendChild(art);
      card.appendChild(why);
      card.appendChild(use);
      optionsHost.appendChild(card);

      let data: any = null;
      let res: any;
      try {
        res = await window.hub.computeVisualData(currentProjectId, selectedId, option.encoding, []);
        if (res && res.ok !== false) data = res.data;
      } catch (_) {
        data = null;
      }
      if (done) return;

      // An option that cannot be drawn says so and stays unpickable — offering a
      // blank tile the user can pick would put a broken encoding in the builder.
      if (!data || !Array.isArray(data.labels) || !data.labels.length) {
        card.classList.add('is-broken');
        const note = document.createElement('span');
        note.className = 'vn-option-note';
        note.textContent = "Couldn't draw this one";
        art.appendChild(note);
        return;
      }

      // Which type actually gets drawn is CODE's decision, not the model's: if
      // the proposed type does not fit the data the app produced, the first
      // eligible one is used instead. Same eligibility the builder's picker runs.
      const eligible = eligibleChartTypes(res.recommendedShape, countNumericSeries(data), data.labels.length);
      const type = eligible.indexOf(option.chartType) >= 0 ? option.chartType : (eligible[0] || 'table');
      // A null entry is what turns the ⋯ Customize menu off (renderResult.ts):
      // a preview owns no overrides, so it needs no override key either.
      renderVizInArea(art, data, type, null, '');

      use.disabled = false;
      use.addEventListener('click', () =>
        close({ kind: 'suggested', datasetId: selectedId, encoding: option.encoding, chartType: type }));
    }

    sets.forEach((d) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'vn-row';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', 'false');
      const nm = document.createElement('span');
      nm.className = 'vn-row-name';
      nm.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      const meta = document.createElement('span');
      meta.className = 'vn-row-meta';
      const rows = typeof d.rowCount === 'number' ? d.rowCount.toLocaleString() : '—';
      const cols = typeof d.columnCount === 'number' ? String(d.columnCount) : '—';
      meta.textContent = rows + ' rows × ' + cols + ' columns';
      row.appendChild(nm);
      row.appendChild(meta);
      row.addEventListener('click', () => {
        selectedId = String(d.id);
        rowsHost.querySelectorAll('.vn-row').forEach((r: any) => r.setAttribute('aria-checked', 'false'));
        row.setAttribute('aria-checked', 'true');
        showStep(2);
      });
      rowsHost.appendChild(row);
    });
    rowsHost.hidden = sets.length === 0;
    noneEl.hidden = sets.length > 0;

    // No datasets: the one useful action is to go and import some. Leaves for
    // the existing Data section rather than re-hosting the import flow here.
    q('.js-vn-import').addEventListener('click', () => {
      close(null);
      if (typeof selectSection === 'function') selectSection('datasets');
    });

    // Without a model the AI route is inert, and says why in the standard line.
    if (!aiReady) {
      askBtn.disabled = true;
      intentEl.disabled = true;
      noteEl.hidden = false;
      q('.js-vn-ai').classList.add('is-disabled');
    }

    askBtn.addEventListener('click', () => { runSuggest(); });
    regenBtn.addEventListener('click', () => { runSuggest(); });
    const goManual = (): void => {
      if (!selectedId) return;
      close({ kind: 'manual', datasetId: selectedId });
    };
    q('.js-vn-manual').addEventListener('click', goManual);
    q('.js-vn-manual2').addEventListener('click', goManual);

    backBtn.addEventListener('click', () => showStep(step3.hidden ? 1 : 2));
    q('.js-vn-cancel').addEventListener('click', () => close(null));
    q('.js-vn-x').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'New visual', null);
    // The builder already knows its dataset, so it skips straight to asking.
    if (opts.startAtSuggest && selectedId) runSuggest();
    else showStep(selectedId ? 2 : 1);
  });
}

// "+ New visual": ask first, then open the builder on the chosen dataset. A
// suggestion is applied to the form and NEVER saved — the user still reviews it.
async function handleNewVisual(): Promise<void> {
  // Projects are demoted BY DESIGN: created implicitly, never picked, and there
  // is no project picker in the nav. So "Open a project first" was a dead end —
  // on a fresh install there are no projects and nothing on screen can make one.
  // Resolve (or create) one the same way the Home "+ New" entries do.
  if (!currentProjectId && !(await resolveProjectId())) {
    showToast('Could not create a workspace to save this in.');
    return;
  }
  const choice = await openNewVisualModal();
  if (!choice) return; // cancelled — nothing was created
  await openVisualBuilder(choice.datasetId);
  if (choice.kind === 'suggested') applySuggestedEncoding(choice.encoding, choice.chartType || '');
}

// ── Builder open / close ─────────────────────────────────────────────────────
async function loadDatasetOptions(selectedId: string): Promise<any[]> {
  let items: any[] = [];
  if (currentProjectId) {
    try {
      items = await window.hub.listDatasets(currentProjectId);
    } catch (_) {
      items = [];
    }
  }
  if (!Array.isArray(items)) items = [];
  const sel = vizSelect('viz-dataset-select');
  fillSelect(
    sel,
    items.map((d) => ({ value: String(d.id), label: (d && d.name ? String(d.name) : 'Untitled dataset') })),
    selectedId,
  );
  return items;
}

// `datasetId` preselects the dataset (the create popup already asked which one);
// omitted, the builder falls back to the first in the list, as it always did.
async function openVisualBuilder(datasetId?: string): Promise<void> {
  if (!currentProjectId) {
    window.alert('Open a project first.');
    return;
  }
  vizEditingId = '';
  vizCurrentChartType = '';
  vizOverrides = {};
  ensureVizForm();
  const datasets = await loadDatasetOptions(datasetId || '');
  showVizGallery(false);
  if (!datasets.length) {
    // No datasets to build from — show the builder shell with a clear hint.
    if (vizForm) vizForm.show(false);
    setVizWarnings(['Import a dataset in the Datasets section first, then build a visual from it.']);
    clearVizArea();
    return;
  }
  const sel = vizSelect('viz-dataset-select');
  await onDatasetChange(sel ? sel.value : String(datasets[0].id));
}

function closeVisualBuilder(): void {
  showVizGallery(true);
  vizEditingId = '';
  vizDatasetId = '';
  vizCurrentChartType = '';
  vizOverrides = {};
  vizPicker = null;
  if (vizForm) vizForm.show(false);
  const sh = vizEl('viz-suggest-hint');
  if (sh) sh.hidden = true;
  clearVizArea();
  setVizWarnings([]);
}

// Load a dataset's columns and (re)build the encoding controls. When restoring a
// saved visual, `preset` carries its stored encoding so the form matches it.
async function onDatasetChange(datasetId: string, preset?: any): Promise<void> {
  if (!currentProjectId || !datasetId) return;
  let ds: any = null;
  try {
    ds = await window.hub.getDatasetMeta(currentProjectId, datasetId);
  } catch (_) {
    ds = null;
  }
  if (!ds) {
    if (vizForm) vizForm.show(false);
    setVizWarnings(['That dataset could not be loaded.']);
    clearVizArea();
    return;
  }
  vizDatasetId = String(ds.id || datasetId);
  const cols = Array.isArray(ds.columns)
    ? ds.columns.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];
  ensureVizForm();
  // The form decides the default category, the default measure and the sort
  // order of the options. Restoring a saved visual is the same call with a
  // preset, so "new" and "reopened" cannot drift apart.
  vizForm!.setColumns(cols, preset, preset && Array.isArray(preset.filters) ? preset.filters : []);

  vizForm!.show(true);
  await recomputeVisual();
}

// ── Encoding → recompute → render ────────────────────────────────────────────
function scheduleRecompute(): void {
  if (vizRecomputeTimer !== null) window.clearTimeout(vizRecomputeTimer);
  vizRecomputeTimer = window.setTimeout(() => {
    vizRecomputeTimer = null;
    recomputeVisual();
  }, 160);
}

function setVizWarnings(warnings: string[]): void {
  const box = vizEl('viz-warnings');
  if (!box) return;
  box.innerHTML = '';
  (warnings || []).forEach((w) => {
    const line = document.createElement('div');
    line.className = 'viz-warning';
    line.textContent = String(w);
    box.appendChild(line);
  });
  box.hidden = !warnings || warnings.length === 0;
}

function clearVizArea(): void {
  const area = vizEl('viz-area');
  if (area) area.innerHTML = '';
  const mount = vizEl('viz-switcher-mount');
  if (mount) mount.innerHTML = '';
  vizPicker = null;
}

// Ask main for the renderer-ready data, then (re)build the shared chart-type
// picker + draw the current type. Mirrors renderTurnResult's picker wiring.
async function recomputeVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) return;
  const encoding = vizForm!.getEncoding();
  let res: any;
  try {
    res = await window.hub.computeVisualData(currentProjectId, vizDatasetId, encoding, vizForm!.getFilters());
  } catch (_) {
    res = { ok: false, error: 'Could not compute the visual.' };
  }
  if (!res || res.ok === false) {
    setVizWarnings([(res && res.error) || 'Could not compute the visual.']);
    clearVizArea();
    return;
  }
  const data = res.data || { labels: [], series: [] };
  setVizWarnings(Array.isArray(res.warnings) ? res.warnings : []);

  const area = vizEl('viz-area');
  const mount = vizEl('viz-switcher-mount');
  if (!area || !mount) return;
  mount.innerHTML = '';

  // Chart chips come from the underlying data shape so charts stay offered even
  // for a geo encoding; the map is appended AFTER (never the default).
  let shape = res.recommendedShape;
  if (data.geo) {
    const catCol = vizForm!.getColumns().find((c) => c.name === encoding.category);
    shape = catCol && catCol.type === 'date' ? 'time_series' : 'categorical';
  }
  const recommended = eligibleChartTypes(shape, countNumericSeries(data), (data.labels || []).length);
  if (data.geo) recommended.push('map_choropleth'); // maps after charts, never first

  if (!recommended.length) {
    area.innerHTML = '';
    const m = document.createElement('div');
    m.className = 'cv-chart-fallback';
    m.textContent = 'Pick a category and at least one measure to draw a chart.';
    area.appendChild(m);
    vizPicker = null;
    return;
  }

  const initial =
    vizCurrentChartType && (recommended.indexOf(vizCurrentChartType) >= 0 || canShow(vizCurrentChartType, data))
      ? vizCurrentChartType
      : recommended[0];

  const picker = buildVizPicker({
    recommended,
    pool: ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']),
    data,
    hasGeo: !!data.geo,
    initial,
    onSelect: (type: string, info: any) => {
      vizCurrentChartType = type;
      if (!info.canRender) {
        area.innerHTML = '';
        const m = document.createElement('div');
        m.className = 'cv-chart-fallback';
        m.textContent = (VIZ_LABELS[type] || type) + ' needs ' + info.needs + " — it doesn't fit this data.";
        area.appendChild(m);
        return;
      }
      // Render through the adapter entry so the ⋯ Customize menu + Values/Periods
      // controls attach; overrides persist via the entry's saveOverride (§4/§6).
      // The identity (same project/dataset/encoding/filters this data came from)
      // rides along for the Mosaic engine; with the flag off it is ignored.
      renderVizViaEntry(area, data, type, {
        projectId: currentProjectId, datasetId: vizDatasetId, encoding, filters: vizForm!.getFilters(),
      });
    },
  });
  vizPicker = picker;
  mount.appendChild(picker.switcher);
  requestAnimationFrame(() => picker.select(initial));
}

// A saved map type is valid to restore even if it's not in `recommended` (which
// lists charts first); a map is showable whenever the data carries geo.
function canShow(type: string, data: any): boolean {
  if (type === 'map_bubble' || type === 'map_choropleth') return !!data.geo;
  if (type === 'table') return true;
  return false;
}

// ── Open a saved visual into the builder ─────────────────────────────────────
async function openSavedVisual(id: string): Promise<void> {
  if (!currentProjectId) return;
  let visual: any = null;
  try {
    visual = await window.hub.getVisual(currentProjectId, id);
  } catch (_) {
    visual = null;
  }
  if (!visual) {
    window.alert('That visual could not be loaded.');
    await refreshVisualList();
    return;
  }
  vizEditingId = String(visual.id || id);
  vizCurrentChartType = typeof visual.chartType === 'string' ? visual.chartType : '';
  vizOverrides = visual.overrides && typeof visual.overrides === 'object' ? visual.overrides : {};
  const savedFilters = Array.isArray(visual.filters)
    ? visual.filters.map((f: any) => ({
        type: 'filter',
        column: f && f.column != null ? String(f.column) : '',
        op: f && f.op != null ? String(f.op) : '=',
        value: f && f.value != null ? String(f.value) : '',
      }))
    : [];
  await loadDatasetOptions(String(visual.datasetId || ''));
  showVizGallery(false);
  // Encoding AND filters go in as one preset, so restoring a saved visual is the
  // same code path as opening a new one.
  await onDatasetChange(String(visual.datasetId || ''),
                        { ...(visual.encoding || {}), filters: savedFilters });
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function handleSaveVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const encoding = vizForm!.getEncoding();
  if (!encoding.category || !Array.isArray(encoding.values) || encoding.values.length === 0) {
    window.alert('Pick a category and at least one measure before saving.');
    return;
  }
  const chartType = vizCurrentChartType || 'column';
  const suggested = suggestVisualName(encoding, chartType);
  const name = await promptModal(vizEditingId ? 'Rename this visual' : 'Name this visual', suggested, 'Save');
  if (name === null) return;
  const finalName = name.trim() || suggested;

  let res: any;
  try {
    const filters = vizForm!.getFilters();
    if (vizEditingId) {
      res = await window.hub.updateVisual(currentProjectId, vizEditingId, { name: finalName, chartType, encoding, overrides: vizOverrides, filters });
      res = res && res.ok ? res.visual : res;
    } else {
      res = await window.hub.saveVisual({ projectId: currentProjectId, datasetId: vizDatasetId, name: finalName, chartType, encoding, overrides: vizOverrides, filters });
    }
  } catch (_) {
    window.alert('Failed to save the visual.');
    return;
  }
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Failed to save the visual.');
    return;
  }
  closeVisualBuilder();
  await refreshVisualList();
}

// ── AI chart suggestion (structure only; never numbers; review before apply) ──
// The builder's ✨ Suggest chart opens the SAME modal the create popup uses,
// straight at its results step with an empty intent. A drawn picker replaced the
// old window.confirm: "apply the suggested chart?" asked the user to accept a
// chart they had not seen.
async function handleSuggestVisual(): Promise<void> {
  if (!currentProjectId || !vizDatasetId) {
    window.alert('Pick a dataset first.');
    return;
  }
  const hint = vizEl('viz-suggest-hint');
  if (hint) hint.hidden = true;
  const choice = await openNewVisualModal({ datasetId: vizDatasetId, startAtSuggest: true });
  // 'manual' and cancel both mean "leave the builder as it is" — it is already
  // open on this dataset, which is what Build it myself asks for.
  if (choice && choice.kind === 'suggested') applySuggestedEncoding(choice.encoding, choice.chartType || '');
}

// Populate the builder form from a suggested encoding (never auto-saves). Numbers
// are recomputed by the app on the recompute that follows.
function applySuggestedEncoding(enc: any, chartType: string): void {
  if (!enc || typeof enc !== 'object' || !vizForm) return;
  // Same call the dataset switch and the saved-visual restore make. A suggestion
  // is just another preset, so it cannot support a field the other two do not.
  vizForm.setEncoding(enc);
  if (typeof chartType === 'string' && chartType) vizCurrentChartType = chartType;
  recomputeVisual();
}

function suggestVisualName(encoding: any, chartType: string): string {
  const typeLabel = VIZ_LABELS[chartType] || chartType || 'Chart';
  const measure = encoding.values && encoding.values[0] ? encoding.values[0].column : '';
  const cat = encoding.category || '';
  if (measure && cat) return `${measure} by ${cat}`;
  return `${typeLabel}`;
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initVisuals(): void {
  // Two "+ New visual" buttons: the gallery header's and the empty state's.
  ['viz-new-btn', 'viz-empty-new-btn'].forEach((btnId) => {
    const b = vizEl(btnId);
    if (b) b.addEventListener('click', () => handleNewVisual());
  });

  // "← Back to visuals": leave the builder and repaint the gallery, so a delete
  // or a rename made while the builder was open shows immediately.
  const cancelBtn = vizEl('viz-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    closeVisualBuilder();
    refreshVisualList();
  });

  const saveBtn = vizEl('viz-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveVisual());

  const suggestBtn = vizEl('viz-suggest-btn');
  if (suggestBtn) suggestBtn.addEventListener('click', () => handleSuggestVisual());

  const dsSel = vizSelect('viz-dataset-select');
  if (dsSel) dsSel.addEventListener('change', () => {
    // Switching dataset starts a fresh build — clear the open visual + its styling/filters.
    vizEditingId = '';
    vizCurrentChartType = '';
    vizOverrides = {};
    onDatasetChange(dsSel.value);
  });
  // Category / Split / Geo / measures / filters are the encoding form's, and it
  // reports every one of them through the single onChange in ensureVizForm().
}

// Mount the encoding form once, into the builder. Its onChange is the ONE place
// an encoding edit becomes a recompute.
function ensureVizForm(): void {
  if (vizForm) return;
  const mount = vizEl('viz-encoding-mount');
  if (!mount) return;
  vizForm = createEncodingForm(mount, {
    onChange: () => scheduleRecompute(),
    // Resolved at click time: the builder's dataset changes under the form.
    dataset: () =>
      currentProjectId && vizDatasetId ? { projectId: currentProjectId, datasetId: vizDatasetId } : null,
  });
}
