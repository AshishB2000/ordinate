// MySQL-wire-protocol connectors — MAIN PROCESS ONLY.
//
// Eight products speak the MySQL wire protocol closely enough to share one
// implementation (`mysql2`, pure JS — no native build, same reasoning as `pg`
// in src/connectionRun.ts). They differ only in defaults and in two dialect
// details that MATTER, so they are declared as data in VARIANTS below and the
// behaviour is written once:
//
//   • default port — 3306 for MySQL/MariaDB/Aurora/SingleStore/PlanetScale,
//     4000 for TiDB, 9030 for StarRocks/Doris. A factory-built family invites
//     exactly one bug: a copy-pasted port. The test pins all eight.
//   • the server-side statement timeout — see timeoutPlan() below. There is no
//     single spelling that works everywhere, and getting it wrong means the
//     timeout silently does nothing.
//
// The SHAPE is copied from src/connectionRun.ts, which is the house standard:
// parameterized metadata queries, the user's SQL wrapped in a sub-SELECT with a
// LIMIT, a SERVER-side timeout, and the connection closed in a `finally`.
// Every error goes out through safeError() — mysql2 puts the host and user into
// its error messages ("Access denied for user 'x'@'y'"), and a DSN-style message
// would otherwise carry a password to a renderer.

import { connect as netConnect } from 'net';
import { createConnection, Connection, ConnectionOptions, FieldPacket } from 'mysql2/promise';
import {
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorField,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTables,
  safeError,
} from './types';

// mysql2 ships a bidirectional {code ↔ NAME} map of protocol column types at
// runtime but leaves it out of its typings, so it is pulled in with an explicit
// shape rather than `any`. Used only to name a column's SOURCE type verbatim.
const { Types } = require('mysql2') as { Types: Record<number, string | undefined> };

const CONNECT_TIMEOUT_MS = 10_000;
// The socket is only destroyed this long AFTER the server-side limit should have
// fired. The server-side limit is the real bound; this is a backstop so a server
// that ignored it cannot hang the main process forever.
const BACKSTOP_GRACE_MS = 2_000;
const MAX_TABLES = 1_000;

// ── Dialect: how to bound a statement on the server ───────────────────────────

// Three spellings exist across this family and they are NOT interchangeable:
//
//   'max_execution_time'  MySQL 5.7.8+ (and Aurora MySQL, TiDB, PlanetScale —
//                         all MySQL-5.7/8.0-compatible). Value is MILLISECONDS.
//                         Applies to read-only SELECTs only, which is all this
//                         app ever runs, so that restriction costs us nothing.
//   'max_statement_time'  MariaDB. MariaDB does NOT implement
//                         max_execution_time at all — setting it is an "Unknown
//                         system variable" error, so a MariaDB user would get a
//                         connector that appears bounded and is not. Value is
//                         SECONDS, and it is applied as a `SET STATEMENT … FOR`
//                         PREFIX on the statement itself rather than as session
//                         state, which is MariaDB's own idiom and scopes the
//                         limit to precisely the one query we care about.
//   'query_timeout'       StarRocks / Apache Doris. Both are MySQL-protocol but
//                         not MySQL forks; neither honours max_execution_time.
//                         Value is SECONDS.
export type TimeoutDialect = 'max_execution_time' | 'max_statement_time' | 'query_timeout';

export interface TimeoutPlan {
  /** Statement to run on the session BEFORE the query, or null when the dialect
   *  bounds the statement by prefixing it instead. */
  session: string | null;
  /** Prefix glued onto the front of the query itself. '' for most dialects. */
  prefix: string;
  dialect: TimeoutDialect;
}

function timeoutSeconds(timeoutMs: number): number {
  // Round UP: a sub-second cap must not become 0, which means "no limit".
  return Math.max(1, Math.ceil(sanitizeTimeoutMs(timeoutMs) / 1000));
}

