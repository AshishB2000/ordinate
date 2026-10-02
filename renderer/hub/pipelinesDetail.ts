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
    hint.appendChild(pqEl('span', '', t('pipelinesDetail.select_a_step_to_change_its')));
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
  id.appendChild(pqEl('span', 'pq-detail-sub', t('pipelinesDetail.stage', { p0: n.stage === 2 ? t('pipelinesDetail.derived_dataset') : kind.word, p1: v.stages[n.stage], p2: !!(n.paused) })));
  const acts = pqEl('div', 'pq-detail-acts');
  const run = pqBtn(pqRunning ? t('common.running') : t('pipelinesDetail.run_from_here'), 'btn-sm', () => void pqRun(n.id), 'play');
  run.id = 'pq-run-node';
  run.disabled = pqRunning;
  run.title = t('pipelinesDetail.runs_this_step_then_everything_after');
  const pause = pqBtn(n.paused ? t('common.resume') : t('common.pause'), 'btn-sm btn-ghost', () => void pqPause(n.id, !n.paused));
  pause.id = 'pq-pause-node';
  pause.title = n.paused ? t('pipelinesDetail.run_this_step_again_in_pipeline') : t('pipelinesDetail.step_over_this_step_in_pipeline');
  acts.append(run, pause);
  if (n.ref) acts.appendChild(pqBtn(t('common.open'), 'btn-sm btn-ghost', () => void pqOpenRecord(n), 'external-link'));
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
  box.appendChild(pqEl('h4', 'pq-box-h', t('common.schedule')));
  const facts = pqEl('dl', 'pq-facts');
  const fact = (k: string, val: string): void => { facts.append(pqEl('dt', '', k), pqEl('dd', '', val)); };
  fact(t('pipelinesDetail.own_schedule'), n.schedule.text);
  fact(t('pipelinesDetail.next_run'), n.nextRunAt ? `${pqAbs(n.nextRunAt)} (${Date.parse(n.nextRunAt) <= Date.now() ? t('common.on_the_next_check') : pqRel(n.nextRunAt)})` : t('pipelinesDetail.nothing_planned'));
  fact(t('pipelinesDetail.last_run'), n.lastRun ? `${pqAbs(n.lastRun.at)} · ${(PQ_STATUS[n.lastRun.status] || PQ_STATUS.never).word}${n.lastRun.durationMs !== undefined ? ' · ' + pqDur(n.lastRun.durationMs) : ''}` : t('html.never'));
  box.appendChild(facts);

  const sch = n.schedule;
  if (sch.edit === 'dataset') {
    const sel = document.createElement('select');
    sel.className = 'pq-select';
    sel.id = 'pq-node-every';
    sel.setAttribute('aria-label', t('commandDefs.refresh_this_dataset'));
    [['off', t('pipelinesDetail.manual_no_refresh_schedule')], ['hourly', t('pipelinesDetail.refresh_hourly')], ['daily', t('pipelinesDetail.refresh_daily')], ['weekly', t('pipelinesDetail.refresh_weekly')]]
      .forEach(([val, t]) => sel.appendChild(new Option(t, val)));
    sel.value = sch.every || 'off';
    sel.addEventListener('change', () => void pqSetNode(n.id, { every: sel.value }));
    box.append(sel, pqEl('p', 'pq-note', t('pipelinesDetail.saved_on_the_dataset_the_same')));
  } else if (sch.edit === 'report') {
    const row = pqEl('div', 'pq-field-row');
    const cad = document.createElement('select');
    cad.className = 'pq-select';
    cad.id = 'pq-node-cadence';
    cad.setAttribute('aria-label', t('pipelinesDetail.how_often_the_report_is_written'));
    [['off', t('pipelinesDetail.manual')], ['daily', t('settingsBackups.daily')], ['weekly', t('common.weekly')], ['monthly', t('common.monthly')]].forEach(([val, t]) => cad.appendChild(new Option(t, val)));
    cad.value = sch.cadence || 'off';
    const at = document.createElement('input');
    at.type = 'time';
    at.className = 'pq-input pq-time';
    at.setAttribute('aria-label', t('common.at'));
    at.value = sch.at || '09:00';
    at.disabled = cad.value === 'off';
    const save = (): void => void pqSetNode(n.id, { cadence: cad.value, at: at.value });
    cad.addEventListener('change', save);
    at.addEventListener('change', save);
    row.append(cad, at);
    box.appendChild(row);
    box.appendChild(pqEl('p', 'pq-note', sch.hasFolder
      ? t('pipelinesDetail.saved_on_the_report_each_run')
      : t('pipelinesDetail.this_report_has_no_folder_yet')));
  } else {
    box.appendChild(pqEl('p', 'pq-note', n.kind === 'source'
      ? t('pipelinesDetail.a_source_has_nothing_to_run')
      : t('pipelinesDetail.this_step_runs_after_its_inputs')));
  }
  return box;
}

