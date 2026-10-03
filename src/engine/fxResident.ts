// Multi-currency, answered in place — the SQL twin of analysis/fx.ts, held to
// `Object.is` agreement with it by scripts/test-fxResident.ts. MAIN PROCESS.
//
// ONE relation does the work: the dataset's Parquet, every planned amount
// column replaced by its converted value, plus the FX_MARK column naming the
// missing pair — re-exposed positionally as `c0..cN` with `__ord` (the file
// row), exactly like engine/joinResident.ts. Registered under a key with
// `residentQuery.withRelationAsync`, it lets the EXISTING resident layer — the
// metric aggregate, the category key, the grouped aggregate, every filter
// operator — run unchanged over converted money, and a missing count is just
// `count` of FX_MARK under the same filters.
//
// The rate for a row is fx.ts's precedence, compiled to ASOF LEFT JOINs (the
// nearest rate dated on or before the row's day) against the rate table read in
// place: identity, direct, inverse (1/r), then via USD (each leg direct-else-
// inverse). The rate table is de-duplicated LAST-wins per (pair, day) over the
// file row, like fx.buildRates. Amounts convert as `amount * rate` with the
// rate computed first, which is fx.convertTable's association; the converted
// DOUBLE travels as VARCHAR (DuckDB's shortest round-trip spelling) so the
// relation keeps the all-VARCHAR contract every reader here assumes.
//
// DECLINED (null → the JS reference answers): a date cell in the rows' or the
// rates' date column that SQL does not read as one of the two canonical shapes
// — the JS side would `Date.parse` it, SQL would not. Codes are validated
// `[A-Z]{3}` before they are spliced in as literals; nothing user-typed reaches
// SQL any other way, and paths only through `parquetStore.relationSql`.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import { FX_MARK, PIVOT_CURRENCY, LATEST_DAY, isCurrencyCode, sortPairs } from '../analysis/fx';
import type { FxPlan, RateRow } from '../analysis/fx';
import { relationSql } from './parquetStore';
import { sqlEmpty } from './sqlGen';
import { sqlNum, sqlCanonicalDate } from './residentCategory';
import { aggExpr, computeMetricResident, filterPredicates, plainFrom } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import * as duck from './duckdb';

export type FxRateSource =
  | { kind: 'sample'; rows: RateRow[] }
  | { kind: 'dataset'; parquetPath: string; columns: ParsedColumn[]; map: { date: string; from: string; to: string; rate: string } };

function lit(code: string): string {
  if (!isCurrencyCode(code)) throw new Error('fx: bad currency code');
  return `'${code}'`;
}

