// The SQL lane (docs/assistant/00-design.md, "Two ways to answer") — PURE: what the two model calls are told, the
// second call's reply read back into one statement, the turn's stored SQL, and the card's own words for a result table.
// MAIN PROCESS ONLY. The calls, the gate and the run are ../ipc/answerSql.
//
// The chart form comes first. Only a question one chart cannot say ("bought in January but not February", "days between
// orders") gets SQL, and in two calls: the first names the datasets (`actionSqlPrompt`, on the action line), then
// Ordinate sends every column of only those (`tablesBlock`) and the second writes one statement (`SQL_SYSTEM_PROMPT`).
// The statement runs through the Query tab's gate; every figure on the card is DuckDB's, and the card's words are the
// app's (../ipc/answerSql `cardOf`): no third call narrates a result.
//
// No runtime import but ids: ./suggestedAction, which is pure, takes its prompt line from here.

import { isValidId } from '../app/ids';
import type { ColumnType, ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import type { ChartData } from '../analysis/vizData';
import type { AsOf } from '../api/asOf';

/** The most datasets one SQL answer reads: the first call names them, the second gets every column of each. */
export const MAX_SQL_DATASETS = 4;
/** The gate's MAX_ORIGIN_SQL (../data/datasetOrigin), which compile() refuses past; scripts/test-answerSql.ts holds them equal. */
export const MAX_SQL_TEXT = 20_000;
const MAX_NAME = 200;
const MAX_TITLE = 300;

/** The datasets an "sql" action names: 1 to MAX_SQL_DATASETS distinct names, or null (no SQL answer). */
export function sanitizeSqlDatasets(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.length >= 1 && out.length <= MAX_SQL_DATASETS ? out : null;
}

/** An "sql" action off the wire (./suggestedAction `validateAction`): its intent and datasets, or null with no datasets to read. */
export function sqlActionOf(intent: string, datasets: unknown): { kind: 'sql'; intent: string; datasets: string[] } | null {
  const named = sanitizeSqlDatasets(datasets);
  return named ? { kind: 'sql', intent, datasets: named } : null;
}

/** The first call's part of the action prompt (./suggestedAction): when "sql" is the kind, and its line. */
export function actionSqlPrompt(marker: string): string {
  return 'Use "sql" ONLY when ONE chart cannot express the question, because it compares rows with other rows or sets of ' +
    'them ("customers who bought in January but not February", "average days between a customer\'s orders", "products ' +
    'never ordered"). Never use it for what "answer" can do: a total, an average, a count, a top N, a share, a running ' +
    'total, a rank or a change on the period before. For "sql" ONLY, the line names the datasets from the FACTS it needs, ' +
    `at most ${MAX_SQL_DATASETS}, and nothing else:\n` +
    marker + ' {"kind":"sql","intent":"<the question, restated>","datasets":["<dataset name>"]}\n' +
    'The app then asks for the SQL itself. When the kind is "sql", your prose is ONE short sentence saying what the answer ' +
    'will list, with no figures. ';
}

/** The second call's system prompt: one statement over the tables it is given, and nothing else. */
export const SQL_SYSTEM_PROMPT =
  'You write ONE DuckDB SQL statement that answers the question from the TABLES given. Rules: one read-only SELECT ' +
  '(WITH, WITH RECURSIVE and window functions are fine); read ONLY the tables listed, by the table name given; a "number" ' +
  'column is DOUBLE and every other column is VARCHAR, so CAST a date column to DATE before comparing or subtracting ' +
  'dates; name every output column with AS, in plain words; put a label column first and the figures after it; ORDER BY ' +
  'so the result reads in order; never invent a table or a column, and never write into the SQL a figure the data ' +
  'should compute. Reply with the SQL statement only: no prose, no code fence, no comment.';

/** One table the second call may read: the gate's name for a dataset, and its columns as SQL sees them. */
export interface SqlTable {
  /** The identifier the gate exposes it under (../engine/sqlDatasets `projectNames`' slug). */
  table: string;
  name: string;
  /** Its size; none for a Live dataset (`live`), whose rows are the warehouse's. */
  rows?: number;
  live?: true;
  /** One row per this column (the table doc's key), and the grain sentence. */
  key?: string;
  grain?: string;
  columns: Array<Pick<ParsedColumn, 'name' | 'type'>>;
}

/**
 * Told with the tables when one is Live (docs/live-data/01-live-sql.md, F3): its statement is translated for the source
 * warehouse, which takes a narrower SQL (F1's allow-list) and reads dates as DATE (F-D7). Guidance only: the translator
 * refuses what it does not take, whatever the model writes.
 */
export const LIVE_SQL_RULES =
  'A table marked Live is read in its source warehouse, so the statement must use plain SQL only: a "date" column of a Live ' +
  'table is already a DATE (no CAST needed); no WITH RECURSIVE, LATERAL, QUALIFY, PIVOT, GROUPING SETS, VALUES, table ' +
  'functions, lists or structs, regex functions, lower, upper, length, substring, round, now() or ILIKE.';

/** A relationship between two of the tables, many FROM rows to one TO row (or one to one). */
export interface SqlLink { from: string; fromColumn: string; to: string; toColumn: string; oneToOne: boolean }

/** A name as SQL writes it: bare when it can be, else quoted as ../engine/datasetView `quoteIdent` quotes. */
const ident = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** The second call's facts: each picked dataset's every column and type, its key and size, and the links between them. */
export function tablesBlock(tables: readonly SqlTable[], links: readonly SqlLink[]): string {
  const lines = ['TABLES'];
  for (const t of tables) {
    const about = [`the dataset ${JSON.stringify(t.name)}`, t.live ? 'Live' : `${(t.rows ?? 0).toLocaleString('en-US')} rows`];
    if (t.key) about.push(`one row per ${ident(t.key)}`);
    else if (t.grain) about.push(t.grain.slice(0, 120));
    lines.push(`- ${ident(t.table)} (${about.join(' · ')})`);
    lines.push(`    ${t.columns.map((c) => `${ident(c.name)} ${c.type}`).join(', ')}`);
  }
  if (tables.some((t) => t.live)) lines.push(`NOTE: ${LIVE_SQL_RULES}`);
  if (links.length) {
    lines.push('LINKS');
    for (const l of links) {
      lines.push(`- ${ident(l.from)}.${ident(l.fromColumn)} → ${ident(l.to)}.${ident(l.toColumn)} (${l.oneToOne ? 'one to one' : 'many to one'})`);
    }
  }
  return lines.join('\n');
}

/** The second call's reply as one statement: a code fence the model wrote anyway taken off. '' for nothing usable. */
export function sqlFromReply(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim();
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(s);
  if (fenced) s = fenced[1].trim();
  return s; // too long, or not a read: the gate says so in compile()
}

// ── The turn's stored SQL (./copilot) ───────────────────────────────────────

/**
 * What an SQL answer turn keeps: the statement, the datasets it read (the gate's deps, by id) and its title. `table`: it
 * read a source table (docs/live-data/01-live-sql.md F5), whose doc's id is in `datasetIds`, on this connection (one per
 * statement, F-D9), as `AnswerSpec.table`.
 */
export interface SqlTurn { text: string; datasetIds: string[]; title: string; table?: string }

/** A stored or new SQL turn, re-sanitized; undefined when it is not one. */
export function sanitizeSqlTurn(raw: unknown): SqlTurn | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  const ids = Array.isArray(o.datasetIds) ? [...new Set(o.datasetIds.filter((x): x is string => isValidId(x)))] : [];
  if (!text || text.length > MAX_SQL_TEXT || !ids.length || ids.length > MAX_SQL_DATASETS || ids.length !== (o.datasetIds as unknown[]).length) return undefined;
  const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
  return { text, datasetIds: ids, title: title || 'Answer', ...(isValidId(o.table) ? { table: o.table } : {}) };
}

/** Same statement: whitespace aside. */
export const sameSql = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// ── The card ────────────────────────────────────────────────────────────────

/** What the browser draws for an SQL answer (../ipc/answerSql `cardOf`). Every cell is DuckDB's; the caption and bullets are the app's. */
export interface SqlCard {
  ok: true;
  kind: 'sql';
  title: string;
  /** The statement over dataset names, as the card's "Show SQL" shows it. Never a dataset's origin. */
  sql: string;
  /** The names of the datasets it read. */
  datasets: string[];
  columns: Array<{ name: string; type: ColumnType }>;
  rows: Cell[][];
  rowCount: number;
  /** The gate's row cap cut it: `rows` holds the first `rowCount`. */
  truncated: boolean;
  caption: string;
  bullets: string[];
  /** A label column and one number column, short enough to draw: that chart too. */
  chart?: { type: 'column' | 'line'; data: ChartData };
  /** Over Live datasets: when the warehouse answered, cached or stale (../engine/live/liveSql). */
  asOf?: AsOf;
}
