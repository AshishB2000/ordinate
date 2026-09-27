// SQL for parse_date, dedupe_key, replace_values and conditional_column — the
// twins of src/data/stepsClean.ts. See sqlGenPower.ts for the shared contract.
//
// conditional_column is the one step whose JS side is the FORMULA ENGINE, so
// its SQL restates, op by op, what formulaEval does for the tests
// conditionalAsCalc emits — looseEq for = / !=, compareOp's "numeric when both
// sides are numbers, else text with null as ''" for the orderings, contains()
// being null (falsy) on a null cell. The differential test is what holds the
// two to the same answer.

import type { SqlColumn } from './sqlGen';
import { ORD, sqlEmpty } from './sqlGen';
import type { ConditionalColumnStep, DedupeKeyStep, ParseDateStep, ReplaceValuesStep } from '../data/stepTypes';
import { colIndex } from '../data/transforms';
import { conditionalAsCalc, parseDateProblem, planDateFormat, replaceProblem, ruleNumber } from '../data/stepsClean';
import { checkRegex, re2Source } from '../data/regexSubset';
import type { PowerSqlCtx, PowerSqlOut } from './sqlGenPower';
import { colOf, markRetype, projList, skipWith, sqlNum, sqlRank, vc } from './sqlGenPower';

const RETYPED_BAIL = { bail: 'a step reads a column typed from data by an earlier step' };

// ── parse_date ───────────────────────────────────────────────────────────────

export function genParseDate(s: ParseDateStep, ctx: PowerSqlCtx): PowerSqlOut {
  const problem = parseDateProblem(ctx.cols, s);
  if (problem) return skipWith(ctx, problem);
  const src = colOf(ctx.cols, s.column) as SqlColumn;
  if (ctx.retyped.has(src.physical)) return RETYPED_BAIL;
  const plan = planDateFormat(s.format);
  // Only space/tab trimmed (stepsClean.trimSpaceTab); the regex gate fixes every
  // digit count, so try_strptime's own leniency ('2024-2-9', ' 24-…') never decides.
  const x = `regexp_replace(${vc(src.physical)}, '^[ \\t]+|[ \\t]+$', '', 'g')`;
  const expr = `CASE WHEN ${sqlEmpty(src.physical)} THEN NULL WHEN regexp_full_match(${x}, CAST(? AS VARCHAR)) ` +
    `THEN strftime(try_strptime(${x}, CAST(? AS VARCHAR)), CAST(? AS VARCHAR)) END`;
  ctx.params.push(plan.re2, plan.strptime, plan.outFormat);
  const phys = ctx.newPhys();
  const as = typeof s.as === 'string' ? s.as.trim() : '';
  if (!as || as === s.column) {
    const cols = ctx.cols.map((c) => (c === src ? { physical: phys, name: c.name, type: 'date' as const } : c));
    const select = [ORD, ...cols.map((c) => (c.physical === phys ? `${expr} AS ${phys}` : c.physical))].join(', ');
    return { body: `SELECT ${select} FROM ${ctx.cur}`, cols };
  }
  const cols = [...ctx.cols, { physical: phys, name: as, type: 'date' as const }];
  return { body: `SELECT ${projList(ctx.cols)}, ${expr} AS ${phys} FROM ${ctx.cur}`, cols };
}

// ── dedupe_key ───────────────────────────────────────────────────────────────

export function genDedupeKey(s: DedupeKeyStep, ctx: PowerSqlCtx): PowerSqlOut {
  const warnings: string[] = [];
  const keys: SqlColumn[] = [];
  for (const name of s.columns) {
    const ci = colIndex(ctx.cols, name);
    if (ci < 0) warnings.push(`Dedupe: unknown column "${name}" ignored`);
    else keys.push(ctx.cols[ci]);
  }
  if (!keys.length) return skipWith(ctx, ...warnings, 'Dedupe skipped: none of the given columns exist');
  const ranked = s.keep === 'max' || s.keep === 'min';
  const by = ranked ? colOf(ctx.cols, s.by || '') : undefined;
  if (ranked && !by) return skipWith(ctx, ...warnings, `Dedupe skipped: unknown column "${s.by || ''}" to rank by`);
  if ([...keys, by].some((c) => c && ctx.retyped.has(c.physical))) return RETYPED_BAIL;
  // Dropping rows would move a pending data-typed column's type (the fold typed it over all of them).
  if (ctx.cols.some((c) => ctx.retype.includes(c.physical))) return RETYPED_BAIL;
  ctx.warnings.push(...warnings);
  let order = ORD;
  if (s.keep === 'last') order = `${ORD} DESC`;
  if (by) {
    const v = sqlRank(by);
    order = `(${v}) IS NULL, ${v} ${s.keep === 'max' ? 'DESC' : 'ASC'}, ${ORD}`;
  }
  const part = [...new Set(keys.map((c) => c.physical))].join(', ');
  return {
    body: `SELECT ${projList(ctx.cols)} FROM ${ctx.cur} QUALIFY row_number() OVER (PARTITION BY ${part} ORDER BY ${order}) = 1`,
  };
}

// ── replace_values ───────────────────────────────────────────────────────────

