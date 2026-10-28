---
name: answer-data-questions
description: Use when asked a question about data in Ordinate (totals, trends, top or bottom items, comparisons, what changed, why a figure moved), or whenever you are about to quote a figure from an Ordinate MCP tool to a user.
---

# Answer data questions with Ordinate's figures

Ordinate's rule is that the server computes every figure and the model never does. You choose
which question to ask the server, then report its answer. **Every figure in your reply is one a
tool returned in this conversation.**

## Which tool answers what

Start with `describe_dataset` to get column types and SQL names. Then:

| The question | Tool | What to quote |
|---|---|---|
| A saved KPI ("what's our margin?") | `list_metrics`, then `metric_value` | its `display`, as given (`"13.2%"`, `"$686.2K"`) |
| A total, or a breakdown by category (what a chart would draw) | `aggregate` with an `encoding` and optional `filters` | the values, formatted as below |
| What changed, what stands out | `insights` | its `title` and `detail`, as given |
| Anything else: a ratio per group, top N rows, a filter the others can't express | `query_sql` (one SELECT; tables and columns by the `sqlName` from `describe_dataset`) | the result values, formatted as below |

## Figures in your reply

1. **Never compute a figure yourself.** Do not add, subtract, divide, average or take a percent
   change of numbers from tool results. If the answer needs a derived figure (a share, a
   difference, a per-order value, growth), ask the server for it: a saved metric, or a
   `query_sql` that computes it. Reading which value is largest is fine.
2. **Ratios are ratios of sums**, the way Ordinate's saved metrics define them: margin is
   `SUM(profit) / SUM(revenue)`, not the average of per-row margins. When a saved metric
   exists, use its `definition` from `list_metrics` in your SQL.
3. **Formatting:**
   - When a tool gives a `display`, quote it as given.
   - For a raw value from `aggregate` or `query_sql`, drop floating-point noise and keep the
     data's own precision: `193014.40999999968` becomes `193,014.41`.
   - For a ratio from `query_sql`, round it in the SQL (`ROUND(100 * SUM(profit) / SUM(revenue), 1) AS margin_pct`),
     so the figure you quote is exactly the one the engine returned. A column your own SQL
     made a percentage this way may be shown with `%`.
   - Otherwise add no currency symbol, unit or abbreviation ("1.57M") the tool didn't give.
     `aggregate` returns plain numbers; Ordinate's formats (currency, %) arrive in a metric's
     `display`.
4. **Say where each figure came from**: "sum of profit by region (`aggregate` on Retail orders)".
   If you built a dashboard in the same task, quote the figures from the same encoding its chart
   uses, so your reply and the chart agree.
5. **If a tool refuses or returns nothing, say so.** Never fill the gap with an estimate.

## An ambiguous question

"Which region is most profitable?" can mean total profit or margin, so ask the server for both:

- `aggregate`: `{ "dataset": "Retail orders", "encoding": { "category": "region", "values": [{ "column": "profit", "aggregation": "sum" }] } }`
- `query_sql`: `SELECT region, ROUND(100 * SUM(profit) / SUM(revenue), 1) AS margin_pct FROM retail_orders GROUP BY region ORDER BY margin_pct DESC`

Then answer with both: "By total profit, West leads with 209,168.36 (sum of profit by region,
`aggregate`). By margin, Northeast leads at 14.5% (profit ÷ revenue per region, `query_sql`)."
These are the bundled sample's figures. Quote the values your own calls return.

## Common mistakes

| Mistake | Do instead |
|---|---|
| "$1.57M" from a raw `209168.36…` | `209,168.36`; the currency comes only from a `display` |
| Working out "about $159 per order" from two results | `query_sql` with `SUM(profit) / COUNT(*)` |
| Averaging per-row ratios for a margin | `SUM(profit) / SUM(revenue)`, or the saved metric |
| Answering from `query_sql` while the dashboard chart uses `aggregate` with a filter | quote the same tool and encoding the chart uses |
| Filling a refused call with a guess | say the call was refused and why |
