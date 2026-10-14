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

/** The same text ignoring case and surrounding space — what two stored values must differ by to be two. */
export const exactKey = (s: string): string => s.trim().toLowerCase();

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
 * A column's stored values by key, each key with EVERY distinct value behind it
 * ("Technology" and "Technology." are two, "West" and "west " one — the first
 * spelling met). Built once per column and handed to `nearValues` for each said
 * value, so a list of them does not normalise the column again for each.
 */
export interface ValueKeys { readonly byKey: ReadonlyMap<string, readonly string[]> }

export function valueKeys(stored: Iterable<string>): ValueKeys {
  const byKey = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const v of stored) {
    const same = exactKey(v);
    if (seen.has(same)) continue;
    seen.add(same);
    const key = normPhrase(v);
    if (!key) continue;
    const behind = byKey.get(key);
    if (behind) behind.push(v);
    else byKey.set(key, [v]);
  }
  return { byKey };
}

/**
 * The stored values a said one may mean, nearest level first and in the order
 * given within a level. A level past `exact` needs MIN_LOOSE characters on both
 * sides. So does `exact` itself unless a stored value IS the said text (in any
 * case): a key strips punctuation, and "A" is not "A+" — nor "A-".
 */
export function nearValues(said: string, stored: Iterable<string> | ValueKeys): NearValue[] {
  const phrase = normPhrase(said);
  if (!phrase) return [];
  const { byKey } = 'byKey' in stored ? stored : valueKeys(stored);
  const short = phrase.length < MIN_LOOSE;
  const asSaid = exactKey(said);
  const at: NearValue[][] = NEAREST_FIRST.map(() => []);
  for (const [key, values] of byKey) {
    const i = NEAREST_FIRST.findIndex((level) =>
      (level === 'exact' || (!short && key.length >= MIN_LOOSE)) && keyMatches(level, phrase, key));
    if (i < 0) continue;
    const same = values.filter((v) => exactKey(v) === asSaid);
    const taken = i === 0 && (same.length || short) ? same : values;
    for (const value of taken) at[i].push({ value, level: NEAREST_FIRST[i] });
  }
  return at.flat();
}

/**
 * The ONE stored value a said one means, or null: the nearest level at which
 * anything matches must hold exactly one value, and `contains` never decides.
 * Two candidates are a guess, and a guess is not taken.
 */
export function oneNearValue(said: string, stored: Iterable<string> | ValueKeys): NearValue | null {
  const near = nearValues(said, stored);
  if (!near.length || near[0].level === 'contains') return null;
  return near.length > 1 && near[1].level === near[0].level ? null : near[0];
}
