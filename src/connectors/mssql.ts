// Microsoft SQL Server family connectors — MAIN PROCESS ONLY.
//
// Three sources, one wire protocol (TDS) and one implementation:
//   • sqlserver      — on-prem / self-hosted SQL Server, port 1433
//   • azure-sql      — Azure SQL Database, port 1433, TLS forced ON
//   • azure-synapse  — Azure Synapse Analytics (dedicated SQL pool), TLS forced ON
//
// Driver: `tedious` — pure JS, no native build, no ODBC/FreeTDS install. It is
// callback + EventEmitter based, so every driver interaction here is wrapped in
// a promise that settles EXACTLY ONCE (a Connection can fail via the connect
// callback AND via an 'error' event, and a Request can fail via its completion
// callback while the connection is already dead), with the connection closed in
// a `finally` on every path.
//
// READ-ONLY. `assertReadOnly` is a guard, not a SQL parser: it rejects anything
// whose top level is not SELECT/WITH, anything containing a top-level DML/DDL
// keyword (including SELECT ... INTO, which creates a table), and any statement
// batch. The real guarantee is still a read-only database login — this stops the
// obvious mistake, it does not make a write-capable account safe.

import type { Connection as TdsConnection, ConnectionConfiguration } from 'tedious';
import type {
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTables,
} from './types';
import { safeError } from './types';

// Loaded lazily so requiring the connector registry does not pull the driver
// (and its socket/TLS machinery) into every app start.
function loadTedious(): typeof import('tedious') {
  return require('tedious') as typeof import('tedious');
}

// The 'row' event's element shape. tedious does not export ColumnValue as a
// type, so the slice we read is declared here rather than reached for with any.
interface TdsColumnValue {
  metadata: { colName: string; type?: { name?: string } };
  value: unknown;
}
interface TdsColumnMetadata {
  colName: string;
  type?: { name?: string };
}

// ── field value helpers ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(1|true|yes|on)$/i.test(v.trim())) return true;
    if (/^(0|false|no|off)$/i.test(v.trim())) return false;
  }
  return fallback;
}

// A TDS cell → the contract's scalar. tedious hands back JS natives already
// (string/number/boolean/Date/Buffer/null); the caller re-detects types from
// these, so a Date must be an unambiguous ISO string, not a locale string.
function cellToValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as string | number | boolean;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return v.toString('hex');
  try {
    const j = JSON.stringify(v);
    return j === undefined ? String(v) : j;
  } catch (_) {
    return String(v);
  }
}

// ── top-level SQL scan ────────────────────────────────────────────────────────
//
// Not a parser — a lexer that skips what must be skipped ('...' strings, "..."
// and [...] identifiers, -- and /* */ comments, T-SQL's NESTED block comments)
// and reports the bare words that sit at paren depth 0. That is enough to answer
// the only three questions the row cap needs: does this query already carry its
// own ORDER BY / paging, is it a CTE, and is it more than one statement.

interface TopScan {
  words: string[];
  /** A ';' at depth 0 with non-whitespace after it — i.e. a statement batch. */
  batched: boolean;
}

