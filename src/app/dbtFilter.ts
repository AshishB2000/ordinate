// A dbt metric filter, read by a CLOSED grammar (semantic layer part 7, f1; docs/semantic-layer/07-portability.md
// D10) into part 1's filter steps — or refused. PURE. The text is an uploaded file's: untrusted, never run.
//
//   where := cond ( AND cond )*
//   cond  := ref op literal | ref [NOT] IN ( literal, … ) | ref IS [NOT] NULL
//   ref   := {{ Dimension('<entity>__<dimension>') }}      op := = != <> < <= > >=
//
// Only shapes whose figures are the warehouse's exactly are read; anything else is null (the metric is skipped):
// - a string literal against a text column, a number against a number column; `<`, `>` only on numbers (a text order
//   is the warehouse's collation, not ours);
// - SQL's `x != v` and `x NOT IN (…)` leave out a NULL x, where Ordinate's `!=` and `not in` keep an empty cell, so
//   both carry a `not_empty` step first. Ordinate reads an empty or blank cell as no value, as dbt reads NULL;
// - no empty string, no backslash (an escape in some warehouses, a character in others), no control character, and no
//   number past 15 digits (JS would round it).

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';

type Tok = { k: 'ref'; dim: string } | { k: 'str'; v: string } | { k: 'num'; v: number } | { k: 'op'; v: string } | { k: 'word'; v: string } | { k: 'p'; v: '(' | ')' | ',' };

const MAX_TEXT = 2_000;
const TOKEN = /\s*(?:\{\{\s*Dimension\s*\(\s*(['"])([A-Za-z0-9_]{1,256})\1\s*\)\s*\}\}|'((?:[^'\\\u0000-\u001f\u007f]|'')*)'|(-?\d{1,15}(?:\.\d{1,15})?)(?![\w.])|(<>|!=|<=|>=|=|<|>)|([(),])|([A-Za-z]+))/y;

function tokens(text: string): Tok[] | null {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const t = TOKEN.exec(text);
    if (!t) return /^\s*$/.test(text.slice(at)) ? out : null;
    if (t[2] !== undefined) out.push({ k: 'ref', dim: t[2] });
    else if (t[3] !== undefined) out.push({ k: 'str', v: t[3].replace(/''/g, "'") });
    else if (t[4] !== undefined) {
      if (t[4].replace(/\D/g, '').length > 15) return null; // past what a double holds exactly
      out.push({ k: 'num', v: Number(t[4]) });
    }
    else if (t[5] !== undefined) out.push({ k: 'op', v: t[5] });
    else if (t[6] !== undefined) out.push({ k: 'p', v: t[6] as '(' | ')' | ',' });
    else out.push({ k: 'word', v: t[7].toUpperCase() });
  }
  return out;
}

/** A literal as the column's type reads it: a non-empty string for text, a number for a number; else null. */
function literal(t: Tok | undefined, col: ParsedColumn): string | number | null {
  if (t?.k === 'str' && col.type === 'text' && t.v.trim() !== '') return t.v;
  if (t?.k === 'num' && col.type === 'number' && Number.isFinite(t.v)) return t.v;
  return null;
}

const step = (column: string, op: FilterStep['op'], more: Partial<FilterStep> = {}): FilterStep => ({ type: 'filter', column, op, ...more });

/**
 * The filter steps `text` says, all of them ANDed, or null for any other shape. `entity`: the metric's semantic
 * model's primary entity (`order` in `order__region`); `columnOf`: a dimension of that model → its column, or null when
 * it is not a plain categorical column (a time dimension, an expression).
 */
export function parseDbtWhere(text: string, entity: string, columnOf: (dimension: string) => ParsedColumn | null): FilterStep[] | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT || !entity) return null;
  const toks = tokens(text);
  if (!toks?.length) return null;
  const out: FilterStep[] = [];
  let i = 0;
  const word = (w: string): boolean => (toks[i]?.k === 'word' && (toks[i] as { v: string }).v === w ? (i++, true) : false);
  for (;;) {
    const ref = toks[i++];
    const prefix = `${entity}__`;
    if (ref?.k !== 'ref' || !ref.dim.startsWith(prefix) || ref.dim.slice(prefix.length).includes('__')) return null;
    const col = columnOf(ref.dim.slice(prefix.length));
    if (!col) return null;
    const t = toks[i];
    if (word('IS')) {
      const not = word('NOT');
      if (!word('NULL')) return null;
      out.push(step(col.name, not ? 'not_empty' : 'is_empty'));
    } else if (word('NOT') || word('IN')) {
      const negated = (t as { v?: string }).v === 'NOT';
      if (negated && !word('IN')) return null;
      if (toks[i++]?.k !== 'p' || (toks[i - 1] as { v: string }).v !== '(') return null;
      const values: Array<string | number> = [];
      for (;;) {
        const v = literal(toks[i++], col);
        if (v === null) return null;
        values.push(v);
        const sep = toks[i++];
        if (sep?.k !== 'p') return null;
        if (sep.v === ')') break;
        if (sep.v !== ',') return null;
      }
      if (negated) out.push(step(col.name, 'not_empty'), step(col.name, 'not in', { values }));
      else out.push(step(col.name, 'in', { values }));
    } else if (t?.k === 'op') {
      i++;
      const value = literal(toks[i++], col);
      if (value === null) return null;
      const op = t.v === '<>' ? '!=' : (t.v as FilterStep['op']);
      if (op !== '=' && op !== '!=' && col.type !== 'number') return null;
      if (op === '!=' && col.type !== 'number') out.push(step(col.name, 'not_empty'));
      out.push(step(col.name, op, { value }));
    } else return null;
    if (i === toks.length) return out;
    if (!word('AND')) return null;
  }
}
