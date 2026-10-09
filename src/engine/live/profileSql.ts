// The schema profile's ONE sampled statement per table, and its reading —
// PURE: builds strings and reads rows, queries nothing.
// docs/live-data/00-plan.md L2.5 (D4, D9).
//
// "Sync schema" (./schemaSync.ts) learns, per declared column, how much of a
// sample is filled, how many distinct values it holds and — for a
// low-cardinality text column — its most frequent values. All of it in ONE
// statement over ONE sample, so a warehouse that bills per scan (BigQuery) or
// re-evaluates a CTE per reference is asked once:
//
//   lv_in    the sample: the declared columns of the table (the engine's own
//            sample clause, then a LIMIT) or of the defining query (a LIMIT),
//            each read as a KEY — NULL when the cell is empty by the
//            compiler's rule (`emptyOf`: null, '' or JS whitespace), else its
//            text (a number: its finite value);
//   lv_ix    the set ids 0…n, as constants (`SELECT 0 UNION ALL SELECT 1 …`,
//            the one spelling all six engines take);
//   lv_cell  the sample UNPIVOTED: every (row, set) pair once — set 0 is the
//            grand total, set i+1 is column i's key, a number's in a DOUBLE
//            slot (`lv_n`), any other's in a text slot (`lv_t`);
//   lv_g     GROUP BY (set, key): one group per distinct key of each column,
//            counting rows only (no per-group sketches);
//   lv_rank  per set: the distinct count (groups with a key), the filled count
//            (their rows), and each group's rank by frequency;
//   out      the total row, one row per non-text column, and a text column's 21
//            most frequent values (21: one past the 20 kept, so "more than 20"
//            is known without a second count).
//
// WHY UNPIVOT, not GROUP BY GROUPING SETS ((), (k0), (k1), …): every grouping
// set carries every key column, so its work grows with columns × columns — on
// the DuckDB bench a 500-column, 2,000-row sample ran out of a 1 GiB worker,
// where the unpivot (rows × columns cells, three narrow slots) took 1.4 s, and
// it was faster at every width measured (docs/live-data/log.md, L2.5). The
// sample is still read ONCE: `lv_in` is referenced once, in the CROSS JOIN, so
// an engine that re-evaluates a CTE per reference (BigQuery) samples once.
// Every count leaves CAST to the dialect's DOUBLE, ids as integers.
//
// THE RULES (the compiler's): identifiers only from the declared schema,
// quoted per dialect, NUL and empty names refused; values only as bound
// parameters (the whitespace class each `blank()` binds, the ClickHouse probe's
// names). The sample SIZE and the set ids are the one exception: app-chosen
// counts, never a request's, spliced as checked digits (`sqlInt`/`sqlPercent`,
// and integers from the column count) because no engine binds a parameter in
// its sample clause.

import type { CompileEnv, LiveSource } from './compile';
import type { SamplePlan, SqlDialect } from './dialect';
import { sqlInt } from './dialect';
import { dialectFor } from './dialects';
import { emptyOf, nullsLast, numberOf, textOf, type Ctx } from './compileFilter';
import type { LiveColumn, LiveRefusal } from './liveSpec';
import { isRefusal, refuse } from './liveSpec';
import type { CompiledQuery } from './sqlParams';
import { ParamSink, hasNul } from './sqlParams';
import type { LiveRows } from './shape';
import { LOW_CARDINALITY, MAX_SAMPLE_CHARS, PROFILE_MAX_COLUMNS, PROFILE_SAMPLE_VALUES } from '../../data/liveProfile';

export type ProfileCompiled = { ok: true; query: CompiledQuery } | LiveRefusal;

/** The sample's row bounds and the cells it may read (rows × columns): the cost model. */
export const PROFILE_MAX_ROWS = 10_000;
export const PROFILE_MIN_ROWS = 1_000;
export const PROFILE_CELL_BUDGET = 1_000_000;

/**
 * Rows to sample for a table of `columns` columns: 10,000, fewer for a wide
 * table so the grouping stays within ~1M (row, column) pairs, never under
 * 1,000. Measured on the DuckDB bench: docs/live-data/log.md, L2.5.
 */
export function sampleRowsFor(columns: number): number {
  const n = Math.max(1, Math.floor(columns));
  return Math.max(PROFILE_MIN_ROWS, Math.min(PROFILE_MAX_ROWS, Math.floor(PROFILE_CELL_BUDGET / n)));
}

/**
 * BigQuery's TABLESAMPLE percent for `rows` of a table the catalog puts at
 * `estimate` rows: twice the share (block sampling is lumpy, and a short
 * sample would undercount distinct values), none when the table is not much
 * larger than the sample or the catalog does not say.
 */
export function samplePercent(rows: number, estimate: number | undefined): number | undefined {
  if (estimate === undefined || !Number.isFinite(estimate) || estimate <= rows * 2) return undefined;
  return Math.min(100, (rows * 200) / estimate);
}

