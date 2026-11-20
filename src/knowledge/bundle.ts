// Knowledge documents in a project export, a backup and their import (docs/knowledge-docs/00-design.md, "Lifecycle").
// MAIN PROCESS. Agents travel in a bundle (src/app/bundleRules.ts), so the documents attached to them travel too, as
// `knowledge/<id>.json` (title, kind, file name, text, who and when, and the agent's id). A restore is an import into a
// new project, so without this a delete followed by a restore would lose them for good.
//
// Export: every document of the project whose agent travels with it (a trashed agent's does not: the Trash is not
// exported). Import: written through the store, so its caps and row-level security apply; the id swap the import already
// did on the bytes has remapped the document's own id and its agent's id together, so an agent's document lands on that
// agent's new id. A document gets a NEW id (nothing refers to one, and an old id may already be in use here). Without a database there are no documents: nothing is exported, and entries are skipped on import.

import { randomUUID } from 'crypto';
import { logger } from '../app/logger';
import { isValidId } from '../app/ids';
import { MAX_TITLE } from './limits';
import { allDocs, createDoc, knowledgeOn } from './store';
import type { DocSource } from './parseTypes';

const SOURCES: ReadonlySet<string> = new Set(['typed', 'markdown', 'text', 'pdf', 'docx']);

/** The bundle entries for the project's documents. `agentIds`: the agents that travel (lower case). */
export async function exportEntries(projectId: string, agentIds: ReadonlySet<string>): Promise<Array<{ name: string; data: Buffer }>> {
  if (!knowledgeOn()) return [];
  return (await allDocs(projectId))
    .filter((d) => d.agentId === null || agentIds.has(d.agentId.toLowerCase()))
    .map((d) => ({
      name: `knowledge/${d.id.toLowerCase()}.json`,
      data: Buffer.from(JSON.stringify({ id: d.id.toLowerCase(), agentId: d.agentId?.toLowerCase() ?? null, title: d.title, source: d.source, fileName: d.fileName, text: d.text, createdBy: d.createdBy, createdAt: d.createdAt, updatedBy: d.updatedBy, updatedAt: d.updatedAt }), 'utf8'),
    }));
}

/**
 * One entry's document, into the new project. `agentIds`: the agents the new project has. A document of an agent the bundle
 * does not carry, an unreadable one, or any one without a database is skipped (false); a cap the store refuses THROWS its sentence.
 */
export async function importEntry(projectId: string, body: Buffer, agentIds: ReadonlySet<string>): Promise<boolean> {
  if (!knowledgeOn()) return false;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    logger.warn('[knowledge] a document in the bundle is not readable: skipped');
    return false;
  }
  const agentId = typeof d.agentId === 'string' ? d.agentId.toLowerCase() : null;
  if (!isValidId(d.id) || typeof d.title !== 'string' || typeof d.text !== 'string' || (agentId !== null && !agentIds.has(agentId))) return false;
  const source = typeof d.source === 'string' && SOURCES.has(d.source) ? (d.source as DocSource) : 'typed';
  const title = Array.from(d.title.replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE).join('') || 'Untitled';
  const by = (typeof d.updatedBy === 'string' ? d.updatedBy : typeof d.createdBy === 'string' ? d.createdBy : '').slice(0, 200);
  await createDoc(projectId, agentId, { title, text: d.text, source, fileName: typeof d.fileName === 'string' ? d.fileName.slice(0, 255) : null }, randomUUID(), by || 'import');
  return true;
}
