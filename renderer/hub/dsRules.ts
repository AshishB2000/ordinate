'use strict';

// Data-quality rules in the renderer: the Quality tab's RULES section, the
// "Show failing rows" grid filter, and the red quality dot the dataset list,
// Home and a dashboard header carry. Classic global-scope renderer <script>:
// no import/export. Loads after dsProfile.js; the editor is dsRuleEditor.ts.
//
// EVERY COUNT ARRIVED COMPUTED. `quality:list` hands back main's latest run and
// its 30-run history; the sparkline plots `history[].failing[ruleId]` through
// the alert inbox's own `aiSparkline`; the failing rows are a `datasetPage`
// window main filtered by the rule's id. This file draws and routes.
//
// The failing-rows filter is TEMPORARY — a module variable, never written to the
// dataset. It is cleared by the banner's Clear and whenever another dataset
// opens (`dqResetForDataset`, from openSavedDataset).

let dqState: { datasetId: string; rules: any[]; latest: any; history: any[] } | null = null;
/** The rule whose failing rows the Data grid is showing, or null. */
let dqGridRule: { id: string; words: string } | null = null;
/** Dataset id → name, for a references rule's words. */
let dqNames = new Map<string, string>();
let dqLoadSeq = 0;

type DqStatus = 'pass' | 'fail' | 'warn' | 'pending';
const DQ_STATUS: Record<DqStatus, { label: string; icon: string; rank: number }> = {
  fail: { label: t('common.fail'), icon: 'x', rank: 0 },
  warn: { label: t('common.warn'), icon: 'alert', rank: 1 },
  pending: { label: t('dsRules.not_run'), icon: 'minus', rank: 2 },
  pass: { label: t('dsRules.pass'), icon: 'check', rank: 3 },
};

function dqResult(ruleId: string): any {
  const list = dqState && dqState.latest && Array.isArray(dqState.latest.results) ? dqState.latest.results : [];
  return list.find((r: any) => r && r.ruleId === ruleId) || null;
}

function dqStatus(rule: any, result: any): DqStatus {
  if (!result) return 'pending';
  if (result.passed) return 'pass';
  return rule.severity === 'warn' ? 'warn' : 'fail';
}

