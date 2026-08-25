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

/** Enough to be useful, few enough to read without scrolling. */
const MAX_RESULTS = 20;

export interface SearchHit {
  kind: 'dataset' | 'visual' | 'analysis' | 'connection';
  id: string;
  name: string;
  /** A dim second line: rows, chart type, sheet count — whatever the list already knows. */
  sub: string;
}

function matches(name: unknown, q: string): boolean {
  return typeof name === 'string' && name.toLowerCase().indexOf(q) >= 0;
}

async function search(projectId: string, query: string): Promise<SearchHit[]> {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];

  // Grouped in the order the sidebar lists the sections, so the results read in
  // the same order as the app they point into.
  const push = (kind: SearchHit['kind'], id: unknown, name: unknown, sub: string): void => {
    if (hits.length >= MAX_RESULTS) return;
    hits.push({ kind, id: String(id), name: String(name), sub });
  };

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
