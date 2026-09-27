// Find segments — the fit, end to end. MAIN PROCESS, PURE.
//
// What the panel shows is computed here and nowhere else: which number
// columns are offered (and why others are not), the fit (standardise →
// k-means++ from a fixed seed → Lloyd → k by the silhouette score over 2…8),
// the app-written segment names, the per-segment profile and the PCA
// scatter. Reading the data is behind `SegmentIo`, which has exactly two
// implementations: the resident one over the stored Parquet
// (engine/segmentResident.ts) and the JS reference over hydrated rows
// (`jsSegmentIo`, below). A differential test holds them to Object.is.
//
// SCALE. The fitting sample is at most SAMPLE_CAP rows, spread evenly over
// the complete rows in stored order; k is CHOSEN on a smaller even subsample
// (SELECT_CAP) and the chosen k is then fitted on the whole sample. The
// silhouette is O(n²), so it scores ≤ SILHOUETTE_CAP points of the selection
// subsample. The centroids are then applied to EVERY row for the sizes and
// the profile. A tie in the silhouette goes to the smaller k.

import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import type { ColumnSummary } from '../data/datasetStats';
import type { SegmentStep } from '../data/stepsSegment';
import { SEGMENT_MAX_FEATURES, SEGMENT_MAX_K, SEGMENT_MIN_K, assignCells, featureIndexes } from '../data/stepsSegment';
import { SEED, lloyd, mulberry32, nearest, pca, project, seedPlusPlus, silhouette, strideIndexes, zScore } from './segmentMath';

export const SAMPLE_CAP = 200_000;
export const SELECT_CAP = 20_000;
export const SILHOUETTE_CAP = 3_000;
export const MAX_ITER = 100;
export const MIN_ROWS = 10;
/** |mean z| below this reads as "Average", not High/Low. */
const NAME_EPS = 0.25;
const NAME_MAX = 80;

type Progress = (fraction: number, note?: string) => void;

// ── Which columns are offered ───────────────────────────────────────────────

export interface FeatureChoice {
  name: string;
  checked: boolean;
  /** Why it is not ticked by default: 'id-like', 'near-constant', 'mostly empty', 'no values'. */
  reason?: string;
}

// "customer_id", "Order ID", "zip", "account_no", "customerId".
const ID_TAIL = /(?:^|[\s_.-])(?:id|uuid|guid|key|code|zip|zipcode|postcode|phone|sku|no|num|number)$/i;
const ID_CAMEL = /[a-z](?:Id|ID|Key|Code|No)$/;

/** Why a number column is not a good default feature, or null. From the column profile. */
export function skipReason(col: ParsedColumn, s: ColumnSummary | undefined, rowCount: number): string | null {
  if (ID_TAIL.test(col.name.trim()) || ID_CAMEL.test(col.name.trim())) return 'id-like';
  const count = s && typeof s.count === 'number' ? s.count : 0;
  if (count === 0 || !s || typeof s.min !== 'number' || typeof s.max !== 'number') return 'no values';
  const { min, max } = s;
  // A 1…n run of distinct integers over every row is a row number, not a measure.
  if (Number.isInteger(min) && Number.isInteger(max) && max - min + 1 === count && count === rowCount && count >= 20) return 'id-like';
  if (max - min <= 1e-9 * Math.max(1, Math.abs(min), Math.abs(max))) return 'near-constant';
  if (rowCount > 0 && count < rowCount / 2) return 'mostly empty';
  return null;
}

/** Every DECLARED number column, ticked unless the profile says otherwise (≤ 32 ticked). */
export function featureChoices(columns: ParsedColumn[], summaries: ColumnSummary[], rowCount: number): FeatureChoice[] {
  let ticked = 0;
  return columns.filter((c) => c.type === 'number').map((c) => {
    const reason = skipReason(c, summaries.find((s) => s.name === c.name), rowCount);
    const checked = !reason && ticked < SEGMENT_MAX_FEATURES;
    if (checked) ticked++;
    return reason ? { name: c.name, checked, reason } : { name: c.name, checked };
  });
}

