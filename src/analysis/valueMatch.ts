// How a word someone said finds a VALUE the data holds — PURE: no fs, no model,
// no imports. One matcher for the two places that read a typed value against a
// column's cells: the dashboard's filter bar (./filterParse) and the
// Assistant's chart answers (src/ai/answerValues.ts).
//
// A said value and a stored one are compared as KEYS: lower case, accents and
// the punctuation at a word's edges stripped, inner whitespace collapsed. A key
// then matches at one of four levels, nearest first:
//   exact     the keys are equal
//   prefix    the stored key starts with the said one, and is longer
//   fuzzy     one edit apart (an insertion, a deletion or a substitution)
//   contains  one key holds the other — offered as a suggestion, never taken
// Each level leaves out what a nearer one already took, so a stored value sits
// at exactly one.

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** A typed word without the punctuation at its edges: `"West",` → `West`. */
export function trimEdges(s: string): string {
  return s.replace(EDGE, '');
}

/** Lower case, accents and edge punctuation stripped: "Québec," → "quebec". */
export function normText(s: string): string {
  return trimEdges(String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
}

/** A phrase as its key: every word through `normText`, single spaces between. */
export function normPhrase(s: string): string {
  return String(s).split(/\s+/).map(normText).filter(Boolean).join(' ');
}

/** Levenshtein distance ≤ 1, without building the matrix. */
export function withinOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export type MatchLevel = 'exact' | 'prefix' | 'fuzzy';
export type Nearness = MatchLevel | 'contains';

const TEST: Record<Nearness, (phrase: string, key: string) => boolean> = {
  exact: (p, k) => k === p,
  prefix: (p, k) => k.length > p.length && k.startsWith(p),
  fuzzy: (p, k) => k !== p && withinOne(p, k),
  contains: (p, k) => k.includes(p) || p.includes(k),
};
const NEAREST_FIRST: readonly Nearness[] = ['exact', 'prefix', 'fuzzy', 'contains'];

/** Does the said key match the stored key at this level? Both are keys already (`normPhrase`). */
export function keyMatches(level: Nearness, phrase: string, key: string): boolean {
  return TEST[level](phrase, key);
}

/** Said keys shorter than this match exactly or not at all: "te" is not "Technology". */
export const MIN_LOOSE = 3;

export interface NearValue { value: string; level: Nearness }

/**
 * The stored values a said one may mean, nearest level first and in the order
 * given within a level. Stored values that share a key are one value — the
 * first spelling met — so "West" and "west " are not two candidates. A level
 * past `exact` needs MIN_LOOSE characters on both sides.
 */
export function nearValues(said: string, stored: Iterable<string>): NearValue[] {
  const phrase = normPhrase(said);
  if (!phrase) return [];
  const byKey = new Map<string, string>();
  for (const v of stored) {
    const key = normPhrase(v);
    if (key && !byKey.has(key)) byKey.set(key, v);
  }
  const out: NearValue[] = [];
  for (const level of NEAREST_FIRST) {
    if (level !== 'exact' && phrase.length < MIN_LOOSE) break;
    for (const [key, value] of byKey) {
      if ((level !== 'exact' && key.length < MIN_LOOSE) || !keyMatches(level, phrase, key)) continue;
      out.push({ value, level });
      byKey.delete(key); // taken: a later level never offers it again
    }
  }
  return out;
}

/**
 * The ONE stored value a said one means, or null: the nearest level at which
 * anything matches must hold exactly one value, and `contains` never decides.
 * Two candidates are a guess, and a guess is not taken.
 */
export function oneNearValue(said: string, stored: Iterable<string>): NearValue | null {
  const near = nearValues(said, stored);
  if (!near.length || near[0].level === 'contains') return null;
  return near.length > 1 && near[1].level === near[0].level ? null : near[0];
}
