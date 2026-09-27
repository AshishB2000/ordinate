// Editing a scorecard's ROWS — which metrics, and for each its target (a fixed
// figure, or another metric read over the same period), owner, group and
// thresholds. A modal over the scorecard page; Save writes the rows through
// `scorecard:update` (sanitised in main by analysis/scorecardModel) and the page
// recomputes. Classic global-scope script — NO import/export. textContent only.

interface ScEditRow {
  metricId: string;
  targetMode: 'none' | 'number' | 'metric';
  target: string;
  targetMetric: string;
  owner: string;
  group: string;
  good: string;
  warn: string;
}

function scToEditRow(r: any): ScEditRow {
  const t = r ? r.target : undefined;
  return {
    metricId: String(r.metricId),
    targetMode: typeof t === 'number' ? 'number' : t && t.metricId ? 'metric' : 'none',
    target: typeof t === 'number' ? String(t) : '',
    targetMetric: t && t.metricId ? String(t.metricId) : '',
    owner: r.owner || '',
    group: r.group || '',
    good: r.thresholds ? String(r.thresholds.good) : '',
    warn: r.thresholds ? String(r.thresholds.warn) : '',
  };
}

function scFromEditRow(e: ScEditRow): any {
  const row: any = { metricId: e.metricId };
  const n = Number(e.target);
  if (e.targetMode === 'number' && e.target.trim() !== '' && Number.isFinite(n)) row.target = n;
  if (e.targetMode === 'metric' && e.targetMetric) row.target = { metricId: e.targetMetric };
  if (e.owner.trim()) row.owner = e.owner.trim();
  if (e.group.trim()) row.group = e.group.trim();
  const g = Number(e.good);
  const w = Number(e.warn);
  if (e.good.trim() !== '' && e.warn.trim() !== '' && Number.isFinite(g) && Number.isFinite(w)) row.thresholds = { good: g, warn: w };
  return row;
}

function scInput(value: string, placeholder: string, onInput: (v: string) => void, aria: string, type = 'text'): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.className = 'sc-ed-input';
  i.value = value;
  i.placeholder = placeholder;
  i.setAttribute('aria-label', aria);
  if (type === 'number') i.step = 'any';
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