/** 'segment', or 'segment_2', 'segment_3'… when taken. */
export function freeColumn(columns: Array<{ name: string }>, base = 'segment'): string {
  const taken = new Set(columns.map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// ── Reading the data ────────────────────────────────────────────────────────

export interface FeatureStats {
  /** Rows with a finite number in every feature. */
  count: number;
  means: number[];
  /** Population std; a constant feature's 0 is stored as 1 (its z is then 0 everywhere). */
  stds: number[];
}

export interface SegmentSummary {
  /** Rows per segment, over EVERY row of the dataset. */
  sizes: number[];
  /** Rows with no segment (an empty or non-numeric feature). */
  empty: number;
  /** Each segment's mean of each feature, k × features; null for an empty segment. */
  means: Array<Array<number | null>>;
}

export interface SegmentIo {
  /** Null = this reader failed; the caller falls back. */
  stats(idx: number[]): FeatureStats | null;
  /** The complete rows at strideIndexes(complete, cap), in stored order. */
  sample(idx: number[], complete: number, cap: number): number[][] | null;
  summary(step: SegmentStep): SegmentSummary | null;
}

/** The shared finishing arithmetic, so both readers divide identically. */
export function finishStats(count: number, sums: number[], sq: number[]): FeatureStats {
  return {
    count,
    means: sums.map((s) => s / count),
    stds: sq.map((q) => {
      const sd = Math.sqrt(q / count);
      return sd > 0 && Number.isFinite(sd) ? sd : 1;
    }),
  };
}

export function finishSummary(sizes: number[], empty: number, sums: number[][]): SegmentSummary {
  return { sizes, empty, means: sums.map((row, k) => row.map((s) => (sizes[k] > 0 ? s / sizes[k] : null))) };
}

const isNum = (v: Cell | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** The JS REFERENCE reader over hydrated rows. */
export function jsSegmentIo(columns: ParsedColumn[], rows: Cell[][]): SegmentIo {
  const complete = (r: Cell[], idx: number[]): boolean => idx.every((i) => isNum(r[i]));
  return {
    stats(idx) {
      let count = 0;
      const sums = new Array<number>(idx.length).fill(0);
      for (const r of rows) {
        if (!complete(r, idx)) continue;
        count++;
        idx.forEach((ci, j) => { sums[j] += r[ci] as number; });
      }
      if (count === 0) return { count: 0, means: [], stds: [] };
      const means = sums.map((s) => s / count);
      const sq = new Array<number>(idx.length).fill(0);
      for (const r of rows) {
        if (!complete(r, idx)) continue;
        idx.forEach((ci, j) => { const d = (r[ci] as number) - means[j]; sq[j] += d * d; });
      }
      return finishStats(count, sums, sq);
    },
    sample(idx, n, cap) {
      const keep = new Set(strideIndexes(n, cap));
      const out: number[][] = [];
      let i = 0;
      for (const r of rows) {
        if (!complete(r, idx)) continue;
        if (keep.has(i)) out.push(idx.map((ci) => r[ci] as number));
        i++;
      }
      return out;
    },
    summary(step) {
      const idx = featureIndexes(columns, step);
      const k = step.centroids.length;
      const sizes = new Array<number>(k).fill(0);
      const sums = Array.from({ length: k }, () => new Array<number>(idx.length).fill(0));
      const z = new Float64Array(idx.length);
      const cells: Cell[] = new Array(idx.length);
      let empty = 0;
      for (const r of rows) {
        for (let j = 0; j < idx.length; j++) cells[j] = r[idx[j]] ?? null;
        const s = assignCells(cells, step, z);
        if (s < 0) { empty++; continue; }
        sizes[s]++;
        for (let j = 0; j < idx.length; j++) sums[s][j] += cells[j] as number;
      }
      return finishSummary(sizes, empty, sums);
    },
  };
}

// ── The fit ─────────────────────────────────────────────────────────────────

export interface FitCore {
  k: number;
  silhouettes: Array<{ k: number; score: number }>;
  /** Largest segment first (ties: the fit's own order). Standardised units. */
  centroids: number[][];
  /** `nearest` to `centroids` for every sample row. */
  labels: Int32Array;
  iterations: number;
  /** The standardised sample, and the positions the silhouette and the scatter use. */
  z: Float64Array[];
  plot: number[];
}

/** The k with the highest silhouette; a tie goes to the SMALLER k (scores arrive in ascending k). */
export function chooseK(scores: Array<{ k: number; score: number }>): number | null {
  let best: { k: number; score: number } | null = null;
  for (const s of scores) if (!best || s.score > best.score) best = s;
  return best ? best.k : null;
}

function fitK(z: Float64Array[], k: number): ReturnType<typeof lloyd> | null {
  const seeds = seedPlusPlus(z, k, mulberry32(SEED));
  return seeds ? lloyd(z, seeds, MAX_ITER) : null;
}

/** Standardise the sample, choose k by silhouette, fit it, order segments by size. */
export function fitCore(sample: number[][], stats: FeatureStats, progress: Progress = () => {}): FitCore | { error: string } {
  const z = sample.map((row) => Float64Array.from(row, (x, j) => zScore(x, stats.means[j], stats.stds[j])));
  const selectIdx = strideIndexes(z.length, SELECT_CAP);
  const sel = selectIdx.map((i) => z[i]);
  const silIdx = strideIndexes(sel.length, SILHOUETTE_CAP);
  const silPoints = silIdx.map((i) => sel[i]);
  const silhouettes: Array<{ k: number; score: number }> = [];
  const fits = new Map<number, ReturnType<typeof lloyd>>();
  for (let k = SEGMENT_MIN_K; k <= SEGMENT_MAX_K; k++) {
    progress(0.15 + (0.55 * (k - SEGMENT_MIN_K)) / (SEGMENT_MAX_K - SEGMENT_MIN_K + 1), `Trying ${k} segments`);
    const fit = fitK(sel, k);
    if (!fit) break; // fewer distinct rows than k — no larger k can work either
    fits.set(k, fit);
    silhouettes.push({ k, score: silhouette(silPoints, silIdx.map((i) => fit.labels[i]), k) });
  }
  const k = chooseK(silhouettes);
  if (k === null) return { error: 'The chosen columns have fewer than two distinct rows, so there is nothing to split.' };
  progress(0.72, `Fitting ${k} segments on ${z.length.toLocaleString('en-US')} rows`);
  const final = sel.length === z.length ? (fits.get(k) as ReturnType<typeof lloyd>) : (fitK(z, k) as ReturnType<typeof lloyd>);
  const sizes = new Array<number>(k).fill(0);
  for (const l of final.labels) sizes[l]++;
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a] || a - b);
  const centroids = order.map((c) => Array.from(final.centroids[c]));
  const labels = Int32Array.from(z, (p) => nearest(p, centroids));
  return {
    k,
    silhouettes,
    centroids,
    labels,
    iterations: final.iterations,
    z,
    plot: silIdx.map((i) => selectIdx[i]),
  };
}

/** "revenue", "unit price" — a column name as a word in a segment name. */
function word(name: string): string {
  return name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/**
 * "High revenue · Low discount": each segment's two features with the largest
 * |mean z| (ties: column order). Two segments with the same name each take
 * their next feature until they differ; any that still collide get " (2)",
 * " (3)" in segment order.
 */
export function segmentNames(centroids: number[][], features: string[]): string[] {
  const f = features.length;
  const ranked = centroids.map((c) => c.map((_, j) => j).sort((a, b) => Math.abs(c[b]) - Math.abs(c[a]) || a - b));
  const part = (c: number[], j: number): string =>
    (c[j] >= NAME_EPS ? 'High ' : c[j] <= -NAME_EPS ? 'Low ' : 'Average ') + word(features[j]);
  const depth = centroids.map(() => Math.min(2, f));
  const make = (s: number): string => clip(ranked[s].slice(0, depth[s]).map((j) => part(centroids[s], j)).join(' · '), NAME_MAX);
  let names = centroids.map((_, s) => make(s));
  for (let guard = 0; guard < f; guard++) {
    const clash = names.map((n) => names.filter((m) => m === n).length > 1);
    let grew = false;
    clash.forEach((c, s) => {
      if (c && depth[s] < f) { depth[s]++; grew = true; }
    });
    if (!grew) break;
    names = centroids.map((_, s) => make(s));
  }
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) || 0) + 1;
    seen.set(n, count);
    if (count === 1) return n;
    const suffix = ` (${count})`;
    return clip(n, NAME_MAX - suffix.length) + suffix;
  });
}

