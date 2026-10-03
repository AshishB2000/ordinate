import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import * as connectionRun from '../connectors/connectionRun';
import * as datasets from '../data/datasets';
import * as configSecrets from '../app/configSecrets';
import { connectorCatalog, getConnector } from '../connectors';
import type { ConnectorDef, ConnectorField } from '../connectors/types';

// Connected-data-source IPC. Every source is a ConnectorDef in src/connectors, so
// these handlers are source-agnostic: they resolve a connectorId, shape the form
// payload into the connector's declared fields, and hand off to
// connectionRun's dispatch. Adding a data source touches none of this. All
// handlers are ipcMain.handle (request/response) and are wrapped so any throw
// becomes { ok:false, error } — the renderer never sees an unhandled rejection.
//
// SECURITY: a secret arrives from the renderer form ONLY in the `secret` payload
// of connection:testAndSave, goes straight into configSecrets.setConnectionSecret
// (plaintext in the gitignored config.json), and is read back solely here, in
// MAIN, via configSecrets.getConnectionSecret. Secrets are never written into a
// project's connections/*.json, never returned to a renderer, and every error
// string leaving a runner has been through safeError(). connectors:catalog
// returns form SHAPE only — the `secret` flag on a field travels, a value never
// does. No deps object (pure disk + drivers + fetch), matching datasets.register().
//
// KNOWN LIMIT (config.ts, not ours to change): config.ConnectionSecret has
// exactly two slots, `password` and `token`. A connector with more than one
// non-password secret field can therefore only persist the first of them. The
// mapping is explicit in secretSlot() so the day a connector needs a third
// credential, the failure is a one-line fix in config.ts rather than a mystery.

// ── Form payload → connector fields ──────────────────────────────────────────

function fieldsOf(def: ConnectorDef): ConnectorField[] {
  return Array.isArray(def.fields) ? def.fields : [];
}

// Coerce one form value to the field's declared type. Forms send strings for
// everything, including numbers and checkboxes.
function coerce(field: ConnectorField, raw: unknown): string | number | boolean | null {
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(n)) return n;
    return typeof field.default === 'number' ? field.default : null;
  }
  if (field.type === 'checkbox') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return raw === 'true' || raw === 'on' || raw === '1';
    return field.default === true;
  }
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof field.default === 'string' || typeof field.default === 'number' || typeof field.default === 'boolean') {
    return field.default;
  }
  return null;
}

// Build the NON-SECRET values bag from a form payload, one declared field at a
// time. Undeclared keys are dropped — a connection record holds the connector's
// fields and nothing a renderer felt like sending.
function buildValues(def: ConnectorDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(def)) {
    if (f.secret === true) continue; // secrets never enter `values`
    const v = coerce(f, raw[f.key]);
    if (v !== null && v !== '') out[f.key] = v;
    else if (typeof f.default !== 'undefined' && raw[f.key] === undefined) out[f.key] = f.default;
  }
  return out;
}

// Which of config.json's two secret slots this field key uses. 'password' is its
// own slot; everything else (token, apiKey, serviceAccount, …) shares `token`.
function secretSlot(key: string): 'password' | 'token' {
  return key === 'password' ? 'password' : 'token';
}

// Pull the secret values out of a form payload, keyed by field key. Also accepts
// the two legacy key names the pre-registry renderer sends ({password}/{token})
// when the connector declares a differently-named single secret field.
function buildSecrets(def: ConnectorDef, raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const secretFields = fieldsOf(def).filter((f) => f.secret === true);
  for (const f of secretFields) {
    const direct = raw[f.key];
    if (typeof direct === 'string' && direct) { out[f.key] = direct; continue; }
    const legacy = raw[secretSlot(f.key)];
    if (typeof legacy === 'string' && legacy) out[f.key] = legacy;
  }
  return out;
}

// Persist a connection's secrets into config.json's two slots.
function storeSecrets(connId: string, secrets: Record<string, string>): void {
  const payload: { password?: string; token?: string } = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    const slot = secretSlot(key);
    if (payload[slot] === undefined) payload[slot] = value; // first writer wins — see KNOWN LIMIT
  }
  if (payload.password || payload.token) configSecrets.setConnectionSecret(connId, payload);
}

