// Topics IPC (semantic layer part 6, D14–D16) — get, save (create or update), delete a Topic (../analysis/topics).
// A topic is ids and names, never a value, so every project reader gets the same reply (row policy META). The list
// rides `model:navigation` (./modelNavigation.ts), with its gone members dropped; `topic:get` is the editor's.

import { ipcMain } from './bus';
import * as topics from '../analysis/topics';
import * as trash from '../app/trash';
import { contentTag } from '../app/editConflict';
import { topicNotFound } from '../analysis/topicMessages';

type SaveInput = { projectId: string; id?: string; base?: string; topic: topics.TopicInput };

export function register(): void {
  ipcMain.handle('topic:get', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const t = await topics.readTopic(projectId, id);
    if (!t) return { ok: false, error: topicNotFound() };
    const { stale } = await topics.topicForReaders(projectId, t.rec);
    return { ok: true, topic: t.rec, tag: t.tag, stale }; // as stored: the drawer removes what is stale, and says so
  });

  // `base`: the drawer's tag — a stale one is 409 record_changed (../app/editConflict); `tag` is the next base.
  ipcMain.handle('topic:save', async (_e, { projectId, id, base, topic }: SaveInput) => {
    const problem = await topics.topicProblem(projectId, topic, id);
    if (problem) return { ok: false, ...problem };
    // A stale base throws ERECORDCHANGED out of updateTopic, uncaught: the route answers it 409.
    const t = id ? await topics.updateTopic(projectId, id, topic, base) : await topics.saveTopic(projectId, topic);
    if (!t) return { ok: false, error: topicNotFound() };
    return { ok: true, topic: t, tag: contentTag('topic', t) };
  });

  ipcMain.handle('topic:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const done = await trash.trashRecord(projectId, 'topic', id); // to the Trash
    return done.ok ? { ok: true } : { ok: false, error: topicNotFound() };
  });
}
