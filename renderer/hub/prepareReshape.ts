// Power-step forms, RESHAPE family — split column, unpivot, pivot, window.
// Classic global-scope script (NO import/export), loaded after prepareForms.js,
// whose builders it uses. Each form returns the same "getter" buildStepForm
// does: read the controls, alert on anything missing, yield a step (or null).
// Main re-validates every step on save (src/data/stepsSanitize.ts).

function buildSplitForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const colSel = makeColSelect(e.column);
  const modeSel = makeNameSelect(['delimiter', 'position', 'regex'], e.mode || 'delimiter');
  const delimIn = textInput(e.delimiter != null ? String(e.delimiter) : ',');
  const posIn = textInput(Array.isArray(e.positions) ? e.positions.join(', ') : '');
  posIn.placeholder = 'e.g. 3, 5 — character positions to cut at';
  const patIn = textInput(e.pattern || '');
  patIn.placeholder = 'e.g. [,;]\\s*';
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.checked = !!e.ignoreCase;
  const intoSel = makeNameSelect(['columns', 'rows'], e.into || 'columns');
  const countIn = textInput(e.count != null ? String(e.count) : '2');
  countIn.type = 'number';
  countIn.min = '1';
  countIn.max = '50';
  const delimRow = fieldRow('Delimiter', delimIn);
  const posRow = fieldRow('Cut at positions', posIn);
  const patRow = fieldRow('Pattern (no lookaround or backreferences)', patIn);
  const caseRow = fieldRow('Ignore case', caseBox);
  const countRow = fieldRow('How many columns (extra parts are dropped)', countIn);
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  const paint = (): void => {
    const mode = modeSel.value;
    delimRow.hidden = mode !== 'delimiter';
    posRow.hidden = mode !== 'position';
    patRow.hidden = mode !== 'regex';
    caseRow.hidden = mode !== 'regex';
    countRow.hidden = intoSel.value !== 'columns' || mode === 'position';
    hint.textContent = intoSel.value === 'rows'
      ? 'Each part becomes its own row; the other columns repeat.'
      : 'The parts replace the column as ' + (colSel.value || 'column') + '_1, ' + (colSel.value || 'column') + '_2, …';
  };
  [modeSel, intoSel, colSel].forEach((el) => el.addEventListener('change', paint));
  body.appendChild(fieldRow('Column', colSel));
  body.appendChild(fieldRow('Split by', modeSel));
  [delimRow, posRow, patRow, caseRow].forEach((r) => body.appendChild(r));
  body.appendChild(fieldRow('Into', intoSel));
  body.appendChild(countRow);
  body.appendChild(hint);
  paint();
  return () => {
    if (!colSel.value) { window.alert('Pick a column to split.'); return null; }
    const step: any = { type: 'split_column', column: colSel.value, mode: modeSel.value, into: intoSel.value };
    if (step.mode === 'delimiter') {
      if (!delimIn.value) { window.alert('Enter the delimiter.'); return null; }
      step.delimiter = delimIn.value;
    } else if (step.mode === 'position') {
      step.positions = posIn.value.split(/[\s,]+/).filter(Boolean).map(Number);
    } else {
      step.pattern = patIn.value;
      if (caseBox.checked) step.ignoreCase = true;
    }
    if (step.into === 'columns' && step.mode !== 'position') step.count = Number(countIn.value) || 2;
    return step;
  };
}

function buildUnpivotForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const checks = makeColChecks(Array.isArray(e.columns) ? e.columns : []);
  const attrIn = textInput(e.attribute || 'attribute');
  const valIn = textInput(e.value || 'value');
  body.appendChild(fieldRow('Columns that become rows', checks.el));
  body.appendChild(fieldRow('Name for the column-name column', attrIn));
  body.appendChild(fieldRow('Name for the value column', valIn));
  return () => {
    const columns = checks.values();
    if (!columns.length) { window.alert('Pick at least one column to unpivot.'); return null; }
    return { type: 'unpivot', columns, attribute: attrIn.value.trim() || 'attribute', value: valIn.value.trim() || 'value' };
  };
}

function buildPivotForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const keySel = makeColSelect(e.key);
  const valSel = makeColSelect(e.value);
  const fnSel = selectFrom(AGG_FNS, e.fn || 'sum');
  const groups = makeColChecks(Array.isArray(e.groupBy) ? e.groupBy : []);
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  hint.textContent = 'Each distinct value of the key column becomes a column (up to 100, in first-seen order).';
  body.appendChild(fieldRow('Key column (its values become columns)', keySel));
  body.appendChild(fieldRow('Value column', valSel));
  body.appendChild(fieldRow('Aggregation', fnSel));
  body.appendChild(fieldRow('One row per', groups.el));
  body.appendChild(hint);
  return () => {
    const groupBy = groups.values();
    if (!keySel.value || !valSel.value) { window.alert('Pick a key column and a value column.'); return null; }
    if (keySel.value === valSel.value || groupBy.indexOf(keySel.value) >= 0 || groupBy.indexOf(valSel.value) >= 0) {
      window.alert('The key, the value and the "one row per" columns must all be different.');
      return null;
    }
    return { type: 'pivot', key: keySel.value, value: valSel.value, fn: fnSel.value, groupBy };
  };
}

