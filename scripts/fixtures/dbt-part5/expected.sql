-- The figures in expected.json, as SQL in MetricFlow's shapes (README.md, "Status"), run from this folder:
--   duckdb -noheader -list < expected.sql > expected.json
-- Pending MetricFlow: the owner's `mf query` run replaces every figure here once.
CREATE TABLE orders AS SELECT * FROM read_csv('orders.csv', header = true, columns = {
  'order_id': 'VARCHAR', 'customer_id': 'VARCHAR', 'region': 'VARCHAR', 'amount': 'BIGINT', 'status': 'VARCHAR', 'order_date': 'DATE' });
CREATE TABLE events AS SELECT * FROM read_csv('events.csv', header = true, columns = { 'user_id': 'VARCHAR', 'event': 'VARCHAR', 'ts': 'DATE' });
-- The project's time spine (README: metricflow_time_spine).
CREATE TABLE spine AS SELECT CAST(range AS DATE) AS d FROM range(DATE '2023-01-01', DATE '2026-01-01', INTERVAL 1 DAY);

-- A cumulative metric by day, as MetricFlow's "join self over time range" (docs.getdbt.com/docs/build/cumulative): the
-- time spine INNER JOINed to the rows in each day's window, so a day whose window holds no row has no figure.
--   window N days: order_date <= d AND order_date > d - N days;  grain_to_date G: order_date >= date_trunc(G, d) AND <= d.
CREATE TABLE daily AS
SELECT 'revenue_7d' AS metric, s.d, CAST(sum(o.amount) AS DOUBLE) AS v FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date > s.d - INTERVAL 7 DAY GROUP BY s.d
UNION ALL SELECT 'revenue_2w', s.d, CAST(sum(o.amount) AS DOUBLE) FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date > s.d - INTERVAL 2 WEEK GROUP BY s.d
UNION ALL SELECT 'revenue_mtd', s.d, CAST(sum(o.amount) AS DOUBLE) FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date >= date_trunc('month', s.d) GROUP BY s.d
UNION ALL SELECT 'revenue_qtd', s.d, CAST(sum(o.amount) AS DOUBLE) FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date >= date_trunc('quarter', s.d) GROUP BY s.d
UNION ALL SELECT 'revenue_ytd', s.d, CAST(sum(o.amount) AS DOUBLE) FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date >= date_trunc('year', s.d) GROUP BY s.d
UNION ALL SELECT 'eu_revenue_7d', s.d, CAST(sum(o.amount) AS DOUBLE) FROM spine s JOIN (SELECT * FROM orders WHERE region = 'EU') o ON o.order_date <= s.d AND o.order_date > s.d - INTERVAL 7 DAY GROUP BY s.d
UNION ALL SELECT 'orders_7d', s.d, CAST(count(o.order_id) AS DOUBLE) FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date > s.d - INTERVAL 7 DAY GROUP BY s.d;