function sanitizeTimeoutMs(timeoutMs: number): number {
  const n = Math.floor(Number(timeoutMs));
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/** The server-side bound for one connector id. Pure — this is the piece the test
 *  pins, because a wrong spelling fails silently at runtime. */
export function timeoutPlan(connectorId: string, timeoutMs: number): TimeoutPlan {
  const dialect = VARIANTS.find((v) => v.id === connectorId)?.timeout ?? 'max_execution_time';
  return timeoutPlanFor(dialect, timeoutMs);
}

export function timeoutPlanFor(dialect: TimeoutDialect, timeoutMs: number): TimeoutPlan {
  if (dialect === 'max_statement_time') {
    // MariaDB, seconds, statement-scoped prefix. Note the trailing space — the
    // query is concatenated straight onto this.
    return { session: null, prefix: `SET STATEMENT max_statement_time=${timeoutSeconds(timeoutMs)} FOR `, dialect };
  }
  if (dialect === 'query_timeout') {
    return { session: `SET query_timeout = ${timeoutSeconds(timeoutMs)}`, prefix: '', dialect };
  }
  return { session: `SET SESSION max_execution_time = ${sanitizeTimeoutMs(timeoutMs)}`, prefix: '', dialect };
}

// Session-settable spellings, tried in order when the declared one is rejected.
// StarRocks reports itself as MySQL 5.x and SingleStore aims at MySQL
// compatibility without matching it exactly, so a declared dialect can be wrong
// on a given build/version. Falling through costs at most two extra round-trips
// once per operation and turns "silently unbounded" into "bounded by whichever
// spelling this server understands". The MariaDB prefix form is deliberately NOT
// in this chain: it is part of the statement, so a wrong guess makes the QUERY
// fail loudly, which is the outcome we want over running unbounded.
const SESSION_TIMEOUT_FALLBACKS: TimeoutDialect[] = ['max_execution_time', 'max_statement_time', 'query_timeout'];

function sessionTimeoutStatement(dialect: TimeoutDialect, timeoutMs: number): string {
  if (dialect === 'max_statement_time') return `SET SESSION max_statement_time = ${timeoutSeconds(timeoutMs)}`;
  return timeoutPlanFor(dialect, timeoutMs).session as string;
}

// ── SQL building ──────────────────────────────────────────────────────────────

/** Backtick-quote an identifier, doubling any embedded backtick. Identifiers can
 *  NEVER be bound parameters, so this is the only guard on the one place a
 *  user-supplied name is interpolated (the database name in `SHOW TABLES FROM`).
 *  Doubling is what makes "evil`; DROP TABLE x; --" stay ONE identifier instead
 *  of closing the quote and starting a new statement. */
export function quoteIdent(id: string): string {
  return '`' + String(id).replace(/`/g, '``') + '`';
}

/** Wrap the user's SQL so it cannot return more than `rowLimit` rows.
 *
 *  The emitted LIMIT is rowLimit + 1 ON PURPOSE: the extra "probe" row is how we
 *  learn the cap actually clipped something. We then hand back exactly rowLimit
 *  rows with truncated:true, so the cap is enforced at rowLimit and truncation is
 *  reported rather than guessed at (rows.length === rowLimit is ambiguous — a
 *  table with exactly rowLimit rows is not truncated).
 *
 *  A trailing semicolon would close the sub-select early, so it is stripped. */
export function wrapSelect(sql: string, rowLimit: number): string {
  const inner = String(sql).trim().replace(/;\s*$/, '');
  // `inner` on its own line (T6.3): a trailing `-- ` or `#` comment would
  // otherwise swallow `) AS t LIMIT …` and the whole table would be buffered.
  return `SELECT * FROM (\n${inner}\n) AS t LIMIT ${probeLimit(rowLimit)}`;
}

export function effectiveRowLimit(rowLimit: number): number {
  const n = Math.floor(Number(rowLimit));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function probeLimit(rowLimit: number): number {
  return effectiveRowLimit(rowLimit) + 1;
}

// ── Connection options ────────────────────────────────────────────────────────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on';
  if (typeof v === 'number') return v !== 0;
  return fallback;
}

function port(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 && n < 65_536 ? n : fallback;
}

/** Build the mysql2 options for one variant + context. Exported so the test can
 *  assert the foot-guns are off without opening a socket. */
export function connectionOptions(variant: MysqlVariant, ctx: ConnectorContext): ConnectionOptions {
  const useSsl = variant.sslRequired ? true : bool(ctx.values.ssl, variant.sslDefault);
  const portNo = port(ctx.values.port, variant.port);
  const pin = ctx.pinned;
  return {
    host: str(ctx.values.host, 'localhost'),
    port: portNo,
    // Server (T6.1): the socket goes to the address the SSRF guard checked.
    // `host` stays the typed name — mysql2 sends it as the TLS SNI.
    ...(pin ? { stream: () => netConnect({ host: pin.address, port: portNo }).setNoDelay(true) } : {}),
    database: str(ctx.values.database) || undefined,
    user: str(ctx.values.user) || undefined,
    password: str(ctx.secrets.password) || undefined,

    // NOT a redundant default. mysql2 defaults this to false, and it MUST stay
    // false: with it on, `SELECT 1; DROP TABLE x;` is sent as two statements and
    // BOTH run, which would put a write path into a read-only app through a
    // field the user typed. This is the same class of bug already found in this
    // project's DuckDB layer, so it is asserted here and in the test rather than
    // left to a library default someone could later "helpfully" flip.
    multipleStatements: false,

    // Rows come back positional, so `select a.id, b.id` does not collapse two
    // columns into one object key. Matches pg's rowMode:'array' in connectionRun.
    rowsAsArray: true,
    // The whole point of Ordinate's type sniffer is that the SOURCE text decides
    // the type ('007' is text). Dates as strings and big numbers as strings keep
    // the driver from making that call for us — and from silently rounding a
    // BIGINT id past 2^53.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,

    // TLS on the wire without pinning a CA. Aurora and most managed MySQL serve
    // certificates from roots we cannot ship, and self-hosted servers are usually
    // self-signed; verifying would just make TLS unusable and push people to turn
    // it off entirely. Same trade-off the Postgres connector already makes.
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,

    connectTimeout: Math.min(sanitizeTimeoutMs(ctx.timeoutMs), CONNECT_TIMEOUT_MS),
    // Explicit: no client-side named placeholders, no server-side prepare. `?`
    // params are escaped by mysql2's own escaper, which is the parameterization
    // the metadata queries below rely on.
    namedPlaceholders: false,
  };
}

// ── Value / column marshalling ────────────────────────────────────────────────

/** Coerce one driver value into the contract's string|number|boolean|null. */
export function normalizeCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as string | number | boolean;
  // A BIGINT past 2^53 would lose digits as a JS number, so it stays text.
  if (t === 'bigint') return (v as bigint).toString();
  if (v instanceof Date) return v.toISOString();
  // BLOB/BINARY. base64 is lossless; utf8 would mangle genuinely binary data and
  // there is no way to tell the two apart from the protocol type alone.
  if (Buffer.isBuffer(v)) return v.toString('base64');
  try {
    // JSON and geometry columns arrive already parsed.
    return JSON.stringify(v) ?? null;
  } catch (_) {
    return String(v);
  }
}

/** The SOURCE's type name, verbatim — never mapped to an Ordinate ColumnType
 *  here, per the contract in types.ts. */
export function columnTypeName(f: Pick<FieldPacket, 'type' | 'columnType' | 'typeName'>): string {
  if (typeof f.typeName === 'string' && f.typeName) return f.typeName;
  const code = typeof f.columnType === 'number' ? f.columnType : f.type;
  if (typeof code === 'number') {
    const name = Types[code];
    if (typeof name === 'string' && name) return name;
    return String(code);
  }
  return 'UNKNOWN';
}

// ── Execution ─────────────────────────────────────────────────────────────────

// mysql2's query<T> generic models object rows only; with rowsAsArray:true the
// result is an array of positional arrays, a shape its typings cannot express.
// `any[]` here is that gap, not laziness — every value is funnelled through
// normalizeCell() / str() immediately after.
type RawRows = any[];

// Open a connection, bound it server-side, run `body`, and ALWAYS close. The
// backstop timer only exists so a server that ignored the SET cannot wedge the
// main process — it is not the timeout, because destroying a socket does not
// reliably stop work already running on the server.
async function withConnection<T extends { ok: true } | ConnectorError>(
  variant: MysqlVariant,
  ctx: ConnectorContext,
  body: (conn: Connection, plan: TimeoutPlan) => Promise<T>,
): Promise<T | ConnectorError> {
  let conn: Connection | null = null;
  let backstop: NodeJS.Timeout | null = null;
  try {
    conn = await createConnection(connectionOptions(variant, ctx));
    const live = conn;
    backstop = setTimeout(() => {
      try { live.destroy(); } catch (_) { /* already gone */ }
    }, sanitizeTimeoutMs(ctx.timeoutMs) + BACKSTOP_GRACE_MS);

    const plan = await applyServerTimeout(conn, variant, ctx.timeoutMs);
    return await body(conn, plan);
  } catch (err) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  } finally {
    if (backstop) clearTimeout(backstop);
    if (conn) await conn.end().catch(() => { try { conn?.destroy(); } catch (_) { /* ignore */ } });
  }
}

