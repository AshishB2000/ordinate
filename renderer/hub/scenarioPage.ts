// An open SCENARIO — the setup on the left (its metrics and its drivers, as
// sliders and inputs: scenarioDrivers.ts), the results on the right: each
// metric's scenario value beside its baseline with the change, and a tornado of
// how far each driver moves one metric at ±10%.
//
// NOTHING HERE COMPUTES A FIGURE. `scenario:compute` (src/ipc/scenarios.ts)
// returns every value, change, label and bar; a slider sends its DRAFT and the
// page lays out the answer. Edits are saved on a debounce, like a story.
//
// Classic global-scope script — NO import/export. textContent only.

let snCurrent: { id: string; name: string; baseMetricIds: string[]; drivers: any[] } | null = null;
let snResult: any = null;
/** The tornado's metric; '' = the first one with a figure. */
let snFocus = '';
let snSeq = 0;
let snComputeTimer: any = 0;
let snSaveTimer: any = 0;

async function snOpen(id: string): Promise<void> {
  if (!currentProjectId) return;
  let s: any = null;
  try { s = await window.hubScenarios.get(currentProjectId, id); } catch (_) { s = null; }
  if (!s || !s.id) { showToast('That scenario could not be opened.'); return; }
  if (snCurrent) await snFlush();
  if (typeof dashCurrent !== 'undefined' && dashCurrent) await handleBackToList();
  if (typeof stStory !== 'undefined' && stStory) await stClose();
  if (typeof scCurrent !== 'undefined' && scCurrent) await scClose();
  if (currentSection !== 'analyses') selectSection('analyses');
  rbSelectTab('scenarios');
  snCurrent = {
    id: String(s.id), name: String(s.name),
    baseMetricIds: Array.isArray(s.baseMetricIds) ? s.baseMetricIds.slice() : [],
    drivers: Array.isArray(s.drivers) ? s.drivers.map((d: any) => ({ ...d })) : [],
  };
  snResult = null;
  snFocus = '';
  for (const hide of ['an-list-view', 'rp-builder', 'st-page', 'sc-page', 'sn-compare']) { const el = snEl(hide); if (el) el.hidden = true; }
  const page = snEl('sn-page');
  if (page) page.hidden = false;
  const name = snEl<HTMLInputElement>('sn-name');
  if (name) name.value = snCurrent.name;
  snSetStatus('');
  if (typeof dkSync === 'function') dkSync(); // the dock's context is now this scenario
  await snLoadSetup();
  await snCompute();
}

async function snClose(): Promise<void> {
  if (!snCurrent) return;
  await snFlush();
  snCurrent = null;
  snResult = null;
  const page = snEl('sn-page');
  if (page) page.hidden = true;
  const list = snEl('an-list-view');
  if (list) list.hidden = false;
  rbSelectTab('scenarios');
  if (typeof dkSync === 'function') dkSync();
}

function snSetStatus(text: string): void {
  const el = snEl('sn-status');
  if (el) el.textContent = text;
}

/** Something in the setup changed: recompute the draft now, save it shortly. */
function snChanged(opts: { setup?: boolean } = {}): void {
  if (!snCurrent) return;
  if (opts.setup) void snLoadSetup();
  else snRenderDrivers();
  clearTimeout(snComputeTimer);
  snComputeTimer = setTimeout(() => { void snCompute(); }, 120);
  clearTimeout(snSaveTimer);
  snSetStatus('Editing…');
  snSaveTimer = setTimeout(() => { void snFlush(); }, 600);
}

async function snFlush(): Promise<void> {
  if (!snSaveTimer || !snCurrent || !currentProjectId) return;
  clearTimeout(snSaveTimer);
  snSaveTimer = 0;
  const cur = snCurrent;
  let res: any = null;
  try {
    res = await window.hubScenarios.update(currentProjectId, cur.id, { name: cur.name, baseMetricIds: cur.baseMetricIds, drivers: cur.drivers });
  } catch (_) { res = null; }
  if (snCurrent === cur) snSetStatus(res && res.ok ? 'Saved' : 'Could not save');
}

async function snCompute(): Promise<void> {
  if (!snCurrent || !currentProjectId) return;
  const my = ++snSeq;
  const box = snEl('sn-results');
  if (box) box.classList.add('is-loading');
  let res: any = null;
  try {
    res = await window.hubScenarios.compute(currentProjectId, snCurrent.id,
      { baseMetricIds: snCurrent.baseMetricIds, drivers: snCurrent.drivers }, snFocus || undefined);
  } catch (_) { res = null; }
  if (my !== snSeq || !snCurrent) return;
  if (box) box.classList.remove('is-loading');
  if (!res || res.ok === false) { snRenderError((res && res.error) || 'Could not compute the scenario.'); return; }
  snResult = res;
  snRenderResults(res);
  snRenderDrivers();
}

