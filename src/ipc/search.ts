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

import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import * as connections from '../connectors/connections';
import * as projects from '../app/projects';
import { tagSearch, attachTags } from '../app/catalogIndex';
import type { TagChip } from '../app/catalogIndex';

/** Enough to be useful, few enough to read without scrolling. */
const MAX_RESULTS = 20;

export interface SearchHit {
  kind: 'dataset' | 'visual' | 'analysis' | 'connection' | 'metric' | 'report' | 'story';
  id: string;
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
  connection: 'Connection',
  metric: 'Metric',
  report: 'Report',
  story: 'Story',
};

function matches(name: unknown, q: string): boolean {
  return typeof name === 'string' && name.toLowerCase().indexOf(q) >= 0;
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
  return (await projects.listProjects()).map((p) => ({ id: p.id, name: p.name }));
}

async function search(projectId: string, query: string): Promise<SearchHit[]> {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  let project = { id: '', name: '' };

  // Grouped in the order the sidebar lists the sections, so the results read in
  // the same order as the app they point into.
  const push = (kind: SearchHit['kind'], id: unknown, name: unknown, sub: string): void => {
    if (hits.length >= MAX_RESULTS) return;
    hits.push({
      kind,
      id: String(id),
      name: String(name),
      sub,
      type: TYPE_LABEL[kind],
      projectId: project.id,
      projectName: project.name,
      snippet: sub,
    });
  };

  for (project of await scope(projectId)) {
    if (hits.length >= MAX_RESULTS) break;
    // '#sales' searches TAGS across every record kind (src/app/catalogIndex.ts).
    if (q.charAt(0) === '#') {
      for (const h of await tagSearch(project.id, q)) {
        if (hits.length < MAX_RESULTS) hits.push({ ...h, projectId: project.id, projectName: project.name, snippet: h.sub });
      }
    } else await searchOne(project.id, q, push);
  }
  await attachTags(hits);
  return hits;
}

type Push = (kind: SearchHit['kind'], id: unknown, name: unknown, sub: string) => void;

async function searchOne(projectId: string, q: string, push: Push): Promise<void> {
  try {
    for (const d of await datasets.listDatasets(projectId)) {
      if (matches(d.name, q)) push('dataset', d.id, d.name, `${Number(d.rowCount || 0).toLocaleString()} rows`);
    }
  } catch (_) { /* one unreadable list must not empty the others */ }

  try {
    for (const v of await visuals.listVisuals(projectId)) {
      if (matches(v.name, q)) push('visual', v.id, v.name, String((v as any).chartType || 'visual'));
    }
  } catch (_) { /* ignore */ }

  try {
    for (const a of await analysis.listAnalyses(projectId)) {
      const sheets = Array.isArray((a as any).sheets) ? (a as any).sheets.length : (a as any).sheetCount;
      if (matches(a.name, q)) push('analysis', a.id, a.name, sheets ? `${sheets} sheet${sheets === 1 ? '' : 's'}` : 'dashboard');
    }
  } catch (_) { /* ignore */ }

  try {
    for (const c of await connections.listConnections(projectId)) {
      if (matches(c.name, q)) push('connection', c.id, c.name, String((c as any).kind || 'connection'));
    }
  } catch (_) { /* ignore */ }
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
