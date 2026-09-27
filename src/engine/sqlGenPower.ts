// SQL for the ten power steps — MAIN PROCESS, PURE string building, like sqlGen.
//
// sqlGen.generateSql hands every step it has no case for to `genPowerStep`,
// with its running state: the virtual schema, the current CTE, the bound-param
// list and the retype bookkeeping. Each family module returns ONE CTE body
// (or none, for a skip) and the schema after it. The house rules hold here too:
//
//   · guards run in TS FIRST and push the fold's warning verbatim — the guard
//     functions are the JS modules' own, so the text cannot drift;
//   · cast on the DECLARED type only; a column whose type was re-derived from
//     data by an earlier step (`retyped`) makes any step that reads it BAIL to
//     the fold rather than guess;
//   · every value is a bound `?`, pushed in the order it appears in the text;
//   · `__ord` is carried through every body, and a step that changes the row
//     multiplicity (split into rows, unpivot, union) RENUMBERS it with an
//     explicit order, so later ORDER BYs stay total.
//
// Data-dependent inputs (a pivot's keys, a lookup's duplicate count) cannot be
// known by a string builder: the step bails with `need-pivot:<i>` /
// `need-dupes:<i>` and engine/pipelinePower.ts runs the small query and retries.

import type { TransformStep } from '../data/transforms';
import type { SqlColumn } from './sqlGen';
import { ORD, sqlEmpty } from './sqlGen';
import type { WindowStep } from '../data/stepTypes';
import { windowProblem, windowType } from '../data/stepsWindow';
import { genPivot, genSplit, genUnpivot } from './sqlGenReshape';
import { genConditional, genDedupeKey, genParseDate, genReplace } from './sqlGenClean';
import { genLookup, genUnion } from './sqlGenCombine';
import { genSegment } from './sqlGenSegment';

export type Param = string | number | null;

export interface PowerSqlOpts {
  /** Other datasets loaded as relations (ORD + c0..cN), by dataset id. */
  refs?: Record<string, { relation: string; columns: SqlColumn[] }>;
  /** Why a referenced dataset is unusable — the step skips with it. */
  errors?: Record<string, string>;
  /** A pivot step's keys, resolved by pipelinePower, by step index. */
  pivots?: Record<number, { keys: string[]; distinct: number }>;
  /** A lookup step's repeated right-key count, by step index. */
  dupes?: Record<number, number>;
}

export interface PowerSqlCtx {
  index: number;
  cols: SqlColumn[];
  cur: string;
  params: Param[];
  warnings: string[];
  retype: string[];
  retyped: Set<string>;
  /** The columns a POWER step typed from data — sqlGen bails a later row-dropping step. */
  powerRetype: Set<string>;
  newPhys: () => string;
  opts: PowerSqlOpts;
}

/** `body` undefined = the step skipped (warning pushed, no CTE). */
export interface PowerSqlOut {
  body?: string;
  cols?: SqlColumn[];
  bail?: string;
}

// ── Shared expression helpers ────────────────────────────────────────────────

export const vc = (p: string): string => `CAST(${p} AS VARCHAR)`;

/** A finite number or NULL — sqlGen's rule for a `number` column. */
export function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

/** The non-empty text of a cell, or NULL — stepsClean.rankValue for a non-number column. */
export function sqlText(p: string): string {
  return `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${vc(p)} END`;
}

/** rankValue in SQL: numbers on the declared type, else non-empty text. */
export function sqlRank(col: SqlColumn, prefix = ''): string {
  return col.type === 'number' ? sqlNum(prefix + col.physical) : sqlText(prefix + col.physical);
}

export function projList(cols: SqlColumn[], override?: Map<string, string>, prefix = ''): string {
  return [prefix + ORD, ...cols.map((c) => {
    const ex = override && override.get(c.physical);
    return ex ? `${ex} AS ${c.physical}` : prefix + c.physical;
  })].join(', ');
}

export function markRetype(ctx: PowerSqlCtx, phys: string): void {
  if (!ctx.retype.includes(phys)) ctx.retype.push(phys);
  ctx.retyped.add(phys);
  ctx.powerRetype.add(phys);
}

export function colOf(cols: SqlColumn[], name: string): SqlColumn | undefined {
  return cols.find((c) => c.name === name);
}

export function skipWith(ctx: PowerSqlCtx, ...warnings: string[]): PowerSqlOut {
  ctx.warnings.push(...warnings);
  return {};
}

export function quoteRel(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── window ───────────────────────────────────────────────────────────────────

function genWindow(s: WindowStep, ctx: PowerSqlCtx): PowerSqlOut {
  const problem = windowProblem(ctx.cols, s);
  if (problem) return skipWith(ctx, problem);
  const val = s.fn === 'row_number' ? undefined : colOf(ctx.cols, s.column || '');
  const part = (s.partitionBy || []).map((p) => colOf(ctx.cols, p) as SqlColumn);
  const ord = s.orderBy ? colOf(ctx.cols, s.orderBy) : undefined;
  if ([val, ord, ...part].some((c) => c && ctx.retyped.has(c.physical))) {
    return { bail: 'window over a column typed from data by an earlier step' };
  }
  const order = ord ? `${sqlRank(ord)} ${s.desc ? 'DESC' : 'ASC'} NULLS LAST, ${ORD}` : ORD;
  const over = `${part.length ? `PARTITION BY ${part.map((c) => c.physical).join(', ')} ` : ''}ORDER BY ${order}`;
  const running = `OVER (${over} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  const offset = Math.max(1, Math.floor(s.offset || 1));
  let expr: string;
  if (s.fn === 'row_number') expr = `CAST(row_number() OVER (${over}) AS DOUBLE)`;
  else if (s.fn === 'lag' || s.fn === 'lead') expr = `${s.fn}(${(val as SqlColumn).physical}, ${offset}) OVER (${over})`;
  else if ((val as SqlColumn).type !== 'number') expr = 'CAST(NULL AS DOUBLE)';
  else {
    const n = sqlNum((val as SqlColumn).physical);
    expr = s.fn === 'running_sum'
      ? `CAST(sum(${n}) ${running} AS DOUBLE)`
      : `CAST(sum(${n}) ${running} / nullif(count(${n}) ${running}, 0) AS DOUBLE)`;
  }
  const phys = ctx.newPhys();
  const cols = [...ctx.cols, { physical: phys, name: s.as.trim(), type: windowType(ctx.cols, s) }];
  return { body: `SELECT ${projList(ctx.cols)}, ${expr} AS ${phys} FROM ${ctx.cur}`, cols };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** SQL for one power step, or null when the type is not one of them. */
export function genPowerStep(step: TransformStep, ctx: PowerSqlCtx): PowerSqlOut | null {
  switch (step.type) {
    case 'split_column':
      return genSplit(step, ctx);
    case 'unpivot':
      return genUnpivot(step, ctx);
    case 'pivot':
      return genPivot(step, ctx);
    case 'parse_date':
      return genParseDate(step, ctx);
    case 'dedupe_key':
      return genDedupeKey(step, ctx);
    case 'replace_values':
      return genReplace(step, ctx);
    case 'conditional_column':
      return genConditional(step, ctx);
    case 'union':
      return genUnion(step, ctx);
    case 'lookup_join':
      return genLookup(step, ctx);
    case 'window':
      return genWindow(step, ctx);
    case 'segment':
      return genSegment(step, ctx);
    default:
      return null;
  }
}
