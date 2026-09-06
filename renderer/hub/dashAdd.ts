// Adding to a sheet: the visual picker, the metric form with its live preview,
// the text card, and the two starter layouts that scaffold an empty sheet.
//
// The preview number here is computed by the SAME window.hub.computeMetric call
// the card itself makes, with the sheet's filters — the renderer never does the
// arithmetic and a model never supplies the figure.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── Add-card flows ────────────────────────────────────────────────────────────
function pushCard(card: any): void {
  const page = dashCurrentPage();
  if (!page) return;
  if (!Array.isArray(page.cards)) page.cards = [];
  page.cards.push(card);
  markDashDirty();
  renderDashGrid();
}

async function handleAddVisual(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  let visuals: any[] = [];
  try {
    visuals = await window.hub.listVisuals(currentProjectId);
  } catch (_) {
    visuals = [];
  }
  if (!Array.isArray(visuals)) visuals = [];

  const pick = await openVisualPicker(visuals);
  if (!pick) return;

  if (pick.kind === 'existing') {
    pushCard({ id: dashUuid(), type: 'visual', visualId: pick.visualId, layout: { x: 0, y: nextFreeRow(), w: 6, h: 6 } });
    return;
  }

  // 'new' | 'ai' — create a visual WITHOUT leaving the analysis. The create
  // popup (visuals.ts) only RESOLVES a choice; the navigation to the Visuals
  // builder was always its caller's doing, so from here we simply do something
  // else with the same resolution:
  //   suggested → the user already SAW the drawn chart they picked, so it is
  //     saved as a visual (name derived the same way the builder's Save
  //     suggests one) and lands on the sheet;
  //   manual → a BLANK visual on the chosen dataset lands on the sheet and is
  //     selected, which opens Properties — the wells ARE the analysis's own
  //     builder, exactly what the old Add-panel hint promised ("a new visual
  //     card starts blank — pick its fields under Properties").
  const choice = await openNewVisualModal(pick.kind === 'ai' ? { aiOnly: true } : {});
  if (!choice) return;
  const suggested = choice.kind === 'suggested';
  const chartType = suggested ? (choice.chartType || 'column') : 'column';
  let visual: any = null;
  try {
    visual = await window.hub.saveVisual({
      projectId: currentProjectId,
      datasetId: choice.datasetId,
      name: suggested ? suggestVisualName(choice.encoding || {}, chartType) : 'Untitled visual',
      chartType,
      encoding: suggested ? choice.encoding : { category: '', values: [] },
      overrides: {},
      filters: [],
    });
  } catch (_) {
    visual = null;
  }
  if (!visual || visual.ok === false || !visual.id) {
    showToast('Could not create the visual.');
    return;
  }
  const card = { id: dashUuid(), type: 'visual', visualId: String(visual.id), layout: { x: 0, y: nextFreeRow(), w: 6, h: 6 } };
  pushCard(card);
  // Select it so Properties binds (and, for a blank one, opens on the wells the
  // user fills next). Analysis mode only — a dashboard has no workbench.
  if (dashMode === 'analysis' && typeof anSelectCard === 'function') await anSelectCard(card.id);
}

/**
 * The add-visual picker: a GALLERY of the saved visuals — the same tile
 * vocabulary as the Visuals section's cards (glyph, name, type · time) — plus
 * the two ways to make a new one, which is what kills the old dead-end where an
 * empty name-list was the whole dialog.
 *
 * Resolves what to do, does nothing itself: 'existing' carries the picked id;
 * 'new' / 'ai' hand off to `openNewVisualModal` in the caller (sequential
 * dialogs, never stacked). The create actions are offered in ANALYSIS mode
 * only: a standalone dashboard has no wells to author a blank visual with.
 */
