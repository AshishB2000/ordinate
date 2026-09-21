'use strict';

// The alert INBOX: the top-bar bell, its popover of events, and the rules page.
// Classic global-scope <script>: no import/export. Loads after alerts.js, whose
// `alRules` / `alEvents` cache it fills and reads.
//
// WHY A BELL AND NOT A SECTION. An alert is not a place you go; it is something
// that happened while you were somewhere else. The unread count has to be
// visible from every surface, which is what the top bar is for — and the
// popover under it is the whole feature for anyone who never writes a second
// rule. The rules page is behind it (and behind Settings → Notifications),
// because managing rules is rare and reading what fired is not.
//
// EVERY NUMBER HERE ARRIVED COMPUTED. An event carries its own `value`,
// `previous` and `message` from main; the sparkline plots `rule.history`, which
// is the list of values main recorded at each evaluation. This file formats and
// draws. It does not compute, and no model is on this path — "Explain" is an
// explicit, optional button that starts an ordinary dock conversation.

/** Popover geometry. The design width; the rows are 64px (hub.css). */
const AI_SPARK_W = 96;
const AI_SPARK_H = 24;
/** Snooze, in ms. One day — long enough to stop a bad night, short enough to forget. */
const AI_SNOOZE_MS = 24 * 60 * 60 * 1000;

let aiPopover: HTMLElement | null = null;

function aiBellBtn(): HTMLButtonElement | null {
  return document.getElementById('topbar-alerts') as HTMLButtonElement | null;
}

// ── The bell ─────────────────────────────────────────────────────────────────

/**
 * Paint the unread count onto the bell.
 *
 * Zero is NOT a badge reading "0" — it is no badge at all, and the bell goes
 * back to being a quiet door to the rules page. A count that never clears is a
 * count people stop reading.
 */
function aiPaintBell(): void {
  const btn = aiBellBtn();
  if (!btn) return;
  const unseen = alEvents.filter((e: any) => e && !e.seen).length;
  btn.classList.toggle('has-unread', unseen > 0);
  let badge = btn.querySelector('.al-badge') as HTMLElement | null;
  if (unseen === 0) {
    if (badge) badge.remove();
  } else {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'al-badge';
      btn.appendChild(badge);
    }
    // Past 9 the exact number stops mattering and the badge stops fitting.
    badge.textContent = unseen > 9 ? '9+' : String(unseen);
  }
  const label = unseen === 0
    ? 'Alerts'
    : `Alerts — ${unseen} unread`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** Re-read everything and repaint the bell. The one refresh entry point. */
async function aiRefresh(): Promise<void> {
  await alRefreshRules();
  aiPaintBell();
  if (aiPopover) aiRenderPopover();
}

// ── The popover ──────────────────────────────────────────────────────────────

function aiClosePopover(): void {
  if (!aiPopover) return;
  aiPopover.remove();
  aiPopover = null;
  const btn = aiBellBtn();
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', aiOnKey, true);
  document.removeEventListener('mousedown', aiOnOutside, true);
}

function aiOnKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); aiClosePopover(); }
}

function aiOnOutside(e: MouseEvent): void {
  const t = e.target as Node;
  if (aiPopover && aiPopover.contains(t)) return;
  const btn = aiBellBtn();
  if (btn && btn.contains(t)) return;
  aiClosePopover();
}

async function aiTogglePopover(): Promise<void> {
  if (aiPopover) { aiClosePopover(); return; }
  const btn = aiBellBtn();
  if (!btn) return;
  aiPopover = document.createElement('div');
  aiPopover.className = 'al-pop';
  aiPopover.id = 'al-pop';
  aiPopover.setAttribute('role', 'dialog');
  aiPopover.setAttribute('aria-label', 'Alerts');
  document.body.appendChild(aiPopover);
  btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', aiOnKey, true);
  document.addEventListener('mousedown', aiOnOutside, true);

  const rect = btn.getBoundingClientRect();
  // Right-aligned to the bell, clamped into the window — the same rule
  // openMiniMenu follows, because a popover half off-screen is a bug report.
  const w = 380;
  aiPopover.style.top = Math.round(rect.bottom + 6) + 'px';
  aiPopover.style.left = Math.round(Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))) + 'px';

  await aiRefresh();
  aiRenderPopover();
}

