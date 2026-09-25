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

const STEP_TYPES: Array<{ type: string; label: string }> = [
  { type: 'calculated_field', label: 'Calculated field' },
  { type: 'filter', label: 'Filter rows' },
  { type: 'group_aggregate', label: 'Group & aggregate' },
  { type: 'dedupe', label: 'Remove duplicates' },
  { type: 'fill_empty', label: 'Fill empty cells' },
  { type: 'trim', label: 'Trim whitespace' },
  { type: 'drop_column', label: 'Drop column' },
  { type: 'rename_column', label: 'Rename column' },
];
const FILTER_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty', 'in', 'not in'];
const AGG_FNS = ['sum', 'avg', 'count', 'min', 'max'];

function pEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Small control builders ───────────────────────────────────────────────────
function textInput(val: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'ds-step-input';
  i.value = val;
  return i;
}

function selectFrom(vals: string[], selected: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  vals.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (v === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

// A column <select> from the CURRENT (derived) columns. includeAll adds a blank
// "(all …)" option whose empty value means "omit the column" (trim/dedupe).
function makeColSelect(selected?: string, includeAll?: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'ds-step-select';
  if (includeAll != null) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = includeAll;
    sel.appendChild(opt);
  }
  expColumns.forEach((col) => {
    const opt = document.createElement('option');
    opt.value = col.name;
    opt.textContent = col.name;
    if (col.name === selected) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function fieldRow(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'ds-step-field';
  const span = document.createElement('span');
  span.className = 'ds-step-field-label';
  span.textContent = labelText;
  row.appendChild(span);
  row.appendChild(control);
  return row;
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
      return 'Unknown step';
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

// Returns a getter that reads the form and yields a step object (or null if the
// input is invalid — the getter shows the alert itself).
function buildStepForm(type: string, body: HTMLElement, existing: any): () => any {
  switch (type) {
    case 'filter': {
      // The column stays a select (that is how a filter is retargeted); the
      // CONDITION is one button opening the shared type-aware dialog, so this
      // surface offers exactly what the visual wells and the sheet filter bar
      // do — one dialog, three call sites.
      const colSel = makeColSelect(existing ? existing.column : undefined);
      // `pending` holds what the dialog returned. Seeded from the step being
      // edited so re-opening the editor and pressing Save is a no-op rather
      // than a silent reset to `=`.
      let pending: any[] = existing && existing.op ? [{ ...existing, type: 'filter' }] : [];

      const condBtn = document.createElement('button');
      condBtn.type = 'button';
      condBtn.className = 'ds-step-cond';
      const paintCond = (): void => {
        condBtn.textContent = pending.length
          ? pending.map((s) => filterStepSummary(s)).join(' and ')
          : 'set a condition…';
      };
      paintCond();
      condBtn.addEventListener('click', async () => {
        const column = colSel.value;
        if (!column) {
          window.alert('Pick a column to filter on.');
          return;
        }
        const col = expColumns.find((c) => c.name === column);
        const steps = await openFilterDialog({
          projectId: currentProjectId || '',
          datasetId: expId || '',
          column,
          type: col && col.type ? String(col.type) : 'text',
          existing: pending[0],
        });
        if (steps === null) return;
        pending = steps;
        paintCond();
      });

      body.appendChild(fieldRow('Column', colSel));
      body.appendChild(fieldRow('Condition', condBtn));
      // Retargeting to another column invalidates the operand — an `in` list of
      // city names means nothing on a price column.
      colSel.addEventListener('change', () => { pending = []; paintCond(); });

      return () => {
        const column = colSel.value;
        if (!column) {
          window.alert('Pick a column to filter on.');
          return null;
        }
        if (pending.length === 0) {
          window.alert('Set a condition for this filter.');
          return null;
        }
        // A min/max range is two steps. Returning the ARRAY lets the caller add
        // both — safe because every filter is a pure row predicate, so the order
        // they land in the pipeline cannot change the result.
        return pending.map((s) => ({ ...s, type, column }));
      };
    }
    case 'group_aggregate': {
      const groupWrap = document.createElement('div');
      groupWrap.className = 'ds-step-checks';
      const groupBoxes: HTMLInputElement[] = [];
      expColumns.forEach((col) => {
        const lbl = document.createElement('label');
        lbl.className = 'ds-step-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = col.name;
        if (existing && Array.isArray(existing.groupBy) && existing.groupBy.indexOf(col.name) >= 0) cb.checked = true;
        groupBoxes.push(cb);
        const s = document.createElement('span');
        s.textContent = col.name;
        lbl.appendChild(cb);
        lbl.appendChild(s);
        groupWrap.appendChild(lbl);
      });
      body.appendChild(fieldRow('Group by', groupWrap));

      const aggList = document.createElement('div');
      aggList.className = 'ds-agg-list';
      body.appendChild(aggList);
      const addAgg = (agg?: any) => aggList.appendChild(makeAggRow(agg));
      if (existing && Array.isArray(existing.aggregations) && existing.aggregations.length) {
        existing.aggregations.forEach((a: any) => addAgg(a));
      } else {
        addAgg();
      }
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn';
      addBtn.textContent = '+ Add aggregation';
      addBtn.addEventListener('click', () => addAgg());
      body.appendChild(addBtn);

      return () => {
        const groupBy = groupBoxes.filter((b) => b.checked).map((b) => b.value);
        if (!groupBy.length) {
          window.alert('Pick at least one column to group by.');
          return null;
        }
        const aggregations: any[] = [];
        aggList.querySelectorAll('.ds-agg-row').forEach((r) => {
          const fn = (r.querySelector('.ds-agg-fn') as HTMLSelectElement).value;
          const column = (r.querySelector('.ds-agg-col') as HTMLSelectElement).value;
          const asVal = (r.querySelector('.ds-agg-as') as HTMLInputElement).value.trim();
          if (column && fn) aggregations.push({ column, fn, as: asVal || fn + '_' + column });
        });
        if (!aggregations.length) {
          window.alert('Add at least one aggregation.');
          return null;
        }
        return { type, groupBy, aggregations };
      };
    }
    case 'dedupe': {
      const wrap = document.createElement('div');
      wrap.className = 'ds-step-checks';
      const boxes: HTMLInputElement[] = [];
      expColumns.forEach((col) => {
        const lbl = document.createElement('label');
        lbl.className = 'ds-step-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = col.name;
        if (existing && Array.isArray(existing.columns) && existing.columns.indexOf(col.name) >= 0) cb.checked = true;
        boxes.push(cb);
        const s = document.createElement('span');
        s.textContent = col.name;
        lbl.appendChild(cb);
        lbl.appendChild(s);
        wrap.appendChild(lbl);
      });
      body.appendChild(fieldRow('Key columns (none checked = all columns)', wrap));
      return () => {
        const columns = boxes.filter((b) => b.checked).map((b) => b.value);
        const step: any = { type };
        if (columns.length) step.columns = columns;
        return step;
      };
    }
    case 'fill_empty': {
      const colSel = makeColSelect(existing ? existing.column : undefined);
      const valIn = textInput(existing && existing.value != null ? String(existing.value) : '');
      body.appendChild(fieldRow('Column', colSel));
      body.appendChild(fieldRow('Fill empty cells with', valIn));
      return () => {
        if (!colSel.value) {
          window.alert('Pick a column.');
          return null;
        }
        return { type, column: colSel.value, value: valIn.value };
      };
    }
    case 'trim': {
      const colSel = makeColSelect(existing ? existing.column : undefined, '(all text columns)');
      body.appendChild(fieldRow('Column', colSel));
      return () => {
        const step: any = { type };
        if (colSel.value) step.column = colSel.value;
        return step;
      };
    }
    case 'drop_column': {
      const colSel = makeColSelect(existing ? existing.column : undefined);
      body.appendChild(fieldRow('Column', colSel));
      return () => {
        if (!colSel.value) {
          window.alert('Pick a column.');
          return null;
        }
        return { type, column: colSel.value };
      };
    }
    case 'rename_column': {
      const fromSel = makeColSelect(existing ? existing.from : undefined);
      const toIn = textInput(existing && existing.to ? String(existing.to) : '');
      body.appendChild(fieldRow('Rename', fromSel));
      body.appendChild(fieldRow('To', toIn));
      return () => {
        const from = fromSel.value;
        const to = toIn.value.trim();
        if (!from || !to) {
          window.alert('Pick a column and enter a new name.');
          return null;
        }
        return { type, from, to };
      };
    }
    default:
      return () => null;
  }
}

function makeAggRow(agg?: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-agg-row';
  const fnSel = selectFrom(AGG_FNS, agg && agg.fn ? String(agg.fn) : 'sum');
  fnSel.classList.add('ds-agg-fn');
  const colSel = makeColSelect(agg ? agg.column : undefined);
  colSel.classList.add('ds-agg-col');
  const asIn = textInput(agg && agg.as ? String(agg.as) : '');
  asIn.classList.add('ds-agg-as');
  asIn.placeholder = 'output name';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-step-btn';
  iconOnly(del, 'x', 'Remove aggregation');
  del.addEventListener('click', () => row.remove());
  row.appendChild(fnSel);
  row.appendChild(colSel);
  row.appendChild(asIn);
  row.appendChild(del);
  return row;
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
  if (dsStepEditIndex >= 0) {
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
