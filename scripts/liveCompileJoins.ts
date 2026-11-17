// The live compiler across a saved relationship (src/engine/live/compileJoin.ts, docs/live-data/00-plan.md L4): the
// joined FROM item each dialect prints, and what goes inside which scan. A part of scripts/test-liveCompile.ts, not a
// suite. The strings below were captured from the compiler when it was built and then read clause by clause against
// compileJoin's rules; a change to them is made by hand, with its reason, never re-recorded.

import type { CompiledQuery, CompileEnv } from '../src/engine/live/compile';
import type { CompileDialectId } from '../src/engine/live/dialect';
import type { LiveColumn, LiveFilter, LiveIR } from '../src/engine/live/liveSpec';

const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');

/** Orders (cust → Customers.id) by Customers.region, sum of amt: the one-hop category join, per dialect. */
export const JOINED_FROM: Record<CompileDialectId, string> = {
  duckdb:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src."amt" AS lv_c1, encode(CASE WHEN (CAST(lv_src."cust" AS VARCHAR) IS NULL OR regexp_full_match(CAST(lv_src."cust" AS VARCHAR), \'[\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]*\')) THEN NULL ELSE CAST(lv_src."cust" AS VARCHAR) END) AS lv_j1 FROM "shop"."orders" AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT encode(CASE WHEN (CAST(lv_src."id" AS VARCHAR) IS NULL OR regexp_full_match(CAST(lv_src."id" AS VARCHAR), \'[\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]*\')) THEN NULL ELSE CAST(lv_src."id" AS VARCHAR) END) AS lv_k, lv_src."region" AS lv_c3, row_number() OVER (PARTITION BY encode(CASE WHEN (CAST(lv_src."id" AS VARCHAR) IS NULL OR regexp_full_match(CAST(lv_src."id" AS VARCHAR), \'[\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]*\')) THEN NULL ELSE CAST(lv_src."id" AS VARCHAR) END) ORDER BY CASE WHEN encode(CAST(lv_src."region" AS VARCHAR)) IS NULL THEN 1 ELSE 0 END, encode(CAST(lv_src."region" AS VARCHAR))) AS lv_rn FROM "shop"."customers" AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
  snowflake:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src."amt" AS lv_c1, TO_BINARY(CASE WHEN (CAST(lv_src."cust" AS VARCHAR) IS NULL OR TRIM(CAST(lv_src."cust" AS VARCHAR), CAST(? AS VARCHAR)) = \'\') THEN NULL ELSE CAST(lv_src."cust" AS VARCHAR) END, \'UTF-8\') AS lv_j1 FROM "shop"."orders" AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT TO_BINARY(CASE WHEN (CAST(lv_src."id" AS VARCHAR) IS NULL OR TRIM(CAST(lv_src."id" AS VARCHAR), CAST(? AS VARCHAR)) = \'\') THEN NULL ELSE CAST(lv_src."id" AS VARCHAR) END, \'UTF-8\') AS lv_k, lv_src."region" AS lv_c3, row_number() OVER (PARTITION BY TO_BINARY(CASE WHEN (CAST(lv_src."id" AS VARCHAR) IS NULL OR TRIM(CAST(lv_src."id" AS VARCHAR), CAST(? AS VARCHAR)) = \'\') THEN NULL ELSE CAST(lv_src."id" AS VARCHAR) END, \'UTF-8\') ORDER BY CASE WHEN TO_BINARY(CAST(lv_src."region" AS VARCHAR), \'UTF-8\') IS NULL THEN 1 ELSE 0 END, TO_BINARY(CAST(lv_src."region" AS VARCHAR), \'UTF-8\')) AS lv_rn FROM "shop"."customers" AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
  bigquery:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src.`amt` AS lv_c1, CAST(CASE WHEN (CAST(lv_src.`cust` AS STRING) IS NULL OR TRIM(CAST(lv_src.`cust` AS STRING), CAST(@p0 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`cust` AS STRING) END AS BYTES) AS lv_j1 FROM `shop`.`orders` AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT CAST(CASE WHEN (CAST(lv_src.`id` AS STRING) IS NULL OR TRIM(CAST(lv_src.`id` AS STRING), CAST(@p1 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`id` AS STRING) END AS BYTES) AS lv_k, lv_src.`region` AS lv_c3, row_number() OVER (PARTITION BY CAST(CASE WHEN (CAST(lv_src.`id` AS STRING) IS NULL OR TRIM(CAST(lv_src.`id` AS STRING), CAST(@p2 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`id` AS STRING) END AS BYTES) ORDER BY CASE WHEN CAST(CAST(lv_src.`region` AS STRING) AS BYTES) IS NULL THEN 1 ELSE 0 END, CAST(CAST(lv_src.`region` AS STRING) AS BYTES)) AS lv_rn FROM `shop`.`customers` AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
  redshift:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src."amt" AS lv_c1, md5(CASE WHEN (CAST(lv_src."cust" AS VARCHAR(65535)) IS NULL OR BTRIM(CAST(lv_src."cust" AS VARCHAR(65535)), CAST($1 AS VARCHAR(65535))) = \'\') THEN NULL ELSE CAST(lv_src."cust" AS VARCHAR(65535)) END) AS lv_j1 FROM "shop"."orders" AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT md5(CASE WHEN (CAST(lv_src."id" AS VARCHAR(65535)) IS NULL OR BTRIM(CAST(lv_src."id" AS VARCHAR(65535)), CAST($2 AS VARCHAR(65535))) = \'\') THEN NULL ELSE CAST(lv_src."id" AS VARCHAR(65535)) END) AS lv_k, lv_src."region" AS lv_c3, row_number() OVER (PARTITION BY md5(CASE WHEN (CAST(lv_src."id" AS VARCHAR(65535)) IS NULL OR BTRIM(CAST(lv_src."id" AS VARCHAR(65535)), CAST($3 AS VARCHAR(65535))) = \'\') THEN NULL ELSE CAST(lv_src."id" AS VARCHAR(65535)) END) ORDER BY CASE WHEN md5(CAST(lv_src."region" AS VARCHAR(65535))) IS NULL THEN 1 ELSE 0 END, md5(CAST(lv_src."region" AS VARCHAR(65535)))) AS lv_rn FROM "shop"."customers" AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
  clickhouse:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src.`amt` AS lv_c1, CASE WHEN (CAST(lv_src.`cust` AS Nullable(String)) IS NULL OR match(CAST(lv_src.`cust` AS Nullable(String)), \'^[\\\\x{0009}-\\\\x{000D}\\\\x{0020}\\\\x{00A0}\\\\x{1680}\\\\x{2000}-\\\\x{200A}\\\\x{2028}\\\\x{2029}\\\\x{202F}\\\\x{205F}\\\\x{3000}\\\\x{FEFF}]*$\')) THEN NULL ELSE CAST(lv_src.`cust` AS Nullable(String)) END AS lv_j1 FROM `shop`.`orders` AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT CASE WHEN (CAST(lv_src.`id` AS Nullable(String)) IS NULL OR match(CAST(lv_src.`id` AS Nullable(String)), \'^[\\\\x{0009}-\\\\x{000D}\\\\x{0020}\\\\x{00A0}\\\\x{1680}\\\\x{2000}-\\\\x{200A}\\\\x{2028}\\\\x{2029}\\\\x{202F}\\\\x{205F}\\\\x{3000}\\\\x{FEFF}]*$\')) THEN NULL ELSE CAST(lv_src.`id` AS Nullable(String)) END AS lv_k, lv_src.`region` AS lv_c3, row_number() OVER (PARTITION BY CASE WHEN (CAST(lv_src.`id` AS Nullable(String)) IS NULL OR match(CAST(lv_src.`id` AS Nullable(String)), \'^[\\\\x{0009}-\\\\x{000D}\\\\x{0020}\\\\x{00A0}\\\\x{1680}\\\\x{2000}-\\\\x{200A}\\\\x{2028}\\\\x{2029}\\\\x{202F}\\\\x{205F}\\\\x{3000}\\\\x{FEFF}]*$\')) THEN NULL ELSE CAST(lv_src.`id` AS Nullable(String)) END ORDER BY CASE WHEN CAST(lv_src.`region` AS Nullable(String)) IS NULL THEN 1 ELSE 0 END, CAST(lv_src.`region` AS Nullable(String))) AS lv_rn FROM `shop`.`customers` AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
  databricks:
    '(SELECT lv_t0.lv_c1 AS lv_c1, lv_t1.lv_c3 AS lv_c3 FROM (SELECT lv_src.`amt` AS lv_c1, CAST(CASE WHEN (CAST(lv_src.`cust` AS STRING) IS NULL OR btrim(CAST(lv_src.`cust` AS STRING), CAST(:p0 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`cust` AS STRING) END AS BINARY) AS lv_j1 FROM `shop`.`orders` AS lv_src) AS lv_t0 LEFT JOIN (SELECT lv_k, lv_c3 FROM (SELECT CAST(CASE WHEN (CAST(lv_src.`id` AS STRING) IS NULL OR btrim(CAST(lv_src.`id` AS STRING), CAST(:p1 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`id` AS STRING) END AS BINARY) AS lv_k, lv_src.`region` AS lv_c3, row_number() OVER (PARTITION BY CAST(CASE WHEN (CAST(lv_src.`id` AS STRING) IS NULL OR btrim(CAST(lv_src.`id` AS STRING), CAST(:p2 AS STRING)) = \'\') THEN NULL ELSE CAST(lv_src.`id` AS STRING) END AS BINARY) ORDER BY CASE WHEN CAST(CAST(lv_src.`region` AS STRING) AS BINARY) IS NULL THEN 1 ELSE 0 END, CAST(CAST(lv_src.`region` AS STRING) AS BINARY)) AS lv_rn FROM `shop`.`customers` AS lv_src) AS lv_r WHERE lv_rn = 1 AND lv_k IS NOT NULL) AS lv_t1 ON lv_t0.lv_j1 = lv_t1.lv_k) AS lv_src',
};

/**
 * The same join on a NUMBER key: the one side's window partition, per dialect. −0 is folded into 0 in the key itself (one
 * partition, one match; String(-0) is '0'), and BigQuery, whose PARTITION BY takes no float, partitions by its 17-digit
 * text, one-to-one on finite doubles.
 */
export const NUMBER_PARTITION: Record<CompileDialectId, string> = {
  snowflake:
    'PARTITION BY CASE WHEN CASE WHEN CAST(lv_src."id" AS DOUBLE) - CAST(lv_src."id" AS DOUBLE) = 0 THEN CAST(lv_src."id" AS DOUBLE) END = 0 THEN CAST(0 AS DOUBLE) ELSE CASE WHEN CAST(lv_src."id" AS DOUBLE) - CAST(lv_src."id" AS DOUBLE) = 0 THEN CAST(lv_src."id" AS DOUBLE) END END',
  bigquery:
    'PARTITION BY FORMAT(\'%.17g\', CASE WHEN CASE WHEN NOT IS_INF(SAFE_CAST(lv_src.`id` AS FLOAT64)) AND NOT IS_NAN(SAFE_CAST(lv_src.`id` AS FLOAT64)) THEN SAFE_CAST(lv_src.`id` AS FLOAT64) END = 0 THEN CAST(0 AS FLOAT64) ELSE CASE WHEN NOT IS_INF(SAFE_CAST(lv_src.`id` AS FLOAT64)) AND NOT IS_NAN(SAFE_CAST(lv_src.`id` AS FLOAT64)) THEN SAFE_CAST(lv_src.`id` AS FLOAT64) END END)',
  clickhouse:
    'PARTITION BY CASE WHEN CASE WHEN isFinite(accurateCastOrNull(lv_src.`id`, \'Float64\')) THEN accurateCastOrNull(lv_src.`id`, \'Float64\') END = 0 THEN toFloat64(0) ELSE CASE WHEN isFinite(accurateCastOrNull(lv_src.`id`, \'Float64\')) THEN accurateCastOrNull(lv_src.`id`, \'Float64\') END END',
  databricks:
    'PARTITION BY CASE WHEN CASE WHEN try_cast(lv_src.`id` AS DOUBLE) - try_cast(lv_src.`id` AS DOUBLE) = 0 THEN try_cast(lv_src.`id` AS DOUBLE) END = 0 THEN CAST(0 AS DOUBLE) ELSE CASE WHEN try_cast(lv_src.`id` AS DOUBLE) - try_cast(lv_src.`id` AS DOUBLE) = 0 THEN try_cast(lv_src.`id` AS DOUBLE) END END',
  redshift:
    'PARTITION BY CASE WHEN CASE WHEN CAST(lv_src."id" AS DOUBLE PRECISION) - CAST(lv_src."id" AS DOUBLE PRECISION) = 0 THEN CAST(lv_src."id" AS DOUBLE PRECISION) END = 0 THEN CAST(0 AS DOUBLE PRECISION) ELSE CASE WHEN CAST(lv_src."id" AS DOUBLE PRECISION) - CAST(lv_src."id" AS DOUBLE PRECISION) = 0 THEN CAST(lv_src."id" AS DOUBLE PRECISION) END END',
  duckdb:
    'PARTITION BY CASE WHEN CASE WHEN isfinite(TRY_CAST(lv_src."id" AS DOUBLE)) THEN TRY_CAST(lv_src."id" AS DOUBLE) END = 0 THEN CAST(0 AS DOUBLE) ELSE CASE WHEN isfinite(TRY_CAST(lv_src."id" AS DOUBLE)) THEN TRY_CAST(lv_src."id" AS DOUBLE) END END',
};

/**
 * Rule 3, a KPI of a RELATED measure (sum of Customers.zid, a number key): the head of the statement, per dialect. Each
 * related row (its table's `lv_k`, exposed as `lv_r1`) keeps its measure on one row only, over the whole filtered result;
 * BigQuery partitions by the key's 17-digit text (no float), as the cut does.
 */
export const KPI_MASK: Record<CompileDialectId, string> = {
  duckdb:
    'SELECT CAST(sum(lv_v0) AS DOUBLE) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY lv_src.lv_r1 ORDER BY lv_src.lv_r1) = 1 THEN CASE WHEN isfinite(TRY_CAST(lv_src.lv_c4 AS DOUBLE)) THEN TRY_CAST(lv_src.lv_c4 AS DOUBLE) END END AS lv_v0 FROM ',
  snowflake:
    'SELECT CAST(sum(lv_v0) AS DOUBLE) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY lv_src.lv_r1 ORDER BY lv_src.lv_r1) = 1 THEN CASE WHEN CAST(lv_src.lv_c4 AS DOUBLE) - CAST(lv_src.lv_c4 AS DOUBLE) = 0 THEN CAST(lv_src.lv_c4 AS DOUBLE) END END AS lv_v0 FROM ',
  bigquery:
    'SELECT CAST(sum(lv_v0) AS FLOAT64) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY FORMAT(\'%.17g\', lv_src.lv_r1) ORDER BY FORMAT(\'%.17g\', lv_src.lv_r1)) = 1 THEN CASE WHEN NOT IS_INF(SAFE_CAST(lv_src.lv_c4 AS FLOAT64)) AND NOT IS_NAN(SAFE_CAST(lv_src.lv_c4 AS FLOAT64)) THEN SAFE_CAST(lv_src.lv_c4 AS FLOAT64) END END AS lv_v0 FROM ',
  redshift:
    'SELECT CAST(sum(lv_v0) AS DOUBLE PRECISION) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY lv_src.lv_r1 ORDER BY lv_src.lv_r1) = 1 THEN CASE WHEN CAST(lv_src.lv_c4 AS DOUBLE PRECISION) - CAST(lv_src.lv_c4 AS DOUBLE PRECISION) = 0 THEN CAST(lv_src.lv_c4 AS DOUBLE PRECISION) END END AS lv_v0 FROM ',
  clickhouse:
    'SELECT toFloat64(sum(lv_v0)) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY lv_src.lv_r1 ORDER BY lv_src.lv_r1) = 1 THEN CASE WHEN isFinite(accurateCastOrNull(lv_src.lv_c4, \'Float64\')) THEN accurateCastOrNull(lv_src.lv_c4, \'Float64\') END END AS lv_v0 FROM ',
  databricks:
    'SELECT CAST(sum(lv_v0) AS DOUBLE) AS o_m0s FROM (SELECT CASE WHEN row_number() OVER (PARTITION BY lv_src.lv_r1 ORDER BY lv_src.lv_r1) = 1 THEN CASE WHEN try_cast(lv_src.lv_c4 AS DOUBLE) - try_cast(lv_src.lv_c4 AS DOUBLE) = 0 THEN try_cast(lv_src.lv_c4 AS DOUBLE) END END AS lv_v0 FROM ',
};

/** Rule 3 on a chart with a number split (no fold): the mask layer over `lv_raw`, per (category, series, related row). */
export const CHART_MASK = 'lv_base AS (SELECT lv_g, lv_s, CASE WHEN row_number() OVER (PARTITION BY lv_g, lv_s, lv_r0 ORDER BY lv_g, lv_s, lv_r0) = 1 THEN lv_u0 END AS lv_v0 FROM lv_raw)';
export const CHART_MASK_BIGQUERY = 'lv_base AS (SELECT lv_g, lv_s, CASE WHEN row_number() OVER (PARTITION BY lv_g, FORMAT(\'%.17g\', lv_s), lv_r0 ORDER BY lv_g, FORMAT(\'%.17g\', lv_s), lv_r0) = 1 THEN lv_u0 END AS lv_v0 FROM lv_raw)';

/** Rule 3 on a folded text axis (DuckDB): the rows under their folded key, masked per (folded key, related row), counted once. */
export const FOLD_MASK = "lv_kmap AS (SELECT DISTINCT lv_g, lv_k, lv_n FROM lv_fold),\nlv_kb AS (SELECT lv_kmap.lv_k AS lv_kk, lv_kmap.lv_n AS lv_kn, lv_base.* FROM lv_base JOIN lv_kmap ON coalesce(lv_base.lv_g, '') = coalesce(lv_kmap.lv_g, '') AND CASE WHEN lv_base.lv_g IS NULL THEN 1 ELSE 0 END = CASE WHEN lv_kmap.lv_g IS NULL THEN 1 ELSE 0 END),\nlv_bk AS (SELECT lv_kb.*, CASE WHEN row_number() OVER (PARTITION BY lv_kk, lv_r0 ORDER BY lv_kk, lv_r0) = 1 THEN lv_v0 END AS lv_w0 FROM lv_kb),\nlv_out AS (SELECT lv_kk AS lv_k, CAST(sum(lv_w0) AS DOUBLE) AS lv_b0s, CAST(max(lv_kn) AS DOUBLE) AS lv_nc FROM lv_bk GROUP BY lv_kk),\n";

const ORDERS: LiveColumn[] = [{ name: 'cust', type: 'text' }, { name: 'amt', type: 'number' }];
const CUSTOMERS: LiveColumn[] = [{ name: 'id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'zid', type: 'number' }];

export function joinedEnv(d: CompileDialectId, opts: { base?: [LiveFilter[], LiveFilter[]]; lock?: LiveFilter[]; idType?: 'number'; keyType?: 'number' } = {}): CompileEnv {
  const side = (parts: string[], columns: LiveColumn[], base?: LiveFilter[]): CompileEnv => ({ dialect: d, source: { kind: 'table', parts }, columns, ...(base?.length ? { base } : {}) });
  const num = (cols: LiveColumn[], name: string, on: boolean): LiveColumn[] => (on ? cols.map((c) => (c.name === name ? { ...c, type: 'number' as const } : c)) : cols);
  const customers = num(CUSTOMERS, 'id', !!opts.idType || !!opts.keyType);
  const orders = num(ORDERS, 'cust', !!opts.keyType);
  return {
    dialect: d,
    source: { kind: 'table', parts: ['shop', 'orders'] },
    columns: [...orders, ...customers.map((c) => ({ ...c, name: `Customers.${c.name}` }))],
    join: {
      sides: [{ env: side(['shop', 'orders'], orders, opts.base?.[0]), filters: [] }, { env: side(['shop', 'customers'], customers, opts.base?.[1]), filters: opts.lock ?? [], via: { parent: 0, from: 'cust', to: 'id' } }],
      columns: [{ table: 0, column: 'cust' }, { table: 0, column: 'amt' }, { table: 1, column: 'id' }, { table: 1, column: 'region' }, { table: 1, column: 'zid' }],
    },
  };
}

export const BY_REGION: LiveIR = { kind: 'chart', category: { column: 'Customers.region', kind: 'text' }, measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null };

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

export function joinShapes(ok: Ok, ids: readonly CompileDialectId[], inOrder: (id: CompileDialectId, q: CompiledQuery) => boolean): void {
  for (const id of ids) {
    const q = comp.compileChart(BY_REGION, { kind: 'text' }, joinedEnv(id));
    const sql = q.ok ? q.query.sql : '';
    ok(`${id}: a one-hop category join is ONE derived table aliased lv_src, as golden`, sql.includes(`FROM ${JOINED_FROM[id]})`), sql);
    ok(`${id}: …the chart reads it through the positional names (the category lv_c3, the measure lv_c1)`, /lv_src\.lv_c3\b/.test(sql) && /lv_src\.lv_c1\b/.test(sql) && !sql.includes('Customers.region'), sql.slice(0, 300));
    ok(`${id}: …every value bound, placeholders in text order`, q.ok && inOrder(id, q.query), q.ok && JSON.stringify(q.query.params));
    // ClickHouse fills an unmatched row of a LEFT JOIN with the type's default (0, '') unless told otherwise (./sql/print.ts).
    ok(`${id}: ${id === 'clickhouse' ? 'ends with SETTINGS join_use_nulls = 1, so an unmatched row reads NULL' : 'no SETTINGS clause'}`, sql.endsWith('\nSETTINGS join_use_nulls = 1') === (id === 'clickhouse'), sql.slice(-80));
    const plain = comp.compileChart({ ...BY_REGION, category: { column: 'cust', kind: 'text' } }, { kind: 'text' }, { dialect: id, source: { kind: 'table', parts: ['shop', 'orders'] }, columns: ORDERS });
    ok(`${id}: NEGATIVE CONTROL: the same chart with no join has no SETTINGS and no lv_t0`, plain.ok && !plain.query.sql.includes('SETTINGS') && !plain.query.sql.includes('lv_t0'), plain.ok && plain.query.sql.slice(-80));
    const bins = comp.compileBinRange({ ...BY_REGION, category: { column: 'Customers.zid', kind: 'bins' } }, joinedEnv(id));
    ok(`${id}: the bin-range probe of a related number category reads it through the join${id === 'clickhouse' ? ', SETTINGS too' : ''}`, bins.ok && /LEFT JOIN \(SELECT lv_k, lv_c4 FROM/.test(bins.query.sql) && bins.query.sql.endsWith('SETTINGS join_use_nulls = 1') === (id === 'clickhouse'), bins.ok ? bins.query.sql : JSON.stringify(bins));
    const own = comp.compileMetric({ ...BY_REGION, kind: 'metric', category: undefined }, joinedEnv(id));
    ok(`${id}: a statement that reads nothing of a related table leaves it out (no LEFT JOIN)`, own.ok && !own.query.sql.includes('LEFT JOIN') && own.query.sql.includes('lv_t0'), own.ok ? own.query.sql : JSON.stringify(own));
  }
  for (const id of ids) {
    const q = comp.compileChart(BY_REGION, { kind: 'text' }, joinedEnv(id, { keyType: 'number' }));
    const sql = q.ok ? q.query.sql : '';
    ok(`${id}: a number key partitions the one side as golden${id === 'bigquery' ? ' (by its 17-digit text: BigQuery partitions by no float)' : ''}`, sql.includes(`${NUMBER_PARTITION[id]} ORDER BY`), sql);
    ok(`${id}: …and both keys fold −0 into 0 before they meet`, (sql.match(/ = 0 THEN /g) ?? []).length >= 3 && sql.includes('ON lv_t0.lv_j1 = lv_t1.lv_k'), sql.slice(0, 400));
  }
  const zid = [{ column: 'Customers.zid', aggregation: 'sum' as const }];
  for (const id of ids) {
    const k = comp.compileMetric({ kind: 'metric', measures: zid, filters: [], order: 'natural', weekCal: null }, joinedEnv(id, { keyType: 'number' }));
    const sql = k.ok ? k.query.sql : '';
    ok(`${id}: a KPI of a related measure masks each related row to one row, as golden, and exposes that row (lv_r1)`, sql.startsWith(KPI_MASK[id]) && sql.includes('lv_t1.lv_k AS lv_r1')
      && sql.endsWith(id === 'clickhouse' ? ') AS lv_m\nSETTINGS join_use_nulls = 1' : ') AS lv_m'), sql);
    const c = comp.compileChart({ kind: 'chart', category: { column: 'amt', kind: 'bins' }, series: 'amt', measures: zid, filters: [], order: 'natural', weekCal: null }, { kind: 'bins', lo: 0, hi: 10, width: 1, bins: 10 }, joinedEnv(id));
    ok(`${id}: a chart of a related measure masks per (category, series, related row) in a layer of its own, as golden`, c.ok && c.query.sql.includes(id === 'bigquery' ? CHART_MASK_BIGQUERY : CHART_MASK), c.ok ? c.query.sql : JSON.stringify(c));
    const own = comp.compileChart(BY_REGION, { kind: 'text' }, joinedEnv(id));
    ok(`${id}: NEGATIVE CONTROL: a measure on the primary is never masked (no lv_r, no row_number past the cut's)`, own.ok && !/lv_r\d/.test(own.query.sql) && (own.query.sql.match(/row_number\(\)/g) ?? []).length === 1, own.ok && own.query.sql.slice(0, 200));
  }
  const fold = comp.compileChart({ ...BY_REGION, category: { column: 'cust', kind: 'text' }, measures: zid }, { kind: 'text' }, joinedEnv('duckdb'));
  ok('a folded text axis with a related measure ranks the unmasked rows, then masks per folded key and counts once, as golden', fold.ok && fold.query.sql.includes(FOLD_MASK) && !fold.query.sql.includes('lv_raw'), fold.ok ? fold.query.sql : JSON.stringify(fold));
  const days = comp.compileChart({ ...BY_REGION, category: { column: 'Customers.region', kind: 'date' }, measures: zid }, { kind: 'days', weekCal: { kind: '445', start: 1 } as never }, joinedEnv('duckdb'));
  ok('a related measure by week-calendar days refuses (relatedMeasure): days roll up past the mask', !days.ok && days.code === 'relatedMeasure', JSON.stringify(days));
  // Where each filter goes (DuckDB): a base filter and a lock inside their own scan; a primary question filter inside the
  // primary's scan; a related column's outside, on the joined cell.
  const base: [LiveFilter[], LiveFilter[]] = [[{ kind: 'compare', column: 'amt', op: '>', value: 1 }], [{ kind: 'compare', column: 'region', op: '!=', value: 'Test' }]];
  const lock: LiveFilter[] = [{ kind: 'in', column: 'region', values: ['North'], negate: false, binary: true }];
  const ir: LiveIR = { ...BY_REGION, filters: [{ kind: 'compare', column: 'amt', op: '<', value: 100 }, { kind: 'contains', column: 'Customers.region', value: 'or' }] };
  const q = comp.compileChart(ir, { kind: 'text' }, joinedEnv('duckdb', { base, lock }));
  const sql = q.ok ? q.query.sql : '';
  ok('the primary scan takes its base filter, then the question\'s filter on a primary column', sql.includes('FROM "shop"."orders" AS lv_src WHERE (CASE WHEN isfinite(TRY_CAST(lv_src."amt" AS DOUBLE)) THEN TRY_CAST(lv_src."amt" AS DOUBLE) END > CAST($1 AS DOUBLE)) AND (CASE WHEN isfinite(TRY_CAST(lv_src."amt" AS DOUBLE)) THEN TRY_CAST(lv_src."amt" AS DOUBLE) END < CAST($2 AS DOUBLE))) AS lv_t0'), sql);
  ok('the related scan takes its base filter, then the lock (compared as bytes), and nothing of the question', sql.includes(`FROM "shop"."customers" AS lv_src WHERE (coalesce(CAST(lv_src."region" AS VARCHAR), '') <> CAST($3 AS VARCHAR)) AND (encode(coalesce(CAST(lv_src."region" AS VARCHAR), '')) IN (encode(CAST($4 AS VARCHAR))))) AS lv_r`), sql);
  ok('a filter on a related column stays outside, on the joined cell', sql.includes(`) AS lv_src WHERE (coalesce(CAST(lv_src.lv_c3 AS VARCHAR), '') LIKE CAST($5 AS VARCHAR) ESCAPE '!')),`), sql);
  const types = comp.compileChart(BY_REGION, { kind: 'text' }, joinedEnv('duckdb', { idType: 'number' }));
  ok('a text key linked to a number one refuses joinKeyTypes, naming the column', !types.ok && types.code === 'joinKeyTypes' && types.params.column === 'cust', JSON.stringify(types));
}
