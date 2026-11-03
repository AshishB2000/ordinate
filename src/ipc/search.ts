// Global search — MAIN PROCESS.
//
// The sidebar's search box has promised "datasets, visuals, dashboards and
// connectors" since it was built, and until now nothing in the renderer even
// referenced it. This is what makes the label true.
//
// NAMES ONLY. Not row contents.
// ponytail: names only; content search is a different feature with a different cost
//
// TWO PATHS, ONE ANSWER (matching and order: src/app/searchMatch.ts).
//   index      with a database: one query over search_entries (0022, ../server/searchIndex.ts),
//              which every write keeps current in its own transaction (recordFs). A source never
//              built (a new install, a version bump) is rebuilt from the records first, once.
//   reference  without one, or on any failure: read every list, as the sections paint themselves.
// Both turn a stored record into rows through the SAME mapping below, fed by each store's own
// parser (datasets.summaryOf, …) — the one its list uses. scripts/test-searchIndex.ts holds the
// two equal.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import * as connections from '../connectors/connections';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import { tagSearch, attachTags } from '../app/catalogIndex';
import type { TagChip } from '../app/catalogIndex';
import * as metrics from '../analysis/metrics';
import * as reportSpec from '../analysis/reportSpec';
import * as alertStore from '../analysis/alertStore';
import type { AlertRule } from '../analysis/alerts';
import { clean, compareKeys, matches, needleOf, rankOf, wordsOf } from '../app/searchMatch';
import type { OrderKeys } from '../app/searchMatch';
import { SOURCES } from '../app/searchSources';
import type { RecordSource, SourceKey } from '../app/searchSources';
import * as index from '../server/searchIndex';
import type { IndexRow } from '../server/searchIndex';
import * as trace from '../engine/residentTrace';

/** Enough to be useful, few enough to read without scrolling. */
const MAX_RESULTS = 20;

export interface SearchHit {
  kind: 'dataset' | 'visual' | 'analysis' | 'view' | 'connection' | 'metric' | 'report' | 'story' | 'alert';
  id: string;
  /** A saved view's dashboard id — the record a `view` hit opens. */
  parentId?: string;
  name: string;
  /** A dim second line: rows, chart type, sheet count — whatever the list already knows. */
  sub: string;
  /** The kind, in the words the UI says it in ("Dataset", "Dashboard"). */
  type: string;
  /** Which project the record is in. The palette searches every project. */
  projectId: string;
  projectName: string;
  /** Same text as `sub` — what the row shows under the name. */
  snippet: string;
  /** Catalog tags, coloured — shown as chips on the row. */
  tags?: TagChip[];
}

/** The kind names the app uses on screen. `analysis` is a dashboard to a user. */
const TYPE_LABEL: Record<SearchHit['kind'], string> = {
  dataset: 'Dataset',
  visual: 'Visual',
  analysis: 'Dashboard',
  view: 'Saved view',
  connection: 'Connection',
  metric: 'Metric',
  report: 'Report',
  story: 'Story',
  alert: 'Alert',
};

/** What a search returns per match, either path. */
export type Found = Pick<SearchHit, 'kind' | 'id' | 'parentId' | 'name' | 'sub'>;
/** A record's row before an audience: what it shows, and the keys it is ordered by. */
type Item = Found & Pick<IndexRow, 'updated' | 'rec' | 'ord'>;

// ── A summary → its rows: the ONE mapping both paths use ─────────────────────

const named = (name: unknown): name is string => typeof name === 'string';
const stamp = (updatedAt: unknown): string => (typeof updatedAt === 'string' ? updatedAt : '');
/** Every text a row holds, as Postgres text can store it: one NUL in a detail line (a metric's column) fails the index's insert. */
const stored = (it: Item): Item => ({
  ...it, id: clean(it.id), name: clean(it.name), sub: clean(it.sub), updated: clean(it.updated), rec: clean(it.rec),
  ...(it.parentId === undefined ? {} : { parentId: clean(it.parentId) }),
});
const one = (kind: Item['kind'], id: unknown, name: unknown, sub: string, updatedAt: unknown): Item[] =>
  named(name) ? [stored({ kind, id: String(id), name, sub, updated: stamp(updatedAt), rec: String(id), ord: 0 })] : [];

