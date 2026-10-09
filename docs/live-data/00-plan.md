# Live data — fresh numbers from the warehouse

Ordinate answers questions from a **copy** of the data (Parquet, refreshed on a schedule). This plan
adds what Omni does well: for a cloud warehouse, **ask the warehouse itself** each time, so a chart,
a KPI tile or an AI answer shows the number as it is *now*, not as it was at the last refresh. It
also adds Snowflake and BigQuery, which Ordinate does not have yet.

This file is the plan of record. Each task below is one PR off `develop` (CLAUDE.md, Git). Written
2026-10-09.

---

## 0. In one minute

**Today**

> 1:00 AM — Ordinate copies the `orders` table.
> 2:00 AM — 500 new orders land in Snowflake.
> 2:05 AM — "How many orders today?" → **the old number**. The copy is an hour old.

**After this plan**

> 2:05 AM — "How many orders today?"
> → the model picks *which* columns and filters (it never writes a number)
> → Ordinate compiles that to SQL and sends it to Snowflake
> → Snowflake counts — **including the 500 new orders**
> → the answer says **"Live · 2:05 AM"**

**What we build, in order**

| Phase | In plain words |
|---|---|
| **L0** | Dashboards update by themselves after a refresh; every tile says how fresh it is; refresh every 5 min; a refresh URL for dbt/Airflow. |
| **L1** | Snowflake and BigQuery connectors. |
| **L2** | A **Live** switch on a warehouse dataset: questions go to the warehouse, with a short cache (5 min by default, 0 = always live). |
| **L3** | Postgres/MySQL stay copies, but a question on a stale copy first pulls just the new rows ("fresh on ask"). |
| **L4** | Later: joins across datasets, AI notes and synonyms, more live warehouses, queries that run as the viewer. |

---

## 1. What Omni does, and what we take

From Omni's docs and blog (sources at the end).

| Omni | We take it? |
|---|---|
| A **semantic model** (YAML views, dimensions, measures, topics with joins). The AI builds a *modeled query*, never raw SQL; Omni compiles it per dialect. | **Yes — we already have the shape.** Our `AnswerSpec` is a modeled query. L2 compiles it per dialect. Joins (topics) come in L4. |
| The warehouse computes; results are cached. **Default cache age 6 h**, settable 0 s – 30 days per model or topic; exact-match reuse. | **Yes**, per dataset, default **5 min** (we lean fresher). |
| Cache **reset API**, called from dbt or a Snowflake function when data lands. | **Yes** — the refresh URL (L0.5) also resets a live dataset's cache. |
| A "requery" cache of the last 30 results in **DuckDB in the browser**; re-filter, re-sort and roll-ups run there. | **The idea, not the place.** DuckDB-Wasm needs `wasm-unsafe-eval` in our CSP and breaks "React never computes". Roll-ups of cached results run in *server* DuckDB (L4). |
| AI accuracy from admin-written `ai_context`, synonyms, sample values, example queries. | **Yes**, L2.5 (sample values) and L4 (notes, synonyms). |

So Omni's "real-time" is: the warehouse is queried on a cache miss, and freshness is a cache
setting. That is what we build.

---

## 2. Where Ordinate is today

Facts this plan builds on (file:line at the time of writing).

- **No Snowflake or BigQuery.** 38 connectors; the warehouses present are Redshift (postgres family),
  Synapse (mssql), Databricks SQL, ClickHouse, Trino, Presto, StarRocks, Doris, Druid.
- **`http.ts` cannot grow:** 1,035 lines, pinned at exactly that in the `test-file-size` allowlist,
  which may only shrink. New warehouses need their own files.
- **Connection secrets have two slots:** `password` and `token` (`src/ipc/connectionSecrets.ts:9-30`).
  A secret field renders as a single-line password input even when typed `textarea`
  (`web/src/features/connections/ConnectionForm.tsx:111-124`), which can't hold a pasted
  service-account JSON or a PEM key.
- **AI answers load every row.** `computeCard` (`src/ipc/answers.ts:127`) calls `datasets.getDataset`
  and then the JS `buildVizData`; top-N, text-filter case fixing and split candidates all scan rows
  in JS. Nothing is cached.
- **Charts and KPI tiles** go through `vizDataFor` (`src/ipc/visuals.ts:416`) → `residentVizData` →
  `aggregateResident`, and `metricFor` (`src/ipc/dashboards.ts:198`) → `computeMetricResident`.
  Publish and export reuse these two, so routing them routes publish too.
- **The resident layer has no series and no top-N** (`visualsResident.ts:140`), only a fixed
  50-plus-"Other" cap on text categories.
- **`queryCache` has no TTL** — its key carries `updatedAt` and is invalidated on every dataset
  write (`src/engine/queryCache.ts:73`). A warehouse changing underneath would never invalidate it.
