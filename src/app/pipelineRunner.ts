// Running a pipeline — MAIN PROCESS ONLY.
//
// "Run now" on a node runs it and everything downstream of it, in topological
// order with independent branches side by side (./pipelines.runGraph). Each
// node runs through the SAME code path its own button does, as a job:
//
//   dataset   refreshAsJob — the ↻ Refresh path (a step-only dataset re-runs its
//             steps, which is datasetDependents' refresh for it)
//   quality   submitQualityRun — the "Run checks" button's job
//   alert     evaluateAndDeliver — the inbox's "check now"
//   report    runReport + writeScheduledReport — the CLI's build and the
//             schedule's write into the report's own folder
//   publish   submitPublish with the stored choices — "Re-publish"
//   source    nothing to run: its datasets fetch from it
//
// A failure (after the retry policy) stops everything downstream of it, which
// is marked BLOCKED, and raises an alert event through the alerts machinery —
// recorded in the inbox and delivered, exactly as a data-quality event is.
// Every node's run lands in its history (./pipelineStore) with its log.

import { randomUUID } from 'crypto';
import * as datasets from '../data/datasets';
import { refreshAsJob } from '../data/refreshJob';
import { recomputeSteps } from '../data/datasetDependents';
import { stepRefIds } from '../data/stepTypes';
import { qualityFailingCount } from '../analysis/qualityRules';
import * as reportSpec from '../analysis/reportSpec';
import { getStoredConfig } from '../publish/publish';
import type { AlertEvent } from '../analysis/alerts';
import * as hubs from '../windows/hubRegistry';
import { ctx, orgKey, serverDataDir } from '../server/context';
import { publish } from '../server/sse';
import { maskKeys } from './pipelineIds';
import * as jobs from './jobs';
import * as store from './pipelineStore';
import { downstream, runGraph } from './pipelines';
import type { ExecResult, NodeOutcome, PipelineGraph, PipelineNode } from './pipelines';
import { loadGraph } from './pipelineView';
import { nextCronRun } from './pipelineCron';

/** Projects with a run in flight, and its nodes' live state. */
const live = new Map<string, Map<string, 'queued' | 'running'>>();

export function liveState(projectId: string): Record<string, string> {
  return Object.fromEntries(live.get(orgKey(projectId)) || []);
}

function changed(projectId: string): void {
  const payload = { projectId, live: liveState(projectId) };
  try {
    // The server's tabs of this org get it over SSE (T2.6); the desktop's windows over IPC.
    if (serverDataDir() !== null) publish({ org: ctx().org.id }, 'pipelines:changed', { projectId, live: maskKeys(payload.live) });
    else hubs.broadcast('pipelines:changed', payload);
  } catch (_) { /* a window closing mid-send */ }
}

async function asJob<T>(spec: { kind: jobs.JobKind; label: string; projectId: string; datasetId?: string }, run: () => Promise<T>): Promise<T> {
  return jobs.submit<T>({ ...spec, run: async (ctx) => { ctx.progress(0.1); return run(); } }).done;
}

