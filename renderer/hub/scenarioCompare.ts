// COMPARE SCENARIOS — the baseline and up to four saved scenarios side by side:
// one row per metric (the union of the scenarios' metrics), one column each,
// every cell the figure and its change on the baseline. The figures come from
// `scenario:compare` (src/ipc/scenarios.ts); this file lays them out and marks
// the best cell of a row whose metric says which way is good.
//
// Classic global-scope script — NO import/export. textContent only.

const SN_CMP_MAX = 4;
let snCmpPicked: string[] = [];
let snCmpSeq = 0;

async function snOpenCompare(preselect: string[]): Promise<void> {
  if (!currentProjectId) return;
  if (snCurrent) await snClose();
  if (currentSection !== 'analyses') selectSection('analyses');
  rbSelectTab('scenarios');
  let all: any[] = [];
  try { all = await window.hubScenarios.list(currentProjectId); } catch (_) { all = []; }
  if (!Array.isArray(all)) all = [];
  snListCache = all;
  const ids = all.map((s) => String(s.id));
  snCmpPicked = preselect.filter((id) => ids.indexOf(id) >= 0);
  for (const id of ids) if (snCmpPicked.length < Math.min(SN_CMP_MAX, 2) && snCmpPicked.indexOf(id) < 0) snCmpPicked.push(id);
  for (const hide of ['an-list-view', 'rp-builder', 'st-page', 'sc-page', 'sn-page']) { const el = snEl(hide); if (el) el.hidden = true; }
  const view = snEl('sn-compare');
  if (view) view.hidden = false;
  snRenderPicker();
  await snRenderCompare();
}

function snCloseCompare(): void {
  const view = snEl('sn-compare');
  if (view) view.hidden = true;
  const list = snEl('an-list-view');
  if (list) list.hidden = false;
  rbSelectTab('scenarios');
}

function snRenderPicker(): void {
  const box = snEl('sn-cmp-pick');
  if (!box) return;
  box.textContent = '';
  const full = snCmpPicked.length >= SN_CMP_MAX;
  for (const s of snListCache) {
    const id = String(s.id);
    const on = snCmpPicked.indexOf(id) >= 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sn-cmp-chip';
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !on && full;
    if (b.disabled) b.title = 'Four scenarios at a time';
    b.append(icon(on ? 'check' : 'plus', 12), document.createTextNode(' ' + String(s.name)));
    b.addEventListener('click', () => {
      snCmpPicked = on ? snCmpPicked.filter((x) => x !== id) : snCmpPicked.concat([id]);
      snRenderPicker();
      void snRenderCompare();
    });
    box.appendChild(b);
  }
  const note = snEl('sn-cmp-count');
  if (note) note.textContent = `${snCmpPicked.length} of ${SN_CMP_MAX} picked`;
}

function snCmpEmpty(title: string, text: string, withNew: boolean): HTMLElement {
  const e = document.createElement('div');
  e.className = 'ws-empty sn-cmp-empty';
  e.appendChild(snTornadoArt());
  const h = document.createElement('h3');
  h.className = 'ws-empty-h';
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'ws-empty-p';
  p.textContent = text;
  e.append(h, p);
  if (withNew) {
    const acts = document.createElement('div');
    acts.className = 'ws-empty-actions';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.textContent = 'New scenario';
    b.addEventListener('click', () => { snCloseCompare(); void snNew(); });
    acts.appendChild(b);
    e.appendChild(acts);
  }
  return e;
}

function snCell(role: string, cls: string, text?: string): HTMLElement {
  const c = document.createElement('div');
  c.setAttribute('role', role);
  c.className = 'sn-cmp-cell ' + cls;
  if (text !== undefined) c.textContent = text;
  return c;
}

