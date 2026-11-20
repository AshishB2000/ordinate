// Which passages answer a question (docs/knowledge-docs/00-design.md, "Passages and matching"). PURE, in the style of
// src/app/assistantSearchRank.ts: Postgres only NARROWS to the passages that share a word with the question
// (`words && $1`, src/knowledge/store.ts), and this function ranks them; because a passage sharing no word scores 0,
// that equals ranking every passage (scripts/test-knowledgeRank.ts holds the two equal).
//
// Score: 2 for each question word in the document's title, 2 for each in the heading path, 1 for each in the text,
// words deduplicated per field. A score of 0 is never shown. The CUT-OFF keeps noise out: only a passage scoring at
// least half the top one's (rounded up) stays, because prose shares common words with almost any question. Ties go to
// the agent's own document, then the newer document, then doc id, then ord, every string compared by code unit.

import { searchWords, searchWordsOf } from '../ai/modelWords';
import { MAX_ASK_CHARS, MAX_ASK_PASSAGES } from './limits';

export const W_TITLE = 2;
export const W_HEADING = 2;
export const W_TEXT = 1;

/** A stored passage as ranking reads it. */
export interface RankPassage {
  docId: string;
  ord: number;
  /** The agent's own document, as against the project's. */
  own: boolean;
  /** The document's last edit, ISO 8601. */
  updatedAt: string;
  title: string;
  heading: string;
  text: string;
  titleWords: readonly string[];
  headingWords: readonly string[];
  textWords: readonly string[];
}

export interface Ranked extends RankPassage { score: number }

/** What a passage is stored with: its three word lists, and `words`, their union (a passage found by its title alone is a candidate). */
export function passageWords(title: string, heading: string, text: string): { titleWords: string[]; headingWords: string[]; textWords: string[]; words: string[] } {
  const titleWords = searchWords(title);
  const headingWords = searchWords(heading);
  const textWords = searchWords(text);
  return { titleWords, headingWords, textWords, words: searchWordsOf([title, heading, text]) };
}

/** The question's words as BOTH sides score and narrow with them: deduplicated, at most 64 (Postgres gets the same list). */
export const MAX_QUESTION_WORDS = 64;
export const questionWords = (question: string): string[] => searchWords(question).slice(0, MAX_QUESTION_WORDS);

const has = (list: readonly string[], w: string): boolean => list.includes(w);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function scorePassage(question: readonly string[], p: RankPassage): number {
  let s = 0;
  for (const w of new Set(question)) s += (has(p.titleWords, w) ? W_TITLE : 0) + (has(p.headingWords, w) ? W_HEADING : 0) + (has(p.textWords, w) ? W_TEXT : 0);
  return s;
}

/** The passages to show for `question`, best first, after the cut-off and the 6 / 4,000-character budget. */
export function rankPassages(question: string, all: readonly RankPassage[], limit = MAX_ASK_PASSAGES, maxChars = MAX_ASK_CHARS): Ranked[] {
  const q = questionWords(question);
  const scored: Ranked[] = [];
  for (const p of all) {
    const score = scorePassage(q, p);
    if (score > 0) scored.push({ ...p, score });
  }
  if (!scored.length) return [];
  const top = scored.reduce((m, p) => Math.max(m, p.score), 0);
  const floor = Math.ceil(top / 2);
  const kept = scored
    .filter((p) => p.score >= floor)
    .sort((a, b) => b.score - a.score || Number(b.own) - Number(a.own) || cmp(b.updatedAt, a.updatedAt) || cmp(a.docId, b.docId) || a.ord - b.ord);
  const out: Ranked[] = [];
  let chars = 0;
  for (const p of kept) {
    if (out.length >= limit || chars + p.text.length > maxChars) break;
    out.push(p);
    chars += p.text.length;
  }
  return out;
}
