'use strict';

// The statistics workbench — the panel's shell, state and runs. Classic
// global-scope renderer <script>; its controls are statsControls.ts, its
// result views statsViews*.ts, its charts statsCharts.ts and its dashboard
// tile statsTile.ts.
//
// A full-width panel IN the workspace, not a modal: it takes the place of the
// section on screen (body.sw-open hides the .ws-panels) and leaves the sidebar
// and the Assistant dock usable, because the dock is how the user asks about
// what the panel shows — dock.ts reads swAssistantRef()/swAssistantSpec() and
// main recomputes that spec as facts. Navigating to a section closes it.
//
// Every figure comes from main (window.hubStats → src/ipc/stats.ts). This
// file only holds the spec the user is building and draws the reply.

type SwTab = 'correlation' | 'regression' | 'groups' | 'distribution';

const SW_TABS: Array<[SwTab, string]> = [
  ['correlation', 'Correlation'], ['regression', 'Regression'], ['groups', 'Compare groups'], ['distribution', 'Distribution'],
];
/** Above this many rows a run is a background job — no auto-run on every click. */
const SW_AUTO_MAX_ROWS = 200_000;

const swState: any = {
  el: null as HTMLElement | null,
  opener: null as HTMLElement | null,
  datasetId: '',
  datasetName: '',
  rowCount: 0,
  columns: [] as Array<{ name: string; type: string }>,
  tab: 'correlation' as SwTab,
  specs: {} as Record<SwTab, any>,
  replies: {} as Record<SwTab, any>,
  seq: 0,
  timer: 0,
  pair: null as [string, string] | null,
};

function swIsOpen(): boolean {
  return !!swState.el && document.body.classList.contains('sw-open');
}

/** The dock's context while the panel is open (dock.ts dkContextRef). */
function swAssistantRef(): { kind: string; id: string; label: string; name: string } | null {
  if (!swIsOpen() || !swState.datasetId) return null;
  const name = SW_TABS.find((t) => t[0] === swState.tab)?.[1] || 'Statistics';
  return { kind: 'stats', id: swState.datasetId, label: `statistics · ${name} · ${swState.datasetName}`, name: `${name} on ${swState.datasetName}` };
}

/** The spec the dock sends with an ask — main recomputes it as facts. */
function swAssistantSpec(): any {
  return swIsOpen() ? swSpec() : null;
}

/** The current tab's spec, complete with the dataset. */
function swSpec(tab: SwTab = swState.tab): any {
  return Object.assign({ datasetId: swState.datasetId, columns: [] }, swState.specs[tab] || {});
}

function swNumeric(): string[] {
  return swState.columns.filter((c: any) => c.type === 'number').map((c: any) => c.name);
}
function swCategorical(): string[] {
  return swState.columns.filter((c: any) => c.type !== 'number').map((c: any) => c.name);
}

/** Sensible starting specs for a dataset's columns. */
function swDefaultSpecs(): Record<SwTab, any> {
  const num = swNumeric();
  const cat = swCategorical();
  const target = num[num.length - 1] || '';
  return {
    correlation: { kind: 'correlation', columns: num.slice(0, 6), method: 'pearson' },
    regression: { kind: 'regression', target, predictors: num.filter((c) => c !== target).slice(0, 5) },
    groups: { kind: 'groups', group: cat[0] || '', outcome: num[0] || cat[1] || '', levels: [] },
    distribution: { kind: 'distribution', columns: num[0] ? [num[0]] : [] },
  };
}

/**
 * Open the workbench. `datasetId` defaults to the open dataset; `pair` (from a
 * scatter's ⋯) pre-fills Correlation and Regression with its two columns.
 */
