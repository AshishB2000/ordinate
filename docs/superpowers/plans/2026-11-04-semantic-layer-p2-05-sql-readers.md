# Semantic layer part 2, PR 05: facts readers for Snowflake, MySQL, SQL Server and Synapse, Oracle — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** **Read from warehouse** on Snowflake, the eight MySQL-wire sources, SQL Server, Azure SQL, Azure Synapse and both Oracles stores comments, keys, indexes, partitioning, clustering and distribution, with no table scan.
**Architecture:** Four pure readers, one per family, each over PR 04's `FactsQuery`. A reader parses the name first and runs a short ladder of catalog statements, each bound and limited. A family file adds one wiring line that opens its own guarded connection. Everything above the reader is PR 04's door.
**Tech Stack:** `src/connectors/*Facts.ts`, the family suites (recording `FactsQuery`, no socket), the real-account nightly for Snowflake.
**Spec:** docs/semantic-layer/02-source-tables.md (D7 rows Snowflake, MySQL family, SQL Server family, Oracle; D8; "Left to the builder": Snowflake `SHOW`, Synapse detection) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-05-sql-readers` off `origin/develop` after PR 04 merges. One PR, in release 2. It is independent of PR 06.

## Global Constraints

- **Reader shape.** Each reader is `export function <family>TableFacts(table: string, open: OpenFacts, opts): Promise<FactsReply>` (types from `src/connectors/tableFacts.ts`, PR 04).
  - It returns `{ ok: false, error: 'Invalid table name' }` **before** calling `open` when the name fails the family's own `describeTable` parse.
  - The column read is required. Every other sub-read is in its own try/catch, and a failure costs that field.
  - It never imports its driver module, so there is no cycle with the family file.
- **Binding.** Names are bound values wherever the catalog takes one: MySQL `?`, SQL Server `@pN`, Oracle `:N`, Snowflake `INFORMATION_SCHEMA` `?`. Snowflake's `SHOW` statements take no binds, so each part must pass `IDENT_RE` (`/^[a-zA-Z_][a-zA-Z0-9_$]*$/`, `src/connectors/snowflake.ts:366`) and is double-quoted, which keeps its stored case (spec D2). The `LIKE` pattern's `_` is a wildcard, so the reader keeps the row whose `name` equals the part exactly.
- **Limits.** Every statement carries `LIMIT n` (Snowflake `SHOW … LIMIT`, MySQL), `TOP (@cap)` (SQL Server) or `FETCH FIRST :n ROWS ONLY` (Oracle). `n` is ≤ `FACTS_ROWS` (2,000) for columns and ≤ 50 for indexes.
- **Wiring lines.** `src/connectors/mssql.ts` (732 lines) gets `export` on `withConnection` and `execSql` (0 lines) plus one `tableFacts:` line in `defFor` (`:710`). `mysql.ts` (616), `oracle.ts` (624) and `snowflake.ts` (443) get the same.
- **Unverified engines say so.** Every fact here comes from vendor documentation, and none has run against a real engine yet. Each reader carries `// UNVERIFIED: <what>` beside the statement, as `listTables` does.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Snowflake `SHOW` and warehouses.** The docs say `SHOW` runs on cloud services, with no running warehouse. Task 4's nightly asserts it on the real account by reading facts with `SNOWFLAKE_WAREHOUSE` unset on the connection. If that fails, switch the reader to `INFORMATION_SCHEMA` (bound, like `describeTable`) and set `factsWake: true` on the Snowflake def, so the button warns as it does for Databricks.
- **Synapse vs Azure SQL.** Only the `azure-synapse` variant asks `SELECT SERVERPROPERTY('EngineEdition')`. The `sys.pdw_*` views run only when it answers 6 (dedicated pool). 11 (serverless) and anything else skip them. Its primary key is `NOT ENFORCED`, so `enforced: false`.
- **Oracle's case.** The verbatim name is tried first, then the upper-case one, as `describeTable` does (`src/connectors/oracle.ts:538-570`). A quoted lower-case twin wins when it exists.
- **A hidden `information_schema`.** On some MySQL hosting plans (PlanetScale), `TABLES`, `STATISTICS` and `PARTITIONS` may be refused. Those cost their fields. Only a refused `COLUMNS` read fails the read.

## Rolling deploys

No new stored shape: the facts land in PR 03's doc through PR 04's door. A pod without this PR stores `describeTable`'s columns for these connectors, the PR 04 fallback. That is less, never wrong.

---

### Task 1: MySQL family

