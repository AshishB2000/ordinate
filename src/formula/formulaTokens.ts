// The formula TOKENIZER, and the error type the whole formula pipeline throws.
// MAIN PROCESS, PURE logic — no fs, no DOM.
//
// An expression is DATA, never code: there is deliberately no `eval` and no
// `new Function` here or in either sibling module.
//
// Split out of formula.ts — see .claude/rules/file-size.md. Ordinary TS module;
// the only edits to the moved code are the `export` keywords.

// ── Errors ───────────────────────────────────────────────────────────────────

export class FormulaError extends Error {
  // Where the problem is, in SOURCE OFFSETS — set by the tokenizer, which is the
  // only thing here that knows them before there are tokens to index.
  at?: { start: number; end: number };
  // Where the problem is, as an index into the TOKEN stream — set by the parser,
  // which counts tokens, not characters. `compile()` maps it back to offsets
  // through the tokens it already has. An index of `tokens.length` means "at the
  // end of the input", which is what an unclosed call or a trailing operator is.
  tokenIndex?: number;
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

// `param` is a dashboard parameter, `[[name]]` — see src/analysis/params.ts.
export type TokKind = 'num' | 'str' | 'name' | 'col' | 'op' | 'punc' | 'param';
export interface Tok {
  kind: TokKind;
  value: string;
  /** Offset of the token's first character in the source string. */
  start: number;
  /** Offset one past its last character — so `src.slice(start, end)` is the
   *  token AS WRITTEN, including the quotes or brackets its `value` drops.
   *  That is what the editor's highlight layer paints, so it must cover every
   *  character: a gap would shift every colour after it. */
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

// Emits: number literals, quoted strings ('…' or "…", backslash escapes the next
// char), bracketed column names [Col Name], bare identifiers, operators, parens,
// commas. Any other character is a syntax error (so ";" in "1;process.exit"
// aborts the whole compile).
function fail(message: string, start: number, end: number): never {
  const e = new FormulaError(message);
  e.at = { start, end };
  throw e;
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    // number literal (int, decimal, exponent)
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && isDigit(src[j])) j += 1;
      if (src[j] === '.') {
        j += 1;
        while (j < n && isDigit(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (isDigit(src[k])) {
          k += 1;
          while (k < n && isDigit(src[k])) k += 1;
          j = k;
        }
      }
      toks.push({ kind: 'num', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    // quoted string
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          val += src[j + 1];
          j += 2;
          continue;
        }
        val += src[j];
        j += 1;
      }
      if (j >= n) fail('Unterminated string literal', i, n);
      toks.push({ kind: 'str', value: val, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }

    // a dashboard parameter [[name]] — checked BEFORE the column form, which
    // would read `[[name` as a column and then trip over the second `]`.
    if (c === '[' && src[i + 1] === '[') {
      const end = src.indexOf(']]', i + 2);
      if (end < 0) fail('Unterminated [[parameter]] reference', i, n);
      toks.push({ kind: 'param', value: src.slice(i + 2, end).trim(), start: i, end: end + 2 });
      i = end + 2;
      continue;
    }

    // bracketed column reference [Col Name] — allows spaces
    if (c === '[') {
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== ']') {
        val += src[j];
        j += 1;
      }
      if (j >= n) fail('Unterminated [column] reference', i, n);
      toks.push({ kind: 'col', value: val.trim(), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }

    // bare identifier (keyword / function name / column ref)
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
      toks.push({ kind: 'op', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }

    // single-char operators
    if (c === '=' || c === '>' || c === '<' || c === '+' || c === '-' || c === '*' || c === '/' || c === '%') {
      toks.push({ kind: 'op', value: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // punctuation — `{`, `}` and `:` frame a level-of-detail expression,
    // `{FIXED [Region] : SUM([Sales])}` (formulaParse.parseLod). Column refs
    // inside one stay ordinary `col` tokens, so a token-level rewrite of column
    // names (save-as-template) reaches them too.
    if (c === '(' || c === ')' || c === ',' || c === '{' || c === '}' || c === ':') {
      toks.push({ kind: 'punc', value: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    fail('Unexpected character: ' + c, i, i + 1);
  }

  return toks;
}

