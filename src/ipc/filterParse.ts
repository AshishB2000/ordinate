// Typed filters over IPC — `filterParse:parse`. MAIN PROCESS.
//
// The renderer sends what was typed into a dashboard's filter bar (or ⌘K's
// `@`, or the dock's "filter this to …"); main answers with the parse:
// highlighted spans, chips and grouped suggestions. The parser itself is pure
// (src/analysis/filterParse.ts); what only main has is the CATALOG — the
// dashboard's datasets' text columns with their distinct values, resident
// first — and the clock and calendar every date phrase resolves against. No
// model is asked and nothing leaves the machine.
//
// The catalog is cached per dashboard for a few seconds: one is built per
// keystroke burst, not per keystroke, and a dataset refreshed meanwhile is
// seen on the next burst.

import { ipcMain } from './bus';

import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import * as datasets from '../data/datasets';
import { catalogResident, catalogJs, mergeCatalogs } from '../analysis/filterCatalog';
import { parseFilterText } from '../analysis/filterParse';
import type { FilterCatalog } from '../analysis/filterParse';
import { getCalendar, todayIso } from '../analysis/dateIntel';
import { orgKey } from '../server/context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_MS = 5000;
const MAX_TEXT = 500;

const cache = new Map<string, { at: number; catalog: Promise<FilterCatalog | null> }>();

/** The datasets the dashboard's cards read, in card order — the dimension order. */
export async function dashboardDatasetIds(projectId: string, dashboardId: string): Promise<string[] | null> {
  const a = await analysis.getAnalysis(projectId, dashboardId);
  if (!a) return null;
  const ids: string[] = [];
  const add = (id: unknown): void => { if (typeof id === 'string' && UUID_RE.test(id) && !ids.includes(id)) ids.push(id); };
  for (const page of a.sheets || []) {
    for (const card of page.cards || []) {
      if (card.type === 'metric' && card.metric) {
        if (card.metric.metricId) add((await metrics.getMetric(projectId, card.metric.metricId))?.datasetId);
        add(card.metric.datasetId);
      } else if (card.type === 'visual') {
        if (card.visual) add(card.visual.datasetId);
        else if (card.visualId) add((await visuals.getVisual(projectId, card.visualId))?.datasetId);
      } else if (card.type === 'control' && card.control) {
        add(card.control.datasetId);
      }
    }
  }
  return ids;
}

async function buildCatalog(projectId: string, dashboardId: string): Promise<FilterCatalog | null> {
  const ids = await dashboardDatasetIds(projectId, dashboardId);
  if (!ids) return null;
  const parts: FilterCatalog[] = [];
  for (const id of ids) {
    const src = await datasets.residentSource(projectId, id).catch(() => null);
    const fast = src ? await catalogResident(src, id) : null;
    if (fast) { parts.push(fast); continue; }
    const ds = await datasets.getDataset(projectId, id);
    if (ds) parts.push(catalogJs(ds.columns, ds.rows, id));
  }
  return mergeCatalogs(parts);
}

export function dashboardCatalog(projectId: string, dashboardId: string): Promise<FilterCatalog | null> {
  const key = orgKey(projectId + '/' + dashboardId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.catalog;
  const catalog = buildCatalog(projectId, dashboardId).catch(() => null);
  cache.set(key, { at: Date.now(), catalog });
  return catalog;
}

/** Placeholder-grade examples built from the dashboard's OWN data, for the empty popover. */
function examples(cat: FilterCatalog): string[] {
  const out: string[] = [];
  const first = cat.dimensions.filter((d) => d.values.length > 0 && d.values.length <= 12);
  if (first[0]) out.push(first.slice(0, 2).map((d) => d.values[0]).join(' ').toLowerCase());
  if (cat.dates.length) out.push('last quarter');
  // The measure with the largest values, compared with a round number near half its max.
  const m = cat.measures.filter((x) => typeof x.max === 'number' && x.max > 1).sort((a, b) => (b.max as number) - (a.max as number))[0];
  if (m) {
    const half = (m.max as number) / 2;
    const unit = 10 ** Math.floor(Math.log10(half));
    out.push(`${m.column.replace(/_/g, ' ')} > ${(Math.round(half / unit) * unit).toLocaleString('en-US')}`);
  }
  if (first[0]) out.push('not ' + first[0].values[first[0].values.length > 1 ? 1 : 0].toLowerCase());
  return out;
}

function sanitizePick(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
    if (typeof v === 'string' && k.length <= MAX_TEXT && v.length <= 2000) out[k] = v;
  }
  return out;
}

export function register(): void {
  ipcMain.handle('filterParse:parse', async (_e, { projectId, dashboardId, text, pick }: Record<string, unknown> = {}) => {
    try {
      const pid = String(projectId || '');
      const did = String(dashboardId || '');
      if (!UUID_RE.test(pid) || !UUID_RE.test(did)) return { ok: false, error: 'Dashboard not found' };
      const catalog = await dashboardCatalog(pid, did);
      if (!catalog) return { ok: false, error: 'Dashboard not found' };
      const parsed = parseFilterText(String(text ?? '').slice(0, MAX_TEXT), catalog, {
        today: todayIso(), calendar: getCalendar(), pick: sanitizePick(pick),
      });
      return {
        ok: true,
        ...parsed,
        columns: {
          dimensions: catalog.dimensions.map((d) => d.column),
          dates: catalog.dates.slice(),
          measures: catalog.measures.map((m) => m.column),
        },
        examples: examples(catalog),
      };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || 'Could not read that filter.' };
    }
  });
}
