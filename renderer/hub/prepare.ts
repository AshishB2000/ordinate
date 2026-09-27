// Prepare view — a reversible transform pipeline over a saved dataset. Classic
// global-scope renderer <script> (NO import/export); shares one scope with
// datasets.ts, from which it reads: expId, expColumns, expRows, currentProjectId,
// promptModal, dsEl/dsShow, normalizeCols, renderExplorerTable, loadExplorerStats,
// refreshDatasetList. The dataset's immutable `source` + ordered `steps` live in
// MAIN; every mutation here calls a window.hub bridge that recomputes the derived
// output from source and returns { ok, dataset, preview }. The explorer table IS
// the live preview of the prepared output. All values rendered as textContent only
// (no HTML injection). No inline style= (CSP) — toggle via .hidden in JS.

// ── Pipeline state (mirrors the persisted ds.steps; set on open in datasets.ts) ──
let expSteps: any[] = [];
let dsStepEditIndex = -1; // -1 = adding a new step; >=0 = editing that index
let dsStepEditType = '';
let dsSuggestedSteps: any[] = []; // AI-proposed steps awaiting user confirmation
let dsTypeMenuClose: (() => void) | null = null; // openMiniMenu's closer, while the Add-step menu is up
// Rows into/out of each step, index-aligned with expSteps — counted by main.
// null = not known yet for this dataset (loadStepCounts fetches it).
let expStepCounts: any[] | null = null;

const STEP_TYPES: Array<{ type: string; label: string }> = [
  { type: 'calculated_field', label: 'Calculated field' },
  { type: 'filter', label: 'Filter rows' },
  { type: 'group_aggregate', label: 'Group & aggregate' },
  { type: 'dedupe', label: 'Remove duplicates' },
  { type: 'fill_empty', label: 'Fill empty cells' },
  { type: 'trim', label: 'Trim whitespace' },
  { type: 'drop_column', label: 'Drop column' },
  { type: 'rename_column', label: 'Rename column' },
  // Forms and summaries in prepareMask.ts.
  { type: 'mask_hash', label: 'Mask — hash' },
  { type: 'mask_redact', label: 'Mask — redact' },
  { type: 'mask_generalize', label: 'Mask — generalise' },
  // The power steps (prepareReshape / prepareClean / prepareCombine).
  { type: 'split_column', label: 'Split column' },
  { type: 'replace_values', label: 'Replace values' },
  { type: 'conditional_column', label: 'Conditional column' },
  { type: 'parse_date', label: 'Parse dates' },
  { type: 'dedupe_key', label: 'Keep one row per key' },
  { type: 'window', label: 'Window (rank, previous, running total)' },
  { type: 'unpivot', label: 'Unpivot columns to rows' },
  { type: 'pivot', label: 'Pivot rows to columns' },
  { type: 'lookup_join', label: 'Look up from another dataset' },
  { type: 'union', label: 'Append another dataset' },
  // The text family (textSteps.ts).
  { type: 'text_terms', label: 'Text — count terms' },
  { type: 'text_sentiment', label: 'Text — sentiment score' },
  { type: 'keyword_rules', label: 'Text — tag with keyword rules' },
];
const FILTER_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty', 'in', 'not in'];
const AGG_FNS = ['sum', 'avg', 'count', 'min', 'max'];

function pEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Steps list (ordered, editable) ───────────────────────────────────────────
function stepSummaryText(step: any): string {
  if (!step || typeof step !== 'object') return 'Unknown step';
  switch (step.type) {
    case 'calculated_field':
      return 'Calculated field "' + step.name + '" = ' + step.expression;
    case 'filter':
      if (step.op === 'period') return 'Filter: ' + step.column + ' in ' + periodLabel(step.period).toLowerCase();
      if (step.op === 'is_empty') return 'Filter: ' + step.column + ' is empty';
      if (step.op === 'not_empty') return 'Filter: ' + step.column + ' is not empty';
      if (isListFilterOp(step.op)) {
        const list = formatFilterValues(step.values);
        // An empty list is SKIPPED by the pipeline (with a warning), so the
        // summary says so rather than implying the step is doing something.
        return 'Filter: ' + step.column + ' ' + step.op + ' ' + (list ? '(' + list + ')' : '— no values yet');
      }
      return 'Filter: ' + step.column + ' ' + step.op + ' ' + (step.value != null ? step.value : '');
    case 'group_aggregate': {
      const by = Array.isArray(step.groupBy) ? step.groupBy.join(', ') : '';
      const aggs = Array.isArray(step.aggregations)
        ? step.aggregations.map((a: any) => a.fn + '(' + a.column + ') → ' + a.as).join(', ')
        : '';
      return 'Group by ' + by + '; ' + aggs;
    }
    case 'dedupe': {
      const cols = Array.isArray(step.columns) && step.columns.length ? step.columns.join(', ') : 'all columns';
      return 'Remove duplicates by ' + cols;
    }
    case 'fill_empty':
      return 'Fill empty in ' + step.column + ' with "' + step.value + '"';
    case 'trim':
      return step.column ? 'Trim whitespace in ' + step.column : 'Trim whitespace (all text columns)';
    case 'drop_column':
      return 'Drop column ' + step.column;
    case 'rename_column':
      return 'Rename ' + step.from + ' → ' + step.to;
    default:
      return pvMaskSummary(step) || sgStepSummary(step) || txStepSummary(step) // prepareMask / segments / textSteps
        || powerStepSummary(step); // prepareCombine.ts
  }
}

