// The data-dependent half of generating a pipeline's SQL — MAIN PROCESS.
//
// sqlGen is a pure string builder, and four things a power pipeline needs are
// facts about the DATA: a pivot's keys (its output columns), a lookup's count
// of repeated right keys (its warning), the rows into an unpivot (its cell
// budget), and the row count after every step (the step list's
// "1,250 → 1,180 rows"). `planPower` asks DuckDB for each with
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

/** Runs SQL whose base relation is written `FROM "t"`; the caller substitutes it. Async bridge. */
export type RunSql = (sql: string, params: Param[]) => Promise<DuckRow[]>;

/** A generateSql bail that planPower can satisfy with a query. */
export function isNeed(reason: string | undefined): boolean {
  return /^need-(pivot|dupes|rows):\d+$/.test(reason || '');
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

async function pivotKeys(schema: SqlColumn[], steps: TransformStep[], i: number, opts: PowerSqlOpts, run: RunSql): Promise<{
  keys: string[]; distinct: number;
} | null> {
  const prefix = generateSql('t', schema, steps.slice(0, i), opts);
  if (prefix.sql === null) return null;
  const key = prefix.columns.find((c) => c.name === (steps[i] as PivotStep).key);
  // sqlGen always ends on exactly this line; anything else is not ours to edit.
  const tail = /\nSELECT [^\n]* FROM (s\d+) ORDER BY __ord$/.exec(prefix.sql);
  if (!key || !tail) return null;
  const sql = `${prefix.sql.slice(0, tail.index)}\nSELECT k, CAST(count(*) OVER () AS DOUBLE) AS n FROM ` +
    `(SELECT ${pivotKeyExpr(key.physical)} AS k, min(__ord) AS o FROM ${tail[1]} GROUP BY 1) AS g ` +
    `WHERE k IS NOT NULL ORDER BY o LIMIT ${MAX_PIVOT_COLUMNS}`;
  const rows = await run(sql, prefix.params);
  return { keys: rows.map((r) => String(r.k)), distinct: rows.length ? Number(rows[0].n) : 0 };
}

/** The rows into step `i` — an unpivot's cell budget (stepsReshape.unpivotSizeProblem). */
async function rowsInto(schema: SqlColumn[], steps: TransformStep[], i: number, opts: PowerSqlOpts, run: RunSql): Promise<number | null> {
  const prefix = generateSql('t', schema, steps.slice(0, i), opts);
  if (prefix.sql === null) return null;
  const rows = await run(`SELECT CAST(count(*) AS DOUBLE) AS n FROM (${prefix.sql}) AS q`, prefix.params);
  return Number(rows[0] ? rows[0].n : 0);
}

/**
 * The finished SQL for `steps`, and the per-step row counts — or null when the
 * pipeline is not expressible even with the data's answers (the caller folds).
 * `opts` carries the union/lookup relations from refOpts; it is filled in place.
 */
export async function planPower(schema: SqlColumn[], steps: TransformStep[], opts: PowerSqlOpts, run: RunSql): Promise<{
  gen: GenResult; counts: StepCount[];
} | null> {
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.type !== 'lookup_join') continue;
    const ref = opts.refs && opts.refs[s.datasetId];
    const col = ref && ref.columns.find((c) => c.name === s.rightKey);
    if (!ref || !col) continue;
    const rows = await run(dupesSql(ref.relation, col), []);
    opts.dupes = { ...(opts.dupes || {}), [i]: Number(rows[0] ? rows[0].d : 0) };
  }

  let gen = generateSql('t', schema, steps, opts);
  for (let guard = 0; gen.sql === null && guard < steps.length; guard += 1) {
    const need = /^need-(pivot|rows):(\d+)$/.exec(gen.unsupported || '');
    if (!need) return null;
    const i = Number(need[2]);
    if (need[1] === 'rows') {
      const rows = await rowsInto(schema, steps, i, opts, run);
      if (rows === null) return null;
      opts.rows = { ...(opts.rows || {}), [i]: rows };
    } else {
      const resolved = await pivotKeys(schema, steps, i, opts, run);
      if (!resolved) return null;
      opts.pivots = { ...(opts.pivots || {}), [i]: resolved };
    }
    gen = generateSql('t', schema, steps, opts);
  }
  if (gen.sql === null) return null;

  if (!steps.length) return { gen, counts: [] };
  // Every count from the ONE chain: the relation after step k is a CTE of `gen`
  // itself, so the statement is the pipeline once plus a count per step. A copy
  // of each prefix pipeline per step was O(steps² × width) on the request
  // thread — 200 steps over 2,000 columns built ~280 MB of SQL (NV-51).
  const tail = /\nSELECT [^\n]* FROM s\d+ ORDER BY __ord$/.exec(gen.sql);
  if (!tail || !gen.rels || gen.rels.length !== steps.length) return null;
  const parts = ['s0', ...gen.rels].map((rel, k) => `(SELECT CAST(count(*) AS DOUBLE) FROM ${rel}) AS n${k}`);
  const row = (await run(`${gen.sql.slice(0, tail.index)}\nSELECT ${parts.join(', ')}`, gen.params))[0] || {};
  const n = (k: number): number => Number(row['n' + k]);
  return { gen, counts: steps.map((_, k) => ({ before: n(k), after: n(k + 1) })) };
}
