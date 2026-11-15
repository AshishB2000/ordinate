// Shared folders' reader channel (docs/team-folders/00-design.md D12) — MAIN PROCESS. A store answers a closed item
// exactly as a missing one; a page people bookmark (a dataset, a dashboard, a story, a report) asks this when it found
// nothing, so it can say "This is in a folder you can't open" instead of "not found". It names nothing: no folder, team
// or item.

import { ipcMain } from './bus';
import { isValidId } from '../app/ids';
import { getDatasetMeta } from '../data/datasets';
import { getStoredAnalysis } from '../analysis/analysis';
import { getStory } from '../analysis/stories';
import { getReport } from '../analysis/reportSpec';
import { opens } from '../server/authz/folderGate';
import { folderRefusal, wholeProject } from '../server/authz/folders';

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

export function register(): void {
  ipcMain.handle('folder:of', async (_e, { projectId, kind, id }: { projectId?: unknown; kind?: unknown; id?: unknown } = {}) =>
    folderOf(String(projectId ?? ''), KINDS.includes(kind as BookmarkKind) ? (kind as BookmarkKind) : 'dataset', String(id ?? '')));
}
