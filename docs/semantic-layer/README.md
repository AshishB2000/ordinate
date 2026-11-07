# Semantic layer

Ordinate's own semantic layer, the **Data model** section: the one place that says what each
dataset, field, metric and business word means, so every chart, dashboard, AI answer and agent
uses the same definitions and gets the same numbers. A company that already has a semantic layer
(dbt, Cube, Snowflake semantic views) connects it in part 7.

Each part is its own design and its own chain of PRs, built in this order. The owner approved all
eight on 2026-11-03, taking every recommended answer. All eight are built (PRs #393 to #466), with a
review pass's fixes in #468 to #482.

| Part | Doc | What it adds |
|---|---|---|
| 1 | [00-design.md](00-design.md) | The Data model section; dataset grain, checked keys, guides; value labels; metrics that know their date, whether they add up, snapshot balances; charts follow their metric; glossary terms; always-applied filters on Live tables; one table joined two ways |
| 2 | [02-source-tables.md](02-source-tables.md) | Source-table docs under Connections, read from the warehouse where it already knows (comments, keys, partitions) |
| 3 | [03-ai.md](03-ai.md) | Instructions for the Assistant, verified questions, sample values, a test chat |
| 4 | [04-governance.md](04-governance.md) | Certified and retired status, light change control, hiding a column or metric from a role |
| 5 | [05-metrics-depth.md](05-metrics-depth.md) | Distinct counts, funnel metrics, saved period metrics (Revenue YTD), per-account snapshots, targets |
| 6 | [06-navigation.md](06-navigation.md) | Hierarchies and drill-down by level, views per team |
| 7 | [07-portability.md](07-portability.md) | Export and import as files, Ossie, importing dbt, querying an external semantic layer live |
| 8 | [08-engine.md](08-engine.md) | Calculated fields on Live tables, computing fan-out joins instead of refusing them, column-level lineage |

The order is a recommendation: parts 2 to 8 each depend on part 1, and on little else. Each doc
lists its own dependencies.
