'use strict';

// The chart's GROUP BY key — MAIN PROCESS ONLY, and PURE: every function here
// builds a SQL string or decodes a returned one. Nothing queries.
//
// Split out of `residentQuery.ts` when it crossed the 800-line cap. The job is
// one thing: how a stored VARCHAR column becomes a group key, and how that key
// becomes an axis label. The physical-column primitives (`phys`, `sqlNum`,
// `bomSafe`) live here because the key is what they were written for;
// `residentQuery`'s filter compiler imports the same two so there stays exactly
// one spelling of each in the codebase.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: for a binned or grained category, SQL
// returns an INTEGER BUCKET ID and nothing else. Every label is then built by
// `analysis/categoryKey`, which is the same call `vizData.buildVizData` makes.
// A label formatted in SQL is how the two paths silently diverge — one side
// writing `2024-Q1` and the other `2024-Q01`, with nothing to catch it.

import type { ColumnType, ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import { binLabel, dateBucketLabel } from '../analysis/categoryKey';
import type { DateGrain } from '../analysis/categoryKey';
import { sqlEmpty } from './sqlGen';
import type { DuckValue } from './duckdb';

/**
 * How the group key is derived from the category column — the resident twin of
 * `vizData.rewriteCategory`. One discriminated union rather than a bag of
 * flags: the four cases are mutually exclusive by declared column type, and
 * each carries different data.
 *
 * `bin` carries `hi` as well as the geometry because the LAST bucket's upper
 * edge is the observed maximum, not `lo + bins*width`.
 */
export type ResidentCatKey =
  | { kind: 'raw' }
  | { kind: 'bin'; lo: number; hi: number; width: number; bins: number }
  | { kind: 'date'; grain: DateGrain }
  | { kind: 'other'; keep: string[]; keepNull: boolean; label: string };

// ── Physical column expressions ──────────────────────────────────────────────
//
// Physical names are positional `c0..cN`, the same contract `sqlGen.ts` and
// `parquetStore.ts` use. User-facing names never reach SQL, so identifier
// quoting, duplicate names and column-name injection are all structurally out of
// reach.

export function phys(i: number): string {
  return `c${i}`;
}

/** A finite JS number, or NULL. Mirrors `sqlGen`'s private `sqlNum`. */
export function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

// The transport in src/engine/duckdb.ts loses exactly ONE leading U+FEFF from
// every returned string (documented there; below the JS layer, unfixable
// there). Doubling a leading BOM at projection time is an exact inverse, and a
// value that does not start with one is untouched — the same fix
// `parquetStore.readTable` applies. Group LABELS are user data, so they get it;
// aggregates are DOUBLEs and cannot be affected.
const BOM = 'chr(65279)';

export function bomSafe(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

/**
 * The un-bucketed key and its label projection.
 *
 * `transforms.stepGroupAggregate` keys on the ROUND-TRIPPED cell, so a `number`
 * column groups on the JS number (`'1'` and `'1.0'` are one group; a
 * non-numeric or non-finite value is `null`) while a text/date column groups on
 * the string verbatim (`null` and `''` stay two distinct groups). Grouping on
 * the raw VARCHAR would split `1` from `1.0`; grouping on a cast would fuse
 * `'007'` with `'7'`. Hence: cast ONLY when the DECLARED type is number.
 */
function groupKeyExpr(cols: ParsedColumn[], gi: number): { group: string; label: string } {
  const p = phys(gi);
  if (cols[gi].type === 'number') {
    const n = sqlNum(p);
    return { group: n, label: n };
  }
  return { group: p, label: bomSafe(p) };
}

// ── Dates ────────────────────────────────────────────────────────────────────

// The TWO canonical date shapes — the only ones SQL implements, and the reason
// `residentQuery.resolveCatKey` probes the column before it groups. The
// components are assembled into an ISO string for TRY_CAST rather than passed
// to make_date(): TRY_CAST returns NULL for '2023-02-31' where make_date
// raises, and `categoryKey.parseDateCell` rejects the same non-dates through
// its civil-date round-trip.
const ISO_RE = '^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})$';
const US_RE = '^(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})$';

function shapeDate(v: string, re: string, y: number, m: number, d: number): string {
  // A non-match makes regexp_extract return '', nullif turns that into NULL,
  // and `||` propagates it — so any other shape yields NULL without a match
  // test of its own.
  return (
    `TRY_CAST(nullif(regexp_extract(${v}, '${re}', ${y}), '') || '-' || ` +
    `lpad(regexp_extract(${v}, '${re}', ${m}), 2, '0') || '-' || ` +
    `lpad(regexp_extract(${v}, '${re}', ${d}), 2, '0') AS DATE)`
  );
}

/** A stored date cell → DATE, or NULL when it is not one of the canonical shapes. */
export function sqlCanonicalDate(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `coalesce(${shapeDate(v, ISO_RE, 1, 2, 3)}, ${shapeDate(v, US_RE, 3, 1, 2)})`;
}

/**
 * The bucket id: days from the epoch to the truncated date — exactly
 * `categoryKey.dateBucket`. DuckDB's `date_trunc('week', …)` is MONDAY-based,
 * which is what makes the two agree. `date_diff` rather than `epoch_days()`
 * because it is the older, plainer spelling; the INTEGER cast keeps the id a JS
 * number rather than a BIGINT the bridge would hand back as a string.
 */
export function dateBucketSql(d: string, grain: DateGrain): string {
  return `CAST(date_diff('day', DATE '1970-01-01', date_trunc('${grain}', ${d})) AS INTEGER)`;
}

// ── The key, and the label it decodes to ─────────────────────────────────────

/**
 * The GROUP BY key and its projection for one `ResidentCatKey`. Bound
 * parameters are pushed in the order they appear in the returned expression.
 *
 * For every BUCKETED kind `group` and `label` are the same expression, which is
 * why `residentQuery.runAggregate` computes it once in a subquery and groups by
 * name: an expression carrying `?`s must be bound exactly once. Only the raw
 * kind keeps them distinct (the label gets the BOM workaround; the key does not
 * need it).
 */
export function catKeyExpr(
  cols: ParsedColumn[],
  gi: number,
  key: ResidentCatKey,
  params: DuckValue[],
): { group: string; label: string } {
  const p = phys(gi);

  if (key.kind === 'bin') {
    const n = sqlNum(p);
    params.push(key.lo, key.width);
    // `lo` and `width` are bound DOUBLEs, so both sides floor the SAME two
    // doubles. Subtract, divide, floor involve no reassociation, so unlike
    // sum() this is BIT-IDENTICAL to `categoryKey.binIndex` rather than merely
    // close. NULL is kept NULL explicitly: DuckDB's least() ignores NULL args.
    const e =
      `CASE WHEN ${n} IS NULL THEN NULL ELSE CAST(greatest(least(` +
      `floor((${n} - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)), ${key.bins - 1}), 0) AS INTEGER) END`;
    return { group: e, label: e };
  }

  if (key.kind === 'date') {
    // Empty is null OR '' OR whitespace, spelled out by sqlEmpty rather than
    // left to trim(): DuckDB's trim strips NBSP but not tab.
    const e = `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${dateBucketSql(sqlCanonicalDate(p), key.grain)} END`;
    return { group: e, label: e };
  }

  if (key.kind === 'other') {
    const v = `CAST(${p} AS VARCHAR)`;
    const holes: string[] = [];
    for (const k of key.keep) {
      holes.push('CAST(? AS VARCHAR)');
      params.push(k);
    }
    // `NULL IN (…)` is NULL, so coalesce before it can quietly fold the empty
    // group into Other — the same discipline as `sqlInPredicate`. Whether the
    // empty group is kept is carried by its own flag, never by the IN list.
    const inKeep = holes.length > 0 ? `coalesce(${v} IN (${holes.join(', ')}), FALSE)` : 'FALSE';
    const kept = key.keepNull ? `(${inKeep} OR ${p} IS NULL)` : inKeep;
    params.push(key.label);
    const e = `CASE WHEN ${kept} THEN ${bomSafe(p)} ELSE CAST(? AS VARCHAR) END`;
    return { group: e, label: e };
  }

  return groupKeyExpr(cols, gi);
}

/** The returned bucket id (or raw key) → the label, via categoryKey and nothing else. */
export function catLabel(raw: DuckValue, type: ColumnType, key: ResidentCatKey): string | number {
  if (key.kind === 'bin') {
    return raw == null ? '' : binLabel(Number(raw), key.lo, key.width, key.bins, key.hi);
  }
  if (key.kind === 'date') return raw == null ? '' : dateBucketLabel(Number(raw), key.grain);
  // 'other' applies to text columns only, so its decode is the raw one.
  return labelOf(raw, type);
}

/**
 * The inverse of `String(cell)`, identical to `parquetStore.toCell` /
 * `pipelineDuck.toCell`. NOT a re-parse: `''` stays `''` for a text column.
 */
function toCell(raw: DuckValue, type: ColumnType): Cell {
  if (raw == null) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `vizData.labelVal` over a round-tripped group key. */
function labelOf(raw: DuckValue, type: ColumnType): string | number {
  const cell = toCell(raw, type);
  if (typeof cell === 'number') return cell;
  return cell == null ? '' : String(cell);
}
