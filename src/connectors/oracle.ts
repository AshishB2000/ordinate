// Oracle Database connectors — MAIN PROCESS ONLY.
//
//   • oracle             — Oracle Database (on-prem or Cloud VM), port 1521
//   • oracle-autonomous  — Oracle Autonomous Database (ADB), TLS connect string
//
// ============================================================================
// THIN MODE IS THE WHOLE BASIS OF SHIPPING THIS. `require('oracledb').thin` is
// true by default in node-oracledb 6+: the driver speaks Oracle Net directly
// from JavaScript and needs NO Oracle Instant Client installed on the machine.
//
// Therefore: DO NOT CALL `oracledb.initOracleClient` ANYWHERE. That one line
// switches the process to Thick mode, which requires a client library we do not
// ship and cannot install for the user. It would work on a developer's Mac that
// happens to have Instant Client and fail at startup for every real user. The
// self-check greps this file for that symbol; keep it absent.
// ============================================================================
//
// VERSION FLOOR: Oracle Database 12.1. Chosen deliberately — the row cap uses
// `FETCH FIRST n ROWS ONLY` (12c+) and the table list uses
// `all_users.oracle_maintained` (12c+). The 11g-and-earlier equivalent of the
// cap is `SELECT * FROM ( … ) WHERE ROWNUM <= n`, which is NOT equivalent in
// general: ROWNUM is assigned before ORDER BY, so it clips the wrong rows unless
// the ordering happens in an inner query. Rather than ship a cap whose meaning
// changes with the server version, we require 12.1 (11.2 left extended support
// in 2020; Autonomous is 19c/23ai) and let an older server return its own error.
//
// READ-ONLY. `assertReadOnly` is a guard, not a SQL parser — see mssql.ts for
// the same caveat. It also rejects `FOR UPDATE`, which reads but takes locks.

import type {
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTables,
} from './types';
import { safeError } from './types';

// ── driver surface ────────────────────────────────────────────────────────────
//
// `oracledb` ships no TypeScript types and we may not add a dependency, so the
// slice of its API used here is declared structurally. Everything is `unknown`
// at the edges and narrowed by cellToValue — no `any` anywhere in this file.

interface OracleMetaData {
  name: string;
  /** Source type name verbatim, e.g. 'NUMBER', 'VARCHAR2', 'TIMESTAMP'. */
  dbTypeName?: string;
}
interface OracleResult {
  metaData?: OracleMetaData[];
  rows?: unknown[][];
}
interface OracleExecOptions {
  outFormat: number;
  maxRows: number;
  fetchTypeHandler?: (meta: OracleMetaData) => { type: unknown } | undefined;
}
interface OracleConnection {
  callTimeout: number;
  execute(sql: string, binds: unknown[], options: OracleExecOptions): Promise<OracleResult>;
  close(): Promise<void>;
}
interface OracleConnAttrs {
  user: string;
  password: string;
  connectString: string;
  /** SECONDS, not milliseconds — sessionAtts multiplies it by 1000. */
  connectTimeout?: number;
  walletLocation?: string;
  walletPassword?: string;
}
interface OracleDb {
  thin: boolean;
  OUT_FORMAT_ARRAY: number;
  DB_TYPE_CLOB: unknown;
  STRING: unknown;
  getConnection(attrs: OracleConnAttrs): Promise<OracleConnection>;
}

// Lazy require: the driver is not pulled in until a user actually connects.
// NOTE (again): no initOracleClient call here — Thin mode, no Instant Client.
export function loadOracle(): OracleDb {
  return require('oracledb') as OracleDb;
}

// ── field value helpers ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// An Oracle cell → the contract's scalar. Dates arrive as JS Date, so they must
// become an unambiguous ISO string; RAW/BLOB arrive as Buffer.
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
// Lexer, not a parser. Skips '...' literals, "..." quoted identifiers, -- line
// comments and /* */ block comments (Oracle's do NOT nest, unlike T-SQL's), and
// reports the bare words at paren depth 0.

