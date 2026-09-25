// The regex subset a data-quality `regex` rule may use — MAIN PROCESS, PURE.
//
// A pattern rule is evaluated by TWO engines: JavaScript's RegExp (the JS
// reference, and the fallback) and DuckDB's RE2 (the resident path). They are
// different regex dialects that happen to share most of their syntax, and the
// part they do not share is exactly where a rule would silently report two
// different failing counts for the same data. So instead of hoping, a pattern
// is VALIDATED against a conservative subset both engines read identically, and
// anything outside it is refused with a sentence saying why.
//
// ── The subset ───────────────────────────────────────────────────────────────
//   literals (any character except the syntax ones below), `.`,
//   `[...]` / `[^...]` with plain ranges, `\d \D \w \W` (ASCII in both), the
//   escapes `\t \n \r` and `\` + a syntax character, groups `( )` and `(?: )`,
//   `|`, `^` `$`, and the quantifiers `* + ? {n} {n,} {n,m}` (m ≤ 1000, RE2's
//   ceiling) with an optional lazy `?`.
//
// ── How the two engines are made to agree on what IS allowed ──────────────────
//   JS:  new RegExp('^(?:' + p + ')$', 'su')   — full match, code points, dotAll
//   RE2: regexp_full_match(v, '(?s)' + p)      — full match, UTF-8, dotAll
// Without dotAll `.` differs: JS excludes \r, U+2028 and U+2029 as well as \n;
// RE2 excludes only \n. With it, `.` is "any code point" on both sides.
//
// ── What is refused, and the divergence behind each (pinned by
//    scripts/test-qualityRules.ts, which runs both engines) ────────────────────
//   \s \S       JS \s includes NBSP, U+FEFF and the Unicode spaces; RE2's is
//               [\t\n\f\r ]. `\s` on an NBSP is true in JS, false in RE2.
//   \b \B       word boundaries — kept out rather than proven equal.
//   \1 \k<n>    back-references: RE2 has none ("invalid escape sequence").
//   (?= (?! (?<= (?<! (?<n> (?i)
//               lookarounds, named groups, inline flags: RE2 rejects or reads
//               them differently ("invalid perl operator").
//   [[:alpha:]] RE2 reads a POSIX class; JS reads '[' then a lone ']' (a syntax
//               error under the u flag). Refused as a nested '['.
//   \p \u \x \c \0
//               different escape spellings in the two engines.
//   {1001}      RE2's repetition ceiling ("invalid repetition size").
//   a lone { } ] and a quantifier with nothing to repeat.

export const MAX_PATTERN = 200;
/** RE2's own repetition ceiling. */
const MAX_REPEAT = 1000;

export interface RegexPreset { label: string; pattern: string }

