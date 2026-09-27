// Background jobs — MAIN PROCESS, and deliberately Electron-free.
//
// Every long operation (import, refresh, export, report, bundle, SQL save,
// quality run, insights recompute, publish, backup) runs as a JOB: it has an
// id, a kind, a label, a progress in 0–1, it may be cancellable, and it ends
// in a result or an error. The Jobs popover (renderer/hub/jobsPanel.ts) paints
// exactly this record; src/ipc/jobs.ts is the only file that knows about
// windows, notifications and the userData path.
//
// ── THE STATE MACHINE ────────────────────────────────────────────────────────
//
//   queued ──▶ running ──▶ done
//     │           ├──────▶ error
//     │           └──────▶ cancelled   (cancel() while running, and run() gave up)
//     └──────────────────▶ cancelled   (cancel() before it started)
//   running|queued ──(the app died)──▶ interrupted   (seen on the next boot)
//
// A job that finishes AFTER cancel() was asked for is reported as what it
// actually did — `done` — because its output exists; claiming "cancelled" over
// a file that was written would be a lie the user finds later.
//
// ── SCHEDULING ───────────────────────────────────────────────────────────────
// At most MAX_RUNNING (3) jobs run at once, and at most ONE per dataset: two
// jobs writing the same dataset's Parquet would race, and the second would
// read what the first half-wrote. The queue is FIFO, but a job blocked on its
// dataset does not block the jobs behind it — the scan takes the first
// STARTABLE job, not the first job.
//
// ── PERSISTENCE ──────────────────────────────────────────────────────────────
// Active jobs (queued + running) and the recent list are written to one JSON
// file whenever the SET changes — not on every progress tick. On the next boot
// `restore()` reads it back and turns anything that was still active into
// `interrupted`: a crash mid-import shows "Interrupted — the app closed while
// this was running" rather than nothing at all.

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export type JobKind =
  | 'import' | 'refresh' | 'export' | 'report' | 'bundle' | 'sql-save' | 'quality'
  | 'insights' | 'publish' | 'backup' | 'restore' | 'automation';

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';

/** What a finished job hands the popover. `path` is what "Reveal" shows. */
export interface JobResult {
  path?: string;
  message?: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  projectId?: string;
  datasetId?: string;
  state: JobState;
  progress: number;
  /** A short line under the label: "412,000 of 1,000,000 rows". */
  note?: string;
  cancellable: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: JobResult;
  error?: string;
  /** Finishing does not notify — the work already says so itself (a scheduled report's own notification). */
  silent?: boolean;
}

export interface JobContext {
  signal: AbortSignal;
  /** Report progress in 0–1 (clamped), with an optional note. */
  progress(p: number, note?: string): void;
  /** Throws JobCancelled if cancel() was asked for. Call between chunks. */
  checkCancelled(): void;
}

export interface JobSpec<T> {
  kind: JobKind;
  label: string;
  projectId?: string;
  datasetId?: string;
  cancellable?: boolean;
  silent?: boolean;
  run: (ctx: JobContext) => Promise<T>;
  /** Map the run's value to what the popover shows (a path to reveal, a line). */
  resultOf?: (value: T) => JobResult | undefined;
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelled';
  }
}

export const MAX_RUNNING = 3;
export const MAX_RECENT = 30;
const KINDS: ReadonlySet<string> = new Set([
  'import', 'refresh', 'export', 'report', 'bundle', 'sql-save', 'quality',
  'insights', 'publish', 'backup', 'restore', 'automation',
]);
const FINAL: ReadonlySet<JobState> = new Set(['done', 'error', 'cancelled', 'interrupted']);

