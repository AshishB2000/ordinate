// Lineage — what a record is built from, and what is built from it. MAIN.
//
// One dependency graph per project, drawn from references the records already
// carry and nothing else: a dataset's `origin` and prepare `steps`, a visual's
// `datasetId` and the columns its encoding names, a measure's `metricId`, a
// metric's definition, a dashboard card's `visualId` / `metric` / `control`, a
// report's `analysisId`, an alert rule's `datasetId` and `metric`. No new field
// is stored anywhere to make this work.
//
//   source → dataset → prepare steps → calculated fields → metrics → visuals
//          → dashboards → reports and alerts
//
// COLUMN-LEVEL where the records allow it: a visual that charts `Month` hangs
// off the `Month` calculated field, not off the dataset in general — which is
// what makes "change this formula and these three charts move" readable.
//
// Three exports, split so the graph is testable without a disk:
//   buildGraph(input)        pure: records in, nodes and edges out
//   focus(graph, nodeId)     pure: the node, everything upstream, everything
//                            downstream, laid out in columns
//   loadLineage(pid, t, id)  reads the project's stores and does both
//
// CYCLES ARE IMPOSSIBLE BY CONSTRUCTION: the layout gives every node a column
// strictly right of each of its inputs, and an edge that would close a loop (a
// metric formula naming itself through another metric) is dropped while
// ordering, so every edge in the output points left to right.

import { stepRefIds } from '../data/stepTypes';

export type LineageKind =
  | 'source' | 'dataset' | 'prepare' | 'calc' | 'metric' | 'visual' | 'dashboard' | 'report' | 'alert';

export interface LineageNode {
  id: string;
  kind: LineageKind;
  name: string;
  /** The dim second line: "CSV file", "sum(revenue)", "8 tiles". */
  sub: string;
  /** What clicking it opens: the record type and id. */
  ref?: { type: string; id: string };
  col?: number;
  row?: number;
}

export interface LineageEdge { from: string; to: string }

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface FocusedLineage extends LineageGraph {
  focus: string;
  /** How many of each record kind sit DOWNSTREAM of the focus: "Used in …". */
  usedIn: Partial<Record<LineageKind, number>>;
  columns: number;
}

/** Left-to-right order. A node never sits left of this rank for its kind. */
export const KIND_RANK: Record<LineageKind, number> = {
  source: 0, dataset: 1, prepare: 2, calc: 3, metric: 4, visual: 5, dashboard: 6, report: 7, alert: 7,
};

// ── Input shapes: only the fields read here ─────────────────────────────────
// ponytail: loose record shapes — each store's own sanitizer already shaped them
type Rec = Record<string, any>;

export interface LineageInput {
  datasets: Rec[];
  visuals: Rec[];
  dashboards: Rec[];
  metrics: Rec[];
  reports: Rec[];
  alerts: Rec[];
  connections?: Array<{ id: string; name: string; kind?: string }>;
  captures?: Array<{ id: string; title?: string }>;
  /** r7:notebooks — the notebooks a `notebook` origin names. */
  notebooks?: Array<{ id: string; name: string }>;
}

const SOURCE_WORD: Record<string, string> = {
  csv: 'CSV file', xlsx: 'Excel file', json: 'JSON file', paste: 'Pasted data',
  capture: 'Screenshot', postgres: 'Database', url: 'Web address', combined: 'Combined datasets',
  input: 'Input table',
};

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Column names a visual's encoding and filters read. */
function visualColumns(v: Rec): string[] {
  const e: Rec = v.encoding || {};
  const cols = [str(e.category), str(e.series)];
  for (const m of arr(e.values)) if (m && !m.metricId) cols.push(str(m.column));
  const p: Rec = e.pivot || {};
  for (const r of arr(p.rows)) cols.push(str(r && typeof r === 'object' ? r.column : r));
  for (const c of arr(p.columns)) cols.push(str(c && typeof c === 'object' ? c.column : c));
  for (const val of arr(p.values)) if (val && !val.metricId) cols.push(str(val.column));
  for (const f of arr(v.filters)) cols.push(str(f && f.column));
  return cols.filter(Boolean);
}