const fromDataset = (d: datasets.DatasetSummary): Item[] => one('dataset', d.id, d.name, `${Number(d.rowCount || 0).toLocaleString()} rows`, d.updatedAt);
const fromVisual = (v: visuals.VisualSummary): Item[] => one('visual', v.id, v.name, String(v.chartType || 'visual'), v.updatedAt);
const fromConnection = (c: connections.Connection): Item[] => one('connection', c.id, c.name, 'kind' in c && c.kind ? String(c.kind) : 'connection', c.updatedAt);
const fromMetric = (m: metrics.MetricSummary): Item[] =>
  one('metric', m.id, m.name, 'formula' in m.definition ? 'Formula metric' : `${m.definition.aggregation}(${m.definition.column})`, m.updatedAt);
const fromReport = (r: Pick<reportSpec.ReportSummary, 'id' | 'name' | 'format' | 'updatedAt'>): Item[] =>
  one('report', r.id, r.name, String(r.format || 'pdf').toUpperCase() + ' report', r.updatedAt);
// Metrics, reports and alert rules are records too — the palette's → actions
// (History, Lineage) are how a metric or an alert reaches either.
const fromAlerts = (rules: readonly AlertRule[]): Item[] =>
  rules.filter((a) => !a.fromWatch && named(a.name)).map((a, ord) => stored({ kind: 'alert', id: String(a.id), name: a.name, sub: 'Alert rule', updated: '', rec: '', ord }));
function fromAnalysis(a: analysis.AnalysisSummary): Item[] {
  const rec = String(a.id);
  const sheets = a.sheetCount ? `${a.sheetCount} sheet${a.sheetCount === 1 ? '' : 's'}` : 'dashboard';
  return [
    ...one('analysis', a.id, a.name, sheets, a.updatedAt),
    // r10:views — "Retail overview › West Q4", matched on the whole phrase.
    ...(a.views || []).map((v, i): Item => stored({ kind: 'view', id: String(v.id), parentId: rec, name: `${a.name} › ${v.name}`, sub: 'Saved view', updated: stamp(a.updatedAt), rec, ord: i + 1 })),
  ];
}

/** The reference's lists, by source: each caller-aware where its list is (dashboards). */
const LISTS: Record<SourceKey, (projectId: string) => Promise<Item[]>> = {
  datasets: async (p) => (await datasets.listDatasets(p)).flatMap(fromDataset),
  visuals: async (p) => (await visuals.listVisuals(p)).flatMap(fromVisual),
  analyses: async (p) => (await analysis.listAnalyses(p)).flatMap(fromAnalysis),
  connections: async (p) => (await connections.listConnections(p)).flatMap(fromConnection),
  metrics: async (p) => (await metrics.listMetrics(p)).flatMap(fromMetric),
  reports: async (p) => (await reportSpec.listReports(p)).flatMap(fromReport),
  alerts: async (p) => fromAlerts((await alertStore.load(p)).rules),
};

const forAll = (items: Item[]): IndexRow[] => items.map((it) => ({ ...it, audience: 'all' }));

/** The index's describer: one stored record → its rows for every audience, through each store's own parser. */
export function describeRecord(where: RecordSource, body: string): IndexRow[] {
  const p = where.projectId;
  try {
    switch (where.source) {
      case 'datasets': { const d = datasets.summaryOf(p, body); return d ? forAll(fromDataset(d)) : []; }
      case 'visuals': { const v = visuals.summaryOf(p, body); return v ? forAll(fromVisual(v)) : []; }
      case 'connections': { const c = connections.connectionOf(p, where.id, body); return c ? forAll(fromConnection(c)) : []; }
      case 'metrics': { const m = metrics.summaryOf(p, body); return m ? forAll(fromMetric(m)) : []; }
      case 'reports': { const r = reportSpec.reportOf(p, body); return r ? forAll(fromReport(r)) : []; }
      case 'alerts': return forAll(fromAlerts(alertStore.rulesOf(JSON.parse(body))));
      case 'analyses': {
        // Parsed once per audience: a parser may normalize what it is handed in place.
        const editor = analysis.summaryOf(p, JSON.parse(body), false);
        const viewer = analysis.summaryOf(p, JSON.parse(body), true);
        return [
          ...(editor ? fromAnalysis(editor).map((it): IndexRow => ({ ...it, audience: 'editor' })) : []),
          ...(viewer ? fromAnalysis(viewer).map((it): IndexRow => ({ ...it, audience: 'viewer' })) : []),
        ];
      }
    }
  } catch (_) {
    return []; // unreadable: its list skips it too
  }
}