function openVisualPicker(
  visuals: any[],
): Promise<{ kind: 'existing'; visualId: string } | { kind: 'new' } | { kind: 'ai' } | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal vn-pick-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'Add a visual';

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: { kind: 'existing'; visualId: string } | { kind: 'new' } | { kind: 'ai' } | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (a11y) a11y.onTabKey(e);
    }

    const canCreate = dashMode === 'analysis';
    const actions = document.createElement('div');
    actions.className = 'vn-pick-actions';
    if (canCreate) {
      const mk = (label: string, kind: 'new' | 'ai'): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        b.addEventListener('click', () => close({ kind }));
        actions.appendChild(b);
        return b;
      };
      mk('+ New visual', 'new');
      const ai = mk('✨ Suggest with the Assistant', 'ai');
      // The standard not_ready treatment: disabled, with the standard sentence.
      // Painted async — the dialog opens instantly and the button un-disables
      // if a model turns out to be configured.
      ai.disabled = true;
      const note = document.createElement('p');
      note.className = 'vn-pick-note';
      note.hidden = true;
      note.textContent = AI_NOT_CONFIGURED;
      actions.appendChild(note);
      window.hub.getKeyStatus().then((st: any) => {
        if (done) return;
        if (st && st.isReady) ai.disabled = false;
        else note.hidden = false;
      }).catch(() => { if (!done) note.hidden = false; });
    }

    const grid = document.createElement('div');
    grid.className = 'vn-pick-grid';
    visuals.forEach((v) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'vn-pick-tile';
      const art = document.createElement('span');
      art.className = 'vn-pick-glyph';
      // The ONLY innerHTML here: VIZ_ICONS is the trusted static SVG constant
      // set (renderResult.ts), never user or model input.
      art.innerHTML = VIZ_ICONS[v && v.chartType] || VIZ_ICONS.column;
      const nm = document.createElement('span');
      nm.className = 'vn-pick-name';
      nm.textContent = v && v.name ? String(v.name) : 'Untitled visual';
      const meta = document.createElement('span');
      meta.className = 'vn-pick-meta';
      meta.textContent =
        ((v && VIZ_LABELS[v.chartType]) || (v && v.chartType) || 'Chart') + ' · ' + formatSidebarTime(v && v.updatedAt);
      tile.appendChild(art);
      tile.appendChild(nm);
      tile.appendChild(meta);
      tile.addEventListener('click', () => close({ kind: 'existing', visualId: String(v.id) }));
      grid.appendChild(tile);
    });

    const footer = document.createElement('div');
    footer.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(null));
    footer.appendChild(cancel);

    box.appendChild(h);
    box.appendChild(actions);
    if (visuals.length) {
      box.appendChild(grid);
    } else if (canCreate) {
      // No saved visuals: the two create actions ARE the content, large and
      // centred — the dead-end this picker replaces was an empty list here.
      box.classList.add('vn-pick-modal--empty');
      const p = document.createElement('p');
      p.className = 'vn-pick-empty';
      p.textContent = 'No saved visuals yet — make one right here.';
      box.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.className = 'dash-modal-empty';
      p.textContent = 'Nothing to pick — create one in its section first.';
      box.appendChild(p);
    }
    box.appendChild(footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Add a visual', null);
  });
}

async function handleAddMetric(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  let datasets: any[] = [];
  try {
    datasets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    datasets = [];
  }
  if (!Array.isArray(datasets)) datasets = [];
  const metric = await openMetricDialog(datasets);
  if (!metric) return;
  pushCard({ id: dashUuid(), type: 'metric', metric, layout: { x: 0, y: nextFreeRow(), w: 3, h: 2 } });
}

/**
 * ONE dialog for the whole metric — dataset, column, aggregation, label — where
 * adding one used to be FOUR chained modals, each of which forgot the last.
 *
 * The preview is the number the card will show, computed by the SAME call the
 * metric card on the sheet makes (`window.hub.computeMetric`, main-only, with
 * the sheet's current filters) — not a second compute that could disagree with
 * it. Nothing is ever computed in the renderer and nothing is stored: the card
 * recomputes on every render exactly as before; this just shows the user what
 * they are adding before they add it.
 *
 * Same modal shell as `dashChooseModal`: backdrop, Escape, focus trapped and
 * returned via the shared `makeModalAccessible`.
 */
