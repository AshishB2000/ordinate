// A snapshot diff computed by DuckDB on the two Parquet files IN PLACE — MAIN.
//
// The rules (what counts as empty, duplicate keys, multiset rows, column
// matching, page order) are defined in src/data/snapshotDiffJs.ts, which is the
// reference; scripts/test-snapshotDiff.ts asserts this file agrees with it on
// every field with Object.is. Neither table is materialised: two queries read
// both files, one for the counts and one for the bounded pages.
//
// House rules (CLAUDE.md, resident-query layer): values compared as stored
// VARCHAR — nothing is cast, so '007' ≠ '7'; emptiness spelled out with
// sqlGen.sqlEmpty's class; an explicit ordinal (`file_row_number`) orders
// everything and every window; every count is CAST to DOUBLE. Async bridge
// only (queryAsync): a diff of two 1M-row files must not freeze the windows.
//
// Returns null on any failure — the caller then runs the JS reference over the
// same two files.

import * as duck from './duckdb';
import { relationSql } from './parquetStore';
import { sqlEmpty } from './sqlGen';
import type { ParsedColumn } from '../data/parse';
import { planDiff, changedCells, emptyResult } from '../data/snapshotDiffJs';
import type { DiffPlan, DiffResult, DiffCell } from '../data/snapshotDiffJs';

export interface DiffSource {
  parquetPath: string;
  columns: ParsedColumn[];
}