function dqRows(n: number): string {
  return n.toLocaleString() + (n === 1 ? ' row' : ' rows');
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Fetch and paint the open dataset's rules. Called with the rest of the Quality tab. */
async function dqRenderRules(): Promise<void> {
  const host = document.getElementById('dq-rules');
  if (!host || !currentProjectId || !expId) return;
  const seq = ++dqLoadSeq;
  const want = expId;
  let res: any = null;
  let list: any[] = [];
  try {
    [res, list] = await Promise.all([window.hub.listQuality(currentProjectId, want), window.hub.listDatasets(currentProjectId)]);
  } catch (_) {
    res = null;
  }
  if (seq !== dqLoadSeq || want !== expId) return; // a newer open already won
  dqNames = new Map((Array.isArray(list) ? list : []).map((d: any) => [String(d.id), d.name ? String(d.name) : t('common.untitled_dataset')]));
  dqState = { datasetId: want, rules: [], latest: null, history: [] };
  dqApply(res && res.ok ? res : null);
}

/** Take main's `{ rules, latest, history }` and repaint; the list's dots move with it. */
function dqApply(q: any): void {
  if (!dqState) return;
  if (q) {
    dqState.rules = Array.isArray(q.rules) ? q.rules : [];
    dqState.latest = q.latest || null;
    dqState.history = Array.isArray(q.history) ? q.history : [];
  }
  dqPaint();
}

async function dqAfterChange(q: any): Promise<void> {
  dqApply(q);
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

// ── The section ──────────────────────────────────────────────────────────────

function dqPaint(): void {
  const host = document.getElementById('dq-rules');
  if (!host || !dqState) return;
  host.textContent = '';
  const rules = dqState.rules.slice();
  const failing = rules.filter((r) => ['fail', 'warn'].includes(dqStatus(r, dqResult(r.id)))).length;

  const head = document.createElement('div');
  head.className = 'dq-head';
  const titles = document.createElement('div');
  titles.className = 'dq-titles';
  const h = document.createElement('h4');
  h.className = 'dq-title';
  h.textContent = t('dsRules.rules');
  const sub = document.createElement('p');
  sub.className = 'dq-sub';
  const part = (text: string, cls?: string): void => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    sub.appendChild(s);
  };
  if (!rules.length) part(t('dsRules.checks_that_run_on_every_save'));
  else {
    part(rules.length + (rules.length === 1 ? ' rule' : ' rules'));
    part(failing + ' failing', failing ? 'dq-sub-bad' : 'dq-sub-good');
    if (dqState.latest && dqState.latest.at) part('checked ' + aiAgo(dqState.latest.at));
  }
  titles.append(h, sub);
  const acts = document.createElement('div');
  acts.className = 'dq-head-acts';
  if (rules.length) {
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'btn btn-sm';
    iconLabel(run, 'refresh', t('dsRules.run_checks'));
    run.addEventListener('click', () => { void dqRun(run); });
    acts.appendChild(run);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-primary btn-sm';
  iconLabel(add, 'plus', t('common.add_rule'));
  add.addEventListener('click', () => { void dqEdit(null); });
  acts.appendChild(add);
  head.append(titles, acts);
  host.appendChild(head);

  if (!rules.length) {
    host.appendChild(dqEmpty());
    return;
  }
  const table = document.createElement('div');
  table.className = 'dq-list';
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', t('common.data_quality_rules'));
  const hr = document.createElement('div');
  hr.className = 'dq-row dq-row-head';
  hr.setAttribute('role', 'row');
  [t('common.status'), t('common.rule'), t('common.severity'), t('dsRules.failing'), t('dsRules.last_30_runs'), ''].forEach((t) => {
    const c = document.createElement('span');
    c.setAttribute('role', 'columnheader');
    c.textContent = t;
    hr.appendChild(c);
  });
  table.appendChild(hr);
  // Failures first, then warnings, then the unrun, then the passing — a test
  // list is read top-down for what is broken.
  rules
    .map((r, i) => ({ r, i, rank: DQ_STATUS[dqStatus(r, dqResult(r.id))].rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .forEach(({ r }) => table.appendChild(dqRow(r)));
  host.appendChild(table);
}

function dqRow(rule: any): HTMLElement {
  const result = dqResult(rule.id);
  const st = dqStatus(rule, result);
  const row = document.createElement('div');
  row.className = 'dq-row is-' + st;
  row.setAttribute('role', 'row');
  row.dataset.ruleId = String(rule.id);
  const cell = (cls: string): HTMLElement => {
    const c = document.createElement('div');
    c.className = cls;
    c.setAttribute('role', 'cell');
    row.appendChild(c);
    return c;
  };

  const pill = document.createElement('span');
  pill.className = 'dq-pill is-' + st;
  pill.append(icon(DQ_STATUS[st].icon, 12), document.createTextNode(DQ_STATUS[st].label));
  cell('dq-c-status').appendChild(pill);

  const what = cell('dq-c-rule');
  const words = document.createElement('span');
  words.className = 'dq-words';
  words.textContent = dqRuleWords(rule, dqNames);
  const kind = document.createElement('span');
  kind.className = 'dq-kindline';
  kind.textContent = dqKindLabel(rule.kind);
  what.append(words, kind);
  if (result && result.error) {
    const e = document.createElement('span');
    e.className = 'dq-rule-err';
    e.textContent = String(result.error);
    what.appendChild(e);
  }

  const sev = document.createElement('span');
  sev.className = 'dq-sev is-' + (rule.severity === 'warn' ? 'warn' : 'fail');
  sev.textContent = rule.severity === 'warn' ? t('common.warn') : t('common.fail');
  cell('dq-c-sev').appendChild(sev);

  const count = cell('dq-c-count tnum');
  if (!result || result.error || result.passed) count.textContent = '—';
  else count.textContent = rule.kind === 'row_count' ? t('dsRules.out_of_range') : dqRows(Number(result.failing) || 0);

  const spark = cell('dq-c-spark dq-spark is-' + st);
  const points = (dqState ? dqState.history : [])
    .map((run: any) => (run && run.failing ? run.failing[rule.id] : undefined))
    .filter((n: any) => typeof n === 'number');
  const svg = aiSparkline(points);
  if (svg) {
    spark.appendChild(svg);
    spark.title = t('dsRules.failing_rows_over_the_last_runs', { pointsCount: points.length });
  } else {
    const none = document.createElement('span');
    none.className = 'dq-spark-none';
    none.textContent = points.length ? t('dsRules.one_run') : t('dsRules.no_runs_yet');
    spark.appendChild(none);
  }

  const acts = cell('dq-c-acts');
  if (result && !result.passed && !result.error && rule.kind !== 'row_count' && result.failing > 0) {
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn btn-ghost btn-sm dq-show';
    iconLabel(show, 'filter', t('dsRules.show_failing_rows'));
    show.addEventListener('click', () => dqShowFailingRows(rule));
    acts.appendChild(show);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'dq-more';
  iconOnly(more, 'more-horizontal', t('dsRules.rule_actions'));
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(more, (el: HTMLElement, close: () => void) => {
      el.classList.add('dq-menu');
      const item = (label: string, run: () => void, danger?: boolean): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item' + (danger ? ' dq-menu-danger' : '');
        b.textContent = label;
        b.addEventListener('click', () => { close(); run(); });
        el.appendChild(b);
      };
      item(t('common.edit_rule'), () => { void dqEdit(rule); });
      item(t('dsRules.delete_rule'), () => { void dqDelete(rule); }, true);
    });
  });
  acts.appendChild(more);
  return row;
}

/**
 * Up to three one-click rules the profile already argues for: a column that is
 * never empty, an id-like column whose values are all distinct, and a number
 * column's current range. Figures are the summaries `dataset:stats` computed.
 */
function dqSuggestions(): any[] {
  const out: any[] = [];
  const sums: any[] = Array.isArray(expSummaries) ? expSummaries : [];
  const n = expRowCount;
  if (n <= 0) return out;
  const full = expColumns.filter((c, i) => sums[i] && sums[i].nonEmpty === n);
  const uniq = expColumns.find((c, i) => c.type === 'text' && n > 1 && sums[i] && sums[i].distinct === n && sums[i].nonEmpty === n);
  // A date is the column whose gaps hurt most; never suggest the unique column twice.
  const others = full.filter((c) => c !== uniq);
  const likely = others.find((c) => c.type === 'date') || others.find((c) => /id|name|key|code/i.test(c.name)) || others[0];
  if (likely) out.push({ kind: 'not_null', column: likely.name, args: {}, severity: 'fail' });
  if (uniq) out.push({ kind: 'unique', column: uniq.name, args: {}, severity: 'fail' });
  const numIdx = expColumns.findIndex((c, i) => c.type === 'number' && sums[i] && typeof sums[i].min === 'number' && sums[i].min !== sums[i].max);
  if (numIdx >= 0) out.push({ kind: 'range', column: expColumns[numIdx].name, args: { min: sums[numIdx].min, max: sums[numIdx].max }, severity: 'warn' });
  return out.slice(0, 3);
}

function dqEmpty(): HTMLElement {
  const box = makeEmptyState({
    variant: 'rules',
    iconName: 'check',
    title: t('dsRules.no_rules_yet'),
    line: t('dsRules.rules_check_this_dataset_on_every'),
    actionLabel: t('common.add_rule'),
    onAction: () => { void dqEdit(null); },
  });
  const sugg = dqSuggestions();
  if (!sugg.length) return box;
  const wrap = document.createElement('div');
  wrap.className = 'dq-suggest';
  const label = document.createElement('span');
  label.className = 'dq-suggest-label';
  label.textContent = t('dsRules.suggested_from_this_data');
  wrap.appendChild(label);
  sugg.forEach((rule) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dq-chip';
    const text = document.createElement('span');
    text.textContent = dqRuleWords(rule, dqNames);
    chip.append(icon('plus', 12), text);
    chip.addEventListener('click', async () => {
      chip.disabled = true;
      let res: any;
      try { res = await window.hub.saveQualityRule(currentProjectId, expId, rule); } catch (_) { res = null; }
      if (res && res.ok) await dqAfterChange(res.quality);
      else {
        chip.disabled = false;
        showToast((res && res.error) || t('dsRules.could_not_add_that_rule'));
      }
    });
    wrap.appendChild(chip);
  });
  box.appendChild(wrap);
  return box;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function dqEdit(rule: any): Promise<void> {
  if (!currentProjectId || !expId) return;
  const res = await dqOpenRuleEditor(rule, {
    projectId: currentProjectId, datasetId: expId, columns: expColumns, summaries: expSummaries, rowCount: expRowCount,
  });
  if (res && res.ok) await dqAfterChange(res.quality);
}

async function dqRun(btn: HTMLButtonElement): Promise<void> {
  if (!currentProjectId || !expId) return;
  btn.disabled = true;
  iconLabel(btn, 'refresh', t('common.checking'));
  let res: any;
  try { res = await window.hub.runQualityChecks(currentProjectId, expId); } catch (_) { res = null; }
  if (!res || res.ok === false) showToast((res && res.error) || t('dsRules.could_not_run_the_checks'));
  await dqAfterChange(res && res.ok ? res : null);
}

async function dqDelete(rule: any): Promise<void> {
  if (!currentProjectId || !expId) return;
  if (!window.confirm(t('dsRules.delete_the_rule', { p0: dqRuleWords(rule, dqNames) }))) return;
  let res: any;
  try { res = await window.hub.deleteQualityRule(currentProjectId, expId, String(rule.id)); } catch (_) { res = null; }
  if (!res || !res.ok) {
    showToast(t('common.could_not_delete_that_rule'));
    return;
  }
  if (dqGridRule && dqGridRule.id === rule.id) dqClearGridRule();
  await dqRenderRules();
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

// ── "Show failing rows" — a temporary filter on the Data grid ────────────────

function dqShowFailingRows(rule: any): void {
  dqGridRule = { id: String(rule.id), words: dqRuleWords(rule, dqNames) };
  // A search left over from browsing would hide failing rows the banner counts.
  expSearch = '';
  const input = dsEl('ds-search') as HTMLInputElement | null;
  if (input) input.value = '';
  expOffset = 0;
  if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-data');
  renderExplorerTable();
}

function dqClearGridRule(): void {
  dqGridRule = null;
  expOffset = 0;
  dqPaintBanner();
  renderExplorerTable();
}

/** Another dataset is opening: nothing about this one's rules carries over. */
function dqResetForDataset(): void {
  dqGridRule = null;
  dqState = null;
  dqLoadSeq += 1;
  const host = document.getElementById('dq-rules');
  if (host) host.textContent = '';
  dqPaintBanner();
}

/** The banner above the grid while a rule filter is on. Painted after each page. */
function dqPaintBanner(): void {
  const banner = document.getElementById('dq-banner');
  if (!banner) return;
  banner.textContent = '';
  banner.hidden = !dqGridRule;
  if (!dqGridRule) return;
  const text = document.createElement('span');
  text.className = 'dq-banner-text';
  const lead = document.createElement('span');
  lead.textContent = t('dsRules.showing_failing', { expTotal: dqRows(expTotal) });
  const words = document.createElement('strong');
  words.textContent = dqGridRule.words;
  text.append(lead, words);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'dq-banner-clear';
  iconLabel(clear, 'x', t('common.clear'));
  clear.addEventListener('click', () => dqClearGridRule());
  banner.append(icon('filter', 14), text, clear);
}

// ── The red dot, wherever a dataset is named ─────────────────────────────────

/** A red dot for `n` failing FAIL rules, or null when there are none. */
function dqDot(n: any): HTMLElement | null {
  const count = typeof n === 'number' && n > 0 ? n : 0;
  if (!count) return null;
  const dot = document.createElement('span');
  dot.className = 'dq-dot';
  const label = t('dsRules.data_quality_failing', { count });
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', label);
  dot.title = label;
  return dot;
}

/** Open a dataset on its Quality tab — the red dot's destination. */
async function dqOpenQualityTab(datasetId: string): Promise<void> {
  if (!datasetId) return;
  if (typeof selectSection === 'function') selectSection('datasets');
  await openSavedDataset(datasetId);
  if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-quality');
}

/**
 * The dashboard header's "Data as of …" line gains "· Data quality: N rules
 * failing" when any dataset the sheet reads is failing. Called by
 * dashGrid.refreshDashFreshness after it sets the line's text.
 */
function dqPaintDashFlag(label: HTMLElement, ids: string[], byId: Map<string, any>): void {
  const bad = ids.map((id) => byId.get(id)).filter((d) => d && typeof d.qualityFailing === 'number' && d.qualityFailing > 0);
  if (!bad.length) return;
  const total = bad.reduce((s, d) => s + d.qualityFailing, 0);
  const text = t('dsRules.data_quality_failing_2', { total });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dq-dash-flag';
  btn.title = bad.length > 1
    ? t('dsRules.across_datasets_opens_s_quality_tab', { text, badCount: bad.length, p2: bad[0].name })
    : t('dsRules.open_s_quality_tab', { p0: bad[0].name });
  const dot = document.createElement('span');
  dot.className = 'dq-dot';
  dot.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.textContent = text;
  btn.append(dot, span);
  btn.addEventListener('click', () => { void dqOpenQualityTab(String(bad[0].id)); });
  label.append(' · ', btn);
}
