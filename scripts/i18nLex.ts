// A small TypeScript TOKENIZER for the string-catalog tooling
// (scripts/i18n-extract.ts writes the catalog, scripts/test-i18n.ts guards it).
//
// The repo has no TypeScript compiler API to lean on (TS 7 ships a native
// binary, not a JS library), and a regex over raw source cannot tell a string
// from the same characters inside a comment, a regex literal or a template's
// `${…}`. This is just enough of a lexer to get that right: comments, the three
// string forms (template literals lexed recursively through their expressions),
// regex-vs-division by the previous significant token, identifiers, numbers and
// punctuation. Every token keeps its source offsets so a rewrite is a splice.

export type TokType = 'ident' | 'num' | 'str' | 'tpl' | 'regex' | 'punct';

export interface TplPart {
  /** The raw source text between `…${` and `}…`, escapes unprocessed. */
  raw: string;
  start: number;
  end: number;
}

export interface Tok {
  type: TokType;
  start: number;
  end: number;
  /** ident/num/punct/regex: the source text. str: the COOKED value. tpl: ''. */
  value: string;
  /** tpl only: n+1 quasis around n expressions. */
  quasis?: TplPart[];
  /** tpl only: each `${…}` expression's own token list and its source span. */
  exprs?: { start: number; end: number; toks: Tok[] }[];
}

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

const PUNCT3 = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '>>', '**'];

/** Cook a quoted string body: the escapes TS source actually uses. */
export function cook(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_m, e: string) => {
    if (e[0] === 'u' && e[1] === '{') return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case '\n': case '\r\n': return '';
      default: return e;
    }
  });
}

/**
 * Tokenize `src` from `pos` until the end, or — inside a template expression —
 * until the `}` that closes it (returned as `stop`).
 */
export function lex(src: string, from = 0, inTemplate = false): { toks: Tok[]; stop: number } {
  const toks: Tok[] = [];
  let i = from;
  let depth = 0;
  const n = src.length;
  const prevSig = (): Tok | undefined => toks[toks.length - 1];
  const regexAllowed = (): boolean => {
    const p = prevSig();
    if (!p) return true;
    if (p.type === 'num' || p.type === 'str' || p.type === 'tpl' || p.type === 'regex') return false;
    if (p.type === 'ident') return REGEX_AFTER_KEYWORD.has(p.value);
    return !(p.value === ')' || p.value === ']' || p.value === '}');
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      toks.push({ type: 'str', start: i, end: j + 1, value: cook(src.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const quasis: TplPart[] = [];
      const exprs: { start: number; end: number; toks: Tok[] }[] = [];
      let j = i + 1;
      let qs = j;
      for (;;) {
        if (j >= n) { quasis.push({ raw: src.slice(qs, j), start: qs, end: j }); break; }
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { quasis.push({ raw: src.slice(qs, j), start: qs, end: j }); j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          quasis.push({ raw: src.slice(qs, j), start: qs, end: j });
          const inner = lex(src, j + 2, true);
          exprs.push({ start: j + 2, end: inner.stop, toks: inner.toks });
          j = inner.stop + 1;
          qs = j;
          continue;
        }
        j++;
      }
      toks.push({ type: 'tpl', start: i, end: j, value: '', quasis, exprs });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      toks.push({ type: 'regex', start: i, end: j, value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$À-￿]/.test(src[j])) j++;
      toks.push({ type: 'ident', start: i, end: j, value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ type: 'num', start: i, end: j, value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (inTemplate) {
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) return { toks, stop: i }; depth--; }
    }
    const p = PUNCT3.find((x) => src.startsWith(x, i)) || PUNCT2.find((x) => src.startsWith(x, i)) || c;
    toks.push({ type: 'punct', start: i, end: i + p.length, value: p });
    i += p.length;
  }
  return { toks, stop: n };
}

/** The static text of a template literal, with each `${…}` replaced by `{}`. */
export function tplStatic(tok: Tok): string {
  return (tok.quasis || []).map((q) => cook(q.raw)).join('{}');
}
