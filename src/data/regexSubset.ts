// The regex subset JS and DuckDB's RE2 agree on — MAIN PROCESS, PURE.
//
// A split or replace step runs twice: in the JS fold (the reference) and in
// DuckDB (sqlGen). JS RegExp and RE2 differ in syntax AND in meaning, so a
// pattern is accepted only from a common subset, and is REWRITTEN into each
// dialect from one scan, never passed through raw:
//
//   · rejected: lookaround, backreferences, named groups, inline flags, word
//     boundaries (\b is also "backspace" inside [ ]), \u/\x/\c/\p escapes, a
//     `[` or empty `[]` inside a class (RE2 reads POSIX classes / JS an empty
//     set), a stray `{`/`}`/`]`, repeat counts over 1000 (RE2's limit), and any
//     pattern that can match EMPTY text (the two engines split/replace empty
//     matches differently — and an empty separator is never what a user meant).
//   · rewritten: capture groups → non-capturing (no step reads a group, and JS
//     split would splice captures into the parts); `.` → an explicit class of
//     JS's non-newline set; `\s`/`\S` → JS's exact whitespace set, spelled out
//     for RE2 (whose \s is only [\t\n\f\r ]).
//   · JS runs with the `u` flag, so classes and `.` step by CODE POINT, as RE2
//     does over UTF-8. The only flag a user may set is ignore-case.
//
// A pattern RE2 still refuses after all this fails the SQL query, and every
// SQL caller falls back to the fold — so the subset only has to rule out
// patterns BOTH engines accept with different meanings.

export type RegexCheck = { ok: true; js: string; re2: string } | { ok: false; error: string };

const JS_WS_CLASS = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const RE2_WS_CLASS =
  '\\t\\n\\v\\f\\r \\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}';
const JS_DOT = '[^\\n\\r\\u2028\\u2029]';
const RE2_DOT = '[^\\n\\r\\x{2028}\\x{2029}]';
// Characters that must stay escaped to mean themselves (the u-flag identity set).
const SYNTAX = '^$\\.*+?()[]{}|/';
const MAX_REPEAT = 1000;
export const MAX_PATTERN_LENGTH = 500;

function bad(error: string): RegexCheck {
  return { ok: false, error };
}

/** Validate `pattern` against the common subset and translate it to both dialects. */
export function checkRegex(pattern: unknown): RegexCheck {
  if (typeof pattern !== 'string' || pattern === '') return bad('the pattern is empty');
  if (pattern.length > MAX_PATTERN_LENGTH) return bad(`the pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  let js = '';
  let re2 = '';
  let depth = 0;
  let inClass = false;
  const n = pattern.length;
  for (let i = 0; i < n; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      const e = pattern[i + 1];
      if (e === undefined) return bad('the pattern ends with a lone backslash');
      i += 1;
      if ('dDwW'.includes(e)) {
        js += '\\' + e;
        re2 += '\\' + e;
      } else if ('tnrfv'.includes(e)) {
        js += '\\' + e;
        re2 += '\\' + e;
      } else if (e === 's') {
        js += inClass ? JS_WS_CLASS : '[' + JS_WS_CLASS + ']';
        re2 += inClass ? RE2_WS_CLASS : '[' + RE2_WS_CLASS + ']';
      } else if (e === 'S') {
        if (inClass) return bad('\\S is not supported inside [ ]');
        js += '[^' + JS_WS_CLASS + ']';
        re2 += '[^' + RE2_WS_CLASS + ']';
      } else if (e === 'b' || e === 'B') {
        return bad('word boundaries (\\b, \\B) are not supported');
      } else if (SYNTAX.includes(e) || (inClass && e === '-')) {
        js += '\\' + e;
        re2 += '\\' + e;
      } else if (e === '-') {
        js += '-';
        re2 += '-';
      } else if (/[0-9]/.test(e)) {
        return bad('backreferences are not supported');
      } else {
        return bad(`the escape \\${e} is not supported`);
      }
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
        js += c;
        re2 += c;
      } else if (c === '[') {
        return bad('escape a literal [ inside [ ] as \\[');
      } else {
        js += c;
        re2 += c;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      js += c;
      re2 += c;
      if (pattern[i + 1] === '^') {
        js += '^';
        re2 += '^';
        i += 1;
      }
      if (pattern[i + 1] === ']') return bad('escape a literal ] as \\]');
      continue;
    }
    if (c === '.') {
      js += JS_DOT;
      re2 += RE2_DOT;
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] !== ':') return bad('lookaround, named groups and inline flags are not supported');
        i += 2;
      }
      depth += 1;
      js += '(?:';
      re2 += '(?:';
      continue;
    }
    if (c === ')') {
      depth -= 1;
      if (depth < 0) return bad('the pattern has an unmatched )');
      js += c;
      re2 += c;
      continue;
    }
    if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return bad('escape a literal { as \\{');
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[2] === '' ? lo : Number(m[2]);
      if (lo > MAX_REPEAT || hi > MAX_REPEAT) return bad(`repeat counts above ${MAX_REPEAT} are not supported`);
      if (m[2] !== undefined && m[2] !== '' && hi < lo) return bad('a repeat range must run low to high');
      js += m[0];
      re2 += m[0];
      i += m[0].length - 1;
      continue;
    }
    if (c === '}' || c === ']') return bad(`escape a literal ${c} as \\${c}`);
    js += c;
    re2 += c;
  }
  if (inClass) return bad('the pattern has an unclosed [');
  if (depth !== 0) return bad('the pattern has an unclosed (');
  try {
    if (new RegExp('^(?:' + js + ')$', 'u').test('')) return bad('the pattern can match empty text');
  } catch (e) {
    return bad(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'invalid pattern');
  }
  return { ok: true, js, re2 };
}

/** The JS RegExp for a checked pattern (global — split and replace both scan all). */
export function jsRegex(js: string, ignoreCase: boolean): RegExp {
  return new RegExp(js, ignoreCase ? 'giu' : 'gu');
}

// The two per-text functions a replace / split step runs. The fold and the
// regex worker (src/engine/regexWorker.ts) both build them HERE, so the worker's
// answer is the fold's answer by construction. Both expect checked patterns.

/** A regex replace step's rules, applied in order. A replacer FUNCTION keeps `$&` / `$1` literal. */
export function regexReplacer(rules: ReadonlyArray<{ from: string; to: string }>, ignoreCase: boolean): (text: string) => string {
  const res = rules.map((r) => {
    const chk = checkRegex(r.from);
    return chk.ok ? jsRegex(chk.js, ignoreCase) : null;
  });
  return (text) => rules.reduce((acc, r, k) => acc.replace(res[k] as RegExp, () => r.to), text);
}

/** A regex split step's parts. */
export function regexSplitter(pattern: string, ignoreCase: boolean): (text: string) => string[] {
  const chk = checkRegex(pattern);
  const re = chk.ok ? jsRegex(chk.js, ignoreCase) : null;
  return (text) => text.split(re as RegExp);
}

/** The RE2 source for a checked pattern, with ignore-case as RE2's inline flag. */
export function re2Source(re2: string, ignoreCase: boolean): string {
  return ignoreCase ? '(?i)' + re2 : re2;
}
