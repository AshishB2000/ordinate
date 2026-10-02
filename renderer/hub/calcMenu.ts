'use strict';

// Table calculations in the renderer — the "Calculate as…" menu on a measure
// chip, a pivot value chip and a KPI card, the chip's badge, and the display of
// a calculated figure beside its raw one ("24.1% of total · 1.25M") in chart
// tooltips, axis ticks, pivot cells and the KPI figure line.
//
// Classic global-scope renderer <script>: NO import/export. Loads after
// chartControls.js (openMiniMenu / miniMenuRow) and formatBind.js (OrdFormat);
// everything it calls is looked up at call time.
//
// NOTHING HERE COMPUTES A FIGURE. The calc runs in main (src/analysis/
// tableCalc.ts, pivotCalc.ts, src/ipc/tableCalcKpi.ts) on the aggregated grid;
// this file stores which calc the user chose on the encoding and formats what
// main sent back. `tcCalcParts` mirrors tableCalc.calcParts on the same shared
// formatter, and scripts/test-tableCalc.ts runs the two side by side.

/** A stored calc, as `analysis/tableCalc.TableCalc`. */
interface TcCalc {
  kind: string;
  along: 'across' | 'down' | { dimension: string };
  restart?: string;
  window?: number;
}

/** What the menu needs to know about where it was opened. */
interface TcContext {
  surface: 'chart' | 'pivot' | 'kpi';
  /** The grid's dimensions, and the axis each one runs along. */
  dims: Array<{ name: string; axis: 'across' | 'down' }>;
  /** Why year over year is unavailable here, or '' when it is available. */
  yoyOff?: string;
  /** Why every kind but percent of total is unavailable (a KPI with no dates), or ''. */
  periodsOff?: string;
}

const TC_KINDS: Array<{ kind: string; label: string; badge: string }> = [
  { kind: 'running_total', label: t('calcMenu.running_total'), badge: t('calcMenu.running_total') },
  { kind: 'pct_of_total', label: t('calcMenu.percent_of_total'), badge: t('common.of_total') },
  { kind: 'diff', label: t('calcMenu.difference_from_previous'), badge: t('calcMenu.diff') },
  { kind: 'pct_diff', label: t('calcMenu.percent_difference_from_previous'), badge: t('calcMenu.diff_2') },
  { kind: 'rank_dense', label: t('calcMenu.rank_dense'), badge: t('common.rank') },
  { kind: 'rank_competition', label: t('calcMenu.rank_competition'), badge: t('common.rank') },
  { kind: 'percentile', label: t('common.percentile'), badge: t('common.percentile') },
  { kind: 'moving_avg', label: t('common.moving_average'), badge: t('calcMenu.moving_avg') },
  { kind: 'moving_sum', label: t('calcMenu.moving_sum'), badge: t('calcMenu.moving_sum') },
  { kind: 'yoy', label: t('calcMenu.year_over_year'), badge: 'YoY' },
  { kind: 'index', label: t('calcMenu.index_to_first_period'), badge: t('calcMenu.index') },
];
const TC_PERCENT = new Set(['pct_of_total', 'pct_diff', 'percentile', 'yoy']);
const TC_MOVING = new Set(['moving_avg', 'moving_sum']);
const TC_SUFFIX: Record<string, string> = {
  running_total: t('calcMenu.running_total_2'), pct_of_total: t('calcMenu.of_total'), diff: t('calcMenu.vs_previous'), pct_diff: t('calcMenu.vs_previous'),
  rank_dense: '', rank_competition: '', percentile: ' percentile', moving_avg: t('calcMenu.moving_avg_2'),
  moving_sum: t('calcMenu.moving_sum_2'), yoy: ' YoY', index: ' index',
};

const tcKindInfo = (kind: string) => TC_KINDS.find((k) => k.kind === kind) || null;

// ── Display — the mirror of tableCalc.calcValueText / calcParts / calcLabel ──

const tcNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tcSigned = (v: number, text: string): string => (v > 0 ? '+' + text : text);

function tcCalcValueText(kind: string, value: unknown): string {
  const v = tcNum(value);
  if (v === null) return '—';
  if (kind === 'pct_diff' || kind === 'yoy') return tcSigned(v, OrdFormat.formatPercent(v, 1));
  if (kind === 'pct_of_total' || kind === 'percentile') return OrdFormat.formatPercent(v, 1);
  if (kind === 'rank_dense' || kind === 'rank_competition') return '#' + OrdFormat.formatNumber(v, { maxDecimals: 0 });
  if (kind === 'index') return OrdFormat.formatNumber(v, { decimals: 1 });
  if (kind === 'diff') return tcSigned(v, OrdFormat.formatCompact(v));
  return OrdFormat.formatCompact(v);
}

