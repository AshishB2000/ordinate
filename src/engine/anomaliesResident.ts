'use strict';

// anomaliesResident — the anomaly detector computed DIRECTLY against a dataset's
// Parquet file. MAIN PROCESS ONLY. Never throws: the single entry point returns
// `null` when the bridge is down, the file is unusable, or anything at all goes
// wrong, and the caller keeps its working `anomalies.detectAnomalies` path.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `dashboard:explainAnomalies` was the last handler that hydrated a whole table.
// It loops every dataset a dashboard references and calls
// `detectAnomalies(ds.columns, ds.rows)`; with the row cap at 1,000,000 that is
// a multi-second full materialisation PER DATASET, for an answer that is at most
// twelve short sentences.
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `detectAnomaliesResident(src, opts)` ≡ `anomalies.detectAnomalies(src.columns,
// parquetStore.readTable(src.parquetPath, src.columns).rows, opts)` — the SAME
// bytes, read the two ways, same anomalies, same order, same `detail` strings,
// same severities, same caps. `scripts/test-anomaliesResident.ts` asserts that
// equivalence differentially rather than against hand-written numbers, because
// these strings are quoted verbatim into a model prompt: a wrong figure here is
// a number the app "computed" and the model then narrates as ground truth.
//
// ── The division of labour (docs/phase-0/04 §6 OQ-12) ────────────────────────
// SQL RETURNS RAW AGGREGATES ONLY. Every threshold, every comparison against a
// threshold, every `round()`, every tie-break, the ordering, the capping and all
// string assembly stay in TypeScript, byte-identical to `anomalies.ts`. The one
// exception is the per-value outlier predicate, which cannot come back to TS
// without materialising the column — so the FENCES, MEAN and STD it compares
// against are computed in TS and bound as PARAMETERS, and only the comparison
// itself happens in SQL.
//
// ── The two function traps, settled by measurement ───────────────────────────
// Both were run against this repo's own bridge before a line of SQL was written
// (docs/phase-0/04 §"Consolidated DuckDB verification experiments"):
//
//   1. STANDARD DEVIATION IS POPULATION (÷N). `anomalies.ts:121` divides the
//      sum of squared deviations by `values.length`. Measured on the shipped
//      fixture [10,11,12,13,14,15,16,20]: `stddev()`/`stddev_samp()` = 3.181980515339464
//      (÷N−1) against `stddev_pop()` = 2.9764702249476644 (÷N) — z(20) 1.9251 vs
//      2.0578, so at `zThreshold: 2` the sample form SILENTLY LOSES the finding.
//      Neither is used here: the variance is a TWO-PASS `sum((v-mean)*(v-mean))`
//      over the TS mean, divided by the count IN TS, which is literally the JS
//      expression rather than a same-named function.
//
//   2. QUANTILES ARE TYPE-7 LINEAR INTERPOLATION. Measured: `quantile(x,0.25)`
//      is an ALIAS FOR `quantile_disc` and returns 11 on that fixture, where
//      type-7 gives 11.75 — fences [5, 21] instead of [6.5, 20.5], a different
//      `detail` string and potentially a different outlier set. `median()` is
//      the 0.5 case of the continuous form (verified: `median` over (1,2,3,4) =
//      2.5). The function used here is `quantile_cont`, verified against
//      `anomalies.quantile` on 800 random samples (see §"What could NOT be
//      reproduced"). It is called ONCE PER COLUMN with a LIST of both
//      quantiles — `quantile_cont(v, [0.25, 0.75])` — which is one sort instead
//      of two. The list form was verified BIT-IDENTICAL to two scalar calls
//      before it was relied on: 400 random samples (n 2..41, mixed magnitudes,
//      integer and non-integer) plus 511 columns of non-integer fixture data,
//      0 disagreements. A different interpolation there would move a
//      user-visible fence, so this is measured, not assumed.
//
// ── What is reused rather than re-derived ────────────────────────────────────
// `anomalies.ts` does not reimplement `empty_heavy`/`constant_column`; it calls
// `datasetStats.findQualityIssues`, and its header calls that "no duplication" a
// correctness property. The same property is preserved here: this module calls
// `statsResident.findQualityIssuesResident` for those two kinds, and
// `statsResident.computeColumnSummariesResident` for `dominant_category` — whose
// three inputs (non-empty count, distinct count, modal value + its count) are
// EXACTLY the fields `ColumnSummary` already carries, including the
// first-occurrence tie-break `mode()` does not give you. Only the two rules with
// no equivalent upstream — `numeric_outlier` and `period_change` — generate SQL
// here.
//
// ── Cost, and where it is NOT ────────────────────────────────────────────────
// This module issues FIVE statements regardless of how wide the table is (six
// when there is a date column) — its own three outlier passes plus
// `statsResident`'s summary and quality scans. Width was still a hang:
// 57 s at 1,000 columns. The cause was one spelling, not the statement count —
// `count(*) FILTER (WHERE …)` costs far more per aggregate than the identical
// `count(CASE WHEN … THEN … END)`, and this file emitted three of them per
// number column (see `hitsSql`). Measured on this repo's bridge, one dataset,
// medians, before/after interleaved so both see the same machine, and asserted
// byte-identical at every point:
//
//   number columns    rows      JS     THIS MODULE'S SQL      whole call
//                                        before    after    before    after
//     2           1,000,000  1,621 ms    127 ms   119 ms     309 ms   299 ms
//     7              20,000     64 ms     26 ms    25 ms      85 ms    84 ms
//    34              10,000    156 ms     84 ms    75 ms     442 ms   431 ms
//    67              10,000    328 ms    217 ms   150 ms   1,435 ms 1,253 ms
//   134               5,000    324 ms    732 ms   248 ms   6,907 ms 7,523 ms
//   334               2,000    351 ms  11,567 ms  586 ms  51,932 ms 44,229 ms
//
// The tall/narrow case this path exists for did not regress (a single
// `quantile_cont` over a LIST of both quantiles is one sort where there were
// two, which is why it moved slightly the other way).
//
// THE WHOLE-CALL COLUMN BARELY MOVES ON WIDE TABLES, AND THAT IS NOT THIS FILE:
// at 334 number columns 41,166 ms of the remaining 44,229 ms is
// `statsResident`'s quality scan, which spells its per-column non-empty and
// distinct counts with the same `FILTER` — measured 51,407 ms → 4,838 ms under
// the same rewrite, with zero figures differing. Until that is fixed the
// caller's width gate (`ipc/dashboards.ts`) still has to exist; nothing in the
// numbers above justifies removing it.
//
// ── What could NOT be reproduced ─────────────────────────────────────────────
// FLOAT SUMMATION ORDER, in three places: the outlier mean, the outlier
// variance, and the period sums. JS folds `+=` left-to-right in row order;
// DuckDB combines vectorised partial sums. Measured on this repo's bridge over
// 200,000 non-integer doubles: 1428577142.8579032 (JS) against
// 1428577142.8573005 (DuckDB), 4.2e-13 relative. At 50,000 and below the two
// were bit-identical, and INTEGER data is exact at every size measured.
//
// QUANTILE INTERPOLATION IN THE LAST ULP. `anomalies.quantile` evaluates
// `s[lo] + frac*(s[hi]-s[lo])`; `quantile_cont` evaluates an algebraically equal
// but differently-associated expression. Fuzzed over 800 random samples (n from
// 2 to 41, mixed magnitudes): 53 disagreed, worst case 1.6e-15 RELATIVE — i.e.
// a handful of ULPs, never a different data point. When `frac === 0` (an
// integral position) both are exact, and for INTEGER data the interpolation is a
// binary-exact quarter, so both forms agree bit-for-bit; the divergence exists
// only for non-integer data.
//
// Neither drift can reach a rendered figure: `minOutlier`/`maxOutlier` are RAW
// DATA VALUES (exact on both paths), `count` is an integer, and the fences are
// the only derived figures — and they are `round()`ed to 1e-6 before they enter
// either the `detail` string or `facts`, roughly nine orders of magnitude above
// the drift. The one theoretical way it becomes visible is a data value sitting
// within ~1e-13 relative of a fence, where membership could flip; that requires
// non-integer data AND a fence landing on a value, and is pinned by a
// large-fixture differential test rather than argued away.
//
// A NON-CANONICAL numeric string in a number column ('0x10', '1.0') reads as
// 16/1 through JS `Number()` and NULL/1 through `TRY_CAST`. Our own writer only
// ever stores `String(n)`, so this is unreachable for a file this app wrote; it
// is inherited verbatim from `residentQuery`/`sqlGen`/`statsResident` and listed
// here rather than papered over.

