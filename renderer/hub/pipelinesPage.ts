'use strict';

// The Data page's PIPELINES tab — every scheduled or dependent thing in the
// project as one DAG, with its schedule, retry policy and Run all. Classic
// global-scope renderer <script>: no import/export.
//
// Main builds the graph and every figure on it (src/app/pipelineView.ts); this
// file paints the head, the empty state and the loop refusal, and owns the
// page's state. The graph is pipelinesGraph.ts, the selected step's panel —
// its own schedule, Run from here, Pause, and run history — pipelinesDetail.ts.

let pqView: any = null;
let pqSel: string | null = null;
let pqSeq = 0;
let pqRunning = false;
let pqCronOpen = false;
let pqLive: Record<string, string> = {};

const PQ_PRESETS: Array<[string, string]> = [
  [t('pipelinesPage.hourly'), '0 * * * *'],
  [t('pipelinesPage.daily_06_00'), '0 6 * * *'],
  [t('pipelinesPage.weekdays_07_00'), '0 7 * * 1-5'],
  [t('pipelinesPage.mondays_09_00'), '0 9 * * 1'],
];

function pqEl(tag: string, cls?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function pqBtn(label: string, cls: string, onClick: () => void, ic?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  if (ic) b.appendChild(icon(ic, 16));
  b.appendChild(pqEl('span', '', label));
  b.addEventListener('click', onClick);
  return b;
}

/** "5 min ago", "in 3 h", "just now". */
function pqRel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = Date.parse(iso) - Date.now();
  const a = Math.abs(d);
  if (a < 60_000) return d > 0 ? t('pipelinesPage.in_under_a_minute') : t('common.just_now');
  const [n, u] = a < 3_600_000 ? [Math.round(a / 60_000), 'min'] : a < 86_400_000 ? [Math.round(a / 3_600_000), 'h'] : [Math.round(a / 86_400_000), a < 2 * 86_400_000 ? 'day' : 'days'];
  return d > 0 ? `in ${n} ${u}` : `${n} ${u} ago`;
}

function pqAbs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function pqDur(ms: number | undefined): string {
  if (typeof ms !== 'number') return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return t('pipelinesPage.min_s', { p0: Math.floor(ms / 60_000), p1: Math.round((ms % 60_000) / 1000) });
}

async function pqLoad(): Promise<void> {
  const seq = ++pqSeq;
  const pid = currentProjectId;
  let v: any = null;
  try { v = pid ? await window.hubPipelines.get(pid) : null; } catch (_) { v = null; }
  if (seq !== pqSeq || pid !== currentProjectId) return;
  pqView = v;
  if (v && v.live) pqLive = v.live;
  if (v && v.ok && pqSel && !v.nodes.some((n: any) => n.id === pqSel)) pqSel = null;
  pqRender();
}

/** The tab's entry point (captureList.clSelectTab). */
async function pqOpen(): Promise<void> {
  const wrap = document.getElementById('pq-wrap');
  if (wrap && !pqView) {
    wrap.textContent = '';
    wrap.appendChild(pqEl('p', 'dsp-note', t('pipelinesPage.reading_the_pipeline')));
  }
  await pqLoad();
}

function pqRender(): void {
  const wrap = document.getElementById('pq-wrap');
  if (!wrap) return;
  const keepScroll = (wrap.querySelector('.pq-graph') as HTMLElement | null)?.scrollLeft || 0;
  wrap.textContent = '';
  const v = pqView;
  if (!v) {
    wrap.appendChild(makeEmptyState({ variant: 'page', iconName: 'alert', title: t('pipelinesPage.could_not_read_the_pipeline'), line: t('pipelinesPage.something_went_wrong_reading_this'), actionLabel: t('inputPage.try_again'), onAction: () => void pqLoad() }));
    return;
  }
  if (!v.ok) {
    const box = makeEmptyState({ variant: 'page', iconName: 'lineage', title: t('pipelinesPage.this_pipeline_has_a_loop'), line: t('pipelinesPage.nothing_runs_until_one_of_them', { error: v.error }) });
    const chain = pqEl('p', 'pq-cycle', (v.cycle || []).join('  →  ') + (v.cycle && v.cycle.length ? '  →  ' + v.cycle[0] : ''));
    box.appendChild(chain);
    wrap.appendChild(box);
    return;
  }
  wrap.appendChild(pqHead(v));
  if (pqCronOpen) wrap.appendChild(pqCronEditor(v));
  if (!v.nodes.length) {
    wrap.appendChild(pqEmpty(v));
    return;
  }
  const graph = pqGraph(v);
  wrap.appendChild(graph);
  graph.scrollLeft = keepScroll;
  wrap.appendChild(pqDetail(v));
  requestAnimationFrame(() => pqDrawEdges());
}