function aiRenderPopover(): void {
  if (!aiPopover) return;
  aiPopover.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'al-pop-head';
  const title = document.createElement('span');
  title.className = 'al-pop-title';
  title.textContent = 'Alerts';
  head.appendChild(title);
  if (alEvents.some((e: any) => !e.seen)) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'al-pop-link';
    all.textContent = 'Mark all seen';
    all.addEventListener('click', async () => {
      try { await window.hub.markAlertSeen(currentProjectId); } catch (_) { /* repaint tells the truth */ }
      await aiRefresh();
    });
    head.appendChild(all);
  }
  aiPopover.appendChild(head);

  const list = document.createElement('div');
  list.className = 'al-pop-list';
  if (alEvents.length === 0) {
    // The shared empty state — one component, and this is the sixth surface.
    list.appendChild(makeEmptyState({
      variant: 'alerts',
      iconName: 'bell',
      title: alRules.length ? 'Nothing has fired' : 'No alerts yet',
      line: alRules.length
        ? 'Your rules are watching. You’ll see anything they catch here.'
        : 'Open a KPI card’s actions menu and choose “Alert me…” to watch a number.',
    }));
  } else {
    alEvents.forEach((e: any) => list.appendChild(aiEventRow(e)));
  }
  aiPopover.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'al-pop-foot';
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'al-pop-link';
  manage.textContent = 'Manage rules';
  manage.addEventListener('click', () => { aiClosePopover(); void aiOpenRulesPage(); });
  foot.appendChild(manage);
  aiPopover.appendChild(foot);
}

/** One event: what fired, what it said, when, and what it has been doing. */
function aiEventRow(e: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'al-ev' + (e.seen ? '' : ' is-unseen');
  row.dataset.eventId = String(e.id);

  const main = document.createElement('div');
  main.className = 'al-ev-main';
  const name = document.createElement('div');
  name.className = 'al-ev-name';
  name.textContent = String(e.ruleName || 'Alert');
  const msg = document.createElement('div');
  msg.className = 'al-ev-msg';
  msg.textContent = String(e.message || '');
  const when = document.createElement('div');
  when.className = 'al-ev-when';
  when.textContent = aiAgo(e.at);
  main.appendChild(name);
  main.appendChild(msg);
  main.appendChild(when);
  row.appendChild(main);

  const rule = alRules.find((r: any) => r && r.id === e.ruleId);
  const spark = aiSparkline(rule && rule.history);
  if (spark) row.appendChild(spark);

  const acts = document.createElement('div');
  acts.className = 'al-ev-acts';
  if (e.analysisId) acts.appendChild(aiAction('Open dashboard', () => {
    aiClosePopover();
    void openAnalysis(String(e.analysisId));
  }));
  acts.appendChild(aiAction('Explain', () => { void aiExplain(e); }));
  if (rule) acts.appendChild(aiAction('Snooze 24h', () => { void aiSnooze(rule); }));
  if (!e.seen) acts.appendChild(aiAction('Mark seen', async () => {
    try { await window.hub.markAlertSeen(currentProjectId, String(e.id)); } catch (_) { /* repaint tells the truth */ }
    await aiRefresh();
  }));
  row.appendChild(acts);
  return row;
}

function aiAction(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'al-ev-act';
  b.textContent = label;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); run(); });
  return b;
}

/**
 * The metric's last evaluations as a 96×24 line.
 *
 * Plotted from `rule.history` — values main recorded, in order — so this is a
 * picture of the app's own figures and not a re-derivation of them. Fewer than
 * two points is not a trend, so it draws nothing rather than a dot pretending
 * to be one.
 */
