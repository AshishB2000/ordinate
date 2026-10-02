// The Assistant's plan card — "import sales.csv, clean it, and build me a
// regional dashboard" as numbered steps the user runs. Classic global-scope
// renderer <script>: NO import/export. Loads after dockPropose.js (dkProposalCard,
// dkMkBtn, dkAppendProposal, dkRemoveProposalCard), askCore.js (xpAppendBubble),
// icons.js, prepare.js (stepSummaryText) and lineagePanel.js (lnOpenNode); all
// reached at call time. The edit mode's fields live in planEdit.ts.
//
// Main owns every decision (src/ipc/plan.ts): the steps were checked there
// before this card is drawn, each is checked again right before it runs, and
// every figure under a step — rows before and after, a KPI — is app-computed.
// Nothing runs without a click: Run all, Step through, Fix, Skip, Stop, Undo.

interface PlState {
  card: HTMLElement;
  body: HTMLElement;
  containerId: string;
  intent: string;
  threadId: string;
  steps: any[];
  checks: any[];
  lines: any[];
  dropped: number;
  snap: any; // ponytail: main's run snapshot (src/ipc/plan.ts), null until the run starts
  editing: boolean;
  busy: boolean;
  stopAsked: boolean;
  /** Run all keeps going after a Skip; Step through pauses. */
  all: boolean;
  note: string;
}

/** Cards whose run has started — they outlive the next question, so Undo stays reachable. */
const plLive: PlState[] = [];

const PL_STATUS_TEXT: Record<string, string> = {
  pending: t('planCard.pending'), running: t('common.running'), done: t('common.done'), skipped: t('planCard.skipped'), failed: t('common.failed'),
};

/** Entry point from dkOfferProposal (dockPropose.ts) for a 'plan' action. Silent if nothing survives the check. */
async function dkOfferPlanProposal(action: any, threadId: string, containerId = 'dk-messages'): Promise<void> {
  if (!currentProjectId || !window.hubPlan) return;
  let res: any;
  try { res = await window.hubPlan.check(currentProjectId, action && action.steps); } catch (_) { return; }
  if (!res || !res.ok || !Array.isArray(res.steps) || !res.steps.length) return;
  const { card } = dkProposalCard(t('common.plan', { stepsCount: res.steps.length }));
  card.classList.add('pl-card');
  const body = document.createElement('div');
  body.className = 'pl-body';
  card.appendChild(body);
  const st: PlState = {
    card, body, containerId,
    intent: String((action && action.intent) || ''),
    threadId: threadId || '',
    steps: res.steps, checks: res.checks || [], lines: res.lines || [],
    dropped: Number(res.dropped || 0) + Number((action && action.droppedSteps) || 0),
    snap: null, editing: false, busy: false, stopAsked: false, all: false, note: '',
  };
  plRender(st);
  dkAppendProposal(card, containerId);
}

/** Keep started plans at the bottom of the conversation after a new answer lands. */
function plReattach(containerId = 'dk-messages'): void {
  const list = document.getElementById(containerId);
  if (!list) return;
  plLive.forEach((st) => { if (st.card.isConnected && st.containerId === containerId) list.appendChild(st.card); });
}

function plEl(tag: string, cls: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The one line a step shows. A prepare step uses Prepare's own summariser. */
function plLineText(st: PlState, i: number): string {
  const s = st.steps[i];
  if (s && s.kind === 'step' && typeof stepSummaryText === 'function') {
    try { return stepSummaryText(s.step) + (s.dataset ? t('planCard.in', { dataset: s.dataset }) : ''); } catch (_) { /* fall through */ }
  }
  const lines = st.snap ? st.snap.lines : st.lines;
  return lines && lines[i] ? String(lines[i].text) : t('planCard.step', { p0: (i + 1) });
}

function plStatusOf(st: PlState, i: number): string {
  return st.snap && Array.isArray(st.snap.status) ? String(st.snap.status[i]) : 'pending';
}

function plStepRow(st: PlState, i: number): HTMLElement {
  const status = plStatusOf(st, i);
  const li = plEl('li', 'pl-step is-' + status);
  const check = !st.snap ? st.checks[i] : null;
  if (check && check.ok === false) li.classList.add('is-invalid');

  li.appendChild(plEl('span', 'pl-num', String(i + 1)));
  const ic = plEl('span', 'pl-ic');
  const lines = st.snap ? st.snap.lines : st.lines;
  try { ic.appendChild(icon(lines && lines[i] ? lines[i].icon : 'circle', 15)); } catch (_) { /* no icon */ }
  li.appendChild(ic);

  const main = plEl('div', 'pl-main');
  main.appendChild(plEl('div', 'pl-line', plLineText(st, i)));
  if (check && check.ok === false) main.appendChild(plEl('div', 'pl-note is-error', String(check.error || t('planCard.this_step_cannot_run_as_it'))));
  else if (check && check.deferred) main.appendChild(plEl('div', 'pl-note', String(check.deferred)));
  if (st.snap && status === 'failed' && st.snap.errors[i]) main.appendChild(plEl('div', 'pl-note is-error', String(st.snap.errors[i])));
  const result = st.snap && st.snap.results ? st.snap.results[i] : null;
  if (result) main.appendChild(plResult(result));
  if (st.editing && typeof plEditFields === 'function') main.appendChild(plEditFields(st, i));
  li.appendChild(main);

  if (st.editing && typeof plEditControls === 'function') li.appendChild(plEditControls(st, i));
  else li.appendChild(plEl('span', 'pl-status is-' + status, PL_STATUS_TEXT[status] || status));
  return li;
}

/** What a step did: its summary, the record as a link, and any KPI the app computed. */
function plResult(r: any): HTMLElement {
  const box = plEl('div', 'pl-result');
  // A KPI chip already says what the summary would ("Revenue = 965"); the log keeps the sentence.
  const hasKpi = Array.isArray(r.kpis) && r.kpis.length > 0;
  if (!hasKpi) box.appendChild(plEl('span', 'pl-result-text', String(r.summary || t('common.done'))));
  if (hasKpi) {
    r.kpis.forEach((k: any) => {
      const chip = plEl('span', 'pl-kpi');
      chip.appendChild(plEl('span', 'pl-kpi-name', String(k.name)));
      chip.appendChild(plEl('span', 'pl-kpi-value', String(k.display)));
      box.appendChild(chip);
    });
  }
  if (r.link && r.link.id) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'pl-link';
    try { a.appendChild(icon('external-link', 13)); } catch (_) { /* text only */ }
    a.appendChild(document.createTextNode(String(r.link.name || t('common.open'))));
    a.title = t('planCard.open', { type: String(r.link.type) });
    a.addEventListener('click', () => {
      if (typeof lnOpenNode === 'function') void lnOpenNode({ ref: { type: r.link.type, id: r.link.id }, name: r.link.name });
    });
    box.appendChild(a);
  }
  return box;
}