interface TopScan {
  words: string[];
  /** A ';' at depth 0 with more SQL after it. */
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
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
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
      while (j < n && /[A-Za-z0-9_$#]/.test(sql[j])) j++;
      if (depth === 0) words.push(sql.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    i++;
  }
  return { words, batched };
}

const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'LOCK', 'BEGIN',
  'DECLARE', 'CALL', 'EXECUTE', 'EXEC', 'ANALYZE', 'AUDIT', 'COMMENT',
]);

function assertReadOnly(scan: TopScan): string | null {
  const w = scan.words;
  if (w[0] !== 'SELECT' && w[0] !== 'WITH') {
    return 'Only SELECT queries are allowed (this connection is read-only)';
  }
  if (scan.batched) {
    return 'Only a single statement is allowed';
  }
  for (const word of w) {
    if (WRITE_WORDS.has(word)) {
      return `Only SELECT queries are allowed (found "${word}")`;
    }
  }
  // Reads rows but takes row locks — not a read as far as this app is concerned.
  if (w.some((x, i) => x === 'FOR' && w[i + 1] === 'UPDATE')) {
    return 'Only SELECT queries are allowed (FOR UPDATE takes locks)';
  }
  return null;
}

// ── the row cap ───────────────────────────────────────────────────────────────
//
// `SELECT * FROM ( <user sql> ) FETCH FIRST n ROWS ONLY` — 12c+. Unlike T-SQL,
// Oracle permits ORDER BY inside an inline view, so the wrapper is safe for an
// ordered query and the ordering survives. Two exceptions:
//   • A CTE (`WITH …`) — Oracle's placement rules for subquery factoring inside
//     an inline view vary by version, so we append the clause to the user's own
//     statement instead of wrapping it. Valid on 12.1+.
//   • The query already has its own FETCH/OFFSET — appending a second one is a
//     syntax error, so nothing is appended and only the client-side cap applies.
// `maxRows` on the execute call is that client-side cap and it always applies.
//
// (11g and earlier: `SELECT * FROM ( … ) WHERE ROWNUM <= n`. Not used — see the
// version-floor note at the top of this file.)

export function capOracle(sql: string, cap: number, scan?: TopScan): string {
  const inner = sql.replace(/;\s*$/, '').trim();
  const s = scan || scanTopLevel(inner);
  const w = s.words;
  const hasPaging = w.some((x, i) => x === 'OFFSET' || (x === 'FETCH' && (w[i + 1] === 'FIRST' || w[i + 1] === 'NEXT')));
  const isCte = w[0] === 'WITH';

  if (hasPaging) return inner;
  if (isCte) return `${inner} FETCH FIRST ${cap} ROWS ONLY`;
  return `SELECT * FROM ( ${inner} ) FETCH FIRST ${cap} ROWS ONLY`;
}

// Oracle identifiers are folded to UPPERCASE unless they were created quoted —
// `create table sales(...)` really makes `SALES`, and asking for "sales" (quoted
// lower-case) then fails with ORA-00942 "table or view does not exist". That is
// THE thing that makes a user's table "not found". Identifiers cannot be bound,
// so a whitelist + quote-doubling is the injection guard: `evil"; DROP TABLE x;
// --` fails IDENT_RE, and even if it reached quoteIdent the doubled quote keeps
// it one absurd identifier rather than a second statement.
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_$#]*$/;

export function isSafeIdent(id: string): boolean {
  return IDENT_RE.test(id);
}

export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

/** Fold an unquoted identifier the way Oracle does, so a user who typed `sales`
 *  gets `"SALES"` and finds their table. */
export function quoteIdentFolded(id: string): string {
  return quoteIdent(id.toUpperCase());
}

// ── connector variants ────────────────────────────────────────────────────────

interface OracleVariant {
  id: string;
  label: string;
  blurb: string;
  /** ADB is reached with a ready-made TLS connect string, not host/port/service. */
  autonomous: boolean;
}

