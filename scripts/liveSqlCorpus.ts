// The CORPUS of SQL on Live datasets (docs/live-data/01-live-sql.md, F1 + F2). Helper for
// scripts/test-liveSqlCompile.ts and scripts/test-liveSqlParity*.ts; not a suite itself.
//
//   CASES      DuckDB SQL as a model writes it, over `orders` (the Live parity fixture,
//              ./liveParityFixture.ts) and `targets` (below): phase B's examples, each allowed
//              construct, NULLs, blanks, '007', long ids, ISO weeks and year ends, quotes and
//              backslashes. Each writes a TOTAL order, so "the first 500" and every row's place are
//              the same on every engine (Ceilings: nondeterministic statements are not comparable).
//              `approx` names the float sums/means compared within 1e-13 (engine.md).
//   LITERALS   values a model may write that must travel as bound parameters, never text.
//   REFUSED    every construct F1 refuses and every R-L threat (R-L12…R-L15), each with the code it
//              is refused with, a PASSING TWIN (the same question without the construct) and, where
//              the guard is a table entry, the seam a negative control widens.

import type { LiveColumn } from '../src/engine/live/liveSpec';

export type Cell = string | number | null;

export interface SqlCase {
  name: string;
  sql: string;
  /** Output positions that are float sums or means (compared within 1e-13). */
  approx?: number[];
}

/** A second, small table with every awkward text: quotes, a backslash, LIKE's wildcards and escape, blanks, a BOM. */
export const TARGET_COLUMNS: LiveColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'target', type: 'number' },
  { name: 'since', type: 'date' },
  { name: 'note', type: 'text' },
];

export const TARGET_ROWS: Cell[][] = [
  ['North', 100, '2024-01-01', "it's"],
  ['South', 250.5, '2024-06-30', 'back\\slash'],
  ['East', -10, null, 'per%cent'],
  ['West', 0, '2023-12-31', 'under_score'],
  [null, 50, '2025-01-05', 'excl!aim'],
  ['Central', null, '2024-02-29', ''],
  ['east', 7, '2024-03-01', '  '],
  ['\ufeffBOM', 1, '2024-12-30', 'O\'Brien "quoted"'],
];

