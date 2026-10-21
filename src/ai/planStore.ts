// Assistant plan runs as RECORDS, so a run started on one pod advances, stops
// and undoes on any other (docs/any-pod/00-design.md §3.5). A run lives at
// userData/projects/<project>/plans/<run>.json (a `records` row with a
// database, a file without): never in a bundle or a backup, gone with its project.
//
// LOCKING — compute outside, apply inside (docs/record-locks). A step awaits a
// parse job, DuckDB and quality checks, so it never runs inside recordFs.locked
// (that would hold one of the pod's DB holds for minutes and pull the step's own
// record writes into the run's transaction). Instead each step is three short
// locked holds of the run's path:
//   claim   the step goes `running` with a LEASE { claim, until } — a second
//           Next (any pod, any tab) finds a live lease and is told so;
//   …       the step runs with no lock held; a heartbeat moves `until` on;
//   apply   the step's touches are merged ALWAYS (undo must know what it made),
//           the status transition only while the lease is still this claim's.
// A lease left by a pod that went away expires (90 s) and the next request
// recovers the run: that step failed, "may have partly run". Leases are timed
// on the DATABASE clock, so pods with skewed clocks agree.
//
// OWNED: a run is its starter's (`by`); anyone else finds nothing, as for an
// unknown id. Capped at 10 runs per user and 50 per org, 24 h from the last change.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import * as recordFs from '../app/recordFs';
import { projectDir, projectsBase, isValidId } from '../app/recordKinds';
import { ctx } from '../server/context';
import { recoverStep, type PlanRun, type RunState } from './planRun';

export const TTL_MS = 24 * 3_600_000;
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_RUNS_PER_USER = 10;
export const MAX_RUNS_PER_ORG = 50;
export const INTERRUPTED = 'The server restarted while this step ran, so it may have partly run. Check what it made, then run it again or skip it.';

export interface Lease {
  claim: string;
  /** Epoch ms on the database clock. */
  until: number;
  kind: 'step' | 'undo';
  /** The state before an undo claimed the run — what a lost undo goes back to. */
  prev: RunState;
}

export interface StoredRun extends Omit<PlanRun, 'fileToken'> {
  v: 1;
  by: string;
  createdAt: string;
  updatedAt: string;
  lease?: Lease;
}

export interface Log {
  warn(obj: object, msg: string): void;
}
let db: Pool | null = null;
let log: Log = { warn: () => undefined };

/** The database clock (and a log) when there is a database; this pod's clock otherwise (one pod). */
export function usePlanDb(pool: Pool | null, l?: Log): void {
  db = pool;
  if (l) log = l;
}

async function clock(): Promise<number> {
  if (!db) return Date.now();
  const r = await db.query<{ t: number }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS t');
  return Number(r.rows[0].t);
}

/** The run's record path, or a throw for an id that is not a UUID. */
export function runPath(projectId: string, runId: string): string {
  const dir = projectDir(projectId);
  if (!dir || !isValidId(runId)) throw new Error('plan run: invalid id');
  return path.join(dir, 'plans', `${runId}.json`);
}

const STATES: ReadonlySet<string> = new Set(['ready', 'running', 'paused', 'failed', 'finished', 'stopped', 'undone']);

/** A stored run, shape-checked like any record read back from disk; null when it is not one of ours. */
function sanitize(raw: unknown, projectId: string, runId: string): StoredRun | null {
  const r = raw as Partial<StoredRun> | null;
  if (!r || r.v !== 1 || r.id !== runId || r.projectId !== projectId || typeof r.by !== 'string' || typeof r.updatedAt !== 'string') return null;
  const n = Array.isArray(r.steps) ? r.steps.length : -1;
  if (n < 0 || ![r.status, r.results, r.errors].every((a) => Array.isArray(a) && a.length === n) || !Array.isArray(r.touches) || !STATES.has(String(r.state))) return null;
  if (r.lease && (typeof r.lease.claim !== 'string' || typeof r.lease.until !== 'number')) return null;
  return r as StoredRun;
}

async function load(p: string, projectId: string, runId: string): Promise<StoredRun | null> {
  try {
    return sanitize(JSON.parse(await recordFs.readFile(p, 'utf8')), projectId, runId);
  } catch {
    return null; // missing or corrupt: the run has ended
  }
}

