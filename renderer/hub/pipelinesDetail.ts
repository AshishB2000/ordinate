'use strict';

// The Pipelines tab's STEP PANEL — under the graph, for the selected step: its
// own schedule (written to the record's existing field), Run from here, Pause,
// and the last 50 runs with their logs inline. Classic global-scope script.

function pqDetail(v: any): HTMLElement {
  const panel = pqEl('section', 'pq-detail');
  panel.id = 'pq-detail';
  const n = pqSel ? v.nodes.find((x: any) => x.id === pqSel) : null;
  if (!n) {
    panel.classList.add('is-hint');
    const hint = pqEl('div', 'pq-hint');
    hint.appendChild(icon('lineage', 16));
    hint.appendChild(pqEl('span', '', 'Select a step to change its schedule, run it and everything after it, or read its run history. Hover one to trace its path.'));
    panel.appendChild(hint);
    return panel;
  }
  const kind = PQ_KIND[n.kind] || PQ_KIND.dataset;

  // Header: what it is, and the three things you do to it.
  const head = pqEl('div', 'pq-detail-head');
  const ic = pqEl('span', 'pq-node-ic');
  ic.appendChild(icon(pqIconFor(n), 16));
  const id = pqEl('div', 'pq-detail-id');
  id.appendChild(pqEl('h3', 'pq-detail-name', n.name));
  id.appendChild(pqEl('span', 'pq-detail-sub', `${n.stage === 2 ? 'Derived dataset' : kind.word} · ${v.stages[n.stage]} stage${n.paused ? ' · paused' : ''}`));
  const acts = pqEl('div', 'pq-detail-acts');
  const run = pqBtn(pqRunning ? 'Running…' : 'Run from here', 'btn-sm', () => void pqRun(n.id), 'play');
  run.id = 'pq-run-node';
  run.disabled = pqRunning;
  run.title = 'Runs this step, then everything after it, in order.';
  const pause = pqBtn(n.paused ? 'Resume' : 'Pause', 'btn-sm btn-ghost', () => void pqPause(n.id, !n.paused));
  pause.id = 'pq-pause-node';
  pause.title = n.paused ? 'Run this step again in pipeline runs.' : 'Step over this step in pipeline runs; what follows it still runs.';
  acts.append(run, pause);
  if (n.ref) acts.appendChild(pqBtn('Open', 'btn-sm btn-ghost', () => void pqOpenRecord(n), 'external-link'));
  head.append(ic, id, acts);
  panel.appendChild(head);

  const body = pqEl('div', 'pq-detail-body');
  body.append(pqScheduleBox(n), pqHistory(n));
  panel.appendChild(body);
  return panel;
}

async function pqOpenRecord(n: any): Promise<void> {
  await lnOpenNode({ kind: n.kind === 'quality' ? 'dataset' : n.kind, name: n.name, ref: n.ref });
  if (n.kind === 'quality') document.getElementById('ds-tab-quality')?.click();
}

