'use strict';

// qualityResident — data-quality rules answered DIRECTLY against a dataset's
// Parquet file. MAIN PROCESS ONLY. Never throws: `evaluateRulesResident` returns
// `null` when the bridge is down or anything at all goes wrong, and the caller
// (analysis/qualityRun) falls back to the JS reference in analysis/qualityRules.
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `evaluateRulesResident(src, rules, refs)` ≡ `rules.map((r) =>
// evaluateRuleJs(r, src.columns, rows, ref))` where `rows` is
// `parquetStore.readTable(src.parquetPath, src.columns).rows` — the same bytes,
// read two ways. `scripts/test-qualityRules.ts` asserts it with `Object.is` on
// `failing` and on every sample cell. The semantics are defined once, in the
// header of analysis/qualityRules.ts; this file is their SQL spelling.
//
// ── How ──────────────────────────────────────────────────────────────────────
// ONE aggregate statement counts every rule: `count(CASE WHEN <failing> THEN 1
// END)` per rule, cast to DOUBLE (never `FILTER (WHERE …)`, which cost 16× at
// width elsewhere in this layer). A failing rule then reads its first
// SAMPLE_ROWS rows with `ORDER BY` the file ordinal — never an unordered LIMIT.
//
// The rules the house style is built on, all held here:
//   · CAST ON THE DECLARED TYPE. Only a `number` column goes through `sqlNum`;
//     a text `007` is compared as `007`.
//   · EMPTY is `sqlEmpty` (null, '' or the spelled-out whitespace class) for
//     text/date, and "not a finite number" for a number column — which is what
//     a hydrated number cell's null means.
//   · EVERY VALUE IS A BOUND `?` — bounds, set values and the pattern. User
//     column names never reach SQL (positional c0..cN); the only other text is
//     the file path, which `parquetStore.relationSql` validates and escapes.
//   · `references` is an anti-join against the other dataset's Parquet, as an
//     uncorrelated `NOT (k IN (SELECT …))` — the subquery holds no NULLs and the
//     outer key is non-NULL, so the IN is two-valued and NOT is exact.

