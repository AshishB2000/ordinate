// Column readings and filter predicates for the live compiler — PURE.
// docs/live-data/00-plan.md L2.2.
//
// The live twin of `residentFilter.ts` + `residentCategory.ts`'s primitives,
// over a warehouse's TYPED columns instead of our all-VARCHAR Parquet. The
// rules are the extract's, stated once per reading:
//
//   number  the dialect's safe cast, kept only when FINITE (a stored extract
//           only ever holds finite numbers — parse.isFiniteNumber);
//   text    the value as text; NULL compares as '' (`transforms.cellToString`);
//   date    a DATE for bucketing and periods; for text comparisons its
//           'YYYY-MM-DD' day — what an extract of a DATE column stores.
//
// Every value is a bound parameter (D4). `transforms.stepFilter` is the
// reference for every operator; each branch below names the line it mirrors.

import type { Cell } from '../../data/transforms';
import { coerceValue } from '../../data/parse';
import type { LiveColumn, LiveFilter, LiveRefusal } from './liveSpec';
import { columnOf, refuse } from './liveSpec';
import type { CompileDialectId, SqlDialect } from './dialect';
import { isTextSourceType, likePattern } from './dialect';
import type { ParamSink } from './sqlParams';
import { daysFromIso, isoFromDays } from '../../analysis/dateIntel';

/** The source relation's alias. Every column is read qualified by it. */
export const SRC = 'lv_src';

export interface Ctx {
  d: SqlDialect;
  b: ParamSink;
  columns: LiveColumn[];
  /** How a column is named, when not `lv_src."<name>"` (a Snowflake semantic view's dimension, part 7 c1). */
  ref?: (col: LiveColumn) => string;
  /** The source table's sort, cluster or partition key columns (its stored facts, ./liveDateRange): a date range on one may compile raw (`RAW_RANGE_DIALECTS`). */
  keys?: readonly string[];
}

/**
 * The dialects whose date range on a key column compiles as a half-open range on the RAW column
 * (`col >= start AND col < end + 1 day`) instead of through the cast (`dateOf`), which may stop a
 * warehouse skipping partitions. EMPTY until the warehouse nightly's numbers (scripts/warehousePruning.ts,
 * docs/assistant/00-design.md "Live date filters on key columns") say a dialect's cast costs bytes; the
 * parity suite adds 'duckdb' to prove both forms answer the same.
 */
export const RAW_RANGE_DIALECTS = new Set<CompileDialectId>();

const SQL_OP: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

/** `CASE WHEN x IS NULL THEN 1 ELSE 0 END` — a portable NULLS LAST. */
export function nullsLast(x: string): string {
  return `CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END`;
}

export function colRef(c: Ctx, col: LiveColumn): string {
  return c.ref ? c.ref(col) : `${SRC}.${c.d.ident(col.name)}`;
}

function storedAsText(col: LiveColumn): boolean {
  return isTextSourceType(col.sourceType);
}

/** A `number` column as a finite double, else NULL. */
export function numberOf(c: Ctx, col: LiveColumn): string {
  return c.d.number(colRef(c, col), storedAsText(col));
}

/** A `date` column as a DATE, else NULL. */
export function dateOf(c: Ctx, col: LiveColumn): string {
  return c.d.date(colRef(c, col), storedAsText(col), col.sourceType ?? '');
}

export function textOf(c: Ctx, col: LiveColumn): string {
  return c.d.text(colRef(c, col));
}

/**
 * A text column as a GROUP key (a text category, a text split). Every import
 * stores '' as null (`parse.finalizeTable` → `coerceCell`: exactly '' — a
 * whitespace-only cell stays text), so a copy has ONE blank category where a
 * warehouse keeps '' and NULL apart. Folding '' into NULL makes them one group,
 * labelled '' and ranked as the copy's null is. Filters need no fold: they
 * compare a NULL as '' already (`coalesce`). Found in L3.2, fixed in L2.8.
 */
export function keyText(c: Ctx, col: LiveColumn): string {
  const t = textOf(c, col);
  return `CASE WHEN ${t} = '' THEN NULL ELSE ${t} END`;
}

/**
 * The text an extract compares this cell by. A date the warehouse holds as a
 * DATE is compared by its ISO day — the text an extract of it holds. (An
 * extract of a TIMESTAMP holds the time too; that divergence is documented in
 * docs/live-data/log.md and pinned by test-liveCompile.)
 */
