// Local & file-based connectors — MAIN PROCESS ONLY.
//
// Three sources, one implementation, because they share one engine: the DuckDB
// the app already ships (`src/duckdb.ts`). No new dependency, no second engine,
// no extension.
//
//   duckdb-file      ATTACH '<file>' (TYPE DUCKDB, READ_ONLY)
//   parquet-folder   read_parquet('<file>')   one table per *.parquet in a folder
//   csv-folder       read_csv_auto('<file>')  one table per *.csv in a folder
//
// Every call uses `queryAsync`/`execAsync`. NEVER `query`/`exec`: a connector
// runs on user interaction, and the sync bridge blocks the Electron main thread
// on `Atomics.wait` — all five windows, the menu bar and the global hotkey
// (src/duckdb.ts, docs/phase-3b §1).
//
// ═════════════════════════════════════════════════════════════════════════════
// 1. THE HARDENING CONFLICT — measured first, designed around second
// ═════════════════════════════════════════════════════════════════════════════
//
// `src/ipc/mosaic.ts` locks the ONE shared DuckDB connection, once per process,
// irreversibly:
//
//   SET allowed_directories=['<userData>'];
//   SET enable_external_access=false;
//   SET lock_configuration=true;
//
// A connector reads files the user picked, which are by definition OUTSIDE
// `userData`. Measured on this build (DuckDB v1.5.5 via `@duckdb/node-api`
// 1.5.5-r.3, macOS arm64), with the lock applied to `userData` only:
//
//   read_csv_auto('<outside>/a.csv')   Permission Error: Cannot access file
//                                      "…/a.csv" - file system operations are
//                                      disabled by configuration
//   glob('<outside>/*.csv')            Permission Error (same)
//   ATTACH '<outside>/x.duckdb'        Permission Error (same)
//   SET allowed_directories=[…]        Invalid Input Error: Cannot change
//                                      configuration option
//                                      "allowed_directories" - the configuration
//                                      has been locked
//   SET enable_external_access=true    Invalid Input Error (same)
//   LOAD sqlite_scanner                Permission Error: Loading external
//                                      extensions is disabled through
//                                      configuration
//
// So yes — the lock blocks a user-picked path outright, and nothing can be
// widened afterwards. Three further measurements shaped the design:
//
//   • REGISTERING BEFORE THE LOCK WORKS, AND THE LOCK THEN HOLDS IT. Hardening
//     with `[userData, '<outside>']` leaves `read_csv_auto`, `glob` and `ATTACH`
//     on `<outside>` working, while `SET allowed_directories` afterwards is
//     still refused. `allowed_directories` is recursive and DuckDB canonicalises
//     it, so one entry per picked folder is enough.
//   • A SYMLINK IS NOT AN ESCAPE HATCH. A symlink placed *inside* `userData`
//     pointing outside was refused with the same Permission Error — DuckDB
//     resolves it. So "stage a symlink under userData" does not work; only a
//     real byte-for-byte copy would.
//   • `duck.shutdown()` DOES hand back an unhardened engine (the next call
//     spawns a fresh worker and a fresh DuckDB instance — verified: a read
//     outside `userData` succeeds again immediately afterwards). THIS MODULE
//     DELIBERATELY DOES NOT USE THAT. It would silently undo a security control
//     the app applied on purpose, and permanently: `hardenConnection` memoises
//     its promise, so Mosaic would never re-apply the lock and the rest of the
//     process would run unhardened. It is recorded here because it is a hole
//     someone else could walk into, not because it is a solution.
//
// ── The approach chosen: REGISTER FIRST, AND REMEMBER ────────────────────────
// Before its first engine access, this module calls the SAME memoised
// `hardenConnection()` that Mosaic calls — with `[userData, …every folder this
// module has ever been pointed at]`. Whoever calls first wins; this module makes
// sure that when it is first, the user's folders are inside the lock. Mosaic's
// later `ensureHardened()` then returns the identical memoised promise, so
// Mosaic's own guarantee is preserved (userData is always in the list) and both
// features work in the same session.
//
// The folder list is PERSISTED, at `<userData>/connectors/duckdb-dirs.json`, and
// re-sent on every harden. That is what makes the outcome ORDER-INDEPENDENT from
// the second session onward: whichever feature hardens first, the folders are in
// the allow-list because they were remembered before the process started.
//
// Why reuse Mosaic's function rather than issue the three SETs here: there must
// be exactly one owner of a once-per-process irreversible action. Two
// independent "have I hardened yet" flags would mean the second one always
// fails against a locked configuration and records a bogus error in
// `hardeningState()`. The import direction (src → src/ipc) is unusual and is the
// price of that; the alternative was worse.
//
// ── What still breaks, stated plainly ────────────────────────────────────────
// The FIRST QUERY against a folder this module has never seen, in a session
// where the engine is ALREADY locked — because Mosaic opened first, or because a
// DIFFERENT folder was queried earlier in the same session. That second case is
// the real one, and it is not hypothetical: "query folder A, then set up and
// query folder B" fails on B.
//
// Two things narrow it as far as two files can. The lock is applied at the LAST
// responsible moment — the first actual query, never when a connection form
// lists a folder (`noteDir` vs `prepareEngine`), so setting up B and querying it
// in a session that has not queried anything yet works. And the folder is
// recorded on the way in, so a restart is a REAL fix, permanently:
//
//   "…was locked to a fixed set of folders earlier in this session…
//    Restart Ordinate and this connection will work."
//
// THE PROPER FIX IS ONE LINE AND IT IS NOT IN THIS FILE: `main.ts` should call
// `hardenConnection([userData, …folders of every saved connection])` once at
// startup, before `require('./src/ipc/mosaic').register()`. Then every saved
// folder is inside the lock from the first millisecond, in every order, and this
// module's per-call harden becomes belt-and-braces. Doing it here is impossible:
// the saved connections are owned by `connections.ts`, and a connector cannot
// see them.
//
// It is detected by CATCHING the Permission Error and translating it, not by
// parsing the applied SQL back out of `hardeningState()` — the engine's own
// answer is the only reliable one. `scripts/test-connectorsLocal.ts` pins both
// directions in child processes (the lock cannot be undone within one process),
// so a change to `mosaic.ts` breaks loudly here.
//
// REJECTED ALTERNATIVE: staging a copy of the user's file under `userData` when
// the engine is already locked. It works in every order, but it is a second read
// path that would run only in the rare case — the definition of a path that rots
// untested — and it turns a 5 GB Parquet folder into a 5 GB copy. A loud error
// plus a restart is a better trade than a silent copy.
//
// ═════════════════════════════════════════════════════════════════════════════
// 2. TWO CONNECTORS WERE DROPPED. WHY, verbatim
// ═════════════════════════════════════════════════════════════════════════════
//
// `SELECT extension_name, install_mode FROM duckdb_extensions()` on this build:
// only FIVE extensions are STATICALLY_LINKED — `autocomplete`, `core_functions`,
// `icu`, `json`, `parquet`. Everything else is `NOT_INSTALLED` or (on a machine
// that has downloaded it before) `REPOSITORY`.
//
// ── sqlite-file: DROPPED ─────────────────────────────────────────────────────
// `sqlite_scanner` is NOT statically linked. Measured with a clean extension
// directory (a fresh user's machine): `ATTACH '<f>' (TYPE SQLITE, READ_ONLY)`
// took 980 ms and wrote `v1.5.5/osx_arm64/sqlite_scanner.duckdb_extension` into
// it — DuckDB autoloaded the extension BY DOWNLOADING IT FROM THE INTERNET. That
// is a surprise network call, which this app promises not to make ("no telemetry,
// no surprise network calls — OSM tiles are the one declared external fetch"),
// and it is also native code fetched at runtime. After hardening it is not even
// possible: `LOAD sqlite_scanner` → "Permission Error: Loading external
// extensions is disabled through configuration". A connector that works only on
// an un-hardened engine, only with a network connection, and only by downloading
// a binary, is not shippable. Bundling the extension ourselves would mean a
// per-platform binary artifact and `allow_unsigned_extensions` — and `LOAD`
// would still be blocked post-hardening.
//
// This is also why every ATTACH below says `TYPE DUCKDB` explicitly. Measured:
// `ATTACH '<a sqlite file>' AS s (READ_ONLY)` with no TYPE downloaded the sqlite
// extension; the same ATTACH with `TYPE DUCKDB` failed in 3 ms with "IO Error:
// The file … exists, but it is not a valid DuckDB database file!" and downloaded
// nothing. The type annotation is a network control, not documentation.
//
// ── motherduck: DROPPED ──────────────────────────────────────────────────────
// The extension loads and then refuses, verbatim:
//
//   Invalid Input Error: Initialization function "motherduck_duckdb_cpp_init" …
//   threw an exception: "Your DuckDB version (v1.5.5) is not yet supported by
//   MotherDuck. The latest supported version is v1.5.4. Please downgrade to use
//   MotherDuck."
//
// v1.5.5 is exactly what `@duckdb/node-api@1.5.5-r.3` ships. On top of that it
// needs the same runtime download as sqlite, plus network access, which
// `enable_external_access=false` removes. Three independent blockers; one of them
// is not ours to fix. Shipping a "MotherDuck" tile that cannot connect would be
// worse than not shipping it.
//
// ═════════════════════════════════════════════════════════════════════════════
// 3. RULES THIS FILE FOLLOWS
// ═════════════════════════════════════════════════════════════════════════════
//
// • READ-ONLY. `ATTACH … (READ_ONLY)` is enforced by the engine, not by us —
//   measured: `INSERT INTO a.t …` → 'Invalid Input Error: Cannot execute
//   statement of type "INSERT" on database "a" which is attached in read-only
//   mode!', same for CREATE. `read_parquet`/`read_csv_auto` have no write form.
// • PATH SAFETY. A user path is interpolated into SQL (it cannot be a bound
//   parameter — it is part of a table function / ATTACH target). It is
//   single-quoted with `'` doubled, exactly as `parquetStore.relationSql()` does,
//   and for the same reason: backslash is NOT an escape character in a DuckDB
//   string literal, so doubling the quote is the whole escape. Verified with a
//   file literally named `we'ird.parquet` and a database named `o'brien.duckdb`.
//   Identifiers get `"` doubling. Directory listing uses `fs.readdirSync`, NOT
//   DuckDB's `glob()`, so a folder whose name contains `*`, `?` or `[` is listed
//   correctly instead of being read as a pattern.
// • TYPES ARE THE SOURCE'S, VERBATIM, NEVER COERCED. `ConnectorColumn.type` is
//   whatever `DESCRIBE` reports for the query — VARCHAR, BIGINT, DATE, DECIMAL…
//   For CSV the answer is `VARCHAR` for every column, because CSV HAS NO TYPES:
//   `read_csv_auto` is passed `all_varchar=true` so `007` stays `'007'` instead
//   of becoming `7`. That is the same rule the rest of the app runs on
//   (`parquetStore` stores every column as VARCHAR and keeps Ordinate's own
//   `ColumnType` beside it); Ordinate's own detection happens downstream, once,
//   on strings.
//   ONE DIVERGENCE FROM `parse.ts`, MEASURED AND LEFT ALONE: DuckDB's CSV reader
//   turns an EMPTY FIELD into NULL — both `a,,b` and `a,"",b` — where Ordinate's
//   own tokenizer produces `''`. It can be suppressed (`nullstr=['<sentinel>']`
//   makes empties come back as `''` — verified), and that is deliberately NOT
//   done: it would make a literal `<sentinel>` in the file become NULL, trading a
//   documented convention for a silent trap. So an empty CSV cell arrives as
//   `null` here, which is also what the Postgres connector does with a real NULL.
//   Parquet is unaffected — it stores NULL and `''` distinctly and both survive.
// • BOUNDED. `ctx.rowLimit` becomes `LIMIT n+1` so an (n+1)th row is the
//   truncation signal, and `truncated: true` is reported, never silent.
//   `ctx.timeoutMs` is a wall-clock race — DuckDB has no per-statement timeout
//   and the bridge cannot interrupt a running query, so a timed-out statement
//   keeps running in the worker until it finishes or hits the bridge's own 120 s
//   ceiling. The CALLER is unblocked at `timeoutMs`; the engine is not. Saying
//   otherwise would be a lie.
// • NO AGGREGATES ARE ISSUED HERE. If one is ever added it must be
//   `CAST(… AS DOUBLE)`: `SUM(INTEGER)`/`count(*)` are HUGEINT/BIGINT and reach
//   JS as decimal STRINGS (src/duckdb.ts TYPE MAPPING, docs/phase-3b).
// • Every error goes through `safeError(e, ctx.secrets)`. None of these three
//   connectors HAS a secret field — the one that would have (`motherduck`'s
//   token) was dropped — but the discipline stays so adding one is safe.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as duck from '../engine/duckdb';
import { hardeningState } from '../ipc/mosaic';
import { noteDir, prepareEngine } from './duckdbDirs';
import type {
  ConnectorColumn,
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTables,
} from './types';
import { safeError } from './types';