import type { ParsedColumn } from '../data/parse';
import type { Anomaly, AnomalyKind, AnomalyOptions } from '../analysis/anomalies';
import type { ColumnSummary, QualityIssue } from '../data/datasetStats';
import { sqlEmpty } from './sqlGen';
import { relationSql } from './parquetStore';
import * as statsResident from './statsResident';
import * as duck from './duckdb';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface AnomalySource {
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)`,
   * `statsResident.StatsSource` and `datasets.residentSource` take.
   */
  columns: ParsedColumn[];
}

// ── Constants mirrored from anomalies.ts ─────────────────────────────────────
//
// Module-private there, so they are restated (the `statsResident`
// EMPTY_HEAVY_RATIO precedent). They are NOT re-derived or "improved":
// `MIN_OUTLIER_SAMPLE` is deliberately not an option there and is not one here.

type Opts = Required<Omit<AnomalyOptions, 'dateCol' | 'measureCol'>>;

const DEFAULTS: Opts = {
  iqrMult: 1.5,
  zThreshold: 3,
  dominantShare: 0.6,
  periodChangePct: 0.5,
  maxPerKind: 3,
  maxTotal: 12,
};

const MIN_OUTLIER_SAMPLE = 8;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * True when anomalies can be detected straight off Parquet. Starts the DuckDB
 * worker on first call (this is the "is the fast path up?" probe, so it has to
 * actually try). Never throws — a false answer means: use the JS path.
 */
export function isAnomaliesResident(): boolean {
  try {
    return duck.isAvailable();
  } catch {
    return false;
  }
}

/**
 * The app-detected anomalies for one stored dataset — the exact array
 * `anomalies.detectAnomalies` produces over the same file's rows.
 *
 * Returns `null` — never throws — when the bridge is unavailable, the file is
 * missing/corrupt/narrower than the record, the column list is empty or
 * malformed, a query fails, or a rule cannot be answered faithfully (see
 * `dateCol` below). `null` ALWAYS means "fall back", never "no anomalies": a
 * clean dataset is a perfectly good answer and is returned as `[]`.
 *
 * The one deliberate gap: a `dateCol` pinned to a column whose declared type is
 * `number` makes the period key `String(<the JS number>)`, which DuckDB's
 * VARCHAR cast does not reproduce (`1` vs `1.0`). Rather than approximate the
 * key, the whole call falls back. Unreachable from the shipped caller, which
 * passes no options at all.
 */
export function detectAnomaliesResident(src: AnomalySource, opts?: AnomalyOptions): Anomaly[] | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    const o: Opts = { ...DEFAULTS, ...(opts || {}) };

    // `dateCol ? by-name : first column of type 'date'` — the truthiness test is
    // the JS one, so an empty-string hint falls through to the type search.
    const dateCol = opts?.dateCol;
    const dateIdx = dateCol
      ? cols.findIndex((c) => c && c.name === dateCol)
      : cols.findIndex((c) => c && c.type === 'date');
    if (dateIdx >= 0 && cols[dateIdx].type === 'number') return null; // see the doc comment

    // ── Stage 1: the numeric-outlier aggregates + the row count ──────────────
    const numIdx: number[] = [];
    cols.forEach((c, i) => {
      if (c.type === 'number') numIdx.push(i);
    });

    const base = runOnce(() => baseSql(src.parquetPath, numIdx));
    if (!base) return null;
    const rowCount = intOrNull(base.n);
    if (rowCount === null) return null;
    // `detectAnomalies` short-circuits on an empty table BEFORE any rule runs.
    if (rowCount === 0) return [];

    const outliers = outlierAnomalies(src, cols, numIdx, base, o);
    if (outliers === null) return null;

    // ── Stage 2: dominant_category, off the shared column summaries ──────────
    const textIdx = cols.map((_, i) => i).filter((i) => cols[i].type !== 'number');
    let summaries: ColumnSummary[] | null = null;
    if (textIdx.length > 0) {
      summaries = statsResident.computeColumnSummariesResident(src);
      if (!summaries || summaries.length !== cols.length) return null;
    }

    // ── Stage 3: empty_heavy / constant_column, off the shared quality scan ──
    const issues: QualityIssue[] | null = statsResident.findQualityIssuesResident(src);
    if (!issues) return null;

    // ── Stage 4: the single biggest period-over-period step ─────────────────
    const period = periodChangeAnomaly(src, cols, dateIdx, o, opts?.measureCol);
    if (period === undefined) return null; // query failure, not "no finding"

    // ── Assembly, in `detectAnomalies`'s discovery order ─────────────────────
    const found: Anomaly[] = [];
    cols.forEach((col, ci) => {
      if (col.type === 'number') {
        const a = outliers.get(ci);
        if (a) found.push(a);
      } else {
        const a = dominantAnomaly(col.name, summaries ? summaries[ci] : undefined, o);
        if (a) found.push(a);
      }
    });

    for (const issue of issues) {
      if (issue.kind === 'empty_heavy') {
        found.push({ kind: 'empty_heavy', column: issue.column, severity: 'warn', detail: issue.detail, facts: {} });
      } else if (issue.kind === 'constant_column') {
        found.push({ kind: 'constant_column', column: issue.column, severity: 'info', detail: issue.detail, facts: {} });
      }
      // duplicate_rows intentionally dropped (not an "unusual change").
    }

    if (period) found.push(period);

    return capAndOrder(found, o);
  } catch {
    return null;
  }
}

// ── Assembly (verbatim from anomalies.detectAnomalies) ───────────────────────

/**
 * Cap per kind (preserving discovery order within a kind), then a STABLE sort
 * putting `warn` before `info`, then cap the total. `Array.prototype.sort` has
 * been stable by specification since ES2019, which is what preserves discovery
 * order within a severity — and therefore the FACTS bullet order, and therefore
 * the model prompt's bytes.
 */
function capAndOrder(found: Anomaly[], o: Opts): Anomaly[] {
  const perKind = new Map<AnomalyKind, number>();
  const capped: Anomaly[] = [];
  for (const a of found) {
    const n = perKind.get(a.kind) ?? 0;
    if (n >= o.maxPerKind) continue;
    perKind.set(a.kind, n + 1);
    capped.push(a);
  }
  capped.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
  return capped.slice(0, o.maxTotal);
}

// ── Rule 1: numeric_outlier ──────────────────────────────────────────────────
//
// THREE PASSES, because the JS is three passes and each depends on the last:
//
//   base  count, sum, quantile_cont([0.25, 0.75])              — no dependency
//   dev   sum((v - mean) * (v - mean))                          — needs mean
//   hits  count/min/max of the values matching the predicate    — needs the
//                                                                 fences + std
//
// Every division, square root, threshold comparison and rounding between those
// passes happens in TS, on the doubles SQL returned, so the only thing SQL
// decides is a sum, an order statistic and a per-row boolean. The mean, the
// fences, the std and the z threshold are BOUND PARAMETERS in the third pass —
// the predicate therefore compares against the exact same doubles the JS
// predicate would.

interface OutlierStats {
  count: number;
  mean: number;
  lowerFence: number;
  upperFence: number;
  std: number;
}

/**
 * One `Anomaly` per number column that has one, keyed by column index. Returns
 * `null` on any query failure — a partial answer would be a silently different
 * anomaly SET, which is worse than a fallback.
 */
function outlierAnomalies(
  src: AnomalySource,
  cols: ParsedColumn[],
  numIdx: number[],
  base: duck.DuckRow,
  o: Opts,
): Map<number, Anomaly> | null {
  const out = new Map<number, Anomaly>();
  if (numIdx.length === 0) return out;

  // Pass 1 decoded: which columns clear MIN_OUTLIER_SAMPLE, and their fences.
  const stats = new Map<number, OutlierStats>();
  for (const i of numIdx) {
    const count = intOrNull(base[`k${i}`]);
    if (count === null) return null;
    if (count < MIN_OUTLIER_SAMPLE) continue; // `values.length < 8` → no finding
    const sum = numOrNull(base[`s${i}`]);
    const q1 = numOrNull(base[`q1_${i}`]);
    const q3 = numOrNull(base[`q3_${i}`]);
    if (sum === null || q1 === null || q3 === null) return null;

    // Literally the JS expressions, in the JS order of operations.
    const iqr = q3 - q1;
    const lowerFence = q1 - o.iqrMult * iqr;
    const upperFence = q3 + o.iqrMult * iqr;
    // A non-finite fence would have to be bound as a parameter to be compared
    // against, and NaN/±Infinity do not survive that round trip predictably.
    // Unreachable for real data (the fences are interpolations of finite stored
    // cells); a fallback beats guessing.
    if (!Number.isFinite(lowerFence) || !Number.isFinite(upperFence)) return null;

    stats.set(i, { count, mean: sum / count, lowerFence, upperFence, std: 0 });
  }
  if (stats.size === 0) return out;

  // Pass 2: the two-pass population variance, over the TS mean.
  const devIdx = [...stats.keys()];
  const devParams: duck.DuckValue[] = [];
  const dev = runOnce(() => devSql(src.parquetPath, devIdx, stats, devParams), devParams);
  if (!dev) return null;
  for (const i of devIdx) {
    const s = stats.get(i) as OutlierStats;
    const sq = numOrNull(dev[`d${i}`]);
    if (sq === null) return null;
    s.std = Math.sqrt(sq / s.count); // variance ÷ N — POPULATION, as anomalies.ts:121
  }

  // Pass 3: the union of the fence test and the z test, per value.
  const hitParams: duck.DuckValue[] = [];
  const hits = runOnce(() => hitsSql(src.parquetPath, devIdx, stats, o, hitParams), hitParams);
  if (!hits) return null;

  for (const i of devIdx) {
    const s = stats.get(i) as OutlierStats;
    const n = intOrNull(hits[`c${i}`]);
    if (n === null) return null;
    if (n === 0) continue; // `outliers.length === 0` → no finding

    // Raw data values, reported verbatim exactly as the JS reduce() does.
    const minOutlier = numOrNull(hits[`lo${i}`]);
    const maxOutlier = numOrNull(hits[`hi${i}`]);
    if (minOutlier === null || maxOutlier === null) return null;

    const name = cols[i].name;
    const lf = round(s.lowerFence);
    const uf = round(s.upperFence);
    const plural = n === 1 ? 'value' : 'values';
    out.set(i, {
      kind: 'numeric_outlier',
      column: name,
      severity: 'warn',
      detail:
        `Column "${name}" has ${n} outlier ${plural} outside the expected range ` +
        `[${lf}, ${uf}]` +
        (minOutlier === maxOutlier ? ` (${minOutlier}).` : ` (from ${minOutlier} to ${maxOutlier}).`),
      facts: {
        count: n,
        lowerFence: lf,
        upperFence: uf,
        minOutlier,
        maxOutlier,
      },
    });
  }
  return out;
}

// ── Rule 2: dominant_category (derived from the shared ColumnSummary) ────────

/**
 * `anomalies.dominantAnomaly`, expressed over the summary `statsResident`
 * already computes. The mapping is exact, field for field:
 *
 *   `nonEmpty`              ← the non-empty cell count (same emptiness predicate)
 *   `counts.size >= 2`      ← `distinct >= 2` (distinct over NON-EMPTY values)
 *   `topValue` / `topCount` ← `mostCommon`, whose SQL tie-break is
 *                             `first(v ORDER BY cnt DESC, min(ordinal) ASC)` —
 *                             the JS `Map` insertion order + strict `>` rule.
 *
 * Every figure below is a ratio of two integer counts, so there is no float
 * divergence in this rule at all.
 */
function dominantAnomaly(name: string, summary: ColumnSummary | undefined, o: Opts): Anomaly | null {
  if (!summary) return null;
  const nonEmpty = summary.nonEmpty;
  const distinct = summary.distinct;
  if (typeof nonEmpty !== 'number' || typeof distinct !== 'number') return null;
  // A single-value column is a constant_column, handled by the quality scan.
  if (nonEmpty === 0 || distinct < 2) return null;
  const top = summary.mostCommon;
  if (!top) return null;

  const share = top.count / nonEmpty;
  if (share < o.dominantShare) return null;
  const pct = Math.round(share * 100);
  return {
    kind: 'dominant_category',
    column: name,
    severity: 'info',
    detail: `Column "${name}" is dominated by "${top.value}" — ${top.count} of ${nonEmpty} non-empty cells (${pct}%).`,
    facts: { value: top.value, count: top.count, share: round(share) },
  };
}

// ── Rule 4: period_change ────────────────────────────────────────────────────

/**
 * One `GROUP BY` gives `(dateKey, sum per measure)` in FIRST-SEEN row order; the
 * ordering decision, the diffing, the thresholds and the strings stay in TS.
 *
 * The ordering CANNOT move into SQL and is not attempted: `anomalies.ts` sorts
 * by `Date.parse` when EVERY key parses finitely and falls back to a default
 * lexical `Array.sort()` otherwise, switching strategy at runtime. `'2023'`
 * parses to a finite time in JS and is not castable to DuckDB's DATE at all, so
 * a plain `ORDER BY` reproduces neither branch.
 *
 * Returns `undefined` for "the query failed" (which must become a fallback) and
 * `null` for "no finding", which is a real answer.
 */
function periodChangeAnomaly(
  src: AnomalySource,
  cols: ParsedColumn[],
  dateIdx: number,
  o: Opts,
  measureCol?: string,
): Anomaly | null | undefined {
  if (dateIdx < 0) return null;
  const numericCols = cols
    .map((c, i) => ({ name: c.name, type: c.type, i }))
    .filter((c) => c.type === 'number' && (!measureCol || c.name === measureCol));
  if (numericCols.length === 0) return null;

  const rows = runQuery((mode) => periodSql(src.parquetPath, dateIdx, numericCols.map((c) => c.i), mode));
  if (rows === null) return undefined;
  if (rows.length < 2) return null; // `dateKeys.length < 2`

  // First-seen order, straight out of `ORDER BY min(<ordinal>)`.
  const dateKeys: string[] = [];
  const sums = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const raw = r.g;
    if (raw == null) return undefined; // the WHERE clause excludes empties; a null here is a bug
    const dk = typeof raw === 'string' ? raw : String(raw);
    const bucket = new Map<number, number>();
    for (const nc of numericCols) {
      // NO COALESCE anywhere in periodSql: a measure with no finite value in a
      // bucket is NULL, which is the JS `undefined` that SKIPS the step rather
      // than treating it as 0.
      const v = sumOrUndefined(r[`m${nc.i}`]);
      if (v !== undefined) bucket.set(nc.i, v);
    }
    dateKeys.push(dk);
    sums.set(dk, bucket);
  }
  // Distinct group keys, so a collision here would mean the GROUP BY lied.
  if (sums.size !== dateKeys.length) return undefined;

  const parsed = dateKeys.map((k) => Date.parse(k));
  const allParse = parsed.every((n) => Number.isFinite(n));
  const ordered = dateKeys.slice();
  if (allParse) ordered.sort((a, b) => (Date.parse(a) as number) - (Date.parse(b) as number));
  else ordered.sort();

  let best: Anomaly | null = null;
  let bestAbs = 0;
  for (const nc of numericCols) {
    for (let i = 1; i < ordered.length; i += 1) {
      const from = sums.get(ordered[i - 1])?.get(nc.i);
      const to = sums.get(ordered[i])?.get(nc.i);
      if (typeof from !== 'number' || typeof to !== 'number' || from === 0) continue;
      const pct = (to - from) / from;
      const abs = Math.abs(pct);
      if (abs < o.periodChangePct || abs <= bestAbs) continue; // strict → first-found wins ties
      bestAbs = abs;
      const pctDisplay = round(pct * 100);
      const dir = pct >= 0 ? 'rose' : 'fell';
      best = {
        kind: 'period_change',
        column: nc.name,
        severity: 'warn',
        detail:
          `"${nc.name}" ${dir} ${Math.abs(pctDisplay)}% from ${ordered[i - 1]} (${round(from)}) ` +
          `to ${ordered[i]} (${round(to)}).`,
        facts: {
          dateColumn: cols[dateIdx].name,
          fromPeriod: ordered[i - 1],
          toPeriod: ordered[i],
          fromValue: round(from),
          toValue: round(to),
          pctChange: round(pct),
        },
      };
    }
  }
  return best;
}

// ── SQL builders ─────────────────────────────────────────────────────────────
//
// Physical names are positional `c0..cN`, the same contract `sqlGen.ts`,
// `parquetStore.ts`, `residentQuery.ts` and `statsResident.ts` use. USER-FACING
// COLUMN NAMES NEVER REACH SQL, so identifier quoting, duplicate names and name
// injection are all structurally out of reach. The only user-influenced text is
// the file path, and `parquetStore.relationSql` validates and escapes that.
//
// The numeric columns are projected ONCE into a `v` CTE as `v<i>`, so the long
// `isfinite(TRY_CAST(…))` guard is written once per column instead of once per
// use — the outlier predicate alone references it five times.

/** `WITH v AS (SELECT <finite numeric reading> AS v<i>, … FROM read_parquet(…))` */
function numericCte(parquetPath: string, idx: number[]): string {
  const projection = idx.map((i) => `${sqlNum(phys(i))} AS v${i}`).join(', ');
  return `v AS (SELECT ${projection} FROM ${relationSql(parquetPath)})`;
}

/**
 * Pass 1 — the row count plus, per number column, the aggregates that depend on
 * nothing else.
 *
 * `count(v)` is the FINITE count: `sqlNum` degrades `NaN`/`±Infinity` to NULL
 * before any aggregate sees them, which matters twice over here — an unfiltered
 * `count` would let a NaN column clear MIN_OUTLIER_SAMPLE, and DuckDB sorts NaN
 * ABOVE every value, so an unfiltered `quantile_cont` would be skewed by it.
 *
 * `quantile_cont`, NOT `quantile`/`quantile_disc`/`median` — see the header.
 * NO COALESCE: a column with no finite cells must stay NULL, and it is filtered
 * out in TS by the count anyway.
 *
 * BOTH FENCES COME OUT OF ONE SORT. `quantile_cont` takes a LIST of quantiles
 * and returns a list of results, so `[0.25, 0.75]` is one ordering of the
 * column's values rather than two independent ones. The list is subscripted in
 * an outer projection (`q[1]`, `q[2]`, 1-based) rather than returned as a list:
 * a LIST crosses `src/duckdb.ts` as JSON TEXT, and re-parsing a double out of
 * DuckDB's own float formatting is a round trip this file has no business
 * trusting when the value is a user-visible fence. Subscripting keeps both
 * halves DOUBLE the whole way. Verified bit-identical to two scalar calls
 * (header, trap 2).
 */
function baseSql(parquetPath: string, numIdx: number[]): string {
  if (numIdx.length === 0) {
    return `SELECT CAST(count(*) AS DOUBLE) AS n FROM ${relationSql(parquetPath)};`;
  }
  const agg = [`count(*) AS n`];
  const sel = [`CAST(n AS DOUBLE) AS n`];
  for (const i of numIdx) {
    agg.push(`count(v${i}) AS k${i}`);
    agg.push(`sum(v${i}) AS s${i}`);
    agg.push(`quantile_cont(v${i}, [0.25, 0.75]) AS q${i}`);
    sel.push(`CAST(k${i} AS DOUBLE) AS k${i}`);
    sel.push(`CAST(s${i} AS DOUBLE) AS s${i}`);
    sel.push(`CAST(q${i}[1] AS DOUBLE) AS q1_${i}`);
    sel.push(`CAST(q${i}[2] AS DOUBLE) AS q3_${i}`);
  }
  return (
    `WITH ${numericCte(parquetPath, numIdx)}, ` +
    `a AS (SELECT ${agg.join(', ')} FROM v) ` +
    `SELECT ${sel.join(', ')} FROM a;`
  );
}

/**
 * Pass 2 — `Σ(v - mean)²`, with `mean` bound as a parameter so the subtraction
 * is against the exact double TS computed as `sum / count`. The division by N
 * (population, not sample) happens in TS, not here: no `var_pop`, no `stddev`,
 * no same-named function that might carry a different denominator or a Welford
 * update rule.
 */
function devSql(
  parquetPath: string,
  idx: number[],
  stats: Map<number, OutlierStats>,
  params: duck.DuckValue[],
): string {
  params.length = 0; // the ordinal retry can rebuild a statement; binding must not double up
  const sel: string[] = [];
  for (const i of idx) {
    const m = (stats.get(i) as OutlierStats).mean;
    // Two placeholders, in textual order — `(v - ?) * (v - ?)` is the JS
    // `(b - mean) * (b - mean)`, not `power(v - ?, 2)`.
    params.push(m, m);
    sel.push(`CAST(sum((v${i} - CAST(? AS DOUBLE)) * (v${i} - CAST(? AS DOUBLE))) AS DOUBLE) AS d${i}`);
  }
  return `WITH ${numericCte(parquetPath, idx)} SELECT ${sel.join(', ')} FROM v;`;
}

/**
 * Pass 3 — count/min/max of the values the JS loop would have pushed into
 * `outliers`.
 *
 * The JS collects them in row order and then reduces to a min and a max, so the
 * ORDER IS NOT OBSERVABLE in the output and no ordinal is needed here (unlike
 * `residentQuery`/`statsResident`, which both need one). What IS observable is
 * membership, and that is a per-row boolean:
 *
 *     v < lowerFence  OR  v > upperFence  OR  (std > 0 AND |(v-mean)/std| > z)
 *
 * a UNION, not an intersection, with STRICT comparisons on both tests. The
 * `std > 0` guard is evaluated IN TS: when it fails, the z clause is not emitted
 * at all. That also covers the pathological `std === Infinity` case (an
 * overflowed sum of squares), where the JS `|(v-mean)/std|` is `NaN` and
 * therefore never `> z` — omitting the clause is exact, whereas binding a
 * non-finite parameter is not.
 *
 * A NULL `v` fails every comparison (NULL is not TRUE), so non-finite cells drop
 * out for free; the explicit `IS NOT NULL` is kept for the reader.
 *
 * The predicate occurs ONCE, in an `h` CTE, rather than being repeated inside
 * three aggregates. That is not cosmetic: a repeated predicate repeats its `?`
 * placeholders, and a positional binding cannot be reused — the three copies
 * would need the parameters pushed three times, which is exactly the kind of
 * bookkeeping that goes wrong silently. One occurrence, one binding.
 *
 * WHAT THE `h` CTE PROJECTS IS THE VALUE, NULLED WHEN THE PREDICATE MISSES —
 * `CASE WHEN <pred> THEN v END` — and the three aggregates are then the plain
 * `count`/`min`/`max` of it, which ignore NULL. The obvious spelling is a
 * boolean column plus `count(*) FILTER (WHERE h)`, `min(v) FILTER (WHERE h)`,
 * `max(v) FILTER (WHERE h)`, and it is IDENTICAL in meaning — but `FILTER`
 * carries a per-aggregate cost that explodes with the column count, and this
 * statement emits three aggregates per number column. Measured on this repo's
 * bridge, same file, same fences, same results (medians, interleaved so the two
 * shapes see the same machine):
 *
 *     number columns      FILTER      CASE-nulled
 *       2 (1M rows)        26 ms          32 ms
 *       7                  21 ms          20 ms
 *     134                 757 ms         198 ms
 *     334              13,230 ms         798 ms
 *
 * At 334 columns that is 1,002 filtered aggregates against 1,002 plain ones —
 * a 16.6x difference for a rewrite that changes no number. This was the single
 * biggest cost inside this module on wide tables.
 */
function hitsSql(
  parquetPath: string,
  idx: number[],
  stats: Map<number, OutlierStats>,
  o: Opts,
  params: duck.DuckValue[],
): string {
  params.length = 0; // see devSql
  const preds: string[] = [];
  const sel: string[] = [];
  for (const i of idx) {
    const s = stats.get(i) as OutlierStats;
    const v = `v${i}`;
    const clauses = [`${v} < CAST(? AS DOUBLE)`, `${v} > CAST(? AS DOUBLE)`];
    params.push(s.lowerFence, s.upperFence);
    if (Number.isFinite(s.std) && s.std > 0 && Number.isFinite(s.mean)) {
      clauses.push(`abs((${v} - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) > CAST(? AS DOUBLE)`);
      params.push(s.mean, s.std, o.zThreshold);
    }
    preds.push(`CASE WHEN ${v} IS NOT NULL AND (${clauses.join(' OR ')}) THEN ${v} END AS h${i}`);
    // count/min/max IGNORE NULL, so these are exactly the outliers' count and
    // extremes — the raw data values, never a fence or a mean.
    sel.push(`CAST(count(h${i}) AS DOUBLE) AS c${i}`);
    sel.push(`CAST(min(h${i}) AS DOUBLE) AS lo${i}`);
    sel.push(`CAST(max(h${i}) AS DOUBLE) AS hi${i}`);
  }
  return (
    `WITH ${numericCte(parquetPath, idx)}, ` +
    `h AS (SELECT ${preds.join(', ')} FROM v) ` +
    `SELECT ${sel.join(', ')} FROM h;`
  );
}

/**
 * The period buckets: one row per distinct NON-EMPTY date key, one summed
 * measure per numeric column, ordered by the key's FIRST occurrence.
 *
 * `sqlEmpty` — not `trim(d) <> ''` — is the emptiness predicate, so the JS
 * `trim()` Unicode whitespace class (NBSP, U+FEFF, U+2028…) is honoured; DuckDB's
 * `trim()` strips spaces only and RE2's `\s` misses NBSP. One definition of
 * "empty" in the codebase, shared with `sqlGen`/`residentQuery`/`statsResident`.
 *
 * `bomSafe` is applied to the LABEL only. The GROUP BY key is the raw stored
 * value, and doubling a leading U+FEFF is injective, so the repair cannot merge
 * or split groups.
 */
function periodSql(parquetPath: string, dateIdx: number, numIdx: number[], mode: OrdinalMode): string {
  const { from, ord } = orderedFrom(parquetPath, mode);
  const d = phys(dateIdx);
  const proj = [`${ord} AS ord`, `${d} AS dk`];
  for (const i of numIdx) proj.push(`${sqlNum(phys(i))} AS v${i}`);

  const sel = [`${bomSafe('dk')} AS g`];
  for (const i of numIdx) sel.push(`CAST(sum(v${i}) AS DOUBLE) AS m${i}`);

  return (
    `WITH e AS (SELECT ${proj.join(', ')} FROM ${from}) ` +
    `SELECT ${sel.join(', ')} FROM e WHERE NOT ${sqlEmpty('dk')} ` +
    `GROUP BY dk ORDER BY min(ord);`
  );
}

// ── Physical column expressions (shared dialect with sqlGen/statsResident) ───

function phys(i: number): string {
  return `c${i}`;
}

/** A finite JS number, or NULL. Mirrors `sqlGen`'s private `sqlNum`. */
function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

// `src/duckdb.ts` loses exactly ONE leading U+FEFF from every returned string
// (documented there; the loss is below the JS layer). Doubling a leading BOM at
// projection time is an exact inverse, and a value that does not start with one
// is untouched — the same repair `parquetStore.readTable` applies. Period keys
// are user data and reach a `detail` string, so they get it.
const BOM = 'chr(65279)';
function bomSafe(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

// ── Ordinal mode ─────────────────────────────────────────────────────────────
//
// `file_row_number=true` surfaces the row's index WITHIN THE FILE — a physical
// property of the stored data, so unlike `row_number() OVER ()` it does not
// depend on the order rows happen to reach an operator under a parallel scan.
// `min(file_row_number)` is therefore first-seen order by construction, which is
// what the period bucket order needs. If a DuckDB build rejects the option we
// downgrade ONCE, permanently, exactly as `residentQuery.ts`/`statsResident.ts`
// do; the happy path costs no probe query.

type OrdinalMode = 'file_row_number' | 'row_number';
let ordinalMode: OrdinalMode = 'file_row_number';

function orderedFrom(parquetPath: string, mode: OrdinalMode): { from: string; ord: string } {
  const base = relationSql(parquetPath); // read_parquet('…') — validated + escaped
  if (mode === 'file_row_number') {
    return { from: `${base.slice(0, -1)}, file_row_number=true)`, ord: 'file_row_number' };
  }
  // A window function cannot be nested inside min(), so it is materialised by a
  // subquery first.
  return { from: `(SELECT row_number() OVER () AS __ord, * FROM ${base})`, ord: '__ord' };
}

// ── Execution ────────────────────────────────────────────────────────────────

/** Run a built statement, downgrading the ordinal once if the build rejects it. */
function runQuery(build: (mode: OrdinalMode) => string, params?: duck.DuckValue[]): duck.DuckRow[] | null {
  if (!duck.isAvailable()) return null;
  try {
    return duck.query(build(ordinalMode), params);
  } catch (err) {
    if (ordinalMode === 'file_row_number' && /file_row_number/i.test(String((err as Error)?.message ?? ''))) {
      ordinalMode = 'row_number';
      return duck.query(build('row_number'), params);
    }
    throw err;
  }
}

/** The single-row variant: a global aggregate always returns exactly one row. */
function runOnce(build: (mode: OrdinalMode) => string, params?: duck.DuckValue[]): duck.DuckRow | null {
  const rows = runQuery(build, params);
  if (!rows || rows.length !== 1) return null;
  return rows[0];
}

// ── Result decoding ──────────────────────────────────────────────────────────

/** A finite number, or null. `'Infinity'` (an overflowed sum) survives as ±Infinity. */
function numOrNull(raw: duck.DuckValue): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** A count: a finite, non-negative integer, or null (which means "fall back"). */
function intOrNull(raw: duck.DuckValue): number | null {
  const n = numOrNull(raw);
  if (n === null || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * A period bucket's measure: `undefined` when the group held no finite value —
 * the JS `Map.get` miss that SKIPS the step rather than reading it as 0.
 * ±Infinity survives (a JS left-fold can overflow the same way).
 */
function sumOrUndefined(raw: duck.DuckValue): number | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

// ── Small mirrors of anomalies.ts ────────────────────────────────────────────

/**
 * `anomalies.round` — trim float noise for DERIVED figures only. Kept in TS
 * because JS `Math.round` is half-UP (`Math.round(-2.5) === -2`) while DuckDB's
 * `round()` is half-away-from-zero (`-3`), and `pctChange` can be negative.
 */
function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * The source is usable only when every column is a real `ParsedColumn`. A
 * 0-column dataset falls back: the file holds only a sentinel column, and there
 * is nothing for any rule to look at (the JS detector returns `[]` there, which
 * the fallback reproduces).
 */
function schemaOf(src: AnomalySource): ParsedColumn[] | null {
  if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
  if (src.columns.length === 0) return null;
  for (const col of src.columns) {
    if (!col || typeof col !== 'object' || typeof col.name !== 'string') return null;
  }
  return src.columns;
}