**Files:** Create `src/connectors/mysqlFacts.ts`. Modify `src/connectors/mysql.ts:605-616` (one `tableFacts:` line, with `withConnection` and `plan.prefix` adapted into a `FactsQuery`). Test: extend `scripts/test-connectorsMysql.ts`.
**Interfaces:** Produces `mysqlTableFacts(table, open, { database: string })`. The schema is the qualifier, else the connection's database, as `describeTable` does (`mysql.ts:562-575`). Each statement binds `[name, schema]`:
1. `information_schema.COLUMNS`: `COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT, COLUMN_KEY`, ordered by `ORDINAL_POSITION`, `LIMIT 2000` (required). `COLUMN_KEY = 'PRI'` sets `key: true`.
2. `TABLES`: `TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, UPDATE_TIME`, `LIMIT 1`.
3. `STATISTICS`: `INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE`, ordered by `INDEX_NAME, SEQ_IN_INDEX`, `LIMIT 500`. These are folded into ≤ 50 indexes. `PRIMARY` becomes `primaryKey: { columns, enforced: true }`.
4. `PARTITIONS`: `PARTITION_METHOD, PARTITION_EXPRESSION` where `PARTITION_NAME IS NOT NULL`, `LIMIT 1`. The expression's backticked names become `columns`.

- [ ] **Step 1: Write the failing test.** Use a recording `FactsQuery` that answers per-statement fixtures by matching `/COLUMNS|TABLES|STATISTICS|PARTITIONS/`.
  ```ts
  const rec: { sql: string; params: unknown[] }[] = []; let opened = 0;
  const open: OpenFacts = async (read) => { opened++; return read(async (sql, params) => { rec.push({ sql, params }); return fixtureFor(sql); }); };
  ok('mysql facts: a hostile name is bound', ((r) => rec.every((x) => !/drop table/i.test(x.sql)) && rec[0].params[0] === 'x`; drop table y; --')(await mysqlTableFacts('shop.x`; drop table y; --', open, { database: 'shop' })));
  ok('mysql facts: three parts never open a connection', ((n) => opened === n)(opened, await mysqlTableFacts('a.b.c', open, { database: 'shop' })));
  ok('mysql facts: every statement is limited', rec.every((x) => /\blimit \d+\s*$/i.test(x.sql.trim())));
  ok('mysql facts: comments, key, an index, the partition', JSON.stringify([f.comment, f.columns[2].comment, f.primaryKey, f.indexes![0], f.partition]) === EXPECTED);
  ok('mysql facts: a refused STATISTICS costs only indexes', ((g) => g.ok && !('indexes' in g) && g.columns.length === 3)(await mysqlTableFacts('shop.orders', failing(/STATISTICS/), { database: 'shop' })));
  ok('every MySQL variant has tableFacts', mysqlConn.CONNECTORS.every((d) => typeof d.tableFacts === 'function'));
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect tsc's "Cannot find module '../src/connectors/mysqlFacts'".
- [ ] **Step 3: Implement.** Write the reader as specified.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsMysql.js scripts/test-file-size.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/connectors/mysqlFacts.ts src/connectors/mysql.ts scripts/test-connectorsMysql.ts`. Message: "Read comments, keys, indexes and partitions for the MySQL family".

### Task 2: SQL Server, Azure SQL, Azure Synapse

**Files:** Create `src/connectors/mssqlFacts.ts`. Modify `src/connectors/mssql.ts`: `export` on `withConnection` (`:558`) and `execSql` (`:494`), and one `tableFacts:` line in `defFor` (`:710`). The adapter binds positional params as `@p0…` (`NVarChar` for a string, `Int` for a number) through `loadTedious().TYPES`. Test: extend `scripts/test-connectorsMssql.ts`.
**Interfaces:** Produces `mssqlTableFacts(table, open, { synapse: boolean })`. Each object lookup is `OBJECT_ID(QUOTENAME(@p0) + N'.' + QUOTENAME(@p1))` (the bound-value quoting `describeTable` uses, `mssql.ts:655-662`), with a blank schema when the name is unqualified.
1. `INFORMATION_SCHEMA.COLUMNS`, `TOP (@cap)` (required).
2. `sys.extended_properties` where `name = 'MS_Description'` and `class = 1`. `minor_id` 0 is the table comment. Any other `minor_id` matches `sys.columns.column_id` and becomes that column's comment.
3. `sys.indexes` joined to `sys.index_columns` and `sys.columns`, `TOP (500)`: `is_primary_key`, `is_unique` and `type_desc` (`CLUSTERED COLUMNSTORE` and the rest go in `kind`). `partition_ordinal > 0` gives `partition: { columns, method: 'RANGE' }`.
4. `sys.dm_db_partition_stats` → `rowEstimate`, and `SUM(used_page_count) * 8192` → `bytes`. Both are often refused, without VIEW DATABASE STATE.
5. Synapse only: `SERVERPROPERTY('EngineEdition')`. When it is 6, read `sys.pdw_table_distribution_properties.distribution_policy_desc` and `sys.pdw_column_distribution_properties` (`distribution_ordinal = 1`) into `distribution: { style, columns }`. The primary key is `enforced: false`.