function compareText(c: Ctx, col: LiveColumn): string {
  if (col.type === 'date' && !storedAsText(col)) return c.d.isoDay(dateOf(c, col));
  return textOf(c, col);
}

/**
 * TRUE when the cell is empty to `transforms.isEmptyCell` — null, '' or JS
 * whitespace. Never NULL. A number column's cell is empty exactly when it holds
 * no finite number (that is what an extract stores there: a number or null); a
 * DATE column's exactly when it is NULL.
 */
export function emptyOf(c: Ctx, col: LiveColumn): string {
  if (col.type === 'number') return `(${numberOf(c, col)} IS NULL)`;
  if (col.type === 'date' && !storedAsText(col)) return `(${colRef(c, col)} IS NULL)`;
  return c.d.blank(textOf(c, col), c.b);
}

function cellText(cell: Cell): string {
  return cell == null ? '' : String(cell);
}

/** One IR filter as a never-NULL SQL predicate, or a refusal. */
export function predicate(c: Ctx, f: LiveFilter): string | LiveRefusal {
  if (f.kind === 'range' && f.partitionTime) return partitionTimeRange(c, f);
  const col = columnOf(c.columns, f.column);
  if (!col) return refuse('unknownColumn', f.column);

  switch (f.kind) {
    case 'empty': {
      const e = emptyOf(c, col);
      return f.negate ? `(NOT ${e})` : e;
    }
    case 'contains': {
      // transforms: `cellToString(cell).includes(needle)` — case-SENSITIVE, a
      // null cell is '', an empty needle matches every row. LIKE is
      // case-sensitive in all six dialects; `%`, `_` and the escape are escaped.
      if (col.type === 'number') return refuse('containsNumber', col.name);
      const pattern = c.b.bind('text', likePattern(f.value, c.d.likeEscape));
      return `(${c.d.like(`coalesce(${compareText(c, col)}, '')`, pattern)})`;
    }
    case 'in': {
      let inner: string;
      if (col.type === 'number') {
        // transforms: entries through the strict number gate; an entry that is
        // not a finite number can never match and is dropped. None left → FALSE.
        const targets = new Set<number>();
        for (const v of f.values) {
          const n = coerceValue(v ?? null, 'number');
          if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
        }
        inner = targets.size === 0
          ? 'FALSE'
          : `coalesce(${numberOf(c, col)} IN (${[...targets].map((n) => c.b.bind('number', n)).join(', ')}), FALSE)`;
      } else {
        const targets = new Set<string>(f.values.map((v) => cellText(v)));
        // A lock compares bytes (row-policy D13): `east` is not `East` on a case-insensitive warehouse either.
        const as = (x: string): string => (f.binary ? c.d.binary(x) : x);
        inner = `(${as(`coalesce(${compareText(c, col)}, '')`)} IN (${[...targets].map((t) => as(c.b.bind('text', t))).join(', ')}))`;
      }
      // `not in` is the EXACT complement: a null cell is in no list, so it stays.
      return f.negate ? `(NOT ${inner})` : inner;
    }
    case 'range': {
      // dateIntel.periodDay / answers' ISO bounds: inclusive, a cell with no date is out.
      if (col.type !== 'date') return refuse('periodNotDate', col.name);
      const raw = rawRange(c, col, f);
      if (raw) return raw;
      const d = dateOf(c, col);
      const parts = [`${d} IS NOT NULL`];
      if (f.from) parts.push(`${d} >= ${c.b.bind('date', f.from)}`);
      if (f.to) parts.push(`${d} <= ${c.b.bind('date', f.to)}`);
      return `(${parts.join(' AND ')})`;
    }
    case 'compare': {
      if (!SQL_OP[f.op]) return refuse('badQuery');
      if (col.type === 'number') {
        // transforms: the target through coerceValue (so '007' is no number and
        // the filter keeps nothing, `!=` included); a null cell is false for
        // every operator.
        const t = coerceValue(f.value ?? null, 'number');
        if (typeof t !== 'number' || !Number.isFinite(t)) return 'FALSE';
        return `(${numberOf(c, col)} ${SQL_OP[f.op]} ${c.b.bind('number', t)})`;
      }
      // Text and date compare as text, a null cell as '' — so `!=` and `<` keep it.
      if (f.binary && (f.op === '=' || f.op === '!=')) return `(${c.d.binary(`coalesce(${compareText(c, col)}, '')`)} ${SQL_OP[f.op]} ${c.d.binary(c.b.bind('text', cellText(f.value)))})`;
      return `(coalesce(${compareText(c, col)}, '') ${SQL_OP[f.op]} ${c.b.bind('text', cellText(f.value))})`;
    }
    default:
      return refuse('badQuery');
  }
}