// ── Constants ────────────────────────────────────────────────────────────────

const CATEGORY = 'Files & local' as const;
const FAMILY = 'duckdb';

/** Files (or tables) listed from one source. A folder browser, not a warehouse. */
const MAX_TABLES = 1000;

/** Used when a caller supplies a nonsense `rowLimit`. Matches connectionRun.ts. */
const DEFAULT_ROW_LIMIT = 1_000_000;

/** Used when a caller supplies a nonsense `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ── SQL text helpers ─────────────────────────────────────────────────────────

/**
 * A DuckDB single-quoted string literal. `'` is doubled and that is the ENTIRE
 * escape — backslash is not an escape character in a DuckDB string literal, so
 * nothing else needs touching. Same approach as `parquetStore.relationSql()` and
 * `mosaic.sqlStr()`; kept here rather than imported because `relationSql` also
 * enforces a `.parquet` suffix, which two of these three connectors do not want.
 */
export function strLit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** A double-quoted DuckDB identifier, `"` doubled. */
export function ident(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * The ATTACH statement this module uses. Exported so the test can execute the
 * exact text and prove the engine refuses writes through it.
 *
 * `TYPE DUCKDB` is load-bearing — see §2. Without it, ATTACH on a file that is
 * not a DuckDB database makes DuckDB guess the format and DOWNLOAD the matching
 * extension over the network.
 */
export function attachSql(filePath: string, alias: string): string {
  return `ATTACH ${strLit(filePath)} AS ${ident(alias)} (TYPE DUCKDB, READ_ONLY)`;
}

/** A fresh catalog alias per call, so concurrent runs never collide or race a DETACH. */
function newAlias(): string {
  return 'ord_src_' + randomUUID().replace(/-/g, '');
}

// The allow-list registry (noteDir / prepareEngine / registeredDirs) lives in
// ./duckdbDirs.ts — see that file's header for why the lock timing matters.

export { registeredDirs } from './duckdbDirs';

/**
 * Turn an engine error into something a user can act on.
 *
 * A Permission Error while the configuration is locked is not a broken file, a
 * bad path, or a bug in the query — it is the once-per-process
 * `allowed_directories` lock, applied before this folder was known. The folder
 * has just been recorded by `prepareEngine`, so a restart is a real fix and the
 * message says so.
 *
 * Detected by catching the engine's own answer rather than by inspecting
 * `hardeningState().applied`: the applied SQL is a canonicalised, symlink-resolved
 * string list, and re-deriving "is this path covered" from it would reimplement
 * DuckDB's own path matching — badly.
 */
function explainError(err: unknown, dir: string, ctx: ConnectorContext): string {
  const msg = safeError(err, ctx.secrets);
  if (/Permission Error/i.test(msg) && hardeningState().attempted) {
    return (
      `Ordinate's query engine was locked to a fixed set of folders earlier in this session, and ` +
      `${dir} is not one of them, so it cannot be read right now. The folder has been remembered — ` +
      `restart Ordinate and this connection will work. ` +
      `(DuckDB's allowed_directories is set once per process and cannot be changed afterwards.)`
    );
  }
  return msg;
}

// ── Bounds ───────────────────────────────────────────────────────────────────

function rowLimitOf(ctx: ConnectorContext): number {
  const n = Number(ctx?.rowLimit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ROW_LIMIT;
  return Math.min(Math.floor(n), DEFAULT_ROW_LIMIT);
}

function timeoutOf(ctx: ConnectorContext): number {
  const n = Number(ctx?.timeoutMs);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Bound the CALLER's wait, which is all that can honestly be bounded: the bridge
 * exposes no way to cancel a statement, and DuckDB has no per-statement timeout,
 * so the query itself runs on in the worker until it finishes or hits the
 * bridge's 120 s ceiling. The timer is `unref`ed so a pending race can never hold
 * the process open.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// ── Path validation ──────────────────────────────────────────────────────────

function fieldString(ctx: ConnectorContext, key: string): string {
  const v = ctx?.values?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

function fieldBool(ctx: ConnectorContext, key: string): boolean {
  const v = ctx?.values?.[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * A path we are willing to put in SQL. Absolute only: a relative path would
 * resolve against `process.cwd()`, which for a packaged Electron app is
 * wherever the user launched it from — unpredictable, and a different folder
 * than the one they picked.
 */
function checkPath(p: string, kind: 'file' | 'directory'): string | null {
  if (!p) return kind === 'file' ? 'Choose a database file' : 'Choose a folder';
  if (p.includes('\0')) return 'Path must not contain a null byte';
  if (!path.isAbsolute(p)) return 'Path must be absolute';
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return `Not found: ${p}`;
  }
  if (kind === 'file' && !st.isFile()) return `Not a file: ${p}`;
  if (kind === 'directory' && !st.isDirectory()) return `Not a folder: ${p}`;
  return null;
}

// ── Folder listing ───────────────────────────────────────────────────────────

interface FileTable {
  /** The identifier a caller references (see the CONTRACT note on listTables). */
  name: string;
  /** Absolute path on disk. */
  file: string;
}

/**
 * Every `*<ext>` under `dir`, as `{name, file}`.
 *
 * `fs.readdirSync`, NOT DuckDB's `glob()`: `glob` would treat `*`, `?` and `[` in
 * the FOLDER's own name as pattern syntax (there is no escape for them), so a
 * folder called `data[2024]` would silently list nothing.
 *
 * The name is the path relative to `dir` with the extension removed and
 * separators normalised to `/`, so nested files stay distinguishable. Collisions
 * (only reachable via case-differing extensions on a case-insensitive volume)
 * get a numeric suffix rather than silently shadowing each other.
 */
function folderTables(dir: string, ext: string, recursive: boolean): FileTable[] {
  const entries = fs.readdirSync(dir, { recursive, encoding: 'utf8' }) as unknown as string[];
  const out: FileTable[] = [];
  const used = new Set<string>();
  for (const rel of entries.slice().sort()) {
    if (typeof rel !== 'string') continue;
    if (!rel.toLowerCase().endsWith(ext)) continue;
    const file = path.join(dir, rel);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue; // vanished between readdir and stat
    }
    const base = rel.slice(0, rel.length - ext.length).split(path.sep).join('/');
    let name = base || rel;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    out.push({ name, file });
    if (out.length >= MAX_TABLES) break;
  }
  return out;
}

/**
 * The `WITH` prelude that binds each listed name to its reader expression.
 *
 * Why a prelude and not a `CREATE VIEW`: the DuckDB catalog is SHARED with
 * `residentQuery`, `statsResident` and Mosaic's `ds_*` views. A connector must
 * not leave anything behind in it, and two connections pointed at two folders
 * must not fight over a name. A CTE lives exactly as long as the statement.
 *
 * Measured: an UNUSED CTE is not bound at all — a prelude entry for a file that
 * has since been deleted costs nothing unless the query actually selects from
 * it. A 500-entry prelude selecting one table ran in 4 ms.
 */
function prelude(tables: readonly { name: string; ref: string }[]): string {
  if (!tables.length) return '';
  return 'WITH ' + tables.map((t) => `${ident(t.name)} AS (SELECT * FROM ${t.ref})`).join(', ') + ' ';
}

// ── Running one statement ────────────────────────────────────────────────────

/**
 * Run `sql` inside `preludeSql`, bounded, and return positional rows + the
 * source's own column types.
 *
 * Two engine round trips: `DESCRIBE` for the column names and types (it plans
 * but does not execute — ~1 ms), then the query itself. Names come from
 * `DESCRIBE` rather than from `Object.keys` of the first row so that a zero-row
 * result still reports its columns, and rows are rebuilt POSITIONALLY from those
 * names. Duplicate output names are safe: DuckDB itself disambiguates them
 * (`SELECT 1 AS a, 2 AS a` describes as `a`, `a_1`, and the row object uses the
 * same keys), so nothing collides the way a `rowMode:'object'` Postgres result
 * would.
 */
async function runStatement(
  preludeSql: string,
  sql: string,
  ctx: ConnectorContext
): Promise<ConnectorRows> {
  const limit = rowLimitOf(ctx);
  // Their files, their SQL — but always sub-select wrapped with a LIMIT, exactly
  // as `connectionRun.pgRun` does. A trailing `;` would break the wrapper.
  const inner = sql.replace(/;\s*$/, '');
  const wrapped = `${preludeSql}SELECT * FROM ( ${inner} ) AS _ord_wrap LIMIT ${limit + 1}`;

  const described = await duck.queryAsync(`DESCRIBE ${wrapped}`);
  const columns: ConnectorColumn[] = described.map((r) => ({
    name: String(r.column_name ?? ''),
    // The SOURCE's type name, verbatim. Never mapped, never coerced.
    type: String(r.column_type ?? ''),
  }));

  const raw = await duck.queryAsync(wrapped);
  const truncated = raw.length > limit;
  const kept = truncated ? raw.slice(0, limit) : raw;
  const rows = kept.map((row) => columns.map((c) => row[c.name] ?? null));
  return { ok: true, columns, rows, truncated };
}

/**
 * `DESCRIBE` one referenceable name, plus an exact `count(*)`.
 *
 * `ref` is built by this module from a name the module itself listed — never
 * from renderer text — so the caller must resolve the name against its own
 * table list FIRST and pass the resolved reference. That is what keeps this
 * safe without a whitelist: there is no path from a typed string to this SQL.
 *
 * The count is EXACT here, unlike every other driver's estimate. A local
 * Parquet/DuckDB file answers `count(*)` off its own metadata in single-digit
 * milliseconds — there is no server to bill and no scan to avoid — so an
 * estimate would be a worse number for no saving.
 */
async function describeRef(preludeSql: string, ref: string): Promise<ConnectorSchema> {
  const described = await duck.queryAsync(`${preludeSql}DESCRIBE SELECT * FROM ${ref}`);
  const columns = described.map((r) => {
    const col: { name: string; type: string; nullable?: boolean } = {
      // The SOURCE's type name, verbatim. Never mapped, never coerced.
      name: String(r.column_name ?? ''),
      type: String(r.column_type ?? ''),
    };
    // DESCRIBE reports `null` as 'YES' / 'NO'; a reader expression (a CSV or a
    // Parquet glob) has no NOT NULL constraint, so the key is simply absent
    // rather than guessed.
    const nullable = String(r.null ?? '').toUpperCase();
    if (nullable === 'YES' || nullable === 'NO') col.nullable = nullable === 'YES';
    return col;
  }).filter((c) => c.name);

  const out: ConnectorSchema = { ok: true, columns };
  try {
    const counted = await duck.queryAsync(`${preludeSql}SELECT count(*) AS n FROM ${ref}`);
    const n = Number(counted[0]?.n ?? NaN);
    if (Number.isFinite(n) && n >= 0) out.rowEstimate = n;
  } catch {
    /* an unreadable file still has a describable header */
  }
  return out;
}

// ── duckdb-file ──────────────────────────────────────────────────────────────

interface DuckTable {
  name: string;
  ref: string;
}

/** Tables AND views in an attached catalog, as flat referenceable names. */
async function attachedTables(alias: string): Promise<DuckTable[]> {
  const rows = await duck.queryAsync(
    `SELECT schema_name AS s, table_name AS n FROM duckdb_tables() WHERE database_name = ${strLit(alias)}
     UNION ALL
     SELECT schema_name AS s, view_name AS n FROM duckdb_views() WHERE database_name = ${strLit(alias)} AND NOT internal
     ORDER BY 1, 2
     LIMIT ${MAX_TABLES}`
  );
  const out: DuckTable[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    const schema = String(r.s ?? '');
    const table = String(r.n ?? '');
    if (!table) continue;
    const base = schema && schema !== 'main' ? `${schema}.${table}` : table;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    out.push({ name, ref: `${ident(alias)}.${ident(schema || 'main')}.${ident(table)}` });
  }
  return out;
}

/**
 * ATTACH read-only, hand the alias to `body`, DETACH — always, including on
 * failure. The alias is fresh per call, so two concurrent calls on the same file
 * get two aliases (measured to work) and neither can DETACH the other's.
 */
async function withAttached<T>(file: string, body: (alias: string, tables: DuckTable[]) => Promise<T>): Promise<T> {
  const alias = newAlias();
  await duck.execAsync(attachSql(file, alias));
  try {
    return await body(alias, await attachedTables(alias));
  } finally {
    try {
      await duck.execAsync(`DETACH ${ident(alias)}`);
    } catch {
      /* already gone, or the bridge died — nothing useful to do */
    }
  }
}

const duckdbFile: ConnectorDef = {
  id: 'duckdb-file',
  label: 'DuckDB database file',
  family: FAMILY,
  category: CATEGORY,
  readOnly: true,
  blurb: 'Query a .duckdb file on this machine. Attached read-only; the file is never modified.',
  fields: [
    {
      key: 'path',
      label: 'Database file',
      type: 'text',
      required: true,
      placeholder: '/Users/you/data/warehouse.duckdb',
      help: 'Absolute path to a DuckDB database file. Opened read-only.',
    },
  ],

  async listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
    const file = fieldString(ctx, 'path');
    const bad = checkPath(file, 'file');
    if (bad) return { ok: false, error: bad };
    const dir = path.dirname(file);
    try {
      await prepareEngine(dir);
      const tables = await withDeadline(
        withAttached(file, async (_alias, list) => list.map((t) => ({ name: t.name }))),
        timeoutOf(ctx),
        'Listing tables'
      );
      return { ok: true, tables };
    } catch (err) {
      return { ok: false, error: explainError(err, dir, ctx) };
    }
  },

  async run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
    const file = fieldString(ctx, 'path');
    const bad = checkPath(file, 'file');
    if (bad) return { ok: false, error: bad };
    if (typeof sql !== 'string' || !sql.trim()) return { ok: false, error: 'No SQL to run' };
    const dir = path.dirname(file);
    try {
      await prepareEngine(dir);
      return await withDeadline(
        withAttached(file, (_alias, list) => runStatement(prelude(list), sql, ctx)),
        timeoutOf(ctx),
        'Query'
      );
    } catch (err) {
      return { ok: false, error: explainError(err, dir, ctx) };
    }
  },

  // The name is resolved against THIS attach's own table list, so a name the
  // renderer invented reaches no SQL at all — it simply is not found.
  async describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
    const file = fieldString(ctx, 'path');
    const bad = checkPath(file, 'file');
    if (bad) return { ok: false, error: bad };
    const wanted = String(table ?? '').trim();
    if (!wanted) return { ok: false, error: 'No table specified' };
    const dir = path.dirname(file);
    try {
      await prepareEngine(dir);
      return await withDeadline(
        withAttached(file, async (_alias, list) => {
          const hit = list.find((t) => t.name === wanted);
          if (!hit) return { ok: false as const, error: `No such table: ${wanted}` };
          return describeRef('', hit.ref);
        }),
        timeoutOf(ctx),
        'Describe'
      );
    } catch (err) {
      return { ok: false, error: explainError(err, dir, ctx) };
    }
  },
};

// ── Folder connectors (parquet, csv) ─────────────────────────────────────────

/**
 * Both folder connectors are the same code with a different extension and a
 * different reader expression.
 *
 * `all_varchar=true` on CSV is the type decision, not a convenience: see §3.
 */
function folderConnector(spec: {
  id: string;
  label: string;
  blurb: string;
  ext: string;
  reader(file: string): string;
  help: string;
}): ConnectorDef {
  const tablesOf = (ctx: ConnectorContext, dir: string): { name: string; ref: string }[] =>
    folderTables(dir, spec.ext, fieldBool(ctx, 'recursive')).map((t) => ({
      name: t.name,
      ref: spec.reader(t.file),
    }));

  return {
    id: spec.id,
    label: spec.label,
    family: FAMILY,
    category: CATEGORY,
    readOnly: true,
    blurb: spec.blurb,
    fields: [
      {
        key: 'path',
        label: 'Folder',
        type: 'text',
        required: true,
        placeholder: '/Users/you/data',
        help: spec.help,
      },
      { key: 'recursive', label: 'Include subfolders', type: 'checkbox', default: false,
        help: 'Nested files are named by their path relative to the folder.' },
      // Read by folderWatch.ts, not here: a watched folder refreshes its datasets.
      { key: 'watch', label: 'Watch this folder', type: 'checkbox', default: false,
        help: 'Refresh the datasets imported from here when a file is added or changed. Only while the app is open.' },
    ],

    async listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
      const dir = fieldString(ctx, 'path');
      const bad = checkPath(dir, 'directory');
      if (bad) return { ok: false, error: bad };
      try {
        // `fs` only — no engine, so no lock is applied here. See `noteDir`.
        noteDir(dir);
        return { ok: true, tables: tablesOf(ctx, dir).map((t) => ({ name: t.name })) };
      } catch (err) {
        return { ok: false, error: explainError(err, dir, ctx) };
      }
    },

    async run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
      const dir = fieldString(ctx, 'path');
      const bad = checkPath(dir, 'directory');
      if (bad) return { ok: false, error: bad };
      if (typeof sql !== 'string' || !sql.trim()) return { ok: false, error: 'No SQL to run' };
      try {
        await prepareEngine(dir);
        const tables = tablesOf(ctx, dir);
        if (!tables.length) return { ok: false, error: `No ${spec.ext} files in ${dir}` };
        return await withDeadline(runStatement(prelude(tables), sql, ctx), timeoutOf(ctx), 'Query');
      } catch (err) {
        return { ok: false, error: explainError(err, dir, ctx) };
      }
    },

    // Resolved against the folder's OWN listing, so the reader expression that
    // reaches SQL is one this module built from a real dirent — never text a
    // renderer typed.
    async describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
      const dir = fieldString(ctx, 'path');
      const bad = checkPath(dir, 'directory');
      if (bad) return { ok: false, error: bad };
      const wanted = String(table ?? '').trim();
      if (!wanted) return { ok: false, error: 'No table specified' };
      try {
        await prepareEngine(dir);
        const hit = tablesOf(ctx, dir).find((t) => t.name === wanted);
        if (!hit) return { ok: false, error: `No such table: ${wanted}` };
        return await withDeadline(describeRef('', hit.ref), timeoutOf(ctx), 'Describe');
      } catch (err) {
        return { ok: false, error: explainError(err, dir, ctx) };
      }
    },
  };
}

