'use strict';

// Find segments — one dataset's segmentation page, a full-width `.ws-panel`
// (section "segments") reached from the dataset header's ⋯ menu and the
// command palette. Two tabs: k-means over number columns (this file: the
// page shell, the column picker, Run with progress and Cancel; the results in
// segmentsView.ts) and the RFM preset (segmentsRfm.ts).
//
// Classic global-scope renderer <script>: no import/export. The page is built
// HERE at first open rather than in index.html, like the Snapshots tab. Every
// figure on it is main's (src/ipc/segments.ts): this file lays them out and
// formats nothing but thousands separators and percentages. textContent only.

interface SgFeature {
  name: string;
  checked: boolean;
  reason?: string;
}

interface SgInfo {
  projectId: string;
  datasetId: string;
  name: string;
  rowCount: number;
  sampleCap: number;
  features: SgFeature[];
  otherColumns: number;
  columns: Array<{ name: string; type: string }>;
  rfm: { id: string; date: string; amount: string };
}

let sgInfo: SgInfo | null = null;
/** Bumped on every open, so a late reply for another dataset is dropped. */
let sgSeq = 0;
let sgBusy = '';
let sgJobId = '';
let sgJobUnsub: (() => void) | null = null;

const SG_REASON: Record<string, string> = {
  'id-like': 'looks like an id',
  'near-constant': 'nearly constant',
  'mostly empty': 'mostly empty',
  'no values': 'no values',
};

