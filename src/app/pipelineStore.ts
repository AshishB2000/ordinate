// A project's pipeline settings and run history — MAIN PROCESS ONLY.
//
// ONE file, `userData/projects/<id>/pipelines.json`: the pipeline's own
// schedule, its retry policy, the nodes that are paused, and the last 50 runs
// of each node with their logs. Everything else a node shows (a dataset's
// refresh schedule, a report's cadence) stays on its own record — this file
// never copies it.
//
// The usual store rules: the project id is UUID-checked before it becomes a
// path, writes are atomic (temp sibling, then rename), a corrupt file reads as
// empty rather than failing the page, and every field is whitelisted on load.
// Writes are serialised per project, because the nodes of one run finish
// concurrently and each appends its run.

import * as fs from 'fs';
import * as path from 'path';
import { projectDir } from './recordKinds';
import { writeJsonAtomic } from '../data/datasetRecord';
import { isValidTimeZone, parseCron } from './pipelineCron';
import { sanitizePolicy } from './pipelines';
import type { RetryPolicy, RunStatus } from './pipelines';
import * as recordFs from './recordFs';

export const MAX_RUNS = 50;
const MAX_LOG = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A node id as src/app/pipelines.ts makes them. JSON keys only — never a path. */
const NODE_RE = /^(source:(conn|file|url):[^\n]{1,500}|(dataset|quality|alert|report):[0-9a-f-]{36}|publish)$/;

export interface PipelineSchedule {
  cron: string;
  tz: string;
  paused: boolean;
  /** When the schedule was set: the first run is the first match after it. */
  since: string;
  lastRunAt?: string;
}

export interface NodeRun {
  id: string;
  runId: string;
  trigger: 'manual' | 'schedule';
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  rows?: number;
  rowsBefore?: number;
  warnings: string[];
  errors: string[];
  note?: string;
}

export interface PipelineState {
  schedule?: PipelineSchedule;
  policy: RetryPolicy;
  paused: string[];
  runs: Record<string, NodeRun[]>;
}

const empty = (): PipelineState => ({ policy: sanitizePolicy({}), paused: [], runs: {} });

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_LOG).map((x) => x.slice(0, 400)) : []);
const iso = (v: unknown): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : '');
const STATUSES: ReadonlySet<string> = new Set(['ok', 'failed', 'blocked', 'paused']);

export function sanitizeSchedule(raw: unknown): PipelineSchedule | undefined {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o || !parseCron(o.cron) || !isValidTimeZone(o.tz)) return undefined;
  const s: PipelineSchedule = {
    cron: String(o.cron).trim().split(/\s+/).join(' '),
    tz: o.tz as string,
    paused: o.paused === true,
    since: iso(o.since) || new Date(0).toISOString(),
  };
  if (iso(o.lastRunAt)) s.lastRunAt = iso(o.lastRunAt);
  return s;
}

function sanitizeRun(raw: unknown): NodeRun | null {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o || !UUID_RE.test(String(o.id || '')) || !UUID_RE.test(String(o.runId || '')) || !STATUSES.has(String(o.status))) return null;
  const run: NodeRun = {
    id: String(o.id), runId: String(o.runId),
    trigger: o.trigger === 'schedule' ? 'schedule' : 'manual',
    status: o.status as RunStatus,
    startedAt: iso(o.startedAt), finishedAt: iso(o.finishedAt),
    durationMs: Math.max(0, Number(o.durationMs) || 0),
    attempts: Math.max(0, Math.min(4, Number(o.attempts) || 0)),
    warnings: strs(o.warnings), errors: strs(o.errors),
  };
  if (typeof o.rows === 'number' && Number.isFinite(o.rows)) run.rows = o.rows;
  if (typeof o.rowsBefore === 'number' && Number.isFinite(o.rowsBefore)) run.rowsBefore = o.rowsBefore;
  if (str(o.note)) run.note = str(o.note);
  return run;
}

export function sanitizeState(raw: unknown): PipelineState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const state = empty();
  const schedule = sanitizeSchedule(o.schedule);
  if (schedule) state.schedule = schedule;
  state.policy = sanitizePolicy(o.policy);
  state.paused = Array.isArray(o.paused) ? [...new Set(o.paused.filter((x): x is string => typeof x === 'string' && NODE_RE.test(x)))] : [];
  const runs = (o.runs && typeof o.runs === 'object' ? o.runs : {}) as Record<string, unknown>;
  for (const [id, list] of Object.entries(runs)) {
    if (!NODE_RE.test(id) || !Array.isArray(list)) continue;
    const clean = list.map(sanitizeRun).filter((r): r is NodeRun => r !== null).slice(0, MAX_RUNS);
    if (clean.length) state.runs[id] = clean;
  }
  return state;
}

export const isNodeId = (id: unknown): id is string => typeof id === 'string' && NODE_RE.test(id);

function file(projectId: string): string {
  const dir = projectDir(projectId);
  return dir ? path.join(dir, 'pipelines.json') : '';
}

export async function load(projectId: string): Promise<PipelineState> {
  const f = file(projectId);
  if (!f) return empty();
  try {
    return sanitizeState(JSON.parse(await recordFs.readFile(f, 'utf8')));
  } catch (_) {
    return empty(); // none yet, or corrupt: an empty pipeline state, never a failure
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Read, change, write — one at a time per project. Resolves to the new state, or null. */
export function update(projectId: string, fn: (s: PipelineState) => void): Promise<PipelineState | null> {
  const f = file(projectId);
  if (!f) return Promise.resolve(null);
  const prev = queues.get(projectId) || Promise.resolve();
  const next = prev.catch(() => null).then(async () => {
    const s = await load(projectId);
    fn(s);
    const clean = sanitizeState(s);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await writeJsonAtomic(f, clean);
    return clean;
  }).catch(() => null);
  queues.set(projectId, next);
  void next.then(() => { if (queues.get(projectId) === next) queues.delete(projectId); });
  return next;
}

/** Add runs, newest first, keeping the last MAX_RUNS per node. */
export function appendRuns(projectId: string, runs: Array<NodeRun & { nodeId: string }>): Promise<PipelineState | null> {
  return update(projectId, (s) => {
    for (const { nodeId, ...run } of runs) {
      if (!isNodeId(nodeId)) continue;
      s.runs[nodeId] = [run, ...(s.runs[nodeId] || [])].slice(0, MAX_RUNS);
    }
  });
}
