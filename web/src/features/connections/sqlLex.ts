// The workbench editor's COSMETIC lexer, completions and identifier quoting —
// pure, ported from the desktop's connEditor.ts / connWorkbench.ts.
//
// No verdict here: six dialects, the statement is the user's own, and only the
// SERVER (`connection:explain`) says whether it is valid. This colours five
// obvious shapes and offers names; it never decides anything.

/** The common core, not one dialect's reserved words: a colour and a completion list. */
export const KEYWORDS: readonly string[] = [
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'using',
  'as', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'ilike', 'between',
  'case', 'when', 'then', 'else', 'end', 'distinct', 'union', 'all', 'with',
  'asc', 'desc', 'count', 'sum', 'avg', 'min', 'max', 'cast', 'coalesce',
  'over', 'partition', 'exists', 'any', 'true', 'false',
];
const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);

export type TokenClass = 'kw' | 'str' | 'num' | 'id' | 'com';
export interface Token {
  start: number;
  end: number;
  cls: TokenClass;
}

/**
 * Strings and comments are consumed whole BEFORE anything looks inside them, so
 * `-- select` and `'it''s'` colour as one thing each. An unterminated string
 * runs to the end — right while typing, or the rest flickers on every quote.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      const to = end < 0 ? n : end;
      out.push({ start: i, end: to, cls: 'com' });
      i = to;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      out.push({ start: i, end: to, cls: 'com' });
      i = to;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") {
          j += 1;
          break;
        } else j += 1;
      }
      out.push({ start: i, end: j, cls: 'str' });
      i = j;
    } else if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n && src[j] !== close) j += 1;
      const to = Math.min(n, j + 1);
      out.push({ start: i, end: to, cls: 'id' });
      i = to;
    } else if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < n && /[0-9._]/.test(src[j])) j += 1;
      out.push({ start: i, end: j, cls: 'num' });
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      if (KEYWORD_SET.has(src.slice(i, j).toLowerCase())) out.push({ start: i, end: j, cls: 'kw' });
      i = j;
    } else i += 1;
  }
  return out;
}

/** The source as runs of text with an optional class — the mirror layer's spans. */
export function highlight(src: string): { text: string; cls: TokenClass | null }[] {
  const runs: { text: string; cls: TokenClass | null }[] = [];
  let at = 0;
  for (const t of tokenize(src)) {
    if (t.start > at) runs.push({ text: src.slice(at, t.start), cls: null });
    runs.push({ text: src.slice(t.start, t.end), cls: t.cls });
    at = t.end;
  }
  if (at < src.length) runs.push({ text: src.slice(at), cls: null });
  return runs;
}

/** The bare word immediately before `caret`, and where it starts (-1: none). */
export function wordBefore(text: string, caret: number): { word: string; from: number } {
  const m = /[A-Za-z_][A-Za-z0-9_$.]*$/.exec(text.slice(0, caret));
  return m ? { word: m[0], from: caret - m[0].length } : { word: '', from: -1 };
}

export interface Completion {
  text: string;
  kind: 'table' | 'column' | 'keyword';
  sub: string;
}

/** How many completions show: more is a list to read, not one to pick from. */
export const AC_MAX = 8;

/** Tables, then columns already described, then keywords — prefix matches, deduped. Nothing fetches. */
export function completions(prefix: string, tables: readonly string[], columns: ReadonlyMap<string, readonly string[]>): Completion[] {
  const q = prefix.toLowerCase();
  if (!q) return [];
  const out: Completion[] = [];
  const seen = new Set<string>();
  const take = (text: string, kind: Completion['kind'], sub: string) => {
    const key = `${kind} ${text}`;
    if (!text || seen.has(key) || !text.toLowerCase().startsWith(q)) return;
    seen.add(key);
    out.push({ text, kind, sub });
  };
  for (const t of tables) take(t, 'table', 'table');
  for (const [table, cols] of columns) for (const c of cols) take(c, 'column', table);
  for (const k of KEYWORDS) take(k.toUpperCase(), 'keyword', 'keyword');
  return out.slice(0, AC_MAX);
}

/**
 * One identifier quoted the way this family's dialect does — text inserted into
 * an editor the user then reads, NOT a security boundary (main bounds and
 * whitelists). Oracle stays bare: it folds unquoted names to upper case.
 */
export function quoteIdent(family: string, name: string): string {
  if (family === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (family === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
  if (family === 'oracle') return name;
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * A `schema.table` name, each part quoted. The desktop quoted the whole string
 * as ONE identifier (`"sales.orders"`), which Postgres reads as a table literally
 * named `sales.orders` — a deliberate fix here. DuckDB-family names are already
 * one identifier with the schema folded in.
 */
export function quoteQualified(family: string, name: string): string {
  return family === 'duckdb' ? quoteIdent(family, name) : name.split('.').map((p) => quoteIdent(family, p)).join('.');
}

/** A SOURCE type name reduced to a glyph — never a type decision (parse.ts makes that, over values). */
export function typeKind(sourceType: string): 'number' | 'date' | 'text' {
  const t = sourceType.toLowerCase();
  if (/(int|numeric|decimal|real|double|float|number|money|serial|bigint)/.test(t)) return 'number';
  if (/(date|time|timestamp|interval)/.test(t)) return 'date';
  return 'text';
}