function mkStepBtn(name: string, aria: string, disabled: boolean, cb: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ds-step-btn';
  iconOnly(b, name, aria);
  b.disabled = disabled;
  if (!disabled) b.addEventListener('click', cb);
  return b;
}

function renderStepsList(): void {
  const list = pEl('ds-steps-list');
  if (!list) return;
  list.innerHTML = '';
  if (!expSteps.length) {
    const empty = document.createElement('div');
    empty.className = 'ds-steps-empty';
    empty.textContent = 'No steps yet. Add one to transform the data — the original stays intact and every step is reversible.';
    list.appendChild(empty);
    return;
  }
  expSteps.forEach((step, i) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ds-step';

    const num = document.createElement('span');
    num.className = 'ds-step-num';
    num.textContent = String(i + 1);
    rowEl.appendChild(num);

    const summary = document.createElement('span');
    summary.className = 'ds-step-summary';
    summary.textContent = stepSummaryText(step);
    rowEl.appendChild(summary);

    // "1,250 → 1,180 rows": the rows this step received and handed on — a line
    // under the summary, so the narrow rail never squeezes the summary itself.
    const counts = expStepCounts && expStepCounts.length === expSteps.length ? expStepCounts[i] : null;
    if (counts) {
      const n = document.createElement('span');
      n.className = 'ds-step-count';
      n.textContent = fmtN(counts.before) + ' → ' + fmtN(counts.after) + ' rows';
      if (counts.before !== counts.after) n.classList.add('is-changed');
      summary.appendChild(n);
    }

    const actions = document.createElement('div');
    actions.className = 'ds-step-actions';
    actions.appendChild(mkStepBtn('arrow-up', 'Move step up', i === 0, () => moveStep(i, -1)));
    actions.appendChild(
      mkStepBtn('arrow-down', 'Move step down', i === expSteps.length - 1, () => moveStep(i, 1)),
    );
    actions.appendChild(mkStepBtn('pencil', 'Edit step', false, () => openStepEditor(step.type, i)));
    actions.appendChild(mkStepBtn('trash', 'Remove step', false, () => removeStep(i)));
    rowEl.appendChild(actions);

    list.appendChild(rowEl);
  });
}

// ── Apply an IPC { ok, dataset, preview } reply → refresh the live preview ─────
function applyStepResult(res: any): boolean {
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Failed to update the pipeline.');
    return false;
  }
  const preview = res.preview || {};
  expColumns = normalizeCols(preview.columns);
  expRows = Array.isArray(preview.rows) ? preview.rows : [];
  if (res.dataset && Array.isArray(res.dataset.steps)) expSteps = res.dataset.steps;
  expStepCounts = Array.isArray(preview.stepCounts) ? preview.stepCounts : null;
  renderPrepareWarnings(Array.isArray(preview.warnings) ? preview.warnings : []);
  renderStepsList();
  renderExplorerTable();
  refreshDatasetList(); // updatedAt + rowCount changed in the saved list
  loadExplorerStats(); // recompute summary chips / quality for the derived output
  return true;
}

function renderPrepareWarnings(warnings: any[]): void {
  const box = pEl('ds-prepare-warnings');
  if (!box) return;
  box.innerHTML = '';
  warnings.forEach((w) => {
    const line = document.createElement('div');
    line.className = 'ds-warning';
    line.textContent = String(w);
    box.appendChild(line);
  });
  box.hidden = warnings.length === 0;
}

// ── Step mutations (index-addressed; main recomputes from source) ─────────────
async function moveStep(i: number, dir: number): Promise<void> {
  if (!currentProjectId || !expId) return;
  const j = i + dir;
  if (j < 0 || j >= expSteps.length) return;
  const order = expSteps.map((_, k) => k);
  const tmp = order[i];
  order[i] = order[j];
  order[j] = tmp;
  const res = await window.hub.reorderDatasetSteps(currentProjectId, expId, order);
  applyStepResult(res);
}

