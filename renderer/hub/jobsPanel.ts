'use strict';

// The Jobs popover: the top-bar button that spins while anything runs, and the
// list under it — running jobs with a progress bar and Cancel, recent jobs with
// their outcome and "Reveal" for anything that wrote a file. Classic
// global-scope <script>: no import/export.
//
// EVERYTHING HERE IS MAIN'S RECORD. src/app/jobs.ts owns the queue and the
// state machine; this file paints `jobs:changed` snapshots and sends Cancel /
// Reveal / Clear back by job id. It never decides a job's state, and Reveal
// never sends a path — main looks the path up on its own record.

interface JpJob {
  id: string;
  kind: string;
  label: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  progress: number;
  note?: string;
  cancellable: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: { path?: string; message?: string };
  error?: string;
}

let jpState: { active: JpJob[]; recent: JpJob[] } = { active: [], recent: [] };
let jpPopover: HTMLElement | null = null;

const JP_KIND_ICON: Record<string, string> = {
  import: 'upload', refresh: 'refresh', export: 'download', report: 'file-text', bundle: 'package',
  'sql-save': 'code', quality: 'circle-check', insights: 'sparkles', publish: 'globe',
  backup: 'hard-drive', restore: 'rotate-ccw', automation: 'terminal', analysis: 'activity',
};

const JP_STATE_WORD: Record<string, string> = {
  queued: 'Waiting', running: 'Running', done: 'Done', error: 'Failed',
  cancelled: 'Cancelled', interrupted: 'Interrupted',
};

function jpBtn(): HTMLButtonElement | null {
  return document.getElementById('topbar-jobs') as HTMLButtonElement | null;
}

/** "just now", "4 min ago", "2 h ago", then a date. */
function jpAgo(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString();
}

/** How long a finished job took, when it ran at all. */
function jpDuration(j: JpJob): string {
  const a = j.startedAt ? Date.parse(j.startedAt) : NaN;
  const b = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const ms = b - a;
  if (ms < 1000) return ms + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + ' s';
  return Math.round(ms / 60_000) + ' min';
}

// ── The button ───────────────────────────────────────────────────────────────

function jpPaintButton(): void {
  const btn = jpBtn();
  if (!btn) return;
  const running = jpState.active.filter((j) => j.state === 'running').length;
  const waiting = jpState.active.length - running;
  btn.classList.toggle('is-busy', jpState.active.length > 0);
  let badge = btn.querySelector('.jp-badge') as HTMLElement | null;
  if (jpState.active.length === 0) {
    if (badge) badge.remove();
  } else {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'jp-badge';
      btn.appendChild(badge);
    }
    badge.textContent = String(Math.min(jpState.active.length, 9)) + (jpState.active.length > 9 ? '+' : '');
  }
  const label = jpState.active.length === 0
    ? 'Jobs'
    : `Jobs — ${running} running` + (waiting ? `, ${waiting} waiting` : '');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// ── The popover ──────────────────────────────────────────────────────────────

function jpClose(): void {
  if (!jpPopover) return;
  jpPopover.remove();
  jpPopover = null;
  const btn = jpBtn();
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', jpOnKey, true);
  document.removeEventListener('mousedown', jpOnOutside, true);
}

function jpOnKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); jpClose(); }
}

function jpOnOutside(e: MouseEvent): void {
  const t = e.target as Node;
  if (jpPopover && jpPopover.contains(t)) return;
  const btn = jpBtn();
  if (btn && btn.contains(t)) return;
  jpClose();
}

async function jpToggle(): Promise<void> {
  if (jpPopover) { jpClose(); return; }
  const btn = jpBtn();
  if (!btn) return;
  jpPopover = document.createElement('div');
  jpPopover.className = 'jp-pop';
  jpPopover.id = 'jp-pop';
  jpPopover.setAttribute('role', 'dialog');
  jpPopover.setAttribute('aria-label', 'Jobs');
  document.body.appendChild(jpPopover);
  btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', jpOnKey, true);
  document.addEventListener('mousedown', jpOnOutside, true);
  const rect = btn.getBoundingClientRect();
  const w = 400;
  jpPopover.style.top = Math.round(rect.bottom + 6) + 'px';
  jpPopover.style.left = Math.round(Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))) + 'px';
  await jpRefresh();
  jpRender();
}