function sgEl<T extends HTMLElement = HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function sgFmt(n: number, digits = 0): string {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function sgPct(share: number): string {
  const p = share * 100;
  return (p > 0 && p < 0.1 ? '<0.1' : p.toLocaleString('en-US', { maximumFractionDigits: 1 })) + '%';
}

/** Segment i's colour — the chart palette tokens, so both themes follow. */
function sgColor(i: number): string {
  return getCSSVar(`--chart-${(i % 8) + 1}`) || CHART_PALETTE[i % CHART_PALETTE.length];
}

function sgButton(cls: string, iconName: string | null, label: string, onClick: () => void): HTMLButtonElement {
  const b = sgEl<HTMLButtonElement>('button', cls);
  b.type = 'button';
  if (iconName) iconLabel(b, iconName, label);
  else b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** An empty-state card in the house style. */
function sgEmpty(iconName: string, title: string, body: string): HTMLElement {
  const box = sgEl('div', 'ws-empty sg-empty');
  const ic = sgEl('div', 'ws-empty-icon');
  ic.appendChild(icon(iconName, 20));
  box.append(ic, sgEl('h3', 'ws-empty-h', title), sgEl('p', 'ws-empty-p', body));
  return box;
}

// ── The page ──────────────────────────────────────────────────────────────────

function sgMount(): HTMLElement {
  const existing = document.getElementById('ws-segments');
  if (existing) return existing;
  const sec = sgEl('section', 'ws-panel sg-panel');
  sec.id = 'ws-segments';
  sec.dataset.section = 'segments';
  sec.hidden = true;
  const page = sgEl('div', 'ds-panel sg-page');
  sec.appendChild(page);

  const head = sgEl('div', 'sg-head');
  const back = sgButton('btn btn-sm ds-back', 'arrow-left', 'Back to dataset', () => sgBack());
  back.id = 'sg-back';
  const ident = sgEl('div', 'sg-ident');
  const title = sgEl('h2', 'sg-title', 'Find segments');
  title.id = 'sg-title';
  const sub = sgEl('p', 'sg-sub');
  sub.id = 'sg-sub';
  ident.append(title, sub);
  head.append(back, ident);

  const tabs = sgEl('div', 'tabs sg-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Segmentation method');
  const tab = (id: string, label: string, mode: 'kmeans' | 'rfm'): HTMLButtonElement => {
    const b = sgButton('tab sg-tab', null, label, () => sgSelectTab(mode, true));
    b.id = id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `sg-tabp-${mode}`);
    b.dataset.mode = mode;
    return b;
  };
  const tk = tab('sg-tab-kmeans', 'Segments (k-means)', 'kmeans');
  const tr = tab('sg-tab-rfm', 'Customers (RFM)', 'rfm');
  tabs.append(tk, tr);
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    sgSelectTab(tk.getAttribute('aria-selected') === 'true' ? 'rfm' : 'kmeans', true);
  });

  const panel = (mode: string, tabId: string): HTMLElement => {
    const p = sgEl('div', 'sg-tabp');
    p.id = `sg-tabp-${mode}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', tabId);
    return p;
  };
  page.append(head, tabs, panel('kmeans', 'sg-tab-kmeans'), panel('rfm', 'sg-tab-rfm'));

  const anchor = document.getElementById('ws-datasets');
  if (anchor) anchor.after(sec);
  else document.body.appendChild(sec);
  // Segments are an action inside Data, so the Data nav item stays lit.
  document.querySelectorAll('.as-nav-item[data-section="datasets"]').forEach((n) => {
    const el = n as HTMLElement;
    const alt = (el.dataset.sectionAlt || '').split(/\s+/).filter(Boolean);
    if (!alt.includes('segments')) el.dataset.sectionAlt = [...alt, 'segments'].join(' ');
  });
  return sec;
}

function sgSelectTab(mode: 'kmeans' | 'rfm', focus: boolean): void {
  for (const m of ['kmeans', 'rfm']) {
    const t = document.getElementById(`sg-tab-${m}`);
    const p = document.getElementById(`sg-tabp-${m}`);
    const on = m === mode;
    if (t) {
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    if (p) p.hidden = !on;
  }
}

/** Open the page for a dataset (default: the one open in the explorer). */
async function sgOpen(datasetId?: string, name?: string, mode: 'kmeans' | 'rfm' = 'kmeans'): Promise<void> {
  const id = datasetId || expId;
  if (!currentProjectId || !id) return;
  const projectId = currentProjectId;
  sgMount();
  const seq = ++sgSeq;
  sgInfo = null;
  sgResult = null;
  sgRfmResult = null;
  selectSection('segments');
  sgSelectTab(mode, false);
  const sub = document.getElementById('sg-sub');
  if (sub) sub.textContent = name || expName || '';
  for (const m of ['kmeans', 'rfm']) {
    const p = document.getElementById(`sg-tabp-${m}`);
    if (!p) continue;
    p.textContent = '';
    const wait = sgEl('div', 'sg-card sg-loading');
    wait.setAttribute('role', 'status');
    wait.append(icon('loader', 16), sgEl('span', '', 'Reading the columns…'));
    p.appendChild(wait);
  }
  let res: any = null;
  try {
    res = await window.hubSegments.features(projectId, id);
  } catch (_) {
    res = null;
  }
  if (seq !== sgSeq) return;
  if (!res || !res.ok) {
    for (const m of ['kmeans', 'rfm']) {
      const p = document.getElementById(`sg-tabp-${m}`);
      if (!p) continue;
      p.textContent = '';
      p.appendChild(sgEmpty('alert', 'This dataset could not be read', (res && res.error) || 'Go back and open it again.'));
    }
    return;
  }
  sgInfo = { projectId, datasetId: id, ...res } as SgInfo;
  if (sub) sub.textContent = `${res.name} · ${sgFmt(res.rowCount)} rows`;
  const back = document.getElementById('sg-back');
  if (back) iconLabel(back, 'arrow-left', `Back to ${res.name}`);
  sgPaintKmeans();
  sgPaintRfm();
}

function sgBack(): void {
  const id = sgInfo ? sgInfo.datasetId : '';
  sgSeq++;
  sgStopWatch();
  selectSection('datasets');
  if (id) void openSavedDataset(id);
}

// ── k-means: the column picker and Run ────────────────────────────────────────

function sgChecked(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#sg-chips input[type="checkbox"]')].filter((b) => b.checked).map((b) => b.value);
}

function sgSyncRun(): void {
  const run = document.getElementById('sg-run') as HTMLButtonElement | null;
  const hint = document.getElementById('sg-run-hint');
  const n = sgChecked().length;
  if (run) run.disabled = n < 2 || !!sgBusy;
  if (hint && sgInfo) {
    const rows = sgInfo.rowCount > sgInfo.sampleCap
      ? `an even ${sgFmt(sgInfo.sampleCap)} of ${sgFmt(sgInfo.rowCount)} rows are fitted, every row is assigned`
      : `${sgFmt(sgInfo.rowCount)} rows`;
    hint.textContent = n < 2 ? 'Pick at least two columns.' : `${n} columns · ${rows}`;
  }
}

function sgSetupCard(info: SgInfo): HTMLElement {
  const card = sgEl('section', 'sg-card sg-setup');
  card.setAttribute('aria-labelledby', 'sg-cols-h');
  const head = sgEl('div', 'sg-card-head');
  const h = sgEl('h3', 'sg-card-h', 'Columns to compare');
  h.id = 'sg-cols-h';
  head.append(h, sgEl('p', 'sg-hint',
    'Each column is put on the same scale, then rows that are alike are grouped. The number of segments, 2 to 8, is the one with the best silhouette score. Ticked by default: every number column the profile does not flag.'));
  card.appendChild(head);

  const chips = sgEl('div', 'sg-chips');
  chips.id = 'sg-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-labelledby', 'sg-cols-h');
  for (const f of info.features) {
    const chip = sgEl<HTMLLabelElement>('label', 'sg-chip' + (f.reason ? ' is-skipped' : ''));
    const box = sgEl<HTMLInputElement>('input', 'sg-chip-box');
    box.type = 'checkbox';
    box.value = f.name;
    box.checked = f.checked;
    box.addEventListener('change', () => {
      chip.classList.toggle('is-on', box.checked);
      sgSyncRun();
    });
    chip.classList.toggle('is-on', f.checked);
    chip.append(box, sgEl('span', 'sg-chip-name', f.name));
    if (f.reason) {
      chip.appendChild(sgEl('span', 'sg-chip-why', SG_REASON[f.reason] || f.reason));
      chip.title = `Not ticked: ${SG_REASON[f.reason] || f.reason}`;
    }
    chips.appendChild(chip);
  }
  card.appendChild(chips);
  if (!info.features.length) {
    card.appendChild(sgEl('p', 'sg-note', 'This dataset has no number columns, so there is nothing to compare. RFM works on a date and an amount.'));
  } else if (info.otherColumns) {
    card.appendChild(sgEl('p', 'sg-note', `${info.otherColumns} text or date column${info.otherColumns === 1 ? ' is' : 's are'} not listed — segments compare numbers.`));
  }

  const row = sgEl('div', 'sg-run-row');
  const run = sgButton('btn btn-primary', 'play', 'Find segments', () => void sgRun());
  run.id = 'sg-run';
  const hint = sgEl('span', 'sg-run-hint');
  hint.id = 'sg-run-hint';
  row.append(run, hint);
  card.append(row, sgProgressBox('sg'), sgErrorLine('sg'));
  return card;
}

function sgProgressBox(prefix: string): HTMLElement {
  const box = sgEl('div', 'sg-progress');
  box.id = `${prefix}-progress`;
  box.hidden = true;
  box.setAttribute('role', 'status');
  const bar = sgEl('div', 'sg-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Progress');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = sgEl('div', 'sg-bar-fill');
  bar.appendChild(fill);
  const note = sgEl('span', 'sg-progress-note');
  const cancel = sgButton('btn btn-sm', 'x', 'Cancel', () => {
    if (sgJobId) void window.hubPlatform.cancelJob(sgJobId);
  });
  cancel.classList.add('sg-cancel');
  box.append(bar, note, cancel);
  return box;
}

function sgErrorLine(prefix: string): HTMLElement {
  const p = sgEl('p', 'sg-error');
  p.id = `${prefix}-error`;
  p.setAttribute('role', 'alert');
  p.hidden = true;
  return p;
}

function sgShowError(prefix: string, text: string, soft = false): void {
  const p = document.getElementById(`${prefix}-error`);
  if (!p) return;
  p.textContent = '';
  p.hidden = !text;
  p.classList.toggle('is-soft', soft);
  if (text) p.append(icon(soft ? 'info' : 'alert', 16), sgEl('span', '', text));
}

function sgProgress(prefix: string, show: boolean, fraction = 0, note = ''): void {
  const box = document.getElementById(`${prefix}-progress`);
  if (!box) return;
  box.hidden = !show;
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const fill = box.querySelector('.sg-bar-fill') as HTMLElement | null;
  if (fill) fill.style.width = `${Math.max(3, pct)}%`;
  box.querySelector('.sg-bar')?.setAttribute('aria-valuenow', String(pct));
  const n = box.querySelector('.sg-progress-note');
  if (n) n.textContent = note;
}

/** Follow this dataset's running 'analysis' job: its progress, and what Cancel cancels. */
function sgWatchJob(datasetId: string, prefix: string): void {
  sgStopWatch();
  const bridge = window.hubPlatform;
  if (!bridge || typeof bridge.onJobsChanged !== 'function') return;
  sgJobUnsub = bridge.onJobsChanged((snap: any) => {
    const job = ((snap && snap.active) || []).find((j: any) => j && j.kind === 'analysis' && j.datasetId === datasetId);
    if (!job) return;
    sgJobId = String(job.id || '');
    const note = job.state === 'queued' ? 'Waiting for another job on this dataset…' : job.note || 'Working…';
    sgProgress(prefix, true, Number(job.progress) || 0, note);
  });
}

function sgStopWatch(): void {
  if (sgJobUnsub) sgJobUnsub();
  sgJobUnsub = null;
  sgJobId = '';
}

function sgPaintKmeans(): void {
  const host = document.getElementById('sg-tabp-kmeans');
  if (!host || !sgInfo) return;
  host.textContent = '';
  const results = sgEl('div', 'sg-results');
  results.id = 'sg-results';
  host.append(sgSetupCard(sgInfo), results);
  sgSyncRun();
  sgPaintResults();
}

async function sgRun(): Promise<void> {
  if (!sgInfo || sgBusy) return;
  const features = sgChecked();
  if (features.length < 2) return;
  const info = sgInfo;
  const seq = sgSeq;
  sgBusy = 'fit';
  sgShowError('sg', '');
  sgSyncRun();
  sgProgress('sg', true, 0, 'Starting…');
  sgWatchJob(info.datasetId, 'sg');
  let res: any;
  try {
    res = await window.hubSegments.fit(info.projectId, info.datasetId, features);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : 'Could not find segments' };
  }
  sgStopWatch();
  sgBusy = '';
  if (seq !== sgSeq) return;
  sgProgress('sg', false);
  sgSyncRun();
  if (!res || !res.ok) {
    if (res && res.cancelled) sgShowError('sg', 'Stopped. Nothing was changed.', true);
    else sgShowError('sg', (res && res.error) || 'Could not find segments.');
    return;
  }
  sgResult = res.result;
  sgPaintResults();
}

// ── The Prepare panel's view of a saved segment step ──────────────────────────

/** The step list's line for a segment step (prepare.ts stepSummaryText). */
function sgStepSummary(step: any): string | null {
  if (!step || step.type !== 'segment') return null;
  const k = Array.isArray(step.names) ? step.names.length : 0;
  const by = Array.isArray(step.features) ? step.features.join(', ') : '';
  return `Segments: ${k} groups by ${by} → ${step.column}`;
}

/** The ✎ editor for a segment step: the model is the fit's, only the column's name changes here. */
function sgBuildStepForm(type: string, body: HTMLElement, existing: any): (() => any) | null {
  if (type !== 'segment' || !existing) return null;
  const input = textInput(String(existing.column || ''));
  body.appendChild(fieldRow('Column', input));
  const list = sgEl('ul', 'sg-step-names');
  list.setAttribute('aria-label', 'Segments this step assigns');
  (Array.isArray(existing.names) ? existing.names : []).forEach((n: string, i: number) => {
    const li = sgEl('li', 'sg-step-name');
    const sw = sgEl('span', 'sg-swatch');
    sw.style.background = sgColor(i);
    li.append(sw, sgEl('span', '', n));
    list.appendChild(li);
  });
  body.appendChild(list);
  const note = sgEl('p', 'sg-step-note',
    `The model — each column's mean and spread, and ${list.childElementCount} centroids — was fitted by Find segments and is reapplied on every refresh. To change it, fit again.`);
  body.appendChild(note);
  body.appendChild(sgButton('btn btn-sm', 'layers', 'Open Find segments', () => void sgOpen(expId, expName)));
  return () => {
    const column = input.value.trim();
    if (!column) {
      window.alert('Name the column.');
      return null;
    }
    return { ...existing, column };
  };
}
