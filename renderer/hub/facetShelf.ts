// The Facet shelf — small multiples in the Visuals builder, under the chart's
// own shelves AND the pivot's (one widget, shown for both). Classic
// global-scope renderer script, mounted by visuals.ts beside the encoding form.
//
// It owns `encoding.facet` and nothing else: Rows and/or Columns (one field
// each), shared or independent value axis, panel order, how many panels before
// the rest fold into "Other", and the panel title. Main does the splitting
// (src/analysis/facets.ts); this only says what was asked for.

interface FacetShelfApi {
  el: HTMLElement;
  setColumns(cols: EncCol[], preset?: any): void;
  /** `encoding.facet`, or null when no field is on either side. */
  getFacet(): any;
  show(on: boolean): void;
}

/** The builder's one shelf (visuals.ensureVizForm mounts it). */
let vizFacetForm: FacetShelfApi | null = null;

const FACET_TITLES: Array<[string, string]> = [
  ['{value}', 'Value'],
  ['{field}: {value}', 'Field: value'],
];

function createFacetShelf(opts: { onChange: () => void }): FacetShelfApi {
  let cols: EncCol[] = [];
  let state: any = {};

  const root = document.createElement('section');
  root.className = 'fc-shelf';
  root.setAttribute('aria-label', 'Small multiples');

  const head = document.createElement('div');
  head.className = 'fc-shelf-head';
  const title = document.createElement('span');
  title.className = 'fc-shelf-title';
  title.textContent = 'Small multiples';
  const badge = document.createElement('span');
  badge.className = 'fc-shelf-badge';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm fc-shelf-clear';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { state = {}; paint(); opts.onChange(); });
  head.append(title, badge, clear);

  const empty = document.createElement('p');
  empty.className = 'fc-shelf-empty';
  empty.textContent = 'Split this chart into a grid of panels — one per value of a field, all drawn the same way.';

  const dims = document.createElement('div');
  dims.className = 'fc-shelf-dims';
  const rowSel = facetSelect('Rows', 'Facet rows');
  const colSel = facetSelect('Columns', 'Facet columns');
  dims.append(rowSel.box, colSel.box);

  const more = document.createElement('div');
  more.className = 'fc-shelf-opts';

  // Shared / independent — a segmented control, because the two are a pair.
  const scaleBox = facetOpt('Value axis', 'div'); // a <label> would click its first button
  scaleBox.classList.add('is-wide');
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Value axis');
  const segBtns = (['shared', 'independent'] as const).map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-opt';
    b.textContent = v === 'shared' ? 'Shared' : 'Independent';
    b.addEventListener('click', () => { state.scale = v === 'shared' ? undefined : v; paint(); opts.onChange(); });
    seg.appendChild(b);
    return { v, b };
  });
  scaleBox.appendChild(seg);

  const orderBox = facetOpt('Order');
  const order = document.createElement('select');
  order.className = 'viz-select';
  order.setAttribute('aria-label', 'Panel order');
  for (const [v, t] of [['label', 'By label'], ['measure', 'By value']]) order.appendChild(new Option(t, v));
  order.addEventListener('change', () => { state.order = order.value === 'measure' ? 'measure' : undefined; opts.onChange(); });
  orderBox.appendChild(order);

  const maxBox = facetOpt('Panels before Other');
  const max = document.createElement('input');
  max.type = 'number';
  max.min = '2';
  max.max = '36';
  max.className = 'viz-select';
  max.placeholder = '12';
  max.setAttribute('aria-label', 'Panels before the rest fold into Other');
  max.addEventListener('change', () => {
    const n = Math.round(Number(max.value));
    state.max = Number.isFinite(n) && n >= 2 && n <= 36 ? n : undefined;
    max.value = state.max ? String(state.max) : '';
    opts.onChange();
  });
  maxBox.appendChild(max);

  const titleBox = facetOpt('Panel title');
  const titleSel = document.createElement('select');
  titleSel.className = 'viz-select';
  titleSel.setAttribute('aria-label', 'Panel title format');
  for (const [v, t] of FACET_TITLES) titleSel.appendChild(new Option(t, v));
  titleSel.addEventListener('change', () => { state.title = titleSel.value === '{value}' ? undefined : titleSel.value; opts.onChange(); });
  titleBox.appendChild(titleSel);

  more.append(scaleBox, orderBox, maxBox, titleBox);
  root.append(head, empty, dims, more);

  for (const [sel, key] of [[rowSel.sel, 'rows'], [colSel.sel, 'cols']] as const) {
    sel.addEventListener('change', () => {
      state[key] = sel.value || undefined;
      const other = key === 'rows' ? 'cols' : 'rows';
      if (state[other] === state[key]) state[other] = undefined; // one field, one side
      paint();
      opts.onChange();
    });
  }

  function fill(sel: HTMLSelectElement, value: string | undefined): void {
    sel.textContent = '';
    sel.appendChild(new Option('None', ''));
    for (const c of cols) sel.appendChild(new Option(c.label || c.name, c.name));
    sel.value = value && cols.some((c) => c.name === value) ? value : '';
  }

  function paint(): void {
    fill(rowSel.sel, state.rows);
    fill(colSel.sel, state.cols);
    const on = !!(state.rows || state.cols);
    root.classList.toggle('is-on', on);
    empty.hidden = on;
    more.hidden = !on;
    clear.hidden = !on;
    badge.textContent = state.rows && state.cols ? 'Matrix' : on ? 'Wrapped' : '';
    segBtns.forEach(({ v, b }) => b.setAttribute('aria-pressed', String((state.scale || 'shared') === v)));
    order.value = state.order === 'measure' ? 'measure' : 'label';
    max.value = state.max ? String(state.max) : '';
    titleSel.value = FACET_TITLES.some(([v]) => v === state.title) ? state.title : '{value}';
  }

  return {
    el: root,
    setColumns(next: EncCol[], preset?: any): void {
      cols = Array.isArray(next) ? next : [];
      state = preset && typeof preset === 'object' ? Object.assign({}, preset) : {};
      paint();
    },
    getFacet(): any {
      if (!state.rows && !state.cols) return null;
      const out: any = {};
      for (const k of ['rows', 'cols', 'scale', 'order', 'max', 'title']) if (state[k] !== undefined) out[k] = state[k];
      return out;
    },
    show(on: boolean): void { root.hidden = !on; },
  };
}

function facetSelect(label: string, aria: string): { box: HTMLElement; sel: HTMLSelectElement } {
  const box = facetOpt(label);
  const sel = document.createElement('select');
  sel.className = 'viz-select';
  sel.setAttribute('aria-label', aria);
  box.appendChild(sel);
  return { box, sel };
}

function facetOpt(label: string, tag: 'label' | 'div' = 'label'): HTMLElement {
  const box = document.createElement(tag);
  box.className = 'fc-shelf-opt';
  const t = document.createElement('span');
  t.className = 'fc-shelf-label';
  t.textContent = label;
  box.appendChild(t);
  return box;
}
