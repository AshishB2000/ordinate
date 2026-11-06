# Model files: your definitions in git

A project's definitions (what its datasets, columns, metrics, glossary terms and relationships mean) can
leave Ordinate as plain files and come back after a review. Export is **Export ▾ → Model files** on the
Data model page; import is **Import…** beside it. The same two operations are available to programs as the
MCP tools `export_model` and `import_model` ([`automation.md`](../automation.md)), so a CI job can keep the
files in git. Only a project's **editors** can export or import.

## The layout

A folder (or the zip the app downloads):

```
model.json              format "ordinate-model", formatVersion, appVersion, the calendar (reference only)
datasets/<slug>.json    id, name, table doc (role, key, grain), field docs, value labels, Live base filters
datasets/<slug>.md      the dataset's guide, as written
metrics/<slug>.json     id, name, definition, filters, format, timeColumn, snapshot, target
terms/<slug>.json       id, name, aliases, description, dataset, filters
relationships.json      sorted by id, with labels
```

Keys are sorted, indented by two spaces, with a trailing newline, so git shows a line per change. A slug
comes from the name (a clash gets `-2`). References are by id. Each object carries `base`, a hash of the
object as exported: it is how an import tells "edited in git" from "edited in the app". Leave `base` alone.

A term, `terms/emea.json`:

```json
{
  "aliases": ["Europe and ME"],
  "base": "…",
  "dataset": "00000000-0000-4000-8000-000000000003",
  "description": "Europe and the Middle East",
  "filters": [{ "column": "region", "op": "in", "type": "filter", "values": ["EU", "ME"] }],
  "id": "00000000-0000-4000-8000-000000000008",
  "name": "EMEA"
}
```

A metric, `metrics/orders.json`:

```json
{
  "base": "…",
  "dataset": "00000000-0000-4000-8000-000000000003",
  "definition": { "aggregation": "countd", "column": "order_id" },
  "format": { "compact": false, "decimals": 0, "kind": "number" },
  "id": "00000000-0000-4000-8000-000000000005",
  "name": "Orders",
  "timeColumn": "day"
}
```

A dataset, `datasets/orders.json`, with its guide beside it in `datasets/orders.md`:

```json
{
  "base": "…",
  "description": "Every order line",
  "fields": [
    { "description": "Net amount", "displayName": "Amount", "name": "amount", "sensitivity": "financial" },
    { "example": "EU", "name": "region", "values": [{ "label": "Europe", "value": "EU" }, { "label": "Middle East", "value": "ME" }] }
  ],
  "grain": "One row per order line",
  "id": "00000000-0000-4000-8000-000000000003",
  "key": "order_id",
  "name": "Orders",
  "role": "fact"
}
```

## What travels, and what never does

Travels: table and field docs, value labels, Live base filters, metrics, glossary terms, relationships.
Never: rows, connections, a dataset's origin (table name, SQL, URL), row and column access rules, secrets, a metric
another tool's semantic layer defines (it stays with that tool; a file holding one is skipped on import). Not carried
yet: metric trees, drill hierarchies, certified and retired marks, Assistant instructions, verified questions, source
table notes, Live calculated fields and topics; an export lists what it left out (`notCarried`), and an import keeps
them on the objects it updates. A
caller whom a row access rule restricts is refused, since the files hold term values and value labels the
rule withholds.

Within one release the export is byte-identical while nothing changes: the same project exports the same
bytes, in the app or over MCP.

## Ossie

Export ▾ → Ossie (`model:exportOssie`) writes the same definitions as one Ossie document (Apache Ossie, the Open
Semantic Interchange spec), **pinned to `0.2.0.dev0`**, the draft read on 2026-11-05 (the only release, 0.1.1, uses
another shape). It is JSON with sorted keys, byte-identical while nothing changes, built from the model files
above, so it carries no rows, origins, secrets or access rules. Export only: nothing is imported from Ossie.
The mapping, with the spec's names, is `docs/semantic-layer/ossie-mapping.md`.

Maps: dataset (name, description and grain, key, guide as AI context), every column as a field (documented fields add
description, synonyms, example, and a time dimension for a metric's date column), simple metrics (sum, average,
count, min, max, distinct count), relationships. A Live dataset over a table names that table as its `source` when
the caller can open the connection; every other dataset has no table, so its `source` holds its own name.

Does not map, and is listed after the download by object and reason: terms, value labels, always-applied filters,
dataset roles, sensitivity, number formats, direction, targets, a non-default calendar, metrics with filters, and
formula, period, funnel and snapshot metrics (Ossie metrics cannot refer to other metrics and have no filters or
semi-additive measures). What Ossie cannot hold is also in the file under one `ordinate` extension. The same caller
who may export the model files may export Ossie; a restricted caller is refused.

## How an import merges

An import is always a **dry run first**: a plan that says, per object, `unchanged`, `updated`, `renamed`,
`new`, `conflict` or `skipped` (with why), and lists what is `only here`. The apply takes the plan's hash and
refuses if the project changed since ("This project changed since the dry run. Check again.").

- Objects match by id, then by exact name (so a file from another project updates the same-named object).
- Datasets are never created: a file for a dataset the project lacks is skipped, with everything that
  references it.
- Three-way, within one project: when the file and the project both changed an object since its `base`, it is
  a `conflict` and the project's version stays unless you choose the file's. Across projects every difference
  is an update.
- **Never a delete.** An object only the project has stays.
- A column's sensitivity may be raised, never lowered.
- Every object goes through the same checks as the editor's save (names, formulas, term cycles, caps).

## From dbt