/** The step's own schedule — editable where the record has one. */
function pqScheduleBox(n: any): HTMLElement {
  const box = pqEl('div', 'pq-box');
  box.appendChild(pqEl('h4', 'pq-box-h', 'Schedule'));
  const facts = pqEl('dl', 'pq-facts');
  const fact = (k: string, val: string): void => { facts.append(pqEl('dt', '', k), pqEl('dd', '', val)); };
  fact('Own schedule', n.schedule.text);
  fact('Next run', n.nextRunAt ? `${pqAbs(n.nextRunAt)} (${Date.parse(n.nextRunAt) <= Date.now() ? 'on the next check' : pqRel(n.nextRunAt)})` : 'Nothing planned');
  fact('Last run', n.lastRun ? `${pqAbs(n.lastRun.at)} · ${(PQ_STATUS[n.lastRun.status] || PQ_STATUS.never).word}${n.lastRun.durationMs !== undefined ? ' · ' + pqDur(n.lastRun.durationMs) : ''}` : 'Never');
  box.appendChild(facts);

  const sch = n.schedule;
  if (sch.edit === 'dataset') {
    const sel = document.createElement('select');
    sel.className = 'pq-select';
    sel.id = 'pq-node-every';
    sel.setAttribute('aria-label', 'Refresh this dataset');
    [['off', 'Manual — no refresh schedule'], ['hourly', 'Refresh hourly'], ['daily', 'Refresh daily'], ['weekly', 'Refresh weekly']]
      .forEach(([val, t]) => sel.appendChild(new Option(t, val)));
    sel.value = sch.every || 'off';
    sel.addEventListener('change', () => void pqSetNode(n.id, { every: sel.value }));
    box.append(sel, pqEl('p', 'pq-note', 'Saved on the dataset — the same schedule its Refresh menu sets.'));
  } else if (sch.edit === 'report') {
    const row = pqEl('div', 'pq-field-row');
    const cad = document.createElement('select');
    cad.className = 'pq-select';
    cad.id = 'pq-node-cadence';
    cad.setAttribute('aria-label', 'How often the report is written');
    [['off', 'Manual'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].forEach(([val, t]) => cad.appendChild(new Option(t, val)));
    cad.value = sch.cadence || 'off';
    const at = document.createElement('input');
    at.type = 'time';
    at.className = 'pq-input pq-time';
    at.setAttribute('aria-label', 'At');
    at.value = sch.at || '09:00';
    at.disabled = cad.value === 'off';
    const save = (): void => void pqSetNode(n.id, { cadence: cad.value, at: at.value });
    cad.addEventListener('change', save);
    at.addEventListener('change', save);
    row.append(cad, at);
    box.appendChild(row);
    box.appendChild(pqEl('p', 'pq-note', sch.hasFolder
      ? 'Saved on the report. Each run writes a file into the report’s folder.'
      : 'This report has no folder yet — open it and pick one in its schedule, so a run has somewhere to write.'));
  } else {
    box.appendChild(pqEl('p', 'pq-note', n.kind === 'source'
      ? 'A source has nothing to run: the datasets after it fetch from it.'
      : 'This step runs after its inputs — whenever they refresh, and in every pipeline run.'));
  }
  return box;
}

/** The last 50 runs, newest first; a row opens its log in place. */
function pqHistory(n: any): HTMLElement {
  const box = pqEl('div', 'pq-box pq-box--history');
  const h = pqEl('h4', 'pq-box-h', 'Run history');
  h.appendChild(pqEl('span', 'pq-col-n', String(n.runs.length)));
  box.appendChild(h);
  if (!n.runs.length) {
    box.appendChild(pqEl('p', 'pq-note', 'No pipeline runs yet. “Run from here” starts one; so does the pipeline schedule.'));
    return box;
  }
  const table = pqEl('div', 'pq-runs');
  table.id = 'pq-runs';
  const headRow = pqEl('div', 'pq-run pq-run--head');
  headRow.setAttribute('aria-hidden', 'true');
  for (const t of ['When', 'Trigger', 'Status', 'Duration', 'Rows', 'Tries']) headRow.appendChild(pqEl('span', '', t));
  table.appendChild(headRow);
  for (const r of n.runs) {
    const row = pqEl('button', 'pq-run') as HTMLButtonElement;
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    const s = PQ_STATUS[r.status] || PQ_STATUS.never;
    const pill = pqEl('span', 'pq-pill pq-pill--' + r.status);
    pill.appendChild(icon(s.icon, 12));
    pill.appendChild(pqEl('span', '', s.word));
    const status = pqEl('span');
    status.appendChild(pill);
    const rows = typeof r.rows === 'number'
      ? (typeof r.rowsBefore === 'number' && r.rowsBefore !== r.rows ? `${r.rowsBefore.toLocaleString()} → ${r.rows.toLocaleString()}` : r.rows.toLocaleString())
      : '—';
    row.append(pqEl('span', '', pqAbs(r.startedAt)), pqEl('span', '', r.trigger === 'schedule' ? 'Schedule' : 'Run now'), status,
      pqEl('span', '', r.status === 'ok' || r.status === 'failed' ? pqDur(r.durationMs) : '—'), pqEl('span', '', rows), pqEl('span', '', String(r.attempts || '—')));
    const log = pqLog(r);
    log.hidden = true;
    row.addEventListener('click', () => {
      log.hidden = !log.hidden;
      row.setAttribute('aria-expanded', String(!log.hidden));
    });
    table.append(row, log);
  }
  box.appendChild(table);
  return box;
}

function pqLog(r: any): HTMLElement {
  const log = pqEl('div', 'pq-log');
  const line = (ic: string, text: string, cls: string): void => {
    const l = pqEl('div', 'pq-log-line ' + cls);
    l.appendChild(icon(ic, 12));
    l.appendChild(pqEl('span', '', text));
    log.appendChild(l);
  };
  line('history', `Started ${new Date(r.startedAt).toLocaleString()} · finished ${new Date(r.finishedAt).toLocaleTimeString()}${r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}`, 'is-info');
  if (typeof r.rows === 'number') {
    line('table', typeof r.rowsBefore === 'number'
      ? `${r.rowsBefore.toLocaleString()} rows before, ${r.rows.toLocaleString()} after (${r.rows - r.rowsBefore >= 0 ? '+' : ''}${(r.rows - r.rowsBefore).toLocaleString()})`
      : `${r.rows.toLocaleString()} rows`, 'is-info');
  }
  if (r.note) line('info', r.note, 'is-info');
  for (const w of r.warnings || []) line('alert', w, 'is-warn');
  for (const e of r.errors || []) line('alert', e, 'is-error');
  if (!r.note && !(r.warnings || []).length && !(r.errors || []).length && typeof r.rows !== 'number') line('circle-check', 'Nothing else to report.', 'is-info');
  return log;
}

async function pqPause(nodeId: string, paused: boolean): Promise<void> {
  if (!currentProjectId) return;
  const r = await window.hubPipelines.setPaused(currentProjectId, nodeId, paused).catch(() => null);
  if (!r || !r.ok) showToast('Could not save.', { kind: 'error' });
  await pqLoad();
}

async function pqSetNode(nodeId: string, patch: { every?: string; cadence?: string; at?: string }): Promise<void> {
  if (!currentProjectId) return;
  const r = await window.hubPipelines.setNodeSchedule(currentProjectId, nodeId, patch).catch(() => null);
  if (!r || !r.ok) showToast((r && r.error) || 'Could not save the schedule.', { kind: 'error' });
  await pqLoad();
}
