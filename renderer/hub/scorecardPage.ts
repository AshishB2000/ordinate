// An open SCORECARD — one period at a time, every metric a row: its value, its
// target, attainment, a status dot, the change on the previous period, a
// twelve-period sparkline, its owner and its latest alert or comment count,
// grouped with a roll-up of how many are on track.
//
// NOTHING HERE COMPUTES A FIGURE. `scorecard:compute` (src/ipc/scorecards.ts)
// returns every value, status and display string, resolved per period through
// the metrics layer; the period picker steps back by asking again. This file
// lays the answer out. Clicking a row opens the metric's detail
// (scorecardDetail.ts).
//
// Classic global-scope script — NO import/export. textContent only.

let scCurrent: { id: string; name: string; period: string; rows: any[] } | null = null;
let scOffset = 0;
let scResult: any = null;
let scSeq = 0;

const SC_STATUS_WORD: Record<string, string> = { good: 'On track', warn: 'At risk', off: 'Off track', none: 'No target' };

async function scOpen(id: string): Promise<void> {
  if (!currentProjectId) return;
  let sc: any = null;
  try { sc = await window.hubPower.scorecardGet(currentProjectId, id); } catch (_) { sc = null; }
  if (!sc || !sc.id) { showToast('That scorecard could not be opened.'); return; }
  if (typeof dashCurrent !== 'undefined' && dashCurrent) await handleBackToList();
  if (typeof stStory !== 'undefined' && stStory) await stClose();
  if (currentSection !== 'analyses') selectSection('analyses');
  rbSelectTab('scorecards');
  scCurrent = { id: String(sc.id), name: String(sc.name), period: String(sc.period), rows: Array.isArray(sc.rows) ? sc.rows : [] };
  scOffset = 0;
  scResult = null;
  for (const id2 of ['an-list-view', 'rp-builder', 'st-page']) { const el = scEl(id2); if (el) el.hidden = true; }
  const page = scEl('sc-page');
  if (page) page.hidden = false;
  const name = scEl<HTMLInputElement>('sc-name');
  if (name) name.value = scCurrent.name;
  const per = scEl<HTMLSelectElement>('sc-period-select');
  if (per) per.value = scCurrent.period;
  scCloseDetail();
  if (typeof dkSync === 'function') dkSync(); // the dock's context is now this scorecard
  await scCompute();
}

async function scClose(): Promise<void> {
  if (!scCurrent) return;
  scCurrent = null;
  scResult = null;
  scCloseDetail();
  const page = scEl('sc-page');
  if (page) page.hidden = true;
  const list = scEl('an-list-view');
  if (list) list.hidden = false;
  rbSelectTab('scorecards');
  if (typeof dkSync === 'function') dkSync();
}

async function scCompute(): Promise<void> {
  if (!scCurrent || !currentProjectId) return;
  const my = ++scSeq;
  const body = scEl('sc-body');
  if (body) body.classList.add('is-loading');
  let res: any = null;
  try { res = await window.hubPower.scorecardCompute(currentProjectId, scCurrent.id, scOffset); } catch (_) { res = null; }
  if (my !== scSeq || !scCurrent) return;
  if (body) body.classList.remove('is-loading');
  if (!res || res.ok === false) { scRenderError((res && res.error) || 'Could not compute the scorecard.'); return; }
  scResult = res;
  scRender(res);
}

function scRenderError(msg: string): void {
  const table = scEl('sc-table');
  if (!table) return;
  table.textContent = '';
  const p = document.createElement('p');
  p.className = 'sc-error';
  p.textContent = msg;
  table.appendChild(p);
}

function scDot(status: string): HTMLElement {
  const d = document.createElement('span');
  d.className = 'sc-dot sc-dot--' + status;
  d.setAttribute('role', 'img');
  d.setAttribute('aria-label', SC_STATUS_WORD[status] || status);
  d.title = SC_STATUS_WORD[status] || status;
  return d;
}

