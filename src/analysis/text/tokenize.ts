// Tokenisation — MAIN PROCESS, PURE. The one definition of "a word" that the
// text steps, the column profile and the keyword rules all share.
//
// THE RULES, in the order they run:
//   1. NFC-normalise and lower-case (String.prototype.toLowerCase — locale-free,
//      so the same text tokenises the same on every machine). A decomposed "é"
//      and a precomposed one are one term.
//   2. Curly and look-alike apostrophes (’ ‘ ʼ ′ ` ´) become ' — "don’t" and
//      "don't" are one term.
//   3. The text is cut into SEGMENTS at sentence punctuation (. ! ? ; : … and line
//      breaks). An n-gram never spans two segments: "great food. service slow"
//      has no "food service".
//   4. A token is a maximal run of letters, digits and combining marks
//      (\p{L}\p{N}\p{M}, the `u` flag), optionally joined by INTERNAL
//      apostrophes. So a contraction is ONE token ("don't", "i'm", "geht's"), and
//      everything else — punctuation, symbols, emoji, hyphens, underscores —
//      separates tokens ("state-of-the-art" is four).
//   5. A token of digits only is a number: dropped unless `keepNumbers`. Mixed
//      tokens ("mp3", "2nd") are words and always kept.
//   6. French elisions are SPLIT: "l'homme" → "l" + "homme", "qu'il" → "qu" + "il".
//      In French the elided article is not part of the word, and the Snowball
//      French list carries the bare forms (l, d, qu…) as stop words, so this is
//      what makes "homme" count as "homme". English contractions stay whole
//      because they carry meaning ("don't" is a negation, and the English list
//      names "don't" itself).
//
// ponytail: no word segmentation for scripts written without spaces (Chinese,
// Japanese, Thai) — a run of such letters is one token; add a segmenter if a
// dataset in one of them shows up. Possessives stay whole ("customer's").

export type TextLang = 'en' | 'es' | 'fr' | 'de';
export const TEXT_LANGS: readonly TextLang[] = ['en', 'es', 'fr', 'de'];
export const TEXT_LANG_NAMES: Readonly<Record<TextLang, string>> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
};

export interface TokenizeOptions {
  lang?: TextLang;
  keepNumbers?: boolean;
}

const APOSTROPHES = /[’‘ʼ′`´]/g;
const SEGMENT_BREAK = /[.!?;:…。！？\n\r]+/;
const WORD = /[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*/gu;
const DIGITS = /^\p{N}+$/u;
const FR_ELISION = /^(c|d|j|l|m|n|s|t|qu|jusqu|lorsqu|puisqu)'(.+)$/;

export function isTextLang(v: unknown): v is TextLang {
  return typeof v === 'string' && (TEXT_LANGS as readonly string[]).includes(v);
}

/** The normalised form every comparison uses: NFC, lower case, straight apostrophes. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().normalize('NFC').replace(APOSTROPHES, "'");
}

/** Tokens per sentence segment — the unit n-grams are built within. */
export function tokenizeSegments(text: string, opts: TokenizeOptions = {}): string[][] {
  if (typeof text !== 'string' || text === '') return [];
  const out: string[][] = [];
  for (const seg of normalizeText(text).split(SEGMENT_BREAK)) {
    const toks: string[] = [];
    for (const m of seg.matchAll(WORD)) {
      const tok = m[0];
      if (!opts.keepNumbers && DIGITS.test(tok)) continue;
      const el = opts.lang === 'fr' ? FR_ELISION.exec(tok) : null;
      if (el) toks.push(el[1], el[2]);
      else toks.push(tok);
    }
    if (toks.length) out.push(toks);
  }
  return out;
}

/** Every token of `text`, in order (segments flattened). */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  return tokenizeSegments(text, opts).flat();
}

/** Length in characters (code points), as a user counts them — an emoji is one. */
export function charLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n += 1; // a low surrogate is the second half of one character
  }
  return n;
}