function plRender(st: PlState): void {
  st.body.textContent = '';
  if (st.intent) st.body.appendChild(plEl('div', 'ai-interp-body pl-intent', st.intent));
  if (st.dropped) {
    st.body.appendChild(plEl('div', 'pl-note is-error',
      t('planCard.of_the_assistant_s_plan_were', { dropped: st.dropped })));
  }
  const list = plEl('ol', 'pl-steps');
  st.steps.forEach((_s, i) => list.appendChild(plStepRow(st, i)));
  st.body.appendChild(list);

  const invalid = !st.snap ? st.checks.filter((c: any) => c && c.ok === false).length : 0;
  if (invalid && !st.editing) {
    st.body.appendChild(plEl('div', 'ai-interp-hint',
      t('planCard.will_fail_as_written_edit_or', { invalid })));
  }
  if (st.note) st.body.appendChild(plEl('div', 'ai-interp-hint pl-flash', st.note));
  st.body.appendChild(plActions(st));
}

function plBtn(label: string, primary: boolean, cb: () => void, disabled = false): HTMLButtonElement {
  const b = dkMkBtn(label, primary, cb);
  b.disabled = disabled;
  return b;
}

function plActions(st: PlState): HTMLElement {
  const row = plEl('div', 'dk-proposal-actions pl-actions');
  const snap = st.snap;
  const state = snap ? String(snap.state) : 'ready';

  if (st.busy) {
    row.appendChild(plBtn(st.stopAsked ? t('planCard.stopping_after_this_step') : t('planCard.stop_after_this_step'), false, () => {
      st.stopAsked = true;
      plRender(st);
    }, st.stopAsked));
    return row;
  }
  if (!snap) {
    if (st.editing) {
      row.appendChild(plBtn(t('planCard.done_editing'), true, () => { void plRecheck(st); }));
      return row;
    }
    row.appendChild(plBtn(t('common.run_all'), true, () => { void plGo(st, true); }));
    row.appendChild(plBtn(t('planCard.step_through'), false, () => { void plGo(st, false); }));
    row.appendChild(plBtn(t('common.edit_2'), false, () => { st.editing = true; st.note = ''; plRender(st); }));
    row.appendChild(plBtn(t('common.cancel'), false, () => dkRemoveProposalCard(st.card)));
    return row;
  }
  if (state === 'failed') {
    const i = Number(snap.next);
    row.classList.add('pl-fail');
    row.appendChild(plBtn(t('planCard.fix'), true, () => { void plFix(st, i); }));
    row.appendChild(plBtn(t('common.skip'), false, () => { void plSkip(st, i); }));
    row.appendChild(plBtn(t('planCard.stop'), false, () => { void plCall(st, () => window.hubPlan.stop(snap.runId)); }));
    return row;
  }
  if (state === 'paused' || state === 'ready') {
    row.appendChild(plBtn(t('planCard.run_step', { p0: (Number(snap.next) + 1) }), true, () => { void plGo(st, false); }));
    row.appendChild(plBtn(t('planCard.run_the_rest'), false, () => { void plGo(st, true); }));
    row.appendChild(plBtn(t('planCard.skip_it'), false, () => { void plCall(st, () => window.hubPlan.skip(snap.runId, Number(snap.next))); }));
    row.appendChild(plBtn(t('planCard.stop'), false, () => { void plCall(st, () => window.hubPlan.stop(snap.runId)); }));
    return row;
  }
  if (state === 'undone') {
    const u = snap.undo || { undone: 0, failed: [] };
    row.appendChild(plEl('span', 'ai-interp-hint', t('planCard.undone_put_back', { undone: u.undone, p2: (u.failed && u.failed.length ? t('planCard.could_not_be', { failedCount: u.failed.length }) : '.') })));
  } else if (snap.canUndo) {
    row.appendChild(plBtn(t('planCard.undo_run'), false, () => { void plCall(st, () => window.hubPlan.undo(snap.runId)); }));
  }
  row.appendChild(plBtn(t('common.done'), state !== 'undone', () => plDone(st)));
  return row;
}

