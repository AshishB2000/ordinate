// The formula PARSER: recursive descent over the token stream, calling a
// FormulaBuilder at each rule (formulaBuilder.ts; `compile` hands it the JS one,
// formulaJs.ts). MAIN PROCESS, PURE logic.
//
// Precedence, lowest → highest:
//   or → and → not → comparison → additive → multiplicative → unary → primary
//
// Split out of formula.ts — see .claude/rules/file-size.md. Ordinary TS module;
// the only edits to the moved code are the `export` keywords.

import { FormulaError, type Tok } from './formulaTokens';
import { type EvalFn, FUNCTIONS } from './formulaEval';
import type { ArithOp, CompareOp, FormulaBuilder } from './formulaBuilder';

// ── Parser (recursive descent) ───────────────────────────────────────────────
//
// Precedence, lowest → highest:
//   or → and → not → comparison → additive → multiplicative → unary → primary

// ── Level of detail ──────────────────────────────────────────────────────────
//
// `{FIXED [Region], [Segment] : SUM([Sales])}` — Tableau's grammar, keywords
// case-insensitive, no dimensions (`{FIXED : SUM([Sales])}`) meaning the whole
// table. The body is exactly ONE aggregate over a row-level expression.
//
// An LOD is a ROW-LEVEL value: the aggregate at that row's group. The parser
// cannot compute it — it needs every row — so it hands the builder the parts of
// a `LodSpec`; the JS builder records it and returns a reader of the row-map
// slot `@lod:<n>`, which formula/lod.ts fills before the row is evaluated. `@` cannot start a token, so no column a user
// can name collides with the slot. A nested LOD is recorded before the one
// around it, so filling slots in index order is filling them in dependency
// order.

export type LodKind = 'fixed' | 'include' | 'exclude';
export type LodAgg = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countd';
export const LOD_AGGS: ReadonlySet<string> = new Set<LodAgg>(['sum', 'avg', 'min', 'max', 'count', 'countd']);

/** A dimension as written, with the source span an error underlines. */
export interface LodDim {
  name: string;
  start: number;
  end: number;
}

export interface LodSpec {
  /** The row-map slot the compiled expression reads this LOD's value from. */
  key: string;
  kind: LodKind;
  dims: LodDim[];
  agg: LodAgg;
  /** The row-level expression inside the aggregate. */
  arg: EvalFn;
  /** The argument when it is ONE bare column reference — the resident path's precondition. */
  argCol: string | null;
  /** True when the argument itself contains an LOD. */
  nested: boolean;
  /** The argument's token count — what one row of it costs the work budget (formulaBudget.ts). */
  cost?: number;
  /** Source offsets of the whole `{…}`. */
  start: number;
  end: number;
}

const LITERAL_NAMES = new Set(['true', 'false', 'null']);

/** Parse `tokens` through `b`. Throws FormulaError, carrying the token it is about. */
export function parseTokens<T>(tokens: Tok[], b: FormulaBuilder<T>): { root: T; refs: string[] } {
  const parser = new Parser(tokens, b);
  const root = parser.parse();
  return { root, refs: Array.from(parser.refs) };
}

class Parser<T> {
  private toks: Tok[];
  private b: FormulaBuilder<T>;
  private pos = 0;
  /** LODs built so far: an `@lod:<n>` key and the `nested` flag count them. */
  private lodCount = 0;
  refs: Set<string> = new Set();

  constructor(toks: Tok[], b: FormulaBuilder<T>) {
    this.toks = toks;
    this.b = b;
  }

  parse(): T {
    const fn = this.parseOr();
    if (this.pos < this.toks.length) {
      this.fail('Unexpected token: ' + this.toks[this.pos].value);
    }
    return fn;
  }

