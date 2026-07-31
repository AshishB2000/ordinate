import { ipcMain } from 'electron';
import * as connections from '../connections';
import * as connectionRun from '../connectionRun';
import * as datasets from '../datasets';
import * as config from '../config';
import type { ConnectionKind } from '../connections';
import type { PgConnConfig } from '../connectionRun';

// Connected-data-source IPC — Postgres + read-only URL/API JSON. All handlers are
// ipcMain.handle (request/response) and are wrapped so any throw becomes
// { ok:false, error } — the renderer never sees an unhandled rejection, and an
// error string is sanitized so it NEVER carries a secret.
//
// SECURITY: the pg password / URL token arrive from the renderer form ONLY in the
// `secret` payload of connection:testAndSave, go straight into
// config.setConnectionSecret (plaintext in the gitignored config.json), and are
// read back solely here, in MAIN, via config.getConnectionSecret. They are never
// written into a project's connections/*.json and never returned to a renderer.
// No deps object (pure disk + pg + fetch), matching datasets.register().

// Build the pg connection config (non-secret) from a stored/incoming connection.
function pgConfigOf(c: { host?: string; port?: number; database?: string; user?: string; ssl?: boolean }): PgConnConfig {
  return {
    host: typeof c.host === 'string' ? c.host : 'localhost',
    port: typeof c.port === 'number' && Number.isFinite(c.port) ? c.port : 5432,
    database: typeof c.database === 'string' ? c.database : '',
    user: typeof c.user === 'string' ? c.user : '',
    ssl: Boolean(c.ssl),
  };
}

// Coerce a form value to a port number (forms send strings). Falls back to 5432.
function toPort(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 5432;
}

// Re-run a saved connection (used by connection:run and connection:refresh).
// Loads the secret in MAIN, dispatches to the right runner. Returns the runner's
// discriminated result. `tableOrQuery` overrides the saved table/query for pg.
async function runSaved(
  projectId: string,
  connId: string,
  tableOrQuery?: { table?: string; query?: string },
): Promise<{ ok: true; result: import('../parse').ParseResult } | { ok: false; error: string }> {
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: 'Connection not found' };
  const secret = config.getConnectionSecret(connId);

  if (conn.kind === 'postgres') {
    const which = tableOrQuery && (tableOrQuery.table || tableOrQuery.query)
      ? { table: tableOrQuery.table, query: tableOrQuery.query }
      : { table: conn.table, query: conn.query };
    return connectionRun.pgRun(pgConfigOf(conn), secret.password || '', which);
  }
  // url
  return connectionRun.urlRun(conn.url || '', secret.token || undefined);
}

