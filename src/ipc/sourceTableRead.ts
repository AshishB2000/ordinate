// `sourceTable:read` (docs/semantic-layer/02-source-tables.md, D6, D15): an editor's click reads one
// table's facts from the warehouse and stores them on its doc, with who and when. `readFacts` is the
// only caller of the facts door (src/connectors/tableFactsRun.ts): the click, a Live dataset's daily
// schema sync and the `sourceTable:facts` job (./sourceFactsRefresh, docs/assistant/00-design.md "Table
// facts"); no view or refresh reads facts. At most READS_PER_HOUR per connection across pods, all callers together,
// taken before the door (a refusal charges nothing; a read that fails still counts). The order is
// the doc, the connection, the count, the secrets, the door, the write. The write is
// `updateSourceDoc`, which cannot move a typed field or the edit tag, so an open editor never sees a
// 409 for a read; a read that fails writes nothing, so the facts stored before stay.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { readTableFacts } from '../connectors/tableFactsRun';
import { osUser } from '../app/catalog';
import { connectionGone, factsNotReadable, factsReadLimit, sourceDocGone } from '../app/sourceTableMessages';
import { docView } from '../app/sourceTableList';
import * as store from '../app/sourceTables';
import { ctx } from '../server/context';
import * as counters from '../server/counters';
import { loadSecrets } from './connectionSecrets';

export const READS_PER_HOUR = 60;
const HOUR_MS = 3_600_000;

/** Read one doc's table facts from the warehouse and store them, stamped with who and when. */
export async function readFacts(projectId: string, connId: string, docId: string): Promise<{ ok: true; doc: store.SourceTableDoc } | { ok: false; error: string; retryAfterSec?: number }> {
  const found = await store.readSourceDoc(projectId, connId, docId);
  if (!found) return { ok: false, error: sourceDocGone() };
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: connectionGone() };
  const taken = await counters.take(ctx().org.id, [{ key: `sourceRead:${connId}`, limit: READS_PER_HOUR, windowMs: HOUR_MS }]);
  if (!taken.ok) return { ok: false, error: factsReadLimit(Math.ceil(taken.retryAfterSec / 60)), retryAfterSec: taken.retryAfterSec };
  const secrets = await loadSecrets(connId, getConnector(conn.connectorId));
  const res = await readTableFacts(conn.connectorId, conn.values, secrets, found.rec.table);
  if (res === null) return { ok: false, error: factsNotReadable() };
  if (!res.ok) return { ok: false, error: res.error };
  const stamp = { readAt: new Date().toISOString(), readBy: osUser() };
  const doc = await store.updateSourceDoc(projectId, connId, docId, (d) => ({ ...d, facts: { ...res.facts, ...stamp } }));
  return doc ? { ok: true, doc } : { ok: false, error: sourceDocGone() };
}

export function register(): void {
  ipcMain.handle('sourceTable:read', async (_e, { projectId, connId, docId }: { projectId: string; connId: string; docId: string }) => {
    const r = await readFacts(projectId, connId, docId);
    return r.ok ? { ok: true, doc: docView(docId, r.doc) } : r;
  });
}