function tcCalcParts(kind: string, value: unknown, raw?: unknown): { value: string; suffix: string; raw: string } {
  const r = tcNum(raw);
  return { value: tcCalcValueText(kind, value), suffix: TC_SUFFIX[kind] ?? '', raw: r === null ? '' : OrdFormat.formatCompact(r) };
}

function tcCalcLabel(kind: string, value: unknown, raw?: unknown): string {
  const p = tcCalcParts(kind, value, raw);
  return p.value + p.suffix + (p.raw ? ' · ' + p.raw : '');
}

/** The small pill on a chip naming its calc ("% of total"). No calc → nothing. */
function tcBadge(host: HTMLElement, calc: TcCalc | undefined | null): void {
  const info = calc ? tcKindInfo(calc.kind) : null;
  if (!info) return;
  const b = document.createElement('span');
  b.className = 'tc-badge';
  b.textContent = info.badge + (TC_MOVING.has(info.kind) ? ' ' + (calc.window || 3) : '');
  b.title = t('calcMenu.calculated_as', { p0: info.label.toLowerCase() });
  host.appendChild(b);
}

// ── Charts ───────────────────────────────────────────────────────────────────

/**
 * Tooltips name both figures for a calculated series. Called by buildChart for
 * the cartesian / round families; a chart with no calc keeps Chart.js's own
 * label, untouched.
 */
function tcTooltip(series: any[], tooltipConfig: any, fmt: (v: any) => string): void {
  const lead = (series || []).find((s) => s && s.calc);
  if (!lead) return;
  tooltipConfig.callbacks.label = (item: any) => {
    const s = series[item.datasetIndex] || series[0];
    const i = item.dataIndex;
    const v = s && Array.isArray(s.values) ? s.values[i] : null;
    const name = item.dataset && item.dataset.label ? item.dataset.label + ': ' : '';
    if (s && s.calc) return name + tcCalcLabel(s.calc.kind, v, Array.isArray(s.raw) ? s.raw[i] : null);
    // A prior-period overlay of a calculated series carries calculated values too.
    if (s && s.role === 'overlay') return name + tcCalcValueText(lead.calc.kind, v);
    return name + fmt(v);
  };
}

/**
 * The axis / value-label formatter for a calculated chart: percent kinds as a
 * percent, a rank as "#3", an index to one decimal. Mixed kinds, or no calc,
 * keep `base` — which is then the very function passed in.
 */
function tcAxisFmt(series: any[], base: (v: any) => string): (v: any) => string {
  const plotted = (series || []).filter((s) => s && s.role !== 'overlay');
  if (!plotted.length || !plotted.every((s) => s.calc)) return base;
  const kinds = plotted.map((s) => s.calc.kind);
  if (kinds.every((k) => TC_PERCENT.has(k))) return (v: any) => (tcNum(v) === null ? '' : OrdFormat.formatPercent(v, 1, { maxOnly: true }));
  if (kinds.every((k) => k === 'rank_dense' || k === 'rank_competition')) return (v: any) => (Number.isInteger(v) ? '#' + v : '');
  if (kinds.every((k) => k === 'index')) return (v: any) => (tcNum(v) === null ? '' : OrdFormat.formatNumber(v, { maxDecimals: 1 }));
  return base;
}

// ── Pivots ───────────────────────────────────────────────────────────────────

/** The calc kind a pivot value field carries, or '' (grid.calcs from pivotCalc.ts). */
function tcPivotKind(grid: any, vi: number): string {
  const c = grid && Array.isArray(grid.calcs) ? grid.calcs[vi] : null;
  return c && typeof c.kind === 'string' ? c.kind : '';
}

/** The tooltip line for a calculated pivot cell: "24.1% of total · 1.25M". */
function tcPivotTip(grid: any, r: number, c: number, vi: number): string {
  const kind = tcPivotKind(grid, vi);
  if (!kind) return '';
  const raw = grid.rawCells && grid.rawCells[r] ? grid.rawCells[r][c] : null;
  return tcCalcLabel(kind, grid.cells[r][c], raw);
}

// ── The menu ─────────────────────────────────────────────────────────────────

/** Why a kind is unavailable in this context, or ''. */
function tcDisabledReason(kind: string, ctx: TcContext): string {
  if (ctx.periodsOff && kind !== 'pct_of_total') return ctx.periodsOff;
  if (kind === 'yoy' && ctx.yoyOff) return ctx.yoyOff;
  return '';
}