const parquetFolder = folderConnector({
  id: 'parquet-folder',
  label: 'Parquet folder',
  blurb: 'Connect a FOLDER of .parquet files as read-only SQL — each file is a table, read in place.',
  ext: '.parquet',
  help: 'Absolute path to a folder containing .parquet files. Each file becomes one table.',
  reader: (file) => `read_parquet(${strLit(file)})`,
});

const csvFolder = folderConnector({
  id: 'csv-folder',
  label: 'CSV folder',
  blurb: 'Connect a FOLDER of .csv files as read-only SQL — each file is a table, read in place as text.',
  ext: '.csv',
  help: 'Absolute path to a folder containing .csv files. Every column is read as text.',
  // all_varchar: CSV has no types, and a sniffed type is a guess that can lose a
  // leading zero. Ordinate does its own detection downstream, once, on strings.
  reader: (file) => `read_csv_auto(${strLit(file)}, all_varchar=true)`,
});

// ── The export ───────────────────────────────────────────────────────────────
//
// CONTRACT NOTE — `ConnectorTable.schema` is deliberately ABSENT from every table
// these connectors report, and `name` is the complete identifier to quote:
//
//     SELECT * FROM "sales"            (parquet-folder / csv-folder: a file)
//     SELECT * FROM "2024/sales"       (…with "Include subfolders" on)
//     SELECT * FROM "t"                (duckdb-file: a table in schema `main`)
//     SELECT * FROM "reporting.t"      (duckdb-file: a table in another schema)
//
// A caller that qualified with a schema — `"main"."t"` — would produce a
// reference that CANNOT BIND: the file's schemas live in a catalog attached under
// a per-call random alias, and `main` in the shared connection is the app's own
// in-memory catalog. Reporting a schema that does not resolve would be a trap, so
// the schema is folded into the name instead and the name is made unique.

export const CONNECTORS: ConnectorDef[] = [duckdbFile, parquetFolder, csvFolder];
