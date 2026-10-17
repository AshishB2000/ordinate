# Record locks: one locked read-modify-write

Built on `fix/record-locked-update`. Every store that loads a record, changes it and saves it back
now does the three inside **`recordFs.locked(path, fn)`** (`src/app/recordFs.ts`), and that lock
holds across pods.

## Why

- **Alerts.** `evaluateProject` loaded `alerts.json`, awaited a metric, the anomaly scan and a
  diagnosis for each rule (a warehouse round trip on a Live rule), then saved the whole file. Every
  mutator also loaded and saved without a lock. The scheduler and the RPCs raced even on one pod,
  so a deleted rule came back and fired.
- **Eleven copied per-process chains** (comments, catalog, fx, pipelines, privacy, themes,
  versions, dataset metadata, snapshots, input tables, colour map), none of which spanned pods.
  Most were keyed by a bare id and themes by one global chain, so two orgs' saves queued behind
  each other in one process while two pods' saves of the same record did not. `recordFs` itself
  was an unconditional upsert, and Helm runs 2 replicas.
- **Project fields** (`projects.ts`: colour map, archive, opened, dismissed insights, rename) took no
  lock. **fx** settings were a never-expiring cache, so another pod's declaration was never seen
  until a restart.
- **Org settings** upserted the whole document, so one member's star overwrote another pod's
  format change (first-run pass F15).
- **Published sites.** A refresh-driven re-publish read the manifest before building and wrote it
  after: it reverted an owner's "members only" to "anyone with the link", and brought removed
  sites back.

## The primitive

`locked(p, fn)` holds (org, path) for the whole async `fn`. Each store keeps its own load,
sanitize and save inside `fn`.

1. **An in-process queue** per `orgKey(path.resolve(p))`. On files (no `DATABASE_URL`) that is the
   whole lock. It replaces the eleven chains.
2. **With the DB:** one pooled client — `BEGIN`, the RLS org (`set_config('ordinate.org')`),
   `SET LOCAL lock_timeout`, then `pg_advisory_xact_lock(hashtextextended($1, 0))`.
   - The key is `'records:' + org + ':' + rel`, a **bind parameter**. Not `keyOf()`: its `'\0'`
     separator is rejected by Postgres.
   - **Advisory, not `FOR UPDATE`**: there is no row to lock before the first comment or rule
     exists, and none for a directory (a version history).
3. **The client is pinned** in an AsyncLocalStorage, so every `recordFs` statement inside `fn` runs
   on it, in that transaction, without its own `BEGIN`/`COMMIT`. That is what makes the save
   atomic, and it is also why a **swallowed failure** fails the save: Postgres answers `COMMIT` on
   an aborted transaction with `ROLLBACK` and no error, so `locked` checks the command and rejects
   (`ERECORDROLLEDBACK`, "This could not be saved. Try again in a moment.").
4. **Re-entrant.** A holder re-taking a key it holds runs straight through. A nested *different*
   key in DB mode is a second advisory lock on the pinned client inside a `SAVEPOINT`: a swallowed
   failure there (from `versions.record`, which "never throws") rolls back to the savepoint, not
   the outer save. On files a nested key queues; a path outside userData uses the queue only.
5. **No read memo inside a hold** (`memo.run(null, fn)`; `withReadMemo` tests `!== undefined`), and
   an outer memo is cleared when the hold ends. `hold.open = false` in a `finally`, in both modes,
   so `void` work started inside it does not run on a returned client.
6. **At most 4 DB holds per pod** (a semaphore inside the queue, before connect). The pool is 10
   (`db/pool.ts`), and an S3 input-table save takes a second client (`storage.newObject`).
7. **The wait is 15 s** (`_setLockWaitMs` for tests), across the queue, the semaphore and
   `lock_timeout`. Past it — or on Postgres 55P03/40P01 — `ERECORDBUSY`, "This is being saved by
   someone else right now. Try again in a moment." (`src/app/recordLockMessages.ts`, through the
   catalog). The RPC route answers an uncaught one `409 {code: 'record_busy', message}`. Postgres
   text never reaches a client.

### The lock order

A dataset record, then its history dir: an input-table save holds `datasets/<id>.json` and records
its versions under `history/dataset/<id>` inside it. Nothing nests the other way. A deleted
watch-derived alert rule turns the dataset's watch off *before* taking `alerts.json`, so no alert
hold ever waits on a dataset record.

## Each store keeps its failure contract