/** Presets, written IN the subset (validated by the test like any user pattern). */
export const REGEX_PRESETS: Readonly<Record<string, RegexPreset>> = {
  email: { label: 'Email', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
  phone: { label: 'Phone', pattern: '\\+?[0-9][0-9 ().-]{5,18}[0-9]' },
  zip: { label: 'ZIP code', pattern: '[0-9]{5}(-[0-9]{4})?' },
  date: { label: 'ISO date', pattern: '[0-9]{4}-[0-9]{2}-[0-9]{2}' },
};

/** Characters that mean something outside a class, so `\` + one is a literal. */
const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
const CLASS_ESC = new Set(['d', 'D', 'w', 'W']);
const CTRL_ESC = new Set(['t', 'n', 'r']);

/** The character an allowed non-class escape stands for (`\t` is a tab, `\.` a dot). */
function escapedChar(e: string): string {
  return e === 't' ? '\t' : e === 'n' ? '\n' : e === 'r' ? '\r' : e;
}

function escapeError(e: string): string {
  if (e === 's' || e === 'S') return '\\s matches different whitespace in JavaScript and DuckDB — spell the characters out, e.g. [ \\t]';
  if (e === 'b' || e === 'B') return 'Word boundaries (\\b) are not supported';
  if (/[1-9]/.test(e) || e === 'k') return 'Back-references are not supported';
  return `"\\${e}" is not supported — type the character itself`;
}

/** One escape at `i` (the backslash). Returns the error, or the kind of atom it is. */
function readEscape(ch: string[], i: number, inClass: boolean): { error: string } | { cls: boolean } {
  const e = ch[i + 1];
  if (e === undefined) return { error: 'The pattern ends with a backslash' };
  if (CLASS_ESC.has(e)) return { cls: true };
  if (CTRL_ESC.has(e) || SYNTAX.has(e) || (inClass && e === '-')) return { cls: false };
  return { error: escapeError(e) };
}

/** A `[...]` class starting at `i`. Returns the index after `]`, or an error. */
function readClass(ch: string[], i: number): { end: number } | { error: string } {
  let j = i + 1;
  if (ch[j] === '^') j += 1;
  if (ch[j] === ']') return { error: 'An empty character class ([] or [^]) is not supported' };
  let afterRange = false;
  for (;;) {
    const c = ch[j];
    if (c === undefined) return { error: 'Unclosed [' };
    if (c === ']') return { end: j + 1 };
    if (c === '[') return { error: 'A "[" inside a class (e.g. [[:alpha:]]) is not supported — escape it as \\[' };
    if (c === '-' && afterRange && ch[j + 1] !== ']') return { error: 'Escape a "-" that follows a range as \\-' };
    // One class atom: an escape or a literal.
    let lo: string | null = c;
    let width = 1;
    if (c === '\\') {
      const esc = readEscape(ch, j, true);
      if ('error' in esc) return esc;
      lo = esc.cls ? null : escapedChar(ch[j + 1]);
      width = 2;
    }
    j += width;
    afterRange = false;
    // A range: atom '-' atom, unless the '-' is the last thing before ']'.
    if (ch[j] === '-' && ch[j + 1] !== undefined && ch[j + 1] !== ']') {
      let hi: string | null = ch[j + 1];
      let hiWidth = 1;
      if (hi === '\\') {
        const esc = readEscape(ch, j + 1, true);
        if ('error' in esc) return esc;
        hi = esc.cls ? null : escapedChar(ch[j + 2]);
        hiWidth = 2;
      }
      if (lo === null || hi === null) return { error: 'A range cannot start or end with \\d or \\w' };
      if (lo.codePointAt(0)! > hi.codePointAt(0)!) return { error: `The range ${lo}-${hi} is out of order` };
      j += 1 + hiWidth;
      afterRange = true;
    }
  }
}

/**
 * Null when `pattern` is in the subset both engines read identically, otherwise
 * the reason it is not — written for the rule editor to show as-is.
 */
export function checkPattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern === '') return 'Enter a pattern';
  if (pattern.length > MAX_PATTERN) return `Keep the pattern under ${MAX_PATTERN} characters`;
  const ch = Array.from(pattern); // code points, so an emoji is one literal
  let depth = 0;
  let canRepeat = false;
  for (let i = 0; i < ch.length;) {
    const c = ch[i];
    if (c === '\\') {
      const esc = readEscape(ch, i, false);
      if ('error' in esc) return esc.error;
      i += 2;
      canRepeat = true;
    } else if (c === '[') {
      const cls = readClass(ch, i);
      if ('error' in cls) return cls.error;
      i = cls.end;
      canRepeat = true;
    } else if (c === '(') {
      if (ch[i + 1] === '?') {
        if (ch[i + 2] !== ':') return 'Only plain ( ) and (?: ) groups are supported — no lookarounds, named groups or inline flags';
        i += 3;
      } else {
        i += 1;
      }
      depth += 1;
      canRepeat = false;
    } else if (c === ')') {
      if (depth === 0) return 'Unmatched )';
      depth -= 1;
      i += 1;
      canRepeat = true;
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (!canRepeat) return `Nothing to repeat before "${c}"`;
      if (c === '{') {
        const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(ch.slice(i, i + 12).join(''));
        if (!m) return 'A lone "{" must be escaped as \\{';
        const n = Number(m[1]);
        const hi = m[2] === undefined ? n : m[3] === '' ? n : Number(m[3]);
        if (n > MAX_REPEAT || hi > MAX_REPEAT) return `Repeat counts above ${MAX_REPEAT} are not supported`;
        if (hi < n) return `{${n},${hi}} is out of order`;
        i += m[0].length;
      } else {
        i += 1;
      }
      if (ch[i] === '?') i += 1; // lazy — irrelevant to a full match, legal in both
      canRepeat = false;
    } else if (c === '}' || c === ']') {
      return `A lone "${c}" must be escaped as \\${c}`;
    } else if (c === '|' || c === '^' || c === '$') {
      i += 1;
      canRepeat = false;
    } else {
      i += 1; // a literal, or `.`
      canRepeat = true;
    }
  }
  if (depth > 0) return 'Unclosed (';
  try {
    jsRegex(pattern);
  } catch {
    return 'That is not a valid pattern';
  }
  return null;
}

/** The JS engine's reading: full match, code points, dotAll. */
export function jsRegex(pattern: string): RegExp {
  return new RegExp('^(?:' + pattern + ')$', 'su');
}

/** The RE2 engine's reading, for `regexp_full_match` (already full-match). */
export function re2Pattern(pattern: string): string {
  return '(?s)' + pattern;
}