// Read a connection's secrets back, re-keyed by the connector's field keys — the
// shape ConnectorContext.secrets promises. MAIN ONLY; never returned anywhere.
function loadSecrets(connId: string, def: ConnectorDef | null): Record<string, string> {
  const stored = configSecrets.getConnectionSecret(connId);
  const out: Record<string, string> = {};
  const password = typeof stored.password === 'string' ? stored.password : '';
  const token = typeof stored.token === 'string' ? stored.token : '';
  const secretFields = def ? fieldsOf(def).filter((f) => f.secret === true) : [];
  for (const f of secretFields) {
    const v = secretSlot(f.key) === 'password' ? password : token;
    if (v) out[f.key] = v;
  }
  // Always expose the two legacy names too: a connector written against the old
  // vocabulary reads ctx.secrets.password / .token directly.
  if (password) out.password = password;
  if (token) out.token = token;
  return out;
}

// Accept both payload vocabularies: the registry one ({connectorId, values}) and
// the pre-registry one ({kind, config}). The renderer is migrated separately.
function readConnectorId(payload: Record<string, unknown>): string {
  const direct = payload.connectorId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const legacy = payload.kind;
  return typeof legacy === 'string' ? legacy.trim() : '';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// Re-run a saved connection (used by connection:run and connection:refresh).
// Loads the secret in MAIN and dispatches through the registry. `tableOrQuery`
// overrides the saved table/query.
async function runSaved(
  projectId: string,
  connId: string,
  tableOrQuery?: { table?: string; query?: string },
  bounds?: { rowLimit?: number },
): Promise<{ ok: true; result: import('../data/parse').ParseResult } | { ok: false; error: string }> {
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: 'Connection not found' };
  const def = getConnector(conn.connectorId);
  const secrets = loadSecrets(connId, def);
  const which = tableOrQuery && (tableOrQuery.table || tableOrQuery.query)
    ? { table: str(tableOrQuery.table), query: str(tableOrQuery.query) }
    : { table: conn.table, query: conn.query };
  const res = await connectionRun.runConnection(conn.connectorId, conn.values, secrets, which, bounds);
  return res.ok ? { ok: true, result: res.result } : res;
}

/**
 * Run a statement on a saved connection and return the cells UNTYPED — for an
 * incremental refresh (src/data/incrementalRefresh.ts), which types a batch to
 * the stored table. The secret is resolved here, in main, as for runSaved.
 */
export async function runSavedText(
  projectId: string,
  connId: string,
  selection: { table?: string; query?: string },
): ReturnType<typeof connectionRun.runConnectionText> {
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: 'Connection not found' };
  const secrets = loadSecrets(connId, getConnector(conn.connectorId));
  return connectionRun.runConnectionText(conn.connectorId, conn.values, secrets, selection);
}

/**
 * WHAT a dataset's refresh should re-run.
 *
 * The dataset's own origin wins, because one connection now feeds many
 * datasets: `origin.sql` is the statement that actually produced these rows, so
 * it is what re-produces them — even after the saved query it came from was
 * renamed, edited or deleted. `origin.table` is the same promise for a table
 * import. Only a dataset saved BEFORE the workbench (origin = connId alone)
 * falls through to the connection's own single saved selection, which is
 * exactly what it has always refreshed to.
 */
export function selectionForDataset(origin: unknown): { table?: string; query?: string } | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  const o = origin as Record<string, unknown>;
  if (o.kind !== 'connection') return undefined;
  if (typeof o.sql === 'string' && o.sql.trim()) return { query: o.sql };
  if (typeof o.table === 'string' && o.table.trim()) return { table: o.table };
  return undefined;
}