export const CASES: SqlCase[] = [
  { name: 'one group per region', sql: 'SELECT region, count(*) AS n, sum(qty) AS q, avg(qty) AS a FROM orders GROUP BY region ORDER BY region', approx: [3] },
  {
    name: 'every aggregate over every kind',
    sql: 'SELECT count(*) AS n, count(region) AS r, count(DISTINCT cat) AS c, sum(amt) AS s, avg(amt) AS a, min(amt) AS lo, max(amt) AS hi, min(d) AS d0, max(d) AS d1, min(cat) AS c0, max(cat) AS c1 FROM orders',
    approx: [3, 4],
  },
  { name: "NULL, '' and blanks in one group", sql: 'SELECT cat, count(*) AS n FROM orders GROUP BY cat ORDER BY cat' },
  { name: 'COALESCE with a literal, grouped by the expression', sql: "SELECT coalesce(region, 'none') AS r, count(*) AS n FROM orders GROUP BY coalesce(region, 'none') ORDER BY r" },
  {
    name: 'CASE buckets grouped by their alias',
    sql: "SELECT CASE WHEN amt > 100 THEN 'big' WHEN amt > 10 THEN 'mid' WHEN amt IS NULL THEN NULL ELSE 'small' END AS size, count(*) AS n FROM orders GROUP BY size ORDER BY size NULLS FIRST",
  },
  { name: 'months', sql: "SELECT date_trunc('month', d) AS m, count(*) AS n, sum(qty) AS q FROM orders WHERE d >= '2024-01-01' GROUP BY m ORDER BY m" },
  { name: 'ISO weeks across a year end', sql: "SELECT date_trunc('week', d) AS w, count(*) AS n FROM orders WHERE d BETWEEN '2024-12-20' AND DATE '2025-01-12' GROUP BY w ORDER BY w" },
  {
    name: 'quarters and years',
    sql: "SELECT extract(year FROM d) AS y, extract(quarter FROM d) AS q, date_trunc('quarter', d) AS qd, date_trunc('year', d) AS yd, count(*) AS n FROM orders WHERE d IS NOT NULL GROUP BY y, q, qd, yd ORDER BY y, q",
  },
  { name: 'month and day parts', sql: 'SELECT extract(month FROM d) AS m, extract(day FROM d) AS dd, count(*) AS n FROM orders WHERE d IS NOT NULL GROUP BY m, dd ORDER BY m, dd' },
  { name: 'days since a date', sql: "SELECT d, d - DATE '2024-01-01' AS days FROM orders WHERE d IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 40" },
  {
    name: 'January but not February (EXCEPT)',
    sql: "SELECT many FROM orders WHERE d >= '2024-01-01' AND d < '2024-02-01' EXCEPT SELECT many FROM orders WHERE d >= '2024-02-01' AND d < '2024-03-01' ORDER BY many",
  },
  {
    name: 'January but not February (NOT IN)',
    sql: "SELECT many, count(*) AS n FROM orders WHERE d BETWEEN '2024-01-01' AND '2024-01-31' AND many NOT IN (SELECT many FROM orders WHERE d BETWEEN '2024-02-01' AND '2024-02-29' AND many IS NOT NULL) GROUP BY many ORDER BY many",
  },
  {
    name: 'January but not February (NOT EXISTS, correlated)',
    sql: "SELECT DISTINCT o.many FROM orders o WHERE o.d BETWEEN '2024-01-01' AND '2024-01-31' AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.many = o.many AND p.d BETWEEN '2024-02-01' AND '2024-02-29') ORDER BY o.many",
  },
  {
    name: 'days between orders (lag)',
    sql: 'SELECT many, avg(gap) AS avg_gap, max(gap) AS max_gap, count(gap) AS gaps FROM (SELECT many, d - lag(d) OVER (PARTITION BY many ORDER BY d) AS gap FROM orders WHERE d IS NOT NULL) s GROUP BY many ORDER BY many',
    approx: [1],
  },
  {
    name: 'ranks over grouped totals',
    sql: 'SELECT region, q, rank() OVER (ORDER BY q DESC) AS rk, dense_rank() OVER (ORDER BY tiers DESC) AS dr, row_number() OVER (ORDER BY region NULLS FIRST) AS rn FROM (SELECT region, sum(qty) AS q, count(DISTINCT tier) AS tiers FROM orders GROUP BY region) s ORDER BY region',
  },
  {
    name: 'running total, moving mean, grand total',
    sql: 'SELECT many, n, sum(n) OVER (ORDER BY many ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running, avg(n) OVER (ORDER BY many ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving, sum(n) OVER () AS total FROM (SELECT many, count(*) AS n FROM orders GROUP BY many) s ORDER BY many',
    approx: [3],
  },
  {
    name: 'lead, lag, first and last value, a forward frame',
    sql: "SELECT m, n, lead(n, 2) OVER (ORDER BY m) AS ahead, lag(n) OVER (ORDER BY m) AS behind, first_value(n) OVER (ORDER BY m) AS first_n, last_value(n) OVER (ORDER BY m ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS next_n, max(n) OVER (ORDER BY m ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS peak FROM (SELECT date_trunc('month', d) AS m, count(*) AS n FROM orders WHERE d IS NOT NULL GROUP BY m) s ORDER BY m",
  },
  {
    name: 'a CTE read twice, once as a scalar',
    sql: "WITH m AS (SELECT region, date_trunc('month', d) AS mo, sum(qty) AS q FROM orders WHERE d IS NOT NULL GROUP BY region, mo) SELECT a.region, max(a.q) AS best, count(*) AS months, (SELECT max(q) FROM m) AS overall FROM m a GROUP BY a.region ORDER BY a.region",
  },
  { name: 'a CTE over a CTE', sql: 'WITH a AS (SELECT many, sum(qty) AS q FROM orders GROUP BY many), b AS (SELECT many, q FROM a WHERE q > 100) SELECT count(*) AS n, sum(q) AS total FROM b' },
  { name: 'a join of two views', sql: 'SELECT o.region, t.target, count(*) AS n, sum(o.qty) AS q FROM orders o JOIN targets t ON o.region = t.region GROUP BY o.region, t.target ORDER BY o.region' },
  { name: 'LEFT JOIN keeps the unmatched', sql: 'SELECT t.region, t.note, count(o.amt) AS n FROM targets t LEFT JOIN orders o ON o.region = t.region GROUP BY t.region, t.note ORDER BY t.region NULLS FIRST, t.note' },
  { name: 'RIGHT JOIN with a second condition', sql: 'SELECT t.region, count(o.qty) AS n FROM orders o RIGHT JOIN targets t ON o.region = t.region AND o.tier = 1 GROUP BY t.region ORDER BY t.region' },
  { name: 'FULL JOIN USING merges the key', sql: 'SELECT region, t.target, o.n FROM (SELECT region, count(*) AS n FROM orders GROUP BY region) o FULL JOIN targets t USING (region) ORDER BY region, t.target' },
  { name: 'a self join', sql: 'SELECT a.region, count(*) AS bigger FROM targets a JOIN targets b ON a.target < b.target GROUP BY a.region ORDER BY a.region NULLS FIRST' },
  { name: 'a quote inside a literal', sql: "SELECT count(*) AS n FROM orders WHERE cat = 'O''Brien'" },
  { name: "LIKE's wildcards", sql: "SELECT cat, count(*) AS n FROM orders WHERE cat LIKE 'a_b' OR cat LIKE '0%' OR cat LIKE '%東%' GROUP BY cat ORDER BY cat" },
  { name: 'LIKE with each engine\'s escape character in the pattern', sql: "SELECT note FROM targets WHERE note LIKE '%!%' OR note LIKE '%\\%' OR note LIKE 'back\\slash' OR note LIKE '%\\_%' ORDER BY note" },
  { name: 'NOT LIKE leaves NULL out', sql: "SELECT count(*) AS n, count(note) AS notes FROM targets WHERE note NOT LIKE '%e%'" },
  { name: "'007' and ids past 15 digits stay text", sql: "SELECT cat, bigid, count(*) AS n FROM orders WHERE cat IN ('007', '7') GROUP BY cat, bigid ORDER BY cat, bigid" },
  { name: 'a text cast to a number', sql: "SELECT CAST(cat AS DOUBLE) AS x, count(*) AS n FROM orders WHERE cat IN ('007', '7') GROUP BY x ORDER BY x" },
  { name: 'a date cast to text', sql: "SELECT CAST(d AS VARCHAR) AS s, count(*) AS n FROM orders WHERE d >= '2025-01-01' GROUP BY s ORDER BY s" },
  { name: 'text cast back to a date', sql: "SELECT CAST(CAST(d AS VARCHAR) AS DATE) AS dd FROM orders WHERE d < '2023-06-01' GROUP BY dd ORDER BY dd" },
  { name: 'HAVING over two aggregates', sql: 'SELECT many, sum(qty) AS q FROM orders GROUP BY many HAVING sum(qty) > 150 AND count(*) > 10 ORDER BY many' },
  { name: 'a share of a scalar subquery', sql: 'SELECT region, count(*) * 1.0 / (SELECT count(*) FROM orders) AS share FROM orders GROUP BY region ORDER BY region', approx: [1] },
  { name: 'UNION ALL keeps duplicates', sql: 'SELECT region AS r FROM targets UNION ALL SELECT region FROM targets ORDER BY r NULLS FIRST' },
  { name: 'UNION of two views', sql: 'SELECT region FROM orders UNION SELECT region FROM targets ORDER BY region' },
  { name: 'INTERSECT', sql: 'SELECT region FROM orders INTERSECT SELECT region FROM targets ORDER BY region' },
  { name: 'a nested set operation', sql: 'SELECT region FROM orders EXCEPT (SELECT region FROM targets WHERE target > 100 UNION SELECT region FROM targets WHERE target < 0) ORDER BY region' },
  { name: 'floor, ceil, abs and minus', sql: 'SELECT floor(amt) AS f, ceil(amt) AS c, abs(amt) AS a, -amt AS n FROM orders WHERE amt IS NOT NULL GROUP BY f, c, a, n ORDER BY f, c, a, n LIMIT 60' },
  { name: 'a division by zero is empty', sql: 'SELECT region, sum(qty) / count(CASE WHEN qty > 100 THEN 1 END) AS r, sum(qty) / NULLIF(count(*), 0) AS per FROM orders GROUP BY region ORDER BY region', approx: [2] },
  { name: 'counts divide as numbers', sql: 'SELECT count(*) / count(DISTINCT tier) AS per, count(*) / 2 AS half FROM orders' },
  { name: 'NOT BETWEEN on dates', sql: "SELECT count(*) AS n FROM orders WHERE d NOT BETWEEN '2024-01-01' AND '2024-12-31'" },
  { name: 'current_date', sql: 'SELECT count(*) AS past, count(CASE WHEN d >= current_date THEN 1 END) AS future FROM orders WHERE d < current_date OR d >= current_date' },
  { name: 'DISTINCT with NULL first', sql: 'SELECT DISTINCT region FROM orders ORDER BY region NULLS FIRST' },
  { name: 'DESC keeps NULL last, as DuckDB does', sql: 'SELECT tier, count(*) AS n FROM orders GROUP BY tier ORDER BY tier DESC' },
  { name: 'an empty answer', sql: 'SELECT many, amt FROM orders WHERE amt > 1000000 ORDER BY many, amt' },
  { name: 'IN a list of numbers', sql: 'SELECT tier, count(*) AS n FROM orders WHERE tier IN (1, 3) GROUP BY tier ORDER BY tier' },
  { name: 'SELECT * over the small table', sql: 'SELECT * FROM targets ORDER BY region NULLS FIRST, target' },
  { name: 't.* beside a derived table', sql: 'SELECT t.*, o.n FROM targets t JOIN (SELECT region, count(*) AS n FROM orders GROUP BY region) o ON o.region = t.region ORDER BY t.region' },
  { name: 'whitespace is text, not empty', sql: "SELECT count(*) AS n FROM orders WHERE cat = '  '" },
  { name: 'composed and decomposed é are two values', sql: "SELECT cat, count(*) AS n FROM orders WHERE cat IN ('\u00e9', 'e\u0301') GROUP BY cat ORDER BY cat" },
  { name: 'text compares by bytes', sql: "SELECT cat FROM orders WHERE cat < 'b' GROUP BY cat ORDER BY cat" },
  { name: 'literals returned as they are', sql: "SELECT 'it''s' AS a, '\\' AS b, '' AS c, 1.5 AS x, NULL AS z FROM targets WHERE region = 'North'" },
  { name: 'a LIMIT inside a CTE', sql: 'WITH top AS (SELECT many, sum(qty) AS q FROM orders GROUP BY many ORDER BY q DESC, many LIMIT 5) SELECT many, q FROM top ORDER BY many' },
  { name: 'a correlated scalar subquery', sql: 'SELECT region, (SELECT max(o.d) FROM orders o WHERE o.region = t.region) AS last_order FROM targets t ORDER BY region NULLS FIRST' },
  { name: 'IN a subquery over the second view', sql: 'SELECT region, count(*) AS n FROM orders WHERE region IN (SELECT region FROM targets WHERE target > 0) GROUP BY region ORDER BY region' },
  { name: "the model's own LIMIT", sql: 'SELECT many, count(*) AS n FROM orders GROUP BY many ORDER BY n DESC, many LIMIT 7' },
  { name: 'more than 500 rows stop at 500', sql: 'SELECT many, cat, amt, qty, d FROM orders ORDER BY many, d, amt, qty, cat' },
  { name: 'NULLIF grouped by the expression', sql: 'SELECT region, NULLIF(tier, 2) AS t, count(*) AS n FROM orders GROUP BY region, NULLIF(tier, 2) ORDER BY region, t' },
  { name: 'a CASE over dates', sql: "SELECT CASE WHEN d < DATE '2024-01-01' THEN 'before' WHEN d IS NULL THEN 'none' ELSE 'after' END AS era, min(d) AS first, max(d) AS last FROM orders GROUP BY era ORDER BY era" },
  { name: 'a comment and a quoted name', sql: 'SELECT "qty" /* ; DROP TABLE orders */, count(*) AS n FROM orders -- the rest\nGROUP BY "qty" ORDER BY "qty"' },
];

