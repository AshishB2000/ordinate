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

### F1 as built

- **Files, one job each** (file-size.md): `src/engine/live/sql/ir.ts` (the IR's types), `shapes.ts`
  (the allow-list as data: `SHAPES` node shape → key → `read`, `any` or the one default it must hold,
  `REFUSED` whole constructs by name, `FUNCTIONS` name → IR), `scope.ts` (the typed refusal, name
  resolution, literal typing), `tree.ts` (`parseSql`, `translate`: statements, CTEs, set operations,
  SELECT, FROM), `treeExpr.ts` (expressions, windows, subqueries), `view.ts` (a dataset's view CTE),
  `print.ts` (`printLiveSql`: the IR per dialect). Sentences: `src/engine/liveSqlMessages.ts`, 22
  catalog keys, translated in the four drafts (their 90% floor would not take 22 nulls).
- **The IR** (`LiveSqlIR`): `views` (each dataset read once, with the columns read from it — F3's
  `columnsNamed`), `rels` (CTEs and FROM subqueries, hoisted in dependency order as `q<i>`), `main`, and
  a display name per output. Expressions are 29 closed node kinds; a column is an index into a FROM
  instance (`t<n>`), a literal a typed parameter. Kinds are DuckDB's over the view: number, text,
  date, `ts` (what `date_trunc` returns in DuckDB), `bool` (a condition, never a returned column).
- **The allow-list:** 31 node shapes and 186 keys classified, 15 shapes refused by name, 26 function
  names (aggregates, the seven window functions, abs/floor/ceil, date_trunc, date_part, nullif, the
  four arithmetic operators, LIKE and NOT LIKE). The census over the whole corpus (330 statements)
  meets every classified key and finds none unclassified.
- **Narrower than the table above, each a sentence and a refusal-table row:** a text literal met by a
  number (DuckDB would cast it) and a number met by text; `CAST(number AS VARCHAR)` (DuckDB writes
  `7.0`); arithmetic on a `date_trunc` result (an INTERVAL in DuckDB); `CROSS JOIN` and comma joins;
  `SELECT *` over `USING`; HAVING, WHERE or window clauses naming a returned column's alias; a FROM
  subquery or CTE body reading an enclosing query's column (DuckDB would read it as LATERAL); a frame on
  a rank or a shift. On **ClickHouse** the printer refuses a correlated subquery and
  lag/lead/first_value/last_value (`lagInFrame` reads frames and NULL its own way) until F7 pins them.
- **Choices the note left open:** a view projects only the columns the statement reads, not every
  visible one, so a calculated field it does not read is never computed (a broken one refuses only the
  statements that read it) and BigQuery reads less. Relations' outputs are `o<i>_<j>`, the statement's
  `o_<j>`: a GROUP BY name that is also an input column is the input column on Postgres, so no output
  alias ever shares a name with one. A GROUP BY item prints as its output alias only when it binds a
  value (two placeholders never match as one expression), else as the expression. `/` prints as
  `l / NULLIF(r, 0)`: DuckDB answers Infinity, which a copy's reply reads as empty; Postgres raises.
  `count(DISTINCT …) OVER`, `IGNORE NULLS` and a lag default are refused keys.
- **Tests** (`test-liveSqlCompile`, 253 checks, DuckDB's parser in-process): golden statements for the
  six dialects (`scripts/liveSqlGolden.ts`) and per-dialect fragments (set operators, frames, null
  order); 35 adversarial literals × 6 forms per dialect print the same text as a sentinel (a NUL is
  refused by DuckDB's parser); hostile aliases, quoting, comments and case print exactly as the plain
  statement; a record's hostile column names reach the text only through `ident()`; the refusal
  table, 131 rows (R-L12 5, R-L14 44, R-L15 17, F1 65), each with a passing twin. CONTROLS: an
  inlining printer fails the literal suite; a view built without the lock fails the lock-clause check
  on all six dialects; a key planted in a real tree (on the SELECT node, and deep in an expression) is
  refused and named by the census; and 37 rows whose guard is a table entry (a function, a defaulted
  key such as `at_clause` or `sample`) stop being refused for it when that entry is widened.

### F2 as built

- **Files:** `scripts/liveSqlCorpus.ts` (61 statements over the parity fixture as `orders` and an
  eight-row `targets` with every awkward text; the hostile literals; the refusal table),
  `scripts/liveSqlDiff.ts` (the reference, the Live run, the comparison), `scripts/liveSqlPins.ts`,
  `test-liveSqlParity` (DuckDB, every `npm test`), `test-liveSqlParityPostgres` (needs `DATABASE_URL`).
- **The reference** is phase B's lane itself: `runSql` (compile(), the gate, our Parquet) runs the
  model's text with each table a named view over the extract projecting as the Live view does, and
  the lock a byte-equal WHERE. "Today" is the reference engine's own `current_date`, given to the
  translator (pin P5).
- **Results:** all 61 statements agree cell for cell, unlocked and locked to East, on DuckDB and on
  Postgres through the real `amazon-redshift` connector (byte-ordered scratch database, zone UTC+14),
  and the 35 hostile literals bind and agree on both. Pins, each checked still to exist: P1
  `date_trunc` is a TIMESTAMP in DuckDB (compared by its day), P2 the bridge drops the reference's
  leading U+FEFF (Live keeps it), P3 division by zero, P4 `CAST('Alpha' AS DOUBLE)` raises in DuckDB and
  is NULL on Live, P5 `current_date` binds the given day, R4 −0 (2 cells on Postgres, read as 0).
- **CONTROLS**, each disagreeing on both engines: the lock dropped from the view (51 of 61 locked
  statements), `LEFT` printed as `INNER`, the `''` fold removed, the null order flipped; and on Postgres
  a count with no `toDouble` divides as an integer (353, not 353.33).
- **What F3 needs from here:** `parseSql` in the caller's org worker; a `SqlEnv` of the caller's
  vocabulary (folded slug → record id and VISIBLE columns) and today's UTC day (`todayIso` reads the
  local calendar); per `ir.views[i]`, `liveTarget` and `withLockOf(…, ir.views[i].columns)` into a
  `ViewInput` (`target.env`, `lock?.steps ?? []`), one connection for all; `printLiveSql` with the
  target's dialect; rows read positionally, −0 as 0 and a non-finite number as NULL, a date output
  already ISO text. Worth adding there: DuckDB's binder over empty typed views (DESCRIBE), so a
  statement DuckDB would not bind (a column neither grouped nor aggregated) is refused before any
  warehouse reads it. The threat-model rows R-L12…R-L15 go in with F3, when a statement first reaches
  a warehouse through this path.

### F3 as built

- **Files:** `src/engine/live/liveSql.ts` (the executor, one job: a statement over Live datasets to a table),
  the lane in `src/ipc/answerSql.ts` (`closedWhy`, `tablesFor`, `runAnswerSql` → `runLive`, `SQL_PER_HOUR` before the
  second call), `src/ipc/answerSnapshots.ts` (a Live table kept as of the warehouse's answer), `src/ai/answerSql.ts`
  (a Live table in the second call's facts: no size, the VISIBLE columns, `LIVE_SQL_RULES`; `SqlCard.asOf`), seven
  sentences in `src/engine/liveSqlMessages.ts` and one in `src/ai/answerSqlMessages.ts`, translated in the four drafts.
  `liveBytesCap` moved from the schema sync to `src/connectors/liveRun.ts`, so the sample and an answer share one
  ceiling. The web card (`AnswerSql.tsx`) says *Live · 2:05 AM* when it was not kept, as a chart card does.
- **Routing, by the vocabulary** (the picked datasets; a turn's `datasetIds` on Refresh): none Live is phase B
  unchanged (F-D15); all Live is F; some is refused before the model writes (F-D9). Verify passes no vocabulary, so it
  stays on the gate and is refused in its own sentence until F4; a verified SQL question on a Live dataset still goes
  to the model (`sqlProblem`).
- **The order:** targets (each Live, ONE connection, none a semantic layer's) → `withLockOf` on every table of the
  vocabulary with every name the statement writes as the question (a hidden column named anywhere is the gate's
  `hidden`, rules that cannot apply refuse whole) → DuckDB's parse → `translate` over the VISIBLE columns, today the
  UTC day (`usageStore.utcDay`) → DuckDB's binder (DESCRIBE over empty views typed DOUBLE/DATE/VARCHAR: it refuses
  `SELECT region, qty … GROUP BY region`, which the translator takes) → a column the schema sync found dropped →
  `withLockOf(…, the columns read)` per table read, nested → `printLiveSql` → the cache → one flight → the dry run
  (where the connector prices: free, uncounted; over `liveBytesCap` nothing is sent; a failed dry run never runs blind)
  → `warehouse()`. Rows by position: a number finite or NULL, −0 as 0; text as text; a date ISO text already.
- **The cache key is F-D12's**: `orgKey('livesql' · project · connection · [dataset, epoch, schemaSyncedAt] per table
  · printed SQL · params)`, looked up at the lowest `maxCacheAgeSec` of the tables read; the stale fallback as
  `liveQuery`'s, `asOf.stale`. Two callers with no lock and the same read columns share an entry (the view projects
  only the columns read), so an editor's and a hidden-column viewer's answer can be the admin's cache hit.
- **`SQL_PER_HOUR` = 30**, a constant (open question 1 stands), per member per connection through `counters.take`
  (`livesql:<connection>:<email>`, one hour), taken for every model-written Live SQL answer, a cache hit included,
  before the second call. Refresh and a verified re-ask take none: they write no statement, and the daily limit and
  the cache bound them. No new environment variable.
- **A viewer** gets the same lane under their lock, with the hidden columns out of the facts, the vocabulary, the
  view and `SELECT *` (F-D14; open question 3's default). A required date filter is not added for SQL (the note's
  rule for source tables); BigQuery refuses a statement without it, typed.
- **Tests:** `test-liveSqlAnswers` — without a database 34 checks: the corpus through `copilot:ask` Object.is-equal
  to F2's reference for an admin (61/61), an editor and a viewer from whom `amt` is hidden (12/12 each); one counted
  statement per answer (the fake's calls = `live_usage`), a cache hit none; the dry run over the ceiling sends nothing
  (CONTROL: under it, priced then one statement); the daily limit (CONTROL: lifted); the 31st answer in an hour refused
  before the model writes (CONTROL: another member's is not); two connections, a Live beside a copy, WITH RECURSIVE, a
  qualified name, a hidden column (the gate's sentence) and a binder refusal, each with a passing twin and nothing
  sent (CONTROL: the translator alone takes the binder's case); reopening sends nothing, Refresh past the cache is
  one counted statement; the canary (two warehouse tables, a defining query, the secret: in no reply or prompt, the
  secret in no log line; CONTROL: the warehouse was sent them). With `DATABASE_URL` 43: a locked viewer ≡ the
  reference locked to East (16/16), the editor ≡ the whole table, a second lock (West) a second statement ≡ West's,
  the first again a cache hit; and the corpus through the real `amazon-redshift` connector on Postgres, 61/61, with no
  host, database or password in a reply. `test-liveSafetyNet`: an SQL answer's Refresh moves from "refuses
  `live_dataset`" to routed, `getDataset` never called (CONTROL: one planted in the lane is caught); verifying SQL over
  Live still refuses, typed. `test-answerSql` §3: a Live dataset whose connection is gone is refused before the model
  writes, in that sentence. `test-liveUsage`'s one-door scan is unchanged.
- **Threat model:** R-L12…R-L18 are in `docs/phase-7-web/threat-model.md` §4.7. The fresh-on-ask row that held R-L12
  is R-L19 now.
- **What F4 needs:** `saveVerifiedSql` and `verifiedSqlAsk` to call `runAnswerSql` with the turn's datasets (Verify
  passes `null` today, which keeps it on the gate) and `sqlProblem` to translate (`parseSql` + `translate` with the
  asker's vocabulary) instead of refusing `isLive`; the re-ask is already keyed per entitlement. **What F5 needs:** the
  vocabulary of `runLive` is `{id, names}` per table and `targetsOf` resolves each through `liveTarget`: phase D's
  in-memory view goes in there, and its names in `tablesFor`.

### F4 as built

- **Files:** `src/engine/live/liveSql.ts` (`runLiveSql` split into `prepared`: targets, the gate, parse, translate, the
  binder, the dropped columns; and `checkLiveSql`, which takes those steps and the print under every table's lock, and
  stops: no cache, no flight, no dry run, no warehouse), `src/ipc/answerSql.ts` (Verify's vocabulary; `liveSqlProblem`),
  `src/ipc/verifiedSql.ts` (`sqlProblem`, the save, the re-ask), the web card (`AnswerSql.tsx`: Verify on a Live table for
  editors, `SaveAsVerified`'s own `useCanEdit`). One sentence deleted (Verify on Live "isn't available yet"), from the
  catalog and the four drafts; none added.
- **Saved:** Verify sends the question and the text only (the contract has no list). With no vocabulary,
  `runAnswerSql` takes the datasets the text names by the gate's own lineage (`extractDeps` over `projectNames`, the
  list `compile()` would read): none Live is phase B unchanged; all Live is F, once, for the editor (usually a cache hit:
  they just asked it); some is F-D9's refusal. Kept: `sql: {text, datasetIds}`, the datasets the TRANSLATOR read
  (`ir.views`), so a word naming another dataset (an alias) is not one. No `SQL_PER_HOUR`: Verify writes no statement.
- **Matched and re-run:** the verified index is unchanged (it keys words, not engines). Asked word for word,
  `verifiedSqlAsk` runs `runAnswerSql` with the record's datasets as the vocabulary: translated for the asker, the column
  gate on their words, printed under THEIR lock, so East and West send two statements under two cache keys and a second
  East is a hit. No model call, no `SQL_PER_HOUR`. On a failure the translate-only check decides the sentence: a
  breakage is *This verified SQL no longer runs: …*; anything else (their hidden column or rules, the daily limit, the
  dry run's ceiling, a timeout) is the executor's own sentence. A dataset gone, or a set now part Live part copy
  (F-D9), is a metadata problem: the model takes the question, as for a chart's.
- **The Verified page's check** (`sqlProblem` deep) on a Live question is `checkLiveSql` for the viewer of the page: a
  translator, binder or printer refusal (a column the schema sync dropped reads `"tier" is not a column here.`, since
  the sync removes it from the declared columns and keeps it in `missingColumns` only for charts, KPIs and alerts), a
  dataset gone or a connection gone is broken; a refusal with no code (the row rules' or the column gate's) is that
  caller's access, not a breakage, as on a copy. MCP's `answer_verified_question` refuses SQL questions as before.
- **Tests:** `test-liveSqlVerified` — without a database 18 checks: Verify keeps the translator's datasets (CONTROL: the
  lexer alone keeps the alias's dataset too); the admin and a viewer from whom `amt` is hidden ask it word for word, no
  model call, each card `Object.is` to F2's reference and marked verified; a verified question naming `amt` is the column
  gate's sentence for the viewer and runs on their Verified page (CONTROL: the admin's table); the page's check sends no
  statement and no dry run; a column dropped by a real schema sync over the fake is reported, naming it, with the fake's
  call count unchanged, and asking it says why with nothing sent (CONTROLS: it ran before the sync; a question on the
  same table not naming it still runs); MCP refuses. With `DATABASE_URL` 29: two viewers, two locks, two statements,
  each `Object.is` to the reference under its own lock, East again a hit (CONTROL: serving West the entry East's
  statement left fails the comparison); the page's check under a lock sends nothing; and on Postgres through the real
  `amazon-redshift` connector, verified in one statement, checked in none, asked word for word ≡ the reference, no host,
  database or password in a reply. `test-liveSafetyNet`: Verify over Live moves from "refuses, typed" to routed
  (`getDataset` never called) and the page's check sends nothing; over a gone connection it refuses.
- **What F5 needs:** a source table has no record, so `extractDeps` over `projectNames` never names one, and a verified
  question names datasets: Keep (phase D's `sourceKeep`) before Verify, then this path as is. `checkLiveSql` and
  `runLiveSql` share `prepared`, where `targetsOf` is the one place a source view's target goes in.

### F5 as built

- **Files:** the lane (`src/ipc/answerSql.ts`: `picked`, `namesOf`, `sqlAnswer` inside the views), `src/ipc/sourceAnswers.ts`
  (`inSqlTables`), `src/engine/sqlDatasets.ts` (`projectNames` takes the views), `src/ipc/answerSnapshots.ts`,
  `src/ipc/sourceKeep.ts` (`keepSql`), `src/ai/copilot.ts` and `copilotRows.ts` (`replaceAnswer` re-points an SQL turn),
  `src/ai/answerSql.ts` (`SqlTurn.table`), `src/ai/sourceTablesBlock.ts` (its framing: an `sql` line may name a table),
  the web card (`AnswerSql.tsx`). No contract, sentence, setting or environment variable is new.
- **How a table enters the lane.** The first call already sees phase D's SOURCE TABLES block (an editor's Home question,
  `askSourceTables`). `picked` resolves each name the `sql` line gives as a dataset first (a dataset of the same name
  wins, as the validator's rule); a name no dataset has is looked up among the ask's tables (`sourceVocabulary`: the same
  step 3 picks, so only when a name misses: `test-askBudget` is unchanged). A table on a connection not asked live is
  `copyRefusal`'s *Copy first* with `needs: 'copy'`, before the second call. The rest of the answer runs inside
  `withSourceViews` with the picked tables' views, so every reader asks the view as a record: `closedWhy`, `liveCount`,
  `SQL_PER_HOUR`'s connection, `tablesFor` (the facts' columns, typed by `liveColumns`, as a Live dataset's VISIBLE
  columns), and F3's executor, where `liveTarget` reads the view and **`targetsOf` needed no change**: a table and a Live
  dataset on one connection run as one statement; two connections are `sqlTwoConnections`, a copy beside it
  `sqlMixedEngines`, as before. The daily limit counts the statement under the first table read's id, as phase D's.
- **Names.** A view is named as a dataset of its name made now would be (`projectNames(projectId, views)`: the views
  youngest in `assignViewNames`), so `ANALYTICS.RETURNS` is `analytics_returns` beside every dataset's own name. Kept, the
  dataset is named as the table and takes the same names, so the stored text needs no rewrite.
- **The turn** keeps `sql.table`, the connection, beside the doc ids in `datasetIds` (`AnswerSpec.table`'s convention).
  Its snapshot, its delivery on reopen and Refresh run inside `inSqlTables` (the role first, then one docs read and one
  connection read), so a caller who may not see source names gets no stored table, as for a chart answer from a table.
- **Keep, then Verify.** The card says *Warehouse table, not a dataset* and offers **Keep as a dataset** (phase D's
  `KeepTable`) where Verify would be. `answer:keepTable` on an SQL turn keeps each table it read (`keepView`:
  `createLiveDataset` through the connection's own Live create) and re-points the turn: the kept ids in `datasetIds`, no
  `table`, the text and title unchanged, the snapshot dropped (the provenance is the ask's, so it is not rewritten). A
  second click makes nothing. Verify is then F4's path as is: the gate's lineage finds the kept datasets by the same names,
  and the record keeps `sql: {text, datasetIds}` of them. Verify before Keep is refused by the gate (the table is no
  dataset), never saved; the web does not offer it.
- **Viewers** are unchanged: no table is offered (`askSourceTables`), looked up (`sourceVocabulary` asks the role before
  any read) or read for them. A model that names one anyway gets the lane's *"…" is not the name of one dataset.*,
  quoting its own word, with no table doc read, no second call and no statement.
- **Left:** the second call is not told a table's required date filter (F3's rule for Live datasets stands); its line
  says "the dataset" for a table; a Keep that fails on a second table leaves the first one made (a code `shortcut:`);
  Verify before Keep says the gate's sentence, not *Keep this answer as a dataset first* (Verify sends the text only).
- **Tests:** `test-liveSqlSources` — without a database 25 checks: the corpus over two tables through `copilot:ask`, the
  admin as editor, `Object.is` to F2's reference (61/61), the first call's block typed from the facts, the second call's
  columns, the turn's doc ids and connection (NEGATIVE CONTROL: against the reference locked to East it disagrees); one
  counted statement under the view's id, then the cache, nothing hydrated, no dataset made (NEGATIVE CONTROL: a spent
  daily limit refuses it, nothing sent); a table and a Live dataset on one connection ≡ the reference (6/6), two
  connections refused before any SQL; *Copy first* with no second call and no statement; a viewer's prompts and replies
  hold no table name, their answer reads a dataset (CONTROL: the editor's hold it), a model naming a table to them is
  refused with no table doc read, and their Keep is refused; Keep makes one Live dataset per table and re-points the
  turn, a second makes none, the kept answer ≡ the reference, Verify after it keeps the kept ids, and asked word for word
  it runs with no model call ≡ the reference (CONTROL: Verify before Keep saves nothing). With `DATABASE_URL` the same 25
  over real grants and the RPC route (a project editor and a project viewer; the corpus cut to 12 for `SQL_PER_HOUR`,
  which counts in Postgres there; Keep 403). Vitest: `answerSql.test.tsx` (the note, Keep for an editor, neither for a
  viewer, Verify once kept). e2e: `web/e2e/source-tables.e2e.ts` step 5, the card laid on the conversation in both themes
  (`dock-source-sql`).
- **What F6 needs from E8:** `team_tables` (the tables a viewer's teams were given) and the editor-written label. Then
  `sourceVocabulary` and `inSqlTables` admit a viewer's given tables instead of asking `seesSourceNames`; the view is named
  from the label, never the table (`namesOf` takes the label for a viewer); and the team-hidden columns become a column
  rule the view's `withLockOf` already applies (the second call's facts and the view then drop them).

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