async function removeStep(i: number): Promise<void> {
  if (!currentProjectId || !expId) return;
  const res = await window.hub.removeDatasetStep(currentProjectId, expId, i);
  applyStepResult(res);
}

// ── Step editor (per-type form built in JS) ───────────────────────────────────
function openStepEditor(type: string, index: number): void {
  // A calculated field is NOT a form. Routing it here rather than at the two
  // buttons that open a step editor is deliberate: the Add menu, the pipeline
  // row's ✎, and both AI suggestion paths all funnel through this function, so
  // one guard is what makes "there is only one formula editor" true instead of
  // true-in-the-places-someone-remembered.
  if (type === 'calculated_field') {
    openCalcField(index);
    return;
  }
  dsStepEditType = type;
  dsStepEditIndex = index;
  const editor = pEl('ds-step-editor');
  if (!editor) return;
  editor.innerHTML = '';
  const existing = index >= 0 ? expSteps[index] : null;

  const title = document.createElement('div');
  title.className = 'ds-step-editor-title';
  const meta = STEP_TYPES.find((s) => s.type === type);
  title.textContent = (index >= 0 ? 'Edit: ' : 'Add: ') + (meta ? meta.label : type);
  editor.appendChild(title);

  const body = document.createElement('div');
  body.className = 'ds-step-editor-body';
  editor.appendChild(body);

  const getStep = buildStepForm(type, body, existing);

  const actions = document.createElement('div');
  actions.className = 'ds-step-editor-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary';
  save.textContent = 'Save step';
  save.addEventListener('click', () => saveStepFromForm(getStep));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeStepEditor());
  actions.appendChild(save);
  actions.appendChild(cancel);
  editor.appendChild(actions);

  editor.hidden = false;
}

function closeStepEditor(): void {
  dsStepEditIndex = -1;
  const editor = pEl('ds-step-editor');
  if (editor) {
    editor.innerHTML = '';
    editor.hidden = true;
  }
}

async function saveStepFromForm(getStep: () => any): Promise<void> {
  const got = getStep();
  if (!got) return;
  if (!currentProjectId || !expId) return;
  // A filter form can return TWO steps (a min/max range). Everything else
  // returns one; normalising here keeps every other form untouched.
  const steps: any[] = Array.isArray(got) ? got : [got];
  if (steps.length === 0) return;

  let res: any;
  if (TX_STEP_TYPES.has(steps[0].type)) {
    // textSteps.ts: a job on a big table; Cancel there leaves the editor open.
    res = await txCommitStep(dsStepEditIndex, steps[0]);
    if (res && res.cancelled) return;
  } else if (dsStepEditIndex >= 0) {
    res = await window.hub.updateDatasetStep(currentProjectId, expId, dsStepEditIndex, steps[0]);
  } else {
    res = await window.hub.addDatasetStep(currentProjectId, expId, steps[0]);
  }
  // The extra bound of a range is APPENDED rather than inserted next to its
  // twin: there is no insert-at-index IPC, and it does not need one — filters
  // are pure row predicates, so where they sit in the order cannot change the
  // rows they produce (the same property dashboardFilters.ts relies on).
  for (let i = 1; i < steps.length && res && res.ok; i += 1) {
    res = await window.hub.addDatasetStep(currentProjectId, expId, steps[i]);
  }
  if (applyStepResult(res)) closeStepEditor();
}

// ── AI suggest steps (structure only; never auto-applies) ─────────────────────
async function handleSuggestSteps(): Promise<void> {
  if (!currentProjectId || !expId) return;
  const out = pEl('ds-suggest-out');
  const list = pEl('ds-suggest-list');
  const btn = pEl('ds-suggest-btn') as HTMLButtonElement | null;
  const actions = out ? (out.querySelector('.ds-suggest-actions') as HTMLElement | null) : null;
  dsSuggestedSteps = [];
  if (out) out.hidden = false;
  if (actions) actions.hidden = true;
  if (list) {
    list.className = 'ds-suggest-list ds-suggest-hint';
    list.textContent = 'Thinking…';
  }
  if (btn) btn.disabled = true;
  let res: any;
  try {
    res = await window.hub.suggestDatasetSteps(currentProjectId, expId);
  } catch (_) {
    res = { ok: false, error: 'Could not get suggestions.' };
  }
  if (btn) btn.disabled = false;
  if (!list) return;

  if (res && res.ok && Array.isArray(res.steps) && res.steps.length) {
    dsSuggestedSteps = res.steps;
    list.className = 'ds-suggest-list';
    list.innerHTML = '';
    res.steps.forEach((s: any, i: number) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'ds-suggest-item';
      rowEl.textContent = i + 1 + '. ' + stepSummaryText(s);
      list.appendChild(rowEl);
    });
    if (actions) actions.hidden = false;
  } else if (res && res.ok && Array.isArray(res.steps)) {
    list.className = 'ds-suggest-list ds-suggest-hint';
    list.textContent = 'No steps suggested — the data already looks ready.';
  } else if (res && res.notReady) {
    list.className = 'ds-suggest-list ds-suggest-hint';
    list.textContent = AI_NOT_CONFIGURED;
  } else {
    list.className = 'ds-suggest-list ds-suggest-hint';
    list.textContent = (res && res.error) || 'Could not get step suggestions.';
  }
}

