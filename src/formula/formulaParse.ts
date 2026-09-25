// The formula PARSER: recursive descent over the token stream, producing the
// EvalFn tree that `compile` hands back. MAIN PROCESS, PURE logic.
//
// Precedence, lowest → highest:
//   or → and → not → comparison → additive → multiplicative → unary → primary
//
// Split out of formula.ts — see .claude/rules/file-size.md. Ordinary TS module;
// the only edits to the moved code are the `export` keywords.

import { FormulaError, type Tok } from './formulaTokens';
import { type EvalFn, arith, compareOp, looseEq, num, truthy, FUNCTIONS } from './formulaEval';

// ── Parser (recursive descent) ───────────────────────────────────────────────
//
// Precedence, lowest → highest:
//   or → and → not → comparison → additive → multiplicative → unary → primary

export class Parser {
  private toks: Tok[];
  private pos = 0;
  refs: Set<string> = new Set();

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  parse(): EvalFn {
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

  private parseOr(): EvalFn {
    let left = this.parseAnd();
    while (this.isName('or')) {
      this.pos += 1;
      const right = this.parseAnd();
      const l = left;
      const r = right;
      left = (row) => truthy(l(row)) || truthy(r(row));
    }
    return left;
  }

  private parseAnd(): EvalFn {
    let left = this.parseNot();
    while (this.isName('and')) {
      this.pos += 1;
      const right = this.parseNot();
      const l = left;
      const r = right;
      left = (row) => truthy(l(row)) && truthy(r(row));
    }
    return left;
  }

  private parseNot(): EvalFn {
    if (this.isName('not')) {
      this.pos += 1;
      const e = this.parseNot();
      return (row) => !truthy(e(row));
    }
    return this.parseComparison();
  }

  private parseComparison(): EvalFn {
    let left = this.parseAdditive();
    // Membership: <expr> IN (v1, v2, …). TRUE if the left value equals any item.
    if (this.isName('in')) {
      this.pos += 1;
      this.expectPunc('(');
      const items: EvalFn[] = [];
      if (!this.isPunc(')')) {
        items.push(this.parseOr());
        while (this.isPunc(',')) {
          this.pos += 1;
          items.push(this.parseOr());
        }
      }
      this.expectPunc(')');
      const l = left;
      left = (row) => {
        const v = l(row);
        for (const it of items) if (looseEq(v, it(row))) return true;
        return false;
      };
    }
    while (this.isOp('=', '==', '!=', '>', '<', '>=', '<=')) {
      const op = this.toks[this.pos].value;
      this.pos += 1;
      const right = this.parseAdditive();
      left = compareOp(op, left, right);
    }
    return left;
  }

  private parseAdditive(): EvalFn {
    let left = this.parseMultiplicative();
    while (this.isOp('+', '-')) {
      const op = this.toks[this.pos].value;
      this.pos += 1;
      const right = this.parseMultiplicative();
      left = arith(op, left, right);
    }
    return left;
  }

  private parseMultiplicative(): EvalFn {
    let left = this.parseUnary();
    while (this.isOp('*', '/', '%')) {
      const op = this.toks[this.pos].value;
      this.pos += 1;
      const right = this.parseUnary();
      left = arith(op, left, right);
    }
    return left;
  }

  private parseUnary(): EvalFn {
    if (this.isOp('-')) {
      this.pos += 1;
      const e = this.parseUnary();
      return (row) => {
        const v = num(e(row));
        return v === null ? null : -v;
      };
    }
    if (this.isOp('+')) {
      this.pos += 1;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): EvalFn {
    const t = this.peek();
    if (!t) this.fail('Unexpected end of expression');

    if (t.kind === 'num') {
      this.pos += 1;
      const v = Number(t.value);
      return () => v;
    }

    if (t.kind === 'str') {
      this.pos += 1;
      const v = t.value;
      return () => v;
    }

    // An UNBOUND parameter. Queries that carry parameters bind them first
    // (params.bindFormulaText rewrites `[[name]]` into a literal), so what
    // reaches the parser here is a reference with no value — the stored
    // dataset, a preview — and it reads as null, which every operator and
    // function already propagates, rather than failing the whole field.
    if (t.kind === 'param') {
      this.pos += 1;
      return () => null;
    }

    if (t.kind === 'col') {
      this.pos += 1;
      const name = t.value;
      this.refs.add(name);
      return (row) => row[name] ?? null;
    }

    if (t.kind === 'name') {
      const lower = t.value.toLowerCase();
      if (lower === 'true') {
        this.pos += 1;
        return () => true;
      }
      if (lower === 'false') {
        this.pos += 1;
        return () => false;
      }
      if (lower === 'null') {
        this.pos += 1;
        return () => null;
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
      const name = t.value;
      this.refs.add(name);
      return (row) => row[name] ?? null;
    }

    if (t.kind === 'punc' && t.value === '(') {
      this.pos += 1;
      const e = this.parseOr();
      this.expectPunc(')');
      return e;
    }

    this.fail('Unexpected token: ' + t.value);
  }

  // IF <test> THEN <val> [ELSEIF <test> THEN <val>]* [ELSE <val>] END
  private parseIf(): EvalFn {
    this.pos += 1; // consume IF
    const branches: { test: EvalFn; then: EvalFn }[] = [];
    const test = this.parseOr();
    this.expectName('then');
    branches.push({ test, then: this.parseOr() });
    while (this.isName('elseif')) {
      this.pos += 1;
      const t2 = this.parseOr();
      this.expectName('then');
      branches.push({ test: t2, then: this.parseOr() });
    }
    let elseFn: EvalFn | null = null;
    if (this.isName('else')) {
      this.pos += 1;
      elseFn = this.parseOr();
    }
    this.expectName('end');
    return (row) => {
      for (const b of branches) if (truthy(b.test(row))) return b.then(row);
      return elseFn ? elseFn(row) : null;
    };
  }

  // CASE <expr> WHEN <val> THEN <result> [WHEN …]* [ELSE <default>] END
  private parseCase(): EvalFn {
    this.pos += 1; // consume CASE
    const subject = this.parseOr();
    const whens: { val: EvalFn; then: EvalFn }[] = [];
    while (this.isName('when')) {
      this.pos += 1;
      const val = this.parseOr();
      this.expectName('then');
      whens.push({ val, then: this.parseOr() });
    }
    if (whens.length === 0) this.fail('CASE requires at least one WHEN');
    let elseFn: EvalFn | null = null;
    if (this.isName('else')) {
      this.pos += 1;
      elseFn = this.parseOr();
    }
    this.expectName('end');
    return (row) => {
      const s = subject(row);
      for (const w of whens) if (looseEq(s, w.val(row))) return w.then(row);
      return elseFn ? elseFn(row) : null;
    };
  }

  private parseCall(name: string): EvalFn {
    const fn = FUNCTIONS[name.toLowerCase()];
    if (!fn) this.fail('Unknown function: ' + name);
    this.pos += 1; // consume name
    this.expectPunc('('); // consume '('
    const args: EvalFn[] = [];
    if (!this.isPunc(')')) {
      args.push(this.parseOr());
      while (this.isPunc(',')) {
        this.pos += 1;
        args.push(this.parseOr());
      }
    }
    this.expectPunc(')');
    return (row) => fn(args.map((a) => a(row)));
  }
}
