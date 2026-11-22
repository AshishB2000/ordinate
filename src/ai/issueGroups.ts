// The issues board's GROUPING (docs/issues-board/00-design.md) — PURE.
//
// Signals with a cause key group by that key. The rest first join a group whose missing name their question holds, then cluster by
// similar question words, or by meaning when the caller hands in a `similar` built from embeddings. A group's key is its cause key or
// `words:` plus its three most frequent words; a new group joins an existing issue with the same key, or (a words group) one whose
// stored words overlap enough.

import { jaccard, norm, wordsOf, type Signal, type SignalKind } from './issueSignals';

/** A group under this many QUESTIONS is stored but not shown until it grows. */
export const MIN_QUESTIONS = 3;
/** Two questions this alike in content words are one need. */
export const SIMILAR_WORDS = 0.4;
/** A new words group joins an existing issue whose stored words are this alike. */
export const JOIN_WORDS = 0.5;
/** Unkeyed signals clustered in one run (the newest): a pairwise pass is quadratic. */
export const MAX_CLUSTERED = 2000;

export interface Group {
  key: string;
  /** The words of a words group (empty for a keyed one). */
  words: string[];
  signals: Signal[];
}

export type Similar = (a: Signal, b: Signal) => boolean;

/** Words alike: the default measure. */
export const bySimilarWords: Similar = (a, b) => jaccard(wordsOf(a.question), wordsOf(b.question)) >= SIMILAR_WORDS;

/** Distinct questions in a set of signals (a turn that struggled in two ways is one question). */
export const questionCount = (signals: readonly Pick<Signal, 'turnId'>[]): number => new Set(signals.map((s) => s.turnId)).size;

/** The commonest kind of a group (ties: the order of SIGNAL_KINDS is not used, the kind name is). */
export function mainKind(signals: readonly Signal[]): SignalKind {
  const n = new Map<SignalKind, number>();
  for (const s of signals) n.set(s.kind, (n.get(s.kind) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

/** The three words most of a group's questions hold, alphabetical among equals. */
export function topWords(signals: readonly Signal[]): string[] {
  const n = new Map<string, number>();
  for (const s of signals) for (const w of wordsOf(s.question)) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([w]) => w).sort();
}

const order = (a: Signal, b: Signal): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : a.kind < b.kind ? -1 : 1);

export function groupSignals(all: readonly Signal[], similar: Similar = bySimilarWords): Group[] {
  const keyed = new Map<string, Group>();
  const loose: Signal[] = [];
  for (const s of all) {
    if (!s.key) loose.push(s);
    else (keyed.get(s.key) ?? (keyed.set(s.key, { key: s.key, words: [], signals: [] }), keyed.get(s.key)!)).signals.push(s);
  }
  // A question that holds a missing name another signal already named is that group's.
  const named = [...keyed.values()].filter((g) => g.key.startsWith('name:') && g.key.length - 5 >= 3);
  const rest: Signal[] = [];
  for (const s of loose) {
    const q = ` ${norm(s.question)} `;
    const home = named.find((g) => q.includes(` ${g.key.slice(5)}`));
    if (home) home.signals.push(s);
    else rest.push(s);
  }
  // Single-link clusters over the newest MAX_CLUSTERED (union-find).
  const items = [...rest].sort(order).slice(0, MAX_CLUSTERED);
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (find(i) !== find(j) && similar(items[i], items[j])) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map<number, Signal[]>();
  items.forEach((s, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), s]));
  const out: Group[] = [...keyed.values()];
  for (const members of clusters.values()) {
    const words = topWords(members);
    const key = words.length ? `words:${words.join('+')}` : `words:other:${mainKind(members)}`;
    const same = out.find((g) => g.key === key);
    if (same) same.signals.push(...members);
    else out.push({ key, words, signals: members });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export interface Existing { id: string; key: string; tokens: readonly string[] }

/** The existing issue a group grows: the same key, or (a words group) the closest whose words overlap at least JOIN_WORDS. */
export function matchIssue(g: Group, existing: readonly Existing[]): string | null {
  const exact = existing.find((e) => e.key === g.key);
  if (exact) return exact.id;
  if (!g.key.startsWith('words:') || !g.words.length) return null;
  let best: { id: string; score: number } | null = null;
  for (const e of existing) {
    if (!e.key.startsWith('words:') || !e.tokens.length) continue;
    const score = jaccard(g.words, e.tokens);
    if (score >= JOIN_WORDS && (!best || score > best.score || (score === best.score && e.id < best.id))) best = { id: e.id, score };
  }
  return best?.id ?? null;
}

/** Cosine of two unit vectors (fingerprints are L2-normalised). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += a[i] * b[i];
  return d;
}

/** Words alike OR meaning alike: `vectors` by question text, `min` the model's least similarity. */
export function bySimilarMeaning(vectors: ReadonlyMap<string, ArrayLike<number>>, min: number): Similar {
  return (a, b) => {
    if (bySimilarWords(a, b)) return true;
    const x = vectors.get(a.question);
    const y = vectors.get(b.question);
    return !!x && !!y && cosine(x, y) >= min;
  };
}