async function jpRefresh(): Promise<void> {
  try {
    const snap = await window.hubPlatform.listJobs();
    if (snap && Array.isArray(snap.active)) jpState = snap;
  } catch (_) { /* keep the last snapshot — the push will correct it */ }
  jpPaintButton();
}

function jpRender(): void {
  if (!jpPopover) return;
  jpPopover.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'jp-head';
  const title = document.createElement('span');
  title.className = 'jp-title';
  title.textContent = 'Jobs';
  head.appendChild(title);
  if (jpState.recent.length) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'jp-link';
    clear.textContent = 'Clear finished';
    clear.addEventListener('click', async () => {
      try { await window.hubPlatform.clearJobs(); } catch (_) { /* the push repaints */ }
      await jpRefresh();
      jpRender();
    });
    head.appendChild(clear);
  }
  jpPopover.appendChild(head);

  const list = document.createElement('div');
  list.className = 'jp-list';
  if (jpState.active.length === 0 && jpState.recent.length === 0) {
    list.appendChild(makeEmptyState({
      variant: 'jobs',
      iconName: 'activity',
      title: 'Nothing running',
      line: 'Imports, refreshes, exports, publishes and backups show up here while they run — you can keep working.',
    }));
  } else {
    if (jpState.active.length) {
      list.appendChild(jpSection('Running'));
      jpState.active.forEach((j) => list.appendChild(jpRow(j)));
    }
    if (jpState.recent.length) {
      list.appendChild(jpSection('Recent'));
      jpState.recent.forEach((j) => list.appendChild(jpRow(j)));
    }
  }
  jpPopover.appendChild(list);
}

function jpSection(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'jp-section';
  h.textContent = text;
  return h;
}

function jpRow(j: JpJob): HTMLElement {
  const row = document.createElement('div');
  row.className = 'jp-row jp-row--' + j.state;
  row.dataset.jobId = j.id;

  const ic = document.createElement('span');
  ic.className = 'jp-ic';
  ic.appendChild(icon(JP_KIND_ICON[j.kind] || 'activity'));
  row.appendChild(ic);

  const main = document.createElement('div');
  main.className = 'jp-main';
  const name = document.createElement('div');
  name.className = 'jp-name';
  name.textContent = j.label;
  name.title = j.label;
  main.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'jp-meta';
  const chip = document.createElement('span');
  chip.className = 'jp-state jp-state--' + j.state;
  chip.textContent = JP_STATE_WORD[j.state] || j.state;
  meta.appendChild(chip);
  const detail = document.createElement('span');
  detail.className = 'jp-detail';
  if (j.state === 'running' || j.state === 'queued') {
    detail.textContent = j.note || (j.state === 'queued' ? 'Waiting for a free slot' : Math.round(j.progress * 100) + '%');
  } else {
    const bits = [jpAgo(j.finishedAt)];
    const d = jpDuration(j);
    if (d && j.state === 'done') bits.push(d);
    detail.textContent = bits.filter(Boolean).join(' · ');
  }
  meta.appendChild(detail);
  main.appendChild(meta);

  if (j.state === 'running' || j.state === 'queued') {
    const bar = document.createElement('div');
    bar.className = 'jp-bar' + (j.state === 'queued' ? ' is-waiting' : '');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', j.label);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(j.progress * 100)));
    const fill = document.createElement('div');
    fill.className = 'jp-bar-fill';
    fill.style.width = Math.round(j.progress * 100) + '%';
    bar.appendChild(fill);
    main.appendChild(bar);
  }
  const line = j.state === 'error' || j.state === 'interrupted' ? j.error : (j.result && j.result.message);
  if (line) {
    const msg = document.createElement('div');
    msg.className = 'jp-msg';
    msg.textContent = line;
    main.appendChild(msg);
  }
  row.appendChild(main);

  const acts = document.createElement('div');
  acts.className = 'jp-acts';
  if ((j.state === 'running' || j.state === 'queued') && j.cancellable) {
    acts.appendChild(jpAction('Cancel', 'x', async () => {
      try { await window.hubPlatform.cancelJob(j.id); } catch (_) { /* the push repaints */ }
    }));
  }
  if (j.state === 'done' && j.result && j.result.path) {
    acts.appendChild(jpAction('Reveal', 'folder', async () => {
      let res: any = null;
      try { res = await window.hubPlatform.revealJob(j.id); } catch (_) { res = null; }
      if (!res || !res.ok) showToast((res && res.error) || 'Could not show the file.');
    }));
  }
  row.appendChild(acts);
  return row;
}

