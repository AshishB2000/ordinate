// The Pipelines page's model — MAIN PROCESS ONLY.
//
// Reads the project's records the way Lineage does (src/ipc/lineage.loadInput,
// metadata only — no table is opened), builds the DAG (./pipelines.ts) and
// dresses each node with what the page shows: its schedule, its last run, how
// long that took, its status and its next run. Nothing here is stored: every
// schedule is read off its OWN record (a dataset's autoRefresh, a report's
// schedule, the publish's after-refresh option) and the pipeline's own cron and
// run history off ./pipelineStore.

import { buildGraph } from '../analysis/lineage';
import { loadInput } from '../ipc/lineage';
import * as connections from '../connectors/connections';
import { getStoredConfig } from '../publish/publish';
import { stepRefIds } from '../data/stepTypes';
import { qualityFailingCount } from '../analysis/qualityRules';
import * as config from './config';
import * as store from './pipelineStore';
import type { NodeRun, PipelineState } from './pipelineStore';
import { buildPipeline, topoOrder, STAGES } from './pipelines';
import type { PipelineGraph, PipelineNode } from './pipelines';
import { describeCron, nextCronRun } from './pipelineCron';

// ponytail: loose record shapes — each store's own sanitizer already shaped them (as lineage.ts)
type Rec = Record<string, any>;

