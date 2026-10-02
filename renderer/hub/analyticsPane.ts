// The builder's ANALYTICS section — reference lines, bands, targets, trend
// lines, moving averages, forecasts, annotations and highlights, each with an
// inline editor. RENDERER ONLY. Classic global-scope <script>: no import/export.
//
// This file edits DEFINITIONS (`vizAnalytics`, saved as `Visual.analytics`) and
// shows the READOUTS main sends back on `data.analytics` — "Average 12.3K",
// "+1.2K per month · R² 0.82", a forecast's last period and its 80% range, or
// why an overlay could not be drawn. It computes nothing: every edit schedules
// the ordinary recompute (vizBuilder.js), and main resolves the figures.
//
// Two gestures arrive from the chart itself (chartAnnotations.js): dragging a
// constant reference / target line (`anpOverlayDragged`) and ⌥-clicking a mark
// (`anpAnnotateAt`). Loads after chartAnnotations.js and vizBuilder.js.

/** The overlays of the visual being built — saved with it. */
let vizAnalytics: any[] = [];
/** The last `data.analytics` main resolved, by overlay id. */
let anpResolved: Map<string, any> = new Map();
/** The last chart data's labels and series names, for the pickers. */
let anpLabels: string[] = [];
let anpSeries: string[] = [];
/** Which row's editor is open. */
let anpOpenId = '';

const ANP_KINDS: Array<{ kind: string; label: string; icon: string; hint: string }> = [
  { kind: 'reference', label: t('analyticsPane.reference_line'), icon: 'minus', hint: t('analyticsPane.a_line_at_a_value_a') },
  { kind: 'band', label: t('analyticsPane.band'), icon: 'columns', hint: t('analyticsPane.shade_between_two_values_or_mean') },
  { kind: 'target', label: t('common.target'), icon: 'target', hint: t('analyticsPane.a_goal_line_with_attainment') },
  { kind: 'trend', label: t('analyticsPane.trend_line'), icon: 'trending-up', hint: t('analyticsPane.least_squares_line_with_its_slope') },
  { kind: 'moving_average', label: t('common.moving_average'), icon: 'chart-line', hint: t('analyticsPane.trailing_average_over_n_points') },
  { kind: 'forecast', label: t('analyticsPane.forecast'), icon: 'chart-area', hint: t('analyticsPane.linear_seasonal_naive_or_holt_winters') },
  { kind: 'annotation', label: t('analyticsPane.annotation'), icon: 'pencil', hint: t('analyticsPane.a_note_pinned_to_a_category') },
  { kind: 'highlight', label: t('analyticsPane.highlight'), icon: 'star', hint: t('analyticsPane.outline_the_top_bottom_or_points') },
];

const ANP_SOURCES: Array<{ value: string; label: string }> = [
  { value: 'constant', label: t('analyticsPane.constant') }, { value: 'avg', label: 'Average' }, { value: 'median', label: t('common.median') },
  { value: 'min', label: t('common.minimum') }, { value: 'max', label: t('common.maximum') }, { value: 'percentile', label: t('common.percentile') },
  { value: 'metric', label: t('common.metric_2') },
];

function anpKindInfo(kind: string): { kind: string; label: string; icon: string; hint: string } {
  return ANP_KINDS.find((k) => k.kind === kind) || ANP_KINDS[0];
}

/** The overlay kinds the current chart type draws (chartTypeSpec.js). */
function anpAccepted(): string[] {
  const type = vizCurrentChartType || 'column';
  return typeof resolveChartType === 'function' ? resolveChartType(type).overlayKinds || [] : [];
}

function anpNewId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : 'ov-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── mount + state in ────────────────────────────────────────────────────────

function anpHost(): HTMLElement | null {
  return document.getElementById('viz-analytics-mount');
}

/** Replace the overlay list — a new visual (none), a reopened one, a version preview. */
function anpSetOverlays(list: any[]): void {
  vizAnalytics = Array.isArray(list) ? list.map((o) => JSON.parse(JSON.stringify(o))) : [];
  anpResolved = new Map();
  anpOpenId = '';
  anpRender();
}

