// The numbers behind "Find segments" — MAIN PROCESS, PURE, deterministic.
//
// Standardise, k-means++ seeding from a FIXED-SEED PRNG, Lloyd iterations,
// the silhouette score and a symmetric eigen-solver for PCA. No randomness
// that is not seeded, no Math.random, no reliance on Map/Set iteration for
// anything numeric: the same sample in gives the same model out, bit for bit,
// on every run and every machine.
//
// THE ONE ASSIGNMENT RULE. `zScore` + `dist2` + `nearest` are the only way a
// row becomes a segment — the fit's own labels, the Prepare step's JS fold
// (src/data/stepsSegment.ts) and its SQL (src/engine/sqlGenSegment.ts, which
// spells the SAME arithmetic in the same order) all go through them, so a
// saved step reproduces the fit exactly. Ties go to the LOWEST index.

export const SEED = 42;

/** mulberry32 — a tiny, well-mixed 32-bit PRNG. Same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ONE standardisation. */
export function zScore(x: number, mean: number, std: number): number {
  return (x - mean) / std;
}

/** Squared Euclidean distance as a left fold over the features. */
export function dist2(z: ArrayLike<number>, c: ArrayLike<number>): number {
  let d = 0;
  for (let j = 0; j < c.length; j++) {
    const t = z[j] - c[j];
    d += t * t;
  }
  return d;
}

/** The nearest centroid; a tie goes to the lowest index. */
export function nearest(z: ArrayLike<number>, centroids: ArrayLike<number>[]): number {
  let best = 0;
  let bestD = dist2(z, centroids[0]);
  for (let k = 1; k < centroids.length; k++) {
    const d = dist2(z, centroids[k]);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/**
 * Evenly spread positions: keep 1-based i when floor(i·T/N) > floor((i−1)·T/N).
 * Exactly T of N (all of them when N ≤ T), first and last regions both covered.
 * The resident sample uses the SAME integer rule in SQL.
 */
export function strideIndexes(n: number, target: number): number[] {
  const out: number[] = [];
  if (n <= target) {
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  for (let i = 1; i <= n; i++) {
    if (Math.floor((i * target) / n) > Math.floor(((i - 1) * target) / n)) out.push(i - 1);
  }
  return out;
}

/**
 * k-means++ seeding: the first centre uniformly, each next one with
 * probability ∝ D². Null when the points have fewer than k distinct values
 * (every remaining D² is zero), so the caller does not fit that k.
 */
export function seedPlusPlus(points: Float64Array[], k: number, rng: () => number): Float64Array[] | null {
  const n = points.length;
  if (n < k || k < 1) return null;
  const centers: Float64Array[] = [Float64Array.from(points[Math.min(n - 1, Math.floor(rng() * n))])];
  const d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d2[i] = dist2(points[i], centers[0]);
  while (centers.length < k) {
    let total = 0;
    let last = -1;
    for (let i = 0; i < n; i++) {
      total += d2[i];
      if (d2[i] > 0) last = i;
    }
    if (!(total > 0) || last < 0) return null;
    let r = rng() * total;
    let pick = last; // float drift past the end lands on the last candidate
    for (let i = 0; i < n; i++) {
      r -= d2[i];
      if (r < 0 && d2[i] > 0) {
        pick = i;
        break;
      }
    }
    const c = Float64Array.from(points[pick]);
    centers.push(c);
    for (let i = 0; i < n; i++) {
      const d = dist2(points[i], c);
      if (d < d2[i]) d2[i] = d;
    }
  }
  return centers;
}

export interface KMeansResult {
  centroids: Float64Array[];
  labels: Int32Array;
  iterations: number;
}

/**
 * Lloyd's algorithm from the given seeds, to convergence (no label changed) or
 * `maxIter`. An emptied cluster keeps its previous centre. Means are left
 * folds in sample order. The returned labels are ALWAYS `nearest` to the
 * returned centroids — the rule a saved step applies.
 */
export function lloyd(points: Float64Array[], seeds: Float64Array[], maxIter: number): KMeansResult {
  const n = points.length;
  const k = seeds.length;
  const f = seeds[0].length;
  const centroids = seeds.map((c) => Float64Array.from(c));
  const labels = new Int32Array(n).fill(-1);
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const l = nearest(points[i], centroids);
      if (l !== labels[i]) {
        labels[i] = l;
        changed++;
      }
    }
    iterations = it + 1;
    if (changed === 0) break;
    const sums = Array.from({ length: k }, () => new Float64Array(f));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const s = sums[labels[i]];
      const p = points[i];
      for (let j = 0; j < f; j++) s[j] += p[j];
      counts[labels[i]]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < f; j++) centroids[c][j] = sums[c][j] / counts[c];
    }
  }
  for (let i = 0; i < n; i++) labels[i] = nearest(points[i], centroids);
  return { centroids, labels, iterations };
}

