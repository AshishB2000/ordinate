// The formula editor's pure halves (legacy formulaEditor.ts + lodUi.ts). NOT ONE
// CHARACTER OF THE LANGUAGE IS PARSED HERE: the tokens, the error and its span,
// the unknown columns, the result type and the preview rows all come from
// `formula:check` on the server — the same compile() the pipeline runs on save.
// This file only colours the server's tokens and offers completions.

import type { Column, FunctionDoc, Tok } from './api';

/** Keyword operators — not functions, but they colour like them. */
const KEYWORDS = new Set(['if', 'then', 'elseif', 'else', 'end', 'case', 'when', 'and', 'or', 'not', 'in', 'true', 'false', 'null']);

export type TokClass = 'col' | 'param' | 'str' | 'num' | 'lod' | 'fn' | '';

/**
 * The colour of one token. `name` is three things in this language — a
 * keyword, a function, or a bare column reference — and only the catalog can
 * tell which, so a bare `revenue` colours as a column exactly like `[revenue]`.
 */
export function tokenClass(tok: Tok, fnNames: ReadonlySet<string>): TokClass {
  if (tok.kind === 'col') return 'col';
  if (tok.kind === 'param') return 'param';
  if (tok.kind === 'str') return 'str';
  if (tok.kind === 'num') return 'num';
  if (tok.kind === 'punc' && (tok.value === '{' || tok.value === '}' || tok.value === ':')) return 'lod';
  if (tok.kind === 'name') {
    const lower = String(tok.value).toLowerCase();
    if (lower === 'fixed' || lower === 'include' || lower === 'exclude') return 'lod';
    if (lower === 'sum' || lower === 'avg' || lower === 'count' || lower === 'countd') return 'fn';
    if (KEYWORDS.has(lower) || fnNames.has(lower)) return 'fn';
    return 'col';
  }
  return '';
}

export interface Run {
  text: string;
  cls: TokClass;
  err: boolean;
}

/**
 * The source as runs of one colour (and one error state) each, for the mirror
 * behind the textarea. Built per character because the error underline is its
 * own range and overlaps the tokens it covers. A trailing newline keeps the
 * mirror as tall as the textarea when the expression ends in a line break.
 */
export function highlightRuns(src: string, tokens: readonly Tok[], at: { start: number; end: number } | null, fnNames: ReadonlySet<string>): Run[] {
  const cls: TokClass[] = new Array<TokClass>(src.length).fill('');
  const err: boolean[] = new Array<boolean>(src.length).fill(false);
  for (const tok of tokens) {
    const c = tokenClass(tok, fnNames);
    if (c) for (let i = Math.max(0, tok.start); i < Math.min(src.length, tok.end); i += 1) cls[i] = c;
  }
  if (at) for (let i = Math.max(0, at.start); i < Math.min(src.length, at.end); i += 1) err[i] = true;
  const runs: Run[] = [];
  let i = 0;
  while (i < src.length) {
    let j = i;
    while (j < src.length && cls[j] === cls[i] && err[j] === err[i]) j += 1;
    runs.push({ text: src.slice(i, j), cls: cls[i], err: err[i] });
    i = j;
  }
  runs.push({ text: '\n', cls: '', err: false });
  return runs;
}

/** Caret position for a clicked LOD keyword template: inside its first `[]`. */
export function lodCaretBack(d: FunctionDoc): number {
  const ins = d.insert ?? '';
  const at = ins.indexOf('[]');
  return d.kind === 'keyword' && at >= 0 ? ins.length - at - 1 : 0;
}

/** What completing `fix` → FIXED inserts: the brace too, unless one is already typed. */
export function lodKeywordInsert(d: FunctionDoc, braced: boolean): string {
  if (d.kind !== 'keyword') return '';
  const kw = d.name.toUpperCase() + ' ';
  return braced ? kw : '{' + kw;
}

export interface PopItem {
  label: string;
  insert: string;
  sub: string;
}

/**
 * The completions for the text before the caret, and where they replace from.
 * An unclosed `[` is a column; inside an LOD's dimension list every column is
 * offered as `[name]`; otherwise two or more identifier characters start a
 * function name (one letter would open a popover over every expression typed).
 * `refs` are other names a bracket can hold — a measure's saved metrics — and
 * come first.
 */
export function popContext(before: string, columns: readonly Column[], docs: readonly FunctionDoc[], refs: readonly PopItem[] = []): { items: PopItem[]; from: number } | null {
  const open = before.lastIndexOf('[');
  if (open >= 0 && before.indexOf(']', open) < 0) {
    const frag = before.slice(open + 1).toLowerCase();
    const items = refs
      .filter((r) => r.label.toLowerCase().includes(frag))
      .concat(columns.filter((c) => c.name.toLowerCase().includes(frag)).map((c) => ({ label: c.name, insert: `[${c.name}]`, sub: c.type })))
      .slice(0, 12);
    return items.length ? { items, from: open } : null;
  }
  const lod = /\{\s*(fixed|include|exclude)(\s[^:{}]*)$/i.exec(before);
  if (lod) {
    const part = lod[2].split(',').pop() ?? '';
    if (!/[[\]]/.test(part)) {
      const frag = part.trim().toLowerCase();
      const items = columns
        .filter((c) => c.name.toLowerCase().includes(frag))
        .slice(0, 12)
        .map((c) => ({ label: c.name, insert: `[${c.name}]`, sub: `dimension · ${c.type}` }));
      if (items.length) return { items, from: before.length - part.trimStart().length };
    }
  }
  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
  if (!word || word[0].length < 2) return null;
  const frag = word[0].toLowerCase();
  const braced = before.slice(0, before.length - word[0].length).trimEnd().endsWith('{');
  const items = docs
    // Right after `{` only FIXED / INCLUDE / EXCLUDE can follow.
    .filter((d) => (braced ? d.kind === 'keyword' : d.kind !== 'recipe') && d.name.startsWith(frag))
    .slice(0, 12)
    .map((d) => ({ label: d.signature, insert: lodKeywordInsert(d, braced) || d.name + '(', sub: d.summary }));
  return items.length ? { items, from: before.length - word[0].length } : null;
}

/** The category heading in the function list. */
export const categoryLabel = (cat: string): string => (cat === 'lod' ? 'Level of detail' : cat.charAt(0).toUpperCase() + cat.slice(1));
