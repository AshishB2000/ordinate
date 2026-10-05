import * as fs from 'fs';
import * as datasetView from './datasetView';
import * as duck from './duckdb';

// THE DUCKDB LOCK — the engine hardening, the one-statement lexer and the
// dataset view names that every place user SQL meets DuckDB relies on:
// src/engine/sqlDatasets.ts (the SQL workbench and SQL datasets),
// src/engine/sqlGate.ts and src/connectors/duckdbDirs.ts. It began as the
// desktop's Mosaic connector (src/ipc/mosaic.ts); the Mosaic channels went with
// the Mosaic chart stack at the T8.1 cutover, the lock stayed.
//
// ═════════════════════════════════════════════════════════════════════════════
// SECURITY — what was measured, what was applied, and what is still possible
// ═════════════════════════════════════════════════════════════════════════════
//
// THE FACT THIS SECTION EXISTS FOR, re-verified on this build (DuckDB v1.5.5,
// `@duckdb/node-api`), not taken on trust:
//
//   duck.query('SELECT 1 AS one; DROP VIEW sentinel;')  →  [] , and the sentinel
//   view is GONE ("Catalog Error: Table with name sentinel does not exist!").
//   duck.query("SELECT 'first' AS v; SELECT 'second' AS v;")  →  [{v:'second'}]
//
// MULTI-STATEMENT SQL EXECUTES. The binding does not reject it, and only the LAST
// statement's rows come back — so a second statement can run completely
// invisibly. Anything that treats `query(sql)` as "one statement" is wrong.
//
//
// DuckDB is not merely a calculator: it can READ AND WRITE THE FILESYSTEM
// (`read_csv`, `COPY … TO`), ATTACH databases, and INSTALL/LOAD extensions —
// which is native code execution. So user SQL gets real controls, not comments.
//
// ── CONTROL 1 (the strong one): the engine is locked down ────────────────────
// Applied once per process, before the first user statement — `hardenConnection()`:
//
//   SET allowed_directories=['<userData>'];   -- MUST come first (see below)
//   SET enable_external_access=false;
//   SET lock_configuration=true;
//
// Measured on this build, AFTER those three:
//
//   read_csv('/etc/hosts')          Permission Error: Cannot access file … -
//                                   file system operations are disabled by
//                                   configuration
//   COPY (SELECT 1) TO '/tmp/x.csv' Permission Error (same)
//   INSTALL httpfs                  Permission Error (cannot reach the ext dir)
//   LOAD httpfs                     Permission Error: Loading external extensions
//                                   is disabled through configuration
//   ATTACH '/tmp/x.db'              Permission Error (same)
//   SET enable_external_access=true Invalid Input Error: … the configuration has
//                                   been locked
//   read_parquet('<userData>/…')    STILL WORKS  ← the app is unaffected
//   COPY … TO '<userData>/…'        STILL WORKS  ← parquetStore still writes
//
// THE ORDER IS LOAD-BEARING AND IS NOT OBVIOUS. `allowed_directories` must be set
// while external access is still ENABLED: afterwards DuckDB refuses with
// "Cannot change allowed_directories when enable_external_access is disabled".
// Set it the other way round (allowed_directories, then lock, WITHOUT disabling
// external access) and it enforces NOTHING — measured: `/etc/hosts`, `COPY TO
// /tmp`, `INSTALL httpfs` and `ATTACH` all still succeed. An allow-list that
// looks applied and enforces nothing is worse than none, so it is pinned by a
// test.
//
// `allowed_directories` IS recursive (a file three levels below the root reads
// fine), DuckDB canonicalises it itself (`/var/…` was stored as `/private/var/…`),
// and a `..` in a path does not escape it — all measured.
//
// Two settings deliberately NOT applied, because measurement says they buy
// nothing here: `allow_unsigned_extensions=false` and
// `autoload_known_extensions=false` are redundant once `LOAD` itself is a
// Permission Error, and `SET disabled_filesystems='LocalFileSystem'` DOES work
// but also kills `read_parquet` on our own files — it takes the whole app down
// with it. Listing no-op SETs would only manufacture confidence.
//
// BLAST RADIUS, stated plainly: there is ONE DuckDB connection for the whole
// process, so this hardening applies to `residentQuery`, `statsResident`,
// `parquetStore`, `pipelineDuck` and everything else, and `lock_configuration` is
// IRREVERSIBLE for the life of the process ("Cannot enable external access while
// database is running"). That is safe today because every DuckDB file access in
// this app is under `userData` (Parquet tables plus the temp siblings
// `parquetStore.writeTable` writes NEXT TO the target). A future feature that
// wants DuckDB to read a user-picked file OUTSIDE `userData` — `read_csv` on a
// path from the open dialog, say — would have to add that directory to
// the allow-list BEFORE the first hardened call, or it will fail with a
// Permission Error. CSV/XLSX parsing today is pure JS and never touches DuckDB.
//
// If hardening FAILS, `hardeningState()` reports it; sqlDatasets refuses to run
// user SQL on an unlocked engine.
//
// ── CONTROL 2 (defence in depth): one statement per call ─────────────────────
// `isSingleStatement()` rejects multi-statement input at the boundary. It
// is a LEXER, not DuckDB's parser, and this is where overclaiming would be easy,
// so precisely:
//
//   • It models the constructs a `;` can legally hide inside, and each was
//     verified against THIS DuckDB build rather than assumed: `'…'` with `''`
//     doubling; `E'…'`/`e'…'` with backslash escapes (a backslash in a PLAIN
//     string is literal — measured); `"…"` identifiers with `""` doubling;
//     `$$…$$` and `$tag$…$tag$` dollar quoting; `--` line comments; and `/* … */`
//     block comments, WHICH NEST on this build (measured: `/* a /* b */ c */` is
//     one comment).
//   • It FAILS CLOSED. A construct it fails to model can only make it think a
//     quoted region ended early, which yields a REJECTION of valid SQL — never a
//     bypass. A bypass would require the lexer to believe it is inside a quote
//     where DuckDB believes it is not, which is why every quoting form above was
//     measured rather than guessed. Input that ends inside an unterminated quote
//     or comment is rejected too.
//   • It is NOT airtight, and it is not claimed to be. A DuckDB quoting syntax
//     that exists and is not listed above would be a hole. What makes this
//     acceptable is that it is the SECOND control: the engine lock above does not
//     depend on parsing SQL correctly at all.
//
// ── WHAT REMAINS POSSIBLE, with hardening applied ────────────────────────────
// Statements that get past both controls (a hardened engine, one statement) can still:
//   • read any dataset in ANY project of this app (`read_parquet` under userData
//     is allowed by design — that is the feature), and write files anywhere under
//     `userData` via `COPY … TO`;
//   • create, replace and drop views and tables in the in-memory catalog;
//   • run an arbitrarily expensive query. There is no statement timeout on the
//     DuckDB side; the bridge's 120 s call ceiling and 512 MiB payload ceiling are
//     the only bounds, so a hostile query is a denial-of-service, not a leak.
// It can NOT read or write outside `userData`, load an extension, attach another
// database, or reach the network.

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Dataset ids reach a SQL identifier through `viewNameFor`. Validate the SHAPE
 * first. Copied verbatim from `src/data/datasets.ts` (which keeps it
 * module-private).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

