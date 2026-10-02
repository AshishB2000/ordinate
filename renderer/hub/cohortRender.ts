// The cohort and event-funnel visuals — DOM, over what MAIN computed.
//
// `data.cohort` (analysis/cohortData.CohortGrid) and `data.eventFunnel`
// (analysis/funnelEvents.EventFunnel) arrive complete: every percentage,
// running sum, average and median is app-computed. This file lays them out,
// FORMATS them, and derives nothing but the 0..1 position a colour ramp needs.
//
// A cohort is a heatmap <table> (sticky header and label columns, cells shaded
// on a sequential ramp mixed from the theme's --surface and --accent, text in
// whichever of --text / black / white reads at AA on that exact shade) or a
// Chart.js retention curve — the `{labels, series}` main sends IS that curve.
// A funnel is a DOM list of steps (bars, counts, both rates, median gap) plus a
// breakdown table. Both carry their own Export CSV, through the Share policy.
//
// Loads after chartPalette.js (getCSSVar) and before renderResult.js, which
// dispatches the `cohort` / `event_funnel` chart types here. Classic global
// script — NO import/export. textContent only: every label is user data.

/** `cohortData.CohortGrid`, as it arrives over IPC. */
interface CohortGridShape {
  grain: string; show: 'retention' | 'value'; curve: boolean;
  cohorts: string[]; sizes: number[]; cells: (number | null)[][]; average: (number | null)[];
  periods: number; periodNoun: string; excluded: number; valueName: string; truncated: boolean; needs: string;
}

/** `funnelEvents.EventFunnel`, as it arrives over IPC. */
interface EventFunnelShape {
  steps: string[]; counts: number[]; pctOfFirst: (number | null)[]; pctOfPrev: (number | null)[];
  medianMs: (number | null)[]; window: { n: number; unit: string };
  breakdown: { column: string; groups: Array<{ label: string; counts: number[]; pctOfFirst: (number | null)[] }>; truncated: boolean } | null;
  excluded: number; needs: string;
}

const ENGINE_TYPES = new Set(['cohort', 'event_funnel']);

function engEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

const engPct = (v: number | null | undefined): string => (v == null ? '' : `${Math.round(v * 10) / 10}%`);
const engNum = (v: number | null | undefined): string => (v == null ? '' : _fmtVal(v));

function engDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const r = (v: number): string => String(Math.round(v * 10) / 10);
  if (ms < 60_000) return `${r(ms / 1000)} s`;
  if (ms < 3_600_000) return `${r(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${r(ms / 3_600_000)} h`;
  return `${r(ms / 86_400_000)} d`;
}

function engWindow(w: { n: number; unit: string }): string {
  const one = w.unit === 'hours' ? 'hour' : 'day';
  return `${w.n} ${w.n === 1 ? one : one + 's'}`;
}

/** The empty state a half-built cohort / funnel shows: a glyph, what is missing, what it will draw. */
function engEmpty(container: HTMLElement, type: string, needs: string): void {
  const box = engEl('div', 'eng-empty');
  const glyph = engEl('div', 'eng-empty-glyph');
  glyph.innerHTML = VIZ_ICONS[type] || ''; // trusted static SVG (renderResult.ts), never user input
  box.appendChild(glyph);
  box.appendChild(engEl('p', 'eng-empty-title', needs || (type === 'cohort'
    ? t('cohortRender.build_a_cohort_from_a_dataset') : t('cohortRender.build_an_event_funnel_from_a'))));
  box.appendChild(engEl('p', 'eng-empty-hint', type === 'cohort'
    ? t('cohortRender.members_are_grouped_by_the_period')
    : t('cohortRender.entities_move_through_the_steps_in')));
  container.appendChild(box);
}

/** Dispatched from renderResult.renderChartJsInArea for the two engine types. */
function renderEngineViz(container: HTMLElement, data: any, type: string, source?: any): void {
  container.innerHTML = '';
  if (type === 'cohort') {
    const g: CohortGridShape | null = data && data.cohort;
    if (!g || g.needs || !g.cohorts.length) { engEmpty(container, type, g ? g.needs || t('cohortRender.no_events_to_group_yet') : ''); return; }
    renderCohortView(container, g, data, source);
    return;
  }
  const f: EventFunnelShape | null = data && data.eventFunnel;
  if (!f || f.needs) { engEmpty(container, type, f ? f.needs : ''); return; }
  renderFunnelView(container, f, data, source);
}

