// Format — the depth of a chart's formatting, as ONE panel with two homes:
//
//   · the chart's ⋯ menu → Customize (every chart surface: the Visuals builder,
//     dashboard and analysis cards, a capture's result), mounted by
//     fmtMountChartMenu from chartControls.openChartMenu;
//   · the analysis editor's Properties → Format tab, mounted by
//     fmtRenderAnalysisFormat from authoringProps.
//
// Sections: Legend (top / right / bottom / left / none), Axes (per axis: title,
// min / max, log scale, number format, tick density, hide — and the right axis
// with which measures sit on it), Data labels (which, format, position), Sort
// (by value, by label, or a custom order you drag — fmtSort.ts), and Colours
// (fmtColorsUi.ts). Every control writes a key of the visual's ordinary
// `overrides` — the object buildChart reads and src/analysis/chartFormat.ts
// clamps — so there is no second store to drift.
//
// The panel re-renders itself after each change (a sort mode shows its order
// list, an axis loses its log switch), keeping open sections open and focus on
// the control that changed.
//
// Classic global-scope renderer <script>: no import/export.

interface FmtPanelCtx {
  type: string;
  /** The chart's {labels, series}, or null while it is still being computed. */
  data: ChartDataShape | null;
  /** The visual's measures, by the names its series are drawn under. */
  measures: string[];
  ov(): any;
  /** Merge `partial` into the overrides (null deletes a key), persist, redraw. */
  patch(partial: Record<string, any>): void;
  /** Where the chart's labels and series come from — null for a chart with no dataset. */
  scope: { projectId: string; category: string; series: string } | null;
  /** Redraw after an edit to the PROJECT's colours (nothing in `overrides` changed). */
  repaint(): void;
  skipLegend?: boolean;
  /**
   * The element the chart draws in. A dashboard style preset remaps
   * --chart-1..8 on a CONTAINER, so a swatch must read its colour there — as
   * buildChart does off its canvas — not off the menu, which lives on <body>.
   */
  colorEl(): Element | null;
}

const FMT_NUMBER_FORMATS: Array<[string, string]> = [
  ['', 'Chart default'], ['auto', 'Auto (K/M/B)'], ['plain', 'Plain'], ['thousands', 'Thousands (1,234)'],
  ['compact', 'Compact (1.2K)'], ['percent', 'Percent (12%)'], ['currency', 'Currency ($1,234)'],
];

/** Disclosure sections the user opened — kept open across the panel's own re-renders. */
const fmtOpenSections = new Set<string>();
let fmtFieldSeq = 0;

/** Mirrors chartFormat.measureNames in main (scripts/test-chartFormat.ts pins the two). */
function fmtMeasureNames(encoding: any): string[] {
  const out: string[] = [];
  (encoding && Array.isArray(encoding.values) ? encoding.values : []).forEach((v: any) => {
    const col = v && typeof v.column === 'string' ? v.column : '';
    if (!col) return;
    const agg = typeof v.aggregation === 'string' ? v.aggregation : 'sum';
    if (agg === 'count') out.push(col);
    else if (agg === 'none') out.push('sum of ' + col, col);
    else out.push(agg + ' of ' + col);
  });
  return out;
}

function fmtPanelScope(src: any): FmtPanelCtx['scope'] {
  const scoped = fmtWithScope({}, src);
  return fmtScopeOf(scoped) ? scoped._colorScope : null;
}

// ── Small builders (the ⋯ menu's own cm-* controls) ────────────────────────

function fmtKeyed<T extends HTMLElement>(el: T, key: string): T {
  el.dataset.fmtKey = key;
  return el;
}

function fmtField(host: HTMLElement, label: string, control: HTMLElement): HTMLElement {
  const f = document.createElement('div');
  f.className = 'cm-field';
  const l = document.createElement('label');
  l.className = 'cm-label';
  l.textContent = label;
  // A counter, not the key: two panels (the ⋯ menu and the Format tab) can be
  // in the document at once, and a key can hold a measure name with spaces.
  const id = 'fmt-field-' + (++fmtFieldSeq);
  control.id = id;
  l.htmlFor = id;
  f.append(l, control);
  host.appendChild(f);
  return f;
}

