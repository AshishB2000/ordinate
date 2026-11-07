// The ONE way a value reaches dbt's filter text (semantic layer part 7, d1; docs/live-data/dbt-semantic-layer.md,
// "Filters") — PURE.
//
// dbt's `where` is Jinja over the warehouse's SQL, `{{ Dimension('customer__customer_type') }} = 'new'`, with no bind
// parameter, so a value is written into text. This closed encoder writes only what it can write exactly and refuses
// the rest; the caller turns a refusal into `layerFilter`, never a dropped filter:
//
//   text     1–200 characters, each a letter, a mark, a digit, a space or one of _ . , : ; / & ( ) # @ + % -, quoted
//            with '. Nothing in the class opens a Jinja tag ({ is out), escapes (\ is out: BigQuery and Databricks read
//            it), ends the quote (' is out: Databricks reads '' as two literals run together, BigQuery as an error), or
//            breaks a line; quote look-alikes are outside it.
//   date     an ISO day that is a real day, quoted.
//   number   finite, `String(n)` only when it reads ^-?\d+(\.\d+)?$ (no exponent).
//   NULL     never a literal: only IS NULL / IS NOT NULL.
//   names    `{{ Dimension('…') }}` only for the dataset's synced dimensions, each a dbt identifier.
//
// `whereText` writes one Ordinate filter as one `where` entry, meaning what it means on an extract (../compileFilter is
// the reference: a NULL compares as '', a date as its ISO day). scripts/test-semanticLiterals.ts fuzzes it.

import type { ColumnType } from '../../../data/parse';
import type { Cell } from '../../../data/transforms';
import type { LiveColumn, LiveRefusal } from '../liveSpec';
import { columnOf, refuse } from '../liveSpec';
import { isoDay } from './cube';
import { refuseLayer } from './semanticRefusals';
import type { SemanticFilter } from './semanticQuery';

// Letters include modifier apostrophes and primes (U+02B9–U+02C1, U+02C8–U+02CB): quote look-alikes, kept out.
const TEXT = /^(?:(?![\u02b9-\u02c1\u02c8-\u02cb])[\p{L}\p{M}\p{N} _.,:;/&()#@+%-]){1,200}$/u; // 1–200 code points
const NUMBER = /^-?\d+(\.\d+)?$/;
/** A dbt dimension name as the filter may write it. */
export const DBT_NAME_RE = /^[a-z_][a-z0-9_]*(__[a-z0-9_]+)*$/;

export type Literal = { ok: true; text: string } | { ok: false };

/** `value` as `type`'s literal in dbt's filter text, or refused. */
export function literal(value: Cell, type: ColumnType): Literal {
  if (type === 'number') {
    const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return NUMBER.test(s) ? { ok: true, text: s } : { ok: false };
  }
  if (typeof value !== 'string' && typeof value !== 'number') return { ok: false };
  const s = String(value);
  if (type === 'date') return isoDay(s) ? { ok: true, text: `'${s}'` } : { ok: false };
  if (!TEXT.test(s)) return { ok: false };
  return { ok: true, text: `'${s}'` };
}

/** The template reference to a synced dimension (a date one at the day grain), or null. */
export function dimensionRef(name: string, synced: ReadonlySet<string>, day = false): string | null {
  if (!synced.has(name) || !DBT_NAME_RE.test(name)) return null;
  return day ? `{{ TimeDimension('${name}', 'day') }}` : `{{ Dimension('${name}') }}`;
}

class Refused {
  constructor(readonly refusal: LiveRefusal) {}
}

/** One filter as one `where` entry's text, or why not (`names` word the refusal). */
export function whereText(f: SemanticFilter, columns: readonly LiveColumn[], names: { dataset: string; layer: string }): { ok: true; text: string } | LiveRefusal {
  const col = columnOf(columns.slice(), f.column);
  if (!col) return refuse('unknownColumn', f.column);
  if ('binary' in f && f.binary) return refuseLayer('layerRowPolicy', names); // the plan refuses it first (D17)
  const no = (): never => {
    throw new Refused(refuseLayer('layerFilter', { ...names, column: col.name }));
  };
  if (col.type === 'number') {
    // dbt types no dimension a number (docs/live-data/dbt-semantic-layer.md): a record that says so was not synced from it.
    if (f.kind === 'contains') return refuse('containsNumber', col.name);
    if (f.kind === 'range') return refuse('periodNotDate', col.name);
    return refuseLayer('layerFilter', { ...names, column: col.name });
  }
  const date = col.type === 'date';
  const D = dimensionRef(col.name, new Set(columns.map((c) => c.name)), date) ?? no();
  const lit = (v: Cell): string => {
    const r = literal(v, date ? 'date' : 'text');
    return r.ok ? r.text : no();
  };
  const blank = (v: Cell): boolean => v == null || v === '';
  try {
    switch (f.kind) {
      case 'compare': {
        if (blank(f.value)) {
          if (date) return no(); // '' against a day: no exact comparison
          if (f.op === '=') return { ok: true, text: `(${D} = '' OR ${D} IS NULL)` };
          if (f.op === '!=') return { ok: true, text: `${D} <> ''` };
          return no();
        }
        const v = lit(f.value);
        if (f.op === '=') return { ok: true, text: `${D} = ${v}` };
        if (f.op === '!=') return { ok: true, text: `(${D} <> ${v} OR ${D} IS NULL)` };
        if (!date) return no(); // a categorical dimension's SQL type, so its order, is unknown
        if (f.op === '>' || f.op === '>=') return { ok: true, text: `${D} ${f.op} ${v}` };
        return { ok: true, text: `(${D} ${f.op} ${v} OR ${D} IS NULL)` }; // a NULL compares as '': before every day
      }
      case 'in': {
        const vs = [...new Set(f.values.filter((v) => !blank(v)).map(lit))];
        const hasBlank = f.values.some(blank);
        if (!vs.length && !hasBlank) return no();
        const list = `(${vs.join(', ')})`;
        if (!f.negate) {
          const orBlank = date ? `${D} IS NULL` : `${D} = '' OR ${D} IS NULL`;
          if (!hasBlank) return { ok: true, text: `${D} IN ${list}` };
          return { ok: true, text: vs.length ? `(${D} IN ${list} OR ${orBlank})` : `(${orBlank})` };
        }
        if (!hasBlank) return { ok: true, text: `(${D} NOT IN ${list} OR ${D} IS NULL)` };
        const notBlank = date ? `${D} IS NOT NULL` : `${D} <> ''`;
        return { ok: true, text: vs.length ? (date ? `${D} NOT IN ${list}` : `(${D} NOT IN ${list} AND ${notBlank})`) : notBlank };
      }
      case 'contains': {
        // LIKE is case-sensitive, as Ordinate's contains; a needle with % or _ would need an escape, which differs by warehouse.
        if (date || !f.value || /[%_]/.test(f.value)) return no();
        return { ok: true, text: `${D} LIKE ${lit(`%${f.value}%`)}` };
      }
      case 'empty':
        if (!date) return no(); // a whitespace-only cell is empty in Ordinate; SQL's whitespace test differs by warehouse
        return { ok: true, text: `${D} IS ${f.negate ? 'NOT ' : ''}NULL` };
      case 'range': {
        if (!date) return refuse('periodNotDate', col.name);
        const parts = [...(f.from ? [`${D} >= ${lit(f.from)}`] : []), ...(f.to ? [`${D} <= ${lit(f.to)}`] : [])];
        return { ok: true, text: parts.length === 0 ? `${D} IS NOT NULL` : parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})` };
      }
      default:
        return refuse('badQuery');
    }
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
}
