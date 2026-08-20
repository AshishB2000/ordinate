// Anomaly detection over an already-loaded dataset — MAIN PROCESS, PURE logic.
// No Electron, no DOM, no fs: every function here operates on the columns/rows
// handed in by the IPC layer, so it is node-testable by a plain `node` self-check
// (scripts/test-anomalies.ts). Mirrors src/datasetStats.ts header + style.
//
// THE APP DETECTS; THE MODEL ONLY EXPLAINS. Every figure in every finding is
// computed here (strict finite-number discipline, same as metricValue /
// datasetStats). The optional AI narrator (analyze.explainAnomalies) is fed these
// findings as FACTS and must never recompute one — the analyze→compute→display
// contract, applied to anomaly detection itself.
//
// The empty-heavy / constant-column rules are NOT reimplemented here: they reuse
// datasetStats.findQualityIssues verbatim (no duplication). duplicate_rows from
// that helper is intentionally dropped — a duplicate row is not an "unusual change".

import type { ColumnType } from '../data/parse';
import { findQualityIssues } from '../data/datasetStats';

// A stored cell is the coerced value from Dataset.rows[*][colIndex]: a JS number
// for numeric columns, the original string for text/date, or null for empties.
type Cell = string | number | null;

export type AnomalyKind =
  | 'numeric_outlier'
  | 'dominant_category'
  | 'empty_heavy'
  | 'constant_column'
  | 'period_change';

export interface Anomaly {
  kind: AnomalyKind;
  column?: string; // set for column-scoped anomalies
  severity: 'info' | 'warn';
  detail: string; // human-readable, safe to show as-is; app-computed figures embedded
  facts: Record<string, string | number>; // structured app-computed figures for the FACTS block
}

export interface AnomalyOptions {
  iqrMult?: number; // 1.5
  zThreshold?: number; // 3
  dominantShare?: number; // 0.6
  periodChangePct?: number; // 0.5 (50%)
  maxPerKind?: number; // 3
  maxTotal?: number; // 12
  // Optional hints for the period-over-period rule. When omitted the detector
  // auto-picks the first `date` column and scans every numeric column. Folding
  // these into the options object keeps ONE tidy signature (the IPC layer calls
  // detectAnomalies(columns, rows) with no opts).
  dateCol?: string; // pin the period column (else: first column of type 'date')
  measureCol?: string; // pin the measure (else: every numeric column is a candidate)
}

const DEFAULTS: Required<Omit<AnomalyOptions, 'dateCol' | 'measureCol'>> = {
  iqrMult: 1.5,
  zThreshold: 3,
  dominantShare: 0.6,
  periodChangePct: 0.5,
  maxPerKind: 3,
  maxTotal: 12,
};

// Minimum finite values a numeric column needs before outlier stats are meaningful.
const MIN_OUTLIER_SAMPLE = 8;

// ── small pure helpers (mirror datasetStats / metricValue) ───────────────────

