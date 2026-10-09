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
