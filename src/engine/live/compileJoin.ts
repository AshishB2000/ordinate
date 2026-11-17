// A Live chart across saved relationships (docs/live-data/00-plan.md L4, "Joins across datasets") — PURE, as ./compile.
//
// Every dataset in the chain is Live on ONE connection, so its warehouse holds every table and ONE statement reads
// them all. The join stands where a dataset's FROM item would: one derived table aliased `lv_src`, each merged
// column re-exposed positionally (`lv_c<i>`, named through `Ctx.ref`), so ./compile's chart, metric and probes run
// over it unchanged — the trick src/engine/joinResident.ts plays on our Parquet, played in the warehouse.
//
// The rules of analysis/joinJs.ts, in SQL:
//   1. KEYS: `profileSql.keyOf` on each side, NULL when empty (null, '' or JS whitespace; for a number column, no
//      finite number), so an empty key matches nothing. Text compares as BYTES (`binary`), a number as a double
//      (String(n) is one-to-one on finite doubles; −0 is folded into 0, one partition) — on BigQuery, which partitions
//      by no float, the window partitions by its 17-digit text, as one-to-one. A number key linked to a text one is refused
//      (`joinKeyTypes`): joinJs matches String(7) with '7', which SQL has no portable spelling of.
//   2. ONE ROW PER HOP: the "one" side is cut to one row per non-NULL key before the LEFT JOIN (`row_number() … = 1`),
//      so no primary row repeats, whatever the warehouse holds (a relationship's cardinality is never enforced there).
//      joinJs keeps the FIRST row in file order; a warehouse has none, so this keeps the SMALLEST by the columns the
//      statement reads from that table, in their declared order (NULL last, text by its bytes — Redshift's `binary`
//      is an md5, still one row), then its onward keys. Rows that tie read the same to every reader, so the pick is
//      deterministic. Where a key's rows DISAGREE on a column read, Live and a copy may show different rows: a named
//      divergence (docs/live-data/log.md, 2026-11-16), pinned by scripts/test-liveJoins.ts — Live equals joinJs over
//      that table with its smallest row first.
//   3. NO FAN-IN: a related row reached by many primary rows counts ONCE per group for a measure on it. After rule 2 a
//      related row IS its key, so `lv_src` exposes `lv_r<t>` (table t's `lv_k`) for each table a measure sits on, and
//      ./compile masks the measure's input to the first row of each (group key…, lv_r<t>) — `fanInMask`, a window over
//      the filtered rows, as joinResident's `maskedCol` (no group for a KPI). Every row of such a partition holds the
//      same related row, so which one survives is irrelevant: rule 2's pick chooses the row, the mask counts it once.
//      A measure on the primary needs none: its rows never repeat.
//   An unmatched row reads NULL (on ClickHouse only with `join_use_nulls`, else the type's default), and a hop after
//   one that found nothing finds nothing, as in joinJs.
//
// Each side's scan is its own dataset's (`prepare` + `whereOf` on its own env, into the statement's one ParamSink):
// its base filters, calculated fields and `_PARTITIONTIME` innermost, then `JoinSide.filters` — the caller's lock on
// it and the range its table requires. The question's filters on PRIMARY columns go inside the primary's scan as well
// (its rows are 1:1 with the join's, so filtering before is filtering after, and the warehouse prunes its partitions);
// a filter on a related column stays outside, on the joined cell, as joinJs reads it (`Prepared.inner`).

import type { LiveColumn, LiveColumnMeasure, LiveFilter, LiveIR, LiveRefusal } from './liveSpec';
import { columnOf, isRefusal, refuse } from './liveSpec';
import type { CompileEnv, Prepared } from './compile';
import { prepare, whereOf } from './compile';
import type { SqlDialect } from './dialect';
import { isTextSourceType } from './dialect';
import type { Ctx } from './compileFilter';
import { SRC, colRef, dateOf, nullsLast, numberOf, textOf } from './compileFilter';
import type { ParamSink } from './sqlParams';
import { keyOf } from './profileSql';