/** `[Name]` references and `agg(column)` operands of a metric formula. */
function formulaRefs(formula: string): { names: string[]; columns: string[] } {
  const names = [...formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
  const columns = [...formula.matchAll(/\b(?:sum|avg|count|min|max)\s*\(\s*([^()]+?)\s*\)/gi)].map((m) => m[1].replace(/^\[|\]$/g, '').trim());
  return { names, columns };
}

export function buildGraph(input: LineageInput): LineageGraph {
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const seenEdge = new Set<string>();
  const add = (n: LineageNode): string => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const link = (from: string, to: string): void => {
    const k = from + '>' + to;
    if (from === to || seenEdge.has(k) || !nodes.has(from) || !nodes.has(to)) return;
    // Never right to left: an edge into an earlier kind is not a thing the
    // records can say, and the layout's left-to-right promise rests on it.
    if (KIND_RANK[nodes.get(to)!.kind] < KIND_RANK[nodes.get(from)!.kind]) return;
    seenEdge.add(k);
    edges.push({ from, to });
  };
  const connName = new Map((input.connections || []).map((c) => [c.id, c]));
  const captureName = new Map((input.captures || []).map((c) => [c.id, c.title || '']));
  const notebookName = new Map((input.notebooks || []).map((n) => [n.id, n.name]));

  // Datasets, their sources, their prepare steps and calculated fields.
  const calcOf = new Map<string, Map<string, string>>(); // datasetId → field name → node id
  const outputOf = new Map<string, string>();            // datasetId → node the data leaves by
  for (const d of input.datasets) {
    const did = str(d.id);
    if (!did) continue;
    const dNode = add({
      id: 'dataset:' + did, kind: 'dataset', name: str(d.name) || 'Dataset',
      sub: typeof d.rowCount === 'number' ? `${d.rowCount.toLocaleString('en-US')} rows` : 'Dataset',
      ref: { type: 'dataset', id: did },
    });
    const steps = arr(d.steps);
    const other = steps.filter((s) => s && s.type !== 'calculated_field');
    let out = dNode;
    if (other.length) {
      out = add({
        id: 'prepare:' + did, kind: 'prepare',
        name: `${other.length} prepare ${other.length === 1 ? 'step' : 'steps'}`,
        sub: [...new Set(other.map((s) => String(s.type).replace(/_/g, ' ')))].slice(0, 3).join(', '),
        ref: { type: 'dataset', id: did },
      });
      link(dNode, out);
    }
    outputOf.set(did, out);
    const calcs = new Map<string, string>();
    for (const s of steps) {
      if (!s || s.type !== 'calculated_field' || !str(s.name)) continue;
      const cid = add({
        id: `calc:${did}:${s.name}`, kind: 'calc', name: s.name,
        sub: 'Calculated field', ref: { type: 'dataset', id: did },
      });
      link(out, cid);
      calcs.set(s.name, cid);
    }
    calcOf.set(did, calcs);
  }
  // Sources — after every dataset exists, so a combined one can point at its parents.
  for (const d of input.datasets) {
    const did = str(d.id);
    const target = 'dataset:' + did;
    if (!nodes.has(target)) continue;
    // A union / lookup step READS another dataset, so it is built from it — as a
    // combined dataset is from its parents — and counts in that one's "Used in".
    for (const ref of stepRefIds(arr(d.steps))) link('dataset:' + ref, target);
    const o: Rec = d.origin || {};
    let sid = '';
    if (o.kind === 'connection') {
      const c = connName.get(str(o.connId));
      sid = add({
        id: 'source:conn:' + str(o.connId), kind: 'source', name: c ? c.name : 'Connection',
        sub: o.table ? `Table ${o.table}` : (c && c.kind ? c.kind : 'Connection'),
        ref: { type: 'connection', id: str(o.connId) },
      });
    } else if (o.kind === 'file') {
      sid = add({ id: 'source:file:' + str(o.path), kind: 'source', name: basename(str(o.path)), sub: 'File' });
    } else if (o.kind === 'url') {
      let host = str(o.url);
      try { host = new URL(host).hostname || host; } catch (_) { /* keep the raw string */ }
      sid = add({ id: 'source:url:' + str(o.url), kind: 'source', name: host, sub: 'Web address' });
    } else if (o.kind === 'capture') {
      sid = add({
        id: 'source:capture:' + str(o.captureId), kind: 'source',
        name: captureName.get(str(o.captureId)) || 'Screenshot', sub: 'Screenshot',
        ref: { type: 'capture', id: str(o.captureId) },
      });
    } else if (o.kind === 'notebook') {
      // A notebook cell's result: the notebook is the source, and the datasets
      // its cells read are inputs exactly as a combine's parents are.
      sid = add({
        id: 'source:notebook:' + str(o.notebookId), kind: 'source',
        name: notebookName.get(str(o.notebookId)) || 'Deleted notebook', sub: 'Notebook',
        ref: notebookName.has(str(o.notebookId)) ? { type: 'notebook', id: str(o.notebookId) } : undefined,
      });
      for (const p of arr(o.deps)) link('dataset:' + str(p), target);
    } else if (o.kind === 'combined' || o.kind === 'composed') {
      const parents = o.kind === 'combined'
        ? [str(o.leftId), str(o.rightId)]
        : [str(o.baseId), ...arr(o.joins).map((j) => str(j && j.datasetId))];
      for (const p of parents) link('dataset:' + p, target);
      continue;
    } else {
      sid = add({
        id: 'source:import:' + did, kind: 'source',
        name: SOURCE_WORD[str(d.sourceKind)] || 'Import', sub: d.sourceKind === 'input' ? 'Typed in Ordinate' : 'Imported',
      });
    }
    link(sid, target);
  }

  /** Where a consumer of `columns` on `datasetId` gets its data from. */
  const inputsFor = (datasetId: string, columns: string[]): string[] => {
    const calcs = calcOf.get(datasetId);
    const used = calcs ? [...new Set(columns.map((c) => calcs.get(c)).filter((x): x is string => !!x))] : [];
    if (used.length) return used;
    const out = outputOf.get(datasetId);
    return out ? [out] : [];
  };

  // Metrics — nodes first, so a formula can name one defined later in the list.
  const metricByName = new Map<string, string>();
  for (const m of input.metrics) {
    const def: Rec = m.definition || {};
    const id = add({
      id: 'metric:' + str(m.id), kind: 'metric', name: str(m.name) || 'Metric',
      sub: def.formula ? String(def.formula) : `${def.aggregation || 'sum'}(${def.column || ''})`,
      ref: { type: 'metric', id: str(m.id) },
    });
    metricByName.set(str(m.name).toLowerCase(), id);
  }
  for (const m of input.metrics) {
    const id = 'metric:' + str(m.id);
    const def: Rec = m.definition || {};
    const cols = arr(m.filters).map((f) => str(f && f.column));
    if (def.formula) {
      const refs = formulaRefs(String(def.formula));
      for (const n of refs.names) {
        const other = metricByName.get(n.toLowerCase());
        if (other) link(other, id);
        else cols.push(n);
      }
      cols.push(...refs.columns);
    } else {
      cols.push(str(def.column));
    }
    // A formula made only of other metrics reads no column itself: its data
    // arrives through them, and a second edge from the dataset would say otherwise.
    if (def.formula && !cols.some(Boolean)) continue;
    for (const src of inputsFor(str(m.datasetId), cols.filter(Boolean))) link(src, id);
  }

  // Visuals.
  for (const v of input.visuals) {
    const id = add({
      id: 'visual:' + str(v.id), kind: 'visual', name: str(v.name) || 'Visual',
      sub: str(v.chartType).replace(/_/g, ' ') || 'Visual',
      ref: { type: 'visual', id: str(v.id) },
    });
    for (const src of inputsFor(str(v.datasetId), visualColumns(v))) link(src, id);
    const e: Rec = v.encoding || {};
    for (const mm of [...arr(e.values), ...arr(e.pivot && e.pivot.values)]) {
      if (mm && mm.metricId) link('metric:' + mm.metricId, id);
    }
  }

  // Dashboards: one node each; its tiles are its edges.
  for (const a of input.dashboards) {
    const cards = arr(a.sheets).flatMap((p) => arr(p && p.cards));
    const tiles = cards.filter((c) => c && c.type !== 'control').length;
    const id = add({
      id: 'dashboard:' + str(a.id), kind: 'dashboard', name: str(a.name) || 'Dashboard',
      sub: `${tiles} ${tiles === 1 ? 'tile' : 'tiles'}`, ref: { type: 'dashboard', id: str(a.id) },
    });
    for (const c of cards) {
      if (!c) continue;
      if (c.type === 'visual' && c.visualId) link('visual:' + c.visualId, id);
      else if (c.type === 'metric' && c.metric) {
        if (c.metric.metricId && nodes.has('metric:' + c.metric.metricId)) link('metric:' + c.metric.metricId, id);
        else for (const src of inputsFor(str(c.metric.datasetId), [str(c.metric.column)])) link(src, id);
      } else if (c.type === 'control' && c.control) {
        for (const src of inputsFor(str(c.control.datasetId), [str(c.control.column)])) link(src, id);
      }
    }
  }

  for (const r of input.reports) {
    const id = add({
      id: 'report:' + str(r.id), kind: 'report', name: str(r.name) || 'Report',
      sub: `${String(r.format || 'pdf').toUpperCase()} report`, ref: { type: 'report', id: str(r.id) },
    });
    link('dashboard:' + str(r.analysisId), id);
  }

  for (const al of input.alerts) {
    const m: Rec = al.metric || {};
    const id = add({
      id: 'alert:' + str(al.id), kind: 'alert', name: str(al.name) || 'Alert',
      sub: al.compare === 'anomaly' ? 'Anomaly alert' : al.compare === 'change' ? 'Change alert' : 'Threshold alert',
      ref: { type: 'alert', id: str(al.id) },
    });
    if (m.metricId && nodes.has('metric:' + m.metricId)) link('metric:' + m.metricId, id);
    else {
      const cols = [str(m.column), ...arr(m.filters).map((f) => str(f && f.column)), str(al.change && al.change.periodColumn)];
      for (const src of inputsFor(str(al.datasetId), cols.filter(Boolean))) link(src, id);
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * The focus node, everything it is built from, and everything built from it —
 * laid out in columns, each node strictly right of all of its inputs.
 */
export function focus(graph: LineageGraph, nodeId: string): FocusedLineage {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const empty: FocusedLineage = { nodes: [], edges: [], focus: nodeId, usedIn: {}, columns: 0 };
  if (!byId.has(nodeId)) return empty;
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of graph.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e.to);
    (inn.get(e.to) || inn.set(e.to, []).get(e.to)!).push(e.from);
  }
  const walk = (start: string, next: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of next.get(cur) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return seen;
  };
  const up = walk(nodeId, inn);
  const down = walk(nodeId, out);
  const keep = new Set([nodeId, ...up, ...down]);
  let edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)
    // Only edges ON a path through the focus: sibling branches of an upstream
    // node are not part of this record's story.
    && ((up.has(e.from) || e.from === nodeId) && (up.has(e.to) || e.to === nodeId)
      || (down.has(e.from) || e.from === nodeId) && (down.has(e.to) || e.to === nodeId)));

  // Order by DFS; an edge back into the current path would close a loop and is dropped.
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const order: string[] = [];
  const outK = new Map<string, string[]>();
  for (const e of edges) (outK.get(e.from) || outK.set(e.from, []).get(e.from)!).push(e.to);
  const back = new Set<string>();
  const visit = (n: string): void => {
    state.set(n, 1);
    for (const m of outK.get(n) || []) {
      if (state.get(m) === 1) back.add(n + '>' + m);
      else if (!state.has(m)) visit(m);
    }
    state.set(n, 2);
    order.push(n);
  };
  for (const n of [...keep].sort()) if (!state.has(n)) visit(n);
  order.reverse();
  edges = edges.filter((e) => !back.has(e.from + '>' + e.to));

  const preds = new Map<string, string[]>();
  for (const e of edges) (preds.get(e.to) || preds.set(e.to, []).get(e.to)!).push(e.from);
  // Columns in BANDS, one per kind rank: every metric sits left of every
  // visual, so a column holds one kind. Inside a band a chain of the same kind
  // (a formula metric over two others, a dataset combined from two) steps one
  // sub-column right per link.
  const col = new Map<string, number>();
  let base = 0;
  for (const rank of [...new Set(order.map((n) => KIND_RANK[byId.get(n)!.kind]))].sort((a, b) => a - b)) {
    let top = base;
    for (const n of order) {
      if (KIND_RANK[byId.get(n)!.kind] !== rank) continue;
      let c = base;
      for (const p of preds.get(n) || []) if (col.has(p) && col.get(p)! >= base) c = Math.max(c, col.get(p)! + 1);
      col.set(n, c);
      top = Math.max(top, c);
    }
    base = top + 1;
  }
  // Squeeze out columns no node landed in.
  const used = [...new Set(col.values())].sort((a, b) => a - b);
  const remap = new Map(used.map((c, i) => [c, i]));
  const columns: string[][] = used.map(() => []);
  for (const n of order) columns[remap.get(col.get(n)!)!].push(n);
  // Within a column: by the average row of the inputs (fewer crossings), then name.
  const row = new Map<string, number>();
  columns.forEach((ids) => {
    const score = (id: string): number => {
      const ps = (preds.get(id) || []).map((p) => row.get(p) ?? 0);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    };
    ids.sort((a, b) => score(a) - score(b) || byId.get(a)!.name.localeCompare(byId.get(b)!.name));
    ids.forEach((id, i) => row.set(id, i));
  });
  const nodes = order.map((id) => ({ ...byId.get(id)!, col: remap.get(col.get(id)!)!, row: row.get(id)! }));
  const usedIn: Partial<Record<LineageKind, number>> = {};
  for (const id of down) {
    const k = byId.get(id)!.kind;
    usedIn[k] = (usedIn[k] || 0) + 1;
  }
  return { nodes, edges, focus: nodeId, usedIn, columns: used.length };
}