- **Refresh:** `hourly | daily | weekly` (`src/data/datasets.ts:145`), 60 s scheduler tick,
  incremental refresh with a cursor and an upsert key already exists (`src/data/incremental.ts`,
  `incrementalRefresh.ts`), 1M-row cap. The refresh locks are **in-process only**
  (`datasetRefresh.ts:102`, `app/jobs.ts`), so two pods can refresh the same dataset at once.
- **Push:** `hub:dataset-refreshed` is published only by *scheduled* refreshes
  (`src/server/jobs/schedules.ts:76`), and **nothing in `web/src` listens to it**.
- **API tokens are user-wide** (`src/server/auth/tokens.ts:36`); there is no narrow,
  single-purpose token.
- Scheduled refreshes are not audited.

---

## 3. Locked decisions

Merging this plan approves these. **No new runtime dependency** is needed anywhere in it.

| # | Decision |
|---|---|
| D1 | **The principle changes** (agreed with the owner, 2026-10-09). New CLAUDE.md text, applied in L2.1: *"**Deterministic engines do the math, never a model.** For a copied (extract) dataset the engine is ours — pure server code and DuckDB over our Parquet; React only formats. For a **Live** dataset it is the source warehouse, running SQL the app compiled from a validated spec, and a parity test proves that SQL and our engine agree on the same rows. A model only extracts structure or narrates figures an engine computed; it never writes a computed number."* |
| D2 | **Live is a per-dataset mode**, offered only by connectors that declare a live dialect. v1 dialects: **Snowflake, BigQuery, Redshift, Databricks SQL, ClickHouse**. Everything else stays extract. |
| D3 | **One compiler, many dialects.** A small intermediate query (category, grain or bins, measures, filters, series, top N) compiles to SQL per dialect. Not a full semantic layer in v1. |
| D4 | **Values are bind parameters, never inlined text.** Snowflake `bindings`, BigQuery `queryParameters`, Databricks `parameters`, ClickHouse `{p:Type}`, Redshift `$n`. Identifiers come only from the stored schema, quoted per dialect. |
| D5 | **Freshness is a cache setting:** `maxCacheAgeSec` per live dataset, 0 – 30 days, default 300. A reset is an `epoch` bump on the record, which every pod sees. |
| D6 | **No silent zeros.** `getDataset` on a live dataset *throws*; every feature not yet built for live refuses with a clear message. A live failure is an error, or the last cached result labelled stale — never an empty chart. |
| D7 | **Live has no JS fallback.** The resident layer returns `null` and falls back to JS; live has no rows to fall back on. Correctness rests on the parity tests (L2.2, L2.8). |
| D8 | **OLTP sources stay extract.** Postgres/MySQL get "fresh on ask" (L3.1); live on a *read replica* is an opt-in (L3.2). |
| D9 | **Cost is guarded by default:** per-query timeout, BigQuery max bytes billed, a per-org daily query limit, per-org concurrency, a cache floor on public pages, cancel on hang-up. |
| D10 | **Browser DuckDB is rejected** (CSP and "React never computes"). Server-side requery is L4. |

---

## 4. How a live answer works

```
question ─► model ─► AnswerSpec ─► validateAnswerSpec (names resolve against the schema)
                                          │
                       ┌──────────────────┴───────────────────┐
                 extract dataset                         live dataset
                       │                                      │
          existing path (Parquet + DuckDB / JS)   toLiveQuery(spec) ─► compile(dialect)
                       │                                      │       SQL + bind params
                       │                            cache hit? ─yes─► rows (fetchedAt)
                       │                                      │no
                       │                     budget ok? ─► connector.live.runBound ─► warehouse
                       │                                      │
                       └──────────────► {labels, series} + asOf ◄┘
                                          │
                              answerFacts ─► narrate (model words the app's figures)
```

The same `toLiveQuery → compile → run` path serves charts (`vizDataFor`), KPI tiles
(`metricFor`), AI answers (`computeCard`), copilot facts, publish and export.

---

## 5. Tasks

Sizes: **S** ≈ one small PR, **M** ≈ a normal PR, **L** ≈ a large PR or two.

### Phase L0 — Freshness basics (every source, no warehouse needed)

**L0.1 Dashboards update themselves after a refresh** · S
- Publish `hub:dataset-refreshed` after **every** successful refresh (manual, scheduled, hook,
  fresh-on-ask) from `refreshAsJob` (`src/data/refreshJob.ts`), to project readers only, as the
  scheduler does today. Payload unchanged.
- Web: `web/src/api/freshness.ts`, mounted once in the app shell. On the event (debounced 500 ms) it
  invalidates the dataset's queries: `visual:data` (predicate on `req.datasetId`; the key embeds
  the request), `visual:preview`, `visual:thumbs`, `metric:values`, `summary:compute`,
  `dashboard:asOfStamps`, `dataset:list|columns|stats|source`. On `onReconnect`, everything.
  TanStack refetches only *visible* queries, so the RPC budget holds.