// ── Public shapes ────────────────────────────────────────────────────────────

export interface HardeningState {
  /** True once `hardenConnection` has run to completion (successfully or not). */
  attempted: boolean;
  /** True when every statement was accepted by the engine. */
  ok: boolean;
  /** The statements that were accepted, in order. */
  applied: string[];
  /** The first failure, verbatim from DuckDB, or null. */
  error: string | null;
}

// ── The view name ────────────────────────────────────────────────────────────

/**
 * `datasetView` VALIDATES view names and never constructs one, so that a raw id
 * can never become SQL text by accident; its header prescribes exactly this
 * mapping, and a UUID's hyphens are what make the mapping necessary.
 *
 * Returns null for anything that is not a UUID — so the only strings that reach
 * `viewSql` are `ds_` followed by 32 hex digits and 4 underscores.
 */
export function viewNameFor(datasetId: unknown): string | null {
  if (!isValidId(datasetId)) return null;
  const name = 'ds_' + datasetId.replace(/-/g, '_');
  return datasetView.isViewName(name) ? name : null;
}

// ── CONTROL 2 — one statement per call ───────────────────────────────────────

/**
 * The number of statements in `sql`, or -1 when the input ends inside an
 * unterminated string/identifier/comment (malformed — DuckDB would reject it
 * anyway, and guessing about it is exactly how a lexer gate becomes a hole).
 *
 * Empty statements do not count, so `';;SELECT 1;;'` is 1 — measured, DuckDB
 * accepts leading and repeated semicolons.
 *
 * See the SECURITY section above for what this does and does not guarantee. In
 * one line: it fails closed, and it is the second control, not the first.
 */
