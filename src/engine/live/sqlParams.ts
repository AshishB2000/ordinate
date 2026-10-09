// Bound parameters for the live compiler — PURE. docs/live-data/00-plan.md D4.
//
// The contract (src/connectors/types.ts LiveParam): `params[i]` is the (i+1)-th
// placeholder in the statement's TEXT order, named `p<i>`, and never reused.
// Building SQL left to right and pushing values as you go keeps that only as
// long as nobody composes fragments out of order — and a CTE-shaped statement is
// composed out of order all the time. So the order is not kept, it is DERIVED:
// while the statement is built every value gets an opaque marker, and `finish`
// walks the finished text once, left to right, numbering markers as it meets
// them. A fragment that ends up in the text twice yields two parameters with
// the same value, so no placeholder is ever shared.
//
// The marker is NUL-delimited. NUL never appears in the rest of the text: an
// identifier or a source query carrying one is refused before it is spliced in
// (./compile.ts), and every other byte of the statement is the compiler's own.

import type { LiveParam } from '../../connectors/types';
import type { Binder, SqlDialect } from './dialect';

/** A finished statement: text, its parameters in placeholder order, and its output columns. */
export interface CompiledQuery {
  sql: string;
  params: LiveParam[];
  /** The output column aliases, in SELECT order — rows are read positionally. */
  columns: string[];
}

const MARKER = /\u0000(\d+)\u0000/g;

export class ParamSink implements Binder {
  private readonly values: { type: LiveParam['type']; value: string | number }[] = [];

  bind(type: LiveParam['type'], value: string | number): string {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('A live parameter must be finite');
    const id = this.values.length;
    this.values.push({ type, value });
    return `\u0000${id}\u0000`;
  }

  finish(sql: string, dialect: SqlDialect, columns: string[]): CompiledQuery {
    const params: LiveParam[] = [];
    const text = sql.replace(MARKER, (_m, id: string) => {
      const v = this.values[Number(id)];
      const p: LiveParam = { name: `p${params.length}`, type: v.type, value: v.value };
      params.push(p);
      return dialect.placeholder(params.length - 1, p);
    });
    return { sql: text, params, columns };
  }
}

/** True when a string can be spliced into a statement next to the markers. */
export function hasNul(s: string): boolean {
  return s.includes('\u0000');
}
