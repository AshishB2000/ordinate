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
