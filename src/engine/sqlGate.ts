// The read-only gate for SQL over the project's datasets — MAIN PROCESS, pure.
// Split out of sqlDatasets.ts (file-size.md). It is the SECOND and third of the
// four controls listed in that file's header: the engine lock comes first and
// the subquery wrapper last, and neither depends on this lexer being right.

import { statementCount } from '../ipc/mosaic';
import { foldKey } from './datasetView';
import { lexSql } from './sqlLex';

// ── The read-only gate ───────────────────────────────────────────────────────

const ONLY_DATASETS = "Only this project's datasets can be queried here — not files, other databases or the app's own tables.";
const FIRST_WORDS: ReadonlySet<string> = new Set(['select', 'with', 'from', 'values']);
// Table functions (and two scalars) that read a file, run a string as SQL, or
// look into the engine. `query('…')` would otherwise run any read hidden in a
// string literal, past every token check here; `json_execute_serialized_sql`
// is the same thing spelled as a serialized statement (T6.3).
const FILE_FUNC_RE =
  /^(read_\w+|\w+_scan|glob|sniff_csv|parquet_\w+|query|query_table|iceberg_\w+|delta_\w+|st_read\w*|duckdb_\w+|pragma_\w+|which_secret|current_setting|getenv|json_execute_serialized_sql)$/i;
/** `mosaic.viewNameFor` — a view over ANY project's dataset, in the shared catalog. */
const MOSAIC_VIEW_RE = /^ds_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i;
/** A quoted name DuckDB's replacement scan would open as a file. */
const PATHISH_RE = /[\\/~]|\.[A-Za-z0-9]{1,8}$/;
/** Words that end a FROM list at their depth (ON/USING do not: a comma after a join condition is another table). */
const FROM_ENDS: ReadonlySet<string> = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'qualify', 'window', 'union', 'except',
  'intersect', 'select', 'returning', 'fetch', 'values',
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
      } else if (FROM_ENDS.has(w)) inFrom[depth] = false;
    }
  }
  return null;
}
