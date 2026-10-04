// The Query tab's text helpers — queryEditor.ts (qeIdent, qeScan, qeInsert's
// spacing, qeCompletions) and queryParams.ts (qtGuessKind, qtCollectParams)
// plus queryTab.ts's starter, ported as pure functions. COSMETIC and
// APPROXIMATE by design: nothing here decides whether SQL is valid or safe,
// and nothing builds a statement — the server re-lexes, gates (sqlGate) and
// BINDS every parameter (src/analysis/params.ts). A value is never spliced.

import { KEYWORDS, tokenize } from '../../connections/sqlLex';

export interface SchemaColumn {
  name: string;
  type: string;
}
export interface SchemaDataset {
  id: string;
  name: string;
  alias: string | null;
  slug: string;
  rowCount: number;
  queryable: boolean;
  columns: SchemaColumn[];
}

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A name as SQL should spell it: bare when DuckDB reads it as written, "quoted" otherwise. */
export function ident(name: string): string {
  const n = String(name || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORD_SET.has(n.toLowerCase()) ? n : '"' + n.replace(/"/g, '""') + '"';
}

/** The names and `[[params]]` in `sql`, outside strings and comments. A `[[x]]` inside a "quoted name" is part of that name. */
export function scan(sql: string): { names: string[]; params: string[] } {
  const skip = new Uint8Array(sql.length);
  for (const t of tokenize(sql)) if (t.cls === 'str' || t.cls === 'com') skip.fill(1, t.start, t.end);
  const names: string[] = [];
  const params: string[] = [];
  const re = /\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]|"((?:[^"]|"")*)"|[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (skip[m.index]) continue;
    if (m[1] !== undefined) {
      if (!params.includes(m[1])) params.push(m[1]);
    } else if (m[2] !== undefined) names.push(m[2].replace(/""/g, '"'));
    else names.push(m[0]);
  }
  return { names, params };
}

/** The datasets `sql` names, first reference first — an approximation of the server's. */
export function referencedIds(sql: string, schema: readonly SchemaDataset[]): string[] {
  const byKey = new Map<string, string>();
  for (const d of schema) {
    if (d.alias) byKey.set(fold(d.alias), d.id);
    byKey.set(d.slug, d.id);
  }
  const out: string[] = [];
  for (const n of scan(sql).names) {
    const id = byKey.get(fold(n));
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Insert `text` at [a, b), spaced so it never runs into a word. Returns the new text and the caret after it. */
export function insertAt(value: string, a: number, b: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, a);
  const after = value.slice(b);
  const pre = before && !/[\s(,.]$/.test(before) ? ' ' : '';
  const post = after && !/^[\s),.;]/.test(after) ? ' ' : '';
  return { value: before + pre + text + post + after, caret: (before + pre + text).length };
}

export interface Completion {
  label: string;
  insert: string;
  sub: string;
}

/** Columns of the datasets the SQL names first, then dataset names, other columns, keywords. After a `.`: columns only. */
export function completions(prefix: string, afterDot: boolean, sql: string, schema: readonly SchemaDataset[], max = 8): Completion[] {
  const q = prefix.toLowerCase();
  const out: Completion[] = [];
  const seen = new Set<string>();
  const take = (label: string, insert: string, sub: string) => {
    if (!label || seen.has(label) || !label.toLowerCase().startsWith(q)) return;
    seen.add(label);
    out.push({ label, insert, sub });
  };
  const refs = referencedIds(sql, schema);
  const first = schema.filter((d) => refs.includes(d.id));
  const rest = schema.filter((d) => !refs.includes(d.id));
  for (const d of first) for (const c of d.columns) take(c.name, ident(c.name), `${c.type} · ${d.name}`);
  if (!afterDot) {
    for (const d of schema) {
      take(d.slug, d.slug, `dataset · ${d.name}`);
      if (d.alias && fold(d.alias) !== d.slug) take(d.alias, ident(d.alias), 'dataset');
    }
  }
  for (const d of rest) for (const c of d.columns) take(c.name, ident(c.name), `${c.type} · ${d.name}`);
  if (!afterDot) for (const k of KEYWORDS) take(k.toUpperCase(), k.toUpperCase(), 'keyword');
  return out.slice(0, max);
}

/**
 * The empty editor's placeholder, from the first dataset's REAL columns:
 * `select region, sum(revenue) as revenue from retail_orders group by 1 order by 2 desc`.
 */
export function starter(schema: readonly SchemaDataset[]): string {
  const d = schema.find((x) => x.queryable && x.columns.length) ?? schema.find((x) => x.queryable);
  if (!d) return 'select * from …';
  // Group by a label, not an id: `order_id` is a text column nobody sums by.
  const texts = d.columns.filter((c) => c.type === 'text');
  const text = texts.find((c) => !/(^|_)(id|uuid|key|code)$|id$/i.test(c.name)) ?? texts[0];
  const num = d.columns.find((c) => c.type === 'number');
  if (text && num) return `select ${ident(text.name)}, sum(${ident(num.name)}) as ${ident(num.name)}\nfrom ${d.slug}\ngroup by 1\norder by 2 desc`;
  if (text) return `select ${ident(text.name)}, count(*) as rows\nfrom ${d.slug}\ngroup by 1\norder by 2 desc`;
  return `select * from ${d.slug} limit 100`;
}

export type ParamKind = 'text' | 'number' | 'date' | 'list';
export interface ParamEntry {
  kind: ParamKind;
  value: string;
}
export type SqlParam = {
  name: string;
  kind: ParamKind;
  value: string | number | string[];
};

/** A first guess at a new parameter's type, from its name. The user can change it. */
export function guessKind(name: string): ParamKind {
  if (/date|day|from|since|until|start|end/i.test(name)) return 'date';
  if (/^(min|max|limit|top|n)$|min_|max_|_min|_max|threshold|amount|count/i.test(name)) return 'number';
  if (/s$|_list|_ids?$/i.test(name) && name.length > 3) return 'list';
  return 'text';
}

/** The parameters the SQL uses, typed for the server — or the first one missing a value. */
export function collectParams(sql: string, state: ReadonlyMap<string, ParamEntry>): { params: SqlParam[]; error: string } {
  const params: SqlParam[] = [];
  for (const name of scan(sql).params) {
    const st = state.get(name) ?? { kind: guessKind(name), value: '' };
    const raw = st.value.trim();
    if (st.kind === 'list') {
      // Always TEXT elements: DuckDB casts text to a number column's type, never the reverse.
      params.push({ name, kind: 'list', value: raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [] });
      continue;
    }
    if (!raw && st.kind !== 'text') return { params, error: `Give [[${name}]] a value in the parameters row.` };
    params.push({ name, kind: st.kind, value: st.kind === 'number' ? Number(raw) : raw });
  }
  return { params, error: '' };
}
