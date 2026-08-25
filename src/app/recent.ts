// Cross-project "Recent" list — MAIN PROCESS ONLY.
//
// Phase 2 of the home-page rebuild. Flattens the datasets and analyses (the
// Dashboards surface) of EVERY project into one time-ordered list, newest-updated
// first, so the home page can show "pick up where you left off" without the
// user having to open a project first.
//
// This is a pure METADATA read: it never hydrates a dataset table, never
// touches a Parquet file, and never computes a figure. Each lister already
// returns a lightweight summary (id/name/updatedAt + a few counts); this module
// only projects those into a uniform shape and sorts.
//
// Import style mirrors src/analysis.ts — NodeNext CommonJS, strict main world.
import * as projects from './projects';
import * as datasets from '../data/datasets';
import * as analysis from '../analysis/analysis';

export type RecentType = 'dataset' | 'analysis';

/**
 * What the record IS, in numbers — carried so a Home row can say more than a
 * name and a timestamp ("1,240 rows x 5 columns" rather than just "Regional
 * sales 2026").
 *
 * STILL FREE. Every field here is already present on the summary its lister
 * returns: rowCount/columnCount on DatasetSummary, sheetCount on
 * AnalysisSummary. This module reads
 * no additional file, opens no record and computes no figure — the promise at
 * the top of this file is unchanged.
 *
 * All optional: an older record, or a lister that stops carrying a count, must
 * degrade to a row with no meta line rather than to a row printing "undefined".
 */
export interface RecentMeta {
  rowCount?: number;
  columnCount?: number;
  sheetCount?: number;
}

export interface RecentItem {
  type: RecentType;
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  updatedAt: string;
  meta?: RecentMeta;
}

export interface RecentGroup {
  projectId: string;
  projectName: string;
  datasets: { id: string; name: string; updatedAt: string; meta?: RecentMeta }[];
  analyses: { id: string; name: string; updatedAt: string; meta?: RecentMeta }[];
}

/**
 * Flatten every group's datasets and analyses into one RecentItem[],
 * newest-updatedAt first, capped to `limit`.
 *
 * PURE — no disk, no async. The sort compares updatedAt so a later timestamp
 * sorts first; ISO-8601 strings compare lexicographically, but this does not
 * assume any particular format, only that a larger string is "later". Equal
 * timestamps preserve input order (stable), so a project's own datasets →
 * analyses ordering, and the project scan order, stay predictable.
 *
 * The `limit` cap is what keeps this a cheap, bounded, metadata-only response
 * even as the number of projects grows.
 */
export function buildRecent(groups: RecentGroup[], limit: number): RecentItem[] {
  const items: RecentItem[] = [];
  for (const g of groups) {
    for (const d of g.datasets) {
      items.push({
        type: 'dataset',
        id: d.id,
        projectId: g.projectId,
        projectName: g.projectName,
        name: d.name,
        updatedAt: d.updatedAt,
        meta: d.meta,
      });
    }
    for (const a of g.analyses) {
      items.push({
        type: 'analysis',
        id: a.id,
        projectId: g.projectId,
        projectName: g.projectName,
        name: a.name,
        updatedAt: a.updatedAt,
        meta: a.meta,
      });
    }
  }

  // Stable descending sort: carry the original index so equal timestamps keep
  // input order (Array.prototype.sort is spec-stable, but the index tie-break
  // makes the intent explicit and independent of that guarantee).
  const cap = limit > 0 ? limit : 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      if (x.item.updatedAt > y.item.updatedAt) return -1;
      if (x.item.updatedAt < y.item.updatedAt) return 1;
      return x.index - y.index;
    })
    .slice(0, cap)
    .map((entry) => entry.item);
}

/**
 * Assemble the cross-project recent list off disk.
 *
 * One failing project or type resolves to [] rather than throwing — a corrupt
 * project must not sink the whole list. The three per-project listers run in
 * parallel (Promise.all), which is cheap because each is a metadata-only read.
 *
 * The default cap is 50: the response is metadata-only JSON, so it is cheap,
 * but it is still bounded so the home page never has to reason about an
 * unbounded list.
 */
export async function listRecent(limit = 50): Promise<RecentItem[]> {
  let projectList: projects.Project[];
  try {
    projectList = await projects.listProjects();
  } catch {
    return [];
  }

  const groups: RecentGroup[] = await Promise.all(
    projectList.map(async (p): Promise<RecentGroup> => {
      const [ds, an] = await Promise.all([
        datasets.listDatasets(p.id).catch(() => []),
        analysis.listAnalyses(p.id).catch(() => []),
      ]);
      return {
        projectId: p.id,
        projectName: p.name,
        datasets: ds.map((d) => ({
          id: d.id,
          name: d.name,
          updatedAt: d.updatedAt,
          meta: { rowCount: d.rowCount, columnCount: d.columnCount },
        })),
        analyses: an.map((a) => ({
          id: a.id,
          name: a.name,
          updatedAt: a.updatedAt,
          meta: { sheetCount: a.sheetCount },
        })),
      };
    }),
  );

  return buildRecent(groups, limit);
}
