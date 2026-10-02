// SQL over the project's OWN datasets — MAIN PROCESS ONLY.
//
// The Data page's Query tab: the user writes DuckDB SQL naming datasets, and it
// runs against their stored Parquet in place.
//
// ── How a dataset becomes a table name ───────────────────────────────────────
// Per STATEMENT, never in the catalog. Each dataset the SQL names is prepended
// as a CTE — under its exact name (`"Retail orders"`) and a slug alias
// (`retail_orders`) — whose body is `datasetView.viewSelectSql`, the SAME typed
// projection a Mosaic view uses. So nothing persists in the shared in-memory
// catalog, nothing leaks between projects, and the user's own SQL is wrapped
// unchanged:
//
//   WITH "Retail orders" AS (SELECT CAST(c0 AS VARCHAR) AS "region", … FROM read_parquet('…')),
//        "retail_orders" AS (SELECT * FROM "Retail orders")
//   SELECT * FROM (
//   <the user's statement — its own WITH / WITH RECURSIVE nests fine in here>
//   ) AS _q("c0", "c1", …) LIMIT n+1
//
// The subquery is what makes the statement read-only by construction: DDL,
// COPY, ATTACH, SET and PRAGMA are syntax errors inside `FROM ( … )`. The
// newlines around it keep a trailing `-- comment` from eating the `)`. The
// column aliases are positional because DuckDB rows arrive as objects: an
// integer-like name ("2") would reorder under JS key rules and a repeated name
// would collide, so the real names come from DESCRIBE, never from the row keys.
//
// ── The cast rules are the resident layer's ─────────────────────────────────
// Only a DECLARED `number` column is DOUBLE; everything else is VARCHAR. So
// `sum()` over a text column is DuckDB's binder error, shown in the editor —
// never a plausible wrong total — and `007` stays `007`.
//
// ── Defence in depth ─────────────────────────────────────────────────────────
//   1. the engine lock (`hardenEngine` → mosaic.hardenConnection) is awaited
//      before any user SQL runs, and a failed lock refuses to run at all;
//   2. one statement (`mosaic.statementCount`), and it must start like a read;
//   3. `readOnlyError` refuses file-reading table functions, a string (or a
//      path-shaped quoted name) in table position — DuckDB's replacement scan
//      reads `FROM 'x.csv'` as a file — and the Mosaic catalog views;
//   4. the subquery wrapper above.
// Every value in the user's `[[params]]` is BOUND (analysis/params.ts — the one
// resolver every parameter host shares), never spliced.

import type { ColumnType, ParsedColumn } from '../data/parse';
import { coerceValue } from '../data/parse';
import type { Cell } from '../data/transforms';
import * as datasets from '../data/datasets';
import { MAX_ORIGIN_SQL } from '../data/datasetOrigin';
import type { DatasetOrigin } from '../data/datasetOrigin';
import { isValidId } from '../app/ids';
import { ROW_LIMIT, SAMPLE_ROWS } from '../connectors/connectionRun';
import { hardenEngine } from '../connectors/duckdbDirs';
import { hardeningState } from '../ipc/mosaic';
import * as duck from './duckdb';
import { viewSelectSql, quoteIdent, foldKey } from './datasetView';
import { lexSql } from './sqlLex';
import { bindSqlParams, sanitizeSqlParams } from '../analysis/params';
import type { SqlBindValue, SqlParam } from '../analysis/params';
import { assignViewNames, extractDeps, slugify } from './sqlNames';
import { readOnlyError } from './sqlGate';
// One API surface for callers and the self-check.
export { assignViewNames, extractDeps, slugify } from './sqlNames';
export { readOnlyError } from './sqlGate';

/** Rows a Run shows. The connection workbench's preview size — one number. */
export const PREVIEW_ROWS = SAMPLE_ROWS;

// ── Types and values ─────────────────────────────────────────────────────────

const NUMERIC_TYPE_RE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL(\(\s*\d+\s*,\s*\d+\s*\))?)$/i;
const DATE_TYPE_RE = /^(DATE|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE)$/i;

