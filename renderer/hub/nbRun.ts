'use strict';

// Running notebook cells, and what a result looks like. Classic global-scope
// renderer <script>: no import/export. textContent only.
//
// A run SAVES first and then asks main to run the cell by id
// (`notebook:run`): main reads the notebook as saved, so what ran is always
// what is on screen. Each run carries a runId Cancel names; a run still going
// after a moment is also a job in the Jobs popover (src/ipc/notebooks.ts).
//
// The result area: the row count and elapsed time, the preview grid (the
// Query tab's — `cwBuildTable` + `qtFormatNumbers`), or the chart (buildChart,
// the renderer every visual uses), with Save as dataset / Pin to dashboard.
// Main computed every figure; nothing here does arithmetic on one.

const nbRunning = new Map<string, string>(); // cell id → run id
let nbExecSeq = 0;
let nbBatchRunning = false;
const nbChartInstances = new Map<string, any>();

function nbDestroyCharts(): void {
  for (const ch of nbChartInstances.values()) { try { ch.destroy(); } catch (_) { /* already gone */ } }
  nbChartInstances.clear();
}

/** Run one cell. Resolves true when it produced a result. */
async function nbRunCell(id: string): Promise<boolean> {
  const c = nbCell(id);
  if (!c || !nbDoc) return false;
  if (c.kind === 'markdown') { nbMdView(id); return true; }
  if (c.kind === 'param') return true;
  if (nbRunning.has(id)) return false;
  const runId = nbUuid();
  nbRunning.set(id, runId);
  nbPaintStates();
  nbRenderResult(id);
  const doc = nbDoc;
  const pid = nbDocProject;
  await nbFlush();
  let res: any = null;
  try {
    res = await window.hubNotebooks.run(pid, doc.id, id, runId);
  } catch (_) {
    res = { ok: false, error: 'The cell could not be run.' };
  }
  if (nbDoc !== doc) return false;
  nbRunning.delete(id);
  if (!res) res = { ok: false, error: 'The cell could not be run.' };
  if (!res.cancelled) res.exec = ++nbExecSeq;
  nbResults.set(id, res);
  nbRenderResult(id);
  nbPaintStates();
  // A new table changes what the cells reading it can offer: a chart's column
  // pickers, a formula's column chips.
  if (res.ok && (c.kind === 'sql' || c.kind === 'formula')) {
    for (const d of doc.cells) {
      if (d.kind === 'chart' && d.sourceCellId === id) nbRebuildBody(d.id);
      if (d.kind === 'formula' && nbFormulaInput(d.id) === id) nbRebuildBody(d.id);
    }
  }
  return !!res.ok;
}

/** Run every cell from `id` down, in order, stopping at the first that fails. */
async function nbRunFrom(id: string | null): Promise<void> {
  if (!nbDoc || nbBatchRunning) return;
  const start = id ? nbDoc.cells.findIndex((c) => c.id === id) : 0;
  if (start < 0) return;
  nbBatchRunning = true;
  const btn = nbEl<HTMLButtonElement>('nb-run-all');
  if (btn) { btn.disabled = true; iconLabel(btn, 'loader', 'Running…'); }
  const doc = nbDoc;
  try {
    for (const c of doc.cells.slice(start)) {
      if (nbDoc !== doc) return;
      if (c.kind === 'param') continue;
      const ok = await nbRunCell(c.id);
      if (!ok) {
        const r = nbResults.get(c.id);
        if (r && !r.cancelled) showToast(`Stopped at ${nbCellName(c.id)} — it did not run.`, { kind: 'error' });
        nbFocusCell(c.id, true, true);
        return;
      }
    }
  } finally {
    nbBatchRunning = false;
    if (btn) { btn.disabled = false; iconLabel(btn, 'play', 'Run all'); }
  }
}

async function nbRunAll(): Promise<void> {
  if (nbDoc && nbDoc.cells.length) await nbRunFrom(nbDoc.cells[0].id);
}

function nbCancel(id: string): void {
  const runId = nbRunning.get(id);
  if (runId) void window.hubNotebooks.cancel(runId);
}

// ── The result area ──────────────────────────────────────────────────────────

function nbStatusText(r: NbResult, kind: string): string {
  const n = Number(r.rowCount) || 0;
  const rows = r.truncated ? `${n.toLocaleString('en-US')}+ rows` : `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`;
  return `${kind === 'chart' ? 'Charted ' : ''}${rows} · ${Number(r.elapsedMs) || 0} ms`;
}