function jpAction(label: string, iconName: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm jp-act';
  b.append(icon(iconName), document.createTextNode(label));
  b.addEventListener('click', () => { void onClick(); });
  return b;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

{
  const btn = jpBtn();
  if (btn) btn.addEventListener('click', () => { void jpToggle(); });
  if (window.hubPlatform && typeof window.hubPlatform.onJobsChanged === 'function') {
    window.hubPlatform.onJobsChanged((snap: any) => {
      if (!snap || !Array.isArray(snap.active)) return;
      jpState = snap;
      jpPaintButton();
      if (jpPopover) jpRender();
    });
    // Boot: the popover is closed, but the button must spin for a job that
    // started before this window did (a second window, a reload).
    void jpRefresh();
  }
}

// ── Jobs whose work runs HERE ────────────────────────────────────────────────

class RjCancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'RjCancelled'; }
}

const rjCancelled = new Set<string>();
if (window.hubPlatform && typeof window.hubPlatform.onRendererJobCancel === 'function') {
  window.hubPlatform.onRendererJobCancel((id: string) => { rjCancelled.add(id); });
}

/**
 * Run renderer-side work (a report laid out with the document libraries that
 * only exist here) as a job main tracks: a row in the Jobs popover, progress,
 * Cancel, "interrupted" if the window dies. `work` gets `step(p, note)`,
 * which reports progress and THROWS once Cancel was asked for — call it
 * between pages. It returns what the job should say it produced: `path` is
 * honoured by main only if main itself wrote that file.
 */
async function rjRun<T extends { path?: string; message?: string } | null>(
  kind: 'report' | 'export',
  label: string,
  projectId: string | undefined,
  work: (step: (p: number, note?: string) => Promise<void>) => Promise<T>,
  opts: { silent?: boolean } = {},
): Promise<T | null> {
  let id = '';
  try {
    const started = await window.hubPlatform.startRendererJob(kind, label, projectId, opts.silent === true);
    if (started && started.ok) id = String(started.id);
  } catch (_) { id = ''; }
  const step = async (p: number, note?: string): Promise<void> => {
    if (!id) return;
    if (rjCancelled.has(id)) throw new RjCancelled();
    try { await window.hubPlatform.updateRendererJob(id, p, note); } catch (_) { /* the bar is a courtesy */ }
    if (rjCancelled.has(id)) throw new RjCancelled();
  };
  try {
    const out = await work(step);
    if (id) {
      await window.hubPlatform.finishRendererJob(id, out
        ? { ok: true, message: out.message, path: out.path }
        : { ok: false, error: 'Nothing was produced.' });
    }
    return out;
  } catch (err: any) {
    const cancelled = err instanceof RjCancelled;
    if (id) {
      try {
        await window.hubPlatform.finishRendererJob(id, { ok: false, error: cancelled ? 'Cancelled.' : String((err && err.message) || err || 'Failed') });
      } catch (_) { /* main will fail it when the window goes */ }
    }
    if (cancelled) return null;
    throw err;
  } finally {
    if (id) rjCancelled.delete(id);
  }
}