const found = ({ kind, id, parentId, name, sub }: Found): Found => ({ kind, id, ...(parentId ? { parentId } : {}), name, sub });

/** The reference: read every list, keep the names whose words start with every word typed, best first. */
export async function searchNames(projectId: string, query: string): Promise<Found[]> {
  const typed = wordsOf(query);
  if (!typed.length) return [];
  const needle = needleOf(query);
  const hits: Array<{ it: Item; keys: OrderKeys }> = [];
  for (const [srcOrd, source] of SOURCES.entries()) {
    let items: Item[] = [];
    try {
      items = await LISTS[source](projectId);
    } catch (_) { /* one unreadable list must not empty the others */ }
    for (const it of items) {
      if (matches(wordsOf(it.name), typed)) hits.push({ it, keys: { rank: rankOf(it.name.toLowerCase(), needle), updated: it.updated, srcOrd, rec: it.rec, ord: it.ord } });
    }
  }
  return hits.sort((a, b) => compareKeys(a.keys, b.keys)).map((h) => found(h.it));
}

/** The same answer from the index (its unbuilt sources built first); null without a database or on any failure. */
export async function searchIndexed(projectId: string, query: string, viewer: boolean, limit: number): Promise<Found[] | null> {
  // Records live under the id as written; the lists read it as given, so a differently-cased id reads nothing there.
  if (projectId !== projectId.toLowerCase()) {
    trace.record('search:names', 'skipped');
    return null;
  }
  try {
    const missing = await index.unbuilt(projectId);
    if (!missing) {
      trace.record('search:names', 'skipped');
      return null;
    }
    for (const source of missing) await index.rebuild(projectId, source, recordFs.rowsUnder);
    const typed = wordsOf(query);
    const rows = typed.length ? await index.query(projectId, typed, needleOf(query), viewer ? ['all', 'viewer'] : ['all', 'editor'], limit) : [];
    trace.record('search:names', rows ? 'resident' : 'skipped');
    return rows ? rows.map((r) => found(r as Found)) : null;
  } catch (err) {
    trace.record('search:names', 'failed', String((err as { code?: unknown })?.code ?? 'error')); // a code, never a name
    return null;
  }
}

/** Every project the search covers: the one asked for, or all of them. */
async function scope(projectId: string): Promise<{ id: string; name: string }[]> {
  if (projectId) {
    const p = await projects.getProject(projectId);
    return [{ id: projectId, name: p ? p.name : '' }];
  }
  // The palette opens on Home too, where there is no active project — and a
  // search box that answers nothing there is the box that made this feature
  // necessary. Project lists are metadata-only (src/app/projects.ts), so this
  // is the same cost per project the sidebar already pays to paint itself.
  // Archived projects are out of the search, as they are out of Recent.
  return (await projects.listProjects()).filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name }));
}

async function search(projectId: string, query: string): Promise<SearchHit[]> {
  const q = needleOf(String(query || ''));
  if (!q) return [];
  const hits: SearchHit[] = [];

  for (const project of await scope(projectId)) {
    const room = MAX_RESULTS - hits.length;
    if (room <= 0) break;
    // '#sales' searches TAGS across every record kind (src/app/catalogIndex.ts).
    if (q.charAt(0) === '#') {
      for (const h of (await tagSearch(project.id, q)).slice(0, room)) hits.push({ ...h, projectId: project.id, projectName: project.name, snippet: h.sub });
      continue;
    }
    const viewer = await analysis.readsPublishedOnly(project.id);
    const matched = (await searchIndexed(project.id, q, viewer, room)) ?? (await searchNames(project.id, q));
    for (const f of matched.slice(0, room)) {
      hits.push({ ...f, type: TYPE_LABEL[f.kind], projectId: project.id, projectName: project.name, snippet: f.sub });
    }
  }
  await attachTags(hits);
  return hits;
}

export function register(): void {
  index.useDescriber(describeRecord);
  ipcMain.handle('search:query', async (_e, { projectId, query }: any = {}) => {
    try {
      return { ok: true, results: await search(projectId, query) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Search failed', results: [] };
    }
  });
}