- Tests: Vitest for the invalidation map; an e2e (dashboard open in one page, refresh triggered from
  another; the tile changes without a reload, inside `rpcBudget`).
- Done when: a refreshed dataset updates every open dashboard within a second, on any pod.

**L0.2 Every figure says how fresh it is** · S
- Every chart, KPI and answer reply carries `asOf`: `lastRefreshedAt` for an extract, `fetchedAt`
  (the time the warehouse answered) for live. Extend `dashboard:asOfStamps` instead of adding a
  channel where it fits.
- UI: a small caption, "As of 1:00 AM" or "Live · 2:05 AM", on tiles and answer cards; older than
  24 h gets the warning tint. The model's narration is given `asOf`, so it can say "as of 1:00 AM".
- Done when: no figure on screen is undated.

**L0.3 Refresh every 5 or 15 minutes** · M
- Add `'5min' | '15min'` to `AutoRefreshEvery` and everywhere it is listed:
  - server: `datasets.ts:145`, `INTERVAL_MS` (`refreshScheduler.ts:41`), `sanitizeAutoRefresh` /
    `setAutoRefresh` (`datasetRecord.ts:87,161`), the zod enums in `src/api/datasets.ts:103` and
    `src/api/prepare.ts:90`, and `src/ipc/pipelines.ts:122`
  - web: `web/src/features/data/format.ts:70`, `connections/DetailsRail.tsx:20`,
    `prepare/PipelinesDetail.tsx:50`, and `web/src/api/datasets.ts:23`
- **Allowed only when incremental refresh is on.** A full refresh every 5 min would hammer the
  source, so the server refuses it, with a catalog message.
- The tick is strictly serial, so one slow table could starve the rest. Incremental refreshes are
  queued as jobs instead (one per dataset, `MAX_RUNNING`), most overdue first. A dataset whose
  refresh takes longer than its cadence shows "Behind schedule".
- Tests: the pure `dueDatasets` with the new intervals; a negative control (5 min without
  incremental is refused).

**L0.4 One refresh at a time, across pods** · S
- With `DATABASE_URL`, wrap a refresh in `pg_try_advisory_lock(hashtext(org || ':' || dataset))` on
  a dedicated client. If the lock is already held, coalesce: return the running job, start nothing.
  Without a DB, the in-process guard stays.
- Needed before L0.5 and L3.1, which can fire from any pod.
- Tests: two pools against a scratch DB; exactly one refresh runs.

**L0.5 A refresh URL for dbt / Airflow** · M
- Migration (next free number, additive): `refresh_hooks(id, org_id, project_id, dataset_id,
  token_hash, prefix, created_by, created_at, last_used_at, revoked_at)`.
- Route: `POST /api/hooks/refresh/<token>`, registered in `src/server/app.ts` beside the file and
  MCP routes. It authorises itself, as `/p/` does: a sha256 lookup with a constant-time compare.
  Add it to `routeAccess()`, the `onRequest` gate, CSRF `BEARER_ONLY` and the rate limits. It
  returns `202 {status: 'queued' | 'already_running'}`. Hooks are at most 1 per minute
  (`REFRESH_HOOK_MIN_INTERVAL_SEC`), else 429.
- **The token can do exactly one thing:** refresh one dataset. On a live dataset it bumps the cache
  epoch instead.
- RPC: `refreshHook:create|list|revoke` (access `write`, project-scoped). The token is shown once.
- UI: a "Refresh URL" section on the dataset's details rail: copy, a `curl` example, and a dbt
  `on-run-end` / Airflow snippet.
