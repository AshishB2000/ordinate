// The pivot shelves — Rows, Columns, Values — plus Totals, Sort, Top N and
// conditional formatting.
//
// It REPLACES the Category / Split by / Measures rows of the encoding form when
// the chart type is `pivot`, and nothing else: filters stay exactly where they
// are, because a filter means the same thing to a pivot as to a column chart
// and a second filter UI is what encodingForm.ts exists to prevent.
//
// Built in JS rather than cloned from a <template>, unlike the encoding form:
// the shelves are three instances of one repeating widget with a per-chip menu,
// which is code either way, and the hub's CSP forbids inline `style=` in HTML
// but not DOM built here.
//
// Loads after encodingForm.js (whose `EncCol` shape it shares) and before
// vizBuilder.js, which mounts it. Classic global-scope script — NO import/export.

type PivotShelf = 'rows' | 'columns' | 'values';

interface PivotBuilderOpts {
  onChange: () => void;
}

interface PivotBuilderApi {
  el: HTMLElement;
  /** Load a dataset's columns, optionally restoring a saved pivot encoding. */
  setColumns(cols: EncCol[], preset?: any): void;
  /** The `encoding.pivot` object main sanitizes and `pivotData` consumes. */
  getPivot(): any;
  /** Reflect a sort the user made by clicking a column header in the grid. */
  setSort(sort: { by: 'label' | number; dir: 'asc' | 'desc' } | null): void;
  show(on: boolean): void;
}

const PIVOT_LIMITS: Record<PivotShelf, number> = { rows: 3, columns: 2, values: 4 };
const PIVOT_SHELF_LABEL: Record<PivotShelf, string> = {
  rows: 'Rows', columns: 'Columns', values: 'Values',
};
const PIVOT_SHELF_EMPTY: Record<PivotShelf, string> = {
  rows: 'Add a dimension', columns: 'Add a dimension', values: 'Add a measure',
};

const PIVOT_GRAINS: Array<{ value: string; label: string }> = [
  { value: '', label: 'No roll-up' },
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
];

const PIVOT_SHOW_AS: Array<{ value: string; label: string }> = [
  { value: 'value', label: 'Value' },
  { value: 'pct_row', label: '% of row' },
  { value: 'pct_col', label: '% of column' },
  { value: 'pct_total', label: '% of total' },
  { value: 'rank', label: 'Rank' },
];

const PIVOT_FORMATS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'plain', label: 'Plain' },
  { value: 'thousands', label: 'Thousands' },
  { value: 'compact', label: 'Compact' },
  { value: 'percent', label: 'Percent' },
  { value: 'currency', label: 'Currency' },
];

const PIVOT_COND: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'scale', label: 'Colour scale' },
  { value: 'bars', label: 'Data bars' },
  { value: 'threshold', label: 'Above / below' },
];

interface PivotChip {
  column: string;
  grain?: string;
  aggregation?: EncAgg;
  format?: string;
  showAs?: string;
  /** The saved Metric this value IS, when it was filled from the metric picker.
   *  ADDITIVE — `column`/`aggregation` stay filled and `pivotData` still does
   *  all the folding, so a deleted metric costs the chip its name, not its
   *  figures. */
  metricId?: string;
  /** The metric's name, for the chip. Re-read from the record, never persisted. */
  metricName?: string;
  /** "Calculate as" (calcMenu.ts) — computed in main, per cell, respecting subtotals. */
  calc?: TcCalc;
}