async function snRenderCompare(): Promise<void> {
  const body = snEl('sn-cmp-body');
  if (!body || !currentProjectId) return;
  const my = ++snCmpSeq;
  if (!snListCache.length) {
    body.textContent = '';
    body.appendChild(snCmpEmpty('Nothing to compare yet', 'Save a scenario or two — a price rise, a volume dip — and see them here side by side with the baseline.', true));
    return;
  }
  if (!snCmpPicked.length) {
    body.textContent = '';
    body.appendChild(snCmpEmpty('Pick scenarios to compare', `Choose up to ${SN_CMP_MAX} above. Each becomes a column beside the baseline.`, false));
    return;
  }
  body.classList.add('is-loading');
  let res: any = null;
  try { res = await window.hubScenarios.compare(currentProjectId, snCmpPicked); } catch (_) { res = null; }
  if (my !== snCmpSeq) return;
  body.classList.remove('is-loading');
  body.textContent = '';
  if (!res || res.ok === false) {
    const p = document.createElement('p');
    p.className = 'sn-error';
    p.textContent = (res && res.error) || 'Could not compare the scenarios.';
    body.appendChild(p);
    return;
  }
  const table = document.createElement('div');
  table.className = 'sn-cmp-table';
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Baseline and scenarios, side by side');
  const cols = `minmax(150px, 1.1fr) repeat(${res.scenarios.length + 1}, minmax(150px, 1fr))`;

  const head = document.createElement('div');
  head.className = 'sn-cmp-row sn-cmp-row--head';
  head.setAttribute('role', 'row');
  head.style.gridTemplateColumns = cols;
  head.appendChild(snCell('columnheader', 'sn-cmp-corner', 'Metric'));
  const base = snCell('columnheader', 'sn-cmp-colhead sn-cmp-colhead--base');
  const bt = document.createElement('span');
  bt.className = 'sn-cmp-colname';
  bt.textContent = 'Baseline';
  const bs = document.createElement('span');
  bs.className = 'sn-cmp-colsub';
  bs.textContent = 'The data as stored';
  base.append(bt, bs);
  head.appendChild(base);
  for (const s of res.scenarios) {
    const h = snCell('columnheader', 'sn-cmp-colhead');
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'sn-cmp-colname sn-cmp-open';
    name.textContent = s.name;
    name.title = 'Open ' + s.name;
    name.addEventListener('click', () => { snCloseCompare(); void snOpen(s.id); });
    const chips = document.createElement('span');
    chips.className = 'sn-cmp-drivers';
    for (const d of (s.drivers || []).slice(0, 3)) {
      const c = document.createElement('span');
      c.className = 'sn-chip';
      c.textContent = d;
      chips.appendChild(c);
    }
    if ((s.drivers || []).length > 3) {
      const c = document.createElement('span');
      c.className = 'sn-chip sn-chip--more';
      c.textContent = '+' + (s.drivers.length - 3);
      chips.appendChild(c);
    }
    if (!(s.drivers || []).length) {
      const c = document.createElement('span');
      c.className = 'sn-cmp-colsub';
      c.textContent = 'No drivers';
      chips.appendChild(c);
    }
    h.append(name, chips);
    head.appendChild(h);
  }
  table.appendChild(head);

  for (const r of res.rows) {
    const row = document.createElement('div');
    row.className = 'sn-cmp-row' + (r.missing ? ' is-missing' : '');
    row.setAttribute('role', 'row');
    row.style.gridTemplateColumns = cols;
    row.appendChild(snCell('rowheader', 'sn-cmp-metric', r.missing ? 'Missing metric' : r.name));
    row.appendChild(snCell('cell', 'sn-cmp-val sn-cmp-val--base tnum', r.baselineDisplay || '—'));
    // The best column of a row — only when the metric says which way is good,
    // among ≥ 2, and only an outright winner: a tie is nobody's best.
    let best = -1;
    if (r.direction && res.scenarios.length > 1) {
      r.cells.forEach((c: any, i: number) => {
        if (typeof c.value !== 'number') return;
        const b = best >= 0 ? r.cells[best].value : null;
        if (b === null || (r.direction === 'down_good' ? c.value < b : c.value > b)) best = i;
      });
      if (best >= 0 && r.cells.some((c: any, i: number) => i !== best && c.value === r.cells[best].value)) best = -1;
    }
    r.cells.forEach((c: any, i: number) => {
      const cell = snCell('cell', 'sn-cmp-val' + (i === best ? ' is-best' : ''));
      const v = document.createElement('span');
      v.className = 'sn-cmp-num tnum';
      v.textContent = c.display || '—';
      const d = document.createElement('span');
      const tone = c.delta === null || c.delta === 0 ? 'flat' : c.tone;
      d.className = 'sn-cmp-delta tnum is-' + tone;
      d.textContent = c.delta === null ? '' : c.delta === 0 ? 'No change' : c.deltaDisplay + (typeof c.pct === 'number' ? ' (' + kpiPct(c.pct) + ')' : '');
      cell.append(v, d);
      if (i === best) {
        const tag = document.createElement('span');
        tag.className = 'sn-cmp-best';
        tag.textContent = 'Best';
        cell.appendChild(tag);
      }
      row.appendChild(cell);
    });
    table.appendChild(row);
  }
  body.appendChild(table);
}

function initScenarioCompare(): void {
  const back = snEl('sn-cmp-back');
  if (back) back.addEventListener('click', () => snCloseCompare());
}