/** The strip over the graph: the pipeline's schedule, retry policy, Run all, and its numbers. */
function pqHead(v: any): HTMLElement {
  const head = pqEl('div', 'pq-head');
  const sched = pqEl('div', 'pq-sched');
  const mark = pqEl('span', 'pq-sched-ic');
  mark.appendChild(icon('calendar', 16));
  const txt = pqEl('div', 'pq-sched-text');
  const s = v.schedule;
  txt.appendChild(pqEl('span', 'pq-label', t('pipelinesPage.pipeline_schedule')));
  txt.appendChild(pqEl('strong', 'pq-sched-main', s ? s.text + (s.paused ? t('pipelinesPage.paused') : '') : t('pipelinesPage.not_scheduled')));
  txt.appendChild(pqEl('span', 'pq-sched-sub', s
    ? (s.paused ? t('pipelinesPage.times_in_paused_nothing_runs_on', { tz: s.tz }) : t('pipelinesPage.times_in_next_run', { tz: s.tz, p1: s.nextRunAt ? pqAbs(s.nextRunAt) + ' (' + pqRel(s.nextRunAt) + ')' : 'never' }))
    : t('pipelinesPage.run_every_step_on_one_schedule')));
  sched.append(mark, txt);
  const sActs = pqEl('div', 'pq-sched-acts');
  sActs.appendChild(pqBtn(s ? t('common.edit_2') : t('pipelinesPage.set_a_schedule'), 'btn-sm btn-ghost', () => { pqCronOpen = !pqCronOpen; pqRender(); }));
  if (s) sActs.appendChild(pqBtn(s.paused ? t('common.resume') : t('common.pause'), 'btn-sm btn-ghost', () => void pqSetSchedule({ paused: !s.paused })));
  sched.appendChild(sActs);

  const retry = pqEl('label', 'pq-field');
  retry.appendChild(pqEl('span', 'pq-label', t('pipelinesPage.on_failure')));
  const rSel = document.createElement('select');
  rSel.className = 'pq-select';
  rSel.id = 'pq-retries';
  [t('pipelinesPage.stop_no_retries'), t('pipelinesPage.retry_once'), t('pipelinesPage.retry_twice'), t('pipelinesPage.retry_3_times')].forEach((t, i) => rSel.appendChild(new Option(t, String(i))));
  rSel.value = String(v.policy.retries);
  const bSel = document.createElement('select');
  bSel.className = 'pq-select';
  bSel.id = 'pq-backoff';
  bSel.setAttribute('aria-label', t('pipelinesPage.first_wait_before_a_retry'));
  [[10_000, t('pipelinesPage.after_10_s')], [30_000, t('pipelinesPage.after_30_s')], [60_000, t('pipelinesPage.after_1_min')], [300_000, t('pipelinesPage.after_5_min')]].forEach(([ms, lbl]) => bSel.appendChild(new Option(t('pipelinesPage.doubling', { t: lbl }), String(ms))));
  if (![...bSel.options].some((o) => o.value === String(v.policy.backoffMs))) {
    bSel.appendChild(new Option(t('pipelinesPage.after_s_doubling', { p0: Math.round(v.policy.backoffMs / 1000) }), String(v.policy.backoffMs)));
  }
  bSel.value = String(v.policy.backoffMs);
  bSel.disabled = v.policy.retries === 0;
  const savePolicy = (): void => void pqSavePolicy(Number(rSel.value), Number(bSel.value));
  rSel.addEventListener('change', savePolicy);
  bSel.addEventListener('change', savePolicy);
  const pickers = pqEl('div', 'pq-field-row');
  pickers.append(rSel, bSel);
  retry.appendChild(pickers);

  const run = pqBtn(pqRunning ? t('common.running') : t('common.run_all'), 'btn-primary', () => void pqRun(), 'play');
  run.id = 'pq-run-all';
  run.disabled = pqRunning || !v.nodes.length;

  head.append(sched, retry, run);

  // The numbers: what the graph holds and how it last went.
  const stats = pqEl('div', 'pq-stats');
  const nodes: any[] = v.nodes;
  const scheduled = nodes.filter((n) => n.schedule.edit && !/^(Manual|Typed)/.test(n.schedule.text)).length;
  const failed = nodes.filter((n) => n.lastRun && (n.lastRun.status === 'failed' || n.lastRun.status === 'blocked')).length;
  const lastRuns = nodes.map((n) => n.lastRun && n.lastRun.at).filter(Boolean).sort();
  const chip = (ic: string, text: string, cls = ''): void => {
    const c = pqEl('span', 'pq-stat' + (cls ? ' ' + cls : ''));
    c.appendChild(icon(ic, 14));
    c.appendChild(pqEl('span', '', text));
    stats.appendChild(c);
  };
  chip('layers', t('pipelinesPage.in_stages', { nodesCount: nodes.length, p2: new Set(nodes.map((n) => n.stage)).size }));
  chip('calendar', scheduled ? t('pipelinesPage.on_their_own_schedule', { scheduled }) : t('pipelinesPage.no_step_has_its_own_schedule'));
  if (failed) chip('alert', t('pipelinesPage.failed_or_blocked_last_time', { failed }), 'is-bad');
  else if (lastRuns.length) chip('circle-check', t('pipelinesPage.everything_ran_cleanly_last_time'), 'is-good');
  chip('history', lastRuns.length ? t('pipelinesPage.last_activity', { p0: pqRel(lastRuns[lastRuns.length - 1]) }) : t('common.never_run'));
  const wrap = pqEl('div', 'pq-headwrap');
  wrap.appendChild(head);
  if (nodes.length) wrap.appendChild(stats); // an empty pipeline has no numbers to tell
  return wrap;
}