async function save(p: string, run: StoredRun): Promise<void> {
  run.updatedAt = new Date().toISOString();
  const { fileToken: _never, ...stored } = run as StoredRun & { fileToken?: string }; // an upload token is never stored
  const tmp = `${p}.${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(p), { recursive: true }); // as every record store does (a no-op worth nothing on Postgres)
  await recordFs.writeFile(tmp, JSON.stringify(stored));
  await recordFs.rename(tmp, p);
}

const expired = (run: StoredRun, now: number): boolean => now - Date.parse(run.updatedAt) > TTL_MS;

/** A lease whose pod went away: the step failed (it may have partly run), or the undo goes back to where it was. */
function recoverIfStale(run: StoredRun, now: number): void {
  if (run.lease && run.lease.until >= now) return;
  if (run.lease?.kind === 'undo') run.state = run.lease.prev;
  else if (run.state === 'running') recoverStep(run, INTERRUPTED);
  delete run.lease;
}

/** The caller's live run, read plainly (a snapshot for a refusal, Fix's input). */
export async function read(projectId: string, runId: string): Promise<StoredRun | null> {
  const p = runPath(projectId, runId);
  const run = await load(p, projectId, runId);
  return run && run.by === ctx().user.email && !expired(run, Date.now()) ? run : null;
}

/** Writes a new run for the caller, then prunes the org's runs to their caps. */
export async function create(run: PlanRun): Promise<StoredRun> {
  const at = new Date().toISOString();
  const stored: StoredRun = { ...run, v: 1, by: ctx().user.email, createdAt: at, updatedAt: at };
  delete (stored as StoredRun & { fileToken?: string }).fileToken;
  await save(runPath(run.projectId, run.id), stored);
  await prune().catch((err: unknown) => log.warn({ err }, 'plan runs could not be pruned'));
  return stored;
}

/**
 * One locked read-modify-write of the caller's run: a stale lease is recovered first, then `fn`
 * changes the run; it is saved. Null when the run is gone (unknown, expired, someone else's).
 */
export async function update<R>(projectId: string, runId: string, fn: (run: StoredRun, now: number) => R): Promise<{ run: StoredRun; out: R } | null> {
  const p = runPath(projectId, runId);
  const me = ctx().user.email;
  return recordFs.locked(p, async () => {
    const run = await load(p, projectId, runId);
    if (!run || run.by !== me || expired(run, Date.now())) return null;
    const now = await clock();
    recoverIfStale(run, now);
    const out = fn(run, now);
    await save(p, run);
    return { run, out };
  });
}

/** Leases the run for a step (`begin` returns its index, or −1) or an undo. `busy` while another lease is live. */
export async function claim(projectId: string, runId: string, kind: Lease['kind'], begin: (run: StoredRun) => number):
  Promise<{ run: StoredRun; before: StoredRun; claim: string; index: number; busy: boolean } | null> {
  const id = randomUUID();
  const r = await update(projectId, runId, (run, now) => {
    if (run.lease) return { busy: true, index: -1, before: run };
    const before = structuredClone(run);
    const index = begin(run);
    if (index >= 0) run.lease = { claim: id, until: now + LEASE_MS, kind, prev: before.state };
    return { busy: false, index, before };
  });
  return r && { run: r.run, claim: id, ...r.out };
}

/** Keeps a claim's lease alive while its step runs. */
export function heartbeat(projectId: string, runId: string, claimId: string): { stop(): void } {
  const timer = setInterval(() => {
    void update(projectId, runId, (run, now) => {
      if (run.lease?.claim === claimId) run.lease.until = now + LEASE_MS;
    }).catch((err: unknown) => log.warn({ err }, 'plan run: a lease could not be renewed'));
  }, HEARTBEAT_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * Applies a claim's outcome: `merge` ALWAYS (the facts — touches, an undo report), `transition` only
 * while the lease is still this claim's; the lease is then released. A lost lease is logged.
 */
export async function apply(projectId: string, runId: string, claimId: string, merge: (run: StoredRun) => void, transition: (run: StoredRun) => void): Promise<StoredRun | null> {
  const r = await update(projectId, runId, (run) => {
    merge(run);
    const ours = run.lease?.claim === claimId;
    if (ours) {
      transition(run);
      delete run.lease;
    }
    return ours;
  });
  if (r && !r.out) log.warn({ run: runId }, 'plan run: a step finished after its lease was recovered; its writes were kept for undo, its status was not applied');
  return r ? r.run : null;
}

/**
 * The org's runs held to their caps: past the TTL, past each user's 10, past the org's 50 — oldest
 * first, never one with a live lease. Each delete is its own locked hold that re-reads the run and
 * keeps it if it changed since the scan.
 */
export async function prune(): Promise<number> {
  let pids: string[] = [];
  try {
    pids = (await recordFs.readdir(projectsBase())).filter((n) => isValidId(n));
  } catch {
    return 0;
  }
  const now = Date.now();
  const found: Array<{ p: string; projectId: string; runId: string; by: string; updatedAt: string; leased: boolean }> = [];
  for (const projectId of pids) {
    let names: string[] = [];
    try {
      names = await recordFs.readdir(path.join(projectDir(projectId), 'plans'));
    } catch {
      continue;
    }
    for (const name of names) {
      const runId = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isValidId(runId)) continue;
      const p = runPath(projectId, runId);
      const run = await load(p, projectId, runId);
      if (!run) continue;
      found.push({ p, projectId, runId, by: run.by, updatedAt: run.updatedAt, leased: !!run.lease && run.lease.until >= now });
    }
  }
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); // newest first
  const perUser = new Map<string, number>();
  const victims = found.filter((f, i) => {
    const mine = (perUser.get(f.by) ?? 0) + 1;
    perUser.set(f.by, mine);
    return !f.leased && (now - Date.parse(f.updatedAt) > TTL_MS || mine > MAX_RUNS_PER_USER || i >= MAX_RUNS_PER_ORG);
  });
  let n = 0;
  for (const v of victims) {
    const gone = await recordFs.locked(v.p, async () => {
      const run = await load(v.p, v.projectId, v.runId);
      if (!run || run.updatedAt !== v.updatedAt || (run.lease && run.lease.until >= (await clock()))) return false;
      await recordFs.rm(v.p, { force: true });
      return true;
    }).catch(() => false);
    if (gone) n++;
  }
  return n;
}