function createPivotBuilder(host: HTMLElement, opts: PivotBuilderOpts): PivotBuilderApi {
  const root = document.createElement('div');
  root.className = 'pivot-build';
  host.appendChild(root);

  let columns: EncCol[] = [];
  const shelves: Record<PivotShelf, PivotChip[]> = { rows: [], columns: [], values: [] };
  let totals = { rows: true, columns: true, grand: true };
  let sort: { by: 'label' | number; dir: 'asc' | 'desc' } | null = null;
  let topN: { n: number; byValueIdx: number } | null = null;
  const conditional = new Map<number, { kind: string; threshold?: number }>();

  /** Dimensions and dates for Rows/Columns; every column for Values. */
  const poolFor = (shelf: PivotShelf): EncCol[] =>
    shelf === 'values' ? columns.slice() : columns.filter((c) => c.type !== 'number');

  const isDate = (name: string): boolean => {
    const c = columns.find((x) => x.name === name);
    return !!c && c.type === 'date';
  };

  // ── One shelf ─────────────────────────────────────────────────────────────

  function renderShelf(shelf: PivotShelf, list: HTMLElement): void {
    list.innerHTML = '';
    const chips = shelves[shelf];
    if (!chips.length) {
      const ph = document.createElement('div');
      ph.className = 'enc-empty';
      ph.textContent = PIVOT_SHELF_EMPTY[shelf];
      list.appendChild(ph);
      return;
    }
    chips.forEach((chip, i) => list.appendChild(makeChip(shelf, chip, i)));
  }

  function makeChip(shelf: PivotShelf, chip: PivotChip, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'enc-pill pivot-chip';
    row.draggable = true;
    row.dataset.idx = String(i);

    // Drag-reorder WITHIN a shelf. A pivot's shelves are ordered — the first
    // row dimension is the outer one — so reordering is not decoration.
    row.addEventListener('dragstart', (e) => {
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/ordinate-pivot', shelf + ':' + i);
      }
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('text/ordinate-pivot')) return;
      e.preventDefault();
      row.classList.add('is-drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('is-drop');
      const raw = e.dataTransfer ? e.dataTransfer.getData('text/ordinate-pivot') : '';
      const [from, idxRaw] = String(raw).split(':');
      const fromIdx = Number(idxRaw);
      if (from !== shelf || !Number.isInteger(fromIdx) || fromIdx === i) return;
      e.preventDefault();
      const moved = shelves[shelf].splice(fromIdx, 1)[0];
      shelves[shelf].splice(i, 0, moved);
      redraw();
    });

    const name = document.createElement('span');
    name.className = 'enc-pill-name';
    // A value that IS a metric shows the metric's NAME — "Revenue", which is
    // the whole point of having named it — rather than the column and
    // aggregation behind it.
    name.textContent = shelf === 'values'
      ? (chip.metricName || aggLabel(chip.aggregation) + ' of ' + chip.column)
      : chip.column;
    row.appendChild(name);
    if (shelf === 'values') tcBadge(row, chip.calc);

    // A date dimension carries its roll-up on the chip, where the chip is —
    // the grain belongs to THAT field, not to the pivot.
    if (shelf !== 'values' && isDate(chip.column)) {
      const g = document.createElement('select');
      g.className = 'viz-select pivot-grain';
      g.setAttribute('aria-label', 'Roll ' + chip.column + ' up by');
      PIVOT_GRAINS.forEach((it) => {
        const o = document.createElement('option');
        o.value = it.value;
        o.textContent = it.value === 'month' ? calMonthWord() : it.label;
        g.appendChild(o);
      });
      g.value = chip.grain || '';
      g.addEventListener('change', () => { chip.grain = g.value || undefined; opts.onChange(); });
      row.appendChild(g);
    }

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'enc-pill-menu';
    menu.setAttribute('aria-label', 'Options for ' + chip.column);
    menu.setAttribute('aria-haspopup', 'menu');
    menu.textContent = '⋮';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(menu, chipMenuItems(shelf, chip, i, menu));
    });
    row.appendChild(menu);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'viz-value-del';
    del.setAttribute('aria-label', 'Remove ' + chip.column);
    del.textContent = '×';
    del.addEventListener('click', () => {
      shelves[shelf].splice(i, 1);
      if (shelf === 'values') conditional.delete(i);
      redraw();
    });
    row.appendChild(del);
    return row;
  }

  const aggLabel = (a: EncAgg | undefined): string =>
    ENC_AGG_LABELS[(a || 'sum') as EncAgg] || 'Sum';

  /** The pivot as "Calculate as" sees it: row dimensions run down, column ones across. */
  const pivotCalcContext = (): TcContext => ({
    surface: 'pivot',
    dims: shelves.rows.map((c): TcContext['dims'][number] => ({ name: c.column, axis: 'down' }))
      .concat(shelves.columns.map((c): TcContext['dims'][number] => ({ name: c.column, axis: 'across' }))),
    yoyOff: shelves.rows.concat(shelves.columns).some((c) => isDate(c.column) && c.grain)
      ? '' : 'Needs a date dimension rolled up by year, quarter or month',
  });

  function chipMenuItems(
    shelf: PivotShelf, chip: PivotChip, i: number, anchor?: HTMLElement,
  ): Array<{ label: string; danger?: boolean; onClick: () => void }> {
    const items: Array<{ label: string; danger?: boolean; onClick: () => void }> = [];
    if (shelf === 'values') {
      // 'none' has no meaning in a pivot cell — every cell IS a group — so the
      // pivot's aggregation list is the five real ones.
      // The metric picker, first: the same popover KPI add, the chart builder
      // and an alert rule open (metricPicker.ts).
      items.push({
        label: chip.metricId ? 'Change metric…' : 'Use a metric…',
        onClick: () => { void pickValueMetric(chip); },
      });
      (['sum', 'avg', 'count', 'min', 'max'] as EncAgg[]).forEach((a) => {
        // Choosing a raw aggregation drops the metric link: the chip is no
        // longer showing that metric, and keeping the id would tell
        // `metric:usage` otherwise.
        items.push({ label: ENC_AGG_LABELS[a], onClick: () => {
          chip.aggregation = a;
          delete chip.metricId;
          delete chip.metricName;
          redraw();
        } });
      });
      items.push(tcMenuItem(anchor || root, chip.calc, pivotCalcContext,
        (calc) => { if (calc) chip.calc = calc; else delete chip.calc; redraw(); }));
      PIVOT_SHOW_AS.forEach((s) => {
        items.push({
          label: 'Show as: ' + s.label,
          onClick: () => { chip.showAs = s.value === 'value' ? undefined : s.value; redraw(); },
        });
      });
      PIVOT_FORMATS.forEach((f) => {
        items.push({
          label: 'Format: ' + f.label,
          onClick: () => { chip.format = f.value === 'auto' ? undefined : f.value; redraw(); },
        });
      });
    }
    // Retarget to another column of the same role, so a chip can be changed
    // without deleting and re-adding it.
    poolFor(shelf)
      .filter((c) => c.name !== chip.column)
      .slice(0, 20)
      .forEach((c) => {
        items.push({ label: 'Use ' + c.name, onClick: () => { chip.column = c.name; chip.grain = undefined; redraw(); } });
      });
    items.push({
      label: 'Remove',
      danger: true,
      onClick: () => { shelves[shelf].splice(i, 1); if (shelf === 'values') conditional.delete(i); redraw(); },
    });
    return items;
  }

  /**
   * Fill a value chip from the metric picker.
   *
   * A FORMULA metric is refused and says why: every pivot cell is a column
   * rolled up within a group, and `[Profit] / [Revenue]` is not one. The KPI
   * card, which shows a single number, takes formula metrics happily.
   */
  async function pickValueMetric(chip: PivotChip): Promise<void> {
    const picked = await openMetricPicker(root, {});
    if (!picked) return;
    if (picked.kind === 'custom') {
      delete chip.metricId;
      delete chip.metricName;
      redraw();
      return;
    }
    const m = picked.metric;
    const def = m && m.definition ? m.definition : {};
    if (typeof def.formula === 'string') {
      window.alert(`"${m.name}" is a formula metric. Every pivot cell is a column rolled up within a group — use it on a KPI card instead.`);
      return;
    }
    if (!columns.some((c) => c.name === def.column)) {
      window.alert(`"${m.name}" is defined on a different dataset's column.`);
      return;
    }
    chip.column = def.column;
    chip.aggregation = (ENC_AGGS.indexOf(def.aggregation) >= 0 ? def.aggregation : 'sum') as EncAgg;
    chip.metricId = m.id;
    chip.metricName = m.name;
    redraw();
  }

  function addPicker(shelf: PivotShelf, btn: HTMLButtonElement): void {
    const taken = new Set(shelves[shelf].map((c) => c.column));
    const avail = poolFor(shelf).filter((c) => !taken.has(c.name));
    if (!avail.length) return;
    openRowMenu(btn, avail.slice(0, 40).map((c) => ({
      label: c.name,
      onClick: () => {
        if (shelves[shelf].length >= PIVOT_LIMITS[shelf]) return;
        const numeric = c.type === 'number';
        shelves[shelf].push(shelf === 'values'
          ? { column: c.name, aggregation: numeric ? 'sum' : 'count' }
          : { column: c.name });
        redraw();
      },
    })));
  }

  // ── The panel ─────────────────────────────────────────────────────────────

  const shelfEls: Record<PivotShelf, HTMLElement> = {} as Record<PivotShelf, HTMLElement>;
  const addBtns: Record<PivotShelf, HTMLButtonElement> = {} as Record<PivotShelf, HTMLButtonElement>;

  (['rows', 'columns', 'values'] as PivotShelf[]).forEach((shelf) => {
    const block = document.createElement('div');
    block.className = 'viz-build-row pivot-shelf';

    const head = document.createElement('div');
    head.className = 'pivot-shelf-head';
    const label = document.createElement('span');
    label.className = 'viz-build-label';
    label.textContent = PIVOT_SHELF_LABEL[shelf];
    head.appendChild(label);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pivot-add';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Add a field to ' + PIVOT_SHELF_LABEL[shelf]);
    add.setAttribute('aria-haspopup', 'menu');
    add.addEventListener('click', (e) => { e.stopPropagation(); addPicker(shelf, add); });
    head.appendChild(add);
    addBtns[shelf] = add;
    block.appendChild(head);

    const list = document.createElement('div');
    list.className = 'pivot-shelf-list';
    block.appendChild(list);
    shelfEls[shelf] = list;
    root.appendChild(block);
  });

  // Totals
  const totalsRow = document.createElement('div');
  totalsRow.className = 'viz-build-row pivot-opts';
  const totalsLabel = document.createElement('span');
  totalsLabel.className = 'viz-build-label';
  totalsLabel.textContent = 'Totals';
  totalsRow.appendChild(totalsLabel);
  const totalsBox = document.createElement('div');
  totalsBox.className = 'pivot-checks';
  ([
    ['rows', 'Total column'],
    ['columns', 'Total row'],
    ['grand', 'Grand total'],
  ] as Array<[keyof typeof totals, string]>).forEach(([key, text]) => {
    const lab = document.createElement('label');
    lab.className = 'pivot-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = totals[key];
    cb.addEventListener('change', () => { totals[key] = cb.checked; opts.onChange(); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(text));
    totalsBox.appendChild(lab);
  });
  totalsRow.appendChild(totalsBox);
  root.appendChild(totalsRow);

  // Sort — the same state a column-header click writes, shown as a control so
  // it is discoverable and clearable without hunting for the right header.
  const sortRow = document.createElement('div');
  sortRow.className = 'viz-build-row pivot-opts';
  const sortLabel = document.createElement('span');
  sortLabel.className = 'viz-build-label';
  sortLabel.textContent = 'Sort';
  sortRow.appendChild(sortLabel);
  const sortText = document.createElement('span');
  sortText.className = 'pivot-sort-state';
  sortRow.appendChild(sortText);
  const sortClear = document.createElement('button');
  sortClear.type = 'button';
  sortClear.className = 'viz-value-del';
  sortClear.textContent = '×';
  sortClear.setAttribute('aria-label', 'Clear the sort');
  sortClear.addEventListener('click', () => { sort = null; redraw(); });
  sortRow.appendChild(sortClear);
  root.appendChild(sortRow);

  // Top N
  const topRow = document.createElement('div');
  topRow.className = 'viz-build-row pivot-opts';
  const topLabel = document.createElement('span');
  topLabel.className = 'viz-build-label';
  topLabel.textContent = 'Top N';
  topRow.appendChild(topLabel);
  const topInput = document.createElement('input');
  topInput.type = 'number';
  topInput.min = '1';
  topInput.className = 'viz-select pivot-topn';
  topInput.placeholder = 'all';
  topInput.setAttribute('aria-label', 'Keep only the top N of the first row dimension');
  topInput.addEventListener('change', () => {
    const n = Math.floor(Number(topInput.value));
    topN = Number.isInteger(n) && n > 0 ? { n, byValueIdx: 0 } : null;
    opts.onChange();
  });
  topRow.appendChild(topInput);
  root.appendChild(topRow);

  // Conditional formatting, one row per value field.
  const condRow = document.createElement('div');
  condRow.className = 'viz-build-row pivot-opts pivot-cond';
  const condLabel = document.createElement('span');
  condLabel.className = 'viz-build-label';
  condLabel.textContent = 'Formatting';
  condRow.appendChild(condLabel);
  const condList = document.createElement('div');
  condList.className = 'pivot-cond-list';
  condRow.appendChild(condList);
  root.appendChild(condRow);

  function renderConditional(): void {
    condList.innerHTML = '';
    if (!shelves.values.length) {
      const ph = document.createElement('div');
      ph.className = 'enc-empty';
      ph.textContent = 'Add a value to format it';
      condList.appendChild(ph);
      return;
    }
    shelves.values.forEach((chip, i) => {
      const line = document.createElement('div');
      line.className = 'pivot-cond-row';
      const name = document.createElement('span');
      name.className = 'pivot-cond-name';
      name.textContent = chip.column;
      line.appendChild(name);

      const sel = document.createElement('select');
      sel.className = 'viz-select';
      sel.setAttribute('aria-label', 'Conditional formatting for ' + chip.column);
      PIVOT_COND.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.value;
        o.textContent = c.label;
        sel.appendChild(o);
      });
      const cur = conditional.get(i);
      sel.value = cur ? cur.kind : '';
      sel.addEventListener('change', () => {
        if (!sel.value) conditional.delete(i);
        else conditional.set(i, { kind: sel.value, threshold: cur ? cur.threshold : 0 });
        renderConditional();
        opts.onChange();
      });
      line.appendChild(sel);

      if (cur && cur.kind === 'threshold') {
        const th = document.createElement('input');
        th.type = 'number';
        th.className = 'viz-select pivot-threshold';
        th.value = String(cur.threshold ?? 0);
        th.setAttribute('aria-label', 'Threshold for ' + chip.column);
        th.addEventListener('change', () => {
          const n = Number(th.value);
          conditional.set(i, { kind: 'threshold', threshold: Number.isFinite(n) ? n : 0 });
          opts.onChange();
        });
        line.appendChild(th);
      }
      condList.appendChild(line);
    });
  }

  function sortSummary(): string {
    if (!sort) return 'First seen';
    const dir = sort.dir === 'desc' ? 'descending' : 'ascending';
    if (sort.by === 'label') return 'Row labels, ' + dir;
    return 'Column ' + (sort.by + 1) + ', ' + dir;
  }

  function redraw(): void {
    (['rows', 'columns', 'values'] as PivotShelf[]).forEach((shelf) => {
      renderShelf(shelf, shelfEls[shelf]);
      addBtns[shelf].disabled = shelves[shelf].length >= PIVOT_LIMITS[shelf];
    });
    renderConditional();
    sortText.textContent = sortSummary();
    sortClear.hidden = !sort;
    opts.onChange();
  }

  return {
    el: root,

    setColumns(cols: EncCol[], preset?: any): void {
      columns = Array.isArray(cols) ? cols : [];
      const p = preset && typeof preset === 'object' ? preset : {};
      const dims = (raw: any, cap: number): PivotChip[] => (Array.isArray(raw) ? raw : [])
        .filter((d) => d && typeof d.column === 'string')
        .slice(0, cap)
        .map((d) => ({ column: String(d.column), grain: typeof d.grain === 'string' ? d.grain : undefined }));
      shelves.rows = dims(p.rows, PIVOT_LIMITS.rows);
      shelves.columns = dims(p.columns, PIVOT_LIMITS.columns);
      shelves.values = (Array.isArray(p.values) ? p.values : [])
        .filter((v: any) => v && typeof v.column === 'string')
        .slice(0, PIVOT_LIMITS.values)
        .map((v: any) => ({
          column: String(v.column),
          aggregation: (ENC_AGGS.indexOf(v.aggregation) >= 0 ? v.aggregation : 'sum') as EncAgg,
          format: typeof v.format === 'string' ? v.format : undefined,
          showAs: typeof v.showAs === 'string' && v.showAs !== 'value' ? v.showAs : undefined,
          metricId: typeof v.metricId === 'string' ? v.metricId : undefined,
          calc: v.calc && typeof v.calc === 'object' ? v.calc : undefined,
        }));

      // A fresh pivot gets the first dimension and the first measure, so the
      // type switch lands on a grid rather than on an empty shell.
      if (!shelves.rows.length) {
        const first = poolFor('rows')[0];
        if (first) shelves.rows.push({ column: first.name });
      }
      if (!shelves.values.length) {
        const num = columns.find((c) => c.type === 'number') || columns[0];
        if (num) shelves.values.push({ column: num.name, aggregation: num.type === 'number' ? 'sum' : 'count' });
      }

      const t = p.totals && typeof p.totals === 'object' ? p.totals : null;
      totals = t
        ? { rows: !!t.rows, columns: !!t.columns, grand: !!t.grand }
        : { rows: true, columns: true, grand: true };
      sort = p.sort && (p.sort.by === 'label' || typeof p.sort.by === 'number')
        ? { by: p.sort.by, dir: p.sort.dir === 'desc' ? 'desc' : 'asc' }
        : null;
      topN = p.topN && typeof p.topN.n === 'number' && p.topN.n > 0
        ? { n: Math.floor(p.topN.n), byValueIdx: 0 }
        : null;
      topInput.value = topN ? String(topN.n) : '';
      conditional.clear();
      for (const c of (Array.isArray(p.conditional) ? p.conditional : [])) {
        if (c && typeof c.valueIdx === 'number' && typeof c.kind === 'string') {
          conditional.set(c.valueIdx, { kind: c.kind, threshold: c.threshold });
        }
      }
      redraw();
    },

    getPivot(): any {
      const out: any = {
        rows: shelves.rows.map((c) => (c.grain ? { column: c.column, grain: c.grain } : { column: c.column })),
        columns: shelves.columns.map((c) => (c.grain ? { column: c.column, grain: c.grain } : { column: c.column })),
        values: shelves.values.map((c) => {
          const v: any = { column: c.column, aggregation: c.aggregation || 'sum' };
          if (c.format) v.format = c.format;
          if (c.showAs) v.showAs = c.showAs;
          if (c.metricId) v.metricId = c.metricId;
          if (c.calc) v.calc = c.calc;
          return v;
        }),
        totals: { rows: totals.rows, columns: totals.columns, grand: totals.grand },
      };
      if (sort) out.sort = { by: sort.by, dir: sort.dir };
      if (topN) out.topN = { n: topN.n, byValueIdx: topN.byValueIdx };
      const conds: any[] = [];
      conditional.forEach((rule, valueIdx) => {
        if (valueIdx >= shelves.values.length) return;
        const c: any = { valueIdx, kind: rule.kind };
        if (rule.kind === 'threshold') c.threshold = rule.threshold ?? 0;
        conds.push(c);
      });
      if (conds.length) out.conditional = conds;
      return out;
    },

    setSort(next): void {
      sort = next;
      redraw();
    },

    show(on: boolean): void {
      root.hidden = !on;
    },
  };
}