export interface FitResult {
  features: string[];
  k: number;
  silhouettes: Array<{ k: number; score: number }>;
  names: string[];
  /** Ready for "Save as column" — the renderer may only change `column`. */
  step: SegmentStep;
  total: number;
  complete: number;
  fitted: number;
  iterations: number;
  sizes: number[];
  empty: number;
  profile: {
    overall: number[];
    stds: number[];
    segments: Array<Array<number | null>>;
    /** (segment mean − overall mean) / std. */
    deviation: Array<Array<number | null>>;
  };
  pca: { variance: [number, number]; points: Array<[number, number, number]> };
}

/** Why these features cannot be fitted, or null. */
export function featureProblem(columns: ParsedColumn[], features: unknown): string | null {
  if (!Array.isArray(features) || features.length < 2) return 'Pick at least two number columns.';
  if (features.length > SEGMENT_MAX_FEATURES) return `Pick at most ${SEGMENT_MAX_FEATURES} columns.`;
  if (new Set(features).size !== features.length) return 'A column is picked twice.';
  for (const f of features) {
    const c = columns.find((col) => col.name === f);
    if (!c) return `There is no column "${String(f)}".`;
    if (c.type !== 'number') return `"${c.name}" is not a number column.`;
  }
  return null;
}

/**
 * The whole fit through one reader. Null = the reader failed (fall back to
 * the other one); `{ error }` = a real answer the user sees.
 */
