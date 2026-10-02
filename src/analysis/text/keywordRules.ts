// Keyword rules — an ordered list of pattern → category, MAIN PROCESS, PURE.
// For tagging tickets or reviews: "refund|chargeback" → Billing, "late" → Delivery.
//
// PRECEDENCE IS ORDER: the FIRST rule that matches decides the category, and no
// later rule is consulted. A text that matches none gets the default category.
//
// Three ways to match, each case-insensitive unless the rule says otherwise:
//   contains  the pattern appears anywhere ("refund" matches "refunded")
//   word      the pattern appears as whole words ("late" matches "arrived late."
//             but not "chocolate"); a multi-word pattern must appear as that phrase
//   regex     a pattern from the JS/RE2 common subset (src/data/regexSubset.ts) —
//             the same gate every other regex in the app passes through
// Text is compared NFC-normalised with straight apostrophes, so "don’t" and
// "don't" are one pattern.

import { checkRegex } from '../../data/regexSubset';
import { normalizeText } from './tokenize';

export type RuleMatch = 'contains' | 'word' | 'regex';
export const RULE_MATCHES: readonly RuleMatch[] = ['contains', 'word', 'regex'];

export interface KeywordRule {
  pattern: string;
  category: string;
  match: RuleMatch;
  caseSensitive?: boolean;
}

export type RuleTest = (text: string) => boolean;

const APOS = /[’‘ʼ′`´]/g;

/** Case-preserving normalisation for case-sensitive rules. */
function fold(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text.normalize('NFC').replace(APOS, "'") : normalizeText(text);
}

function escapeRe(s: string): string {
  // The u-flag identity escapes: syntax characters and '/', nothing else ('\-' is an error there).
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** One rule's test, or the reason it cannot run. */
export function compileRule(rule: KeywordRule): RuleTest | string {
  const cs = !!rule.caseSensitive;
  if (typeof rule.pattern !== 'string' || rule.pattern.trim() === '') return 'a rule has no pattern';
  if (rule.match === 'regex') {
    const chk = checkRegex(rule.pattern);
    if (!chk.ok) return `the pattern "${rule.pattern}": ${chk.error}`;
    const re = new RegExp(chk.js, cs ? 'u' : 'iu'); // not global: .test() must not carry lastIndex between rows
    return (text) => re.test(text.normalize('NFC').replace(APOS, "'"));
  }
  const needle = fold(rule.pattern.trim(), cs);
  if (rule.match === 'word') {
    // Whole words: no letter, digit or mark on either side. The pattern is
    // escaped, so this lookaround is ours, never a user's.
    const words = needle.split(/\s+/).map(escapeRe).join('\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${words}(?![\\p{L}\\p{N}\\p{M}])`, 'u');
    return (text) => re.test(fold(text, cs));
  }
  return (text) => fold(text, cs).includes(needle);
}

export interface CompiledRules {
  tests: Array<{ test: RuleTest; category: string }>;
  problems: string[];
}

/** Compile in order; a broken rule is left out and named in `problems`. */
export function compileRules(rules: readonly KeywordRule[]): CompiledRules {
  const tests: CompiledRules['tests'] = [];
  const problems: string[] = [];
  for (const r of rules) {
    const t = compileRule(r);
    if (typeof t === 'string') problems.push(t);
    else tests.push({ test: t, category: r.category });
  }
  return { tests, problems };
}

/** The first matching rule's category, or `otherwise`. */
export function categorize(text: string, compiled: CompiledRules, otherwise: string | null): string | null {
  for (const { test, category } of compiled.tests) if (test(text)) return category;
  return otherwise;
}
