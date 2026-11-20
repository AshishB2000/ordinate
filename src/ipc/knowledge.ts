// Knowledge documents IPC (docs/knowledge-docs/00-design.md): list, get, save, upload, delete. The contracts
// (src/api/knowledge.ts) let any project reader call the two readers and an editor the writers; WHOSE documents a caller
// may reach is decided here (rules 2 and 3): a project's are every reader's, an agent's are those of everyone who may use
// that agent (src/ai/agentAccess.ts `agentForAsk`, the one place that decides), and a trashed agent's are neither used
// nor listed. Editor prose, never a dataset row (row policy META). Document text is never logged.

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ipcMain } from './bus';
import { agentForAsk, EDITOR_RANK } from '../ai/agentAccess';
import { rankOn } from '../server/authz/caller';
import { FileTokenError, resolveUpload } from '../server/files';
import { osUser } from '../app/catalog';
import { logger } from '../app/logger';
import { MAX_DOCS_PER_PROJECT, MAX_FILE_BYTES, MAX_TITLE } from '../knowledge/limits';
import { KnowledgeReadError, readDocument } from '../knowledge/readDocument';
import { countDocs, createDoc, deleteDoc, getDoc, KnowledgeRefusal, knowledgeOn, listDocs, updateDoc } from '../knowledge/store';
import * as msg from '../knowledge/knowledgeMessages';

const NO_DB = { ok: false as const, needsDatabase: true as const, error: msg.needsDatabase() };
const gone = (): { ok: false; error: string } => ({ ok: false, error: msg.docGone() });

/** May the caller reach documents of `agentId` (null: the project's, which the contract already allows)? */
async function mayReach(projectId: string, agentId: string | null): Promise<boolean> {
  return agentId === null || (await agentForAsk(projectId, agentId)).agent !== null;
}

/** Cut at a code point, never inside a surrogate pair. */
const clipTitle = (s: string): string => Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE).join('');
const titleOfFile = (name: string): string => clipTitle(name.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_]+/g, ' '));

function failed(what: string, err: unknown): { ok: false; error: string } {
  if (err instanceof KnowledgeRefusal || err instanceof KnowledgeReadError) return { ok: false, error: err.message };
  logger.error(`[knowledge] ${what} failed:`, (err as { code?: string })?.code ?? 'error'); // never the message: it could quote a document
  return { ok: false, error: msg.docNotSaved() };
}

export function register(): void {
  ipcMain.handle('knowledge:list', async (_e, { projectId, agentId }: { projectId: string; agentId?: string }) => {
    if (!knowledgeOn()) return NO_DB;
    try {
      if (!(await mayReach(projectId, agentId ?? null))) return { ok: false, error: msg.agentGone() };
      const [docs, total, projectDocs, rank] = await Promise.all([listDocs(projectId, agentId ?? null), countDocs(projectId), agentId ? listDocs(projectId, null).then((d) => d.length) : Promise.resolve(null), rankOn(projectId)]);
      return { ok: true, docs, total, max: MAX_DOCS_PER_PROJECT, projectDocs, canEdit: rank >= EDITOR_RANK };
    } catch (err) {
      logger.error('[knowledge] list failed:', (err as { code?: string })?.code ?? 'error');
      return { ok: false, error: msg.docsNotRead() };
    }
  });

  ipcMain.handle('knowledge:get', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    if (!knowledgeOn()) return NO_DB;
    try {
      const doc = await getDoc(projectId, id);
      return doc && (await mayReach(projectId, doc.agentId)) ? { ok: true, doc } : gone();
    } catch (err) {
      logger.error('[knowledge] get failed:', (err as { code?: string })?.code ?? 'error');
      return { ok: false, error: msg.docsNotRead() };
    }
  });

  ipcMain.handle('knowledge:save', async (_e, { projectId, agentId, id, base, title, text }: { projectId: string; agentId?: string; id?: string; base?: string; title: string; text: string }) => {
    if (!knowledgeOn()) return NO_DB;
    try {
      if (id) {
        const cur = await getDoc(projectId, id);
        if (!cur || !(await mayReach(projectId, cur.agentId))) return gone();
        // A stale base throws ERECORDCHANGED out of updateDoc, uncaught here: the route answers it 409 record_changed.
        const doc = await updateDoc(projectId, id, { title, text }, base, osUser());
        return doc ? { ok: true, doc } : gone();
      }
      if (!(await mayReach(projectId, agentId ?? null))) return { ok: false, error: msg.agentGone() };
      return { ok: true, doc: await createDoc(projectId, agentId ?? null, { title, text }, randomUUID(), osUser()) };
    } catch (err) {
      if ((err as { code?: string })?.code === 'ERECORDCHANGED') throw err;
      return failed('save', err);
    }
  });

  ipcMain.handle('knowledge:upload', async (_e, { projectId, agentId, fileToken, title }: { projectId: string; agentId?: string; fileToken: string; title?: string }) => {
    if (!knowledgeOn()) return NO_DB;
    if (!(await mayReach(projectId, agentId ?? null))) return { ok: false, error: msg.agentGone() }; // before the single-use token is spent
    let upload: Awaited<ReturnType<typeof resolveUpload>> | null = null;
    try {
      upload = await resolveUpload(fileToken);
      if ((await fs.promises.stat(upload.path)).size > MAX_FILE_BYTES) return { ok: false, error: msg.fileTooBig() };
      const read = await readDocument(await fs.promises.readFile(upload.path), upload.name);
      const name = upload.name.slice(0, 255);
      const doc = await createDoc(projectId, agentId ?? null, { title: title && clipTitle(title) ? clipTitle(title) : titleOfFile(name) || 'Untitled document', text: read.text, source: read.source, fileName: name }, randomUUID(), osUser());
      return { ok: true, doc };
    } catch (err) {
      if (err instanceof FileTokenError) return { ok: false, error: msg.uploadExpired() };
      return failed('upload', err);
    } finally {
      upload?.done(); // the staged bytes: the original file is not kept
    }
  });

  ipcMain.handle('knowledge:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    if (!knowledgeOn()) return NO_DB;
    try {
      const cur = await getDoc(projectId, id);
      if (!cur || !(await mayReach(projectId, cur.agentId))) return gone();
      return (await deleteDoc(projectId, id)) ? { ok: true } : gone();
    } catch (err) {
      return failed('delete', err);
    }
  });
}