/** A recompute landed: keep its readouts and the axis it drew. */
function anpApplyResolved(data: any): void {
  anpResolved = new Map();
  for (const r of (data && Array.isArray(data.analytics) ? data.analytics : [])) anpResolved.set(String(r.id), r);
  anpLabels = (data && Array.isArray(data.labels) ? data.labels : []).map(String);
  anpSeries = (data && Array.isArray(data.series) ? data.series : [])
    .filter((s: any) => s && s.role !== 'overlay').map((s: any, i: number) => String(s.name || t('common.series_2', { p0: i + 1 })));
  anpRender();
}

/** The chart type changed: which kinds it draws changed with it. */
function anpSetChartType(_type: string): void {
  anpRender();
}

function anpChanged(): void {
  anpRender();
  if (typeof scheduleRecompute === 'function') scheduleRecompute();
}

// ── gestures from the chart (chartAnnotations.js) ────────────────────────────

/** A reference / target line was dragged to `value` — it becomes that constant. */
function anpOverlayDragged(id: string, value: number): void {
  const ov = vizAnalytics.find((o) => o.id === id);
  if (!ov || !Number.isFinite(value)) return;
  ov.value = { type: 'constant', value };
  anpChanged();
}

/** ⌥-click on a mark: pin a note to that category. */
async function anpAnnotateAt(label: string, seriesIndex: number): Promise<void> {
  const text = await promptModal(t('analyticsPane.annotate', { label }), '', t('analyticsPane.add_note'));
  if (text === null || !text.trim()) return;
  const ov: any = { id: anpNewId(), kind: 'annotation', at: label, text: text.trim() };
  if (seriesIndex > 0 && seriesIndex < anpSeries.length) ov.series = seriesIndex;
  vizAnalytics.push(ov);
  anpOpenId = ov.id;
  anpChanged();
}

// ── adding ───────────────────────────────────────────────────────────────────

function anpDefaults(kind: string): any {
  const ov: any = { id: anpNewId(), kind };
  if (kind === 'reference') ov.value = { type: 'stat', stat: 'avg' };
  if (kind === 'target') ov.value = { type: 'constant', value: anpSuggestTarget() };
  if (kind === 'band') ov.sd = 1;
  if (kind === 'moving_average') ov.window = 3;
  if (kind === 'forecast') { ov.method = 'linear'; ov.horizon = 3; ov.season = 'auto'; }
  if (kind === 'annotation') { ov.at = anpLabels[anpLabels.length - 1] || ''; ov.text = t('common.note'); }
  if (kind === 'highlight') { ov.rule = 'top'; ov.n = 3; }
  return ov;
}

/** A round number just above the current series' maximum — somewhere visible to start from. */
function anpSuggestTarget(): number {
  const area = document.getElementById('viz-area');
  const chart = area ? chartInstances.get(area) : null;
  const vals: number[] = [];
  try {
    (chart && chart.data && chart.data.datasets && chart.data.datasets[0] ? chart.data.datasets[0].data : [])
      .forEach((v: any) => { if (typeof v === 'number') vals.push(v); });
  } catch (_) { /* no chart yet */ }
  if (!vals.length) return 100;
  const max = Math.max(...vals);
  const step = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.abs(max) || 1)) - 1));
  return Math.ceil((max * 1.1) / step) * step;
}

function anpOpenAddMenu(anchor: HTMLElement): void {
  document.querySelectorAll('.anp-menu').forEach((m) => m.remove());
  const accepted = anpAccepted();
  const menu = document.createElement('div');
  menu.className = 'anp-menu';
  menu.setAttribute('role', 'menu');
  for (const k of ANP_KINDS) {
    const ok = accepted.indexOf(k.kind) >= 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'anp-menu-item';
    b.setAttribute('role', 'menuitem');
    b.disabled = !ok;
    b.appendChild(icon(k.icon));
    const text = document.createElement('span');
    text.className = 'anp-menu-text';
    const name = document.createElement('span');
    name.className = 'anp-menu-name';
    name.textContent = k.label;
    const hint = document.createElement('span');
    hint.className = 'anp-menu-hint';
    hint.textContent = ok ? k.hint : t('analyticsPane.not_drawn_on', { p0: VIZ_LABELS[vizCurrentChartType] || t('analyticsPane.this_chart') });
    text.append(name, hint);
    b.appendChild(text);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      const ov = anpDefaults(k.kind);
      vizAnalytics.push(ov);
      anpOpenId = ov.id;
      anpChanged();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)) + 'px';
  const first = menu.querySelector('button:not([disabled])') as HTMLButtonElement | null;
  if (first) first.focus();
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
    if (e.type === 'click' && menu.contains(e.target as Node)) return;
    menu.remove();
    document.removeEventListener('click', close, true);
    document.removeEventListener('keydown', close, true);
  };
  setTimeout(() => {
    document.addEventListener('click', close, true);
    document.addEventListener('keydown', close, true);
  }, 0);
}