const plural = (n: number, w: string): string => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** Run ONE node through its own button's path. Throws or returns ok:false on failure. */
export async function execNode(projectId: string, node: PipelineNode): Promise<ExecResult> {
  const id = node.ref ? node.ref.id : '';
  switch (node.kind) {
    case 'source':
      return { ok: true, note: 'A source — the datasets after it fetch from it.' };
    case 'dataset': {
      const meta = await datasets.getDatasetMeta(projectId, id);
      if (!meta) return { ok: false, error: 'The dataset is gone.', retryable: false };
      const before = meta.rowCount;
      if (meta.origin && meta.origin.kind !== 'capture') {
        const r = await refreshAsJob(projectId, id);
        if (!r.ok) return { ok: false, error: r.error, rowsBefore: before };
        return { ok: true, rows: r.dataset.rowCount, rowsBefore: before, warnings: r.warnings };
      }
      if (stepRefIds(meta.steps || []).length) {
        const r = await asJob({ kind: 'refresh', label: 'Recompute ' + meta.name, projectId, datasetId: id }, () => recomputeSteps(projectId, id));
        const after = await datasets.getDatasetMeta(projectId, id);
        return r.ok ? { ok: true, rows: after ? after.rowCount : before, rowsBefore: before } : { ok: false, error: 'Its steps could not be re-run.' };
      }
      return { ok: true, rows: before, note: 'Nothing to fetch — its rows were typed or imported once.' };
    }
    case 'quality': {
      const { submitQualityRun } = require('../ipc/quality');
      await (await submitQualityRun(projectId, id)).done;
      const meta = await datasets.getDatasetMeta(projectId, id);
      const q = meta && meta.quality;
      if (!q || !q.latest) return { ok: false, error: 'The checks did not run.' };
      const failing = qualityFailingCount(q) || 0;
      const warnIds = new Set(q.rules.filter((r) => r.severity === 'warn').map((r) => r.id));
      const warns = q.latest.results.filter((r) => !r.passed && warnIds.has(r.ruleId)).length;
      const warnings = warns ? [`${plural(warns, 'warning rule')} failing`] : [];
      const passed = q.latest.results.filter((r) => r.passed).length;
      if (failing) return { ok: false, retryable: false, rows: meta.rowCount, warnings, error: `${plural(failing, 'FAIL rule')} failing — what is built from it was stopped.` };
      return { ok: true, rows: meta.rowCount, warnings, note: `${passed} of ${q.latest.results.length} rules passed.` };
    }
    case 'alert': {
      const alertStore = require('../analysis/alertStore');
      const rule = ((await alertStore.load(projectId)).rules as Array<{ id: string; datasetId: string; enabled: boolean }>).find((r) => r.id === id);
      if (!rule) return { ok: false, error: 'The alert rule is gone.', retryable: false };
      if (!rule.enabled) return { ok: true, note: 'The rule is off, so it was not checked.' };
      const fired: AlertEvent[] = await asJob({ kind: 'compute', label: 'Alert check · ' + node.name, projectId },
        () => require('../ipc/alerts').evaluateAndDeliver(projectId, rule.datasetId));
      return { ok: true, note: fired.some((e) => e.ruleId === id) ? 'Fired.' : 'Checked — it did not fire.' };
    }
    case 'report': {
      const report = await reportSpec.getReport(projectId, id);
      if (!report) return { ok: false, error: 'The report is gone.', retryable: false };
      if (!report.schedule || !report.schedule.folder) {
        return { ok: false, retryable: false, error: 'Choose a folder in this report’s schedule first — a pipeline run writes the file there.' };
      }
      return asJob({ kind: 'report', label: 'Report · ' + report.name, projectId }, async () => {
        const res = await require('../automation/reportRunner').runReport(projectId, id, { headless: false });
        const w = await require('../ipc/reports').writeScheduledReport(projectId, id, res.bytes, new Date());
        if (!w.ok) throw new Error(w.error);
        const warnings = res.skippedMaps ? [`${plural(res.skippedMaps, 'map')} left out — maps need the visible window.`] : [];
        return { ok: true, warnings, note: 'Wrote ' + String(w.dest).split(/[\\/]/).pop() } as ExecResult;
      });
    }
    case 'publish': {
      const cfg = await getStoredConfig(projectId);
      if (!cfg) return { ok: false, retryable: false, error: 'This project has not been published yet.' };
      const r = await require('../ipc/publish').submitPublish(cfg, 'Re-publish').done;
      return { ok: true, note: `${plural(r.files.length, 'file')} written.` };
    }
  }
  return { ok: false, error: 'Unknown step.' };
}

/** The alert a failure raises: which step, why, and how much it stopped. */
async function raiseFailures(projectId: string, graph: PipelineGraph, outcomes: NodeOutcome[]): Promise<void> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const at = new Date().toISOString();
  const UUID = /^[0-9a-f-]{36}$/i;
  const events: AlertEvent[] = outcomes.filter((o) => o.status === 'failed').map((o) => {
    const n = byId.get(o.nodeId)!;
    const blocked = outcomes.filter((x) => x.status === 'blocked' && x.blockedBy === o.nodeId).length;
    const refId = n.ref && UUID.test(n.ref.id) ? n.ref.id : '';
    return {
      id: randomUUID(),
      ruleId: refId || randomUUID(),
      ruleName: 'Pipeline',
      datasetId: n.kind === 'dataset' || n.kind === 'quality' ? refId : '',
      at,
      value: blocked,
      previous: null, delta: null, deltaPct: null,
      message: `Pipeline: "${n.name}" failed — ${(o.result && o.result.error) || 'it did not finish'}`
        + (blocked ? ` ${plural(blocked, 'step')} after it ${blocked === 1 ? 'was' : 'were'} stopped.` : ''),
      seen: false,
    };
  });
  if (!events.length) return;
  try {
    await require('../analysis/alertStore').recordEvents(projectId, events);
    await require('../ipc/alerts').deliver(projectId, events);
  } catch (err: unknown) {
    console.error('[pipelines] could not raise the failure alert:', err instanceof Error ? err.message : err);
  }
}