/**
 * How a key column's raw values meet a day boundary exactly as its cast to DATE does, as the type the
 * bound day is sent as; null when they may not (text, or a type not known to be a date or a time).
 * A DATE is compared with a DATE. A timestamp of any zone kind is compared with a DATE the engine
 * promotes to midnight in the session zone, the same zone its cast to DATE reads (UTC on Snowflake,
 * Postgres and Redshift; Snowflake's TIMESTAMP_TZ casts through UTC in `date`). BigQuery promotes a
 * DATE to DATETIME but not to TIMESTAMP, so a TIMESTAMP is compared with a TIMESTAMP (UTC midnight).
 */
function rawDayType(d: CompileDialectId, sourceType: string): 'date' | 'timestamp' | null {
  if (sourceType === '' || /^date$/i.test(sourceType)) return 'date';
  if (/time/i.test(sourceType)) return d === 'bigquery' && /^timestamp$/i.test(sourceType) ? 'timestamp' : 'date';
  return null;
}

/** A `range` on a key column as a half-open range on the raw column, or null for the cast form (`RAW_RANGE_DIALECTS`). */
function rawRange(c: Ctx, col: LiveColumn, f: { from?: string; to?: string }): string | null {
  if (!RAW_RANGE_DIALECTS.has(c.d.id) || !c.keys?.includes(col.name) || storedAsText(col)) return null;
  const type = rawDayType(c.d.id, col.sourceType ?? '');
  const from = f.from === undefined ? undefined : daysFromIso(f.from);
  const to = f.to === undefined ? undefined : daysFromIso(f.to);
  // A bound that is not an ISO day keeps the cast form, which binds it as given.
  if (!type || from === null || to === null) return null;
  const x = colRef(c, col);
  // A TIMESTAMP bound is that day's UTC midnight, spelled as every connector's timestamp parameter is (ISO 8601).
  const day = (n: number): string => (type === 'timestamp' ? `${isoFromDays(n)}T00:00:00.000Z` : isoFromDays(n));
  const parts = [`${x} IS NOT NULL`];
  if (from !== undefined) parts.push(`${x} >= ${c.b.bind(type, day(from))}`);
  if (to !== undefined) parts.push(`${x} < ${c.b.bind(type, day(to + 1))}`);
  return `(${parts.join(' AND ')})`;
}

/**
 * BigQuery's `_PARTITIONTIME` (an ingestion-time partitioned table, ./liveDateRange) in an inclusive day range,
 * half-open on the raw pseudo-column against TIMESTAMPs at UTC midnight, as a partition boundary is. A base
 * filter only, so it is read on the table scan itself. Any other dialect, or a bound that is not an ISO day,
 * is refused: never a cast that would stop the warehouse pruning, and never a dropped filter.
 * Checked against BigQuery's rules (docs/live-data/log.md, 2026-11-16) but for the alias qualifier `lv_src.`, which its
 * documentation never shows: the warehouse nightly runs it on a real table (scripts/warehouseLivePartitionTime.ts).
 */
function partitionTimeRange(c: Ctx, f: { column: string; from?: string; to?: string }): string | LiveRefusal {
  if (c.d.id !== 'bigquery' || f.column !== '_PARTITIONTIME') return refuse('badQuery');
  const from = f.from === undefined ? undefined : daysFromIso(f.from);
  const to = f.to === undefined ? undefined : daysFromIso(f.to);
  if (from === null || to === null || (from === undefined && to === undefined)) return refuse('badQuery');
  const x = `${SRC}._PARTITIONTIME`;
  const day = (n: number): string => c.b.bind('timestamp', `${isoFromDays(n)}T00:00:00.000Z`);
  const parts: string[] = [];
  if (from !== undefined) parts.push(`${x} >= ${day(from)}`);
  if (to !== undefined) parts.push(`${x} < ${day(to + 1)}`);
  return `(${parts.join(' AND ')})`;
}

/** Every filter as a predicate, in order, or the first refusal: a statement's WHERE (base filters first). */
export function predicates(c: Ctx, filters: readonly LiveFilter[] | undefined): string[] | LiveRefusal {
  const out: string[] = [];
  for (const f of filters ?? []) {
    const s = predicate(c, f);
    if (typeof s !== 'string') return s;
    out.push(s);
  }
  return out;
}
