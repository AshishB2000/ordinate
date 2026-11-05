// `model:navigation` (semantic layer part 6, step 01): every dataset's hierarchies, the levels that no longer resolve
// marked `missing`, and the calendar's date ladder, in one read. METADATA ONLY: the catalog file, the dataset list and
// each dataset's declared columns; never a row, never a warehouse. Level names are column names, never values, so the
// reply is the same for every caller (row policy META).

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { loadStrict } from '../app/catalog';
import { activeWeekCal } from '../analysis/retailCalendar';
import { dateLadder, navHierarchies } from '../analysis/drillLevels';
import type { NavHierarchy } from '../analysis/drillLevels';
import type { DateGrain } from '../analysis/categoryKey';

export type NavigationReply = { ok: true; tables: { datasetId: string; hierarchies: NavHierarchy[] }[]; dateLadder: DateGrain[] } | { ok: false; error: string };

export async function modelNavigation(projectId: string): Promise<{ tables: { datasetId: string; hierarchies: NavHierarchy[] }[]; dateLadder: DateGrain[] }> {
  const [list, file] = await Promise.all([datasets.listDatasets(projectId), loadStrict(projectId)]);
  const found = await Promise.all(list.map(async (d) => {
    const stored = file.tables?.[d.id]?.hierarchies;
    if (!stored?.length) return null;
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    return meta ? { datasetId: d.id, hierarchies: navHierarchies(stored, meta.columns) } : null;
  }));
  return { tables: found.filter((t) => t !== null), dateLadder: dateLadder(activeWeekCal() !== null) };
}

/** What `answerChips` needs to offer the next level: metadata only (one catalog read, one dataset meta), `[]` on any failure. */
export async function navContext(projectId: string, datasetId: string): Promise<{ hierarchies: NavHierarchy[]; ladder: DateGrain[] }> {
  const ladder = dateLadder(activeWeekCal() !== null);
  try {
    const [file, meta] = await Promise.all([loadStrict(projectId), datasets.getDatasetMeta(projectId, datasetId)]);
    const stored = file.tables?.[datasetId]?.hierarchies;
    return { hierarchies: meta && stored?.length ? navHierarchies(stored, meta.columns) : [], ladder };
  } catch {
    return { hierarchies: [], ladder };
  }
}

export function register(): void {
  ipcMain.handle('model:navigation', async (_e, { projectId }: { projectId?: unknown } = {}): Promise<NavigationReply> => {
    try {
      return { ok: true, ...(await modelNavigation(typeof projectId === 'string' ? projectId : '')) };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'The data model could not be read.' };
    }
  });
}
