// The PostgreSQL wire-protocol connector family. MAIN PROCESS ONLY.
//
// Eleven sources ship from this file. They are not eleven implementations —
// they are ONE driver plus a table of per-vendor facts (default port, whether
// TLS is effectively mandatory, and how to list tables when the vendor's
// `information_schema` is not the standard one). Anything that is genuinely the
// same for all eleven — the read-only wrapper, the row cap, the server-side
// timeout, secret redaction, closing the client — exists exactly once, because
// eleven copies of a security property is eleven chances to get it wrong.
//
// The driver is a direct descendant of `src/connectionRun.ts`'s `pgListTables` /
// `pgRun`, and deliberately keeps every guarantee that file already made:
//
//   • parameterised `information_schema` listing (values are BOUND, never
//     concatenated),
//   • a table name is whitelist-validated AND double-quoted before it can reach
//     SQL text,
//   • the user's own SQL runs inside `select * from ( … ) limit n`,
//   • the query is bounded by a SERVER-side `statement_timeout`,
//   • the client is closed in a `finally`, on every path.
//
// Two things are deliberately DIFFERENT from `connectionRun.ts`, and both are
// tightenings rather than features:
//
//   1. TLS no longer means `rejectUnauthorized: false`. `connectionRun` disabled
//      certificate verification whenever `ssl` was on, which buys encryption
//      but not authentication — an on-path attacker can still be the server.
//      Here verification is ON by default and turning it off is a separate,
//      explicit checkbox whose `help` text says exactly what it costs.
//   2. The session is asked to be read-only (`default_transaction_read_only`)
//      before anything runs. The sub-select wrapper alone does NOT make a query
//      read-only: Postgres allows data-modifying CTEs, so
//      `select * from (with x as (insert … returning *) select * from x) t` is
//      a perfectly legal write inside a SELECT. The session flag closes that.
//      It is best-effort (see `applyGuards`) because not every engine here has
//      the setting, so it is a second lock, never the only one.
//
// ── Two things this file could not verify without a live server ──────────────
// Marked `// UNVERIFIED` at each site, and repeated here so they are not
// discovered by a user first:
//   • Redshift's `svv_external_tables` column names (`schemaname`/`tablename`)
//     and the exact set of objects `information_schema.tables` omits on a
//     late-binding view.
//   • Whether QuestDB / Materialize / RisingWave accept `set statement_timeout`
//     and expose `information_schema.tables`. Both are handled by falling back,
//     never by assuming.

import { isIP } from 'net';
import { Client, types as pgTypes } from 'pg';
import type {
  ConnectorColumn,
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorField,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTable,
  ConnectorTables,
  LiveParam,
} from './types';
import { safeError } from './types';
import { checkParams, isParamError } from './liveParams';

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Ceiling on the table picker. A warehouse can hold six figures of tables and
 *  the picker is a list, not a search engine. Also bounded by ctx.rowLimit. */
const MAX_TABLES = 1000;

/** Floor for the server-side statement timeout. `ctx.timeoutMs` is the budget
 *  for the WHOLE operation, so the query gets what connecting did not spend —
 *  but never a value so small that a healthy query is killed on arrival. */
const MIN_STATEMENT_TIMEOUT_MS = 1_000;

/** A Postgres identifier we are willing to interpolate. Verbatim from
 *  `connectionRun.ts` — leading letter/underscore, then letters/digits/_/$.
 *  Identifiers cannot be bound parameters, so this whitelist is the first guard
 *  and `quoteIdent` is the second. */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

/** Doubling an embedded `"` is the WHOLE escape for a delimited identifier:
 *  inside `"…"` a `;`, a newline, `--` or `drop table` is inert text. Same rule
 *  and same reasoning as `src/datasetView.ts` `quoteIdent`. Applied even though
 *  IDENT_RE already forbids a quote, so the two guards are independent. */
function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