function snRenderError(msg: string): void {
  const kpis = snEl('sn-kpis');
  if (!kpis) return;
  kpis.textContent = '';
  const p = document.createElement('p');
  p.className = 'sn-error';
  p.textContent = msg;
  kpis.appendChild(p);
}

// ── results ──────────────────────────────────────────────────────────────────

function snRenderResults(res: any): void {
  const kpis = snEl('sn-kpis');
  if (!kpis) return;
  kpis.textContent = '';
  if (!res.metrics.length) {
    const empty = document.createElement('div');
    empty.className = 'sn-kpis-empty';
    const h = document.createElement('p');
    h.className = 'sn-kpis-empty-h';
    h.textContent = 'No metrics in this scenario yet';
    const p = document.createElement('p');
    p.textContent = 'Add the metrics you want to see move — revenue, margin, units — and every driver is applied to all of them at once.';
    empty.append(icon('gauge', 20), h, p);
    kpis.appendChild(empty);
  }
  const focus = res.tornado ? res.tornado.metricId : '';
  for (const m of res.metrics) kpis.appendChild(snKpi(m, m.metricId === focus));
  snRenderTornado(res);
  const notes = snEl('sn-notes');
  if (notes) {
    notes.textContent = '';
    for (const n of res.notes || []) {
      const li = document.createElement('li');
      li.append(icon('info', 12), document.createTextNode(' ' + n));
      notes.appendChild(li);
    }
    notes.hidden = !(res.notes || []).length;
  }
}

/** One result tile: the scenario value, the baseline under it, the change as a pill. Click → its tornado. */
function snKpi(m: any, focused: boolean): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sn-kpi' + (m.missing ? ' is-missing' : '');
  b.dataset.metricId = m.metricId;
  b.setAttribute('aria-pressed', String(focused));
  b.title = m.missing ? 'This metric no longer exists' : 'Show what moves ' + m.name + ' in the sensitivity chart';
  const name = document.createElement('span');
  name.className = 'sn-kpi-name';
  name.textContent = m.name;
  const value = document.createElement('span');
  value.className = 'sn-kpi-value tnum';
  value.textContent = m.display || '—';
  const base = document.createElement('span');
  base.className = 'sn-kpi-base tnum';
  base.textContent = 'Baseline ' + (m.baselineDisplay || '—');
  const delta = document.createElement('span');
  const tone = m.delta === 0 || m.delta === null ? 'flat' : m.tone;
  delta.className = 'sn-kpi-delta tnum is-' + tone;
  if (m.delta !== null && m.delta !== 0) delta.appendChild(icon(m.delta > 0 ? 'arrow-up' : 'arrow-down', 12));
  const text = document.createElement('span');
  text.textContent = m.delta === null ? 'No figure' : m.delta === 0 ? 'No change' : m.deltaDisplay + (typeof m.pct === 'number' ? ' (' + kpiPct(m.pct) + ')' : '');
  delta.appendChild(text);
  b.append(name, value, base, delta);
  if (!m.missing) b.addEventListener('click', () => { snFocus = m.metricId; void snCompute(); });
  return b;
}

