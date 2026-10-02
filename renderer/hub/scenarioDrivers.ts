// A scenario's SETUP — the left side of the scenario page (scenarioPage.ts):
// the metrics it moves, as chips, and its drivers, as sliders and inputs, in
// the order they apply. "Add driver" aims a new one at a column (every row, or
// only rows where a column has a value) or at a metric; the columns offered
// are the ones the metrics actually aggregate (`scenario:targets`), so a driver
// can always move something. Every edit goes through snChanged(): the draft is
// recomputed at once and saved on a debounce. Labels come back from main.
//
// Classic global-scope script — NO import/export. textContent only.

let snMetricsAll: any[] = [];
let snTargets: any = null;
let snAddOpen = false;
const SN_ADD_DEFAULT = { mode: 'column', column: '', fcol: '', fval: '', metricId: '', kind: 'pct', value: '5' };
let snAdd = { ...SN_ADD_DEFAULT };

async function snLoadSetup(): Promise<void> {
  if (!snCurrent || !currentProjectId) return;
  const cur = snCurrent;
  try { const r = await window.hub.listMetrics(currentProjectId); snMetricsAll = r && Array.isArray(r.metrics) ? r.metrics : []; } catch (_) { snMetricsAll = []; }
  try { snTargets = await window.hubScenarios.targets(currentProjectId, cur.baseMetricIds); } catch (_) { snTargets = null; }
  if (snCurrent !== cur) return;
  snRenderMetricChips();
  snRenderDrivers();
  snRenderAdd();
}

function snMetricName(id: string): string {
  const m = snMetricsAll.find((x) => String(x.id) === id);
  return m ? String(m.name) : t('common.missing_metric');
}

// ── metrics ──────────────────────────────────────────────────────────────────

function snRenderMetricChips(): void {
  const box = snEl('sn-metric-chips');
  if (!box || !snCurrent) return;
  box.textContent = '';
  for (const id of snCurrent.baseMetricIds) {
    const chip = document.createElement('span');
    chip.className = 'sn-mchip';
    const name = document.createElement('span');
    name.className = 'sn-mchip-name';
    name.textContent = snMetricName(id);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'sn-mchip-x';
    iconOnly(x, 'x', t('scenarioDrivers.remove', { id: snMetricName(id) }), 12);
    x.addEventListener('click', () => {
      if (!snCurrent) return;
      snCurrent.baseMetricIds = snCurrent.baseMetricIds.filter((m) => m !== id);
      snChanged({ setup: true });
    });
    chip.append(name, x);
    box.appendChild(chip);
  }
  if (!snCurrent.baseMetricIds.length) {
    const p = document.createElement('p');
    p.className = 'sn-side-empty';
    p.textContent = t('scenarioDrivers.no_metrics_yet_add_the_ones');
    box.appendChild(p);
  }
}

function snAddMetricMenu(anchor: HTMLElement): void {
  if (!snCurrent) return;
  const cur = snCurrent;
  const left = snMetricsAll.filter((m) => cur.baseMetricIds.indexOf(String(m.id)) < 0);
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    if (!left.length || cur.baseMetricIds.length >= 12) {
      const p = document.createElement('div');
      p.className = 'sn-menu-note';
      p.textContent = left.length ? t('scenarioDrivers.twelve_metrics_is_the_most_a') : t('scenarioDrivers.every_metric_in_this_project_is');
      menu.appendChild(p);
      return;
    }
    for (const m of left) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-menu-item';
      b.textContent = String(m.name);
      b.addEventListener('click', () => {
        close();
        cur.baseMetricIds.push(String(m.id));
        snChanged({ setup: true });
      });
      menu.appendChild(b);
    }
  });
}

// ── drivers ──────────────────────────────────────────────────────────────────

/** Main's word for driver i — only while the computed result still describes that driver. */
function snDriverInfo(i: number): any {
  const d = snCurrent ? snCurrent.drivers[i] : null;
  const info = snResult && Array.isArray(snResult.drivers) ? snResult.drivers[i] : null;
  if (!d || !info || info.kind !== d.kind || JSON.stringify(info.target) !== JSON.stringify(d.target)) return null;
  return info;
}

