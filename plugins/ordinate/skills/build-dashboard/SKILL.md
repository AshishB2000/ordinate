---
name: build-dashboard
description: Use when asked to build, make, draft or set up a dashboard, KPI board, report page or set of charts in Ordinate, or to turn an Ordinate dataset into charts, through the Ordinate MCP tools (create_dashboard, create_visual, publish_dashboard).
---

# Build a dashboard in Ordinate

You describe the dashboard and Ordinate builds and computes it. `create_dashboard` takes a
**plan**: which dataset, which columns, which aggregation, which chart type. Ordinate's validator
checks every part against the real data and drops what does not fit. A plan never carries a
number. Every figure on the dashboard is computed by the server when it is drawn.

## Steps

1. **Find the data.** `list_datasets` (pass `project` if the user named one), then
   `describe_dataset` for each candidate. Note each column's declared `type` (`number`, `text`,
   `date`). Use the exact dataset and column names it returns.
2. **See what exists.** `list_dashboards` gives names and each one's `status` (`draft`,
   `published`, or `edited`: published with edits not live yet), not tiles, so if one sounds like
   what the user asked for, name it in your reply. A viewer's token lists published dashboards
   only. `list_metrics` lists the project's saved KPI
   definitions. `insights` on the main dataset shows trends, movers and concentration worth a
   chart.
3. **Write the plan** (shape and choices below). The example is a shape to adapt to the
   user's question, not a finished dashboard.
4. **Call `create_dashboard` once.** Each call makes a new dashboard, as a **draft**: only the
   project's editors and admins see it until one of them publishes it. Read `dropped` in the
   reply: each entry names what was removed and why. Do not quietly call it again to fix a
   drop. Report it, and rebuild only if the user wants that.
5. **Tell the user**:
   - the dashboard's name, its sheets and tiles, and anything dropped (with the reason given);
   - where to find it: by name under **Dashboards** in Ordinate, among the drafts. No tool
     returns the server's address, so give the path `/analyses/<project id>/<dashboard id>`
     (where it is edited) only when the user gave you the address (the project id comes from
     `list_projects`);
   - that it is a draft: nobody with view-only access sees it yet. Ask them to look at it (and
     preview it) in Ordinate, and whether to publish it. Do not tell them it is live.

   If you quote any figure, follow the `answer-data-questions` skill.
6. **Publish only when the user says so.** `publish_dashboard` (the dashboard's `id` from
   `create_dashboard`) makes it visible to **everyone in the project**, viewers included. Its
   layout, filters and charts freeze; figures stay live. Later edits, theirs or yours, stay in the
   draft until it is published again. Never publish on your own initiative, and never as part of
   building. A reply of `status: "published"` with `publishedAt` means it is live. If the user's
   token is view-only the tool refuses, saying an editor or admin must do it: pass that on.
   `unpublish_dashboard` takes it away from viewers (the draft stays); also only when asked.

## Plan shape

```json
{
  "name": "Sales overview",
  "sheets": [
    {
      "name": "Overview",
      "metrics": [
        { "dataset": "Retail orders", "column": "revenue", "aggregation": "sum", "label": "Revenue" },
        { "dataset": "Retail orders", "column": "profit", "aggregation": "sum", "label": "Profit" },
        { "dataset": "Retail orders", "column": "order_date", "aggregation": "count", "label": "Orders" }
      ],
      "visuals": [
        { "dataset": "Retail orders", "name": "Revenue by month", "chartType": "line",
          "encoding": { "category": "order_date", "grain": "month", "values": [{ "column": "revenue", "aggregation": "sum" }] } },
        { "dataset": "Retail orders", "name": "Profit by region", "chartType": "bar",
          "encoding": { "category": "region", "values": [{ "column": "profit", "aggregation": "sum" }] } },
        { "dataset": "Retail orders", "name": "Revenue by category and segment", "chartType": "stacked_column",
          "encoding": { "category": "category", "series": "customer_segment", "values": [{ "column": "revenue", "aggregation": "sum" }] } },
        { "dataset": "Retail orders", "name": "Furniture profit by state", "chartType": "bar",
          "encoding": { "category": "state", "values": [{ "column": "profit", "aggregation": "sum" }] },
          "filters": [{ "column": "category", "op": "=", "value": "Furniture" }] }
      ],
      "texts": [{ "heading": "About this sheet", "text": "Sales from the retail orders dataset. Use the chips above to narrow by region or date." }],
      "controls": [
        { "dataset": "Retail orders", "kind": "dropdown", "column": "region", "label": "Region" },
        { "dataset": "Retail orders", "kind": "date_range", "column": "order_date", "label": "Order date" }
      ]
    }
  ]
}
```

