// What a dashboard's PUBLISHED copy reads (docs/team-folders/00-design.md D9, D16) — MAIN PROCESS. Frozen at Publish
// as `published.reads`, it is what reach is: a dataset a caller cannot open still answers the figure doors for a
// dashboard they open whose copy reads it (src/server/dashboardReads.ts, 0035).
//
// A narrowing of src/server/subscriptions/figureDatasets `datasetsOfRoot`: every id under a `…datasetId(s)` key of the
// copy (its visual cards are frozen inline), the datasets of every metric a card names (a formula's operands, a
// period's base, a tree's parts, followed to depth 16) and each chart's and KPI's join plan reads (what the doors gate,
// ipc/relationships chartReads / metricReads). No lineage climb (a refresh reads parents as the system) and no
// relationship walk beyond the plan. A security walk: it reads every folder (D14).
// The same metric walk scopes a saved metric's figure to the datasets it reads (`inMetricReach`, metric:value).

import type { PublishedCopy } from './publishedCopy';
import type { Card } from './dashboards';
import * as metrics from './metrics';
import { namesSaid } from './metricNames';
import * as visuals from './visuals';
import type { FilterStep } from '../data/transforms';
import { isValidId } from '../app/ids';
import { collectIds, type Found } from '../server/subscriptions/figureDatasets';
import { folderAccessOn, isFolderError, wholeProject } from '../server/authz/folders';
import { folderGate, type FigureScope } from '../server/authz/folderGate';
import { chartReads, metricReads } from '../ipc/relationships';

const MAX_LEVELS = 16;
const lower = (id: string): string => id.toLowerCase();

/** The datasets of `ids`' metrics and of every metric they name, to depth 16; each simple metric's join plan reads too. */
async function metricDatasets(projectId: string, ids: Iterable<string>, filters: FilterStep[], out: Set<string>): Promise<void> {
  const seen = new Set<string>();
  let byName: Map<string, metrics.Metric> | null = null;
  let level = [...ids];
  for (let depth = 0; level.length && depth <= MAX_LEVELS; depth++) {
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(lower(id))) continue;
      seen.add(lower(id));
      const m = await metrics.getMetric(projectId, id);
      if (!m) continue;
      out.add(lower(m.datasetId));
      const found: Found = { all: new Set(), datasets: out, visuals: new Set(), metrics: new Set() };
      collectIds({ tree: m.tree, target: m.target, filters: m.filters }, found); // a tree's parts, a target's metric, a term's table
      next.push(...(found.metrics ?? []));
      if (metrics.isPeriodDefinition(m.definition)) next.push(m.definition.base);
      const said = namesSaid(m.definition);
      if (said.length) byName ??= await metrics.metricsByName(projectId);
      for (const n of said) {
        const named = byName?.get(n);
        if (named) next.push(named.id);
      }
      if (metrics.isSimpleDefinition(m.definition)) for (const r of await metricReads(projectId, m.datasetId, m.definition.column, [...m.filters, ...filters])) out.add(lower(r));
    }
    level = next;
  }
}

/** The chart a visual card draws: its frozen definition, else (a copy made from a Ready dashboard) the chart as stored. */
async function chartOf(projectId: string, c: Card): Promise<Pick<visuals.Visual, 'datasetId' | 'encoding' | 'filters'> | null> {
  if (c.type !== 'visual') return null;
  if (c.visual) return c.visual;
  return c.visualId ? visuals.getVisual(projectId, c.visualId) : null;
}

/** Every dataset `copy` reads, sorted, lowercase. */
export function publishedReads(projectId: string, copy: Pick<PublishedCopy, 'sheets' | 'filters'>): Promise<string[]> {
  return wholeProject(async () => {
    const found: Found = { all: new Set(), datasets: new Set(), visuals: new Set(), metrics: new Set() };
    collectIds({ sheets: copy.sheets, filters: copy.filters }, found);
    const out = found.datasets;
    for (const card of copy.sheets.flatMap((s) => s.cards)) {
      const v = await chartOf(projectId, card);
      if (v && isValidId(v.datasetId)) {
        if (!card.visual) collectIds(v, found);
        for (const r of await chartReads(projectId, v.datasetId, v.encoding, [...(v.filters ?? []), ...copy.filters])) out.add(lower(r));
      }
      const k = card.type === 'metric' ? card.metric : undefined;
      if (k && isValidId(k.datasetId) && k.column) for (const r of await metricReads(projectId, k.datasetId, k.column, copy.filters)) out.add(lower(r));
    }
    await metricDatasets(projectId, found.metrics ?? [], copy.filters, out);
    return [...out].filter(isValidId).sort();
  });
}

/** What a stored dashboard record's published copy reads, worked out from its definition (dashboard_reads' rebuild). */
export async function bodyReads(projectId: string, body: string): Promise<string[]> {
  const { analysisOf } = require('./analysis') as typeof import('./analysis'); // lazy: it imports this module
  const a = analysisOf(projectId, JSON.parse(body), true);
  return a ? publishedReads(projectId, a) : [];
}

/**
 * `fn` (a saved metric's figure, `metric:value`) in the figure scope of metric `id`'s datasets — its own and those of
 * the metrics it names — when the caller reaches them (D9), so a dashboard's KPI on a reached dataset resolves; as it
 * is otherwise (a metric the caller opens on a simple definition reads nothing more; a closed one stays missing).
 */
export async function inMetricReach<T>(projectId: string, id: string, fn: () => Promise<T>): Promise<T> {
  if (!isValidId(projectId) || !isValidId(id)) return fn();
  const access = await folderAccessOn(projectId); // asked already in this request by the metric store
  if (access.all || access.noFolders) return fn();
  const own = await metrics.getMetric(projectId, id);
  if (own && metrics.isSimpleDefinition(own.definition) && !own.target) return fn();
  const all = new Set<string>();
  const m = await wholeProject(async () => {
    const found = own ?? (await metrics.getMetric(projectId, id));
    if (found) await metricDatasets(projectId, [found.id], [], all);
    return found;
  });
  if (!m) return fn();
  let run: FigureScope;
  try {
    run = await folderGate(projectId, m.datasetId, async () => [...all]);
  } catch (err) {
    if (isFolderError(err)) return fn(); // not reached: as it was, a metric the caller cannot see
    throw err;
  }
  return run(fn);
}