/**
 * Mean silhouette over `points` with `labels` (0..k−1). O(n²) — callers pass a
 * subsample. A point alone in its cluster scores 0; with one cluster present
 * every point scores 0.
 */
export function silhouette(points: Float64Array[], labels: ArrayLike<number>, k: number): number {
  const n = points.length;
  if (n < 2) return 0;
  const size = new Float64Array(k);
  for (let i = 0; i < n; i++) size[labels[i]]++;
  const sum = new Float64Array(k);
  let total = 0;
  for (let i = 0; i < n; i++) {
    sum.fill(0);
    for (let j = 0; j < n; j++) {
      if (j !== i) sum[labels[j]] += Math.sqrt(dist2(points[i], points[j]));
    }
    const own = labels[i];
    if (size[own] <= 1) continue; // s = 0
    const a = sum[own] / (size[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c !== own && size[c] > 0) b = Math.min(b, sum[c] / size[c]);
    }
    if (b === Infinity) continue;
    const m = Math.max(a, b);
    total += m > 0 ? (b - a) / m : 0;
  }
  return total / n;
}

export interface Eigen {
  values: number[];
  vectors: number[][]; // vectors[i] is the unit eigenvector of values[i]
}

/**
 * Eigen-decomposition of a real SYMMETRIC matrix by cyclic Jacobi rotations.
 * Deterministic: fixed sweep order, fixed stop rule. Sorted by value, largest
 * first (a tie keeps the lower original index first), and each vector's sign
 * fixed so its largest-magnitude component (lowest index on a tie) is
 * positive — so a result never flips between runs.
 */
export function jacobiEigen(matrix: number[][]): Eigen {
  const n = matrix.length;
  const a = matrix.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let r = 0; r < n; r++) {
          const arp = a[r][p];
          const arq = a[r][q];
          a[r][p] = c * arp - s * arq;
          a[r][q] = s * arp + c * arq;
        }
        for (let r = 0; r < n; r++) {
          const apr = a[p][r];
          const aqr = a[q][r];
          a[p][r] = c * apr - s * aqr;
          a[q][r] = s * apr + c * aqr;
        }
        for (let r = 0; r < n; r++) {
          const vrp = v[r][p];
          const vrq = v[r][q];
          v[r][p] = c * vrp - s * vrq;
          v[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y][y] - a[x][x] || x - y);
  const values = order.map((i) => a[i][i]);
  const vectors = order.map((i) => {
    const vec = v.map((row) => row[i]);
    let big = 0;
    for (let j = 1; j < n; j++) if (Math.abs(vec[j]) > Math.abs(vec[big])) big = j;
    return vec[big] < 0 ? vec.map((x) => -x) : vec;
  });
  return { values, vectors };
}

export interface Pca {
  /** Share of total variance on PC1 and PC2. */
  variance: [number, number];
  /** The first two principal axes (unit vectors over the features). */
  axes: [number[], number[]];
  /** Column means the points are centred on before projecting. */
  center: number[];
}

/** PCA of the (already standardised) points: the covariance, then Jacobi. */
export function pca(points: Float64Array[]): Pca {
  const n = points.length;
  const f = n ? points[0].length : 0;
  const center = new Array<number>(f).fill(0);
  for (const p of points) for (let j = 0; j < f; j++) center[j] += p[j];
  for (let j = 0; j < f; j++) center[j] = n ? center[j] / n : 0;
  const cov = Array.from({ length: f }, () => new Array<number>(f).fill(0));
  const d = new Float64Array(f);
  for (const p of points) {
    for (let j = 0; j < f; j++) d[j] = p[j] - center[j];
    for (let x = 0; x < f; x++) for (let y = x; y < f; y++) cov[x][y] += d[x] * d[y];
  }
  for (let x = 0; x < f; x++) {
    for (let y = x; y < f; y++) {
      cov[x][y] = n > 1 ? cov[x][y] / (n - 1) : 0;
      cov[y][x] = cov[x][y];
    }
  }
  const e = jacobiEigen(cov);
  const total = e.values.reduce((s, x) => s + Math.max(0, x), 0);
  const share = (i: number): number => (total > 0 && i < e.values.length ? Math.max(0, e.values[i]) / total : 0);
  const zero = new Array<number>(f).fill(0);
  return {
    variance: [share(0), share(1)],
    axes: [e.vectors[0] || zero, e.vectors[1] || zero],
    center,
  };
}

/** One point on the first two principal axes. */
export function project(p: ArrayLike<number>, model: Pca): [number, number] {
  let x = 0;
  let y = 0;
  for (let j = 0; j < model.center.length; j++) {
    const c = p[j] - model.center[j];
    x += c * model.axes[0][j];
    y += c * model.axes[1][j];
  }
  return [x, y];
}