function openMetricDialog(
  datasets: any[],
): Promise<{ datasetId: string; column: string; aggregation: string; label?: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal dash-metric-modal';
    const h = document.createElement('div');
    h.className = 'ws-modal-title';
    h.textContent = 'Add a metric';

    const field = (labelText: string, control: HTMLElement): HTMLElement => {
      const row = document.createElement('label');
      row.className = 'dm-field';
      const span = document.createElement('span');
      span.className = 'dm-field-label';
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(control);
      return row;
    };

    const dsSel = document.createElement('select');
    dsSel.className = 'ws-modal-input';
    datasets.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      dsSel.appendChild(opt);
    });

    const colSel = document.createElement('select');
    colSel.className = 'ws-modal-input';

    // Aggregation as a segmented row, not a fifth dropdown — five options with
    // one always active is a radio group, and seeing them all is what makes
    // "Count of a text column" discoverable.
    const aggRow = document.createElement('div');
    aggRow.className = 'dm-aggs';
    aggRow.setAttribute('role', 'radiogroup');
    aggRow.setAttribute('aria-label', 'Aggregation');
    let aggregation: DashAgg = 'sum';
    const paintAggs = (): void => {
      aggRow.querySelectorAll('.dm-agg').forEach((b) => {
        const on = (b as HTMLElement).dataset.agg === aggregation;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    DASH_AGGS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-agg';
      b.dataset.agg = a;
      b.setAttribute('role', 'radio');
      b.textContent = DASH_AGG_LABELS[a];
      b.addEventListener('click', () => { aggregation = a; paintAggs(); onChange(); });
      aggRow.appendChild(b);
    });

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'ws-modal-input';
    labelInput.placeholder = 'Label';
    // The label follows the other three fields until the user edits it by hand —
    // after that it is theirs and no change below may clobber it.
    let labelTouched = false;
    labelInput.addEventListener('input', () => { labelTouched = true; });
    const autoLabel = (): string => DASH_AGG_LABELS[aggregation] + ' of ' + (colSel.value || '');

    // The live preview: label + value, the same pair the card renders.
    const preview = document.createElement('div');
    preview.className = 'dm-preview';
    const prevVal = document.createElement('div');
    prevVal.className = 'dash-metric-value';
    prevVal.textContent = '—';
    const prevLabel = document.createElement('div');
    prevLabel.className = 'dash-metric-label';
    preview.appendChild(prevVal);
    preview.appendChild(prevLabel);

    // Debounced, generation-counted: a slow reply for the previous column must
    // not paint over the current one.
    let previewTimer = 0;
    let previewSeq = 0;
    const runPreview = async (): Promise<void> => {
      const seq = ++previewSeq;
      const dsId = dsSel.value;
      const column = colSel.value;
      prevLabel.textContent = labelInput.value.trim() || autoLabel();
      if (!dsId || !column || !currentProjectId) { prevVal.textContent = '—'; return; }
      prevVal.textContent = '…';
      let r: any;
      try {
        r = await window.hub.computeMetric(
          currentProjectId, dsId, column, aggregation,
          effectiveFilters(),
        );
      } catch (_) {
        r = { ok: false };
      }
      if (done || seq !== previewSeq) return;
      if (!r || r.ok === false || r.value == null) { prevVal.textContent = '—'; return; }
      prevVal.textContent = fmtWith(r.value, 'auto');
    };
    const onChange = (): void => {
      if (!labelTouched) labelInput.value = autoLabel();
      prevLabel.textContent = labelInput.value.trim() || autoLabel();
      if (previewTimer) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => { previewTimer = 0; void runPreview(); }, 200);
    };

    // Columns for the picked dataset, NUMERIC FIRST — sum/avg/min/max only mean
    // something on a number column, so those are the likely picks. A stable sort
    // keeps the dataset's own order within each group.
    const loadColumns = async (): Promise<void> => {
      colSel.innerHTML = '';
      let meta: any = null;
      try {
        meta = currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, dsSel.value) : null;
      } catch (_) {
        meta = null;
      }
      if (done) return;
      const cols: any[] = meta && Array.isArray(meta.columns) ? meta.columns : [];
      const ordered = cols
        .map((c, i) => ({ c, i }))
        .sort((a, b) => Number(b.c && b.c.type === 'number') - Number(a.c && a.c.type === 'number') || a.i - b.i);
      ordered.forEach(({ c }) => {
        const opt = document.createElement('option');
        opt.value = String(c.name);
        opt.textContent = String(c.name) + (c.type ? ' (' + c.type + ')' : '');
        colSel.appendChild(opt);
      });
      ok.disabled = colSel.options.length === 0;
      onChange();
    };
    dsSel.addEventListener('change', () => { void loadColumns(); });
    colSel.addEventListener('change', onChange);
    labelInput.addEventListener('input', onChange);

    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = 'Add';
    ok.disabled = datasets.length === 0;

    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    function close(val: { datasetId: string; column: string; aggregation: string; label?: string } | null): void {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(val);
    }
    function submit(): void {
      if (ok.disabled || !dsSel.value || !colSel.value) return;
      const out: { datasetId: string; column: string; aggregation: string; label?: string } = {
        datasetId: dsSel.value, column: colSel.value, aggregation,
      };
      // A hand-written label is kept; the auto one is not stored, so the card
      // keeps deriving it and a later column rename stays truthful.
      if (labelTouched && labelInput.value.trim()) out.label = labelInput.value.trim();
      close(out);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
      else if (a11y) a11y.onTabKey(e);
    }
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    if (datasets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'dash-modal-empty';
      empty.textContent = 'Import a dataset first — a metric reads one.';
      box.appendChild(empty);
    } else {
      box.appendChild(field('Dataset', dsSel));
      box.appendChild(field('Column', colSel));
      box.appendChild(field('Aggregation', aggRow));
      box.appendChild(field('Label', labelInput));
      box.appendChild(preview);
    }
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    a11y = makeModalAccessible(box, 'Add a metric', datasets.length ? dsSel : cancel);
    paintAggs();
    if (datasets.length) void loadColumns();
  });
}