export function statementCount(sql: string): number {
  if (typeof sql !== 'string') return -1;

  let count = 0;
  let hasContent = false; // any non-whitespace since the last top-level `;`
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // ── Line comment: `-- … <newline>` ──
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }

    // ── Block comment: `/* … */`, NESTING (measured on this build) ──
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) return -1; // unterminated
      continue;
    }

    // ── String literal: `'…'`, `''` doubling; backslash escapes ONLY after an
    //    E/e prefix (measured: a backslash in a PLAIN string is literal). ──
    if (ch === "'") {
      const prev = i > 0 ? sql[i - 1] : '';
      const beforePrev = i > 1 ? sql[i - 2] : '';
      const escaped = (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$]/.test(beforePrev);
      i += 1;
      let closed = false;
      while (i < n) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return -1;
      hasContent = true;
      continue;
    }

    // ── Quoted identifier: `"…"`, `""` doubling ──
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return -1;
      hasContent = true;
      continue;
    }

    // ── Dollar quoting: `$$…$$` / `$tag$…$tag$` (both measured to work) ──
    if (ch === '$') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (open) {
        const delim = open[0];
        const end = sql.indexOf(delim, i + delim.length);
        if (end < 0) return -1; // unterminated
        i = end + delim.length;
        hasContent = true;
        continue;
      }
      // A bare `$1`/`$name` parameter reference — ordinary content.
    }

    // ── A top-level statement separator ──
    if (ch === ';') {
      if (hasContent) count += 1;
      hasContent = false;
      i += 1;
      continue;
    }

    if (!/\s/.test(ch)) hasContent = true;
    i += 1;
  }

  if (hasContent) count += 1;
  return count;
}

/** True when `sql` is exactly one well-formed-enough statement. Fails closed. */
export function isSingleStatement(sql: string): boolean {
  return statementCount(sql) === 1;
}

// ── CONTROL 1 — engine hardening ─────────────────────────────────────────────

let hardening: Promise<HardeningState> | null = null;
let state: HardeningState = { attempted: false, ok: false, applied: [], error: null };

/** The outcome of `hardenConnection`, for diagnostics and tests. */
export function hardeningState(): HardeningState {
  return { ...state, applied: [...state.applied] };
}

/** Test-only: forget that hardening ran. The ENGINE cannot be un-hardened. */
export function resetHardeningForTests(): void {
  hardening = null;
  state = { attempted: false, ok: false, applied: [], error: null };
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Lock the shared DuckDB connection down to `allowedDirs`, once per process.
 *
 * ORDER IS LOAD-BEARING — see the SECURITY section. `allowed_directories` must be
 * set BEFORE external access is disabled (DuckDB refuses it afterwards), and
 * disabling external access is what makes the allow-list mean anything at all.
 *
 * Never throws, and never rejects: a failure is recorded in `hardeningState()`
 * and the caller proceeds. Idempotent — concurrent callers share one promise, and
 * a second call after it settled is a no-op.
 */
export function hardenConnection(allowedDirs: readonly string[]): Promise<HardeningState> {
  if (hardening) return hardening;
  hardening = (async (): Promise<HardeningState> => {
    const applied: string[] = [];
    let error: string | null = null;
    try {
      // DuckDB canonicalises the path itself, but resolve symlinks here anyway so
      // the list we RECORD is the list the engine enforces (macOS `/var` is a
      // symlink to `/private/var`, and every temp dir lives under it).
      const dirs: string[] = [];
      for (const d of allowedDirs) {
        if (typeof d !== 'string' || !d) continue;
        try {
          fs.mkdirSync(d, { recursive: true });
          dirs.push(fs.realpathSync(d));
        } catch {
          dirs.push(d);
        }
      }
      const statements = dirs.length
        ? [
            `SET allowed_directories=[${dirs.map(sqlStr).join(', ')}];`,
            'SET enable_external_access=false;',
            'SET lock_configuration=true;',
          ]
        : // With no allow-list, disabling external access would break the app's
          // own `read_parquet`. Better to apply nothing and say so than to ship a
          // half-lock nobody can reason about.
          [];
      if (!statements.length) error = 'no allowed directories were resolved; the engine was left unhardened';
      for (const s of statements) {
        await duck.execAsync(s);
        applied.push(s);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    state = { attempted: true, ok: error === null && applied.length > 0, applied, error };
    return hardeningState();
  })();
  return hardening;
}
