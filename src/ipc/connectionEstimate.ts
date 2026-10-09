// `connection:estimate` — price a statement before it runs. Split out of
// ./connections.ts at its size budget; registered from its register().
//
// The source's free dry run (BigQuery's totalBytesProcessed, `live.estimate`)
// comes back as bytes plus the editor's "~1.2 GB" label, formatted server side
// by connectionRun.estimateSql. `estimate: null` is the honest answer for a
// source that cannot estimate — not an error; the catalog's `estimates` flag
// lets the web editor skip the call for those. The secret is resolved here, in
// main, as for every other connection:* handler, and never leaves it.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import * as connectionRun from '../connectors/connectionRun';
import { getConnector } from '../connectors';
import { loadSecrets } from './connectionSecrets';

export function registerEstimate(): void {
  ipcMain.handle('connection:estimate', async (_e, payload: unknown = {}) => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const projectId = typeof p.projectId === 'string' ? p.projectId : '';
    const connId = typeof p.connId === 'string' ? p.connId : '';
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      const secrets = await loadSecrets(connId, getConnector(conn.connectorId));
      const res = await connectionRun.estimateSql(conn.connectorId, conn.values, secrets, typeof p.sql === 'string' ? p.sql : '');
      if (res === null) return { ok: true, estimate: null };
      return res.ok ? { ok: true, estimate: { bytes: res.bytes, label: res.label } } : { ok: false, error: res.error };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error && err.message ? err.message : 'Could not estimate that query' };
    }
  });
}