/**
 * "Calculate as…" — the kinds, a check on the current one, "None" first, the
 * unavailable ones disabled with the reason beside them. Choosing a kind opens
 * the small settings popover (compute along / restart every / N); `onPick`
 * gets the finished calc, or `null` for None.
 */
function tcOpenCalcMenu(anchor: HTMLElement, current: TcCalc | undefined | null, ctx: TcContext, onPick: (calc: TcCalc | null) => void): void {
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    menu.classList.add('tc-menu');
    const head = document.createElement('div');
    head.className = 'tc-menu-head';
    head.textContent = t('calcMenu.calculate_as');
    menu.appendChild(head);
    const none = miniMenuRow(t('common.none'));
    setRowCheck(none, !current);
    none.addEventListener('click', () => { close(); onPick(null); });
    menu.appendChild(none);
    const sep = document.createElement('div');
    sep.className = 'chart-menu-sep';
    menu.appendChild(sep);
    TC_KINDS.forEach((k) => {
      const row = miniMenuRow(k.label);
      row.classList.add('tc-menu-row');
      row.dataset.kind = k.kind;
      setRowCheck(row, !!current && current.kind === k.kind);
      const why = tcDisabledReason(k.kind, ctx);
      if (why) {
        row.disabled = true;
        row.title = why;
        const note = document.createElement('span');
        note.className = 'tc-menu-why';
        note.textContent = why;
        row.appendChild(note);
      }
      row.addEventListener('click', () => {
        close();
        // A KPI's grid is its periods: nothing to choose but N.
        if (ctx.surface === 'kpi' && !TC_MOVING.has(k.kind)) { onPick({ kind: k.kind, along: 'across' }); return; }
        tcOpenCalcConfig(anchor, k.kind, current && current.kind === k.kind ? current : null, ctx, onPick);
      });
      menu.appendChild(row);
    });
  });
}

let tcActivePop: (() => void) | null = null;

/** The settings popover for one kind. A dialog, not a menu: it holds selects. */
function tcOpenCalcConfig(anchor: HTMLElement, kind: string, current: TcCalc | null, ctx: TcContext, onPick: (calc: TcCalc | null) => void): void {
  if (tcActivePop) tcActivePop();
  const info = tcKindInfo(kind);
  const pop = document.createElement('div');
  pop.className = 'tc-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', (info ? info.label : t('calcMenu.table_calculation')) + t('calcMenu.settings'));
  const title = document.createElement('div');
  title.className = 'tc-pop-title';
  title.textContent = info ? info.label : kind;
  pop.appendChild(title);

  const field = (label: string, control: HTMLElement, cls: string): void => {
    const wrap = document.createElement('label');
    wrap.className = 'tc-field ' + cls;
    const t = document.createElement('span');
    t.className = 'tc-field-label';
    t.textContent = label;
    wrap.appendChild(t);
    wrap.appendChild(control);
    pop.appendChild(wrap);
  };
  const select = (opts: Array<[string, string]>, value: string): HTMLSelectElement => {
    const s = document.createElement('select');
    s.className = 'viz-select tc-select';
    opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); });
    s.value = value;
    if (s.value !== value && opts.length) s.value = opts[0][0];
    return s;
  };

  let alongSel: HTMLSelectElement | null = null;
  let restartSel: HTMLSelectElement | null = null;
  if (ctx.surface !== 'kpi') {
    const cur = current ? current.along : ctx.surface === 'pivot' ? 'down' : 'across';
    const curVal = typeof cur === 'object' ? 'dim:' + cur.dimension : cur;
    const alongOpts: Array<[string, string]> = [['across', t('calcMenu.table_across')], ['down', t('calcMenu.table_down')]];
    ctx.dims.forEach((d) => alongOpts.push(['dim:' + d.name, t('calcMenu.along', { name: d.name })]));
    alongSel = select(alongOpts, curVal);
    field(t('calcMenu.compute_along'), alongSel, 'js-tc-along');
    if (ctx.surface === 'pivot') {
      const restartOpts: Array<[string, string]> = [['', t('common.none')]];
      ctx.dims.forEach((d) => restartOpts.push([d.name, d.name]));
      restartSel = select(restartOpts, current && current.restart ? current.restart : '');
      field(t('calcMenu.restart_every'), restartSel, 'js-tc-restart');
    } else {
      const note = document.createElement('p');
      note.className = 'tc-pop-note';
      note.textContent = t('calcMenu.restarting_needs_a_second_dimension_in');
      pop.appendChild(note);
    }
  }
  let nInput: HTMLInputElement | null = null;
  if (TC_MOVING.has(kind)) {
    nInput = document.createElement('input');
    nInput.type = 'number';
    nInput.min = '2';
    nInput.max = '366';
    nInput.step = '1';
    nInput.className = 'viz-select tc-n';
    nInput.value = String(current && current.window ? current.window : 3);
    field(ctx.surface === 'kpi' ? t('calcMenu.over_the_last_n_periods') : t('calcMenu.over_the_last_n_cells'), nInput, 'js-tc-n');
  }

  const actions = document.createElement('div');
  actions.className = 'tc-pop-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-ghost';
  cancel.textContent = t('common.cancel');
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-sm btn-primary js-tc-apply';
  apply.textContent = t('common.apply');
  actions.appendChild(cancel);
  actions.appendChild(apply);
  pop.appendChild(actions);
  document.body.appendChild(pop);

  const ac = new AbortController();
  const close = (): void => {
    ac.abort();
    pop.remove();
    if (tcActivePop === close) tcActivePop = null;
    if (anchor.isConnected) anchor.focus();
  };
  tcActivePop = close;
  cancel.addEventListener('click', close);
  apply.addEventListener('click', () => {
    const calc: TcCalc = { kind, along: 'across' };
    const a = alongSel ? alongSel.value : 'across';
    calc.along = a.startsWith('dim:') ? { dimension: a.slice(4) } : (a === 'down' ? 'down' : 'across');
    if (restartSel && restartSel.value) calc.restart = restartSel.value;
    if (nInput) {
      const n = Math.round(Number(nInput.value));
      calc.window = Number.isFinite(n) ? Math.min(366, Math.max(2, n)) : 3;
    }
    close();
    onPick(calc);
  });

  // Under the anchor, flipped above it when there is no room below.
  const rect = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 260;
  const h = pop.offsetHeight || 200;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w)) + 'px';
  pop.style.top = (rect.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 4) : rect.bottom + 4) + 'px';
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }, { capture: true, signal: ac.signal });
  setTimeout(() => {
    document.addEventListener('mousedown', (e) => { if (!pop.contains(e.target as Node)) close(); }, { capture: true, signal: ac.signal });
  }, 0);
  (pop.querySelector('select, input, .js-tc-apply') as HTMLElement | null)?.focus();
}

