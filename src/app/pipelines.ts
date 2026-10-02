// Pipelines — every scheduled or dependent thing in a project as ONE DAG, and
// the rule for running it. PURE: no Electron, no disk, no clock.
//
// THE GRAPH IS LINEAGE'S. src/analysis/lineage.ts already draws every reference
// the records carry (a dataset's origin and steps, a visual's dataset, a
// dashboard's tiles, a report's dashboard, an alert's metric). A pipeline keeps
// only the nodes that RUN — sources, datasets, quality checks, alerts, reports
// and the publish — and connects two of them when lineage has a path between
// them through nodes that do not run (prepare steps, calculated fields,
// metrics, visuals, dashboards). No new reference is stored to make this work.
//
// Six stages, left to right — the page's columns:
//   0 sources (connections, folder watches, files, web addresses)
//   1 datasets
//   2 derived datasets (SQL, combined, and anything reading an input table)
//   3 quality checks       4 alerts       5 reports and the publish
//
// A dataset's quality checks GATE what is built from it downstream: its alerts,
// reports and the publish hang off the checks rather than the dataset, so a
// FAIL rule that fails stops them, the way a broken refresh does.
//
// CYCLES ARE REFUSED. Records can only name records that already exist, but a
// hand-edited file can still close a loop; `buildPipeline` then returns the
// loop instead of a graph, and nothing runs.
//
// `runGraph` is the runner with every effect injected: what running one node
// means, and how to wait between retries. It starts each node the moment all
// of its inputs are done, so independent branches run side by side.

import type { LineageGraph } from '../analysis/lineage';

export type PipelineKind = 'source' | 'dataset' | 'quality' | 'alert' | 'report' | 'publish';

export const STAGES = ['Sources', 'Datasets', 'Derived datasets', 'Quality checks', 'Alerts', 'Reports & publish'] as const;

export interface PipelineNode {
  id: string;
  kind: PipelineKind;
  stage: number;
  name: string;
  sub: string;
  ref?: { type: string; id: string };
}

export interface PipelineEdge { from: string; to: string }

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export type BuildResult = ({ ok: true } & PipelineGraph) | { ok: false; error: string; cycle: string[] };

export interface PipelineExtras {
  /** Datasets that have at least one quality rule. */
  qualityDatasets?: string[];
  /** The project's stored publish, when there is one. */
  publish?: { dashboardIds: string[]; outDir: string } | null;
  /** Datasets that can be re-fetched or recomputed — kept even with no edges. */
  runnable?: string[];
  /** A SQL dataset's inputs (`origin.deps`), which lineage does not draw. */
  sqlDeps?: Record<string, string[]>;
}

const RUNS = new Set(['source', 'dataset', 'quality', 'alert', 'report', 'publish']);
/** Lineage sources that name something to fetch; an import or a screenshot does not. */
const FETCHABLE_SOURCE = /^source:(conn|file|url):/;

/** The nodes reached from `id` — every one when `start` is a list. */
export function downstream(edges: PipelineEdge[], start: string[]): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set(start);
  const stack = [...start];
  while (stack.length) for (const n of out.get(stack.pop()!) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen;
}

/**
 * Kahn's order over `ids` (edges outside them ignored), ties by the order given.
 * `cycle` lists what could not be ordered when the graph loops.
 */
export function topoOrder(ids: string[], edges: PipelineEdge[]): { order: string[]; cycle: string[] } {
  const inSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!inSet.has(e.from) || !inSet.has(e.to)) continue;
    indeg.set(e.to, indeg.get(e.to)! + 1);
    (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e.to);
  }
  const order: string[] = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const n of out.get(id) || []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) ready.push(n);
    }
  }
  return { order, cycle: ids.filter((id) => !order.includes(id)) };
}