  // EVERY parser error goes through here, so every one of them carries the
  // token it is complaining about. The editor underlines that token; without a
  // position a message like "Unexpected token: /" makes the user hunt for which
  // "/" in a long expression is the wrong one.
  private fail(message: string): never {
    const e = new FormulaError(message);
    e.tokenIndex = this.pos;
    throw e;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private isName(word: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'name' && t.value.toLowerCase() === word;
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return !!t && t.kind === 'op' && ops.includes(t.value);
  }

  private isPunc(value: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punc' && t.value === value;
  }

  private expectPunc(value: string): void {
    if (!this.isPunc(value)) {
      const got = this.peek();
      this.fail(`Expected "${value}" but got ${got ? got.value : 'end of input'}`);
    }
    this.pos += 1;
  }

  private expectName(word: string): void {
    if (!this.isName(word)) {
      const got = this.peek();
      this.fail(`Expected "${word.toUpperCase()}" but got ${got ? got.value : 'end of input'}`);
    }
    this.pos += 1;
  }

  private parseOr(): T {
    let left = this.parseAnd();
    while (this.isName('or')) {
      const at = this.pos;
      this.pos += 1;
      const right = this.parseAnd();
      left = this.b.or(left, right, at);
    }
    return left;
  }

  private parseAnd(): T {
    let left = this.parseNot();
    while (this.isName('and')) {
      const at = this.pos;
      this.pos += 1;
      const right = this.parseNot();
      left = this.b.and(left, right, at);
    }
    return left;
  }

  private parseNot(): T {
    if (this.isName('not')) {
      const at = this.pos;
      this.pos += 1;
      const e = this.parseNot();
      return this.b.not(e, at);
    }
    return this.parseComparison();
  }

  private parseComparison(): T {
    let left = this.parseAdditive();
    // Membership: <expr> IN (v1, v2, …). TRUE if the left value equals any item.
    // It binds ONCE, before the comparison loop: `a IN (1) = TRUE` is `(a IN (1)) = TRUE`.
    if (this.isName('in')) {
      const at = this.pos;
      this.pos += 1;
      this.expectPunc('(');
      const items: T[] = [];
      if (!this.isPunc(')')) {
        items.push(this.parseOr());
        while (this.isPunc(',')) {
          this.pos += 1;
          items.push(this.parseOr());
        }
      }
      this.expectPunc(')');
      left = this.b.inList(left, items, at);
    }
    while (this.isOp('=', '==', '!=', '>', '<', '>=', '<=')) {
      const at = this.pos;
      const op = this.toks[this.pos].value as CompareOp;
      this.pos += 1;
      const right = this.parseAdditive();
      left = this.b.compare(op, left, right, at);
    }
    return left;
  }

  private parseAdditive(): T {
    let left = this.parseMultiplicative();
    while (this.isOp('+', '-')) {
      const at = this.pos;
      const op = this.toks[this.pos].value as ArithOp;
      this.pos += 1;
      const right = this.parseMultiplicative();
      left = this.b.arith(op, left, right, at);
    }
    return left;
  }

  private parseMultiplicative(): T {
    let left = this.parseUnary();
    while (this.isOp('*', '/', '%')) {
      const at = this.pos;
      const op = this.toks[this.pos].value as ArithOp;
      this.pos += 1;
      const right = this.parseUnary();
      left = this.b.arith(op, left, right, at);
    }
    return left;
  }

  private parseUnary(): T {
    if (this.isOp('-')) {
      const at = this.pos;
      this.pos += 1;
      const e = this.parseUnary();
      return this.b.neg(e, at);
    }
    if (this.isOp('+')) {
      this.pos += 1;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): T {
    const t = this.peek();
    if (!t) this.fail('Unexpected end of expression');
    const at = this.pos;

    if (t.kind === 'num') {
      this.pos += 1;
      return this.b.num(Number(t.value), at);
    }

    if (t.kind === 'str') {
      this.pos += 1;
      return this.b.str(t.value, at);
    }

    // An UNBOUND parameter. Queries that carry parameters bind them first
    // (params.bindFormulaText rewrites `[[name]]` into a literal), so what
    // reaches the parser here is a reference with no value — the stored
    // dataset, a preview — and it reads as null, which every operator and
    // function already propagates, rather than failing the whole field.
    if (t.kind === 'param') {
      this.pos += 1;
      return this.b.param(at);
    }

    if (t.kind === 'col') {
      this.pos += 1;
      this.refs.add(t.value);
      return this.b.col(t.value, at);
    }

    if (t.kind === 'name') {
      const lower = t.value.toLowerCase();
      if (lower === 'true') {
        this.pos += 1;
        return this.b.bool(true, at);
      }
      if (lower === 'false') {
        this.pos += 1;
        return this.b.bool(false, at);
      }
      if (lower === 'null') {
        this.pos += 1;
        return this.b.nul(at);
      }
      const next = this.toks[this.pos + 1];
      const callForm = next && next.kind === 'punc' && next.value === '(';
      // IF … THEN … [ELSEIF …] [ELSE …] END — the keyword form (the function form
      // if(cond, then, else) is still available when followed directly by "(").
      if (lower === 'if' && !callForm) return this.parseIf();
      if (lower === 'case') return this.parseCase();
      // function call when the identifier is immediately followed by '('
      if (callForm) {
        return this.parseCall(t.value);
      }
      // otherwise a bare column reference
      this.pos += 1;
      this.refs.add(t.value);
      return this.b.col(t.value, at);
    }

    if (t.kind === 'punc' && t.value === '(') {
      this.pos += 1;
      const e = this.parseOr();
      this.expectPunc(')');
      return e;
    }

    if (t.kind === 'punc' && t.value === '{') return this.parseLod();

    this.fail('Unexpected token: ' + t.value);
  }

  // IF <test> THEN <val> [ELSEIF <test> THEN <val>]* [ELSE <val>] END
  private parseIf(): T {
    const at = this.pos;
    this.pos += 1; // consume IF
    const branches: { test: T; then: T }[] = [];
    const test = this.parseOr();
    this.expectName('then');
    branches.push({ test, then: this.parseOr() });
    while (this.isName('elseif')) {
      this.pos += 1;
      const t2 = this.parseOr();
      this.expectName('then');
      branches.push({ test: t2, then: this.parseOr() });
    }
    let elseFn: T | null = null;
    if (this.isName('else')) {
      this.pos += 1;
      elseFn = this.parseOr();
    }
    this.expectName('end');
    return this.b.ifThen(branches, elseFn, at);
  }

  // CASE <expr> WHEN <val> THEN <result> [WHEN …]* [ELSE <default>] END
  private parseCase(): T {
    const at = this.pos;
    this.pos += 1; // consume CASE
    const subject = this.parseOr();
    const whens: { val: T; then: T }[] = [];
    while (this.isName('when')) {
      this.pos += 1;
      const val = this.parseOr();
      this.expectName('then');
      whens.push({ val, then: this.parseOr() });
    }
    if (whens.length === 0) this.fail('CASE requires at least one WHEN');
    let elseFn: T | null = null;
    if (this.isName('else')) {
      this.pos += 1;
      elseFn = this.parseOr();
    }
    this.expectName('end');
    return this.b.caseWhen(subject, whens, elseFn, at);
  }

  // { FIXED|INCLUDE|EXCLUDE [dim], … : AGG(<expr>) }
  private parseLod(): T {
    const at = this.pos;
    const open = this.toks[this.pos];
    this.pos += 1; // consume {
    const kw = this.peek();
    const kind = kw && kw.kind === 'name' ? kw.value.toLowerCase() : '';
    if (kind !== 'fixed' && kind !== 'include' && kind !== 'exclude') {
      this.fail('Expected FIXED, INCLUDE or EXCLUDE after "{"');
    }
    this.pos += 1;
    const dims: LodDim[] = [];
    if (!this.isPunc(':')) {
      for (;;) {
        const d = this.peek();
        if (!d || (d.kind !== 'col' && d.kind !== 'name')) {
          this.fail(`Expected a dimension like [Region] or ":" but got ${d ? d.value : 'end of input'}`);
        }
        if (!dims.some((x) => x.name === d.value)) dims.push({ name: d.value, start: d.start, end: d.end });
        this.refs.add(d.value);
        this.pos += 1;
        if (!this.isPunc(',')) break;
        this.pos += 1;
      }
    }
    this.expectPunc(':');
    const fnTok = this.peek();
    const agg = fnTok && fnTok.kind === 'name' ? fnTok.value.toLowerCase() : '';
    if (!LOD_AGGS.has(agg)) {
      this.fail('Expected one aggregate (SUM, AVG, MIN, MAX, COUNT or COUNTD) after ":"');
    }
    this.pos += 1;
    this.expectPunc('(');
    const before = this.lodCount;
    const argAt = this.pos;
    const arg = this.parseOr();
    const only = this.toks[argAt];
    const bare = this.pos - argAt === 1 && !!only &&
      (only.kind === 'col' || (only.kind === 'name' && !LITERAL_NAMES.has(only.value.toLowerCase())));
    this.expectPunc(')');
    const close = this.peek();
    this.expectPunc('}');
    const key = '@lod:' + this.lodCount;
    const nested = this.lodCount > before;
    this.lodCount += 1;
    return this.b.lod({
      key, kind: kind as LodKind, dims, agg: agg as LodAgg, arg,
      argCol: bare ? only.value : null,
      nested,
      cost: this.pos - argAt,
      start: open.start,
      end: close ? close.end : open.end,
    }, at);
  }

  private parseCall(name: string): T {
    const at = this.pos;
    const lower = name.toLowerCase();
    // Own names only: FUNCTIONS is an object literal, and what it inherits (`constructor`) is no function of ours.
    if (!Object.hasOwn(FUNCTIONS, lower)) this.fail('Unknown function: ' + name);
    this.pos += 1; // consume name
    this.expectPunc('('); // consume '('
    const args: T[] = [];
    if (!this.isPunc(')')) {
      args.push(this.parseOr());
      while (this.isPunc(',')) {
        this.pos += 1;
        args.push(this.parseOr());
      }
    }
    this.expectPunc(')');
    return this.b.call(lower, args, at);
  }
}