- Audit: new actions `hook_refresh` and `scheduled_refresh` (closing the gap that scheduled
  refreshes aren't audited).
- Tests: a revoked or unknown token is refused; a token for dataset A can't refresh B; the 429
  path; a canary (the token never appears in logs).

### Phase L1 — Snowflake and BigQuery

**L1.1 Room for warehouse keys** · S
- Web: a **masked multi-line secret** control in `ConnectionForm` (shows "Key saved" once
  `secretSet`, with a "Replace" action). Add `'textarea'` to `FIELD_TYPES`
  (`src/connectors/index.ts:39`).
- Secrets fit the existing two slots: a Snowflake private key goes in `token` and its passphrase in
  `password`; a Snowflake PAT goes in `token`; a BigQuery key JSON goes in `token`.
- Tests: Vitest for the control; the secret never comes back to the browser.

**L1.2 Snowflake connector** · M
- Files: `src/connectors/snowflake.ts` (its own family) plus `src/connectors/jwt.ts` (RS256 signing
  with `node:crypto`, shared with BigQuery). Register in `FAMILY_MODULES`, add the family to
  `FAMILIES` in `scripts/test-connectors.ts`, add a logo.
- Fields: account (`myorg-myaccount` or a locator), user, auth (`key pair` | `programmatic access
  token`), private key, passphrase, token, **warehouse** (required), database, schema, role
  (required). No password-only sign-in, which Snowflake is phasing out.
- Host: the account is validated (`^[a-z0-9_-]+(\.[a-z0-9_-]+){0,3}$`) and **we build**
  `https://<account>.snowflakecomputing.com`, with a privatelink checkbox. A user never types a URL.
  Every socket goes through the SSRF guard.
- Transport: the SQL API, `POST /api/v2/statements?requestId=<uuid>`, with `{statement, timeout,
  warehouse, database, schema, role, bindings, parameters: {QUERY_TAG: 'ordinate:<org>',
  WEEK_START: 1, TIMEZONE: 'UTC'}}`.
  - A 202 response is polled on `statementStatusUrl`; result partitions are read until the row cap.
  - **On abort or timeout, `POST …/cancel`**, so a closed tab never leaves a warehouse running.
  - Auth header: `Bearer <jwt|pat>` with `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT |
    PROGRAMMATIC_ACCESS_TOKEN`. The JWT has `iss = ACCOUNT.USER.SHA256:<public key fingerprint>`
    and a lifetime of at most 1 h, cached per connection with `orgKey()`.
- Row cap: user SQL sits on its own line inside `select * from (\n…\n) limit N+1` (rule F3), plus
  a client-side stop.
- **Read-only: not enforced by the engine**, which is the same label Databricks and Trino carry today.
  One statement per call (`MULTI_STATEMENT_COUNT=1`). Test connection **warns** when the role is
  `ACCOUNTADMIN`, `SYSADMIN` or `SECURITYADMIN`. The operator doc gives the read-only role SQL.
- Types: `rowType` → `ColumnType` (FIXED/REAL → number, except FIXED with more than 15 digits, which
  stays text per `parse.ts`; DATE/TIMESTAMP_* → date, zoned values written as UTC ISO; VARIANT and
  OBJECT → JSON text).
- `listTables` and `describeTable` via `SHOW TERSE TABLES` / `INFORMATION_SCHEMA.COLUMNS`.

**L1.3 BigQuery connector** · M
- File: `src/connectors/bigquery.ts` (its own family), using `jwt.ts`.
- Fields: billing project, service-account key JSON, default dataset, location, max bytes per query.
- Auth: a JWT signed with the key → `POST https://oauth2.googleapis.com/token` → an access token,
  cached about 55 min per connection with `orgKey()`. **The key file's `token_uri` must equal that
  exact URL, or we refuse it.** The key file is user-supplied, and a free-form `token_uri` would be
  an SSRF and credential-exfiltration hole.
- Transport: `POST https://bigquery.googleapis.com/bigquery/v2/projects/<p>/queries` with
  `{query, useLegacySql: false, parameterMode: 'NAMED', queryParameters, maxResults, timeoutMs,
  location, maximumBytesBilled, labels: {ordinate: 'live|extract'}}`.
  - An incomplete job is polled with `getQueryResults` and paged with `pageToken`.
  - **`jobs.cancel` on abort.**
- **Read-only:**
  - Ask for the `bigquery.readonly` scope. Whether `jobs.query` accepts it is reported to work but
    is unconfirmed, so the first step of this task is a spike that verifies it.
  - If it works, read-only is enforced by Google.
  - If not, every user-written SQL is **dry-run** first and refused unless `statementType` is
    `SELECT`. The dry run is free.
  - The operator doc: Data Viewer + Job User roles only.
- Cost: `maximumBytesBilled` on every query (connection field, capped by `LIVE_MAX_BYTES_BILLED`).
  The dry run's `totalBytesProcessed` is shown in the query editor before running.
- Types: INT64, NUMERIC and BIGNUMERIC arrive as strings (more than 15 digits stays text).
  **TIMESTAMP arrives as epoch seconds and is converted to UTC ISO.** REPEATED/RECORD → JSON text.
- Row cap: the same wrapper as Snowflake, plus a client-side stop.

**L1.4 Incremental refresh and table SQL for both** · S
- `incrementalSql.ts` `DIALECTS` gains `snowflake` (`"…"` quoting, `'…'::timestamp_tz`) and
  `bigquery` (backticks, `TIMESTAMP('…')`).
- `connectionRun.ts` table SQL gains BigQuery's `` `project.dataset.table` ``.
- Tests: extend `test-incrementalRefresh`.

**L1.5 Tests and counts** · S
- `scripts/test-connectorsSnowflake.ts` and `scripts/test-connectorsBigquery.ts`. Both are HTTPS-only,
  so following the Databricks precedent they export pure `buildRequest` / `shapeResponse` functions
  and test them against recorded JSON fixtures. The socket layer is the existing, already-tested
  `httpRequest`.
- Cover:
  - partitions and paging
  - truncation at the cap
  - epoch timestamps
  - a leading U+FEFF
  - ids with more than 15 digits
  - JWT claims, verified with `crypto.verify`
  - a bad `token_uri`
  - a bad account name
  - cancel on abort
  - a **secret canary**: plant a key and a PAT, then grep every output and error
- Counts 38 → 40: `scripts/test-icons.ts:42`, README (lines 17 and 116), CLAUDE.md. Also fix the
  stale "35" comments (`ConnectionsPage.tsx:2`, `incrementalSql.ts:23`, `src/ipc/connections.ts:220`,
  `datasetOrigin.ts:21`).
- Real-account tests: `scripts/test-warehouseLive.ts` (it says it skipped when credentials are
  absent) and `.github/workflows/warehouse-nightly.yml` with repo secrets.

### Phase L2 — Live datasets

**L2.1 The Live record and the safety net** · M
- `ConnectorDef` gains an optional property (still one registry entry per connector, not a union):
  ```ts
  live?: {
    dialect: LiveDialectId;                 // 'snowflake' | 'bigquery' | 'redshift' | 'databricks' | 'clickhouse'
    runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError>;
    estimate?(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<{ bytes: number } | ConnectorError>;
  };
  ```
  `ConnectorContext` gains `costTag?` and `maxBytes?`.
- `Dataset` gains `mode?: 'extract' | 'live'` (absent = extract) and
  `live?: { maxCacheAgeSec: number; epoch: number; schemaSyncedAt: string }`. This lives in the
  record, so it needs no SQL migration. `src/data/liveDataset.ts` holds sanitising, `isLive()` and
  `requireExtract()`.
- A live dataset stores **schema only**: columns with declared types from the warehouse types. No
  Parquet, and no 1M-row cap, because results come back aggregated.
- **Safety net (D6):** `datasets.getDataset` throws `LiveDatasetError` on a live dataset. Every
  reader not yet routed then fails loudly instead of computing on zero rows. A test calls each
  row-reading channel (the list in L2.6) against a live dataset and asserts a typed refusal.
- Create flow: "Add from connection" asks **"Copy the data"** or **"Live"** (Live is offered only
  when the connector has `live`). The dataset's settings can switch modes; extract → live drops the
  Parquet after a confirm.
- `dataset:source` adds `live: true` and `maxCacheAgeSec`. It still sends no SQL text and no URL.
- Apply the D1 text to CLAUDE.md, and add a "Live datasets" section under the resident-query layer.

**L2.2 The compiler** · L
- Files (each under 500 lines):
  - `src/engine/live/liveSpec.ts`: the IR and the adapters `fromVizEncoding`, `fromAnswerSpec`,
    `fromMetric`
  - `src/engine/live/compile.ts`: IR → `{sql, params}`, dialect-agnostic
  - `src/engine/live/dialects/{snowflake,bigquery,redshift,databricks,clickhouse,duckdb}.ts`. The
    DuckDB dialect is the test bench, so CI needs no warehouse.
- Rules, copied from the resident layer so live and extract mean the same thing:
  - **Cast on the declared type.** A column declared `number` but stored as a warehouse string is
    `TRY_CAST`/`SAFE_CAST`. `sum` over a text column is refused at compile time: loud, never a
    wrong figure.
  - **Every aggregate is cast to DOUBLE** (`FLOAT64` on BigQuery).
  - **Empty = null or `''` or whitespace**, with the whitespace class spelled out per dialect.
    `count` counts non-empty cells: `COUNT(CASE WHEN NOT <empty> THEN 1 END)`.
  - **`avg` is compiled as sum + count**, so "Other", roll-ups and retail-calendar periods stay exact.
  - **Text categories:** the same 50-plus-"Other" rule as `resolveCatKey`, in one query (group,
    rank, re-aggregate everything ranked past 50).
  - **Date grains** use ISO weeks starting Monday and calendar quarters:
    - Snowflake `DATE_TRUNC` under `WEEK_START=1`
    - BigQuery `DATE_TRUNC(d, ISOWEEK)`
    - ClickHouse `toMonday`
    - Databricks and Redshift `date_trunc('week')`
    - Labels such as `YYYY-Qn` are formatted in our code, from the bucket start.
  - **Retail calendar active:** the warehouse groups by day and our code rolls days up into retail
    periods. This is exact because of the sum + count rule.
  - **Number bins:** two steps (min/max, then bucket), using `resolveCatKey`'s bin rule.
  - **Filters:** every op in `FILTER_OPS`, with the same case rule as `filterOps` for `contains`
    (`%` and `_` escaped). `period` is resolved by the app to concrete dates, using the data's latest
    date, which is a cached `MAX()` query. `within_km` is refused on live in v1, with a message.
  - **Series and top N** (`ORDER BY` the first measure, then `LIMIT N`), both new compared with the
    resident layer.
  - **Order is explicit.** A warehouse has no row order, so live orders dates ascending, bins
    ascending, and text by the first measure descending, then label. Every `ORDER BY` ends with the
    label, so the result is deterministic. This differs from an extract's first-seen order for text
    categories, and the UI and docs say so.
- Tests: `scripts/test-liveCompile.ts`.
  - An **adversarial literal suite** per dialect (quotes, backslashes, unicode quotes, `${}`, NUL)
    proves values only ever travel as parameters.
  - `scripts/test-liveParity.ts` is the differential test. One fixture table holds every edge case
    (empties `''`/`'  '`/tab/NBSP, nulls, `007`, `-0`, ids with more than 15 digits, dates across
    ISO-week, quarter and year boundaries, unicode).
    - It runs a generated matrix: aggregation × category kind × grain × filter op × series × top.
    - Each case runs **extract** (the existing path) and **live** (the compiler's DuckDB dialect).
    - Labels and values are compared with `Object.is`. Order is checked against each path's own rule.
    - Float sums get the documented ~1e-13 tolerance (an existing known divergence); everything else
      must match exactly.
  - **Negative control:** a broken empty-predicate is injected and the harness must fail.

**L2.3 The executor and the cache** · M
- `src/engine/live/liveQuery.ts`: IR → compile → cache → budget → `runBound` → shape to the same
  `{labels, series}` / number the resident layer returns.
- `queryCache` gains an optional per-entry `maxAgeMs`, used only by live. The live key is
  `[org, 'live', datasetId, epoch, schemaSyncedAt, stableStringify(ir)]` (`orgKey()` as everywhere).
  Concurrent identical asks already share one computation.
- On a warehouse error: if a cached result exists, **serve it labelled "Stale · as of …"**;
  otherwise return a typed error. Never an empty result.
- Cancel: the request's abort signal → the connector's cancel.
- Trace: `residentTrace` op `live:<dialect>` with outcomes `hit | warehouse | stale | refused |
  failed`, on `/metrics`.

**L2.4 Route every door** · M
- `vizDataFor` (charts, publish, export), `metricFor` (KPI tiles, metric series), and `computeCard`
  (AI answers: top N in SQL; text-filter case fixing becomes a cached `SELECT DISTINCT … WHERE
  lower(col) IN (…) LIMIT 20`; split candidates come from the profile, L2.5).
- Copilot facts (`src/ipc/copilot.ts:224` calls `buildVizData` directly) must go through
  `vizDataFor`. `answer:explain`, `summary:rewrite` and `alerts.ts` read figures through the routed
  functions, and `guardAnswer` keeps auditing every figure against the app's ledger.
- Tests: the differential spies prove a live dataset never calls `getDataset`, and a dashboard with
  N live tiles makes at most N warehouse calls, and zero on a second view inside the cache age.

**L2.5 Profile and AI context for live** · M
- "Sync schema" (on create, on demand, and daily) stores per column: declared type, approximate
  distinct count, null share, and up to 20 sample values for low-cardinality text. It runs one
  sampled query per table (`SAMPLE` / `TABLESAMPLE`), cost-guarded.
- Feeds the AI prompt (Omni's sample values), the split picker and the filter pickers. A column
  that disappears from the warehouse marks dependent charts "column missing" instead of failing
  oddly.

**L2.6 The Live experience** · M
- Dataset settings: a **Live** switch and a cache-age picker (Always live · 1 min · 5 min (default)
  · 1 h · 6 h · 1 day), plus **Refresh now**, which bumps the epoch.
- Every figure: "Live · 2:05 AM" or "Live · cached 3 min ago" (L0.2), and "Stale · as of …" on
  fallback.
- **Off for live in v1**, each with an explanation and a **"Make a copy"** action that creates an
  extract of the same source:
  - prepare steps and formulas
  - the table view and data search
  - stats, insights and anomalies, and quality checks
  - pivot, cohort and funnel
  - drivers, segments, scenarios, LOD and joins
  - snapshots
- One e2e for the live dataset screen, against a DuckDB-dialect fake connector registered only in
  the test harness, with both themes screenshotted.

**L2.7 Usage and budget** · M
- Migration (additive): `live_usage(org_id, day, queries, bytes)`, upserted per warehouse call so the
  count is shared across pods.
- Limits: `LIVE_DAILY_QUERY_LIMIT` per org (past it, figures are served from cache or labelled
  stale, and admins are told), `LIVE_MAX_CONCURRENT` per org per pod, and a cache floor for
  published `/p/` pages (`LIVE_MIN_CACHE_AGE_PUBLIC_SEC`, so a public link can't be used to run up
  the warehouse bill).
- Admin page: queries and bytes per day per connection, so the warehouse bill is never a surprise.

**L2.8 Parity on real engines** · M
- Run the L2.2 parity matrix against real engines:
  - **Postgres in CI** (the Redshift dialect's portable subset; CI already has Postgres)
  - **ClickHouse** in a nightly container
  - **Snowflake and BigQuery** nightly, against real accounts
- Divergences found are pinned as named, tested exceptions (like the U+FEFF one), never loosened
  silently.

**L2.9 Operator docs** · S
- `docs/server/live-data.md`: the Snowflake read-only role SQL, BigQuery IAM, how cost is bounded,
  choosing a cache age, and the refresh URL with dbt and Airflow.
- Every new env var goes in `docs/server/configuration.md` (`test-serverDocs`).

### Phase L3 — Fresh on ask (Postgres, MySQL and other copies)

**L3.1 Pull the new rows before answering** · M
- Per dataset: `freshOnAsk: { maxStalenessSec }`, only when incremental refresh is on.
- When a chart, tile or answer touches a copy older than that, start an **incremental** refresh
  (never a full one), single-flight across pods (L0.4).
  - Wait up to `FRESH_ON_ASK_WAIT_MS` (5 s). If it finishes in time, answer fresh.
  - Otherwise answer from the copy with "As of 1:00 AM · refreshing…", and L0.1 updates it when done.
- At most one fresh-on-ask refresh per dataset per staleness window. A dashboard load checks each
  dataset once.
- Tests: the due rule as a pure function; integration against a scratch Postgres (insert rows, ask,
  see them).

**L3.2 Live on a Postgres read replica (opt-in)** · S
- Redshift's dialect already exists after L2, so Postgres-family live is cheap. It is offered behind
  a checkbox, "This is a read replica or a warehouse", and the UI says why it matters.

### Phase L4 — After the core (to be planned with numbers)

- **Series and top N in the resident layer**, and **AI answers on extracts through the resident
  path**. Today they load every row, which is slow at 1M rows.
- **Joins across datasets** (Omni's topics): compile a join when both datasets live on the same
  connection; `analysis/relationships.ts` already holds the relationships.
- **AI notes and synonyms per dataset** ("revenue means `net_amount`, completed orders only"):
  Omni's `ai_context`.
- **Server requery:** roll up or re-filter a cached live result in our DuckDB without a warehouse
  trip.
- **Run as the viewer:** per-user OAuth to Snowflake and BigQuery, so the warehouse's own row-level
  security applies.
- **More live dialects:** Synapse, Trino/Presto, StarRocks/Doris.
- **Pivot on live**, and a **shared cross-pod result cache** in Postgres if per-pod caches cost too
  much.

---

## 6. Order

```
L0.1 ─ L0.2 ─────────────────────────────────────────────── (quick wins, ship first)
L1.1 ─ L1.2 ─ L1.3 ─ L1.4 ─ L1.5
            L2.1 ─ L2.2 ─ L2.3 ─ L2.4 ─ L2.5 ─ L2.6 ─ L2.7 ─ L2.8 ─ L2.9
                   (L2.2 can start beside L1: its DuckDB dialect needs no warehouse)
L0.3 ─ L0.4 ─ L0.5 ─ L3.1 ─ L3.2      (independent; any time after L0.2)
L4 …
```

| Phase | Tasks | Size |
|---|---|---|
| L0 | 5 | S, S, M, S, M |
| L1 | 5 | S, M, M, S, S |
| L2 | 9 | M, **L**, M, M, M, M, M, M, S |
| L3 | 2 | M, S |

---

## 7. Threat model additions

These go into `docs/phase-7-web/threat-model.md` with the PR that introduces each one.

| # | Risk | Control |
|---|---|---|
| R-L1 | SQL injection through a filter value | Bind parameters only (D4); identifiers only from the stored schema; an adversarial literal suite per dialect. |
| R-L2 | A warehouse bill run up by a viewer, a leaked hook or a public link | Cache floor on `/p/`; daily limit and concurrency cap; BigQuery max bytes billed; timeout + cancel on hang-up; hooks coalesced, 1/min. |
| R-L3 | Key theft via a crafted BigQuery key file | `token_uri` pinned to Google's; keys in the secrets store; canary tests. |
| R-L4 | SSRF via the Snowflake account name | Account regex; we build the host; the SSRF guard on every socket. |
| R-L5 | One org seeing another's cached live result | `orgKey()` in every live cache key; a two-org test with the same dataset id (the import case). |
| R-L6 | Warehouse error text leaking SQL or names to a browser | Errors pass `safeError` and the origin redaction; no SQL text reaches a browser (`dataset:source` rule). |
| R-L7 | A refresh URL used for more than a refresh | A capability for one dataset and one action; sha256-stored, shown once, revocable, audited, rate-limited. |
| R-L8 | A wrong number that looks right (silent zero, an unrouted reader) | `getDataset` refuses live (D6); unsupported features refuse; parity tests; `live:*` outcomes on `/metrics`. |
| R-L9 | Warehouse rows reaching a model through the profile's sample values (L2.5): an injected instruction, or personal data sent to a model provider | Values withheld for marked, proposed and detected columns (fails closed); bounded per value, per column and per dataset; JSON-quoted and labelled as data; stripped from a bundle under the share policy. |
| R-L10 | The schema sync's sampling query run up the bill (L2.5) | One statement per sync, ≤ 1M (row, column) cells, the engine's sample clause; BigQuery priced first against `LIVE_MAX_BYTES_BILLED`; the executor's daily limit, slots and timeout; one sync per dataset across pods; daily, retried hourly. |

Unchanged and stated in the UI: a live query runs as the **connection's** warehouse identity, like
an extract does today. Project grants decide who may open the dataset. Per-viewer identity is L4.

---

## 8. New settings

| Variable | Purpose | Default |
|---|---|---|
| `LIVE_QUERY_TIMEOUT_MS` | Per warehouse query; cancelled after this | `60000` |
| `LIVE_MAX_BYTES_BILLED` | BigQuery ceiling per query (a connection can set lower) | `10737418240` (10 GiB) |
| `LIVE_DAILY_QUERY_LIMIT` | Warehouse queries per org per day; `0` = no limit | `10000` |
| `LIVE_MAX_CONCURRENT` | Live warehouse queries in flight per org per pod | `4` |
| `LIVE_MIN_CACHE_AGE_PUBLIC_SEC` | Cache floor for published `/p/` pages | `60` |
| `FRESH_ON_ASK_WAIT_MS` | How long an answer waits for an incremental pull | `5000` |
| `REFRESH_HOOK_MIN_INTERVAL_SEC` | Minimum gap between two calls of one refresh URL | `60` |

---

## 9. Every PR in this plan also

- passes `npm test`, `npm run lint` (zero findings) and `npm run test:web`, and the e2e for any
  screen it touches
- puts new server sentences through `t()`, then runs `node scripts/i18n-extract.js`
- keeps files under 500 lines (800 hard); `http.ts` does not grow
- treats `src/api/index.ts`, `routes.tsx` and `nav.ts` as append-only; a new channel gets a contract
  with the narrowest `access`
- adds a negative control with every new guard, and a canary test with every new secret field
- adds its env vars to `docs/server/configuration.md`, and a log entry with any measurement it made

---

## 10. Open questions for the owner

1. **Default cache age: 5 min?** Omni defaults to 6 h. Fresher costs more warehouse queries.
2. **Daily limit of 10,000 warehouse queries per org?**
3. **Real-account nightly tests** need a Snowflake account and a GCP project with billing, as
   GitHub secrets. Can you provide them?
4. **Snowflake sign-in by key pair or PAT only** (no password)?

---

## Sources

- Omni: [DuckDB complements BI](https://omni.co/blog/DuckDB-complements-BI),
  [Under the hood of Omni's intelligent cache](https://omni.co/blog/under-the-hood-of-omnis-intelligent-cache),
  [AI queries](https://docs.omni.co/ai/queries),
  [SQL generation](https://docs.omni.co/analyze-explore/sql/generation),
  [Caching](https://docs.omni.co/analyze-explore/performance/caching.md),
  [Cache policies](https://docs.omni.co/modeling/models/cache-policies.md),
  [Reset cache API](https://docs.omni.co/api/models/reset-cache.md),
  [Invalidate the cache with dbt or SQL](https://community.omni.co/t/invalidate-omnis-cache-with-dbt-or-sql/337),
  [AI optimization](https://docs.omni.co/modeling/develop/ai-optimization.md)
- Snowflake: [SQL API quickstart](https://quickstarts.snowflake.com/guide/getting_started_snowflake_sql_api),
  [Date & time functions (`WEEK_START`)](https://docs.snowflake.com/en/sql-reference/functions-date-time),
  [PAT with the SQL API](https://dev.classmethod.jp/articles/snowflake-sql-api-pat-try/)
- BigQuery: [Job resource (`dryRun`, `maximumBytesBilled`)](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job),
  [`jobs.insert` scopes](https://docs.cloud.google.com/bigquery/docs/reference/v2/jobs/insert),
  [read-only scope report](https://github.com/googleapis/nodejs-bigquery/issues/1362)
