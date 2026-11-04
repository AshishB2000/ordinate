# Semantic layer, part 7 — Portability

Status: draft, not built (2026-11-03). Depends on part 1 ([00-design.md](00-design.md)).

Part 1 makes Ordinate the semantic layer for a company that has none. Part 7 moves definitions
in and out: as **files** (git, review, promoting a test project to the real one), as an **Ossie**
file for other tools, as an **import of dbt** definitions, and, for a company that already has a
semantic layer, by **querying that layer live** each time a chart loads. Claims about Snowflake,
dbt, Cube and Ossie beyond what the owner settled are marked **(to verify)**.

## What you will see when this is done

**Data model** gets **Export ▾** (Model files · Ossie) and **Import…**. An import always shows a
dry run first:

```
Import model files — dry run                               retail-model.zip
  ✓ 14 unchanged
  ↻  3 updated     Revenue (filters), Orders (guide), EMEA (values)
  ✎  1 renamed     "Avg basket" → "Average basket"
  ＋ 2 new         Term "Enterprise" · Metric "Gross margin"
  ⚠  1 conflict    Stock on hand: changed here and in the file     [ Keep this project's ▾ ]
  –  2 skipped     Dataset "Returns" is not in this project (and 1 metric on it)
  ○  4 only here   Not in the files. An import never deletes.
                                                  [ Cancel ]  [ Apply 6 changes ]
```

Under **Connections**, a Snowflake connection lists its semantic views beside its tables, and a dbt
or Cube connection lists its models. **Add as dataset** makes a Live dataset whose measures are the
layer's own metrics:

```
Measure ▾    METRICS FROM SNOWFLAKE · Sales semantic view
             Revenue        can be added up        Defined in Snowflake: edit it there
             Avg basket     can't be added up
```

A chart that needs rows says so where the figure would be: "A pivot table can't be drawn from
Sales: Snowflake computes its metrics and returns totals, not rows."

## Intent

- **Postgres stays the store; files are a door**: reviewable in git, movable between projects.
- **A company's own semantic layer keeps its definitions**: Ordinate asks it for figures only.
- **Every way in lands in one merge**: dbt (later Ossie) becomes model files, then one dry run.

## Goals

1. Export the model as JSON files plus a markdown guide per dataset, byte-identical when unchanged.
2. Import them into an existing project: id then name, renames, three-way conflicts, a dry run first.
3. Export an Ossie file with a report of what did not map.
4. Import dbt's simple, ratio and derived metrics on one model, naming everything skipped.
5. Query an external layer live: Snowflake semantic views, then dbt's Semantic Layer API, then Cube.

## Non-goals

- **Git sync.** People commit the exported files; a CI job imports them through MCP (D8).
- **Ossie import** until the spec reaches 1.0: a moving draft breaks round trips.
- **Importing dbt metrics Ordinate cannot compute** (cumulative, conversion, time offset,
  cross-model); the live dbt connection reaches them.
- **Writing back** to a layer (connectors are read-only), and **running MetricFlow** (Python).
- **A company's internal MCP as a data source** ([below](#the-internal-mcp-connector-not-in-this-part)).

## Anti-goals (a failure even if it works)

- **Two live copies of one definition**: a layer's metric mirrored with its math, drifting apart.
- **An import that overwrites or deletes silently**, or **stores what the editor would refuse**.
- **Ordinate combining a layer's figures**: adding up two averages dbt returned, or folding
  "Other" from a ratio metric ourselves.
- **A model translating a definition.** No AI in any mapping: a guessed mapping is a wrong number.

## Approaches

**A. Ordinate is the store; files and other layers are doors (my call).** Records in Postgres stay
the truth. Model files and Ossie are exports; model files, dbt and later Ossie are imports through
one merge; an existing layer is a Live connection whose metrics Ordinate names but never defines.
*Trade-off:* a team that wants git as its truth runs export/commit or CI/import itself.

**B. Files are the truth (git sync):** Ordinate reads a repo, UI edits become commits. Right for
code-first teams, but it needs git credentials, a sync job, a UI conflict story and likely a YAML
parser, and it reverses part 1's rejection of files first.