/** One table of the join: its own dataset's env, what its scan filters besides its base filters, and the hop adding it. */
export interface JoinSide {
  /** Its own dialect, source (calcs included), DECLARED columns, base filters and keys — as its dataset's own questions. */
  env: CompileEnv;
  /** The caller's row lock on it and the range its table requires (a related side's); the primary's are the question's. */
  filters: LiveFilter[];
  /** The hop that adds it: the side its key is read on (an earlier one) and the two key columns. None for the primary. */
  via?: { parent: number; from: string; to: string };
}

export interface LiveJoin {
  /** [0] is the primary. */
  sides: JoinSide[];
  /** Merged column i (`CompileEnv.columns[i]`) → its side and its own name there. */
  columns: { table: number; column: string }[];
}

/** What a ClickHouse statement over a join ends with, as ./sql/print.ts's: an unmatched row then reads NULL, not the type's default. */
export const JOIN_NULLS = '\nSETTINGS join_use_nulls = 1';

// Test seam: the negative control drops the one-row-per-key cut (scripts/test-liveJoins.ts).
let cutOneSide = true;
export function setJoinCutForTest(on: boolean): void {
  cutOneSide = on;
}

// Test seam: the negative control drops the fan-in mask (scripts/test-liveJoinMeasures.ts).
let maskFanIn = true;
export function setJoinMaskForTest(on: boolean): void {
  maskFanIn = on;
}

/** Rule 3: `v` on the first row of its partition only (NULL on the rest). `by`: window-ready keys (no float on BigQuery: `partitionOf`). */
export function fanInMask(v: string, by: string[]): string {
  if (!maskFanIn) return v;
  return `CASE WHEN row_number() OVER (PARTITION BY ${by.join(', ')} ORDER BY ${by.join(', ')}) = 1 THEN ${v} END`;
}

/** Rule 1: `col`'s join key, NULL when empty; text as bytes; −0 and 0 one number (String(-0) is '0'), so they share a partition. */
function joinKey(c: Ctx, col: LiveColumn): string {
  const k = keyOf(c, col);
  return col.type === 'number' ? `CASE WHEN ${k} = 0 THEN ${c.d.toDouble('0')} ELSE ${k} END` : c.d.binary(k);
}

/** A key as a window's PARTITION BY: BigQuery partitions by no float, so a number key goes there as its round-trip text (17 digits). */
export function partitionOf(c: Pick<Ctx, 'd'>, key: string, col: Pick<LiveColumn, 'type'>): string {
  return col.type === 'number' && c.d.id === 'bigquery' ? `FORMAT('%.17g', ${key})` : key;
}

/** Rule 2's order on one column: NULL last, then the value its readers see (a date stored as text: then its text). */
function pickOrder(c: Ctx, col: LiveColumn): string[] {
  const asc = (v: string): string[] => [nullsLast(v), v];
  if (col.type === 'number') return asc(numberOf(c, col));
  const bytes = asc(c.d.binary(textOf(c, col)));
  return col.type === 'date' ? [...asc(dateOf(c, col)), ...(isTextSourceType(col.sourceType) ? bytes : [])] : bytes;
}

/**
 * `prepare` for a joined env (./compile calls it): every side's scan, the LEFT JOIN chain, and the context the chart
 * reads the merged columns through. `names`: the merged columns the statement reads, already checked declared.
 */