/** "3 on track · 1 at risk · 1 off track" — the whole card at a glance. */
function scRenderSummary(res: any): void {
  const box = scEl('sc-summary');
  if (!box) return;
  box.textContent = '';
  const counts: Record<string, number> = { good: 0, warn: 0, off: 0, none: 0 };
  for (const r of res.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  for (const st of ['good', 'warn', 'off', 'none']) {
    if (!counts[st] && st === 'none') continue;
    const item = document.createElement('span');
    item.className = 'sc-summary-item';
    const n = document.createElement('strong');
    n.textContent = String(counts[st]);
    const w = document.createElement('span');
    w.textContent = (SC_STATUS_WORD[st] || st).toLowerCase();
    item.append(scDot(st), n, w);
    box.appendChild(item);
  }
}

function scRender(res: any): void {
  const label = scEl('sc-period-label');
  if (label) label.textContent = res.window ? res.window.label : '';
  const next = scEl<HTMLButtonElement>('sc-period-next');
  if (next) next.disabled = scOffset <= 0;
  const range = scEl('sc-period-range');
  if (range) range.textContent = res.window ? `${res.window.from} – ${res.window.to}` : '';
  scRenderSummary(res);

  const table = scEl('sc-table');
  if (!table) return;
  table.textContent = '';
  if (!res.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'sc-empty-rows';
    const h = document.createElement('p');
    h.className = 'sc-empty-rows-h';
    h.textContent = 'No metrics on this scorecard yet';
    const p = document.createElement('p');
    p.textContent = 'Add the metrics you want to track, give each a target, and the app scores every period for you.';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-primary';
    add.textContent = 'Add metrics';
    add.addEventListener('click', () => { void scEditRows(); });
    empty.append(h, p, add);
    table.appendChild(empty);
    return;
  }

  const head = document.createElement('div');
  head.className = 'sc-row sc-row--head';
  head.setAttribute('role', 'row');
  for (const t of ['', 'Metric', res.window ? res.window.label : 'Current', 'Target', 'Attainment', 'vs previous', 'Last 12', 'Owner', '']) {
    const c = document.createElement('span');
    c.className = 'sc-cell';
    c.setAttribute('role', 'columnheader');
    c.textContent = t;
    head.appendChild(c);
  }
  table.appendChild(head);

  const grouped = res.rows.some((r: any) => r.group);
  const order: string[] = [];
  for (const r of res.rows) { const g = r.group || ''; if (order.indexOf(g) < 0) order.push(g); }
  if (grouped && order.indexOf('') > 0) { order.splice(order.indexOf(''), 1); order.push(''); }
  for (const g of order) {
    if (grouped) table.appendChild(scGroupHead(g, res.groups.find((x: any) => x.group === g)));
    for (const r of res.rows.filter((x: any) => (x.group || '') === g)) table.appendChild(scRow(r));
  }
}

function scGroupHead(group: string, roll: any): HTMLElement {
  const h = document.createElement('div');
  h.className = 'sc-group';
  const name = document.createElement('span');
  name.className = 'sc-group-name';
  name.textContent = group || 'Other';
  h.appendChild(name);
  if (roll) {
    const r = document.createElement('span');
    r.className = 'sc-group-roll';
    r.textContent = roll.scored ? `${roll.onTrack} of ${roll.scored} on track` : `${roll.total} metric${roll.total === 1 ? '' : 's'}, no targets`;
    const meter = document.createElement('span');
    meter.className = 'sc-group-meter';
    const fill = document.createElement('span');
    fill.className = 'sc-group-meter-fill';
    fill.style.width = (roll.scored ? Math.round((roll.onTrack / roll.scored) * 100) : 0) + '%';
    meter.appendChild(fill);
    h.append(meter, r);
  }
  return h;
}

function scCell(cls: string, text?: string): HTMLElement {
  const c = document.createElement('span');
  c.className = 'sc-cell ' + cls;
  c.setAttribute('role', 'cell');
  if (text !== undefined) c.textContent = text;
  return c;
}

function scRow(r: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sc-row' + (r.missing ? ' is-missing' : '');
  row.setAttribute('role', 'row');
  row.tabIndex = 0;
  row.dataset.metricId = String(r.metricId);
  row.dataset.status = String(r.status);

  const st = scCell('sc-cell--status');
  st.appendChild(scDot(r.status));
  row.appendChild(st);

  const name = scCell('sc-cell--name');
  const n = document.createElement('span');
  n.className = 'sc-metric-name';
  n.textContent = String(r.name);
  name.appendChild(n);
  if (r.undated) {
    const note = document.createElement('span');
    note.className = 'sc-note';
    note.textContent = 'all time — no date column';
    name.appendChild(note);
  }
  row.appendChild(name);

  row.appendChild(scCell('sc-cell--value', r.display || '—'));
  const tgt = scCell('sc-cell--target', r.targetDisplay || '—');
  if (r.targetName) tgt.title = 'Target from the metric ' + r.targetName;
  row.appendChild(tgt);

  const att = scCell('sc-cell--att');
  if (typeof r.attainment === 'number') {
    const meter = document.createElement('span');
    meter.className = 'sc-att-meter sc-att-meter--' + r.status;
    const fill = document.createElement('span');
    fill.className = 'sc-att-fill';
    fill.style.width = Math.max(2, Math.min(100, (r.attainment / 150) * 100)) + '%';
    const mark = document.createElement('span');
    mark.className = 'sc-att-target';
    meter.append(fill, mark);
    const pct = document.createElement('span');
    pct.className = 'sc-att-pct';
    pct.textContent = Math.round(r.attainment) + '%';
    att.append(meter, pct);
  } else att.textContent = '—';
  row.appendChild(att);

  const chg = scCell('sc-cell--change sc-tone--' + (r.tone || 'flat'));
  if (r.deltaDisplay) {
    const arrow = r.delta > 0 ? 'arrow-up' : r.delta < 0 ? 'arrow-down' : 'minus';
    chg.appendChild(icon(arrow, 16));
    const t = document.createElement('span');
    t.textContent = r.deltaDisplay + (typeof r.pct === 'number' ? ` (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(Math.abs(r.pct) < 10 ? 1 : 0)}%)` : '');
    chg.appendChild(t);
  } else chg.textContent = '—';
  row.appendChild(chg);

  const spark = scCell('sc-cell--spark sc-spark--' + r.status);
  const svg = Array.isArray(r.spark) && r.spark.length ? aiSparkline(r.spark) : null;
  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${r.name} over the last ${r.spark.length} periods`);
    spark.appendChild(svg);
  }
  row.appendChild(spark);

  row.appendChild(scCell('sc-cell--owner', r.owner || ''));

  const act = scCell('sc-cell--activity');
  if (r.alert) {
    const a = document.createElement('span');
    a.className = 'sc-activity sc-activity--alert';
    a.title = r.alert.message;
    a.appendChild(icon('bell', 16));
    const t = document.createElement('span');
    t.textContent = aiAgo(r.alert.at);
    a.appendChild(t);
    act.appendChild(a);
  }
  if (r.comments) {
    const c = document.createElement('span');
    c.className = 'sc-activity sc-activity--comments';
    c.title = `${r.comments} open comment thread${r.comments === 1 ? '' : 's'} where this metric appears`;
    c.appendChild(icon('message-square', 16));
    const t = document.createElement('span');
    t.textContent = String(r.comments);
    c.appendChild(t);
    act.appendChild(c);
  }
  row.appendChild(act);

  const open = (): void => { if (!r.missing) void scOpenDetail(String(r.metricId)); };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return row;
}

async function scSetPeriod(period: string): Promise<void> {
  if (!scCurrent || !currentProjectId) return;
  scCurrent.period = period;
  scOffset = 0;
  await window.hubPower.scorecardUpdate(currentProjectId, scCurrent.id, { period });
  await scCompute();
  if (scDetailMetric) void scOpenDetail(scDetailMetric);
}

async function scStep(dir: number): Promise<void> {
  scOffset = Math.max(0, scOffset + dir);
  await scCompute();
  if (scDetailMetric) void scOpenDetail(scDetailMetric);
}

async function scRename(name: string): Promise<void> {
  if (!scCurrent || !currentProjectId || !name.trim() || name.trim() === scCurrent.name) return;
  scCurrent.name = name.trim();
  await window.hubPower.scorecardUpdate(currentProjectId, scCurrent.id, { name: scCurrent.name });
}

/** The ⋯ menu: report, publish (when the publisher is installed), duplicate, delete. */
function scMoreMenu(anchor: HTMLElement): void {
  if (!scCurrent) return;
  const cur = scCurrent;
  // Feature-detected: publish-to-folder (publishDialog.js + the platform bridge)
  // ships with feat/platform-depth. Present, the scorecard is offered to it,
  // ticked; absent, the item is simply not here.
  const publish = (window as any).openPublishDialog;
  const canPublish = typeof publish === 'function' && !!(window as any).hubPlatform;
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    const add = (label: string, run: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-menu-item';
      b.textContent = label;
      b.addEventListener('click', () => { close(); run(); });
      menu.appendChild(b);
    };
    add('Create report…', () => { void scCreateReport(cur.id); });
    if (canPublish) add('Publish…', () => { void publish(cur.id); });
    add('Duplicate', () => { void scDuplicate(cur.id); });
    add('Delete', () => { void scDelete({ id: cur.id, name: cur.name }); });
  });
}

/**
 * Another page of the Dashboards section opening — a dashboard, a report, a
 * story, by the dock or the palette — takes the screen from the scorecard, the
 * way it would from each other. Watching their `hidden` keeps two pages from
 * ever drawing at once.
 */
function scGuardPages(): void {
  for (const id of ['dash-editor', 'rp-builder', 'st-page']) {
    const el = scEl(id);
    if (!el) continue;
    new MutationObserver(() => {
      const page = scEl('sc-page');
      if (el.hidden || !page || page.hidden) return;
      page.hidden = true;
      scCurrent = null;
      scResult = null;
      scCloseDetail();
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }
}

function initScorecardPage(): void {
  scGuardPages();
  const back = scEl('sc-back');
  if (back) back.addEventListener('click', () => { void scClose(); });
  const name = scEl<HTMLInputElement>('sc-name');
  if (name) {
    name.addEventListener('change', () => { void scRename(name.value); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  }
  const per = scEl<HTMLSelectElement>('sc-period-select');
  if (per) per.addEventListener('change', () => { void scSetPeriod(per.value); });
  const prev = scEl('sc-period-prev');
  if (prev) prev.addEventListener('click', () => { void scStep(1); });
  const next = scEl('sc-period-next');
  if (next) next.addEventListener('click', () => { void scStep(-1); });
  const edit = scEl('sc-edit');
  if (edit) edit.addEventListener('click', () => { void scEditRows(); });
  const more = scEl('sc-more');
  if (more) more.addEventListener('click', (e) => { e.stopPropagation(); scMoreMenu(more); });
  const close = scEl('sc-detail-close');
  if (close) close.addEventListener('click', () => scCloseDetail());
}