/**
 * Re-run a saved connection into its linked dataset, updating the CONNECTION's
 * lastStatus / lastError / lastRefreshedAt either way.
 *
 * Exported because the dataset refresh service needs exactly this and must not
 * re-implement it: the secret is resolved here, in main, and a second copy would
 * be a second place for that to go wrong. `connection:refresh` is now a thin
 * wrapper over it, so the two cannot drift.
 *
 * `outWarnings` collects the pipeline warnings from re-deriving the dataset.
 */
export async function refreshConnectionInto(
  projectId: string,
  connId: string,
  datasetId: string,
  outWarnings?: string[],
): Promise<{ ok: true; dataset: import('../data/datasets').Dataset } | { ok: false; error: string }> {
  try {
    // Read the dataset's own origin FIRST — metadata only, no table hydrate —
    // so the refresh re-runs what built THIS dataset rather than whatever the
    // connection last happened to have selected.
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    const res = await runSaved(projectId, connId, selectionForDataset(meta?.origin));
    if (!res.ok) {
      await connections.updateConnection(projectId, connId, { lastStatus: 'error', lastError: res.error });
      return { ok: false, error: res.error };
    }
    const ds = await datasets.updateDatasetData(
      projectId,
      datasetId,
      { columns: res.result.columns, rows: res.result.rows },
      undefined,
      outWarnings,
    );
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
}

export function register(): void {
  // The renderer-safe connector catalog: identity + form shape for every
  // registered source. No functions, no values, nothing secret. Returns a BARE
  // ARRAY — a picker with no connectors and a picker that failed to load look
  // the same to a renderer, and it has a fallback for both.
  ipcMain.handle('connectors:catalog', async () => {
    try {
      return connectorCatalog();
    } catch (err: unknown) {
      console.error('[connections] connectors:catalog failed:', err instanceof Error ? err.message : err);
      return [];
    }
  });

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
  ipcMain.handle('connection:testAndSave', async (_e, payload: any = {}) => {
    try {
      const p = asRecord(payload);
      const projectId = str(p.projectId);
      const connectorId = readConnectorId(p);
      const def = getConnector(connectorId);
      if (!def) return { ok: false, error: 'Unknown connection kind' };

      // `values` (registry payload) or `config` (legacy payload) carry the form.
      const form = { ...asRecord(p.config), ...asRecord(p.values) };
      const rawSecret = { ...asRecord(p.secret), ...asRecord(p.secrets) };

      const values = buildValues(def, form);
      const secrets = buildSecrets(def, rawSecret);
      const table = str(p.table) || str(form.table);
      const query = str(p.query) || str(form.query);

      const test = await connectionRun.testConnection(connectorId, values, secrets, { table, query });
      if (!test.ok) return { ok: false, error: test.error };

      const fallbackName = str(values.database) || str(values.host) || str(values.url) || def.label;
      const saved = await connections.saveConnection(projectId, {
        name: str(p.name) || str(form.name) || fallbackName,
        connectorId,
        values,
        table: table || undefined,
        query: query || undefined,
        lastStatus: 'ok',
      });
      if (!saved) return { ok: false, error: 'Invalid project, or the project no longer exists' };

      // Persist the secrets separately (plaintext config.json), keyed by connId.
      storeSecrets(saved.id, secrets);

      return {
        ok: true,
        connection: connections.publicConnection(saved),
        status: 'ok',
        tables: test.tables,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not test or save the connection' };
    }
  });

  // List a saved connection's tables (secret loaded in MAIN). A source with no
  // table picker returns an empty list rather than an error.
  ipcMain.handle('connection:listTables', async (_e, { projectId, connId }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      const def = getConnector(conn.connectorId);
      const secrets = loadSecrets(connId, def);
      const res = await connectionRun.listTables(conn.connectorId, conn.values, secrets);
      return res.ok ? { ok: true, tables: res.tables } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not list tables' };
    }
  });

  // Run a connection and return a ParseResult PREVIEW (no save). The renderer may
  // pass a table/query to override the saved one.
  ipcMain.handle('connection:run', async (_e, { projectId, connId, tableOrQuery, limit }: any = {}) => {
    try {
      const want = Number(limit);
      const res = await runSaved(
        projectId,
        connId,
        tableOrQuery && typeof tableOrQuery === 'object' ? tableOrQuery : undefined,
        Number.isFinite(want) && want > 0 ? { rowLimit: want } : undefined,
      );
      return res.ok ? { ok: true, preview: res.result } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not run the connection' };
    }
  });

  // Re-run a connection and overwrite its linked dataset's data. Updates the
  // connection's lastRefreshedAt/lastStatus either way.
  ipcMain.handle('connection:refresh', async (_e, { projectId, connId, datasetId }: any = {}) => {
    const res = await refreshConnectionInto(projectId, connId, datasetId);
    return res.ok ? { ok: true, dataset: res.dataset } : res;
  });

  // One table's columns, out of the source's own catalog. `schema: null` means
  // this connector has no catalog to browse (HTTP engines, the URL source) —
  // the workbench hides its schema browser rather than showing an empty tree.
  // That is a legitimate answer, NOT an error, and the two must stay distinct.
  ipcMain.handle('connection:describe', async (_e, { projectId, connId, table }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      const def = getConnector(conn.connectorId);
      const secrets = loadSecrets(connId, def);
      const res = await connectionRun.describeTable(conn.connectorId, conn.values, secrets, str(table));
      if (res === null) return { ok: true, schema: null };
      if (!res.ok) return { ok: false, error: res.error };
      const schema: { columns: unknown[]; rowEstimate?: number } = { columns: res.columns };
      if (typeof res.rowEstimate === 'number') schema.rowEstimate = res.rowEstimate;
      return { ok: true, schema };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not describe that table' };
    }
  });

  // A bounded peek at one table. `limit` may only LOWER the bound — buildContext
  // clamps it, so a renderer cannot ask for more than the app's own row cap.
  ipcMain.handle('connection:sample', async (_e, { projectId, connId, table, limit }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      const def = getConnector(conn.connectorId);
      const secrets = loadSecrets(connId, def);
      const want = Number(limit);
      const res = await connectionRun.sampleTable(
        conn.connectorId, conn.values, secrets, str(table),
        Number.isFinite(want) && want > 0 ? want : connectionRun.SAMPLE_ROWS,
      );
      return res.ok ? { ok: true, preview: res.result } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not sample that table' };
    }
  });

  // Validate a statement and report the columns it WOULD return, without
  // fetching a result. The error, when there is one, is the dialect's own.
  ipcMain.handle('connection:explain', async (_e, { projectId, connId, sql }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn) return { ok: false, error: 'Connection not found' };
      const def = getConnector(conn.connectorId);
      const secrets = loadSecrets(connId, def);
      const res = await connectionRun.explainSql(conn.connectorId, conn.values, secrets, str(sql));
      return res.ok ? { ok: true, columns: res.columns } : { ok: false, error: res.error };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not check that query' };
    }
  });

  // Create, edit or rename a saved query on a connection. Returns the whole
  // list so the renderer never has to merge one in by hand.
  ipcMain.handle('connection:saveQuery', async (_e, { projectId, connId, id, name, sql }: any = {}) => {
    try {
      const queries = await connections.saveQuery(projectId, connId, {
        id: str(id) || undefined,
        name: str(name),
        sql: typeof sql === 'string' ? sql : '',
      });
      return queries ? { ok: true, queries } : { ok: false, error: 'Could not save that query' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save that query' };
    }
  });

  // Remove a saved query. A dataset built from it keeps refreshing — its origin
  // carries the SQL, not just the id.
  ipcMain.handle('connection:deleteQuery', async (_e, { projectId, connId, queryId }: any = {}) => {
    try {
      const queries = await connections.deleteQuery(projectId, connId, str(queryId));
      return queries ? { ok: true, queries } : { ok: false, error: 'Connection not found' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not delete that query' };
    }
  });

  // Delete a connection (also drops its secret from config.json).
  ipcMain.handle('connection:delete', async (_e, { projectId, connId }: any = {}) => {
    try {
      const ok = await connections.deleteConnection(projectId, connId);
      configSecrets.deleteConnectionSecret(connId);
      return { ok };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not delete the connection' };
    }
  });
}
