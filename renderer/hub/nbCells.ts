'use strict';

// What each kind of notebook cell EDITS. Classic global-scope renderer
// <script>: no import/export. textContent only — a markdown cell renders
// through markdown.ts, which builds elements and never parses HTML.
//
//   sql       nbEditor.ts
//   formula   `[column] = expression` in the app's formula language, with the
//             input cell's columns as chips that insert `[name]`
//   chart     a compact Visuals builder: source cell, chart type, category,
//             measure + aggregation, an optional split — the VizEncoding every
//             saved visual stores, so Pin makes an ordinary visual of it
//   markdown  rendered; click (or ↩ on the focused cell) to edit, blur to render
//   param     `[[name]]`, its type and its value
//
// Every edit writes the cell in `nbDoc` and calls nbTouch(); main answers the
// save with the graph, and the stale badges follow from it.

const nbMdEditing = new Set<string>();

const NB_CHART_TYPES = ['column', 'bar', 'stacked_column', 'line', 'area', 'pie', 'donut', 'scatter', 'treemap', 'funnel', 'waterfall', 'radar'];
const NB_AGGS: Array<[string, string]> = [['sum', t('common.sum')], ['avg', 'Average'], ['count', t('common.count')], ['min', t('common.min')], ['max', t('common.max')], ['none', t('nbCells.no_aggregation')]];

function nbBuildEditor(c: NbCellDoc): HTMLElement {
  if (c.kind === 'sql') return nbSqlEditor(c);
  if (c.kind === 'formula') return nbFormulaEditor(c);
  if (c.kind === 'chart') return nbChartEditor(c);
  if (c.kind === 'param') return nbParamEditor(c);
  return nbMarkdownEditor(c);
}

/** Rebuild one cell's editor in place (a chart's source just produced columns, say). */
function nbRebuildBody(id: string): void {
  const c = nbCell(id);
  const body = nbCellEl(id)?.querySelector('.nb-cell-body') as HTMLElement | null;
  if (!c || !body) return;
  const hadFocus = body.contains(document.activeElement);
  body.textContent = '';
  body.appendChild(nbBuildEditor(c));
  if (hadFocus) nbFocusCell(id);
}

function nbField(label: string, control: HTMLElement, cls = ''): HTMLElement {
  const f = document.createElement('label');
  f.className = 'nb-field' + (cls ? ' ' + cls : '');
  const l = document.createElement('span');
  l.className = 'nb-field-label';
  l.textContent = label;
  f.append(l, control);
  return f;
}

