// VADER sentiment — MAIN PROCESS. A line-for-line port of vaderSentiment
// 3.3.2's SentimentIntensityAnalyzer.polarity_scores (MIT, C.J. Hutto), with the
// lexicon bundled as assets/text/vader-lexicon.json (mean valence only; see
// assets/text/NOTICE.txt). scripts/test-vader.ts holds it to the reference
// implementation's published examples.
//
// Everything the reference does is here, in the reference's order and with its
// quirks kept on purpose, because a "fixed" port is a different model whose
// scores no published figure describes:
//   · words are whitespace-split and stripped of leading/trailing ASCII
//     punctuation unless that leaves ≤ 2 characters (so ":)" survives);
//   · booster / dampener words (±0.293, faded 0.95 and 0.9 with distance),
//     ALL-CAPS emphasis (+0.733) when only SOME words are capitals;
//   · negation within three words (×−0.74), "n't", "never so/this" (×1.25),
//     "without doubt", "no" before a lexicon word, "least";
//   · the special-case idioms ("the shit", "bad ass", "kiss of death" …) and the
//     "kind of" / "sort of" dampeners;
//   · "but": everything before it ×0.5, after it ×1.5 — including the
//     reference's list.index() lookup, which rescales the FIRST equal value;
//   · "!" (up to 4, +0.292 each) and "??"+ amplification;
//   · compound = normalize(sum, alpha 15), then pos/neu/neg proportions,
//     rounded like Python's round() (4 and 3 places).
//
// ponytail: emoji are not translated to their descriptions (the reference
// swaps each emoji for words from a second, 3,500-line lexicon); an emoji
// scores as punctuation. Add emoji_utf8_lexicon.txt if review text is emoji-heavy.

import * as fs from 'fs';
import * as path from 'path';

const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;
const N_SCALAR = -0.74;

const NEGATE: ReadonlySet<string> = new Set([
  'aint', 'arent', 'cannot', 'cant', 'couldnt', 'darent', 'didnt', 'doesnt',
  "ain't", "aren't", "can't", "couldn't", "daren't", "didn't", "doesn't",
  'dont', 'hadnt', 'hasnt', 'havent', 'isnt', 'mightnt', 'mustnt', 'neither',
  "don't", "hadn't", "hasn't", "haven't", "isn't", "mightn't", "mustn't",
  'neednt', "needn't", 'never', 'none', 'nope', 'nor', 'not', 'nothing', 'nowhere',
  'oughtnt', 'shant', 'shouldnt', 'uhuh', 'wasnt', 'werent',
  "oughtn't", "shan't", "shouldn't", 'uh-uh', "wasn't", "weren't",
  'without', 'wont', 'wouldnt', "won't", "wouldn't", 'rarely', 'seldom', 'despite',
]);

const BOOSTER = new Map<string, number>([
  ...['absolutely', 'amazingly', 'awfully', 'completely', 'considerable', 'considerably', 'decidedly',
    'deeply', 'effing', 'enormous', 'enormously', 'entirely', 'especially', 'exceptional', 'exceptionally',
    'extreme', 'extremely', 'fabulously', 'flipping', 'flippin', 'frackin', 'fracking', 'fricking',
    'frickin', 'frigging', 'friggin', 'fully', 'fuckin', 'fucking', 'fuggin', 'fugging', 'greatly',
    'hella', 'highly', 'hugely', 'incredible', 'incredibly', 'intensely', 'major', 'majorly', 'more',
    'most', 'particularly', 'purely', 'quite', 'really', 'remarkably', 'so', 'substantially',
    'thoroughly', 'total', 'totally', 'tremendous', 'tremendously', 'uber', 'unbelievably', 'unusually',
    'utter', 'utterly', 'very'].map((w): [string, number] => [w, B_INCR]),
  ...['almost', 'barely', 'hardly', 'just enough', 'kind of', 'kinda', 'kindof', 'kind-of', 'less',
    'little', 'marginal', 'marginally', 'occasional', 'occasionally', 'partly', 'scarce', 'scarcely',
    'slight', 'slightly', 'somewhat', 'sort of', 'sorta', 'sortof', 'sort-of'].map((w): [string, number] => [w, B_DECR]),
]);

const SPECIAL_CASES = new Map<string, number>([
  ['the shit', 3], ['the bomb', 3], ['bad ass', 1.5], ['badass', 1.5], ['bus stop', 0.0],
  ['yeah right', -2], ['kiss of death', -1.5], ['to die for', 3],
  ['beating heart', 3.1], ['broken heart', -2.9],
]);

// Python's string.punctuation.
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

let lexicon: Map<string, number> | null = null;
let lexiconVersion = 'vaderSentiment 3.3.2';

