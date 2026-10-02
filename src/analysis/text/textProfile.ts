// A text column's profile — MAIN PROCESS, PURE. What the column-profile panel's
// "Text" section shows: lengths, the language, top terms and bigrams, and the
// sentiment spread. Every figure is computed here, over a SAMPLE: the first
// TEXT_SAMPLE_CAP filled values in stored row order (deterministic, and stated
// in the panel), read by engine/textSampleResident.ts off the Parquet or by
// textSampleOf below from hydrated rows — scripts/test-textProfile.ts holds the
// two samples to Object.is, value by value.

import type { Cell } from '../../data/transforms';
import type { ParsedColumn } from '../../data/parse';
import type { TextLang } from './tokenize';
import { charLength } from './tokenize';
import { detectLanguage } from './stopwords';
import { addCounts, documentTerms, topTerms } from './ngrams';
import { compoundScore } from './vader';

/** How many filled values a profile reads — the first N by stored row order. */
export const TEXT_SAMPLE_CAP = 5000;
/** The "Text" section appears for a text column whose average length reaches this. */
export const TEXT_MIN_AVG_LENGTH = 20;

export interface SentimentBand {
  label: string;
  count: number;
}
export interface TextProfile {
  sampled: number;
  cap: number;
  avgLength: number;
  medianLength: number;
  eligible: boolean;
  lang: TextLang;
  detected: TextLang;
  topTerms: Array<{ term: string; count: number }>;
  topBigrams: Array<{ term: string; count: number }>;
  sentiment: { mean: number; bands: SentimentBand[] } | null;
}

// VADER's own convention: |compound| < 0.05 is neutral; ±0.5 splits strong from mild.
const BANDS: Array<{ label: string; test: (c: number) => boolean }> = [
  { label: 'Very negative', test: (c) => c <= -0.5 },
  { label: 'Negative', test: (c) => c > -0.5 && c <= -0.05 },
  { label: 'Neutral', test: (c) => c > -0.05 && c < 0.05 },
  { label: 'Positive', test: (c) => c >= 0.05 && c < 0.5 },
  { label: 'Very positive', test: (c) => c >= 0.5 },
];

/** The JS reference sample: the first `limit` filled cells of a TEXT column, as strings. */
export function textSampleOf(columns: ParsedColumn[], rows: Cell[][], column: string, limit: number): string[] | null {
  const ci = columns.findIndex((c) => c && c.name === column);
  if (ci < 0 || columns[ci].type !== 'text') return null;
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const v = r ? r[ci] : null;
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.trim() === '') continue; // transforms.isEmptyCell: whitespace is empty
    out.push(s);
  }
  return out;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** The profile of a sample. `lang` overrides the detected language for the term counts. */
export function profileText(values: readonly string[], lang?: TextLang): TextProfile {
  const lengths = values.map(charLength).sort((a, b) => a - b);
  let total = 0;
  for (const n of lengths) total += n;
  const avgLength = values.length ? total / values.length : 0;
  const detected = detectLanguage(values).lang;
  const use = lang || detected;
  const base = {
    sampled: values.length, cap: TEXT_SAMPLE_CAP, avgLength, medianLength: median(lengths),
    eligible: values.length > 0 && avgLength >= TEXT_MIN_AVG_LENGTH, lang: use, detected,
  };
  if (!base.eligible) return { ...base, topTerms: [], topBigrams: [], sentiment: null };

  const uni = new Map<string, number>();
  const bi = new Map<string, number>();
  const counts = BANDS.map(() => 0);
  let sum = 0;
  for (const v of values) {
    addCounts(uni, documentTerms(v, { lang: use, minN: 1, maxN: 1 }));
    addCounts(bi, documentTerms(v, { lang: use, minN: 2, maxN: 2 }));
    const c = compoundScore(v);
    sum += c;
    const k = BANDS.findIndex((b) => b.test(c));
    if (k >= 0) counts[k] += 1;
  }
  return {
    ...base,
    topTerms: topTerms(uni, 12).map(([term, count]) => ({ term, count })),
    topBigrams: topTerms(bi, 8).map(([term, count]) => ({ term, count })),
    sentiment: { mean: sum / values.length, bands: BANDS.map((b, k) => ({ label: b.label, count: counts[k] })) },
  };
}
