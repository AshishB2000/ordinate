// Stop words per language, and a language guess from them — MAIN PROCESS.
//
// The lists are the Snowball project's (assets/text/stopwords-<lang>.json,
// provenance and licence in assets/text/NOTICE.txt), read once on first use.
// They are stored normalised the way tokenize.ts normalises text (NFC, lower
// case, straight apostrophes), so a lookup is a plain Set membership.
//
// The language guess is the stop-word HIT RATE: the share of a sample's tokens
// that are stop words of each language, highest wins. Stop words are the most
// frequent words of a language and nearly disjoint across these four, so even
// a few short reviews separate cleanly. Ties go to the earlier language in
// TEXT_LANGS (English first), which is also the answer for text with no hits.

import * as fs from 'fs';
import * as path from 'path';
import type { TextLang } from './tokenize';
import { TEXT_LANGS, normalizeText, tokenize } from './tokenize';

const ASSET_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'text');
const cache = new Map<TextLang, ReadonlySet<string>>();

/** The stop words of `lang`. An unreadable list is an empty set — counting still works. */
export function stopwords(lang: TextLang): ReadonlySet<string> {
  const hit = cache.get(lang);
  if (hit) return hit;
  let words: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, `stopwords-${lang}.json`), 'utf8'));
    if (raw && Array.isArray(raw.words)) words = raw.words.filter((w: unknown) => typeof w === 'string');
  } catch {
    /* a missing asset degrades to "no stop words", never to a crash */
  }
  const set: ReadonlySet<string> = new Set(words.map(normalizeText));
  cache.set(lang, set);
  return set;
}

export interface LangGuess {
  lang: TextLang;
  /** Share of tokens that are stop words of each language, 0–1. */
  rates: Record<TextLang, number>;
  tokens: number;
}

export function detectLanguage(texts: readonly string[]): LangGuess {
  const hits: Record<TextLang, number> = { en: 0, es: 0, fr: 0, de: 0 };
  let tokens = 0;
  const sets = TEXT_LANGS.map((l) => [l, stopwords(l)] as const);
  for (const t of texts) {
    for (const tok of tokenize(t)) {
      tokens += 1;
      for (const [l, set] of sets) if (set.has(tok)) hits[l] += 1;
    }
  }
  const rates = { en: 0, es: 0, fr: 0, de: 0 } as Record<TextLang, number>;
  let lang: TextLang = TEXT_LANGS[0];
  for (const l of TEXT_LANGS) {
    rates[l] = tokens ? hits[l] / tokens : 0;
    if (hits[l] > hits[lang]) lang = l;
  }
  return { lang, rates, tokens };
}
