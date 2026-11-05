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
Never: rows, connections, a dataset's origin (table name, SQL, URL), row access rules, secrets. Metric trees,
hierarchies, instructions and verified questions are not carried yet; an export lists what it left out. A
caller whom a row access rule restricts is refused, since the files hold term values and value labels the
rule withholds.

Within one release the export is byte-identical while nothing changes: the same project exports the same
bytes, in the app or over MCP.

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
