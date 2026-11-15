// Shared folders' reader channel (docs/team-folders/00-design.md D12) — MAIN PROCESS. A store answers a closed item
// exactly as a missing one; a page people bookmark (a dataset, a dashboard) asks this when it found nothing, so it
// can say "This is in a folder you can't open" instead of "not found". It names nothing: no folder, team or item.

import { ipcMain } from './bus';
import { isValidId } from '../app/ids';
import { getDatasetMeta } from '../data/datasets';
import { getStoredAnalysis } from '../analysis/analysis';
import { opens } from '../server/authz/folderGate';
import { folderRefusal, wholeProject } from '../server/authz/folders';

/** `{ok:false, code:'folder', reason:'closed'}` when `id` exists in a folder the caller cannot open; `{ok:true}` otherwise. */
export async function folderOf(projectId: string, kind: 'dataset' | 'dashboard', id: string): Promise<{ ok: true } | ReturnType<typeof folderRefusal>> {
  if (!isValidId(projectId) || !isValidId(id) || (kind !== 'dataset' && kind !== 'dashboard') || (await opens(projectId, kind, id))) return { ok: true };
  // The live record over every folder: the one read here that may see a closed item, and it answers only whether it is there.
  const there = await wholeProject(async () => (kind === 'dataset' ? await getDatasetMeta(projectId, id) : await getStoredAnalysis(projectId, id)) !== null);
  return there ? folderRefusal('closed') : { ok: true };
}

export function register(): void {
  ipcMain.handle('folder:of', async (_e, { projectId, kind, id }: { projectId?: unknown; kind?: unknown; id?: unknown } = {}) =>
    folderOf(String(projectId ?? ''), kind === 'dashboard' ? 'dashboard' : 'dataset', String(id ?? '')));
}
