// The read-only gate for SQL over the project's datasets — MAIN PROCESS, pure.
// Split out of sqlDatasets.ts (file-size.md). It is the second to fourth of the
// five controls listed in that file's header: `readOnlyError`, a lexer, is the
// pre-filter; `astRelationError` is the allow-list over DuckDB's OWN parse of
// the statement, the project boundary inside an org (threat model R2).

import { statementCount } from './sqlHarden';
import { foldKey } from './datasetView';
import { lexSql } from './sqlLex';

// ── The read-only gate ───────────────────────────────────────────────────────

export const ONLY_DATASETS = "Only this project's datasets can be queried here — not files, other databases or the app's own tables.";
const FIRST_WORDS: ReadonlySet<string> = new Set(['select', 'with', 'from', 'values']);
// Table functions (and two scalars) that read a file, run a string as SQL, or
// look into the engine. `query('…')` would otherwise run any read hidden in a
// string literal, past every token check here; `json_execute_serialized_sql`
// is the same thing spelled as a serialized statement (T6.3).
const FILE_FUNC_RE =
  /^(read_\w+|\w+_scan|glob|sniff_csv|parquet_\w+|query|query_table|iceberg_\w+|delta_\w+|st_read\w*|duckdb_\w+|pragma_\w+|which_secret|current_setting|getenv|json_execute_serialized_sql)$/i;
/** `sqlHarden.viewNameFor` — a view over ANY project's dataset, in the shared catalog. */
const MOSAIC_VIEW_RE = /^ds_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i;
/** A quoted name DuckDB's replacement scan would open as a file. */
const PATHISH_RE = /[\\/~]|\.[A-Za-z0-9]{1,8}$/;
/** Words that end a FROM list at their depth (ON/USING do not: a comma after a join condition is another table). */
const FROM_ENDS: ReadonlySet<string> = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'qualify', 'window', 'union', 'except',
  'intersect', 'select', 'returning', 'fetch', 'values',
]);
/** Words DuckDB reads a table name (or a replacement-scan path) after — table position only, never a FROM list. */
const TABLE_WORDS: ReadonlySet<string> = new Set([
  'pivot', 'pivot_wider', 'pivot_longer', 'unpivot', 'summarize', 'describe', 'show', 'table', 'only',
]);

/**
 * Why `sql` may not run here, or null. `known` holds the folded exposed names,
 * so a dataset literally called "sales.csv" is still a dataset.
 */
export function readOnlyError(sql: string, known: ReadonlySet<string> = new Set()): string | null {
  const count = statementCount(sql);
  if (count < 0) return 'The query ends inside an unterminated string, quoted name or comment.';
  if (count === 0) return 'Write a query first.';
  if (count > 1) return `Run one statement at a time — this has ${count}.`;

  const toks = lexSql(sql).filter((t) => !(t.kind === 'punct' && t.text === ';'));
  const first = toks[0];
  const opensParen = first && first.kind === 'punct' && first.text === '(';
  if (!opensParen && !(first && first.kind === 'word' && FIRST_WORDS.has(first.text.toLowerCase()))) {
    return 'Only queries that read data can run here — start with SELECT, WITH, FROM or VALUES.';
  }

  const inFrom: boolean[] = [false];
  let depth = 0;
  let tablePos = false;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const next = toks[i + 1];
    const atTable: boolean = tablePos;
    tablePos = false;
    if (t.kind === 'punct') {
      // A `(` IN table position opens a parenthesised join (T6.3): its first item
      // is in table position too, and so is each item after a comma in it —
      // `FROM ('x.csv' CROSS JOIN range(1))` is DuckDB's replacement scan again.
      if (t.text === '(') {
        inFrom[++depth] = atTable;
        tablePos = atTable;
      } else if (t.text === ')') depth = Math.max(0, depth - 1);
      else if (t.text === ',' && inFrom[depth]) tablePos = true;
      continue;
    }
    if (t.kind === 'str') {
      if (atTable) return ONLY_DATASETS;
      continue;
    }
    if (t.kind !== 'word' && t.kind !== 'qid') continue;
    if (MOSAIC_VIEW_RE.test(t.text)) return ONLY_DATASETS;
    if (next && next.kind === 'punct' && next.text === '(' && FILE_FUNC_RE.test(t.text)) return ONLY_DATASETS;
    if (t.kind === 'qid' && atTable && !known.has(foldKey(t.text)) && PATHISH_RE.test(t.text)) return ONLY_DATASETS;
    if (t.kind === 'word') {
      const w = t.text.toLowerCase();
      if (w === 'from' || w === 'join') {
        inFrom[depth] = true;
        tablePos = true;
      } else if (TABLE_WORDS.has(w)) tablePos = true;
      else if (FROM_ENDS.has(w)) inFrom[depth] = false;
    }
  }
  return null;
}

// ── The allow-list over DuckDB's parse ───────────────────────────────────────
// `json_serialize_sql` (the statically loaded json extension) parses only — no
// binder, no file is opened. The lexer above cannot know every word that opens
// table position, so this walks what DuckDB itself would bind instead.

