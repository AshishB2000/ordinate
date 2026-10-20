// Which datasets a send's figures can come from — computed by `deliver` itself
// from the SOURCE a caller names (a dashboard, an alert rule); a caller never
// supplies the list (docs/email/00-design.md §2). Item 5 refuses a row-policy
// dataset on exactly this set (deliver.ts `refuseFanOut`).
//
// Deliberately an OVER-approximation — a missed dataset fails open, an extra
// one only fails closed — and computed from DEFINITIONS, never from what the
// figure doors happened to read (a cached answer reads nothing):
//
//   1. the root: the analysis (sheets, cards, inline visuals, filters,
//      parameters, views, controls, analytics …) or the alert rule. Gone →
//      throws, and deliver refuses with `compute_failed`.
//   2. every UUID anywhere in it. One under a `…datasetId(s)` key is IN the set
//      whether or not it can be read; one under a `…visualId(s)` key loads that
//      visual, which is walked the same way.
//   3. src/analysis/lineage.ts's graph, walked UPSTREAM from the root and from
//      every collected id that names a dataset, metric or visual: combined /
//      composed / sql / notebook parents, Prepare union and lookup_join,
//      calculated fields, formula metrics naming other metrics, visual →
//      metric, dashboard → visual / metric / control, alert → metric — plus
//      every reached metric's own dataset, edge or not.
//   4. the project's relationships, both directions, until nothing new
//      appears — each newcomer's own lineage upstream included.
//
// Ceiling (R18): a visual trashed in the seconds between a run composing its
// figures and this read is missing here — `getVisual` cannot tell trashed from
// unreadable, and a card on a trashed visual is legitimate (resolveFigures skips
// it), so "missing" cannot be a refusal.

import * as analysis from '../../analysis/analysis';
import * as alertStore from '../../analysis/alertStore';
import { buildGraph } from '../../analysis/lineage';
import * as metrics from '../../analysis/metrics';
import { listRelationships } from '../../analysis/relationships';
import * as visuals from '../../analysis/visuals';
import * as datasets from '../../data/datasets';
import type { Delivery } from './deliver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATASET_KEY = /datasetids?$/i;
const VISUAL_KEY = /visualids?$/i;
const MAX_DEPTH = 40;

interface Found { all: Set<string>; datasets: Set<string>; visuals: Set<string> }

/** Every UUID anywhere in `v`; those under a dataset- or visual-id key (or in such an array) noted. Too deep → throws. */
export function collectIds(v: unknown, out: Found, key = '', depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('a record nested too deep to read its references');
  if (typeof v === 'string') {
    if (!UUID_RE.test(v)) return;
    const id = v.toLowerCase();
    out.all.add(id);
    if (DATASET_KEY.test(key)) out.datasets.add(id);
    if (VISUAL_KEY.test(key)) out.visuals.add(id);
  } else if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out, key, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collectIds(x, out, k, depth + 1);
  }
}

const present = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null);

export async function figureDatasets(d: Delivery): Promise<string[]> {
  if (d.kind === 'test') return [];
  const pid = d.projectId;
  const root = d.kind === 'dashboard'
    ? await analysis.getAnalysis(pid, d.analysisId)
    : (await alertStore.load(pid)).rules.find((r) => r.id === d.ruleId) ?? null;
  if (!root) throw new Error('the dashboard or alert rule this send is from is gone');

  const found: Found = { all: new Set(), datasets: new Set(), visuals: new Set() };
  collectIds(root, found);
  const vis = new Map<string, visuals.Visual>();
  const tried = new Set<string>();
  for (let next = [...found.visuals]; next.length; next = [...found.visuals].filter((id) => !tried.has(id))) {
    for (const id of next) {
      tried.add(id);
      const v = await visuals.getVisual(pid, id);
      if (v) {
        vis.set(id, v);
        collectIds(v, found);
      }
    }
  }

  const [metas, mets] = await Promise.all([
    datasets.listDatasets(pid).then((l) => Promise.all(l.map((s) => datasets.getDatasetMeta(pid, s.id)))),
    metrics.listMetrics(pid).then((l) => Promise.all(l.map((m) => metrics.getMetric(pid, m.id)))),
  ]);
  const graph = buildGraph({
    datasets: present(metas), visuals: [...vis.values()], metrics: present(mets), reports: [],
    dashboards: d.kind === 'dashboard' ? [root] : [], alerts: d.kind === 'alert' ? [root] : [],
  });
  const nodes = new Set(graph.nodes.map((n) => n.id));
  const up = new Map<string, string[]>();
  for (const e of graph.edges) (up.get(e.to) ?? up.set(e.to, []).get(e.to) as string[]).push(e.from);

  // A metric's own dataset even where lineage draws no edge (a formula made only of other metrics).
  const metricDataset = new Map(present(mets).map((m) => [`metric:${m.id}`, `dataset:${m.datasetId}`]));
  const out = new Set(found.datasets);
  const seen = new Set<string>();
  const climb = (start: string): void => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur.startsWith('dataset:')) out.add(cur.slice('dataset:'.length));
      stack.push(...(up.get(cur) ?? []));
      const own = metricDataset.get(cur);
      if (own) stack.push(own);
    }
  };
  climb(`${d.kind === 'dashboard' ? 'dashboard' : 'alert'}:${d.kind === 'dashboard' ? d.analysisId : d.ruleId}`);
  for (const id of found.all) for (const kind of ['dataset', 'metric', 'visual']) if (nodes.has(`${kind}:${id}`)) climb(`${kind}:${id}`);
  for (const id of found.datasets) climb(`dataset:${id}`);

  const near = new Map<string, string[]>();
  for (const r of await listRelationships(pid)) {
    const [a, b] = [r.from.datasetId.toLowerCase(), r.to.datasetId.toLowerCase()];
    (near.get(a) ?? near.set(a, []).get(a) as string[]).push(b);
    (near.get(b) ?? near.set(b, []).get(b) as string[]).push(a);
  }
  // A Set's iteration visits what is added during it, so this one pass reaches the fixpoint:
  // every newcomer — a related dataset or its lineage upstream — has its own relationships followed.
  for (const id of out) {
    for (const n of near.get(id) ?? []) {
      if (out.has(n)) continue;
      out.add(n);
      climb(`dataset:${n}`);
    }
  }
  return [...out].sort();
}