function plDone(st: PlState): void {
  const at = plLive.indexOf(st);
  if (at >= 0) plLive.splice(at, 1);
  dkRemoveProposalCard(st.card);
}

/** Take a snapshot from main: redraw, log the run into the conversation, reload a restyled open dashboard. */
function plApply(st: PlState, snap: any): void {
  if (!snap || snap.ok === false) {
    st.note = (snap && snap.error) || t('planCard.that_did_not_work');
    if (snap && snap.runId) st.snap = snap;
    return;
  }
  st.snap = snap;
  if (Array.isArray(snap.steps)) st.steps = snap.steps;
  st.note = '';
  if (typeof snap.log === 'string' && snap.log) {
    xpAppendBubble('assistant', snap.log, undefined, st.containerId);
    // The bubble lands after the card; keep the card last so its buttons stay in view.
    plReattach(st.containerId);
  }
  const ran = typeof snap.ran === 'number' ? snap.ran : -1;
  const r = ran >= 0 && snap.results ? snap.results[ran] : null;
  if (r && r.link && r.link.type === 'dashboard' && dashCurrent && dashCurrent.id === r.link.id && typeof openAnalysis === 'function') {
    void openAnalysis(r.link.id); // main rewrote the open dashboard — show the saved one
  }
}

async function plCall(st: PlState, fn: () => Promise<any>): Promise<void> {
  if (st.busy) return;
  st.busy = true;
  plRender(st);
  let snap: any;
  try { snap = await fn(); } catch (_) { snap = { ok: false, error: t('planCard.that_did_not_work') }; }
  st.busy = false;
  plApply(st, snap);
  plRender(st);
}

/** Start the run if needed, then run one step — or keep going until it stops, fails or is stopped. */
async function plGo(st: PlState, all: boolean): Promise<void> {
  if (st.busy || !currentProjectId) return;
  if (!st.snap) {
    let started: any;
    try {
      started = await window.hubPlan.start(currentProjectId, st.threadId || (typeof dkThreadId === 'string' ? dkThreadId : ''), st.intent, st.steps);
    } catch (_) { started = null; }
    if (!started || !started.ok) { st.note = (started && started.error) || t('planCard.could_not_start_the_plan'); plRender(st); return; }
    st.snap = started;
    st.card.classList.add('pl-live');
    if (plLive.indexOf(st) < 0) plLive.push(st);
  }
  st.stopAsked = false;
  st.all = all;
  st.busy = true;
  for (;;) {
    const runId = st.snap.runId;
    // Show the step as running while main works on it.
    const i = Number(st.snap.next);
    if (i >= 0 && Array.isArray(st.snap.status)) st.snap.status[i] = 'running';
    plRender(st);
    let snap: any;
    try { snap = await window.hubPlan.next(runId); } catch (_) { snap = { ok: false, error: t('planCard.the_step_could_not_run') }; }
    plApply(st, snap);
    if (!all || st.stopAsked || !st.snap || st.snap.state !== 'paused') break;
  }
  st.busy = false;
  if (st.stopAsked && st.snap && st.snap.state === 'paused') {
    st.stopAsked = false;
    await plCall(st, () => window.hubPlan.stop(st.snap.runId));
    return;
  }
  plRender(st);
}

/** Skip the failed step, then carry on the way the run was going. */
async function plSkip(st: PlState, i: number): Promise<void> {
  if (!st.snap) return;
  await plCall(st, () => window.hubPlan.skip(st.snap.runId, i));
  if (st.all && st.snap && st.snap.state === 'paused') await plGo(st, true);
}

async function plFix(st: PlState, i: number): Promise<void> {
  if (st.busy || !st.snap) return;
  st.busy = true;
  st.note = t('planCard.asking_the_assistant_to_fix_step', { p0: (i + 1) });
  plRender(st);
  let res: any;
  try { res = await window.hubPlan.fix(st.snap.runId, i); } catch (_) { res = { ok: false, error: t('planCard.fix_failed') }; }
  st.busy = false;
  plApply(st, res);
  if (res && res.ok) {
    st.steps = res.steps;
    st.note = t('planCard.step_was_rewritten_and_passed_the', { p0: (i + 1) });
  }
  plRender(st);
}