const WINDOW_FNS: Array<{ fn: string; label: string }> = [
  { fn: 'row_number', label: 'Row number' },
  { fn: 'lag', label: 'Previous value (lag)' },
  { fn: 'lead', label: 'Next value (lead)' },
  { fn: 'running_sum', label: 'Running sum' },
  { fn: 'running_avg', label: 'Running average' },
];

function buildWindowForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const fnSel = document.createElement('select');
  fnSel.className = 'ds-step-select';
  WINDOW_FNS.forEach((w) => {
    const opt = document.createElement('option');
    opt.value = w.fn;
    opt.textContent = w.label;
    if (w.fn === (e.fn || 'row_number')) opt.selected = true;
    fnSel.appendChild(opt);
  });
  const colSel = makeColSelect(e.column);
  const offIn = textInput(e.offset != null ? String(e.offset) : '1');
  offIn.type = 'number';
  offIn.min = '1';
  const parts = makeColChecks(Array.isArray(e.partitionBy) ? e.partitionBy : []);
  const orderSel = makeColSelect(e.orderBy, '(stored row order)');
  const descBox = document.createElement('input');
  descBox.type = 'checkbox';
  descBox.checked = !!e.desc;
  const asIn = textInput(e.as || '');
  asIn.placeholder = 'new column name';
  const colRow = fieldRow('Value column', colSel);
  const offRow = fieldRow('Rows back / ahead', offIn);
  const paint = (): void => {
    colRow.hidden = fnSel.value === 'row_number';
    offRow.hidden = fnSel.value !== 'lag' && fnSel.value !== 'lead';
  };
  fnSel.addEventListener('change', paint);
  body.appendChild(fieldRow('Calculate', fnSel));
  body.appendChild(colRow);
  body.appendChild(offRow);
  body.appendChild(fieldRow('Restart for each (partition)', parts.el));
  body.appendChild(fieldRow('Order by (ties keep the stored order)', orderSel));
  body.appendChild(fieldRow('Descending', descBox));
  body.appendChild(fieldRow('New column', asIn));
  paint();
  return () => {
    const as = asIn.value.trim();
    if (!as) { window.alert('Name the new column.'); return null; }
    const step: any = { type: 'window', fn: fnSel.value, as };
    if (step.fn !== 'row_number') {
      if (!colSel.value) { window.alert('Pick the value column.'); return null; }
      step.column = colSel.value;
    }
    if (step.fn === 'lag' || step.fn === 'lead') step.offset = Math.max(1, Math.floor(Number(offIn.value) || 1));
    const partitionBy = parts.values();
    if (partitionBy.length) step.partitionBy = partitionBy;
    if (orderSel.value) step.orderBy = orderSel.value;
    if (descBox.checked) step.desc = true;
    return step;
  };
}

/** One line per reshape step for the pipeline list (prepare.ts stepSummaryText). */
function reshapeStepSummary(step: any): string | null {
  switch (step.type) {
    case 'split_column': {
      const by = step.mode === 'position'
        ? 'at positions ' + (step.positions || []).join(', ')
        : step.mode === 'regex' ? 'on /' + step.pattern + '/' : 'on "' + step.delimiter + '"';
      return 'Split ' + step.column + ' ' + by + ' into ' + (step.into === 'rows' ? 'rows' : (step.count || (step.positions || []).length + 1) + ' columns');
    }
    case 'unpivot':
      return 'Unpivot ' + (step.columns || []).join(', ') + ' → ' + (step.attribute || 'attribute') + ', ' + (step.value || 'value');
    case 'pivot':
      return 'Pivot ' + step.key + ' into columns: ' + step.fn + '(' + step.value + ')' +
        ((step.groupBy || []).length ? ' per ' + step.groupBy.join(', ') : '');
    case 'window': {
      const w = WINDOW_FNS.find((x) => x.fn === step.fn);
      const of = step.column ? ' of ' + step.column : '';
      const by = step.orderBy ? ' by ' + step.orderBy + (step.desc ? ' (desc)' : '') : '';
      const per = (step.partitionBy || []).length ? ' per ' + step.partitionBy.join(', ') : '';
      return (w ? w.label : step.fn) + of + by + per + ' → ' + step.as;
    }
    default:
      return null;
  }
}