function nbSelect(options: Array<[string, string]>, value: string, aria: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'conn-input nb-select';
  s.setAttribute('aria-label', aria);
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    s.appendChild(o);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// ── Formula ──────────────────────────────────────────────────────────────────

/** The cell a formula reads: the nearest SQL or formula cell above it. */
function nbFormulaInput(id: string): string | null {
  if (!nbDoc) return null;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  const src = nbDataCellAbove(i);
  return src ? src.id : null;
}

function nbFormulaEditor(c: NbCellDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'nb-formula';
  const row = document.createElement('div');
  row.className = 'nb-fx-row';
  const col = document.createElement('input');
  col.className = 'conn-input nb-fx-col';
  col.value = c.column || 'value';
  col.setAttribute('aria-label', t('common.new_column_name'));
  col.spellcheck = false;
  const expr = document.createElement('input');
  expr.className = 'conn-input nb-fx-expr';
  expr.value = c.expression || '';
  expr.placeholder = '[amount] * 1.2';
  expr.setAttribute('aria-label', t('common.formula'));
  expr.spellcheck = false;
  const bracket = (t: string): HTMLElement => Object.assign(document.createElement('span'), { className: 'nb-fx-punct', textContent: t });
  row.append(bracket('['), col, bracket(']'), bracket('='), expr);
  col.addEventListener('input', () => { c.column = col.value.trim() || 'value'; nbTouch(); });
  expr.addEventListener('input', () => { c.expression = expr.value; nbTouch(); });
  for (const el of [col, expr]) el.addEventListener('keydown', (e) => nbEditorKey(e, c.id));
  box.appendChild(row);

  // The input's columns, as chips that insert `[name]` at the caret.
  const inputId = nbFormulaInput(c.id);
  const res = inputId ? nbResults.get(inputId) : null;
  const cols = document.createElement('div');
  cols.className = 'nb-fx-cols';
  const lead = document.createElement('span');
  lead.className = 'nb-fx-lead';
  if (!inputId) lead.textContent = t('nbCells.a_formula_adds_one_column_to');
  else if (!res || !res.ok) lead.textContent = t('nbCells.reads_run_it_to_list_its', { inputId: nbCellName(inputId) });
  else lead.textContent = t('nbCells.reads', { inputId: nbCellName(inputId) });
  cols.appendChild(lead);
  for (const k of (res && res.ok && res.columns) || []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nb-fx-chip';
    chip.textContent = k.name;
    chip.title = t('nbCells.insert', { name: k.name, type: k.type });
    chip.addEventListener('click', () => {
      const at = expr.selectionStart ?? expr.value.length;
      const ins = `[${k.name}]`;
      expr.value = expr.value.slice(0, at) + ins + expr.value.slice(expr.selectionEnd ?? at);
      expr.focus();
      expr.setSelectionRange(at + ins.length, at + ins.length);
      c.expression = expr.value;
      nbTouch();
    });
    cols.appendChild(chip);
  }
  box.appendChild(cols);
  return box;
}

// ── Chart ────────────────────────────────────────────────────────────────────

/** The SQL and formula cells above `id`, as [id, name] options. */
function nbSourceOptions(id: string): Array<[string, string]> {
  if (!nbDoc) return [];
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  return nbDoc.cells.slice(0, Math.max(0, i))
    .filter((c) => c.kind === 'sql' || c.kind === 'formula')
    .map((c) => [c.id, nbCellName(c.id)] as [string, string]);
}

function nbChartEditor(c: NbCellDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'nb-chart-builder';
  const enc = c.encoding && typeof c.encoding === 'object' ? c.encoding : { category: '', values: [] };
  c.encoding = enc;
  const set = (fn: () => void, rebuild = false): void => {
    fn();
    nbTouch();
    if (rebuild) nbRebuildBody(c.id);
  };

  const sources = nbSourceOptions(c.id);
  const src = nbSelect([['', sources.length ? t('nbCells.choose_a_cell') : t('nbCells.no_sql_cell_above')], ...sources], c.sourceCellId || '', t('nbCells.chart_the_result_of'),
    (v) => set(() => { c.sourceCellId = v; }, true));
  src.classList.add('nb-chart-source');
  const types = nbSelect(NB_CHART_TYPES.map((t) => [t, (VIZ_LABELS as any)[t] || t] as [string, string]), c.chartType || 'column', t('common.chart_type'),
    (v) => set(() => { c.chartType = v; }));
  box.append(nbField('Chart', src), nbField(t('nbCells.as'), types));

  const res = c.sourceCellId ? nbResults.get(c.sourceCellId) : null;
  const columns: Array<{ name: string; type: string }> = res && res.ok && res.columns ? res.columns : [];
  if (!columns.length) {
    const hint = document.createElement('p');
    hint.className = 'nb-chart-hint';
    hint.textContent = c.sourceCellId ? t('nbCells.run_to_choose_its_columns', { sourceCellId: nbCellName(c.sourceCellId) }) : t('nbCells.pick_the_sql_or_formula_cell');
    box.appendChild(hint);
    return box;
  }
  // Sensible defaults the first time: a label to group by and a number to sum.
  const measure0 = Array.isArray(enc.values) && enc.values[0] ? enc.values[0] : null;
  if (!enc.category) {
    const text = columns.find((k) => k.type !== 'number') || columns[0];
    enc.category = text ? text.name : '';
  }
  if (!measure0) {
    const num = columns.find((k) => k.type === 'number' && k.name !== enc.category);
    enc.values = num ? [{ column: num.name, aggregation: 'sum' }] : [{ column: enc.category, aggregation: 'count' }];
    nbTouch();
  }
  const colOpts = columns.map((k) => [k.name, k.name] as [string, string]);
  const m = enc.values[0];
  box.append(
    nbField(t('common.category'), nbSelect(colOpts, enc.category, t('common.category'), (v) => set(() => { enc.category = v; }))),
    nbField(t('common.measure'), nbSelect(colOpts, m.column, t('common.measure_column'), (v) => set(() => { enc.values[0] = { ...enc.values[0], column: v }; }))),
    nbField(t('nbCells.of'), nbSelect(NB_AGGS, m.aggregation || 'sum', t('common.aggregation'), (v) => set(() => { enc.values[0] = { ...enc.values[0], aggregation: v }; }))),
    nbField(t('common.split_by'), nbSelect([['', t('common.none')], ...colOpts], enc.series || '', t('common.split_by'),
      (v) => set(() => { if (v) enc.series = v; else delete enc.series; }))),
  );
  for (const s of box.querySelectorAll('select')) s.addEventListener('keydown', (e) => nbEditorKey(e as KeyboardEvent, c.id));
  return box;
}

/**
 * After a save the graph has moved: relabel every chart's source list and
 * every parameter's "Read by" line in place — no rebuild, so focus stays put.
 */
function nbSyncEditors(): void {
  if (!nbDoc) return;
  for (const c of nbDoc.cells) {
    const sec = nbCellEl(c.id);
    if (!sec) continue;
    if (c.kind === 'chart') {
      const sel = sec.querySelector('.nb-chart-source') as HTMLSelectElement | null;
      if (sel) for (const o of sel.options) if (o.value) o.textContent = nbCellName(o.value);
    } else if (c.kind === 'param') {
      const el = sec.querySelector('.nb-param-readers');
      if (el) el.textContent = nbParamReaders(c);
    }
  }
}

function nbParamReaders(c: NbCellDoc): string {
  const n = nbGraph ? nbGraph.cells.filter((x) => x.deps.includes(c.id)).length : 0;
  return n ? t('nbCells.read_by', { n }) : t('nbCells.not_read_yet_write_in_a', { p0: c.name || 'name' });
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function nbMarkdownEditor(c: NbCellDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'nb-md';
  if (nbMdEditing.has(c.id) || !(c.text || '').trim()) {
    const ta = document.createElement('textarea');
    ta.className = 'conn-input nb-md-input';
    ta.value = c.text || '';
    ta.placeholder = t('nbCells.a_heading_what_this_notebook_answers');
    ta.setAttribute('aria-label', t('nbCells.note_in_markdown'));
    ta.addEventListener('input', () => { c.text = ta.value; nbAutoGrow(ta); nbTouch(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        nbMdView(c.id);
        const next = nbNeighbour(c.id, 1);
        if (e.shiftKey && next) nbFocusCell(next, true);
        return;
      }
      nbEditorKey(e, c.id);
    });
    ta.addEventListener('blur', () => { if ((c.text || '').trim()) window.setTimeout(() => nbMdView(c.id), 0); });
    box.appendChild(ta);
    window.requestAnimationFrame(() => nbAutoGrow(ta));
    return box;
  }
  const view = document.createElement('div');
  view.className = 'nb-md-view md-card';
  view.tabIndex = 0;
  view.setAttribute('role', 'button');
  view.setAttribute('aria-label', t('nbCells.note_press_enter_to_edit'));
  view.appendChild(mdRender(mdParse(c.text || ''), document, {
    // Never a navigation of the hub window: main's shell-safe open, http(s) only.
    link: (a: HTMLAnchorElement, href: string) => {
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.hub.openExternal(href); });
    },
  }));
  view.addEventListener('click', () => nbMdEdit(c.id));
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nbMdEdit(c.id); }
    else nbEditorKey(e, c.id);
  });
  box.appendChild(view);
  return box;
}

