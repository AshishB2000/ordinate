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
  posIn.placeholder = t('prepareReshape.e_g_3_5_character_positions');
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
  const delimRow = fieldRow(t('prepareReshape.delimiter'), delimIn);
  const posRow = fieldRow(t('prepareReshape.cut_at_positions'), posIn);
  const patRow = fieldRow(t('prepareReshape.pattern_no_lookaround_or_backreferences'), patIn);
  const caseRow = fieldRow(t('common.ignore_case'), caseBox);
  const countRow = fieldRow(t('prepareReshape.how_many_columns_extra_parts_are'), countIn);
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
      ? t('prepareReshape.each_part_becomes_its_own_row')
      : t('prepareReshape.the_parts_replace_the_column_as', { p0: (colSel.value || 'column') });
  };
  [modeSel, intoSel, colSel].forEach((el) => el.addEventListener('change', paint));
  body.appendChild(fieldRow(t('common.column'), colSel));
  body.appendChild(fieldRow(t('common.split_by'), modeSel));
  [delimRow, posRow, patRow, caseRow].forEach((r) => body.appendChild(r));
  body.appendChild(fieldRow(t('prepareReshape.into'), intoSel));
  body.appendChild(countRow);
  body.appendChild(hint);
  paint();
  return () => {
    if (!colSel.value) { window.alert(t('prepareReshape.pick_a_column_to_split')); return null; }
    const step: any = { type: 'split_column', column: colSel.value, mode: modeSel.value, into: intoSel.value };
    if (step.mode === 'delimiter') {
      if (!delimIn.value) { window.alert(t('prepareReshape.enter_the_delimiter')); return null; }
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
  body.appendChild(fieldRow(t('prepareReshape.columns_that_become_rows'), checks.el));
  body.appendChild(fieldRow(t('prepareReshape.name_for_the_column_name_column'), attrIn));
  body.appendChild(fieldRow(t('prepareReshape.name_for_the_value_column'), valIn));
  return () => {
    const columns = checks.values();
    if (!columns.length) { window.alert(t('prepareReshape.pick_at_least_one_column_to')); return null; }
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
  hint.textContent = t('prepareReshape.each_distinct_value_of_the_key');
  body.appendChild(fieldRow(t('prepareReshape.key_column_its_values_become_columns'), keySel));
  body.appendChild(fieldRow(t('prepareReshape.value_column'), valSel));
  body.appendChild(fieldRow(t('common.aggregation'), fnSel));
  body.appendChild(fieldRow(t('prepareReshape.one_row_per'), groups.el));
  body.appendChild(hint);
  return () => {
    const groupBy = groups.values();
    if (!keySel.value || !valSel.value) { window.alert(t('prepareReshape.pick_a_key_column_and_a')); return null; }
    if (keySel.value === valSel.value || groupBy.indexOf(keySel.value) >= 0 || groupBy.indexOf(valSel.value) >= 0) {
      window.alert(t('prepareReshape.the_key_the_value_and_the'));
      return null;
    }
    return { type: 'pivot', key: keySel.value, value: valSel.value, fn: fnSel.value, groupBy };
  };
}

const WINDOW_FNS: Array<{ fn: string; label: string }> = [
  { fn: 'row_number', label: t('common.row_number') },
  { fn: 'lag', label: t('prepareReshape.previous_value_lag') },
  { fn: 'lead', label: t('prepareReshape.next_value_lead') },
  { fn: 'running_sum', label: t('prepareReshape.running_sum') },
  { fn: 'running_avg', label: t('prepareReshape.running_average') },
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
  const orderSel = makeColSelect(e.orderBy, t('prepareReshape.stored_row_order'));
  const descBox = document.createElement('input');
  descBox.type = 'checkbox';
  descBox.checked = !!e.desc;
  const asIn = textInput(e.as || '');
  asIn.placeholder = t('common.new_column_name_2');
  const colRow = fieldRow(t('prepareReshape.value_column'), colSel);
  const offRow = fieldRow(t('prepareReshape.rows_back_ahead'), offIn);
  const paint = (): void => {
    colRow.hidden = fnSel.value === 'row_number';
    offRow.hidden = fnSel.value !== 'lag' && fnSel.value !== 'lead';
  };
  fnSel.addEventListener('change', paint);
  body.appendChild(fieldRow(t('prepareReshape.calculate'), fnSel));
  body.appendChild(colRow);
  body.appendChild(offRow);
  body.appendChild(fieldRow(t('prepareReshape.restart_for_each_partition'), parts.el));
  body.appendChild(fieldRow(t('prepareReshape.order_by_ties_keep_the_stored'), orderSel));
  body.appendChild(fieldRow(t('prepareReshape.descending'), descBox));
  body.appendChild(fieldRow(t('common.new_column'), asIn));
  paint();
  return () => {
    const as = asIn.value.trim();
    if (!as) { window.alert(t('common.name_the_new_column')); return null; }
    const step: any = { type: 'window', fn: fnSel.value, as };
    if (step.fn !== 'row_number') {
      if (!colSel.value) { window.alert(t('prepareReshape.pick_the_value_column')); return null; }
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
        ? t('prepareReshape.at_positions', { p0: (step.positions || []).join(', ') })
        : step.mode === 'regex' ? t('prepareReshape.on', { pattern: step.pattern }) : t('prepareReshape.on_2', { delimiter: step.delimiter });
      return t('prepareReshape.split_into', { column: step.column, by, p2: (step.into === 'rows' ? 'rows' : (step.count || (step.positions || []).length + 1) + ' columns') });
    }
    case 'unpivot':
      return t('prepareReshape.unpivot', { p0: (step.columns || []).join(', '), p1: (step.attribute || 'attribute'), p2: (step.value || 'value') });
    case 'pivot':
      return t('prepareReshape.pivot_into_columns', { key: step.key, fn: step.fn, value: step.value, p3: ((step.groupBy || []).length ? ' per ' + step.groupBy.join(', ') : '') });
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