const BOM = 'chr(65279)';
/** Undo the bridge's leading-BOM loss on a returned value (see parquetStore). */
function bomSafe(v: string): string {
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

/** One side: its ordinal and the compared columns, normalised (empty → NULL). */
function sideSql(src: DiffSource, idx: number[]): string {
  const cols = idx.map((p, j) => {
    const c = `"c${p}"`;
    return `CASE WHEN ${sqlEmpty(c)} THEN NULL ELSE CAST(${c} AS VARCHAR) END AS v${j}`;
  });
  return `SELECT CAST(file_row_number AS DOUBLE) AS ord${cols.map((c) => ', ' + c).join('')} ` +
    `FROM ${relationSql(src.parquetPath, { fileRowNumber: true })}`;
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The CTEs every query shares, ending in `t(kind, oo, no, o0.., n0..)`. */
function withSql(plan: DiffPlan, oldSrc: DiffSource, newSrc: DiffSource): string {
  const w = plan.columns.length;
  const pick = (a: string, p: string): string => range(w).map((j) => `, ${a}.v${j} AS ${p}${j}`).join('');
  const differs = range(w).filter((j) => j !== plan.keyAt).map((j) => `o${j} IS DISTINCT FROM n${j}`);
  let firsts: string;
  let on: string;
  let kind: string;
  if (plan.mode === 'key') {
    const k = `v${plan.keyAt}`;
    // First row of each key, by file order — the documented duplicate rule.
    firsts = `o1 AS (SELECT * FROM o QUALIFY row_number() OVER (PARTITION BY ${k} ORDER BY ord) = 1), ` +
      `n1 AS (SELECT * FROM n QUALIFY row_number() OVER (PARTITION BY ${k} ORDER BY ord) = 1)`;
    on = `o1.${k} IS NOT DISTINCT FROM n1.${k}`;
    kind = `CASE WHEN oo IS NULL THEN 'a' WHEN no IS NULL THEN 'r' ` +
      `WHEN ${differs.length ? differs.join(' OR ') : 'FALSE'} THEN 'c' ELSE 'u' END`;
  } else {
    // The k-th copy of a row matches the k-th: a multiset, deterministic by ord.
    const part = w ? `PARTITION BY ${range(w).map((j) => `v${j}`).join(', ')} ` : '';
    firsts = `o1 AS (SELECT *, row_number() OVER (${part}ORDER BY ord) AS occ FROM o), ` +
      `n1 AS (SELECT *, row_number() OVER (${part}ORDER BY ord) AS occ FROM n)`;
    on = ['o1.occ = n1.occ', ...range(w).map((j) => `o1.v${j} IS NOT DISTINCT FROM n1.v${j}`)].join(' AND ');
    kind = `CASE WHEN oo IS NULL THEN 'a' WHEN no IS NULL THEN 'r' ELSE 'u' END`;
  }
  return `WITH o AS (${sideSql(oldSrc, plan.oldIdx)}), n AS (${sideSql(newSrc, plan.newIdx)}), ${firsts}, ` +
    `j AS (SELECT o1.ord AS oo, n1.ord AS no${pick('o1', 'o')}${pick('n1', 'n')} FROM o1 FULL OUTER JOIN n1 ON ${on}), ` +
    `t AS (SELECT *, ${kind} AS kind FROM j)`;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function cell(v: unknown): DiffCell {
  return v === null || v === undefined ? null : String(v);
}

async function run(plan: DiffPlan, oldSrc: DiffSource, newSrc: DiffSource): Promise<DiffResult> {
  const cte = withSql(plan, oldSrc, newSrc);
  const out = emptyResult(plan);

  const counts = await duck.queryAsync(
    `${cte} SELECT kind, CAST(count(*) AS DOUBLE) AS n FROM t GROUP BY kind ` +
    `UNION ALL SELECT 'do' AS kind, CAST((SELECT count(*) FROM o) - (SELECT count(*) FROM o1) AS DOUBLE) AS n ` +
    `UNION ALL SELECT 'dn' AS kind, CAST((SELECT count(*) FROM n) - (SELECT count(*) FROM n1) AS DOUBLE) AS n;`,
  );
  for (const r of counts) {
    const n = num(r.n);
    if (r.kind === 'a') out.counts.added = n;
    else if (r.kind === 'r') out.counts.removed = n;
    else if (r.kind === 'c') out.counts.changed = n;
    else if (r.kind === 'u') out.counts.unchanged = n;
    else if (r.kind === 'do') out.duplicates.old = plan.mode === 'key' ? n : 0;
    else if (r.kind === 'dn') out.duplicates.new = plan.mode === 'key' ? n : 0;
  }

  const w = plan.columns.length;
  const vals = range(w).map((j) => `, ${bomSafe(`o${j}`)} AS o${j}, ${bomSafe(`n${j}`)} AS n${j}`).join('');
  const rows = await duck.queryAsync(
    `${cte}, r AS (SELECT *, row_number() OVER (PARTITION BY kind ORDER BY CASE WHEN kind = 'r' THEN oo ELSE no END) AS rk ` +
    `FROM t WHERE kind <> 'u') SELECT kind, oo, no${vals} FROM r WHERE rk <= ? ORDER BY kind, rk;`,
    [plan.limit],
  );
  for (const r of rows) {
    const ov = range(w).map((j) => cell(r['o' + j]));
    const nv = range(w).map((j) => cell(r['n' + j]));
    if (r.kind === 'a') out.added.push({ ord: num(r.no), values: nv });
    else if (r.kind === 'r') out.removed.push({ ord: num(r.oo), values: ov });
    else if (r.kind === 'c') {
      out.changed.push({ ordOld: num(r.oo), ordNew: num(r.no), key: nv[plan.keyAt], cells: changedCells(plan, ov, nv) });
    }
  }
  return out;
}

/**
 * Diff `oldSrc` (a snapshot) against `newSrc` (the current table). An unusable
 * key is `{ error }`; a DuckDB failure is null (fall back to the reference).
 */
export async function diffParquet(
  oldSrc: DiffSource,
  newSrc: DiffSource,
  key: unknown,
  limit?: unknown,
): Promise<DiffResult | { error: string } | null> {
  const plan = planDiff(oldSrc.columns, newSrc.columns, key, limit);
  if ('error' in plan) return plan;
  try {
    return await run(plan, oldSrc, newSrc);
  } catch (err: any) {
    console.error('[snapshotDiff] resident diff failed:', err?.message || err);
    return null;
  }
}