function snRenderDrivers(): void {
  const box = snEl('sn-drivers');
  if (!box || !snCurrent) return;
  const drivers = snCurrent.drivers;
  const count = snEl('sn-driver-count');
  if (count) count.textContent = drivers.length ? String(drivers.length) : '';
  if (!drivers.length) {
    box.textContent = '';
    box.appendChild(snDriversEmpty());
    return;
  }
  let rows = [...box.querySelectorAll<HTMLElement>('.sn-drv')];
  // Rebuilt only when the SHAPE changes — a slider replaced mid-drag stops dragging.
  if (rows.length !== drivers.length || drivers.some((d, i) => rows[i].dataset.kind !== d.kind)) {
    box.textContent = '';
    rows = drivers.map((d, i) => snDriverRow(d, i));
    rows.forEach((r) => box.appendChild(r));
  }
  drivers.forEach((d, i) => snSyncDriverRow(rows[i], d, i));
}

function snDriverRow(d: any, i: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sn-drv';
  row.dataset.kind = d.kind;
  const head = document.createElement('div');
  head.className = 'sn-drv-head';
  const n = document.createElement('span');
  n.className = 'sn-drv-n';
  n.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'sn-drv-label';
  const acts = document.createElement('span');
  acts.className = 'sn-drv-acts';
  const btn = (ic: string, aria: string, run: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn icon-btn-sm';
    iconOnly(b, ic, aria, 14);
    b.addEventListener('click', () => { if (snCurrent) run(); });
    acts.appendChild(b);
    return b;
  };
  const move = (by: number): void => {
    const list = snCurrent!.drivers;
    const at = Number(row.dataset.index);
    const to = at + by;
    if (to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];
    snChanged();
  };
  btn('chevron-up', t('scenarioDrivers.apply_driver_earlier', { p0: i + 1 }), () => move(-1)).classList.add('sn-drv-up');
  btn('chevron-down', t('scenarioDrivers.apply_driver_later', { p0: i + 1 }), () => move(1)).classList.add('sn-drv-down');
  btn('trash', t('scenarioDrivers.remove_driver', { p0: i + 1 }), () => {
    snCurrent!.drivers.splice(Number(row.dataset.index), 1);
    snChanged();
  });
  head.append(n, label, acts);

  const target = document.createElement('div');
  target.className = 'sn-drv-target';

  const ctl = document.createElement('div');
  ctl.className = 'sn-drv-ctl';
  const kind = document.createElement('select');
  kind.className = 'sn-drv-kind';
  kind.setAttribute('aria-label', t('scenarioDrivers.driver_change_by_a_percent_or', { p0: i + 1 }));
  for (const [v, tv] of [['pct', t('scenarioDrivers.change_by')], ['abs', t('scenarioDrivers.set_to')]]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = tv;
    kind.appendChild(o);
  }
  kind.value = d.kind;
  kind.addEventListener('change', () => {
    const cur = snCurrent!.drivers[Number(row.dataset.index)];
    cur.kind = kind.value;
    cur.value = kind.value === 'pct' ? 5 : 0;
    snChanged();
  });
  ctl.appendChild(kind);
  const num = document.createElement('input');
  num.type = 'number';
  num.step = 'any';
  num.className = 'sn-drv-num tnum';
  num.setAttribute('aria-label', d.kind === 'pct' ? t('scenarioDrivers.driver_percent_change', { p0: i + 1 }) : t('scenarioDrivers.driver_value', { p0: i + 1 }));
  if (d.kind === 'pct') {
    const range = document.createElement('input');
    range.type = 'range';
    range.step = '0.5';
    range.className = 'sn-drv-range';
    range.setAttribute('aria-label', t('scenarioDrivers.driver_percent_change_slider', { p0: i + 1 }));
    range.addEventListener('input', () => {
      snCurrent!.drivers[Number(row.dataset.index)].value = Number(range.value);
      num.value = range.value;
      snChanged();
    });
    ctl.appendChild(range);
  }
  num.addEventListener('input', () => {
    const v = Number(num.value);
    if (num.value.trim() === '' || !Number.isFinite(v)) return;
    const cur = snCurrent!.drivers[Number(row.dataset.index)];
    cur.value = cur.kind === 'pct' ? Math.max(-100, v) : v;
    snChanged();
  });
  ctl.appendChild(num);
  const unit = document.createElement('span');
  unit.className = 'sn-drv-unit';
  unit.textContent = d.kind === 'pct' ? '%' : '';
  unit.setAttribute('aria-hidden', 'true');
  ctl.appendChild(unit);

  const foot = document.createElement('div');
  foot.className = 'sn-drv-foot';
  const pl = document.createElement('label');
  pl.className = 'sn-drv-param';
  const pt = document.createElement('span');
  pt.textContent = t('scenarioDrivers.on_a_dashboard_follow_parameter');
  const param = document.createElement('input');
  param.type = 'text';
  param.className = 'sn-drv-param-in';
  param.placeholder = 'none';
  param.spellcheck = false;
  param.setAttribute('aria-label', t('scenarioDrivers.driver_dashboard_number_parameter_it', { p0: i + 1 }));
  param.addEventListener('change', () => {
    const cur = snCurrent!.drivers[Number(row.dataset.index)];
    const v = param.value.trim();
    if (v) cur.param = v; else delete cur.param;
    snChanged();
  });
  pl.append(pt, param);
  const hint = document.createElement('span');
  hint.className = 'sn-drv-hint';
  hint.append(icon('alert', 12), document.createTextNode(t('scenarioDrivers.changes_none_of_these_metrics')));
  foot.append(pl, hint);

  row.append(head, target, ctl, foot);
  return row;
}

