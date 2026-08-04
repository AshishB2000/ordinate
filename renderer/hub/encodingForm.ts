// The encoding form — category / measures / split / geo / filters — as a widget
// that can be mounted ANYWHERE, as many times as needed.
//
// Classic global-scope renderer <script>: NO import/export. Reuses FILTER_OPS
// (prepare.ts) at call time.
//
// WHY THIS EXISTS. This markup and this logic lived inside visuals.ts, addressed
// through `document.getElementById('viz-category-select')` and friends. That is
// fine for exactly one instance and impossible for two, which is what the
// analysis authoring surface needs (docs/analysis/01-authoring-surface.md, phase
// C): its left panel is the same form bound to whichever card is selected.
//
// The alternative was a second encoding form written against the panel's own
// ids. That is the outcome this file exists to prevent — two forms, one
// `computeVisualData`, and a slow divergence in which aggregations, filter
// operators and geo levels each surface happens to support.
//
// HOW IT IS DECOUPLED. The markup stays in index.html as a <template>, so the
// CSP story is unchanged and the form is still readable as HTML. Each instance
// clones it and addresses its own controls by CLASS, scoped to that clone. The
// `id`s survive only where a <label for=> needs one, and those are rewritten
// with a per-instance suffix — two mounted forms must not both claim
// `#viz-category-select`.
//
// It owns its columns, measures and filters, and reports every edit through one
// `onChange`. It does NOT know about datasets, IPC, chart types or rendering:
// the caller fetches the dataset, hands over columns, and decides what an edit
// means. That boundary is the point — phase C mounts this against a card
// without inheriting the Visuals section's save/preview behaviour.

interface EncodingFormOpts {
  /** Fired on any edit. The caller decides whether that means recompute, save, both. */
  onChange: () => void;
}

interface EncodingFormApi {
  /** The mounted root. Already appended to the host. */
  el: HTMLElement;
  /** Load a dataset's columns, optionally restoring a saved encoding + filters. */
  setColumns(cols: EncCol[], preset?: any, filters?: any[]): void;
  /** Apply an encoding against the columns already loaded (an AI suggestion). */
  setEncoding(preset: any): void;
  /**
   * Put `column` into the named well — what a drop, or a click on a field,
   * means. Returns false if the column is not in this dataset, so the caller
   * can refuse the drop rather than silently encoding a phantom column.
   * The form stays DnD-agnostic: the caller owns the drag listeners.
   */
  dropField(well: string, column: string): boolean;
  /** The encoding in the shape computeVisualData / buildVizData consume. */
  getEncoding(): any;
  /** Visual-level filters as transforms `filter` steps. */
  getFilters(): any[];
  /** The columns currently loaded (callers need these for warnings/naming). */
  getColumns(): EncCol[];
  show(on: boolean): void;
}

type EncAgg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';
interface EncCol { name: string; type: string }
interface EncMeasure { column: string; aggregation: EncAgg }

const ENC_AGGS: EncAgg[] = ['sum', 'avg', 'count', 'min', 'max', 'none'];
const ENC_AGG_LABELS: Record<EncAgg, string> = {
  sum: 'Sum', avg: 'Average', count: 'Count', min: 'Min', max: 'Max', none: 'Raw (no aggregation)',
};

let encFormSeq = 0;

