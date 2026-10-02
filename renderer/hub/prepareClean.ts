// Power-step forms, CLEAN family — parse dates, keep one row per key, replace
// values, conditional column. Classic global-scope script (NO import/export),
// loaded after prepareForms.js. Main re-validates every step on save, and every
// figure a preview shows is counted in main (window.hubPower.previewStep).

// The allow-list main accepts (src/data/stepsClean.ts DATE_FORMATS × TIME_FORMATS).
const PP_DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'YYYYMMDD'];
const PP_TIME_FORMATS = ['', ' HH:mm', ' HH:mm:ss', 'THH:mm', 'THH:mm:ss'];

function buildParseDateForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const colSel = makeColSelect(e.column);
  const formats: string[] = [];
  PP_DATE_FORMATS.forEach((d) => PP_TIME_FORMATS.forEach((t) => formats.push(d + t)));
  const fmtSel = makeNameSelect(formats, e.format || 'YYYY-MM-DD');
  const asIn = textInput(e.as || '');
  asIn.placeholder = t('prepareClean.replace_the_column_in_place');
  const preview = makePreviewBox();
  const read = (): any => {
    const step: any = { type: 'parse_date', column: colSel.value, format: fmtSel.value };
    if (asIn.value.trim()) step.as = asIn.value.trim();
    return step;
  };
  let seq = 0;
  const refresh = async (): Promise<void> => {
    if (!colSel.value) return setPreview(preview, []);
    const mine = ++seq;
    const res = await previewPowerStep(read());
    if (mine !== seq || !res) return;
    if (!res.ok || !res.parseDate) return setPreview(preview, [res.error || t('common.could_not_preview')], true);
    const p = res.parseDate;
    const lines = [t('prepareClean.of_values_parsed_failed', { parsed: fmtN(p.parsed), p1: fmtN(p.parsed + p.failed), failed: fmtN(p.failed), p3: (p.empty ? ' · ' + fmtN(p.empty) + ' empty' : '') })];
    if (p.samples.length) lines.push(t('prepareClean.did_not_parse', { p0: p.samples.map((x: string) => '"' + x + '"').join(', ') }));
    setPreview(preview, lines, p.failed > 0);
  };
  [colSel, fmtSel].forEach((el) => el.addEventListener('change', () => void refresh()));
  body.appendChild(fieldRow(t('common.column'), colSel));
  body.appendChild(fieldRow(t('prepareClean.format_a_value_that_does_not'), fmtSel));
  body.appendChild(fieldRow(t('common.new_column_name'), asIn));
  body.appendChild(preview);
  void refresh();
  return () => {
    if (!colSel.value) { window.alert(t('prepareClean.pick_the_column_to_parse')); return null; }
    return read();
  };
}

function buildDedupeKeyForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const keys = makeColChecks(Array.isArray(e.columns) ? e.columns : []);
  const keepSel = document.createElement('select');
  keepSel.className = 'ds-step-select';
  [['first', t('prepareClean.the_first_row')], ['last', t('prepareClean.the_last_row')], ['max', t('prepareClean.the_row_with_the_highest')], ['min', t('prepareClean.the_row_with_the_lowest')]]
    .forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      if (v === (e.keep || 'first')) opt.selected = true;
      keepSel.appendChild(opt);
    });
  const bySel = makeColSelect(e.by);
  const byRow = fieldRow(t('prepareClean.of_this_column_ties_keep_the'), bySel);
  const paint = (): void => { byRow.hidden = keepSel.value !== 'max' && keepSel.value !== 'min'; };
  keepSel.addEventListener('change', paint);
  body.appendChild(fieldRow(t('prepareClean.key_columns'), keys.el));
  body.appendChild(fieldRow(t('prepareClean.for_each_key_keep'), keepSel));
  body.appendChild(byRow);
  paint();
  return () => {
    const columns = keys.values();
    if (!columns.length) { window.alert(t('prepareClean.pick_at_least_one_key_column')); return null; }
    const step: any = { type: 'dedupe_key', columns, keep: keepSel.value };
    if (step.keep === 'max' || step.keep === 'min') {
      if (!bySel.value) { window.alert(t('prepareClean.pick_the_column_to_rank_by')); return null; }
      step.by = bySel.value;
    }
    return step;
  };
}

/** A two-input rule row: from → to, with a remove button. */
function makePairRow(from: string, to: string, fromHint: string, toHint: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-agg-row pp-pair';
  const a = textInput(from);
  a.classList.add('pp-from');
  a.placeholder = fromHint;
  const arrow = document.createElement('span');
  arrow.className = 'pp-arrow';
  arrow.textContent = '→';
  const b = textInput(to);
  b.classList.add('pp-to');
  b.placeholder = toHint;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-step-btn';
  iconOnly(del, 'x', t('common.remove_rule'));
  del.addEventListener('click', () => row.remove());
  row.append(a, arrow, b, del);
  return row;
}

function readPairs(list: HTMLElement): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  list.querySelectorAll('.pp-pair').forEach((r) => {
    const from = (r.querySelector('.pp-from') as HTMLInputElement).value;
    const to = (r.querySelector('.pp-to') as HTMLInputElement).value;
    out.push({ from, to });
  });
  return out;
}

const REPLACE_HINTS: Record<string, string> = {
  exact: t('prepareClean.a_cell_equal_to_find_becomes'),
  contains: t('prepareClean.every_occurrence_of_find_is_replaced'),
  regex: t('prepareClean.every_match_of_the_pattern_is'),
};

function buildReplaceForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const colSel = makeColSelect(e.column);
  const modeSel = makeNameSelect(['exact', 'contains', 'regex'], e.mode || 'exact');
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.checked = !!e.ignoreCase;
  const caseRow = fieldRow(t('common.ignore_case'), caseBox);
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  const list = document.createElement('div');
  list.className = 'ds-agg-list';
  const add = (from = '', to = ''): void => { list.appendChild(makePairRow(from, to, 'find', t('prepareClean.replace_with'))); };
  (Array.isArray(e.rules) && e.rules.length ? e.rules : [{ from: '', to: '' }]).forEach((r: any) => add(r.from, r.to));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = t('common.add_rule_2');
  addBtn.addEventListener('click', () => add());
  const paint = (): void => {
    caseRow.hidden = modeSel.value !== 'regex';
    hint.textContent = REPLACE_HINTS[modeSel.value] || '';
  };
  modeSel.addEventListener('change', paint);
  body.appendChild(fieldRow(t('common.column'), colSel));
  body.appendChild(fieldRow(t('common.match'), modeSel));
  body.appendChild(caseRow);
  body.appendChild(hint);
  body.appendChild(list);
  body.appendChild(addBtn);
  paint();
  return () => {
    if (!colSel.value) { window.alert(t('common.pick_a_column')); return null; }
    const rules = readPairs(list).filter((r) => modeSel.value === 'exact' || r.from !== '');
    if (!rules.length) { window.alert(t('prepareClean.add_at_least_one_rule_with')); return null; }
    const step: any = { type: 'replace_values', column: colSel.value, mode: modeSel.value, rules };
    if (modeSel.value === 'regex' && caseBox.checked) step.ignoreCase = true;
    return step;
  };
}

const RULE_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty'];

function makeRuleRow(rule?: any): HTMLElement {
  const r = rule || { when: {} };
  const row = document.createElement('div');
  row.className = 'ds-agg-row pp-rule';
  const ifLbl = document.createElement('span');
  ifLbl.className = 'pp-arrow';
  ifLbl.textContent = t('common.if');
  const colSel = makeColSelect(r.when.column);
  colSel.classList.add('pp-col');
  const opSel = selectFrom(RULE_OPS, r.when.op || '=');
  opSel.classList.add('pp-op');
  const valIn = textInput(r.when.value != null ? String(r.when.value) : '');
  valIn.classList.add('pp-val');
  valIn.placeholder = 'value';
  const thenLbl = document.createElement('span');
  thenLbl.className = 'pp-arrow';
  thenLbl.textContent = t('prepareClean.then');
  const thenIn = textInput(r.then != null ? String(r.then) : '');
  thenIn.classList.add('pp-then');
  thenIn.placeholder = 'result';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-step-btn';
  iconOnly(del, 'x', t('common.remove_rule'));
  del.addEventListener('click', () => row.remove());
  const paint = (): void => { valIn.hidden = opSel.value === 'is_empty' || opSel.value === 'not_empty'; };
  opSel.addEventListener('change', paint);
  paint();
  row.append(ifLbl, colSel, opSel, valIn, thenLbl, thenIn, del);
  return row;
}

function buildConditionalForm(body: HTMLElement, existing: any): () => any {
  const e = existing || {};
  const nameIn = textInput(e.name || '');
  nameIn.placeholder = t('common.new_column_name_2');
  const list = document.createElement('div');
  list.className = 'ds-agg-list';
  (Array.isArray(e.rules) && e.rules.length ? e.rules : [null]).forEach((r: any) => list.appendChild(makeRuleRow(r)));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = t('common.add_rule_2');
  addBtn.addEventListener('click', () => list.appendChild(makeRuleRow()));
  const elseIn = textInput(e.else != null ? String(e.else) : '');
  elseIn.placeholder = t('common.leave_empty');
  const hint = document.createElement('div');
  hint.className = 'ds-step-hint';
  hint.textContent = t('prepareClean.the_first_rule_that_matches_decides');
  body.appendChild(fieldRow(t('common.new_column'), nameIn));
  body.appendChild(list);
  body.appendChild(addBtn);
  body.appendChild(fieldRow(t('common.otherwise'), elseIn));
  body.appendChild(hint);
  return () => {
    const name = nameIn.value.trim();
    if (!name) { window.alert(t('common.name_the_new_column')); return null; }
    const rules: any[] = [];
    list.querySelectorAll('.pp-rule').forEach((row) => {
      const column = (row.querySelector('.pp-col') as HTMLSelectElement).value;
      const op = (row.querySelector('.pp-op') as HTMLSelectElement).value;
      const value = (row.querySelector('.pp-val') as HTMLInputElement).value;
      const then = (row.querySelector('.pp-then') as HTMLInputElement).value;
      if (!column) return;
      const when: any = { column, op };
      if (op !== 'is_empty' && op !== 'not_empty') when.value = value;
      rules.push({ when, then });
    });
    if (!rules.length) { window.alert(t('prepareClean.add_at_least_one_rule')); return null; }
    return { type: 'conditional_column', name, rules, else: elseIn.value === '' ? null : elseIn.value };
  };
}

/** One line per clean step for the pipeline list. */
function cleanStepSummary(step: any): string | null {
  switch (step.type) {
    case 'parse_date':
      return t('prepareClean.parse_as', { column: step.column, format: step.format, p2: (step.as ? ' → ' + step.as : '') });
    case 'dedupe_key': {
      const keep = step.keep === 'max' || step.keep === 'min' ? 'the ' + step.keep + ' ' + step.by : 'the ' + step.keep;
      return t('prepareClean.one_row_per_keeping', { p0: (step.columns || []).join(', '), keep });
    }
    case 'replace_values': {
      const n = (step.rules || []).length;
      return t('prepareClean.replace_in', { column: step.column, mode: step.mode, n });
    }
    case 'conditional_column': {
      const n = (step.rules || []).length;
      return t('prepareClean.conditional_column', { name: step.name, n });
    }
    default:
      return null;
  }
}
