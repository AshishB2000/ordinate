# Semantic layer, part 1 — design

Status: approved by the owner (2026-11-03), after one builder review and the owner's
answers to its two questions (see [Owner's answers](#owners-answers)). Nothing here is built yet.

Most companies that run Ordinate have no semantic layer (no dbt metrics, no Cube, no LookML). For
them Ordinate *is* the semantic layer: the one place that says what each table, field, metric and
business word means, so every chart, dashboard, AI answer and agent uses the same definitions and
gets the same numbers.

Ordinate already holds much of this, spread over five stores: the catalog (`src/app/catalog.ts`),
metrics (`src/analysis/metrics.ts`), relationships (`src/analysis/relationships.ts`), the
workspace calendar (`src/analysis/dateIntel.ts`) and Prepare. Part 1 fills the gaps that cause
wrong or inconsistent numbers, and puts it all on one screen. Connecting a company's *existing*
semantic layer (dbt, Cube, Snowflake semantic views) is a later part.

## What you will see when this is done

Open **Data model** in the left nav. One section for the project:

```
Data model · Retail demo                                         [ + Term ]  [ + Metric ]

TABLES                                   METRICS
┌ Orders ─────────────── fact ┐          Revenue        sum(amount)   counts by Order date
│ One row per order line      │          Avg basket     avg(amount)   ⚠ can't be added up
│ Key line_id  ✓ unique       │          Stock on hand  sum(units)    snapshot: last Stock date
│ Guide ▸                     │
└─────────────────────────────┘          TERMS (glossary)
┌ Customers ─────────── dimension ┐      EMEA            Customers · region in Europe, Middle East, Africa
│ One row per customer          │        Enterprise      Customers · seats ≥ 500
│ Key customer_id  ⚠ 12 repeats │
└───────────────────────────────┘      ALWAYS APPLIED
                                         Orders     Prepare step: drop is_test = true
RELATIONSHIPS                            Sales (Live)  status ≠ 'void'
Orders.customer_id → Customers   many-to-one  98% match
Orders.order_date  → Dates "Order date"
Orders.ship_date   → Dates "Ship date"
```

Each part opens the editor it already has (the catalog's column panel, the metric editor, the
relationship editor) or a new one for the new parts. Charts, dashboards, the Assistant, Explore,
published pages and MCP agents all read these definitions; nothing is copied into a dashboard.

### The name and where it sits (owner, 2026-11-03)

**Data model**, its own top-level section in the left nav, right after Data (route `/model`; one
line appended to the append-only `web/src/app/nav.ts`). Not plain "Model": the Assistant's AI
model picker is already labelled "Model" (`web/src/features/assistant/DockParts.tsx`). "Data model"
is what Cube and Metabase call it, and the code already calls relationships "the project data
model". "Semantic layer" stays the term in docs and on the website, not in the app, because it is
jargon for the business people who use the page.

The section's tabs: **Datasets · Source tables · Metrics · Glossary · Relationships** (Source tables
comes with part 2, and only for people who can open the connection; part 3 adds Assistant). The first tab says
Datasets, the app's word for them, because a **source table** in the company's database is a
different thing (see [Datasets and source tables](#datasets-and-source-tables-owner-2026-11-03)).
In this doc, "table" means an Ordinate dataset unless it says source table. The calendar shows as
one line linking to where the fiscal year is set today: Admin → Workspace (`/admin?tab=workspace`,
org admins only); others see the line without the link.

**The Datasets tab (owner's pick, 2026-11-03, from three prototyped layouts):** a list of datasets on
the left and the picked table's panel on the right, with a **To fill in next** strip above both.
- **The strip** lists the gaps that matter most, as one-click chips that open the table: no key, a
  key that repeats, no guide, no description, no role. At most four, then "+N more". The server
  builds the list from the stored docs and the key check; the page only draws it. The strip hides
  when nothing is missing.
- **The table panel** has four tabs: **Overview** (what one row is, role, key, always-applied
  filters, quality, access, used by), **Fields** (meaning, other names, value labels),
  **Guide** (the table's article, rendered markdown, with who edited it last) and **Lineage**
  (the existing lineage graph, drawn inline).
- The two layouts not picked were a data dictionary (every table as one long readable page) and
  a board of table cards by how complete they are. The prototype for all three is on the
  throwaway branch, not in `develop`.

What moves (`routes.tsx` is append-only, so old routes stay and redirect):
- **Relationships** leaves Data's tab strip for Data model; `/data?tab=relationships` opens it;
- **Metrics** moves from `/data/metrics` to Data model's Metrics tab; the old route redirects;
- **Catalog stays under Data** as the search-everything list of every record (datasets, visuals,
  dashboards, reports).

### Its sections

| Section | What it holds | Part 1 |
|---|---|---|
| Tables | What each table is, what one row means, key (checked), fact or dimension, owner | New fields (D1, D2, D4) |
| Guide | One markdown article per table: what it holds, how to query it, what to watch out for, good questions | New (D4) |
| Fields | Column meaning, display name, other names, example, sensitivity, value labels | Value labels new (D6) |
| Relationships | Joins, cardinality, match rate, repeat warnings, labels | Moved from its tab; new D3, D14 |
| Metrics | Definition, format, date, additivity, snapshot, where used | New fields (D7–D9, D16) |
| Glossary | Terms: named, reusable filters | New (D10–D12) |
| Always applied | Prepare filter steps on copies, base filters on Live tables | Live new (D13) |
| Calendar | Fiscal year start, retail calendar | Shown; already a workspace setting |
| Lineage | Where each table comes from and what is built on it | Shown as the table panel's Lineage tab: the existing `lineage:get` graph (`Graph` in `LineageDrawer.tsx`), drawn inline instead of in a drawer. Sources by kind and label only, never a path, URL or SQL |
| Quality | The table's quality rules and their last result | Shown; already quality rules |
| Access | Row access rules on the table, sensitive columns | Shown; already row policy and sensitivity |
| Used by | Charts, dashboards, alerts and reports using a table, metric or term | Shown; already catalog usage and `metric:usage` (terms new) |

Calendar, Lineage, Quality, Access and Used by need no new engine work: Model shows them and links
to their screens.

**Today one thing is copied:** a chart measure picked from a *simple* metric stores the metric's
`metricId` but plots its own copied `column` and `aggregation`. `buildVizData` never reads the
metric (`src/analysis/visuals.ts`, `metricMeasures.ts`), so a metric's filters do not apply on
charts and editing the metric does not change them. Part 1 changes that (answer A, D16).

## Owner's answers

Given 2026-11-03, to the two questions the builder review raised.

**A. A chart built from a metric follows the metric when it is drawn: yes.** Editing a metric
updates every chart that uses it, and the metric's filters, snapshot (D8) and date (D9) apply on
charts. Charts built from a metric **that has filters** change their numbers once, to what the
metric says. `metric:usage` lists them, so the Data model section and the release note name them. See D16.

**B. Drill-down by level is not in part 1: hierarchies move to a later part.** The existing drill
panel only shows the rows behind a figure (`web/src/features/visuals/drill/DrillPanel.tsx`), so
drill-down by level would be a new feature. Without it, hierarchies would only feed Explore's field
list and the Assistant, which is too little to build now. D5 is kept below for that part.

## Intent

- **One meaning per thing.** "Revenue", "EMEA" and "Customers" are defined once. Change the
  definition and every figure that uses it changes with it.
- **Stop wrong numbers before they reach a screen.** Most of part 1 is the definitions an engine
  needs to compute correctly: what one row is, whether a number can be added up, which date a
  metric counts by, what a balance means over time, which rows never count.
- **Make the AI and agents right more often.** The same definitions feed the Assistant's facts and
  the MCP tools, so a question about "EMEA revenue" maps to the team's EMEA and the team's Revenue.

## Goals

1. Tables say what one row is, their key (checked for repeats), whether they are facts or
   dimensions, and carry a guide: an article on how to use them.
2. Columns can name what coded values mean.
3. Metrics know which date they count by, whether they can be added across groups (derived, not
   typed in), and can be snapshot metrics (balances, stock, headcount).
4. A glossary of business terms, each a named, reusable filter.
5. Filters that always apply to a table, on copies and on Live tables.
6. One table joined two ways ("Order date" and "Ship date" from one Dates table).
7. The Data model section, and the AI and MCP readers, show all of it.

## Non-goals (part 1)

- **Distinct counts.** No aggregation counts distinct values today (`MetricAggregation`, `LiveAgg`).
  "Customers = distinct customer_id" needs a new aggregation in three engines with its own
  differential tests. Its own change, next.
- **Computing a fan-out instead of refusing it.** The join planner already refuses any join that
  would repeat rows of the main table (`joinPlan.ts`), so double-counting cannot happen. Looker's
  "symmetric aggregates" would compute those questions instead; not now.
- **Calculated fields on Live tables.** On copies, a Prepare formula step already gives a
  calculated column every reader sees. Live tables have no Prepare; compiling formulas to five
  warehouse dialects is its own design.
- **Snapshot metrics on Live tables.** Refused with a sentence in part 1 (see D8).
- **Terms defined by behaviour** ("active = ordered in the last 90 days", which needs an aggregate
  over another table). Part 1 terms are row filters.
- **Composite keys**, and a snapshot's "each account's own last value".
- **Hierarchies and drill-down by level** (answer B). D5 stays below as the starting point for the
  part that builds drill-down.
- Later parts: views per team, AI instructions and verified questions, targets, certified and
  retired status, hiding a column or metric from a role, definitions as files in git, Ossie
  export, querying an external semantic layer.

## Anti-goals (a failure even if it works)

- **Two copies of one definition.** A term pasted into twenty filters that drift apart.
- **A number that changes silently.** A deleted term whose filter quietly disappears, a value
  label that merges two categories, a period that lands on a different date column without
  saying so.
- **A model deciding a figure.** Definitions are typed by people and checked by code; the AI only
  reads them.
- **Forms before value.** Every new field is optional. A project that fills in nothing behaves
  exactly as today, and golden fixtures do not change.

## Approaches

**A. Extend the stores that exist, gather them on one page (chosen — my call, confirm).** New
fields go where their neighbours live: table and column semantics in the catalog, metric
semantics on the metric record, terms as a new record kind like metrics, labels on
relationships. The Data model section reads all of them.
*Trade-off:* definitions stay in several stores, so a future export (Ossie, YAML) must read
several. Nothing existing migrates, and each step ships alone.

**B. One semantic-model document per project** (like a LookML or dbt project), with metrics and
relationships moved into it. One source of truth and an easy export, but every metric and
relationship reader moves (dozens of call sites), it lands big-bang, and one document edited by a
whole team conflicts constantly under the content-tag save (`docs/edit-conflicts/`).

**C. Files first** (YAML in git that Ordinate reads). Teams without a semantic layer are rarely
code-first, Ordinate is a UI-first product, and files in git are in "later" anyway.

A wins because nothing that works today moves, and B's one advantage (export) is a reader that
can be added over A's stores later.

## Decisions

Marked **(my call)** where I decided without the owner; everything else follows from the repo's
rules.

### Tables

**D1. A table's semantics live in the catalog** as a new `tables: Record<datasetId, TableDoc>`
section of `CatalogFile`, beside `records` and `columns` (my call). The catalog already survives
refresh and re-import, keyed by dataset id and column name, and is one atomically written file
per project. The field is optional and sanitized to defaults, so `schemaVersion` stays 1 and no
migration is needed.

```ts
interface TableDoc {
  role: '' | 'fact' | 'dimension';      // '' = not said
  key: string;                          // one column name, '' = none
  grain: string;                        // ≤ 200; empty → "One row per <key's display name>"
  guide: string;                        // markdown article, ≤ 8,000
  // hierarchies: a later part (D5)
  keyCheck?: { rows: number; empty: number; repeatedKeys: number; checkedAt: string };
  updatedBy: string; updatedAt: string;
}
```

**D2. A declared key is checked, never trusted.** The check counts rows, empty keys and keys that
repeat. It runs when the key is saved and after each refresh or re-import of the dataset, and the
counts are stored on the doc so any pod can show them. JS reference plus a resident DuckDB twin,
held to `Object.is` agreement. On a Live table the check runs only on **Check now**, as one
bounded query under the Live cost guards (my call: no surprise warehouse queries).

**D3. Relationships keep showing a broken promise.** A many-to-one says each key appears once on
the one side. The join takes the **first** matching row per key (`joinJs.ts`, "Rule 2"), so an
order can get one of two "customer 42" rows. The relationship dialog already warns about this
before saving, from the suggestion's sample stats ("…repeats some … values. Each lookup uses the
first matching row.", `RelationshipDialog.tsx`). What's missing is the warning after saving.

`relationship:save` already counts the one side's distinct keys over the full tables (`toKeys`,
`toKeyed`). It now stores a warning when they differ, or when the one side's table declares a key
and the relationship uses another column. The warning is re-checked when the one side's data
refreshes and shown on the relationship and the Data model section. It does not refuse (my call): data
changes after saving, and existing models must keep loading.

**D4. `role` and `guide` change no figure.** Role groups the Data model section and Explore's field list,
orders relationship suggestions (fact → dimension), and tells the AI which tables hold events and
which describe things. The guide renders with the app's own markdown renderer
(`web/src/features/dashboards/Markdown.tsx`, CSP-safe). It reaches the AI through the facts
blocks the same way column notes do (`src/ai/columnNotes.ts`): capped, and framed as text people
wrote, which the model treats as data. MCP's `describe_dataset` returns it. Partition and
clustering hints read from the warehouse are later; part 1 is the note.

### Columns

**D5. Hierarchies: moved out of part 1 by answer B.** Kept as the starting point for the part
that builds drill-down.
Named, ordered lists of 2 to 6 of the table's own columns (Geography: Country → Region → City).
Date columns need none; their grains already are one. They are used by:
- a new drill-down that re-charts by the next level;
- Explore's field list, which groups the levels;
- the Assistant ("break it down further" picks the next level);
- the dashboard filter value picker, which narrows a lower level by the higher one, **if** the
  picker already accepts the sheet's other filters. If it doesn't, this cascade is out of part 1
  (builder checks).

**D6. Value labels** say what coded values mean: `values: { value, label }[]` on a `ColumnDoc`,
at most 500 per column, **text columns only** (my call: number columns bin as categories, and a
number's text differs between engines). A value is matched exactly against the stored cell text.
Two values may not share a label, and a value may not repeat; both are refused with a sentence,
so a label can never merge two categories.

Labels are applied **on the server**, wherever a category or series name from that column is
produced: chart labels and legends (`vizData`), KPI captions, filter value pickers, Explore,
published pages, embeds and chart exports. The raw value travels beside the label, so a filter
picked by its label filters by the raw value. Row grids and row exports keep showing stored
values in part 1.

A restricted viewer (row access rules) does not receive a column's value list from catalog
replies, since the list names values they may not be allowed to see. They still see labels on
values in their own results. Classified in `scripts/rowPolicyReaders.ts`.

### Metrics

**D7. Can it be added up: derived, never typed in.** Every measure gets an additivity, worked out
from what it is:

| Measure | Across categories | Across time |
|---|---|---|
| `sum`, `count` | yes | yes |
| `avg`, `min`, `max` | no | no |
| Formula metric | yes only if it is `+` / `−` of additive parts | same |
| Snapshot metric (D8) | yes | **no** |

This covers any chart measure, not only saved metrics, because it follows from the aggregation.
It is enforced where the app adds up figures it has already computed:
- table calculations that sum across cells (`running_total`, `percent_of_total`, `moving_sum` in
  `tableCalc.ts`) over a measure that can't be added that way;
- a metric tree `sum` relation over a child that can't be added.
- the period overlay caption (`periodScope.overlayCaption`), which adds up the current and prior
  buckets to write "Revenue is up 12% vs the same months last year". Over a measure that can't be
  added across time it says nothing rather than a wrong percentage (found by the part 5 review).

Builder: confirm whether `metricTree` already guards this. Pivot subtotals are already
recomputed from source, never folded, so they need nothing.

A refused calculation shows the reason where the figure would be, and the calculation picker
greys out the option with the same reason. **Existing saved charts with such a calculation start
showing the refusal** (my call: "loud beats wrong" is the rule `liveSpec.ts` already follows; a
running total of averages is not a number anyone should read).

**D8. Snapshot metrics.** `snapshot?: { column: string; take: 'last' | 'first' }` on a simple
metric, where `column` is one of the dataset's date columns. Meaning: among the rows a figure
covers (after every filter), keep those whose snapshot date is the latest (or earliest), then
aggregate as usual. "Latest" is taken **per time bucket** when the figure is split by date, and
otherwise over everything in scope, **not** per category (my call). This matches dbt's
`non_additive_dimension` without `window_groupings`, so an import or Ossie export later maps
1:1. A region with no rows on the latest date shows empty, not its own older value.

Built in the JS reference (`metricValue.ts`, `vizData`) and the resident DuckDB twin, held to
`Object.is` agreement over a matrix: by month, by category, by both, with filters, with an empty
scope, and with dates in both formats that `dateIntel` parses. On a Live dataset a snapshot metric
is a **typed refusal** with a catalog sentence (D6 of the live-data plan). Metric tiles, alerts,
scorecards, the metric tree and published pages get it through the existing doors
(`computeCardMetric`, `computeCard`) without new paths. Charts get it through D16.

**D9. Which date a metric counts by.** `timeColumn?: string` on a metric: one of its dataset's
date columns. When set:
- a dashboard date control's period applies to the metric's `timeColumn`, not the column the
  control names. A control's step arrives merged into the tile's one `filters` list, looking
  exactly like the tile's own date filter. So every place that merges controls into a tile marks
  the control's steps with a new optional `fromControl: true` on `FilterStep` (my call):
  - in the browser: `VisualTile.tsx` and `CardRuntime.tsx` for live dashboards;
  - on the server: `mergeDashboardFilters` for reports, stories, published pages and
    subscriptions.

  The server rewrites only marked period steps, once, before the engines see them, so JS, resident
  and Live get the same filter. The marker is not a security property: it only says which date the
  person meant, and the row lock is prepended separately. The tile's caption says which date was
  used;
- **conflicts are refused, never guessed (my call).** A chart whose metric measures name
  different `timeColumn`s (or one has one and another doesn't) is refused under a date control,
  with a sentence naming both dates. A formula metric whose parts name different `timeColumn`s is
  refused when saved;
- the KPI compare (previous period, previous year) and the metric tree's period use it;
- scorecards (`dateColOf` in `src/ipc/scorecards.ts`) and the Metrics page sparkline
  (`sparkColumn` in `src/ipc/metrics.ts`) use it instead of the dataset's first date column (found
  by the part 5 review);
- an alert on the metric defaults its period column to it;
- the Assistant puts "revenue last month" on it, and Explore uses it as the metric's default date
  axis.

Unset means today's behaviour exactly. The metric editor **suggests** the column when the dataset
has exactly one date column; it never sets one silently.

**No new time-intelligence engine.** Year to date, quarter to date, last N, previous period, same
period last year, moving sums and averages, and running totals all exist (`PeriodPreset`,
`Compare`, `tableCalc.ts`) and already work on any metric. `timeColumn` is what makes them land
on the right date. That is Power BI's "one Year to date for every measure", which Ordinate
already has.

### Glossary

**D10. A term is a named, reusable filter**, a new project record kind `term`, stored and managed
like metrics: `recordFs`, edit-conflict tag, Trash.

```ts
interface Term {
  id: string; projectId: string;
  name: string;              // unique among terms AND metric names (the AI matches both)
  aliases: string[];         // ≤ 8, the same rules as a column's "Also called"
  description?: string;
  datasetId: string;         // the table its columns belong to
  filters: FilterStep[];     // sanitized like a metric's filters; no term inside a term
  createdAt: string; updatedAt: string; schemaVersion: 1;
}
```

Part 1 terms are row filters, including relative periods ("Recent order = order date in the last
90 days" is a row filter). Terms that need another table's aggregate are a non-goal.

**D11. Terms are referenced, never copied, and a reference is never dropped (my call).** A filter
list may hold `{ type: 'term', term: <id> }`, a new step type beside `FilterStep`
(`{ type: 'filter', column, op, … }`, `src/data/transforms.ts`). Terms can then go anywhere filters
go today (chart, tile, dashboard control, metric filters, alert, Explore URL, AI answer) with no
new field on any contract.

The catch: an unknown step type is dropped without a word by `sanitizeStep` (`transforms.ts`), and
several places keep only `type === 'filter'` (`visuals.ts`, `dashboardFilters.ts`,
`VisualTile.tsx`; about 30 filter cleanups in all). Each of them must keep a term step, or expand
it, and never drop it. **That inventory is part of the work.** A test plants a term through every
cleanup site and every door, and fails if the figure doesn't change.

Terms are **expanded on the server at the doors**:
- after the row lock is prepended, and before the Live split and the answer-cache key, so editing
  a term changes the cached figure;
- each term becomes its filter steps. Each expanded step carries the term's `datasetId` (a new
  optional field on `FilterStep`);
- a deleted term is refused with a sentence ("EMEA was deleted — remove it or restore it from
  Trash"), never skipped.

**A term only filters its own table (my call).** Today a filter names a bare column. It resolves to
the main table first and then to the nearest related table (`joinPlan.ts`), and is skipped with a
warning when no table has it. For an expanded term step, the column must resolve to the term's
own dataset: the main table when that is the term's dataset, otherwise through a relationship.
It never resolves to a same-named column of another table. Where it can't resolve:
- on a chart, tile or metric, the figure is refused with a sentence;
- under a dashboard-wide control, the tile shows that the term doesn't apply to it, visibly, the
  way an inapplicable dashboard filter already is noted.

On Live tables (no joins) a term applies only to its own dataset.

The second line of defence: if an unexpanded term ever reaches `applyPipeline` or the Live
compiler, it **throws** (like `LiveDatasetError`). A missed door is then a failing test, not a
quietly bigger number.

**D12. Who sees a term.** Everyone who can read the project sees a term's name, aliases and
description. A restricted viewer does not get its filter values (a term can list customer names),
the same rule as D6. The Assistant's facts and MCP get terms. There is a new `list_terms` tool,
and `metric_value` and `aggregate` accept term names. `docs/automation.md` is regenerated.

### Always-applied filters

**D13. Copies use Prepare; Live tables get a base filter.** On a copied dataset, "never count
test accounts" is already a Prepare filter step. It removes the rows from the stored table, so
every reader is covered, exports and SQL included. Nothing new is built for copies; the Data model section
lists those steps under **Always applied** and links to Prepare.

A Live dataset has no Prepare, so it gets `baseFilters: FilterStep[]` on its record: plain steps,
no terms in part 1. They are added to **every** statement Ordinate sends for that dataset:
- figure queries (the compiler);
- value pickers;
- profile and sample SQL. These are written separately in `src/engine/live/profileSql.ts` and run
  by the schema sync through `runStatement`, and the one shared door (`warehouse()`) takes SQL
  that is already written. So each SQL builder adds the base filters itself.

Coverage is not automatic, so the test is what proves it. It plants a base filter, runs every Live
entry point against the fake warehouse, asserts each statement carries the filter, and includes a
negative control. One case joins the Live parity matrix: a Live table with a base filter against
a copy with the same Prepare step.

### Joins

**D14. One table, joined two ways.** Several relationships between the same two datasets can
already be saved: only an identical column pair is replaced (`relationships.ts`). The planner then
uses the first in the list (`joinPlan.ts`), and a chart names a joined column by dataset
(`categoryDatasetId`, `values[].datasetId`) or a filter by bare name. Part 1 keeps that default
and adds an opt-in (my call: nothing breaks on upgrade):
- a relationship gets an optional `label` ("Ship date");
- a reference that names a dataset keeps resolving through the **first** relationship, as today;
- a reference may name a relationship instead (a new optional `via: relId` on the measure, the
  category and the filter step), and then resolves through that one. Its columns are named by the
  label (`Ship date.month`);
- `JoinPlan.tables` is keyed by relationship, not dataset, because the same dataset may now appear
  twice;
- the Data model section says which relationship is the default ("Charts use Order date unless they pick
  Ship date"), so the first-wins pick is visible.

This changes `joinPlan.ts`, `joinJs.ts` and the resident join together, held by a differential
test. The fan-out rules and the row-policy refusals do not change, and Live joins stay off. This
is the riskiest step, so it goes last.

### Charts follow their metric

**D16. A chart reads its metric when it is drawn (answer A).** A chart measure already stores the
`metricId` it was picked from. On each draw the server reads that metric:
- **A simple metric with no filters, snapshot or `timeColumn`** plots exactly as today. Its copied
  `column`/`aggregation` equal the metric's, so the figure is byte-identical and costs nothing new.
  If the metric's definition was edited since, the chart now follows the edit.
- **A simple metric with filters, a snapshot or a `timeColumn`** is planned through the path
  formula metrics already use (`src/ipc/vizMetricMeasures.ts`, `metricMeasures.ts`). That path
  computes each measure on its own, so two measures with different metric filters on one chart
  each get their own.
- **A deleted metric** falls back to the stored copy, as today (`visuals.ts`), and the chip says
  the metric is gone.

Before this ships, `metric:usage` lists the charts whose numbers change (built from a metric that
has filters). The Data model section shows that list, and so does the release note.

### Shared calculated fields

**D15. No new mechanism in part 1.** On copies, a Prepare formula step already is a calculated
field every chart, metric and agent sees. The Data model section lists them with their formula. Live
calculated fields are a non-goal.

## Where it is read

| Reader | Gets |
|---|---|
| Data model section (new, `web/src/features/model/`) | Everything above, each linking to its editor |
| Charts, tiles, metrics, alerts, published pages, embeds | Value labels, additivity refusals, snapshot math, `timeColumn`, expanded terms, base filters, labelled joins: all server-side |
| Assistant facts (`copilotFacts`, `liveFacts`, `planFacts`) | Table role, grain and guide; value labels; metric `timeColumn` and additivity; terms |
| MCP (`describe_dataset`, `list_metrics`, new `list_terms`, `metric_value`, `aggregate`) | The same, as the token's user, under the same row rules |

## Constraints (from the repo's rules)

- **Two implementations agree.** The key check, snapshot math and labelled joins each have a JS
  reference and a resident twin, tested with `Object.is`.
- **Live.** Every new figure path goes through the doors. Snapshot metrics refuse on Live with a
  typed refusal, base filters reach every compiled statement, and `test-liveSafetyNet` covers any
  new row-reading channel.
- **Contracts.** Every new channel (`term:*`, `catalog:setTable`, `catalog:checkKey`,
  `live:setBaseFilters`, the Data model section's reads) has a zod input, the narrowest access and project
  scope. `src/api/index.ts`, `routes.tsx` and `nav.ts` are append-only. New `read` contracts are
  classified in `scripts/rowPolicyReaders.ts`.
- **Caches** are keyed with `orgKey()`. The answer-cache key is computed after term expansion.
- **Sentences** (warnings, refusals) go through `t()` and the i18n extract.
- **File size.** `catalog.ts` (419 lines) and `metrics.ts` (468) take no big additions: table
  docs, terms, additivity and snapshot math each get their own file.
- **No new runtime dependency, no migration.** Everything is records or catalog JSON, with
  additive optional fields.
- **UI.** The Data model section meets the house polish bar (no plain lists, real empty states) and gets
  mockups before it is built.

## Tests (the ones that prove the point)

- **Key check:** JS vs resident over repeats, empties and both types; a negative control that a
  repeated key is reported. `relationship:save` warns on a repeating one side.
- **Charts follow their metric:** a chart from a metric with filters shows the metric's figure,
  equal to its KPI tile. A chart from a metric without filters is byte-identical to today. Two
  measures with different metric filters on one chart each get their own. JS vs resident.
- **Additivity:** the rule table as a unit test. `running_total` over `avg` is refused while over
  `sum` it is allowed, and the same holds on a published page.
- **Snapshot:** the D8 matrix, JS vs resident; the Live refusal.
- **`timeColumn`:** a dashboard period lands on the metric's column and the caption says so;
  compare uses it; with nothing set, the golden fixtures are byte-identical (never re-recorded).
- **Terms:** an inventory test that every door expands them, plus a planted unexpanded term that
  must throw in `applyPipeline` and the Live compiler (the negative control). Editing a term
  changes a cached figure, and a deleted term is refused. A restricted viewer gets no filter
  values or value lists.
- **Base filters:** every Live entry point's statement carries them, with a negative control and a
  parity case.
- **Value labels:** applied in `vizData` and on `/p/`; a label filter filters by the raw value;
  duplicate labels are refused.
- **Labelled joins:** JS vs resident with Dates joined twice. A reference without `via` still takes
  the first relationship, byte-identical to today.
- **Terms outside their table:** a term on Customers.region doesn't touch an Orders column also
  named `region`. An unreachable term is refused on a tile and noted under a dashboard control.

## Build order (each step is its own PR, chained)

1. Tables: `TableDoc`, the key check, relationship warnings.
2. Additivity and the table-calculation refusals.
3. Charts follow their metric (D16), with the list of charts that change.
4. `timeColumn`.
5. Terms.
6. Value labels.
7. Snapshot metrics.
8. Live base filters.
9. Labelled (role-playing) joins.
10. The Data model section, gathering everything (each earlier step adds its fields to the editor it
    belongs to, so nothing waits on the page).

## Changes found while planning (2026-11-03)

The implementation plans ([index](../superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md))
read the code each decision touches. Where the code disagreed with this doc, the plans follow the
code, and these lines record it:

- **Two releases.** The catalog, metric, relationship and dataset sanitizers keep only the fields
  they know, so a pod of the previous release would erase guides, labels, `timeColumn`, snapshots,
  relationship labels and `via` on its next write. Release 1 ships readers and guards only; the
  features come in release 2.
- **D7:** there is no calc picker to grey out (the desktop's menu was deleted), and the metric-tree
  `sum` guard is dropped, because the tree already shows "Not explained by its parts" instead of a
  wrong total.
- **D8:** alerts evaluate a stored copy of the metric's column and aggregation, so they do not get
  snapshots "through the existing doors". An alert with a `metricId` reads its metric's snapshot
  explicitly.
- **D9:** dashboard date controls are marked where their steps are made (`controlSteps` on the
  server, `editor/filters.ts` in the browser), not only where they merge, because KPI cards never
  pass through the merges. Explore's default date axis is dropped: Explore carries no metric.
- **D6:** value labels travel beside the raw values (raw → label pairs in the reply) and are applied
  at the reply edges and in the browser, because cross-filter, drill, colours and several server
  callers key by the raw label. Maps, pivots, cohort and funnel grids, facets, tree splits,
  scorecard breakdowns and driver text keep raw values in part 1.
- **D11:** about 95 filter cleanup sites, not 30, and terms expand **before** the row-access gates
  (the gates read the filters), with the row lock still first in the final list. Tiles gain a
  `notes` line for a dashboard term that doesn't apply, because no such note existed.
- **D13:** Live value pickers send no statement of their own (they read the stored profile), so a
  base-filter change queues a schema sync. Copies made from a Live dataset get the base filters as
  Prepare filter steps.
- **D14:** today a re-saved relationship moves to the end of the list and a re-saved edge gets a new
  id, which silently changes which one is "first". The 09a guard fixes both.
- **D16:** the formula-metric chart path does run on Live, so a chart with two differently filtered
  metrics sends one statement per filter list (counted against the daily limit), and a metric
  filter the Live compiler can't compile becomes a typed refusal.

## Datasets and source tables (owner, 2026-11-03)

Two different things, documented in two places:

| | Source table | Dataset |
|---|---|---|
| What it is | A table or view in the company's database or warehouse (`public.orders`) | Ordinate's own: a copy or a Live view of a source, after Prepare |
| Who reads its docs | Editors and the data team, who write SQL and build datasets | Everyone: people, charts, metrics, the Assistant, agents |
| Its docs | Technical: partition and sort columns, indexes, distribution, required filters, when it refreshes, the data team's owner | Business: what one row is, key, role, guide, field meanings, value labels, terms, metrics |
| Where | **Data model → Source tables**, the tab right after Datasets, with the same layout | **Data model → Datasets** |

- One source table can feed several datasets, such as a Live view and a copy, or two copies with
  different Prepare steps. Its notes are written once and shown read-only in each dataset's Guide
  under **From the source table**.
- Where a warehouse already holds the facts (table and column comments, primary keys, partition and
  cluster keys), a connector reads them instead of someone typing them. Column comments become
  *suggested* field meanings that an editor accepts.
- Source table names and notes show only to people who can open the connection. "No dataset origin
  reaches a browser" still holds for dataset replies: a viewer never sees a schema, a table name
  or SQL.
- **Same layout as Datasets (owner, 2026-11-03).** The Source tables tab has the list, the "To fill
  in next" strip and a panel with the same four tabs: Overview (connection, `schema.table`, keys,
  partitions, when facts were read, owner, datasets built from it), Columns, Guide (the technical
  note) and Lineage (source table → datasets → metrics → charts). Connections stays where a
  connection is set up and tested, and links to the tab.
- **Source tables are part 2.** They need a reader per connector (eight drivers), which is its own
  piece of work. Part 1 names the tab Datasets, and each dataset's Lineage tab shows its source by
  kind and connection name.

## Where it is stored

In **Postgres**, like every other record, not as files on S3. The catalog (table docs, guides,
field docs, value labels) is one record per project (`catalog.json` through `recordFs`), and
terms are records like metrics. With `DATABASE_URL` each record is a row of `records`. S3 or
`DATA_DIR` keeps only Parquet.

Why not markdown files on S3:
- **Edits stay safe.** Records already have the cross-pod lock, the edit-conflict tag, versions and
  Trash.
- **Orgs stay apart.** Every record row is filtered by org, under row-level security.
- **Any pod reads the same copy.** S3 has no transactions, so two editors saving at once could
  silently lose one guide.

dbt keeps its docs as YAML and `.md` files **in the project's git repository**, compiled into
`manifest.json`; some teams host the generated docs site on S3, but git is the source. Ordinate
gets the same "docs as files" benefit later through an export to and import from files (a later
part), with Postgres staying the store.

The Assistant's "context" is not a separate store: each question's facts are built from these
records (`copilotFacts`, `planFacts`), capped, as column notes are today.

## Later parts (not in part 1; each has its own design, index in [README.md](README.md))

| Part | What it adds |
|---|---|
| [2. Source tables](02-source-tables.md) | Source-table docs under Connections, warehouse comments, keys and partitions read automatically (above) |
| [3. AI](03-ai.md) | Instructions for the Assistant, verified questions (Snowflake's verified queries), sample values, a test chat that saves a checked answer |
| [4. Governance](04-governance.md) | Certified and retired status with "use X instead", approvals, hiding a column or metric from a role (object-level security) |
| [5. Metrics depth](05-metrics-depth.md) | Distinct counts, funnel (conversion) metrics, saved running totals (Revenue YTD), each account's own last value in snapshots, targets |
| [6. Navigation](06-navigation.md) | Hierarchies and drill-down by level, views per team (a "Sales" view with only its fields) |
| [7. Portability](07-portability.md) | Definitions as files (export and import, git), Ossie export, importing dbt definitions, querying an external semantic layer (dbt, Cube, Snowflake semantic views) |
| [8. Engine](08-engine.md) | Calculated fields on Live tables, computing fan-out joins instead of refusing them, column-level lineage |

## Left to the builder

- Contract and file names, and the exact Data model layout (after mockups).
- Where the key check hooks into refresh and re-import.
- Whether the formula-metric chart path (`vizMetricMeasures`) runs on Live datasets. If it
  doesn't, bring D16 on Live back to the owner before building it.
- Whether `metricTree` already refuses a `sum` over a non-additive child (D7).
- The exact caps on the facts blocks for the guide and value labels.
