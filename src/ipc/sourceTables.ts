// Source table docs over RPC (docs/semantic-layer/02-source-tables.md, D14). Four `write` channels, so a
// viewer never reaches a handler. Records only: no connector call, no dataset hydrated, no secret read.
// Replies are built key by key (`dismissed` never leaves). A refusal the caller can act on is
// `{ ok: false, error }`; a stale save throws ERECORDCHANGED for the route's 409, and anything else
// reaches the route too, which logs it and answers without the message (it can hold a path).

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import { connectionGone, sourceDocGone } from '../app/sourceTableMessages';
import { connectionHead, sourceList, usedTables } from '../app/sourceTableList';
import * as store from '../app/sourceTables';

interface Ids { projectId: string; connId: string; docId: string }
interface SavePayload { projectId: string; connId: string; docId?: string; table?: string; patch: store.SourcePatch; base?: string }

export function register(): void {
  ipcMain.handle('sourceTable:list', async (_e, { projectId }: { projectId: string }) => ({ ok: true, ...(await sourceList(projectId)) }));

  ipcMain.handle('sourceTable:get', async (_e, { projectId, connId, docId }: Ids) => {
    const conn = await connections.getConnection(projectId, connId);
    if (!conn) return { ok: false, error: connectionGone() };
    const found = await store.readSourceDoc(projectId, connId, docId);
    if (!found) return { ok: false, error: sourceDocGone() };
    const { rec } = found;
    const built = (await usedTables(projectId, [conn])).get(connId)?.get(rec.table) ?? [];
    return {
      ok: true,
      doc: { docId, table: rec.table, owner: rec.owner, refresh: rec.refresh, requiredFilters: rec.requiredFilters, guide: rec.guide, ...(rec.facts ? { facts: rec.facts } : {}), updatedBy: rec.updatedBy, updatedAt: rec.updatedAt },
      tag: found.tag,
      connection: connectionHead(conn),
      datasets: built.map((d) => ({ id: d.id, name: d.name })),
    };
  });

  ipcMain.handle('sourceTable:save', async (_e, p: SavePayload) => {
    if (!(await connections.getConnection(p.projectId, p.connId))) return { ok: false, error: connectionGone() };
    if (p.docId === undefined) {
      const made = await store.createSourceDoc(p.projectId, p.connId, p.table ?? '', p.patch);
      if (!made.ok) return made;
      const doc = await store.readSourceDoc(p.projectId, p.connId, made.docId);
      return doc ? { ok: true, docId: made.docId, created: made.created, tag: doc.tag } : { ok: false, error: sourceDocGone() };
    }
    const saved = await store.saveSourceDoc(p.projectId, p.connId, p.docId, p.patch, p.base);
    return saved ? { ok: true, docId: p.docId, tag: saved.tag } : { ok: false, error: sourceDocGone() };
  });

  ipcMain.handle('sourceTable:delete', async (_e, { projectId, connId, docId }: Ids) => {
    if (!(await connections.getConnection(projectId, connId))) return { ok: false, error: connectionGone() };
    return (await store.deleteSourceDoc(projectId, connId, docId)) ? { ok: true } : { ok: false, error: sourceDocGone() };
  });
}