export function runFit(columns: ParsedColumn[], features: string[], io: SegmentIo, progress: Progress = () => {}): FitResult | { error: string } | null {
  const problem = featureProblem(columns, features);
  if (problem) return { error: problem };
  const idx = features.map((f) => columns.findIndex((c) => c.name === f));
  progress(0.03, 'Reading the columns');
  const stats = io.stats(idx);
  if (!stats) return null;
  if (stats.count < MIN_ROWS) {
    return { error: `Only ${stats.count} row${stats.count === 1 ? ' has' : 's have'} a number in every chosen column — at least ${MIN_ROWS} are needed.` };
  }
  progress(0.08, 'Sampling rows');
  const sample = io.sample(idx, stats.count, SAMPLE_CAP);
  if (!sample) return null;
  const core = fitCore(sample, stats, progress);
  if ('error' in core) return core;
  const names = segmentNames(core.centroids, features);
  const step: SegmentStep = {
    type: 'segment',
    column: freeColumn(columns),
    features: features.slice(),
    means: stats.means,
    stds: stats.stds,
    centroids: core.centroids,
    names,
  };
  progress(0.9, 'Assigning every row');
  const summary = io.summary(step);
  if (!summary) return null;
  const axes = pca(core.z);
  const points = core.plot.map((i): [number, number, number] => {
    const [x, y] = project(core.z[i], axes);
    return [x, y, core.labels[i]];
  });
  progress(1, `${core.k} segments`);
  return {
    features: features.slice(),
    k: core.k,
    silhouettes: core.silhouettes,
    names,
    step,
    total: summary.sizes.reduce((a, b) => a + b, 0) + summary.empty,
    complete: stats.count,
    fitted: sample.length,
    iterations: core.iterations,
    sizes: summary.sizes,
    empty: summary.empty,
    profile: {
      overall: stats.means,
      stds: stats.stds,
      segments: summary.means,
      deviation: summary.means.map((row) => row.map((m, j) => (m === null ? null : (m - stats.means[j]) / stats.stds[j]))),
    },
    pca: { variance: axes.variance, points },
  };
}