/** Put driver `d`'s current state into its row, leaving alone whatever has focus. */
function snSyncDriverRow(row: HTMLElement, d: any, i: number): void {
  row.dataset.index = String(i);
  const info = snDriverInfo(i);
  const set = (sel: string, text: string): void => { const el = row.querySelector(sel); if (el) el.textContent = text; };
  set('.sn-drv-n', String(i + 1));
  set('.sn-drv-label', info ? info.label : d.name || t('scenarioDrivers.new_driver'));
  set('.sn-drv-target', info ? info.targetText : '');
  const up = row.querySelector<HTMLButtonElement>('.sn-drv-up');
  if (up) up.disabled = i === 0;
  const down = row.querySelector<HTMLButtonElement>('.sn-drv-down');
  if (down) down.disabled = i === snCurrent!.drivers.length - 1;
  const hint = row.querySelector<HTMLElement>('.sn-drv-hint');
  if (hint) hint.hidden = !info || info.applied;
  const active = document.activeElement;
  const range = row.querySelector<HTMLInputElement>('.sn-drv-range');
  if (range && range !== active) {
    range.min = String(Math.max(-100, Math.min(-50, Math.floor(d.value))));
    range.max = String(Math.max(50, Math.ceil(d.value)));
    range.value = String(d.value);
  }
  const num = row.querySelector<HTMLInputElement>('.sn-drv-num');
  if (num && num !== active) num.value = String(d.value);
  const param = row.querySelector<HTMLInputElement>('.sn-drv-param-in');
  if (param && param !== active) param.value = d.param || '';
}

