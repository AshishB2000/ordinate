// TF-IDF across the groups of a dimension — MAIN PROCESS, PURE.
//
// "Terms most distinctive of West": each value of the chosen dimension is ONE
// document (all its rows' text together), and a term scores
//
//     tf(t, g)  = count of t in g / total term count of g   (every n counted)
//     idf(t)    = ln(N / df(t))                              (N = groups, df = groups using t)
//     tfidf     = tf × idf
//
// The textbook (unsmoothed) idf, chosen on purpose: a term EVERY group uses is
// distinctive of none, so it scores exactly 0 — "service" in every region's
// reviews never outranks "parking" that only West's mention. The smoothed
// sklearn form (ln((1+N)/(1+df)) + 1) never reaches 0, so with three regions it
// would rank West's most FREQUENT words, which is a different question (and the
// "count" ranking already answers it). One group means N = df = 1 and every
// score 0: with nothing to compare against, nothing is distinctive.

import { byCount } from './ngrams';

export interface GroupCounts {
  counts: Map<string, number>;
  /** Sum of every term count in the group — tf's denominator. */
  total: number;
}

/** Document frequency: how many groups use each term. */
export function documentFrequency(groups: readonly GroupCounts[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const g of groups) for (const t of g.counts.keys()) df.set(t, (df.get(t) || 0) + 1);
  return df;
}

/** tfidf of every term of `g`, given the corpus' df and group count N. */
export function tfidfScores(g: GroupCounts, df: Map<string, number>, n: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [t, c] of g.counts) {
    const d = df.get(t) || 1;
    out.set(t, g.total > 0 ? (c / g.total) * Math.log(n / d) : 0);
  }
  return out;
}

/**
 * Rank a group's terms: by tf-idf (ties → count, then term) or by count (ties → term).
 * Returns [term, count, tfidf] triples, best first.
 */
export function rankGroup(
  g: GroupCounts, scores: Map<string, number>, rank: 'count' | 'tfidf', top: number,
): Array<[string, number, number]> {
  const rows: Array<[string, number, number]> = [...g.counts.entries()].map(([t, c]) => [t, c, scores.get(t) || 0]);
  rows.sort((a, b) => {
    if (rank === 'tfidf' && b[2] !== a[2]) return b[2] - a[2];
    return byCount([a[0], a[1]], [b[0], b[1]]);
  });
  return rows.slice(0, Math.max(0, top));
}
