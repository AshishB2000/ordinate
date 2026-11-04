# Semantic layer part 2, PR 06: facts readers for ClickHouse and Databricks — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClickHouse and Databricks SQL tables can be read from the warehouse: columns, types, comments, keys, partitions, sort and clustering, size. Neither connector has `describeTable` today, so these readers also supply the columns. Databricks says first that a read runs on its SQL warehouse and can start it.
**Architecture:** One file, `src/connectors/httpFacts.ts`, holds two readers over PR 04's `FactsQuery`. Their adapters send each statement through the HTTP family's existing **bound** request builders (`clickhouseRunBound`, `databricksRunBound` in `src/connectors/liveHttp.ts`). Values are always parameters, and the transport is the family's SSRF-checked one. `factsWake: true` on the Databricks def reaches the tab through `sourceTable:list`.
**Tech Stack:** `src/connectors`, a new suite `scripts/test-connectorsHttpFacts.ts` (`test-connectorsHttp.ts` is allowlisted at 880 lines and cannot grow).
**Spec:** docs/semantic-layer/02-source-tables.md (D7 rows ClickHouse and Databricks, the note under D7, D8; "Left to the builder": Databricks partitions and `DESCRIBE DETAIL`) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-06-http-readers` off `origin/develop` after PR 04 merges (not after 05). One PR, in release 2.

## Global Constraints

- **Do not call `.runBound(`.** `scripts/test-liveUsage.ts:367-372` fails when `.runBound(` appears outside `src/connectors/liveRun.ts`. The adapters call the module functions `clickhouseRunBound(ctx, sql, params)` (make it `export` at `liveHttp.ts:83`, 0 lines) and `databricksRunBound(ctx, sql, params)` (already exported, `:157`). They are not a Live statement: no `warehouse()`, and nothing in `live_usage`.
- **Binding.** ClickHouse uses `{p0:String}` and Databricks `:p0`, with values as `LiveParam { name: 'p<i>', type: 'text' | 'number', value }`. Two spots take an identifier instead: Databricks' `DESCRIBE DETAIL` and an explicit catalog prefix. Each part there must pass `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and is wrapped in backticks. A name with more than 3 parts, or any failing part, is refused before `open`.
- **Limits.** Every `SELECT` ends in `LIMIT n`. `DESCRIBE DETAIL` takes no `LIMIT` and returns one row: say so in a comment, and the row cap (2,000) still bounds it.
- `src/connectors/http.ts` (744 lines) gets 3 lines at most: two `tableFacts:` lines and `factsWake: true` on `databricks-sql` (`:637-653`).
- Every fact here is from vendor docs (`// UNVERIFIED`). No real-account nightly exists for these two.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Databricks can start a stopped SQL warehouse.** `factsWake: true` must reach `sourceTable:list` → `connections[].factsWake`, so PR 07 can put the warning on the button. Task 2 asserts the reply.
- **ClickHouse's primary key is not unique.** It is the sparse index's prefix, so `enforced: false`. `primary_key`, `sorting_key` and `partition_key` are expressions: `sortKey` and `primaryKey.columns` come from `system.columns`' `is_in_*` flags, not by parsing the expression. `partition.method` keeps the expression text, `toYYYYMM(order_date)`.
- **The ratchet.** Run `test-liveUsage` after the change.

## Rolling deploys

No new stored shape. Before this PR these two connectors are `readsFacts: false` (neither method), so the tab shows "write the notes by hand". After it, they can be read.

---

### Task 1: ClickHouse

**Files:** Create `src/connectors/httpFacts.ts`, `scripts/test-connectorsHttpFacts.ts`. Modify `src/connectors/liveHttp.ts:83` (`export`), `src/connectors/http.ts:616-635` (the `clickhouse` def gains `tableFacts: (ctx, t) => clickhouseTableFacts(t, (read) => read(chQuery(ctx)), { database: str(ctx, 'database', 'default') })`).
**Interfaces:** Produces `export function clickhouseTableFacts(table: string, open: OpenFacts, opts: { database: string }): Promise<FactsReply>` and `export const chQuery = (ctx: ConnectorContext): FactsQuery`. `chQuery` maps rows out of `clickhouseRunBound`'s `ConnectorRows`, and a `ConnectorError` is thrown, so it surfaces as the reader's failure. The name is `db.table` or `table` (in `opts.database`).
1. `SELECT name, type, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key FROM system.columns WHERE database = {p0:String} AND table = {p1:String} ORDER BY position LIMIT 2000` (required).
2. `SELECT comment, engine, partition_key, total_rows, total_bytes, metadata_modification_time FROM system.tables WHERE database = {p0:String} AND name = {p1:String} LIMIT 1`.

This gives `primaryKey: { columns: is_in_primary_key, enforced: false }`, `sortKey` (`is_in_sorting_key`) and `partition: { columns: is_in_partition_key, method: partition_key }`. `total_rows` → `rowEstimate`, `total_bytes` → `bytes`, and `metadata_modification_time` (UTC) → `lastModified`.

- [ ] **Step 1: Write the failing test.** Use the recording `FactsQuery` harness from PR 05.
  ```ts
  ok('clickhouse facts: names are parameters', rec.every((x) => /\{p0:String\}/.test(x.sql) && !x.sql.includes('orders')) && JSON.stringify(rec[0].params) === '["shop","orders"]');
  ok('clickhouse facts: every statement is limited', rec.every((x) => /\bLIMIT \d+$/.test(x.sql.trim())));
  ok('clickhouse facts: key from the flags, not enforced; sort and partition', JSON.stringify([f.primaryKey, f.sortKey, f.partition]) === '[{"columns":["order_date"],"enforced":false},["order_date","region"],{"columns":["order_date"],"method":"toYYYYMM(order_date)"}]');
  ok('clickhouse facts: four parts never open', ((n) => opened === n)(opened, await clickhouseTableFacts('a.b.c.d', open, { database: 'default' })));
  ok('clickhouse facts: a refused system.tables keeps the columns', ((g) => g.ok && g.columns.length === 3 && !('rowEstimate' in g))(await clickhouseTableFacts('shop.orders', failing(/system\.tables/), { database: 'default' })));
  ok('clickhouse def: tableFacts wired, still not browsable', typeof ch.tableFacts === 'function' && typeof ch.describeTable !== 'function');
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect "Cannot find module '../src/connectors/httpFacts'".
- [ ] **Step 3: Implement.** Write the reader as specified.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsHttpFacts.js scripts/test-connectorsHttp.js scripts/test-liveUsage.js scripts/test-file-size.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/connectors/httpFacts.ts src/connectors/liveHttp.ts src/connectors/http.ts scripts/test-connectorsHttpFacts.ts`. Message: "Read ClickHouse comments, keys, sort and partition keys from its system tables".

### Task 2: Databricks SQL

**Files:** Modify `src/connectors/httpFacts.ts` (+`databricksTableFacts`, `dbxQuery`), `src/connectors/http.ts:637-653` (`tableFacts:` and `factsWake: true`). Test: extend `scripts/test-connectorsHttpFacts.ts` and `scripts/test-sourceTables.ts` (the list reply).
**Interfaces:** Produces `export function databricksTableFacts(table: string, open: OpenFacts, opts: { catalog?: string; schema?: string }): Promise<FactsReply>`. The name has 1–3 parts: `catalog.schema.table`, `schema.table` in the connection's catalog, or `table` in its schema. `IS` is `` `<catalog>`.information_schema `` when there is a catalog, else `information_schema`.
1. `SELECT column_name, full_data_type, is_nullable, comment FROM IS.columns WHERE table_schema = :p0 AND table_name = :p1 ORDER BY ordinal_position LIMIT 2000` (required).
2. `SELECT comment, last_altered FROM IS.tables WHERE table_schema = :p0 AND table_name = :p1 LIMIT 1`.
3. `SELECT k.column_name FROM IS.table_constraints t JOIN IS.key_column_usage k ON … WHERE t.constraint_type = 'PRIMARY KEY' AND t.table_schema = :p0 AND t.table_name = :p1 ORDER BY k.ordinal_position LIMIT 32`. Unity Catalog keys are informational, so `enforced: false`.
4. ``DESCRIBE DETAIL `catalog`.`schema`.`table` `` (Delta only; a view or a non-Delta table fails here and costs only this field). It gives `partitionColumns` → `partition: { columns, method: 'IDENTITY' }`, `clusteringColumns` → `clusterBy`, `sizeInBytes` → `bytes` and `lastModified`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('databricks facts: catalog whitelisted and backticked, names bound', rec[0].sql.startsWith('SELECT column_name') && rec[0].sql.includes('`main`.information_schema.columns') && JSON.stringify(rec[0].params) === '["sales","orders"]');
  ok('databricks facts: DESCRIBE DETAIL names a whitelisted, quoted path', rec.find((x) => x.sql.startsWith('DESCRIBE DETAIL'))!.sql === 'DESCRIBE DETAIL `main`.`sales`.`orders`');
  ok('databricks facts: a part failing the whitelist never opens', ((n) => opened === n)(opened, await databricksTableFacts('main.sales.or`ders', open, {})));
  ok('databricks facts: partition, clustering, informational key', JSON.stringify([f.partition, f.clusterBy, f.primaryKey]) === '[{"columns":["order_date"],"method":"IDENTITY"},["region"],{"columns":["line_id"],"enforced":false}]');
  ok('databricks facts: a view (DESCRIBE DETAIL fails) keeps the rest', ((g) => g.ok && g.columns.length === 3 && !('partition' in g))(await databricksTableFacts('main.sales.v', failing(/^DESCRIBE DETAIL/), {})));
  ok('the list says reading wakes the warehouse', (await post('sourceTable:list', { projectId: P })).value.connections.find((c: Reply) => c.connectorId === 'databricks-sql').factsWake === true);
  ```
  The last assert needs a Databricks connection with one doc in `test-sourceTables.ts`. It is saved with `connections.saveConnection` and never contacted.
- [ ] **Step 2: Run it to see it fail.** Run `node scripts/test-connectorsHttpFacts.js`. Expect "databricksTableFacts is not a function".
- [ ] **Step 3: Implement.** Write the reader as specified.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsHttpFacts.js scripts/test-connectorsHttp.js scripts/test-sourceTables.js scripts/test-liveUsage.js scripts/test-file-size.js` (each with `node`), then `npm run lint`.
- [ ] **Step 5: Commit.** `git add src/connectors/httpFacts.ts src/connectors/http.ts scripts/test-connectorsHttpFacts.ts scripts/test-sourceTables.ts`. Message: "Read Databricks comments, keys and Delta partitions, and say a read can start the warehouse".

## Existing tests that must stay green

`test-connectors`, `test-connectorsHttp`, `test-liveConnectors`, `test-liveUsage`, `test-tableFacts`, `test-sourceTables`, `test-file-size`, `check-contracts`.