/** DuckDB's type name → the app's ColumnType. Arrays, structs, BOOLEAN, TIME… are text. */
export function columnKind(sqlType: string): ColumnType {
  const t = String(sqlType || '').trim();
  if (NUMERIC_TYPE_RE.test(t)) return 'number';
  if (DATE_TYPE_RE.test(t)) return 'date';
  return 'text';
}

export interface DescribedColumn {
  name: string;
  sqlType: string;
  kind: ColumnType;
}

const NON_FINITE: ReadonlySet<string> = new Set(['NaN', 'Infinity', '-Infinity']);

/**
 * Rows keyed `c0..cN` → the app's `{columns, rows}`, typed from DESCRIBE rather
 * than re-sniffed (a VARCHAR `007` stays text). A BIGINT/HUGEINT arrives as a
 * decimal string; one that a JS number cannot hold exactly demotes its WHOLE
 * column to text, keeping every digit — parse.ts's rule for a >15-digit id,
 * and never a rounded figure.
 */
export function toTable(cols: DescribedColumn[], rows: duck.DuckRow[]): { columns: ParsedColumn[]; rows: Cell[][] } {
  const columns: ParsedColumn[] = cols.map((c, i) => ({ name: c.name.trim() ? c.name : `col${i + 1}`, type: c.kind }));
  const out: Cell[][] = rows.map(() => new Array<Cell>(cols.length));
  for (let c = 0; c < cols.length; c += 1) {
    const key = `c${c}`;
    let lossy = false;
    for (let r = 0; r < rows.length; r += 1) {
      const v = rows[r][key];
      if (v === null || v === undefined) out[r][c] = null;
      else if (columns[c].type !== 'number') out[r][c] = String(v);
      else if (typeof v === 'number') out[r][c] = Number.isFinite(v) ? v : null;
      else if (NON_FINITE.has(v)) out[r][c] = null;
      else {
        const n = coerceValue(v, 'number');
        if (n === null) lossy = true;
        out[r][c] = n;
      }
    }
    if (lossy) {
      columns[c] = { name: columns[c].name, type: 'text' };
      for (let r = 0; r < rows.length; r += 1) {
        const v = rows[r][key];
        out[r][c] = v === null || v === undefined ? null : String(v);
      }
    }
  }
  return { columns, rows: out };
}

/** DuckDB's message without the parts that describe OUR wrapper, not the user's SQL. */
export function cleanDuckError(err: unknown): string {
  let m = err instanceof Error ? err.message : String(err ?? '');
  m = m.replace(/^Failed to extract statements:\s*/i, '');
  const cut = m.search(/\n\s*(LINE \d+:|Candidate functions:)/);
  if (cut >= 0) m = m.slice(0, cut);
  m = m.replace(/\s+/g, ' ').trim();
  return m || 'The query failed.';
}

// ── The project's catalog ────────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  name: string;
  alias: string | null;
  slug: string;
  rowCount: number;
  /** False for a legacy record whose table is still inline in its JSON. */
  queryable: boolean;
  /** The record's declared columns, positionally aligned to the Parquet. */
  columns: ParsedColumn[];
}

/** Every dataset in the project with its exposed names. Metadata only — no table is read. */
export async function projectCatalog(projectId: string): Promise<CatalogEntry[]> {
  if (!isValidId(projectId)) return [];
  const list = await datasets.listDatasets(projectId);
  const metas = (await Promise.all(list.map((s) => datasets.getDatasetMeta(projectId, s.id))))
    .filter((m): m is datasets.DatasetMeta => m !== null);
  const names = assignViewNames(metas.map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt })));
  return metas.map((m) => {
    const n = names.get(m.id) || { alias: null, slug: slugify(m.name) };
    return {
      id: m.id,
      name: m.name,
      alias: n.alias,
      slug: n.slug,
      rowCount: m.rowCount,
      queryable: m.resident,
      columns: m.columns,
    };
  });
}

// ── Compile, describe, run ───────────────────────────────────────────────────

interface Compiled {
  text: (aliases: string[] | null, limit: number | null) => string;
  binds: SqlBindValue[];
  deps: string[];
  used: string[];
}

