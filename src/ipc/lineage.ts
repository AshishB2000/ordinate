import { ipcMain } from './bus';
import { buildGraph, focus } from '../analysis/lineage';
import type { LineageInput, FocusedLineage } from '../analysis/lineage';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import * as metrics from '../analysis/metrics';
import * as reportSpec from '../analysis/reportSpec';
import * as alertStore from '../analysis/alertStore';
import * as connections from '../connectors/connections';
import * as history from '../app/history';
import { isValidId } from '../app/ids';
import { listNotebooks } from '../analysis/notebook/store';

// Lineage IPC — the dependency graph around one record (src/analysis/lineage.ts
// builds it; this reads the project's records to build it from).
//
// Everything is read fresh on each open: a lineage panel that lagged behind a
// just-saved visual would be wrong in exactly the moment someone looks at it,
// and every read here is a small JSON file — no table is ever opened.

const PREFIX: Record<string, string> = {
  dataset: 'dataset:', visual: 'visual:', dashboard: 'dashboard:',
  metric: 'metric:', report: 'report:', alert: 'alert:',
};

const present = <T>(list: Array<T | null>): T[] => list.filter((x): x is T => x !== null);

export async function loadInput(projectId: string): Promise<LineageInput> {
  const [dsList, visList, anList, metList, reports, alertFile, conns, caps, nbs] = await Promise.all([
    datasets.listDatasets(projectId).catch(() => []),
    visuals.listVisuals(projectId).catch(() => []),
    analysis.listAnalyses(projectId).catch(() => []),
    metrics.listMetrics(projectId).catch(() => []),
    reportSpec.listReports(projectId).catch(() => []),
    alertStore.load(projectId).catch(() => ({ rules: [] })),
    connections.listConnections(projectId).catch(() => []),
    history.loadAllSummaries(projectId).catch(() => []),
    listNotebooks(projectId).catch(() => []),
  ]);
  return {
    datasets: present(await Promise.all(dsList.map((d) => datasets.getDatasetMeta(projectId, d.id)))),
    visuals: present(await Promise.all(visList.map((v) => visuals.getVisual(projectId, v.id)))),
    dashboards: present(await Promise.all(anList.map((a) => analysis.getAnalysis(projectId, a.id)))),
    metrics: present(await Promise.all(metList.map((m) => metrics.getMetric(projectId, m.id)))),
    reports,
    alerts: alertFile.rules || [],
    connections: conns.map((c) => ({ id: c.id, name: c.name, kind: c.connectorId })),
    captures: caps.map((c) => ({ id: String(c.id), title: c.title })),
    notebooks: nbs.map((n) => ({ id: n.id, name: n.name })),
  };
}

export async function lineageFor(projectId: string, type: string, id: string): Promise<(FocusedLineage & { upstream: number }) | null> {
  if (!isValidId(projectId) || !isValidId(id) || !PREFIX[type]) return null;
  const g = redactSources(focus(buildGraph(await loadInput(projectId)), PREFIX[type] + id));
  // "Built from N": the records left of the focus, counted here rather than by a renderer.
  const at = g.nodes.find((n) => n.id === g.focus)?.col ?? 0;
  return { ...g, upstream: g.nodes.filter((n) => (n.col ?? 0) < at).length };
}

/**
 * A file or web-address source is keyed by its full path or URL inside the
 * graph — that is how two datasets from one file share a node — and a URL can
 * carry a key in its query. Every such id leaves as `source:<kind>:<n>`; the
 * edges follow. Names stay: a file's base name, a URL's host.
 */
export function redactSources(g: FocusedLineage): FocusedLineage {
  const map = new Map<string, string>();
  g.nodes.forEach((n, i) => {
    const m = /^source:(file|url):/.exec(n.id);
    if (m) map.set(n.id, `source:${m[1]}:${i}`);
  });
  if (!map.size) return g;
  const re = (s: string): string => map.get(s) ?? s;
  return {
    ...g,
    focus: re(g.focus),
    nodes: g.nodes.map((n) => (map.has(n.id) ? { ...n, id: re(n.id) } : n)),
    edges: g.edges.map((e) => ({ from: re(e.from), to: re(e.to) })),
  };
}

export function register(): void {
  ipcMain.handle('lineage:get', async (_e, { projectId, type, id }: any = {}) =>
    lineageFor(String(projectId || ''), String(type || ''), String(id || '')));
}
