// SQL for union and lookup_join — the twins of src/data/stepsCombine.ts. The
// other dataset is a relation the caller loaded (opts.refs: ORD + c0..cN). A
// reference the caller could NOT load arrives in opts.errors and skips with the
// fold's warning; one it simply did not pass BAILS, since only the fold then
// knows the reason. See sqlGenPower.ts for the shared contract.

import type { SqlColumn } from './sqlGen';
import { ORD, sqlEmpty } from './sqlGen';
import type { LookupJoinStep, PipelineContext, UnionStep } from '../data/stepTypes';
import { lookupDupWarning, lookupPlan, unionPlan, unionRetyped } from '../data/stepsCombine';
import type { PowerSqlCtx, PowerSqlOut } from './sqlGenPower';
import { markRetype, quoteRel, skipWith, sqlNum, vc } from './sqlGenPower';

/** stepsCombine.lookupKey in SQL (the rule joinResident.keySql also follows). */
export function keySql(p: string, type: SqlColumn['type']): string {
  return type === 'number'
    ? `CASE WHEN ${sqlNum(p)} IS NULL THEN NULL ELSE ${vc(p)} END`
    : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${vc(p)} END`;
}

function reference(ctx: PowerSqlCtx, id: string): { relation: string; columns: SqlColumn[] } | string | null {
  const err = ctx.opts.errors && ctx.opts.errors[id];
  if (typeof err === 'string') return err;
  return (ctx.opts.refs && ctx.opts.refs[id]) || null;
}

// ── union ────────────────────────────────────────────────────────────────────

export function genUnion(s: UnionStep, ctx: PowerSqlCtx): PowerSqlOut {
  const ref = reference(ctx, s.datasetId);
  if (typeof ref === 'string') return skipWith(ctx, `Union skipped: ${ref}`);
  if (!ref) return { bail: 'union needs the other dataset loaded as a relation' };
  const plan = unionPlan(ctx.cols, ref.columns, s.mapping);
  const retype = unionRetyped(ctx.cols, ref.columns, plan);
  if (ctx.cols.some((c, k) => plan.source[k] >= 0 && ctx.retyped.has(c.physical))) {
    return { bail: 'union into a column typed from data by an earlier step' };
  }
  ctx.warnings.push(...plan.warnings);
  const fresh: SqlColumn[] = ctx.cols.map((c) => ({ ...c, physical: ctx.newPhys() }));
  // Both sides as VARCHAR — the storage contract — so UNION ALL never picks a type.
  const cell = (expr: string, k: number): string => (retype.includes(k) ? `nullif(${expr}, '')` : expr);
  const mine = ctx.cols.map((c, k) => `${cell(vc(c.physical), k)} AS ${fresh[k].physical}`);
  const theirs = plan.source.map((j, k) =>
    `${j >= 0 ? cell(vc(ref.columns[j].physical), k) : 'CAST(NULL AS VARCHAR)'} AS ${fresh[k].physical}`);
  for (const k of retype) markRetype(ctx, fresh[k].physical);
  // A column already typed from data (and unmatched, or we bailed above) keeps being so.
  for (const [k, c] of ctx.cols.entries()) if (ctx.retyped.has(c.physical)) markRetype(ctx, fresh[k].physical);
  const inner = `SELECT 0 AS __src, ${[ORD, ...mine].join(', ')} FROM ${ctx.cur} ` +
    `UNION ALL SELECT 1 AS __src, ${[ORD, ...theirs].join(', ')} FROM ${quoteRel(ref.relation)}`;
  const outer = fresh.map((c) => c.physical).join(', ');
  return {
    body: `SELECT (row_number() OVER (ORDER BY __src, ${ORD}) - 1) AS ${ORD}, ${outer} FROM (${inner}) AS u`,
    cols: fresh,
  };
}

// ── lookup_join ──────────────────────────────────────────────────────────────

export function genLookup(s: LookupJoinStep, ctx: PowerSqlCtx): PowerSqlOut {
  const ref = reference(ctx, s.datasetId);
  if (typeof ref === 'string') return skipWith(ctx, `Lookup skipped: ${ref}`);
  if (!ref) return { bail: 'lookup needs the other dataset loaded as a relation' };
  // The fold's own guard list, over the relation's schema (no rows needed).
  const shadow: PipelineContext = { tables: { [s.datasetId]: { columns: ref.columns, rows: [] } } };
  const plan = lookupPlan(ctx.cols, s, shadow);
  if (Array.isArray(plan)) return skipWith(ctx, ...plan);
  const left = ctx.cols[plan.li];
  if (ctx.retyped.has(left.physical)) return { bail: 'lookup on a key typed from data by an earlier step' };
  const dupes = ctx.opts.dupes && ctx.opts.dupes[ctx.index];
  if (dupes === undefined) return { bail: `need-dupes:${ctx.index}` };
  ctx.warnings.push(...plan.warnings);
  if (dupes > 0) ctx.warnings.push(lookupDupWarning(s.rightKey, dupes));

  const right = ref.columns[plan.ri];
  const brought = plan.bring.map((j, k) => ({ src: ref.columns[j], col: { physical: ctx.newPhys(), name: plan.names[k], type: ref.columns[j].type } }));
  const rk = keySql(right.physical, right.type);
  const firstPerKey = `SELECT ${rk} AS __k, ${brought.map((b) => b.src.physical).join(', ')} FROM ${quoteRel(ref.relation)} ` +
    `QUALIFY row_number() OVER (PARTITION BY ${rk} ORDER BY ${ORD}) = 1`;
  const select = [`l.${ORD}`, ...ctx.cols.map((c) => `l.${c.physical}`), ...brought.map((b) => `r.${b.src.physical} AS ${b.col.physical}`)];
  return {
    body: `SELECT ${select.join(', ')} FROM ${ctx.cur} AS l LEFT JOIN (${firstPerKey}) AS r ` +
      `ON ${keySql(`l.${left.physical}`, left.type)} = r.__k`,
    cols: [...ctx.cols, ...brought.map((b) => b.col)],
  };
}

/** The repeated-key count pipelinePower asks DuckDB for (count(k) − count(DISTINCT k)). */
export function dupesSql(relation: string, col: SqlColumn): string {
  const k = keySql(col.physical, col.type);
  return `SELECT CAST(count(k) - count(DISTINCT k) AS DOUBLE) AS d FROM (SELECT ${k} AS k FROM ${quoteRel(relation)}) AS x`;
}