function isEmpty(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

function keyOf(cell: Cell): string {
  return typeof cell === 'number' ? String(cell) : (cell as string);
}

// Trim float noise for embedded/derived figures. Raw data cells (outlier values,
// period sums) are reported verbatim; only DERIVED quantities (fences, ratios) are
// rounded so a finding reads "…outside [1, 99]" not "…outside [1.0000000002, …]".
function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

// Linear-interpolated quantile (numpy "linear" / type-7). sorted must be ascending.
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

function finiteNumbersOf(rows: Cell[][], ci: number): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r ? r[ci] : null;
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

// ── per-rule detectors (each returns 0+ anomalies; never throws) ─────────────

// 1. numeric_outlier — union of the IQR-fence and z-score tests over a column's
// finite values. Only runs on columns typed `number` (a leading-zero id column is
// typed `text`, so it is never treated as numeric here) with ≥ MIN_OUTLIER_SAMPLE
// finite cells.
function outlierAnomaly(name: string, values: number[], opts: Required<Omit<AnomalyOptions, 'dateCol' | 'measureCol'>>): Anomaly | null {
  if (values.length < MIN_OUTLIER_SAMPLE) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - opts.iqrMult * iqr;
  const upperFence = q3 + opts.iqrMult * iqr;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const std = Math.sqrt(variance);

  const outliers: number[] = [];
  for (const v of values) {
    const outByFence = v < lowerFence || v > upperFence;
    const outByZ = std > 0 && Math.abs((v - mean) / std) > opts.zThreshold;
    if (outByFence || outByZ) outliers.push(v);
  }
  if (outliers.length === 0) return null;

  const minOutlier = outliers.reduce((a, b) => (b < a ? b : a));
  const maxOutlier = outliers.reduce((a, b) => (b > a ? b : a));
  const lf = round(lowerFence);
  const uf = round(upperFence);
  const plural = outliers.length === 1 ? 'value' : 'values';
  return {
    kind: 'numeric_outlier',
    column: name,
    severity: 'warn',
    detail:
      `Column "${name}" has ${outliers.length} outlier ${plural} outside the expected range ` +
      `[${lf}, ${uf}]` +
      (minOutlier === maxOutlier ? ` (${minOutlier}).` : ` (from ${minOutlier} to ${maxOutlier}).`),
    facts: {
      count: outliers.length,
      lowerFence: lf,
      upperFence: uf,
      minOutlier,
      maxOutlier,
    },
  };
}

// 2. dominant_category — a text/date column whose modal value's share of NON-EMPTY
// cells is ≥ dominantShare, with ≥ 2 distinct non-empty values (a single-value
// column is a constant_column, handled by findQualityIssues, not "dominant").
function dominantAnomaly(name: string, cells: Cell[], opts: Required<Omit<AnomalyOptions, 'dateCol' | 'measureCol'>>): Anomaly | null {
  const counts = new Map<string, number>();
  let nonEmpty = 0;
  for (const c of cells) {
    if (isEmpty(c)) continue;
    nonEmpty += 1;
    const k = keyOf(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (nonEmpty === 0 || counts.size < 2) return null;

  let topValue = '';
  let topCount = 0;
  for (const [value, n] of counts) {
    if (n > topCount) {
      topCount = n;
      topValue = value;
    }
  }
  const share = topCount / nonEmpty;
  if (share < opts.dominantShare) return null;
  const pct = Math.round(share * 100);
  return {
    kind: 'dominant_category',
    column: name,
    severity: 'info',
    detail: `Column "${name}" is dominated by "${topValue}" — ${topCount} of ${nonEmpty} non-empty cells (${pct}%).`,
    facts: { value: topValue, count: topCount, share: round(share) },
  };
}

// 4. period_change — largest single step-over-step % change of any numeric column
// summed per distinct date. Periods are ordered by Date.parse when every distinct
// date parses, else by string sort (a documented ponytail simplification — good
// enough for ISO/`YYYY`/`YYYY-MM` style dates, the common case). Flags the single
// biggest |change| where the prior period is non-zero and |pct| ≥ periodChangePct.
function periodChangeAnomaly(
  columns: { name: string; type: ColumnType }[],
  rows: Cell[][],
  opts: Required<Omit<AnomalyOptions, 'dateCol' | 'measureCol'>>,
  dateCol?: string,
  measureCol?: string,
): Anomaly | null {
  const dateIdx = dateCol
    ? columns.findIndex((c) => c.name === dateCol)
    : columns.findIndex((c) => c.type === 'date');
  if (dateIdx < 0) return null;

  const numericCols = columns
    .map((c, i) => ({ ...c, i }))
    .filter((c) => c.type === 'number' && (!measureCol || c.name === measureCol));
  if (numericCols.length === 0) return null;

  // Bucket sums per distinct date, per numeric column.
  const dateKeys: string[] = [];
  const seen = new Set<string>();
  const sums = new Map<string, Map<number, number>>(); // dateKey → (colIdx → sum)
  for (const r of rows) {
    if (!r) continue;
    const d = r[dateIdx];
    if (isEmpty(d)) continue;
    const dk = keyOf(d);
    if (!seen.has(dk)) {
      seen.add(dk);
      dateKeys.push(dk);
      sums.set(dk, new Map());
    }
    const bucket = sums.get(dk) as Map<number, number>;
    for (const nc of numericCols) {
      const v = r[nc.i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        bucket.set(nc.i, (bucket.get(nc.i) ?? 0) + v);
      }
    }
  }
  if (dateKeys.length < 2) return null;

  // Order periods: numeric-by-time when all parse, else lexical.
  const parsed = dateKeys.map((k) => Date.parse(k));
  const allParse = parsed.every((n) => Number.isFinite(n));
  const ordered = dateKeys.slice();
  if (allParse) ordered.sort((a, b) => (Date.parse(a) as number) - (Date.parse(b) as number));
  else ordered.sort();

  // Largest single step-over-step |pct| across all numeric columns.
  let best: Anomaly | null = null;
  let bestAbs = 0;
  for (const nc of numericCols) {
    for (let i = 1; i < ordered.length; i += 1) {
      const from = sums.get(ordered[i - 1])?.get(nc.i);
      const to = sums.get(ordered[i])?.get(nc.i);
      if (typeof from !== 'number' || typeof to !== 'number' || from === 0) continue;
      const pct = (to - from) / from;
      const abs = Math.abs(pct);
      if (abs < opts.periodChangePct || abs <= bestAbs) continue;
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
          dateColumn: columns[dateIdx].name,
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

// ── public API ───────────────────────────────────────────────────────────────

// Detect app-computed anomalies over already-loaded columns/rows. Never throws —
// any bad input degrades to []. Findings are capped per-kind (maxPerKind) and in
// total (maxTotal) and ordered warn-before-info.
export function detectAnomalies(
  columns: { name: string; type: ColumnType }[],
  rows: Cell[][],
  opts?: AnomalyOptions,
): Anomaly[] {
  try {
    const cols = Array.isArray(columns) ? columns : [];
    const body = Array.isArray(rows) ? rows : [];
    if (cols.length === 0 || body.length === 0) return [];

    const o = { ...DEFAULTS, ...(opts || {}) };
    const found: Anomaly[] = [];

    // 1 + 2 — per column.
    cols.forEach((col, ci) => {
      if (col.type === 'number') {
        const a = outlierAnomaly(col.name, finiteNumbersOf(body, ci), o);
        if (a) found.push(a);
      } else {
        const cells = body.map((r) => (r ? r[ci] ?? null : null));
        const a = dominantAnomaly(col.name, cells, o);
        if (a) found.push(a);
      }
    });

    // 3 — reuse datasetStats.findQualityIssues for empty_heavy / constant_column.
    for (const issue of findQualityIssues(cols, body)) {
      if (issue.kind === 'empty_heavy') {
        found.push({ kind: 'empty_heavy', column: issue.column, severity: 'warn', detail: issue.detail, facts: {} });
      } else if (issue.kind === 'constant_column') {
        found.push({ kind: 'constant_column', column: issue.column, severity: 'info', detail: issue.detail, facts: {} });
      }
      // duplicate_rows intentionally dropped (not an "unusual change").
    }

    // 4 — one period_change (the single biggest step) if a date + numeric exist.
    const pc = periodChangeAnomaly(cols, body, o, opts?.dateCol, opts?.measureCol);
    if (pc) found.push(pc);

    // Cap per kind (preserving discovery order within a kind).
    const perKind = new Map<AnomalyKind, number>();
    const capped: Anomaly[] = [];
    for (const a of found) {
      const n = perKind.get(a.kind) ?? 0;
      if (n >= o.maxPerKind) continue;
      perKind.set(a.kind, n + 1);
      capped.push(a);
    }

    // Order warn before info (stable), then cap total.
    capped.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
    return capped.slice(0, o.maxTotal);
  } catch (_) {
    return []; // never throws — bad input yields no findings
  }
}

// PURE facts block for the model (guard line + one line per app-detected anomaly).
// Twin of copilot's GUARD_LINE style: every figure below was computed by the app;
// the model must cite them exactly and NEVER recompute or invent one.
const GUARD_LINE =
  'The anomalies below were DETECTED and MEASURED by the app (Ordinate), not by you. ' +
  'Treat every figure as ground truth: cite them exactly and NEVER recompute, round, or invent one.';

export function buildAnomaliesFacts(datasetName: string, anomalies: Anomaly[]): string {
  const list = Array.isArray(anomalies) ? anomalies : [];
  const lines: string[] = [GUARD_LINE, ''];
  if (list.length === 0) {
    lines.push(`No anomalies were detected in dataset "${datasetName}".`);
    return lines.join('\n');
  }
  lines.push(`Anomalies detected in dataset "${datasetName}" (${list.length}, all figures app-computed):`);
  for (const a of list) {
    lines.push(`- [${a.severity}] ${a.detail}`);
  }
  return lines.join('\n');
}
