// Shared folders' channels (docs/team-folders/00-design.md) — MAIN PROCESS. `folder:of` (D12): a store answers a closed
// item exactly as a missing one; a page people bookmark (a dataset, a dashboard, a story, a report) asks this when it
// found nothing, so it can say "This is in a folder you can't open" instead of "not found". It names nothing: no
// folder, team or item. The rest (E7) are the tree and its changes (src/server/authz/folderTree.ts) and moves
// (src/server/authz/folderMove.ts); the route has checked the caller's project role, the modules check the folder.

import { ipcMain } from './bus';
import { isValidId } from '../app/ids';
import { getDatasetMeta } from '../data/datasets';
import { getStoredAnalysis } from '../analysis/analysis';
import { getStory } from '../analysis/stories';
import { getReport } from '../analysis/reportSpec';
import { opens } from '../server/authz/folderGate';
import { folderRefusal, wholeProject, type PlacedKind } from '../server/authz/folders';
import { createFolder, deleteFolder, folderAccess, folderTree, grantFolder, renameFolder, setShareFigures } from '../server/authz/folderTree';
import { impactOf, moveItems } from '../server/authz/folderMove';

export type BookmarkKind = 'dataset' | 'dashboard' | 'story' | 'report';
const KINDS: readonly BookmarkKind[] = ['dataset', 'dashboard', 'story', 'report'];

/** The record as the caller's store reads it (null: closed, or missing) — a story and a report follow what they read (D3). */
const readFor = (projectId: string, kind: BookmarkKind, id: string): Promise<unknown> =>
  kind === 'dataset' ? getDatasetMeta(projectId, id) : kind === 'dashboard' ? getStoredAnalysis(projectId, id) : kind === 'story' ? getStory(projectId, id) : getReport(projectId, id);

/** `{ok:false, code:'folder', reason:'closed'}` when `id` exists in a folder the caller cannot open; `{ok:true}` otherwise. */
export async function folderOf(projectId: string, kind: BookmarkKind, id: string): Promise<{ ok: true } | ReturnType<typeof folderRefusal>> {
  if (!isValidId(projectId) || !isValidId(id) || !KINDS.includes(kind)) return { ok: true };
  const placed = kind === 'dataset' || kind === 'dashboard';
  if (placed ? await opens(projectId, kind, id) : (await readFor(projectId, kind, id)) !== null) return { ok: true };
  // The live record over every folder: the one read here that may see a closed item, and it answers only whether it is there.
  const there = await wholeProject(async () => (await readFor(projectId, kind, id)) !== null);
  return there ? folderRefusal('closed') : { ok: true };
}

type Move = { projectId: string; items: Array<{ kind: PlacedKind; id: string }>; to: string; from?: string };

export function register(): void {
  ipcMain.handle('folder:of', async (_e, { projectId, kind, id }: { projectId?: unknown; kind?: unknown; id?: unknown } = {}) =>
    folderOf(String(projectId ?? ''), KINDS.includes(kind as BookmarkKind) ? (kind as BookmarkKind) : 'dataset', String(id ?? '')));
  // The contracts (src/api/folders.ts) have parsed each payload.
  ipcMain.handle('folder:tree', (_e, { projectId }: { projectId: string }) => folderTree(projectId));
  ipcMain.handle('folder:create', (_e, { projectId, parentId, name }: { projectId: string; parentId: string | null; name: string }) => createFolder(projectId, parentId, name));
  ipcMain.handle('folder:rename', (_e, { projectId, folderId, name }: { projectId: string; folderId: string; name: string }) => renameFolder(projectId, folderId, name));
  ipcMain.handle('folder:delete', (_e, { projectId, folderId }: { projectId: string; folderId: string }) => deleteFolder(projectId, folderId));
  ipcMain.handle('folder:setShareFigures', (_e, { projectId, folderId, on }: { projectId: string; folderId: string; on: boolean }) => setShareFigures(projectId, folderId, on));
  ipcMain.handle('folder:access', (_e, { projectId }: { projectId: string }) => folderAccess(projectId));
  ipcMain.handle('folder:grant', (_e, { projectId, folderId, teamId, level }: { projectId: string; folderId: string; teamId: string; level: 'view' | 'edit' | null }) =>
    grantFolder(projectId, folderId, teamId, level));
  ipcMain.handle('folder:moveImpact', async (_e, { projectId, ...move }: Move) => {
    const r = await impactOf(projectId, move);
    return r.ok ? r.impact : r; // the people behind it stay on the server
  });
  ipcMain.handle('folder:move', (_e, { projectId, hash, ...move }: Move & { hash: string }) => moveItems(projectId, { ...move, hash }));
}
