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
  /**
   * Which dataset the filters run against, resolved at CLICK time rather than at
   * construction — the form outlives the dataset selection. The type-aware
   * filter dialog needs it to read a column's distinct values; without it the
   * dialog still opens, just with no checkbox list to offer.
   */
  dataset?: () => { projectId: string; datasetId: string } | null;
  /**
   * 'form'  — the Visuals builder: labelled rows of selects (unchanged).
   * 'wells' — the authoring panel: each row is a drop zone, each field a pill,
   *           and an empty zone says what belongs in it.
   *
   * ONE state and one getEncoding() either way. This changes what the rows LOOK
   * like, never what they mean — a second form is exactly what this file exists
   * to prevent.
   */
  variant?: 'form' | 'wells';
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
  /**
   * Hide the CHART fields — Category, Measures, Split by, Map regions — and
   * leave Filters showing. That is exactly the split a pivot needs: its shelves
   * replace the four, and a filter means the same thing to a pivot as to a
   * column chart, so there is no second filter UI (which is the outcome this
   * whole file exists to prevent).
   */
  showFields(on: boolean): void;
  /** The encoding in the shape computeVisualData / buildVizData consume. */
  getEncoding(): any;
  /** Visual-level filters as transforms `filter` steps. */
  getFilters(): any[];
  /** The columns currently loaded (callers need these for warnings/naming). */
  getColumns(): EncCol[];
  /**
   * Reflect what MAIN actually did to the category dimension — the date grain it
   * picked when the encoding named none, and the inline note when it capped a
   * long tail. The form never derives either: both need the rows, and the app
   * does the math in main. Setting the select's `.value` here fires no `change`,
   * so this cannot loop back into a recompute.
   */
  applyCategoryInfo(info: EncCategoryInfo | null | undefined): void;
  /**
   * Put the date grain to `grain` when the category IS a date. Returns true
   * only when that changed it — the caller recomputes; fires no `change`.
   */
  setGrain(grain: string): boolean;
  show(on: boolean): void;
}

/** The `category` block of a `visual:data` reply (src/analysis/vizData.ts). */
interface EncCategoryInfo {
  kind?: string;
  grain?: string;
  binned?: boolean;
  note?: string;
}