// ── AI suggest calculated field (structure only) ──────────────────────────────
// The model proposes a { name, expression } — never a value; the app compiles and
// computes the formula. We open the EXISTING step editor prefilled so the user
// reviews/edits and clicks Save step (confirm-before-apply, fully editable).
async function handleSuggestCalcField(): Promise<void> {
  if (!currentProjectId || !expId) return;
  const out = pEl('ds-calc-suggest-out');
  const btn = pEl('ds-calc-suggest-btn') as HTMLButtonElement | null;

  const showHint = (msg: string) => {
    if (!out) return;
    out.hidden = false;
    out.innerHTML = '';
    const head = mkAiPanel('Assistant suggestion — the app compiles and computes the formula');
    out.appendChild(head);
    const hint = document.createElement('div');
    hint.className = 'ai-interp-hint';
    hint.textContent = msg;
    out.appendChild(hint);
  };

  showHint('Thinking…');
  if (btn) btn.disabled = true;

  let res: any;
  try {
    res = await window.hub.suggestCalcField(currentProjectId, expId);
  } catch (_) {
    res = { ok: false, error: 'Could not suggest a calculated field.' };
  }
  if (btn) btn.disabled = false;

  if (res && res.notReady) {
    showHint(AI_NOT_CONFIGURED);
    return;
  }
  if (!res || res.ok === false) {
    showHint((res && res.error) || 'Could not suggest a calculated field.');
    return;
  }

  // Success — open the editor prefilled; nothing is applied until the user Saves.
  if (out) { out.hidden = true; out.innerHTML = ''; }
  prefillCalcFieldEditor(res.name, res.expression, res.warning);
}

/**
 * Open the formula editor on a NEW calculated field, prefilled from an AI
 * suggestion. Nothing is applied — the user now sees the proposal's real
 * result on real rows BEFORE accepting it, which is the point of routing a
 * model's formula through the same editor a hand-written one goes through.
 *
 * Shared by BOTH AI entry points (this panel's ✨ Suggest, and the AI dock's
 * calc-field proposal card), which is why it keeps its name.
 */
function prefillCalcFieldEditor(name: unknown, expression: unknown, warning?: unknown): void {
  openCalcField(-1, {
    name: String(name || ''),
    expression: String(expression || ''),
    note: 'Assistant suggestion — review and edit; the app compiles and computes the formula.'
      + (warning ? ' ' + String(warning) : ''),
  });
}

/**
 * The calculated-field surface, for a new step (`index` -1) or an existing one.
 *
 * `applyStepResult` returning false keeps the editor OPEN with the expression
 * intact — main can still refuse a step the editor was happy with (a name that
 * raced another tab, a dataset that moved), and losing a formula to a closed
 * modal is the exact frustration this whole panel replaces.
 */
function openCalcField(index: number, prefill?: { name?: string; expression?: string; note?: string }): void {
  if (!currentProjectId || !expId) return;
  closeStepEditor();
  const step = index >= 0 ? expSteps[index] : null;
  openFormulaEditor({
    projectId: currentProjectId,
    datasetId: expId,
    existing: prefill || (step ? { name: String(step.name || ''), expression: String(step.expression || '') } : undefined),
    onSave: async (field) => {
      const s = { type: 'calculated_field', name: field.name, expression: field.expression };
      const res = index >= 0
        ? await window.hub.updateDatasetStep(currentProjectId, expId, index, s)
        : await window.hub.addDatasetStep(currentProjectId, expId, s);
      return applyStepResult(res);
    },
  });
}

// Applying REPLACES the whole pipeline with the confirmed suggestions (setSteps).
async function applySuggestedSteps(): Promise<void> {
  if (!currentProjectId || !expId || !dsSuggestedSteps.length) return;
  const res = await window.hub.setDatasetSteps(currentProjectId, expId, dsSuggestedSteps);
  if (applyStepResult(res)) dismissSuggested();
}