const DEFAULT_PORT = 1521;

const VARIANTS: OracleVariant[] = [
  {
    id: 'oracle',
    label: 'Oracle Database',
    blurb: 'Oracle Database 12.1 or newer, read-only. No Oracle client install needed.',
    autonomous: false,
  },
  {
    id: 'oracle-autonomous',
    label: 'Oracle Autonomous Database',
    blurb: 'Autonomous Database over TLS, read-only. No Oracle client install needed.',
    autonomous: true,
  },
];

function fieldsFor(v: OracleVariant): ConnectorDef['fields'] {
  if (v.autonomous) {
    return [
      {
        key: 'connectString',
        label: 'Connect string',
        type: 'text',
        required: true,
        placeholder: 'tcps://adb.us-ashburn-1.oraclecloud.com:1522/abc123_mydb_high.adb.oraclecloud.com',
        help: 'Copy the TLS connect string from the OCI console (Database connection → TLS authentication: TLS). Requires the database to allow TLS connections; a mutual-TLS-only database needs the wallet fields below.',
      },
      { key: 'user', label: 'User', type: 'text', required: true, placeholder: 'ADMIN' },
      { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
      {
        key: 'walletLocation',
        label: 'Wallet folder',
        type: 'text',
        help: 'Optional, for a mutual-TLS (wallet) database. Path to the unzipped wallet. Thin mode reads ewallet.pem from it — a wallet containing only cwallet.sso will not work.',
      },
      {
        key: 'walletPassword',
        label: 'Wallet password',
        type: 'password',
        secret: true,
        help: 'Optional. The password set when the wallet was downloaded, needed to decrypt ewallet.pem.',
      },
    ];
  }
  return [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', type: 'number', default: DEFAULT_PORT },
    {
      key: 'serviceName',
      label: 'Service name',
      type: 'text',
      required: true,
      placeholder: 'ORCLPDB1',
      help: 'The service name, not the SID. Combined with host and port into host:port/service.',
    },
    { key: 'user', label: 'User', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
  ];
}

/** host:port/serviceName — the "Easy Connect" form, so nobody hand-builds a DSN. */
export function buildConnectString(v: OracleVariant, values: Record<string, unknown>): string {
  if (v.autonomous) return str(values.connectString).trim();
  const host = str(values.host).trim();
  const port = num(values.port, DEFAULT_PORT);
  const service = str(values.serviceName).trim().replace(/^\//, '');
  return `${host}:${port}/${service}`;
}

/** The getConnection attributes for one operation. Exported so a test can
 *  assert them — a timeout that is not in this object is not a timeout. */
export function buildConnAttrs(v: OracleVariant, ctx: ConnectorContext): OracleConnAttrs {
  const attrs: OracleConnAttrs = {
    user: str(ctx.values.user).trim(),
    password: str(ctx.secrets.password),
    connectString: buildConnectString(v, ctx.values),
    // SECONDS here (the driver multiplies by 1000), milliseconds for
    // callTimeout below. At least 1s so a small ctx.timeoutMs never floors to
    // 0, which the driver reads as "no timeout".
    connectTimeout: Math.max(1, Math.ceil(ctx.timeoutMs / 1000)),
  };
  if (v.autonomous) {
    const wallet = str(ctx.values.walletLocation).trim();
    if (wallet) {
      attrs.walletLocation = wallet;
      const pw = str(ctx.secrets.walletPassword);
      if (pw) attrs.walletPassword = pw;
    }
  }
  return attrs;
}

// ── driver plumbing ───────────────────────────────────────────────────────────

async function withConnection<T>(
  v: OracleVariant,
  ctx: ConnectorContext,
  fn: (conn: OracleConnection) => Promise<T>,
): Promise<T> {
  const oracledb = loadOracle();
  const conn = await oracledb.getConnection(buildConnAttrs(v, ctx));
  try {
    // Server-side bound on a single round trip, in MILLISECONDS.
    conn.callTimeout = Math.max(1, Math.floor(ctx.timeoutMs));
    return await fn(conn);
  } finally {
    await conn.close().catch(() => { /* connection already gone */ });
  }
}

interface ExecOut {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  truncated: boolean;
}

/** Run one statement. `cap` is the number of rows we are willing to KEEP; one
 *  extra is fetched so truncation is detected without a second COUNT query. */
async function execute(conn: OracleConnection, sql: string, binds: unknown[], cap: number): Promise<ExecOut> {
  const oracledb = loadOracle();
  const res = await conn.execute(sql, binds, {
    // Positional rows: a `select *` join with duplicate column names would
    // collide in an object.
    outFormat: oracledb.OUT_FORMAT_ARRAY,
    maxRows: cap + 1, // client-side cap; always applies, whatever the SQL says
    // A CLOB otherwise arrives as a Lob stream object we would have to read
    // asynchronously mid-row. Fetch it as a string instead.
    fetchTypeHandler: (meta: OracleMetaData) =>
      meta && meta.dbTypeName === 'CLOB' ? { type: oracledb.STRING } : undefined,
  });
  const all = res.rows || [];
  const truncated = all.length > cap;
  const rows = (truncated ? all.slice(0, cap) : all).map((r) => (r || []).map(cellToValue));
  return {
    columns: (res.metaData || []).map((m) => ({
      name: String(m.name ?? ''),
      // Source type verbatim — mapping to a ColumnType is the caller's job.
      type: String(m.dbTypeName ?? ''),
    })),
    rows,
    truncated,
  };
}

// ── operations ────────────────────────────────────────────────────────────────

const TABLE_LIST_CAP = 1000;

/** A table wider than this is a modelling accident, not a tree to render. */
const COLUMN_LIST_CAP = 2000;

async function listTables(v: OracleVariant, ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  // ALL_TABLES = every table this user can read, joined to ALL_USERS so the
  // Oracle-maintained schemas (SYS, SYSTEM, XDB, …) drop out without a
  // hand-maintained blocklist. Every value is a bind (:1); the only literal is
  // the constant 'N'.
  //
  // OWNER and TABLE_NAME come back UPPERCASE unless the object was created with
  // a quoted lower-case name — see quoteIdentFolded above.
  const sql =
    'SELECT t.owner, t.table_name ' +
    '  FROM all_tables t ' +
    '  JOIN all_users u ON u.username = t.owner ' +
    ' WHERE u.oracle_maintained = \'N\' ' +
    ' ORDER BY t.owner, t.table_name ' +
    ' FETCH FIRST :1 ROWS ONLY';
  try {
    const out = await withConnection(v, ctx, (conn) =>
      execute(conn, sql, [TABLE_LIST_CAP], TABLE_LIST_CAP),
    );
    return { ok: true, tables: out.rows.map((r) => ({ schema: str(r[0]), name: str(r[1]) })) };
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

async function run(v: OracleVariant, ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const trimmed = String(sql ?? '').trim();
  if (!trimmed) return { ok: false, error: 'No query specified' };

  const scan = scanTopLevel(trimmed.replace(/;\s*$/, ''));
  const violation = assertReadOnly(scan);
  if (violation) return { ok: false, error: violation };

  const cap = Math.max(1, Math.floor(ctx.rowLimit));
  const capped = capOracle(trimmed, cap + 1, scan);

  try {
    const out = await withConnection(v, ctx, (conn) => execute(conn, capped, [], cap));
    return { ok: true, columns: out.columns, rows: out.rows, truncated: out.truncated };
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/**
 * One table's columns out of `ALL_TAB_COLUMNS`, every value a bind.
 *
 * ORACLE FOLDS UNQUOTED IDENTIFIERS TO UPPER CASE, so the catalog stores
 * `ORDERS` for a table created as `orders`. The tree sends back exactly what
 * `listTables` reported (already upper case for the ordinary case), but a user
 * typing a name into the editor will type it in lower case — so both spellings
 * are tried, verbatim first. Matching case-insensitively instead would find the
 * wrong object on a schema that really does hold a quoted lower-case twin.
 *
 * `ALL_TABLES.NUM_ROWS` is the estimate: it is whatever the last
 * DBMS_STATS/ANALYZE wrote, and NULL on a table that has never been gathered.
 * Read in its own try — no estimate is a missing nicety, not a failed describe.
 */
async function describeTable(
  v: OracleVariant,
  ctx: ConnectorContext,
  table: string,
): Promise<ConnectorSchema | ConnectorError> {
  const parts = str(table).trim().split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !p)) {
    return { ok: false, error: 'Invalid table name' };
  }
  const owner = parts.length === 2 ? parts[0] : '';
  const name = parts[parts.length - 1];

  const columnsSql =
    'SELECT column_name, data_type, nullable ' +
    '  FROM all_tab_columns ' +
    ' WHERE table_name = :1 AND (:2 IS NULL OR owner = :2) ' +
    ' ORDER BY owner, column_id ' +
    ' FETCH FIRST :3 ROWS ONLY';
  const estimateSql =
    'SELECT num_rows FROM all_tables ' +
    ' WHERE table_name = :1 AND (:2 IS NULL OR owner = :2) ' +
    ' FETCH FIRST 1 ROWS ONLY';

  try {
    const out = await withConnection(v, ctx, async (conn) => {
      // Verbatim, then the Oracle-folded upper case. Two cheap catalog reads
      // beat guessing which convention this schema was created with.
      let cols = await execute(conn, columnsSql, [name, owner || null, COLUMN_LIST_CAP], COLUMN_LIST_CAP);
      let lookup: [string, string | null] = [name, owner || null];
      if (cols.rows.length === 0) {
        lookup = [name.toUpperCase(), owner ? owner.toUpperCase() : null];
        cols = await execute(conn, columnsSql, [lookup[0], lookup[1], COLUMN_LIST_CAP], COLUMN_LIST_CAP);
      }
      let estimate: number | undefined;
      try {
        const est = await execute(conn, estimateSql, [lookup[0], lookup[1]], 1);
        const n = Number(est.rows[0]?.[0]);
        if (Number.isFinite(n) && n >= 0) estimate = Math.round(n);
      } catch (_) {
        /* stats never gathered, or ALL_TABLES not readable — skip the estimate */
      }
      return { cols, estimate };
    });

    const columns = out.cols.rows.map((r) => {
      const col: { name: string; type: string; nullable?: boolean } = {
        name: str(r[0]),
        type: str(r[1]),
      };
      // ALL_TAB_COLUMNS.NULLABLE is 'Y' / 'N', not 'YES' / 'NO'.
      const nullable = str(r[2]).toUpperCase();
      if (nullable === 'Y' || nullable === 'N') col.nullable = nullable === 'Y';
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

function defFor(v: OracleVariant): ConnectorDef {
  return {
    id: v.id,
    label: v.label,
    family: 'oracle',
    category: v.autonomous ? 'Cloud warehouses' : 'Databases',
    readOnly: true,
    blurb: v.blurb,
    fields: fieldsFor(v),
    listTables: (ctx: ConnectorContext) => listTables(v, ctx),
    run: (ctx: ConnectorContext, q: string) => run(v, ctx, q),
    describeTable: (ctx: ConnectorContext, t: string) => describeTable(v, ctx, t),
  };
}

export const CONNECTORS: ConnectorDef[] = VARIANTS.map(defFor);

// Alias + default so the registry can import this under either convention.
export const connectors: ConnectorDef[] = CONNECTORS;
export default CONNECTORS;

// Exported for the self-check only.
export const __testing = { VARIANTS, DEFAULT_PORT, scanTopLevel, assertReadOnly, cellToValue };
