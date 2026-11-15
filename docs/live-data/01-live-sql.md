# SQL on Live datasets and source tables — design (Assistant phase F)

Phase F of the [Assistant design](../assistant/00-design.md#build-order). Phase B's SQL lane answers
what one chart can't say ("bought in January but not February", "days between orders") with one
DuckDB statement over copied datasets, and refuses a Live dataset (`requireExtract`) and any dataset
under row rules or hiding a column from the caller (`gateRows`). This note makes the same lane answer
from Live datasets and, for editors, from source tables, with the caller's row rules, hidden columns
and cost limits applied **in the warehouse**.

The rules from `AGENTS.md` hold: the warehouse computes every figure; a Live dataset has no rows on
our side; values are bind parameters; input never becomes code; every socket goes through the SSRF
guard; no SQL text, table name or host reaches a browser.

Builds on [Live data](00-plan.md) and its [log](log.md) (D4, D6, D7, the executor, `warehouse()`,
`liveBudget`, the parity suites), [row access rules](../row-policy/00-design.md) (D7, D12, D13),
[team folders](../team-folders/00-design.md) (the storage net, connection tables, E8) and
[source tables](../semantic-layer/02-source-tables.md). Measured on nothing yet: every number below
is a constant in the code at `edf47c9b`, with phase B (`d17259d1`, `feat/answer-sql-lane`) and phase
D (`c3ec0bef`, `feat/explore-source-tables`) read from their branches.

## What you will see

- **An editor** asks "average days between a customer's orders" with Orders Live on Snowflake. The
  card is phase B's: **Not checked · SQL written by the AI**, the table, **Show SQL**, **Verify**,
  plus *Live · 2:05 AM*. Show SQL shows the DuckDB statement the AI wrote, which names only
  `orders`. The statement Snowflake ran (table name, defining query) never leaves the server.
- **A viewer** whose rule gives them region East asks the same question. Snowflake computes it over
  East's rows only; their card is identical in shape, with no sign of other regions.
- **The same viewer**, where Orders hides `cost` from their team: the AI is never told `cost`
  exists, the warehouse is never asked for it, and a statement naming it gets the column gate's
  refusal, as a chart naming it does.
- **On BigQuery**, a statement that would read too much is refused before it runs, in the
  connector's own sentence (*Refused before running: this query would process 14.2 GB, over this
  connection's limit of 10 GB billed per query.*). Nothing is billed.
- **A statement the gate can't carry** to a warehouse (`WITH RECURSIVE`, `regexp_matches`, a table
  from two connections) says so in one sentence, never a partial table.