This plan builds with nothing dropped on Ordinate's bundled sample project ("Retail orders").

- **`metrics`**: the KPI strip, drawn first. Use 2 to 4, each `{ dataset, column, aggregation, label }`.
  The aggregation is `sum`, `avg`, `count`, `min` or `max`. `sum`, `avg`, `min` and `max` need a
  `number` column; `count` works on any column.
- **`visuals`**: 2 to 5 per sheet. Each is a new chart `{ dataset, name, chartType, encoding,
  filters? }`, or a saved visual placed as it is: `{ "visual": "<saved visual name or id>" }`.
- **`controls`**: filter chips above the sheet, `{ dataset, kind, column, label }`. The kind is
  `dropdown` (pick one value), `multi` (several) or `date_range`. Add a `date_range` when there
  is a date column, and a dropdown for a text column with few values. Use 1 to 3 per sheet.
- **`texts`**: notes, `{ heading?, text? }`. Plain context only, never a figure: a number typed
  into a note is not recomputed, so it is wrong the next time the data refreshes.
- **`filters`** on one chart: `{ column, op, value }` with op `=`, `!=`, `>`, `<`, `>=`, `<=`,
  `contains`, `is_empty` or `not_empty`; or `in` / `not in` with `values: [...]`.
- **More sheets**: split by question ("Overview", "Regions", "Products"), not one long sheet.
- **Layout**: don't give positions or sizes. Ordinate lays out the grid.

## Picking the chart

| The question | `chartType` | `encoding` |
|---|---|---|
| How does it change over time? | `line`, `area` | `category`: a date column, plus `grain`: `day`, `week`, `month`, `quarter` or `year`. Prefer the raw date column with a grain over an already bucketed one (a `Month` column) |
| Which category is biggest? | `bar` (many or long labels), `column` (few) | `category`: a text column |
| What share does each part have (up to about 6 parts)? | `donut`, `pie` | `category` + one value |
| Two measures per category | `clustered_column`, `combo` | two `values` |
| Split by a second dimension | `stacked_column`, `stacked_bar` | `series`: the second text column |
| How is a number spread out? | `histogram` | `category`: the number column, plus `bins` |
| Rows by columns | `pivot` | `pivot: { rows: [{column}], columns: [{column}], values: [{column, aggregation}] }`, plus `category` and `values` mirroring them |
| The detail rows | `table` | |

Other valid types: `clustered_bar`, `pct_stacked_column`, `pct_stacked_bar`, `line_markers`,
`stacked_area`, `scatter`, `gauge`, `bubble`, `treemap`, `heatmap`, `funnel`, `sankey`,
`candlestick`, `boxplot`, `cohort`, `event_funnel`, `waterfall`, `bullet`, `calendar`, `radar`,
`pareto`, `map_bubble`, `map_choropleth`, `word_cloud`.

## What a plan cannot do

- **Calculated fields** are refused. Automation never changes a dataset. If a chart needs a new
  column, say so: the user adds it in Ordinate, then you chart that column.
- **A ratio KPI** (margin %, average order value) can't be built: a metric tile is one column
  and one aggregation. If `list_metrics` has a saved metric for it, tell the user to add that
  metric's card in Ordinate. You can still quote its value with `metric_value`.

## Common mistakes

| Mistake | What happens | Do instead |
|---|---|---|
| `sum` of a text column (an id, a code, a number stored as text) | the tile is dropped: "needs a number column" | check `describe_dataset`; use `count` |
| A column or dataset name that's close but not exact | dropped | copy the names `describe_dataset` returned |
| A figure written into a note or the dashboard name | wrong after the next refresh | a KPI tile |
| Calling `create_dashboard` again after a drop | a second, near-duplicate dashboard | report the drop and ask |
| Telling the user the dashboard is shared or live | viewers see nothing: it is a draft | say it is a draft, and ask whether to publish |
| Calling `publish_dashboard` right after building, unasked | a half-checked dashboard goes to every viewer | show the draft first, publish when the user says so |
| Eight charts on one sheet | a crowded wall of charts | 2 to 5 per sheet, more sheets |