export function register(): void {
  // List a project's connections (renderer-safe view — no secrets ever present).
  ipcMain.handle('connections:list', async (_e, { projectId }: any = {}) => {
    try {
      const list = await connections.listConnections(projectId);
      return list.map(connections.publicConnection);
    } catch (_) {
      return [];
    }
  });

  // Test a connection with the INCOMING secret; save (metadata + secret) only on
  // success. On failure nothing is persisted. Returns the public connection.
  ipcMain.handle('connection:testAndSave', async (_e, { projectId, kind, config: cfg, secret }: any = {}) => {
    try {
      const k: ConnectionKind = kind === 'postgres' ? 'postgres' : kind === 'url' ? 'url' : ('' as ConnectionKind);
      if (k !== 'postgres' && k !== 'url') return { ok: false, error: 'Unknown connection kind' };
      const form = cfg && typeof cfg === 'object' ? cfg : {};
      const sec = secret && typeof secret === 'object' ? secret : {};

      // Build the non-secret metadata + test with the incoming secret.
      let input: connections.ConnectionInput;
      if (k === 'postgres') {
        const pgCfg: PgConnConfig = {
          host: typeof form.host === 'string' && form.host.trim() ? form.host.trim() : 'localhost',
          port: toPort(form.port),
          database: typeof form.database === 'string' ? form.database.trim() : '',
          user: typeof form.user === 'string' ? form.user.trim() : '',
          ssl: Boolean(form.ssl),
        };
        const test = await connectionRun.pgListTables(pgCfg, typeof sec.password === 'string' ? sec.password : '');
        if (!test.ok) return { ok: false, error: test.error };
        input = {
          name: typeof form.name === 'string' && form.name.trim() ? form.name.trim() : (pgCfg.database || pgCfg.host),
          kind: 'postgres',
          host: pgCfg.host,
          port: pgCfg.port,
          database: pgCfg.database,
          user: pgCfg.user,
          ssl: pgCfg.ssl,
          table: typeof form.table === 'string' && form.table.trim() ? form.table.trim() : undefined,
          query: typeof form.query === 'string' && form.query.trim() ? form.query.trim() : undefined,
          lastStatus: 'ok',
        };
      } else {
        const url = typeof form.url === 'string' ? form.url.trim() : '';
        const token = typeof sec.token === 'string' ? sec.token : undefined;
        const test = await connectionRun.urlRun(url, token);
        if (!test.ok) return { ok: false, error: test.error };
        input = {
          name: typeof form.name === 'string' && form.name.trim() ? form.name.trim() : url,
          kind: 'url',
          url,
          lastStatus: 'ok',
        };
      }

      const saved = await connections.saveConnection(projectId, input);
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };

      // Persist the secret separately (plaintext config.json), keyed by connId.
      if (k === 'postgres' && typeof sec.password === 'string' && sec.password) {
        config.setConnectionSecret(saved.id, { password: sec.password });
      } else if (k === 'url' && typeof sec.token === 'string' && sec.token) {
        config.setConnectionSecret(saved.id, { token: sec.token });
      }

      return { ok: true, connection: connections.publicConnection(saved), status: 'ok' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not test or save the connection' };
    }
  });

  // Postgres only: list tables for a saved connection (loads its secret in MAIN).
  ipcMain.handle('connection:listTables', async (_e, { projectId, connId }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      if (conn.kind !== 'postgres') return { ok: false, error: 'Not a Postgres connection' };
      const secret = config.getConnectionSecret(connId);
      const res = await connectionRun.pgListTables(pgConfigOf(conn), secret.password || '');
      return res.ok ? { ok: true, tables: res.tables } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not list tables' };
    }
  });

  // Run a connection and return a ParseResult PREVIEW (no save). For pg the
  // renderer may pass a table/query to override the saved one.
  ipcMain.handle('connection:run', async (_e, { projectId, connId, tableOrQuery }: any = {}) => {
    try {
      const res = await runSaved(projectId, connId, tableOrQuery && typeof tableOrQuery === 'object' ? tableOrQuery : undefined);
      return res.ok ? { ok: true, preview: res.result } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not run the connection' };
    }
  });

  // Re-run a connection and overwrite its linked dataset's data. Updates the
  // connection's lastRefreshedAt/lastStatus either way.
  ipcMain.handle('connection:refresh', async (_e, { projectId, connId, datasetId }: any = {}) => {
    try {
      const res = await runSaved(projectId, connId);
      if (!res.ok) {
        await connections.updateConnection(projectId, connId, { lastStatus: 'error', lastError: res.error });
        return { ok: false, error: res.error };
      }
      const ds = await datasets.updateDatasetData(projectId, datasetId, {
        columns: res.result.columns,
        rows: res.result.rows,
      });
      if (!ds) {
        await connections.updateConnection(projectId, connId, { lastStatus: 'error', lastError: 'Linked dataset not found' });
        return { ok: false, error: 'Linked dataset not found' };
      }
      await connections.updateConnection(projectId, connId, {
        lastStatus: 'ok',
        lastError: null,
        lastRefreshedAt: new Date().toISOString(),
        linkedDatasetId: ds.id,
      });
      return { ok: true, dataset: ds };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not refresh the connection' };
    }
  });

  // Delete a connection (also drops its secret from config.json).
  ipcMain.handle('connection:delete', async (_e, { projectId, connId }: any = {}) => {
    try {
      const ok = await connections.deleteConnection(projectId, connId);
      config.deleteConnectionSecret(connId);
      return { ok };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not delete the connection' };
    }
  });
}
