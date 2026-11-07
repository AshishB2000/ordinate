// A Live dataset's calculated fields in a statement (semantic layer part 8, step 04; docs/semantic-layer/
// 08-engine.md D7) — PURE.
//
// A statement that reads a calc reads its source through ONE derived table per calc it needs (those it
// names, and what they read, transitively), in list order:
//
//   layer 0   SELECT <declared columns still needed> FROM <source> AS lv_src [WHERE <base filters>]
//   layer k   SELECT <columns still needed>, <calc k> AS <calc k's name> FROM (<layer k−1>) AS lv_src
//   FROM item (<layer n>) AS lv_src
//
// Each layer projects only the columns still needed above it, never `*` (BigQuery bills what is read). The
// outer alias stays `lv_src`, so the statement's filters, keys, case matches and row lock read a calc
// exactly as a column. Each calc is step 03's SQL (./formulaSql `compileCalcSql`), its literals bound into
// the statement's own sink. A statement that names no calc never comes here: byte-identical to before.
//
// Refused, typed: Databricks (`calcDialect`); an input the warehouse dropped (`columnMissing`, only for the
// statements that read the calc); a calc that no longer compiles, whose type moved, or whose name a
// warehouse column now has ignoring case (`calculated` — never skipped as an unknown column); over
// MAX_CALC_SQL of derived tables, or past the connector's MAX_LIVE_PARAMS bound values (`calcTooLarge`).

import { compile } from '../../formula/formula';
import type { LiveCalc } from '../../data/liveCalcs';
import type { LiveSource } from './compile';
import type { Ctx } from './compileFilter';
import { SRC, predicate } from './compileFilter';
import type { LiveColumn, LiveFilter, LiveRefusal } from './liveSpec';
import { isRefusal, refuse } from './liveSpec';
import { MAX_CALC_SQL, compileCalcSql } from './formulaSql';
import { calcsRefusedOn } from './liveCalcCheck';
import { boundCount } from './sqlParams';
import { MAX_LIVE_PARAMS } from '../../connectors/liveParams';

/**
 * Does a statement over these column names read a calculated field? Ignoring case, as BigQuery and
 * Databricks resolve names, so a warehouse column that differs from a calc only by case is caught too.
 */
export function namesCalc(names: readonly string[], src: LiveSource): boolean {
  const calcs = src?.calcs;
  if (!calcs?.length) return false;
  const lower = new Set(calcs.map((c) => c.name.toLowerCase()));
  return names.some((n) => typeof n === 'string' && lower.has(n.toLowerCase()));
}

/** The calcs `names` read, transitively, in list order — each with the names it reads — or why one cannot run. */
function needed(calcs: readonly LiveCalc[], declared: readonly LiveColumn[], names: readonly string[]): { i: number; refs: string[] }[] | LiveRefusal {
  const has = new Set(declared.map((c) => c.name));
  const clash = new Set(declared.map((c) => c.name.toLowerCase()));
  const byLower = new Map(calcs.map((c, i) => [c.name.toLowerCase(), i]));
  const out = new Map<number, string[]>();
  const visit = (name: string): LiveRefusal | null => {
    const i = byLower.get(name.toLowerCase());
    if (i === undefined || out.has(i)) return null;
    const calc = calcs[i];
    // A warehouse column now spelled like the calc: the warehouse could read either, so neither is asked.
    if (clash.has(calc.name.toLowerCase())) return refuse('calculated', calc.name);
    const parsed = compile(calc.expression);
    if (!parsed.ok) return refuse('calculated', calc.name);
    out.set(i, parsed.fn.refs);
    for (const r of parsed.fn.refs) {
      if (has.has(r)) continue;
      const j = calcs.findIndex((c) => c.name === r);
      if (j < 0) return refuse('columnMissing', r);
      if (j >= i) return refuse('calculated', calc.name);
      const bad = visit(r);
      if (bad) return bad;
    }
    return null;
  };
  for (const n of names) {
    const bad = typeof n === 'string' ? visit(n) : null;
    if (bad) return bad;
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([i, refs]) => ({ i, refs }));
}

/**
 * The FROM item of a statement over `names` that reads calcs: the layers above `inner` (the source's own
 * FROM item, `… AS lv_src`), with the base filters in the innermost WHERE. `c.columns` is the dataset's
 * columns with its calcs; the declared ones are the rest.
 */
export function calcFrom(c: Ctx, src: LiveSource, names: readonly string[], inner: string, base: readonly LiveFilter[] = []): string | LiveRefusal {
  if (calcsRefusedOn(c.d.id)) return refuse('calcDialect');
  const calcs = src.calcs ?? [];
  const calcNames = new Set(calcs.map((x) => x.name));
  const declared = c.columns.filter((col) => !calcNames.has(col.name));
  const need = needed(calcs, declared, names);
  if (isRefusal(need)) return need;

  // Top down: what each layer must pass up — the statement's own columns, then each calc's inputs.
  const want = new Set(names.filter((n) => typeof n === 'string'));
  const keep: string[][] = [];
  for (let k = need.length - 1; k >= 0; k -= 1) {
    const own = calcs[need[k].i].name;
    want.delete(own);
    keep[k] = [...want];
    for (const r of need[k].refs) want.add(r);
  }
  const ident = (n: string): string => c.d.ident(n);
  const pass = (list: readonly string[], below: ReadonlySet<string>): string[] =>
    [...declared.map((x) => x.name), ...calcs.map((x) => x.name)].filter((n) => below.has(n) && list.includes(n)).map((n) => `${SRC}.${ident(n)} AS ${ident(n)}`);

  const preds: string[] = [];
  for (const f of base) {
    const p = predicate(c, f);
    if (isRefusal(p)) return p;
    preds.push(p);
  }
  const available = new Set(declared.map((x) => x.name));
  const first = pass([...want], available);
  let sql = `SELECT ${first.length ? first.join(', ') : '1 AS lv_one'} FROM ${inner}${preds.length ? ` WHERE ${preds.join(' AND ')}` : ''}`;
  for (let k = 0; k < need.length; k += 1) {
    const calc = calcs[need[k].i];
    const r = compileCalcSql(calc.expression, { d: c.d, b: c.b, columns: declared, earlier: calcs.slice(0, need[k].i), later: calcs.slice(need[k].i + 1) });
    // Stored typed at save: a formula that no longer compiles, or whose type moved, is never asked.
    if (!r.ok || r.type !== calc.type) return refuse('calculated', calc.name);
    const cols = [...pass(keep[k], available), `${r.sql} AS ${ident(calc.name)}`];
    sql = `SELECT ${cols.join(', ')} FROM (${sql}) AS ${SRC}`;
    available.add(calc.name);
    if (sql.length > MAX_CALC_SQL || boundCount(sql) > MAX_LIVE_PARAMS) return refuse('calcTooLarge');
  }
  return `(${sql}) AS ${SRC}`;
}
