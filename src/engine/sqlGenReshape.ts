// SQL for split_column, unpivot and pivot — the twins of src/data/stepsReshape.ts.
// See sqlGenPower.ts for the shared contract.

import type { SqlColumn } from './sqlGen';
import { ORD, sqlEmpty } from './sqlGen';
import type { PivotStep, SplitColumnStep, UnpivotStep } from '../data/stepTypes';
import { colIndex } from '../data/transforms';
import {
  pivotCapWarning, pivotClash, pivotProblem, splitNames, splitProblem, splitWidth, unpivotNameProblem,
} from '../data/stepsReshape';
import { checkRegex, re2Source } from '../data/regexSubset';
import type { PowerSqlCtx, PowerSqlOut } from './sqlGenPower';
import { colOf, markRetype, projList, skipWith, sqlNum, vc } from './sqlGenPower';

// ── split_column ─────────────────────────────────────────────────────────────

/** The parts of `p` as a VARCHAR[] (delimiter/regex) — NULL in, NULL out. */
function partsList(s: SplitColumnStep, p: string, ctx: PowerSqlCtx): string {
  if (s.mode === 'delimiter') {
    ctx.params.push(s.delimiter as string);
    return `string_split(${vc(p)}, CAST(? AS VARCHAR))`;
  }
  const chk = checkRegex(s.pattern);
  ctx.params.push(chk.ok ? re2Source(chk.re2, !!s.ignoreCase) : '');
  return `regexp_split_to_array(${vc(p)}, CAST(? AS VARCHAR))`;
}

/** Code-point substrings at the cut points — DuckDB's substring counts characters. */
function positionParts(s: SplitColumnStep, p: string): string[] {
  const cuts = [0, ...(s.positions as number[])];
  return cuts.map((a, k) =>
    k + 1 < cuts.length ? `substring(${vc(p)}, ${a + 1}, ${cuts[k + 1] - a})` : `substring(${vc(p)}, ${a + 1})`);
}

export function genSplit(s: SplitColumnStep, ctx: PowerSqlCtx): PowerSqlOut {
  const ci = colIndex(ctx.cols, s.column);
  if (ci < 0) return skipWith(ctx, `Split skipped: unknown column "${s.column}"`);
  const problem = splitProblem(s);
  if (problem) return skipWith(ctx, problem);
  const src = ctx.cols[ci];
  if (ctx.retyped.has(src.physical)) return { bail: 'split over a column typed from data by an earlier step' };

  if (s.into === 'rows') {
    const phys = ctx.newPhys();
    const others = ctx.cols.filter((_, k) => k !== ci);
    // A NULL cell stays one row: [NULL] unnests to exactly one.
    const list = s.mode === 'position'
      ? `list_value(${positionParts(s, src.physical).join(', ')})`
      : partsList(s, src.physical, ctx);
    const inner = `SELECT ${projList(ctx.cols)}, CASE WHEN ${src.physical} IS NULL THEN list_value(CAST(NULL AS VARCHAR)) ELSE ${list} END AS __parts FROM ${ctx.cur}`;
    const mid = `SELECT ${projList(others)}, unnest(__parts) AS __part, unnest(generate_series(1, len(__parts))) AS __k FROM (${inner}) AS a`;
    const cols = ctx.cols.map((c, k) => (k === ci ? { physical: phys, name: c.name, type: 'text' as const } : c));
    const outer = cols.map((c, k) => (k === ci ? `nullif(__part, '') AS ${phys}` : c.physical)).join(', ');
    markRetype(ctx, phys);
    return { body: `SELECT (row_number() OVER (ORDER BY ${ORD}, __k) - 1) AS ${ORD}, ${outer} FROM (${mid}) AS b`, cols };
  }

  const names = splitNames(s.column, splitWidth(s));
  const clash = names.find((nm) => ctx.cols.some((c, k) => k !== ci && c.name === nm));
  if (clash) return skipWith(ctx, `Split skipped: column "${clash}" already exists`);
  const exprs = s.mode === 'position'
    ? positionParts(s, src.physical)
    : names.map((_, k) => `__parts[${k + 1}]`);
  const fresh: SqlColumn[] = names.map((name) => ({ physical: ctx.newPhys(), name, type: 'text' as const }));
  const from = s.mode === 'position'
    ? ctx.cur
    : `(SELECT ${projList(ctx.cols)}, ${partsList(s, src.physical, ctx)} AS __parts FROM ${ctx.cur}) AS a`;
  const cols = [...ctx.cols.slice(0, ci), ...fresh, ...ctx.cols.slice(ci + 1)];
  const select = [ORD, ...cols.map((c) => {
    const k = fresh.indexOf(c);
    return k < 0 ? c.physical : `nullif(${exprs[k]}, '') AS ${c.physical}`;
  })].join(', ');
  for (const c of fresh) markRetype(ctx, c.physical);
  return { body: `SELECT ${select} FROM ${from}`, cols };
}

// ── unpivot ──────────────────────────────────────────────────────────────────