/**
 * Carry an ordinary chart encoding over to a pivot, and back.
 *
 * Switching chart type must not silently throw the user's work away, and the
 * mapping is the obvious one in both directions: category ↔ the first row
 * dimension, split ↔ the first column dimension, measures ↔ values. Coming
 * BACK, only the first of each survives — a chart has one category and one
 * split, and inventing extra ones would be a different chart.
 */
function pivotFromEncoding(enc: any): any {
  const values = Array.isArray(enc && enc.values) ? enc.values : [];
  return {
    rows: enc && enc.category ? [{ column: enc.category }] : [],
    columns: enc && enc.series ? [{ column: enc.series }] : [],
    values: values.slice(0, 4).map((v: any) => ({
      column: v.column,
      aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation,
      ...(v.calc ? { calc: tcSwapAxis(v.calc) } : {}),
    })),
    totals: { rows: true, columns: true, grand: true },
  };
}

function encodingFromPivot(pivot: any): any {
  const rows = Array.isArray(pivot && pivot.rows) ? pivot.rows : [];
  const cols = Array.isArray(pivot && pivot.columns) ? pivot.columns : [];
  const values = Array.isArray(pivot && pivot.values) ? pivot.values : [];
  const out: any = {
    category: rows[0] ? rows[0].column : '',
    values: values.map((v: any) => ({ column: v.column, aggregation: v.aggregation || 'sum', ...(v.calc ? { calc: tcSwapAxis(v.calc) } : {}) })),
  };
  if (cols[0]) out.series = cols[0].column;
  if (rows[0] && rows[0].grain) out.grain = rows[0].grain;
  return out;
}