function scanTopLevel(sql: string): TopScan {
  const words: string[] = [];
  let depth = 0;
  let batched = false;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // '' / "" doubling is the escape in T-SQL; a doubled quote just re-opens.
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '[') {
      // Bracketed identifier; ]] is the escape.
      i++;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // T-SQL block comments nest, unlike most dialects.
      let cdepth = 1;
      i += 2;
      while (i < n && cdepth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { cdepth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { cdepth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { if (depth > 0) depth--; i++; continue; }
    if (c === ';') {
      if (depth === 0 && sql.slice(i + 1).trim().length > 0) batched = true;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$#@]/.test(sql[j])) j++;
      if (depth === 0) words.push(sql.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    i++;
  }
  return { words, batched };
}

// Top-level keywords that mean this is not a read. `INTO` is here because
// `SELECT … INTO t2 FROM t1` creates and populates a table.
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'CREATE', 'ALTER', 'DROP',
  'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'BACKUP',
  'RESTORE', 'SHUTDOWN', 'RECONFIGURE', 'BULK', 'OPENROWSET', 'WAITFOR',
]);

function assertReadOnly(scan: TopScan): string | null {
  const first = scan.words[0];
  if (first !== 'SELECT' && first !== 'WITH') {
    return 'Only SELECT queries are allowed (this connection is read-only)';
  }
  if (scan.batched) {
    return 'Only a single statement is allowed';
  }
  for (const w of scan.words) {
    if (WRITE_WORDS.has(w)) {
      return `Only SELECT queries are allowed (found "${w}")`;
    }
  }
  return null;
}

// ── the row cap ───────────────────────────────────────────────────────────────
//
// T-SQL has no LIMIT, and the obvious wrapper — SELECT TOP (n) * FROM ( … ) AS t
// — is NOT universally applicable. Two cases break it, both common:
//
//   1. A user's own ORDER BY. SQL Server error 1033: "The ORDER BY clause is
//      invalid in views, inline functions, derived tables, subqueries, and
//      common table expressions, unless TOP, OFFSET or FOR XML is also
//      specified." So `SELECT TOP (n) * FROM (SELECT … ORDER BY x) AS t` is a
//      hard syntax error, not a slow query.
//   2. A CTE. `WITH` may not appear inside a derived table at all.
//
// So: wrap only when it is legal, and otherwise APPEND `OFFSET 0 ROWS FETCH NEXT
// n ROWS ONLY` to the user's own statement (SQL Server 2012+), supplying
// `ORDER BY (SELECT NULL)` when there is no ORDER BY to attach it to. Honest
// limitations of the append path:
//   • It needs SQL Server 2012+. Azure SQL and Synapse are always newer; a 2008
//     R2 box running a CTE query gets a syntax error, and the caller sees it.
//   • Azure Synapse DEDICATED SQL pools historically did not support OFFSET…
//     FETCH outside limited forms. If a Synapse CTE query fails this way the
//     user's own `TOP` is the workaround. Unverified against a live pool.
//   • If the query ALREADY has its own OFFSET/FETCH, nothing is appended (it
//     would be a syntax error) — that query is capped client-side only.
//
// Which is why the client-side stop below is not optional. It is the only cap
// that holds in every one of these branches.

export function capTsql(sql: string, cap: number, scan?: TopScan): string {
  const inner = sql.replace(/;\s*$/, '').trim();
  const s = scan || scanTopLevel(inner);
  const w = s.words;
  const hasOrderBy = w.some((x, i) => x === 'ORDER' && w[i + 1] === 'BY');
  const hasPaging = w.some((x, i) => x === 'OFFSET' || (x === 'FETCH' && (w[i + 1] === 'NEXT' || w[i + 1] === 'FIRST')));
  const isCte = w[0] === 'WITH';

  if (hasPaging) return inner; // already paged by the user — client-side cap only
  if (hasOrderBy || isCte) {
    const order = hasOrderBy ? '' : ' ORDER BY (SELECT NULL)';
    return `${inner}${order} OFFSET 0 ROWS FETCH NEXT ${cap} ROWS ONLY`;
  }
  return `SELECT TOP (${cap}) * FROM ( ${inner} ) AS _ord_cap`;
}

// A T-SQL identifier we are willing to interpolate. Identifiers cannot be bound
// parameters, so a whitelist + quote-doubling is the guard. `evil"; DROP TABLE
// x; --` fails the regex; if it somehow reached quoteIdent the doubled quotes
// would keep it a single (absurd) identifier rather than new statements.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#@]*$/;

export function isSafeIdent(id: string): boolean {
  return IDENT_RE.test(id);
}

export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

// ── driver config ─────────────────────────────────────────────────────────────

interface MssqlVariant {
  id: string;
  label: string;
  blurb: string;
  defaultPort: number;
  /** Azure endpoints refuse plaintext TDS: encrypt is ON and not user-toggleable. */
  forceEncrypt: boolean;
  /** On-prem only: named instances and the self-signed-cert escape hatch. */
  onPrem: boolean;
}

const VARIANTS: MssqlVariant[] = [
  {
    id: 'sqlserver',
    label: 'Microsoft SQL Server',
    blurb: 'SQL Server 2012 or newer over TDS, read-only.',
    defaultPort: 1433,
    forceEncrypt: false,
    onPrem: true,
  },
  {
    id: 'azure-sql',
    label: 'Azure SQL Database',
    blurb: 'Azure SQL Database over TDS. TLS is always on.',
    defaultPort: 1433,
    forceEncrypt: true,
    onPrem: false,
  },
  {
    id: 'azure-synapse',
    label: 'Azure Synapse Analytics',
    blurb: 'Synapse dedicated or serverless SQL pool over TDS. TLS is always on.',
    defaultPort: 1433,
    forceEncrypt: true,
    onPrem: false,
  },
];

function fieldsFor(v: MssqlVariant): ConnectorDef['fields'] {
  const fields: ConnectorDef['fields'] = [
    {
      key: 'host',
      label: 'Server',
      type: 'text',
      required: true,
      placeholder: v.onPrem ? 'sql.internal.example.com' : 'myserver.database.windows.net',
    },
    { key: 'port', label: 'Port', type: 'number', default: v.defaultPort },
    { key: 'database', label: 'Database', type: 'text', required: true },
    {
      key: 'user',
      label: 'User',
      type: 'text',
      required: true,
      help: v.onPrem ? undefined : 'SQL authentication only. Entra ID / MFA logins are not supported.',
    },
    { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
  ];
  if (v.onPrem) {
    fields.push({
      key: 'instanceName',
      label: 'Instance name',
      type: 'text',
      help: 'Optional, for a named instance. Needs SQL Browser on UDP 1434; the port above is then ignored.',
    });
    fields.push({
      key: 'encrypt',
      label: 'Encrypt connection (TLS)',
      type: 'checkbox',
      default: true,
    });
    fields.push({
      key: 'trustServerCertificate',
      label: 'Trust the server certificate without verifying it',
      type: 'checkbox',
      default: false,
      help: 'Off by default. Turning this on encrypts the connection but stops checking who is on the other end — anyone able to intercept the network path can impersonate the server. Only for a self-signed certificate on a network you control.',
    });
  }
  return fields;
}

/** The tedious config for one operation. Exported so a test can assert it —
 *  a timeout that is not in this object is not a timeout. */
export function buildTediousConfig(v: MssqlVariant, ctx: ConnectorContext): ConnectionConfiguration {
  const instanceName = v.onPrem ? str(ctx.values.instanceName).trim() : '';
  const port = num(ctx.values.port, v.defaultPort);
  // Azure: encrypt is forced and no trust escape hatch is even offered.
  const encrypt = v.forceEncrypt ? true : bool(ctx.values.encrypt, true);
  const trustServerCertificate = v.onPrem ? bool(ctx.values.trustServerCertificate, false) : false;

  return {
    server: str(ctx.values.host).trim(),
    authentication: {
      type: 'default',
      options: {
        userName: str(ctx.values.user).trim(),
        password: str(ctx.secrets.password),
      },
    },
    options: {
      database: str(ctx.values.database).trim(),
      // tedious rejects port + instanceName together; the instance name wins.
      ...(instanceName ? { instanceName } : { port }),
      encrypt,
      trustServerCertificate,
      // BOTH bounds come from ctx.timeoutMs — connecting and querying each get
      // the whole budget, which is the honest reading of "one operation".
      connectTimeout: ctx.timeoutMs,
      requestTimeout: ctx.timeoutMs,
      // Rows are streamed via the 'row' event and capped as they arrive; letting
      // tedious collect them all would defeat the client-side cap.
      rowCollectionOnRequestCompletion: false,
      // Array rows, so duplicate column names from a `select *` join don't
      // collide the way object keys would.
      useColumnNames: false,
      // ApplicationIntent=ReadOnly: on an availability group this routes to a
      // readable secondary. Belt to the read-only guard's braces.
      readOnlyIntent: true,
      appName: 'Ordinate',
    },
  };
}

// ── driver plumbing ───────────────────────────────────────────────────────────

function connect(cfg: ConnectionConfiguration): Promise<TdsConnection> {
  const { Connection } = loadTedious();
  return new Promise<TdsConnection>((resolve, reject) => {
    let conn: TdsConnection;
    try {
      conn = new Connection(cfg);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    // A failing connection reports through BOTH the 'error' event and the
    // connect callback. Whichever arrives first settles; the other is a no-op.
    // The listener stays attached for the connection's whole life so a later
    // socket error can never become an unhandled 'error' event (which throws).
    conn.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      try { conn.close(); } catch (_) { /* already closing */ }
      reject(err);
    });
    conn.connect((err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { conn.close(); } catch (_) { /* already closing */ }
        reject(err);
      } else {
        resolve(conn);
      }
    });
  });
}

interface ExecResult {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  truncated: boolean;
}

/** Run one statement, stop reading at `cap` rows, cancel the request when the
 *  cap is hit so the server stops streaming. `cap` is the number of rows we are
 *  willing to KEEP; one extra is read to know whether the result was clipped. */
function execSql(
  conn: TdsConnection,
  sql: string,
  cap: number,
  addParams?: (req: import('tedious').Request) => void,
): Promise<ExecResult> {
  const { Request } = loadTedious();
  return new Promise<ExecResult>((resolve, reject) => {
    let columns: { name: string; type: string }[] = [];
    const rows: (string | number | boolean | null)[][] = [];
    let seen = 0;
    let canceled = false;
    let settled = false;

    const req = new Request(sql, (err: Error | null | undefined) => {
      if (settled) return;
      settled = true;
      // A cancel we asked for surfaces as a request error; that is a success.
      if (err && !canceled) {
        reject(err);
        return;
      }
      resolve({ columns, rows, truncated: seen > cap });
    });

    // tedious types the payload as ColumnMetadata[] OR a name-keyed object
    // (useColumnNames decides which). We set useColumnNames:false so it is
    // always the array, but the listener is declared over `unknown` and narrowed
    // — a listener typed only for the array does not satisfy the overload.
    req.on('columnMetadata', (meta: unknown) => {
      const list: TdsColumnMetadata[] = Array.isArray(meta)
        ? (meta as TdsColumnMetadata[])
        : Object.values((meta || {}) as Record<string, TdsColumnMetadata>);
      columns = list.map((m) => ({
        name: String(m.colName ?? ''),
        // The SOURCE's type name, verbatim — mapping to a ColumnType is the
        // caller's job, per the ConnectorColumn contract.
        type: String(m?.type?.name ?? ''),
      }));
    });

    req.on('row', (cols: TdsColumnValue[]) => {
      seen++;
      if (seen > cap) {
        if (!canceled) {
          canceled = true;
          try { conn.cancel(); } catch (_) { /* request already finished */ }
        }
        return;
      }
      rows.push((cols || []).map((c) => cellToValue(c?.value)));
    });

    if (addParams) addParams(req);

    try {
      conn.execSql(req);
    } catch (err) {
      if (!settled) { settled = true; reject(err); }
    }
  });
}

async function withConnection<T>(
  v: MssqlVariant,
  ctx: ConnectorContext,
  fn: (conn: TdsConnection) => Promise<T>,
): Promise<T> {
  const conn = await connect(buildTediousConfig(v, ctx));
  try {
    return await fn(conn);
  } finally {
    try { conn.close(); } catch (_) { /* already closed */ }
  }
}

// ── operations ────────────────────────────────────────────────────────────────

const TABLE_LIST_CAP = 1000;

/** A table with more columns than this is a data-modelling accident, not a
 *  schema tree to render. Same reasoning as TABLE_LIST_CAP above. */
const COLUMN_LIST_CAP = 2000;

async function listTables(v: MssqlVariant, ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  try {
    // Parameterized, including the row cap: TOP accepts a variable when it is
    // parenthesised, so no value in this statement is string-concatenated.
    const sql =
      'SELECT TOP (@maxRows) TABLE_SCHEMA, TABLE_NAME ' +
      'FROM INFORMATION_SCHEMA.TABLES ' +
      'WHERE TABLE_TYPE IN (@baseTable, @viewType) ' +
      'ORDER BY TABLE_SCHEMA, TABLE_NAME';
    const out = await withConnection(v, ctx, (conn) =>
      execSql(conn, sql, TABLE_LIST_CAP, (req) => {
        const { TYPES } = loadTedious();
        req.addParameter('maxRows', TYPES.Int, TABLE_LIST_CAP);
        req.addParameter('baseTable', TYPES.NVarChar, 'BASE TABLE');
        req.addParameter('viewType', TYPES.NVarChar, 'VIEW');
      }),
    );
    const tables = out.rows.map((r) => ({ schema: str(r[0]), name: str(r[1]) }));
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

async function run(v: MssqlVariant, ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const trimmed = String(sql ?? '').trim();
  if (!trimmed) return { ok: false, error: 'No query specified' };

  const scan = scanTopLevel(trimmed.replace(/;\s*$/, ''));
  const violation = assertReadOnly(scan);
  if (violation) return { ok: false, error: violation };

  const cap = Math.max(1, Math.floor(ctx.rowLimit));
  // cap + 1 server-side so a result of exactly `cap` rows is not reported as
  // truncated, and so truncation is detected without a second COUNT query.
  const capped = capTsql(trimmed, cap + 1, scan);

  try {
    const out = await withConnection(v, ctx, (conn) => execSql(conn, capped, cap));
    return { ok: true, columns: out.columns, rows: out.rows, truncated: out.truncated };
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/**
 * One table's columns out of `INFORMATION_SCHEMA.COLUMNS`, fully parameterised.
 *
 * Every user-supplied part is a tedious PARAMETER, so nothing the renderer sent
 * is ever concatenated into T-SQL — a stronger guard than `run`'s, which has to
 * build a projection and therefore leans on `scanTopLevel`/`assertReadOnly`.
 *
 * The estimate comes from `sys.dm_db_partition_stats`, summed over the heap or
 * clustered index (`index_id IN (0,1)`) — the standard way to read a row count
 * without scanning. A principal with no VIEW DATABASE STATE permission cannot
 * read it, which is ordinary on Azure SQL, so it is a separate try and its
 * failure only costs the estimate.
 */
async function describeTable(
  v: MssqlVariant,
  ctx: ConnectorContext,
  table: string,
): Promise<ConnectorSchema | ConnectorError> {
  const parts = String(table ?? '').trim().split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !p)) {
    return { ok: false, error: 'Invalid table name' };
  }
  const schema = parts.length === 2 ? parts[0] : '';
  const name = parts[parts.length - 1];

  const columnsSql =
    'SELECT TOP (@maxCols) COLUMN_NAME, DATA_TYPE, IS_NULLABLE ' +
    'FROM INFORMATION_SCHEMA.COLUMNS ' +
    'WHERE TABLE_NAME = @tableName AND (@schemaName = @blank OR TABLE_SCHEMA = @schemaName) ' +
    'ORDER BY TABLE_SCHEMA, ORDINAL_POSITION';

  // QUOTENAME() is what makes this safe to hand to OBJECT_ID: it is SQL
  // Server's own identifier quoter, applied server-side to a BOUND value, so a
  // hostile name is bracketed rather than parsed.
  const estimateSql =
    'SELECT SUM(ps.row_count) FROM sys.dm_db_partition_stats ps ' +
    'WHERE ps.index_id IN (0, 1) AND ps.object_id = OBJECT_ID(' +
    "CASE WHEN @schemaName = @blank THEN QUOTENAME(@tableName) " +
    'ELSE QUOTENAME(@schemaName) + N\'.\' + QUOTENAME(@tableName) END)';

  const bind = (req: import('tedious').Request): void => {
    const { TYPES } = loadTedious();
    req.addParameter('maxCols', TYPES.Int, COLUMN_LIST_CAP);
    req.addParameter('tableName', TYPES.NVarChar, name);
    req.addParameter('schemaName', TYPES.NVarChar, schema);
    req.addParameter('blank', TYPES.NVarChar, '');
  };

  try {
    const out = await withConnection(v, ctx, async (conn) => {
      const cols = await execSql(conn, columnsSql, COLUMN_LIST_CAP, bind);
      let estimate: number | undefined;
      try {
        const est = await execSql(conn, estimateSql, 1, (req) => {
          const { TYPES } = loadTedious();
          req.addParameter('tableName', TYPES.NVarChar, name);
          req.addParameter('schemaName', TYPES.NVarChar, schema);
          req.addParameter('blank', TYPES.NVarChar, '');
        });
        const n = Number(est.rows[0]?.[0]);
        if (Number.isFinite(n) && n >= 0) estimate = Math.round(n);
      } catch (_) {
        /* VIEW DATABASE STATE is commonly withheld — no estimate, still fine */
      }
      return { cols, estimate };
    });

    const columns = out.cols.rows.map((r) => {
      const col: { name: string; type: string; nullable?: boolean } = {
        name: str(r[0]),
        type: str(r[1]),
      };
      const nullable = str(r[2]).toUpperCase();
      if (nullable === 'YES' || nullable === 'NO') col.nullable = nullable === 'YES';
      return col;
    }).filter((c) => c.name);
    if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };

    const schemaOut: ConnectorSchema = { ok: true, columns };
    if (out.estimate !== undefined) schemaOut.rowEstimate = out.estimate;
    return schemaOut;
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

function defFor(v: MssqlVariant): ConnectorDef {
  return {
    id: v.id,
    label: v.label,
    family: 'mssql',
    category: v.onPrem ? 'Databases' : 'Cloud warehouses',
    readOnly: true,
    blurb: v.blurb,
    fields: fieldsFor(v),
    listTables: (ctx: ConnectorContext) => listTables(v, ctx),
    run: (ctx: ConnectorContext, sql: string) => run(v, ctx, sql),
    describeTable: (ctx: ConnectorContext, table: string) => describeTable(v, ctx, table),
  };
}

export const CONNECTORS: ConnectorDef[] = VARIANTS.map(defFor);

// Alias + default so the registry can import this under either convention.
export const connectors: ConnectorDef[] = CONNECTORS;
export default CONNECTORS;

// Exported for the self-check only.
export const __testing = { VARIANTS, scanTopLevel, assertReadOnly, cellToValue };