function badName(name: unknown): boolean {
  return typeof name !== 'string' || name === '' || hasNul(name);
}

/**
 * The sample as a FROM item: the declared columns of the table under the
 * engine's sample clause, or of the defining query (on its own lines, rule
 * F3), then LIMIT. Throws when a size is not a checked literal.
 */
function sampledFrom(d: SqlDialect, src: LiveSource, columns: LiveColumn[], plan: SamplePlan): string | LiveRefusal {
  const cols = columns.map((c) => d.ident(c.name)).join(', ');
  const limit = `LIMIT ${sqlInt(plan.rows)}`;
  if (src && src.kind === 'table') {
    if (!Array.isArray(src.parts) || src.parts.length === 0) return refuse('badSource');
    if (src.parts.some(badName)) return refuse('badIdentifier');
    const clause = plan.limitOnly ? null : d.tableSample(plan);
    return `(SELECT ${cols} FROM ${src.parts.map((p) => d.ident(p)).join('.')}${clause ? ` ${clause}` : ''} ${limit}) AS lv_src`;
  }
  if (src && src.kind === 'sql' && typeof src.sql === 'string') {
    const sql = src.sql.replace(/[\s;]+$/, '');
    if (sql.trim() === '') return refuse('badSource');
    if (hasNul(sql)) return refuse('badIdentifier');
    return `(SELECT ${cols} FROM (\n${sql}\n) AS lv_q ${limit}) AS lv_src`;
  }
  return refuse('badSource');
}

/** Whether the engine's own sample clause applies — what the profile reports as its method. */
export function samples(env: CompileEnv, plan: SamplePlan): boolean {
  const d = dialectFor(env.dialect);
  try {
    return !!d && env.source?.kind === 'table' && !plan.limitOnly && d.tableSample(plan) !== null;
  } catch {
    return false;
  }
}

/** A column's key: NULL when empty, else a number's finite value or any other column's text. */
function keyOf(c: Ctx, col: LiveColumn): string {
  if (col.type === 'number') return numberOf(c, col);
  return `CASE WHEN ${emptyOf(c, col)} THEN NULL ELSE ${textOf(c, col)} END`;
}

/** `CASE lv_set WHEN i+1 THEN lv_ki … ELSE <null> END` over the given column indexes; the typed NULL when none. */
function keyBySet(idx: number[], typedNull: string): string {
  return idx.length ? `CASE lv_set ${idx.map((i) => `WHEN ${i + 1} THEN lv_k${i}`).join(' ')} ELSE ${typedNull} END` : typedNull;
}

/** The output columns, in SELECT order — rows are read positionally. */
export const PROFILE_OUTPUT = ['o_set', 'o_rn', 'o_v', 'o_c', 'o_nd', 'o_ne'] as const;

/** The profile statement over the declared columns (at most PROFILE_MAX_COLUMNS). */
export function compileProfile(env: CompileEnv, plan: SamplePlan): ProfileCompiled {
  const d = dialectFor(env.dialect);
  const columns = Array.isArray(env.columns) ? env.columns : [];
  if (!d || columns.length === 0 || columns.length > PROFILE_MAX_COLUMNS) return refuse('badQuery');
  if (columns.some((c) => !c || badName(c.name))) return refuse('badIdentifier');
  if (new Set(columns.map((c) => c.name)).size !== columns.length) return refuse('badQuery');
  const c: Ctx = { d, b: new ParamSink(), columns };
  let from: string | LiveRefusal;
  try {
    from = sampledFrom(d, env.source, columns, plan);
  } catch {
    return refuse('badQuery'); // a sample size that is not a checked literal
  }
  if (isRefusal(from)) return from;

  const all = columns.map((_, i) => i);
  const text = all.filter((i) => columns[i].type === 'text');
  const textIds = text.map((i) => String(i + 1)).join(', ');
  const tKey = keyBySet(all.filter((i) => columns[i].type !== 'number'), d.text('NULL'));
  const nKey = keyBySet(all.filter((i) => columns[i].type === 'number'), d.toDouble('NULL'));
  const value = text.length ? `CASE WHEN lv_set IN (${textIds}) THEN lv_t ELSE ${d.text('NULL')} END` : d.text('NULL');
  const cap = text.length ? `CASE WHEN lv_set IN (${textIds}) THEN ${PROFILE_SAMPLE_VALUES + 1} ELSE 1 END` : '1';
  const index = [0, ...all.map((i) => i + 1)].map((n) => `SELECT ${n} AS lv_set`).join(' UNION ALL ');
  const sql =
    `WITH lv_in AS (SELECT ${all.map((i) => `${keyOf(c, columns[i])} AS lv_k${i}`).join(', ')} FROM ${from}),\n` +
    `lv_ix AS (${index}),\n` +
    `lv_cell AS (SELECT lv_ix.lv_set AS lv_set, ${tKey} AS lv_t, ${nKey} AS lv_n FROM lv_in CROSS JOIN lv_ix),\n` +
    `lv_g AS (SELECT lv_set, lv_t, ${d.toDouble('count(*)')} AS lv_c, CASE WHEN lv_t IS NULL AND lv_n IS NULL THEN 0 ELSE 1 END AS lv_p ` +
    `FROM lv_cell GROUP BY lv_set, lv_t, lv_n),\n` +
    `lv_rank AS (SELECT lv_set, lv_t, lv_c, ` +
    `row_number() OVER (PARTITION BY lv_set ORDER BY lv_p DESC, lv_c DESC, ${nullsLast('lv_t')}, lv_t) AS lv_rn, ` +
    `sum(lv_p) OVER (PARTITION BY lv_set) AS lv_nd, sum(lv_p * lv_c) OVER (PARTITION BY lv_set) AS lv_ne FROM lv_g)\n` +
    `SELECT ${d.toInt('lv_set')} AS o_set, ${d.toInt('lv_rn')} AS o_rn, ${d.label(value)} AS o_v, ${d.toDouble('lv_c')} AS o_c, ` +
    `${d.toDouble('lv_nd')} AS o_nd, ${d.toDouble('lv_ne')} AS o_ne FROM lv_rank WHERE lv_rn <= ${cap} ORDER BY lv_set, lv_rn`;
  return { ok: true, query: c.b.finish(sql, d, [...PROFILE_OUTPUT]) };
}