- **An editor** asks about `ANALYTICS.RETURNS`, a documented table with no dataset: the same lane
  answers from the table (phase D's in-memory view). **Verify** asks to keep it as a dataset first.

## The recommendation: DuckDB SQL in, Ordinate's SQL out

The model keeps writing **DuckDB SQL**, as in phase B. DuckDB's own parser reads it
(`json_serialize_sql`, parse only, in the caller's locked org worker, exactly as `astGate` does), and
a new pure translator turns that tree into a **closed relational IR**: an allow-list of node types,
node keys and functions, every name resolved, every literal a bind parameter. Ordinate then prints
the IR per dialect through `SqlDialect` (`src/engine/live/dialect.ts`), with each table read as a
**view CTE** Ordinate writes from the record: only the caller's visible columns, under their lock,
the base filters, the calcs. **No byte the model wrote reaches the warehouse**: only identifiers
from the record (through `ident()`), keywords, punctuation and placeholders.

```
model text ─► DuckDB parse (json_serialize_sql) ─► tree ─► translate (allow-list, resolve, bind) ─► LiveSqlIR
                                                                                                      │
  per table read: liveTarget + withLockOf (lock, hidden) ─► view CTE (visible columns, lock, base, calcs)
                                                                                                      │
                     print (dialect, ParamSink) ─► cache/flight (orgKey) ─► warehouse() ─► rows ─► card
```

### The options weighed

| Option | Verdict |
|---|---|
| (a) DuckDB parses and re-prints; send the text if it is in a subset every dialect reads identically | **Rejected.** The same text means different things per engine. A backslash escapes in a string literal on BigQuery, Snowflake and ClickHouse and not in DuckDB or Postgres, so `'\'` is a whole literal to DuckDB and an open one to BigQuery, and whatever follows is code there. A double-quoted name is a string literal on Databricks: `SELECT "amount"` returns the word *amount* on every row, a silent wrong figure. `#` starts a comment on BigQuery and is a positional reference in DuckDB; nested block comments and `$$` quoting are each read by some of the six and not others. A subset proven identical everywhere is a grammar Ordinate owns anyway: (b), without the guarantee that nothing else is sent. |
| (b) A restricted IR, compiled per dialect, like the chart form's compiler | **Taken, with DuckDB SQL as its front end.** Nothing the model wrote is sent. Values are parameters (D4), identifiers come from the record, functions from a table. |
| (b′) The model writes that IR as JSON | **Rejected.** Models write SQL far better than a bespoke tree; phase B's prompt, its verified questions and its tests are DuckDB SQL; and the DuckDB front end gives the differential its reference for free (below). The IR is internal. |
| (c) Pull a bounded, locked, visible-column extract into DuckDB and run the statement there | **Rejected.** It respects D6 to the letter (we would have the rows) and breaks it in spirit: a per-question copy of every column read, held in the org worker, for data an owner made Live so it stays in the warehouse. It is wrong or refused past the cap: `LIVE_ROW_LIMIT` is 100,000, and the tables people make Live are bigger, so a truncated pull is a wrong figure and a refused one is most questions. It bills a full scan of each pulled column per question on BigQuery, before any filter the statement had. **Make a copy** (`dataset:copyLive`) is the honest version and exists. |
| (d) Send the text as is, relying on the warehouse role and a deny-list | **Rejected.** Every parser differential above stays open, a new warehouse function ships every month (Snowflake Cortex, BigQuery `AI.*`), and a deny-list fails open on the one it lacks. |
| (e) A transpiler (sqlglot or similar) | **Rejected.** A runtime dependency (Python), and a transpiler is built for fidelity, not as a boundary: it passes through what it does not understand. |
| (f) Run as the viewer (per-user OAuth, the warehouse's own row security) | **Not now** (L4 in the plan). It needs per-user warehouse identity, does not remove the need for the gate (cost, side effects), and Ordinate's row rules and hidden columns are Ordinate's, not the warehouse's. |
| (g) Secure views created per caller in the warehouse | **Rejected.** Needs DDL rights; the connection role is read-only by design. |

## Decisions

| # | Decision | Why |
|---|---|---|
| F-D1 | **The model writes DuckDB SQL; DuckDB parses it; the translator compiles the tree.** One parser, so no parser differential at the front: what DuckDB understood is what is printed. | (a) and (b′) above. |
| F-D2 | **The allow-list covers node types, node keys and functions.** A node type, a key with a non-default value, or a function the translator does not read is refused. A BASE_TABLE with an `at_clause` or a `sample`, a `SETTINGS`-like key a DuckDB upgrade adds: refused. A census test runs the corpus and fails when DuckDB emits a key the translator has not classified. | An allow-list fails closed; a DuckDB upgrade cannot widen it silently. |
| F-D3 | **Names resolve to records, and only generated names are printed outside the views.** A table name must be a slug the second call was given (a Live dataset or a source table view); a schema- or catalog-qualified name is refused, as `astRelationError` refuses one. A column resolves against the view's visible columns or a CTE's outputs, case-insensitively, ambiguity refused. The printer writes views as `v0…`, their columns as `c0…`, CTEs `q0…`, outputs `o_0…`, every reference qualified. | The warehouse's search path, case folding (Snowflake upper-cases, BigQuery ignores case) and ClickHouse's alias-before-column rule cannot change a reference's meaning, and a model alias is never text. |
| F-D4 | **Every literal is a bind parameter** through `ParamSink` (the marker scheme of `sqlParams.ts`), typed from context (a literal compared with a date column binds as `date`). Integers the grammar needs as text (`LIMIT`, frame bounds `ROWS 3 PRECEDING`) go through `sqlInt`; a date unit is a keyword from the allow-list. `current_date` binds today's UTC date from the app's clock. | D4, R-L1. No engine binds a LIMIT or a frame bound; "today" must be the same day in the warehouse and in the reference. |
| F-D5 | **One number type, DOUBLE.** Number columns are `number()` in the view, every aggregate and every number parameter prints through `toDouble`, every number output too. | Postgres and Redshift divide integers as integers (`count(*) / 2`), DuckDB does not; and the resident rule ("every aggregate is CAST AS DOUBLE") keeps BigInt and NUMERIC strings out of the reply. |
| F-D6 | **A table is read only through its view CTE**, which Ordinate writes from the record with the existing compiler parts: `fromItem` (the table, or the editor's defining query), `calcFrom` for calcs, `predicates` for the lock and the base filters, and per column `number`, `date` or `keyText` (text, `''` folded to NULL as every import stores it). The view is the only FROM item that names a warehouse object. | Row rules and hidden columns are applied in one place, by code that already passes the parity suites; the statement cannot read the table except through it. |
| F-D7 | **Dates are DATE in the view** (`dialect.date`), and the second call is told so per column. Outputs print `isoDay` for a date, so every engine returns the same text. | A timestamp's text differs per engine (log L2.2, pin 6); DATE is the one form all six compare alike. Phase B's extract lane is unchanged (dates VARCHAR there). |
| F-D8 | **Order is explicit.** The printed statement ends `ORDER BY` the model's top-level keys, then every output column, NULLS LAST unless the model said otherwise (DuckDB's default, spelled out); then `LIMIT 501` (phase B's 500 rows, fetched as limit + 1). Text orders by the warehouse's own comparison: bytes on BigQuery, ClickHouse, Databricks and Snowflake by default, the database collation on Postgres (L2.8 pin R1). `binary()` cannot order: on Postgres and Redshift it is `md5`. | A warehouse has no row order (compile.ts's rule), so "the first 500" and a snapshot must not change between runs. |
| F-D9 | **One connection per statement, Live or source tables only.** A statement reading an extract and a Live dataset, or Live datasets on two connections, is refused. | A warehouse cannot read our Parquet, and copying either side is (c). |
| F-D10 | **Every table under its own lock.** Each table read takes `withLockOf(projectId, id, …)` (`src/ipc/rowDoors.ts`): its lock and hidden columns, or the typed refusal `rowLockFor` throws (derived, pipeline, column, none, fan-out). A join of two locked views combines only rows the caller may see in each. | Row-policy D6 fails closed per dataset; the output is a function of visible rows only, so no join widens. |
| F-D11 | **The statement runs through `warehouse()`**, the one door: slot, daily admission, `runLiveBound` (SSRF guard, `costTag 'live'`, timeout, row cap), bytes on settle. On BigQuery a free dry run (`live.estimate`, which already refuses a non-SELECT) comes first. | The cost limits Live already enforces, plus BigQuery's refusal before billing. `test-liveUsage` still finds no other caller of `runLiveBound`. |
| F-D12 | **Cached and shared like a Live figure**: `orgKey('livesql' · project · connection · [dataset, epoch, schemaSyncedAt] per table · printed SQL · params)`, the age the lowest `maxCacheAgeSec` of the tables read, one flight per key cancelled by the last hang-up (`liveFlight`), the stale fallback labelled `asOf.stale`. | The lock's values are parameters, so a different entitlement is a different key (row-policy D12), and a Refresh's epoch bump misses. |
| F-D13 | **The printed SQL never leaves the server.** Show SQL shows the model's DuckDB text, which names only slugs. A warehouse error is a catalog sentence; its text goes to the log (R-L6). | It holds the table name or the defining query: a dataset origin (AGENTS.md). |
| F-D14 | **The same gates for viewers and editors; different reach.** Below. Viewers never Verify. | Row rules and hidden columns are what makes a viewer safe here, not a lower ceiling. |
| F-D15 | **Phase B's extract lane is unchanged.** F applies when every table a statement reads is Live or a source table. | The DuckDB gate over our own Parquet allows far more (every DuckDB function), safely sandboxed by the org lock; narrowing it would break verified questions. |

### What the IR allows (F1)

A construct enters only with its parity cases (below). Everything else is refused in one sentence.

| Allowed | Printed |
|---|---|
| `SELECT [DISTINCT]`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT n` | the same clauses; `SELECT *` expanded to the view's visible columns |
| `WITH` (not recursive), subqueries in `FROM`, `IN (subquery)`, `EXISTS`, scalar subqueries | CTEs `q0…` |
| `INNER`, `LEFT`, `RIGHT`, `FULL` joins with `ON` or `USING` | `USING` written out as `ON` |
| `UNION ALL`, `UNION`, `EXCEPT`, `INTERSECT` | spelled per dialect: BigQuery's `UNION DISTINCT`, `EXCEPT DISTINCT`; ClickHouse's explicit modes. `EXCEPT ALL` and `INTERSECT ALL` refused (Redshift has neither) |
| `count`, `count(DISTINCT)`, `sum`, `avg`, `min`, `max` | `toDouble(…)`, `countDistinct` |
| `row_number`, `rank`, `dense_rank`, `lag`, `lead`, `first_value`, `last_value`, and the aggregates, `OVER (PARTITION BY … ORDER BY … ROWS …)` | frame bounds via `sqlInt` |
| `CASE`, `COALESCE`, `NULLIF`, `+ - * /`, comparisons, `AND OR NOT`, `IS [NOT] NULL`, `BETWEEN`, `IN (…)`, `LIKE` | `like()`; the pattern bound, rewritten from DuckDB's no-escape convention into the dialect's (`likeEscape`: `!` or `\`), since a `\` in a pattern is an escape on some engines and a plain character in DuckDB |
| `CAST(x AS DOUBLE)`, `AS VARCHAR`, `AS DATE` | `number`, `text`, `date` |
| `date_trunc(unit, d)` for week, month, quarter, year; `extract(part FROM d)` for year, month, day, quarter; `d1 - d2` on dates; `abs`, `floor`, `ceil` | `trunc` (ISO weeks, as DuckDB), `datePart`, `epochDay(d1) - epochDay(d2)` |

Refused in F1, each with its reason in the refusal table of `test-liveSqlCompile`: `WITH RECURSIVE`
(unbounded cost, and support differs across the six), `LATERAL`, `QUALIFY` (not on Postgres),
`PIVOT`, `GROUPING SETS`/`ROLLUP`/`CUBE`, `VALUES`, every table function, lambdas, lists, structs and
maps, regex functions (each engine's regex dialect differs; user regex runs in the regex worker
here), `lower`, `upper`, `length`, `substring` (case maps and code units differ, as the formula
compiler found), `round` (half-even on a Postgres double, half away from zero elsewhere), `now()`,
`ILIKE`, positional references, `* EXCLUDE`/`REPLACE`/`COLUMNS()`. Each can be added later in its own
change with its pins.

`SqlDialect` gains only what the printer cannot spell from existing methods (set operators and an
explicit null order); like `binary`, each is required, so a dialect without one fails `tsc`.

## Threat model

New rows for `docs/phase-7-web/threat-model.md`, each added by the PR that closes it.

| # | Threat | Closed by |
|---|---|---|
| R-L12 | **Parser differential**: comments, quoting, string escapes, dollar quotes, unicode escapes read differently by DuckDB and the warehouse | No model text is sent (F-D1). The printer emits only its own tokens; `ident()` (which refuses `''` and NUL) is the only path for a record's name. |
| R-L13 | **Injection through a literal or an identifier** | F-D4 (every literal bound; the 13 adversarial literals of `test-connectorsSnowflake` plus backslash, backtick, `${}`, NUL, unicode quotes, per dialect), F-D3 (identifiers from the record only, aliases generated). |
| R-L14 | **A function with side effects or external reach.** Snowflake: `SYSTEM$` functions, external functions, stages (`@~`), `COPY INTO @stage` (unload), `CALL`, Cortex. BigQuery: `EXTERNAL_QUERY` (federated Cloud SQL), remote functions, `ML.*`/`AI.*` (billed), `EXPORT DATA`, temp JS functions, `INFORMATION_SCHEMA.JOBS` (others' query text). Postgres/Redshift: `dblink`, `pg_read_file`, `lo_import`, `COPY … PROGRAM`, `pg_sleep`, `set_config`, `nextval`, `UNLOAD`, Spectrum. Databricks: `read_files`, `secret()`, `http_request`, `ai_query`, path tables. ClickHouse: `url()`, `s3()`, `file()`, `remote()`, `mysql()`, `dictGet`, a `SETTINGS` clause | The function allow-list (F-D2): only the table above is printable. None of these has an IR node. |
| R-L15 | **Reaching the base table another way**: a qualified name, `information_schema`, `system.*`, `pg_catalog`, `SNOWFLAKE.ACCOUNT_USAGE`, `TABLE(…)`, time travel (`AT(…)`, `FOR SYSTEM_TIME AS OF`, `VERSION AS OF`), the search path | F-D3 and F-D6: a qualified name is refused, the only FROM items printed are `v0…` and `q0…`, and the view's FROM is built from the record. Time travel and samples are node keys the translator refuses (F-D2). |
| R-L16 | **A lock that widens**: an empty `IN`, a skipped filter, a case-insensitive collation | The lock is the Live doors' own (`predicates`, binary compare per dialect, row-policy D13), inside the view, so every reference to the table is under it. `rowLockFor`'s fail-closed reasons refuse the whole statement. |
| R-L17 | **Origin leak**: the printed SQL, a table name in an error | F-D13, and a canary (table name, defining query, host, secret planted; every reply and prompt grepped). |
| R-L18 | **An injected instruction** in a table doc, a description or a sample value makes the model write a hostile statement | Whatever it writes passes the same translator; its worst is an allowed statement that costs (bounded below) or is wrong (Not checked). Sample values stay withheld for a restricted caller (R-L10). |

### What "read-only" means per warehouse

The IR has only SELECT, so no write is printable. Underneath, the engine's own guard differs:

| Warehouse | Writes refused by the engine? | The boundary |
|---|---|---|
| Postgres family (a Postgres replica, Redshift) | Postgres yes: `default_transaction_read_only on` per session (L2.8 R5: `nextval` refused). It is best-effort per engine (`applyGuards` ignores a refused `set`); not verified on Redshift | Postgres: the session, then the role. Redshift: the role until verified |
| ClickHouse | Yes: `readonly=2`. It still lets a query change settings, so a `SETTINGS` clause must never be printable, and is not | the URL parameter, then the user |
| BigQuery | Scopes `bigquery.readonly` + `cloud-platform.read-only` (the spike is not run, log L1.3) and IAM Data Viewer + Job User; the SQL lane adds the dry run's `statementType = SELECT` | IAM |
| Snowflake | No: the SQL API has no read-only session. `MULTI_STATEMENT_COUNT=1`; Test connection warns on ACCOUNTADMIN, SYSADMIN, SECURITYADMIN | the role alone |
| Databricks SQL | No | the token's grants alone |

`docs/server/live-data.md` keeps the read-only role SQL per warehouse; F adds that the role must
not hold `USAGE` on stages, integrations or external functions on Snowflake, nor connection or
remote-function rights on BigQuery. Defence in depth, since F-D2 already refuses them.

## Row rules and hidden columns, in the warehouse

For each table the statement reads, inside `withLockOf(projectId, id, body, columnsNamed)`:

1. **Resolve** the target: `liveTarget` for a Live dataset; phase D's in-memory view
   (`src/data/sourceView.ts`) for a source table. Folders (E2) apply first: a dataset the caller
   cannot open has no metadata, so its slug resolves to nothing. A reached-only dataset (folders D9)
   is never asked about, so it is not in the vocabulary.
2. **Hidden columns** (`hiddenColumnsFor`, which already counts a calc that reads a hidden column):
   the view projects `declared − hidden`. When the rules do not hold, every column is hidden and the
   statement is refused (`columns`). The second call's facts list only the visible columns, so the
   model is never told a hidden one exists. `columnsNamed` is the statement's resolved columns of
   that table, so one naming a hidden column gets the gate's `hidden` refusal, exactly as a chart.
3. **The lock**: `lock.steps` go through the Live adapter (`liveSpec`, `lock: true` → `binary: true`)
   into `predicates`, AND-ed into the view's WHERE with the base filters: `binary(col) IN
   (binary(?), …)`, values bound. A missing lock column refuses (`column`), never skips.
4. **Print** the view CTE, then the statement over `v0…`.

```sql
WITH v0 AS (
  SELECT <number("AMOUNT")> AS c0, <keyText("REGION")> AS c1, <date("ORDER_DATE")> AS c2
  FROM "ANALYTICS"."ORDERS" AS lv_src
  WHERE <binary("REGION")> IN (<binary(?)>) AND <base filters>
), q0 AS ( … the model's CTE, over v0 … )
SELECT … FROM q0 … ORDER BY …, o_0, o_1 LIMIT 501
```

The lock column may itself be hidden: the WHERE applies before the projection. A required date
filter on a source table (`partition.required`, phase A) is not added silently: the second call is
told the table needs one; BigQuery refuses a statement without it (a typed failure), and elsewhere
the cost limits below apply.

## Cost limits

| Warehouse | Before it runs | While it runs | Counted |
|---|---|---|---|
| BigQuery | dry run, free: refused unless SELECT and under `maximumBytesBilled` = min(the connection's field, `LIVE_MAX_BYTES_BILLED`, 10 GiB by default), with the size in the sentence | `maximumBytesBilled` on the job (BigQuery fails it at no charge), `jobTimeoutMs`, cancel on hang-up | 1 statement; billed bytes from the reply |
| Snowflake | nothing (the SQL API has no byte ceiling) | the statement's `timeout` (`LIVE_QUERY_TIMEOUT_MS`, 60 s; a warehouse `STATEMENT_TIMEOUT_IN_SECONDS` an operator sets lower also applies), cancel; the warehouse size and its resource monitor are the operator's | 1; bytes "Not reported" |
| Postgres, Redshift | nothing | `statement_timeout` = the budget, cancel | 1 |
| Databricks | nothing | our deadline, then cancel (submitted with `wait_timeout 0s`) | 1 |
| ClickHouse | nothing | `max_execution_time` = the budget, cancel on close | 1 |

Everywhere: at most 4 tables (`MAX_SQL_DATASETS`), 20,000 characters (`MAX_SQL_TEXT`), 501 rows
back, `LIVE_MAX_CONCURRENT` (4 per org per pod), `LIVE_DAILY_QUERY_LIMIT` (10,000 per org per UTC
day, of which one member may spend `MEMBER_SHARE`, half), the cache (F-D12). New: **at most
`SQL_PER_HOUR` = 30 Live SQL answers per member per connection** (`counters.take`, across pods,
the `READS_PER_HOUR` pattern of `sourceTable:read`), taken before the second AI call, so a refusal
costs no model call and no warehouse statement. A chart's statements are compiled and cheap; a model's
four-table join is not, and the daily limit counts statements, not cost. The BigQuery dry run is
free and uncounted, as the schema sync's is (log L2.7).

| | Editors, admins | Viewers |
|---|---|---|
| Live datasets they can open | every row, every column | under their lock, without hidden columns |
| Source tables | every documented table on a live-capable connection (phase D) | none until E8; then the tables given to their teams, without the team-hidden columns |
| Verify | yes | no |
| Cost | every gate above | every gate above |

## Source tables and Live datasets: one path

A source table is phase D's view: a `DatasetMeta` built in memory from its doc's facts, `mode: 'live'`,
readable only inside `withSourceViews`, never written. `liveTarget` reads it like a record, so the
view CTE, the cache (keyed on the facts' read time, the view's `schemaSyncedAt`) and `warehouse()` are
the same. Differences: no row rules exist on a table (team folders: *To limit rows, make a dataset*);
editors only (`seesSourceNames`) until E8 ships `team_tables`, when a viewer's given tables join the
vocabulary and their team-hidden columns are removed by the column gate (a synthetic column rule, as
E8 designs it); a table on a connection not asked live is *Copy first* (`needs: 'copy'`). A source
table's name reaches no viewer: in a viewer's second call the table's slug is made from the
editor-written label (team folders, open question 1), never from the table's own name. **Verify** on
an answer that read a source table asks to keep it first (phase D's `sourceKeep`), since a verified
question names datasets.

## Verify, verified questions and snapshots

- **Verify** (editors) saves phase B's record unchanged: `sql: {text, datasetIds}`, the model's
  DuckDB text and the datasets the translator resolved. It runs once through F first.
- **Asked word for word**, it is translated again for the asker and printed under their lock: two
  viewers with different rules send two statements, each cached under its own key. No model call.
- **The Verified page's check** (`sqlProblem`, today *broken* on any Live dataset) translates without
  a warehouse call: a dataset gone, a column no longer declared (the schema sync dropped it), or a
  construct outside the allow-list (an extract switched to Live whose question uses `regexp_matches`)
  says which. MCP's `answer_verified_question` still refuses SQL questions.
- **Snapshots** (phase B): the turn keeps the table, its `asOf` and the fingerprint of the caller's
  lock and hidden columns on each table read. Reopening sends nothing while it holds; **Refresh** is
  one counted statement.

## Proof: the differential and the parity suites

**The reference is DuckDB running the model's own text.** The fixture is the Live parity fixture
(`scripts/liveParityFixture.ts`, typed as an import types it). For each statement of a corpus (phase
B's test questions, then a generated matrix: each allowed construct × column kind × empties, NULLs,
`007`, ids over 15 digits, −0, ISO-week and year boundaries, unicode):

- **Reference:** DuckDB runs the text over the extract twin, each table a CTE projecting exactly as
  the view does (DOUBLE, DATE, text with `''` as NULL), the lock as a byte-equal WHERE.
- **Live:** translate → view → print for the DuckDB dialect → the fake connector
  (`scripts/liveFakeConnector.ts`) through `warehouse()`.
- Every cell compared with `Object.is` (float aggregates within the documented 1e-13), in order: the
  corpus writes total orders, and F-D8's appended keys change nothing then.

The same corpus runs on Postgres in CI (the Redshift dialect, byte-ordered, zone UTC+14, as
`test-liveParityPostgres`), on ClickHouse in the nightly container, and on Snowflake and BigQuery
in the nightly over literal twins (`scripts/liveParityLiteral.ts`), every 8th case plus every
refusal and pin. Databricks stays golden shapes until an engine is available. A divergence is a
named pin with a test that it still exists, never a loosened comparison; the L2.8 pins carry over
(collation R1, the session zone R2, −0 R4), and text comparison, grouping and order on a warehouse
whose collation is not binary join R1.

## The PR plan

Each PR carries its tests, classifies what it touches in `scripts/rowPolicyReaders.ts` and
`scripts/columnAccessReaders.ts`, and puts its sentences through `t()`.

| PR | What | Tests and NEGATIVE CONTROLS |
|---|---|---|
| F1 | `src/engine/live/sql/tree.ts` (DuckDB tree → IR: the allow-list, resolution, typing, binding), `print.ts` (IR → each dialect), `view.ts` (a table's view CTE); the two `SqlDialect` additions. Pure: nothing calls it | `test-liveSqlCompile`: golden shapes for six dialects; the adversarial literal and identifier suites (only placeholders and `ident()` output in the text); every refused construct of the table above with a passing twin; the key census. CONTROLS: a printer that inlines one literal fails the literal suite; a view built without the lock fails the lock clause check; an unclassified key added to a fixture tree is refused |
| F2 | The differential on DuckDB and Postgres: `scripts/liveSqlCorpus.ts`, `test-liveSqlParity` (every `npm test`), `test-liveSqlParityPostgres` (needs `DATABASE_URL`), `scripts/liveSqlPins.ts` | CONTROLS, each must disagree: the lock dropped from the view, `LEFT` printed as `INNER`, the `''` fold removed, the null order flipped, integer division (no `toDouble` on a count) on Postgres |
| F3 | The executor (`src/engine/live/liveSql.ts`: targets, `withLockOf` per table, one connection, print, cache and flight, the BigQuery dry run, `SQL_PER_HOUR`, `warehouse()`, `asOf`, stale) and the lane: `closedWhy` stops refusing Live, `runAnswerSql` routes a Live statement to F, snapshots | `test-liveSqlAnswers`: the channel's table `Object.is` to F2's reference for an admin, an editor, a locked viewer and a viewer with a hidden column; one counted statement per answer, a cache hit none, a second lock a second statement; a dry run over the cap sends nothing (CONTROL: under it, it runs); the 31st answer in an hour refused (CONTROL: another member's is not); the daily limit; refusals (two connections, mixed engines, recursive, qualified name, hidden column), each with a passing twin. `test-liveSafetyNet`: the lane moves from "refuses `live_dataset`" to routed, `getDataset` never called (CONTROL: a planted `getDataset` fails it). `test-liveUsage`'s one-door scan unchanged. R-L6/R-L17 canary over every reply, log line and prompt |
| F4 | Verified SQL on Live: `sqlProblem` and the re-ask through F; the Verified page's translate-only check | `test-liveSqlVerified`: two viewers, two locks, two statements, each equal to its reference (CONTROL: serving the second asker the first's entry fails); a column dropped by a schema sync is reported with no warehouse call (the fake's call count stays 0) |
| F5 | Source tables for editors: the lane's vocabulary takes phase D's tables; Keep before Verify | `test-liveSqlSources`: an editor's table answer equal to the reference; a viewer's prompt and replies hold no table name (CONTROL: as an editor, they do); a non-live connection is *Copy first* |
| F6 | After E8: viewers on given tables, team-hidden columns out of the view | in `test-teamTables`: an unticked table refused, a hidden column absent from the printed view (CONTROL: unhide it and it is present) |
| F7 | The nightly: the corpus on ClickHouse (container) and on Snowflake and BigQuery literal twins (`scripts/warehouseLiveSqlParity.ts`, under the secret canary); operator docs (`docs/server/live-data.md`: the role's stage and integration rights, a Snowflake resource monitor) | the nightly's own pins; a set but unusable account fails, an unset one prints one skip line |

F1 and F2 can merge before phase B and D land on `develop`; F3 needs B, F5 needs D, F6 needs E8.

**Waits on the owner:** F7 runs Snowflake and BigQuery only where `warehouse-nightly.yml`'s
`SNOWFLAKE_*` and `BIGQUERY_*` secrets are set. **They are not today**: the run of 2026-11-15
(43735675013) skipped both warehouses for want of them. They must be added (on
accounts whose role holds no stage, integration or remote-function rights). Databricks needs a
workspace and a token to leave golden shapes.

## Ceilings

- **A narrower SQL than the extract lane.** F1's allow-list is much smaller than DuckDB's, so some
  questions phase B answers on a copy are refused on Live, with the construct named. Each addition is
  its own change with its pins.
- **Nondeterministic statements are not comparable.** `row_number()` over a non-unique order picks
  differently per engine (and per run); the corpus writes total orders, and Not checked covers the rest.
- **Cost on Snowflake, Postgres, Databricks and ClickHouse is bounded by time, not bytes.** Only
  BigQuery refuses before billing.
- **Text comparison and order follow the warehouse's collation** where it is not binary (pin R1,
  F-D8). Only the lock compares bytes.
- **Show SQL shows what the AI wrote**, not what ran. The two mean the same by the parity suites, not
  by inspection.

## Open questions

1. **`SQL_PER_HOUR` = 30 per member per connection** is a guess, not a measurement: worst case 30 ×
   60 s of warehouse time an hour per member on Snowflake. Keep it, make it a setting, or drop it and
   rely on the daily limit?
2. **A byte ceiling on Snowflake**: `SYSTEM$EXPLAIN_PLAN_JSON` (which the nightly's pruning
   measurement already calls) before each SQL statement, refusing past N bytes assigned. Default: no,
   until the nightly measures its round trip and how well bytes assigned predict bytes scanned.
3. **Viewers in F3, or editors first for a release?** Default: viewers in F3, under the lock, as
   their charts are.
4. **Exact text on a non-binary collation**: every text comparison through `binary()` (equality
   only, since `md5` cannot order) and text order by `COLLATE "C"` where the dialect has one, at the
   cost of Postgres indexes and possibly Snowflake pruning, instead of the R1 pin. Default: the pin.
5. **Redshift's read-only session**: verify `default_transaction_read_only` on a real cluster (it is
   best-effort today), or state in the operator docs that the role is Redshift's only write guard.
6. **Row rules in the extract lane's CTE prelude.** The same view rule would let a viewer under row
   rules use phase B on copies. Not in F's scope; a small change after it.
7. **A Databricks workspace** for the nightly (owner).