// ── the list ─────────────────────────────────────────────────────────────────

function anpRender(): void {
  const host = anpHost();
  if (!host) return;
  host.textContent = '';
  host.className = 'anp';
  const head = document.createElement('div');
  head.className = 'anp-head';
  const title = document.createElement('span');
  title.className = 'viz-field-label anp-title';
  title.textContent = t('analyticsPane.analytics');
  const count = document.createElement('span');
  count.className = 'anp-count';
  count.textContent = vizAnalytics.length ? String(vizAnalytics.length) : '';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm anp-add';
  add.setAttribute('aria-haspopup', 'menu');
  add.append(icon('plus'), Object.assign(document.createElement('span'), { textContent: t('common.add') }));
  add.addEventListener('click', (e) => { e.stopPropagation(); anpOpenAddMenu(add); });
  head.append(title, count, add);
  host.appendChild(head);

  if (!vizAnalytics.length) {
    const empty = document.createElement('p');
    empty.className = 'anp-empty';
    empty.textContent = t('analyticsPane.lay_a_reference_line_target_trend');
    host.appendChild(empty);
    return;
  }
  const accepted = anpAccepted();
  const list = document.createElement('div');
  list.className = 'anp-list';
  for (const ov of vizAnalytics) list.appendChild(anpRow(ov, accepted));
  host.appendChild(list);
}

function anpRow(ov: any, accepted: string[]): HTMLElement {
  const info = anpKindInfo(ov.kind);
  const res = anpResolved.get(ov.id);
  const row = document.createElement('div');
  row.className = 'anp-row' + (ov.hidden ? ' is-hidden' : '') + (anpOpenId === ov.id ? ' is-open' : '');
  row.dataset.overlayId = ov.id;
  row.dataset.kind = ov.kind;

  const bar = document.createElement('div');
  bar.className = 'anp-row-bar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'anp-row-main';
  toggle.setAttribute('aria-expanded', String(anpOpenId === ov.id));
  const glyph = document.createElement('span');
  glyph.className = 'anp-glyph anp-glyph--' + ov.kind;
  if (ov.color) glyph.style.color = ov.color;
  glyph.appendChild(icon(info.icon));
  const text = document.createElement('span');
  text.className = 'anp-row-text';
  const name = document.createElement('span');
  name.className = 'anp-row-name';
  name.textContent = ov.label || (res && res.label) || info.label;
  const read = document.createElement('span');
  read.className = 'anp-row-read';
  const drawn = accepted.indexOf(ov.kind) >= 0;
  if (!drawn) { read.textContent = t('analyticsPane.not_drawn_on', { p0: VIZ_LABELS[vizCurrentChartType] || t('analyticsPane.this_chart') }); read.classList.add('is-warn'); }
  else if (ov.hidden) read.textContent = t('analyticsPane.hidden');
  else if (res && res.warning) { read.textContent = res.warning; read.classList.add('is-warn'); }
  else read.textContent = res ? res.text : t('common.computing');
  text.append(name, read);
  toggle.append(glyph, text);
  toggle.addEventListener('click', () => { anpOpenId = anpOpenId === ov.id ? '' : ov.id; anpRender(); });

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'anp-icon-btn';
  iconOnly(eye, ov.hidden ? 'eye-off' : 'eye', ov.hidden ? t('analyticsPane.show_overlay') : t('analyticsPane.hide_overlay'));
  eye.addEventListener('click', () => { if (ov.hidden) delete ov.hidden; else ov.hidden = true; anpChanged(); });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'anp-icon-btn';
  iconOnly(del, 'x', t('analyticsPane.remove_overlay'));
  del.addEventListener('click', () => { vizAnalytics = vizAnalytics.filter((o) => o !== ov); anpChanged(); });
  bar.append(toggle, eye, del);
  row.appendChild(bar);
  if (anpOpenId === ov.id) row.appendChild(anpEditor(ov, res));
  return row;
}