async function handleAddText(): Promise<void> {
  const heading = await promptModal('Text card — heading (optional)', '', 'Next');
  if (heading === null) return;
  const text = await promptModal('Text card — body (optional)', '', 'Add');
  if (text === null) return;
  if (!heading.trim() && !text.trim()) return; // a card with no content is dropped anyway
  const card: any = { id: dashUuid(), type: 'text', layout: { x: 0, y: nextFreeRow(), w: 6, h: 2 } };
  if (heading.trim()) card.heading = heading.trim();
  if (text.trim()) card.text = text.trim();
  pushCard(card);
}

// ── Starter layouts ─────────────────────────────────────────────────────────
// A starter builds REAL tiles from a dataset's own columns. It used to insert a
// text card reading "Add metric cards here" and then ask which SAVED VISUAL went
// in each slot — so on a fresh project, where no visual exists yet, the whole
// layout was one text card telling you to do it yourself.
//
// The cards come from main (analysis:starterCards → starterPlan → the same
// buildPlanRecords the Assistant's plan runs through), and they are placed HERE:
// dashCurrent is the live record this editor owns, and markDashDirty is the one
// debounced write. Main writing it directly would be clobbered by the next save.
async function applyStarter(kind: string, datasetId?: string): Promise<void> {
  const page = dashCurrentPage();
  if (!page || !currentProjectId) return;
  if (!Array.isArray(page.cards)) page.cards = [];
  if (page.cards.length && !window.confirm('Add starter cards to this page?')) return;

  const dsId = datasetId || await pickStarterDataset();
  if (!dsId) return;

  let res: any;
  try {
    res = await window.hub.starterCards(currentProjectId, kind, dsId);
  } catch (_) { res = null; }
  if (!res || res.ok === false || !Array.isArray(res.cards) || !res.cards.length) {
    window.alert((res && res.error) || 'Could not build a starter layout from that dataset.');
    return;
  }

  // Main packed from y = 0 against an empty grid. Read the offset ONCE: it
  // recomputes as cards land, so reading it per card would stagger them.
  const y0 = nextFreeRow();
  for (const card of res.cards) {
    if (card && card.layout) card.layout.y = (card.layout.y || 0) + y0;
    page.cards.push(card);
  }
  markDashDirty();
  renderDashPages();
  renderDashGrid();
  // Anything the validator refused is said out loud rather than silently missing
  // — the same rule the Assistant's proposal card follows.
  if (Array.isArray(res.dropped) && res.dropped.length) {
    showToast(res.dropped.length === 1 ? 'One tile could not be built.' : `${res.dropped.length} tiles could not be built.`);
  }
}

/** Which dataset the layout is built from. Silent when there is only one. */
async function pickStarterDataset(): Promise<string | null> {
  let list: any[] = [];
  try { list = await window.hub.listDatasets(currentProjectId); } catch (_) { list = []; }
  if (!Array.isArray(list) || !list.length) {
    window.alert('Import a dataset first — a starter layout builds from one.');
    return null;
  }
  if (list.length === 1) return String(list[0].id);
  return await dashChooseModal(
    'Build the starter layout from',
    list.map((d) => ({ value: String(d.id), label: d && d.name ? String(d.name) : 'Untitled dataset' })),
    'Build',
  );
}