function nbRenderResult(id: string): void {
  const sec = nbCellEl(id);
  const out = sec ? (sec.querySelector('.nb-out') as HTMLElement | null) : null;
  const c = nbCell(id);
  if (!out || !c) return;
  const old = nbChartInstances.get(id);
  if (old) { try { old.destroy(); } catch (_) { /* gone */ } nbChartInstances.delete(id); }
  out.textContent = '';
  out.hidden = false;

  if (nbRunning.has(id)) {
    const bar = document.createElement('div');
    bar.className = 'nb-out-bar is-running';
    const st = document.createElement('span');
    st.className = 'nb-status';
    st.append(icon('loader', 14), Object.assign(document.createElement('span'), { textContent: 'Running…' }));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-ghost nb-cancel';
    iconLabel(cancel, 'x', 'Cancel');
    cancel.addEventListener('click', () => nbCancel(id));
    bar.append(st, cancel);
    out.appendChild(bar);
    return;
  }
  const r = nbResults.get(id);
  if (!r) { out.hidden = true; return; }
  if (r.cancelled) {
    const p = document.createElement('p');
    p.className = 'nb-out-note';
    p.textContent = 'Cancelled — run it again to see a result.';
    out.appendChild(p);
    return;
  }
  if (!r.ok) {
    const box = document.createElement('div');
    box.className = 'qt-error nb-error';
    box.setAttribute('role', 'alert');
    const ic = document.createElement('span');
    ic.className = 'qt-error-icon';
    ic.appendChild(icon('alert', 16));
    const body = document.createElement('div');
    body.className = 'qt-error-body';
    body.append(
      Object.assign(document.createElement('p'), { className: 'qt-error-h', textContent: 'The cell did not run' }),
      Object.assign(document.createElement('p'), { className: 'qt-error-msg', textContent: r.error || 'It failed.' }),
    );
    box.append(ic, body);
    out.appendChild(box);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'nb-out-bar';
  const st = document.createElement('span');
  st.className = 'nb-status';
  st.textContent = nbStatusText(r, c.kind);
  const note = document.createElement('span');
  note.className = 'nb-out-meta';
  const cols = (r.columns || []).length;
  note.textContent = [
    c.kind !== 'chart' ? `${cols} ${cols === 1 ? 'column' : 'columns'}` : '',
    r.truncated ? 'showing the first 500 — Save as dataset keeps them all' : '',
    r.cached ? 'from cache' : '',
  ].filter(Boolean).join(' · ');
  const gap = document.createElement('span');
  gap.className = 'nb-cell-gap';
  bar.append(st, note, gap);
  if (c.kind === 'chart') {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'btn btn-sm nb-pin';
    iconLabel(pin, 'layout-dashboard', 'Pin to dashboard');
    pin.addEventListener('click', () => { void nbPinChart(id); });
    bar.appendChild(pin);
  } else {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-sm nb-save';
    iconLabel(save, 'database', 'Save as dataset');
    save.disabled = cols === 0;
    save.addEventListener('click', () => { void nbSaveAsDataset(id); });
    bar.appendChild(save);
  }
  out.appendChild(bar);

  if (c.kind === 'chart' && r.chart) {
    const wrap = document.createElement('div');
    wrap.className = 'nb-chart';
    // Linked hover (linkedHover.ts): two chart cells over the same cell and category light together.
    if (c.encoding && c.encoding.category) wrap.dataset.lhField = `nb:${c.sourceCellId}|${c.encoding.category}`;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${(VIZ_LABELS as any)[r.chart.chartType] || 'Chart'} of ${nbCellName(c.sourceCellId || '')}`);
    wrap.appendChild(canvas);
    out.appendChild(wrap);
    const chart = buildChart(canvas, r.chart.data, r.chart.chartType, {});
    if (chart) nbChartInstances.set(id, chart);
    else {
      wrap.remove();
      out.appendChild(Object.assign(document.createElement('p'), { className: 'nb-out-note', textContent: 'Nothing to draw — the chart has no values.' }));
    }
  } else if (c.kind !== 'chart') {
    const grid = document.createElement('div');
    grid.className = 'ds-table-scroll cw-grid nb-grid-scroll';
    grid.appendChild(qtFormatNumbers(cwBuildTable(r.columns || [], r.rows || []), r.columns || []));
    out.appendChild(grid);
  }
  for (const w of (r.warnings || []).slice(0, 3)) {
    const p = document.createElement('p');
    p.className = 'nb-out-warn';
    p.append(icon('info', 14), Object.assign(document.createElement('span'), { textContent: w }));
    out.appendChild(p);
  }
}