function codeSql(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN regexp_full_match(${v}, '[A-Za-z]{3}') THEN upper(${v}) END`;
}

function daySql(p: string): string {
  return `CAST(date_diff('day', DATE '1970-01-01', ${sqlCanonicalDate(p)}) AS INTEGER)`;
}

function ordered(parquetPath: string): string {
  const base = relationSql(parquetPath); // validated + escaped
  return `${base.slice(0, -1)}, file_row_number=true)`;
}

// categoryKey's two canonical SHAPES. A cell of one of them that is not a real
// date (2024-02-31) is null on BOTH sides; only a cell of neither shape reaches
// the JS `Date.parse` fallback, and that is what declines.
const SHAPES = ['(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})', '(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})'];

/** Non-empty cells of `c<i>` in neither canonical date shape. */
async function nonCanonical(parquetPath: string, i: number): Promise<number> {
  const p = `c${i}`;
  const v = `CAST(${p} AS VARCHAR)`;
  const shaped = SHAPES.map((re) => `regexp_full_match(${v}, '${re}')`).join(' OR ');
  const out = await duck.queryAsync(`SELECT CAST(count(*) AS DOUBLE) AS n FROM ${relationSql(parquetPath)} WHERE NOT ${sqlEmpty(p)} AND NOT (${shaped});`, []);
  return out.length ? Number(out[0].n) : 1;
}

async function ratesSql(rates: FxRateSource): Promise<string | null> {
  let rows: string;
  if (rates.kind === 'sample') {
    if (!rates.rows.length) return `SELECT CAST(NULL AS VARCHAR) AS f, CAST(NULL AS VARCHAR) AS t, CAST(NULL AS INTEGER) AS d, CAST(NULL AS DOUBLE) AS r WHERE false`;
    const vals = rates.rows.map((r, o) =>
      `(${lit(r.from)}, ${lit(r.to)}, ${Math.trunc(r.day)}, CAST('${String(r.rate)}' AS DOUBLE), ${o})`);
    rows = `SELECT * FROM (VALUES ${vals.join(', ')}) AS v(f, t, d, r, o)`;
  } else {
    const at = (n: string): number => rates.columns.findIndex((c) => c.name === n);
    const di = at(rates.map.date);
    const fi = at(rates.map.from);
    const ti = at(rates.map.to);
    const ri = at(rates.map.rate);
    if (di < 0 || fi < 0 || ti < 0 || ri < 0) return null;
    if ((await nonCanonical(rates.parquetPath, di)) > 0) return null;
    // Cast on the DECLARED type only: a rate column that is not `number` has no rates.
    const rate = rates.columns[ri].type === 'number' ? sqlNum(`c${ri}`) : 'CAST(NULL AS DOUBLE)';
    rows = `SELECT ${codeSql(`c${fi}`)} AS f, ${codeSql(`c${ti}`)} AS t, ${daySql(`c${di}`)} AS d, ${rate} AS r, file_row_number AS o ` +
      `FROM ${ordered(rates.parquetPath)}`;
  }
  return `SELECT f, t, d, r FROM (${rows}) WHERE f IS NOT NULL AND t IS NOT NULL AND d IS NOT NULL AND r > 0 ` +
    `QUALIFY row_number() OVER (PARTITION BY f, t, d ORDER BY o DESC) = 1`;
}

/**
 * The converted relation, parenthesised, ready to stand where `read_parquet(…)`
 * would — or null when the resident path must decline. Throws on a malformed
 * plan; callers wrap.
 */
export async function fxRelationSql(src: ResidentSource, rates: FxRateSource, plan: FxPlan): Promise<string | null> {
  const cols = src.columns;
  const T = lit(plan.target);
  const USD = lit(PIVOT_CURRENCY);
  const viaUsd = plan.target !== PIVOT_CURRENCY;
  for (const di of new Set(plan.cols.map((c) => c.dateIndex))) {
    if (di >= 0 && (await nonCanonical(src.parquetPath, di)) > 0) return null;
  }
  const fx = await ratesSql(rates);
  if (fx === null) return null;

  const extra: string[] = [];
  const joins: string[] = [];
  const effs: string[] = [];
  plan.cols.forEach((c, k) => {
    const cur = c.code !== null ? lit(c.code) : c.curIndex >= 0 ? codeSql(`c${c.curIndex}`) : 'CAST(NULL AS VARCHAR)';
    const day = c.dateIndex >= 0 ? daySql(`c${c.dateIndex}`) : String(LATEST_DAY);
    extra.push(`${cur} AS __u${k}`, `${day} AS __d${k}`, `${sqlNum(`c${c.index}`)} AS __a${k}`);
    const x = (s: string): string => `__x${k}${s}`;
    const on = (alias: string, keyCol: string | null): string =>
      `ON ${keyCol ? `${alias}.${keyCol} = __r.__u${k} AND ` : ''}__r.__d${k} >= ${alias}.d`;
    joins.push(
      `ASOF LEFT JOIN (SELECT f, d, r FROM __fx WHERE t = ${T}) AS ${x('a')} ${on(x('a'), 'f')}`,
      `ASOF LEFT JOIN (SELECT t, d, r FROM __fx WHERE f = ${T}) AS ${x('b')} ${on(x('b'), 't')}`,
    );
    const one = 'CAST(1 AS DOUBLE)';
    // The NULL-day guard is load-bearing: measured, an ASOF join MATCHES a NULL
    // probe key to the latest rate rather than to nothing.
    let eff = `CASE WHEN __r.__u${k} = ${T} THEN ${one} WHEN __r.__d${k} IS NULL THEN NULL ` +
      `WHEN ${x('a')}.r IS NOT NULL THEN ${x('a')}.r ` +
      `WHEN ${x('b')}.r IS NOT NULL THEN ${one} / ${x('b')}.r`;
    if (viaUsd) {
      joins.push(
        `ASOF LEFT JOIN (SELECT f, d, r FROM __fx WHERE t = ${USD}) AS ${x('c')} ${on(x('c'), 'f')}`,
        `ASOF LEFT JOIN (SELECT t, d, r FROM __fx WHERE f = ${USD}) AS ${x('d')} ${on(x('d'), 't')}`,
        `ASOF LEFT JOIN (SELECT d, r FROM __fx WHERE f = ${USD} AND t = ${T}) AS ${x('e')} ${on(x('e'), null)}`,
        `ASOF LEFT JOIN (SELECT d, r FROM __fx WHERE f = ${T} AND t = ${USD}) AS ${x('f')} ${on(x('f'), null)}`,
      );
      const l1 = `coalesce(${x('c')}.r, ${one} / ${x('d')}.r)`;
      const l2 = `coalesce(${x('e')}.r, ${one} / ${x('f')}.r)`;
      eff += ` WHEN __r.__u${k} <> ${USD} AND ${l1} IS NOT NULL AND ${l2} IS NOT NULL THEN ${l1} * ${l2}`;
    }
    effs.push(`${eff} END AS __e${k}`);
  });

  const byIndex = new Map(plan.cols.map((c, k) => [c.index, k]));
  const out = cols.map((_, i) => {
    const k = byIndex.get(i);
    if (k === undefined) return `c${i}`;
    return `CASE WHEN __a${k} IS NULL THEN c${i} WHEN __e${k} IS NULL THEN NULL ELSE CAST(__a${k} * __e${k} AS VARCHAR) END AS c${i}`;
  });
  const mark = `CASE ${plan.cols.map((_, k) =>
    `WHEN __a${k} IS NOT NULL AND __e${k} IS NULL THEN coalesce(__u${k}, '?') || '→' || ${T}`).join(' ')} END AS c${cols.length}`;

  return `(WITH __fx AS (${fx}), ` +
    `__r AS (SELECT file_row_number AS __ord, *, ${extra.join(', ')} FROM ${ordered(src.parquetPath)}), ` +
    `__e AS (SELECT __r.*, ${effs.join(', ')} FROM __r ${joins.join(' ')}) ` +
    `SELECT __ord, ${out.join(', ')}, ${mark} FROM __e)`;
}

/** The converted relation's schema: the dataset's columns plus FX_MARK. */
export function fxColumns(columns: ParsedColumn[]): ParsedColumn[] {
  return columns.concat([{ name: FX_MARK, type: 'text' }]);
}

/**
 * Missing rows and their pairs under `filters`, over a relation already
 * registered under `fxSrc.parquetPath`. Null on failure.
 */
export async function fxMissingResident(fxSrc: ResidentSource, filters: FilterStep[]): Promise<{ missing: number; pairs: string[] } | null> {
  try {
    const missing = await computeMetricResident(fxSrc, { column: FX_MARK, aggregation: 'count' }, filters);
    if (missing === null) return null;
    let pairs: string[] = [];
    if (missing > 0) {
      const params: duck.DuckValue[] = [];
      const m = `c${fxSrc.columns.length - 1}`;
      const preds = [`${m} IS NOT NULL`].concat(filterPredicates(fxSrc.columns, filters, params));
      const rows = await duck.queryAsync(`SELECT DISTINCT CAST(${m} AS VARCHAR) AS p FROM ${plainFrom(fxSrc.parquetPath)} WHERE ${preds.join(' AND ')};`, params);
      pairs = sortPairs(rows.map((r) => String(r.p)));
    }
    return { missing, pairs };
  } catch (_) {
    return null;
  }
}

/**
 * One converted metric over a registered relation: `computeMetricResident`'s
 * statement (the shared aggExpr + filterPredicates compilers) with the missing
 * count beside it. A null VALUE here is a real answer — every row missing, say
 * — because a failure throws instead; null overall means "use the reference".
 */
export async function fxMetricOn(
  fxSrc: ResidentSource,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
): Promise<{ value: number | null; missing: number; pairs: string[] } | null> {
  try {
    const cols = fxSrc.columns;
    const ci = cols.findIndex((c) => c.name === spec.column);
    if (ci < 0) return null;
    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(cols, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    const out = await duck.queryAsync(`SELECT ${aggExpr(cols, ci, spec.aggregation)} AS m0 FROM ${plainFrom(fxSrc.parquetPath)}${where};`, params);
    if (!out.length) return null;
    const raw = out[0].m0;
    const n = raw == null ? null : typeof raw === 'number' ? raw : Number(raw);
    const miss = await fxMissingResident(fxSrc, filters);
    return miss ? { value: n === null || Number.isNaN(n) ? null : n, ...miss } : null;
  } catch (_) {
    return null;
  }
}