// ── Shared chrome ────────────────────────────────────────────────────────────

function engHead(meta: string, actions: HTMLElement[]): HTMLElement {
  const head = engEl('div', 'eng-head');
  head.appendChild(engEl('span', 'eng-meta', meta));
  const tools = engEl('div', 'eng-tools');
  actions.forEach((a) => tools.appendChild(a));
  head.appendChild(tools);
  return head;
}

function engCsvButton(type: string, data: any, source: any): HTMLButtonElement {
  const b = engEl('button', 'btn btn-sm eng-csv', t('common.export_csv'));
  b.type = 'button';
  b.setAttribute('aria-label', type === 'cohort' ? t('cohortRender.export_the_cohort_table_as_csv') : t('cohortRender.export_the_funnel_as_csv'));
  b.addEventListener('click', () => { void engExportCsv(type, data, source); });
  return b;
}

/** The whole table as CSV, through the Share policy (privacyShare.ts), then the native save panel. */
async function engExportCsv(type: string, data: any, source: any): Promise<void> {
  const shaped = await pvShareData(source || null, data, 'export');
  if (!shaped) return;
  const rows = engineRows(type, shaped, true);
  if (!rows) return;
  const cell = (s: string): string => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const name = type === 'cohort' ? 'cohort-retention.csv' : 'event-funnel.csv';
  try { await window.hub.saveCsv(rows.map((r) => r.map(cell).join(',')).join('\r\n'), name); } catch (_) { /* the panel reports its own failure */ }
}

/**
 * The visual as rows of text, header row first — for CSV (`raw`: full-precision
 * figures) and for a report page (formatted as on screen). null for any other
 * type, or when there is nothing to tabulate.
 */
function engineRows(type: string, data: any, raw: boolean): string[][] | null {
  if (type === 'cohort') {
    const g: CohortGridShape | null = data && data.cohort;
    if (!g || g.needs || !g.cohorts.length) return null;
    const fmt = (v: number | null): string => (v == null ? '' : raw ? String(v) : g.show === 'value' ? engNum(v) : engPct(v));
    const head = [t('common.cohort'), t('cohortRender.members')];
    for (let k = 0; k < g.periods; k += 1) head.push(`${g.periodNoun} ${k}`);
    const out = [head];
    g.cohorts.forEach((c, i) => out.push([c, String(g.sizes[i])].concat(g.cells[i].map(fmt))));
    out.push(['Average', String(g.sizes.reduce((a, b) => a + b, 0))].concat(g.average.map(fmt)));
    return out;
  }
  if (type === 'event_funnel') {
    const f: EventFunnelShape | null = data && data.eventFunnel;
    if (!f || f.needs) return null;
    const pct = (v: number | null): string => (v == null ? '' : raw ? String(v) : engPct(v));
    const out = [[t('common.step'), t('cohortRender.entities'), t('cohortRender.of_first_step'), t('cohortRender.of_previous_step'), t('cohortRender.median_time_from_previous')]];
    f.steps.forEach((s, k) => out.push([s, String(f.counts[k]), pct(f.pctOfFirst[k]), k ? pct(f.pctOfPrev[k]) : '',
      k ? (raw ? (f.medianMs[k] == null ? '' : String(f.medianMs[k])) : engDuration(f.medianMs[k])) : '']));
    if (raw && f.breakdown) {
      out.push([]);
      out.push([f.breakdown.column].concat(f.steps));
      f.breakdown.groups.forEach((grp) => out.push([grp.label].concat(grp.counts.map(String))));
    }
    return out;
  }
  return null;
}

/** A report page's typeset table for an engine visual, or null (reportRender.ts). */
function engineReportGrid(type: string, data: any, maxRows: number): { head: string[][]; body: string[][] } | null {
  if (!ENGINE_TYPES.has(type)) return null;
  const rows = engineRows(type, data, false);
  if (!rows || rows.length - 1 > maxRows) return null;
  return { head: rows.slice(0, 1), body: rows.slice(1) };
}

// ── Colour: a sequential ramp mixed from theme tokens, text picked for AA ────