- [ ] **Step 1: Write the failing test.** Same recording harness as Task 1.
  ```ts
  ok('mssql facts: the name only ever as @p0/@p1', rec.every((x) => !/drop table/i.test(x.sql)) && rec.some((x) => x.params.includes('x]; drop table y; --')));
  ok('mssql facts: every statement is TOP-limited', rec.every((x) => /^\s*select\s+top\s*\(/i.test(x.sql) || /serverproperty/i.test(x.sql)));
  ok('azure sql: no pdw statement is sent', !rec.some((x) => /pdw_/i.test(x.sql)));
  ok('synapse dedicated (6): hash distribution, an informational key', JSON.stringify([s.distribution, s.primaryKey!.enforced]) === '[{"style":"HASH","columns":["customer_id"]},false]');
  ok('synapse serverless (11): no pdw read', !recSynapse11.some((x) => /pdw_/i.test(x.sql)));
  ok('mssql facts: a refused partition_stats costs only the size', ((g) => g.ok && !('rowEstimate' in g) && g.comment === 'Orders')(await mssqlTableFacts('dbo.orders', failing(/dm_db_partition_stats/), { synapse: false })));
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect "Cannot find module".
- [ ] **Step 3: Implement.** Write the reader as specified. `opts.synapse` is `v.id === 'azure-synapse'`.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsMssql.js scripts/test-file-size.js` (`mssql.ts` ≤ 735).
- [ ] **Step 5: Commit.** `git add src/connectors/mssqlFacts.ts src/connectors/mssql.ts scripts/test-connectorsMssql.ts`. Message: "Read descriptions, indexes, partitions and Synapse distribution for SQL Server".

### Task 3: Oracle and Oracle Autonomous

**Files:** Create `src/connectors/oracleFacts.ts`. Modify `src/connectors/oracle.ts`: export `withConnection` (`:383`) and `execute` (`:430`), plus one wiring line in `defFor`. Test: extend `scripts/test-connectorsOracle.ts`.
**Interfaces:** Produces `oracleTableFacts(table, open)`. It first runs the columns read with the verbatim `[name, owner]`, then retries with the upper-cased pair, and every later statement uses whichever pair answered. Each statement binds `:1` (name), `:2` (owner or NULL) and `FETCH FIRST :3 ROWS ONLY`:
1. `ALL_TAB_COLUMNS` (required).
2. `ALL_COL_COMMENTS` and `ALL_TAB_COMMENTS`.
3. `ALL_CONSTRAINTS` where `constraint_type = 'P'`, joined to `ALL_CONS_COLUMNS` and ordered by `position`. `enforced` is `status = 'ENABLED'`.
4. `ALL_INDEXES` joined to `ALL_IND_COLUMNS` (≤ 50): `uniqueness` and `index_type` → `kind`.
5. `ALL_PART_TABLES.partitioning_type` with `ALL_PART_KEY_COLUMNS` (`object_type = 'TABLE'`).
6. `ALL_TABLES`: `num_rows` → `rowEstimate`, `last_analyzed` → `lastModified`. There is no `bytes`: `ALL_SEGMENTS` does not exist, and `DBA_SEGMENTS` needs a DBA grant.

- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('oracle facts: verbatim first, then upper case', rec[0].params[0] === 'orders' && rec[1].params[0] === 'ORDERS' && rec.slice(2).every((x) => x.params[0] === 'ORDERS'));
  ok('oracle facts: every statement fetches first n rows', rec.every((x) => /fetch first :\d+ rows only\s*$/i.test(x.sql.trim())));
  ok('oracle facts: a disabled key is not enforced', JSON.stringify(f.primaryKey) === '{"columns":["LINE_ID"],"enforced":false}');
  ok('oracle facts: list partitioning', JSON.stringify(f.partition) === '{"columns":["REGION"],"method":"LIST"}');
  ok('oracle facts: a hostile name is bound', rec.every((x) => !/drop table/i.test(x.sql)));
  ```
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect "Cannot find module".
- [ ] **Step 3: Implement.** Write the reader as specified.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsOracle.js scripts/test-file-size.js` (each with `node`).
- [ ] **Step 5: Commit.** `git add src/connectors/oracleFacts.ts src/connectors/oracle.ts scripts/test-connectorsOracle.ts`. Message: "Read comments, keys, indexes and partitions for Oracle".