/** The "Calculate as…" row for an openRowMenu item list. */
function tcMenuItem(anchor: HTMLElement, current: TcCalc | undefined | null, ctx: () => TcContext, onPick: (calc: TcCalc | null) => void): { label: string; onClick: () => void } {
  const info = current ? tcKindInfo(current.kind) : null;
  return {
    label: t('calcMenu.calculate_as_2', { p0: (info ? '  (' + info.badge + ')' : '') }),
    // After the row menu has closed, so the two popovers never overlap.
    onClick: () => { setTimeout(() => tcOpenCalcMenu(anchor, current, ctx(), onPick), 0); },
  };
}

/**
 * A calc carried across a chart ↔ pivot switch. The chart's category becomes
 * the pivot's first ROW, so "along the category" (across) becomes "down" — and
 * the reverse. A named dimension means the same thing on both.
 */
function tcSwapAxis(calc: TcCalc): TcCalc {
  if (typeof calc.along === 'object') return { ...calc };
  return { ...calc, along: calc.along === 'down' ? 'across' : 'down' };
}

/** A chart as "Calculate as" sees it: the category runs across, a split runs down. */
function tcChartContext(columns: Array<{ name: string; type: string }>, category: string, split: string): TcContext {
  const dims: TcContext['dims'] = [];
  if (category) dims.push({ name: category, axis: 'across' });
  if (split) dims.push({ name: split, axis: 'down' });
  const cat = (columns || []).find((c) => c.name === category);
  return { surface: 'chart', dims, yoyOff: cat && cat.type === 'date' ? '' : t('calcMenu.needs_a_date_category') };
}

/**
 * The builder form's own "fx" button beside a measure's aggregation — the
 * form variant has no ⋮ menu to put "Calculate as" in.
 */
function tcChipButton(current: TcCalc | undefined | null, ctx: () => TcContext, onPick: (calc: TcCalc | null) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tc-chip-btn js-tc-calc' + (current ? ' is-on' : '');
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-label', t('calcMenu.calculate_as'));
  b.title = t('calcMenu.calculate_as_3');
  b.appendChild(icon('function', 14));
  b.addEventListener('click', (e) => { e.stopPropagation(); tcOpenCalcMenu(b, current, ctx(), onPick); });
  return b;
}