// Apply the declared session-level bound; if this server does not know that
// variable, try the other spellings before giving up. Returns the plan whose
// `prefix` the caller must glue onto its statement (non-empty for MariaDB only).
async function applyServerTimeout(conn: Connection, variant: MysqlVariant, timeoutMs: number): Promise<TimeoutPlan> {
  const declared = timeoutPlanFor(variant.timeout, timeoutMs);
  if (declared.session === null) return declared; // MariaDB: bounded by the prefix instead.

  const order = [variant.timeout, ...SESSION_TIMEOUT_FALLBACKS.filter((d) => d !== variant.timeout)];
  for (const dialect of order) {
    try {
      await conn.query(sessionTimeoutStatement(dialect, timeoutMs));
      return { session: sessionTimeoutStatement(dialect, timeoutMs), prefix: '', dialect };
    } catch (_) {
      // "Unknown system variable" — try the next spelling.
    }
  }
  // Nothing took. The query still runs, bounded only by the socket backstop.
  // Deliberately not fatal: a user with an exotic MySQL-protocol server should
  // still be able to read their data, and the row cap still applies.
  return declared;
}

// ── Connector definitions ─────────────────────────────────────────────────────

export interface MysqlVariant {
  id: string;
  label: string;
  /** Default TCP port. The single most copy-paste-able mistake in this file. */
  port: number;
  blurb: string;
  category: ConnectorDef['category'];
  /** ssl checkbox default. */
  sslDefault: boolean;
  /** TLS is not optional for this product — the checkbox cannot turn it off. */
  sslRequired?: boolean;
  timeout: TimeoutDialect;
  /** Some hosted plans expose no usable information_schema; go straight to
   *  SHOW TABLES rather than showing the user an error first. */
  listVia: 'information_schema' | 'show_tables';
  sslHelp?: string;
}

