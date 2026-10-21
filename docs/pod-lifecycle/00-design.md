# A pod that stops cleanly, holds bounded memory, and shows what saturates

Branch `fix/pod-lifecycle`, batch 3 item 1, off `origin/develop` @ 46bbfc3d. Merge 1 of 5.

## What you will see

- **A rolling deploy is quiet.** On SIGTERM the pod stops taking new jobs, answers `/readyz` 503,
  lets running work finish, cancels what is still running at a deadline, ends every stream, closes
  every DuckDB worker through its own queue and exits 0, inside `SHUTDOWN_GRACE_SECONDS` (20 s by
  default). No `libc++abi … Napi::Error` in the log.
- **A job cut short by a restart says so.** The Jobs popover shows it Cancelled with "Ordinate
  restarted while this was running. Run it again." A job asked for while the pod drains is refused
  with "Ordinate is restarting. Try again in a minute."
- **An import cannot take the pod down.** A 4 MB bundle that declares 4 GiB, an unknown entry, a
  lying size or a crafted zip is refused before anything is written, or streamed to disk with the
  process's memory flat. Backup and restore of a whole org hold one project at a time, never the org.
- **`/metrics` shows what saturates:** the DuckDB queues, the Postgres pool, the event loop, memory,
  streams, Live queries in flight, and whether the pod is draining. The chart can ship a
  ServiceMonitor and alert rules; `docs/server/monitoring.md` says what each alert means and what to
  do.
- **Every server log line is pino JSON**, with the request id and org when there is a request. No
  `console.*` is left in `src/` (two CLI self-check blocks excepted, listed below).

## 1. The spec's decisions (condensed, not re-litigated)

1. One shutdown sequence in a new `src/server/shutdown.ts`, called from `main.ts`: draining (readyz
   503, `jobs.submit` refuses with a catalog sentence) → stop the scheduled-job runner and the bus →
   `jobs.drain(deadline)` (wait, then cancel through the signal; a cancelled job ends `cancelled` with
   the restart sentence and its owner gets the `jobs:changed` push before streams close) →
   `app.close()` → await detached work (`untilAborted`), interrupt every DuckDB call at the deadline →
   `await closeAll()` with the remaining budget (`closeEvery` takes a deadline; close through the
   queue, await `'exit'`, never `terminate()`) → `computePool.shutdown()` → `pool.end()` → exit 0, or
   log the org of a surviving worker and exit 1.
2. `SHUTDOWN_GRACE_SECONDS`, default 20, set by the chart from a value next to
   `terminationGracePeriodSeconds: 30` and the 5 s `preStop`; it must stay below grace − preStop
   (written in `values.yaml` and `configuration.md`).
3. In-process jobs stay in memory (persistence across restarts is Out); fix the `jobs.ts` header.
4. Bundle memory bounded by design, in a new module: positioned reads, never the whole upload in
   memory; every name checked against `ENTRY_RULES` from the central directory before anything is
   inflated; binary entries streamed through `zlib.createInflateRaw` to the org temp dir, counting
   actual bytes and aborting past the declared size; JSON entries in memory under a per-entry cap
   derived from the largest real record type.
5. Backup writes its zip entry by entry to a temp file with the inner bundles STORED; restore reads
   entry by entry inside the job; `projects:export` uses the async reader. `MAX_TOTAL_BYTES` then
   bounds disk, not memory. Import access (R13) unchanged.
