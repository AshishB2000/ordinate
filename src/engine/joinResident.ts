// A LEFT JOIN chain over the stored Parquet, answered in place — the SQL twin
// of analysis/joinJs.ts, held to `Object.is` agreement by scripts/test-joins.ts.
// MAIN PROCESS.
//
// The joined relation re-exposes every merged column POSITIONALLY as `c0..cN`
// (primary first), plus `__ord` (the primary's file row) and `__o<t>` (each
// related table's file row). That one choice is what lets the existing resident
// layer run unchanged over a join: `residentQuery.resolveCatKey`, `aggExpr` and
// `filterPredicates` all address `c<i>` over one relation, so bins, date grains,
// the top-50 cap and every filter operator come for free and cannot drift.
//
// The three rules of joinJs.ts, in SQL:
//   1. keys: the stored VARCHAR, NULL when empty (`keySql`);
//   2. one row per hop: QUALIFY row_number() … = 1 over the key, file order;
//   3. no fan-in: a related measure cell survives only on the FIRST row of its
//      (group key, related row) — a window over the group key, then the
//      ordinary aggregate.
//
// Every entry point returns null on any failure; the caller falls back to the
// JS reference. Paths reach SQL only through `parquetStore.relationSql`; values
// only as bound parameters; identifiers only as positional `c<i>`.

import { randomUUID } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import { FILTER_OPS, LIST_OPS } from '../data/filterOps';
import type { MetricAggregation } from '../analysis/metricValue';
import { recommendChartType } from '../analysis/vizData';
import type { VizDataResult } from '../analysis/vizData';
import type { DsInfo, JoinLayout, JoinPlan, VizJoin } from '../analysis/joinPlan';
import type { KeyStats } from '../analysis/joinJs';
import { relationSql } from './parquetStore';
import { sqlEmpty } from './sqlGen';
import { catKeyExpr, catLabel, sqlNum } from './residentCategory';
import { aggExpr, filterPredicates, resolveCatKey, withRelation } from './residentQuery';
import type { ResidentMeasure } from './residentQuery';
import * as duck from './duckdb';

export interface JoinSource {
  datasetId: string;
  parquetPath: string;
  columns: ParsedColumn[];
}

function ordered(parquetPath: string): string {
  const base = relationSql(parquetPath); // validated + escaped
  return `${base.slice(0, -1)}, file_row_number=true)`;
}