/** No drivers: say what one is, and offer two that fit these metrics. */
function snDriversEmpty(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'sn-drivers-empty';
  const h = document.createElement('p');
  h.className = 'sn-drivers-empty-h';
  h.textContent = t('scenarioDrivers.no_drivers_yet_every_figure_is');
  const p = document.createElement('p');
  p.textContent = t('scenarioDrivers.a_driver_moves_one_input_a');
  box.append(h, p);
  const ideas: Array<{ text: string; driver: any }> = [];
  const cols = snTargets && Array.isArray(snTargets.columns) ? snTargets.columns : [];
  if (cols[0]) ideas.push({ text: cols[0].column + ' +5%', driver: { kind: 'pct', value: 5, target: { column: cols[0].column } } });
  if (cols[1]) ideas.push({ text: cols[1].column + ' −3%', driver: { kind: 'pct', value: -3, target: { column: cols[1].column } } });
  const ms = snTargets && Array.isArray(snTargets.metrics) ? snTargets.metrics : [];
  if (ms[0]) ideas.push({ text: ms[0].name + ' −10%', driver: { kind: 'pct', value: -10, target: { metricId: ms[0].id } } });
  if (ideas.length) {
    const row = document.createElement('div');
    row.className = 'sn-ideas';
    for (const idea of ideas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-empty-chip sn-idea';
      b.textContent = idea.text;
      b.setAttribute('aria-label', t('scenarioDrivers.add_the_driver', { text: idea.text }));
      b.addEventListener('click', () => {
        if (!snCurrent) return;
        snCurrent.drivers.push({ name: idea.text, ...idea.driver });
        snChanged();
      });
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  return box;
}

// ── add a driver ─────────────────────────────────────────────────────────────

function snField(label: string, control: HTMLElement): HTMLElement {
  const l = document.createElement('label');
  l.className = 'sn-field';
  const t = document.createElement('span');
  t.className = 'sn-field-label';
  t.textContent = label;
  l.append(t, control);
  return l;
}

function snSelect(aria: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'sn-input';
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

function snRenderAdd(): void {
  const host = snEl('sn-add');
  if (!host || !snCurrent) return;
  host.textContent = '';
  if (!snAddOpen) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sn-add-btn';
    b.id = 'sn-add-open';
    b.append(icon('plus', 14), document.createTextNode(t('scenarioDrivers.add_driver')));
    b.addEventListener('click', () => { snAddOpen = true; snAdd = { ...SN_ADD_DEFAULT }; snRenderAdd(); });
    host.appendChild(b);
    return;
  }
  const cols: any[] = snTargets && Array.isArray(snTargets.columns) ? snTargets.columns : [];
  const ms: any[] = snTargets && Array.isArray(snTargets.metrics) ? snTargets.metrics : [];
  if (!snAdd.column && cols[0]) snAdd.column = cols[0].datasetId + '|' + cols[0].column;
  if (!snAdd.metricId && ms[0]) snAdd.metricId = ms[0].id;
  const form = document.createElement('div');
  form.className = 'sn-add-form';
  form.setAttribute('role', 'group');
  form.setAttribute('aria-label', t('scenarioDrivers.new_driver'));

  const seg = document.createElement('div');
  seg.className = 'sn-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('scenarioDrivers.what_the_driver_moves'));
  for (const [mode, text] of [['column', t('scenarioDrivers.a_column')], ['metric', t('scenarioDrivers.a_metric')]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sn-seg-btn';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(snAdd.mode === mode));
    b.addEventListener('click', () => { snAdd.mode = mode; snRenderAdd(); });
    seg.appendChild(b);
  }
  form.appendChild(seg);

  if (snAdd.mode === 'column') {
    if (!cols.length) {
      const p = document.createElement('p');
      p.className = 'sn-side-empty';
      p.textContent = t('scenarioDrivers.these_metrics_aggregate_no_column_a');
      form.appendChild(p);
    } else {
      form.appendChild(snField(t('common.column'), snSelect(t('scenarioDrivers.column_the_driver_moves'),
        cols.map((c) => [c.datasetId + '|' + c.column, t('scenarioDrivers.in', { column: c.column, p1: c.metrics.join(', ') })] as [string, string]),
        snAdd.column, (v) => { snAdd.column = v; snAdd.fcol = ''; snAdd.fval = ''; snRenderAdd(); })));
      const dsId = snAdd.column.split('|')[0];
      const ds = (snTargets.datasets || []).find((x: any) => x.id === dsId);
      const fcols: Array<[string, string]> = [['', t('scenarioDrivers.all_rows')]].concat(
        (ds ? ds.columns : []).filter((c: any) => c.type !== 'number').map((c: any) => [c.name, c.name] as [string, string])) as Array<[string, string]>;
      form.appendChild(snField(t('scenarioDrivers.only_rows_where'), snSelect(t('scenarioDrivers.only_rows_where_this_column'), fcols, snAdd.fcol, (v) => { snAdd.fcol = v; snAdd.fval = ''; snRenderAdd(); })));
      if (snAdd.fcol) {
        const val = snSelect(t('scenarioDrivers.has_this_value'), [['', t('common.loading')]], '', (v) => { snAdd.fval = v; });
        val.disabled = true;
        form.appendChild(snField('is', val));
        void snFillValues(val, dsId, snAdd.fcol);
      }
    }
  } else {
    form.appendChild(snField(t('common.metric'), snSelect(t('scenarioDrivers.metric_the_driver_moves'), ms.map((m) => [m.id, m.name] as [string, string]),
      snAdd.metricId, (v) => { snAdd.metricId = v; })));
  }

  const line = document.createElement('div');
  line.className = 'sn-add-line';
  line.appendChild(snField(t('common.change'), snSelect(t('scenarioDrivers.change_by_a_percent_or_set'), [['pct', t('scenarioDrivers.by')], ['abs', t('scenarioDrivers.set_to')]], snAdd.kind, (v) => {
    snAdd.kind = v;
    snAdd.value = v === 'pct' ? '5' : '0';
    snRenderAdd();
  })));
  const value = document.createElement('input');
  value.type = 'number';
  value.step = 'any';
  value.className = 'sn-input tnum';
  value.id = 'sn-add-value';
  value.value = snAdd.value;
  value.addEventListener('input', () => { snAdd.value = value.value; });
  line.appendChild(snField(snAdd.kind === 'pct' ? t('common.percent') : t('common.value'), value));
  form.appendChild(line);

  const acts = document.createElement('div');
  acts.className = 'sn-add-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm';
  cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', () => { snAddOpen = false; snRenderAdd(); });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm btn-primary';
  add.id = 'sn-add-confirm';
  add.textContent = t('scenarioDrivers.add_driver_2');
  add.addEventListener('click', () => snConfirmAdd());
  acts.append(cancel, add);
  form.appendChild(acts);
  host.appendChild(form);
}

async function snFillValues(sel: HTMLSelectElement, datasetId: string, column: string): Promise<void> {
  let values: string[] = [];
  try {
    const r = await window.hub.datasetDistinct(currentProjectId, datasetId, column, 200);
    values = r && Array.isArray(r.values) ? r.values.map((v: any) => String(v)) : [];
  } catch (_) { values = []; }
  if (!sel.isConnected) return;
  sel.textContent = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v === '' ? '(empty)' : v;
    sel.appendChild(o);
  }
  sel.disabled = values.length === 0;
  snAdd.fval = values.indexOf(snAdd.fval) >= 0 ? snAdd.fval : values[0] || '';
  sel.value = snAdd.fval;
}

function snConfirmAdd(): void {
  if (!snCurrent) return;
  const v = Number(snAdd.value);
  if (snAdd.value.trim() === '' || !Number.isFinite(v)) { showToast(t('scenarioDrivers.give_the_driver_a_number')); return; }
  let target: any;
  if (snAdd.mode === 'metric') {
    if (!snAdd.metricId) return;
    target = { metricId: snAdd.metricId };
  } else {
    const column = snAdd.column.split('|').slice(1).join('|');
    if (!column) return;
    target = { column };
    if (snAdd.fcol) target.filter = { type: 'filter', column: snAdd.fcol, op: '=', value: snAdd.fval };
  }
  snCurrent.drivers.push({ name: '', kind: snAdd.kind, value: snAdd.kind === 'pct' ? Math.max(-100, v) : v, target });
  snAddOpen = false;
  snRenderAdd();
  snChanged();
}

function initScenarioDrivers(): void {
  const add = snEl('sn-add-metric');
  if (add) add.addEventListener('click', (e) => { e.stopPropagation(); snAddMetricMenu(add); });
}
