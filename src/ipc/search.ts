// Global search — MAIN PROCESS.
//
// The sidebar's search box has promised "datasets, visuals, dashboards and
// connectors" since it was built, and until now nothing in the renderer even
// referenced it. This is what makes the label true.
//
// NAMES ONLY. Not row contents.
// ponytail: names only; content search is a different feature with a different cost
//
// Everything searched here is a metadata LIST that main already loads without
// hydrating a table — the same lists the five sections paint themselves from.
// A search box that reads a million rows to answer a keystroke is not a search
// box, it is a freeze.
//
// TWO PATHS, ONE ANSWER. With a database, a search reads the index
// (0022_search_index.sql, ../server/searchIndex.ts): one stamp query over the
// project's records (recordFs.stampOf, no body read), a rebuild of only the
// sources whose stamp moved — from the SAME lists below — then one query.
// Without one, or on any failure, `searchNames` reads every list, as before.
// Both rank exact, then prefix, then contains (data/dataSearch.ts rankOf), in
// source then list order; scripts/test-searchIndex.ts holds them equal.

import * as path from 'path';
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
import { needleOf, rankOf } from '../data/dataSearch';
import * as index from '../server/searchIndex';
import type { IndexEntry } from '../server/searchIndex';
import * as trace from '../engine/residentTrace';

/** Enough to be useful, few enough to read without scrolling. */
const MAX_RESULTS = 20;
/** Bump when what a source writes changes: every stored stamp is then stale. */
const INDEX_VERSION = 1;

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

type Entry = IndexEntry & { kind: SearchHit['kind'] };

/** One list the search reads: its index key, the records its stamp covers, and everything it can show, in order. */
export interface Source {
  key: string;
  at: (projectId: string) => string;
  list: (projectId: string) => Promise<Entry[]>;
}

const under = (name: string) => (projectId: string): string => path.join(projects.projectDir(projectId), name);
const named = (name: unknown): name is string => typeof name === 'string';

/**
 * The lists, in the order the sidebar lists the sections, so results read in the order of the app they point into.
 * A viewer is listed published dashboards only (analysis.listAnalyses), so dashboards are their own source per audience.
 */
export function sourcesFor(viewer: boolean): Source[] {
  return [
    { key: 'datasets', at: under('datasets'), list: async (p) => (await datasets.listDatasets(p)).filter((d) => named(d.name)).map((d) => ({ kind: 'dataset', id: String(d.id), name: d.name, sub: `${Number(d.rowCount || 0).toLocaleString()} rows` })) },
    { key: 'visuals', at: under('visuals'), list: async (p) => (await visuals.listVisuals(p)).filter((v) => named(v.name)).map((v) => ({ kind: 'visual', id: String(v.id), name: v.name, sub: String(v.chartType || 'visual') })) },
    {
      key: viewer ? 'analyses:viewer' : 'analyses:editor',
      at: under('analyses'),
      list: async (p) => (await analysis.listAnalyses(p)).flatMap((a): Entry[] => [
        ...(named(a.name) ? [{ kind: 'analysis' as const, id: String(a.id), name: a.name, sub: a.sheetCount ? `${a.sheetCount} sheet${a.sheetCount === 1 ? '' : 's'}` : 'dashboard' }] : []),
        // r10:views — "Retail overview › West Q4", matched on the whole phrase.
        ...(a.views || []).map((v) => ({ kind: 'view' as const, id: String(v.id), parentId: String(a.id), name: `${a.name} › ${v.name}`, sub: 'Saved view' })),
      ]),
    },
    { key: 'connections', at: under('connections'), list: async (p) => (await connections.listConnections(p)).filter((c) => named(c.name)).map((c) => ({ kind: 'connection', id: String(c.id), name: c.name, sub: 'kind' in c && c.kind ? String(c.kind) : 'connection' })) },
    // Metrics, reports and alert rules are records too — the palette's → actions
    // (History, Lineage) are how a metric or an alert reaches either.
    { key: 'metrics', at: under('metrics'), list: async (p) => (await metrics.listMetrics(p)).filter((m) => named(m.name)).map((m) => ({ kind: 'metric', id: String(m.id), name: m.name, sub: 'formula' in m.definition ? 'Formula metric' : `${m.definition.aggregation}(${m.definition.column})` })) },
    { key: 'reports', at: under('reports'), list: async (p) => (await reportSpec.listReports(p)).filter((r) => named(r.name)).map((r) => ({ kind: 'report', id: String(r.id), name: r.name, sub: String(r.format || 'pdf').toUpperCase() + ' report' })) },
    { key: 'alerts', at: under('alerts.json'), list: async (p) => (await alertStore.load(p)).rules.filter((a) => !a.fromWatch && named(a.name)).map((a) => ({ kind: 'alert', id: String(a.id), name: a.name, sub: 'Alert rule' })) },
  ];
}

/** The reference: read every list and keep the names holding `needle`, best first. */
export async function searchNames(projectId: string, needle: string, sources: readonly Source[]): Promise<Entry[]> {
  const found: Array<{ e: Entry; rank: number }> = [];
  for (const s of sources) {
    let entries: Entry[] = [];
    try {
      entries = await s.list(projectId);
    } catch (_) { /* one unreadable list must not empty the others */ }
    for (const e of entries) {
      const rank = rankOf(e.name, needle);
      if (rank >= 0) found.push({ e, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.e); // stable: source then list order within a rank
}

/** The same answer from the index, its stale sources rebuilt first; null without a database or on any failure. */
export async function searchIndexed(projectId: string, needle: string, sources: readonly Source[], limit: number): Promise<Entry[] | null> {
  try {
    const stamps = await recordFs.stampOf(sources.map((s) => s.at(projectId)));
    const stored = stamps && (await index.storedStamps(projectId, sources.map((s) => s.key)));
    if (!stamps || !stored) {
      trace.record('search:names', 'skipped');
      return null;
    }
    for (let i = 0; i < sources.length; i++) {
      const stamp = `${INDEX_VERSION}:${stamps[i]}`;
      if (stored.get(sources[i].key) !== stamp) await index.replaceSource(projectId, sources[i].key, i, stamp, await sources[i].list(projectId));
    }
    const rows = await index.queryEntries(projectId, sources.map((s) => s.key), needle, limit);
    trace.record('search:names', rows ? 'resident' : 'skipped');
    return rows as Entry[] | null;
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
    const sources = sourcesFor(await analysis.readsPublishedOnly(project.id));
    const found = (await searchIndexed(project.id, q, sources, room)) ?? (await searchNames(project.id, q, sources));
    for (const e of found.slice(0, room)) {
      hits.push({
        kind: e.kind,
        ...(e.parentId ? { parentId: e.parentId } : {}),
        id: e.id,
        name: e.name,
        sub: e.sub,
        type: TYPE_LABEL[e.kind],
        projectId: project.id,
        projectName: project.name,
        snippet: e.sub,
      });
    }
  }
  await attachTags(hits);
  return hits;
}

export function register(): void {
  ipcMain.handle('search:query', async (_e, { projectId, query }: any = {}) => {
    try {
      return { ok: true, results: await search(projectId, query) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Search failed', results: [] };
    }
  });
}