const EVERY_MS: Record<string, number> = { hourly: 3600_000, daily: 86_400_000, weekly: 604_800_000 };
const CADENCE_MS: Record<string, number> = { daily: 86_400_000, weekly: 604_800_000, monthly: 30 * 86_400_000 };
const ORIGIN_WORD: Record<string, string> = {
  connection: 'Database', file: 'File', url: 'Web address', sql: 'SQL query', combined: 'Combined', composed: 'Combined',
};
const WORD: Record<string, string> = { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export interface NodeSchedule {
  /** What the card says: "Daily", "Weekly at 09:00", "After its inputs". */
  text: string;
  /** What the page may edit: a dataset's refresh, a report's cadence, or nothing. */
  edit: 'dataset' | 'report' | null;
  every?: string;
  cadence?: string;
  at?: string;
  hasFolder?: boolean;
}

export interface NodeView extends PipelineNode {
  schedule: NodeSchedule;
  lastRun: { at: string; status: string; durationMs?: number } | null;
  nextRunAt: string | null;
  paused: boolean;
  runs: NodeRun[];
}

export interface PipelineView {
  ok: true;
  stages: readonly string[];
  nodes: NodeView[];
  edges: PipelineGraph['edges'];
  schedule: (store.PipelineSchedule & { text: string; nextRunAt: string | null }) | null;
  policy: PipelineState['policy'];
  /** The zone a new schedule starts in. */
  tz: string;
}

/** The earliest a report on this schedule runs next — reportSpec.scheduleDue's two gates, solved. */
export function reportNextRun(s: { cadence: string; at: string }, lastRunAt: string | undefined, now: number): number | null {
  if (!CADENCE_MS[s.cadence]) return null;
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const base = new Date(Math.max(now, Number.isFinite(last) ? last + CADENCE_MS[s.cadence] : now));
  const m = /^(\d{2}):(\d{2})$/.exec(s.at || '');
  if (!m) return base.getTime();
  const at = new Date(base);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Math.max(base.getTime(), at.getTime());
}

export async function loadGraph(projectId: string): Promise<{ graph: PipelineGraph; input: Rec } | { error: string; cycle: string[] }> {
  const [input, conns, publish] = await Promise.all([
    loadInput(projectId),
    connections.listConnections(projectId).catch(() => []),
    getStoredConfig(projectId),
  ]);
  const ds: Rec[] = input.datasets;
  const built = buildPipeline(buildGraph(input), {
    qualityDatasets: ds.filter((d) => d.quality && d.quality.rules && d.quality.rules.length).map((d) => d.id),
    publish: publish ? { dashboardIds: publish.dashboardIds, outDir: publish.outDir } : null,
    sqlDeps: Object.fromEntries(ds.filter((d) => d.origin && d.origin.kind === 'sql').map((d) => [d.id, d.origin.deps || []])),
    runnable: ds.filter((d) => (d.origin && d.origin.kind !== 'capture') || stepRefIds(d.steps || []).length).map((d) => d.id),
  });
  if (!built.ok) return { error: built.error, cycle: built.cycle };
  return { graph: { nodes: built.nodes, edges: built.edges }, input: { ...input, conns, publish } };
}

function scheduleFor(n: PipelineNode, input: Rec, now: number): { schedule: NodeSchedule; next: number | null; stamp: { at: string; status: string } | null } {
  const id = n.ref ? n.ref.id : '';
  if (n.kind === 'source') {
    return { schedule: { text: 'Read by its datasets', edit: null }, next: null, stamp: null };
  }
  if (n.kind === 'dataset') {
    const d = (input.datasets as Rec[]).find((x) => x.id === id) || {};
    const stamp = d.lastRefreshedAt ? { at: d.lastRefreshedAt, status: d.lastRefreshStatus === 'error' ? 'failed' : 'ok' } : null;
    const refetch = Boolean(d.origin && d.origin.kind !== 'capture');
    const derived = n.stage === 2;
    if (!refetch) {
      return { schedule: { text: derived ? 'After its inputs' : 'Typed or imported once', edit: null }, next: null, stamp };
    }
    const a = d.autoRefresh;
    const off = config.get().autoRefresh === false;
    if (!a) return { schedule: { text: derived ? 'After its inputs' : 'Manual', edit: 'dataset', every: 'off' }, next: null, stamp };
    const last = a.lastAutoAt ? Date.parse(a.lastAutoAt) : NaN;
    const next = off ? null : Math.max(now, Number.isFinite(last) ? last + EVERY_MS[a.every] : now);
    return { schedule: { text: WORD[a.every] + (off ? ' · off in Settings' : ''), edit: 'dataset', every: a.every }, next, stamp };
  }
  if (n.kind === 'quality') {
    const d = (input.datasets as Rec[]).find((x) => x.id === id) || {};
    const q = d.quality;
    const failing = qualityFailingCount(q);
    const stamp = q && q.latest ? { at: q.latest.at, status: failing ? 'failed' : 'ok' } : null;
    return { schedule: { text: 'After each refresh', edit: null }, next: null, stamp };
  }
  if (n.kind === 'alert') {
    const r = (input.alerts as Rec[]).find((x) => x.id === id) || {};
    const stamp = r.lastEvaluatedAt ? { at: r.lastEvaluatedAt, status: 'ok' } : null;
    return { schedule: { text: r.enabled === false ? 'Rule is off' : 'After each refresh', edit: null }, next: null, stamp };
  }
  if (n.kind === 'report') {
    const r = (input.reports as Rec[]).find((x) => x.id === id) || {};
    const s = r.schedule;
    const stamp = r.lastRunAt ? { at: r.lastRunAt, status: 'ok' } : null;
    if (!s || s.cadence === 'off') return { schedule: { text: 'Manual', edit: 'report', cadence: 'off', at: (s && s.at) || '09:00', hasFolder: Boolean(s && s.folder) }, next: null, stamp };
    const next = s.folder ? reportNextRun(s, r.lastRunAt, now) : null;
    return {
      schedule: { text: `${WORD[s.cadence]} at ${s.at}` + (s.folder ? '' : ' · no folder'), edit: 'report', cadence: s.cadence, at: s.at, hasFolder: Boolean(s.folder) },
      next, stamp,
    };
  }
  const p = input.publish;
  const stamp = p && p.lastPublishedAt ? { at: p.lastPublishedAt, status: 'ok' } : null;
  return { schedule: { text: p && p.options && p.options.afterRefresh ? 'After each refresh' : 'Manual', edit: null }, next: null, stamp };
}

/** The whole page: graph, per-node schedule/last/next, the pipeline's own schedule. */
export async function loadView(projectId: string, now = Date.now()): Promise<PipelineView | { ok: false; error: string; cycle: string[] }> {
  const [g, state] = await Promise.all([loadGraph(projectId), store.load(projectId)]);
  if ('error' in g) return { ok: false, error: g.error, cycle: g.cycle };
  const s = state.schedule;
  const pipeNext = s && !s.paused ? nextCronRun(s.cron, s.tz, Date.parse(s.lastRunAt || s.since)) : null;
  const paused = new Set(state.paused);
  const nextOf = new Map<string, number | null>();
  const views = new Map<string, NodeView>();
  for (const n of g.graph.nodes) {
    const { schedule, next, stamp } = scheduleFor(n, g.input, now);
    const runs = state.runs[n.id] || [];
    const mine = runs[0] ? { at: runs[0].finishedAt, status: runs[0].status, durationMs: runs[0].durationMs } : null;
    const lastRun = mine && (!stamp || Date.parse(mine.at) >= Date.parse(stamp.at)) ? mine : stamp;
    nextOf.set(n.id, next);
    let sub = n.sub;
    if (n.kind === 'dataset') {
      const d: Rec = (g.input.datasets as Rec[]).find((x) => x.id === (n.ref && n.ref.id)) || {};
      const word = d.sourceKind === 'input' ? 'Input table' : ORIGIN_WORD[(d.origin && d.origin.kind) || ''] || (n.stage === 2 ? 'Derived' : 'Imported');
      const rows = Number(d.rowCount) || 0;
      sub = `${word} · ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;
    }
    views.set(n.id, { ...n, sub, schedule, lastRun, nextRunAt: null, paused: paused.has(n.id), runs });
  }
  // A node runs next when it or anything upstream of it does, or the pipeline does.
  const preds = new Map<string, string[]>();
  for (const e of g.graph.edges) (preds.get(e.to) || preds.set(e.to, []).get(e.to)!).push(e.from);
  for (const id of topoOrder(g.graph.nodes.map((n) => n.id), g.graph.edges).order) {
    const cands = [nextOf.get(id), pipeNext, ...(preds.get(id) || []).map((p) => nextOf.get(p))].filter((x): x is number => typeof x === 'number');
    const next = cands.length ? Math.min(...cands) : null;
    nextOf.set(id, next);
    views.get(id)!.nextRunAt = next === null ? null : new Date(next).toISOString();
  }
  return {
    ok: true,
    stages: STAGES,
    nodes: g.graph.nodes.map((n) => views.get(n.id)!),
    edges: g.graph.edges,
    schedule: s ? { ...s, text: describeCron(s.cron), nextRunAt: pipeNext === null ? null : new Date(pipeNext).toISOString() } : null,
    policy: state.policy,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}