export function genUnpivot(s: UnpivotStep, ctx: PowerSqlCtx): PowerSqlOut {
  const warnings: string[] = [];
  const idx: number[] = [];
  for (const name of s.columns) {
    const ci = colIndex(ctx.cols, name);
    if (ci < 0) warnings.push(`Unpivot: unknown column "${name}" ignored`);
    else if (!idx.includes(ci)) idx.push(ci);
  }
  if (!idx.length) return skipWith(ctx, ...warnings, 'Unpivot skipped: none of the chosen columns exist');
  const attr = (s.attribute || 'attribute').trim() || 'attribute';
  const val = (s.value || 'value').trim() || 'value';
  const keep = ctx.cols.filter((_, k) => !idx.includes(k));
  const problem = unpivotNameProblem(keep.map((c) => c.name), attr, val);
  if (problem) return skipWith(ctx, ...warnings, problem);
  if (idx.some((k) => ctx.retyped.has(ctx.cols[k].physical))) {
    return { bail: 'unpivot over a column typed from data by an earlier step' };
  }
  ctx.warnings.push(...warnings);
  const types = [...new Set(idx.map((k) => ctx.cols[k].type))];
  const pa = ctx.newPhys();
  const pv = ctx.newPhys();
  const keepList = keep.map((c) => c.physical);
  const branches = idx.map((k, n) => {
    ctx.params.push(ctx.cols[k].name);
    const v = types.length === 1 ? vc(ctx.cols[k].physical) : `nullif(${vc(ctx.cols[k].physical)}, '')`;
    return `SELECT ${[ORD, ...keepList].join(', ')}, ${n} AS __k, CAST(? AS VARCHAR) AS ${pa}, ${v} AS ${pv} FROM ${ctx.cur}`;
  });
  const cols: SqlColumn[] = [
    ...keep,
    { physical: pa, name: attr, type: 'text' },
    { physical: pv, name: val, type: types.length === 1 ? types[0] : 'text' },
  ];
  if (types.length > 1) markRetype(ctx, pv);
  const outer = [...keepList, pa, pv].join(', ');
  return {
    body: `SELECT (row_number() OVER (ORDER BY ${ORD}, __k) - 1) AS ${ORD}, ${outer} FROM (${branches.join(' UNION ALL ')}) AS u`,
    cols,
  };
}

// ── pivot ────────────────────────────────────────────────────────────────────

/** The key of a pivot cell: its stored text, NULL when empty (stepsReshape.pivotKeys). */
export function pivotKeyExpr(phys: string): string {
  return `CASE WHEN ${sqlEmpty(phys)} THEN NULL ELSE ${vc(phys)} END`;
}

export function genPivot(s: PivotStep, ctx: PowerSqlCtx): PowerSqlOut {
  const problem = pivotProblem(ctx.cols, s);
  if (problem) return skipWith(ctx, problem);
  const key = colOf(ctx.cols, s.key) as SqlColumn;
  const value = colOf(ctx.cols, s.value) as SqlColumn;
  const groups = s.groupBy.map((g) => colOf(ctx.cols, g) as SqlColumn);
  // A data-typed group column BAILS: the fold groups its coerced cells ('' is
  // already null there), SQL would group the raw text.
  if ([key, value, ...groups].some((c) => ctx.retyped.has(c.physical))) {
    return { bail: 'pivot over a column typed from data by an earlier step' };
  }
  const resolved = ctx.opts.pivots && ctx.opts.pivots[ctx.index];
  if (!resolved) return { bail: `need-pivot:${ctx.index}` };
  const clash = pivotClash(s.groupBy, resolved.keys);
  if (clash) return skipWith(ctx, clash);
  if (resolved.distinct > resolved.keys.length) ctx.warnings.push(pivotCapWarning(s.key, resolved.distinct));

  const select: string[] = [];
  const groupKeys: string[] = [];
  const cols: SqlColumn[] = [];
  for (const src of groups) {
    const phys = ctx.newPhys();
    select.push(`${src.physical} AS ${phys}`);
    if (!groupKeys.includes(src.physical)) groupKeys.push(src.physical);
    cols.push({ physical: phys, name: src.name, type: src.type });
  }
  const k = pivotKeyExpr(key.physical);
  const n = value.type === 'number' ? sqlNum(value.physical) : null;
  for (const kv of resolved.keys) {
    const phys = ctx.newPhys();
    let expr: string;
    if (s.fn === 'count') {
      expr = `CASE WHEN count(CASE WHEN ${k} = CAST(? AS VARCHAR) THEN 1 END) = 0 THEN NULL ` +
        `ELSE CAST(count(CASE WHEN ${k} = CAST(? AS VARCHAR) AND NOT ${sqlEmpty(value.physical)} THEN 1 END) AS DOUBLE) END`;
      ctx.params.push(kv, kv);
    } else if (n === null) {
      expr = 'CAST(NULL AS DOUBLE)';
    } else if (s.fn === 'avg') {
      // sum/count, not avg(): the fold's shape (see sqlGen's group_aggregate).
      expr = `CAST(sum(CASE WHEN ${k} = CAST(? AS VARCHAR) THEN ${n} END) / ` +
        `nullif(count(CASE WHEN ${k} = CAST(? AS VARCHAR) THEN ${n} END), 0) AS DOUBLE)`;
      ctx.params.push(kv, kv);
    } else {
      expr = `CAST(${s.fn}(CASE WHEN ${k} = CAST(? AS VARCHAR) THEN ${n} END) AS DOUBLE)`;
      ctx.params.push(kv);
    }
    select.push(`${expr} AS ${phys}`);
    cols.push({ physical: phys, name: kv, type: 'number' });
  }
  select.push(`min(${ORD}) AS ${ORD}`);
  const tail = groupKeys.length ? ` GROUP BY ${groupKeys.join(', ')}` : ' HAVING count(*) > 0';
  return { body: `SELECT ${select.join(', ')} FROM ${ctx.cur}${tail}`, cols };
}