/** Rule 1 — `joinJs.keyOf` in SQL. */
export function keySql(p: string, type: ParsedColumn['type']): string {
  return type === 'number'
    ? `CASE WHEN ${sqlNum(p)} IS NULL THEN NULL ELSE CAST(${p} AS VARCHAR) END`
    : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE CAST(${p} AS VARCHAR) END`;
}

/** The joined relation, parenthesised, ready to stand where a `read_parquet(…)` would. */
export function joinRelationSql(
  sources: JoinSource[],
  plan: JoinPlan,
  layout: JoinLayout,
  infos: Map<string, DsInfo>,
): string {
  const sel = ['t0.file_row_number AS __ord'];
  for (let t = 1; t < plan.tables.length; t++) sel.push(`t${t}.__o AS __o${t}`);
  layout.columns.forEach((_, m) => sel.push(`t${layout.tableOf[m]}.c${layout.srcIndex[m]} AS c${m}`));

  let from = `${ordered(sources[0].parquetPath)} AS t0`;
  for (let t = 1; t < plan.tables.length; t++) {
    const via = plan.tables[t].via;
    if (!via) throw new Error('join hop missing');
    const ft = plan.tables.findIndex((x) => x.datasetId === via.from.datasetId);
    const fromInfo = infos.get(via.from.datasetId) as DsInfo;
    const toInfo = infos.get(via.to.datasetId) as DsInfo;
    const fi = fromInfo.columns.findIndex((c) => c.name === via.from.column);
    const ti = toInfo.columns.findIndex((c) => c.name === via.to.column);
    if (ft < 0 || fi < 0 || ti < 0) throw new Error('join key missing');
    const toKey = keySql(`c${ti}`, toInfo.columns[ti].type);
    from +=
      ` LEFT JOIN (SELECT file_row_number AS __o, * FROM ${ordered(sources[t].parquetPath)} ` +
      `QUALIFY row_number() OVER (PARTITION BY ${toKey} ORDER BY file_row_number) = 1) AS t${t} ` +
      `ON ${keySql(`t${ft}.c${fi}`, fromInfo.columns[fi].type)} = ${keySql(`t${t}.c${ti}`, toInfo.columns[ti].type)}`;
  }
  return `(SELECT ${sel.join(', ')} FROM ${from})`;
}

/** Rule 3 — a related measure column masked to the first row of (partition, related row). */
function maskedCol(layout: JoinLayout, ci: number, partition: string): string {
  const t = layout.tableOf[ci];
  if (t === 0) return `c${ci}`;
  const by = partition ? `${partition}, __o${t}` : `__o${t}`;
  return `CASE WHEN row_number() OVER (PARTITION BY ${by} ORDER BY __o) = 1 THEN c${ci} END AS c${ci}`;
}

function finiteOrNull(raw: duck.DuckValue): number | null {
  const n = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function measureLabel(m: ResidentMeasure): string {
  return m.aggregation === 'count' ? m.column : `${m.aggregation} of ${m.column}`;
}

// `visualsResident.filterCannotWarn` over merged names: a step that would make
// the JS reference warn must be answered BY the JS reference, warning included.
function cannotWarn(f: FilterStep, names: Set<string>): boolean {
  if (!f || f.type !== 'filter' || !names.has(f.column) || !FILTER_OPS.has(f.op)) return false;
  return !(LIST_OPS.has(f.op) && (!Array.isArray(f.values) || f.values.length === 0));
}

/**
 * Branch (A) of `buildVizData` — no split, no geo, not all-'none' — over a
 * join. Null for anything else, and whenever the JS reference would warn.
 */
export function joinedAggregateResident(
  sources: JoinSource[],
  join: VizJoin,
  infos: Map<string, DsInfo>,
): VizDataResult | null {
  try {
    const enc = join.encoding;
    if (enc.geo || enc.series || enc.pivot) return null;
    const values = enc.values || [];
    // Empty, or all-'none' (branch C): `every` is true for both.
    if (values.every((v) => v.aggregation === 'none')) return null;
    const cols = join.layout.columns;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has(enc.category) || values.some((v) => !names.has(v.column))) return null;
    if (!join.filters.every((f) => cannotWarn(f, names))) return null;

    const measures: ResidentMeasure[] = values.map((v) => ({
      column: v.column,
      aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation,
    }));
    const relation = joinRelationSql(sources, join.plan, join.layout, infos);
    const key = 'join:' + randomUUID();
    const src = { parquetPath: key, columns: cols };
    const gi = cols.findIndex((c) => c.name === enc.category);

    return withRelation(key, relation, () => {
      const plan = resolveCatKey(src, enc.category, measures, join.filters, enc.grain, enc.bins);
      if (!plan) return null;
      const params: duck.DuckValue[] = [];
      const ck = catKeyExpr(cols, gi, plan.key, params);
      const preds = filterPredicates(cols, join.filters, params);
      const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
      const mcis = [...new Set(measures.map((m) => cols.findIndex((c) => c.name === m.column)))];
      const aggs = measures.map(
        (m, i) => `${aggExpr(cols, cols.findIndex((c) => c.name === m.column), m.aggregation)} AS m${i}`,
      );
      const sql =
        `SELECT __k AS g0, ${aggs.join(', ')} FROM (` +
        `SELECT __k, __o, ${mcis.map((ci) => maskedCol(join.layout, ci, '__k')).join(', ')} FROM (` +
        `SELECT ${ck.label} AS __k, __ord AS __o, * FROM ${relation}${where})) ` +
        `GROUP BY __k ORDER BY min(__o);`;
      const out = duck.query(sql, params);
      const catType = cols[gi].type;
      return {
        data: {
          labels: out.map((r) => catLabel(r.g0 ?? null, catType, plan.key)),
          series: measures.map((m, i) => ({ name: measureLabel(m), values: out.map((r) => finiteOrNull(r[`m${i}`] ?? null)) })),
        },
        recommendedShape: recommendChartType(cols, enc).shape,
        warnings: [],
        category: plan.info,
      };
    });
  } catch (_) {
    return null;
  }
}

/** One metric over a join (`joinJs.joinedMetricJs`). `column` is a merged name. */
export function joinedMetricResident(
  sources: JoinSource[],
  plan: JoinPlan,
  layout: JoinLayout,
  infos: Map<string, DsInfo>,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
): number | null {
  try {
    const cols = layout.columns;
    const ci = cols.findIndex((c) => c.name === spec.column);
    if (ci < 0) return null;
    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(cols, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    const relation = joinRelationSql(sources, plan, layout, infos);
    const sql =
      `SELECT ${aggExpr(cols, ci, spec.aggregation)} AS m0 FROM (` +
      `SELECT ${maskedCol(layout, ci, '')} FROM (SELECT __ord AS __o, * FROM ${relation}${where}));`;
    const out = duck.query(sql, params);
    const raw = out.length ? out[0].m0 : null;
    if (raw == null) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isNaN(n) ? null : n;
  } catch (_) {
    return null;
  }
}

/** Full-table relationship check (`joinJs.keyStatsJs`). */
export function keyStatsResident(
  from: { parquetPath: string; index: number; type: ParsedColumn['type'] },
  to: { parquetPath: string; index: number; type: ParsedColumn['type'] },
): KeyStats | null {
  try {
    const fk = keySql(`c${from.index}`, from.type);
    const tk = keySql(`c${to.index}`, to.type);
    const a = duck.query(
      `SELECT CAST(count(*) AS DOUBLE) AS n, CAST(count(t.k) AS DOUBLE) AS matched, ` +
        `CAST(count(DISTINCT f.k) AS DOUBLE) AS fkeys, CAST(count(f.k) AS DOUBLE) AS fkeyed ` +
        `FROM (SELECT ${fk} AS k FROM ${relationSql(from.parquetPath)}) f ` +
        `LEFT JOIN (SELECT DISTINCT ${tk} AS k FROM ${relationSql(to.parquetPath)}) t ON f.k = t.k;`,
    )[0];
    const b = duck.query(
      `SELECT CAST(count(DISTINCT k) AS DOUBLE) AS tkeys, CAST(count(k) AS DOUBLE) AS tkeyed ` +
        `FROM (SELECT ${tk} AS k FROM ${relationSql(to.parquetPath)});`,
    )[0];
    const n = Number(a.n);
    const matched = Number(a.matched);
    return {
      matched,
      unmatchedFrom: n - matched,
      fromKeys: Number(a.fkeys),
      fromKeyed: Number(a.fkeyed),
      toKeys: Number(b.tkeys),
      toKeyed: Number(b.tkeyed),
    };
  } catch (_) {
    return null;
  }
}

/** The sampled join rate (`joinJs.joinRateJs`): first `sample` FROM rows, all of TO. */
export function joinRateResident(
  from: { parquetPath: string; index: number; type: ParsedColumn['type'] },
  to: { parquetPath: string; index: number; type: ParsedColumn['type'] },
  sample: number,
): number | null {
  try {
    const fk = keySql(`c${from.index}`, from.type);
    const tk = keySql(`c${to.index}`, to.type);
    const r = duck.query(
      `SELECT CAST(count(k) AS DOUBLE) AS n, ` +
        `CAST(count(*) FILTER (WHERE k IN (SELECT k2 FROM (SELECT ${tk} AS k2 FROM ${relationSql(to.parquetPath)}) WHERE k2 IS NOT NULL)) AS DOUBLE) AS hit ` +
        `FROM (SELECT ${fk} AS k FROM ${ordered(from.parquetPath)} WHERE file_row_number < CAST(? AS BIGINT));`,
      [sample],
    )[0];
    const n = Number(r.n);
    return n === 0 ? null : Number(r.hit) / n;
  } catch (_) {
    return null;
  }
}
