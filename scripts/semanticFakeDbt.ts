// The test harness's FAKE dbt SEMANTIC LAYER (semantic layer part 7, d1; docs/live-data/dbt-semantic-layer.md). Not a
// suite itself.
//
//   parseTemplate  a reader of the `where` text Ordinate writes (src/engine/live/semantic/literals.ts): every predicate
//                  it can read, and whatever it cannot as a `raw` one, so a value that broke out of its quotes shows up
//                  as a second predicate (test-semanticLiterals' fuzz and its negative control).

/** A dimension as the template names it: `{{ Dimension('x') }}`, or `{{ TimeDimension('x', 'day') }}` (`day`). */
export type TemplateRef = { name: string; day: boolean };
export type TemplatePredicate =
  | { ref: TemplateRef; op: '=' | '<>' | '<' | '<=' | '>' | '>='; value: string }
  | { ref: TemplateRef; isNull: boolean }
  | { ref: TemplateRef; in: string[]; not: boolean }
  | { ref: TemplateRef; like: string }
  | { raw: string };
export type TemplateTree = TemplatePredicate | { and: TemplateTree[] } | { or: TemplateTree[] };

type Tok = { t: 'ref'; ref: TemplateRef } | { t: 'str'; v: string } | { t: 'num'; v: string } | { t: 'op'; v: string } | { t: 'kw'; v: string } | { t: 'p'; v: '(' | ')' | ',' } | { t: 'raw'; v: string };

const REF = /^\{\{ (?:Dimension\('([a-z0-9_]+)'\)|TimeDimension\('([a-z0-9_]+)', 'day'\)) \}\}/;
const KW = new Set(['IN', 'NOT', 'IS', 'NULL', 'LIKE', 'AND', 'OR']);

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (/^\s/.test(rest)) { i += 1; continue; }
    const ref = REF.exec(rest);
    if (ref) { out.push({ t: 'ref', ref: { name: ref[1] ?? ref[2], day: ref[2] !== undefined } }); i += ref[0].length; continue; }
    if (rest[0] === "'") {
      let v = '';
      let j = 1;
      for (; j < rest.length; j += 1) {
        if (rest[j] === "'" && rest[j + 1] === "'") { v += "'"; j += 1; } else if (rest[j] === "'") break; else v += rest[j];
      }
      if (j >= rest.length) { out.push({ t: 'raw', v: rest }); break; } // an unterminated quote
      out.push({ t: 'str', v });
      i += j + 1;
      continue;
    }
    const m = /^(<>|<=|>=|=|<|>)/.exec(rest) ?? /^-?\d+(?:\.\d+)?(?![\w.])/.exec(rest) ?? /^[A-Z]+(?![\w])/.exec(rest);
    if (m && /^[<>=]/.test(m[0])) out.push({ t: 'op', v: m[0] });
    else if (m && /^-?\d/.test(m[0])) out.push({ t: 'num', v: m[0] });
    else if (m && KW.has(m[0])) out.push({ t: 'kw', v: m[0] });
    else if ('(),'.includes(rest[0])) { out.push({ t: 'p', v: rest[0] as '(' | ')' | ',' }); i += 1; continue; }
    else { const r = /^\S+/.exec(rest)![0]; out.push({ t: 'raw', v: r }); i += r.length; continue; }
    i += m[0].length;
  }
  return out;
}

/** The text Ordinate writes for one `where` entry, read back: its tree and every predicate in it (unreadable ones `raw`). */
export function parseTemplate(sql: string): { tree: TemplateTree; predicates: TemplatePredicate[] } {
  const ts = tokens(sql);
  let at = 0;
  const predicates: TemplatePredicate[] = [];
  const peek = (): Tok | undefined => ts[at];
  const is = (t: Tok['t'], v?: string): boolean => peek()?.t === t && (v === undefined || (peek() as { v?: string }).v === v);
  const raw = (): { raw: string } => {
    const parts: string[] = [];
    let depth = 0;
    while (at < ts.length && !(depth === 0 && (is('kw', 'AND') || is('kw', 'OR') || is('p', ')')))) {
      const tok = ts[at++];
      if (tok.t === 'p' && tok.v === '(') depth += 1;
      if (tok.t === 'p' && tok.v === ')') depth -= 1;
      parts.push(tok.t === 'ref' ? `{{${tok.ref.name}}}` : tok.v);
    }
    return { raw: parts.join(' ') };
  };
  const str = (): string | null => (is('str') ? (ts[at++] as { v: string }).v : null);
  const pred = (): TemplatePredicate => {
    const start = at;
    const tok = peek();
    if (tok?.t !== 'ref') return raw();
    at += 1;
    const ref = tok.ref;
    const back = (): TemplatePredicate => { at = start; return raw(); };
    if (is('op')) {
      const op = (ts[at++] as { v: string }).v as '=';
      const v = str();
      return v === null ? back() : { ref, op, value: v };
    }
    if (is('kw', 'IS')) {
      at += 1;
      const not = is('kw', 'NOT');
      if (not) at += 1;
      if (!is('kw', 'NULL')) return back();
      at += 1;
      return { ref, isNull: !not };
    }
    if (is('kw', 'LIKE')) {
      at += 1;
      const v = str();
      return v === null ? back() : { ref, like: v };
    }
    const not = is('kw', 'NOT');
    if (not) at += 1;
    if (!is('kw', 'IN')) return back();
    at += 1;
    if (!is('p', '(')) return back();
    at += 1;
    const values: string[] = [];
    for (;;) {
      const v = str();
      if (v === null) return back();
      values.push(v);
      if (is('p', ',')) { at += 1; continue; }
      if (is('p', ')')) { at += 1; break; }
      return back();
    }
    return { ref, in: values, not };
  };
  const term = (): TemplateTree => {
    if (is('p', '(')) {
      const start = at;
      at += 1;
      const inner = expr();
      if (is('p', ')')) { at += 1; return inner; }
      at = start;
    }
    const p = pred();
    predicates.push(p);
    return p;
  };
  const expr = (): TemplateTree => {
    const items = [term()];
    let joint: 'AND' | 'OR' | null = null;
    while (is('kw', 'AND') || is('kw', 'OR')) {
      const k = (ts[at++] as { v: string }).v as 'AND' | 'OR';
      if (joint && joint !== k) { const r: TemplatePredicate = { raw: `mixed ${joint} and ${k}` }; predicates.push(r); items.push(r); }
      joint = k;
      items.push(term());
    }
    return items.length === 1 ? items[0] : joint === 'OR' ? { or: items } : { and: items };
  };
  const tree = expr();
  while (at < ts.length) { // anything after the expression is a predicate nobody wrote
    const r = raw();
    if (!r.raw) at += 1;
    predicates.push(r.raw ? r : { raw: ')' });
  }
  return { tree, predicates };
}
