// The folder rule for the board (docs/issues-board/00-design.md, "Privacy"): what an issue, or one example question, may show a caller.
// It is #5's inbox rule (`levelsOf`: a dataset or dashboard in a folder closed to the caller) with one step more: an id that no longer EXISTS
// is closed too, whenever a folder restricts the caller. A deleted dataset leaves no placement, and `levelsOf` reads an unplaced id as the
// project's own folder (open), so a deleted dataset that sat in a closed folder would otherwise open. An admin, or a project with no folder
// besides Everyone, is not restricted (`levelsOf` answers null with no query) and sees every issue.

import { listDatasets } from '../../data/datasets';
import { listAnalyses } from '../../analysis/analysis';
import * as gate from '../authz/folderGate';

export interface Placed { datasetIds: string[]; dashboardIds: string[] }

/** `rows` without any that touches a dataset or dashboard the caller cannot open, or that is gone. One lookup per kind, however many rows. */
export async function openTo<T extends Placed>(projectId: string, rows: readonly T[]): Promise<T[]> {
  if (!rows.length) return [];
  const ds = await gate.levelsOf(projectId, 'dataset');
  if (!ds) return [...rows];
  const bd = rows.some((r) => r.dashboardIds.length) ? await gate.levelsOf(projectId, 'dashboard') : null;
  const datasets = rows.some((r) => r.datasetIds.length) ? new Set((await listDatasets(projectId)).map((d) => d.id.toLowerCase())) : new Set<string>();
  const boards = bd ? new Set((await listAnalyses(projectId)).map((a) => a.id.toLowerCase())) : new Set<string>();
  const dsOpen = (id: string): boolean => datasets.has(id.toLowerCase()) && ds(id) !== 'none';
  const bdOpen = (id: string): boolean => (bd ? boards.has(id.toLowerCase()) && bd(id) !== 'none' : false);
  // Dashboard folders restrict exactly when dataset folders do (the same access), so `bd` is null only when no row names a dashboard.
  return rows.filter((r) => r.datasetIds.every(dsOpen) && r.dashboardIds.every(bdOpen));
}
