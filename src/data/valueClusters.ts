// SIMILAR VALUES — "Google", "Google LLC" and "google inc." are one company.
// PURE: counts in, clusters out. No fs, no DuckDB, no model.
//
// The suggestion behind Prepare's "Find similar values": it proposes which
// values of a text column to merge, and the merge itself is an ordinary
// `replace_values` step (exact mode) the user reviews, edits and can remove —
// nothing here rewrites a cell.
//
// Two values are similar when they share a KEY (the key-collision method):
// accents folded, case folded, punctuation dropped, company suffixes dropped,
// words de-duplicated and sorted. That finds spelling, casing, spacing and
// "Inc." / "LLC" variants with no model. Aliases a key cannot see ("US" and
// "United States") come from the optional Assistant pass as extra GROUPS — a
// model says only "these name the same thing"; every group is checked against
// the column's real values, and the canonical value and every count are ours.
//
// ponytail: key collision only — "Gooogle" (a typo) is not caught. Add an
// edit-distance pass over the keys if typos turn out to matter; it is O(n²)
// over distinct values, so it needs a blocking key first.

import type { ReplaceRule } from './stepTypes';

export interface ValueCluster {
  /** The value the others become: the most frequent, then the shortest. */
  to: string;
  toCount: number;
  from: Array<{ value: string; count: number }>;
  /** Rows the merge rewrites — the sum of `from`. */
  rows: number;
}

/** Past this many distinct values the column is not a set of labels, and comparing them is not a suggestion. */
export const MAX_DISTINCT = 20_000;
export const MAX_CLUSTERS = 50;

/** Words that do not tell two names apart. Dropped only when something else is left. */
const NOISE = new Set([
  'the', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'sa', 'ag', 'bv', 'pty',
]);

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What two spellings of one thing have in common. '' when the value has no letters or digits. */
export function valueKey(value: string): string {
  const words = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.'’]/g, '') // "U.S.A." is "usa", "O'Brien" is "obrien"
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const core = words.filter((w) => !NOISE.has(w));
  return [...new Set(core.length ? core : words)].sort(byCode).join(' ');
}

/**
 * The clusters of `counts` (`[value, rows]`, each value once): values sharing a
 * key, joined with any `groups` of values said to be the same thing. A value
 * `groups` names that the column does not hold is ignored.
 */
export function clusterValues(
  counts: ReadonlyArray<readonly [string, number]>,
  groups: ReadonlyArray<readonly string[]> = [],
): ValueCluster[] {
  const parent = counts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const firstWithKey = new Map<string, number>();
  const at = new Map<string, number>();
  counts.forEach(([value], i) => {
    at.set(value, i);
    const key = valueKey(value);
    if (!key) return;
    const first = firstWithKey.get(key);
    if (first === undefined) firstWithKey.set(key, i);
    else join(first, i);
  });
  for (const g of groups) {
    const ids = g.map((v) => at.get(v)).filter((i): i is number => i !== undefined);
    for (let k = 1; k < ids.length; k += 1) join(ids[0], ids[k]);
  }

  const sets = new Map<number, number[]>();
  counts.forEach((_, i) => {
    const root = find(i);
    const set = sets.get(root);
    if (set) set.push(i);
    else sets.set(root, [i]);
  });

  const out: ValueCluster[] = [];
  for (const ids of sets.values()) {
    if (ids.length < 2) continue;
    const members = ids
      .map((i) => ({ value: counts[i][0], count: counts[i][1] }))
      .sort((a, b) => b.count - a.count || a.value.length - b.value.length || byCode(a.value, b.value));
    const [to, ...from] = members;
    out.push({ to: to.value, toCount: to.count, from, rows: from.reduce((n, m) => n + m.count, 0) });
  }
  return out.sort((a, b) => b.rows - a.rows || byCode(a.to, b.to));
}

/** The exact-mode rules that carry out `clusters`. */
export function mergeRules(clusters: ReadonlyArray<Pick<ValueCluster, 'to' | 'from'>>): ReplaceRule[] {
  return clusters.flatMap((c) => c.from.map((m) => ({ from: m.value, to: c.to })));
}

/**
 * A model's reply → groups of the column's OWN values. Drop, never repair: a
 * string the column does not hold is dropped, a value already placed stays in
 * its first group, and a group left with fewer than two values is no group.
 */
export function checkGroups(raw: unknown, known: ReadonlySet<string>, max = 200): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break;
    const group: string[] = [];
    for (const v of Array.isArray(g) ? g : []) {
      if (typeof v !== 'string' || !known.has(v) || seen.has(v)) continue;
      seen.add(v);
      group.push(v);
    }
    if (group.length >= 2) out.push(group);
  }
  return out;
}