/** Lineage in, the pipeline out — or the loop that stops it. */
export function buildPipeline(lineage: LineageGraph, extras: PipelineExtras = {}): BuildResult {
  const nodes = new Map<string, PipelineNode>();
  const lin = new Map(lineage.nodes.map((n) => [n.id, n]));
  const edges: PipelineEdge[] = [...lineage.edges];
  const keep = (id: string): boolean => {
    const n = lin.get(id);
    if (!n || !RUNS.has(n.kind)) return false;
    return n.kind !== 'source' || FETCHABLE_SOURCE.test(id);
  };
  for (const n of lineage.nodes) {
    if (!keep(n.id)) continue;
    nodes.set(n.id, { id: n.id, kind: n.kind as PipelineKind, stage: 0, name: n.name, sub: n.sub, ...(n.ref ? { ref: n.ref } : {}) });
  }
  for (const [id, deps] of Object.entries(extras.sqlDeps || {})) {
    for (const d of deps) edges.push({ from: 'dataset:' + d, to: 'dataset:' + id });
  }
  const qualityOf = new Map<string, string>();
  for (const did of extras.qualityDatasets || []) {
    const ds = nodes.get('dataset:' + did);
    if (!ds) continue;
    const id = 'quality:' + did;
    nodes.set(id, { id, kind: 'quality', stage: 3, name: ds.name, sub: 'Quality checks', ref: { type: 'dataset', id: did } });
    qualityOf.set(ds.id, id);
    edges.push({ from: ds.id, to: id });
  }
  if (extras.publish) {
    const id = 'publish';
    const folder = extras.publish.outDir.split(/[\\/]/).filter(Boolean).pop() || 'folder';
    nodes.set(id, { id, kind: 'publish', stage: 5, name: 'Publish to ' + folder, sub: 'Published site' });
    for (const d of extras.publish.dashboardIds) edges.push({ from: 'dashboard:' + d, to: id });
  }

  // Project: an edge between two running nodes wherever lineage has a path
  // between them that passes only through nodes that do not run.
  const succ = new Map<string, string[]>();
  for (const e of edges) (succ.get(e.from) || succ.set(e.from, []).get(e.from)!).push(e.to);
  const projected: PipelineEdge[] = [];
  const seenEdge = new Set<string>();
  for (const from of nodes.keys()) {
    const seen = new Set<string>();
    const stack = [...(succ.get(from) || [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (nodes.has(cur)) {
        if (cur !== from && !seenEdge.has(from + '>' + cur)) { seenEdge.add(from + '>' + cur); projected.push({ from, to: cur }); }
        continue;
      }
      stack.push(...(succ.get(cur) || []));
    }
  }

  // Stages: a dataset built from another dataset is derived.
  const hasDatasetParent = new Set(projected.filter((e) => nodes.get(e.from)!.kind === 'dataset' && nodes.get(e.to)!.kind === 'dataset').map((e) => e.to));
  const STAGE: Record<PipelineKind, number> = { source: 0, dataset: 1, quality: 3, alert: 4, report: 5, publish: 5 };
  for (const n of nodes.values()) {
    n.stage = n.kind === 'dataset' && hasDatasetParent.has(n.id) ? 2 : STAGE[n.kind];
    if (n.kind === 'dataset' && n.stage === 2) n.sub = n.sub || 'Derived';
  }

  // The quality gate: a dataset's later-stage consumers wait on its checks.
  const gated = new Map<string, PipelineEdge>();
  for (const e of projected) {
    const gate = qualityOf.get(e.from);
    const g = gate && nodes.get(e.to)!.stage > 3 ? { from: gate, to: e.to } : e;
    gated.set(g.from + '>' + g.to, g);
  }
  let out = [...gated.values()];

  // Nothing runs and nothing depends on it: not part of any pipeline.
  const linked = new Set(out.flatMap((e) => [e.from, e.to]));
  const runnable = new Set((extras.runnable || []).map((d) => 'dataset:' + d));
  const kept = [...nodes.values()].filter((n) => linked.has(n.id) || runnable.has(n.id) || n.kind === 'report' || n.kind === 'publish');
  const ids = kept.map((n) => n.id);
  out = out.filter((e) => ids.includes(e.from) && ids.includes(e.to));

  const { cycle } = topoOrder(ids, out);
  if (cycle.length) {
    return { ok: false, error: 'These records read each other in a circle, so nothing can run first.', cycle: cycle.map((id) => nodes.get(id)!.name) };
  }
  return { ok: true, nodes: orderRows(kept, out), edges: out };
}

/** Within a stage, by the average position of the inputs (fewer crossings), then name. */
function orderRows(nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode[] {
  const preds = new Map<string, string[]>();
  for (const e of edges) (preds.get(e.to) || preds.set(e.to, []).get(e.to)!).push(e.from);
  const row = new Map<string, number>();
  const result: PipelineNode[] = [];
  for (let s = 0; s < STAGES.length; s += 1) {
    const col = nodes.filter((n) => n.stage === s);
    const score = (n: PipelineNode): number => {
      const ps = (preds.get(n.id) || []).map((p) => row.get(p)).filter((x): x is number => x !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER;
    };
    col.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    col.forEach((n, i) => row.set(n.id, i));
    result.push(...col);
  }
  return result;
}

// ── The runner ───────────────────────────────────────────────────────────────

export type RunStatus = 'ok' | 'failed' | 'blocked' | 'paused';

export interface ExecResult {
  ok: boolean;
  error?: string;
  rows?: number;
  rowsBefore?: number;
  warnings?: string[];
  note?: string;
  /** False: running it again cannot change the answer (a failing quality rule). */
  retryable?: boolean;
}

export interface NodeOutcome {
  nodeId: string;
  status: RunStatus;
  attempts: number;
  startedAt: number;
  finishedAt: number;
  result?: ExecResult;
  /** For `blocked`: the upstream node that stopped it. */
  blockedBy?: string;
}

export interface RetryPolicy {
  /** 0–3. */
  retries: number;
  /** The first wait; each retry waits twice the one before. */
  backoffMs: number;
}

export function sanitizePolicy(raw: unknown): RetryPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const r = Math.round(Number(o.retries));
  const b = Math.round(Number(o.backoffMs));
  return {
    retries: Number.isFinite(r) ? Math.min(3, Math.max(0, r)) : 0,
    backoffMs: Number.isFinite(b) ? Math.min(600_000, Math.max(1000, b)) : 30_000,
  };
}

/** The wait before retry `n` (1-based). */
export const backoffFor = (policy: RetryPolicy, n: number): number => policy.backoffMs * 2 ** (n - 1);

export interface RunOptions {
  exec: (nodeId: string) => Promise<ExecResult>;
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  /** Nodes to step over: marked paused, and what is downstream still runs. */
  paused?: Set<string>;
  onStart?: (nodeId: string) => void;
  onDone?: (o: NodeOutcome) => void;
}

/**
 * Run `start` and everything downstream of it. Each node waits for its inputs
 * inside the run; one that failed or was blocked blocks it. Never rejects — a
 * thrown exec is a failed attempt.
 */
export async function runGraph(graph: PipelineGraph, start: string[], opts: RunOptions): Promise<NodeOutcome[]> {
  const now = opts.now || Date.now;
  const known = new Set(graph.nodes.map((n) => n.id));
  const set = downstream(graph.edges, start.filter((id) => known.has(id)));
  const ids = graph.nodes.map((n) => n.id).filter((id) => set.has(id));
  const { cycle } = topoOrder(ids, graph.edges);
  if (cycle.length) throw new Error('A pipeline with a cycle cannot run.');
  const preds = new Map<string, string[]>();
  for (const e of graph.edges) if (set.has(e.from) && set.has(e.to)) (preds.get(e.to) || preds.set(e.to, []).get(e.to)!).push(e.from);

  const done = new Map<string, Promise<NodeOutcome>>();
  const runOne = async (id: string): Promise<NodeOutcome> => {
    const inputs = await Promise.all((preds.get(id) || []).map((p) => done.get(p)!));
    const t0 = now();
    const bad = inputs.find((o) => o.status === 'failed' || o.status === 'blocked');
    let o: NodeOutcome;
    if (bad) {
      o = { nodeId: id, status: 'blocked', attempts: 0, startedAt: t0, finishedAt: t0, blockedBy: bad.blockedBy || bad.nodeId };
    } else if (opts.paused && opts.paused.has(id)) {
      o = { nodeId: id, status: 'paused', attempts: 0, startedAt: t0, finishedAt: t0 };
    } else {
      if (opts.onStart) opts.onStart(id);
      let attempts = 0;
      let result: ExecResult;
      for (;;) {
        attempts += 1;
        try {
          result = await opts.exec(id);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok || result.retryable === false || attempts > opts.policy.retries) break;
        await opts.sleep(backoffFor(opts.policy, attempts));
      }
      o = { nodeId: id, status: result.ok ? 'ok' : 'failed', attempts, startedAt: t0, finishedAt: now(), result };
    }
    if (opts.onDone) opts.onDone(o);
    return o;
  };
  // Topological order, so every input's promise exists before it is awaited.
  for (const id of topoOrder(ids, graph.edges).order) done.set(id, runOne(id));
  return Promise.all(done.values());
}