interface Entry {
  job: Job;
  spec: JobSpec<unknown>;
  ctl: AbortController;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let file: string | null = null;
let now: () => Date = () => new Date();
const queue: Entry[] = [];
const running = new Map<string, Entry>();
let recent: Job[] = [];
const listeners = new Set<(jobs: JobsSnapshot) => void>();
const finishListeners = new Set<(job: Job) => void>();

export interface JobsSnapshot {
  active: Job[];
  recent: Job[];
}

/**
 * Where the jobs file lives (null = in memory only), and the clock. Called once
 * by src/ipc/jobs.ts at boot; tests call it to point at a temp file.
 */
export function configure(opts: { file?: string | null; now?: () => Date }): void {
  if (opts.file !== undefined) file = opts.file;
  if (opts.now) now = opts.now;
}

/** Every change to the list (start, progress, finish). Returns an unsubscribe. */
export function onChange(fn: (jobs: JobsSnapshot) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fires once per job as it reaches a final state. */
export function onFinish(fn: (job: Job) => void): () => void {
  finishListeners.add(fn);
  return () => finishListeners.delete(fn);
}

export function snapshot(): JobsSnapshot {
  const active = [...running.values(), ...queue].map((e) => ({ ...e.job }));
  active.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { active, recent: recent.map((j) => ({ ...j })) };
}

export function get(id: string): Job | null {
  const e = running.get(id) || queue.find((q) => q.job.id === id);
  if (e) return { ...e.job };
  const r = recent.find((j) => j.id === id);
  return r ? { ...r } : null;
}

/**
 * Queue a job. Returns its id at once and a promise of the run's value; the
 * promise REJECTS on error or cancel, so a caller that awaits it (an IPC
 * handler that must still answer its renderer) sees the same outcome the
 * popover does.
 */
export function submit<T>(spec: JobSpec<T>): { id: string; done: Promise<T> } {
  if (!spec || !KINDS.has(spec.kind) || typeof spec.run !== 'function') {
    throw new Error('jobs.submit: invalid job spec');
  }
  const job: Job = {
    id: randomUUID(),
    kind: spec.kind,
    label: String(spec.label || spec.kind).slice(0, 200),
    state: 'queued',
    progress: 0,
    cancellable: spec.cancellable !== false,
    createdAt: now().toISOString(),
  };
  if (spec.projectId) job.projectId = spec.projectId;
  if (spec.datasetId) job.datasetId = spec.datasetId;
  if (spec.silent) job.silent = true;
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<T>((res, rej) => {
    resolve = res as (v: unknown) => void;
    reject = rej;
  });
  // An unawaited rejection must not crash main; the state carries the outcome.
  done.catch(() => { /* reported through the job record */ });
  queue.push({ job, spec: spec as JobSpec<unknown>, ctl: new AbortController(), resolve, reject });
  persist();
  emit();
  pump();
  return { id: job.id, done };
}

/** Ask a job to stop. Queued: removed now. Running: its signal aborts. */
export function cancel(id: string): boolean {
  const qi = queue.findIndex((e) => e.job.id === id);
  if (qi >= 0) {
    const [e] = queue.splice(qi, 1);
    finish(e, 'cancelled', undefined, 'Cancelled before it started.');
    e.reject(new JobCancelled());
    pump();
    return true;
  }
  const r = running.get(id);
  if (!r || !r.job.cancellable || r.ctl.signal.aborted) return false;
  r.ctl.abort();
  r.job.note = 'Cancelling…';
  emit();
  return true;
}

/**
 * A job that ran in ANOTHER process — a headless `--cli` / `--mcp` run of the
 * same app writes its jobs to a log the GUI tails (src/ipc/automation.ts), and
 * each one lands here so the Jobs popover shows what automation did. Only a
 * FINISHED job can arrive this way; it is shape-checked like the jobs file.
 */
export function recordExternal(raw: unknown): Job | null {
  const [job] = sanitizeList([raw]);
  if (!job || !FINAL.has(job.state)) return null;
  if (recent.some((j) => j.id === job.id)) return null;
  recent = [job, ...recent].slice(0, MAX_RECENT);
  persist();
  emit();
  return { ...job };
}

const running_ctx = new AsyncLocalStorage<JobContext>();

/**
 * The job whose run() this code is executing inside, or null. Lets a deep
 * callee (a dataset write several calls down a refresh) report progress and
 * honour Cancel without every function between them growing a parameter.
 */
export function current(): JobContext | null {
  return running_ctx.getStore() || null;
}

/** Drop finished jobs from the recent list (the popover's "Clear"). */
export function clearRecent(): void {
  recent = [];
  persist();
  emit();
}

/**
 * Boot: read the file, and turn anything still active in it into
 * `interrupted`. Returns the jobs it interrupted, so the caller can say so.
 */
export function restore(): Job[] {
  if (!file) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return []; // no file yet, or unreadable: nothing to restore, never fatal
  }
  const data = (raw && typeof raw === 'object' ? raw : {}) as { active?: unknown; recent?: unknown };
  const interrupted: Job[] = [];
  const stamp = now().toISOString();
  for (const j of sanitizeList(data.active)) {
    interrupted.push({
      ...j,
      state: 'interrupted',
      finishedAt: stamp,
      error: 'The app closed while this was running.',
      note: undefined,
    });
  }
  recent = [...interrupted, ...sanitizeList(data.recent).filter((j) => FINAL.has(j.state))].slice(0, MAX_RECENT);
  persist();
  emit();
  return interrupted;
}

/** Test hook: forget everything, including in-flight entries. */
export function reset(): void {
  queue.length = 0;
  running.clear();
  recent = [];
  listeners.clear();
  finishListeners.clear();
  file = null;
  now = () => new Date();
}

// ── Internals ────────────────────────────────────────────────────────────────

function startable(e: Entry): boolean {
  if (!e.job.datasetId) return true;
  for (const r of running.values()) if (r.job.datasetId === e.job.datasetId) return false;
  return true;
}

function pump(): void {
  while (running.size < MAX_RUNNING) {
    const i = queue.findIndex(startable);
    if (i < 0) return;
    const [e] = queue.splice(i, 1);
    start(e);
  }
}

function start(e: Entry): void {
  const { job, ctl } = e;
  running.set(job.id, e);
  job.state = 'running';
  job.startedAt = now().toISOString();
  persist();
  emit();
  let lastEmit = 0;
  const ctx: JobContext = {
    signal: ctl.signal,
    progress(p: number, note?: string) {
      if (FINAL.has(job.state)) return;
      // Monotonic: a bar that slides backwards reads as a restart. A nested
      // step reporting its own 0→1 (a dataset write inside a save) only moves
      // the bar once it passes where the job already is.
      const v = Number.isFinite(p) ? Math.max(job.progress, Math.min(1, Math.max(0, p))) : job.progress;
      job.progress = v;
      if (typeof note === 'string') job.note = note.slice(0, 200);
      // Throttled: a per-row progress call must not become a per-row IPC push.
      const t = Date.now();
      if (t - lastEmit >= 100 || v >= 1) {
        lastEmit = t;
        emit();
      }
    },
    checkCancelled() {
      if (ctl.signal.aborted) throw new JobCancelled();
    },
  };
  // A microtask hop, so a run() that throws synchronously is still a rejection.
  // The entry leaves `running` BEFORE its promise settles, so a caller awaiting
  // `done` already sees the job in `recent` and a free slot behind it.
  const settle = (): void => {
    running.delete(job.id);
    pump();
    persist();
    emit();
  };
  Promise.resolve()
    .then(() => running_ctx.run(ctx, () => e.spec.run(ctx)))
    .then(
      (value) => {
        let result: JobResult | undefined;
        try { result = e.spec.resultOf ? e.spec.resultOf(value) : undefined; } catch (_) { result = undefined; }
        job.progress = 1;
        finish(e, 'done', result);
        settle();
        e.resolve(value);
      },
      (err) => {
        const cancelled = err instanceof JobCancelled || (ctl.signal.aborted && isAbort(err));
        finish(e, cancelled ? 'cancelled' : 'error', undefined, cancelled ? 'Cancelled.' : messageOf(err));
        settle();
        e.reject(err);
      },
    );
}

function finish(e: Entry, state: JobState, result?: JobResult, error?: string): void {
  const job = e.job;
  job.state = state;
  job.finishedAt = now().toISOString();
  job.note = undefined;
  if (result && typeof result === 'object') {
    const r: JobResult = {};
    if (typeof result.path === 'string' && result.path) r.path = result.path;
    if (typeof result.message === 'string' && result.message) r.message = result.message.slice(0, 300);
    if (r.path || r.message) job.result = r;
  }
  if (error) job.error = error.slice(0, 500);
  recent = [{ ...job }, ...recent.filter((j) => j.id !== job.id)].slice(0, MAX_RECENT);
  for (const fn of finishListeners) {
    try { fn({ ...job }); } catch (_) { /* a listener must not break the queue */ }
  }
}

function isAbort(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError');
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong.';
}

function emit(): void {
  if (listeners.size === 0) return;
  const snap = snapshot();
  for (const fn of listeners) {
    try { fn(snap); } catch (_) { /* a listener must not break the queue */ }
  }
}

function persist(): void {
  if (!file) return;
  const snap = snapshot();
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
  } catch (_) {
    // Losing the jobs file costs the "interrupted" line after a crash, never a
    // job — so a failed write is swallowed rather than failing the job.
    try { fs.rmSync(tmp, { force: true }); } catch (__) { /* nothing to clean */ }
  }
}

const STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'error', 'cancelled', 'interrupted']);

/** The file is ours, but it is still disk input: shape-check every field. */
function sanitizeList(raw: unknown): Job[] {
  if (!Array.isArray(raw)) return [];
  const out: Job[] = [];
  for (const r of raw.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !KINDS.has(o.kind as string) || !STATES.has(o.state as string)) continue;
    const j: Job = {
      id: o.id,
      kind: o.kind as JobKind,
      label: typeof o.label === 'string' ? o.label.slice(0, 200) : String(o.kind),
      state: o.state as JobState,
      progress: typeof o.progress === 'number' && Number.isFinite(o.progress) ? Math.min(1, Math.max(0, o.progress)) : 0,
      cancellable: o.cancellable === true,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    };
    if (typeof o.projectId === 'string') j.projectId = o.projectId;
    if (typeof o.datasetId === 'string') j.datasetId = o.datasetId;
    if (typeof o.startedAt === 'string') j.startedAt = o.startedAt;
    if (typeof o.finishedAt === 'string') j.finishedAt = o.finishedAt;
    if (typeof o.error === 'string') j.error = o.error.slice(0, 500);
    if (o.silent === true) j.silent = true;
    const res = o.result as Record<string, unknown> | undefined;
    if (res && typeof res === 'object') {
      const jr: JobResult = {};
      if (typeof res.path === 'string') jr.path = res.path;
      if (typeof res.message === 'string') jr.message = res.message.slice(0, 300);
      if (jr.path || jr.message) j.result = jr;
    }
    out.push(j);
  }
  return out;
}
