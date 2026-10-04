// The regex pool — MAIN PROCESS. Runs a user regex over a batch of texts in
// ./regexWorker.ts under a per-call DEADLINE, and kills the thread when the
// deadline passes (T6.4, threat-model R1).
//
// WHY A THREAD AND A KILL. A JavaScript match cannot be interrupted from its
// own thread, the regex subset needs the `u` flag, and V8's linear engine does
// not run `u` patterns (measured in T6.3). So the only bound on `(\w+)+!` over
// a 40-character cell is to run it where it can be terminated: the request
// awaits, the event loop keeps serving, and a call that overruns rejects with
// RegexTimeout after DEADLINE_MS. The killed thread is replaced lazily.
//
// Batching: one call per BATCH of distinct texts (the caller dedupes), so an
// ordinary step costs a few messages, not one per cell, and each call's legal
// work stays far below the deadline however large the table.
//
// Not the compute pool: that one leases a DuckDB port and its threads cost
// 133–537 ms cold (log.md T4.1); this thread loads three pure modules.

import * as path from 'path';
import { Worker } from 'worker_threads';
import type { RegexSpec } from './regexWorker';

export type { RegexSpec } from './regexWorker';

/** Per call. A legal batch takes milliseconds (T6.4 measurements in threat-model R1). */
export const DEADLINE_MS = 2_000;
/** Texts / characters per call — bounds a legal call's work, whatever the table. */
const BATCH_TEXTS = 20_000;
const BATCH_CHARS = 4_000_000;
/** Calls in flight at once; more wait. One idle thread is kept warm. */
const MAX_BUSY = 4;
const KEEP_IDLE = 1;

let deadlineMs = DEADLINE_MS;
let workerFile = path.join(__dirname, 'regexWorker.js');

export class RegexTimeout extends Error {
  constructor(readonly deadlineMs: number) {
    super(`A pattern ran past the ${deadlineMs} ms deadline`);
    this.name = 'RegexTimeout';
  }
}

/** The deadline now in force (the timeout sentence quotes it). */
export function deadline(): number {
  return deadlineMs;
}

/** Test hooks. */
export function setDeadlineForTest(ms: number | null): void {
  deadlineMs = ms ?? DEADLINE_MS;
}
export function setWorkerFileForTest(file: string | null): void {
  workerFile = file ?? path.join(__dirname, 'regexWorker.js');
}

const idle: Worker[] = [];
const waiting: Array<() => void> = [];
let busy = 0;
let killed = 0;

/** Threads terminated at the deadline since start. */
export function killedCount(): number {
  return killed;
}

async function acquire(): Promise<Worker> {
  while (busy >= MAX_BUSY) await new Promise<void>((r) => waiting.push(r));
  busy += 1;
  const warm = idle.pop();
  if (warm) return warm;
  try {
    return await spawn();
  } catch (e) {
    release(null);
    throw e;
  }
}

async function spawn(): Promise<Worker> {
  const w = new Worker(workerFile);
  w.once('exit', () => {
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
  });
  // Started before the clock does: a cold thread's boot is not the pattern's time.
  await new Promise<void>((resolve, reject) => {
    w.once('online', () => resolve());
    w.once('error', reject);
  });
  return w;
}

function release(w: Worker | null): void {
  busy -= 1;
  if (w) {
    w.unref();
    if (idle.length < KEEP_IDLE) idle.push(w);
    else void w.terminate();
  }
  const next = waiting.shift();
  if (next) next();
}

function call(w: Worker, spec: RegexSpec, texts: string[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
    };
    const onMessage = (m: { results?: unknown[]; error?: string }): void => {
      done();
      if (m.results) resolve(m.results);
      else reject(new Error(m.error || 'The pattern failed'));
    };
    const onError = (e: unknown): void => { done(); reject(e instanceof Error ? e : new Error('The regex worker failed')); };
    const onExit = (): void => { done(); reject(new Error('The regex worker stopped')); };
    const timer = setTimeout(() => { done(); reject(new RegexTimeout(deadlineMs)); }, deadlineMs);
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);
    w.ref(); // a call in flight keeps the process alive; an idle thread does not
    w.postMessage({ spec, texts });
  });
}

function batches(texts: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const s of texts) {
    if (cur.length && (cur.length >= BATCH_TEXTS || chars + s.length > BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s);
    chars += s.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * `spec` over every text, in order, off this thread. Rejects with RegexTimeout
 * when one call overruns the deadline (its thread is terminated), or with the
 * worker's own error.
 */
export async function runRegex(spec: RegexSpec, texts: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const batch of batches(texts)) {
    const w = await acquire();
    let results: unknown[];
    try {
      results = await call(w, spec, batch);
    } catch (e) {
      if (e instanceof RegexTimeout) killed += 1;
      void w.terminate(); // still matching (or broken): never handed out again
      release(null);
      throw e;
    }
    release(w);
    for (const r of results) out.push(r);
  }
  return out;
}

/** Close every idle thread (tests, shutdown). */
export async function shutdown(): Promise<void> {
  await Promise.all(idle.splice(0).map((w) => w.terminate()));
}
