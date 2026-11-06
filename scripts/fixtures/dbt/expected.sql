-- The figures in expected.json, as SQL in MetricFlow's shapes, run with the DuckDB CLI from this folder:
--   duckdb -json < expected.sql
-- See README.md: this stands in for `mf query` until MetricFlow records them (the owner's step).
CREATE TABLE orders AS SELECT * FROM read_csv('seed.csv', header = true, columns = {
  'id': 'VARCHAR', 'customer_id': 'VARCHAR', 'region': 'VARCHAR', 'amount': 'DOUBLE', 'status': 'VARCHAR',
  'order_date': 'DATE', 'stock_date': 'DATE', 'units': 'INTEGER' });
CREATE TABLE visits AS SELECT * FROM read_csv('visits.csv', header = true, columns = {
  'visit_id': 'VARCHAR', 'customer_id': 'VARCHAR', 'visit_date': 'DATE' });


-- Spelled out (DuckDB has no dynamic SQL): every simple metric × {total, region, month}.
CREATE TABLE figures AS
WITH
s AS (
  SELECT 'Revenue' AS metric, '' AS grp, '' AS k, CAST(sum(amount) AS DOUBLE) AS v FROM orders
  UNION ALL SELECT 'Revenue', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders GROUP BY region
  UNION ALL SELECT 'Revenue', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders GROUP BY 3
  UNION ALL SELECT 'Orders', '', '', CAST(count(id) AS DOUBLE) FROM orders
  UNION ALL SELECT 'Orders', 'region', region, CAST(count(id) AS DOUBLE) FROM orders GROUP BY region
  UNION ALL SELECT 'Orders', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(count(id) AS DOUBLE) FROM orders GROUP BY 3
  UNION ALL SELECT 'Avg order', '', '', avg(amount) FROM orders
  UNION ALL SELECT 'Avg order', 'region', region, avg(amount) FROM orders GROUP BY region
  UNION ALL SELECT 'Avg order', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), avg(amount) FROM orders GROUP BY 3
  UNION ALL SELECT 'Smallest order', '', '', min(amount) FROM orders
  UNION ALL SELECT 'Smallest order', 'region', region, min(amount) FROM orders GROUP BY region
  UNION ALL SELECT 'Smallest order', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), min(amount) FROM orders GROUP BY 3
  UNION ALL SELECT 'Largest order', '', '', max(amount) FROM orders
  UNION ALL SELECT 'Largest order', 'region', region, max(amount) FROM orders GROUP BY region
  UNION ALL SELECT 'Largest order', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), max(amount) FROM orders GROUP BY 3
  UNION ALL SELECT 'Customers', '', '', CAST(count(DISTINCT customer_id) AS DOUBLE) FROM orders
  UNION ALL SELECT 'Customers', 'region', region, CAST(count(DISTINCT customer_id) AS DOUBLE) FROM orders GROUP BY region
  UNION ALL SELECT 'Customers', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(count(DISTINCT customer_id) AS DOUBLE) FROM orders GROUP BY 3
  UNION ALL SELECT 'EU revenue', '', '', CAST(sum(amount) AS DOUBLE) FROM orders WHERE region = 'EU'
  UNION ALL SELECT 'EU revenue', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders WHERE region = 'EU' GROUP BY region
  UNION ALL SELECT 'EU revenue', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders WHERE region = 'EU' GROUP BY 3
  UNION ALL SELECT 'Refunds', '', '', CAST(sum(amount) AS DOUBLE) FROM orders WHERE status = 'refunded'
  UNION ALL SELECT 'Refunds', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders WHERE status = 'refunded' GROUP BY region
  UNION ALL SELECT 'Refunds', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders WHERE status = 'refunded' GROUP BY 3
  UNION ALL SELECT 'Not refunded', '', '', CAST(sum(amount) AS DOUBLE) FROM orders WHERE status != 'refunded'
  UNION ALL SELECT 'Not refunded', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders WHERE status != 'refunded' GROUP BY region
  UNION ALL SELECT 'Not refunded', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders WHERE status != 'refunded' GROUP BY 3
  UNION ALL SELECT 'EU and US revenue', '', '', CAST(sum(amount) AS DOUBLE) FROM orders WHERE region IN ('EU', 'US')
  UNION ALL SELECT 'EU and US revenue', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders WHERE region IN ('EU', 'US') GROUP BY region
  UNION ALL SELECT 'EU and US revenue', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders WHERE region IN ('EU', 'US') GROUP BY 3
  UNION ALL SELECT 'Bulk revenue', '', '', CAST(sum(amount) AS DOUBLE) FROM orders WHERE units >= 5 AND status = 'paid'
  UNION ALL SELECT 'Bulk revenue', 'region', region, CAST(sum(amount) AS DOUBLE) FROM orders WHERE units >= 5 AND status = 'paid' GROUP BY region
  UNION ALL SELECT 'Bulk revenue', 'month', strftime(date_trunc('month', order_date), '%Y-%m'), CAST(sum(amount) AS DOUBLE) FROM orders WHERE units >= 5 AND status = 'paid' GROUP BY 3
  UNION ALL SELECT 'Visits', '', '', CAST(count(visit_id) AS DOUBLE) FROM visits
  UNION ALL SELECT 'Visits', 'month', strftime(date_trunc('month', visit_date), '%Y-%m'), CAST(count(visit_id) AS DOUBLE) FROM visits GROUP BY 3
),
-- A ratio and a derived metric: each input on its own at the group, FULL OUTER JOINed on it (MetricFlow's combine).
pair AS (
  SELECT coalesce(a.grp, b.grp) AS grp, coalesce(a.k, b.k) AS k, a.v AS av, b.v AS bv, a.metric AS am, b.metric AS bm
  FROM (SELECT * FROM s WHERE metric = 'Revenue') a FULL OUTER JOIN (SELECT * FROM s WHERE metric = 'Orders') b ON a.grp = b.grp AND a.k = b.k
),
pair2 AS (
  SELECT coalesce(a.grp, b.grp) AS grp, coalesce(a.k, b.k) AS k, a.v AS av, b.v AS bv
  FROM (SELECT * FROM s WHERE metric = 'Revenue') a FULL OUTER JOIN (SELECT * FROM s WHERE metric = 'Refunds') b ON a.grp = b.grp AND a.k = b.k
),
-- A balance: the rows on the last stock_date of the whole query, or of each month (the queried time grain); a region
-- is not a window grouping, so it does not get a last day of its own.
stock AS (
  SELECT 'Stock' AS metric, '' AS grp, '' AS k, CAST(sum(units) AS DOUBLE) AS v FROM orders WHERE stock_date = (SELECT max(stock_date) FROM orders)
  UNION ALL SELECT 'Stock', 'region', region, CAST(sum(units) AS DOUBLE) FROM orders WHERE stock_date = (SELECT max(stock_date) FROM orders) GROUP BY region
  UNION ALL SELECT 'Stock', 'month', strftime(date_trunc('month', o.stock_date), '%Y-%m'), CAST(sum(o.units) AS DOUBLE) FROM orders o
    JOIN (SELECT date_trunc('month', stock_date) AS m, max(stock_date) AS last FROM orders GROUP BY 1) w ON date_trunc('month', o.stock_date) = w.m AND o.stock_date = w.last GROUP BY 3
)
SELECT metric, grp, k, v FROM s
UNION ALL SELECT 'AOV', grp, k, CAST(av AS DOUBLE) / CAST(NULLIF(bv, 0) AS DOUBLE) FROM pair
UNION ALL SELECT 'Net', grp, k, av - bv FROM pair2
UNION ALL SELECT metric, grp, k, v FROM stock;

SELECT metric, grp, k, v FROM figures ORDER BY metric, grp, k;