export type RunReply = { ok: true; runId: string; outcomes: NodeOutcome[] } | { ok: false; error: string };

/** Run these nodes and everything downstream. One run per project at a time. */
export async function runFrom(
  projectId: string, start: string[], trigger: 'manual' | 'schedule',
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RunReply> {
  // Keyed per org: on a server a project id repeats across orgs after an import.
  const key = orgKey(projectId);
  if (live.has(key)) return { ok: false, error: 'This pipeline is already running.' };
  const state = new Map<string, 'queued' | 'running'>();
  live.set(key, state);
  try {
    const g = await loadGraph(projectId);
    if ('error' in g) return { ok: false, error: g.error };
    const graph = g.graph;
    const roots = start.length ? start : graph.nodes.map((n) => n.id);
    for (const id of downstream(graph.edges, roots)) if (graph.nodes.some((n) => n.id === id)) state.set(id, 'queued');
    if (!state.size) return { ok: false, error: 'Nothing to run.' };
    changed(projectId);
    const saved = await store.load(projectId);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const runId = randomUUID();
    const writes: Array<Promise<unknown>> = [];
    const outcomes = await runGraph(graph, roots, {
      exec: (id) => execNode(projectId, byId.get(id)!),
      policy: saved.policy,
      sleep,
      paused: new Set(saved.paused),
      onStart: (id) => { state.set(id, 'running'); changed(projectId); },
      onDone: (o) => {
        state.delete(o.nodeId);
        const r = o.result;
        const errors = o.status === 'blocked'
          ? [`Not run: "${(byId.get(o.blockedBy || '') || { name: 'a step before it' }).name}" failed.`]
          : r && !r.ok ? [r.error || 'Failed.'] : [];
        writes.push(store.appendRuns(projectId, [{
          nodeId: o.nodeId, id: randomUUID(), runId, trigger, status: o.status,
          startedAt: new Date(o.startedAt).toISOString(), finishedAt: new Date(o.finishedAt).toISOString(),
          durationMs: o.finishedAt - o.startedAt, attempts: o.attempts,
          ...(r && typeof r.rows === 'number' ? { rows: r.rows } : {}),
          ...(r && typeof r.rowsBefore === 'number' ? { rowsBefore: r.rowsBefore } : {}),
          warnings: (r && r.warnings) || [], errors,
          ...(o.status === 'paused' ? { note: 'Paused — stepped over.' } : r && r.note ? { note: r.note } : {}),
        }]).then(() => changed(projectId)));
      },
    });
    await Promise.all(writes);
    await raiseFailures(projectId, graph, outcomes);
    return { ok: true, runId, outcomes };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'The pipeline could not run.' };
  } finally {
    live.delete(key);
    changed(projectId);
  }
}

/** The scheduled pass: every project whose pipeline cron came due since its last run. */
export async function tick(now = Date.now()): Promise<void> {
  let list: Array<{ id: string }> = [];
  try { list = await require('./projects').listProjects(); } catch (_) { return; }
  for (const p of list) {
    const s = (await store.load(p.id)).schedule;
    if (!s || s.paused || live.has(orgKey(p.id))) continue;
    const next = nextCronRun(s.cron, s.tz, Date.parse(s.lastRunAt || s.since));
    if (next === null || next > now) continue;
    // Stamp FIRST, win or lose — the scheduler's rule: a failing pipeline waits
    // for its next slot instead of retrying every minute.
    await store.update(p.id, (st) => { if (st.schedule) st.schedule.lastRunAt = new Date(now).toISOString(); });
    void runFrom(p.id, [], 'schedule');
  }
}