/** The pipeline cron editor: an expression, presets, and the next three runs it names. */
function pqCronEditor(v: any): HTMLElement {
  const box = pqEl('div', 'pq-cron');
  const s = v.schedule;
  const tz = s ? s.tz : v.tz;
  const row = pqEl('div', 'pq-cron-row');
  const input = document.createElement('input');
  input.className = 'pq-input pq-cron-input';
  input.id = 'pq-cron-input';
  input.spellcheck = false;
  input.placeholder = t('pipelinesPage.minute_hour_day_month_weekday_e');
  input.setAttribute('aria-label', t('pipelinesPage.schedule_as_five_cron_fields'));
  input.value = s ? s.cron : '0 6 * * *';
  const presets = pqEl('div', 'pq-presets');
  for (const [label, expr] of PQ_PRESETS) {
    const c = pqEl('button', 'chip', label) as HTMLButtonElement;
    c.type = 'button';
    c.addEventListener('click', () => { input.value = expr; void paint(); });
    presets.appendChild(c);
  }
  row.append(input, presets);
  const out = pqEl('div', 'pq-cron-preview');
  out.setAttribute('aria-live', 'polite');
  const save = pqBtn(t('pipelinesPage.save_schedule'), 'btn-sm btn-primary', () => void pqSetSchedule({ cron: input.value, tz }).then((ok) => { if (ok) { pqCronOpen = false; void pqLoad(); } }));
  save.id = 'pq-cron-save';
  const paint = async (): Promise<void> => {
    const p = await window.hubPipelines.preview(input.value, tz).catch(() => null);
    out.textContent = '';
    if (!p || !p.ok) {
      out.appendChild(pqEl('span', 'pq-cron-bad', t('pipelinesPage.five_fields_minute_0_59_hour')));
      save.disabled = true;
      return;
    }
    save.disabled = false;
    out.appendChild(pqEl('strong', '', p.text));
    out.appendChild(pqEl('span', '', t('pipelinesPage.times_in_next', { tz, p1: p.next.map(pqAbs).join(', ') })));
  };
  input.addEventListener('input', () => void paint());
  const acts = pqEl('div', 'pq-cron-acts');
  acts.appendChild(save);
  if (s) acts.appendChild(pqBtn(t('pipelinesPage.remove_schedule'), 'btn-sm btn-ghost', () => void pqSetSchedule({ cron: null }).then(() => { pqCronOpen = false; void pqLoad(); })));
  acts.appendChild(pqBtn(t('common.cancel'), 'btn-sm btn-ghost', () => { pqCronOpen = false; pqRender(); }));
  box.append(row, out, acts);
  void paint();
  return box;
}

