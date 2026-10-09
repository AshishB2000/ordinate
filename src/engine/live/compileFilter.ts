// Column readings and filter predicates for the live compiler — PURE.
// docs/live-data/00-plan.md L2.2.
//
// The live twin of `residentFilter.ts` + `residentCategory.ts`'s primitives,
// over a warehouse's TYPED columns instead of our all-VARCHAR Parquet. The
// rules are the extract's, stated once per reading:
//
//   number  the dialect's safe cast, kept only when FINITE (a stored extract
//           only ever holds finite numbers — parse.isFiniteNumber);
//   text    the value as text; NULL compares as '' (`transforms.cellToString`);
//   date    a DATE for bucketing and periods; for text comparisons its
//           'YYYY-MM-DD' day — what an extract of a DATE column stores.
//
// Every value is a bound parameter (D4). `transforms.stepFilter` is the
// reference for every operator; each branch below names the line it mirrors.

import type { Cell } from '../../data/transforms';
import { coerceValue } from '../../data/parse';
import type { LiveColumn, LiveFilter, LiveRefusal } from './liveSpec';
import { columnOf, refuse } from './liveSpec';
import type { SqlDialect } from './dialect';
import { isTextSourceType, likePattern } from './dialect';
import type { ParamSink } from './sqlParams';

/** The source relation's alias. Every column is read qualified by it. */
export const SRC = 'lv_src';

export interface Ctx {
  d: SqlDialect;
  b: ParamSink;
  columns: LiveColumn[];
}

const SQL_OP: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

/** `CASE WHEN x IS NULL THEN 1 ELSE 0 END` — a portable NULLS LAST. */
export function nullsLast(x: string): string {
  return `CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END`;
}

export function colRef(c: Ctx, col: LiveColumn): string {
  return `${SRC}.${c.d.ident(col.name)}`;
}

function storedAsText(col: LiveColumn): boolean {
  return isTextSourceType(col.sourceType);
}

/** A `number` column as a finite double, else NULL. */
export function numberOf(c: Ctx, col: LiveColumn): string {
  return c.d.number(colRef(c, col), storedAsText(col));
}

/** A `date` column as a DATE, else NULL. */
export function dateOf(c: Ctx, col: LiveColumn): string {
  return c.d.date(colRef(c, col), storedAsText(col), col.sourceType ?? '');
}

export function textOf(c: Ctx, col: LiveColumn): string {
  return c.d.text(colRef(c, col));
}

/**
 * The text an extract compares this cell by. A date the warehouse holds as a
 * DATE is compared by its ISO day — the text an extract of it holds. (An
 * extract of a TIMESTAMP holds the time too; that divergence is documented in
 * docs/live-data/log.md and pinned by test-liveCompile.)
 */
function compareText(c: Ctx, col: LiveColumn): string {
  if (col.type === 'date' && !storedAsText(col)) return c.d.isoDay(dateOf(c, col));
  return textOf(c, col);
}

/**
 * TRUE when the cell is empty to `transforms.isEmptyCell` — null, '' or JS
 * whitespace. Never NULL. A number column's cell is empty exactly when it holds
 * no finite number (that is what an extract stores there: a number or null); a
 * DATE column's exactly when it is NULL.
 */
export function emptyOf(c: Ctx, col: LiveColumn): string {
  if (col.type === 'number') return `(${numberOf(c, col)} IS NULL)`;
  if (col.type === 'date' && !storedAsText(col)) return `(${colRef(c, col)} IS NULL)`;
  return c.d.blank(textOf(c, col), c.b);
}

function cellText(cell: Cell): string {
  return cell == null ? '' : String(cell);
}

/** One IR filter as a never-NULL SQL predicate, or a refusal. */
export function predicate(c: Ctx, f: LiveFilter): string | LiveRefusal {
  const col = columnOf(c.columns, f.column);
  if (!col) return refuse('unknownColumn', f.column);

  switch (f.kind) {
    case 'empty': {
      const e = emptyOf(c, col);
      return f.negate ? `(NOT ${e})` : e;
    }
    case 'contains': {
      // transforms: `cellToString(cell).includes(needle)` — case-SENSITIVE, a
      // null cell is '', an empty needle matches every row. LIKE is
      // case-sensitive in all six dialects; `%`, `_` and the escape are escaped.
      if (col.type === 'number') return refuse('containsNumber', col.name);
      const pattern = c.b.bind('text', likePattern(f.value, c.d.likeEscape));
      return `(${c.d.like(`coalesce(${compareText(c, col)}, '')`, pattern)})`;
    }
    case 'in': {
      let inner: string;
      if (col.type === 'number') {
        // transforms: entries through the strict number gate; an entry that is
        // not a finite number can never match and is dropped. None left → FALSE.
        const targets = new Set<number>();
        for (const v of f.values) {
          const n = coerceValue(v ?? null, 'number');
          if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
        }
        inner = targets.size === 0
          ? 'FALSE'
          : `coalesce(${numberOf(c, col)} IN (${[...targets].map((n) => c.b.bind('number', n)).join(', ')}), FALSE)`;
      } else {
        const targets = new Set<string>(f.values.map((v) => cellText(v)));
        inner = `(coalesce(${compareText(c, col)}, '') IN (${[...targets].map((t) => c.b.bind('text', t)).join(', ')}))`;
      }
      // `not in` is the EXACT complement: a null cell is in no list, so it stays.
      return f.negate ? `(NOT ${inner})` : inner;
    }
    case 'range': {
      // dateIntel.periodDay / answers' ISO bounds: inclusive, a cell with no date is out.
      if (col.type !== 'date') return refuse('periodNotDate', col.name);
      const d = dateOf(c, col);
      const parts = [`${d} IS NOT NULL`];
      if (f.from) parts.push(`${d} >= ${c.b.bind('date', f.from)}`);
      if (f.to) parts.push(`${d} <= ${c.b.bind('date', f.to)}`);
      return `(${parts.join(' AND ')})`;
    }
    case 'latest':
      return refuse('unresolvedPeriod');
    case 'compare': {
      if (!SQL_OP[f.op]) return refuse('badQuery');
      if (col.type === 'number') {
        // transforms: the target through coerceValue (so '007' is no number and
        // the filter keeps nothing, `!=` included); a null cell is false for
        // every operator.
        const t = coerceValue(f.value ?? null, 'number');
        if (typeof t !== 'number' || !Number.isFinite(t)) return 'FALSE';
        return `(${numberOf(c, col)} ${SQL_OP[f.op]} ${c.b.bind('number', t)})`;
      }
      // Text and date compare as text, a null cell as '' — so `!=` and `<` keep it.
      return `(coalesce(${compareText(c, col)}, '') ${SQL_OP[f.op]} ${c.b.bind('text', cellText(f.value))})`;
    }
    default:
      return refuse('badQuery');
  }
}
