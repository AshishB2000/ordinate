// Which column pair most likely relates two datasets. PURE. MAIN PROCESS.
//
// Three signals, all app-computed:
//   name   — how alike the two headers are (0..1, after normalising case,
//            punctuation and a trailing id/key/code);
//   type   — whether the declared types agree;
//   rate   — the SAMPLED share of FROM keys found in TO (joinJs.joinRateJs /
//            joinResident.joinRateResident), the one signal that looks at data.
//
// The rate is the expensive one, so it is only computed for the pairs the two
// cheap signals rank highest — `RATE_CANDIDATES` of them.

import type { ParsedColumn } from '../data/parse';

export const RATE_CANDIDATES = 12;
export const RATE_SAMPLE = 5000;

export interface KeyCandidate {
  from: string;
  to: string;
  name: number;
  typeMatch: boolean;
  /** Share of sampled FROM keys found in TO; null when not measured or no keys. */
  rate: number | null;
  score: number;
}

/** "Customer ID" / "customer_id" / "customerId" → "customer". */
export function normalizeHeader(s: string): string {
  const flat = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return flat.replace(/(id|key|code|no|num|number)$/, '') || flat;
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 1 for the same normalised header, else a Dice coefficient over letter pairs (containment floors at 0.8). */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeHeader(a);
  const y = normalizeHeader(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let dice = 0;
  if (bx.length && by.length) {
    const pool = new Map<string, number>();
    for (const g of by) pool.set(g, (pool.get(g) || 0) + 1);
    let hits = 0;
    for (const g of bx) {
      const n = pool.get(g) || 0;
      if (n > 0) { hits++; pool.set(g, n - 1); }
    }
    dice = (2 * hits) / (bx.length + by.length);
  }
  const contains = x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
  return Math.max(dice, contains ? 0.8 : 0);
}

const W_NAME = 0.45;
const W_TYPE = 0.15;
const W_RATE = 0.4;

/**
 * Every column pair, ranked. `rateOf` is called for at most `RATE_CANDIDATES`
 * pairs — the best by name and type — and may return null (unmeasurable).
 * Ties keep FROM column order, then TO column order, so the ranking is stable.
 */
export function rankKeys(
  fromCols: ParsedColumn[],
  toCols: ParsedColumn[],
  rateOf: (from: string, to: string) => number | null,
  limit = 8,
): KeyCandidate[] {
  const pairs: KeyCandidate[] = [];
  for (const f of fromCols) {
    for (const t of toCols) {
      const name = nameSimilarity(f.name, t.name);
      const typeMatch = f.type === t.type;
      pairs.push({ from: f.name, to: t.name, name, typeMatch, rate: null, score: W_NAME * name + W_TYPE * (typeMatch ? 1 : 0) });
    }
  }
  const byCheap = pairs.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score || a.i - b.i);
  for (const { p } of byCheap.slice(0, RATE_CANDIDATES)) {
    p.rate = rateOf(p.from, p.to);
    p.score += W_RATE * (p.rate ?? 0);
  }
  return pairs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.score - a.p.score || a.i - b.i)
    .slice(0, limit)
    .map(({ p }) => p);
}

/**
 * The cardinality the data supports, from the key statistics: TO keys unique →
 * many-to-one (and one-to-one when FROM keys are unique too). Null when TO
 * repeats keys, which no relationship here can represent safely.
 */
export function inferCardinality(stats: { fromKeys: number; fromKeyed: number; toKeys: number; toKeyed: number }): 'many_to_one' | 'one_to_one' | null {
  if (stats.toKeys !== stats.toKeyed) return null;
  return stats.fromKeys === stats.fromKeyed ? 'one_to_one' : 'many_to_one';
}