export const VARIANTS: MysqlVariant[] = [
  {
    id: 'mysql',
    label: 'MySQL',
    port: 3306,
    blurb: 'MySQL 5.7 or later, over the standard client protocol.',
    category: 'Databases',
    sslDefault: false,
    timeout: 'max_execution_time',
    listVia: 'information_schema',
  },
  {
    id: 'mariadb',
    label: 'MariaDB',
    port: 3306,
    blurb: 'MariaDB server. Bounded with max_statement_time, not max_execution_time.',
    category: 'Databases',
    sslDefault: false,
    // MariaDB forked before max_execution_time existed and never adopted it.
    timeout: 'max_statement_time',
    listVia: 'information_schema',
  },
  {
    id: 'aurora-mysql',
    label: 'Amazon Aurora (MySQL)',
    port: 3306,
    blurb: 'Aurora MySQL-compatible cluster endpoint. TLS on by default.',
    category: 'Databases',
    sslDefault: true, // Aurora endpoints accept TLS and are reached over a network we do not control.
    timeout: 'max_execution_time',
    listVia: 'information_schema',
    sslHelp: 'Aurora endpoints support TLS; leave this on unless your cluster has it disabled.',
  },
  {
    id: 'singlestore',
    label: 'SingleStore',
    port: 3306,
    blurb: 'SingleStore (formerly MemSQL), over the MySQL protocol.',
    // An MPP analytics engine rather than an OLTP database — grouped with the
    // other distributed query engines in the picker.
    category: 'Query engines',
    sslDefault: false,
    timeout: 'max_execution_time',
    listVia: 'information_schema',
  },
  {
    id: 'tidb',
    label: 'TiDB',
    port: 4000,
    blurb: 'TiDB. Note the default port is 4000, not 3306.',
    category: 'Databases',
    sslDefault: false,
    timeout: 'max_execution_time',
    listVia: 'information_schema',
  },
  {
    id: 'planetscale',
    label: 'PlanetScale',
    port: 3306,
    blurb: 'PlanetScale (Vitess). TLS is required and tables are listed with SHOW TABLES.',
    category: 'Databases',
    sslDefault: true,
    sslRequired: true, // PlanetScale refuses unencrypted connections outright.
    timeout: 'max_execution_time',
    // Some PlanetScale plans do not expose a usable information_schema through
    // the Vitess routing layer; SHOW TABLES always works.
    listVia: 'show_tables',
    sslHelp: 'PlanetScale requires TLS — this cannot be turned off.',
  },
  {
    id: 'starrocks',
    label: 'StarRocks',
    port: 9030,
    blurb: 'StarRocks FE query port (9030), over the MySQL protocol.',
    category: 'Query engines',
    sslDefault: false,
    timeout: 'query_timeout',
    listVia: 'information_schema',
  },
  {
    id: 'doris',
    label: 'Apache Doris',
    port: 9030,
    blurb: 'Apache Doris FE query port (9030), over the MySQL protocol.',
    category: 'Query engines',
    sslDefault: false,
    timeout: 'query_timeout',
    listVia: 'information_schema',
  },
];