/** Values a model may write as literals: each must reach the warehouse as a parameter and never as text. */
export const LITERALS: string[] = [
  "'", "''", '\\', "\\'", '\u2018\u2019\u201c\u201d', '${x}', '?', '@p1', ':p0', '{p0:String}', '$1', '"', '`', '--', '/*', '*/', '#',
  "'; DROP TABLE orders; --", '%', '_', '!', '\n', "Robert'); DROP TABLE students;--", '\u202e', '\\x{0009}', '$$', 'U&\'\\0041\'',
  '\ufeff', 'é', '東京', '😀', ' ', '', '\u0000', 'a\u0000b',
];

/** A guard whose table a negative control widens: the function allow-list, or one node key's default. */
export type Seam = { kind: 'function'; name: string } | { kind: 'key'; shape: string; key: string };

export interface Refused {
  name: string;
  /** The threat it stands for (docs/live-data/01-live-sql.md), or the F1 refusal table. */
  threat: 'R-L12' | 'R-L13' | 'R-L14' | 'R-L15' | 'F1';
  sql: string;
  code: string;
  /** The same question without the construct: it translates. */
  twin: string;
  seam?: Seam;
}

const fn = (name: string): Seam => ({ kind: 'function', name });
const key = (shape: string, k: string): Seam => ({ kind: 'key', shape, key: k });