export function joinPrepare(ir: LiveIR, env: CompileEnv & { join: LiveJoin }, b: ParamSink, d: SqlDialect, ms: LiveColumnMeasure[], names: string[]): Prepared | LiveRefusal {
  const { sides, columns: at } = env.join;
  const merged = env.columns;
  if (!Array.isArray(sides) || sides.length < 2 || !Array.isArray(at) || at.length !== merged.length) return refuse('badQuery');
  const index = new Map(merged.map((col, i) => [col.name, i]));
  const inner = (f: LiveFilter): boolean => at[index.get(f.column) ?? -1]?.table === 0;
  const read = [...new Set(names.flatMap((n) => (index.has(n) ? [index.get(n) as number] : [])))].sort((x, y) => x - y);
  // A table the statement reads nothing from, nor through, is left out: its LEFT JOIN keeps every row once, so it changes nothing.
  const used = (t: number): boolean => read.some((i) => at[i].table === t) || sides.some((s, k) => k > t && s.via?.parent === t && used(k));
  const kids = (t: number): number[] => sides.flatMap((s, k) => (k > 0 && s.via?.parent === t && used(k) ? [k] : []));
  const parts: string[] = [];
  for (let t = 0; t < sides.length; t++) {
    const s = sides[t];
    const via = s.via;
    if (t > 0 && (!via || !(via.parent >= 0 && via.parent < t))) return refuse('badQuery');
    if (t > 0 && !used(t)) continue;
    const mine = read.filter((i) => at[i].table === t);
    const onward = kids(t).map((k) => sides[k].via!.from);
    // The scan reads what is exposed and every key, so a calculated one gets its layer.
    const filters = t === 0 ? [...s.filters, ...ir.filters.filter(inner)] : s.filters;
    const probe: LiveIR = { kind: 'metric', measures: [...mine.map((i) => at[i].column), ...(via ? [via.to] : []), ...onward].map((column) => ({ column, aggregation: 'count' })), filters, order: 'natural', weekCal: null };
    const p = prepare(probe, s.env, b);
    if (isRefusal(p)) return p;
    if (p.c.d.id !== d.id) return refuse('badQuery'); // one statement is one warehouse's
    const where = whereOf(p, probe);
    if (isRefusal(where)) return where;
    const col = (name: string): LiveColumn => columnOf(p.c.columns, name)!;
    const sel = mine.map((i) => `${colRef(p.c, col(at[i].column))} AS lv_c${i}`);
    kids(t).forEach((k, j) => sel.push(`${joinKey(p.c, col(onward[j]))} AS lv_j${k}`));
    if (!via) {
      parts.push(`(SELECT ${sel.length ? sel.join(', ') : '1 AS lv_one'} FROM ${p.from}${where}) AS lv_t0`);
      continue;
    }
    const from = columnOf(sides[via.parent].env.columns, via.from);
    if (!from) return refuse('unknownColumn', via.from);
    if ((from.type === 'number') !== (col(via.to).type === 'number')) return refuse('joinKeyTypes', via.from);
    const key = joinKey(p.c, col(via.to));
    const order = [...mine.flatMap((i) => pickOrder(p.c, col(at[i].column))), ...onward.flatMap((n) => [nullsLast(joinKey(p.c, col(n))), joinKey(p.c, col(n))])];
    const rn = `row_number() OVER (PARTITION BY ${partitionOf(p.c, key, col(via.to))} ORDER BY ${order.length ? order.join(', ') : key}) AS lv_rn`;
    const out = ['lv_k', ...mine.map((i) => `lv_c${i}`), ...kids(t).map((k) => `lv_j${k}`)].join(', ');
    parts.push(`LEFT JOIN (SELECT ${out} FROM (SELECT ${[`${key} AS lv_k`, ...sel, rn].join(', ')} FROM ${p.from}${where}) AS lv_r ` +
      `WHERE ${cutOneSide ? 'lv_rn = 1 AND ' : ''}lv_k IS NOT NULL) AS lv_t${t} ON lv_t${via.parent}.lv_j${t} = lv_t${t}.lv_k`);
  }
  const sel = read.map((i) => `lv_t${at[i].table}.lv_c${i} AS lv_c${i}`);
  if (!sel.length) return refuse('badQuery');
  // Rule 3: each related table a measure sits on, its row exposed (only then, so every other statement is unchanged).
  const tableOf = (m: LiveColumnMeasure): number => at[index.get(m.column) ?? -1]?.table ?? 0;
  const masked = [...new Set(ms.map(tableOf).filter((t) => t > 0))].sort((x, y) => x - y);
  for (const t of masked) sel.push(`lv_t${t}.lv_k AS lv_r${t}`);
  if (d.id === 'clickhouse') b.suffix = JOIN_NULLS;
  const c: Ctx = { d, b, columns: merged, ref: (x) => `${SRC}.lv_c${index.get(x.name)}` };
  const rowOf = (m: LiveColumnMeasure): string | null => {
    const t = tableOf(m);
    return t > 0 ? partitionOf(c, `${SRC}.lv_r${t}`, columnOf(sides[t].env.columns, sides[t].via!.to)!) : null;
  };
  return { c, from: `(SELECT ${sel.join(', ')} FROM ${parts.join(' ')}) AS lv_src`, base: [], ms, inner, ...(masked.length ? { rowOf } : {}) };
}