6. Metrics in the hand-rolled `metrics.ts`, no dependency, no org label: `ordinate_duckdb_queue_depth`,
   `ordinate_duckdb_busy_workers`, `ordinate_duckdb_wait_seconds` (histogram, enqueue → start),
   `ordinate_pg_pool_clients{state}`, `ordinate_event_loop_delay_seconds{quantile}`,
   `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `nodejs_external_memory_bytes`,
   `ordinate_sse_streams`, `ordinate_live_queries_in_flight`, `ordinate_draining`.
7. `DATABASE_POOL_MAX` (default 10) replaces the fixed `max: 10`; `sizing.md`: `max_connections ≥ pods
   × (DATABASE_POOL_MAX + 1 for the bus)`.
8. Helm `metrics.serviceMonitor.enabled` and `metrics.prometheusRule.enabled`, both off; six rules,
   each linking its section of `docs/server/monitoring.md`.
9. One logger: replace `console.*` in `src/` with pino through a Node script; the process logger
   outside a request (`ctx()` throws there); then oxlint `no-console` for `src/**`, not `scripts/`.

## 2. What the code does today (inventory, re-read on 46bbfc3d)

Line numbers below are this tree's. Where the spec's numbers drifted it says so.

### 2.1 Shutdown path

| Where | What |
|---|---|
| `src/server/main.ts:74-83` | `process.once(SIGTERM/SIGINT)` → `metrics?.close()` → `app.close().then(exit 0, exit 1)`. A second signal gets Node's default handler (immediate exit). |
| `src/server/app.ts:179-224` | `onReady`: migrate, wire records/blobs/locks/secrets/orgConfig, `wireSchedules`, `wireSubscriptions`, `storage:gc`, then `startBus` (`:222`) and `startRunner` (`:223`). Handles kept in closure vars `jobs`, `bus` (`:177-178`). |
| `src/server/app.ts:227-230` | `preClose`: `await jobs?.stop(); await bus?.stop()`. |
| `src/server/app.ts:231-244` | `onClose`: un-wires every DB store (`useRecordDb(null)` …) then `await pool.end()`. |
| `src/server/app.ts:263-266` | `onSend`: `await orgConfig.flushed(org)`. |
| `src/server/app.ts:303-309` | per-`/api/` request `AbortController` (RPC timeout + client hang-up) → `runInContext(…, ac.signal)`. |
| `src/server/app.ts:324-330` | `/readyz`: `probe()` + `ping(pool)`; never looks at shutdown. |
| `src/server/app.ts:388` | the ONLY server caller of `untilAborted` (bigquery's `untilAborted` is an unrelated local function, `src/connectors/bigquery.ts:87`). |
| `src/server/app.ts:462` | `onClose` → sync `duck.shutdown()` (spec said `:462`, unchanged). |
| `src/server/sse.ts:247-250` | `preClose`: closes every stream this app opened. `streamCount()` `:151-153`. Pushes: `jobs.onChange` `:259-276`, `jobs.onFinish` `:277-279`. |
| `src/server/files.ts:241` | `onClose`: clears the token sweep timer. |
| `src/server/auth/password.ts:75`, `auth/index.ts:86` | `onReady` only. |
| `src/server/headers.ts:80`, `csrf.ts:79`, `limits.ts:90`, `metrics.ts:66` | request hooks, nothing at close. |
| `src/server/jobs/runner.ts:166-221` | `startRunner().stop()`: sets `stopped`, awaits the claim in flight with NO deadline; `runClaim` (`:123-163`) reschedules even on failure. Claimed runs have no abort signal (`runInContext` without one, `:136`). |
| `src/server/jobs/bus.ts:166-175` | `stop()`: `setFanOut(null)`, awaits the pending NOTIFY flush, ends LISTEN. After it, a push to a tab whose stream is on another pod goes nowhere. |
| `src/server/limits.ts:136-156` | `untilAborted`: races the handler against the request signal; the handler runs on, untracked. |
| Fastify 5.12.5 | `close()` sets `closing`, runs `preClose`, `server.close()` + `closeIdleConnections()` (`forceCloseConnections: 'idle'` default), answers NEW requests 503 with `Connection: close` (`lib/route.js:479-498`). Keep-alive timeout is 72 s. |

### 2.2 DuckDB close paths

| Where | What |
|---|---|
| `src/engine/duckdbPool.ts:162-165` | `DuckPool.shutdown()`: clears the sweep, `close(org)` each map entry. Waits for nothing. |
| `src/engine/duckdbPool.ts:236-242`, `:252-258` | `close()` drops the entry and posts `{kind:'close'}` once `waiting` drains (`:119`). |
| `src/engine/duckdbPool.ts:89`, `:110-121` | `waiting` counts calls between `get()` and their reply; `client.busy` counts posted calls. `idle()` `:95`. |
| `src/engine/duckdbPool.ts:197`, `:227` | `track(worker)`; `unref` once ready. |
| `src/engine/duckdbPool.ts:289-302` | `routeByOrg` → `duck.setRouter({… shutdown: () => pool.shutdown()})`. |
| `src/engine/duckdb.ts:382-393` | `shutdown()`: router shutdown, settle the bridge's own pending, `closeWorker(bridge)`. |
| `src/engine/duckdb.ts:401-404` | `closeAll()` = `shutdown()` + `closeEvery()`. One caller: `scripts/selfcheck.ts:42`. |
| `src/engine/duckdb.ts:618-628` | `callAsync` → `router.call` when routed. No "closed for good" state: a call after `closeAll()` spawns a NEW org worker. |
| `src/engine/duckdbClose.ts:28` | `GIVE_UP_MS = 120 000`. |
| `src/engine/duckdbClose.ts:40-53` | `closeWorker`: post close, `ref()` until `'exit'`; its catch does `void w.terminate()` (`:44`). `postMessage` on a Worker does not throw for a plain object, so the catch is effectively dead, but it is the one `terminate()` on this path. |
| `src/engine/duckdbClose.ts:60-70` | `closeEvery()`: resolves only when every tracked worker has emitted `'exit'`; no deadline on the promise (the 120 s timer only lets the loop end). |
| `src/engine/duckdbClient.ts:56-77` | per-call timeout/abort → `{kind:'interrupt', id}`; `fail()` `:80-86`. |
| `src/engine/duckdbWorker.ts:236-253` | `interrupt`/`stopRunning`: re-sends `connection.interrupt()` every 10 ms until the call settles. `:194` skips a call whose sender is `closed`. `:287-317` the message loop; `close` is queued (`:299`), `interrupt` and `port` are handled at once. |
| `src/engine/computePool.ts:161-165` | `shutdown()` terminates every compute thread. Never called. On the server a compute thread never loads DuckDB itself (`computeWorker.ts:10-12`, a leased port per op), so terminating one is safe; its port closing makes the org worker stop what that port was running (`duckdbWorker.ts:308-311`). |
| `src/engine/regexPool.ts:171` | JS-only threads; not on the shutdown path (they die with the process). |

### 2.3 Jobs (`src/app/jobs.ts`, 496 lines)

- `submit` `:204-238`, `cancel` `:241-256` (refuses non-`cancellable` jobs), `start` `:353-409`
  (`checkCancelled`, the reject branch maps only `JobCancelled`/`AbortError` to `cancelled`),
  `finish` `:411-427`, `emit` `:439-445`. Header `:29-34` claims persistence; `configure`/`restore`
  are called only by `scripts/test-jobs.ts:165-192`.
- **A job's DuckDB calls do not see its own signal.** `start` runs inside the submitter's async
  context (`within`, `:232`), so `ctx().signal` is the submitting REQUEST's signal; the job's
  `ctl.signal` reaches only `checkCancelled` and code that passes it on (computePool ops). A Cancel
  (or a drain) does not interrupt a job that is inside a DuckDB query.
- `submit` callers (22): `ipc/datasetCompose.ts:350`, `ipc/sqlQuery.ts:73` (`sql:prepareSave`, awaits
  `done` in the RPC), `ipc/insights.ts:79`, `ipc/quality.ts:26`, `ipc/text.ts:193`, `ipc/stats.ts:95`,
  `ipc/geoAnalysis.ts:48`, `ipc/projects.ts:151` (export), `:207` (import), `ipc/datasetImport.ts:30`,
  `ipc/settingsServer.ts:144` (backup), `:169` (restore), `ipc/publishServer.ts:92`,
  `ipc/backups.ts:35` (desktop-only safety copy, a no-op on the server), `automation/resolve.ts:63`,
  `ipc/segments.ts:120`, `:161`, `ipc/drivers.ts:427`, `data/snapshotRestore.ts:34`,
  `data/refreshJob.ts:54`, `engine/live/schemaSyncJob.ts:105`, `app/pipelineRunner.ts:54`.
- Other API users: `ipc/jobs.ts:14-22` (list/cancel/clear), `sse.ts:259`, `:277`, `metrics.ts:60`,
  `jobs.current()` in `data/datasets.ts:222` and `connectors/saasHttp.ts:242`;
  `recordExternal` only from `automation/jobLog.ts` (no entry point since T8.1).

### 2.4 Postgres pool

`src/server/db/pool.ts:12-20` (`max: 10`, comment names `DATABASE_POOL_MAX` as the upgrade);
`createPool` `:40-46`. Callers: `server/app.ts:170` (the server's pool),
`server/importDesktop.ts:127`, `server/secrets/rotate.ts:92`, `server/db/migrateMain.ts:21` (one-off
commands, keep the default). The bus opens its own LISTEN client outside the pool (`bus.ts:59-`).
Tests build their own `new Pool` (`scripts/test-jobs-pods.ts:175` and ~15 others) — untouched.

### 2.5 Every reader and writer of a bundle zip

| Code | Today |
|---|---|
| `src/app/bundle.ts:49-83` | `ENTRY_RULES` (case-insensitive regexes), `MAX_ENTRIES` 50 000, `MAX_ENTRY_BYTES` 1 GiB, `MAX_TOTAL_BYTES` 4 GiB − 1. |
| `bundle.ts:117-193` | `writeZip` / `writeZipAsync` / `assemble`: whole zip as one Buffer (`Buffer.concat`). |
| `bundle.ts:198-255` | `zipDirectory` / `readZip` / `readZipAsync`: needs the whole file as a Buffer; checks declared sizes; local header read only for its lengths (not compared with the CD); no overlap check; no zip64/descriptor/flag checks beyond bit 0. |
| `bundle.ts:267-311` | `peekManifest`: positioned tail read (desktop backups list). |
| `bundle.ts:343-387` | `exportProject`: every file into memory, then `writeZipAsync`. |
| `bundle.ts:418-522` | `importBundle(bytes)`: `readZipAsync` inflates EVERY entry (`:421`), THEN the whitelist (`:429-432`). |
| `src/ipc/projects.ts:140-181` | `projects:export` job: `exportProject` → `sharePolicy.applyToBundle` → temp file → download token. |
| `src/ipc/projects.ts:183-198`, `:205-231` | `projects:import` → `importBundleFile(upload.path)` → `recordFs.readFile(file)` (whole upload) → `importBundle`. |
| `src/app/sharePolicy.ts:345-414` | `applyToBundle`: `readZip(bytes)` (sync `inflateRawSync` on the main thread, `:348`), `writeZip` (`:413`). Default policy `bundle: 'mask'` (`privacyStore.ts:47`), so EVERY export reads it. |
| `src/ipc/settingsServer.ts:57-88` | `writeBackup`: every project's bundle into `entries`, then `writeZipAsync` (inner bundles deflated again), then `writeFile`. |
| `src/ipc/settingsServer.ts:91-117` | `readBackup(bytes)`: `readZipAsync` of the whole backup into a Map. |
| `src/ipc/settingsServer.ts:160-198` | `backups:restore`: reads and validates the backup IN THE RPC (`:164`), then a job imports each Buffer. |
| `src/app/backups.ts:116-131`, `:220-227` | desktop `backupProject` (exportProject bytes → file), `restoreBackup` (`readFile` → `importBundle`). |
| `src/app/themeStore.ts:165`, `userTemplateStore.ts:108` | `importBundleThemes/Templates(entries, swap)`: each reads only its own entry. |
| Tests that build or read zips | `test-bundle.ts:78-250`, `test-sharePolicy.ts:236-312`, `test-settings-server.ts:171-195`, `test-projects-server.ts:162`, `test-backups.ts:151-167`, `test-securityReview.ts:79-83`, `test-comments.ts:331-334`, `recordsScenario.ts:246-247`. |

### 2.6 Metrics, chart, compose

- `src/server/metrics.ts:111-145` (families), `:152-166` (listener). Validator in
  `scripts/test-promMetrics.ts:40-110` accepts `summary`.
- `liveBudget.ts:129-133` `stats(org)` is per org only. `sse.ts:151` `streamCount()`.
- Chart: `values.yaml:95-100` metrics (the ServiceMonitor mention is at `:94`), `:116-122` resources
  (2Gi limit; DuckDB takes 80 % of it by default — so Node's own heap and buffers live in ~400 MiB),
  `:191` `terminationGracePeriodSeconds: 30`; `deployment.yaml:51` grace, `:88-90` `preStop: sleep 5`
  (hard-coded). `_helpers.tpl` `$owned` list refuses chart-owned env names. `deploy/helm/ci/kind-e2e.sh:38-75`
  lints and renders.
- `deploy/docker-compose.yml:70-` has no `stop_grace_period`: Compose's default is **10 s**, below a
  20 s budget. `docs/server/ecs.md:80` sets `stopTimeout: 30`.

### 2.7 `console.*` in `src/` — 114 calls, not 53

The spec counted six directories. `grep -rnE '\bconsole\.(log|warn|error|info|debug|trace)\b' src` finds
**114** in 50 files: `ai` 32, `app` 22, `formula` 17, `ipc` 12, `analysis` 11, `engine` 9, `data` 4,
`server` 4, `connectors` 2, `publish` 1. The six the spec counted match its 53 exactly.

| Files (count) |
|---|
| `formula/calc.ts` 17 and `ai/headline.ts` 10 — all inside `if (require.main === module)` self-check blocks (`calc.ts:430-606`, `headline.ts:268-367`); nothing runs them directly (`test-importServer.ts:127-128` only `require`s the modules). |
| `ai/analyze.ts` 17 — including a "VERIFICATION (dev)" dump at `:314-327` that prints every extracted row and column to stdout at info level on every analysis. |
| `app/sampleProject.ts` 5, `app/privacyStore.ts` 5, `ipc/liveDatasets.ts` 3, `engine/live/schemaSync.ts` 3, `app/history.ts` 3, `ai/analyzeStream.ts` 3, `server/live/limitNotice.ts` 2, `ipc/incremental.ts` 2, `engine/residentTrace.ts` 2, `data/snapshots.ts` 2, `connectors/connections.ts` 2, `app/versions.ts` 2, `analysis/alertStore.ts` 2. |
| 1 each: `server/subscriptions/deliver.ts`, `server/mail/emailChannel.ts`, `publish/hosted.ts`, `ipc/datasets.ts`, `ipc/datasetCompose.ts`, `ipc/copilot.ts`, `ipc/connections.ts`, `ipc/captureDataset.ts`, `ipc/backups.ts`, `ipc/alerts.ts`, `engine/snapshotDiff.ts`, `engine/live/schemaSyncJob.ts`, `engine/live/liveWarehouse.ts:67`, `engine/live/liveBudget.ts`, `data/sensitivity.ts`, `data/datasets.ts`, `app/userTemplateStore.ts`, `app/themeStore.ts`, `app/projects.ts`, `app/pipelineRunner.ts`, `app/catalog.ts`, `app/captureRecord.ts`, `app/blobStore.ts`, `analysis/visuals.ts`, `analysis/stories.ts`, `analysis/scorecards.ts`, `analysis/scenarios.ts`, `analysis/relationships.ts`, `analysis/qualityRun.ts`, `analysis/metrics.ts`, `analysis/eventStore.ts`, `analysis/analysis.ts`, `ai/models.ts`, `ai/copilot.ts`. |

Tests that capture `console.*` to assert on logging: `scripts/test-residentTrace.ts:20-30`,
`scripts/liveQueryHarness.ts:127-135`, `scripts/test-incrementalSettings.ts:190-201`,
`scripts/test-sharePolicy.ts` (`logged`, the salt check). `pino` is not a direct dependency
(Fastify's, 10.4.0); `app.log` is a pino instance with `REDACT_PATHS`.

## 3. Decisions where the spec leaves room

### 3.1 The shutdown sequence and its budget

`T = SHUTDOWN_GRACE_SECONDS`, measured from the signal. Every step proceeds the moment its await
settles; the deadlines are caps, so an idle pod exits in milliseconds. Each step is wrapped so a
failure is logged and the sequence continues — nothing may skip the DuckDB close.

| # | Step | Awaits | Cap (from the signal) | At the cap |
|---|---|---|---|---|
| 1 | `draining = true`; `jobs.refuseNew(Restarting)`; log `shutting down {budgetMs}` | nothing | — | — |
| 2 | `runner.stop()` started (no new claims) | (awaited together with step 3) | `0.5 T` | move on; the claimed row's lease lapses and another pod retakes it (the runner's crash path) |
| 3 | `jobs.drain(0.5 T)`: queued jobs cancelled now with the restart sentence; running jobs awaited | running jobs settle | `0.5 T` | `ctl.abort(reason)` on every running job, wait ≤ `min(1 s, 0.05 T)` more; a job still running then is finished `interrupted` with the same sentence and emitted |
| 3b | `bus.stop()` (flushes the pending NOTIFYs) — AFTER the drain | the flush | `0.7 T` | move on |
| 4 | `app.close()`: preClose ends every SSE stream; in-flight HTTP finishes | the close callback | `0.7 T` | abort every in-flight `/api/` request's signal with `Restarting` (the route answers 503 with the sentence; their DuckDB calls are interrupted by that same signal), wait ≤ 250 ms for the replies to flush, then `server.closeAllConnections()` |
| 5 | detached work: `Promise.allSettled(set)` | every handler promise still running | `0.8 T` | `duck.interruptAll()`: refuse new calls, interrupt every running DuckDB call in every worker, skip every queued one |
| 6 | `duck.closeAll(0.95 T)`: close posted through each worker's queue, each `'exit'` awaited | every DuckDB worker's `'exit'` | `0.95 T` | the survivors' orgs are returned |
| 6b | `computePool.shutdown()` then `pool.end()` | thread exits; pg clients released | `T` | move on (pg rolls back a dropped transaction) |
| 7 | exit | — | — | 0; or, with a DuckDB survivor, log `{orgs}` at error and exit 1 |

At T = 20 s: jobs 10 s, HTTP until 14 s, detached until 16 s, DuckDB close until 19 s, Postgres until
20 s. Why this split: jobs are the long tail (an import or a refresh runs for seconds to minutes),
so they get half; an RPC that awaits a job (`sql:prepareSave`, `projects:export`, `backups:*`)
finishes right after its job is cancelled, so 4 s covers the HTTP that is left; interrupting DuckDB
is measured at ~2 ms (`duckdbWorker.ts:231`) and a worker's queued exit at milliseconds, so 3 s
for step 6 is generous headroom for freeing a large in-memory instance.

Further decisions in this sequence:

- **The bus stops after the drain, not with the runner.** A job's `client` can be a REMOTE tab
  (`sse.ts:132-148`): its `jobs:changed` push travels over the bus. Stopping the bus first (today's
  preClose order) would lose exactly the push the spec requires. Keeping it up also lets item 4's
  cross-pod Cancel reach a draining pod.
- **Runner and drain overlap.** `runner.stop()` awaits the claimed run with no deadline, and a
  scheduled refresh can itself await an in-process job; awaiting the runner first would hold the
  drain hostage. Both start at once and share the `0.5 T` cap.
- **A scheduled run that fails while draining is not recorded.** `runClaim` skips its
  reschedule `UPDATE` when `isDraining()` and the run threw (refused by `jobs.submit`, or interrupted
  at step 5): the lease lapses and another pod retakes the row within `LEASE_MS + POLL_MS`, instead
  of the run being pushed a whole interval out as "failed". It also never touches a pool that step 6b
  is ending.
- **Every response while draining carries `Connection: close`** (one line in app.ts's existing
  `onSend`). Fastify only does this for requests that ARRIVE after `close()` began; a request
  already in flight would otherwise leave a keep-alive socket that holds `server.close()` for up to
  the 72 s keep-alive timeout. The step-4 cap is the backstop.
- **`/readyz` answers 503 `{ok:false, draining:true}` without probing** while draining.
- **app.ts's DB `onClose` does nothing while draining.** Today it un-wires every store
  (`useRecordDb(null)` …) and ends the pool inside `app.close()` — at step 4, while step 5's detached
  work may still save a record. Un-wired, recordFs silently falls back to JSON FILES on the pod's
  disk: a save that "succeeds" and is lost. Under the shutdown sequence nothing is un-wired;
  shutdown.ts ends the pool at 6b, so anything later fails loudly. Tests that build an app and call
  `app.close()` (draining false) keep today's teardown. The module-level `dbPool` is never nulled
  (a null pool reads as the no-database dev mode in several registrations).
- **The `app.ts:462` hook goes.** Tests rely on `selfcheck.finish()` → `closeAll()`, which already
  closes every worker; an in-process `app.close()` no longer shuts DuckDB down under the test.
- **Repeated signals are ignored** (`process.on`, logged once). The budget bounds the wait; a forced
  exit is a SIGKILL away, and a second Ctrl-C exiting around a busy worker is the abort this fixes.
- **The metrics listener is left open** until the exit, so `ordinate_draining 1` can be scraped.
- **Compose gets `stop_grace_period: 30s`** (its 10 s default is below the budget). ECS already sets
  `stopTimeout: 30`. The chart adds `shutdownGraceSeconds: 20` beside
  `terminationGracePeriodSeconds`, owns `SHUTDOWN_GRACE_SECONDS` (added to `$owned`), and `fail`s the
  render when `shutdownGraceSeconds >= terminationGracePeriodSeconds - 5`.

New modules: `src/server/lifecycle.ts` (a leaf: the draining flag, `Restarting` / `isRestarting`, the
in-flight request and detached-work registries), `src/server/lifecycleMessages.ts` (the two catalog
sentences), `src/server/shutdown.ts` (the sequence), `src/server/podEnv.ts` (`SHUTDOWN_GRACE_SECONDS`
1–300 and `DATABASE_POOL_MAX` 1–1000, parsed like `liveEnv.ts`, re-exported through `env.ts`).
`untilAborted` registers every handler promise in the detached set (`p.then(del, del)`, never
`finally`, which would re-raise); app.ts registers each request's `AbortController` and removes it
on reply close.

### 3.2 Interrupting a DuckDB call at the deadline without `terminate()`

1. **A new worker message `{kind:'stop'}`, handled at once like `interrupt`** (not through the
   queue): every sender of that worker (its parent and every leased compute port, kept in a set
   by `listen`) is marked `closed`, and `stopRunning()` interrupts the running call every 10 ms until
   it settles. Queued calls are skipped when their turn comes (`duckdbWorker.ts:194`, the existing
   path). The queued `close` then runs `closeNow()` — the one exit measured safe.
2. **`duck.interruptAll()`** (in `duckdbClose.ts`, over its `alive` set, so the bridge's worker and
   every pool worker are covered, including ones already closing or still starting) posts `stop`,
   then fails each pool client's pending promises with `unavailable` so nothing on the main thread
   waits for a reply. It also sets a **closed-for-good** flag in `duckdb.ts`: from then on
   `callAsync` and `leasePort` reject with `unavailable` instead of spawning a fresh worker that the
   exit would then abort around. `closeAll()` sets the same flag (so `selfcheck.finish` is covered);
   plain `shutdown()` does not (tests reuse the bridge after it).
3. **`closeEvery(deadlineAt?)`** resolves with the labels of workers still alive at the deadline
   (`track(worker, label)`: the org id, `probe`, or `bridge`), never waits past it, and never
   terminates. Default deadline: today's 120 s, so `selfcheck.finish` is unchanged.
4. **`closeWorker`'s catch no longer calls `terminate()`**: it is unreachable for a plain-object
   `postMessage`, and the trap says it must never be reached on the server; removing it makes that
   true everywhere.
5. A native step that ignores interrupts (a stuck httpfs read, an extension load during start-up)
   leaves its worker alive at `0.95 T`: logged with its org, exit 1. That exit may itself abort
   natively; the pod was going to be SIGKILLed anyway. It is the one known way to an abort and it is
   logged first.

A job's DuckDB calls get the job's signal: `jobs.start` runs `spec.run` under
`withAbort(ctl.signal)` (new in `context.ts`: the current store with
`signal = AbortSignal.any([store.signal, ctl.signal])`; no store, no change). So `ctl.abort()` — a
user's Cancel or the drain — interrupts the query the job is in. The request's signal still applies,
as today.

### 3.3 The jobs drain and the refusal

- `jobs.refuseNew(make: (() => Error) | null)`: while set, `submit` throws `make()`. jobs.ts imports
  nothing new; shutdown.ts passes `() => new Restarting(restarting())`.
- `jobs.drain(deadlineAt, reason, sliceMs)`: as in the table above. The reject branch of `start`
  reads `ctl.signal.reason === reason` → `cancelled` with `reason.message`, whatever the run threw
  (an interrupted DuckDB call rejects with a DuckDBError, not a `JobCancelled`). A run that resolves
  after the abort is still `done` (today's rule: its output exists).
- The `interrupted` finish of a job that ignored its signal is guarded: `start`'s settle skips
  `finish` when the job is already final, so a late settle in a test cannot overwrite it.
- The route answers an uncaught `Restarting` 503 `{error:'restarting', code:'restarting', message}`;
  the web client already shows `message` (`web/src/api/client.ts:107-108`). Handlers that catch and
  return `{ok:false, error: err.message}` show the same sentence.
- Not refused: sign-in and sign-out, `/api/events` (reconnects), every RPC that does not submit a
  job, `jobs:list|cancel|clear`.
- Header `jobs.ts:29-34` rewritten: memory only on the server; the file is a test fixture's.

### 3.4 The zip reader (`src/app/zipReader.ts`) and hostile input

`openZip(source, policy)` where `source = { file, offset?, length? }` (a range lets restore read a
STORED inner bundle in place) and `policy = { nameOk(name), capOf(name), maxEntries, maxTotal }`.
It opens one `FileHandle` (no TOCTOU between checks and reads), validates the whole structure with
positioned reads, and inflates NOTHING. Then:
`read(entry)` → Buffer (≤ its cap, `zlib.inflateRaw` async with `maxOutputLength = usize`, CRC
checked); `extract(entry, dest, signal)` → streamed `fh.createReadStream({start,end})` →
`zlib.createInflateRaw()` → a counting/CRC `Transform` → `createWriteStream(dest, {flags:'wx'})`,
`stream.pipeline` with the job's signal; `verify(entry)` → streamed CRC of a stored range.

| Hostile input | Handling |
|---|---|
| **EOCD search** | Scan back over the last `22 + 65535` bytes for `0x06054b50` whose comment length ends EXACTLY at the end of the source. A forged EOCD inside a comment or inside data fails that test. None → "not a bundle". |
| **zip64** | Refused: `0xFFFF` counts, `0xFFFFFFFF` CD size/offset or any entry's csize/usize/offset, or a zip64 locator `0x07064b50` at EOCD − 20. Our writer never needs it (≤ 0xFFFF entries, < 4 GiB). |
| **Multi-disk** | Disk numbers ≠ 0, or "entries on this disk" ≠ total → refused. |
| **CD outside the file** | `cdOffset + cdSize` must EQUAL the EOCD offset (no gap, no overlap with the EOCD), `cdSize ≤ 16 MiB` (our 50 000-entry directory is ~7 MB), and the walk must consume exactly `cdSize` bytes for exactly `count` entries. |
| **Flags** | Only bit 11 (UTF-8) and bits 1–2 (deflate level hints) are allowed. Bit 0/6 (encryption), **bit 3 (data descriptor)**, bit 13 (masked headers), anything else → refused. Descriptors are refused rather than tolerated because they are the one case where the local header may legitimately disagree with the CD; Ordinate never writes one. |
| **Compression method** | 0 or 8 only, from the CD, before any read. |
| **Names** | `nameLen ≤ 1024`; decoded with `TextDecoder('utf-8', {fatal:true})` (bit 11) or ASCII-only without bit 11; then `policy.nameOk`. Bundle: `ENTRY_RULES` (anchored, ASCII-only) AND canonical case: after removing the history timestamp (`KEY`, which legitimately has `T`/`Z`) no upper-case letter is allowed, so `DATASETS/x.JSON` cannot land beside `datasets/` on a case-insensitive volume or escape the record router (`isRecordPath` is case-sensitive). `..`, `/abs`, `\`, NUL, control chars and every non-ASCII trick fail the anchored ASCII rules; JS `/i` without `/u` never folds `ſ`/`K` (U+212A) to ASCII, pinned by a test. Backup: `backup.json` or `^[^/\\]+\.ordinate$`; these names are keys, NEVER paths (an inner bundle is read in place or extracted to a UUID-named temp file). |
| **Duplicates** | Key `name.normalize('NFC').toLowerCase()`; a second one → refused (covers case and NFC/NFD variants). |
| **Declared sizes** | Per entry `usize ≤ policy.capOf(name)`; Σ usize ≤ `maxTotal` (4 GiB − 1); stored ⇒ `csize === usize`; deflate ⇒ `csize ≤ source length`. All from the CD, before any data read. |
| **Local header vs CD** | Each local header (30 bytes + name) read at its CD offset: signature, flags, method, CRC, csize, usize, name length and name BYTES must equal the CD's. The local extra length is read for the data offset; extra CONTENTS are ignored everywhere (nothing we use comes from them, so a zip64 or timestamp extra cannot change a decision). |
| **Overlapping entries** | Every `[localOffset, dataStart + csize)` lies inside `[0, cdOffset)`; sorted by offset, each ends at or before the next starts. Kills the overlapping-data (non-recursive) zip bomb and any entry pointing into the directory. |
| **Actual vs declared size** | JSON/asset: `maxOutputLength = usize` (zlib refuses more), then `length === usize`. Streamed: the Transform counts and destroys the pipeline the moment output exceeds `usize`; at the end the count must equal `usize`. The partial file is deleted. |
| **CRC** | crc32 over the inflated bytes (`zlib.crc32(chunk, prev)` while streaming), compared at the end; mismatch → refused, partial deleted. A stored inner bundle's outer CRC is verified (streamed) before it is imported. |
| **Truncated / corrupt deflate** | zlib's error → refused with the entry's name. |
| **Comment and extra lengths** | EOCD comment must end at EOF; CD extra + comment lengths are bounded by the exact-consumption walk; local extra by the overlap/bounds check. |
| **Errors** | One `ZipRefused` with a catalog sentence (`src/app/bundleMessages.ts`) naming the entry, never a path or offset. `importBundle` maps it to `{ok:false, error}` as today. |

Order inside `importBundle` (moved to a new `src/app/bundleImport.ts`; `bundle.ts` re-exports it so
every caller and test keeps `bundle.importBundle`):

1. `openZip` (structure + names + declared sizes; nothing inflated). An unknown name is refused here.
2. `manifest.json` read (≤ 1 MiB, as `peekManifest`); format/version check; counts from CD NAMES; the
   alerts count from `alerts.json`; manifest mismatch → refused.
3. **Pass 1 over the in-memory kinds** (JSON and assets), one entry at a time: read (inflate, size,
   CRC), scan UUIDs on `buf.toString('latin1')`, keep only ids already in use here (`idsInUse()`),
   drop the buffer.
4. **Stage the streamed kinds** (Parquet) into `temp()/bundle-<uuid>/<n>` (UUID-named files, never
   entry names).
5. Only now `createProject`; **pass 2** re-reads each JSON entry, swaps ids and writes the record;
   assets are re-read and `writeBlob`; staged Parquet is renamed into place (`EXDEV` → copy + unlink).
   Project extras, themes and templates read their own entries.
6. Any failure after 5 → `deleteProject` (today's rule); `finally` removes the staging dir and closes
   the handle.

So nothing is created until every entry has been inflated and checked. JSON is inflated twice
(CPU, not memory). The id swap runs on latin1 text: byte-exact for any input (UTF-8 multi-byte
sequences are ≥ 0x80 and never match `[0-9a-f-]`) and a one-byte V8 string, half the memory of the
UTF-16 decode it replaces. `importBundle(Buffer)` stays for the tests: it writes the bytes to a temp
file and imports that, so every existing hostile-bundle test now runs through the new reader.

The ENTRY_RULES, caps, `BUNDLE_FORMAT` and `ruleFor` move to a leaf `src/app/bundleRules.ts`
(imported by `bundle.ts` and `bundleImport.ts`; no cycle). `bundle.ts` drops from 522 lines to
about 360.

### 3.5 The per-entry caps

| Kind | Cap | Why |
|---|---|---|
| JSON (any `.json`) | **32 MiB** | The largest real record type is an **input table's version** (`history/dataset/<id>/<key>.json`, `inputTable/store.ts:102-105`): it holds the whole base table, at most 10 000 rows × 50 columns (`inputTable/columns.ts:40-41`), compact JSON. Measured: 5.6 MiB with typical cells (8-digit numbers, 12-character labels); **30.1 MiB with a 60-character string in every cell**. Everything else is far smaller: a record a person edits arrives in one RPC (`MAX_RPC_BODY_KB`, 1 MiB by default); a 16 384-column dataset's record with its source columns, pretty-printed, is 4.4 MiB. 32 MiB covers a full input table of 60-character cells. Peak memory per entry ≈ 4 × 32 MiB (raw, inflated, latin1 text, swapped copy) ≈ 128 MiB, half the 256 MB bound. A v2 desktop record with rows inline over 32 MiB is refused ("re-export it from a current version"); the server never writes v2 records. |
| `manifest.json`, `backup.json` | 1 MiB / 32 MiB | the manifest as `peekManifest` reads it; `backup.json` lists projects (2 MB at 10 000 projects). |
| Assets (`assets/<id>.png|jpg|svg`) | **5 MiB** | `projectAssets.MAX_ASSET_BYTES`; `writeBlob` refuses more anyway. Refused from the CD now, not after half the project is written. |
| Parquet | 1 GiB (unchanged `MAX_ENTRY_BYTES`) | streamed; never in memory. |
| Total | 4 GiB − 1 (unchanged) | now a DISK bound (staging + project), not memory. |
| Backup inner bundle | 4 GiB − 1 | read in place (stored) or streamed to temp (a deflated one from an older backup). |

### 3.6 Backup, restore, export

- **Backup** (`writeBackup`): a new `src/app/zipWriter.ts` `ZipFileWriter` appends entry by entry to
  `temp()/backup-<uuid>.zip` (mode 0600) — local header, body, central record kept in memory (46
  bytes + name per entry), CD and EOCD at `close()`. Each project's bundle is added **stored**
  (`{store:true}`, crc32 over the buffer) the moment it is exported; `backup.json` is written LAST
  (its counts are known only then; readers look it up by name). The header builders move out of
  `bundle.ts`'s `assemble` into `zipWriter.ts` and `assemble` uses them, so `writeZip` stays
  byte-identical (pinned by a differential test: writer output ≡ `writeZip` output). Memory: one
  project's bundle at a time, never the org.
- **Restore** (`backups:restore`): the RPC resolves the upload and submits the job; EVERYTHING else
  runs inside the job: `openZip(upload)` with the backup policy → `backup.json` → the same-set check
  (unchanged rule) → for each project: a stored inner bundle is `verify`-ed and imported IN PLACE as
  a range of the upload (no copy); a deflated one (a backup made before this change) is streamed to
  `temp()/restore-<uuid>.ordinate` and imported from there, then deleted. The RPC still awaits the
  job and calls `up.done()` in `finally`, so the file lives exactly as long as the job. A refused
  backup is now a failed `restore` job carrying the sentence; the reply shape is unchanged.
  `readBackup` (exported, no caller outside the file) is replaced by the job's reader.
- **`projects:export`**: `applyToBundle` uses `readZipAsync` / `writeZipAsync` (inflate and deflate on
  libuv's pool, never the main thread). Its input is our own freshly written bundle, so the old
  in-memory reader is fine there. **Ceiling, stated:** one project's export is built in memory
  (~3 × its bundle) — what the spec prescribes. The hostile path (import) and the org-wide paths
  (backup, restore) are bounded by design; streaming `exportProject` to a file is the named upgrade
  if one project's Parquet approaches the pod's memory (`ponytail:` note at the call).
- **Desktop paths**: `app/backups.ts restoreBackup` imports `{file}` instead of reading it.
  `peekManifest` is untouched.
- **S3 mode**: unchanged. A bundle's Parquet still lands on the pod's disk (open since T5.2,
  `log.md:636`); not this item.

### 3.7 Metrics

| Series | Type | Source |
|---|---|---|
| `ordinate_duckdb_queue_depth` | gauge | Σ over org workers of calls handed to the worker that have not started: `waiting − 1` for a ready worker with a call running, `waiting` while it starts. Compute-thread calls over a leased port are not visible on the main thread (counted by the compute-pool series). |
| `ordinate_duckdb_busy_workers` | gauge | workers that are not `idle()` (a call waiting, in flight, or leased). |
| `ordinate_duckdb_wait_seconds` | histogram (the request buckets) | **worker-measured**: the worker stamps each message's arrival and every async reply (including "cancelled before it started") carries `queued` µs; the main side observes it before matching the id, so a call cancelled while still queued is counted too. Plus the main-side wait for a starting worker's `ready`. |
| `ordinate_pg_pool_clients{state="total|idle|waiting"}` | gauge | pg's `totalCount`, `idleCount`, `waitingCount`; the pool is handed to metrics by app.ts after `createPool`. Absent without a database. |
| `ordinate_event_loop_delay_seconds{quantile="0.5|0.9|0.99|1"}` | gauge | `perf_hooks.monitorEventLoopDelay({resolution: 10})`, started with the metrics listener, **reset after each scrape** (prom-client's practice); `1` is the max. A gauge, not a summary: a reset window cannot honestly carry `_sum`/`_count` counters. |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `nodejs_external_memory_bytes` | gauge | `process.memoryUsage()` |
| `ordinate_sse_streams` | gauge | `streamCount()` |
| `ordinate_live_queries_in_flight` | gauge | new `liveBudget.inFlight()`: Σ running over orgs |
| `ordinate_draining` | gauge | 0/1 |

No org label anywhere. The DuckDB stats live in `duckdbPool.ts` (`poolStats()`, like
`computePool.stats()`); `metrics.ts` only renders, so the engine never imports the server.

### 3.8 Helm and the monitoring doc

- `metrics.serviceMonitor: {enabled: false, interval: 30s, labels: {}}` → `templates/servicemonitor.yaml`
  selecting the existing `-metrics` Service (`app.kubernetes.io/component: metrics`), port `metrics`.
- `metrics.prometheusRule: {enabled: false, labels: {}, runbookBaseUrl:
  https://github.com/AshishB2000/ordinate/blob/develop/docs/server/monitoring.md}` →
  `templates/prometheusrule.yaml`, rules scoped `namespace=<release ns>, job=<fullname>-metrics`,
  each with `runbook_url: <base>#<anchor>`:

| Alert | Expression (sketch) | for |
|---|---|---|
| `OrdinateDuckDBWaitHigh` | `histogram_quantile(0.95, sum by (le, pod) (rate(ordinate_duckdb_wait_seconds_bucket[5m]))) > 5` | 10m |
| `OrdinatePgPoolWaiting` | `max by (pod) (ordinate_pg_pool_clients{state="waiting"}) > 0` | 5m |
| `OrdinateEventLoopLag` | `max by (pod) (ordinate_event_loop_delay_seconds{quantile="0.99"}) > 0.5` | 5m |
| `Ordinate5xxRatio` | (rpc + http 5xx rate, each `or vector(0)`) / (rpc + http total rate) `> 0.05` | 10m |
| `OrdinateMemoryNearLimit` | `container_memory_working_set_bytes{container="ordinate"} / on(namespace,pod,container) kube_pod_container_resource_limits{resource="memory",container="ordinate"} > 0.9` (cAdvisor + kube-state-metrics) | 5m |
| `OrdinateContainerRestarts` | `increase(kube_pod_container_status_restarts_total{container="ordinate"}[15m]) > 0` | 0m |

- `kind-e2e.sh` gains `helm lint --strict` and `helm template` with both flags on (and a check that
  both kinds render); the server-side dry-run apply stays without them (kind has no Prometheus
  Operator CRDs).
- `docs/server/monitoring.md`: every series (meaning, unit, labels), every alert (what it means, the
  first three things to look at, the knob: `DUCKDB_MAX_WORKERS`/`DUCKDB_THREADS`/replicas,
  `DATABASE_POOL_MAX` + `max_connections`, CPU-bound handlers, memory limit vs `DUCKDB_MEMORY_LIMIT`,
  the restart's last log lines), and the 5xx note that a deploy's draining 503s are short and the
  10 m window absorbs them.

### 3.9 The logger

- `src/app/logger.ts`: `logger.debug|info|warn|error(...args)` — console-compatible on purpose, so the
  codemod is a rename: the arguments are `util.format`-ed into `msg`, an `Error` argument becomes
  `err`. Inside a request (a non-throwing `currentContext()` added to `context.ts`) it logs through
  `base.child({ reqId, org })`; outside, through `base`. `base` is `app.log` (pino, with
  `REDACT_PATHS`), installed by `buildApp` via `useLogger(app.log)`; before that (tests, worker
  threads) a 10-line fallback writes pino-shaped JSON lines to stderr. No pino import, no new
  dependency.
- The codemod (a Node script, run once, not committed): `console.log|info` → `logger.info`,
  `console.warn` → `logger.warn`, `console.error` → `logger.error`, `console.debug` → `logger.debug`,
  plus the import at the right relative path; it fails loudly on a file that already binds `logger`.
- Hand fixes after it: `ai/analyze.ts:314-327` (the dev dump) becomes ONE `logger.debug` line with
  shapes and counts only — no rows, no columns, no cell values (user data stays out of logs at any
  level).
- Allowed exceptions (listed in the PR): the `require.main === module` self-check blocks of
  `src/formula/calc.ts` and `src/ai/headline.ts`, wrapped in `/* oxlint-disable no-console */ …
  /* oxlint-enable */` — a CLI self-check's stdout is its interface.
- `.oxlintrc.json`: an override `{ files: ["src/**"], rules: { "eslint/no-console": "error" } }`.
- The four suites that captured `console.*` switch to `scripts/logCapture.ts` (`useLogger` with a
  recording logger, restored in `finally`); their negative controls stay (the planted path / the warn
  line must still be seen).

### 3.10 The negative-control abort count

The emitted `src/server/main.js` and `app.js` are gitignored build output, so the old behaviour is
restored without touching tracked files: after `npm run build:ts`, a scratch script (in the
scratchpad) rewrites the emitted `main.js` SIGTERM handler back to `app.close().then(() =>
process.exit(0), () => process.exit(1))` and re-adds `app.addHook('onClose', async () =>
duck.shutdown())` to the emitted `app.js`. Then `node scripts/test-server-boot.js` runs its SIGTERM
loop unchanged, in both modes, and the counts are taken from its per-iteration lines:
**aborts** (exit by `SIGABRT`/134, or `libc++abi`/`Napi::Error` in stderr) and **overruns** (still
alive at `SHUTDOWN_GRACE_SECONDS + 3 s`, then SIGKILLed by the test, as the kubelet would). Then
`npm run build:ts` again restores the real build. Both numbers go in the PR body. If the old path
shows 0 aborts, that is reported as measured, with the overrun count as the discriminating number.

## 4. Steps, in commit order

Each step is a small series of commits; every commit builds and its suites pass.

1. **Shutdown.**
   1. `duckdbClose`/`duckdbWorker`/`duckdb`/`duckdbPool`: `stop` message, `interruptAll`,
      closed-for-good, `closeEvery(deadline)` returning labelled survivors, no `terminate()`. Tests in
      `test-duckdbPool.ts` (or a new suite if it would pass 500 lines).
   2. `jobs.ts`: `refuseNew`, `drain`, `withAbort` (context.ts), the reject-branch reason, the guarded
      settle, the header. Cases in `test-jobs.ts`.
   3. `lifecycle.ts`, `lifecycleMessages.ts`, `podEnv.ts` (`SHUTDOWN_GRACE_SECONDS`), `shutdown.ts`;
      `main.ts` wiring; app.ts (readyz, `Connection: close`, request registry, `Restarting` 503, the
      DB `onClose` guard, `background()`/`appPool()` getters, `:462` removed); `limits.ts` registry;
      `runner.ts` draining skip; MAIN_FILES; compose `stop_grace_period`; chart value, `$owned`, the
      `fail`; `configuration.md`.
2. **`test-server-boot` extension** (both modes), then the negative-control scratch run.
3. **Zips.**
   1. `bundleRules.ts` (moved), `zipReader.ts`, `bundleMessages.ts`, `scripts/test-zipReader.ts`.
   2. `bundleImport.ts` (streamed import), `importBundleFile`, desktop `restoreBackup`;
      `scripts/test-bundleMemory.ts` (import cases).
   3. `zipWriter.ts`, backup writer, restore inside the job; `test-bundleMemory` backup/restore case.
   4. `sharePolicy.applyToBundle` on the async reader/writer.
4. **Metrics.**
   1. Series, `liveBudget.inFlight`, `poolStats`, worker `queued`, `DATABASE_POOL_MAX`;
      `test-promMetrics.ts` cases.
   2. Helm templates + values + kind-e2e lines; `monitoring.md`; `sizing.md`.
5. **Logger.**
   1. `logger.ts`, `useLogger` in `buildApp`, `currentContext`, `scripts/logCapture.ts`, the four suites.
   2. The codemod run + the hand fixes.
   3. `no-console` in `.oxlintrc.json` + the two exception blocks.
6. **Docs.** Threat model R3 rewritten; retro §6 "rare DuckDB native abort" closed with the
   measurement; CHANGELOG; `docs/README.md` row; the PR body file.

## 5. Test plan (one-to-one with the spec's Tests)

| Spec test | Where | How |
|---|---|---|
| SIGTERM mid-flight: slow `sql:run` cross join over `range()` + an in-process job | `test-server-boot.ts`, new section, both modes (with `DATABASE_URL`: one scratch database, `CREATE DATABASE`, for all iterations, `AUTH_MODE=dev`, `ORDINATE_ENV=dev`) | per iteration: spawn `main.js` with `SHUTDOWN_GRACE_SECONDS=2`, `DUCKDB_THREADS=1`; create a project; open `/api/events?client=<uuid>`; POST `sql:run` with `SELECT count(*) FROM range(1000000) a, range(100000) b` (not awaited); POST `sql:prepareSave` with the same SQL and the client header (not awaited); wait for `jobs:changed` showing it `running`; SIGTERM |
| exit 0, no `libc++abi` / `Napi::Error` | same | exit code + stderr scan |
| `/readyz` 503 between signal and exit | same | poll every 50 ms from the signal until refused; ≥ 1 × 503 with `draining:true` |
| the job ends `cancelled` with the restart sentence | same | the SSE `jobs:changed` frames; the sentence read from `lifecycleMessages` |
| gone within `SHUTDOWN_GRACE_SECONDS + 3 s` | same | signal → `'exit'` timing; past it the test SIGKILLs and fails the iteration |
| ≥ 20 repeats in one run | same | 20 sequential iterations per mode; one aggregate `ok` ("20 of 20") with per-iteration detail on failure |
| NEGATIVE CONTROL: old `shutdown()` restored, count aborts | scratch run, §3.10 | aborts and overruns, both modes, in the PR body |
| ~4 MB bundle declaring ~4 GiB: refused, or streamed with RSS growth < 256 MB | `test-bundleMemory.ts`, both modes | 4 Parquet entries of 1 GiB − 1 zeros (deflated ~1 MB each; true sizes and CRCs; a valid manifest): import streams them; RSS sampled every 5 ms; max − baseline < 256 MB; the 4 GiB lands in staging/project and is deleted after |
| unknown entry refused before one byte is inflated | same | spy on `zlib.createInflateRaw` and `zlib.inflateRaw` (wrapped on the shared module object): 0 calls; CONTROL: the same bundle without the stray entry → calls > 0 |
| an entry that inflates past its declared size is refused | same | one Parquet (streamed) and one JSON (in memory) variant; no project created, staging empty |
| a real large bundle round-trips byte-identical (control) | same | a project with a ~200 000-row dataset (+ source Parquet, records, a version, an asset) exported, imported into a FRESH org (no remap); every imported file ≡ its entry (`Buffer.equals`); differential: `readZip` (old reader) and `openZip` read identical entry lists and bytes |
| backup + restore of several projects: RSS bounded, byte-identical | same | 12 projects × ~30 MB incompressible Parquet (≈ 360 MB backup): RSS growth < 256 MB during backup and during restore; every restored file ≡ its source; the backup's inner bundles are method 0 |
| every new series present and parseable | `test-promMetrics.ts` | the existing validator over the full exposition, each new family named |
| pg `waiting` rises when the pool is exhausted (control 0 at idle) | `test-promMetrics.ts`, DB part (scratch DB) | `DATABASE_POOL_MAX=1`: idle → `waiting 0`; hold the client, start a query → `waiting 1` |
| DuckDB queue depth rises behind a slow query | `test-promMetrics.ts` | `routeByOrg` on a temp dir: the `LONG` query + two fast ones in one org → depth ≥ 1 and busy = 1; after interrupt → 0; wait histogram count rises |
| a planted `console.log` fails `npm run lint` | manual, shown in the PR body | not committed |
| must stay green | — | test-selfcheckExit, test-jobs, test-jobs-pods, test-sse, test-liveUsage, test-bundle, test-backups, test-sharePolicy, test-projects-server, test-settings-server, test-serverDocs, helm lint/template |

Added beyond the spec's list, each guard with its negative control:

- `scripts/test-zipReader.ts`: one crafted zip per row of §3.4's table (zip64 markers and locator,
  multi-disk, CD gap/outside, flags incl. bit 3, method 12/99, invalid UTF-8, non-ASCII without bit 11,
  `../x`, `/x`, `a\b`, `DATASETS/<id>.JSON`, `dataſets/…`, NFC/NFD and case duplicates, a local header
  differing in each field, overlapping and directory-pointing entries, stored `csize ≠ usize`, short
  and long inflation, CRC, truncated deflate, forged EOCD in a comment, EOCD comment not reaching EOF);
  CONTROL: the untouched valid zip opens and reads.
- `test-duckdbPool.ts`: `interruptAll` stops the `LONG` query and skips the queued ones, then
  `closeEvery(+2 s)` returns no survivor; CONTROL: without `interruptAll`, `closeEvery(+300 ms)`
  returns that org as a survivor and does not wait longer; a call after `interruptAll` rejects
  `unavailable` and spawns no worker.
- `test-jobs.ts`: refusal while draining (CONTROL: submit works after `refuseNew(null)`); queued
  cancelled at once; running cancelled at the deadline with the reason's sentence even when the run
  throws something else; a job that ignores its signal ends `interrupted`; a job inside a routed
  DuckDB call (a ~2 s query) cancelled at 200 ms ends `cancelled` within 500 ms (CONTROL: the same job
  left alone ends `done` after ~2 s, so the Cancel is what stopped the query).
- `ZipFileWriter` ≡ `writeZip` byte-for-byte (differential).

Gates: `npm run build:ts`; `npm test` without and with `DATABASE_URL`, and in the CI env (password
Postgres + MinIO); `npm run lint` 0; `check-contracts` 0 unresolved; `test-file-size`;
`node scripts/test-server-boot.js` and `node scripts/test-bundleMemory.js` both modes;
`node scripts/test-serverDocs.js`; `helm lint` + `helm template` with both flags.

## 6. Risks and traps

- **Fastify/Node keep-alive at close.** Whether an in-flight response on a keep-alive socket holds
  `server.close()` must be measured in step 2; `Connection: close` while draining and the step-4
  `closeAllConnections()` are there either way.
- **A resident caller whose DuckDB call is interrupted falls back to the JS path** (the house rule:
  `null` → hydrate). After `interruptAll` that fallback's own reads reject `unavailable` at once, so it
  fails fast instead of burning CPU — but a CPU-bound fold already running would delay the exit;
  bounded by the budget, logged.
- **`exit 1` may itself abort** when a worker ignores the interrupt (§3.2.5). Logged first; Kubernetes
  would SIGKILL next.
- **Job Cancel now interrupts DuckDB.** A user's Cancel on a job mid-query stops the query (new, and
  the point); the job ends `cancelled`, as it already did when it reached `checkCancelled`.
- **The scheduled runner's reschedule skip** while draining changes a failed-during-shutdown run from
  "failed, next interval" to "retaken by another pod within ~65 s". With one replica the row runs
  again after the restart (the lease lapses).
- **Disk.** `MAX_TOTAL_BYTES` (4 GiB) per import × 3 concurrent jobs can pass the chart's `data`
  emptyDir `sizeLimit: 10Gi`, and the kubelet evicts on that, not the filesystem. R3 says so;
  quotas and import access are R13 (the user's call). `fs.statfs` was rejected: it sees the node's
  disk, not the emptyDir limit.
- **Postgres growth.** An import can write up to `MAX_TOTAL_BYTES` of JSON records (each ≤ 32 MiB).
  Bounded, not prevented; R3 names it.
- **The 32 MiB JSON cap refuses** an input table averaging more than ~60 characters per cell across
  10 000 × 50, and a legacy v2 record with rows inline over 32 MiB.
- **Export stays O(one project) in memory** (§3.6), by the spec's decision.
- **Shared-file collisions.** `jobs.ts` (item 4's bus cancel: separate functions), `app.ts` (item 4
  rewires file routes; my edits are additive lines in hooks I own), `ipc/projects.ts` and
  `settingsServer.ts` (item 4 makes `resolveUpload` async: my job reads `upload.path` and assumes
  only a LOCAL path), `env.ts` + `configuration.md` (item 2 appends; mine are in `podEnv.ts` plus one
  re-export line), `MAIN_FILES`, CHANGELOG, `docs/README.md`, threat model R3 only.
- **After this merges, `console.*` in `src/` fails lint.** Items 2–5 must use `logger`; the
  orchestrator should tell them before their merges. The codemod touches ~48 files, so expect
  import-line conflicts in files the other items also edit: keep both sides, then re-run the lint.
- **Tests that capture `console.*`** must move to `logCapture` in the same commit as the codemod, or
  their negative controls go silently vacuous (the salt check in test-sharePolicy above all).
- **Never re-null `dbPool` or un-wire stores during shutdown** (§3.1): fail closed, never fall back to
  local files.
- **`p.finally()` on a tracked promise re-raises its rejection** as unhandled; use `then(del, del)`.
- **Entry names are never paths in restore**; staging files are UUID-named.
- **`importBundle(Buffer)`** writes a temp file per call: tests only; product callers pass `{file}`.

## 7. Files and sizes

New: `src/server/{lifecycle,lifecycleMessages,shutdown,podEnv}.ts`, `src/app/{zipReader,zipWriter,
bundleRules,bundleImport,bundleMessages,logger}.ts`, `scripts/{test-zipReader,test-bundleMemory,
logCapture}.ts`, `deploy/helm/ordinate/templates/{servicemonitor,prometheusrule}.yaml`,
`docs/server/monitoring.md`. Near limits: `duckdb.ts` 760 → ~766 (flag only; the rest goes in
`duckdbClose.ts`); `app.ts` 560 → ~575; `jobs.ts` 496 → ~535 (drain belongs to the queue's state
machine; it needs its private maps); `bundle.ts` 522 → ~360; `env.ts` 503 → ~506. No file passes
800, none is admitted to the allowlist.