| Store | Key | On a refused or rolled-back hold |
|---|---|---|
| comments | `projects/<p>/comments.json` | `{ok: false, error}` — the sentence |
| themes | `themes.json` | `{ok: false, error}`; `listThemes` (embed, publish) reads without it |
| catalog, privacy policy and review, snapshots, fx | the store's own file | rejects, as a failed write did |
| pipelines (`update`) | `pipelines.json` | `null`, as before |
| versions (`record`) | the record's history dir | `null` ("never throws") |
| dataset metadata (`serialized`, `writeQuality`, `writeIncremental`, `markRefresh`, `setAutoRefresh`) | `datasets/<id>.json` | `false` |
| input tables | `datasets/<id>.json` — the same key `writeQuality` takes | rejects |
| project fields, `ipc/format` (`withProjectLock`) | `project.json` | rejects; `touchOpened` best effort |
| alerts (`withAlerts(projectId, fallback, fn)`) | `alerts.json` | each mutator's own fallback |
| subscriptions (`updateSubscription`, `stampRun`, `deleteSubscription`) | `subscriptions/<id>.json` | re-read under the lock; gone → `null`/skip |
| published sites (`publishHosted`'s switch, `setAccess`, `removeSite`) | `published/<id>/manifest.json` | rejects |

`comments.list` locks only when it has conflict copies to fold — that is a write — and also when
the file is corrupt, since moving it aside is one too.

## Alerts: compute outside, apply inside

`evaluateProject` computes every rule's figures from a **plain load, outside any lock** — never
DuckDB or a warehouse under one. Then, under the lock, it re-loads and applies each result only if
the stored rule is still `JSON.stringify`-identical to the rule it evaluated. A rule deleted,
edited or evaluated by someone else meanwhile is left as it is now, and only the applied events are
returned, so two evaluators at once fire once. `syncWatchRules` (on every bell open) diffs from a
plain load and locks only if something would change, re-checking inside.

## Org settings: a patch, not the document

`config.persist()` captures the document `cfg` was loaded from (storable form) before it replaces
the cache, and hands both to the backing. The flush (`orgConfig.ts`) runs in one transaction:
`INSERT … ON CONFLICT DO NOTHING RETURNING version`; if the row exists, `SELECT body … FOR UPDATE`,
apply THIS write's patch — `storable(cfg)` diffed against its base per top-level key and per member
inside `starredBy` (`diffDoc`/`applyPatch`) — then `UPDATE`. When nobody wrote since the base, the
body is written exactly as before. Only the last queued write adopts the merged body. Two pods
changing the same top-level key still last-writer-wins on it.

## fx

The cache stays — `getFx` runs on every figure — but each entry is fresh for 1 s, keyed by the fx
file (which carries the org), like `orgConfig`'s `FRESH_MS`. The cached value is the read itself,
so a dashboard's tiles asking at once share one. `edit` reads fresh inside the lock and refreshes
the entry after the commit.

## Measured

Local Postgres 17, the bench `scripts/bench-recordLocked.ts`, base `62aca7cf` and this branch run
back to back on the same loaded machine (four other sessions building and testing):

| | Base | This branch |
|---|---|---|
| One `comments.add`, median of 200 sequential (median of 5 runs) | 2.39 ms | **2.04 ms** |
| …its p95 (median of 5 runs) | 3.36 ms | 2.89 ms |
| A 20-tile `visual:dataBatch` with a declared currency, each in a new second, median of 15 (median of 5 runs) | 17.76 ms | 18.41 ms |

A locked save is *faster*: one transaction with its statements pinned to one client, where each
statement used to be its own (`BEGIN`, query, `COMMIT`, a pool checkout). The batch pays one fx
read per new second, shared by its 20 tiles (+0.65 ms); before the in-flight read was shared, all
20 tiles read at once and it was ~3 ms.

Controls (each suite's negative control, run on every gate):

| Control | Lost |
|---|---|
| 100 concurrent appends without `locked`, files / Postgres (`test-recordLocked` a) | 99 / 99 of 100 |
| The old per-process chain, two pods × 20 appends (`test-recordLocked-pods`) | 20 of 40 |
| 12 transactions each taking a second client, no per-pod cap, `max: 6` pool | 12 of 12 timed out |
| The old evaluator against a parked metric (`test-alertMerge`, run on the base) | B back, C and D's rename lost, digest and a quality event lost, a double fire |
| The old re-publish against a parked build (`test-hostedLock`, run on the base) | 'link' restored, the removed site back |
| The old settings flush, 20 members starring alternately on two pods (`test-orgConfig-db`, on the base) | 10 of 20 lists |

## Out of scope, and where each goes next

- **Wrap the remaining collection stores**: copilot, eventStore, relationships, trashStore,
  channels, connections, userTemplateStore, `history.ts` `setDatasetId`, projectBoundaries.
- **Whole-document editors** (analyses, visuals, metrics, stories, scorecards, scenarios,
  notebooks) stay last-writer-wins. Next: an `updatedAt` compare-and-set.
- **`src/data/datasets.ts`** (792 lines) is untouched. Refresh, `updateDataset` and `updateSteps`
  rewrite the record from a read taken before the fetch or pipeline, so they still drop locked
  metadata written meanwhile. Next: split `datasets.ts`, then lock only the record switch.
- The `sample:seed` guard (per pod), a NOTIFY on `org_config`, and merging inside one top-level
  org settings key.

## Calls made against the plan

- **A second sentence.** A save Postgres rolled back says "This could not be saved. Try again in a
  moment." — otherwise the comment and theme stores would show their generic fallback or pg-free
  internal text. Two keys in `en.json`, not one.
- **"Already gone" is success for any rule** found before `deleteRule` took the lock and gone under
  it (deleted meanwhile, or taken by the sync with its watch), not only a watch-derived one.
- **`deleteRule` turns the watch off first** (Decision 9), not after the lock as Step 2's wording
  had it: done after, a sync in between re-creates the rule.
- **`evaluateProject` returns `[]` when its save fails**: nothing was applied, so nothing fired.
- **A pre-existing bug, fixed:** `alertStore.load` returned `{ ...EMPTY }` for a missing file, whose
  arrays were `EMPTY`'s own — the first rule saved into a new project rode into the next new
  project's file, across orgs in one process. Found by the DB leg of `test-alertMerge`.