/**
 * ClickHouse only: does the table declare a SAMPLE BY key? `SAMPLE n` on a
 * table without one is an error, so the profile asks first (system.tables, a
 * metadata read). The names travel as parameters. Null for every other
 * dialect and for a query source (nothing to ask; the LIMIT bounds it).
 */
export function compileSamplingKeyProbe(env: CompileEnv): ProfileCompiled | null {
  const d = dialectFor(env.dialect);
  if (!d || d.id !== 'clickhouse' || env.source?.kind !== 'table') return null;
  const parts = env.source.parts;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2 || parts.some(badName)) return refuse('badIdentifier');
  const b = new ParamSink();
  const db = parts.length === 2 ? b.bind('text', parts[0]) : 'currentDatabase()';
  const sql = `SELECT sampling_key AS o_key FROM system.tables WHERE database = ${db} AND name = ${b.bind('text', parts[parts.length - 1])}`;
  return { ok: true, query: b.finish(sql, d, ['o_key']) };
}

// ── Reading the rows ─────────────────────────────────────────────────────────

/** One column's figures from the sample. */
export interface ColumnFigures {
  name: string;
  filled: number;
  distinct: number;
  /** A low-cardinality text column's most frequent values, most frequent first (≤ 20). */
  values?: string[];
  counts?: number[];
}

export interface ProfileFigures {
  /** Rows the sample held. */
  rows: number;
  columns: ColumnFigures[];
}

/** A count off the wire: a number, or the decimal string a warehouse (BigQuery) or a BIGINT bridge sends. */
function countOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'string' && /^\s*\d+(\.0+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The profile statement's rows → per-column figures, or null when they are
 * not the shape it asked for (a refusal upstream: never a guessed profile).
 * Rows are positional to PROFILE_OUTPUT; their order is not trusted — each
 * value carries its set and rank.
 */
export function shapeProfile(rows: LiveRows, columns: LiveColumn[]): ProfileFigures | null {
  if (!Array.isArray(rows)) return null;
  let total = 0;
  const stats = new Map<number, { filled: number; distinct: number; ranked: [number, string, number][] }>();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== PROFILE_OUTPUT.length) return null;
    const set = countOf(r[0]);
    const rn = countOf(r[1]);
    const c = countOf(r[3]);
    const nd = countOf(r[4]);
    const ne = countOf(r[5]);
    if (set === null || rn === null || c === null || nd === null || ne === null || set > columns.length) return null;
    if (set === 0) {
      total = c;
      continue;
    }
    let s = stats.get(set);
    if (!s) stats.set(set, (s = { filled: ne, distinct: nd, ranked: [] }));
    const v = r[2];
    if (typeof v === 'string' && columns[set - 1].type === 'text') s.ranked.push([rn, v, c]);
  }
  const out: ColumnFigures[] = columns.map((col, i) => {
    const s = stats.get(i + 1);
    const f: ColumnFigures = { name: col.name, filled: s?.filled ?? 0, distinct: s?.distinct ?? 0 };
    if (!s || col.type !== 'text' || s.distinct > LOW_CARDINALITY) return f;
    const kept = s.ranked.sort((a, b) => a[0] - b[0]).filter(([, v]) => v.length <= MAX_SAMPLE_CHARS).slice(0, PROFILE_SAMPLE_VALUES);
    if (kept.length) Object.assign(f, { values: kept.map((k) => k[1]), counts: kept.map((k) => k[2]) });
    return f;
  });
  return { rows: total, columns: out };
}