async function swOpen(opts: { datasetId?: string; tab?: SwTab; pair?: [string, string] } = {}): Promise<void> {
  if (!currentProjectId) { showToast('Open a project first'); return; }
  let id = opts.datasetId || (typeof expId === 'string' && expId ? expId : '') || swState.datasetId;
  let list: any[] = [];
  try { list = await window.hub.listDatasets(currentProjectId); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  if (!id || !list.some((d) => d && d.id === id)) id = list[0] ? list[0].id : '';
  swState.opener = document.activeElement as HTMLElement | null;
  swEnsureShell();
  swFillDatasets(list, id);
  document.body.classList.add('sw-open');
  if (!id) { swPaintEmptyProject(); swSyncDock(); return; }
  await swLoadDataset(id);
  if (opts.pair) {
    const [x, y] = opts.pair;
    swState.specs.correlation = { kind: 'correlation', columns: [x, y], method: 'pearson' };
    swState.specs.regression = { kind: 'regression', target: y, predictors: [x] };
    swState.pair = [x, y];
  }
  swSelectTab(opts.tab || (opts.pair ? 'correlation' : swState.tab), true);
  swSyncDock();
  (swState.el.querySelector('.sw-tab[aria-selected="true"]') as HTMLElement | null)?.focus();
}

function swClose(): void {
  if (!swState.el || !document.body.classList.contains('sw-open')) return;
  document.body.classList.remove('sw-open');
  swState.seq += 1; // a reply still in flight is now stale
  swDestroyCharts();
  swSyncDock();
  const back = swState.opener;
  swState.opener = null;
  if (back && document.contains(back) && back.getClientRects().length) back.focus();
}

function swSyncDock(): void {
  if (typeof dkRenderContext === 'function') dkRenderContext();
}

function swEnsureShell(): void {
  if (swState.el) return;
  const el = document.createElement('section');
  el.className = 'sw-panel';
  el.id = 'sw-panel';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Statistics');

  const head = document.createElement('header');
  head.className = 'sw-head';
  const ident = document.createElement('div');
  ident.className = 'sw-ident';
  const h = document.createElement('h2');
  h.className = 'sw-title';
  const mark = document.createElement('span');
  mark.className = 'sw-mark';
  mark.appendChild(icon('activity', 16));
  h.append(mark, 'Statistics');
  const sub = document.createElement('p');
  sub.className = 'sw-sub';
  sub.id = 'sw-sub';
  ident.append(h, sub);

  const actions = document.createElement('div');
  actions.className = 'sw-head-actions';
  const dsLabel = document.createElement('label');
  dsLabel.className = 'sw-inline-field';
  dsLabel.htmlFor = 'sw-dataset';
  dsLabel.textContent = 'Dataset';
  const ds = document.createElement('select');
  ds.id = 'sw-dataset';
  ds.className = 'sw-select';
  ds.addEventListener('change', () => { void swLoadDataset(ds.value).then(() => swSelectTab(swState.tab, true)); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-sm sw-close';
  close.id = 'sw-close';
  iconLabel(close, 'x', 'Close');
  close.setAttribute('aria-label', 'Close statistics');
  close.addEventListener('click', () => swClose());
  actions.append(dsLabel, ds, close);
  head.append(ident, actions);

  const tabs = document.createElement('div');
  tabs.className = 'tabs sw-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Analyses');
  for (const [key, label] of SW_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab sw-tab';
    b.id = 'sw-tab-' + key;
    b.dataset.tab = key;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'sw-tabpanel');
    b.textContent = label;
    b.addEventListener('click', () => swSelectTab(key));
    tabs.appendChild(b);
  }
  // Arrow keys move along the tabs, the ARIA tab pattern.
  tabs.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = SW_TABS.findIndex((t) => t[0] === swState.tab);
    const next = SW_TABS[(i + (e.key === 'ArrowRight' ? 1 : SW_TABS.length - 1)) % SW_TABS.length][0];
    e.preventDefault();
    swSelectTab(next);
    (document.getElementById('sw-tab-' + next) as HTMLElement | null)?.focus();
  });

  const body = document.createElement('div');
  body.className = 'sw-body';
  body.id = 'sw-tabpanel';
  body.setAttribute('role', 'tabpanel');
  const controls = document.createElement('aside');
  controls.className = 'sw-controls';
  controls.id = 'sw-controls';
  controls.setAttribute('aria-label', 'Analysis settings');
  const results = document.createElement('div');
  results.className = 'sw-results';
  results.id = 'sw-results';
  results.setAttribute('aria-live', 'polite');
  body.append(controls, results);
  el.append(head, tabs, body);

  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || (typeof wsLayerOpen === 'function' && wsLayerOpen())) return;
    e.preventDefault();
    swClose();
  });
  const hub = document.querySelector('.hub-body');
  const scrim = document.getElementById('dk-scrim');
  if (hub && scrim && scrim.parentElement === hub) hub.insertBefore(el, scrim);
  else (hub || document.body).appendChild(el);
  swState.el = el;
  // Going to a section (the sidebar, a shortcut, the palette) leaves the panel.
  if (hub) new MutationObserver(() => swClose()).observe(hub, { attributes: true, attributeFilter: ['data-section'] });
}