async function scEditRows(): Promise<void> {
  if (!scCurrent || !currentProjectId) return;
  const cur = scCurrent;
  let metrics: any[] = [];
  try { const r = await window.hub.listMetrics(currentProjectId); metrics = r && Array.isArray(r.metrics) ? r.metrics : []; } catch (_) { metrics = []; }
  const byId = new Map<string, any>((Array.isArray(metrics) ? metrics : []).map((m: any) => [String(m.id), m]));
  let rows: ScEditRow[] = cur.rows.map(scToEditRow);

  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal sc-editor';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Edit scorecard metrics');
  const title = document.createElement('div');
  title.className = 'ws-modal-title';
  title.textContent = 'Metrics, targets and owners';
  const sub = document.createElement('p');
  sub.className = 'sc-ed-sub';
  sub.textContent = 'Thresholds are percent of target. Leave them blank for the defaults: on track at 100%, at risk from 90% (or, for a metric where down is good, up to 110%).';
  const list = document.createElement('div');
  list.className = 'sc-ed-list';
  const groupsId = 'sc-ed-groups-' + Date.now();
  const datalist = document.createElement('datalist');
  datalist.id = groupsId;

  const render = (): void => {
    list.textContent = '';
    datalist.textContent = '';
    for (const g of Array.from(new Set(rows.map((r) => r.group.trim()).filter(Boolean)))) {
      const o = document.createElement('option');
      o.value = g;
      datalist.appendChild(o);
    }
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'sc-ed-empty';
      p.textContent = 'No metrics yet. Add the numbers you want to track.';
      list.appendChild(p);
    }
    const head = document.createElement('div');
    head.className = 'sc-ed-row sc-ed-row--head';
    for (const t of ['Metric', 'Target', 'Owner', 'Group', 'Good %', 'Warn %', '']) {
      const c = document.createElement('span');
      c.textContent = t;
      head.appendChild(c);
    }
    if (rows.length) list.appendChild(head);
    rows.forEach((r, i) => {
      const m = byId.get(r.metricId);
      const row = document.createElement('div');
      row.className = 'sc-ed-row';
      const name = document.createElement('div');
      name.className = 'sc-ed-metric';
      const nm = document.createElement('span');
      nm.className = 'sc-ed-metric-name';
      nm.textContent = m ? String(m.name) : 'Missing metric';
      const dir = document.createElement('span');
      dir.className = 'sc-ed-metric-dir';
      dir.textContent = m && m.direction === 'down_good' ? 'down is good' : m && m.direction === 'up_good' ? 'up is good' : '';
      name.append(nm, dir);
      row.appendChild(name);

      const tgt = document.createElement('div');
      tgt.className = 'sc-ed-target';
      const mode = document.createElement('select');
      mode.className = 'viz-select sc-ed-mode';
      mode.setAttribute('aria-label', 'Target type for ' + (m ? m.name : 'metric'));
      for (const [v, l] of [['none', 'None'], ['number', 'Number'], ['metric', 'Metric…']]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = l;
        mode.appendChild(o);
      }
      mode.value = r.targetMode;
      mode.addEventListener('change', async () => {
        if (mode.value === 'metric') {
          const picked = await openMetricPicker(mode, {});
          if (picked && picked.kind === 'metric' && picked.metric) { r.targetMode = 'metric'; r.targetMetric = String(picked.metric.id); }
        } else r.targetMode = mode.value as ScEditRow['targetMode'];
        render();
      });
      tgt.appendChild(mode);
      if (r.targetMode === 'number') tgt.appendChild(scInput(r.target, 'e.g. 250000', (v) => { r.target = v; }, 'Target value', 'number'));
      if (r.targetMode === 'metric') {
        const chip = document.createElement('span');
        chip.className = 'sc-chip';
        const tm = byId.get(r.targetMetric);
        chip.textContent = tm ? String(tm.name) : 'Missing metric';
        tgt.appendChild(chip);
      }
      row.appendChild(tgt);
      const owner = scInput(r.owner, 'Owner', (v) => { r.owner = v; }, 'Owner');
      const group = scInput(r.group, 'Group', (v) => { r.group = v; }, 'Group');
      group.setAttribute('list', groupsId);
      const down = m && m.direction === 'down_good';
      row.append(owner, group,
        scInput(r.good, '100', (v) => { r.good = v; }, 'Good threshold, percent of target', 'number'),
        scInput(r.warn, down ? '110' : '90', (v) => { r.warn = v; }, 'Warning threshold, percent of target', 'number'));
      const acts = document.createElement('div');
      acts.className = 'sc-ed-acts';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'icon-btn';
      iconOnly(up, 'arrow-up', 'Move up');
      up.disabled = i === 0;
      up.addEventListener('click', () => { const t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t; render(); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      iconOnly(del, 'x', 'Remove ' + (m ? m.name : 'row'));
      del.addEventListener('click', () => { rows.splice(i, 1); render(); });
      acts.append(up, del);
      row.appendChild(acts);
      list.appendChild(row);
    });
  };

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm sc-ed-add';
  add.append(icon('plus', 16), Object.assign(document.createElement('span'), { textContent: 'Add metric' }));
  add.addEventListener('click', async () => {
    const picked = await openMetricPicker(add, {});
    if (!picked || picked.kind !== 'metric' || !picked.metric) return;
    if (!byId.has(String(picked.metric.id))) byId.set(String(picked.metric.id), picked.metric);
    rows.push(scToEditRow({ metricId: String(picked.metric.id) }));
    render();
  });

  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-primary';
  save.textContent = 'Save';
  actions.append(cancel, save);

  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  save.addEventListener('click', async () => {
    const out = rows.map(scFromEditRow);
    const res = await window.hubPower.scorecardUpdate(currentProjectId as string, cur.id, { rows: out });
    if (!res || res.ok === false) { showToast('Could not save the scorecard.'); return; }
    if (scCurrent && scCurrent.id === cur.id) scCurrent.rows = res.scorecard.rows;
    close();
    await scCompute();
  });
  document.addEventListener('keydown', onKey, true);

  box.append(title, sub, list, datalist, add, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  render();
  save.focus();
}