/**
 * What counts as "the user typed a query" rather than "the user typed a table
 * name". Deliberately an ALLOWLIST of read-shaped statement starts, because the
 * consequence of guessing wrong in this direction is small (a rejected input
 * with a clear message) and the consequence of guessing wrong in the other
 * direction is that arbitrary text goes to the server inside a sub-select.
 *
 * It is also the cheapest read-only guard in the file: `drop table x`,
 * `insert …` and `update …` are not query starts, so they are judged as table
 * names, fail IDENT_RE, and never reach a socket. `with … (insert … returning)`
 * DOES start like a query — that hole is what `default_transaction_read_only`
 * in `applyGuards` is for.
 *
 * `\b` matters: `selection`, `with_totals` and `table_sales` are table names,
 * not statements, and a word boundary is what keeps them that way.
 */
const QUERY_START_RE = /^\(|^(select|with|values|table)\b/i;

// ── Value coercion off ConnectorContext.values (all `unknown`) ────────────────

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true' || v === '1' || v === 'on';
}

function asPort(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(asString(v), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

// ── Per-vendor facts ─────────────────────────────────────────────────────────

/** One table-listing attempt. Tried in order; the first that answers wins. */
interface ListQuery {
  sql: string;
  /** Result column positions. `schema: -1` means the source has no schemas. */
  schema: number;
  name: number;
  /** True when `sql` references `$1` and wants the schema filter bound. */
  wantsSchemaParam: boolean;
}

interface PgVariant {
  id: string;
  label: string;
  category: ConnectorDef['category'];
  blurb: string;
  /** The vendor's documented default port for its PostgreSQL endpoint. */
  port: number;
  /** TLS prefilled ON where the vendor's public endpoint requires it. */
  ssl: boolean;
  /** Tried in order. Omitted → STANDARD_LIST. */
  list?: ListQuery[];
  /** false → a rejected `set statement_timeout` is tolerated instead of fatal.
   *  Only for engines that speak the wire protocol without being Postgres. */
  statementTimeoutVerified: boolean;
  /** Set on a warehouse that can answer a Live dataset itself (plan D2): `runBound`. */
  live?: 'redshift';
}

// The standard listing: parameterised, catalog schemas excluded, ordered. This
// is `connectionRun.pgListTables` with an optional bound schema filter added.
// `$1::text is null` lets ONE statement serve both "all schemas" and "one
// schema" without building SQL by string concatenation.
const STANDARD_LIST: ListQuery[] = [
  {
    sql: `select table_schema, table_name
            from information_schema.tables
           where table_schema not in ('pg_catalog', 'information_schema')
             and ($1::text is null or table_schema = $1::text)
           order by table_schema, table_name`,
    schema: 0,
    name: 1,
    wantsSchemaParam: true,
  },
];

const VARIANTS: PgVariant[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    category: 'Databases',
    blurb: 'Read-only access to a PostgreSQL database.',
    port: 5432,
    ssl: false, // Usually reached over a private network or localhost.
    statementTimeoutVerified: true,
  },
  {
    id: 'amazon-redshift',
    label: 'Amazon Redshift',
    category: 'Cloud warehouses',
    blurb: 'Read-only access to a Redshift cluster or Serverless workgroup.',
    port: 5439, // Redshift's own default, NOT 5432.
    ssl: true, // Reached over the public internet; clusters commonly require SSL.
    statementTimeoutVerified: true, // Redshift implements statement_timeout (ms).
    live: 'redshift',
    list: [
      // WHY a Redshift-specific query: `information_schema.tables` on Redshift
      // does not report Spectrum/external tables, which live in external
      // schemas and are listed by `svv_external_tables` instead. A user whose
      // data lake is the whole point of their cluster would see an empty
      // picker. The UNION covers both; if the account cannot read
      // `svv_external_tables` the whole statement fails and the plain
      // information_schema attempt below still answers.
      // UNVERIFIED: the `schemaname`/`tablename` column names of
      // SVV_EXTERNAL_TABLES are from documentation, not from a live cluster —
      // which is exactly why this is a fallback ladder and not one statement.
      {
        sql: `select table_schema, table_name
                from information_schema.tables
               where table_schema not in ('pg_catalog', 'information_schema')
                 and ($1::text is null or table_schema = $1::text)
              union
              select schemaname, tablename
                from svv_external_tables
               where ($1::text is null or schemaname = $1::text)
               order by 1, 2`,
        schema: 0,
        name: 1,
        wantsSchemaParam: true,
      },
      ...STANDARD_LIST,
    ],
  },
  {
    id: 'cockroachdb',
    label: 'CockroachDB',
    category: 'Databases',
    blurb: 'Read-only access to a CockroachDB cluster over its SQL port.',
    port: 26257, // CockroachDB's SQL port.
    // Cockroach *Cloud* requires TLS, but this entry also covers a self-hosted
    // `--insecure` cluster, so it is off by default and one checkbox away.
    ssl: false,
    statementTimeoutVerified: true,
  },
  {
    id: 'alloydb',
    label: 'Google AlloyDB',
    category: 'Cloud warehouses',
    blurb: 'Read-only access to an AlloyDB for PostgreSQL cluster.',
    port: 5432,
    ssl: true, // Public-IP connections require SSL.
    statementTimeoutVerified: true,
  },
  {
    id: 'neon',
    label: 'Neon',
    category: 'Cloud warehouses',
    blurb: 'Read-only access to a Neon serverless Postgres branch.',
    port: 5432,
    ssl: true, // Neon refuses a plaintext connection.
    statementTimeoutVerified: true,
  },
  {
    id: 'supabase',
    label: 'Supabase',
    category: 'Cloud warehouses',
    blurb: 'Read-only access to a Supabase project database.',
    port: 5432, // Direct connection. The pooler answers on 6543 — user-editable.
    ssl: true, // Supabase requires TLS on the public endpoint.
    statementTimeoutVerified: true,
  },
  {
    id: 'timescaledb',
    label: 'TimescaleDB',
    category: 'Databases',
    blurb: 'Read-only access to a TimescaleDB (PostgreSQL extension) database.',
    port: 5432, // An extension on stock Postgres — same port, same catalogs.
    ssl: false,
    statementTimeoutVerified: true,
  },
  {
    id: 'yugabytedb',
    label: 'YugabyteDB',
    category: 'Databases',
    blurb: 'Read-only access to a YugabyteDB cluster over the YSQL API.',
    // 5433, not 5432: YSQL's default port. 5432 on a Yugabyte node is nothing,
    // and 7000/9000 are the admin UIs. Getting this wrong is a connection
    // refused with no hint as to why, so it is pinned by a test.
    port: 5433,
    ssl: false,
    statementTimeoutVerified: true,
  },
  {
    id: 'materialize',
    label: 'Materialize',
    category: 'Databases',
    blurb: 'Read-only access to a Materialize instance over its pgwire port.',
    port: 6875,
    ssl: false,
    // UNVERIFIED: Materialize documents a `statement_timeout` session variable
    // but this was not exercised against a live instance. Tolerated rather than
    // fatal — see `applyGuards` for what that costs.
    statementTimeoutVerified: false,
    list: [
      // Materialize's information_schema is documented as partial. Try it, then
      // fall back to `show tables`, which is native and returns the object name
      // in its first column (read POSITIONALLY, so a differing column name
      // between versions cannot break the listing).
      ...STANDARD_LIST,
      { sql: 'show tables', schema: -1, name: 0, wantsSchemaParam: false },
    ],
  },
  {
    id: 'questdb',
    label: 'QuestDB',
    category: 'Databases',
    blurb: 'Read-only access to QuestDB over its PostgreSQL wire port.',
    port: 8812, // QuestDB's pgwire port (9000 is the HTTP/REST endpoint).
    ssl: false,
    // UNVERIFIED: QuestDB implements a subset of pgwire and its handling of
    // `set statement_timeout` was not confirmed. Tolerated, not fatal.
    statementTimeoutVerified: false,
    list: [
      // QuestDB has no schemas, so the standard statement's `table_schema`
      // predicate and its bound parameter are both meaningless here — and
      // QuestDB's parameter support in pgwire is limited. Ask for the two
      // columns unfiltered first…
      {
        sql: 'select table_schema, table_name from information_schema.tables order by 1, 2',
        schema: 0,
        name: 1,
        wantsSchemaParam: false,
      },
      // …and fall back to `show tables`, which QuestDB has had far longer than
      // its information_schema. One column, read positionally.
      { sql: 'show tables', schema: -1, name: 0, wantsSchemaParam: false },
    ],
  },
  {
    id: 'risingwave',
    label: 'RisingWave',
    category: 'Databases',
    blurb: 'Read-only access to a RisingWave streaming database.',
    port: 4566,
    ssl: false,
    // UNVERIFIED against a live instance; RisingWave tracks Postgres closely
    // but is not Postgres. Tolerated, not fatal.
    statementTimeoutVerified: false,
    list: [
      ...STANDARD_LIST,
      { sql: 'show tables', schema: -1, name: 0, wantsSchemaParam: false },
    ],
  },
];

// ── Form ─────────────────────────────────────────────────────────────────────

function buildFields(v: PgVariant): ConnectorField[] {
  return [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', type: 'number', required: true, default: v.port },
    { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'postgres' },
    { key: 'user', label: 'User', type: 'text', required: true },
    // The ONLY secret on this form. `secret: true` routes it to
    // config.connectionSecrets instead of the project record — the project
    // folder is shareable, so a password landing there is the worst failure
    // this family has. Pinned by a test for exactly that reason.
    { key: 'password', label: 'Password', type: 'password', secret: true },
    {
      key: 'schema',
      label: 'Schema',
      type: 'text',
      placeholder: 'all schemas',
      help: 'Optional. Limits the table list to one schema. Sent as a bound query parameter, never as SQL text.',
    },
    { key: 'ssl', label: 'Use TLS', type: 'checkbox', default: v.ssl },
    {
      key: 'sslInsecure',
      label: 'Trust an unverified certificate',
      type: 'checkbox',
      default: false,
      help: 'Off by default. Turning it on keeps the connection encrypted but stops checking WHO is on the other end, so anyone able to intercept the network can impersonate the server. Only for a private network with a self-signed certificate.',
    },
  ];
}

// ── Driver ───────────────────────────────────────────────────────────────────

/** Everything `new Client(…)` needs, resolved from ctx. */
function clientConfig(v: PgVariant, ctx: ConnectorContext): ConstructorParameters<typeof Client>[0] {
  const useSsl = asBool(ctx.values.ssl);
  const insecure = asBool(ctx.values.sslInsecure);
  // Server (T6.1): connect to the address the SSRF guard checked; TLS still
  // verifies the typed name (pg only sets servername itself for a non-IP host).
  const pin = ctx.pinned;
  const servername = pin && isIP(pin.host) === 0 ? { servername: pin.host } : {};
  return {
    host: pin ? pin.address : asString(ctx.values.host),
    port: asPort(ctx.values.port, v.port),
    database: asString(ctx.values.database),
    user: asString(ctx.values.user),
    password: ctx.secrets.password || '',
    // Verification ON unless the user explicitly opted out. See header note 1.
    ssl: useSsl ? { rejectUnauthorized: !insecure, ...servername } : undefined,
    connectionTimeoutMillis: ctx.timeoutMs,
    // JS-side backstop ONLY. It makes the call RETURN; it does not stop the
    // server working (or billing). The server-side bound is set in applyGuards.
    query_timeout: ctx.timeoutMs,
  };
}

/**
 * The two session guards, issued as ordinary statements after connect.
 *
 * WHY not the startup packet: `pg` puts a `statement_timeout` client option
 * into the STARTUP message (see node_modules/pg/lib/client.js getStartupConf).
 * A server that does not know that GUC answers FATAL and the connection never
 * opens — so on a pgwire-compatible engine the startup route would turn a
 * missing timeout into a missing connector. Sent as a statement, a rejection is
 * one failed query we can decide about.
 *
 * The timeout value is an integer we computed, not user text; `set` does not
 * accept a bound parameter, so interpolation is unavoidable and safe here.
 */
async function applyGuards(v: PgVariant, client: Client, ctx: ConnectorContext, startedAt: number): Promise<void> {
  // Read-only first: if anything below throws, the session is already locked.
  // Best-effort by design — not every engine here has the setting, and its
  // absence must not remove a source. The sub-select wrapper and the read-only
  // credentials the user connects with remain the primary guards.
  try {
    await client.query('set default_transaction_read_only to on');
  } catch {
    /* engine has no such setting — see the comment above */
  }

  // `ctx.timeoutMs` is the budget for the WHOLE operation, so the query gets
  // what connecting did not spend.
  const spent = Date.now() - startedAt;
  const budget = Math.max(MIN_STATEMENT_TIMEOUT_MS, Math.floor(ctx.timeoutMs - spent));
  try {
    await client.query(`set statement_timeout to ${budget}`);
  } catch (e) {
    // On real Postgres this cannot fail for any reason that leaves the session
    // usable, so a failure is a genuine error. On the three engines flagged
    // UNVERIFIED it may simply be unsupported; we continue with only the
    // JS-side `query_timeout`, which returns control but leaves the server
    // running the query. That degradation is documented rather than hidden.
    if (v.statementTimeoutVerified) throw e;
  }
}

/** The rowMode:'array' result shape. @types/pg's overloads do not line up with
 *  a `{text, rowMode, values}` object literal, so the cast is confined here. */
interface ArrayResult {
  fields?: { name: string; dataTypeID: number }[];
  rows?: unknown[][];
}

async function queryArray(client: Client, text: string, values?: unknown[]): Promise<ArrayResult> {
  // queryMode 'extended' (T6.3): ONE statement per call. Without values pg uses
  // the simple protocol, which runs `select 1 ) x; commit; begin read write;
  // delete …` as four statements — past the read-only session and the LIMIT.
  const cfg = { text, rowMode: 'array', values, queryMode: 'extended' } as unknown as Parameters<Client['query']>[0];
  return (await client.query(cfg)) as unknown as ArrayResult;
}

/** Connect, run `fn`, and close the client — ALWAYS, on every path. */
async function withClient<T>(
  v: PgVariant,
  ctx: ConnectorContext,
  fn: (client: Client) => Promise<T | ConnectorError>,
): Promise<T | ConnectorError> {
  const startedAt = Date.now();
  const client = new Client(clientConfig(v, ctx));
  try {
    await client.connect();
    await applyGuards(v, client, ctx, startedAt);
    return await fn(client);
  } catch (e) {
    // `pg` puts host, port, database and sometimes the whole DSN in its error
    // messages. Nothing reaches a renderer without passing through here.
    return { ok: false, error: safeError(e, ctx.secrets) };
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Column types ─────────────────────────────────────────────────────────────

let oidNames: Map<number, string> | null = null;

/** The SOURCE's type name, verbatim — read out of `pg`'s own builtin OID table
 *  rather than a hand-copied list, so it cannot drift. An OID we do not know
 *  (an extension type, or a pgwire engine's own) reports `oid_<n>`: honest and
 *  useless beats plausible and wrong, because the caller maps this to a
 *  ColumnType and `007` must stay text. */
function typeName(oid: number): string {
  if (!oidNames) {
    oidNames = new Map<number, string>();
    const builtins = (pgTypes as unknown as { builtins?: Record<string, unknown> } | undefined)?.builtins;
    for (const [k, val] of Object.entries(builtins || {})) {
      if (typeof val === 'number' && !oidNames.has(val)) oidNames.set(val, k.toLowerCase());
    }
  }
  return oidNames.get(oid) || `oid_${oid}`;
}

/** Narrow a driver value to what ConnectorRows allows. Dates become ISO strings
 *  and structured values become JSON, matching `connectionRun.cellToString`;
 *  a bigint becomes a string because a JS number would silently lose digits. */
function cellValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Buffer) return v.toString('base64');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

async function listTables(v: PgVariant, ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const schemaFilter = asString(ctx.values.schema);
  const cap = Math.max(1, Math.min(MAX_TABLES, Math.floor(ctx.rowLimit) || MAX_TABLES));
  const candidates = v.list && v.list.length ? v.list : STANDARD_LIST;

  return withClient<ConnectorTables>(v, ctx, async (client) => {
    let firstError: unknown = null;

    for (const c of candidates) {
      try {
        // The schema is a VALUE and is bound as one — it is never concatenated,
        // so a name like `evil"; drop table x; --` is inert data on the wire.
        const values = c.wantsSchemaParam ? [schemaFilter || null] : undefined;
        // The cap is our own integer. `limit` cannot take a bound parameter on
        // every engine here, so it is interpolated after Math.floor.
        const res = await queryArray(client, `${c.sql} limit ${cap}`, values);
        const rows = res.rows || [];
        const tables: ConnectorTable[] = [];
        for (const row of rows) {
          const name = asString(row[c.name]);
          if (!name) continue;
          const schema = c.schema >= 0 ? asString(row[c.schema]) : '';
          tables.push(schema ? { schema, name } : { name });
        }
        return { ok: true, tables };
      } catch (e) {
        // A candidate failing is expected — that is what the ladder is for.
        // Keep the FIRST error: candidate 1 is the intended path, so its
        // message is the one that explains a total failure.
        if (firstError === null) firstError = e;
      }
    }
    return { ok: false, error: safeError(firstError, ctx.secrets) };
  });
}

/**
 * `sql` is either the user's own SELECT or a bare (optionally schema-qualified)
 * table name — the same two shapes `connectionRun.pgRun` accepted. A bare name
 * is unambiguous because `select * from ( public.sales ) t` is not valid SQL,
 * so nothing a user could mean as a query is read as a table.
 */
async function run(v: PgVariant, ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const input = typeof sql === 'string' ? sql.trim() : '';
  if (!input) return { ok: false, error: 'No table or query specified' };

  const cap = Math.max(1, Math.floor(ctx.rowLimit) || 1);
  // Ask for ONE more row than the cap. If it comes back, the cap clipped the
  // result and `truncated` says so; the extra row is dropped. Guessing
  // truncation from `rows.length === cap` would cry wolf on an exact fit.
  const probe = cap + 1;

  let text: string;
  if (QUERY_START_RE.test(input)) {
    // Their database, their SQL — but always sub-select wrapped so the row cap
    // applies no matter what they wrote. A trailing `;` would end the statement
    // before the wrapper's `limit`, so strip it (verbatim from connectionRun).
    // Their text on its OWN line (T6.3): a trailing `--` comment would
    // otherwise swallow the wrapper's `) … limit` and lift the row cap.
    text = `select * from (\n${input.replace(/;\s*$/, '')}\n) as _ord_wrap limit ${probe}`;
  } else {
    // Anything that is not recognisably a query is treated as a TABLE NAME and
    // must survive the whitelist. This is what makes a hostile string safe:
    // `evil"; drop table x; --` is not a query start, so it is judged as a
    // table name, fails IDENT_RE, and is rejected here — before a client is
    // opened, so nothing at all reaches the server.
    const parts = input.split('.');
    if (parts.length > 2 || !parts.every((p) => IDENT_RE.test(p))) {
      return { ok: false, error: 'Invalid table name' };
    }
    // Whitelisted above, then quoted here. Two independent guards: the regex
    // forbids a `"` from ever existing in the name, and `quoteIdent` doubles
    // one anyway, so neither alone has to be perfect.
    text = `select * from ${parts.map(quoteIdent).join('.')} limit ${probe}`;
  }

  return withClient<ConnectorRows>(v, ctx, async (client) => {
    // rowMode:'array' → rows are positional, so `select *` across a join with
    // duplicate column names does not collide the way an object would.
    const res = await queryArray(client, text);
    const columns: ConnectorColumn[] = (res.fields || []).map((f) => ({
      name: String(f.name),
      type: typeName(Number(f.dataTypeID)),
    }));
    const raw = res.rows || [];
    const truncated = raw.length > cap;
    const rows = (truncated ? raw.slice(0, cap) : raw).map((row) => row.map(cellValue));
    return { ok: true, columns, rows, truncated };
  });
}

/**
 * One table's columns, out of `information_schema.columns`.
 *
 * Everything the caller supplies is BOUND, never concatenated: the schema and
 * the table arrive from a renderer, so they are `$1`/`$2` and a name like
 * `x"; drop table y; --` is inert text on the wire. That is a stronger guard
 * than `run`'s, which has to interpolate because it builds a FROM clause.
 *
 * An unqualified name matches in ANY non-catalog schema, which is what the tree
 * sends for a source whose `listTables` reported no schema. Ordering by
 * `table_schema` keeps that deterministic rather than whichever row came back
 * first.
 *
 * The row estimate is `pg_class.reltuples` — the planner's number, updated by
 * ANALYZE/autovacuum, `-1` on a table that has never been analysed. It is an
 * ESTIMATE and the UI says so; `count(*)` on a warehouse table is not something
 * to run because a tree node came into view. A failure to read it is not a
 * failure to describe the table, so it is caught separately.
 */
const COLUMNS_SQL = `select column_name, data_type, is_nullable
                       from information_schema.columns
                      where table_name = $2
                        and ($1::text is null or table_schema = $1::text)
                        and table_schema not in ('pg_catalog', 'information_schema')
                      order by table_schema, ordinal_position`;

const ESTIMATE_SQL = `select c.reltuples
                        from pg_class c
                        join pg_namespace n on n.oid = c.relnamespace
                       where c.relname = $2
                         and ($1::text is null or n.nspname = $1::text)
                       limit 1`;

async function describeTable(
  v: PgVariant,
  ctx: ConnectorContext,
  table: string,
): Promise<ConnectorSchema | ConnectorError> {
  const parts = String(table || '').trim().split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((p) => !p)) {
    return { ok: false, error: 'Invalid table name' };
  }
  const schema = parts.length === 2 ? parts[0] : null;
  const name = parts[parts.length - 1];

  return withClient<ConnectorSchema>(v, ctx, async (client) => {
    const res = await queryArray(client, COLUMNS_SQL, [schema, name]);
    const columns = (res.rows || []).map((row) => {
      const col: { name: string; type: string; nullable?: boolean } = {
        name: asString(row[0]),
        type: asString(row[1]),
      };
      const isNullable = asString(row[2]).toUpperCase();
      if (isNullable === 'YES' || isNullable === 'NO') col.nullable = isNullable === 'YES';
      return col;
    }).filter((c) => c.name);
    if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };

    const out: ConnectorSchema = { ok: true, columns };
    try {
      const est = await queryArray(client, ESTIMATE_SQL, [schema, name]);
      const n = Number((est.rows || [])[0]?.[0]);
      // reltuples is -1 on a never-analysed table and a float otherwise.
      if (Number.isFinite(n) && n >= 0) out.rowEstimate = Math.round(n);
    } catch {
      /* no estimate is a missing nicety, not a failed describe */
    }
    return out;
  });
}

