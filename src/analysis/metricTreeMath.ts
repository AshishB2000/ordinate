// A metric tree's ARITHMETIC — MAIN PROCESS, PURE: figures in, figures out. No
// fs, no DuckDB, no model. The derivation is docs/metric-tree/00-design.md
// "The math"; this file is that section in code.
//
// A node's change is split across its children by the SHAPLEY value of the
// relation f (sum, product, ratio): a coalition S of children takes its current
// figures, the rest keep their previous ones, and
//
//   c_i = Σ_{S ⊆ N∖{i}} |S|!(n−|S|−1)!/n! · [ f(x^{S∪{i}}) − f(x^S) ]
//
// so Σ c_i = f(x¹) − f(x⁰) with no special case for a zero or a sign change. A
// sum is s_i·Δx_i, computed directly (exact in floating point as well).

import type { TreeRelation } from './metricTree';

export interface Part {
  previous: number | null;
  current: number | null;
  /** Sum only: subtracted. */
  negative?: boolean;
}

export type Contributions =
  | { ok: true; contributions: number[]; implied: number }
  | { ok: false; why: 'missing' | 'zero_denominator' };

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** f over one coalition's figures, or null when it has none (a zero denominator). */
export function relate(relation: TreeRelation, xs: number[], negative: boolean[] = []): number | null {
  if (relation === 'sum') return xs.reduce((s, x, i) => s + (negative[i] ? -x : x), 0);
  if (relation === 'product') return xs.reduce((p, x) => p * x, 1);
  return xs[1] === 0 ? null : xs[0] / xs[1];
}

const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];

/** The Shapley weight |S|!(n−|S|−1)!/n! for a coalition of `s` others among `n`. */
export function shapleyWeight(s: number, n: number): number {
  return (FACT[s] * FACT[n - s - 1]) / FACT[n];
}

/**
 * Each part's contribution to the change of f, and f's own change (`implied`).
 * Not a figure when a part has none in a period, or a ratio meets a zero
 * denominator in any coalition.
 */
export function contributions(relation: TreeRelation, parts: Part[]): Contributions {
  if (!parts.every((p) => fin(p.previous) && fin(p.current))) return { ok: false, why: 'missing' };
  const x0 = parts.map((p) => p.previous as number);
  const x1 = parts.map((p) => p.current as number);
  const neg = parts.map((p) => !!p.negative);
  if (relation === 'sum') {
    const c = parts.map((_, i) => (neg[i] ? -(x1[i] - x0[i]) : x1[i] - x0[i]));
    return { ok: true, contributions: c, implied: (relate('sum', x1, neg) as number) - (relate('sum', x0, neg) as number) };
  }
  const n = parts.length;
  // f at every coalition, by bitmask: bit i set = part i at its current figure.
  const at: Array<number | null> = [];
  for (let mask = 0; mask < 1 << n; mask += 1) at.push(relate(relation, x0.map((v, i) => (mask & (1 << i) ? x1[i] : v))));
  if (at.some((v) => v === null || !Number.isFinite(v))) return { ok: false, why: 'zero_denominator' };
  const c = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let mask = 0; mask < 1 << n; mask += 1) {
      if (mask & (1 << i)) continue;
      let size = 0;
      for (let b = mask; b; b &= b - 1) size += 1;
      c[i] += shapleyWeight(size, n) * ((at[mask | (1 << i)] as number) - (at[mask] as number));
    }
  }
  return { ok: true, contributions: c, implied: (at[(1 << n) - 1] as number) - (at[0] as number) };
}

/** Below this the gap between a node's change and its parts' is float noise, not a figure. */
export const RESIDUAL_TOLERANCE = 1e-9;

/** The part of `delta` the children do not explain, or null when there is none worth showing. */
export function residualOf(delta: number, explained: number[]): number | null {
  const sum = explained.reduce((s, v) => s + v, 0);
  const r = delta - sum;
  return Math.abs(r) > RESIDUAL_TOLERANCE * Math.max(1, Math.abs(delta)) ? r : null;
}

/** c / Δ × 100, or null when the parent did not change. */
export function shareOf(c: number | null, delta: number | null): number | null {
  return fin(c) && fin(delta) && delta !== 0 ? (c / delta) * 100 : null;
}

/**
 * Which child explains most of the parent's change: the largest
 * `contribution × sign(Δ)` — the push in the direction the parent went. Ties
 * go to the earlier child (editor order); none when the parent did not move or
 * no child pushed its way.
 */
export function leadIndex(contribs: Array<number | null>, delta: number | null): number {
  if (!fin(delta) || delta === 0) return -1;
  const sign = Math.sign(delta);
  let best = -1;
  let bestV = 0;
  contribs.forEach((c, i) => {
    if (!fin(c)) return;
    const v = c * sign;
    if (v > bestV) {
      best = i;
      bestV = v;
    }
  });
  return best;
}

/** Segments shown before "Other": the largest |contribution| first, ties by key. */
export const SEGMENTS_SHOWN = 6;

/** Indexes of the segments to show (largest |contribution| first) and of the rest. */
export function topSegments(items: Array<{ key: string; contribution: number | null }>, shown = SEGMENTS_SHOWN): { shown: number[]; rest: number[] } {
  const order = items
    .map((it, i) => ({ i, key: it.key, v: fin(it.contribution) ? Math.abs(it.contribution) : -1 }))
    .sort((a, b) => b.v - a.v || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.i);
  // One left over reads better as itself than as "Other (1)".
  const cut = order.length <= shown + 1 ? order.length : shown;
  return { shown: order.slice(0, cut), rest: order.slice(cut) };
}