function fieldsFor(v: MysqlVariant): ConnectorField[] {
  return [
    { key: 'host', label: 'Host', type: 'text', required: true, default: 'localhost', placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', type: 'number', required: true, default: v.port },
    { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'analytics' },
    { key: 'user', label: 'User', type: 'text', required: true },
    // secret:true routes this to config.connectionSecrets — never the project
    // folder, never a renderer. Rule 2 in types.ts.
    { key: 'password', label: 'Password', type: 'password', secret: true },
    {
      key: 'ssl',
      label: 'Use TLS',
      type: 'checkbox',
      default: v.sslRequired ? true : v.sslDefault,
      help: v.sslHelp ?? 'Encrypts the connection. The server certificate is not verified against a CA.',
    },
  ];
}

// ── listTables / run ──────────────────────────────────────────────────────────

// Parameterized: the database name is a VALUE here, bound with `?`, never
// concatenated. An empty database means "every non-system schema".
const INFO_SCHEMA_SQL =
  `SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.tables
     WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
       AND (? = '' OR TABLE_SCHEMA = ?)
     ORDER BY TABLE_SCHEMA, TABLE_NAME
     LIMIT ${MAX_TABLES}`;

/** `SHOW TABLES [FROM db]`. The database is an IDENTIFIER here and cannot be a
 *  bound parameter, so it is backtick-quoted by quoteIdent. */
export function showTablesSql(database: string): string {
  return database ? `SHOW TABLES FROM ${quoteIdent(database)}` : 'SHOW TABLES';
}

async function listTables(variant: MysqlVariant, ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const database = str(ctx.values.database).trim();
  return withConnection(variant, ctx, async (conn, plan) => {
    if (variant.listVia === 'information_schema') {
      try {
        const [rows] = await conn.query<RawRows>(plan.prefix + INFO_SCHEMA_SQL, [database, database]);
        return {
          ok: true as const,
          tables: (rows || []).map((r: unknown[]) => ({ schema: str(r[0]), name: str(r[1]) })),
        };
      } catch (_) {
        // Fall through to SHOW TABLES — a hosted plan may hide information_schema
        // (PlanetScale is the known case, but it is not the only one).
      }
    }
    const [rows] = await conn.query<RawRows>(plan.prefix + showTablesSql(database));
    // SHOW TABLES takes no LIMIT clause, so the cap is applied here instead —
    // the only place in this module where a bound is client-side rather than
    // server-side, and it is a metadata list, not a data read.
    const tables = (rows || [])
      .slice(0, MAX_TABLES)
      .map((r: unknown[]) => ({ schema: database || undefined, name: str(r[0]) }));
    return { ok: true as const, tables };
  });
}

async function run(variant: MysqlVariant, ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const inner = str(sql).trim();
  if (!inner) return { ok: false, error: 'No query specified' };
  const cap = effectiveRowLimit(ctx.rowLimit);

  return withConnection(variant, ctx, async (conn, plan) => {
    const [rows, fields] = await conn.query<RawRows>(plan.prefix + wrapSelect(inner, cap));
    const all = Array.isArray(rows) ? rows : [];
    // The probe row proves the cap clipped. Report it; never trim silently.
    const truncated = all.length > cap;
    const body = truncated ? all.slice(0, cap) : all;
    return {
      ok: true as const,
      columns: (fields || []).map((f: FieldPacket) => ({ name: str(f.name), type: columnTypeName(f) })),
      rows: body.map((r: unknown[]) => (Array.isArray(r) ? r.map(normalizeCell) : [normalizeCell(r)])),
      truncated,
    };
  });
}

/**
 * One table's columns out of `information_schema.columns`, fully parameterised.
 *
 * The schema and table arrive from a renderer and are BOUND with `?` — never
 * backtick-quoted into the text, which is what `run` has to do because it
 * builds a FROM clause. `TABLE_SCHEMA` falls back to the connection's own
 * database when the tree sends an unqualified name, then to any non-system
 * schema, so a source listed via `SHOW TABLES` (PlanetScale) describes too.
 *
 * `information_schema.tables.TABLE_ROWS` is the estimate. On InnoDB it is a
 * sampled figure that can be off by a wide margin — which is exactly why the
 * contract calls it `rowEstimate` and the tree renders it as "~". It is read in
 * its own try: no estimate is a missing nicety, not a failed describe.
 */
const DESCRIBE_COLUMNS_SQL =
  `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.columns
     WHERE TABLE_NAME = ?
       AND (? = '' OR TABLE_SCHEMA = ?)
       AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
     ORDER BY TABLE_SCHEMA, ORDINAL_POSITION`;

const DESCRIBE_ROWS_SQL =
  `SELECT TABLE_ROWS FROM information_schema.tables
     WHERE TABLE_NAME = ? AND (? = '' OR TABLE_SCHEMA = ?) LIMIT 1`;

async function describeTable(
  variant: MysqlVariant,
  ctx: ConnectorContext,
  table: string,
): Promise<ConnectorSchema | ConnectorError> {
  const parts = str(table).trim().split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !p)) {
    return { ok: false, error: 'Invalid table name' };
  }
  // An unqualified name is looked up in the connection's own database first —
  // which is what the user means by `orders` when they connected to `shop`.
  const schema = parts.length === 2 ? parts[0] : str(ctx.values.database).trim();
  const name = parts[parts.length - 1];

  return withConnection(variant, ctx, async (conn, plan) => {
    const [rows] = await conn.query<RawRows>(
      plan.prefix + DESCRIBE_COLUMNS_SQL, [name, schema, schema],
    );
    const columns = (rows || []).map((r: unknown[]) => {
      const col: { name: string; type: string; nullable?: boolean } = {
        name: str(r[0]),
        type: str(r[1]),
      };
      const nullable = str(r[2]).toUpperCase();
      if (nullable === 'YES' || nullable === 'NO') col.nullable = nullable === 'YES';
      return col;
    }).filter((c) => c.name);
    if (columns.length === 0) return { ok: false as const, error: `No such table: ${name}` };

    const out: ConnectorSchema = { ok: true as const, columns };
    try {
      const [est] = await conn.query<RawRows>(
        plan.prefix + DESCRIBE_ROWS_SQL, [name, schema, schema],
      );
      const n = Number((est || [])[0]?.[0]);
      if (Number.isFinite(n) && n >= 0) out.rowEstimate = Math.round(n);
    } catch (_) {
      /* a hosted plan may hide information_schema.tables — see listTables */
    }
    return out;
  });
}

export const CONNECTORS: ConnectorDef[] = VARIANTS.map((v) => ({
  id: v.id,
  label: v.label,
  family: 'mysql',
  category: v.category,
  readOnly: true as const, // Rule 1: there is no write path. See types.ts.
  blurb: v.blurb,
  fields: fieldsFor(v),
  listTables: (ctx: ConnectorContext) => listTables(v, ctx),
  run: (ctx: ConnectorContext, sql: string) => run(v, ctx, sql),
  describeTable: (ctx: ConnectorContext, table: string) => describeTable(v, ctx, table),
}));