type EncAgg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';
// `label`/`title`: the catalog's display name and description (catalogUi.ctDocColumns) — display only.
interface EncCol { name: string; type: string; label?: string; title?: string }
interface EncMeasure {
  column: string;
  aggregation: EncAgg;
  /**
   * The saved Metric this measure IS, when it was filled from the metric
   * picker. ADDITIVE and never a replacement — `column`/`aggregation` stay
   * filled, `buildVizData` never reads this, and a chart whose metric is later
   * deleted plots exactly as it did. What it buys is the metric's NAME on the
   * pill, and a row in `metric:usage`.
   */
  metricId?: string;
  /** The metric's name, for the pill. Not persisted — re-read from the record. */
  metricName?: string;
}

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
  const grainSel = q<HTMLSelectElement>('js-enc-grain');
  const catNote = q<HTMLElement>('js-enc-cat-note');
  const serSel = q<HTMLSelectElement>('js-enc-series');
  const geoSel = q<HTMLSelectElement>('js-enc-geo');
  const valuesList = q<HTMLElement>('js-enc-values');
  const filtersList = q<HTMLElement>('js-enc-filters');
  const addValue = q<HTMLButtonElement>('js-enc-add-value');
  const addFilter = q<HTMLButtonElement>('js-enc-add-filter');

  const wells = opts.variant === 'wells';
  if (wells) root.classList.add('is-wells');

  let columns: EncCol[] = [];
  let measures: EncMeasure[] = [];
  let filters: any[] = [];

  /** The dashed "nothing here yet" line an empty well shows. */
  function placeholder(text: string): HTMLElement {
    const p = document.createElement('div');
    p.className = 'enc-empty';
    p.textContent = text;
    return p;
  }

  /**
   * A SINGLE-value well (Category, Split by) in the wells variant: a pill when
   * it holds a field, a dashed placeholder when it does not.
   *
   * The <select> stays — it is still the value, still what getEncoding() reads,
   * and still what a keyboard user operates. This only decides which of the two
   * is on screen. Building a separate widget and syncing it back would be a
   * second source of truth for the same field.
   */
  function syncSingle(sel: HTMLSelectElement | null, emptyText: string, clearable: boolean): void {
    if (!wells || !sel) return;
    const row = sel.closest('.viz-build-row') as HTMLElement | null;
    if (!row) return;
    row.querySelector('.enc-single')?.remove();
    // The select is ALWAYS stood down: either the pill or the placeholder is
    // showing it. Leaving it visible when empty painted the well twice — a
    // "None" dropdown sitting under "Add a dimension".
    //
    // And the stand-in SWAPS with the select rather than stacking on it: leaving
    // the pill up while the select was revealed showed the value twice.
    const reveal = (standIn: HTMLElement): void => {
      standIn.hidden = true;
      sel.hidden = false;
      sel.focus();
    };
    const has = !!sel.value;
    sel.hidden = true;
    if (!has) {
      const ph = placeholder(emptyText);
      ph.classList.add('enc-single');
      ph.addEventListener('click', () => reveal(ph));
      row.appendChild(ph);
      return;
    }
    const pill = document.createElement('div');
    pill.className = 'enc-pill enc-pill--one enc-single';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'enc-pill-name';
    name.textContent = sel.options[sel.selectedIndex]?.text || sel.value;
    // Click the name to change it: reveal the select the pill is standing in for.
    name.addEventListener('click', () => reveal(pill));
    pill.appendChild(name);
    if (clearable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'viz-value-del';
      del.setAttribute('aria-label', 'Remove ' + name.textContent);
      del.textContent = '×';
      del.addEventListener('click', () => {
        sel.value = '';
        syncSingle(sel, emptyText, clearable);
        opts.onChange();
      });
      pill.appendChild(del);
    }
    row.appendChild(pill);
  }

  function syncSingles(): void {
    // Category is not clearable: a chart without a dimension has nothing to plot,
    // and the form has always guaranteed one.
    syncSingle(catSel, 'Add a dimension', false);
    syncSingle(serSel, 'Add a dimension', true);
  }

  // Falls back to ALL columns when the dataset has no numeric one, so the
  // measure select is never empty — `count` over a text column is legitimate.
  // This fallback is load-bearing and is why measures are not filtered to
  // numbers at the type level.
  const numberCols = (): EncCol[] => {
    const nums = columns.filter((c) => c.type === 'number');
    return nums.length ? nums : columns.slice();
  };

  function fill(sel: HTMLSelectElement | null, items: Array<{ value: string; label: string; title?: string }>, value: string): void {
    if (!sel) return;
    sel.innerHTML = '';
    items.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      if (it.title) o.title = it.title;
      sel.appendChild(o);
    });
    sel.value = value;
    // A saved encoding can name a column the dataset no longer has; fall back to
    // the first real option rather than leaving the select on a phantom value.
    if (sel.value !== value && items.length) sel.value = items[0].value;
  }

  /**
   * The Category options: text and date columns as plain options, numeric ones
   * under a "Bin numeric…" group.
   *
   * The group is a WARNING, not a filter. A measure column is still choosable as
   * a dimension — that is legitimate — but picking one used to draw one bar per
   * distinct value, so a price column with 5,000 values drew 5,000 bars. Main
   * bins a numeric category into ten equal-width ranges, and the group label is
   * what says so before the click rather than after it.
   */
  function fillCategory(value: string): void {
    if (!catSel) return;
    catSel.innerHTML = '';
    const opt = (c: EncCol): HTMLOptionElement => {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.label || c.name;
      if (c.title) o.title = c.title;
      return o;
    };
    const dims = columns.filter((c) => c.type !== 'number');
    const nums = columns.filter((c) => c.type === 'number');
    dims.forEach((c) => catSel.appendChild(opt(c)));
    if (nums.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'Bin numeric…';
      nums.forEach((c) => grp.appendChild(opt(c)));
      catSel.appendChild(grp);
    }
    // No preset, or a saved encoding naming a column the dataset no longer has:
    // fall back to the first real option rather than leaving the select blank on
    // a phantom value. `catSel.value = ''` does NOT report a mismatch (it is
    // stored verbatim with selectedIndex -1), so the empty case is checked first.
    const first = dims[0] || nums[0];
    catSel.value = value;
    if ((!value || catSel.value !== value) && first) catSel.value = first.name;
  }

  /** The grain control belongs to a date category and nothing else. */
  function catType(): string {
    const name = catSel ? catSel.value : '';
    const col = columns.find((c) => c.name === name);
    return col ? col.type : '';
  }

  function syncGrain(): void {
    if (!grainSel) return;
    grainSel.hidden = catType() !== 'date';
  }

  /**
   * The dimension moved. Main re-decides both of the things it owns: the grain
   * (the old one belonged to a different column) and the note (which described a
   * tail this column does not have). `applyCategoryInfo` refills them when the
   * recompute this triggers comes back — clearing first is what keeps a stale
   * "top 50" note off a column that has twelve values.
   */
  function categoryChanged(): void {
    if (grainSel) grainSel.value = '';
    setCatNote('');
    syncGrain();
  }

  function setCatNote(text: string): void {
    if (!catNote) return;
    catNote.textContent = text;
    catNote.hidden = !text;
  }

  // ── Measures ──────────────────────────────────────────────────────────────
  function renderMeasures(): void {
    valuesList.innerHTML = '';
    const nums = numberCols();
    if (wells && !measures.some((m) => m.column)) {
      valuesList.appendChild(placeholder('Drop a measure here'));
      return;
    }
    measures.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = wells ? 'viz-value-row enc-pill' : 'viz-value-row';

      if (m.metricId) {
        // A measure that IS a metric shows the metric's name, not the column
        // and aggregation behind it — "Revenue", which is the whole point of
        // having named it. The ⋮ menu is how it goes back to being a column.
        const chip = document.createElement('span');
        chip.className = 'viz-value-metric';
        chip.textContent = m.metricName || m.column || 'Metric';
        chip.title = 'A saved metric. ⋮ to change it or go back to a column.';
        row.appendChild(chip);
      } else {
        const colSel = document.createElement('select');
        colSel.className = 'viz-select viz-value-col';
        colSel.setAttribute('aria-label', 'Measure column');
        fill(colSel, nums.map((c) => ({ value: c.name, label: c.label || c.name, title: c.title })), m.column);
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
      }

      if (wells) {
        // The reference puts a ⋮ on each field pill. openRowMenu is the popup
        // projects.ts already owns — one menu implementation in the renderer,
        // not a third.
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'enc-pill-menu';
        menu.setAttribute('aria-label', 'Options for ' + (m.column || 'this measure'));
        menu.setAttribute('aria-haspopup', 'menu');
        menu.textContent = '⋮';
        menu.addEventListener('click', (e) => {
          e.stopPropagation();
          const items: Array<{ label: string; danger?: boolean; onClick: () => void }> =
            ENC_AGGS.map((a) => ({
              label: ENC_AGG_LABELS[a],
              // Choosing a raw aggregation drops the metric link: the pill is
              // no longer showing that metric, and leaving the id on it would
              // claim otherwise to `metric:usage`.
              onClick: () => {
                measures[i].aggregation = a;
                delete measures[i].metricId;
                delete measures[i].metricName;
                renderMeasures();
                opts.onChange();
              },
            }));
          // The metric picker, on the pill that already carries this measure —
          // the same popover KPI add and the alert form open (metricPicker.ts).
          items.unshift({
            label: measures[i].metricId ? 'Change metric…' : 'Use a metric…',
            onClick: () => { void pickMeasureMetric(i, menu); },
          });
          if (measures.length > 1) {
            items.push({
              label: 'Remove',
              danger: true,
              onClick: () => { measures.splice(i, 1); renderMeasures(); opts.onChange(); },
            });
          }
          openRowMenu(menu, items);
        });
        row.appendChild(menu);
      } else {
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
      }
      valuesList.appendChild(row);
    });
  }

  /**
   * Fill measure `i` from the metric picker.
   *
   * A FORMULA metric is refused here, and says so: a chart measure is a column
   * rolled up per category, and `[Profit] / [Revenue]` is not one — plotting it
   * would need a per-category resolution the chart bridge has no vocabulary
   * for. The KPI card, which shows ONE number, takes formula metrics happily.
   */
  async function pickMeasureMetric(i: number, anchor: HTMLElement): Promise<void> {
    const ds = opts.dataset ? opts.dataset() : null;
    const picked = await openMetricPicker(anchor, { datasetId: ds ? ds.datasetId : undefined });
    if (!picked) return;
    if (picked.kind === 'custom') {
      delete measures[i].metricId;
      delete measures[i].metricName;
      renderMeasures();
      opts.onChange();
      return;
    }
    const m = picked.metric;
    const def = m && m.definition ? m.definition : {};
    if (typeof def.formula === 'string') {
      window.alert(`"${m.name}" is a formula metric. A chart measure has to be a column rolled up per category — use it on a KPI card instead.`);
      return;
    }
    measures[i] = {
      column: def.column || '',
      aggregation: ENC_AGGS.indexOf(def.aggregation) >= 0 ? def.aggregation : 'sum',
      metricId: m.id,
      metricName: m.name,
    };
    renderMeasures();
    opts.onChange();
  }

  // ── Filters (transforms `filter` steps; rows are filtered BEFORE aggregation,
  // so the app still computes every number) ─────────────────────────────────
  function renderFilters(): void {
    filtersList.innerHTML = '';
    if (wells && !filters.length) {
      filtersList.appendChild(placeholder('Drop a field here to filter'));
      return;
    }
    filters.forEach((f, i) => filtersList.appendChild(makeFilterRow(f, i)));
  }

  /** Open the type-aware dialog for one filter row and write the answer back. */
  async function editFilter(idx: number): Promise<void> {
    const cur = filters[idx];
    if (!cur || !cur.column) return;
    const ds = opts.dataset ? opts.dataset() : null;
    const col = columns.find((c) => c.name === cur.column);
    const steps = await openFilterDialog({
      projectId: ds ? ds.projectId : '',
      datasetId: ds ? ds.datasetId : '',
      column: cur.column,
      type: col ? col.type : 'text',
      existing: cur,
    });
    if (steps === null) return; // cancelled — leave the row exactly as it was
    // A min/max range is TWO steps and always was; splicing in place keeps each
    // one independently editable and deletable.
    filters.splice(idx, 1, ...steps);
    renderFilters();
    opts.onChange();
  }

  function makeFilterRow(step: any, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = wells ? 'viz-filter-row enc-pill enc-pill--filter' : 'viz-filter-row';

    const colSel = document.createElement('select');
    colSel.className = 'viz-select';
    colSel.setAttribute('aria-label', 'Filter column');
    fill(colSel, columns.map((c) => ({ value: c.name, label: c.label || c.name, title: c.title })), step.column || '');
    colSel.addEventListener('change', () => {
      // Retargeting to a column of a different type makes the old operand
      // meaningless (an `in` list of region names on a number column), so the
      // condition resets to unset and the row goes inert until it is set again.
      filters[i] = { type: 'filter', column: colSel.value, op: '' };
      renderFilters();
      opts.onChange();
    });
    row.appendChild(colSel);

    // ONE control for the whole condition, opening the type-aware dialog —
    // replacing the operator-select + value-input pair that asked the user to
    // know that a dimension wants `in` and a measure wants a range. Changing the
    // COLUMN stays a select, because that is how a filter is retargeted; the
    // dialog owns everything downstream of it.
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'viz-filter-cond';
    edit.textContent = filterStepSummary(step) || 'set a condition…';
    edit.setAttribute('aria-label', 'Edit the filter on ' + (step.column || 'this column'));
    edit.addEventListener('click', () => { void editFilter(i); });
    row.appendChild(edit);

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
    // NO operator yet — see the note on `getFilters`. A fresh row is inert until
    // the dialog gives it a condition, and it does NOT open the dialog by
    // itself: a modal that appears on its own steals the next click, which is
    // usually the one that matters.
    filters.push({ type: 'filter', column: columns[0] ? columns[0].name : '', op: '' });
    renderFilters();
  });
  // BEFORE the shared handler below, which is the one that calls onChange: the
  // recompute that fires from there must read the CLEARED grain, or a dimension
  // switch would ask main to bucket the new column by the old column's grain.
  if (catSel) catSel.addEventListener('change', () => categoryChanged());
  [catSel, serSel, geoSel].forEach((s) =>
    s && s.addEventListener('change', () => { syncSingles(); opts.onChange(); }));
  if (grainSel) grainSel.addEventListener('change', () => opts.onChange());
  // Leaving the select without choosing puts the pill back.
  [catSel, serSel].forEach((s) => s && s.addEventListener('blur', () => syncSingles()));

  return {
    el: root,

    setColumns(cols: EncCol[], preset?: any, presetFilters?: any[]): void {
      columns = Array.isArray(cols) ? cols : [];

      // Category: text/date columns first, numbers under "Bin numeric…" — a
      // dimension is far more often one of the former, and choosing one of the
      // latter now means ten ranges rather than one bar per distinct value.
      fillCategory(preset && typeof preset.category === 'string' ? preset.category : '');
      if (grainSel) grainSel.value = preset && typeof preset.grain === 'string' ? preset.grain : '';
      setCatNote('');
      syncGrain();

      const textCols = columns.filter((c) => c.type !== 'number');
      fill(
        serSel,
        [{ value: '', label: 'None' }].concat(textCols.map((c) => ({ value: c.name, label: c.label || c.name, title: c.title }))),
        preset && typeof preset.series === 'string' ? preset.series : '',
      );

      if (geoSel) {
        geoSel.value = preset && preset.geo && typeof preset.geo.level === 'string' ? preset.geo.level : '';
      }

      if (preset && Array.isArray(preset.values) && preset.values.length) {
        measures = preset.values.map((v: any) => ({
          column: v && typeof v.column === 'string' ? v.column : '',
          aggregation: ENC_AGGS.indexOf(v && v.aggregation) >= 0 ? (v.aggregation as EncAgg) : 'sum',
          ...(v && typeof v.metricId === 'string' ? { metricId: v.metricId } : {}),
        }));
      } else {
        const nums = numberCols();
        measures = [{ column: nums[0] ? nums[0].name : '', aggregation: 'sum' }];
      }
      filters = Array.isArray(presetFilters) ? presetFilters.map((f) => ({ ...f })) : [];
      renderMeasures();
      renderFilters();
      syncSingles();
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
        categoryChanged(); // assigning `.value` fires no `change` — do it by hand
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
        // Inert until a condition is set — dropping a field must not silently
        // change the chart, and must not throw a modal over the drop either.
        filters.push({ type: 'filter', column, op: '' });
        renderFilters();
        return true;
      } else {
        return false;
      }
      syncSingles();
      opts.onChange();
      return true;
    },

    getEncoding(): any {
      const enc: any = {
        category: catSel ? catSel.value : '',
        values: measures.filter((m) => m.column).map((m) => (
          m.metricId
            ? { column: m.column, aggregation: m.aggregation, metricId: m.metricId }
            : { column: m.column, aggregation: m.aggregation }
        )),
      };
      const series = serSel ? serSel.value : '';
      if (series) enc.series = series;
      // The grain travels WITH the encoding, so a tile, a published snapshot and
      // an Assistant plan all bucket the same dates the same way. Only for a date
      // category — main ignores it elsewhere, and carrying it would let a stale
      // grain reappear when the dimension goes back to being a date.
      const grain = grainSel && !grainSel.hidden ? grainSel.value : '';
      if (grain) enc.grain = grain;
      const geoLevel = geoSel ? geoSel.value : '';
      if (geoLevel) enc.geo = { level: geoLevel };
      return enc;
    },

    // Rows with no column — and now rows with no OPERATOR — are dropped here;
    // main-side sanitizeFilters validates and whitelists again regardless.
    //
    // The operator check makes an old comment finally true. A freshly added or
    // freshly dropped row used to be `{op: '=', value: ''}`, and the code here
    // claimed such a row "changes nothing until it names a column". It did
    // change something: `= ''` matches rows whose cell is EMPTY, so dropping a
    // field on FILTERS blanked the chart until you typed a value. An unset row
    // now carries `op: ''`, which is in no operator vocabulary, so it is
    // genuinely inert on every path — here, in sanitizeSteps, and in SQL.
    getFilters(): any[] {
      return filters
        .filter((f) => f && f.column && f.op)
        .map((f) => {
          const s: any = { type: 'filter', column: f.column, op: f.op || '=' };
          if (isListFilterOp(f.op)) s.values = Array.isArray(f.values) ? f.values.slice() : [];
          else if (!isValuelessFilterOp(f.op)) s.value = f.value != null ? f.value : '';
          return s;
        });
    },

    getColumns(): EncCol[] {
      return columns.slice();
    },

    applyCategoryInfo(info: EncCategoryInfo | null | undefined): void {
      syncGrain();
      if (grainSel && !grainSel.hidden && info && typeof info.grain === 'string') {
        // Only fills a BLANK select: main echoes the grain it used, which on the
        // second and later computes is the one already showing. Overwriting
        // unconditionally would be harmless today and a lie the moment main ever
        // clamps a grain the user chose.
        if (!grainSel.value) grainSel.value = info.grain;
      }
      setCatNote(info && typeof info.note === 'string' ? info.note : '');
    },

    setGrain(grain: string): boolean {
      syncGrain();
      if (!grainSel || grainSel.hidden || grainSel.value === grain) return false;
      grainSel.value = grain;
      return grainSel.value === grain;
    },

    showFields(on: boolean): void {
      root.querySelectorAll('.viz-build-row').forEach((row) => {
        if (row.classList.contains('js-enc-filters-row')) return;
        (row as HTMLElement).hidden = !on;
      });
    },

    show(on: boolean): void {
      root.hidden = !on;
    },
  };
}