function aiSparkline(history: any): SVGSVGElement | null {
  const pts = Array.isArray(history) ? history.filter((n: any) => typeof n === 'number' && Number.isFinite(n)) : [];
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  // A flat line is a real answer: span 0 would divide by zero, so it draws down
  // the middle instead of collapsing onto the baseline.
  const span = max - min || 1;
  const stepX = AI_SPARK_W / (pts.length - 1);
  const d = pts.map((v: number, i: number) => {
    const x = i * stepX;
    const y = AI_SPARK_H - 2 - ((v - min) / span) * (AI_SPARK_H - 4);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'al-spark');
  svg.setAttribute('width', String(AI_SPARK_W));
  svg.setAttribute('height', String(AI_SPARK_H));
  svg.setAttribute('viewBox', `0 0 ${AI_SPARK_W} ${AI_SPARK_H}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** "4m ago" / "3h ago" / "2d ago". Relative, because "when" is the only question. */
function aiAgo(iso: string): string {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

/** Snooze the rule behind an event for a day. */
async function aiSnooze(rule: any): Promise<void> {
  const until = new Date(Date.now() + AI_SNOOZE_MS).toISOString();
  try {
    await window.hub.patchAlertRule(currentProjectId, String(rule.id), { snoozedUntil: until });
    showToast(`Snoozed "${rule.name}" for 24 hours.`);
  } catch (_) {
    showToast('Could not snooze that rule.');
  }
  await aiRefresh();
}

/**
 * "Explain" — an ordinary DOCK conversation about the event.
 *
 * Main writes the thread (app-computed facts in, one narration out, audited
 * against the app's ledger) and hands back its id; this opens it. With no model
 * configured the channel answers `not_ready` and the button says so instead of
 * failing — every optional-AI surface in this app behaves that way.
 */
async function aiExplain(e: any): Promise<void> {
  let r: any;
  try {
    r = await window.hub.explainAlert(currentProjectId, e);
  } catch (_) {
    r = { ok: false };
  }
  if (r && r.reason === 'not_ready') {
    // One name for this state everywhere — AI_NOT_CONFIGURED / AI_SETUP_LABEL
    // (execMenu.ts), pinned by scripts/test-ai-naming.ts.
    showToast(AI_NOT_CONFIGURED + ' ' + AI_SETUP_LABEL + ' in Settings to explain alerts.');
    return;
  }
  if (!r || r.ok === false || !r.threadId) {
    showToast((r && r.error) || 'Could not explain that alert.');
    return;
  }
  aiClosePopover();
  if (typeof dkSetOpen === 'function') dkSetOpen(true);
  if (typeof dkOpenThread === 'function') await dkOpenThread(String(r.threadId));
}

// ── The rules page ───────────────────────────────────────────────────────────

/**
 * Every rule in the project, as a table. Reached from the inbox footer and from
 * Settings → Notifications — two doors, one surface, because a rule is edited
 * far less often than an event is read.
 */
async function aiOpenRulesPage(): Promise<void> {
  await alRefreshRules();
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay';
  overlay.id = 'al-rules';
  const box = document.createElement('div');
  box.className = 'ws-modal al-rules-modal';

  const head = document.createElement('div');
  head.className = 'al-rules-head';
  const title = document.createElement('div');
  title.className = 'ws-modal-title';
  title.textContent = 'Alert rules';
  head.appendChild(title);
  box.appendChild(head);

  const body = document.createElement('div');
  body.className = 'al-rules-body';
  box.appendChild(body);

  function close(): void {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });

  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions';

  // The per-project delivery choice sits with the rules it applies to, not in
  // global Settings: "one notification per refresh instead of six" is a property
  // of THIS project's alerting, and a different project may want the opposite.
  const digestWrap = document.createElement('label');
  digestWrap.className = 'al-digest';
  const digest = document.createElement('input');
  digest.type = 'checkbox';
  digest.addEventListener('change', async () => {
    try { await window.hub.setAlertDigest(currentProjectId, digest.checked); } catch (_) {
      showToast('Could not change that setting.');
    }
  });
  digestWrap.appendChild(digest);
  const digestText = document.createElement('span');
  digestText.textContent = 'One digest notification per refresh';
  digestWrap.appendChild(digestText);
  actions.appendChild(digestWrap);

  const spacer = document.createElement('span');
  spacer.className = 'al-actions-spacer';
  actions.appendChild(spacer);
  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn btn-primary';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', close);
  actions.appendChild(doneBtn);
  box.appendChild(actions);

  async function paint(): Promise<void> {
    await alRefreshRules();
    body.innerHTML = '';
    let file: any = {};
    try { file = (await window.hub.listAlerts(currentProjectId)) || {}; } catch (_) { file = {}; }
    digest.checked = Boolean(file.digest);
    if (!alRules.length) {
      body.appendChild(makeEmptyState({
        variant: 'rules',
        iconName: 'bell',
        title: 'No alert rules yet',
        line: 'Open a KPI card’s actions menu and choose “Alert me…”, or use a numeric column’s profile.',
      }));
      return;
    }
    const table = document.createElement('table');
    table.className = 'al-rules-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['', 'Rule', 'Metric', 'Condition', 'Last value', 'Last fired', 'Quiet hours', ''].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    alRules.forEach((r: any) => tbody.appendChild(aiRuleRow(r, paint)));
    table.appendChild(tbody);
    body.appendChild(table);
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  await paint();
}

function aiRuleRow(r: any, repaint: () => Promise<void>): HTMLElement {
  const tr = document.createElement('tr');
  tr.dataset.ruleId = String(r.id);

  const onCell = document.createElement('td');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'stp-switch' + (r.enabled !== false ? ' stp-switch-on' : '');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(r.enabled !== false));
  toggle.setAttribute('aria-label', 'Enable ' + r.name);
  const thumb = document.createElement('span');
  thumb.className = 'stp-switch-thumb';
  toggle.appendChild(thumb);
  toggle.addEventListener('click', async () => {
    const next = !toggle.classList.contains('stp-switch-on');
    try {
      await window.hub.patchAlertRule(currentProjectId, String(r.id), { enabled: next });
    } catch (_) {
      showToast('Could not change that rule.');
    }
    await repaint();
  });
  onCell.appendChild(toggle);
  tr.appendChild(onCell);

  tr.appendChild(aiCell(String(r.name || 'Alert'), 'al-rule-name'));
  const m = r.metric || {};
  tr.appendChild(aiCell(m.column ? `${m.aggregation}(${m.column})` : 'whole dataset'));
  tr.appendChild(aiCell(aiConditionText(r)));
  tr.appendChild(aiCell(r.lastValue == null ? '—' : fmtWith(r.lastValue, 'auto'), 'tnum'));
  tr.appendChild(aiCell(r.lastFiredAt ? aiAgo(r.lastFiredAt) : 'never'));

  const quiet = document.createElement('td');
  quiet.appendChild(aiQuietPicker(r, repaint));
  tr.appendChild(quiet);

  const del = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dash-card-btn al-rule-del';
  iconOnly(btn, 'trash', 'Delete ' + r.name, 14);
  btn.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${r.name}"? Its past alerts go with it.`)) return;
    try {
      await window.hub.deleteAlertRule(currentProjectId, String(r.id));
    } catch (_) {
      showToast('Could not delete that rule.');
    }
    await repaint();
    await aiRefresh();
  });
  del.appendChild(btn);
  tr.appendChild(del);
  return tr;
}