export const REFUSED: Refused[] = [
  // R-L15: reaching the base table another way.
  { threat: 'R-L15', name: 'a schema-qualified table', sql: 'SELECT region FROM analytics.orders', code: 'qualified', twin: 'SELECT region FROM orders' },
  { threat: 'R-L15', name: 'a catalog-qualified table', sql: 'SELECT region FROM wh.analytics.orders', code: 'qualified', twin: 'SELECT region FROM orders' },
  { threat: 'R-L15', name: 'information_schema', sql: 'SELECT table_name FROM information_schema.tables', code: 'qualified', twin: 'SELECT region FROM targets' },
  { threat: 'R-L15', name: 'pg_catalog', sql: 'SELECT * FROM pg_catalog.pg_tables', code: 'qualified', twin: 'SELECT * FROM targets' },
  { threat: 'R-L15', name: 'SNOWFLAKE.ACCOUNT_USAGE', sql: 'SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY', code: 'qualified', twin: 'SELECT * FROM targets' },
  { threat: 'R-L15', name: 'system.* (ClickHouse)', sql: 'SELECT * FROM system.tables', code: 'qualified', twin: 'SELECT * FROM targets' },
  { threat: 'R-L15', name: 'BigQuery INFORMATION_SCHEMA.JOBS', sql: 'SELECT query FROM `region-us`.INFORMATION_SCHEMA.JOBS', code: 'parse', twin: 'SELECT note FROM targets' },
  { threat: 'R-L15', name: 'a table the vocabulary does not hold', sql: 'SELECT * FROM tables', code: 'table', twin: 'SELECT * FROM targets' },
  { threat: 'R-L15', name: 'a qualified column', sql: 'SELECT analytics.orders.region FROM orders', code: 'qualified', twin: 'SELECT orders.region FROM orders' },
  { threat: 'R-L15', name: 'time travel AT (VERSION)', sql: 'SELECT region FROM orders AT (VERSION => 1)', code: 'construct', twin: 'SELECT region FROM orders', seam: key('ref:BASE_TABLE', 'at_clause') },
  { threat: 'R-L15', name: 'time travel AT (TIMESTAMP)', sql: "SELECT region FROM orders AT (TIMESTAMP => TIMESTAMP '2024-01-01')", code: 'construct', twin: 'SELECT region FROM orders', seam: key('ref:BASE_TABLE', 'at_clause') },
  { threat: 'R-L15', name: 'time travel FOR SYSTEM_TIME AS OF (BigQuery)', sql: "SELECT region FROM orders FOR SYSTEM_TIME AS OF '2024-01-01'", code: 'parse', twin: 'SELECT region FROM orders' },
  { threat: 'R-L15', name: 'time travel VERSION AS OF (Databricks)', sql: 'SELECT region FROM orders VERSION AS OF 1', code: 'parse', twin: 'SELECT region FROM orders' },
  { threat: 'R-L15', name: 'a sample of a table', sql: 'SELECT region FROM orders TABLESAMPLE 10', code: 'construct', twin: 'SELECT region FROM orders', seam: key('ref:BASE_TABLE', 'sample') },
  { threat: 'R-L15', name: 'a sample of a query', sql: 'SELECT region FROM orders USING SAMPLE 10', code: 'construct', twin: 'SELECT region FROM orders', seam: key('node:SELECT_NODE', 'sample') },
  { threat: 'R-L15', name: 'a Snowflake stage', sql: 'SELECT * FROM @~/orders.csv', code: 'parse', twin: 'SELECT * FROM orders' },
  { threat: 'R-L15', name: 'a file path as a table', sql: "SELECT * FROM 'orders.parquet'", code: 'table', twin: 'SELECT * FROM orders' },
  // R-L14: side effects and external reach — no IR node exists for any of them.
  { threat: 'R-L14', name: 'read_csv()', sql: "SELECT * FROM read_csv('/etc/passwd')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'url() (ClickHouse)', sql: "SELECT * FROM url('http://169.254.169.254/latest/meta-data')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 's3() (ClickHouse)', sql: "SELECT * FROM s3('s3://bucket/key.csv')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'remote() (ClickHouse)', sql: "SELECT * FROM remote('10.0.0.1', 'db', 't')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'mysql() (ClickHouse)', sql: "SELECT * FROM mysql('host:3306', 'db', 't', 'u', 'p')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'read_files() (Databricks)', sql: "SELECT * FROM read_files('s3://bucket/')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'EXTERNAL_QUERY (BigQuery)', sql: "SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT 1')", code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'range() (a value generator phase B allows)', sql: 'SELECT * FROM range(10)', code: 'construct', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'pg_sleep()', sql: 'SELECT pg_sleep(10) AS x FROM orders', code: 'function', twin: 'SELECT abs(10) AS x FROM orders', seam: fn('pg_sleep') },
  { threat: 'R-L14', name: 'pg_read_file()', sql: "SELECT pg_read_file('/etc/passwd') AS x FROM orders", code: 'function', twin: "SELECT coalesce(region, '/etc/passwd') AS x FROM orders", seam: fn('pg_read_file') },
  { threat: 'R-L14', name: 'dblink()', sql: "SELECT dblink('host=10.0.0.1', 'SELECT 1') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('dblink') },
  { threat: 'R-L14', name: 'lo_import()', sql: "SELECT lo_import('/etc/passwd') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('lo_import') },
  { threat: 'R-L14', name: 'set_config()', sql: "SELECT set_config('statement_timeout', '0', false) AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('set_config') },
  { threat: 'R-L14', name: 'nextval()', sql: "SELECT nextval('s') AS x FROM orders", code: 'function', twin: 'SELECT qty AS x FROM orders', seam: fn('nextval') },
  { threat: 'R-L14', name: 'current_setting()', sql: "SELECT current_setting('TimeZone') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('current_setting') },
  { threat: 'R-L14', name: 'getenv()', sql: "SELECT getenv('HOME') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('getenv') },
  { threat: 'R-L14', name: 'query() runs a string', sql: "SELECT query('SELECT 1') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('query') },
  { threat: 'R-L14', name: 'SYSTEM$ (Snowflake)', sql: 'SELECT system$whoami() AS x FROM orders', code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('system$whoami') },
  { threat: 'R-L14', name: 'Cortex (Snowflake)', sql: "SELECT SNOWFLAKE.CORTEX.COMPLETE('m', region) AS x FROM orders", code: 'construct', twin: 'SELECT region AS x FROM orders' },
  { threat: 'R-L14', name: 'ML.PREDICT (BigQuery)', sql: 'SELECT ML.PREDICT(region) AS x FROM orders', code: 'construct', twin: 'SELECT region AS x FROM orders' },
  { threat: 'R-L14', name: 'AI.GENERATE (BigQuery)', sql: "SELECT AI.GENERATE('p') AS x FROM orders", code: 'construct', twin: 'SELECT region AS x FROM orders' },
  { threat: 'R-L14', name: 'secret() (Databricks)', sql: "SELECT secret('scope', 'key') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('secret') },
  { threat: 'R-L14', name: 'http_request() (Databricks)', sql: "SELECT http_request('http://10.0.0.1') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('http_request') },
  { threat: 'R-L14', name: 'ai_query() (Databricks)', sql: "SELECT ai_query('m', region) AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('ai_query') },
  { threat: 'R-L14', name: 'dictGet() (ClickHouse)', sql: "SELECT dictGet('d', 'a', qty) AS x FROM orders", code: 'function', twin: 'SELECT qty AS x FROM orders', seam: fn('dictget') },
  { threat: 'R-L14', name: 'file() as a scalar (ClickHouse)', sql: "SELECT file('/etc/passwd') AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders', seam: fn('file') },
  { threat: 'R-L14', name: 'a SETTINGS clause (ClickHouse)', sql: 'SELECT region FROM orders SETTINGS readonly = 0', code: 'parse', twin: 'SELECT region FROM orders' },
  // Not one SELECT: nothing serializes, so nothing is translated.
  { threat: 'R-L14', name: 'SET', sql: 'SET threads = 1', code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'COPY … TO', sql: "COPY orders TO 'orders.csv'", code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'COPY (query) TO', sql: "COPY (SELECT * FROM orders) TO 'x.csv'", code: 'statement', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'COPY INTO @stage (Snowflake unload)', sql: 'COPY INTO @stage FROM orders', code: 'parse', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'EXPORT DATA (BigQuery)', sql: "EXPORT DATA OPTIONS (uri = 'gs://b/*') AS SELECT * FROM orders", code: 'parse', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'CALL', sql: 'CALL pragma_version()', code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'PRAGMA', sql: 'PRAGMA version', code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'ATTACH', sql: "ATTACH 'x.db'", code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'INSTALL', sql: 'INSTALL httpfs', code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'CREATE TABLE AS', sql: 'CREATE TABLE x AS SELECT * FROM orders', code: 'statement', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'INSERT', sql: "INSERT INTO targets VALUES ('x', 1, NULL, NULL)", code: 'statement', twin: 'SELECT * FROM targets' },
  { threat: 'R-L14', name: 'UPDATE', sql: 'UPDATE targets SET target = 0', code: 'statement', twin: 'SELECT * FROM targets' },
  { threat: 'R-L14', name: 'DELETE', sql: 'DELETE FROM targets', code: 'statement', twin: 'SELECT * FROM targets' },
  { threat: 'R-L14', name: 'DROP', sql: 'DROP TABLE orders', code: 'statement', twin: 'SELECT * FROM orders' },
  { threat: 'R-L14', name: 'two statements', sql: 'SELECT region FROM orders; SELECT note FROM targets', code: 'statement', twin: 'SELECT region FROM orders' },
  { threat: 'R-L14', name: 'a statement then DROP', sql: 'SELECT region FROM orders; DROP TABLE orders', code: 'statement', twin: 'SELECT region FROM orders;' },
  { threat: 'R-L14', name: 'a temp JS function (BigQuery)', sql: "CREATE TEMP FUNCTION f(x FLOAT64) RETURNS FLOAT64 LANGUAGE js AS 'return x'; SELECT f(qty) FROM orders", code: 'parse', twin: 'SELECT qty FROM orders' },
  // R-L12: what another engine's parser would read differently.
  { threat: 'R-L12', name: 'a # comment (BigQuery)', sql: 'SELECT region FROM orders # where 1 = 0', code: 'parse', twin: 'SELECT region FROM orders -- where 1 = 0' },
  { threat: 'R-L12', name: 'a backquoted name (BigQuery, ClickHouse)', sql: 'SELECT `region` FROM orders', code: 'function', twin: 'SELECT "region" FROM orders' },
  { threat: 'R-L12', name: 'a placeholder ($1)', sql: 'SELECT region FROM orders WHERE region = $1', code: 'construct', twin: "SELECT region FROM orders WHERE region = 'x'" },
  { threat: 'R-L12', name: 'a placeholder (?)', sql: 'SELECT region FROM orders WHERE region = ?', code: 'construct', twin: "SELECT region FROM orders WHERE region = 'x'" },
  { threat: 'R-L12', name: 'COLLATE', sql: 'SELECT region FROM orders WHERE region COLLATE nocase = \'east\'', code: 'construct', twin: "SELECT region FROM orders WHERE region = 'east'" },
  // F1's refusal table (docs/live-data/01-live-sql.md "What the IR allows (F1)").
  { threat: 'F1', name: 'WITH RECURSIVE', sql: 'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT n FROM r', code: 'construct', twin: 'WITH r AS (SELECT 1 AS n FROM orders) SELECT n FROM r' },
  { threat: 'F1', name: 'LATERAL', sql: 'SELECT o.region, x.n FROM orders o, LATERAL (SELECT o.qty AS n) x', code: 'construct', twin: 'SELECT o.region, o.qty AS n FROM orders o' },
  { threat: 'F1', name: 'QUALIFY', sql: 'SELECT region FROM orders QUALIFY row_number() OVER (ORDER BY d) = 1', code: 'construct', twin: 'SELECT region, row_number() OVER (ORDER BY d) AS rn FROM orders', seam: key('node:SELECT_NODE', 'qualify') },
  { threat: 'F1', name: 'PIVOT', sql: 'PIVOT orders ON region USING sum(qty)', code: 'statement', twin: 'SELECT region, sum(qty) AS q FROM orders GROUP BY region' },
  { threat: 'F1', name: 'ROLLUP', sql: 'SELECT region, sum(qty) AS q FROM orders GROUP BY ROLLUP (region)', code: 'construct', twin: 'SELECT region, sum(qty) AS q FROM orders GROUP BY region' },
  { threat: 'F1', name: 'GROUPING SETS', sql: 'SELECT region, tier, sum(qty) AS q FROM orders GROUP BY GROUPING SETS ((region), (tier))', code: 'construct', twin: 'SELECT region, tier, sum(qty) AS q FROM orders GROUP BY region, tier' },
  { threat: 'F1', name: 'GROUP BY ALL', sql: 'SELECT region, sum(qty) AS q FROM orders GROUP BY ALL', code: 'construct', twin: 'SELECT region, sum(qty) AS q FROM orders GROUP BY region', seam: key('node:SELECT_NODE', 'aggregate_handling') },
  { threat: 'F1', name: 'VALUES', sql: 'SELECT * FROM (VALUES (1), (2)) v(x)', code: 'construct', twin: 'SELECT qty AS x FROM orders' },
  { threat: 'F1', name: 'a list', sql: 'SELECT [qty, tier] AS xs FROM orders', code: 'function', twin: 'SELECT qty, tier FROM orders' },
  { threat: 'F1', name: 'a struct', sql: "SELECT {'a': qty} AS s FROM orders", code: 'function', twin: 'SELECT qty AS a FROM orders' },
  { threat: 'F1', name: 'a lambda', sql: 'SELECT list_transform([qty], x -> x + 1) AS xs FROM orders', code: 'function', twin: 'SELECT qty + 1 AS x FROM orders' },
  { threat: 'F1', name: 'regexp_matches', sql: "SELECT count(*) AS n FROM orders WHERE regexp_matches(cat, '^a')", code: 'function', twin: "SELECT count(*) AS n FROM orders WHERE cat LIKE 'a%'", seam: fn('regexp_matches') },
  { threat: 'F1', name: 'lower', sql: 'SELECT lower(cat) AS c FROM orders', code: 'function', twin: 'SELECT cat AS c FROM orders', seam: fn('lower') },
  { threat: 'F1', name: 'upper', sql: 'SELECT upper(cat) AS c FROM orders', code: 'function', twin: 'SELECT cat AS c FROM orders', seam: fn('upper') },
  { threat: 'F1', name: 'length', sql: 'SELECT length(cat) AS c FROM orders', code: 'function', twin: 'SELECT cat AS c FROM orders', seam: fn('length') },
  { threat: 'F1', name: 'substring', sql: 'SELECT substring(cat, 1, 2) AS c FROM orders', code: 'function', twin: 'SELECT cat AS c FROM orders', seam: fn('substring') },
  { threat: 'F1', name: 'round', sql: 'SELECT round(amt) AS r FROM orders', code: 'function', twin: 'SELECT floor(amt) AS r FROM orders', seam: fn('round') },
  { threat: 'F1', name: 'now()', sql: 'SELECT count(*) AS n FROM orders WHERE d < now()', code: 'function', twin: 'SELECT count(*) AS n FROM orders WHERE d < current_date', seam: fn('now') },
  { threat: 'F1', name: 'ILIKE', sql: "SELECT count(*) AS n FROM orders WHERE cat ILIKE 'a%'", code: 'function', twin: "SELECT count(*) AS n FROM orders WHERE cat LIKE 'a%'", seam: fn('~~*') },
  { threat: 'F1', name: 'LIKE … ESCAPE', sql: "SELECT count(*) AS n FROM orders WHERE cat LIKE 'a!%' ESCAPE '!'", code: 'function', twin: "SELECT count(*) AS n FROM orders WHERE cat LIKE 'a%'" },
  { threat: 'F1', name: 'a positional ORDER BY', sql: 'SELECT region, count(*) AS n FROM orders GROUP BY region ORDER BY 1', code: 'construct', twin: 'SELECT region, count(*) AS n FROM orders GROUP BY region ORDER BY region' },
  { threat: 'F1', name: 'a positional GROUP BY', sql: 'SELECT region, count(*) AS n FROM orders GROUP BY 1', code: 'construct', twin: 'SELECT region, count(*) AS n FROM orders GROUP BY region' },
  { threat: 'F1', name: 'a positional reference (#1)', sql: 'SELECT #1 FROM orders', code: 'construct', twin: 'SELECT many FROM orders' },
  { threat: 'F1', name: '* EXCLUDE', sql: 'SELECT * EXCLUDE (cat) FROM orders', code: 'construct', twin: 'SELECT * FROM orders', seam: key('expr:STAR', 'exclude_list') },
  { threat: 'F1', name: '* REPLACE', sql: 'SELECT * REPLACE (qty + 1 AS qty) FROM orders', code: 'construct', twin: 'SELECT * FROM orders', seam: key('expr:STAR', 'replace_list') },
  { threat: 'F1', name: 'COLUMNS()', sql: "SELECT COLUMNS('a.*') FROM orders", code: 'construct', twin: 'SELECT amt FROM orders' },
  { threat: 'F1', name: 'EXCEPT ALL', sql: 'SELECT region FROM orders EXCEPT ALL SELECT region FROM targets', code: 'construct', twin: 'SELECT region FROM orders EXCEPT SELECT region FROM targets' },
  { threat: 'F1', name: 'INTERSECT ALL', sql: 'SELECT region FROM orders INTERSECT ALL SELECT region FROM targets', code: 'construct', twin: 'SELECT region FROM orders INTERSECT SELECT region FROM targets' },
  { threat: 'F1', name: 'UNION BY NAME', sql: 'SELECT region FROM orders UNION BY NAME SELECT region FROM targets', code: 'construct', twin: 'SELECT region FROM orders UNION SELECT region FROM targets' },
  { threat: 'F1', name: 'CROSS JOIN', sql: 'SELECT o.region, t.note FROM orders o CROSS JOIN targets t', code: 'construct', twin: 'SELECT o.region, t.note FROM orders o JOIN targets t ON o.region = t.region' },
  { threat: 'F1', name: 'a comma join', sql: 'SELECT o.region, t.note FROM orders o, targets t WHERE o.region = t.region', code: 'construct', twin: 'SELECT o.region, t.note FROM orders o JOIN targets t ON o.region = t.region' },
  { threat: 'F1', name: 'NATURAL JOIN', sql: 'SELECT region FROM orders NATURAL JOIN targets', code: 'construct', twin: 'SELECT region FROM orders JOIN targets USING (region)' },
  { threat: 'F1', name: 'ASOF JOIN', sql: 'SELECT o.region FROM orders o ASOF JOIN targets t ON o.d >= t.since', code: 'construct', twin: 'SELECT o.region FROM orders o JOIN targets t ON o.d >= t.since' },
  { threat: 'F1', name: 'SEMI JOIN', sql: 'SELECT o.region FROM orders o SEMI JOIN targets t ON o.region = t.region', code: 'construct', twin: 'SELECT o.region FROM orders o JOIN targets t ON o.region = t.region' },
  { threat: 'F1', name: 'FILTER (WHERE …)', sql: 'SELECT count(*) FILTER (WHERE qty > 1) AS n FROM orders', code: 'construct', twin: 'SELECT count(CASE WHEN qty > 1 THEN 1 END) AS n FROM orders', seam: key('expr:FUNCTION', 'filter') },
  { threat: 'F1', name: 'OFFSET', sql: 'SELECT region FROM orders ORDER BY region LIMIT 5 OFFSET 2', code: 'construct', twin: 'SELECT region FROM orders ORDER BY region LIMIT 5', seam: key('mod:LIMIT_MODIFIER', 'offset') },
  { threat: 'F1', name: 'DISTINCT ON', sql: 'SELECT DISTINCT ON (region) region, qty FROM orders', code: 'construct', twin: 'SELECT DISTINCT region, qty FROM orders', seam: key('mod:DISTINCT_MODIFIER', 'distinct_on_targets') },
  { threat: 'F1', name: 'IGNORE NULLS', sql: 'SELECT first_value(qty IGNORE NULLS) OVER (ORDER BY d) AS f FROM orders', code: 'construct', twin: 'SELECT first_value(qty) OVER (ORDER BY d) AS f FROM orders', seam: key('expr:WINDOW', 'ignore_nulls') },
  { threat: 'F1', name: 'a default for lag', sql: 'SELECT lag(qty, 1, 0) OVER (ORDER BY d) AS p FROM orders', code: 'construct', twin: 'SELECT lag(qty, 1) OVER (ORDER BY d) AS p FROM orders', seam: key('expr:WINDOW', 'default_expr') },
  { threat: 'F1', name: 'a RANGE frame with an offset', sql: 'SELECT sum(qty) OVER (ORDER BY qty RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM orders', code: 'construct', twin: 'SELECT sum(qty) OVER (ORDER BY qty ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM orders' },
  { threat: 'F1', name: 'TRY_CAST', sql: 'SELECT TRY_CAST(cat AS DOUBLE) AS x FROM orders', code: 'construct', twin: 'SELECT CAST(cat AS DOUBLE) AS x FROM orders', seam: key('expr:CAST', 'try_cast') },
  { threat: 'F1', name: 'a cast to INTEGER', sql: 'SELECT CAST(amt AS INTEGER) AS x FROM orders', code: 'construct', twin: 'SELECT CAST(amt AS DOUBLE) AS x FROM orders' },
  { threat: 'F1', name: 'a number cast to text', sql: 'SELECT CAST(amt AS VARCHAR) AS x FROM orders', code: 'construct', twin: 'SELECT CAST(d AS VARCHAR) AS x FROM orders' },
  { threat: 'F1', name: '|| (concatenation)', sql: "SELECT region || '!' AS x FROM orders", code: 'function', twin: 'SELECT region AS x FROM orders' },
  { threat: 'F1', name: '% (modulo)', sql: 'SELECT qty % 2 AS x FROM orders', code: 'function', twin: 'SELECT qty / 2 AS x FROM orders' },
  { threat: 'F1', name: 'IS DISTINCT FROM', sql: 'SELECT count(*) AS n FROM orders WHERE region IS DISTINCT FROM cat', code: 'construct', twin: 'SELECT count(*) AS n FROM orders WHERE region <> cat' },
  { threat: 'F1', name: 'a timestamp minus a timestamp', sql: "SELECT date_trunc('month', d) - date_trunc('year', d) AS x FROM orders", code: 'type', twin: 'SELECT d - d AS x FROM orders' },
  { threat: 'F1', name: 'a date plus a number', sql: 'SELECT d + 1 AS x FROM orders', code: 'type', twin: "SELECT d - DATE '2024-01-01' AS x FROM orders" },
  { threat: 'F1', name: 'sum over text', sql: 'SELECT sum(cat) AS x FROM orders', code: 'type', twin: 'SELECT count(cat) AS x FROM orders' },
  { threat: 'F1', name: 'a number compared with text', sql: "SELECT count(*) AS n FROM orders WHERE qty = '7'", code: 'type', twin: 'SELECT count(*) AS n FROM orders WHERE qty = 7' },
  { threat: 'F1', name: 'a text literal that is not a day', sql: "SELECT count(*) AS n FROM orders WHERE d >= '2024-13-01'", code: 'date', twin: "SELECT count(*) AS n FROM orders WHERE d >= '2024-12-01'" },
  { threat: 'F1', name: 'a condition as a column', sql: 'SELECT qty > 1 AS big FROM orders', code: 'type', twin: 'SELECT CASE WHEN qty > 1 THEN 1 ELSE 0 END AS big FROM orders' },
  { threat: 'F1', name: 'an aggregate in WHERE', sql: 'SELECT region FROM orders WHERE sum(qty) > 1', code: 'aggregate', twin: 'SELECT region FROM orders GROUP BY region HAVING sum(qty) > 1' },
  { threat: 'F1', name: 'a window function in WHERE', sql: 'SELECT region FROM orders WHERE row_number() OVER () = 1', code: 'window', twin: 'SELECT region, row_number() OVER (ORDER BY region) AS rn FROM orders' },
  { threat: 'F1', name: 'an unknown column', sql: 'SELECT cost FROM orders', code: 'column', twin: 'SELECT amt FROM orders' },
  { threat: 'F1', name: 'an ambiguous column', sql: 'SELECT region FROM orders o JOIN targets t ON o.region = t.region', code: 'ambiguous', twin: 'SELECT o.region FROM orders o JOIN targets t ON o.region = t.region' },
  { threat: 'F1', name: 'a LIMIT of 0', sql: 'SELECT region FROM orders LIMIT 0', code: 'whole', twin: 'SELECT region FROM orders LIMIT 1' },
  { threat: 'F1', name: 'a date_trunc unit outside the four', sql: "SELECT date_trunc('hour', d) AS h FROM orders", code: 'unit', twin: "SELECT date_trunc('month', d) AS h FROM orders" },
  { threat: 'F1', name: 'an extract part outside the four', sql: 'SELECT extract(dow FROM d) AS w FROM orders', code: 'unit', twin: 'SELECT extract(month FROM d) AS w FROM orders' },
  { threat: 'F1', name: 'a LIKE pattern that is a column', sql: 'SELECT count(*) AS n FROM orders WHERE cat LIKE region', code: 'like', twin: "SELECT count(*) AS n FROM orders WHERE cat LIKE 'r%'" },
  { threat: 'F1', name: 'a statement reading no dataset', sql: 'SELECT 1 AS one', code: 'noTable', twin: 'SELECT 1 AS one FROM orders' },
  { threat: 'F1', name: 'a set operation of unequal widths', sql: 'SELECT region, qty FROM orders UNION SELECT region FROM targets', code: 'columns', twin: 'SELECT region FROM orders UNION SELECT region FROM targets' },
  { threat: 'F1', name: 'a set operation mixing kinds', sql: 'SELECT qty FROM orders UNION SELECT region FROM targets', code: 'columns', twin: 'SELECT qty FROM orders UNION SELECT target FROM targets' },
  { threat: 'F1', name: 'a huge integer literal', sql: 'SELECT count(*) AS n FROM orders WHERE qty < 123456789012345678901234567890', code: 'number', twin: 'SELECT count(*) AS n FROM orders WHERE qty < 1234567890' },
  { threat: 'F1', name: 'the same alias twice in FROM', sql: 'SELECT a.region FROM orders a JOIN targets a ON a.region = a.region', code: 'duplicate', twin: 'SELECT a.region FROM orders a JOIN targets b ON a.region = b.region' },
];