/** Top-level `;` removed: with exactly one statement they are only ever leading or trailing. */
function stripSemicolons(sql: string): string {
  let out = sql;
  for (const t of lexSql(sql).reverse()) {
    if (t.kind === 'punct' && t.text === ';') out = out.slice(0, t.start) + ' ' + out.slice(t.end);
  }
  return out;
}

/**
 * Named statements the query may read as tables — a notebook's SQL cells
 * (src/analysis/notebook/run.ts). Each is the user's text, gated and bound
 * exactly like the statement itself, and prepended as a CTE AFTER the dataset
 * CTEs, in order, so a later one may read an earlier one.
 */
export interface SqlView { name: string; sql: string }

async function compile(projectId: unknown, sql: unknown, params: unknown, views: SqlView[] = []): Promise<Compiled | { error: string }> {
  if (!isValidId(projectId)) return { error: 'Invalid project id' };
  if (typeof sql !== 'string' || !sql.trim()) return { error: 'Write a query first.' };
  if (sql.length > MAX_ORIGIN_SQL) {
    return { error: `The query is longer than ${MAX_ORIGIN_SQL.toLocaleString('en-US')} characters.` };
  }
  // Views first: their CTEs come first in the text, so their binds do too.
  const boundViews: Array<{ name: string; sql: string; binds: SqlBindValue[]; used: string[] }> = [];
  for (const v of views) {
    const b = bindSqlParams(v.sql, params);
    if ('error' in b) return { error: `${v.name}: ${b.error}` };
    boundViews.push({ name: v.name, ...b });
  }
  const bound = bindSqlParams(sql, params);
  if ('error' in bound) return bound;

  // The lock BEFORE anything the user wrote reaches the engine — and it goes
  // first for a second reason: its execAsync starts the worker without
  // blocking, so residentSource's synchronous isAvailable() probe never parks
  // the main thread (the ordering mosaic.ts documents).
  await hardenEngine();
  const lock = hardeningState();
  if (!lock.ok) {
    return { error: `SQL is off for this session: the query engine could not be locked to Ordinate's data${lock.error ? ` (${lock.error})` : ''}.` };
  }

  const cat = await projectCatalog(projectId);
  const known = new Set<string>();
  for (const e of cat) {
    if (e.alias) known.add(foldKey(e.alias));
    known.add(e.slug);
  }
  for (const v of boundViews) known.add(foldKey(v.name));
  for (const v of boundViews) {
    const g = readOnlyError(v.sql, known);
    if (g) return { error: `${v.name}: ${g}` };
  }
  const guard = readOnlyError(bound.sql, known);
  if (guard) return { error: guard };

  const deps = [...new Set([...boundViews.flatMap((v) => extractDeps(v.sql, cat)), ...extractDeps(bound.sql, cat)])];
  const ctes: string[] = [];
  for (const id of deps) {
    const e = cat.find((x) => x.id === id) as CatalogEntry;
    const src = await datasets.residentSource(projectId, id);
    if (!src) {
      return { error: `"${e.name}" can't be queried — it was saved before datasets were stored as Parquet. Import it again (or re-save it), then run this.` };
    }
    const primary = e.alias ?? e.slug;
    ctes.push(`${quoteIdent(primary)} AS (${viewSelectSql(src.parquetPath, src.columns)})`);
    if (e.alias !== null && foldKey(e.alias) !== e.slug) ctes.push(`${quoteIdent(e.slug)} AS (SELECT * FROM ${quoteIdent(e.alias)})`);
  }
  for (const v of boundViews) ctes.push(`${quoteIdent(v.name)} AS (\n${stripSemicolons(v.sql)}\n)`);
  const prelude = ctes.length ? `WITH ${ctes.join(',\n')}\n` : '';
  const body = stripSemicolons(bound.sql);
  return {
    text: (aliases, limit) =>
      `${prelude}SELECT * FROM (\n${body}\n) AS _q`
      + (aliases ? `(${aliases.map(quoteIdent).join(', ')})` : '')
      + (limit !== null ? ` LIMIT ${limit}` : ''),
    binds: [...boundViews.flatMap((v) => v.binds), ...bound.binds],
    deps,
    used: [...new Set([...boundViews.flatMap((v) => v.used), ...bound.used])],
  };
}

