# Semantic layer, part 2 — source tables

Status: draft, not built (2026-11-03; revised the same day: source tables get their own Data model
tab). Builds on [part 1](00-design.md) and its section
[Datasets and source tables](00-design.md#datasets-and-source-tables-owner-2026-11-03).

A **source table** is a table or view in the company's database or warehouse (`ANALYTICS.ORDERS`).
A **dataset** is Ordinate's copy or Live view of one. Part 1 documents datasets for everyone. Part 2
documents source tables for the people who build datasets, and reads what the warehouse already
knows so nobody types it twice.

## What you will see when this is done

**Data model** has a tab per kind: **Datasets · Source tables · Metrics · Glossary ·
Relationships** (plus part 3's Assistant). An editor opens **Source tables**. It is laid out like
Datasets: the list on the left, grouped by connection, the picked table's panel on the right, and
a **To fill in next** strip above both.

```
Data model · Retail demo      Datasets  [Source tables]  Metrics  Glossary  Relationships

TO FILL IN NEXT  [ RETURNS: no doc ]  [ CUSTOMERS: no owner ]  [ public.orders: never read ]  +2 more

WAREHOUSE (Snowflake)        + Add │ ANALYTICS.ORDERS                          [ Edit ]
  ANALYTICS.ORDERS     3 datasets  │ Overview · Columns · Guide · Lineage
  ANALYTICS.CUSTOMERS  1 dataset ⚠ │ Connection    Warehouse (Snowflake)
  ANALYTICS.RETURNS    no doc    ⚠ │ Owner         Data platform (Priya N.)
SHOP DB (PostgreSQL)         + Add │ Refreshes     Hourly at :15, by the orders_hourly job
  public.orders        1 dataset   │ Required      Filter on ORDER_DATE, or a query scans every partition
                                   │ Primary key   LINE_ID (declared, not enforced)
                                   │ Clustered by  ORDER_DATE, REGION
                                   │ Rows          ~48.2M (the warehouse's estimate) · 12.4 GB
                                   │ Read          3 days ago by sam            [ Read again ]
                                   │ Built from it Orders (copy) · Orders (Live) · Daily sales
```

- **Columns**: each column's warehouse type, comment and a key mark.
- **Guide**: the technical markdown note, with who edited it last.
- **Lineage**: this table → the datasets built from it → their metrics → charts and dashboards.

**Connections** stays where a connection is set up and tested. Its details rail and the selected
table carry **Document in Data model ↗**.

In **Data model → Datasets → Orders**, an editor sees two additions:

```
Guide   …the dataset's own guide (part 1)…
        FROM THE SOURCE TABLE · ANALYTICS.ORDERS on Warehouse              Open in Source tables ↗
        Owner Data platform · refreshes hourly at :15 · filter on ORDER_DATE · key LINE_ID
        …the source notes, read-only…

Fields  discount   Meaning  —        The warehouse says: "Discount in USD, after tax"  [ Use ] [ Dismiss ]
```

A viewer sees none of it: no Source tables tab, no source block, and a source table's name
nowhere in the app.

## Intent

- **Write it once, where it belongs.** Partitions, sort keys, refresh time and owner are facts
  about the warehouse table, documented once and shown in each dataset built from it.
- **Read, don't retype.** Most warehouses already hold comments, keys and partition keys.
- **Give datasets a head start.** A warehouse column comment is a ready field meaning. It becomes
  the dataset's own only when an editor accepts it.

## Goals

1. A **Source tables** tab in Data model, laid out like Datasets, for editors and admins.
2. A doc per source table: owner, refresh timing, required filters, a markdown guide.
3. **Read from warehouse** stores columns with their types and comments, keys, partition,
   cluster, sort and distribution keys, indexes, size and last change, with who read it and when.
4. A dataset built from a source table shows its doc read-only in its Guide, to editors, and gets
   the warehouse's comments and primary key as *suggestions*, never applied silently.
5. Source table names and notes reach only people who can open the connection.

## Non-goals (part 2)

- **The Assistant and MCP do not read source docs.** Facts are built per dataset with no caller
  role (`datasetFacts`, `projectFacts` in `src/ai/copilotFacts.ts`), so editor-only notes cannot go
  in safely. Accepted suggestions are ordinary dataset docs and reach the AI through part 1.
- **Listing every table a warehouse has.** The tab lists documented tables and tables a dataset is
  built from; **+ Add** picks any other one (D4).
- **Org-wide docs** (Q2), **re-reading on a schedule** (Q3), **parsing a query to find its
  tables** (D11 links them by hand), versions and Trash for source docs.
- **Reading sources with no catalog** (SaaS apps, Trino, Presto, Elasticsearch, OpenSearch, Druid):
  typed notes only.
- **Acting on a fact.** A required partition filter links to part 1's always-applied filters
  (part 1 D13); it never becomes one.

## Anti-goals (a failure even if it works)

- **A source table name in a viewer's reply or URL**, including the three replies that carry one
  today (D13).
- **A field meaning that appears without an editor's click.**
- **A warehouse query because someone opened a page.** Opening the tab reads only records.
- **Machine facts mixed into human text.** A re-read replaces the facts and never touches the guide.
- **Two copies of one note.** Datasets point at the doc; nothing is copied into a dataset.

## Approaches

**A. Docs keyed by connection and table, in their own records; facts from a new optional connector
method; datasets find their doc through their origin; one Data model tab reads it all (my
call).** One store, one place to edit, explicit reads, nothing a viewer can reach.
*Trade-off:* a new record kind, and a reader per driver family.

**B. Copy source notes into each dataset's part 1 doc.** No new store, but two copies of one note,
and the catalog is `read` (`catalog:get`, `catalog:columns`), so every reply needs trimming.

**C. Widen `describeTable`; read facts live whenever the panel opens.** Never stale, but every open
is warehouse work (Snowflake's `describeTable` queries `information_schema`, which needs a running
warehouse), and typed notes still need A's store. A wins: B breaks both rules part 2 exists for.

## Decisions

### Store

**D1. One record per documented table, plus an index per connection (my call).**
- `connections/<connId>.tables.json`: `{ table, docId, owner, hasGuide, readAt }[]`, ≤ 2,000
  entries, so the tab's list and a dataset's lookup cost one small read per connection.
- `connections/<connId>/tables/<docId>.json`: the doc. `docId` is a random UUID; the name is inside.
- Not one record per connection: one table's facts reach 4 MB at D6's caps, and a record is capped
  at 8 MiB (`OTHER_RECORD_MAX_BYTES`). Not a name hashed into a UUID: a project import remaps every
  UUID in an entry's name (`src/app/bundleImport.ts`).
- Doc first, then the index under `recordFs.locked`: a crash leaves an unlisted doc, never a
  dangling entry. Saves carry the edit-conflict `base`; a stale one is refused 409.
- `listConnections` reads only `<uuid>.json`, so it skips both. `deleteConnection` (today one `rm`)
  removes them; `ENTRY_RULES` (`src/app/bundleRules.ts`) lets them travel in a bundle.
- **No in-memory cache (my call):** records read per request, the same on any pod.

```ts
interface SourceTableDoc {
  table: string;            // exactly as listTables names it, ≤ 1,000 (the contracts' `Table` cap)
  owner: string;            // ≤ 80, free text like RecordDoc.owner
  refresh: string;          // ≤ 200, "Hourly at :15, by the orders_hourly job"
  requiredFilters: string;  // ≤ 500
  guide: string;            // markdown, ≤ 8,000
  facts?: TableFacts & { readAt: string; readBy: string };
  updatedBy: string; updatedAt: string; schemaVersion: 1;
}
```

**D2. The key is the table name exactly as `listTables` reports it.** The workbench imports a tree
table under that name (`qualify` in `web/src/features/connections/api.ts` → `origin.table`), so a
tree-imported dataset matches as is. Never case-folded: Oracle and Snowflake keep unquoted names in
upper case, and a quoted lower-case twin can exist (`describeTable` in `src/connectors/oracle.ts`).

### The Source tables tab

**D3. Same layout as Datasets, editors and admins only.** The tab is drawn only when
`useCanEdit(projectId)` (`web/src/features/projects/api.ts`) says so, which stays false until the
roles are known, so a viewer never sees it flash. The server is the real gate (D14). A viewer who
types its address lands on Datasets.

**D4. The list reads records only, never the warehouse.** Per connection, it is the union of the
index (D1) and the tables datasets are built from (D9). A used table with no doc shows with a ⚠.
**+ Add** opens a picker filled by the existing `connection:listTables`: a warehouse call, on a
click. Picking a table creates its empty doc.

**D5. The strip and the panel.**
- **To fill in next**, built on the server from the docs and origins, at most four chips, then
  "+N more", hidden when nothing is missing (part 1's rule): a dataset is built from it but it has
  no doc; never read; no owner; no guide; read over 30 days ago.
- **Overview**: connection, `schema.table`, owner, refresh, required filters, primary key,
  partition, sort, cluster and distribution keys, row estimate and size where the warehouse gives
  them, when the facts were read and by whom, **Built from it** (D9's datasets, linking to Datasets).
- **Columns**: name, warehouse type, comment, key mark, from the stored facts. Never read: a
  **Read from warehouse** button in place of the table.
- **Guide**: the markdown guide, rendered by part 1's renderer, with who edited it last.
- **Lineage**: D10.
- **No table name in a URL (my call).** Routes carry `connId` and `docId`, never the name, so a
  link an editor pastes to a viewer names nothing. A used table with no doc is picked in-page.
  **Document in Data model ↗** on Connections creates the empty doc first, so its link has a `docId`.

### Reading from the warehouse

**D6. A new optional method, `tableFacts?(ctx, table)` on `ConnectorDef`**, beside `describeTable`,
never a second kind of connector. The catalog gets a `readsFacts` flag like `browsable`
(`src/connectors/index.ts`). It is per connector, not per Live dialect: plain PostgreSQL also uses
the `redshift` dialect (`src/connectors/postgres.ts`) but has no `SVV_TABLE_INFO`. One read runs
`describeTable` where it exists (columns and types; a row estimate from PostgreSQL, MySQL, SQL
Server, Oracle, Snowflake and BigQuery today) and `tableFacts` where it exists, and stores the merge.

```ts
interface TableFacts {
  comment?: string;                                // ≤ 2,000, the catalog's description cap
  columns: { name: string; type: string; nullable?: boolean; comment?: string; key?: true }[];  // ≤ 2,000
  primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean };
  clusterBy?: string[]; sortKey?: string[];
  distribution?: { style: string; columns: string[] };
  indexes?: { name: string; columns: string[]; unique: boolean; kind?: string }[];  // ≤ 50
  rowEstimate?: number; bytes?: number; lastModified?: string;  // the warehouse's own figures
}
```

**D7. What each connector reads.** From vendor documentation; none has run against a real engine
here yet. Each reader is a short ladder like Redshift's `listTables`: a sub-read that fails (a
missing permission, a view the engine lacks) costs that field, never the read.

| Connector | Comments | Keys and indexes | Partition, cluster, sort, distribution | Cost of a read |
|---|---|---|---|---|
| BigQuery | `description` on the table and each field | `tableConstraints.primaryKey` (not enforced) | `timePartitioning`/`rangePartitioning` with `requirePartitionFilter`, `clustering.fields` | None: the `tables.get` call `describeTable` already makes; today it keeps only columns and `numRows` |
| Snowflake | `SHOW TABLES` / `SHOW COLUMNS` `comment` | `SHOW PRIMARY KEYS IN TABLE` (not enforced) | `cluster_by` | `SHOW` needs no warehouse, per the docs (builder checks); `listTables` already sends `show terse tables` through the SQL API |
| PostgreSQL, AlloyDB, Neon, Supabase, Timescale | `obj_description`, `col_description` | `pg_index` (primary key, unique, method) | `pg_get_partkeydef` | Catalog reads, no table scan |
| Amazon Redshift | the same | the same | `SVV_TABLE_INFO` `diststyle`, `sortkey1` | The same; that view leaves out empty tables |
| CockroachDB, YugabyteDB, Materialize, QuestDB, RisingWave | try the Postgres reads | the same | none | Keep what answers, UNVERIFIED like their `listTables` |
| MySQL, MariaDB, Aurora, TiDB, SingleStore, StarRocks, Doris, PlanetScale | `TABLE_COMMENT`, `COLUMN_COMMENT` | `information_schema.statistics` | `information_schema.partitions` | Catalog reads; a plan that hides `information_schema` reads nothing |
| SQL Server, Azure SQL, Synapse | `sys.extended_properties` `MS_Description` | `sys.indexes`, `sys.index_columns` | Synapse: `sys.pdw_table_distribution_properties` | Catalog reads |
| Oracle, Oracle Autonomous | `ALL_TAB_COMMENTS`, `ALL_COL_COMMENTS` | `ALL_CONSTRAINTS`, `ALL_IND_COLUMNS` | `ALL_PART_KEY_COLUMNS` | Catalog reads |
| ClickHouse | `system.tables`, `system.columns` `comment` | `primary_key` | `partition_key`, `sorting_key` | Metadata reads; the Live sample already asks `system.tables` (`compileSamplingKeyProbe`, `src/engine/live/profileSql.ts`) |
| Databricks SQL | `information_schema` `comment` | `table_constraints` (informational) | `DESCRIBE DETAIL` partition and clustering columns | **Runs on the SQL warehouse and can start it**; the button says so |

ClickHouse and Databricks have no `describeTable` today (`src/connectors/http.ts`), so their
`tableFacts` also returns the columns and types.

**D8. Every read is bounded, read-only and guarded.**
- One new door, `connectionRun.tableFacts`, built like `connectionRun.describeTable`: `guardHost`
  (the SSRF guard; BigQuery and Snowflake pin their own fixed hosts, the HTTP family its typed one),
  `buildContext`'s 30 s and row clamps, `safeError` on every failure, a limit on every statement,
  the table name bound or whitelisted and quoted as each `describeTable` does today.
- **Only on an editor's click** (`sourceTable:read`), never on view, refresh or schedule.
- **At most 60 reads per connection per hour per org (my call)**, across pods, by `counters.take`
  (`src/server/counters.ts`). Past it: a sentence with the wait.
- **Not a Live statement.** There is no Live dataset to target, so it does not take `warehouse()`
  and is not counted in `live_usage`, like `connection:describe` and the Live schema sync's column
  read (`readLiveSchema` → `connectionRun.describeTable`) today. `test-liveUsage` still proves
  `runLiveBound` has one caller.
- The result is stored with `readAt` and `readBy`; nothing asks the warehouse again until a click.

### Datasets and lineage

**D9. How a dataset knows its source table:** only from its origin, on the server.

| Origin | Source table |
|---|---|
| `connection` with `table`: a copy, a Live view, or "Make a copy" of one (`copyLiveDataset` keeps the origin) | That table on that connection, by exact name |
| `connection` with `sql` (a query on the connection) | None until an editor links tables: a new `readsTables: string[]` (≤ 16) on the origin |
| `connection` with neither (saved before the workbench) | The connection's own saved `table`, the fallback a refresh uses (`runSaved`) |
| `file`, `url`, `capture`, or none (paste, input tables) | None |
| `combined`, `composed`, `sql` (a query over datasets), `notebook` | None in part 2 (my call): the Lineage tab shows the parents |

**D10. Lineage per source table.** Today the graph has one source node per *connection*
(`source:conn:<connId>`), and `add` keeps the first node per id, so its `sub` names whichever table
came first (`src/analysis/lineage.ts`). The tab's Lineage is a new editor-only read,
`sourceTable:lineage`, built from the same `buildGraph` input with one node per (connection,
table), rooted at the picked table and drawn with `focus` and part 1's inline `Graph`. Node ids
carry no table name, as `redactSources` does for files and web addresses. `lineage:get`, which
viewers call, keeps its per-connection node and gets only D13's trim.

**D11. `readsTables` is a label on the origin.** It wins over `table` when set, so an editor can also
fix an unqualified name. Neither a refresh (`selectionForDataset`) nor the Live target
(`liveTarget`) reads it; `sanitizeOrigin` whitelists it like `queryId`. The link picker lists first
the tables whose name appears as a word in the query: a sort order, never a link. It lives on the
origin because that is the one dataset field no browser gets: `dataset:source` redacts it, and
summaries carry only `originConnId` (`src/data/datasetSummary.ts`). The part 1 catalog is `read`.

**D12. Suggestions, never silent.**
- `catalog:suggestions` lists, per dataset: a column comment where the column of the **same exact
  name** has no meaning; the table comment where the dataset has no description; a single-column
  primary key where the dataset has that column and no part 1 key.
- **Use** writes through `catalog:setColumn`, `catalog:set` or part 1's key save, whose key check
  (part 1 D2) runs even for an enforced key: the copy may differ.
- **Dismiss** stores a short hash of the text, never the text (viewers read `catalog:columns`). A
  changed comment is offered again. Renamed columns, and a name two linked tables share with
  different comments, get none. Composite keys stay a fact (a part 1 non-goal).
- For editors, the Datasets tab's strip gains one chip, "N suggested meanings".

### Visibility and security

**D13. Source names and notes are for project editors and admins**: the `write` access every
workbench channel already needs to open a connection (`src/api/connections.ts`). A viewer is
`callerOn(projectId).restricted` (`src/server/authz/caller.ts`). Today three `read` replies give
viewers source names. PR 1 closes them; an editor's reply stays byte-identical.

| Reply | A viewer gets today | After |
|---|---|---|
| `dataset:source` | "Connection · Warehouse · ANALYTICS.ORDERS" (`sourceView`, `src/data/datasetOrigin.ts`) | "Connection · Warehouse" |
| `lineage:get` | source node `sub: "Table ANALYTICS.ORDERS"` (`src/analysis/lineage.ts`) | the connector's kind |
| `connections:list` | `publicConnection`: host, database, user, `table`, `query`, saved queries' SQL | id, name, connector, status, dataset count |

**D14. Every new channel is `write`, project-scoped, with a zod input:** `sourceTable:list` (the
tab's list and strip), `:get` (Overview, Columns, Guide), `:save`, `:delete`, `:read`, `:lineage`,
`:forDataset` (the dataset Guide's block), `catalog:suggestions`, `dataset:setSourceTables`. So a
viewer's call is refused 403 before a handler runs. None is `read`, so none joins
`scripts/rowPolicyReaders.ts`. None returns rows: facts are metadata, and an editor is never under
a row lock. Replies are rebuilt key by key, like `publicConnection`.

**D15. Secrets.** Loaded in main by `loadSecrets`, as every workbench handler does; nothing new is
stored. A failed read gives the editor the `safeError` text, as `connection:describe` does.

## Constraints (from the repo's rules)

- **No dataset origin reaches a browser**: D13 makes it true for the three replies that break it.
- **Every socket through the SSRF guard**, via `connectionRun`; never a driver called directly.
- **Read-only and bounded**: the drivers' read-only sessions stay; every statement is limited.
- **Live**: no rows on our side, no `getDataset` on a new path, no new row-reading channel.
- **Contracts**: `src/api/index.ts`, `routes.tsx` and `nav.ts` append-only (the tab is a tab of
  `/model`, no new nav line); `check-contracts` 0 unresolved.
- **Records** through `recordFs`, writes `locked`, corrupt docs skipped. Sentences via `t()`. No
  new dependency. **UI**: the house polish bar, real empty states, mockups before building.
- **File size**: `src/ipc/connections.ts` (503 lines), `postgres.ts` (737), `mssql.ts` (732) and
  `http.ts` (744) take no readers; each family's reader is its own file.

## Tests that prove it

Part 2 computes no figure, so there is no second implementation to hold to `Object.is`. Every
guard gets a negative control instead.

- **Readers**, in each family's suite (`test-connectorsPostgres`, `-Mysql`, `-Mssql`, `-Oracle`,
  `-Snowflake`, `-Bigquery`, `-Http`): a hostile name (`x"; drop table y; --`) is bound or refused
  before a socket opens; every statement is limited; a failing sub-read keeps the rest; BigQuery
  makes one GET. Postgres also runs for real in the `-db` gate (`COMMENT ON`, a key, a partition).
- **SSRF:** a host that resolves privately is refused before any socket; `SSRF_ALLOW` lets it
  through. **Secrets canary:** a fake connector's error and comment hold the password; no reply or
  log line does.
- **Viewers:** with `canary_tbl_9f3` as a table and in saved SQL, the three D13 replies never
  contain it for a viewer and are byte-identical for an editor; removing the trim fails the test.
  Every `sourceTable:*` channel, `catalog:suggestions` and `dataset:setSourceTables` answers a
  viewer 403. Vitest and Playwright as a viewer: Data model has no Source tables tab, its address
  lands on Datasets, and the Guide has no source block. As an editor the tab is there (the control).
- **No warehouse on view:** opening the tab, its list, strip, panel and Lineage makes zero
  connector calls (a counting fake driver); **+ Add** and **Read again** make them.
- **No name in a URL:** Playwright walks the tab and the Connections link, and no URL holds the
  table's name.
- **Lineage:** two tables on one connection are two nodes in `sourceTable:lineage`, each leading to
  its own datasets, metrics and charts; node ids hold no table name; `lineage:get` is unchanged
  for an editor.
- **Never silent:** the dataset's catalog is byte-identical after a read until **Use**; a planted
  auto-apply fails; dismissals stick; a changed comment returns; ambiguous columns get none.
- **Resolution and store:** every row of D9; a Live view and its copy show one doc;
  `test-dataset-origin` caps `readsTables` and `sourceView` never prints it; a crash between doc and
  index leaves an unlisted doc; a stale save gets 409; a bundle round trip keeps every lookup.
- **Limits:** the 61st read in an hour is refused across two pods; `live_usage` is unchanged by a
  read; `getDataset` is never called (a spy).
- **Web:** Vitest for the panel's states (empty, never read, read, stale, failed, not readable);
  Playwright on the fake warehouse (`scripts/liveFakeConnector.ts`) with a reader over DuckDB's own
  comments; light and dark screens.

## Build order (chained PRs)

1. **Close the viewer leaks** (D13). Needs nothing else; ships first.
2. The store and contracts (D1, D2, D14): save with `base`, delete with the connection, bundle
   rules. No warehouse reads yet.
3. `tableFacts`, `connectionRun.tableFacts`, `sourceTable:read`, the rate limit; BigQuery and the
   Postgres family with Redshift.
4. Snowflake, MySQL, SQL Server and Synapse, Oracle.
5. ClickHouse, Databricks, and the fake warehouse's reader.
6. **The Source tables tab** (D3–D5, mockups first): list, strip, Overview, Columns, Guide; the
   **Document in Data model ↗** links on Connections.
7. D9–D10: resolution, `sourceTable:lineage` and the tab's Lineage, `dataset:setSourceTables`, the
   dataset Guide's **From the source table**.
8. Suggestions (D12) in the Datasets tab's Fields and strip.

## Dependencies

- **On part 1:** PRs 6–8 need the Data model section (part 1's build step 10): its tab shell, the
  list-and-panel layout, the strip, the markdown Guide and the inline Lineage `Graph`. PR 8 also
  needs `TableDoc.key` with its key check (part 1 D1, D2). PRs 1–5 need nothing from part 1.
- **Later parts:** part 3 adds the Assistant tab and decides whether an editor's SQL help reads
  source notes; part 4 may make the owner a person; part 6 may move Views to a header picker,
  which changes nothing here; part 7 maps dbt `sources:` (descriptions, `freshness`) onto this
  store; part 8 builds column-level lineage on D10's nodes.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

**Q1. Close today's viewer leaks in PR 1?** Viewers stop seeing "Table ANALYTICS.ORDERS" in
Lineage and on the dataset's source line, and stop receiving host, database, user and saved SQL
from `connections:list`. *Recommended: yes.* Your rule is false until it ships, and the only web
caller of `connections:list` is the Connections page (`web/src/features/connections/api.ts`).

**Q2. Docs per connection, or one per warehouse table across the org?** *Recommended: per
connection.* Connections are project records; org-wide docs need org-level connections, which is
its own change. Two projects on one warehouse write two docs.

**Q3. Re-read facts only on a click?** *Recommended: yes*, with the read date shown and the strip's
"read over 30 days ago" chip. Re-reading on refresh or a schedule means surprise warehouse work on
Snowflake and Databricks, and a job to build.

## Left to the builder

- Contract, file and method names; the exact caps; the rate limit's numbers; the tab's route key.
- Snowflake: confirm on a real account that `SHOW` needs no running warehouse; if it does, read
  `information_schema` and say so on the button, as for Databricks.
- Databricks: where Unity Catalog exposes partition columns; whitelist `DESCRIBE DETAIL`'s name as
  `quotedTable` does. Synapse: how to tell a dedicated pool from Azure SQL before the `pdw` views.
- What a viewer sees on `/connections` once `connections:list` is trimmed.
- Whether `lastRefreshError` on dataset summaries shows a viewer a warehouse error naming a table
  (`relation "public.orders" does not exist`); if so, PR 1 withholds it, as `connections:list`
  already does for datasets closed to the caller.
- Whether `sourceTable:lineage` extends `buildGraph` with a per-table node or builds beside it,
  as long as `lineage:get`'s graph stays unchanged.