/** The bundled lexicon, read once. A Map, never an object: "constructor" is a word too. */
function lex(): Map<string, number> {
  if (lexicon) return lexicon;
  const m = new Map<string, number>();
  try {
    const file = path.join(__dirname, '..', '..', '..', 'assets', 'text', 'vader-lexicon.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.version === 'string') lexiconVersion = raw.version;
    const words = raw && raw.words && typeof raw.words === 'object' ? raw.words : {};
    for (const k of Object.keys(words)) if (typeof words[k] === 'number') m.set(k, words[k]);
  } catch {
    /* a missing lexicon scores every text 0 — visible, never a crash */
  }
  lexicon = m;
  return m;
}

/** The lexicon version a text_sentiment step records. */
export function vaderVersion(): string {
  lex();
  return lexiconVersion;
}

export interface Polarity {
  neg: number;
  neu: number;
  pos: number;
  compound: number;
}

/** Python's str.isupper(): at least one cased character, and no lower-case one. */
function isUpper(w: string): boolean {
  return w !== w.toLowerCase() && w === w.toUpperCase();
}

function stripPunc(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && PUNCT.has(token[a])) a += 1;
  while (b > a && PUNCT.has(token[b - 1])) b -= 1;
  const stripped = token.slice(a, b);
  return stripped.length <= 2 ? token : stripped;
}

function negated(word: string): boolean {
  return NEGATE.has(word) || word.includes("n't");
}

/** Python round(x, nd): correctly rounded, ties to even. toFixed rounds exact ties away from zero. */
function pyRound(x: number, nd: number): number {
  const f = 10 ** nd;
  const t = x * f;
  const fl = Math.floor(t);
  if (t - fl === 0.5) return (fl % 2 === 0 ? fl : fl + 1) / f;
  return Number(x.toFixed(nd));
}

function scalarIncDec(word: string, valence: number, capDiff: boolean): number {
  const lower = word.toLowerCase();
  let scalar = 0.0;
  const b = BOOSTER.get(lower);
  if (b !== undefined) {
    scalar = b;
    if (valence < 0) scalar *= -1;
    if (isUpper(word) && capDiff) scalar += valence > 0 ? C_INCR : -C_INCR;
  }
  return scalar;
}

function negationCheck(valence: number, lw: readonly string[], startI: number, i: number): number {
  if (startI === 0) {
    if (negated(lw[i - 1])) valence *= N_SCALAR;
  } else if (startI === 1) {
    if (lw[i - 2] === 'never' && (lw[i - 1] === 'so' || lw[i - 1] === 'this')) valence *= 1.25;
    else if (lw[i - 2] === 'without' && lw[i - 1] === 'doubt') { /* unchanged */ } else if (negated(lw[i - 2])) valence *= N_SCALAR;
  } else if (startI === 2) {
    // Python precedence, kept: (never AND (so|this)) OR (so|this one back).
    if ((lw[i - 3] === 'never' && (lw[i - 2] === 'so' || lw[i - 2] === 'this')) || (lw[i - 1] === 'so' || lw[i - 1] === 'this')) {
      valence *= 1.25;
    } else if (lw[i - 3] === 'without' && (lw[i - 2] === 'doubt' || lw[i - 1] === 'doubt')) {
      /* unchanged */
    } else if (negated(lw[i - 3])) {
      valence *= N_SCALAR;
    }
  }
  return valence;
}

function specialIdioms(valence: number, lw: readonly string[], i: number): number {
  const onezero = `${lw[i - 1]} ${lw[i]}`;
  const twoonezero = `${lw[i - 2]} ${lw[i - 1]} ${lw[i]}`;
  const twoone = `${lw[i - 2]} ${lw[i - 1]}`;
  const threetwoone = `${lw[i - 3]} ${lw[i - 2]} ${lw[i - 1]}`;
  const threetwo = `${lw[i - 3]} ${lw[i - 2]}`;
  for (const seq of [onezero, twoonezero, twoone, threetwoone, threetwo]) {
    const v = SPECIAL_CASES.get(seq);
    if (v !== undefined) {
      valence = v;
      break;
    }
  }
  if (lw.length - 1 > i) {
    const v = SPECIAL_CASES.get(`${lw[i]} ${lw[i + 1]}`);
    if (v !== undefined) valence = v;
  }
  if (lw.length - 1 > i + 1) {
    const v = SPECIAL_CASES.get(`${lw[i]} ${lw[i + 1]} ${lw[i + 2]}`);
    if (v !== undefined) valence = v;
  }
  for (const g of [threetwoone, threetwo, twoone]) {
    const b = BOOSTER.get(g);
    if (b !== undefined) valence += b;
  }
  return valence;
}

