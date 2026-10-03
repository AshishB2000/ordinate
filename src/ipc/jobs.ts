import { shell } from 'electron';
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import { senderOf } from '../server/context';
import * as fs from 'fs';
import * as path from 'path';
import * as jobs from '../app/jobs';
import * as hubs from '../windows/hubRegistry';
import { notifyJob } from '../app/notify';

// Jobs IPC — the Jobs popover's list, Cancel, Reveal and Clear, the push that
// keeps every hub window's popover live, and the notification when a job
// finishes behind an unfocused window. The queue itself is src/app/jobs.ts,
// which knows nothing about windows; this file is the only one that does.
//
// Reveal takes a JOB ID, never a path: the path comes off the job record main
// wrote, so a renderer cannot ask the OS file manager to open an arbitrary
// location.

const KIND_TITLE: Record<string, string> = {
  import: 'Import finished', refresh: 'Refresh finished', export: 'Export ready', report: 'Report ready',
  bundle: 'Bundle ready', 'sql-save': 'Query saved', quality: 'Quality run finished',
  insights: 'Insights ready', publish: 'Site published', backup: 'Backup written',
  restore: 'Restore finished', automation: 'Automation finished', analysis: 'Analysis finished',
  compute: 'Computation finished',
};

/**
 * Jobs whose WORK runs in a renderer — a report or a PDF is laid out where the
 * chart engine and the document libraries live (see src/ipc/reports.ts). Main
 * still owns the record, so the popover, the notification and "interrupted"
 * treat them like any other job; the renderer only reports progress and the
 * outcome. A window that closes mid-job fails its jobs rather than leaving
 * them running forever.
 */
const RENDERER_KINDS: ReadonlySet<string> = new Set(['report', 'export']);

interface RendererOutcome { ok: boolean; error?: string; message?: string; path?: string }

interface RendererJob {
  ctx: jobs.JobContext | null;
  settle: ((outcome: RendererOutcome) => void) | null;
  pending: { progress?: number; note?: string; outcome?: RendererOutcome };
  senderId: number;
}
const rendererJobs = new Map<string, RendererJob>();

/**
 * Files MAIN wrote on a renderer's behalf (a report's bytes, a saved PDF).
 * A renderer job may name one as its output for "Reveal" — but only a path in
 * this set, so a renderer can never point the OS file manager somewhere main
 * did not write.
 */
const written: string[] = [];
export function noteWrittenPath(p: string): void {
  if (typeof p !== 'string' || !p) return;
  written.push(p);
  if (written.length > 50) written.shift();
}