async function describe(c: Compiled): Promise<DescribedColumn[]> {
  const rows = await duck.queryAsync(`DESCRIBE ${c.text(null, null)}`, c.binds);
  return rows.map((r) => {
    const sqlType = String(r.column_type ?? '');
    return { name: String(r.column_name ?? ''), sqlType, kind: columnKind(sqlType) };
  });
}

export type ExplainResult =
  | { ok: true; columns: DescribedColumn[]; deps: string[] }
  | { ok: false; error: string };

/** Validate without fetching a row: DESCRIBE the wrapped statement. */
export async function explainSql(projectId: unknown, sql: unknown, params: unknown): Promise<ExplainResult> {
  try {
    const c = await compile(projectId, sql, params);
    if ('error' in c) return { ok: false, error: c.error };
    return { ok: true, columns: await describe(c), deps: c.deps };
  } catch (err) {
    return { ok: false, error: cleanDuckError(err) };
  }
}

export type RunResult =
  | {
      ok: true;
      columns: ParsedColumn[];
      rows: Cell[][];
      rowCount: number;
      /** More than `limit` rows exist; `rows` holds the first `limit`. */
      truncated: boolean;
      elapsedMs: number;
      sqlTypes: string[];
      deps: string[];
      /** Parameter names the statement actually used. */
      used: string[];
    }
  | { ok: false; error: string };

/** Run, bounded to `limit` rows (fetched as limit+1, so "more" is known, not guessed). */
export async function runSql(
  projectId: unknown, sql: unknown, params: unknown = [], limit: number = PREVIEW_ROWS, views: SqlView[] = [],
): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const c = await compile(projectId, sql, params, views);
    if ('error' in c) return { ok: false, error: c.error };
    const described = await describe(c);
    const n = Math.max(1, Math.min(Math.floor(Number(limit)) || PREVIEW_ROWS, ROW_LIMIT));
    const raw = await duck.queryAsync(c.text(described.map((_, i) => `c${i}`), n + 1), c.binds);
    const truncated = raw.length > n;
    const table = toTable(described, truncated ? raw.slice(0, n) : raw);
    return {
      ok: true,
      columns: table.columns,
      rows: table.rows,
      rowCount: table.rows.length,
      truncated,
      elapsedMs: Date.now() - t0,
      sqlTypes: described.map((d) => d.sqlType),
      deps: c.deps,
      used: c.used,
    };
  } catch (err) {
    return { ok: false, error: cleanDuckError(err) };
  }
}

export type DatasetRunResult =
  | { ok: true; columns: ParsedColumn[]; rows: Cell[][]; origin: Extract<DatasetOrigin, { kind: 'sql' }> }
  | { ok: false; error: string };

/**
 * The whole result, for a save or a refresh: at most `cap` rows, and MORE than
 * that is an error rather than a silent first-million. Returns the `sql` origin
 * that re-runs it — the original text with its `[[placeholders]]`, the
 * parameters it used, and the datasets it read.
 */
export async function runForDataset(
  projectId: unknown,
  sql: unknown,
  params: unknown,
  cap: number = ROW_LIMIT,
): Promise<DatasetRunResult> {
  const res = await runSql(projectId, sql, params, cap);
  if (!res.ok) return res;
  if (res.truncated) {
    return {
      ok: false,
      error: `This query returns more than ${cap.toLocaleString('en-US')} rows — the most one dataset can hold. Filter or aggregate it, then try again.`,
    };
  }
  const clean = sanitizeSqlParams(params) || [];
  const used: SqlParam[] = clean.filter((p) => res.used.includes(p.name));
  const origin: Extract<DatasetOrigin, { kind: 'sql' }> = { kind: 'sql', sql: sql as string, deps: res.deps };
  if (used.length) origin.params = used;
  return { ok: true, columns: res.columns, rows: res.rows, origin };
}
