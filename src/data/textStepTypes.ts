// The three TEXT prepare steps — their shapes and their whitelist. MAIN
// PROCESS, PURE (no transforms import, so transforms.ts can spread
// TEXT_STEP_TYPES into its own set at load time without a cycle).
//
//   text_terms      reshape: the table becomes its top terms (1–3-grams, stop
//                   words removed) — by frequency, or by TF-IDF across the
//                   groups of a chosen dimension ("terms most distinctive of West")
//   text_sentiment  adds a number column: VADER's compound score, −1 … 1,
//                   with the lexicon version recorded on the step
//   keyword_rules   adds a text column: the category of the FIRST matching rule
//
// The same gate for renderer input, stored records and the Assistant's
// suggestions: a step is rebuilt from known fields only, and anything malformed
// is REFUSED with a reason (a regex outside the common subset, an unknown
// language) rather than repaired. Column EXISTENCE is the fold's business.

import type { TextLang } from '../analysis/text/tokenize';
import { isTextLang } from '../analysis/text/tokenize';
import type { KeywordRule, RuleMatch } from '../analysis/text/keywordRules';
import { RULE_MATCHES, compileRule } from '../analysis/text/keywordRules';
import { vaderVersion } from '../analysis/text/vader';

export const TEXT_STEP_TYPES: ReadonlySet<string> = new Set(['text_terms', 'text_sentiment', 'keyword_rules']);

export interface TextTermsStep {
  type: 'text_terms';
  column: string;
  lang: TextLang;
  /** n-gram sizes counted, 1 ≤ minN ≤ maxN ≤ 3. */
  minN: number;
  maxN: number;
  /** Terms kept — overall, or per group when `by` is set. */
  top: number;
  /** 'tfidf' needs `by`; without one the sanitizer makes it 'count'. */
  rank: 'count' | 'tfidf';
  /** The dimension whose values are TF-IDF's documents. */
  by?: string;
  keepNumbers?: boolean;
  /** Add each term's mean sentiment (VADER compound of the rows it occurs in). */
  sentiment?: boolean;
}

export interface TextSentimentStep {
  type: 'text_sentiment';
  column: string;
  /** The new column — default `<column>_sentiment`. */
  as?: string;
  /** The lexicon the scores came from, e.g. "vaderSentiment 3.3.2". */
  lexiconVersion: string;
}

export interface KeywordRulesStep {
  type: 'keyword_rules';
  column: string;
  /** The new column — default `<column>_category`. */
  as?: string;
  rules: KeywordRule[];
  /** The category when no rule matches (null leaves the cell empty). */
  otherwise?: string | null;
}

export type TextStep = TextTermsStep | TextSentimentStep | KeywordRulesStep;

// ponytail: fixed caps; each is a number a user can see in a warning.
export const MAX_TERMS_TOP = 1000;
export const MAX_KEYWORD_RULES = 100;
const MAX_NAME = 500;

/** The output column names of text_terms, in order — the editor and the fold agree on these. */
export const TERMS_COLUMNS = { term: 'term', ngram: 'words', count: 'count', tfidf: 'tfidf', sentiment: 'sentiment' } as const;

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= MAX_NAME ? v : undefined;
}
function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = v === undefined || v === null || v === '' ? dflt : Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export function sentimentColumnName(s: TextSentimentStep): string {
  return (s.as && s.as.trim()) || `${s.column}_sentiment`;
}
export function categoryColumnName(s: KeywordRulesStep): string {
  return (s.as && s.as.trim()) || `${s.column}_category`;
}

/** A clean step, or the reason the raw one was refused. */
export function checkTextStep(o: Raw): TextStep | string {
  const type = String(o.type);
  const column = str(o.column);
  if (!column) return 'text step: no column';
  switch (type) {
    case 'text_terms': {
      const lang = isTextLang(o.lang) ? o.lang : o.lang === undefined ? 'en' : null;
      if (!lang) return `count terms: unknown language "${String(o.lang)}"`;
      const minN = intIn(o.minN, 1, 3, 1);
      const maxN = Math.max(minN, intIn(o.maxN, 1, 3, minN));
      const step: TextTermsStep = {
        type, column, lang, minN, maxN, top: intIn(o.top, 1, MAX_TERMS_TOP, 50), rank: 'count',
      };
      const by = str(o.by);
      if (by && by !== column) step.by = by;
      if (o.rank === 'tfidf' && step.by) step.rank = 'tfidf';
      if (o.keepNumbers === true) step.keepNumbers = true;
      if (o.sentiment === true) step.sentiment = true;
      return step;
    }
    case 'text_sentiment': {
      const step: TextSentimentStep = {
        type, column,
        // Recorded once, when the step is made; a stored step keeps the version it was scored with.
        lexiconVersion: typeof o.lexiconVersion === 'string' && o.lexiconVersion.length <= 100 ? o.lexiconVersion : vaderVersion(),
      };
      const as = str(o.as);
      if (as && as.trim()) step.as = as.trim();
      return step;
    }
    case 'keyword_rules': {
      const rules: KeywordRule[] = [];
      for (const r of Array.isArray(o.rules) ? o.rules.slice(0, MAX_KEYWORD_RULES) : []) {
        const rr = (r || {}) as Raw;
        const pattern = str(rr.pattern);
        const category = str(rr.category);
        if (!pattern || !pattern.trim()) continue; // a blank row in the editor is not a rule
        if (category === undefined) return 'tag with rules: a rule has no category';
        const match: RuleMatch = (RULE_MATCHES as readonly unknown[]).includes(rr.match) ? rr.match as RuleMatch : 'contains';
        const rule: KeywordRule = { pattern, category, match };
        if (rr.caseSensitive === true) rule.caseSensitive = true;
        const chk = compileRule(rule);
        if (typeof chk === 'string') return `tag with rules: ${chk}`;
        rules.push(rule);
      }
      if (!rules.length) return 'tag with rules: no rules';
      const step: KeywordRulesStep = { type, column, rules };
      const as = str(o.as);
      if (as && as.trim()) step.as = as.trim();
      if (o.otherwise === null) step.otherwise = null;
      else if (typeof o.otherwise === 'string' && o.otherwise.length <= MAX_NAME) step.otherwise = o.otherwise;
      return step;
    }
    default:
      return `unknown step type "${type}"`;
  }
}

export function sanitizeTextStep(o: Raw): TextStep | null {
  const r = checkTextStep(o);
  return typeof r === 'string' ? null : r;
}