export function register(deps: { hubFocused: () => boolean; focusHub: () => void; headless?: boolean }) {
  // jobs.json belongs to the GUI. A headless run (--cli / --mcp) keeps its
  // queue in memory and logs finished jobs for the GUI to show
  // (src/automation/jobLog.ts) — it must never rewrite or "interrupt" the
  // GUI's running jobs.
  if (!deps.headless) {
    jobs.configure({ file: path.join(appPaths.userData(), 'jobs.json') });
    const interrupted = jobs.restore();
    if (interrupted.length) console.warn('[jobs]', interrupted.length, 'job(s) were interrupted by the last shutdown');
  }

  jobs.onChange((snap) => hubs.broadcast('jobs:changed', snap));
  jobs.onFinish((job) => {
    if (job.state !== 'done' && job.state !== 'error') return; // cancelled: the user was there
    if (job.silent) return;
    if (deps.hubFocused()) return;
    const title = job.state === 'error' ? 'Job failed' : (KIND_TITLE[job.kind] || 'Job finished');
    const body = job.state === 'error' ? `${job.label} — ${job.error || 'failed'}` : job.label;
    const out = job.result && job.result.path;
    notifyJob(title, body, () => {
      if (out && fs.existsSync(out)) shell.showItemInFolder(out);
      else deps.focusHub();
    });
  });

  ipcMain.handle('jobs:list', () => jobs.snapshot());

  ipcMain.handle('jobs:cancel', (_e, { id }: { id?: unknown } = {}) => ({ ok: jobs.cancel(String(id || '')) }));

  ipcMain.handle('jobs:clear', () => {
    jobs.clearRecent();
    return { ok: true };
  });

  ipcMain.handle('jobs:rendererStart', (e, { kind, label, projectId, silent }: { kind?: unknown; label?: unknown; projectId?: unknown; silent?: unknown } = {}) => {
    if (typeof kind !== 'string' || !RENDERER_KINDS.has(kind)) return { ok: false, error: 'Not a renderer job kind.' };
    const sender = senderOf(e);
    const entry: RendererJob = { ctx: null, settle: null, pending: {}, senderId: sender.id };
    const job = jobs.submit<RendererOutcome>({
      kind: kind as jobs.JobKind,
      label: typeof label === 'string' && label ? label : 'Working…',
      projectId: typeof projectId === 'string' ? projectId : undefined,
      silent: silent === true,
      run: (ctx) => new Promise((resolve, reject) => {
        entry.ctx = ctx;
        entry.settle = (o) => (o.ok ? resolve(o) : reject(new Error(o.error || 'Failed.')));
        ctx.signal.addEventListener('abort', () => {
          if (!sender.isDestroyed()) sender.send('jobs:rendererCancel', job.id);
        });
        if (entry.pending.progress !== undefined) ctx.progress(entry.pending.progress, entry.pending.note);
        if (entry.pending.outcome) entry.settle(entry.pending.outcome);
      }),
      resultOf: (o) => (o && (o.message || o.path) ? { message: o.message, path: o.path } : undefined),
    });
    rendererJobs.set(job.id, entry);
    job.done.finally(() => rendererJobs.delete(job.id)).catch(() => { /* reported on the record */ });
    sender.once('destroyed', () => {
      const r = rendererJobs.get(job.id);
      if (!r) return;
      const lost = { ok: false, error: 'The window closed before this finished.' };
      if (r.settle) r.settle(lost); else r.pending.outcome = lost;
    });
    return { ok: true, id: job.id };
  });

  ipcMain.handle('jobs:rendererUpdate', (e, { id, progress, note }: { id?: unknown; progress?: unknown; note?: unknown } = {}) => {
    const r = rendererJobs.get(String(id || ''));
    if (!r || r.senderId !== senderOf(e).id) return { ok: false };
    const p = Number(progress);
    const n = typeof note === 'string' ? note : undefined;
    if (r.ctx) r.ctx.progress(p, n); else r.pending = { ...r.pending, progress: p, note: n };
    return { ok: true, cancelled: Boolean(r.ctx && r.ctx.signal.aborted) };
  });

  ipcMain.handle('jobs:rendererFinish', (e, { id, ok, error, message, path: out }: { id?: unknown; ok?: unknown; error?: unknown; message?: unknown; path?: unknown } = {}) => {
    const r = rendererJobs.get(String(id || ''));
    if (!r || r.senderId !== senderOf(e).id) return { ok: false };
    const outcome = {
      ok: ok === true,
      error: typeof error === 'string' ? error : undefined,
      message: typeof message === 'string' ? message : undefined,
      path: typeof out === 'string' && written.includes(out) ? out : undefined,
    };
    if (r.settle) r.settle(outcome); else r.pending.outcome = outcome;
    return { ok: true };
  });

  ipcMain.handle('jobs:reveal', (_e, { id }: { id?: unknown } = {}) => {
    const job = jobs.get(String(id || ''));
    const p = job && job.result && job.result.path;
    if (!p) return { ok: false, error: 'This job has no file to show.' };
    if (!fs.existsSync(p)) return { ok: false, error: 'The file is no longer there.' };
    shell.showItemInFolder(p);
    return { ok: true };
  });
}