function nbMdEdit(id: string): void {
  nbMdEditing.add(id);
  nbRebuildBody(id);
  const ta = nbCellEl(id)?.querySelector('.nb-md-input') as HTMLTextAreaElement | null;
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function nbMdView(id: string): void {
  if (!nbMdEditing.delete(id)) return;
  nbRebuildBody(id);
}

// ── Parameter ────────────────────────────────────────────────────────────────

function nbParamEditor(c: NbCellDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'nb-param';
  const name = document.createElement('input');
  name.className = 'conn-input nb-param-name';
  name.value = c.name || '';
  name.setAttribute('aria-label', t('nbCells.parameter_name'));
  name.spellcheck = false;
  name.addEventListener('input', () => { c.name = name.value.trim(); nbTouch(); });
  const ref = document.createElement('span');
  ref.className = 'nb-param-ref';
  ref.append(Object.assign(document.createElement('span'), { textContent: '[[' }), name, Object.assign(document.createElement('span'), { textContent: ']]' }));

  const value = document.createElement('input');
  value.className = 'conn-input nb-param-value';
  value.setAttribute('aria-label', t('common.value'));
  const setType = (tv: string): void => {
    value.type = tv === 'number' ? 'number' : tv === 'date' ? 'date' : 'text';
    value.placeholder = tv === 'number' ? '2000' : tv === 'date' ? 'YYYY-MM-DD' : t('nbCells.west');
  };
  setType(c.type || 'number');
  value.value = c.value === null || c.value === undefined ? '' : String(c.value);
  const read = (): number | string | null => {
    const v = value.value.trim();
    if (!v) return null;
    if (c.type === 'number') return Number.isFinite(Number(v)) ? Number(v) : null;
    return v;
  };
  value.addEventListener('input', () => { c.value = read(); nbTouch(); });
  const type = nbSelect([['number', t('common.number')], ['text', t('common.text')], ['date', t('common.date')]], c.type || 'number', t('common.type'), (t) => {
    c.type = t as NbCellDoc['type'];
    setType(t);
    c.value = read();
    nbTouch();
  });
  for (const el of [name, value, type]) el.addEventListener('keydown', (e) => nbEditorKey(e as KeyboardEvent, c.id));

  const readers = document.createElement('span');
  readers.className = 'nb-param-readers';
  readers.textContent = nbParamReaders(c);
  box.append(ref, nbField(t('common.type'), type, 'nb-field--inline'), nbField(t('common.value'), value, 'nb-field--inline nb-field--grow'), readers);
  return box;
}