function fmtSelect(key: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = fmtKeyed(document.createElement('select'), key);
  s.className = 'cm-input cm-select';
  options.forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    s.appendChild(o);
  });
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function fmtSwitch(host: HTMLElement, key: string, label: string, on: boolean, onToggle: (on: boolean) => void, disabled = false): void {
  const row = document.createElement('div');
  row.className = 'cm-toggle-row';
  const t = document.createElement('span');
  t.className = 'cm-toggle-label';
  t.textContent = label;
  const b = fmtKeyed(document.createElement('button'), key);
  b.type = 'button';
  b.className = 'cm-switch' + (on ? ' cm-switch-on' : '');
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  const thumb = document.createElement('span');
  thumb.className = 'cm-switch-thumb';
  b.appendChild(thumb);
  b.addEventListener('click', () => onToggle(!on));
  row.append(t, b);
  host.appendChild(row);
}

function fmtNote(host: HTMLElement, text: string, warn = false): void {
  const p = document.createElement('p');
  p.className = 'fmt-note' + (warn ? ' fmt-note--warn' : '');
  p.textContent = text;
  host.appendChild(p);
}

function fmtSection(host: HTMLElement, title: string): HTMLElement {
  const open = fmtOpenSections.has(title);
  const sec = document.createElement('section');
  sec.className = 'an-sec fmt-sec' + (open ? ' is-open' : '');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'an-sec-head';
  head.dataset.fmtKey = 'sec:' + title;
  head.setAttribute('aria-expanded', String(open));
  const chev = document.createElement('span');
  chev.className = 'an-sec-chev';
  chev.setAttribute('aria-hidden', 'true');
  setIcon(chev, 'chevron-right');
  const t = document.createElement('span');
  t.textContent = title;
  head.append(chev, t);
  const body = document.createElement('div');
  body.className = 'an-sec-body';
  head.addEventListener('click', () => {
    const on = sec.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(on));
    if (on) fmtOpenSections.add(title); else fmtOpenSections.delete(title);
  });
  sec.append(head, body);
  host.appendChild(sec);
  return body;
}

// ── Legend ───────────────────────────────────────────────────────────────────