### Task 4: Snowflake, with the real-account check

**Files:** Create `src/connectors/snowflakeFacts.ts`. Modify:
- `src/connectors/snowflake.ts`: export `execute` (`:214`), and add one `tableFacts:` line in `CONNECTORS[0]` (`:402`).
- `scripts/warehouseLiveSnowflake.ts`: read facts for the account's first table, and once more with `warehouse` removed from the values.
- `scripts/warehouseLiveBigquery.ts`: read facts for its table, PR 04's reader.

Test: extend `scripts/test-connectorsSnowflake.ts`.
**Interfaces:** Produces `snowflakeTableFacts(table, open, { database?: string })`. The name has 1–3 parts, each passing `IDENT_RE`. With 2 parts, the schema runs against the connection's database, and with 3, against the named one. `Q` is `"` + part + `"`.
1. `SHOW COLUMNS IN TABLE Q(db).Q(schema).Q(name)` (required; `UNVERIFIED: SHOW COLUMNS takes no LIMIT` — the connector's own row cap of 2,000 bounds what is kept). It gives `column_name`. `data_type` is JSON: `FIXED` with precision and scale becomes `NUMBER(p,s)`, and the rest use their `type`, matching `describeTable`'s spelling. `null?` → `nullable`, and `comment`.
2. `SHOW TABLES LIKE '<name>' IN SCHEMA Q(db).Q(schema) LIMIT 50`. Keep the row with `name === part`. It gives `comment`, `cluster_by` (`LINEAR(A, B)` → `['A', 'B']`), `rows` → `rowEstimate` and `bytes`.
3. `SHOW PRIMARY KEYS IN TABLE … ` (UNVERIFIED limit), ordered by `key_sequence`. It gives `primaryKey: { enforced: false }`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('snowflake facts: a name failing the whitelist never opens', ((n) => opened === n)(opened, await snowflakeTableFacts('A.B"; DROP TABLE X; --', open, {})));
  ok('snowflake facts: parts quoted as stored', rec[0].sql === 'SHOW COLUMNS IN TABLE "ANALYTICS"."PUBLIC"."orders"');
  ok('snowflake facts: a LIKE look-alike is not the table', f.comment === 'The real one'); // SHOW TABLES answered ORDERS_X and ORDERS for 'ORDERS'
  ok('snowflake facts: clustering and an informational key', JSON.stringify([f.clusterBy, f.primaryKey]) === '[["ORDER_DATE","REGION"],{"columns":["LINE_ID"],"enforced":false}]');
  ok('snowflake facts: SHOW TABLES is limited', rec.find((x) => /^SHOW TABLES/.test(x.sql))!.sql.endsWith('LIMIT 50'));
  ```
  In `warehouseLiveSnowflake.ts`, run `readTableFacts('snowflake', { ...values, warehouse: '' }, secrets, table)`. It answers `ok` with ≥ 1 column; if not, the nightly fails with "SHOW needed a warehouse: switch the reader to INFORMATION_SCHEMA and set factsWake". Also run the SECRET CANARY grep over its reply, as the suite does for every other call.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:ts`. Expect "Cannot find module".
- [ ] **Step 3: Implement.** Write the reader as specified.
- [ ] **Step 4: Run it to see it pass.** Run `node scripts/test-connectorsSnowflake.js scripts/test-connectorsSnowflakeHttp.js scripts/test-warehouseLive.js` (the last one skips without credentials), `node scripts/test-liveUsage.js` and `npm run lint`.
- [ ] **Step 5: Commit.** `git add src/connectors/snowflakeFacts.ts src/connectors/snowflake.ts scripts/test-connectorsSnowflake.ts scripts/warehouseLiveSnowflake.ts scripts/warehouseLiveBigquery.ts`. Message: "Read Snowflake comments, clustering and keys with SHOW, and check both warehouses nightly".

## Existing tests that must stay green

`test-connectors`, `test-connectorsMysql`, `test-connectorsMssql`, `test-connectorsOracle`, `test-connectorsSnowflake`, `test-connectorsSnowflakeHttp`, `test-connectorsWire`, `test-liveConnectors`, `test-liveUsage`, `test-tableFacts`, `test-warehouseLive` (skips without credentials), `test-file-size`, `check-contracts`.