**C. Translate every external layer into Ordinate** and compute it ourselves: the two-copies
anti-goal, MetricFlow's metric types exceed our engine, and the owner chose querying live.

A wins: nothing in part 1 moves, every door is optional, and each layer keeps its math.

## Decisions

### Model files (7a)

**D1. JSON, not YAML (my call; open question 1).** No YAML parser is in `package.json` or
`node_modules`, and adding one is a runtime dependency. A YAML writer is easy, but files that
cannot be read back do not round-trip. JSON is written with sorted keys (`stableStringify` in
`src/engine/queryCache.ts`), 2-space indent and a trailing newline, so git diffs line by line.

**D2. Layout.** One zip, unzipped into a folder:

```
model.json              format "ordinate-model", formatVersion 1, appVersion, the calendar (read-only)
datasets/<slug>.json    id, name, table doc (role, key, grain), field docs, value labels, base filters
datasets/<slug>.md      the dataset's guide (part 1 D4)
metrics/<slug>.json     id, name, definition, filters, format, timeColumn, snapshot
terms/<slug>.json       id, name, aliases, description, dataset, filters
relationships.json      sorted by id, with labels (part 1 D14)
```

- Slugs come from names (a clash gets `-2`, in id order). No timestamps or `updatedBy` (my call):
  they would change on every export and drown the real diff.
- **References are by id**, resolved through the export's own files, so each name lives in one
  place. Formula metrics keep naming metrics (`[Profit]`, `src/analysis/metricFormula.ts`).
- Each object carries `base`, a hash of it as exported, for D4's three-way check.

**D3. What travels.** Definitions only: table and field docs, value labels, metrics, terms,
relationships, Live base filters. **Never:** rows, connections, dataset origins (no table name,
SQL or URL reaches a browser), row access rules, secrets. The calendar is for reference, never
imported. Not the project bundle (`src/app/bundle.ts`): that carries Parquet, and its import always
makes a **new** project with remapped ids (`bundleImport.ts`). Model files merge, and are read.

**D4. Import merges after a dry run, stateless across pods.** `model:importPlan(fileToken)` returns
each object as unchanged, updated, renamed, new, conflict, skipped (with why) or only here, plus a
hash of the plan. `model:importApply(fileToken, planHash, choices)` takes the zip again (file
tokens are single-use), re-plans, and refuses a different hash: "This project changed since the dry
run. Check again." Matching:
- **By id, then exact name.** Same id, new name: a rename. Same name, other id: an update keeping
  the target's id (the promotion case, where two projects' ids differ).
- **Datasets are never created or deleted** (they need data). An unmatched one is skipped with
  everything that references it, each listed. Field docs for a missing column are skipped.
- **Three-way conflicts.** The file differs from its `base` (edited in git) and so does the project
  (edited here): a conflict, defaulting to **keep this project's** (my call). With no shared base,
  across projects, every difference is an update, shown as a diff.
- **Never a delete** (my call): extra objects are listed as "only here". Deleting a term stays a
  person's act, since part 1 D11 refuses figures that reference a deleted term.
- **Sensitivity may rise, never fall** (my call). A lowered marking is skipped and shown.

**D5. Same gates as the editor.** Every object goes through its save path's sanitizer (metrics,
terms, table docs, value-label uniqueness, term and metric names unique together); formulas compile
at plan time and term cycles are refused. The zip is read by `src/app/zipReader.ts` with its own
whitelist (the `bundleRules.ts` pattern), JSON through `parseBounded` (`src/app/jsonBudget.ts`),
guides capped at part 1's 8,000 characters.

**D6. Writes go per object, in order, and can be undone.** Table docs, terms, metrics, then
relationships, each through the tagged save (`lockedUpdate`, `src/app/editConflict.ts`). With no
multi-record transaction, a failure part way reports what was written; a re-run skips the
unchanged, and each overwritten record keeps its last version.