function fmtLegendField(host: HTMLElement, ctx: FmtPanelCtx): void {
  const ov = ctx.ov();
  const dflt = legendOnByDefault(ctx.type, chartSeries(ctx.data || {}));
  const shown = ov.showLegend !== undefined ? !!ov.showLegend : dflt;
  const value = shown ? (ov.legendPosition || 'bottom') : 'none';
  const sel = fmtSelect('legend', [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left'], ['none', 'None']],
    value, (v) => {
      if (v === 'none') ctx.patch({ showLegend: false });
      else ctx.patch({ showLegend: dflt ? null : true, legendPosition: v === 'bottom' ? null : v });
    });
  fmtField(host, 'Legend', sel);
}

// ── Axes ────────────────────────────────────────────────────────────────────

/** The numbers drawn on an axis, from the chart's data (the log-scale check). */
function fmtDataOnAxis(ctx: FmtPanelCtx, key: string): number[] {
  const ov = ctx.ov();
  const right = new Set(Array.isArray(ov.y2Series) ? ov.y2Series : []);
  const out: number[] = [];
  chartSeries(ctx.data || {}).forEach((s) => {
    if (s.role === 'overlay') return;
    if (key === 'y2' ? !right.has(s.name) : right.has(s.name)) return;
    s.values.forEach((v: any) => { if (typeof v === 'number' && Number.isFinite(v)) out.push(v); });
  });
  return out;
}

function fmtSetAxis(ctx: FmtPanelCtx, key: string, props: Record<string, any>): void {
  const axes = Object.assign({}, ctx.ov().axes || {});
  const a = Object.assign({}, axes[key] || {});
  Object.keys(props).forEach((p) => {
    if (props[p] === null || props[p] === undefined || props[p] === false || props[p] === '') delete a[p];
    else a[p] = props[p];
  });
  if (Object.keys(a).length) axes[key] = a; else delete axes[key];
  ctx.patch({ axes: Object.keys(axes).length ? axes : null });
}

function fmtAxisBlock(body: HTMLElement, ctx: FmtPanelCtx, key: 'x' | 'y' | 'y2', role: FmtRole): void {
  const ov = ctx.ov();
  const a = (ov.axes && ov.axes[key]) || {};
  const head = document.createElement('div');
  head.className = 'fmt-sub';
  head.textContent = (key === 'x' ? 'X axis' : key === 'y' ? 'Y axis' : 'Right axis')
    + (role === 'value' ? ' · values' : ' · categories');
  body.appendChild(head);

  // The title keys predate this panel (xAxisLabel / yAxisLabel); the right
  // axis's is their sibling. Debounced like every text field in the app.
  const titleKey = key === 'x' ? 'xAxisLabel' : key === 'y' ? 'yAxisLabel' : 'y2AxisLabel';
  const title = fmtKeyed(document.createElement('input'), key + ':title');
  title.className = 'cm-input';
  title.type = 'text';
  title.autocomplete = 'off';
  title.placeholder = 'No title';
  title.value = ov[titleKey] || '';
  let titleTimer: number | null = null;
  title.addEventListener('input', () => {
    if (titleTimer !== null) window.clearTimeout(titleTimer);
    titleTimer = window.setTimeout(() => { titleTimer = null; ctx.patch({ [titleKey]: title.value.trim() || null }); }, 400);
  });
  fmtField(body, 'Title', title);

  if (role === 'value') {
    const pair = document.createElement('div');
    pair.className = 'fmt-pair';
    body.appendChild(pair);
    const err = document.createElement('p');
    err.className = 'fmt-note fmt-note--warn';
    err.hidden = true;
    const num = (prop: 'min' | 'max', label: string) => {
      const inp = fmtKeyed(document.createElement('input'), key + ':' + prop);
      inp.className = 'cm-input';
      inp.type = 'number';
      inp.step = 'any';
      inp.placeholder = 'Auto';
      inp.value = typeof a[prop] === 'number' ? String(a[prop]) : '';
      inp.addEventListener('change', () => {
        const n = inp.value.trim() === '' ? null : Number(inp.value);
        const next = Object.assign({}, a, { [prop]: n });
        const problem = n !== null && !Number.isFinite(n) ? 'Enter a number, or leave it empty for Auto.'
          : typeof next.min === 'number' && typeof next.max === 'number' && !(next.min < next.max) ? 'Min must be below Max.'
          : a.log && typeof next.min === 'number' && next.min <= 0 ? 'A log scale needs Min above 0.'
          : '';
        err.textContent = problem;
        err.hidden = !problem;
        if (!problem) fmtSetAxis(ctx, key, { [prop]: n });
      });
      fmtField(pair, label, inp);
    };
    num('min', 'Min');
    num('max', 'Max');
    body.appendChild(err);

    // "Start at zero" is the chart's VALUE axis (buildChartScales' yZero): y,
    // or x on a horizontal bar. Chart.js starts bars at zero and lines at
    // their data, so that is what an untouched switch shows.
    const s = resolveChartType(ctx.type);
    const zeroAxis = s.isHoriz ? 'x' : 'y';
    // Not under a log scale, which has no zero to start at.
    if (key === zeroAxis && !a.log && !s.isScatter && !s.isBubble && !s.isCandlestick && !s.isBoxplot && !s.opts.pct) {
      const on = ov.yZero !== undefined ? !!ov.yZero : s.chartType === 'bar';
      fmtSwitch(body, key + ':zero', 'Start at zero', on, (next) => ctx.patch({ yZero: next }));
    }

    const minBlocks = typeof a.min === 'number' && a.min <= 0;
    fmtSwitch(body, key + ':log', 'Log scale', !!a.log, (on) => fmtSetAxis(ctx, key, { log: on }), !a.log && minBlocks);
    if (!a.log && minBlocks) fmtNote(body, 'A log scale needs Min above 0.');
    if (a.log && ctx.data && fmtDataOnAxis(ctx, key === 'x' ? 'y' : key).some((v) => v <= 0)) {
      fmtNote(body, 'Some values here are zero or below, so this axis is drawn linear.', true);
    }
    fmtField(body, 'Number format', fmtSelect(key + ':format', FMT_NUMBER_FORMATS, a.format || '',
      (v) => fmtSetAxis(ctx, key, { format: v || null })));
  }
  fmtField(body, 'Tick density', fmtSelect(key + ':ticks', [['', 'Auto'], ['few', 'Fewer'], ['many', 'More']], a.ticks || '',
    (v) => fmtSetAxis(ctx, key, { ticks: v || null })));
  fmtSwitch(body, key + ':hide', 'Hide axis', !!a.hide, (on) => fmtSetAxis(ctx, key, { hide: on }));
}

/** Measure series a right axis can take: two or more, and not a split. */
function fmtDualMeasures(ctx: FmtPanelCtx): string[] {
  if (ctx.scope && ctx.scope.series) return [];
  const names = chartSeries(ctx.data || {}).filter((s) => s.role !== 'overlay').map((s) => String(s.name || ''));
  return names.length >= 2 ? names : [];
}

function fmtAxesSection(host: HTMLElement, ctx: FmtPanelCtx): void {
  const roles = fmtAxisRoles(ctx.type);
  if (!roles.x && !roles.y) return;
  const body = fmtSection(host, 'Axes');
  fmtSwitch(body, 'gridlines', 'Gridlines', ctx.ov().showGridlines !== false,
    (on) => ctx.patch({ showGridlines: on ? null : false }));
  if (roles.x) fmtAxisBlock(body, ctx, 'x', roles.x);
  if (roles.y) fmtAxisBlock(body, ctx, 'y', roles.y);
  const measures = roles.y2 ? fmtDualMeasures(ctx) : [];
  if (!measures.length) return;
  const ov = ctx.ov();
  const assigned: string[] | null = Array.isArray(ov.y2Series) ? ov.y2Series : null;
  // A combo's default: its lines (every measure after the first) on the right.
  const right = new Set(assigned || (ctx.type === 'combo' ? measures.slice(1) : []));
  const head = document.createElement('div');
  head.className = 'fmt-sub';
  head.textContent = 'Measures on the right axis';
  body.appendChild(head);
  measures.forEach((m) => {
    const on = right.has(m);
    // At least one measure stays on the left axis (main clamps the same rule).
    const last = !on && right.size >= measures.length - 1;
    fmtSwitch(body, 'y2:' + m, m, on, (next) => {
      const set = new Set(right);
      if (next) set.add(m); else set.delete(m);
      ctx.patch({ y2Series: measures.filter((x) => set.has(x)) });
    }, last);
  });
  if (right.size) fmtAxisBlock(body, ctx, 'y2', 'value');
}

// ── Data labels ─────────────────────────────────────────────────────────────

function fmtLabelsSection(host: HTMLElement, ctx: FmtPanelCtx): void {
  if (NO_VALUE_LABEL_TYPES.has(ctx.type) || ctx.type === 'table' || ctx.type.indexOf('map_') === 0) return;
  const ov = ctx.ov();
  const body = fmtSection(host, 'Data labels');
  const mode = ov.valueMode || (ov.showValues ? 'all' : 'maxmin');
  fmtField(body, 'Show', fmtSelect('labels:mode', VALUE_MODES as Array<[string, string]>, mode,
    (v) => ctx.patch({ valueMode: v })));
  fmtField(body, 'Format', fmtSelect('labels:format', FMT_NUMBER_FORMATS, ov.labelFormat || '',
    (v) => ctx.patch({ labelFormat: v || null })));
  const roles = fmtAxisRoles(ctx.type);
  if (roles.x === 'value' || roles.y === 'value') {
    fmtField(body, 'Position', fmtSelect('labels:pos',
      [['outside', 'Outside end'], ['inside', 'Inside end'], ['center', 'Centre']], ov.labelPosition || 'outside',
      (v) => ctx.patch({ labelPosition: v === 'outside' ? null : v })));
  }
}

// ── The panel ────────────────────────────────────────────────────────────────

function fmtRenderPanel(host: HTMLElement, ctx: FmtPanelCtx): void {
  if (!host) return;
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
    ? document.activeElement.dataset.fmtKey || '' : '';
  host.innerHTML = '';
  if (!ctx.skipLegend) fmtLegendField(host, ctx);
  fmtAxesSection(host, ctx);
  fmtLabelsSection(host, ctx);
  fmtSortSection(host, ctx);
  fmtColoursSection(host, ctx);
  if (focused) {
    const again = Array.from(host.querySelectorAll('[data-fmt-key]'))
      .find((el) => (el as HTMLElement).dataset.fmtKey === focused) as HTMLElement | undefined;
    if (again) {
      again.focus();
      // A text field keeps its caret at the end, so typing carries on.
      if (again instanceof HTMLInputElement && again.type === 'text') again.setSelectionRange(again.value.length, again.value.length);
    }
  }
}

/** The ⋯ menu's Customize: this chart's entry, its overrides key, its container. */
function fmtMountChartMenu(host: HTMLElement | null, container: HTMLElement, data: any, type: string,
  entry: any, turnIdx: any, overrideKey: string): void {
  if (!host) return;
  const redraw = () => renderVizInArea(container, data, type, entry, turnIdx);
  const ctx: FmtPanelCtx = {
    type,
    data,
    measures: entry && entry.drill ? fmtMeasureNames(entry.drill.encoding) : chartSeries(data).map((s) => String(s.name || '')),
    ov: () => (entry.chartOverrides && entry.chartOverrides[overrideKey]) || {},
    patch: (partial) => {
      patchOverride(entry, overrideKey, partial);
      redraw();
      fmtRenderPanel(host, ctx);
    },
    scope: fmtPanelScope(entry && entry.drill),
    repaint: () => { redraw(); fmtRenderPanel(host, ctx); },
    colorEl: () => container,
  };
  fmtRenderPanel(host, ctx);
}

/**
 * The analysis editor's Format tab, below its Display and Axes sections (which
 * already carry the title and the legend). The data comes from main — the
 * Properties pane holds only the visual record, not its drawn chart.
 */
function fmtRenderAnalysisFormat(host: HTMLElement, visual: any, write: () => void): void {
  if (!host || !visual) return;
  const wrap = document.createElement('div');
  wrap.className = 'fmt-panel fmt-panel--props';
  host.appendChild(wrap);
  const ov = () => {
    if (!visual.overrides || typeof visual.overrides !== 'object') visual.overrides = {};
    return visual.overrides;
  };
  const ctx: FmtPanelCtx = {
    type: String(visual.chartType || 'column'),
    data: null,
    measures: fmtMeasureNames(visual.encoding),
    ov,
    patch: (partial) => {
      const o = ov();
      Object.keys(partial).forEach((k) => { if (partial[k] === null || partial[k] === undefined) delete o[k]; else o[k] = partial[k]; });
      write();
      fmtRenderPanel(wrap, ctx);
    },
    scope: fmtPanelScope({ projectId: currentProjectId, encoding: visual.encoding }),
    repaint: () => {
      if (typeof renderDashGrid === 'function') renderDashGrid();
      if (typeof anPaintSelection === 'function') anPaintSelection();
      fmtRenderPanel(wrap, ctx);
    },
    skipLegend: true,
    // The selected card's chart, else any chart on the sheet — the sheet's
    // style preset is what its colours resolve against.
    colorEl: () => document.querySelector('#dash-grid .dash-card.is-selected .cv-viz-area')
      || document.querySelector('#dash-grid .cv-viz-area') || document.getElementById('dash-grid'),
  };
  fmtRenderPanel(wrap, ctx);
  if (!currentProjectId || !visual.datasetId) return;
  window.hub.computeVisualData(currentProjectId, visual.datasetId, visual.encoding, visual.filters || [])
    .then((res: any) => {
      if (!res || res.ok === false || !res.data || !wrap.isConnected) return;
      ctx.data = res.data;
      fmtRenderPanel(wrap, ctx);
    })
    .catch(() => { /* the data-free sections are already there */ });
}