**Import…** also takes dbt's `target/semantic_manifest.json` (written by `dbt parse`). It is a **copy**: dbt
stays the source of truth only through a live dbt connection. The file is told by its content, not its name;
a full `manifest.json` small enough to read works too, and one over 32 MiB or 1,000,000 values is refused
with "Upload target/semantic_manifest.json instead: it holds only the semantic layer." It goes through the
same dry run and apply as model files, with one step more: under **Datasets** you confirm which dataset each
semantic model is. Datasets are never created.

| dbt | Ordinate |
|---|---|
| Semantic model | the dataset you pick; first offered by its exact name, else a name that differs only in case, spaces or `_` ("matched by name: check it") |
| Primary entity whose `expr` (or name) is a column | the table's key |
| Dimension on a column (a time dimension on a date column) | the field's description; `label` as its display name |
| Simple metric: `sum`, `count`, `average`, `min`, `max`, `count_distinct` over a column | `{ column, aggregation }` (`avg`, `countd`) |
| The measure's `agg_time_dimension`, else the model's default | the metric's date |
| `non_additive_dimension` with no `window_groupings` | a snapshot: the last day for `max`, the first for `min` |
| Filters: `{{ Dimension('<entity>__<dimension>') }}` with `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `IS [NOT] NULL`, joined by `AND` | filter steps; `!=` and `NOT IN` also leave out an empty cell, as SQL leaves out NULL |
| Ratio; derived (`+ − × ÷`, brackets, numbers) over metrics on one semantic model | a formula metric (`[Revenue] / [Orders]`) |
| Cumulative, `window: N days` (N ≤ 366) or `N weeks` (N ≤ 52), `period_agg: last` | a period metric, `last N days` (weeks as 7N days, never calendar weeks), over the unfiltered simple metric on the same measure; its filters become the period metric's |
| Cumulative, `grain_to_date: month`, `quarter` or `year`, `period_agg: last` | `month`, `quarter` or `year` to date, while the workspace's calendar is dbt's: Gregorian, and for a quarter or year the year from January |

A metric's name is its `label`, else its dbt name. Each carries where it came from, so importing the file again
updates it, even after a rename here (the dry run shows the rename back). An import changes only what dbt says:
a table's role, grain, description and guide, a field's other names and value labels, and a metric's format,
direction and target stay this project's.

**Skipped, each named with why**, never approximated: a cumulative metric that is not one of the two rows above (no
window and no grain; `period_agg` `first`, dbt's default, or `average`; a window in months, quarters, years or
hours, or a custom grain; a week to date, as dbt's week is its warehouse's; a to-date on another calendar;
`fill_nulls_with`; no unfiltered simple metric with a date on its measure; over a balance; over a count, which is 0
here where dbt has no figure); conversion metrics (dbt pairs each conversion with the closest base event and counts
conversions, Ordinate's funnel counts people from their first); a derived input with `offset_window` or
`offset_to_grain` (dbt shifts each day, then adds the days up); inputs on more than one semantic model;
`window_groupings` (how dbt groups it by other fields is not documented); `median`, `percentile`, `sum_boolean` and other aggregations; an `expr` that is SQL rather than
one column; a filter of any other shape (`OR`, `LIKE`, `TimeDimension`, a function, another entity's dimension,
an ordering comparison on text), or on a ratio or derived metric; `fill_nulls_with` (dbt shows 0 where there are
no rows, Ordinate shows no figure); a snapshot on a Live dataset; a metric type Ordinate does not read; and a
ratio or derived metric whose input was skipped, listed under that input. Foreign entities are not imported. One
upload reads at most 500 semantic models and 2,000 metrics. dbt import is in the app only: MCP's `import_model`
takes model files.

**Imported windows and dbt.** A window metric matches dbt on every day, and on every week, month, quarter and
year that has ended with rows in its last window. dbt reads a period at its last day whose window holds rows, so
where a period's last window holds none (orders that stopped mid-month, a Sunday with no order), Ordinate shows no
figure and dbt repeats its last day with rows. For the period in progress Ordinate counts up to today, and a "last N
days" window up to yesterday. A to-date follows the workspace's calendar from the import on: change the calendar
and it moves away from dbt, as every period metric moves. The dry run says both under Datasets.

The translation is held, figure by figure, to dbt's on checked-in projects (`scripts/fixtures/dbt/` with
`scripts/test-dbtImport.ts`, `scripts/fixtures/dbt-part5/` with `scripts/test-dbtPart5.ts`; each README says how the
figures were recorded).

## The loop in CI

A personal API token (**API tokens** in the app) acts as its user, so use an editor's. Both calls are
`POST /api/mcp` with `Authorization: Bearer ord_…`.

1. A job exports and commits the files:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "export_model", "arguments": { "project": "Retail model" } } }
```

   The reply's `structuredContent.files` maps each path to its text; write each one unchanged.

2. On a pull request, a job sends the changed files as a dry run, with no `apply`, and posts the `plan`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "import_model", "arguments": { "project": "Retail model", "files": { "model.json": "…", "metrics/orders.json": "…" } } } }
```

3. On merge, a job sends the same files with `apply: true` and the `plan.hash` from a dry run of that very
   content (run the dry run, read the hash, apply in the same job):

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "import_model", "arguments": { "project": "Retail model", "files": { "model.json": "…" }, "apply": true, "planHash": "<plan.hash>" } } }
```

   The reply is `{ written, failed }`; each failure names the object and says why. There is no "before"
   download over MCP: git is the undo.

Each call is audited as `mcp:export_model` or `mcp:import_model`; a viewer's token is denied and audited.

**Size.** A request body is capped at 1 MiB (a larger one is a 413). A bigger model needs the app's Export
and Import, which take a zip.