// ── Live (Redshift) ──────────────────────────────────────────────────────────
//
// docs/live-data/00-plan.md L2.1, D4: one statement the live compiler wrote,
// its values as `$n` binds — never SQL text — under the same guards as `run`
// (read-only session, server-side statement_timeout, the client closed on
// every path, the SSRF-pinned address). The row cap is the same wrapper with
// the statement on its own line (rule F3); the outer select is a plain
// projection, so the compiled ORDER BY's order is what comes back.

/** The text and values a bound query sends. Exported: the self-check pins that a value never reaches the text. */
export function redshiftBound(
  sql: string,
  rawParams: unknown,
  rowLimit: number,
): { text: string; values: (string | number | boolean | null)[] } | ConnectorError {
  const params = checkParams(rawParams);
  if (isParamError(params)) return params;
  const input = typeof sql === 'string' ? sql.trim().replace(/;\s*$/, '') : '';
  if (!input) return { ok: false, error: 'No query specified' };
  const probe = Math.max(1, Math.floor(rowLimit) || 1) + 1;
  return { text: `select * from (\n${input}\n) as _ord_live limit ${probe}`, values: params.map((p) => p.value) };
}

/** Stop a running statement from a second session: the hang-up must stop the warehouse, not just our wait. */
async function cancelBackend(v: PgVariant, ctx: ConnectorContext, pid: unknown): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return;
  const client = new Client(clientConfig(v, { ...ctx, timeoutMs: 5_000 }));
  try {
    await client.connect();
    await queryArray(client, 'select pg_cancel_backend($1)', [pid]);
  } catch {
    /* best effort: statement_timeout still bounds it */
  } finally {
    await client.end().catch(() => {});
  }
}