function dismissSuggested(): void {
  dsSuggestedSteps = [];
  const out = pEl('ds-suggest-out');
  if (out) out.hidden = true;
}

// ── Panel lifecycle ───────────────────────────────────────────────────────────
// Called by datasets.ts openSavedDataset (after expSteps is set) — collapse any
// editor/menu/suggestions and render the pipeline + combine picker fresh.
function resetPreparePanel(): void {
  dsStepEditIndex = -1;
  dsSuggestedSteps = [];
  const panel = pEl('ds-prepare-panel');
  if (panel) panel.hidden = true;
  if (dsTypeMenuClose) dsTypeMenuClose();
  closeStepEditor();
  const out = pEl('ds-suggest-out');
  if (out) out.hidden = true;
  const calcOut = pEl('ds-calc-suggest-out');
  if (calcOut) { calcOut.hidden = true; calcOut.innerHTML = ''; }
  renderPrepareWarnings([]);
  expStepCounts = null;
  renderStepsList();
  void loadStepCounts();
}

// The counts stored with the last recompute (or recomputed once, for a record
// older than them). Guarded on the dataset still being the open one.
async function loadStepCounts(): Promise<void> {
  const id = expId;
  if (!currentProjectId || !id || !expSteps.length || !window.hubPower) return;
  let res: any = null;
  try {
    res = await window.hubPower.stepCounts(currentProjectId, id);
  } catch (_) {
    return;
  }
  if (expId !== id || !res || !res.ok || !Array.isArray(res.stepCounts)) return;
  // A union/lookup summary names the other dataset (prepareCombine.ts ppNames).
  if (expSteps.some((st) => st && st.datasetId)) await ppListDatasets();
  if (expId !== id) return;
  expStepCounts = res.stepCounts;
  renderStepsList();
}

/**
 * "Prepare data" SELECTS THE PREPARE TAB — it no longer toggles a panel.
 *
 * This is the one deliberate behaviour change of the Data-section restructure.
 * Prepare is a view of the open dataset now, alongside Data and Quality
 * (dataSection.ts), so a button that hid it again while its tab was showing
 * would leave that tab blank. The panel's own `hidden` is owned by the tab.
 *
 * Everything else here is unchanged: the step list is still refreshed on the way
 * in, exactly as the toggle did. (The combine picker it also refreshed is gone —
 * combining is the composer's job now.)
 */
function togglePreparePanel(): void {
  const panel = pEl('ds-prepare-panel');
  if (!panel) return;
  panel.hidden = false;
  if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-prepare');
  renderStepsList();
}

// ── Boot wiring (once) ─────────────────────────────────────────────────────────
function initPrepare(): void {
  const prepBtn = pEl('ds-prepare-btn');
  if (prepBtn) prepBtn.addEventListener('click', () => togglePreparePanel());

  // The step-type chooser is openMiniMenu (chartControls.ts) — the hub's own
  // popover, which positions in the body, flips up when it would run off the
  // bottom, and closes on outside-click/Esc. As an absolutely-positioned child
  // of the rail it was instead clipped by the rail's own overflow, which is how
  // an eight-item list read as three.
  const addBtn = pEl('ds-step-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      // A second click dismisses: openMiniMenu's outside-click handler spares
      // its own anchor, so without this the button would only ever reopen.
      if (dsTypeMenuClose) { dsTypeMenuClose(); return; }
      dsTypeMenuClose = openMiniMenu(addBtn, (menu: HTMLElement, close: () => void) => {
        STEP_TYPES.forEach((t) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'chart-menu-item';
          row.textContent = t.label;
          row.addEventListener('click', () => { close(); openStepEditor(t.type, -1); });
          menu.appendChild(row);
        });
      }, () => {
        addBtn.setAttribute('aria-expanded', 'false');
        dsTypeMenuClose = null;
      });
      // After the open, not before: openMiniMenu closes any other mini menu
      // first, and that close runs our onClose.
      addBtn.setAttribute('aria-expanded', 'true');
    });
  }

  const suggestBtn = pEl('ds-suggest-btn');
  if (suggestBtn) suggestBtn.addEventListener('click', () => handleSuggestSteps());
  const calcBtn = pEl('ds-calc-suggest-btn');
  if (calcBtn) calcBtn.addEventListener('click', () => handleSuggestCalcField());
  const applyBtn = pEl('ds-suggest-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => applySuggestedSteps());
  const dismissBtn = pEl('ds-suggest-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', () => dismissSuggested());

}