function aiCell(text: string, cls?: string): HTMLElement {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/** The rule's condition in the same words the dialog offered it in. */
function aiConditionText(r: any): string {
  if (r.compare === 'threshold' && r.threshold) {
    const word = AL_OPS.find((o) => o.value === r.threshold.op);
    return `${word ? word.label : r.threshold.op} ${fmtWith(r.threshold.value, 'auto')}`;
  }
  if (r.compare === 'change' && r.change) {
    const word = AL_DIRECTIONS.find((d) => d.value === r.change.direction);
    const vs = r.change.vs === 'previous_period' ? 'previous period' : 'previous refresh';
    return `${word ? word.label : 'moves by'} ${r.change.pct}% vs ${vs}`;
  }
  return 'new anomalies';
}

/**
 * Per-rule quiet hours, as two native `<select>`s of the 24 hours.
 *
 * Native, and hours rather than times, deliberately: "don't tell me between 10pm
 * and 7am" is the whole requirement, and a time picker would invite a precision
 * (22:37) that means nothing to a schedule that ticks hourly.
 */
function aiQuietPicker(r: any, repaint: () => Promise<void>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'al-quiet';
  const q = r.quietHours || null;

  const hourSelect = (value: number | null, aria: string): HTMLSelectElement => {
    const sel = document.createElement('select');
    sel.className = 'al-quiet-sel';
    sel.setAttribute('aria-label', aria);
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '—';
    sel.appendChild(none);
    for (let h = 0; h < 24; h += 1) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = String(h).padStart(2, '0') + ':00';
      sel.appendChild(o);
    }
    sel.value = value == null ? '' : String(value);
    return sel;
  };

  const from = hourSelect(q ? q.from : null, 'Quiet hours from');
  const to = hourSelect(q ? q.to : null, 'Quiet hours to');
  const apply = async (): Promise<void> => {
    // Either both ends or neither: a half-set window has no meaning, and
    // `null` is how main is told to clear it.
    const f = from.value === '' ? null : Number(from.value);
    const t = to.value === '' ? null : Number(to.value);
    const patch = f == null || t == null ? { quietHours: null } : { quietHours: { from: f, to: t } };
    try {
      await window.hub.patchAlertRule(currentProjectId, String(r.id), patch);
    } catch (_) {
      showToast('Could not change the quiet hours.');
    }
    await repaint();
  };
  from.addEventListener('change', () => { void apply(); });
  to.addEventListener('change', () => { void apply(); });

  wrap.appendChild(from);
  const dash = document.createElement('span');
  dash.className = 'al-quiet-dash';
  dash.textContent = '–';
  wrap.appendChild(dash);
  wrap.appendChild(to);
  return wrap;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

{
  const bell = aiBellBtn();
  if (bell) bell.addEventListener('click', () => { void aiTogglePopover(); });

  const manage = document.getElementById('stp-alerts-manage');
  if (manage) manage.addEventListener('click', () => { void aiOpenRulesPage(); });

  // Main pushes the moment a rule fires, unattended or not, so the bell is
  // right without anyone opening anything. send/on: nothing is asked for.
  if (window.hub && typeof window.hub.onAlertsFired === 'function') {
    window.hub.onAlertsFired(() => {
      void (async () => {
        await aiRefresh();
        // A card's bell is accented while its newest event is unseen, so the
        // open grid has to hear about this too.
        if (typeof renderDashGrid === 'function' && dashCurrent) renderDashGrid();
      })();
    });
  }
}
