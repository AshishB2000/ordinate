# Live data log

Append-only. One entry per task: date, task id, what was measured, what was decided and why.
The plan is [00-plan.md](00-plan.md).

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
