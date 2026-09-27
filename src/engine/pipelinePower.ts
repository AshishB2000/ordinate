// The data-dependent half of generating a pipeline's SQL — MAIN PROCESS.
//
// sqlGen is a pure string builder, and three things a power pipeline needs are
// facts about the DATA: a pivot's keys (its output columns), a lookup's count
// of repeated right keys (its warning), and the row count after every step
// (the step list's "1,250 → 1,180 rows"). `planPower` asks DuckDB for each with
// one small query over the same relations, feeds the answers back to
// generateSql through its opts, and returns the finished GenResult plus counts.
//
// It never decides anything the fold would decide differently: a pivot's keys
// are read in FIRST-SEEN order (min(__ord)), capped exactly as pivotKeys caps,
// and every count is of a prefix of the very pipeline being run.

import type { StepCount, PipelineContext, PivotStep } from '../data/stepTypes';
import { MAX_PIVOT_COLUMNS, refProblem, stepRefIds } from '../data/stepTypes';
import type { TransformStep } from '../data/transforms';
import type { GenResult, SqlColumn } from './sqlGen';
import { generateSql } from './sqlGen';
import type { Param, PowerSqlOpts } from './sqlGenPower';
import { pivotKeyExpr } from './sqlGenReshape';
import { dupesSql } from './sqlGenCombine';
import type { DuckRow } from './duckdb';

/** Runs SQL whose base relation is written `FROM "t"`; the caller substitutes it. */
export type RunSql = (sql: string, params: Param[]) => DuckRow[];

/** A generateSql bail that planPower can satisfy with a query. */
export function isNeed(reason: string | undefined): boolean {
  return /^need-(pivot|dupes):\d+$/.test(reason || '');
}

/**
 * The refs/errors a pipeline's union/lookup steps see: every referenced id is
 * either a relation (`relationFor` names it) or carries the fold's skip reason,
 * so SQL and the fold skip the same steps with the same words.
 */
export function refOpts(
  steps: TransformStep[],
  ctx: PipelineContext | undefined,
  relationFor: (id: string, k: number) => string,
): { opts: PowerSqlOpts; loads: Array<{ relation: string; id: string }> } {
  const opts: PowerSqlOpts = { refs: {}, errors: {} };
  const loads: Array<{ relation: string; id: string }> = [];
  stepRefIds(steps).forEach((id, k) => {
    const problem = refProblem(ctx, id);
    if (problem) {
      (opts.errors as Record<string, string>)[id] = problem;
      return;
    }
    const table = (ctx as PipelineContext).tables[id];
    const relation = relationFor(id, k);
    const columns: SqlColumn[] = table.columns.map((c, i) => ({ physical: `c${i}`, name: c.name, type: c.type }));
    (opts.refs as Record<string, { relation: string; columns: SqlColumn[] }>)[id] = { relation, columns };
    loads.push({ relation, id });
  });
  return { opts, loads };
}

function pivotKeys(schema: SqlColumn[], steps: TransformStep[], i: number, opts: PowerSqlOpts, run: RunSql): {
  keys: string[]; distinct: number;
} | null {
  const prefix = generateSql('t', schema, steps.slice(0, i), opts);
  if (prefix.sql === null) return null;
  const key = prefix.columns.find((c) => c.name === (steps[i] as PivotStep).key);
  // sqlGen always ends on exactly this line; anything else is not ours to edit.
  const tail = /\nSELECT [^\n]* FROM (s\d+) ORDER BY __ord$/.exec(prefix.sql);
  if (!key || !tail) return null;
  const sql = `${prefix.sql.slice(0, tail.index)}\nSELECT k, CAST(count(*) OVER () AS DOUBLE) AS n FROM ` +
    `(SELECT ${pivotKeyExpr(key.physical)} AS k, min(__ord) AS o FROM ${tail[1]} GROUP BY 1) AS g ` +
    `WHERE k IS NOT NULL ORDER BY o LIMIT ${MAX_PIVOT_COLUMNS}`;
  const rows = run(sql, prefix.params);
  return { keys: rows.map((r) => String(r.k)), distinct: rows.length ? Number(rows[0].n) : 0 };
}

/**
 * The finished SQL for `steps`, and the per-step row counts — or null when the
 * pipeline is not expressible even with the data's answers (the caller folds).
 * `opts` carries the union/lookup relations from refOpts; it is filled in place.
 */
export function planPower(schema: SqlColumn[], steps: TransformStep[], opts: PowerSqlOpts, run: RunSql): {
  gen: GenResult; counts: StepCount[];
} | null {
  steps.forEach((s, i) => {
    if (s.type !== 'lookup_join') return;
    const ref = opts.refs && opts.refs[s.datasetId];
    const col = ref && ref.columns.find((c) => c.name === s.rightKey);
    if (!ref || !col) return;
    const rows = run(dupesSql(ref.relation, col), []);
    opts.dupes = { ...(opts.dupes || {}), [i]: Number(rows[0] ? rows[0].d : 0) };
  });

  let gen = generateSql('t', schema, steps, opts);
  for (let guard = 0; gen.sql === null && guard < steps.length; guard += 1) {
    const need = /^need-pivot:(\d+)$/.exec(gen.unsupported || '');
    if (!need) return null;
    const i = Number(need[1]);
    const resolved = pivotKeys(schema, steps, i, opts, run);
    if (!resolved) return null;
    opts.pivots = { ...(opts.pivots || {}), [i]: resolved };
    gen = generateSql('t', schema, steps, opts);
  }
  if (gen.sql === null) return null;

  if (!steps.length) return { gen, counts: [] };
  const parts = ['(SELECT CAST(count(*) AS DOUBLE) FROM "t") AS n0'];
  const params: Param[] = [];
  for (let k = 1; k <= steps.length; k += 1) {
    const g = k === steps.length ? gen : generateSql('t', schema, steps.slice(0, k), opts);
    if (g.sql === null) return null;
    parts.push(`(SELECT CAST(count(*) AS DOUBLE) FROM (${g.sql}) AS q${k}) AS n${k}`);
    params.push(...g.params);
  }
  const row = run(`SELECT ${parts.join(', ')}`, params)[0] || {};
  const n = (k: number): number => Number(row['n' + k]);
  return { gen, counts: steps.map((_, k) => ({ before: n(k), after: n(k + 1) })) };
}
