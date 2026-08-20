// The formula TOKENIZER, and the error type the whole formula pipeline throws.
// MAIN PROCESS, PURE logic — no Electron, no fs, no DOM.
//
// An expression is DATA, never code: there is deliberately no `eval` and no
// `new Function` here or in either sibling module.
//
// Split out of formula.ts — see .claude/rules/file-size.md. Ordinary TS module;
// the only edits to the moved code are the `export` keywords.

// ── Errors ───────────────────────────────────────────────────────────────────

export class FormulaError extends Error {}

// ── Tokenizer ────────────────────────────────────────────────────────────────

export type TokKind = 'num' | 'str' | 'name' | 'col' | 'op' | 'punc';
export interface Tok {
  kind: TokKind;
  value: string;
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
      toks.push({ kind: 'num', value: src.slice(i, j) });
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
      if (j >= n) throw new FormulaError('Unterminated string literal');
      toks.push({ kind: 'str', value: val });
      i = j + 1;
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
      if (j >= n) throw new FormulaError('Unterminated [column] reference');
      toks.push({ kind: 'col', value: val.trim() });
      i = j + 1;
      continue;
    }

    // bare identifier (keyword / function name / column ref)
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
      toks.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }

    // single-char operators
    if (c === '=' || c === '>' || c === '<' || c === '+' || c === '-' || c === '*' || c === '/' || c === '%') {
      toks.push({ kind: 'op', value: c });
      i += 1;
      continue;
    }

    // punctuation
    if (c === '(' || c === ')' || c === ',') {
      toks.push({ kind: 'punc', value: c });
      i += 1;
      continue;
    }

    throw new FormulaError('Unexpected character: ' + c);
  }

  return toks;
}