const PIVOT_NEEDS_IN = 'PIVOT needs its values listed here — write ON col IN (…) USING …, or one SELECT.';
/** TableRef types the parser emits (the `class`-less `type` of a FROM item). */
const REF_TYPES: ReadonlySet<string> = new Set([
  'BASE_TABLE', 'SUBQUERY', 'JOIN', 'TABLE_FUNCTION', 'EXPRESSION_LIST', 'EMPTY_FROM', 'EMPTY', 'PIVOT', 'SHOW_REF',
  'INVALID', 'CTE', 'COLUMN_DATA', 'DELIM_GET', 'BOUND_TABLE_REF',
]);
const ALLOWED_REFS: ReadonlySet<string> = new Set([
  'BASE_TABLE', 'SUBQUERY', 'JOIN', 'TABLE_FUNCTION', 'EXPRESSION_LIST', 'EMPTY_FROM', 'EMPTY', 'PIVOT', 'SHOW_REF',
]);
/** Table functions that only generate or unnest values. */
const TABLE_FUNCS: ReadonlySet<string> = new Set(['range', 'generate_series', 'unnest', 'json_each', 'json_tree', 'repeat', 'repeat_row']);
/** Scalars that echo the compiled text (absolute Parquet paths) or a catalog definition. */
const CATALOG_SCALARS: ReadonlySet<string> = new Set(['current_query', 'pg_get_viewdef']);

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The FROM-item keys of a TableRef that hold another TableRef. */
const childRef = (type: string, key: string): boolean =>
  (type === 'JOIN' && (key === 'left' || key === 'right')) || (type === 'PIVOT' && key === 'source');

/**
 * Why the statement DuckDB parsed (`json_serialize_sql`'s reply, JSON-parsed)
 * reads something other than `known` (folded dataset and view names) and its
 * own CTEs in scope, or null. An allow-list: a node type or table function it
 * does not name is refused, so a new DuckDB construct fails closed.
 */
export function astRelationError(ast: unknown, known: ReadonlySet<string>): string | null {
  if (!isNode(ast)) return ONLY_DATASETS;
  if (ast.error !== false) {
    if (ast.error_type === 'parser') {
      // The user's own syntax error — the text cleanDuckError shows for it.
      const m = str(ast.error_message).split(/\n\s*LINE \d+:/)[0].replace(/\s+/g, ' ').trim();
      return m ? `Parser Error: ${m}` : ONLY_DATASETS;
    }
    // PIVOT without IN becomes several statements, which serialize to nothing.
    if (ast.error_type === 'not implemented') return PIVOT_NEEDS_IN;
    return ONLY_DATASETS;
  }
  if (!Array.isArray(ast.statements) || ast.statements.length !== 1) return ONLY_DATASETS;
  return walk(ast.statements, known, new Set());
}

function walk(v: unknown, known: ReadonlySet<string>, ctes: ReadonlySet<string>): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const e = walk(x, known, ctes);
      if (e) return e;
    }
    return null;
  }
  if (!isNode(v)) return null;
  // A TableRef wherever it sits; an expression of the same type name has a `class`.
  if (typeof v.type === 'string' && !('class' in v) && REF_TYPES.has(v.type)) return ref(v, known, ctes);
  if (v.class === 'FUNCTION') {
    const f = str(v.function_name).toLowerCase();
    if (FILE_FUNC_RE.test(f) || CATALOG_SCALARS.has(f)) return ONLY_DATASETS;
  }
  // CTEs by scope, never as one set: body i sees the keys before it, and its
  // own only when it is a recursive CTE of that name. Anything else would let a
  // later or shadowing CTE's name excuse a catalog read or a file.
  let scope = ctes;
  const map = isNode(v.cte_map) && Array.isArray(v.cte_map.map) ? v.cte_map.map : [];
  if (map.length) {
    const names: string[] = [];
    for (const entry of map) {
      if (!isNode(entry) || typeof entry.key !== 'string') return ONLY_DATASETS;
      const name = foldKey(entry.key);
      const body = isNode(entry.value) && isNode(entry.value.query) ? entry.value.query.node : null;
      const self = isNode(body) && body.type === 'RECURSIVE_CTE_NODE' && foldKey(str(body.cte_name)) === name;
      const e = walk(entry.value, known, new Set([...ctes, ...names, ...(self ? [name] : [])]));
      if (e) return e;
      names.push(name);
    }
    scope = new Set([...ctes, ...names]);
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === 'cte_map') continue;
    const e = k === 'from_table' ? ref(x, known, scope) : walk(x, known, scope);
    if (e) return e;
  }
  return null;
}

function ref(r: unknown, known: ReadonlySet<string>, scope: ReadonlySet<string>): string | null {
  if (!isNode(r) || typeof r.type !== 'string' || !ALLOWED_REFS.has(r.type)) return ONLY_DATASETS;
  if (r.type === 'BASE_TABLE') {
    // A CTE is never qualified, so a schema or catalog always means DuckDB's own.
    if (str(r.schema_name) || str(r.catalog_name)) return ONLY_DATASETS;
    const name = str(r.table_name);
    const k = foldKey(name);
    if (!known.has(k) && (PATHISH_RE.test(name) || name.includes('://') || name.includes('*') || !scope.has(k))) return ONLY_DATASETS;
  } else if (r.type === 'TABLE_FUNCTION') {
    const f = r.function;
    if (!isNode(f) || !TABLE_FUNCS.has(str(f.function_name).toLowerCase()) || str(f.schema) || str(f.catalog)) return ONLY_DATASETS;
  } else if (r.type === 'SHOW_REF' && !isNode(r.query)) {
    return ONLY_DATASETS; // SHOW TABLES / DATABASES / ALL TABLES: the catalog itself
  }
  for (const [k, x] of Object.entries(r)) {
    const e = childRef(r.type, k) ? ref(x, known, scope) : walk(x, known, scope);
    if (e) return e;
  }
  return null;
}
