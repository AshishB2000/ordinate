// Reciprocal rank fusion (docs/assistant/00-design.md "Scale rules"): meaning
// and words merge by RANK, never by comparing their scores. Pure.
//
// An item's score is Σ 1/(k + rank) over the lists it is in (rank from 1; a
// list naming it twice counts its best rank once; a list without it adds
// nothing). Ties go to the better rank in the FIRST list (words), then to the
// key. Each item's terms are added smallest rank first, so two items with the
// same ranks get the very same score, whatever list they came from.

export interface Fused {
  readonly key: string;
  readonly score: number;
}

const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** `lists` (best first; words first) as one ranking, at most `limit` long. */
export function fuse(lists: readonly (readonly string[])[], { k = 60, limit = Infinity }: { k?: number; limit?: number } = {}): Fused[] {
  if (!(k >= 0 && Number.isFinite(k))) throw new RangeError(`k must be a finite number ≥ 0, not ${k}`);
  const ranks = new Map<string, number[]>();
  const words = new Map<string, number>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((key, i) => {
      if (seen.has(key)) return;
      seen.add(key);
      const mine = ranks.get(key);
      if (mine) mine.push(i + 1);
      else ranks.set(key, [i + 1]);
      if (li === 0) words.set(key, i + 1);
    });
  });
  const fused = [...ranks].map(([key, rs]) => ({ key, score: rs.sort((a, b) => a - b).reduce((s, r) => s + 1 / (k + r), 0) }));
  const wordRank = (key: string): number => words.get(key) ?? Infinity;
  fused.sort((a, b) => b.score - a.score || cmp(wordRank(a.key), wordRank(b.key)) || cmp(a.key, b.key));
  return fused.slice(0, Math.max(0, limit));
}