function swFillDatasets(list: any[], id: string): void {
  const sel = document.getElementById('sw-dataset') as HTMLSelectElement | null;
  if (!sel) return;
  sel.textContent = '';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name || 'Untitled dataset';
    sel.appendChild(o);
  }
  sel.value = id;
  sel.disabled = list.length < 2;
}

async function swLoadDataset(id: string): Promise<void> {
  let meta: any = null;
  try { meta = await window.hub.getDatasetMeta(currentProjectId, id); } catch (_) { meta = null; }
  swState.datasetId = meta ? id : '';
  swState.datasetName = meta ? meta.name || 'Untitled dataset' : '';
  swState.rowCount = meta ? Number(meta.rowCount) || 0 : 0;
  swState.columns = meta && Array.isArray(meta.columns) ? meta.columns.map((c: any) => ({ name: String(c.name), type: String(c.type) })) : [];
  swState.specs = swDefaultSpecs();
  swState.replies = {};
  swState.pair = null;
  const sub = document.getElementById('sw-sub');
  if (sub) {
    sub.textContent = meta
      ? `${swState.datasetName} · ${swState.rowCount.toLocaleString('en-US')} rows · every figure computed by the app`
      : 'This dataset could not be opened.';
  }
  swSyncDock();
}

function swSelectTab(tab: SwTab, force?: boolean): void {
  if (!swState.el) return;
  const changed = swState.tab !== tab;
  swState.tab = tab;
  for (const b of swState.el.querySelectorAll('.sw-tab')) {
    const on = (b as HTMLElement).dataset.tab === tab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    (b as HTMLElement).tabIndex = on ? 0 : -1;
  }
  document.getElementById('sw-tabpanel')?.setAttribute('aria-labelledby', 'sw-tab-' + tab);
  swPaintControls();
  if (changed || force) {
    const reply = swState.replies[tab];
    if (reply) swPaintReply(reply);
    else swSchedule(true);
  }
  swSyncDock();
}

/** A control changed: re-run (debounced) when the dataset is small enough to. */
function swSchedule(now?: boolean): void {
  window.clearTimeout(swState.timer);
  swState.replies[swState.tab] = null;
  if (swState.rowCount > SW_AUTO_MAX_ROWS) { swPaintStale(); return; }
  swState.timer = window.setTimeout(() => { void swRun(); }, now ? 0 : 250);
}

async function swRun(): Promise<void> {
  if (!swState.datasetId || !currentProjectId) return;
  const tab = swState.tab as SwTab;
  const spec = swSpec(tab);
  const seq = ++swState.seq;
  swPaintLoading(swState.rowCount > SW_AUTO_MAX_ROWS);
  let reply: any;
  try { reply = await window.hubStats.run(currentProjectId, spec); } catch (_) { reply = { ok: false, error: 'Something went wrong. Try again.' }; }
  if (seq !== swState.seq || !swIsOpen()) return;
  reply = Object.assign({}, reply, { spec, tab });
  swState.replies[tab] = reply;
  if (swState.tab !== tab) return;
  swPaintReply(reply);
  // The Groups picker lists what the run found; repaint it only when that set
  // changed, so ticking a box does not steal focus from the list.
  const r = reply.ok && reply.result && reply.result.ok ? reply.result : null;
  if (tab === 'groups' && r) {
    const key = [r.group, r.outcome, r.available.length, !!r.prop].join('\u0000');
    if (key !== swState.groupsKey) { swState.groupsKey = key; swPaintControls(); }
  }
}

function swResults(): HTMLElement {
  const host = document.getElementById('sw-results') as HTMLElement;
  swDestroyCharts();
  host.textContent = '';
  return host;
}

function swPaintLoading(job: boolean): void {
  const host = swResults();
  const box = document.createElement('div');
  box.className = 'sw-loading';
  box.setAttribute('role', 'status');
  const spin = icon('loader', 20);
  spin.classList.add('sw-spin');
  const t = document.createElement('p');
  t.textContent = job ? 'Running as a background job — progress and Cancel are in Jobs.' : 'Computing…';
  box.append(spin, t);
  host.appendChild(box);
}