function engRgb(css: string): [number, number, number] | null {
  const s = String(css || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function engLum(c: [number, number, number]): number {
  const ch = (v: number): number => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}
const engContrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

interface EngRamp { base: [number, number, number]; ink: [number, number, number]; text: [number, number, number] | null }

function engRamp(host: HTMLElement): EngRamp | null {
  const base = engRgb(getCSSVar('--surface', host));
  const ink = engRgb(getCSSVar('--accent', host));
  return base && ink ? { base, ink, text: engRgb(getCSSVar('--text', host)) } : null;
}

/** Shade a cell at `t` ∈ [0, 1]: background from the ramp, text colour for AA contrast. */
function engShade(td: HTMLElement, t: number, ramp: EngRamp): void {
  const w = 0.08 + 0.72 * Math.max(0, Math.min(1, t));
  const bg = ramp.base.map((b, i) => Math.round(b + (ramp.ink[i] - b) * w)) as [number, number, number];
  td.style.backgroundColor = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
  const L = engLum(bg);
  if (ramp.text && engContrast(L, engLum(ramp.text)) >= 4.5) return; // the theme's own text reads here
  td.style.color = engContrast(L, 0) >= engContrast(L, 1) ? '#000' : '#fff';
}

// ── The cohort ───────────────────────────────────────────────────────────────

function renderCohortView(container: HTMLElement, g: CohortGridShape, data: any, source: any): void {
  const wrap = engEl('div', 'eng-wrap ch-wrap');
  let curve = !!g.curve;
  const body = engEl('div', 'ch-body');
  const seg = engEl('div', 'eng-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('cohortRender.cohort_view'));
  const views: Array<[string, boolean]> = [[t('common.table'), false], [t('common.retention_curve'), true]];
  const btns = views.map(([label, isCurve]) => {
    const b = engEl('button', 'eng-seg-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => { curve = isCurve; draw(); });
    seg.appendChild(b);
    return b;
  });
  const members = g.sizes.reduce((a, b) => a + b, 0);
  const meta = t('cohortRender.members_by', { cohortsCount: g.cohorts.length, members: _fmtVal(members), p3: g.show === 'value' ? g.valueName : 'retention', p4: g.periodNoun.toLowerCase() });
  wrap.appendChild(engHead(meta, [seg, engCsvButton('cohort', data, source)]));
  const notes: string[] = [];
  if (g.truncated) notes.push(t('cohortRender.showing_the_latest_cohorts_and_first', { cohortsCount: g.cohorts.length, periods: g.periods, p2: g.periodNoun.toLowerCase() }));
  if (g.excluded) notes.push(t('cohortRender.without_an_entity_or_a_readable', { excluded: _fmtVal(g.excluded), excluded2: g.excluded }));
  if (notes.length) wrap.appendChild(engEl('p', 'eng-note', notes.join(' ')));
  wrap.appendChild(body);
  container.appendChild(wrap);

  function draw(): void {
    btns.forEach((b, i) => { const on = views[i][1] === curve; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
    const old = chartInstances.get(container);
    if (old) { try { old.destroy(); } catch (_) { /* already gone */ } chartInstances.delete(container); }
    body.innerHTML = '';
    if (curve) cohortCurve(body, container, data, g);
    else cohortTable(body, g);
  }
  draw();
}

function cohortTable(host: HTMLElement, g: CohortGridShape): void {
  const scroll = engEl('div', 'ch-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', t('cohortRender.cohort_table'));
  const table = engEl('table', 'ch-table');
  const thead = engEl('thead');
  const hr = engEl('tr');
  [[t('common.cohort'), 'ch-corner ch-label'], [t('cohortRender.members'), 'ch-corner ch-size']].forEach(([t, c]) => {
    const th = engEl('th', c, t);
    th.scope = 'col';
    hr.appendChild(th);
  });
  for (let k = 0; k < g.periods; k += 1) {
    const th = engEl('th', 'ch-col', `${g.periodNoun} ${k}`);
    th.scope = 'col';
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  // The ramp's top: retention scales over k ≥ 1 (k = 0 is 100% by definition
  // and would flatten everything else); a value scales over every cell.
  let max = 0;
  g.cells.forEach((row) => row.forEach((v, k) => { if (v != null && (g.show === 'value' || k > 0) && v > max) max = v; }));
  const ramp = engRamp(host.isConnected ? host : document.body);
  const text = (v: number): string => (g.show === 'value' ? engNum(v) : engPct(v));

  const tbody = engEl('tbody');
  g.cohorts.forEach((label, i) => {
    const tr = engEl('tr', 'ch-row');
    const th = engEl('th', 'ch-label', label);
    th.scope = 'row';
    tr.appendChild(th);
    tr.appendChild(engEl('td', 'ch-size', _fmtVal(g.sizes[i])));
    g.cells[i].forEach((v, k) => {
      const td = engEl('td', 'ch-cell');
      if (v == null) { td.classList.add('is-blank'); tr.appendChild(td); return; }
      td.textContent = text(v);
      td.title = t('cohortRender.cohort_members', { label, p1: _fmtVal(g.sizes[i]), periodNoun: g.periodNoun, k, v: text(v) });
      if (k === 0 && g.show !== 'value') td.classList.add('is-base');
      else if (ramp && max > 0) engShade(td, v / max, ramp);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const tfoot = engEl('tfoot');
  const fr = engEl('tr', 'ch-avg');
  const fth = engEl('th', 'ch-label', 'Average');
  fth.scope = 'row';
  fth.title = t('cohortRender.weighted_by_cohort_size_over_the');
  fr.appendChild(fth);
  fr.appendChild(engEl('td', 'ch-size', _fmtVal(g.sizes.reduce((a, b) => a + b, 0))));
  g.average.forEach((v) => fr.appendChild(engEl('td', 'ch-cell', v == null ? '' : text(v))));
  tfoot.appendChild(fr);
  table.appendChild(tfoot);
  scroll.appendChild(table);
  host.appendChild(scroll);
}

/** One line per cohort plus the average, bold — main's `{labels, series}` as drawn. */
function cohortCurve(host: HTMLElement, container: HTMLElement, data: any, g: CohortGridShape): void {
  const wrap = engEl('div', 'cv-canvas-wrap ch-curve');
  const canvas = engEl('canvas');
  canvas.setAttribute('aria-label', t('cohortRender.retention_curve_cohorts_and_their', { cohortsCount: g.cohorts.length }));
  wrap.appendChild(canvas);
  host.appendChild(wrap);
  const chart = buildChart(canvas, { labels: data.labels, series: data.series }, 'line', {
    valueMode: 'off', showLegend: g.cohorts.length <= 12, noAnimate: true, smooth: false,
    numberFormat: g.show === 'value' ? undefined : 'plain',
    yAxisLabel: g.show === 'value' ? g.valueName : t('cohortRender.retained'), xAxisLabel: t('cohortRender.s_since_first_event', { periodNoun: g.periodNoun }),
  });
  if (!chart) { wrap.remove(); engEmpty(host, 'cohort', t('cohortRender.nothing_to_draw_yet')); return; }
  const strong = getCSSVar('--text-strong', host) || getCSSVar('--text', host);
  (chart.data.datasets || []).forEach((ds: any) => {
    const avg = ds.label === 'Average';
    ds.borderWidth = avg ? 3.5 : 1.25;
    ds.pointRadius = avg ? 2.5 : 0;
    ds.order = avg ? 0 : 1; // drawn last, on top
    if (avg && strong) { ds.borderColor = strong; ds.backgroundColor = strong; }
  });
  chart.update('none');
  chartInstances.set(container, chart);
}

/** A mini triangle for the Visuals gallery card (vizThumbs.ts). False = keep the glyph. */
function drawCohortThumb(canvas: HTMLCanvasElement, g: CohortGridShape): boolean {
  if (!g || g.needs || !g.cohorts.length || !g.periods) return false;
  const host = canvas.parentElement || document.body;
  const w = host.clientWidth || 200;
  const h = host.clientHeight || 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  const ramp = engRamp(host);
  if (!ctx || !ramp) return false;
  ctx.scale(dpr, dpr);
  const rows = Math.min(g.cohorts.length, 24);
  const cols = Math.min(g.periods, 24);
  const cw = w / cols;
  const rh = h / rows;
  const start = g.cohorts.length - rows;
  let max = 0;
  g.cells.forEach((r) => r.forEach((v, k) => { if (v != null && (g.show === 'value' || k > 0) && v > max) max = v; }));
  for (let i = 0; i < rows; i += 1) {
    for (let k = 0; k < cols; k += 1) {
      const v = g.cells[start + i][k];
      if (v == null) continue;
      const t = k === 0 && g.show !== 'value' ? 1 : max > 0 ? v / max : 0;
      const wgt = 0.12 + 0.8 * t;
      const c = ramp.base.map((b, j) => Math.round(b + (ramp.ink[j] - b) * wgt));
      ctx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      ctx.fillRect(k * cw + 0.5, i * rh + 0.5, Math.max(1, cw - 1), Math.max(1, rh - 1));
    }
  }
  return true;
}

// ── The event funnel ─────────────────────────────────────────────────────────

function renderFunnelView(container: HTMLElement, f: EventFunnelShape, data: any, source: any): void {
  const wrap = engEl('div', 'eng-wrap ef-wrap');
  const meta = t('cohortRender.entered_strict_order_within_of_the', { p0: _fmtVal(f.counts[0] || 0), window: engWindow(f.window) });
  wrap.appendChild(engHead(meta, [engCsvButton('event_funnel', data, source)]));
  if (f.excluded) {
    wrap.appendChild(engEl('p', 'eng-note',
      t('cohortRender.without_an_entity_or_a_readable_2', { excluded: _fmtVal(f.excluded), excluded2: f.excluded })));
  }
  const scroll = engEl('div', 'ef-scroll');
  const list = engEl('ol', 'ef-steps');
  f.steps.forEach((step, k) => {
    const li = engEl('li', 'ef-step');
    const name = engEl('div', 'ef-name');
    name.appendChild(engEl('span', 'ef-idx', String(k + 1)));
    name.appendChild(engEl('span', 'ef-label', step));
    li.appendChild(name);
    const track = engEl('div', 'ef-track');
    track.setAttribute('aria-hidden', 'true');
    const bar = engEl('div', 'ef-bar');
    bar.style.width = `${Math.max(0, Math.min(100, f.pctOfFirst[k] ?? 0))}%`;
    track.appendChild(bar);
    li.appendChild(track);
    const figs = engEl('div', 'ef-figs');
    figs.appendChild(engEl('span', 'ef-count', _fmtVal(f.counts[k])));
    figs.appendChild(engEl('span', 'ef-rate', k ? t('cohortRender.of_first', { p0: engPct(f.pctOfFirst[k]) }) : 'entered'));
    if (k) figs.appendChild(engEl('span', 'ef-rate', t('cohortRender.of_previous', { p0: engPct(f.pctOfPrev[k]) })));
    if (k) figs.appendChild(engEl('span', 'ef-time', t('cohortRender.median_after_step', { p0: engDuration(f.medianMs[k]), k })));
    li.appendChild(figs);
    li.setAttribute('aria-label', t('cohortRender.step_entities', { p0: k + 1, step, p2: f.counts[k], p3: (k ? t('cohortRender.of_the_first_step_of_the', { p0: engPct(f.pctOfFirst[k]), p1: engPct(f.pctOfPrev[k]), p2: engDuration(f.medianMs[k]) }) : '') }));
    list.appendChild(li);
  });
  scroll.appendChild(list);
  if (f.breakdown && f.breakdown.groups.length) scroll.appendChild(funnelBreakdown(f));
  wrap.appendChild(scroll);
  container.appendChild(wrap);
}

function funnelBreakdown(f: EventFunnelShape): HTMLElement {
  const bd = f.breakdown!;
  const box = engEl('div', 'ef-breakdown');
  box.appendChild(engEl('h4', 'ef-bd-title', t('cohortRender.by', { column: bd.column, p1: (bd.truncated ? t('cohortRender.top', { groupsCount: bd.groups.length }) : '') })));
  const table = engEl('table', 'ef-bd-table');
  const hr = engEl('tr');
  const corner = engEl('th', 'ef-bd-label', bd.column);
  corner.scope = 'col';
  hr.appendChild(corner);
  f.steps.forEach((s, k) => { const th = engEl('th', '', `${k + 1}. ${s}`); th.scope = 'col'; hr.appendChild(th); });
  const thead = engEl('thead');
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = engEl('tbody');
  bd.groups.forEach((grp) => {
    const tr = engEl('tr');
    const th = engEl('th', 'ef-bd-label', grp.label === '' ? '(blank)' : grp.label);
    th.scope = 'row';
    tr.appendChild(th);
    grp.counts.forEach((c, k) => {
      const td = engEl('td');
      td.appendChild(engEl('span', 'ef-bd-count', _fmtVal(c)));
      if (k) td.appendChild(engEl('span', 'ef-bd-pct', engPct(grp.pctOfFirst[k])));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
  return box;
}
