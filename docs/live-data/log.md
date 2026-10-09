# Live data — task log

Measurements and decisions per task of [00-plan.md](00-plan.md). Newest last.

## 2026-10-09 — L1.1 Room for warehouse keys, L1.2 Snowflake (+ the Snowflake halves of L1.4, L1.5)

**Built.** `src/connectors/snowflake.ts` (the family: fields, the SQL API protocol, run, listTables,
describeTable, `live.runBound`), split by job into `snowflakeAuth.ts` (account → host, JWT, the JWT
cache), `snowflakeShape.ts` (rowType → ColumnType, value decoding), `snowflakeSql.ts` (the F3 cap,
bindings) and `snowflakeHttp.ts` (the socket). Registered in `FAMILY_MODULES`; logo `siSnowflake`.
`incrementalSql.ts` gains the `snowflake` dialect. Web: `SecretTextarea`, the masked multi-line
secret control (new-connection form, and the rail's "Key saved" → Replace).

**Decisions (and where they depart from the plan's wording).**

- **One secret field for the key or the PAT** (`token`, a textarea), not two. Both would land in the
  same `token` slot (`connectionSecrets.ts`: everything but `password` shares it, first writer wins),
  and `secretStatus` would show both as "Set" when only one is. The `auth` select says which it is; a
  PEM in PAT mode is refused before a socket opens, so a private key can never go out as a bearer.
- **FIXED wider than 15 digits is not declared a number.** Snowflake's `INTEGER` is `NUMBER(38,0)`:
  "precision > 15 → text" would make every integer column unsummable, and "→ number" would turn a
  20-digit id into null (parse.ts refuses a lossy number). It is left undeclared, so parse.ts decides
  from the values, as for a CSV or a Postgres `bigint`: a 16+ digit id keeps the column text
  (`test-connectorsSnowflake`: `ORDER_ID` → text), small values make it a number (`ID` → number).
- **REAL for an extract is printed at 15 significant digits** (DBL_DIG; Postgres's default before
  v12), because `0.30000000000000004` would otherwise be nulled by parse.ts's strict rule. `runBound`
  (live) keeps the exact double.
- **DATE / TIMESTAMP_NTZ bindings use the API's documented value formats**, epoch milliseconds and
  epoch nanoseconds, converted from the ISO string a `LiveParam` carries, rather than the ISO string
  itself. The session runs with `TIMEZONE = 'UTC'`.
- **A transport of its own over `safeFetch`, not `httpRequest`.** The SQL API gzips result partitions
  after the first; `httpRequest` decodes every body as UTF-8 text, which destroys gzip bytes, and has no
  abort signal. `http.ts` cannot grow, so `snowflakeHttp.ts` (111 lines) adds the clock, the byte
  ceiling, bounded gunzip and the signal over the same SSRF guard.
- **Sync submit, cancel when the handle lands.** The submit is sent without `async=true`, as the
  plan says. A submit still in flight when the caller gives up has no handle yet, so the caller is
  answered at once, and the statement is cancelled as soon as its 202 arrives. The statement's own
  `timeout` stops it on Snowflake's side in any case.
- **Test connection warnings.** `ConnectorTables` gains an optional `warnings` (a compatible change to
  `types.ts`), which `connectionRun` passes through and `connection:testAndSave` /
  `connection:listTables` / `connection:replaceSecret` return. The one sentence so far
  (`adminRoleWarning`) is in `src/connectors/connectorMessages.ts`, a new `MAIN_FILES` sentence file.

**Measured** (4 vCPU container, Node 22, medians):

| What | Result |
|---|---|
| Key-pair JWT, 2048-bit key, AES-256-CBC PKCS#8: sign (decrypt + sign) / cache hit | 1.43 ms / 0.006 ms (21 runs) |
| Shaping 100k values of one type (`shapeFirst`, extract) | FIXED 17–33 ms, TEXT 14.5, REAL 110, DATE 156, TIMESTAMP_TZ 158, TIMESTAMP_NTZ 181 |
| Gzip bomb (64 MB of zeros, 64 KB on the wire) against a 1 MB ceiling | stopped, reported truncated, in < 3 s |

Timestamp shaping costs what `toISOString()` costs, which the Postgres path already pays per cell in
`connectionRun` (a `Date` → ISO string). Removing BigInt from the epoch arithmetic changed nothing
measurable (626 → 678 ms for 100k × 8 columns, within noise), so the cost is the formatting.

**Tests.** `test-connectorsSnowflake` (88 checks: the account guard with 2,000 fuzzed inputs and a
negative control, request/JWT/QUERY_TAG, `crypto.verify` of the JWT, the JWT cache per org, every
binding type, 13 adversarial literals, every rowType incl. TZ offsets and U+FEFF, partitions,
truncation at the cap, 202 polling, cancel on abort in a poll and mid-submit, cancel on timeout,
listTables/describeTable, and the secret canary over every result, error, request and printed line),
`test-connectorsSnowflakeHttp` (9: SSRF refusal with a negative control, redirect refused, gzip,
gzip bomb, byte ceiling, timeout and abort tear the socket down), `test-incrementalRefresh` §8 (the
cursor predicate pushed to a fake SQL API through a real refresh), `test-connections-server` (the key
and passphrase through `testAndSave` into the encrypted store, `secretSet` booleans only, the
admin-role warning, and the existing dump/disk/reply/log greps extended to the new canaries),
Vitest for the masked control and the rail's Replace, and the connections e2e.

**Not done here.** BigQuery (L1.3, a sibling task). The real-account nightly
(`test-warehouseLive`, `warehouse-nightly.yml`) and the README / CLAUDE.md counts belong to the
reconciliation after both connectors merge.


## 2026-10-09 — L1.3 BigQuery connector (+ the BigQuery halves of L1.4 and L1.5)

### The read-only scope spike: NOT RUN

The plan's first step for L1.3 is a spike: does `jobs.query` accept the `bigquery.readonly` scope,
and does Google then refuse a write? There is no GCP account to run it against, so it is
**unverified**. What was checked instead is Google's own machine-readable API description — the
BigQuery v2 discovery document, revision `20260922`, fetched 2026-10-09 from
`https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest`:

| Method | Scopes the discovery document accepts |
|---|---|
| `jobs.query`, `jobs.getQueryResults`, `jobs.get`, `datasets.list`, `tables.list`, `tables.get` | `bigquery`, `cloud-platform`, `cloud-platform.read-only` |
| `jobs.insert` | `bigquery`, `cloud-platform`, `devstorage.*` — **no read-only scope** |
| `jobs.cancel` | `bigquery`, `cloud-platform` — **no read-only scope** |

Two further facts from the same document:

- **`bigquery.readonly` is not in the API's scope list any more** (it lists `bigquery`,
  `bigquery.insertdata`, `cloud-platform`, `cloud-platform.read-only`, `devstorage.*`). The read-only
  scope the document names for `jobs.query` is `cloud-platform.read-only`.
- **`QueryResponse` now carries `statementType`**, so a `jobs.query` dry run says what a statement
  is, under the same scopes as the query itself. The plan assumed the dry run needed `jobs.insert`,
  which no read-only scope covers.

### What the code does instead — safe whichever way the spike comes out

1. **The query token asks for `bigquery.readonly` AND `cloud-platform.read-only`.** Both are
   read-only; the second is the one the discovery document lists for `jobs.query`.
2. **Every statement `run` sends is dry-run first** (`jobs.query` with `dryRun: true`, free) and
   refused unless `statementType` is `SELECT` — and refused when the field is missing. The dry run
   is of the exact text that then runs, the row-cap wrapper included. `live.runBound` skips it: its
   SQL is compiled by the app, never typed, and a dry run would double each chart's latency.
3. **`jobs.cancel` gets its own token with the `bigquery` scope**, minted only when a job must be
   cancelled and used for that URL only. Every query also carries `jobTimeoutMs`, so BigQuery stops
   the job itself if the cancel never arrives.
4. **A 403 "insufficient authentication scopes" is reported as exactly that**, naming the two scopes
   and `docs/server/live-data.md`. Ordinate does not widen the scope to work around it.

| If the spike finds… | Then |
|---|---|
| the read-only scopes work and Google refuses a write | Read-only is enforced by Google; the dry run is defence in depth. |
| they work but a write goes through | The dry-run gate and the IAM roles (Data Viewer + Job User) hold. |
| Google refuses them for `jobs.query` | Every BigQuery query fails with the scope sentence. Decide with the owner: drop to the `bigquery` scope and rely on the dry run + IAM. |

To close it with an account: mint a token with the two scopes, `jobs.query` `SELECT 1` (expect 200),
then a `CREATE TABLE … AS SELECT 1` into a dataset the account may write (expect 403); record the
result here. `scripts/test-warehouseLive.ts` (L1.5, not built here) is where that belongs.

### Decisions

- **Number columns keep BigQuery's strings.** `INT64`, `NUMERIC`, `BIGNUMERIC` and `FLOAT64` arrive
  as strings; the cells stay those strings and the column declares `columnType: 'number'` only when
  every value passes `parse.ts`'s `isFiniteNumber`. One id over 15 significant digits makes the
  whole column text, as the CSV detector would — declaring `number` regardless would have the
  dispatch's `coerceValue` turn that id into `null`. Keeping the string also keeps `-0.0` as `-0`
  through the dispatch (a float round trip prints `0`).
- **TIMESTAMP is converted exactly.** BigQuery sends epoch seconds, often in E notation
  (`1.7044176E9`); the digits are shifted as a decimal (BigInt), never multiplied as a float, to a
  millisecond UTC ISO string like every other connector's `Date`. Differential check: 2,000 random
  instants between years 1 and 9999, in decimal and E forms, equal `new Date(ms).toISOString()`.
- **The incremental cursor literal differs from the plan's `TIMESTAMP('…')`.** BigQuery refuses to
  compare a `DATE` or `DATETIME` column with a `TIMESTAMP` (no implicit coercion), and `DATE` is the
  usual partition column — a typed literal would turn every such incremental refresh into a full
  scan. An untyped string literal *is* coerced to the column's own type, so the pushed predicate is
  `` `col` >= 'YYYY-MM-DD' `` (the bound's day: one more day of superset, which the JS cut absorbs),
  and the bare column keeps partition pruning.
- **The editor's estimate** is a new channel, `connection:estimate` (access `write`, like explain),
  answered from `live.estimate`; the catalog reports `estimates: true|false` so the web editor only
  calls it for a source that can price a statement. The "~1.2 GB" label is formatted server-side.
- **Explain still bills on BigQuery**: `connection:explain` runs the statement bounded to one row,
  which BigQuery bills as a full scan. A dry-run explain (its `schema`) is a follow-up; the estimate
  next to Run shows the size first.
- **The abort signal**: `ctx.signal` when the caller sets one, else the request's own (a closed tab),
  read from the request context. An abort while `jobs.query` is still in flight cancels the job when
  its id arrives.

### Tests

No live service was measured. Off recorded REST-shaped fixtures (`scripts/fixtures/bigquery/`) and an
injected transport: `test-connectorsBigquery` (104 checks), `test-bigqueryBounds` (51),
`test-incrementalMerge` (+4: the BigQuery dialect), `test-incrementalRefresh` (+6: an end-to-end
incremental run that pushes the predicate), `test-connectors` / `test-icons` (the registry, 39
connectors), and `estimate.test.tsx` (3, Vitest).

The editor estimate was looked at in both themes against the built server, booted in-process with
the fake transport injected (an ad-hoc script, not committed): "~1.2 GB" by Run for a SELECT, a muted
"No estimate" carrying the refusal for a DELETE. `connections.e2e`'s picker spec passes and shows the
BigQuery tile in both themes; its main flow cannot run on this machine, because it signs in to the
source Postgres with a canary password that only a `trust` pg_hba (as in CI) accepts.

## 2026-10-09 — L0.3 Refresh every 5 or 15 minutes · L0.4 One refresh at a time, across pods

- **Built.** `'5min' | '15min'` join `AutoRefreshEvery`; one cadence table
  (`src/data/refreshCadence.ts`) now feeds the sanitizer, the scheduler, the Pipelines view and the
  RPC checks instead of five hand-kept lists. The fast cadences need incremental refresh on, refused
  at the sanitizer (a stored one reads back as no schedule), at `setAutoRefresh` and at
  `dataset:update` / `pipelines:setNodeSchedule` with a catalog sentence
  (`src/data/refreshMessages.ts`). The tick queues due INCREMENTAL refreshes as jobs, most overdue
  first, without waiting for them; full refreshes stay serial and awaited. A scheduled run records
  `lastAutoMs` (queued → finished); longer than its cadence is `behindSchedule` on the summary.
  Cross-pod: `src/server/jobs/refreshLock.ts` (`pg_try_advisory_lock(hashtext(org || ':' || id))`
  on a dedicated pooled client, released in `finally`), held by every refresh job;
  `src/data/refreshJob.ts` `startRefresh` / `refreshRunning` are the door L0.5 and L3.1 call.
- **Measured** (`scripts/test-refreshLock.ts`, local Postgres 16, loaded dev machine): lock + unlock
  around a refresh while a second pool races for the same key, 20 rounds — median 1.4 ms, max 15 ms;
  exactly one of the two ran every round. Two real server processes asked over RPC to refresh one
  dataset at the same instant (each refresh held 2.5 s): one refresh ran, the other pod answered
  `alreadyRunning`, in all 4 rounds (one of them a failing refresh, after which the lock was free);
  with the lock switched off (negative control) both ran, overlapping.
- **Measured** (`scripts/test-refreshQueue.ts`): a tick with 5 incremental refreshes due returned in
  24 ms with all 5 queued (3 running, 2 waiting, in most-overdue order); before, the tick awaited each
  refresh in turn. Never more than 3 fetches in flight (jobs `MAX_RUNNING`).
- **Found and fixed:** a job that waited in the queue started inside the async context of whichever
  job finished first (`AsyncLocalStorage` follows the promise that called `pump()`), so on a pod
  serving two orgs a refresh queued by org B could run as org A. Queued jobs now start in their
  submitter's context (`AsyncResource.bind` at submit). Queuing refreshes made this common, so it
  is fixed here; `scripts/test-jobs.ts` pins it.
- **Found and fixed:** a checked-out `pg` client has no pool `'error'` listener, so a lock
  connection lost mid-refresh (database restart) would have been an uncaught error that kills the
  pod. The held client carries its own listener; the test kills the session mid-refresh.
- **Decided:** "most overdue" is time past due, not a share of the interval — a weekly table a day
  late is staler than a 5-minute one ten minutes late. A dataset already refreshing when it comes
  due is skipped and NOT stamped, so the next tick asks again. Turning incremental refresh off under
  a fast schedule drops it to hourly in the same write rather than leaving the sanitizer to turn it
  off silently. hashtext collisions only serialize two datasets; they never let one run twice.
- **Not done (scope):** the web app has no incremental-refresh settings panel since T8.1
  (`incremental:set` was not ported), so a fast cadence is only selectable on a dataset whose
  incremental refresh was turned on before (desktop import) — the picker shows the fast options
  greyed, saying why. `connection:refresh` (the workbench's "Refresh now") and the MCP
  `datasets refresh` tool still call the refresh directly, outside the job and the lock.

## 2026-10-09 — L2.2 The compiler

- **Built.** `src/engine/live/`: `liveSpec.ts` (the IR, typed refusals, and the adapters
  `fromVizEncoding` / `fromAnswerSpec` / `fromMetric`, each taking exactly what `vizDataFor`,
  `computeCard` and `metricFor` take today); `compile.ts` + `compileFilter.ts` (IR + dialect +
  source + declared columns → one statement and its `LiveParam[]`: the latest-date `MAX()`, the
  bin range, the grain probe, the chart, the metric); `dialects/{snowflake,bigquery,redshift,
  databricks,clickhouse,duckdb}.ts` behind `dialect.ts`; `sqlParams.ts` (placeholders numbered
  from the FINISHED text, so a CTE built out of order still binds `params[i]` to the (i+1)-th
  placeholder, and a fragment used twice binds twice); `shape.ts` (rows → `{labels, series}` +
  `CategoryInfo`, or the metric number); `evaluate.ts` (`evaluateLive(ir, env, run)`, the step
  order for L2.3, and `resolvePeriods`). Refusal sentences: `src/engine/liveRefusals.ts`
  (catalog keys `liveRefusals.*` — not `liveMessages.*`, which L2.1 uses; drafts translated).
  `categoryKey.gregorianBucketLabel` is the calendar-free half of `dateBucketLabel`, so a label
  follows the calendar the query was compiled under.
- **Measured** (`scripts/test-liveParity.ts`, DuckDB bench, this container): 1,090 charts, 108 KPI
  values and 112 AI answers through both paths — extract = `vizDataFor` / `computeCardMetric` /
  `computeCard` over a real stored dataset (1,060 rows, so KPIs take the resident path), live =
  adapt → compile → DuckDB → shape — 2,313 live statements, ~40 s wall. Everything agrees.
  Largest sum/avg deviation **1.0e-15** relative over 1,470 figures (tolerance 1e-13).
- **A 1e15 outlier is a summation-order test, not a compiler test.** With 1e15 among ~1,000 small
  cells the deviation reached **8.9e-14**: every later addition rounds at 1e15's ULP (0.125), a
  BIASED error of ~n·ε whose size depends on the order of addition. Inherent to parallel
  summation, so the fixture holds no huge outlier and the documented 1e-13 stands.
- **Two summation orders inside live, too.** A split ranks a category by the window total of its
  per-series sums, the flat chart by a direct sum: measured 241.9 vs 241.89999999999998 for two
  categories equal in exact arithmetic, swapping their order. Both are live's rule; the parity
  test accepts a swap only within the float tolerance.
- **Order is explicit, and differs from the extract on purpose.** Live orders dates and bins
  ascending and text by the first measure (largest first), each ending on the key, NULL last; the
  extract is first-seen. The UI note belongs to L2.6.
- **Named divergences, each pinned** (`scripts/liveParityPins.ts`, `scripts/test-liveCompile.ts`):
  1. ties AT the 50 cut — the extract keeps the first-seen, live the smaller label;
  2. ties AT an answer's top-N cut — the same;
  3. a split answer's top N — live ranks by the category total, the extract by the first series
     (`answers.ranked` reads `series[0]`);
  4. sum/avg/min/max over a non-number column — live refuses, the extract draws nulls;
  5. `contains` on a number column, a split by a date column, a period on a non-date column,
     `within_km`, raw points, pivot/cohort/funnel/drivers/facets/maps/related fields — refused;
  6. a date the warehouse holds as a TIMESTAMP — buckets and periods agree; a text comparison
     (`=`, `<`, `in`, `contains`) compares the DAY on live, the stored timestamp text on the
     extract;
  7. −0 — DuckDB stores −0.0 as 0 and an extract stores `String(-0)` = `'0'`; live shaping turns
     any −0 a warehouse returns into 0;
  8. an answer's data-relative period with no dates warns after the adapter's own warnings (the
     extract interleaves by filter position).
- **Found in the existing extract path** (reported, outside L2.2): `sqlGen.WS_CLASS`, the resident
  layer's "empty" class, is narrower than JS `trim()` — it misses U+1680, U+2000–U+200A, U+2028,
  U+2029, U+202F, U+205F and U+3000, so a cell holding only those is empty to
  `transforms.isEmptyCell` and not to the resident `count` / `is_empty` (pinned: the resident chart
  counts 5 where JS counts 1). Live spells JS's class in full and agrees with JS. Inherited and
  unchanged: a text ORDERING filter over astral characters (DuckDB bytes vs JS UTF-16) — live agrees
  with the resident path, not the JS fold.
- **For L2.3 / L2.4.** Wrap `run(query, step)` (rows positional to `query.columns`) with the cache,
  the budget, `runBound` and the abort signal. Concatenate `adapted.warnings` and
  `outcome.warnings`; `recommendedShape` stays `recommendChartType(columns, encoding)`. Live
  answers are already ranked and cut — do not apply `answers.ranked` again. Text-filter case fixing
  stays L2.4's cached DISTINCT query (the IR carries values as stated). FX conversion, LOD and
  parameter replay are not in the IR: route or refuse them before the adapter.
- **To verify on real engines (L2.8).** Only DuckDB executes here; the other five are golden shapes:
  ClickHouse `match()` over UTF-8 and `{p:Type}` values; `TRIM(x, chars)` on BigQuery and
  Snowflake, `btrim` on Databricks and Redshift; Snowflake under `WEEK_START = 1`; Databricks
  `trunc(d, 'WEEK')`; the tie order of text under each engine's collation.

## 2026-10-09 — L0.1 Dashboards update themselves after a refresh · L0.2 Every figure says how fresh it is

- **One announcement, every door.** `refreshAsJob` (`src/data/refreshJob.ts`) announces a SUCCESSFUL
  refresh as `hub:dataset-refreshed` through `src/data/refreshEvents.ts` → the scheduler's
  `pushToReaders` (project readers only, every pod over LISTEN/NOTIFY). That covers the dataset
  row's / dashboard's ↻, the scheduler's tick and pipeline runs, and is the door L0.5's hook and
  L3.1's fresh-on-ask will use. The tick's reporter (`src/server/jobs/schedules.ts`) now pushes only
  a FAILED scheduled refresh, so a scheduled success is announced once. **Negative control,
  measured:** with the reporter also pushing successes, `test-jobs-pods` fails — every tab on both
  pods gets the tick's event twice.
- **Also announced:** a SQL dataset re-run downstream of a change (`datasetDependents`) — without it
  a dashboard over a query on the refreshed table (or on an input table just edited) stayed stale.
- **Payload:** the scheduler's `{ projectId, datasetId, name, ok, rowsBefore, rowsAfter }`, minus the
  tick's optional `alertsFired` on a success (counted after the refresh lands; no tab reads it — the
  alerts arrive as `alerts:fired`).
- **Measured, e2e** (`web/e2e/freshness.e2e.ts`, built server, Chromium, dev sign-in): a dashboard
  open in one page, the rows edited in another → the KPI redrawn without a reload in 812–839 ms;
  `dataset:refresh` from the other page → the caption moved in 749–1,189 ms (four runs; both include
  the 500 ms debounce and the refresh job itself). **2 RPCs per redraw** (one `analysis:tiles` batch for every tile on the sheet + one
  `dashboard:asOfStamps`); the dashboard's own load is 10 (budget 25).
- **Measured, two pods** (`test-jobs-pods`, Postgres 16): a manual `dataset:refresh` on pod A reaches
  every reader's tab on A and B exactly once; another org's tabs get nothing.
- **Decided — reconnect re-reads every FIGURE query, not every query.** After a dropped stream the
  events in between are lost, so every query in the invalidation map is re-read; an open editor's
  own document (`analysis:open`, `prepare:get`, staleTime Infinity) is not, or a reconnect would
  re-read the record under the person editing it.
- **`asOf`** (`src/api/asOf.ts`, one shape, types-only on the web): `{ at, mode, cached?, stale?,
  refreshing? }`. An extract is `{ at: lastRefreshedAt, mode: 'extract' }`; never refreshed → the
  rows' `createdAt` (a rename or a prepare edit bumps `updatedAt` without the data being newer); an
  input table or a capture → its last edit. A figure of several datasets is as old as its stalest.
  On `visual:data`/`visual:dataBatch`, `visual:preview`, `dashboard:metric`, `metric:value(s)`,
  `stats:tile`, every `analysis:tiles` tile and `answer:card`; `dashboard:asOfStamps` gains `latest`
  (the sheet's stalest) for the As-of picker's "Latest".
- **Decided — stamped outside the answer cache.** A refresh writes the table, then its markers
  (`markRefresh`), so a cached answer would keep the old time; `test-figureAsOf` moves the marker
  with no data change and the caption follows while the figure is reused. Inside an as-of read the
  stamp is the snapshot's time (the metadata IS the snapshot's).
- **Measured, the stamp's cost** (one metadata read per reply; 1,000 single stamps, 50 batches of
  50 in parallel): records as files — 0.08 ms median, 0.15 ms p95; a 50-tile batch 3.8 ms median.
  Records in Postgres — 0.50 ms median, 5.1 ms p95; a 50-tile batch 22 ms median, 77 ms p95 (50
  reads of one row through the pool). Same order as the `answerKey.keyParts` read each tile already
  makes; a per-request memo is the fix if a 50-tile sheet ever feels it.
- **AI:** the answer facts gain `Data as of: Oct 9, 2026, 1:00 AM UTC.` — UTC and labelled, because
  the server does not know the reader's zone and a model must not convert one. `numberAudit` masks a
  clock time and a month-and-day so a narration repeating it is not accused, and those digits never
  enter the ledger; "March 12 orders", "May 3.5 million" and a figure beside a time are still
  audited (tests in `test-numberAudit`, `test-answerFacts`).
- **UI:** `web/src/ui/asOf.ts` words every variant later phases will set ("As of 1:00 AM", "Live ·
  2:05 AM", "Live · cached 3 min ago", "Stale · as of …", "· refreshing…"); over a day old takes
  `--warn` plus an icon. Shown in each dashboard card's head (charts, KPIs, statistics; Present
  included), on answer cards, beside the builder's preview, and in the As-of picker's "Latest".
- **Not changed:** the published `/p/` page is a snapshot with its own publish time;
  `sanitizeBundle`'s whitelist drops the new field, and nothing was added to it.
- **Environment:** in this sandbox OpenStreetMap tiles are unreachable (`ERR_TUNNEL_CONNECTION_FAILED`),
  so the e2e flows over the sample dashboard's map fail on the base commit and on this branch alike;
  with the tiles stubbed locally (not committed) `dashboards`, `analyses` and `visuals` pass in full.

## 2026-10-09 — L2.1 The Live record and the safety net

- **Built:** `Dataset.mode` / `live: {maxCacheAgeSec, epoch, schemaSyncedAt}` in the record
  (`src/data/liveDataset.ts`, no migration); declared types per dialect (`liveSchema.ts`); the
  record writers (`liveRecord.ts`); `connection:import {mode:'live'}` and the new `dataset:setMode`
  (`src/ipc/liveDatasets.ts`, contract in `src/api/live.ts`); `runBound` on Redshift (`$n`,
  `postgres.ts`), ClickHouse and Databricks SQL (`liveHttp.ts`); the `live` flag in the connector
  catalog; `dataset:source` gains `live`, `maxCacheAgeSec`, `canGoLive`.
- **http.ts made room, then shrank:** the transport, JSON, accessors, base URL, row cap and the two
  response shapes moved to `httpShared.ts` (re-exported, so `http.httpRequest` / `MAX_BYTES` and
  the self-check are untouched). http.ts 1,035 → 744 lines, so its `test-file-size` ALLOWED entry is
  removed rather than lowered. The transport gained an optional `signal` (abort = socket destroyed).
- **Safety net, measured by `test-liveSafetyNet`:** every row-reading channel enumerated from the
  `src/api/` contracts that take a dataset refuses a Live dataset, typed; the first run found the
  refusal silent in 9 places and fixed each — `dataset:distinct` (`{values:[], total:0}`),
  `insights:list` (`[]`), `metric:values` (a bare `ok:false`), `quality:run` (no rules → `ok`),
  `prepare:get`, `sql:run` (a wrong "saved before Parquet" message), `snapshots:*`, the alert
  periods/anomaly readers (`null`/`[]` → drivers said "fewer than two periods"), and the
  project-wide walks that broke instead of skipping (value search, privacy scan; Home insights and
  bundles skip too). The MCP `datasets.list/describe` report `rows: null` and `mode: 'live'`
  instead of a zero.
- **Decided — typed refusal without editing 137 catch sites:** most handlers turn any throw into
  `{ok:false, error: err.message}`. The RPC route walks a reply for the refusal's exact sentence and
  adds `code: 'live_dataset'` (per item in a batch, so one Live tile never fails a dashboard), but
  only when a `LiveDatasetError` was constructed during the call (a process counter) — zero cost on
  every other request. An uncaught one is 409 `{code:'live_dataset', message}`.
- **Decided — Databricks submits asynchronously (`wait_timeout: 0s`) and polls** (100 → 200 → 400 →
  800 → 1,000 ms) so an abort or a blown budget can POST `…/statements/<id>/cancel`; the synchronous
  `run` path cannot name a statement it is still waiting on. Costs one extra round trip per query.
- **Decided — Redshift keeps `run`'s row-cap wrapper** (`select * from (\n…\n) limit n+1`): the
  compiled ORDER BY's order survives a plain projection in Postgres (pinned below) — L2.8 re-checks
  it on Redshift. Cancel is `pg_cancel_backend(pid)` from a second session on the same pinned address.
- **Measured (local Postgres 16 standing in for Redshift, `test-liveConnectors`):** 11 adversarial
  literals round-trip byte-for-byte through `$n`; a NUL is the server's refusal; the cap clips 10
  rows to 3 in order and reports it; an abort 400 ms into `pg_sleep(20)` answers "Cancelled"
  10–13 ms later (5 runs) and leaves nothing in `pg_stat_activity`. A bound round trip — connect,
  the read-only + statement_timeout guards, one `$1` query, close — is 5.7 ms (mean of 20, local).
- **Merged with L0.1–L0.4, L1.1–L1.3 and L2.2:** `isLiveCapable` lights up Snowflake and BigQuery
  too (they declare `live`), beside the catalog's `estimates`. A Live record drops any `autoRefresh` /
  `incremental` on load and `scheduledMetas` skips Live, so the 5/15-minute cadences and the job queue
  never reach one; `queueRefresh` (scheduler, pipelines, a future hook) answers the typed refusal;
  `dataset:refresh` and `connection:refresh` still bump the epoch, and now announce it
  (`hub:dataset-refreshed`, L0.1) so an open dashboard re-asks. `metric:values` keeps both the
  refusal and L0.2's `asOf`.
- **Not done here (by plan):** executor and cache (L2.3), routing charts / KPIs / answers (L2.4 —
  until then they refuse, as the suite asserts), the full Live UI (L2.6).

## 2026-10-09 — L1.4 and L1.5 finished: counts, the real-account nightly, the canaries

- **L1.4 checked, one gap filled.** Both dialects were in `incrementalSql.ts` (`snowflake`: `"…"`
  with doubling, `'…'::timestamp_tz` under the session's UTC; `bigquery`: one backtick path, a day
  literal — the BigQuery log entry above says why it is not `TIMESTAMP('…')`), the dispatch's table
  SQL quotes `` `project.dataset.table` `` (`connectionRun.quotedTable` → `quotedTablePath`), and
  `test-incrementalRefresh` §8 and §9 push the predicate end to end through each real connector.
  `test-incrementalMerge`'s per-dialect list had BigQuery but not Snowflake; it has both now.
- **Counts 38 → 40:** README (the two sentences, the connector table's heading, and Snowflake and
  Google BigQuery in its Cloud warehouses row, 7 → 9, in catalog order), CLAUDE.md (the sources
  count, the registry count, and `snowflake.ts` 1, `bigquery.ts` 1 in the family list); the stale
  "35" in four code comments. `test-icons` already pinned 40. Plan, phase-7 history and the
  dated `docs/superpowers/` notes keep the counts of their day.
- **The real-account test, `scripts/test-warehouseLive.ts`** (+ `warehouseLiveHarness.ts`,
  `warehouseLiveSnowflake.ts`, `warehouseLiveBigquery.ts`, split by job). It runs in server mode
  (the SSRF guard on) inside a request context, through `getConnector` and `connectionRun`, and
  only WATCHES the real transports through their seams. Without credentials it prints one skip
  line per warehouse and exits 0; with some but not all of one warehouse's variables it fails. The
  log prints no secret and no account identifier (a public repo's Actions log is public): every
  printed line and failure detail is redacted, while the canary greps the raw results and errors
  plus every printed byte for the key, passphrase, PAT, and every JWT, access token and assertion
  issued during the run — with a negative control in the suite. `.github/workflows/warehouse-nightly.yml`
  runs it at 05:41 UTC and on demand, `contents: read`, not a required check.
- **The scope spike, made answerable.** The BigQuery half records (`spike:` lines and the run's
  step summary): the scopes the query token asked for; the scopes Google granted, read back from
  `oauth2.googleapis.com/tokeninfo` (POST, bearer header, then form body); whether `jobs.query`
  accepts that token; and how a WRITE is refused — through Ordinate's estimate and run (the gate,
  or BigQuery's parser at the dry run), and sent straight to `jobs.query` with the read-only token,
  bypassing the gate. That write is a temp-table script, which needs no IAM grant, so a refusal can
  only be the scopes; with `BIGQUERY_SCRATCH_DATASET` it also tries the plan's `CREATE TABLE … AS
  SELECT 1` and drops the table if it was created. A verdict line maps the outcome onto the
  three rows of the table above. The answer is recorded, not asserted: every outcome is safe.
- **Canaries, re-checked.** Connector level was already complete for both (results, errors,
  requests, printed output; Snowflake also the catalog). Server level had Snowflake's
  testAndSave / list / listTables only and no BigQuery. `test-connections-server` now drives both
  through `connection:run`, `connection:explain`, `connection:estimate` (Snowflake: `null`;
  BigQuery: priced), `connection:listTables`, `connection:describe`, `connectors:catalog` and
  `connections:list`, including a warehouse whose every error echoes the bearer, the key and the
  passphrase (each reply must carry `***` and no needle). The BigQuery key's PEM lines and id, the
  Snowflake JWTs, and every BigQuery assertion and access token join the needles, so the existing
  database dump, `pg_dump`, disk, reply, trace-log and output greps cover them.
- **Not measured: no real account was available here.** The live test was exercised only against
  in-process fakes of both APIs (a scratch harness, not committed), including its negative
  controls: a passphrase printed mid-run and an access token returned in a row both fail the
  canary. What the fakes cannot settle, and the first nightly will: whether a Snowflake result
  of ~48 MB spans several partitions (asserted), the exact 422 body of a cancelled statement
  (`000604` or "cancel" asserted), BigQuery accepting `…Z` timestamp parameters and dry-running
  `ASSERT` and a script (either may be the gate's case), the scope answers, and whether a 450-step
  recursive CTE is still running ~10 s in, when the late cancel lands (chosen over a cross join,
  which the on-demand billing tier can stop on CPU first).

## 2026-10-09 — L2.3 The executor and the cache

- **Built.** `src/engine/live/liveQuery.ts`: `liveVizData(projectId, datasetId, encoding, filters)`,
  `liveMetric(projectId, datasetId, spec, filters)` and `liveAnswer(projectId, spec)` — exactly what
  `vizDataFor`, `computeCardMetric` and `computeCard` take, answering their success shapes (the chart
  + `recommendedShape`, `warnings`, `category`; the number; the ranked and cut chart + `notes` +
  `filterLabels`) plus `asOf {at, mode: 'live', cached?, stale?}`, or a typed `LiveFailure {ok: false,
  code: live_refused | live_unavailable | live_failed | live_timeout | live_cancelled, error, reason?}`
  whose `error` is a catalog sentence. Not wired into the doors (L2.4). Beside it: `liveTarget.ts`
  (record → connection → connector, dialect, source parts; the secrets read on the first warehouse
  call only, through the same `loadSecrets` a refresh uses), `liveBudget.ts`,
  `src/connectors/liveRun.ts` (the live ConnectorContext: `guardHost` — now exported from
  connectionRun — `costTag 'live'`, `maxBytes`, the timeout, the signal, `safeError`) and
  `src/engine/liveQueryMessages.ts` (6 catalog sentences). `queryCache` gains a per-entry `maxAgeMs`
  (and a per-lookup one; the tighter wins, so lowering a dataset's age applies at once), `peek` (any
  age, for the stale fallback) and a clock seam; nothing but live sets an age. `residentTrace`
  `recordLive` → `/metrics`. Settings `LIVE_QUERY_TIMEOUT_MS`, `LIVE_MAX_CONCURRENT` (env.ts, re-read
  per query like `LIVE_MAX_BYTES_BILLED`).
- **The test bench.** `scripts/liveFakeConnector.ts`: two defs (`live-fake`, `live-fake-net` with a
  host field) declaring the DuckDB dialect, running the compiled statement through the async bridge in
  the org's own worker; a spy (`fake.calls`) and a hook (hold, fail, slow). `LiveDialectId` gains
  `'duckdb'` (and liveSchema a DuckDB type table) — declared by no shipped connector, asserted. The
  registry gains `registerTestConnector`: resolvable by id, never in `listConnectors`/the catalog,
  refused under `ORDINATE_ENV=prod`. For L2.6: `startServer(env, { live: true })` seeds a fake
  connection + a Live dataset over a built-in `live_fake_orders` table (`seed.ts --live`,
  `seedLiveFake`) and starts the server with `ORDINATE_TEST_LIVE_FAKE=1` (env.ts refuses it in prod;
  the image ships no `scripts/`). Checked by hand against the built server: the flag registers the
  fake, `connection:listTables` runs it in the org worker, `connectors:catalog` does not list it.
- **Decided — one flight per question, cancelled by the LAST hang-up.** `queryCache.through` already
  shares a computation, but it cannot carry a hang-up: under it one closed tab would cancel the
  warehouse call every other viewer of the tile waits on. So live keeps its own in-flight map under
  the cache key: an asker who hangs up stops waiting at once, and the shared call (its signal +
  `LIVE_QUERY_TIMEOUT_MS` reach `runBound`) is aborted only when no asker is left; a later asker
  starts afresh rather than joining a cancelled call. The flight's body runs in the asker's context
  but under the SHARED signal, so anything that reads the request's signal (the DuckDB pool under the
  fake, a connector's fallback) obeys the same rule. A joiner counts as `hit` (no call of its own).
- **Decided — the key** is `orgKey('live' · project · dataset · epoch · schemaSyncedAt ·
  {ir, source, dialect})`: the plan's, plus the project and the source, so an origin edit that did
  not move `schemaSyncedAt` still cannot answer from the old statement. The period resolver's MAX()
  is its own entry, keyed by its statement: two answers over one date column ask it once.
  `asOf.at` is the OLDEST statement's time (a cached MAX() included).
- **Decided — no warehouse text in a reply at all**, stronger than redacting it: a warehouse can
  quote fragments of a defining query no redaction pass would recognise. The reply is a catalog
  sentence ("…an admin can find the reason in the server log"); the server log gets one line per
  failed STATEMENT (not per asker), `safeError`'d. The trace's once-per-op warning is the summary.
- **Decided — a sixth trace outcome, `cancelled`** (the plan names five): a closed tab is not a
  warehouse failure, and the once-per-op warning must not be spent on one. `failed` stays "a viewer
  saw an error".
- **Decided, smaller.** The stale fallback reads the exact key, so right after "Refresh" (epoch bump,
  and `refreshLive` also invalidates) a failing warehouse is an error, not the pre-refresh figure.
  Expired entries stay until the LRU's byte budget evicts them. A concurrency slot is held until the
  connector SETTLES, not until the caller stops waiting (a cancelled statement still winding down
  counts). A result past `LIVE_ROW_LIMIT` (100,000 groups) is a refusal (`tooManyGroups`), never part
  of a chart. `LIVE_QUERY_TIMEOUT_MS` is not clamped to the extract's 30 s.
- **Found by the parity check:** `computeCard`'s `filterLabels` hold EVERY filter's label in spec
  order ("region = North" beside "d: 2024-Q4"); `evaluateLive`'s `periodLabels` are the periods only.
  `liveAnswer` interleaves them, taking a non-period label from `specFilterSteps` itself.
- **L2.7's seams, one each, in `liveBudget.ts`:** `checkDaily(org, datasetId)` returns ok (L2.7:
  `live_usage` + `LIVE_DAILY_QUERY_LIMIT`). Its refusal is already handled — the stale answer, else
  `live_refused`/`dailyLimit` with the seam's own sentence — and tested through
  `setDailyCheckForTest`. `noteCall(org, datasetId)` is the per-call usage upsert (a no-op).
  `cacheAgeFloorSec()` (0) is the public-page floor, already applied in the age; L2.7 has to bring
  "this is a `/p/` request" to it — no flag carries that yet.
- **Measured** (`test-liveQuery`, 4 vCPU container, the fake over the 1,060-row parity fixture in an
  org's DuckDB worker; three runs): a cache hit **0.38–0.48 ms** median (n=200; it still reads the
  dataset record and the connection record — the epoch and the dialect — but no secret), a warehouse
  call **2.41–2.53 ms** median (n=40, one KPI statement, no network). A real warehouse adds 100 ms to
  seconds per statement. `LIVE_QUERY_TIMEOUT_MS=150` against a held statement answered `live_timeout`
  in 154 ms, the connector's signal fired.
- **Tests.** `test-liveQuery` (61 checks): 6 charts, 3 KPIs and 4 answers through the executor equal
  `evaluateLive` over the parity runner EXACTLY and the extract within 1e-13; hit inside the age / miss
  at it (fake clock, ±1 ms); an epoch bump misses with no invalidation; age 0 always asks, 5
  concurrent identical asks make ONE call (1 warehouse + 4 hits); one MAX() for two answers; stale on
  error; a typed error with nothing cached (NEGATIVE CONTROL: no data, no labels); the R-L6 canary
  (statement, defining query, host, table and secret planted in a returned and a thrown warehouse
  error: in no reply; the secret in no log line); R-L5 with two orgs holding the same ids; refusals;
  `/metrics`. `test-liveQueryBudget` (34): abort (the connector's signal fires, `cancelled` traced),
  a shared call surviving one hang-up and cancelled by the last, the timeout (typed, and stale when
  cached), `LIVE_MAX_CONCURRENT=2` (the third waits, peak 2 per org, another org not queued, a queued
  hang-up never reaches the warehouse), the daily seam, the live context (costTag, bytes, timeout, row
  cap), the SSRF guard (metadata address refused before `runBound`; NEGATIVE CONTROL: a public one
  pinned), the row cap, the registry and env guards. `test-queryCache` +6 (ages, `peek`).
- **For L2.4.** Route a Live dataset to these three BEFORE the extract's own answer cache
  (`answerKey.keyParts`, `queryCache.through('aggregate'|'metric')`): wrapping them again would pin a
  figure past `maxCacheAgeSec` and hide `stale`. `visual:data`'s stamp must keep the reply's live
  `asOf` instead of writing `lastRefreshedAt`. Refuse param replay, FX, LOD and drivers before calling
  (not in the IR). `liveAnswer`'s chart is ranked and cut already. Text-filter case fixing is still
  the cached DISTINCT query L2.4 owns.

## 2026-10-09 — L0.5 A refresh URL for dbt / Airflow

- **Built.** Migration `0011_refresh_hooks.sql` (`refresh_hooks`, forced RLS, the audit CHECK
  widened); `src/server/hooks/` — `store.ts` (token, hash, the claim, list/create/revoke under RLS),
  `route.ts` (`POST /api/hooks/refresh/<token>`, beside the file and MCP routes), `act.ts` (THE
  decision: refresh an extract through `startRefresh`, reset a Live dataset's cache through
  `refreshLive`), `rpc.ts` (`refreshHook:list|create|revoke`, contracts in
  `src/api/refreshHooks.ts`); `REFRESH_HOOK_MIN_INTERVAL_SEC`; audit actions `hook_refresh` and
  `scheduled_refresh` (the tick's reporter in `src/server/jobs/schedules.ts` now writes one per
  scheduled refresh that ran). Web: `RefreshUrl.tsx` (the panel), opened from the dataset page's
  ⋯ menu and from a connection rail's dataset row; the Audit tab's two new event names.
- **Decided — the refresh runs as the hook's CREATOR**, with their current role, re-checked on every
  call by `dataset:refresh`'s own rule (`authorize` with that contract). A hook is a credential a
  person minted, like a personal token, so it is never worth more than that person is now: disabled,
  removed or demoted → 403 and a `denied` row. A scheduled refresh stays `jobs@system` (it belongs
  to the dataset, not a person). The job lands in the creator's Jobs list; the audit actor is the
  creator. Under `AUTH_MODE=dev` (no users rows) the creator is the dev admin, as everyone is.
  `created_by` is therefore an email (the key every grant check uses), not a users FK.
- **Decided — the interval IS the claim.** One `UPDATE … SET last_used_at = now() WHERE … AND
  last_used_at <= now() - interval RETURNING …`: concurrent claims serialize on the row and the
  loser re-checks against the winner's stamp, on the database clock. A claim that is then refused
  (403) still spends the interval, which bounds audit rows a leaked URL can write too.
- **Decided — RLS that works without an org.** The URL names no org, so `refresh_hooks` has a second
  pair of policies keyed on `ordinate.hook` = the token's hash: a call sees and stamps exactly the
  row it holds the hash of; a member's call sees its org's rows (`ordinate.org`, as `records`).
- **Decided — revoked ≡ unknown**: same 404 body and headers, the same two SQL statements (the
  UPDATE, then a SELECT that would find a live row's wait), no audit row for either. Measured
  (`test-refreshHooks-db`, median of 15 calls over HTTP, loaded container): revoked 2.35 ms,
  unknown 2.24 ms (first run 2.88 / 2.91).
- **Decided — `cache_reset` is a third status**, not `queued`: on a Live dataset nothing is queued,
  the bump is done when the call is answered, and a pipeline can tell the two apart.
- **Decided — a personal API token cannot create a refresh URL** (as `tokens:create`): it would
  outlive the token's own revocation. The list is `audit: 'denials'`; create and revoke are `rpc`
  rows like `tokens:*` (no new create/revoke actions: the vocabulary has none for tokens either).
- **Decided — any body, any method.** dbt Cloud and Airflow send JSON, `curl -d` a form; the route
  has its own catch-all body parser (≤ 64 KiB, ignored), answers 405 to other methods, and matches
  every deeper path, so neither a 415 nor Fastify's "Route … not found" log line (which no serializer
  masks) can happen with a token in it. A pino `logMethod` hook masks `ordh_…` in every message as
  well; the request serializer masks the path.
- **Measured — across pods.** Two in-process apps on one database (two pools), both calling one URL
  at the same instant: exactly one 202 and one 429 in each of 4 rounds; two real server processes:
  the same in each of 5 rounds, and the dataset refreshed. NEGATIVE CONTROLS: a check-then-act claim
  on two pools lets both through; two different URLs of one dataset at once both get 202.
- **Deviation — the dbt snippet.** The plan says "dbt `on-run-end`". An `on-run-end` hook runs SQL in
  the warehouse and cannot call a URL without warehouse-side network setup, so the panel and
  `docs/server/live-data.md` show `dbt build && curl …` for dbt Core and a dbt Cloud "Run completed"
  webhook instead, and say why.
- **Not done (scope):** a pipeline cron's dataset refresh (`pipelineRunner`, also under the tick)
  still leaves no audit row; only the dataset scheduler's refreshes are `scheduled_refresh`. `connection:refresh` and the MCP `datasets
  refresh` tool still bypass the job and the lock (noted under L0.3/L0.4).

## 2026-10-09 — L3.2 Live on a PostgreSQL read replica (opt-in)

- **Built.** `ConnectorLive.optIn` (`src/connectors/types.ts`): the key of a non-secret checkbox a
  connection must have ticked before Live is offered for it. Data, not a function, so the catalog
  sends it (`CatalogEntry.liveOptIn`) and the web applies the same rule to a connection's values
  without a round trip; the server enforces it. `isLiveCapable(def)` now means CAN be Live (and is
  false for an opt-in naming no non-secret checkbox — fail closed); `isLiveOffered(def, values)`
  (`src/connectors/index.ts`) decides per connection, strictly `values[optIn] === true`.
  `src/ipc/liveOptIn.ts`: `liveOfferRefusal` (the catalog sentence) — asked by `connection:import
  {mode:'live'}` and `dataset:setMode` (`liveDatasets.ts`), by `dataset:source`'s `canGoLive`
  (`datasetViews.ts`) and by the executor on EVERY question (`liveTarget.ts`); and the new channel
  `connection:setLiveOptIn` (contract in `src/api/live.ts`, `write`). PostgreSQL, AlloyDB, Neon,
  Supabase and TimescaleDB declare the Redshift dialect + the opt-in field "This is a read replica
  or a warehouse" (`readReplica`, off by default, last on the form, its help the one-line why).
  Web: the form renders it generically; the workbench offers Copy/Live by `liveOffered(def, conn)`;
  the rail has a switch (`ReplicaSwitch.tsx`) under the connection's facts.
- **Decided — which members.** Only those whose server IS PostgreSQL (parser, functions, casts):
  the dialect's `$n`, `~` with `[[:space:]]`, `BTRIM(x, chars)`, `DATE_TRUNC`, `TO_CHAR`, `date - date`,
  windows and CTEs are all PostgreSQL ≥ 9.x. Not CockroachDB (a reimplementation; RE2 regular
  expressions, not PostgreSQL's), not YugabyteDB (a fork of the PG 11 query layer over distributed
  storage), not Materialize / QuestDB / RisingWave (pgwire only). Unverified here, so not Live.
- **Decided — unticking is REFUSED while Live datasets ask the connection**, naming how many
  (`code: 'live_in_use'`, `liveDatasets: n`), rather than switching them to copies: each switch is a
  full import from the database just called a primary, and it would silently change what every
  dashboard over them shows. The count and the write are not atomic; a Live dataset created in
  between (or restored from the Trash later) is still refused by the executor before any socket.
- **Found and fixed — the live session's time zone.** `CAST(timestamptz AS DATE)` and `DATE_TRUNC`
  follow the SESSION's `TimeZone`; an extract reads a timestamptz as an instant and stores it in UTC.
  On a database whose zone is not UTC, live put the same instant on another day. `runBound` (the
  Redshift / Postgres family) now runs `set timezone to 'UTC'` first — as Snowflake's session already
  does. Measured in a scratch database `ALTER DATABASE … SET timezone TO 'Pacific/Kiritimati'`: without
  it the day chart has 9 rows where the copy has 7; with it, equal. Negative control kept in the suite
  (the chart's own statement, re-sent on a raw session in the database's zone, answers other days).
- **Found, NOT fixed (for L2.8) — `''` and `NULL` in a text category.** Every import types `''` as
  null (`parse.coerceCell`), so a copy has ONE blank category; a real warehouse groups `''` and `NULL`
  apart and live answers TWO rows labelled "" (their figures add up to the copy's). The L2.2 bench
  missed it because its extract fixture is saved with `datasets.saveDataset`, which keeps `''` — the
  bench's extract shows two "" rows as well. Applies to every dialect and to a split's series. The fix
  is a compiler change (`NULLIF(key, '')` for text keys) plus a bench fixture saved the way an import
  saves it; it overlaps L2.8's parity work, so it is pinned (`test-liveReplica`: "PINNED — …") and left
  to that task. The operator doc names it.
- **Not testable here — collation.** This machine has only `C`/`C.UTF-8` locales. Text ordering filters
  and tied labels follow the database's collation on live and code points on a copy; documented.
- **Measured** (`test-liveReplica`, local PostgreSQL 16, 4 vCPU container shared with other suites,
  four runs): a live KPI with cache age 0 — connect, read-only + `statement_timeout` + UTC, one bound
  statement, close — median **7.6–13.0 ms** of 20; the `set timezone` statement alone **0.08–0.15 ms**
  median of 200. The connection set-up dominates; a remote replica adds its round trips to each.
- **Tests.** `test-liveReplica` (pure rule + catalog + contract with negative controls; RPC enforcement
  without a database; with `DATABASE_URL` the end-to-end flow: 10 charts and 6 KPIs through
  `liveVizData` / `liveMetric` equal `vizDataFor` / `computeCardMetric` over the copy with `Object.is`,
  sums and averages included — the fixture's amounts are quarters, so no summation order rounds).
  `test-connectors`: `postgres` moved from the "not live" list to "live, behind its opt-in" (the
  catalog flag now means "can be Live", by design), and `liveOptIn` joined the documented catalog keys.
  Vitest `replica.test.tsx` (5); `connections.e2e.ts`: the main flow asserts no Live choice on an
  unticked PostgreSQL, and a new flow ticks the box on the form, saves a Live dataset, and sees the
  untick refused in place (screens `connections-replica-form-*`, `connections-replica-workbench-*`).

## 2026-10-09 — L2.5 Profile and AI context for live

- **Built.** `src/data/liveProfile.ts` — the profile a Live record keeps in its `live` block (no SQL
  migration): per column the warehouse's type name, filled and distinct counts in the sample, and for
  a low-cardinality text column (≤ 50 distinct in the sample) up to 20 values with their counts, most
  frequent first; the sample's rows, time, method (`sample`/`limit`) and, when the last sync read
  none, why (`tooCostly`/`failed`/`refused`). Sanitized on every load and before every write, like
  the rest of the record. Readers: `profileDistinct` (the pickers), `profileSplitCandidates`,
  `sampleMatrix` (the sensitivity detector), `withoutSamples` (bundles).
  `src/engine/live/profileSql.ts` — the ONE statement per table, the ClickHouse sampling-key probe,
  the cost model and the reading of the rows; `tableSample(plan)` on every dialect (DuckDB
  `USING SAMPLE n ROWS`, Snowflake `SAMPLE (n ROWS)`, Databricks `TABLESAMPLE (n ROWS)`, BigQuery
  `TABLESAMPLE SYSTEM (p PERCENT)` from the catalog's row count, ClickHouse `SAMPLE n` only with a
  sampling key, Redshift none), sizes spliced only through `sqlInt`/`sqlPercent`.
  `src/engine/live/schemaSync.ts` (describe → sample → one write) and `schemaSyncJob.ts` (the three
  doors, one at a time). `src/engine/live/liveMissing.ts` + `src/analysis/liveDependents.ts` (column
  missing). `src/ai/liveFacts.ts` (a Live dataset's facts block and inventory notes).
  `src/ipc/liveProfile.ts` — `dataset:syncLiveSchema` (`write`; waits for the job and answers counts,
  column names and the sample's typed outcome) and `dataset:liveSchema` (`read`; the Schema panel's
  figures, computed server side, with the missing columns and what uses them), contracts in
  `src/api/live.ts`. `estimateLive` in `src/connectors/liveRun.ts` (the dry run's context and
  guard). 8 catalog sentences (`src/engine/liveProfileMessages.ts`) + the `columnMissing` refusal.
- **Decided — the three doors.** On create (`connection:import` → Live and `dataset:setMode` queue a
  job; the create does not wait), on demand (`dataset:syncLiveSchema`), daily (the scheduler's tick
  hands the Live datasets it skips for refresh to `queueDueSchemaSyncs`: due 24 h after the last
  sync; the attempt is stamped first, so a failing warehouse is asked hourly, not every 60 s tick).
  The job is a `refresh` job under the L0.4 lock: one sync per dataset across pods, never beside a
  refresh or a cache reset of it. A daily one is `silent`.
- **Decided — one write.** Columns, profile, missing list and `schemaSyncedAt` land in one
  read-modify-write (`writeSchemaSync`). `schemaSyncedAt` is in every live cache key (L2.3), so a
  sync retires the dataset's cached answers by itself — at most one extra warehouse call per question
  per day, which is what "the schema may have changed" costs. A changed column list also announces
  the dataset (`hub:dataset-refreshed`), so an open dashboard redraws.
- **Decided — a sample not read keeps the last figures.** Too costly, refused or failed: the columns
  still sync, and each column still declared with the same type keeps its last figures, marked
  `skipped`, with a catalog sentence on the panel. A failed DESCRIBE changes nothing.
- **Decided — UNPIVOT, not GROUPING SETS.** The first version grouped `GROUPING SETS ((), (k0), (k1),
  …)`. Every set carries every key column, so its cost grows with columns²: on the bench a
  500-column sample ran a 1 GiB DuckDB worker out of memory. The statement now unpivots the sample
  against constant set ids (`SELECT 0 UNION ALL SELECT 1 …` — the one spelling all six engines take)
  into three narrow slots (set, text key, DOUBLE key), groups once, ranks per set. The sample is still
  referenced ONCE (BigQuery re-evaluates a CTE per reference). Same figures, byte for byte, where the
  sample is the whole table; faster at every width (below); and the Redshift dialect's statement runs
  on Postgres 16 and agrees with the DuckDB bench on every column (`test-liveProfile` §6).
- **Decided — the cost guard.** ≤ 1M (row, column) cells: 10,000 rows, fewer past 100 columns, never
  under 1,000 (`sampleRowsFor`), at most 500 columns profiled. BigQuery: TABLESAMPLE's percent is
  twice the sample's share of the catalog's row count (block sampling is lumpy); the dry run prices
  the statement first and past `LIVE_MAX_BYTES_BILLED` or the connection's own ceiling the sample is
  skipped. Everything else goes through the executor's own door, `runStatement(t, query, signal)` →
  `warehouse()`: the daily limit, a concurrency slot, the timeout and cancel, `costTag 'live'`.
- **Decided — at most one second try, LIMIT only**, through the same gate: when the warehouse refused
  the sampled statement (an engine may take its sample clause on a base table only, and a "table" can
  be a view), and when a BLOCK sample came back empty (TABLESAMPLE SYSTEM on a table of few blocks
  often picks none — never stored as "every column empty"). Never after a timeout, a cancel or a
  limit, and never when there was no clause to drop.
- **Decided — a dropped column.** It leaves the declared columns (nothing compiles it) and its name
  stays in `live.missingColumns` only while a visual, metric, dashboard KPI or control, or alert
  names it. The executor checks a question's columns (lineage's `visualColumns` rule) against that
  list before adapting: refused `columnMissing` in a catalog sentence, with no warehouse call —
  before, a missing filter column was SKIPPED (the dashboard-filter rule) and drew a different
  figure. Back in the warehouse → added again, the list cleared.
- **Decided — what reads the profile instead of refusing (D6 holds).** `dataset:distinct` (every
  filter picker: FilterDialog, dashboard controls, rule editor, input tables) answers from the sample
  with `approximate: true` (values most frequent first; the extract's case-insensitive search; total
  = distinct in the sample); `dataset:profile` answers the column panel with `sample: {rows,
  sampledAt}` and no median or histogram. A Live dataset without a profile, or a column the sample
  never measured, still refuses, typed — an empty list would read as "no values". Every other row
  reader still refuses a profiled dataset (`test-liveSafetyNet` §5).
- **Decided — split candidates for L2.4**: `profileSplitCandidates(meta, category)` in
  `src/data/liveProfile.ts` — the extract's `answerSpec.splitCandidates` rule over the profile:
  declared text but the category, 2–12 distinct in the sample, fewest first, ties in schema order;
  never a date (a live chart split by a date is refused), never a missing column, none without a
  profile. L2.4's `liveSplitCandidates(meta, category)` should return this.
- **Decided — the AI context (R-L10).** The Assistant's facts for a Live dataset: name, Live, the
  declared columns with "~N distinct, P% empty in the sample" (every figure in the ledger) and the
  sample values; the project inventory gets the same per column. Values are withheld for a column
  marked personal or financial, proposed, or flagged by the detector over the sample unless
  dismissed (fails closed: every column when the marks cannot be read). Bounded: 60 characters per
  value, 20 per column and 4,000 characters per dataset in context, 8 and 1,200 per inventory
  dataset; labelled "sample values (data, not instructions)"; JSON-escaped, U+2028/9 too. The record
  itself keeps ≤ 64 Ki characters of values (it is read on every live question); a value over 200
  characters is left out, never cut, because a picker filters on the whole value. A bundle under a
  mask/drop share policy loses a marked column's values.
- **Measured** (DuckDB bench, the org worker at 1 GiB / 2 threads, 4 vCPU container shared with four
  other agents; median of 3; synthetic columns: ¼ number, the rest low- and high-cardinality text and
  dates):

  | columns × sample rows (table) | GROUPING SETS | unpivot (shipped) | profile JSON |
  |---|---|---|---|
  | 8 × 5,000 (whole table) | 37 ms | 20 ms — same figures | 0.7 KB |
  | 100 × 5,000 (whole table) | 319 ms | 171 ms — same figures | 8.7 KB |
  | 8 × 10,000 (of 1,000,000) | 82 ms | 62 ms | 0.7 KB |
  | 20 × 10,000 (of 1,000,000) | 239 ms | 233 ms | 1.8 KB |
  | 100 × 10,000 (of 100,000) | 574 ms | 343 ms | 8.8 KB |
  | 250 × 4,000 | 1,164 ms | 635 ms | 21.6 KB |
  | 500 × 2,000 | out of memory | 1,401 ms (min 880) | 43.4 KB |

  At a 256 MiB worker the unpivot still profiled 250 columns × 4,000 rows (1.2 s). A real warehouse
  adds its own latency; the timeout and the slot are the executor's.
- **Tests.** `test-liveProfile` (100 checks with `DATABASE_URL`, 99 without): §1 the statement per
  dialect (golden fragments: the sample clause, the unpivot, the sample referenced once, every count
  a DOUBLE, the whitespace class bound), 7 hostile column names × 6 dialects decode back, NUL refused,
  NEGATIVE CONTROL: forged sizes refused; the record bound; §2 the stored profile against a direct
  count over the 1,060 fixture rows (filled and distinct exact, values byte-identical — BOM,
  decomposed é, emoji — with their counts; the 20 cap; a 201-character value left out); §3 the
  pickers, the panel and the Schema panel over the RPC route (NEGATIVE CONTROL: unprofiled, they
  refuse), split candidates; §4 a dropped column (refused `columnMissing` with no warehouse call;
  NEGATIVE CONTROL: a chart not naming it answers; back → cleared); §5 the privacy canary; §5b the
  prompt bounds; §6 Postgres. `test-liveProfileSync` (39): the due rule; the tick (one job, none
  while it runs, the attempt stamped, no retry within the hour); create / on demand / two starts;
  the dry-run gate with its NEGATIVE CONTROL; the second try's two cases and their NEGATIVE CONTROLS;
  the daily limit, the concurrency slot, a warehouse error (R-L6 canary), a timeout, a cancel (nothing
  written); a sync moves the cache key. `test-liveSafetyNet` +6 (92): the Schema panel lists; a
  profile opens the pickers and the column panel and nothing else; an unmeasured column refuses.
- **For L2.4 / L2.6 / L2.7 / L2.8.** L2.4: wire `profileSplitCandidates`; the pickers need nothing
  more. L2.6: the Schema panel (`dataset:liveSchema`) and the **Sync schema** button
  (`dataset:syncLiveSchema`); say "from a sample" where `approximate`/`sample` is set. L2.7: the
  profile's statements already take `runStatement` → `warehouse()`; the BigQuery dry run
  (`estimateLive`, free, unbilled) is the one live call that does not — count it or not there. L2.8:
  on real engines, check the profile statement on each (GROUPING-free, but a 500-way `UNION ALL` and
  a CASE per cell), Snowflake's fixed-size `SAMPLE (n ROWS)` cost on a large table, and BigQuery's
  TABLESAMPLE percent against its block size.
## 2026-10-09 — L3.1 Pull the new rows before answering (fresh on ask)

- **Built.** `freshOnAsk: { maxStalenessSec }` on the dataset record (60 s – 1 day; the picker offers
  1 min · 5 min · 15 min · 1 h), allowed only with incremental refresh on and never on Live —
  sanitized on every load (`src/data/freshOnAskRule.ts`, one line in `datasets.normalize`), refused
  by `dataset:update` with a catalog sentence (`src/data/freshOnAskMessages.ts`, a new `MAIN_FILES`
  entry), and dropped by `writeIncremental` in the same write that turns incremental refresh off.
  `ensureFresh(projectId, datasetIds)` (`src/data/freshOnAsk.ts`) is one line at the top of
  `vizDataFor`, `computeCardMetric`, `computeStatsTile` and `computeCard` — before the answer-cache
  key reads the record, so a pull that lands in time moves `updatedAt` and the answer is recomputed.
  `figureAsOf` (and `computeCard`'s own stamp) adds `refreshing: true` from what the request found
  (`src/data/freshOnAskState.ts`). Web: `FreshOnAskPicker` beside the schedule on the dataset page
  and in the workbench rail — disabled with "needs incremental refresh" in words without it, "Waits
  for a full refresh" when the server says the next run is full (`freshOnAsk.fullDue` on the list).
- **Never a full refresh — a mode, not a pre-check.** `startRefresh(…, { incrementalOnly })` → the
  job → `refreshDataset(…, mode 'incremental')` → `refreshIncremental`, which returns `skipped`
  instead of reaching `runFull` both when `fullReason` says so up front (first run, 7th run, "Full
  refresh now", cursor/key gone, no Parquet) and when it finds out after the fetch (the columns
  changed). A skipped run writes nothing, moves no marker and is not an error; the job ends `done`.
  The ask also checks `fullReason` first (verdict `full`), so normally no job starts at all.
  **Negative control** (`test-freshOnAskDoors` §4): the same dataset refreshed in the ordinary mode
  reaches the full re-fetch spy; in the incremental mode it never does (3 cases).
- **One check per dataset per request** — memoised on the request's own context object (a WeakMap,
  so it dies with the request): a 6-tile `analysis:tiles` load over one stale dataset did ONE
  metadata read and ONE pull; two such loads at the same instant, still one pull (`pulls`, this pod's
  in-flight map, orgKey'd). One wait per request, too: a request asking several datasets one after
  another shares one `FRESH_ON_ASK_WAIT_MS` budget (measured: two slow datasets in a row, 600 ms
  budget → both answered "refreshing" in < 1 s).
- **Decided — the window lives on the record, claimed under an advisory lock.** "At most one pull per
  dataset per window" needs a time every pod reads. The record is already what every check reads
  (and a `records` row with Postgres), so `freshOnAsk.triggeredAt` costs no extra read on the hot
  path and no migration (and no migration number to collide with L0.5's). Its read-modify-write is
  made a compare-and-set across pods by taking the refresh lock's primitive on a key of its own
  (`<org>:fresh-on-ask:<id>`, never the refresh lock itself) around "re-read, still stale and
  unclaimed? stamp". This pod also remembers its own starts (`triggered`, orgKey'd), so a stamp lost
  to a racing whole-record write still holds the window here. Rejected: reusing `lastRefreshedAt`
  alone — a FAILED pull never moves it, so every ask would retry a broken source; a new table — a
  migration for one timestamp the record already has room for.
- **Decided — the pull runs detached.** As the system in the org (like a scheduled refresh: in nobody's
  Jobs list, for no tab), inside an `AsyncResource` captured when the module loads — so it carries no
  request abort signal (a closed tab ends that person's wait, not the refresh everyone else waits
  for), no as-of scope and no display currency (`afterRefresh`'s alert evaluation must not run in the
  asker's currency). Proven by the fake source reading its own context: `jobs@system`, no signal, no
  as-of, not the asker's EUR. After a landing, `afterRefresh` runs as after a ↻ (alerts, quality,
  republish, the SQL datasets built on it — otherwise a dashboard over a query on the table stays
  stale).
- **Not pulled:** inside an as-of read; outside server mode (no request to memoise on, no job queue
  shared with readers, no push); outside a request on the server; for a Live dataset.
- **Measured** (this container, Node 22, local Postgres 16 as both the SOURCE and the records store,
  `test-freshOnAskPg`; one `analysis:tiles` load = a chart + two KPIs over one dataset):

  | Load (median per run; the range is over 5 runs) | Median |
  |---|---|
  | Dataset without fresh on ask (15 loads) | 5.4 – 7.6 ms |
  | Fresh on ask, copy fresh (15 loads) — the added cost is one record read per dataset per request | 6.0 – 9.0 ms (+0.2 – 1.4 ms, at run-to-run noise) |
  | Fresh on ask, copy stale: one incremental pull from Postgres (cursor pushed down, DuckDB merge, Parquet + record write, announce), waited for (7 loads, a new dataset each) | 119 – 164 ms (single loads 103 – 187 ms) |

  So a stale ask costs ~110 – 160 ms over a fresh one on a small table, all of it the incremental
  run itself. With records as files and a fake source (`test-freshOnAskDoors`): a 7-tile load
  waiting for a 150 ms pull 354 – 398 ms; the same load fresh 15 – 16 ms. A stale ask whose pull outlasts the wait
  answers at the budget (250 ms → < 1.2 s round trip, old figures, `refreshing`), the push arrives
  when the rows land, and the next ask is fresh. A 10 ms timer kept ticking through a 1 s wait (≥ 50
  ticks: the wait never blocks the event loop).
- **Cross-pod, measured with a second Postgres session as "another pod":** holding this window's claim
  → this pod pulls nothing; holding the refresh lock with the window stamped → this pod polls
  `pg_locks` every 200 ms and answers fresh ~400 ms later when it is let go, or `refreshing` at the
  budget when it is not. (Not run: two real server processes — L0.4's `test-refreshLock` covers the
  lock between processes; the claim is the same primitive.)
- **Not done / for the owner.** The web app still has no panel to turn incremental refresh on
  (T8.1; L0.3 noted the same for the fast cadences), so fresh on ask is only offered on datasets
  whose incremental refresh was set before or through the record. Every 7th incremental run is full,
  so a dataset refreshed ONLY by fresh on ask pulls six times and then shows "Waits for a full
  refresh" until a schedule or Refresh now runs the full one — by design (the brief: never full on
  ask); a schedule alongside avoids it. A chart reading a RELATED dataset (a join through a
  relationship) pulls only its own dataset, and is dated by it — as L0.2 dates it.

## 2026-10-09 — Incremental refresh settings in the web app (closes the gap L0.3 and L3.1 reported)

- **Built.** The desktop's `incremental:get` / `incremental:set` (deleted with T8.1), ported:
  contracts in `src/api/incremental.ts` (`get` read, `set` write, both project-scoped), handlers in
  `src/ipc/incremental.ts`, the logic in `src/data/incrementalSettings.ts`, sentences in
  `src/data/incrementalMessages.ts` (a new `MAIN_FILES` entry, drafts translated). Web: an
  "Incremental on/off" button beside the schedule on the dataset page and in the workbench rail,
  opening a panel (`web/src/features/data/Incremental.tsx`): how the source is read, on/off, the
  cursor (the server's number and date columns of the prepare SOURCE), update by key or append, the
  key, the lookback (minutes / hours / days for a date cursor, ids for a number one), "Next refresh:
  full" with the reason, and the run log (fetched / inserted / updated / mark per run).
- **Decided — a source that cannot take the cursor predicate is refused.** HTTP engines and SaaS APIs
  (`incrementalSql.canPush` false) would be read whole on every "incremental" run and filtered after
  the fetch — the load the 5/15-minute cadences and fresh on ask are only allowed because incremental
  refresh avoids. The panel says "Filtered after fetch" and why; the server refuses turning it on
  (catalog sentence). An older record that has it on over such a source can still be turned OFF.
- **Decided — one key column.** The merge (`incremental.mergeJs` and its DuckDB twin, differential-
  tested) keys on one column; a composite key would change both and their tests, so the panel offers
  one, as the desktop did.
- **Kept from the desktop:** a new cursor column resets the mark and the run count (the next run is
  full); the same cursor with a new lookback keeps them; off keeps the block and its log. New:
  turning it off drops a 5/15-minute schedule to hourly and fresh on ask in the same write
  (`writeIncremental`, L0.3 / L3.1), and Live datasets and non-connection datasets are refused even
  "off" (they keep no block).
- **Errors stay in the log.** A thrown error (it can carry a path) is logged; the browser gets the
  catalog's "Could not read / save the incremental refresh settings." — never the error's text.
- **Tests.** `test-incrementalSettings` (44 checks: the view from the source columns, on/off, every
  refusal with its catalog sentence, the contract's 400s, the mark reset with a NEGATIVE CONTROL,
  the five blocked kinds incl. ClickHouse "filtered after fetch" — and Live, a paste and a gone
  connection describing no read at all, not "after the fetch" — the 5-minute cadence and fresh on
  ask refused before and taken after (NEGATIVE CONTROL), a missing dataset and a thrown error
  answered with the catalog's sentence and no planted path (NEGATIVE CONTROL: the log has it));
  `test-liveSafetyNet` reads `incremental:get` on a Live dataset as a metadata path (200, no
  `live_dataset`); Vitest `incremental.test.tsx` (11, incl. a number cursor's lookback reading back
  as ids, not seconds — fails on the first draft, which split it into minutes); `data.e2e` opens the
  panel of a dataset on over a connection since deleted (only "off" is possible; the run log the
  record keeps), turns it on for another, then picks every 5 minutes and fresh on ask — the panel
  in three states and the page, both themes; `connections.e2e` opens it from the rail.
- **Not done.** "Next refresh: full" and a full run's note in the log are `fullReason`'s English
  (src/data/incrementalRefresh.ts, stored on the record as the desktop did), not catalog sentences;
  translating them means a messages file for incrementalRefresh and keys, not text, in the log.
## 2026-10-09 — L2.8 Parity on real engines

- **Built.** The L2.2 matrix moved out of `test-liveParity` into `scripts/liveParityMatrix.ts`, run
  on any `ParityEngine` (`liveParityFixture.ts`: a dialect, a loader that returns a live source,
  a runner). `scripts/liveParityEngines.ts`: Postgres as Redshift and ClickHouse, each running every
  statement through the REAL connector's `live.runBound` (via `liveRun.runLiveBound`, server mode,
  the SSRF guard pinning the one address that answers). Suites: `test-liveParity` (DuckDB, every
  `npm test`), `test-liveParityPostgres` (needs `DATABASE_URL`: CI's `check` job runs it; a scratch
  database `ordinate_l28_<pid>_<ms>`, byte-ordered `C`, default zone UTC+14, dropped `WITH (FORCE)`),
  `test-liveParityClickhouse` (needs `CLICKHOUSE_URL`; the new `clickhouse` job of
  `warehouse-nightly.yml` runs it against a `clickhouse/clickhouse-server:25.8` service container).
  Snowflake and BigQuery: `scripts/warehouseLiveParity.ts`, called by `test-warehouseLive` after each
  warehouse's connector checks, under its secret canary (job timeout 20 → 60 min).
- **Decided — the real accounts are never written.** Their roles are read-only, so the nightly's
  twin is a DEFINING QUERY over literals (`scripts/liveParityLiteral.ts`): every cell a text literal
  (backslash-escaped) or NULL, typed only by `CAST` — `FROM (VALUES …) AS v(c0, …)` on Snowflake,
  `UNNEST(ARRAY<STRUCT<c0 STRING, …>>[…])` on BigQuery. A Live dataset over SQL is a production shape,
  and the same twin runs on CI's Postgres (`E'…'` literals, the same escaping) every 9th case, so the
  mechanism is proved before a warehouse sees it. Warehouse runs take every 8th chart, KPI and answer
  case (≈500 statements each); every filter op, both negative controls and the pins always run.
- **Fixed — `''` and NULL were two blank categories on live, one in a copy** (found by L3.2). Every
  import stores `''` as null (`parse.coerceCell`); a warehouse groups them apart. A text GROUP key —
  category or split — is now `CASE WHEN t = '' THEN NULL ELSE t END` (`compileFilter.keyText`, used by
  `compile.keyExpr` and the text series), in all six dialects; filters already compared NULL as `''`.
  The L2.2 bench missed it because it saved its extract raw; the fixture is now typed exactly as an
  import types it (`fx.importTyped`: stringify as `connectionRun` does, then `parse.finalizeTable`),
  and so is the L2.3 executor harness. The matrix's skip for "split + top N over `cat`" ('' twice made
  the label set ambiguous) is gone: 120 answers, not 112. L3.2's `liveReplicaFlow` pin of the old
  behaviour ("two blank rows on live") will now fail on merge, as a pin should — flip it to equality.
- **Fixed — the answer's order no longer rests on the row-cap wrapper.** Every connector runs
  `select * from (…) limit n`, and SQL does not promise a derived table's ORDER BY survives it.
  `shape.shapeChart` now orders rows by the ranks the statement returns (`o_cr`, then `o_sr`), a
  stable sort. Observed: Postgres kept the order in 1,899 of 1,899 chart statements, ClickHouse in
  1,663 of 1,663 — the sort is for Snowflake, BigQuery and Redshift, which make no such promise.
- **Fixed — the Postgres/Redshift live session runs in UTC** (`set timezone to 'UTC'` in
  `runBound`, the same lines as L3.2, so the two merge clean). `CAST(timestamptz AS DATE)` takes the
  day in the session's zone; Redshift defaults to UTC but a user, database or parameter group can
  change it.
- **Divergences, each a named pin with a test that it still exists** (`scripts/liveParityPgPins.ts`,
  read off the run in `test-liveParityPostgres`):
  - R1 collation — Postgres orders text by its collation (CI's `postgres:17` defaults to
    `en_US.utf8`); Redshift and the extract compare code points. On an ICU twin `k < 'b'` keeps 2 of
    6 where the extract keeps 4, and tied labels order differently. The matrix runs byte-ordered.
    **Open for L3.2 / L2.9:** a Postgres read replica whose database collation is not `C` will
    differ from its copy on text ordering filters and on the order of tied categories.
  - R2 session zone — TIMESTAMPTZ days agree in a database defaulting to UTC+14; CONTROL: the same
    statement in a session left at +14 puts every instant on the next day.
  - R3 order through the wrapper — kept by Postgres (above); NEGATIVE CONTROL on the order check.
  - R4 −0 — Postgres returned −0 in 5,853 cells (ClickHouse 2,575; DuckDB stores none); every figure
    still matched, the shaping reports +0 (pin 8).
  - R5 read-only — `nextval()` through `runBound` is refused by the read-only session.
  - The eight L2.2 pins run again on every engine, through its own twins, and hold on Postgres and
    ClickHouse unchanged.
- **ClickHouse, run here without Docker.** ClickHouse 25.8.2.1's engine embedded (chdb 4.0.2, from
  PyPI) behind a 60-line Python stand-in for its HTTP interface (query from the body, `param_*` as
  query parameters; not committed — the nightly runs the real server). The whole matrix and every pin
  agree: `match()` over UTF-8, `{p:Type}` values (a tab, a quote, a backslash and a decomposed é now
  ride in three new filter cases), `accurateCastOrNull`, `toMonday`, MergeTree parts in any order.
  Nothing to pin. Databricks still has golden shapes only (no engine in L2.8's scope).
- **Found outside L2.8:** a KPI `sum` whose filter leaves no number (`amt = '007'`, `amt is_empty`)
  is a legitimate null on the resident path, which `dashboards.metricFor` cannot tell from a failure
  — it traces `failed` and recomputes in JS (correct, slower, and one spurious warning per run).
- **Measured** (4 vCPU container; first runs, before four other agents loaded it): DuckDB 1,090
  charts + 108 KPIs + 112 answers, 2,313 statements in 35 s; Postgres 16.15 the same matrix, 2,331
  statements through `runBound` in 41 s (43 s whole suite); ClickHouse 25.8 (embedded) 2,326 statements
  in 68 s. Largest sum/avg deviation: 1.0e-15 (DuckDB, Postgres), 3.0e-15 (ClickHouse) — inside the
  documented 1e-13. Final runs (load average ~22): DuckDB 2,374 statements / 43 s, Postgres 2,815
  (matrix + literal twin 417) / 185 s, ClickHouse 2,393 / 124 s.
- **Tests.** Negative controls on every engine: a broken empty predicate, and the fold stripped from
  the very statements (`unfoldedBlankCaught`: a `cat` chart, a split by `cat`, an answer) must each
  disagree; on DuckDB also the extract saved raw. Mutations checked by hand in the compiled `.js`:
  the fold removed → 35 + 4 + 29 charts, 42 filter ops and 9 answers disagree on DuckDB and on
  Postgres, and `test-liveCompile`'s fold shape fails for all six dialects; DuckDB's empty predicate
  without whitespace → 239 disagreements; the shaping's rank sort removed → `test-liveCompile`'s two
  shuffled-reply checks fail. The SSRF guard is shown on (the database refused without the
  allowance). A set but unusable `CLICKHOUSE_URL` fails; unset, the suite prints one skip line.

## 2026-10-09 — L2.7 Usage and budget

- **Built.** Migration `0012_live_usage.sql`: `live_usage(org_id, day, connection_id, project_id,
  queries, bytes, refused)`, key `(org_id, day, connection_id)`, forced RLS on `ordinate.org`.
  `src/server/live/usageStore.ts` (admission, bytes, the read; Postgres, or per-pod memory keyed with
  `orgKey()` without `DATABASE_URL`), `src/server/live/limitNotice.ts` (the once-a-day notice),
  `src/server/admin/liveUsage.ts` (`admin:liveUsage`, contract in `src/api/admin.ts`, `adminList`),
  `src/engine/live/liveWarehouse.ts` (the one door, below — split out of `liveQuery.ts`, which was at
  500 lines and is now 404),
  `src/server/liveEnv.ts` (the Live settings, split out of `env.ts`, which re-exports them; it was at
  501 lines, now 469; `EnvError` moved to `envError.ts` so the split has no require cycle). L2.3's
  seams in `liveBudget.ts` are filled: `checkDaily` (async now), `noteCall(ticket, bytes)`,
  `cacheAgeFloorSec()` + `publicFloorSec()`. `RequestContext.published` with `runAsPublished` /
  `isPublishedRequest` (`context.ts`), set by `/p/` (`published.ts`). `ConnectorRows.bytes?` — BigQuery
  sets it from its reply (`billedBytesOf`: `totalBytesBilled`, else `totalBytesProcessed`); liveRun
  passes it through. Web: Admin → **Live usage** tab (`LiveUsageTab.tsx`; an org tab, so it shows
  without accounts too, saying the counts are this server's), and `liveLimitNotice.ts` in the shell (a
  toast with "See usage"). Settings `LIVE_DAILY_QUERY_LIMIT` (10,000; 0 = none),
  `LIVE_MIN_CACHE_AGE_PUBLIC_SEC` (60; 0 = none), both re-read per statement like L2.3's.
- **Decided — admitting a statement IS counting it.** The plan's "checkDaily refuses, noteCall
  upserts" would be check-then-count: N pods (× `LIVE_MAX_CONCURRENT`) at limit − 1 all pass. So the
  check and the count are one transaction: `BEGIN; set_config('ordinate.org'); pg_advisory_xact_lock(
  hashtextextended('live_usage:<org>:<day>'))` in one round trip, then one statement that reads the
  org's sum (a snapshot taken after the lock) and upserts `queries + 1` or, past the limit,
  `refused + 1`. `noteCall` adds only the bytes, when the connector settles, to the row of the day the
  statement was admitted on. A statement counts when admitted, whatever then happens (an error or a
  cancel can still bill). NEGATIVE CONTROL in `test-liveUsage-db`: check-then-count on two pools at
  limit 1 lets 2 through; the store lets 1.
- **Decided — admitted only once a slot is held.** L2.3 asked the daily seam before the concurrency
  slot; now `acquire → checkDaily → runBound`, so a question that hangs up while queued is never
  counted, and one whose askers all hang up while it is being counted is not sent (it stays counted:
  the cautious side). The cost: past the limit a refusal waits for a slot like anyone else.
- **Decided — fail closed.** A count that cannot be written (Postgres down) sends nothing: the stale
  answer, else `live_failed`, the reason logged once. An uncounted statement is an unbounded one.
- **Decided — one notice per org per UTC day, decided under the same lock.** `refused` is a column,
  so "is this the day's first refusal?" is `sum(refused) = 0` read under the per-day lock — exactly
  one across pods (tested: 13 racing refusals on two pools, one first). The notice is one log line and
  a `live:daily-limit` push to each enabled org admin (dev sign-in / no Postgres: the org's tabs),
  payload `{day, limit}` only. The admin page also shows the day's refusals for the rest of the day.
- **Decided — keyed by connection** (plus `project_id`, not in the key, to name it), not the plan's
  `(org_id, day)`: the page is per connection; the limit sums the org's rows. `bytes` is NULL until a
  statement reports a figure, so Snowflake (whose SQL API reports no byte statistic per statement —
  checked against the reply shape, not guessed) reads "Not reported", never "0 B".
- **Decided — the public floor is a lookup age; the entry keeps the longest.** `queryCache` takes the
  tighter of an entry's age and a lookup's, so an answer stored at age 0 by a signed-in viewer could
  never serve a page. An entry now keeps `max(dataset age, LIVE_MIN_CACHE_AGE_PUBLIC_SEC)`; each asker
  looks up with its own (`max(dataset age, the request's floor)`). NEGATIVE CONTROL: a signed-in ask
  at age 0 still goes to the warehouse every time, a fresh public answer notwithstanding.
- **Found — a `/p/` page sends no warehouse query today.** A published site is a snapshot built at
  publish (CSP `default-src 'none'`: it fetches nothing), so the floor guards no live read yet. The
  route still runs as a published request, and `test-liveUsage` drives the executor through a real
  `GET /p/…` (site lookup stubbed) to prove the floor holds there and nowhere else. A re-publish after
  a refresh runs as the publisher, not as a page request, and is bounded by the daily limit.
- **The one door.** Every Live statement goes through `warehouse()` (`src/engine/live/liveWarehouse.ts`,
  re-exported by `liveQuery.ts` with `LiveCallError` and `CallKind`): slot, daily admission,
  `runLiveBound` (the only caller of a connector's `live.runBound`), bytes on settle. Its signature is
  `warehouse(t: LiveTarget, query: CompiledQuery, shared: AbortSignal): Promise<LiveRows>` — rows
  positional to `query.columns`; it throws `LiveCallError` (`cancelled`, `timeout`, `failed`,
  `tooLarge`, or `daily` with the catalog sentence in `detail`), logged once; it caches and shares
  nothing, and counts against `ctx()`'s org. `test-liveUsage` fails when anything else in `src/` calls
  `runLiveBound` or `.runBound(` — **L2.4's DISTINCT and L2.5's profile/sample statements must go
  through `warehouse()`** to be slotted, limited and counted.
- **Measured.** One admission on Postgres (local PG 16, 4 vCPU container shared with other jobs,
  median of 100 sequential, `test-liveUsage-db`): three runs at low load gave 1.38 / 1.44 / 1.57 ms
  with a limit (lock + sum + upsert) and 1.50 / 1.37 / 1.45 ms without (no lock) — noise between the
  two; two runs at load average 13 gave 4.0 ms both ways. The executor's warehouse call on the fake
  (in-memory admission included), median of 40, after the `liveWarehouse.ts` split: 1.78 / 2.08 /
  2.39 ms over three runs of `test-liveQuery` (L2.3 measured 2.41–2.53 ms) — no cost visible.
- **Tests.** `test-liveUsage` (55 checks, no DB): every statement one query (KPIs, an answer and its
  MAX()), a hit or a joined flight none; bytes summed, null when unreported; past the limit stale or a
  typed refusal with no statement sent, never empty; 0 = none; re-read per statement; a new UTC day
  starts over; one notice per org per day (NEGATIVE CONTROL: the 2nd and 3rd send and log nothing);
  fail closed; a statement whose askers all hang up while it is being counted is not sent
  (NEGATIVE CONTROL: with the asker still waiting it is); the floor inside a real `GET /p/…` and
  nowhere else (NEGATIVE CONTROLS); the one-door static check, and `warehouse()` exported by the
  executor (NEGATIVE CONTROL: a planted caller is found); BigQuery bytes from three reply shapes;
  `admin:liveUsage`'s labels; env. `test-liveUsage-db` (24, Postgres): 60 racing admissions on two
  pools = 60 (NEGATIVE CONTROL: read-then-write leaves 1), bytes exact, the limit across pods with one
  first refusal (NEGATIVE CONTROL above), the executor on Postgres, the notice on the admin's stream
  only and once, RLS as an ordinary role, the admin channel per org. `test-admin-db`'s matrix covers
  the new channel (16 admin channels; 6 audited-on-denial lists). Vitest `liveUsage.test.tsx` (5); the
  admin e2e adds Live usage empty, counted and limit-reached screens (light + dark).
- **Found — `test-refreshLock` counted every advisory lock on the server**, not its own database's,
  and killed the backend of whichever it saw first. With the admission's lock in `test-liveUsage-db`
  running beside it in `npm test` (or any other suite on a shared Postgres) it failed 6 checks; both
  probes now read `pg_locks` for the scratch database only (passes run beside `test-liveUsage-db`).
  `test-liveUsage` no longer closes its app before exiting: closing shuts the org DuckDB workers down
  asynchronously, and it once died with the known exit-time `Napi::Error` (retro, phase 7) after
  every check passed, under a load average of 20.
- **Merged with L2.5, L3.1, L3.2 and L2.8.** L2.5's `runStatement` (the schema sync's profile, its
  sample and the ClickHouse sampling-key probe) now wraps this `warehouse()`, so a sync is slotted,
  daily-limited and counted like a question (its `callFailure` already read `daily`); there is one
  `LiveCallError`, in `liveWarehouse.ts`. The BigQuery dry run before a sample (`estimateLive`) is
  free and stays uncounted. The fake warehouse's billed figure is `fake.billedBytes`: L2.5's
  `fake.bytes` is the priced variant's dry-run estimate. `FRESH_ON_ASK_WAIT_MS` stays in `env.ts`.
- **Not done (scope):** nothing routes a chart, KPI or answer to the executor yet (L2.4), so the e2e
  seeds `live_usage` rows rather than causing them. Usage rows are kept indefinitely (one small row
  per connection per day).

## 2026-10-09 — L2.4 Route every door

- **Built.** `src/ipc/liveRoute.ts` (the KPI and chart doors: `liveMetaOf`, `liveChart`,
  `liveCardMetric`) and `src/ipc/liveAnswers.ts` (the answer door: `liveCardFor`, `liveCaseFix`,
  `liveSplitCandidates`). One early branch in each of the three functions every figure goes
  through — `vizDataFor`, `computeCardMetric`, `computeCard` — before the extract's answer cache and
  before any `getDataset`. `src/engine/live/liveFigureError.ts` (`LiveFigureError`, `liveCodeOf`; its
  own file so the RPC route can type one without importing the doors). Executor: `liveLookup` (one
  compiled lookup, cached and shared like the period MAX(), through the same `warehouse()` as every
  other statement — since the merge, L2.7's one door in `liveWarehouse.ts`), the answer reply's
  `periodRanges`, and `liveFlight.ts` (the flights moved out of `liveQuery.ts`, which the lookup
  would have taken past 500 lines; 406 after the L2.7 merge). Compiler:
  `compileCaseMatches` and a `caseKey` per dialect (JS `trim()`'s class, then lower case; RE2 on
  DuckDB and ClickHouse — a byte-wise trim would eat a multi-byte character — `TRIM`/`BTRIM` with the
  class bound as a value elsewhere). Assistant: a Live dataset's facts (merged into L2.5's
  `src/ai/liveFacts.ts`, below).
- **What now works on Live, through those three:** `visual:data` / `dataBatch` / `preview` /
  `thumbs`, every `analysis:tiles` tile (chart, KPI, saved metric, compare delta), `dashboard:metric`,
  `metric:values` / `preview` (and `metric:table`'s value column), `answer:card` / `explain` /
  `rerun` and the dock's answer action, `alerts:test` and the alert evaluator (threshold and
  change-since-last), the Summary card (its KPI level), copilot facts for a chart (now through
  `vizDataFor` for every dataset), a Live dataset (schema, notes, metrics — never a row count), a
  dashboard's KPI cards and the defined metrics, publish (`buildDashboard`, a story's `buildStory`)
  and the HTML export (`dashboardPageHtml`), `story:figures`, `scorecard:compute` (anchored on the
  warehouse's latest date), report pages (through `analysis:tiles` / `visual:data`), the
  analysis-plan preview, MCP (`creators` / `metricValue` call the same doors).
- **What still refuses, typed** (L2.6's "off for live" list): pivot, cohort, funnel, drivers,
  facets, maps, raw points (the adapter's `live_refused` + reason, never an empty chart); and at the
  door — new, each with a NEGATIVE CONTROL (the extract answers): an **"as of"** read (`asOf`: the
  warehouse answers now and a Live dataset keeps no snapshots), a **currency conversion** (`fx`: the
  warehouse would sum unconverted amounts), a **filter or column through a relationship**
  (`related`; with no relationship an unknown filter column is skipped with the extract's own
  warning, as before). Scenarios refuse in `operand()` (their KPIs would now route, but a driver's
  partitions read rows — never a half-live figure). The column profile of an UNPROFILED Live dataset
  refuses before its chart asks the warehouse (a profiled one answers from its sample, L2.5). Not routed and still the L2.1 refusal (`live_dataset`): **`metric:series`** — the
  Metrics table's sparkline (N+1 statements by design, one per point; it wants one grouped live
  query) — so `metric:table` shows a Live metric's value with no sparkline; `metrics.distinctValues`
  now rethrows the refusal instead of answering "no series" (a silent blank before this); the
  **scorecard detail** page (its top dimension reads distinct values); a dropdown control's options on
  a Live column (publish refuses such a dashboard; the filter pickers come from the L2.5 profile);
  drill-down rows, stats, insights.
- **Decided — a KPI failure THROWS** `LiveFigureError` from `computeCardMetric`, a chart failure is
  RETURNED as `{ok:false, code, error, reason}`. Every caller of `computeCardMetric` reads `ok:false`
  as "the dataset is gone" and shows a blank (`metrics.resolveDefinition` → null, the alert evaluator
  → no fire, publish → "Source removed"), exactly the silent figure D6 forbids, while a throw is loud
  everywhere for free: one that no handler catches is answered by the RPC route as a typed **409**
  with its code, reason and catalog sentence (as `LiveDatasetError` is; any other throw stays the bare
  500). Where a figure is SHOWN the type is kept: `dashboard:metric`, `metric:value` / `preview` /
  `compare` and `alerts:test` spread `liveCodeOf(err)`, the tiles batch passes `code` + `reason` on.
  Where one KPI must not sink the rest it is caught: publish (that tile, or that story block, says
  why; the page still publishes), the alert evaluator (the rule is skipped, its state untouched, the
  others evaluated), the Summary card (no KPI sentence), copilot facts (the card n/a, that defined
  metric left out — the others still listed). A scorecard row whose warehouse fails reads n/a
  (`scorecards.figure` already caught every error that way); its reason is L2.6's to show.
- **Decided — the live `asOf` is kept.** `stampAsOf` keeps a reply's `mode: 'live'` time (the oldest
  wins when a figure also read an extract), and `asOfFrom` gives a Live dataset no record time, so
  `dashboard:asOfStamps`' "Latest" is the sheet's stalest EXTRACT. A saved metric carries its
  operands' oldest live time (`ResolveCtx.asOf`).
- **Decided — the case fix.** One lookup per text column per answer, `SELECT DISTINCT col … WHERE
  caseKey(col) IN (…) ORDER BY col LIMIT 20·k` (k = the distinct values asked: the plan's LIMIT 20
  per value, so an `in` of 30 values is never cut short at 20 — a value left unfixed would silently
  drop its category), the asked values keyed in JS (`trim().toLowerCase()`) and bound; keys sorted,
  so the same values in any order and case are one cached statement. It goes through the executor's
  `warehouse()` like every statement (`liveQuery.liveLookup`), never `runLiveBound` directly. Named
  divergence: where two spellings share a key ("West", "WEST") the extract keeps the first SEEN, live
  the first in the warehouse's order. The card's labels keep the values AS ASKED and its `steps` the
  fixed ones, as the extract's do; a period's steps are the day bounds the warehouse's latest date
  resolved it to (`periodRanges`).
- **Decided — split candidates** are `liveSplitCandidates(meta, category)` =
  `liveProfile.profileSplitCandidates`: the extract's rule (2–12 distinct values, fewest first)
  over the schema profile's counts. A dataset never profiled offers **none** — not the text columns
  in schema order (this entry's first draft): a "Split by" chip on a column of thousands of values
  draws 50 + "Other", and only the profile knows the counts. One "Sync schema" and the chips appear.
- **Found, not ours:** `scorecards.latestDate` reads the LAST label of a day-grain chart as the
  latest date, but an extract's date axis is in first-seen order (the L2.2 note above), so on an
  extract whose rows are not in date order the scorecard anchors on the last-SEEN date (the parity
  fixture: 2023-09-16 where the data runs to 2025-03-01). Live orders dates ascending, so a Live
  scorecard anchors right. Left for its own change.
- **Measured** (`test-liveRoute`, 4 vCPU container shared with four other agents — load average
  ~8 —, the fake warehouse over the 1,060-row parity fixture, through the real RPC route; medians of
  15 views per run, cache cleared before each first view, five runs): a dashboard of **4 Live tiles**
  (a text chart, a quarter chart, two KPIs) makes **4 warehouse calls on first view and 0 on the
  second** inside the cache age; `analysis:tiles` **18–26 ms first, 4.4–6.6 ms cached** (no network —
  a real warehouse adds 100 ms to seconds per statement on the first view only). Four tiles asking
  two questions: 2 calls. A date axis with no grain (or a number axis) asks one probe first, so such a
  tile costs 2 statements, still 0 on the second view. After Refresh (an epoch bump) the view asks
  again. The Live check on an EXTRACT door is one more metadata read: **0.08–0.17 ms** median of 400
  (records as files; L0.2 measured 0.50 ms in Postgres).
- **Measured after the L2.5 / L2.7 / L2.8 merge** (L2.7's daily admission now in every statement's
  path; a quiet machine, load average ~1.5, three runs): still 4 calls then 0; `analysis:tiles`
  **16–18 ms first, 4.1–4.7 ms cached**; the Live check 0.16 ms. (One run under load — average
  ~8 — read 31 ms / 5.8 ms.)
- **Measured, e2e** (`web/e2e/liveTiles.e2e.ts`, built server, `ORDINATE_TEST_LIVE_FAKE=1`): a
  dashboard with a Live KPI and a Live chart opens in **10 RPCs** (budget 25), each card captioned
  "Live · <time>" (or "Live · cached just now" when an RPC asked first), a reload inside the cache age
  "Live · cached just now"; both themes screenshotted. `dashboards` and `analyses` fail here only on
  the unreachable OSM tiles (as on the base commit, L0.1's note); with the tiles stubbed locally (not
  committed) they pass 4/4 and 5/5. `freshness`, `stories` and `scorecards` pass as they are.
- **Tests.** `test-liveRoute` (69 checks): 15 doors on Live equal the extract of the same rows,
  dated live, the `getDataset` spy never asked for the Live dataset (and asked for the extract —
  the spy works); the call counts above; publish and export carry the live figures, `sanitizeBundle`
  keeps them and drops `asOf`, codes and a planted secret; 7 adapter refusals (the extract draws the
  same pivot — the control) + 3 door refusals, each with its negative control; the live time through
  the stamp and `asOfStamps`; a Live scorecard's window equals the extract over that window; a
  published story's Live metric, and its warehouse down (that block says why, the rest publishes);
  `metric:table`'s value is live and `metric:series` refuses typed (NEGATIVE CONTROL: the extract's
  series); an uncaught `LiveFigureError` is a typed 409 (NEGATIVE CONTROL: any other throw, a bare
  500); L2.7's daily limit at the chart, KPI and answer doors (the case-fix lookup first) is a typed
  `dailyLimit` refusal (NEGATIVE CONTROL: lifted, the same chart answers). `test-liveRouteAnswers` (39): the case-fix statement × 25 hostile literals × 6 dialects
  (NEGATIVE CONTROL: an inlining dialect is caught), the JS key on DuckDB (NBSP, tab, case), 30
  values asked all fixed (NEGATIVE CONTROL: one LIMIT 20 fixes 20), the door (one lookup, bound keys,
  cached across case and order, a hostile answer filter = the extract's empty chart and the table
  intact); the live card's ledger holds the extract's figures label for label, `guardAnswer` passes
  a narration of them and catches an invented number (NEGATIVE CONTROL); copilot facts through a
  `vizDataFor` spy, the schema facts, a dashboard's live KPI card, the defined metrics (the warehouse
  down: that one left out, the others listed); `answer:explain`, the Summary card, alerts (a failing
  warehouse skips only that rule). `test-liveSafetyNet` (now over the fake warehouse, 145 checks):
  the routed doors — `answer:explain` and `answer:rerun` added — ANSWER, dated live; everything
  else still refuses, typed; a Live dataset whose connection is gone is a typed failure on every
  door, its canary SQL in no reply.
- **Merged with L2.5, L2.7 and L2.8** (the integration branch at 3722c2a), both sides kept:
  - **One source of a Live dataset's facts** for the Assistant: L2.5's `src/ai/liveFacts.ts`
    (columns, the sampled profile, bounded and labelled sample values, withheld columns), which now
    also lists the dataset's defined metrics with the warehouse's figures, in the ledger
    (`liveProfile.liveCopilotFacts(projectId, id, defined)`); this entry's `liveDatasetFacts.ts`
    is gone.
  - **A column the warehouse dropped** (L2.5 `missingColumns`) is refused `columnMissing` at every
    door: the chart and KPI doors no longer read it as a relationship's column, and the answer door
    says so before its case-fix lookup asks anything.
  - **The column panel**: a profiled Live dataset answers from its sample (L2.5); an unprofiled one
    is still refused up front (the chart door would otherwise route it to the warehouse).
  - **The case fix groups text as L2.8 does** (`keyText`: '' folded into NULL — an import stores ''
    as null, so '' is never a copy's spelling either).
  - **One door, one error class:** the lookup goes through L2.7's `warehouse()`
    (`liveWarehouse.ts`: slot, daily admission and count, `runLiveBound`, bytes), looked up at
    `agesOf(t).lookupMs` and kept for `keepMs` like every answer; `liveFlight.ts` keeps only the
    flights, rejecting with L2.7's `LiveCallError`.
  - The safety net's §5 (L2.5: a profile opens nothing but the pickers and the panel) skips the
    routed doors, which answer profiled or not — and checks that they do.
