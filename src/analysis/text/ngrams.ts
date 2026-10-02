// N-grams and term counts — MAIN PROCESS, PURE.
//
// Decisions, pinned by scripts/test-textCore.ts:
//   · n-grams are built on the token stream AFTER stop words are removed, the
//     common choice: "the service was slow" gives the bigram "service slow".
//     The gap a removed word leaves is closed, so a bigram can join two words
//     that had a stop word between them.
//   · they never cross a SEGMENT (sentence punctuation, tokenize.ts) or a row.
//   · a term is its tokens joined by ONE space; n is its token count, 1–3.
//   · counts are OCCURRENCES ("good good" counts "good" twice), not documents.

import type { TextLang } from './tokenize';
import { tokenizeSegments } from './tokenize';
import { stopwords } from './stopwords';

export const MAX_NGRAM = 3;

export interface TermOptions {
  lang: TextLang;
  minN: number;
  maxN: number;
  keepNumbers?: boolean;
}

/** The n-grams of one token list, in order. */
export function ngrams(tokens: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Content tokens of `text` per segment — stop words removed. */
export function contentSegments(text: string, lang: TextLang, keepNumbers = false): string[][] {
  const stop = stopwords(lang);
  const out: string[][] = [];
  for (const seg of tokenizeSegments(text, { lang, keepNumbers })) {
    const kept = seg.filter((t) => !stop.has(t));
    if (kept.length) out.push(kept);
  }
  return out;
}

/** Every term of one document, with repeats, for n in [minN, maxN]. */
export function documentTerms(text: string, opts: TermOptions): string[] {
  const lo = Math.max(1, Math.min(MAX_NGRAM, Math.floor(opts.minN)));
  const hi = Math.max(lo, Math.min(MAX_NGRAM, Math.floor(opts.maxN)));
  const out: string[] = [];
  for (const seg of contentSegments(text, opts.lang, opts.keepNumbers)) {
    for (let n = lo; n <= hi; n += 1) for (const g of ngrams(seg, n)) out.push(g);
  }
  return out;
}

/** Add one document's terms into a running count. */
export function addCounts(into: Map<string, number>, terms: readonly string[]): void {
  for (const t of terms) into.set(t, (into.get(t) || 0) + 1);
}

/** Tokens in a term — its n. */
export function termSize(term: string): number {
  let n = 1;
  for (let i = 0; i < term.length; i += 1) if (term.charCodeAt(i) === 32) n += 1;
  return n;
}

/** Stable order: count descending, then the term by code unit — no locale, so every machine agrees. */
export function byCount(a: [string, number], b: [string, number]): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** The `top` most frequent terms of a count map. */
export function topTerms(counts: Map<string, number>, top: number): Array<[string, number]> {
  return [...counts.entries()].sort(byCount).slice(0, Math.max(0, top));
}