export function genReplace(s: ReplaceValuesStep, ctx: PowerSqlCtx): PowerSqlOut {
  const problem = replaceProblem(ctx.cols, s);
  if (problem) return skipWith(ctx, problem);
  const src = colOf(ctx.cols, s.column) as SqlColumn;
  if (ctx.retyped.has(src.physical)) return RETYPED_BAIL;
  const p = src.physical;
  let expr: string;
  if (s.mode === 'exact') {
    // CASE takes the FIRST matching WHEN — the fold's first-rule-wins map.
    const whens = s.rules.map((r) => {
      ctx.params.push(r.from, r.to);
      return 'WHEN CAST(? AS VARCHAR) THEN CAST(? AS VARCHAR)';
    });
    expr = `CASE coalesce(${vc(p)}, '') ${whens.join(' ')} ELSE ${vc(p)} END`;
  } else {
    // Nested innermost-first: rule 1 rewrites first, and its `?`s come first in the text.
    expr = vc(p);
    for (const r of s.rules) {
      if (s.mode === 'contains') {
        expr = `replace(${expr}, CAST(? AS VARCHAR), CAST(? AS VARCHAR))`;
        ctx.params.push(r.from, r.to);
      } else {
        const chk = checkRegex(r.from);
        expr = `regexp_replace(${expr}, CAST(? AS VARCHAR), CAST(? AS VARCHAR), 'g')`;
        // RE2's rewrite reads `\1`; doubling every backslash keeps `to` literal.
        ctx.params.push(chk.ok ? re2Source(chk.re2, !!s.ignoreCase) : '', r.to.replace(/\\/g, '\\\\'));
      }
    }
  }
  const phys = ctx.newPhys();
  const cols = ctx.cols.map((c) => (c === src ? { physical: phys, name: c.name, type: 'text' as const } : c));
  const select = [ORD, ...cols.map((c) => (c.physical === phys ? `nullif(${expr}, '') AS ${phys}` : c.physical))].join(', ');
  markRetype(ctx, phys);
  return { body: `SELECT ${select} FROM ${ctx.cur}`, cols };
}

// ── conditional_column ───────────────────────────────────────────────────────

const ORDER_OPS: Record<string, string> = { '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

/** One rule's test as a never-NULL boolean; params pushed in text order. */
function ruleTest(col: SqlColumn, op: string, value: string | number | undefined, params: (string | number | null)[]): string {
  const p = col.physical;
  const text = value === undefined ? '' : String(value);
  if (op === 'is_empty') return sqlEmpty(p);
  if (op === 'not_empty') return `NOT ${sqlEmpty(p)}`;
  if (op === 'contains') {
    params.push(text);
    return `coalesce(contains(${vc(p)}, CAST(? AS VARCHAR)), FALSE)`;
  }
  const n = ruleNumber(col.type, value);
  if (op === '=' || op === '!=') {
    let eq: string;
    if (n === null) {
      eq = `(${p} IS NOT NULL AND ${vc(p)} = CAST(? AS VARCHAR))`;
      params.push(text);
    } else {
      eq = `(${p} IS NOT NULL AND coalesce(${sqlNum(p)} = CAST(? AS DOUBLE), ${vc(p)} = CAST(? AS VARCHAR)))`;
      params.push(n, String(n));
    }
    return op === '=' ? eq : `NOT ${eq}`;
  }
  const o = ORDER_OPS[op];
  if (n === null) {
    params.push(text);
    return `coalesce(${vc(p)}, '') ${o} CAST(? AS VARCHAR)`;
  }
  params.push(n, String(n));
  return `CASE WHEN ${sqlNum(p)} IS NOT NULL THEN ${sqlNum(p)} ${o} CAST(? AS DOUBLE) ` +
    `ELSE coalesce(${vc(p)}, '') ${o} CAST(? AS VARCHAR) END`;
}

export function genConditional(s: ConditionalColumnStep, ctx: PowerSqlCtx): PowerSqlOut {
  const calc = conditionalAsCalc(ctx.cols, s);
  if (typeof calc === 'string') return skipWith(ctx, calc);
  const used = s.rules.map((r) => colOf(ctx.cols, r.when.column) as SqlColumn);
  if (used.some((c) => ctx.retyped.has(c.physical))) return RETYPED_BAIL;
  const val = (v: string | null | undefined): string => {
    if (v === null || v === undefined) return 'CAST(NULL AS VARCHAR)';
    ctx.params.push(v);
    return 'CAST(? AS VARCHAR)';
  };
  const parts = s.rules.map((r, k) => {
    const test = ruleTest(used[k], r.when.op, r.when.value, ctx.params);
    return `WHEN ${test} THEN ${val(r.then)}`;
  });
  const expr = `CASE ${parts.join(' ')} ELSE ${val(s.else)} END`;
  const phys = ctx.newPhys();
  markRetype(ctx, phys);
  const cols = [...ctx.cols, { physical: phys, name: calc.name, type: 'text' as const }];
  return { body: `SELECT ${projList(ctx.cols)}, nullif(${expr}, '') AS ${phys} FROM ${ctx.cur}`, cols };
}