// ── KPI cards ────────────────────────────────────────────────────────────────

const TC_KPI_REASONS: Record<string, string> = {
  no_date_column: t('calcMenu.needs_a_date_column_to_form'),
  no_periods: t('calcMenu.no_periods_to_calculate_over'),
  not_a_date_axis: t('calcMenu.the_periods_are_not_dates_so'),
};

/**
 * A KPI card with a calc: the figure becomes the calculated one and a line
 * under it names what it is and the raw figure — "of total · 1.25M". Main
 * computes it (tableCalc:kpi); this only paints.
 */
async function paintMetricCalc(card: any, body: HTMLElement): Promise<void> {
  const m = card && card.metric;
  if (!m || !m.calc || !currentProjectId || !window.hubPower) return;
  const valEl = body.querySelector('.dash-metric-value') as HTMLElement | null;
  const line = document.createElement('div');
  line.className = 'dash-metric-calc tnum is-loading';
  line.textContent = ' ';
  if (valEl) valEl.insertAdjacentElement('afterend', line);
  else body.appendChild(line);
  let r: any = null;
  try {
    r = await window.hubPower.kpiCalc(
      currentProjectId,
      { metricId: m.metricId, datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, format: m.format },
      effectiveFilters(), m.calc, dashParamPayload(),
    );
  } catch (_) {
    r = null;
  }
  if (!line.isConnected) return; // the grid re-rendered while this was in flight
  line.classList.remove('is-loading');
  if (!r || r.ok === false) { line.remove(); return; }
  if (r.reason) {
    line.classList.add('is-hint');
    line.textContent = TC_KPI_REASONS[r.reason] || t('calcMenu.cannot_calculate_this_here');
    return;
  }
  if (valEl) valEl.textContent = r.text;
  line.textContent = r.line;
  const info = tcKindInfo(r.kind);
  line.title = (info ? info.label : t('calcMenu.calculated')) + (r.period ? t('calcMenu.for', { period: r.period }) : '');
  body.classList.add('has-calc');
  // The label under the figure repeats the card's title in the common case;
  // with a calc line to show, that is the line the card can spare (as Compare does).
  const label = body.querySelector('.dash-metric-label') as HTMLElement | null;
  const title = (body.closest('.dash-card')?.querySelector('.dash-card-title')?.textContent || '').trim();
  if (label && (label.textContent || '').trim() === title) label.hidden = true;
}

/** The Properties section: "Calculate as" for the selected KPI card. */
async function tcRenderKpiProps(card: any, host: HTMLElement): Promise<void> {
  const m = card && card.metric;
  if (!m || !currentProjectId) return;
  const sec = document.createElement('div');
  sec.className = 'tc-kpi-props';
  const h = document.createElement('div');
  h.className = 'an-kpi-props-h';
  h.appendChild(icon('function', 14));
  const tv = document.createElement('span');
  tv.textContent = t('calcMenu.calculate_as');
  h.appendChild(tv);
  sec.appendChild(h);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tc-kpi-btn js-tc-kpi';
  btn.setAttribute('aria-haspopup', 'menu');
  const info = m.calc ? tcKindInfo(m.calc.kind) : null;
  const btnText = document.createElement('span');
  btnText.textContent = info ? info.label + (TC_MOVING.has(info.kind) ? ' (' + (m.calc.window || 3) + ')' : '') : t('common.none');
  btn.appendChild(btnText);
  btn.appendChild(icon('chevron-down', 12));
  sec.appendChild(btn);
  const note = document.createElement('p');
  note.className = 'an-prop-note an-prop-note--info';
  note.textContent = t('calcMenu.shows_the_figure_as_a_calculation');
  sec.appendChild(note);
  host.appendChild(sec);

  let dateColumn: string | null = null;
  try {
    const r = await window.hubPower.kpiCalcOptions(currentProjectId, { metricId: m.metricId, datasetId: m.datasetId, column: m.column, aggregation: m.aggregation });
    dateColumn = r && r.ok ? r.dateColumn : null;
  } catch (_) { dateColumn = null; }
  const ctx: TcContext = { surface: 'kpi', dims: [], periodsOff: dateColumn ? '' : t('calcMenu.needs_a_date_column_to_form') };
  btn.addEventListener('click', () => tcOpenCalcMenu(btn, m.calc, ctx, (calc) => {
    if (calc) m.calc = calc;
    else delete m.calc;
    markDashDirty(t('calcMenu.calculate_as'));
    renderDashGrid();
    anPaintSelection();
    anRenderKpiProps(card);
  }));
}