/** No pipeline yet: the six stages, empty, under what will fill them. */
function pqEmpty(v: any): HTMLElement {
  const box = pqEl('div', 'pq-empty');
  const cols = pqEl('div', 'pq-cols pq-cols--ghost');
  cols.setAttribute('aria-hidden', 'true');
  for (const name of v.stages) {
    const col = pqEl('div', 'pq-col');
    col.appendChild(pqEl('div', 'pq-col-h', name));
    for (let i = 0; i < 2; i++) col.appendChild(pqEl('div', 'pq-ghost'));
    cols.appendChild(col);
  }
  const msg = makeEmptyState({
    variant: 'page', iconName: 'lineage', title: t('pipelinesPage.nothing_runs_on_its_own_yet'),
    line: t('pipelinesPage.connect_a_database_or_a_folder'),
    actionLabel: t('common.connect_data'), onAction: () => { clSelectTab('datasets'); (document.getElementById('ds-connect-open') as HTMLElement | null)?.click(); },
  });
  msg.classList.add('pq-empty-msg');
  box.append(cols, msg);
  return box;
}

async function pqSetSchedule(patch: { cron?: string | null; tz?: string; paused?: boolean }): Promise<boolean> {
  if (!currentProjectId) return false;
  const r = await window.hubPipelines.setSchedule(currentProjectId, patch).catch(() => null);
  if (!r || !r.ok) { showToast((r && r.error) || t('common.could_not_save_the_schedule'), { kind: 'error' }); return false; }
  if (patch.paused !== undefined) await pqLoad();
  return true;
}

async function pqSavePolicy(retries: number, backoffMs: number): Promise<void> {
  if (!currentProjectId) return;
  const r = await window.hubPipelines.setPolicy(currentProjectId, { retries, backoffMs }).catch(() => null);
  if (!r || !r.ok) showToast(t('pipelinesPage.could_not_save_the_retry_policy'), { kind: 'error' });
  await pqLoad();
}

/** Run a step and everything after it — or, with no step, the whole pipeline. */
async function pqRun(nodeId?: string): Promise<void> {
  const pid = currentProjectId;
  if (!pid || pqRunning) return;
  pqRunning = true;
  pqRender();
  let r: any = null;
  try { r = await window.hubPipelines.run(pid, nodeId); } catch (_) { r = null; }
  pqRunning = false;
  pqLive = {};
  if (!r || !r.ok) showToast((r && r.error) || t('pipelinesPage.the_pipeline_could_not_run'), { kind: 'error' });
  else {
    const failed = r.outcomes.filter((o: any) => o.status === 'failed').length;
    const blocked = r.outcomes.filter((o: any) => o.status === 'blocked').length;
    showToast(failed
      ? t('pipelinesPage.failed_an_alert_was_raised', { failed, p2: blocked ? t('pipelinesPage.stopped_after', { blocked, failed }) : '' })
      : t('pipelinesPage.pipeline_ran_done', { outcomesCount: r.outcomes.length }), { kind: failed ? 'error' : 'success' });
  }
  if (pid === currentProjectId) await pqLoad();
}

(function initPipelinesPage(): void {
  const tab = document.getElementById('ds-tab-pipelines');
  if (tab) tab.addEventListener('click', () => clSelectTab('pipelines'));
  let t: ReturnType<typeof setTimeout> | null = null;
  if (window.hubPipelines) {
    window.hubPipelines.onChanged((o) => {
      if (!o || o.projectId !== currentProjectId) return;
      pqLive = o.live || {};
      const wrap = document.getElementById('pq-wrap');
      if (!wrap || wrap.hidden) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; void pqLoad(); }, 150);
    });
  }
  window.addEventListener('resize', () => { if (pqView && pqView.ok) pqDrawEdges(); });
})();