function createEncodingForm(host: HTMLElement, opts: EncodingFormOpts): EncodingFormApi {
  const tpl = document.getElementById('viz-encoding-tpl') as HTMLTemplateElement | null;
  const first = tpl && tpl.content.firstElementChild;
  if (!first) throw new Error('viz-encoding-tpl is missing from index.html');
  const root = first.cloneNode(true) as HTMLElement;

  // Unique ids per instance, and every `for=` follows its own control. Collected
  // BEFORE any id is written, so a rewrite can never point a label at the
  // element that used to own the old id.
  const uid = 'ef' + ++encFormSeq;
  const owned = [...root.querySelectorAll('[id]')].map((el) => ({ el, old: el.id }));
  owned.forEach(({ el, old }) => {
    const next = old + '-' + uid;
    root.querySelectorAll('label[for="' + old + '"]').forEach((l) => l.setAttribute('for', next));
    el.id = next;
  });
  host.appendChild(root);

  const q = <T extends HTMLElement>(cls: string): T => root.querySelector('.' + cls) as T;
  const catSel = q<HTMLSelectElement>('js-enc-cat');
  const serSel = q<HTMLSelectElement>('js-enc-series');
  const geoSel = q<HTMLSelectElement>('js-enc-geo');
  const valuesList = q<HTMLElement>('js-enc-values');
  const filtersList = q<HTMLElement>('js-enc-filters');
  const addValue = q<HTMLButtonElement>('js-enc-add-value');
  const addFilter = q<HTMLButtonElement>('js-enc-add-filter');

  let columns: EncCol[] = [];
  let measures: EncMeasure[] = [];
  let filters: any[] = [];

  // Falls back to ALL columns when the dataset has no numeric one, so the
  // measure select is never empty — `count` over a text column is legitimate.
  // This fallback is load-bearing and is why measures are not filtered to
  // numbers at the type level.
  const numberCols = (): EncCol[] => {
    const nums = columns.filter((c) => c.type === 'number');
    return nums.length ? nums : columns.slice();
  };

  function fill(sel: HTMLSelectElement | null, items: Array<{ value: string; label: string }>, value: string): void {
    if (!sel) return;
    sel.innerHTML = '';
    items.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      sel.appendChild(o);
    });
    sel.value = value;
    // A saved encoding can name a column the dataset no longer has; fall back to
    // the first real option rather than leaving the select on a phantom value.
    if (sel.value !== value && items.length) sel.value = items[0].value;
  }

  // ── Measures ──────────────────────────────────────────────────────────────
  function renderMeasures(): void {
    valuesList.innerHTML = '';
    const nums = numberCols();
    measures.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'viz-value-row';

      const colSel = document.createElement('select');
      colSel.className = 'viz-select viz-value-col';
      colSel.setAttribute('aria-label', 'Measure column');
      fill(colSel, nums.map((c) => ({ value: c.name, label: c.name })), m.column);
      colSel.addEventListener('change', () => { measures[i].column = colSel.value; opts.onChange(); });
      row.appendChild(colSel);

      const aggSel = document.createElement('select');
      aggSel.className = 'viz-select viz-value-agg';
      aggSel.setAttribute('aria-label', 'Aggregation');
      fill(aggSel, ENC_AGGS.map((a) => ({ value: a, label: ENC_AGG_LABELS[a] })), m.aggregation);
      aggSel.addEventListener('change', () => {
        measures[i].aggregation = aggSel.value as EncAgg;
        opts.onChange();
      });
      row.appendChild(aggSel);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'viz-value-del';
      del.setAttribute('aria-label', 'Remove measure');
      del.textContent = '×';
      del.disabled = measures.length <= 1; // keep at least one measure
      del.addEventListener('click', () => {
        measures.splice(i, 1);
        renderMeasures();
        opts.onChange();
      });
      row.appendChild(del);
      valuesList.appendChild(row);
    });
  }

  // ── Filters (transforms `filter` steps; rows are filtered BEFORE aggregation,
  // so the app still computes every number) ─────────────────────────────────
  function renderFilters(): void {
    filtersList.innerHTML = '';
    filters.forEach((f, i) => filtersList.appendChild(makeFilterRow(f, i)));
  }

  function makeFilterRow(step: any, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'viz-filter-row';

    const colSel = document.createElement('select');
    colSel.className = 'viz-select';
    colSel.setAttribute('aria-label', 'Filter column');
    fill(colSel, columns.map((c) => ({ value: c.name, label: c.name })), step.column || '');
    colSel.addEventListener('change', () => { filters[i].column = colSel.value; opts.onChange(); });
    row.appendChild(colSel);

    const opSel = document.createElement('select');
    opSel.className = 'viz-select';
    opSel.setAttribute('aria-label', 'Filter condition');
    fill(opSel, FILTER_OPS.map((o: string) => ({ value: o, label: o })), step.op || '=');
    row.appendChild(opSel);

    const valIn = document.createElement('input');
    valIn.type = 'text';
    valIn.className = 'viz-filter-val';
    valIn.value = step.value != null ? String(step.value) : '';
    valIn.setAttribute('aria-label', 'Filter value');
    valIn.addEventListener('input', () => { filters[i].value = valIn.value; opts.onChange(); });
    row.appendChild(valIn);

    const syncVal = (): void => { valIn.hidden = opSel.value === 'is_empty' || opSel.value === 'not_empty'; };
    opSel.addEventListener('change', () => { filters[i].op = opSel.value; syncVal(); opts.onChange(); });
    syncVal();

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'viz-value-del';
    del.setAttribute('aria-label', 'Remove filter');
    del.textContent = '×';
    del.addEventListener('click', () => { filters.splice(i, 1); renderFilters(); opts.onChange(); });
    row.appendChild(del);
    return row;
  }

  addValue.addEventListener('click', () => {
    const nums = numberCols();
    measures.push({ column: nums[0] ? nums[0].name : '', aggregation: 'sum' });
    renderMeasures();
    opts.onChange();
  });
  addFilter.addEventListener('click', () => {
    filters.push({ type: 'filter', column: columns[0] ? columns[0].name : '', op: '=', value: '' });
    renderFilters();
    // No onChange: an empty filter row changes nothing until it names a column,
    // and getFilters() drops it. Recomputing here would be a wasted query.
  });
  [catSel, serSel, geoSel].forEach((s) => s && s.addEventListener('change', () => opts.onChange()));

  return {
    el: root,

    setColumns(cols: EncCol[], preset?: any, presetFilters?: any[]): void {
      columns = Array.isArray(cols) ? cols : [];

      // Category: every column, text/date before numbers — a dimension is far
      // more often one of those.
      const catItems = columns
        .slice()
        .sort((a, b) => (a.type === 'number' ? 1 : 0) - (b.type === 'number' ? 1 : 0))
        .map((c) => ({ value: c.name, label: c.name }));
      const presetCat = preset && typeof preset.category === 'string' ? preset.category : '';
      fill(catSel, catItems, presetCat || (catItems[0] ? catItems[0].value : ''));

      const textCols = columns.filter((c) => c.type !== 'number');
      fill(
        serSel,
        [{ value: '', label: 'None' }].concat(textCols.map((c) => ({ value: c.name, label: c.name }))),
        preset && typeof preset.series === 'string' ? preset.series : '',
      );

      if (geoSel) {
        geoSel.value = preset && preset.geo && typeof preset.geo.level === 'string' ? preset.geo.level : '';
      }

      if (preset && Array.isArray(preset.values) && preset.values.length) {
        measures = preset.values.map((v: any) => ({
          column: v && typeof v.column === 'string' ? v.column : '',
          aggregation: ENC_AGGS.indexOf(v && v.aggregation) >= 0 ? (v.aggregation as EncAgg) : 'sum',
        }));
      } else {
        const nums = numberCols();
        measures = [{ column: nums[0] ? nums[0].name : '', aggregation: 'sum' }];
      }
      filters = Array.isArray(presetFilters) ? presetFilters.map((f) => ({ ...f })) : [];
      renderMeasures();
      renderFilters();
    },

    // Re-applies against the columns already loaded, keeping the current
    // filters. Delegating to setColumns is deliberate: one code path decides
    // what a preset means, so a suggestion can never support a field that
    // restoring a saved visual does not.
    setEncoding(preset: any): void {
      this.setColumns(columns, preset, filters);
    },

    dropField(well: string, column: string): boolean {
      if (!columns.some((c) => c.name === column)) return false;
      if (well === 'category') {
        if (!catSel) return false;
        catSel.value = column;
        if (catSel.value !== column) return false; // not an option (shouldn't happen)
      } else if (well === 'series') {
        if (!serSel) return false;
        serSel.value = column;
        if (serSel.value !== column) return false;
      } else if (well === 'values') {
        // A measure select only offers numberCols(), so a text column dropped
        // here would land on a select that cannot hold it. Default it to
        // `count`, which is the aggregation that makes sense for one.
        const numeric = columns.some((c) => c.name === column && c.type === 'number');
        // Replace the lone empty default rather than stacking a second row on it.
        const blank = measures.length === 1 && !measures[0].column;
        const m: EncMeasure = { column, aggregation: numeric ? 'sum' : 'count' };
        if (blank) measures[0] = m;
        else measures.push(m);
        renderMeasures();
      } else if (well === 'filters') {
        filters.push({ type: 'filter', column, op: '=', value: '' });
        renderFilters();
        // A filter with no value yet changes nothing, so no onChange — same
        // reasoning as the + Add filter button.
        return true;
      } else {
        return false;
      }
      opts.onChange();
      return true;
    },

    getEncoding(): any {
      const enc: any = {
        category: catSel ? catSel.value : '',
        values: measures.filter((m) => m.column).map((m) => ({ column: m.column, aggregation: m.aggregation })),
      };
      const series = serSel ? serSel.value : '';
      if (series) enc.series = series;
      const geoLevel = geoSel ? geoSel.value : '';
      if (geoLevel) enc.geo = { level: geoLevel };
      return enc;
    },

    // Rows with no column are dropped here; main-side sanitizeFilters validates
    // and whitelists again regardless.
    getFilters(): any[] {
      return filters
        .filter((f) => f && f.column)
        .map((f) => {
          const s: any = { type: 'filter', column: f.column, op: f.op || '=' };
          if (f.op !== 'is_empty' && f.op !== 'not_empty') s.value = f.value != null ? f.value : '';
          return s;
        });
    },

    getColumns(): EncCol[] {
      return columns.slice();
    },

    show(on: boolean): void {
      root.hidden = !on;
    },
  };
}
