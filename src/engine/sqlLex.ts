// A SQL token stream for DuckDB text the USER wrote — MAIN PROCESS, pure, no
// imports. Used by sqlDatasets.ts to find which datasets a query names and to
// refuse the constructs that read files.
//
// It models the same quoting forms `ipc/mosaic.ts`'s `statementCount` does,
// each measured there against this DuckDB build: `'…'` with `''` doubling,
// `E'…'` with backslash escapes, `"…"` with `""` doubling, `$tag$…$tag$`, `--`
// line comments and NESTING `/* */` comments. That is not tidiness — the guards
// that stand on this lexer are only as good as its idea of where a string ends.
// A lexer that thinks `read_text(` is inside a string when DuckDB thinks it is
// code is a bypass; the reverse is a false rejection. Every form above errs the
// safe way or is modelled exactly.
//
// Whitespace and comments produce no tokens. An unterminated string, identifier
// or comment runs to the end of input — `statementCount` has already refused
// such input before anything here is trusted.

export type SqlTokenKind = 'word' | 'qid' | 'str' | 'num' | 'punct';

export interface SqlToken {
  kind: SqlTokenKind;
  /** word: as written; qid: unescaped identifier; str: literal body; punct: the char. */
  text: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

export function lexSql(sql: string): SqlToken[] {
  const src = typeof sql === 'string' ? sql : '';
  const n = src.length;
  const out: SqlToken[] = [];
  let i = 0;

  // A `'…'` body starting at the opening quote `q`. Backslash escapes only for
  // an E-string (measured: a backslash in a PLAIN string is literal).
  const readString = (q: number, escapes: boolean): number => {
    let j = q + 1;
    let body = '';
    while (j < n) {
      const c = src[j];
      if (escapes && c === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
      if (c === "'") {
        if (src[j + 1] === "'") { body += "'"; j += 2; continue; }
        j += 1;
        break;
      }
      body += c;
      j += 1;
    }
    out.push({ kind: 'str', text: body, start: q, end: Math.min(j, n) });
    return Math.min(j, n);
  };

  while (i < n) {
    const ch = src[i];

    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }

    if (ch === "'") { i = readString(i, false); continue; }

    if (ch === '"') {
      let j = i + 1;
      let body = '';
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { body += '"'; j += 2; continue; }
          j += 1;
          break;
        }
        body += src[j];
        j += 1;
      }
      out.push({ kind: 'qid', text: body, start: i, end: Math.min(j, n) });
      i = Math.min(j, n);
      continue;
    }

    if (ch === '$') {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 130));
      if (open) {
        const close = src.indexOf(open[0], i + open[0].length);
        const end = close < 0 ? n : close + open[0].length;
        out.push({ kind: 'str', text: src.slice(i + open[0].length, close < 0 ? n : close), start: i, end });
        i = end;
        continue;
      }
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(src[j])) j += 1;
      const word = src.slice(i, j);
      // `E'…'`: the prefix is a word of its own, directly followed by a quote.
      if ((word === 'e' || word === 'E') && src[j] === "'") { i = readString(j, true); continue; }
      out.push({ kind: 'word', text: word, start: i, end: j });
      i = j;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[0-9._eE]/.test(src[j])) j += 1;
      out.push({ kind: 'num', text: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    out.push({ kind: 'punct', text: ch, start: i, end: i + 1 });
    i += 1;
  }
  return out;
}