function swPaintStale(): void {
  const host = swResults();
  host.appendChild(makeEmptyState({
    variant: 'sw', iconName: 'play', title: 'Ready to run',
    line: `${swState.rowCount.toLocaleString('en-US')} rows — large runs go to the background as a job.`,
    actionLabel: 'Run analysis', onAction: () => { void swRun(); },
  }));
}

function swPaintEmptyProject(): void {
  swState.datasetId = '';
  const c = document.getElementById('sw-controls');
  if (c) c.textContent = '';
  const sub = document.getElementById('sw-sub');
  if (sub) sub.textContent = 'No datasets yet';
  swResults().appendChild(makeEmptyState({
    variant: 'sw', iconName: 'database', title: 'No data to analyse',
    line: 'Import a dataset first, then come back to correlate, model and compare it.',
  }));
}

/** The shared failure state: the app's own reason, never a stack. */
function swPaintProblem(host: HTMLElement, message: string): void {
  host.appendChild(makeEmptyState({ variant: 'sw', iconName: 'info', title: swProblemTitle(message), line: message }));
}

function swProblemTitle(message: string): string {
  if (/^Pick /.test(message)) return 'Choose what to analyse';
  if (/^Need /.test(message)) return 'Not enough data';
  return 'This analysis cannot run';
}

function swPaintReply(reply: any): void {
  const host = swResults();
  if (!reply || reply.ok === false) { swPaintProblem(host, (reply && reply.error) || 'Could not run the analysis.'); return; }
  const r = reply.result;
  if (!r || r.ok === false) { swPaintProblem(host, (r && r.error) || 'Could not run the analysis.'); return; }
  if (r.kind === 'correlation') swViewCorrelation(host, r, reply.spec);
  else if (r.kind === 'regression') swViewRegression(host, r, reply.spec);
  else if (r.kind === 'groups') swViewGroups(host, r, reply.spec);
  else swViewDistribution(host, r, reply.spec);
}

/** The head every result shares: title, meta line, actions. */
function swResultHead(host: HTMLElement, title: string, meta: string, spec: any, extra?: HTMLElement[]): void {
  const head = document.createElement('div');
  head.className = 'sw-result-head';
  const t = document.createElement('div');
  const h = document.createElement('h3');
  h.className = 'sw-result-title';
  h.textContent = title;
  const m = document.createElement('p');
  m.className = 'sw-result-meta';
  m.textContent = meta;
  t.append(h, m);
  const acts = document.createElement('div');
  acts.className = 'sw-result-actions';
  for (const e of extra || []) acts.appendChild(e);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm sw-add-dash';
  iconLabel(add, 'layout-dashboard', 'Add to dashboard');
  add.addEventListener('click', () => { void swAddToDashboard(spec); });
  acts.appendChild(add);
  head.append(t, acts);
  host.appendChild(head);
}

/** The app's own sentence, set apart as the headline finding. */
function swSentence(host: HTMLElement, text: string): void {
  if (!text) return;
  const p = document.createElement('p');
  p.className = 'sw-sentence';
  p.appendChild(icon('check', 16));
  const span = document.createElement('span');
  span.textContent = text;
  p.appendChild(span);
  host.appendChild(p);
}

/** A row of labelled figures. */
function swStatRow(host: HTMLElement, items: Array<[string, string, string?]>): void {
  const row = document.createElement('div');
  row.className = 'sw-stats';
  for (const [label, value, note] of items) {
    const c = document.createElement('div');
    c.className = 'sw-stat';
    const l = document.createElement('div');
    l.className = 'sw-stat-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'sw-stat-value tnum';
    v.textContent = value;
    c.append(l, v);
    if (note) {
      const n = document.createElement('div');
      n.className = 'sw-stat-note';
      n.textContent = note;
      c.appendChild(n);
    }
    row.appendChild(c);
  }
  host.appendChild(row);
}

// ── Entry points: the palette, and a scatter's ⋯ ─────────────────────────────

registerCommand({
  id: 'data.statistics', title: 'Statistics…', group: 'Data', icon: 'activity',
  when: () => !!currentProjectId,
  run: () => { void swOpen(); },
});