import type { ColumnType, ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import type { QualityRule, Resolved, RuleResult } from '../analysis/qualityRules';
import { SAMPLE_ROWS, numberSet, resolveRule, rowCountResult } from '../analysis/qualityRules';
import { re2Pattern } from '../analysis/qualityRegex';
import { sqlEmpty } from './sqlGen';
import { phys, sqlNum, bomSafe, sqlCanonicalDate, toCell } from './residentCategory';
import { relationSql } from './parquetStore';
import { runOrderedAsync } from './residentQuery';
import * as duck from './duckdb';

/** A dataset's stored table, positionally aligned to its record — `datasets.residentSource`. */
export interface QualitySource {
  parquetPath: string;
  columns: ParsedColumn[];
}

type Bound = Extract<Resolved, { ok: true }>;

/** Emptiness on the DECLARED type — the SQL twin of `isEmptyCell` over a hydrated cell. */
function emptySql(type: ColumnType, p: string): string {
  return type === 'number' ? `(${sqlNum(p)} IS NULL)` : sqlEmpty(p);
}

/** The comparison key — `qualityRules.cellKey`: a DOUBLE, or the stored text; NULL when empty. */
function keySql(type: ColumnType, p: string): string {
  return type === 'number' ? sqlNum(p) : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE CAST(${p} AS VARCHAR) END`;
}

/**
 * The rule's failing predicate over the physical c0..cN of `parquetPath`'s
 * relation. Pushes its parameters in TEXT order, so a caller placing
 * predicates left to right binds them correctly. Null for row_count (no row
 * fails it) and for a references rule with no resident other side.
 */
function failingPredicateSql(
  rule: QualityRule,
  r: Bound,
  parquetPath: string,
  params: duck.DuckValue[],
  refPath?: string,
): string | null {
  const p = phys(r.ci);
  const isNum = r.type === 'number';
  const { min, max } = rule.args;
  switch (rule.kind) {
    case 'not_null':
      return emptySql(r.type, p);
    case 'unique': {
      const k = keySql(r.type, p);
      return `(${k} IS NOT NULL AND ${k} IN (SELECT k FROM (SELECT ${k} AS k FROM ${relationSql(parquetPath)}) ` +
        `WHERE k IS NOT NULL GROUP BY k HAVING count(*) > 1))`;
    }
    case 'range': {
      const v = isNum ? sqlNum(p) : sqlCanonicalDate(p);
      const cast = isNum ? 'DOUBLE' : 'DATE';
      const out: string[] = [];
      if (min !== undefined) { out.push(`${v} < CAST(? AS ${cast})`); params.push(min); }
      if (max !== undefined) { out.push(`${v} > CAST(? AS ${cast})`); params.push(max); }
      // A number cell that is not a finite number is empty (header); a date cell
      // that is not a canonical date is a failure in its own right.
      return isNum
        ? `(${v} IS NOT NULL AND (${out.join(' OR ')}))`
        : `(NOT ${sqlEmpty(p)} AND (${v} IS NULL OR ${out.join(' OR ')}))`;
    }
    case 'regex':
      params.push(re2Pattern(rule.args.pattern ?? ''));
      return `(NOT ${sqlEmpty(p)} AND NOT regexp_full_match(CAST(${p} AS VARCHAR), ?))`;
    case 'in_set': {
      const vals: duck.DuckValue[] = isNum ? numberSet(rule.args.values) : rule.args.values || [];
      const k = keySql(r.type, p);
      if (!vals.length) return `(${k} IS NOT NULL)`;
      params.push(...vals);
      const holes = vals.map(() => `CAST(? AS ${isNum ? 'DOUBLE' : 'VARCHAR'})`).join(', ');
      return `(${k} IS NOT NULL AND NOT (${k} IN (${holes})))`;
    }
    case 'references': {
      if (!refPath) return null;
      const k = keySql(r.type, p);
      const rk = keySql(r.refType, phys(r.refCi));
      return `(${k} IS NOT NULL AND NOT (${k} IN (SELECT k FROM (SELECT ${rk} AS k FROM ${relationSql(refPath)}) WHERE k IS NOT NULL)))`;
    }
    default:
      return null;
  }
}

/**
 * Every rule's result, off the stored Parquet. `refs` maps a references rule's
 * `datasetId` to that dataset's resident source, or null when it is gone.
 *
 * Returns `null` — never throws — on any failure; `null` always means "fall
 * back", never "nothing failed".
 */
export async function evaluateRulesResident(
  src: QualitySource,
  rules: QualityRule[],
  refs: ReadonlyMap<string, QualitySource | null>,
): Promise<RuleResult[] | null> {
  try {
    const cols = schemaOf(src);
    if (!cols || !duck.isAvailable()) return null;
    const params: duck.DuckValue[] = [];
    const sel = ['CAST(count(*) AS DOUBLE) AS n'];
    const plan = rules.map((rule, i) => {
      const ref = rule.kind === 'references' ? refs.get(rule.args.datasetId ?? '') ?? null : undefined;
      const r = resolveRule(rule, cols, ref);
      if (r.ok && rule.kind !== 'row_count') {
        const pred = failingPredicateSql(rule, r, src.parquetPath, params, ref ? ref.parquetPath : undefined);
        if (pred === null) throw new Error('unexpressible rule');
        sel.push(`CAST(count(CASE WHEN ${pred} THEN 1 END) AS DOUBLE) AS f${i}`);
      }
      return { rule, r, ref };
    });
    const out = await duck.queryAsync(`SELECT ${sel.join(', ')} FROM ${relationSql(src.parquetPath)};`, params);
    const n = out.length === 1 ? countOf(out[0].n) : null;
    if (n === null) return null;

    const results: RuleResult[] = [];
    for (let i = 0; i < plan.length; i += 1) {
      const { rule, r, ref } = plan[i];
      if (!r.ok) {
        results.push({ ruleId: rule.id, passed: false, failing: 0, sample: [], error: r.error });
        continue;
      }
      if (rule.kind === 'row_count') {
        results.push(rowCountResult(rule, n));
        continue;
      }
      const failing = countOf(out[0][`f${i}`]);
      if (failing === null) return null;
      const sample = failing > 0 ? await sampleRows(src.parquetPath, cols, rule, r, ref ? ref.parquetPath : undefined) : [];
      results.push({ ruleId: rule.id, passed: failing === 0, failing, sample });
    }
    return results;
  } catch {
    return null;
  }
}

/**
 * The failing predicate for "Show failing rows" — handed to `datasetPage` as a
 * `rowFilter`, so search, sort and paging stay that module's. Null when the
 * rule has no failing rows to show or cannot be expressed resident.
 */
export function failingRowSql(
  src: QualitySource,
  rule: QualityRule,
  ref?: QualitySource | null,
): { sql: string; params: duck.DuckValue[] } | null {
  const r = resolveRule(rule, src.columns, ref);
  if (!r.ok) return null;
  const params: duck.DuckValue[] = [];
  const sql = failingPredicateSql(rule, r, src.parquetPath, params, ref ? ref.parquetPath : undefined);
  return sql === null ? null : { sql, params };
}

/** The first SAMPLE_ROWS failing rows, whole, in stored order. */
async function sampleRows(parquetPath: string, cols: ParsedColumn[], rule: QualityRule, r: Bound, refPath?: string): Promise<Cell[][]> {
  const params: duck.DuckValue[] = [];
  const pred = failingPredicateSql(rule, r, parquetPath, params, refPath);
  if (pred === null) throw new Error('unexpressible rule');
  const projection = cols.map((_, c) => `${bomSafe(phys(c))} AS v${c}`).join(', ');
  const rows = await runOrderedAsync(
    parquetPath,
    (from, ord) => `SELECT ${projection} FROM ${from} WHERE ${pred} ORDER BY ${ord} LIMIT ${SAMPLE_ROWS};`,
    params,
  );
  return rows.map((row) => cols.map((col, c) => toCell(row[`v${c}`] ?? null, col.type)));
}

/** A count: a finite, non-negative integer, or null (which means "fall back"). */
function countOf(raw: duck.DuckValue | undefined): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return raw != null && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Usable only when every column is a real ParsedColumn; a 0-column table falls back. */
function schemaOf(src: QualitySource): ParsedColumn[] | null {
  if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns) || !src.columns.length) return null;
  return src.columns.every((c) => c && typeof c === 'object' && typeof c.name === 'string') ? src.columns : null;
}