function leastCheck(valence: number, lw: readonly string[], i: number, L: Map<string, number>): number {
  if (i > 1 && !L.has(lw[i - 1]) && lw[i - 1] === 'least') {
    if (lw[i - 2] !== 'at' && lw[i - 2] !== 'very') valence *= N_SCALAR;
  } else if (i > 0 && !L.has(lw[i - 1]) && lw[i - 1] === 'least') {
    valence *= N_SCALAR;
  }
  return valence;
}

function sentimentValence(words: readonly string[], lw: readonly string[], i: number, capDiff: boolean, L: Map<string, number>): number {
  const item = words[i];
  const lower = lw[i];
  const base = L.get(lower);
  if (base === undefined) return 0;
  let valence = base;
  if (lower === 'no' && i !== words.length - 1 && L.has(lw[i + 1])) valence = 0.0;
  if ((i > 0 && lw[i - 1] === 'no') || (i > 1 && lw[i - 2] === 'no')
    || (i > 2 && lw[i - 3] === 'no' && (lw[i - 1] === 'or' || lw[i - 1] === 'nor'))) {
    valence = base * N_SCALAR;
  }
  if (isUpper(item) && capDiff) valence += valence > 0 ? C_INCR : -C_INCR;
  for (let startI = 0; startI < 3; startI += 1) {
    if (i > startI && !L.has(lw[i - (startI + 1)])) {
      let s = scalarIncDec(words[i - (startI + 1)], valence, capDiff);
      if (startI === 1 && s !== 0) s *= 0.95;
      if (startI === 2 && s !== 0) s *= 0.9;
      valence += s;
      valence = negationCheck(valence, lw, startI, i);
      if (startI === 2) valence = specialIdioms(valence, lw, i);
    }
  }
  return leastCheck(valence, lw, i, L);
}

function butCheck(lw: readonly string[], sentiments: number[]): void {
  const bi = lw.indexOf('but');
  if (bi < 0) return;
  for (let k = 0; k < sentiments.length; k += 1) {
    const s = sentiments[k];
    const si = sentiments.indexOf(s); // the reference's list.index(): the FIRST equal value
    if (si < bi) sentiments[si] = s * 0.5;
    else if (si > bi) sentiments[si] = s * 1.5;
  }
}

function punctuationEmphasis(text: string): number {
  let ep = 0;
  let qm = 0;
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '!') ep += 1;
    else if (text[k] === '?') qm += 1;
  }
  const epAmp = Math.min(ep, 4) * 0.292;
  const qmAmp = qm > 1 ? (qm <= 3 ? qm * 0.18 : 0.96) : 0;
  return epAmp + qmAmp;
}

/** The reference's polarity_scores(text). */
export function polarityScores(input: string): Polarity {
  const L = lex();
  const text = String(input ?? '').trim();
  const words = text.split(/\s+/).filter((w) => w !== '').map(stripPunc);
  const lw = words.map((w) => w.toLowerCase());
  let caps = 0;
  for (const w of words) if (isUpper(w)) caps += 1;
  const capDiff = caps > 0 && caps < words.length;

  const sentiments: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (BOOSTER.has(lw[i]) || (i < words.length - 1 && lw[i] === 'kind' && lw[i + 1] === 'of')) {
      sentiments.push(0);
      continue;
    }
    sentiments.push(sentimentValence(words, lw, i, capDiff, L));
  }
  butCheck(lw, sentiments);

  if (!sentiments.length) return { neg: 0, neu: 0, pos: 0, compound: 0 };
  let sum = 0;
  for (const s of sentiments) sum += s;
  const amp = punctuationEmphasis(text);
  if (sum > 0) sum += amp;
  else if (sum < 0) sum -= amp;
  const compound = Math.max(-1, Math.min(1, sum / Math.sqrt(sum * sum + 15)));

  let posSum = 0;
  let negSum = 0;
  let neuCount = 0;
  for (const s of sentiments) {
    if (s > 0) posSum += s + 1;
    if (s < 0) negSum += s - 1;
    if (s === 0) neuCount += 1;
  }
  if (posSum > Math.abs(negSum)) posSum += amp;
  else if (posSum < Math.abs(negSum)) negSum -= amp;
  const total = posSum + Math.abs(negSum) + neuCount;
  return {
    neg: pyRound(Math.abs(negSum / total), 3),
    neu: pyRound(Math.abs(neuCount / total), 3),
    pos: pyRound(Math.abs(posSum / total), 3),
    compound: pyRound(compound, 4),
  };
}

/** The compound score alone — the number a text_sentiment column holds. */
export function compoundScore(text: string): number {
  return polarityScores(text).compound;
}