function snRenderTornado(res: any): void {
  const body = snEl('sn-tornado-body');
  const sub = snEl('sn-tornado-sub');
  const sel = snEl<HTMLSelectElement>('sn-tornado-metric');
  if (!body) return;
  body.textContent = '';
  const t = res.tornado;
  if (sel) {
    sel.textContent = '';
    for (const m of res.metrics) {
      if (m.missing) continue;
      const o = document.createElement('option');
      o.value = m.metricId;
      o.textContent = m.name;
      sel.appendChild(o);
    }
    sel.value = t ? t.metricId : '';
    sel.disabled = !t;
  }
  if (sub) {
    sub.textContent = t
      ? `How far ${t.name} (${t.display}) moves when each driver's target moves ${Math.round(t.step * 100)}% either way, the others as set. Widest first.`
      : 'Which driver matters most, once there is a metric with a figure.';
  }
  const still = !!t && t.bars.length > 0 && t.bars.every((b: any) => b.swing === 0);
  if (!t || !t.bars.length || still) {
    const e = document.createElement('div');
    e.className = 'sn-tornado-empty';
    e.appendChild(snTornadoArt());
    const p = document.createElement('p');
    p.textContent = !t ? 'Add a metric and a driver to see the sensitivity.'
      : still ? `None of these drivers moves ${t.name}. Pick another metric above, or add a driver on one of its inputs.`
        : `Add a driver to see which one moves ${t.name} most.`;
    e.appendChild(p);
    body.appendChild(e);
    return;
  }
  const v = typeof t.value === 'number' ? t.value : 0;
  let scale = 0;
  for (const bar of t.bars) {
    for (const x of [bar.low, bar.high]) if (typeof x === 'number') scale = Math.max(scale, Math.abs(x - v));
  }
  const head = document.createElement('div');
  head.className = 'sn-tor-row sn-tor-row--head';
  head.setAttribute('aria-hidden', 'true');
  for (const [cls, txt] of [['', 'Driver'], ['sn-tor-num', `At −${Math.round(t.step * 100)}%`], ['sn-tor-axis', t.display], ['sn-tor-num', `At +${Math.round(t.step * 100)}%`]]) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = txt;
    head.appendChild(s);
  }
  body.appendChild(head);
  for (const bar of t.bars) {
    const row = document.createElement('div');
    row.className = 'sn-tor-row' + (bar.swing === 0 ? ' is-still' : '');
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', `${bar.label}: ${bar.lowDisplay} at −${Math.round(t.step * 100)}%, ${bar.highDisplay} at +${Math.round(t.step * 100)}%`);
    const label = document.createElement('span');
    label.className = 'sn-tor-label';
    label.textContent = bar.label;
    label.title = bar.label;
    const lo = document.createElement('span');
    lo.className = 'sn-tor-num tnum';
    lo.textContent = bar.lowDisplay;
    const track = document.createElement('span');
    track.className = 'sn-tor-track';
    for (const [x, side] of [[bar.low, 'low'], [bar.high, 'high']] as Array<[number | null, string]>) {
      if (typeof x !== 'number' || !scale) continue;
      const d = x - v;
      const seg = document.createElement('span');
      seg.className = 'sn-tor-bar sn-tor-bar--' + side;
      seg.style.left = (50 + (Math.min(0, d) / scale) * 50) + '%';
      seg.style.width = (Math.abs(d) / scale) * 50 + '%';
      track.appendChild(seg);
    }
    const hi = document.createElement('span');
    hi.className = 'sn-tor-num tnum';
    hi.textContent = bar.highDisplay;
    row.append(label, lo, track, hi);
    body.appendChild(row);
  }
  const legend = document.createElement('div');
  legend.className = 'sn-tor-legend';
  for (const [side, txt] of [['low', `Driver's target −${Math.round(t.step * 100)}%`], ['high', `Driver's target +${Math.round(t.step * 100)}%`]]) {
    const item = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = 'sn-tor-swatch sn-tor-bar--' + side;
    item.append(sw, document.createTextNode(txt));
    legend.appendChild(item);
  }
  body.appendChild(legend);
}

// ── head ─────────────────────────────────────────────────────────────────────

function snMoreMenu(anchor: HTMLElement): void {
  if (!snCurrent) return;
  const cur = snCurrent;
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    const add = (label: string, run: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-menu-item';
      b.textContent = label;
      b.addEventListener('click', () => { close(); run(); });
      menu.appendChild(b);
    };
    add('Duplicate', () => { void snFlush().then(() => snDuplicate(cur.id)); });
    add('Delete', () => { void snDelete({ id: cur.id, name: cur.name }); });
  });
}

/**
 * Another page of the Dashboards section opening — a dashboard, a report, a
 * story, a scorecard — takes the screen from the scenario, as scorecardPage.ts
 * does for itself. Watching their `hidden` keeps two pages from drawing at once.
 */
function snGuardPages(): void {
  for (const id of ['dash-editor', 'rp-builder', 'st-page', 'sc-page']) {
    const el = snEl(id);
    if (!el) continue;
    new MutationObserver(() => {
      if (el.hidden) return;
      const page = snEl('sn-page');
      if (page && !page.hidden) {
        void snFlush();
        page.hidden = true;
        snCurrent = null;
        snResult = null;
      }
      const cmp = snEl('sn-compare');
      if (cmp) cmp.hidden = true;
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
}

function initScenarioPage(): void {
  snGuardPages();
  const back = snEl('sn-back');
  if (back) back.addEventListener('click', () => { void snClose(); });
  const name = snEl<HTMLInputElement>('sn-name');
  if (name) {
    name.addEventListener('input', () => {
      if (!snCurrent) return;
      snCurrent.name = name.value.trim() || snCurrent.name;
      snChanged();
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  }
  const sel = snEl<HTMLSelectElement>('sn-tornado-metric');
  if (sel) sel.addEventListener('change', () => { snFocus = sel.value; void snCompute(); });
  const cmp = snEl('sn-compare-open');
  if (cmp) cmp.addEventListener('click', () => { if (snCurrent) void snOpenCompare([snCurrent.id]); });
  const more = snEl('sn-more');
  if (more) more.addEventListener('click', (e) => { e.stopPropagation(); snMoreMenu(more); });
  initScenarioDrivers();
}