-- period_agg: last at a coarser grain: last_value over the period's days that survived the join, ordered by day.
CREATE TABLE grains AS SELECT * FROM (VALUES ('week'), ('month'), ('quarter'), ('year')) g(grain);
CREATE TABLE periods AS
SELECT DISTINCT metric, grain, CAST(date_trunc(grain, d) AS DATE) AS start,
  last_value(v) OVER (PARTITION BY metric, grain, date_trunc(grain, d) ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS v
FROM daily, grains;
-- aov_7d = revenue_7d / orders_7d: each input on its own at the group, FULL OUTER JOINed on it, then divided.
CREATE TABLE aov AS
SELECT coalesce(a.d, b.d) AS d, a.v / b.v AS v FROM (SELECT * FROM daily WHERE metric = 'revenue_7d') a FULL OUTER JOIN (SELECT * FROM daily WHERE metric = 'orders_7d') b ON a.d = b.d;
CREATE TABLE aov_periods AS
SELECT coalesce(a.grain, b.grain) AS grain, coalesce(a.start, b.start) AS start, a.v / b.v AS v
FROM (SELECT * FROM periods WHERE metric = 'revenue_7d') a FULL OUTER JOIN (SELECT * FROM periods WHERE metric = 'orders_7d') b ON a.grain = b.grain AND a.start = b.start;

-- Every day and every period that has ended by 2024-06-30 (the suite's today is 2024-07-01).
CREATE TABLE by_day AS
SELECT metric, d, v FROM daily WHERE d <= DATE '2024-06-30' UNION ALL SELECT 'aov_7d', d, v FROM aov WHERE d <= DATE '2024-06-30' AND v IS NOT NULL;
CREATE TABLE by_period AS
SELECT metric, grain, start, v FROM periods WHERE start + CAST('1 ' || grain AS INTERVAL) <= DATE '2024-07-01'
UNION ALL SELECT 'aov_7d', grain, start, v FROM aov_periods WHERE start + CAST('1 ' || grain AS INTERVAL) <= DATE '2024-07-01' AND v IS NOT NULL;

-- Controls: the shapes that stay skipped, each figure a hand-made Ordinate metric is shown to differ from.
-- revenue_7d_first: period_agg first (dbt's default) by month.
CREATE TABLE c_first AS
SELECT DISTINCT CAST(date_trunc('month', d) AS DATE) AS start,
  first_value(v) OVER (PARTITION BY date_trunc('month', d) ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS v
FROM daily WHERE metric = 'revenue_7d' AND d < DATE '2024-07-01';
-- revenue_rolling_month: window 1 month by day (calendar-month arithmetic on each day).
CREATE TABLE c_month AS
SELECT s.d, CAST(sum(o.amount) AS DOUBLE) AS v FROM spine s JOIN orders o ON o.order_date <= s.d AND o.order_date > s.d - INTERVAL 1 MONTH WHERE s.d <= DATE '2024-06-30' GROUP BY s.d;
-- revenue_ly: offset_window 1 year: each spine day takes the day a year before it, then the days are added up by month.
CREATE TABLE c_ly AS
SELECT CAST(date_trunc('month', s.d) AS DATE) AS start, CAST(sum(r.v) AS DOUBLE) AS v
FROM spine s JOIN (SELECT order_date AS d, sum(amount) AS v FROM orders GROUP BY 1) r ON r.d = CAST(s.d - INTERVAL 1 YEAR AS DATE)
WHERE s.d < DATE '2024-07-01' GROUP BY 1;
-- visit_to_buy (docs.getdbt.com/docs/build/conversion): each buy paired with the closest visit in (buy - 7 days, buy],
-- counted once per buy; the rate is conversions over visits.
CREATE TABLE c_conv AS
WITH b AS (SELECT row_number() OVER () AS id, * FROM events WHERE event = 'buy'),
v AS (SELECT * FROM events WHERE event = 'visit'),
paired AS (SELECT DISTINCT b.id FROM b JOIN v ON v.user_id = b.user_id AND v.ts <= b.ts AND v.ts > b.ts - INTERVAL 7 DAY)
SELECT CAST((SELECT count(*) FROM paired) AS DOUBLE) / CAST((SELECT count(*) FROM v) AS DOUBLE) AS v;

SELECT json_object(
  'byDay', (SELECT to_json(map_from_entries(list({'k': metric, 'v': days} ORDER BY metric))) FROM (
    SELECT metric, map_from_entries(list({'k': strftime(d, '%Y-%m-%d'), 'v': v} ORDER BY d)) AS days FROM by_day GROUP BY metric)),
  'byPeriod', (SELECT to_json(list(json_array(metric, grain, strftime(start, '%Y-%m-%d'), v) ORDER BY metric, grain, start)) FROM by_period),
  'controls', json_object(
    'revenue_7d_first', (SELECT to_json(map_from_entries(list({'k': strftime(start, '%Y-%m'), 'v': v} ORDER BY start))) FROM c_first),
    'revenue_rolling_month', (SELECT to_json(map_from_entries(list({'k': strftime(d, '%Y-%m-%d'), 'v': v} ORDER BY d))) FROM c_month),
    'revenue_ly', (SELECT to_json(map_from_entries(list({'k': strftime(start, '%Y-%m'), 'v': v} ORDER BY start))) FROM c_ly),
    'visit_to_buy', (SELECT v FROM c_conv)
  )
);