/** The last 50 runs, newest first; a row opens its log in place. */
function pqHistory(n: any): HTMLElement {
  const box = pqEl('div', 'pq-box pq-box--history');
  const h = pqEl('h4', 'pq-box-h', t('pipelinesDetail.run_history'));
  h.appendChild(pqEl('span', 'pq-col-n', String(n.runs.length)));
  box.appendChild(h);
  if (!n.runs.length) {
    box.appendChild(pqEl('p', 'pq-note', t('pipelinesDetail.no_pipeline_runs_yet_run_from')));
    return box;
  }
  const table = pqEl('div', 'pq-runs');
  table.id = 'pq-runs';
  const headRow = pqEl('div', 'pq-run pq-run--head');
  headRow.setAttribute('aria-hidden', 'true');
  for (const tv of [t('common.when'), t('pipelinesDetail.trigger'), t('common.status'), t('metricEditor.duration'), t('common.rows'), t('pipelinesDetail.tries')]) headRow.appendChild(pqEl('span', '', tv));
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
    row.append(pqEl('span', '', pqAbs(r.startedAt)), pqEl('span', '', r.trigger === 'schedule' ? t('common.schedule') : t('pipelinesDetail.run_now')), status,
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
  line('history', t('pipelinesDetail.started_finished', { p0: new Date(r.startedAt).toLocaleString(), p1: new Date(r.finishedAt).toLocaleTimeString(), p2: r.attempts > 1 ? t('pipelinesDetail.attempts', { attempts: r.attempts }) : '' }), 'is-info');
  if (typeof r.rows === 'number') {
    line('table', typeof r.rowsBefore === 'number'
      ? t('pipelinesDetail.rows_before_after', { p0: r.rowsBefore.toLocaleString(), p1: r.rows.toLocaleString(), p2: !!(r.rows - r.rowsBefore >= 0), p3: (r.rows - r.rowsBefore).toLocaleString() })
      : `${r.rows.toLocaleString()} rows`, 'is-info');
  }
  if (r.note) line('info', r.note, 'is-info');
  for (const w of r.warnings || []) line('alert', w, 'is-warn');
  for (const e of r.errors || []) line('alert', e, 'is-error');
  if (!r.note && !(r.warnings || []).length && !(r.errors || []).length && typeof r.rows !== 'number') line('circle-check', t('pipelinesDetail.nothing_else_to_report'), 'is-info');
  return log;
}

async function pqPause(nodeId: string, paused: boolean): Promise<void> {
  if (!currentProjectId) return;
  const r = await window.hubPipelines.setPaused(currentProjectId, nodeId, paused).catch(() => null);
  if (!r || !r.ok) showToast(t('pipelinesDetail.could_not_save'), { kind: 'error' });
  await pqLoad();
}

async function pqSetNode(nodeId: string, patch: { every?: string; cadence?: string; at?: string }): Promise<void> {
  if (!currentProjectId) return;
  const r = await window.hubPipelines.setNodeSchedule(currentProjectId, nodeId, patch).catch(() => null);
  if (!r || !r.ok) showToast((r && r.error) || t('common.could_not_save_the_schedule'), { kind: 'error' });
  await pqLoad();
}
