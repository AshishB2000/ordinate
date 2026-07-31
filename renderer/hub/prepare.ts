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
const FILTER_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty'];
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
      if (step.op === 'is_empty') return 'Filter: ' + step.column + ' is empty';
      if (step.op === 'not_empty') return 'Filter: ' + step.column + ' is not empty';
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

function mkStepBtn(label: string, aria: string, disabled: boolean, cb: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ds-step-btn';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
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
    actions.appendChild(mkStepBtn('▲', 'Move step up', i === 0, () => moveStep(i, -1)));
    actions.appendChild(mkStepBtn('▼', 'Move step down', i === expSteps.length - 1, () => moveStep(i, 1)));
    actions.appendChild(mkStepBtn('✎', 'Edit step', false, () => openStepEditor(step.type, i)));
    actions.appendChild(mkStepBtn('🗑', 'Remove step', false, () => removeStep(i)));
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
  dsStepEditType = type;
  dsStepEditIndex = index;
  hideTypeMenu();
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
    case 'calculated_field': {
      const nameIn = textInput(existing && existing.name ? String(existing.name) : '');
      const exprIn = textInput(existing && existing.expression ? String(existing.expression) : '');
      body.appendChild(fieldRow('New column name', nameIn));
      body.appendChild(fieldRow('Expression', exprIn));
      const hint = document.createElement('div');
      hint.className = 'ds-step-hint';
      hint.textContent =
        'e.g. [price] * [qty]  ·  IF [score] > 90 THEN "A" ELSE "B" END  ·  ' +
        'datediff("day", [start], [end])  ·  left(upper([code]), 3). ' +
        'Supports number, string, date, logical and type-conversion functions (Tableau-style).';
      body.appendChild(hint);
      return () => {
        const name = nameIn.value.trim();
        const expression = exprIn.value.trim();
        if (!name || !expression) {
          window.alert('A column name and an expression are both required.');
          return null;
        }
        return { type, name, expression };
      };
    }
    case 'filter': {
      const colSel = makeColSelect(existing ? existing.column : undefined);
      const opSel = selectFrom(FILTER_OPS, existing && existing.op ? String(existing.op) : '=');
      const valIn = textInput(existing && existing.value != null ? String(existing.value) : '');
      const valRow = fieldRow('Value', valIn);
      body.appendChild(fieldRow('Column', colSel));
      body.appendChild(fieldRow('Condition', opSel));
      body.appendChild(valRow);
      const syncVal = () => {
        valRow.hidden = opSel.value === 'is_empty' || opSel.value === 'not_empty';
      };
      opSel.addEventListener('change', syncVal);
      syncVal();
      return () => {
        const column = colSel.value;
        const op = opSel.value;
        if (!column) {
          window.alert('Pick a column to filter on.');
          return null;
        }
        const step: any = { type, column, op };
        if (op !== 'is_empty' && op !== 'not_empty') step.value = valIn.value;
        return step;
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
  del.textContent = '✕';
  del.setAttribute('aria-label', 'Remove aggregation');
  del.addEventListener('click', () => row.remove());
  row.appendChild(fnSel);
  row.appendChild(colSel);
  row.appendChild(asIn);
  row.appendChild(del);
  return row;
}

async function saveStepFromForm(getStep: () => any): Promise<void> {
  const step = getStep();
  if (!step) return;
  if (!currentProjectId || !expId) return;
  let res: any;
  if (dsStepEditIndex >= 0) {
    res = await window.hub.updateDatasetStep(currentProjectId, expId, dsStepEditIndex, step);
  } else {
    res = await window.hub.addDatasetStep(currentProjectId, expId, step);
  }
  if (applyStepResult(res)) closeStepEditor();
}

// ── Step-type chooser menu ────────────────────────────────────────────────────
function renderTypeMenu(): void {
  const menu = pEl('ds-step-type-menu');
  if (!menu) return;
  menu.innerHTML = '';
  STEP_TYPES.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ds-step-type-item';
    b.textContent = t.label;
    b.addEventListener('click', () => openStepEditor(t.type, -1));
    menu.appendChild(b);
  });
}

function hideTypeMenu(): void {
  const m = pEl('ds-step-type-menu');
  if (m) m.hidden = true;
}

// ── Combine with another dataset ──────────────────────────────────────────────
async function populateCombineSelect(): Promise<void> {
  const sel = pEl('ds-combine-select') as HTMLSelectElement | null;
  if (!sel || !currentProjectId) return;
  let items: any[] = [];
  try {
    items = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    items = [];
  }
  sel.innerHTML = '';
  const others = (Array.isArray(items) ? items : []).filter((d) => String(d.id) !== expId);
  if (!others.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No other datasets';
    sel.appendChild(opt);
  } else {
    others.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
      sel.appendChild(opt);
    });
  }
  await syncCombineOn();
}

// Show/hide the join-key row and (for join) populate both key selects — left from
// this dataset's columns, right from the picked other dataset's columns.
async function syncCombineOn(): Promise<void> {
  const modeSel = pEl('ds-combine-mode') as HTMLSelectElement | null;
  const onRow = pEl('ds-combine-on');
  if (!modeSel || !onRow) return;
  const isJoin = modeSel.value === 'join';
  onRow.hidden = !isJoin;
  if (!isJoin) return;

  const leftSel = pEl('ds-combine-on-left') as HTMLSelectElement | null;
  if (leftSel) {
    leftSel.innerHTML = '';
    expColumns.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.name;
      leftSel.appendChild(o);
    });
  }

  const rightSel = pEl('ds-combine-on-right') as HTMLSelectElement | null;
  const otherSel = pEl('ds-combine-select') as HTMLSelectElement | null;
  if (rightSel && otherSel && otherSel.value && currentProjectId) {
    rightSel.innerHTML = '';
    let other: any = null;
    try {
      other = await window.hub.getDataset(currentProjectId, otherSel.value);
    } catch (_) {
      other = null;
    }
    const cols: any[] = other && Array.isArray(other.columns) ? other.columns : [];
    cols.forEach((c) => {
      const o = document.createElement('option');
      o.value = c && c.name != null ? String(c.name) : '';
      o.textContent = c && c.name != null ? String(c.name) : '';
      rightSel.appendChild(o);
    });
  }
}