async function runBound(v: PgVariant, ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError> {
  const bound = redshiftBound(sql, params, ctx.rowLimit);
  if ('ok' in bound) return bound;
  const cap = Math.max(1, Math.floor(ctx.rowLimit) || 1);
  const signal = ctx.signal;
  if (signal?.aborted) return { ok: false, error: 'Cancelled' };
  return withClient<ConnectorRows>(v, ctx, async (client) => {
    if (signal?.aborted) return { ok: false, error: 'Cancelled' };
    const pid: unknown = (client as unknown as { processID?: unknown }).processID;
    const cancel: { done: Promise<void> | null } = { done: null };
    const onAbort = (): void => {
      cancel.done = cancelBackend(v, ctx, pid);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await queryArray(client, bound.text, bound.values);
      const columns: ConnectorColumn[] = (res.fields || []).map((f) => ({ name: String(f.name), type: typeName(Number(f.dataTypeID)) }));
      const raw = res.rows || [];
      const truncated = raw.length > cap;
      return { ok: true, columns, rows: (truncated ? raw.slice(0, cap) : raw).map((row) => row.map(cellValue)), truncated };
    } catch (e) {
      if (!cancel.done) throw e;
      await cancel.done; // the statement's own error is "canceling statement due to user request"
      return { ok: false, error: 'Cancelled' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  });
}

// ── The eleven ───────────────────────────────────────────────────────────────

function define(v: PgVariant): ConnectorDef {
  return {
    id: v.id,
    label: v.label,
    family: 'postgres',
    category: v.category,
    readOnly: true,
    blurb: v.blurb,
    fields: buildFields(v),
    listTables: (ctx: ConnectorContext) => listTables(v, ctx),
    run: (ctx: ConnectorContext, sql: string) => run(v, ctx, sql),
    describeTable: (ctx: ConnectorContext, table: string) => describeTable(v, ctx, table),
    ...(v.live ? { live: { dialect: v.live, runBound: (ctx: ConnectorContext, sql: string, params: LiveParam[]) => runBound(v, ctx, sql, params) } } : {}),
  };
}

export const CONNECTORS: ConnectorDef[] = VARIANTS.map(define);

export default CONNECTORS;