**D7. Editors only (my call).** Export and import need `write` on the project. The files hold term
filter values and value-label lists that part 1 (D6, D12) withholds from restricted viewers, so a
caller restricted by a row access rule anywhere in the project is refused export.

**D8. MCP, so git can drive it.** `export_model` returns the files inline; `import_model` takes them
inline (within `/api/mcp`'s `MAX_BODY`), dry run by default, `apply: true` with the plan hash.

### Ossie export (7g)

**D9. Export only, pinned to the spec version it was tested against.** Source table names appear
only for Live datasets whose connection the caller can open (part 1's source-table rule); a
SQL-defined dataset or an extract exports with none, and the report says so. Every Ossie name here
is **(to verify)** against the spec when built.

| Ordinate | Ossie (to verify) | Notes |
|---|---|---|
| Dataset: name, description, grain, key | dataset or logical table, primary key | Role only if the spec has one |
| Field: type, meaning, display name, other names | field or dimension, synonyms | |
| Simple metric | metric expression | Filters only if the spec has metric filters |
| Formula metric (`+ − × ÷` of metrics) | derived metric | Anything else not mapped |
| `timeColumn`; snapshot metric (part 1 D9, D8) | time dimension; semi-additive measure | |
| Relationship, cardinality, label | relationship | |
| Guide | description or AI context | Markdown as text |

Not mapped, and listed: terms (unless the spec has named filters), value labels, base filters,
formats, direction, calendar. Never exported: row access rules, sensitivity, secrets. If the spec
allows vendor extensions (to verify), unmapped fields go into an `ordinate` extension.

### Importing dbt definitions (7f, secondary)

**D10. A translation into model files, then D4's merge.** The person uploads
`semantic_manifest.json` or `manifest.json`: JSON, no parser, no dbt Cloud or git access. A copy,
and the dry run says so; teams keeping dbt as their truth use the live connection (7d). dbt field
names are **(to verify)**:

| dbt | Ordinate |
|---|---|
| Semantic model | an existing dataset, by name; the person confirms in the dry run |
| Primary entity; dimension | table key (part 1 D1); field doc |
| Simple metric: sum, count, average, min, max | simple metric (distinct count waits for part 5) |
| Metric filter | filter steps, only in shapes part 1's filters have; else skipped |
| Ratio; derived (`+ − × ÷`, brackets) | formula metric, all on one model |
| `agg_time_dimension` | `timeColumn` |
| `non_additive_dimension`, no window groupings | snapshot (part 1 D8 was built to match) |

Skipped and named: cumulative, conversion, time offset, cross-model, window groupings, unknown
aggregations. Imports carry `importedFrom: { kind: 'dbt', name }`, so a re-import updates.

### Querying an external semantic layer live (7b–7e)

**D11. A semantic dataset is a Live dataset**: `mode: 'live'` plus `live.semantic: { backend:
'snowflake' | 'dbt' | 'cube', model }`. Its columns are the layer's **dimensions**, typed as the
layer reports. It inherits the Live safety net (`getDataset` throws `LiveDatasetError`,
`src/data/liveDataset.ts`), the three doors (`src/ipc/liveRoute.ts`) and the web's `mode` gates.
The schema sync (`src/engine/live/schemaSync.ts`) reads dimensions and metrics from the layer and
skips the row sample, so no sensitivity is detected: markings are set by hand, and the page says so.

**D12. The IR gains a metric by name** (`src/engine/live/liveSpec.ts`):

```ts
export type LiveMeasure = { column: string; aggregation: LiveAgg } | { metric: string };
```

A metric name must be in the dataset's synced list, as a column must be declared (plan D4). A
metric measure on a plain Live dataset, or a column measure on a semantic one, is refused (my
call: aggregating a dimension ourselves goes around the layer). The adapter gets its own file
(`liveSpec.ts` is 452 lines, `compile.ts` 455).

**D13. A layer's metrics are metric records holding a name, not math (my call).** The sync writes
one `Metric` per external metric with a third definition kind, `{ external: '<layer name>' }`,
beside simple and formula (`src/analysis/metrics.ts`). Definition and filters are read-only ("Defined
in dbt: edit it there"); format and direction stay Ordinate's. Every surface that lists metrics
then gets them with no new reader: measure picker, KPI tiles, alerts, scorecards, the Data model,
`metric:usage`, Assistant facts, MCP `list_metrics` and `metric_value`. Part 1 D16 (a chart reads
its metric when drawn) turns the reference into `{ metric }`.
- **The cost:** 33 places in 19 files branch on the definition kind (`isFormulaDefinition`,
  `'formula' in`), and `computeCardMetric`'s `{column, aggregation}` spec (`src/ipc/dashboards.ts`)
  widens to take `{ metric }`. That inventory is in 7b, with a second line of defence: an external
  definition reaching the JS or resident engine **throws**.
- A dropped metric stays, listed as missing like `live.missingColumns`, and refuses: "Revenue is no
  longer defined in dbt". A layer-side rename is missing plus new, never a silent remap.
- Names are unique per project, case-insensitively (`metricsByName`); a clash appends the
  connection's name ("Revenue · dbt prod"). A trashed mirror is not recreated by the next sync.

**D14. One capability, one registry entry per source.** `ConnectorDef` gains an optional
`semantic: { backend, listModels, describeModel, query }` (`src/connectors/types.ts`), a property
like `live`, never a second kind of connector.
- **Snowflake** has it on its existing entry (`src/connectors/snowflake.ts`, 443 lines; listing goes
  in a new `snowflakeSemantic.ts`): same account, role and secrets, queried as SQL through
  `live.runBound` with bound values.
- **dbt** and **Cube** are new `FAMILY_MODULES` entries (`src/connectors/index.ts`). `listTables`
  lists models; `run` refuses, since a layer has no rows to copy. Plain JSON POSTs go through
  `httpShared.httpRequest` (SSRF pin, byte ceiling, abort), with no GraphQL client or JWT library
  (Cube's token, if HS256 (to verify), is a few lines of `node:crypto` beside `connectors/jwt.ts`).
  Tokens are `secret: true` fields stored as `connection.token` (`src/server/secrets/store.ts`)
  through `src/ipc/connectionSecrets.ts`: no new secret kind.
- "Make a copy" (`dataset:copyLive`) is hidden and refused on a semantic dataset.

**D15. Compile per backend; shape through the existing code.** `src/engine/live/semantic/` holds one
file per backend: IR in, one request out, and the reply read back into the rows `shape.ts` already
labels, so labels still come from `analysis/categoryKey`, never from the layer.
- **Snowflake:** `SELECT … FROM SEMANTIC_VIEW(…)` with `?` binds. Binds inside the clause are **to
  verify**; if refused, filters go in an outer `WHERE` on grouped dimensions only, others refused.
- **dbt:** GraphQL with JSON results. If filters are template text only (to verify), values cannot
  be bound, so a closed literal encoder writes them (finite numbers, ISO dates, escaped text from a
  strict character class), backed by a fuzz suite; anything else is refused, never inlined raw.
- **Cube:** a REST JSON query, values as JSON (to verify).

**D16. What a layer cannot do is refused, typed** (new `LiveRefusalCode`s, catalog sentences):
- **Needs rows:** pivots, cohorts, funnels, drivers, maps, facets, raw points, drill to rows, grids,
  row exports, SQL over the dataset, joins. Already refused on Live; the sentences name the layer.
- **Needs our re-aggregation:** number bins, retail weeks rolled up from days, an automatic date
  grain (the picker offers the layer's grains), table calculations over a metric that can't be
  added up (part 1 D7), snapshot metrics, formula metrics over external metrics.
- **"Other" is a second question, never a sum (my call).** Ask for the top 50 groups plus one. Only
  if the 51st comes back, ask again with `dimension NOT IN (top 50)`: the layer computes "Other",
  which is right even for a ratio.
- **Can it be added up:** only where the layer says plain sum or count (to verify per backend).

**D17. Row access fails closed on external layers (my call; open question 2).** Row policy needs a
binary comparison per dialect (`binary()` in `src/engine/live/dialect.ts`, row-policy D13); a dbt
or Cube filter compares in a collation we cannot see. A restricted caller is refused (`row_policy`),
as one already is on any saved-metric measure (`src/ipc/rowDoors.ts`). Value pickers and the AI's
spelling lookups take the same refusal. The Snowflake dialect's `TO_BINARY` form, if it works inside
`SEMANTIC_VIEW` (to verify), lifts it for Snowflake once pinned in `test-rowPolicyLive`.

**D18. The Live cost guards, unchanged.** `warehouse()` (`src/engine/live/liveWarehouse.ts`) is
widened to take a semantic request beside a SQL statement, so every request is slotted
(`LIVE_MAX_CONCURRENT`), counted (`LIVE_DAILY_QUERY_LIMIT`, `live_usage`), timed out
(`LIVE_QUERY_TIMEOUT_MS`), cancelled on hang-up (dbt's cancel to verify; at least we stop polling),
shared in one flight (`liveFlight.ts`) and floored on `/p/`. The cache key is today's (`orgKey`,
epoch, `schemaSyncedAt`, the IR, which now names metrics). A layer's edit shows within the cache
age, or at once on Refresh or the refresh URL. Layer error text goes to the log via `safeError`
(R-L6); no view name, dbt environment or Cube URL is in a dataset reply.

## The internal-MCP connector (not in this part)

It brings **rows**, not definitions, so it belongs with the connectors in its own design
(`docs/connectors/mcp-source.md`, not written). Settled by the owner: never a figure source by
itself; **copy-only**, for when a company's MCP is its only door; it accepts `structuredContent`
matching the tool's `outputSchema`; remote HTTP servers only (no stdio, so no child process from
config); every socket through the SSRF guard; its token a connection secret.

## Constraints (from the repo's rules)

- **Contracts:** `model:export`, `model:importPlan`, `model:importApply`, `model:exportOssie` and
  the semantic-model listing and create, each `write` with project scope and a zod input;
  `src/api/index.ts` append-only; `read` contracts classified in `scripts/rowPolicyReaders.ts`.
- **Any pod:** files move by `fileToken`/`downloadToken`; the dry run keeps nothing in memory.
- **Live:** semantic datasets join `test-liveSafetyNet`; no figure path bypasses the three doors.
- **Security:** SSRF guard on every socket (a self-hosted Cube is often private: `SSRF_ALLOW`, in
  `docs/server/configuration.md`); secrets in the store, canary-tested; no `eval`, no child process.
- **No new runtime dependency, no migration:** JSON, `node:crypto`, the zip reader and writer.
- **Sentences** through `t()` and the i18n extract. **File size:** new work goes in new files;
  `liveSpec.ts`, `compile.ts`, `snowflake.ts` and `connections.ts` (662 lines) barely grow.

## Tests

- **Round trip:** export, then import into the same project: all unchanged, zero writes. Export,
  import into a clone with the same datasets, export: byte-identical files. Goldens never re-recorded.
- **Merge matrix:** rename, update across ids, three-way conflict under both choices, a skipped
  dataset and its dependents, "only here" never deleted, sensitivity never lowered, a stale plan
  hash refused. Negative controls: a duplicate value label, a term cycle, a metric named like a
  term, an unknown zip entry and an oversized guide are each refused as the editor refuses them.
- **Leaks:** grep every exported file and plan reply for a planted secret, table name, SQL string
  and row-policy value. None are found, and a planted canary proves the grep finds one.
- **dbt translation:** a checked-in fixture `semantic_manifest.json` with figures computed offline by
  MetricFlow from the same seed CSV (the command recorded beside it). Imported metrics over the seed
  agree; any float divergence is pinned by name. Each skipped type appears in the plan.
- **Layer parity, per backend:** a test-only fake for each (the `scripts/liveFakeConnector.ts`
  pattern, `registerTestConnector`) answers by running in DuckDB the SQL the fixture's definitions
  expand to. The same charts, KPIs and answers over an extract of the seed, with equal Ordinate
  metrics, agree by `Object.is`: top N, "Other" as a second question, grains, filters. This proves
  our adapter, not the vendor's math. Golden requests pin each backend's request per IR shape.
- **Real engines, nightly** (beside live-data L2.8's runs): Snowflake, Cube in a container, dbt if
  an account exists (open question 3).
- **Refusals and guards:** each D16 code at every door; an external definition planted in the JS
  engine throws; a restricted caller is refused at every door (`test-rowPolicyLive`);
  `test-liveUsage` still finds only `warehouse()`; a private-range Cube URL is refused without
  `SSRF_ALLOW`, redirects re-checked (`test-ssrf`); dbt and Cube tokens are `test-secrets` canaries.
- **The dbt literal encoder:** quotes, template braces, NUL, line breaks, lookalikes, each encoded
  exactly or refused, plus a negative control showing a raw value would have broken out.

## Build order (chained PRs)

Two tracks on different files, each chained in order:

| Sub-part | PRs |
|---|---|
| **7a Model files** (`src/app/`) | 1 export and round trip · 2 dry run and the merge matrix · 3 apply with plan hash · 4 MCP tools, `docs/automation.md` regenerated |
| **7b Layer foundation** (`src/engine/live/`, needs part 1 D16) | 1 IR `{metric}`, refusal codes, `warehouse()` widened, fake bench · 2 `live.semantic`, layer sync, external metric records, the `isFormulaDefinition` inventory · 3 picker, Data model badges, Connections listing (mockups first) |
| **7c Snowflake semantic views** | adapter, golden requests, nightly parity |
| **7e Cube** (built before 7d: no dbt Cloud account yet) | connector, nightly container parity |
| **7d dbt Semantic Layer** (beta until a dbt Cloud account runs nightly) | connector, literal encoder and fuzz, fixture parity |
| **7f dbt import** | the translator into 7a's merge |
| **7g Ossie export** | after checking the spec at that date |

## Dependencies

- **Part 1:** table docs (D1), value labels (D6), additivity (D7), snapshot (D8), `timeColumn` (D9),
  terms (D10–D12), base filters (D13), labelled relationships (D14); 7a exports each kind as it
  lands. **D16 is a hard prerequisite for 7b**, and part 1's open question (does
  `vizMetricMeasures` run on Live?) decides how a chart with an external metric is planned.
- **Part 2:** Ossie's source names reuse its "people who can open the connection" rule. **Part 5:**
  distinct counts, before dbt's distinct counts import. **Parts 3, 4:** AI instructions and
  certified status join the files later, under a `formatVersion` bump.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

**Facts from the owner:** there is no dbt Cloud account with the Semantic Layer yet. So 7e (Cube) is built before 7d (dbt), and dbt ships labelled beta until a real account runs the nightly parity.

1. **Model files as JSON, with no new dependency?** YAML needs a parser at run time.
   *Recommended:* JSON now; YAML later as a second reader of the same schema, if teams ask.
2. **Refuse restricted viewers on every external layer in part 7?** *Recommended:* yes, fail closed;
   lift it per backend once a binary comparison is pinned, Snowflake first.
3. **Is there a dbt Cloud account with the Semantic Layer for nightly tests?** *Recommended:* if not,
   build Cube (7e) before dbt (7d) and label dbt beta until a real account runs nightly.

## Left to the builder

- Snowflake's exact `SEMANTIC_VIEW` syntax, listing and describing views, and binds in the clause;
  the same for dbt's GraphQL and Cube's REST shapes, hosts and auth.
- How each backend answers Live's two lookups (the latest date for a relative period, stored
  spellings for the AI); a backend that cannot refuses those questions, typed.
- What a dbt dataset is: picked metrics plus their shared dimensions, or a saved query (to verify).
- Slug rules, the plan hash, the dry-run layout (mockups first), the clash-suffix wording, the
  `isFormulaDefinition` site list, and whether mirrors are written in the sync's one write or after.
