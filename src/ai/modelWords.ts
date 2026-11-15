// The words the Assistant's search of the Data model compares (src/app/assistantSearchRank.ts) — pure. ONE function
// for what is stored (a name, an "also called" name, a description) and for what is asked, so the index and the
// reference agree, and an exact name always finds itself: whatever the rules below do to a word, they do it on both
// sides.
//
//   split   ./answerSuggest `words`: runs of letters, marks and digits, squashed, at least 3 long.
//   stop    a short list of English question words ("what", "the", "show") is dropped: they would find every
//           description, and the GIN prefilter would read most of the index.
//   fold    a light plural rule, English only and deterministic: "categories" → "category", "addresses" →
//           "address", "boxes" → "box", "branches" → "branch", "sales" → "sale"; a word ending in ss, us or is
//           ("gross", "status", "analysis") and one under 4 letters is kept. It only ever MERGES two words ("news" and
//           "new"), so it can widen what a question finds, never hide a name from itself.
//   cap     64 code points a word, as ⌘K's (src/app/searchMatch.ts): a GIN entry has a size limit.

import { words } from './answerSuggest';

const STOP: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'what', 'which', 'who', 'how', 'many', 'much', 'show', 'give', 'tell', 'list', 'are', 'was', 'were',
  'has', 'have', 'had', 'our', 'all', 'each', 'per', 'from', 'into', 'than', 'then', 'that', 'this', 'these', 'those', 'there',
  'their', 'them', 'they', 'you', 'your', 'its', 'not', 'but', 'can', 'could', 'would', 'should', 'will', 'did', 'does', 'any',
  'some', 'get', 'please', 'about', 'also', 'been', 'more', 'most', 'other', 'only', 'very', 'just',
]);
const MAX_WORD = 64;

export function fold(w: string): string {
  if (w.length < 4 || !w.endsWith('s')) return w;
  if (w.endsWith('ies') && w.length >= 5) return w.slice(0, -3) + 'y';
  if (/(?:sses|xes|ches|shes|zzes)$/.test(w)) return w.slice(0, -2);
  return /(?:ss|us|is)$/.test(w) ? w : w.slice(0, -1);
}

/** The words of `text` as the search stores and compares them: deduplicated, first seen first. */
export function searchWords(text: string): string[] {
  return [...new Set(words(text).filter((w) => !STOP.has(w)).map((w) => Array.from(fold(w)).slice(0, MAX_WORD).join('')))];
}

/** The words of several texts, deduplicated across them. */
export const searchWordsOf = (texts: readonly string[]): string[] => [...new Set(texts.flatMap(searchWords))];
