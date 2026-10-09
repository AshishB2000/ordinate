import { describe, expect, it } from 'vitest';
import { AC_MAX, completions, highlight, quoteIdent, quoteQualified, tokenize, typeKind, wordBefore } from './sqlLex';

describe('the cosmetic SQL lexer', () => {
  it('colours keywords, strings, numbers, quoted identifiers and comments', () => {
    const src = `select "a b", 'it''s' -- from x\nfrom t where n > 1.5 /* c */`;
    const kinds = tokenize(src).map((t) => `${t.cls}:${src.slice(t.start, t.end)}`);
    expect(kinds).toEqual(['kw:select', 'id:"a b"', "str:'it''s'", 'com:-- from x', 'kw:from', 'kw:where', 'num:1.5', 'com:/* c */']);
  });

  it('runs an unterminated string or comment to the end (no flicker while typing)', () => {
    expect(tokenize("where x = 'abc").at(-1)).toEqual({ start: 10, end: 14, cls: 'str' });
    expect(tokenize('a /* open').at(-1)).toEqual({ start: 2, end: 9, cls: 'com' });
  });

  it('highlight() covers the source exactly, in order', () => {
    const src = 'SELECT  x  FROM "t" -- end';
    const runs = highlight(src);
    expect(runs.map((r) => r.text).join('')).toBe(src);
    expect(runs.filter((r) => r.cls).map((r) => r.cls)).toEqual(['kw', 'kw', 'id', 'com']);
  });

  it('finds the word before the caret, dots included', () => {
    expect(wordBefore('select sales.ord', 16)).toEqual({ word: 'sales.ord', from: 7 });
    expect(wordBefore('select x, ', 10)).toEqual({ word: '', from: -1 });
  });
});

describe('completions', () => {
  const cols = new Map([['sales.orders', ['region', 'revenue']]]);
  it('offers tables, then columns, then keywords — prefix matches, capped', () => {
    expect(completions('re', ['sales.orders'], cols).map((c) => `${c.kind}:${c.text}`)).toEqual(['column:region', 'column:revenue']);
    expect(completions('sales', ['sales.orders', 'sales.customers'], cols).map((c) => c.text)).toEqual(['sales.orders', 'sales.customers']);
    expect(completions('se', [], new Map())[0]).toEqual({ text: 'SELECT', kind: 'keyword', sub: 'keyword' });
    expect(completions('', ['t'], cols)).toEqual([]);
    expect(completions('c', Array.from({ length: 20 }, (_, i) => `c${i}`), new Map())).toHaveLength(AC_MAX);
  });
});

describe('identifier quoting per dialect', () => {
  it('quotes the way each family does, escaping its own quote', () => {
    expect(quoteIdent('postgres', 'a"b')).toBe('"a""b"');
    expect(quoteIdent('mysql', 'a`b')).toBe('`a``b`');
    expect(quoteIdent('mssql', 'a]b')).toBe('[a]]b]');
    expect(quoteIdent('oracle', 'sales')).toBe('sales');
  });
  it('quotes a schema-qualified name part by part, except DuckDB (one folded identifier)', () => {
    expect(quoteQualified('postgres', 'sales.orders')).toBe('"sales"."orders"');
    expect(quoteQualified('mysql', 'db.t')).toBe('`db`.`t`');
    expect(quoteQualified('duckdb', 'reporting.t')).toBe('"reporting.t"');
    expect(quoteQualified('bigquery', 'sales.orders')).toBe('`sales`.`orders`');
    expect(quoteIdent('bigquery', 'a`b\\c')).toBe('`a\\`b\\\\c`');
  });
  it('reduces a source type to a glyph shape', () => {
    expect([typeKind('bigint'), typeKind('NUMERIC(10,2)'), typeKind('timestamp with time zone'), typeKind('varchar')]).toEqual(['number', 'number', 'date', 'text']);
  });
});