function showCombineNote(msg: string): void {
  const note = pEl('ds-combine-note');
  if (!note) return;
  note.textContent = msg;
  note.hidden = false;
}

async function handleCombine(): Promise<void> {
  if (!currentProjectId || !expId) return;
  const otherSel = pEl('ds-combine-select') as HTMLSelectElement | null;
  const modeSel = pEl('ds-combine-mode') as HTMLSelectElement | null;
  if (!otherSel || !otherSel.value) {
    showCombineNote('Pick another dataset to combine with.');
    return;
  }
  const mode: 'append' | 'join' = modeSel && modeSel.value === 'join' ? 'join' : 'append';
  let on: { left: string; right: string } | undefined;
  if (mode === 'join') {
    const leftSel = pEl('ds-combine-on-left') as HTMLSelectElement | null;
    const rightSel = pEl('ds-combine-on-right') as HTMLSelectElement | null;
    const l = leftSel ? leftSel.value : '';
    const r = rightSel ? rightSel.value : '';
    if (!l || !r) {
      showCombineNote('Pick a join key on each side.');
      return;
    }
    on = { left: l, right: r };
  }
  let res: any;
  try {
    res = await window.hub.combineDatasets(currentProjectId, expId, otherSel.value, mode, on);
  } catch (_) {
    res = { ok: false, error: 'Failed to combine the datasets.' };
  }
  if (!res || res.ok === false) {
    showCombineNote((res && res.error) || 'Failed to combine the datasets.');
    return;
  }
  const name = res.dataset && res.dataset.name ? String(res.dataset.name) : 'combined dataset';
  const warns = Array.isArray(res.warnings) && res.warnings.length ? ' (' + res.warnings.join('; ') + ')' : '';
  showCombineNote('Created "' + name + '" in this project.' + warns);
  await refreshDatasetList();
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
    list.textContent = 'Connect a model in Execution settings to get step suggestions.';
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
    const head = mkAiPanel('AI suggestion — the app compiles and computes the formula');
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
    showHint('Connect a model in Execution settings to suggest a calculated field.');
    return;
  }
  if (!res || res.ok === false) {
    showHint((res && res.error) || 'Could not suggest a calculated field.');
    return;
  }

  // Success — open the editor prefilled; nothing is applied until the user Saves.
  if (out) { out.hidden = true; out.innerHTML = ''; }
  openStepEditor('calculated_field', -1);
  const editor = pEl('ds-step-editor');
  if (!editor) return;
  const inputs = editor.querySelectorAll('.ds-step-input');
  const nameIn = inputs[0] as HTMLInputElement | undefined;
  const exprIn = inputs[1] as HTMLInputElement | undefined;
  if (nameIn) nameIn.value = String(res.name || '');
  if (exprIn) exprIn.value = String(res.expression || '');

  // Prepend an AI-interpretation label into the editor so the user knows this is a
  // suggestion to review/edit before saving.
  const panel = document.createElement('div');
  panel.className = 'ai-interp';
  panel.appendChild(mkAiPanel('AI suggestion — review and edit; the app compiles and computes the formula'));
  if (res.warning) {
    const warn = document.createElement('div');
    warn.className = 'ai-interp-hint';
    warn.textContent = String(res.warning);
    panel.appendChild(warn);
  }
  editor.insertBefore(panel, editor.firstChild);
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
  hideTypeMenu();
  closeStepEditor();
  const out = pEl('ds-suggest-out');
  if (out) out.hidden = true;
  const calcOut = pEl('ds-calc-suggest-out');
  if (calcOut) { calcOut.hidden = true; calcOut.innerHTML = ''; }
  const note = pEl('ds-combine-note');
  if (note) {
    note.hidden = true;
    note.textContent = '';
  }
  renderPrepareWarnings([]);
  renderStepsList();
  populateCombineSelect();
}

function togglePreparePanel(): void {
  const panel = pEl('ds-prepare-panel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderStepsList();
    populateCombineSelect();
  }
}

// ── Boot wiring (once) ─────────────────────────────────────────────────────────
function initPrepare(): void {
  const prepBtn = pEl('ds-prepare-btn');
  if (prepBtn) prepBtn.addEventListener('click', () => togglePreparePanel());

  const addBtn = pEl('ds-step-add');
  const typeMenu = pEl('ds-step-type-menu');
  if (addBtn && typeMenu) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = typeMenu.hidden;
      if (show) renderTypeMenu();
      typeMenu.hidden = !show;
    });
    document.addEventListener('click', (e) => {
      if (typeMenu.hidden) return;
      const t = e.target as Node;
      if (t !== addBtn && !typeMenu.contains(t)) typeMenu.hidden = true;
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

  const combineSel = pEl('ds-combine-select');
  if (combineSel) combineSel.addEventListener('change', () => syncCombineOn());
  const combineMode = pEl('ds-combine-mode');
  if (combineMode) combineMode.addEventListener('change', () => syncCombineOn());
  const combineBtn = pEl('ds-combine-btn');
  if (combineBtn) combineBtn.addEventListener('click', () => handleCombine());
}
