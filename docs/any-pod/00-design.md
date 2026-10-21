# Any pod can serve any request: no sticky sessions

Item 4 of batch 3, branch `fix/any-pod`, migration `0021`. Every file:line below was re-read on
`46bbfc3d`.

## What you will see

- A default two-replica install works with no load-balancer settings: upload a file on one pod,
  parse it on another, save on a third request; export on one, download on another; back up on one,
  restore on another; run an Assistant plan with each click landing anywhere.
- Cancel in the Jobs popover stops the job whichever pod runs it, and the popover shows every job of
  the tab, from whichever pod pushed it.
- The abuse limits are org-wide: 10 wrong passwords lock an account however the attempts were
  spread, the test-email limit holds across pods, and so do Send now and the embed limits.
- No operator doc asks for sticky sessions. One line in `upgrade.md` tells operators on older
  versions to keep theirs.
- Without `DATABASE_URL` (tests, `AUTH_MODE=dev`), nothing changes: there is one process and the
  in-memory stores stay.

## 1. The decisions (from the spec, not re-litigated)

| What | Decided |
|---|---|
| File tokens | Rows in Postgres (0021 `file_tokens`): the sha256 of the token, never the token, with org, user, kind, storage key, name, size, `expires_at`, `used_at`. Single use is ONE conditional `UPDATE … RETURNING`. A wrong caller matches nothing and never burns the owner's token. Without `DATABASE_URL`, today's Map. |
| Their bytes | Shared storage. File mode: the org's temp dir on the shared `DATA_DIR` (more than one pod already needs a ReadWriteMany claim for tables). S3 mode: the upload streams to the pod's temp as today, hashing as it goes, then ONE signed PUT to `…/orgs/<org>/staging/<key>` (payload hash known, no `UNSIGNED-PAYLOAD`); another pod fetches the object into its own temp on first use. Downloads likewise: `GET /api/files/<token>` serves from storage on any pod. |
| Cleanup | A scheduled job (`defineJob`, claimed once across pods) deletes expired rows and their objects. `done()` still deletes eagerly. |
| Staged imports | Written once as Parquet to staging with a DuckDB COPY (works for `DATA_DIR` and S3). A stage row beside it (0021): owner, columns + types + parse metadata, 30-minute expiry, 2 per user. All three writers produce that one shape; Save on any pod reads it; the same-pod in-memory copy stays as a fast path; the 1M-row parse leaves the heap. |
| Plan runs | Records under the project (recordFs). Each step in `recordFs.locked` so two pods never advance one run. Capped per org, not per pod; 24-hour TTL. Resolved from the record on any pod. A table before-image would go to staging. |
| Jobs | `jobs:cancel` and `jobs:clear` travel over the bus to the pod that runs the job; the job's own `jobs:changed` push confirms. If the popover trusts `jobs:list` alone, fix the popover to merge the pushes. |
| Drivers facts | A short-lived record keyed by the token. |
| Shared counter | One Postgres table, `INSERT … ON CONFLICT … DO UPDATE SET n = n + 1 RETURNING n`, behind one helper, swept by the same job. Used by the password lockout, every email budget kind (item 3's `mention` included), test sends, Send now, and the embed per-token and per-org limits. |
| Stay per pod (R8 says so) | The coarse per-IP and per-user RPC buckets (`limits.ts:29-31`, `:93-116`), the SMTP semaphore (`smtp.ts:36`, `:65-71`), `LIVE_MAX_CONCURRENT` (`liveBudget.ts:37`). |
| `sample:seed` | Its in-flight guard becomes an advisory lock. |
| Docs | Drop the sticky-session requirement everywhere (CLAUDE.md included); keep one line for older versions. |

## 2. Caller inventory

### `resolveUpload` — 8 call sites, all synchronous today (`src/server/files.ts:106-109`)

| # | Call site | Channel | Where its `done()` is today |
|---|---|---|---|
| 1 | `src/ai/planExec.ts:101` (`pickImportFile`, `:98-102`) | `plan:next` import step | `:115`, in the `finally` around `parseAsJob` (`:111-116`). The throw from `resolveUpload` propagates to `runNext`'s catch: a failed step. `picked.path` is read again at `:117`/`:122` only for the desktop origin (`serverDataDir() === null`), after `done()`. |
| 2 | `src/ipc/rebuild.ts:120` | `rebuild:read` | `:135`, `finally { upload?.done() }`; `let upload = null` declared before the `try` (`:118`). |
| 3 | `src/ipc/projects.ts:188` | `projects:import` | `:196`, `finally` around `importBundleFile` (`:193-197`); `FileTokenError` caught at `:189-192`. |
| 4 | `src/ipc/datasetImport.ts:51` | `dataset:pickAndParse` | `:71`, `finally { upload?.done() }` (`let upload = null` at `:49`). |
| 5 | `src/ipc/captureDataset.ts:81` | `captureDataset:draft` | `:86`, `finally { upload?.done() }` (`:79`). |
| 6 | `src/ipc/analysesServer.ts:145` | `asset:importImage` | `:154`, `finally` (`:150-155`); `FileTokenError` caught at `:146-149`. |
| 7 | `src/ipc/projectBoundaries.ts:13` | `boundary:import` | `:18`, inner `finally` (`:14-19`). |
| 8 | `src/ipc/settingsServer.ts:49` (helper `upload()`, `:47-54`) | `branding:setLogo` (`:128`), `backups:restore` (`:161`) | `:138` and `:196`, each a `finally`. Restore's `done()` runs after `await job.done` (`:190`), so the job never reads a deleted file. |

### `offerDownload` — 4 call sites (`files.ts:116-118`); each wrote its file into `appPaths.temp()` first

| # | Call site | Channel | The file |
|---|---|---|---|
| 1 | `src/ipc/projects.ts:175` | `projects:export` | `temp()/export-<uuid>.ordinate` (`:147`), written in the job (`:165-167`). |
| 2 | `src/ipc/publishServer.ts:130` | `dashboard:exportHtml` | `temp()/export-<uuid>.html` (`:127-129`). |
| 3 | `src/ipc/visualsServer.ts:85` | `visual:rowsDownload` | `temp()/drill-<uuid>.csv` (`:83-84`). |
| 4 | `src/ipc/settingsServer.ts:153` | `backups:download` | `temp()/backup-<uuid>.zip` (`:84-86`). |

Test-only: `scripts/test-files.ts:143` calls `offerDownload`; `downloadPathForTest` (`files.ts:251-254`) is
read by `test-drillScope.ts:143`, `test-sharePolicy.ts:63`, `test-visual-rows.ts:34`;
`resetForTest` (`:245-248`) by `test-files.ts:58`. These run in-process without a token database,
so they keep the Map backend unchanged.

### The file routes

- `src/server/app.ts:443`: `registerFileRoutes(app, cfg.maxUploadMb, () => uploadCapMb(…))`; `:32`
  imports `maskFileToken` for the request logger.
- `files.ts:180-210` `POST /api/files` (streams to `temp()/upload-<32 hex>`, `issue('upload', …)` at
  `:209`); `:212-237` `GET /api/files/:token` (`take(token, 'download')`, streams, `forget` on
  `close`); `:239-241` the per-process sweep timer (`SWEEP_EVERY_MS` 60 s); `:61-63` the Map and its
  `ponytail:` comment.

### `importStage` (`src/data/importStage.ts`)

- State: `:36` the Map; `:23-24` `MAX_STAGED = 2` per owner, `TTL_MS` 30 min; `:40-43` owner = org +
  user; `:58-63` `put`, `:66-71` `get`, `:73-75` `drop`, `:78-80` `previewOf` (2,000 rows).
- Writers (3): `src/ipc/datasetImport.ts:65` (`dataset:pickAndParse`), `:87` (`dataset:parsePaste`,
  server only), `src/ipc/sqlQuery.ts:89` (`sql:prepareSave`, the table built at `:88`).
- Readers (2): `src/ipc/datasets.ts:337` `get`, `:340` GONE, `:349` `drop` (`dataset:save`);
  `src/ipc/datasetCompose.ts:74` `get` in `resolveRef` (truncated at `:80-82` by `sample`, which is
  `PREVIEW_PARENT_ROWS` for `dataset:composePreview` at `:133` and `null` for `composeSave` at
  `:206`), `:110` GONE, `:241` and `:267` `drop`.
- Cell types: `ParseResult.rows` is `(string | number | null)[][]` (`src/data/parse.ts:25`), and
  rectangular (`finalize` pads ragged rows, `:206-211`). SQL results are coerced to the same three
  types (`src/engine/sqlDatasets.ts:104-131`).

### Plan runs

- `src/ipc/plan.ts:36-47` (`MAX_RUNS = 20` per pod, all orgs, oldest evicted), `:76-78` `runOf`,
  `:81-83` `runProject`, `:88` installs it as the contracts' resolver, `:116-122` `plan:next` puts
  `fileToken` on the in-memory run; `:33-34` the sticky-session `ponytail:`.
- `src/api/assistant.ts:35-36` `planRuns` / synchronous `byRun`; `:113-117` the five channels using
  it. `plan:replace` (`plan.ts:131`) has no contract, so it is unreachable (404) today.
- `src/ai/planRun.ts:56-70` `PlanRun` (`fileToken` at `:69`); `:120-151` `runNext` (claims, runs,
  applies, all in memory); `:174-178` `stopRun`; `:204-218` `undoRun`.
- **What the undo before-images hold** (`planRun.ts:43-50`, filled in `planExec.ts`): a changed
  dataset is `{ id, steps: prior }` (`:146`), the dataset's prepare steps; a restyled dashboard is
  the whole Analysis record (`:240`, `:248`). Every other touch is `created: true` with no before.
  `undoGroup` (`:296-305`) trashes or `writeBack`s. **No before-image is a table**, so nothing
  goes to staging; the run record holds them as JSON.
- Callers in the web: `PlanCard.tsx:142` (start), `:162` (next, with `fileToken` exactly when the
  next step is an import, `:129`, `:151-162`), `:167`, `:253`, `:270` (stop), `:269`, `:289` (skip),
  `:297` (fix), `:280` (undo).

### Jobs

- `src/ipc/jobs.ts:13-23`: `jobs:list` = this pod's `snapshotFor(owner)`; `jobs:cancel` = this pod's
  `get(id)?.owner === owner() && cancel(id)`; `jobs:clear` = this pod's `clearRecent(owner)`.
  Contracts `src/api/home.ts:45-47`.
- `src/app/jobs.ts:241-256` `cancel`, `:286-290` `clearRecent`, `:185-189` `snapshotFor`.
- Pushes: `src/server/sse.ts:259-276` `jobs:changed` = this pod's slice for one tab, `:277-279`
  `jobs:finished`; they reach a tab on another pod through the bus (`sse.ts:30-39`,
  `jobs/bus.ts:59-176`).
- The popover trusts each push as the whole list: `web/src/api/jobs.ts:46`
  (`setQueryData(KEY, snap(p))`). So with jobs on two pods, each pod's push erases the other's
  jobs. It must merge. Same for `useDatasetJob`, which reads raw pushes
  (`web/src/features/analytics/segments/SegmentsParts.tsx:37-45`), and its Cancel at `:57`.

### Drivers facts

- `src/ipc/drivers.ts:72` `TOKENS_KEPT = 50`; `:279-292` the Map, `remember`, `recall` (checks
  the project, not the org).
- `remember` runs inside `driversFor` (`:392`), and `driversFor` has six callers: `runDrivers`
  (`:426`, `:436`; the panel doors `drivers:explain` `:537`, `drivers:explainAlert` `:548`, and the
  chart-point door), the waterfall tile `driversVizData` (`:502`), `src/ipc/summary.ts:118`,
  `src/ipc/alertDiagnosis.ts:23`, and `src/ipc/copilot.ts:311`.
- The one reader: `copilot.ts:309-316`. Test: `scripts/test-drivers.ts:407`.

### The abuse limits

- Password lockout: `src/server/auth/password.ts:41-62` (`FAIL_MAX` 10, `FAIL_WINDOW_MS` 15 min,
  LRU of 5,000 keys); used at `:125-127` (login check), `:133` (failure), `:138` (success clears),
  `:160-165` (password change).
- Email budgets: `src/server/mail/budget.ts:1-59`, a rolling hour of timestamped charges per key,
  `hold` all-or-none at `:47-55` with `refund`. Callers: `src/server/mail/emailChannel.ts:157`
  (`hold` per batch), `:171` and `:180` (`refund`), `:252` (bucket choice), `:82`
  (`resetBudgetsForTest`); `scripts/test-smtp.ts:327-348`.
- Send now: `src/server/subscriptions/rpc.ts:28-36` (`lastSendNow`, gap 60 s), `:229-234`.
- Embed: `src/server/embed/route.ts:74-88` (`app.createRateLimit` per token fingerprint and per
  org, 1-minute windows), `:140-141`.

### `sample:seed`

`src/ipc/projects.ts:19-21` (the per-pod `seeding` Map), `:63-80` (the handler and its `ponytail:`).

### `s3.ts`

`signedHeaders` `:85-100` signs `UNSIGNED-PAYLOAD` only; `send` `:102-110` takes no body (retries
once on 403 with fresh credentials); `download` `:113-131` (temp sibling, length check, rename);
`remove` `:134-138`; `createBucket` `:141-145`. `storage.ts:75-82` builds `prefix/orgs/<org>/`
(`orgKey` private, `orgUrl` exported); `:97-113` scopes each org worker's secret to that prefix.

### `defineJob` and the runner

`src/server/jobs/runner.ts:82-86` `defineJob` (once per kind per process); `:89`, `:136` a job runs
as `jobs@system`/admin in the row's org; `:172-192` rows ensured for every org under
`DATA_DIR/orgs`; `:92-112` the claim; `:123-154` run and reschedule, fenced on the lease owner.
Kinds today: `storage:gc` (`app.ts:217-220`), `tick` (`schedules.ts:128`), `subscriptions`
(`subscriptions/job.ts:35`, with the `defined` guard against a second app in one process).

### `recordFs.locked`

`src/app/recordFs.ts:236-263`: an in-process queue, then (DB) one pooled client, `BEGIN`, RLS org,
`lock_timeout`, `pg_advisory_xact_lock` (`:265-284`), at most `MAX_DB_HOLDS = 4` per pod (`:189`).
Every recordFs statement of the same org inside `fn` runs on that client, in that transaction
(`:160-169`). The rule (`:46-48`, `docs/record-locks/00-design.md` "compute outside, apply
inside"): never await DuckDB or a warehouse inside `fn`.

### Every doc line that asks for sticky sessions or says "per pod" about a limit that moves

| File | Lines | What it says |
|---|---|---|
| `CLAUDE.md` | 52 | "more than one replica needs sticky sessions (R8)" |
| `docs/server/README.md` | 76-81 | "Three things that bite on day one", item 2 |
| `docs/server/eks.md` | 196-197, 214-218 | the ALB stickiness annotation in the values example, and the "required" paragraph |
| `docs/server/gke-aks.md` | 13-15, 27, 37 | the sticky bullet, and cookie affinity in the GKE and AKS ingress rows |
| `docs/server/ecs.md` | 115-116 | "Turn on stickiness (`lb_cookie`)" |
| `docs/server/sizing.md` | 111-113 | "more than one pod needs sticky sessions" |
| `docs/phase-7-web/threat-model.md` | 297 | R8 |
| `docs/server/configuration.md` | 83-84, 101 | embed and email limits "per pod" |
| `docs/server/sso.md` | 211 | lockout "(per pod)" |
| `docs/server/embedding.md` | 125 | "All per pod" |
| `docs/server/email.md` | 129 | "in each pod" |
| `src/server/files.ts:61-62`, `src/ipc/plan.ts:33-34`, `src/ipc/projects.ts:63-65`, `src/server/auth/password.ts:45`, `src/server/subscriptions/rpc.ts:28` | | the `ponytail:` and header comments that say per pod |

History (`docs/phase-7-web/log.md`, `99-retro.md`) stays as written.

### Also checked, and left alone

Module-level state that outlives a request was listed across `src/` (`grep "^const .* = new Map"`).
Besides the items above, every one is a cache that recomputes on a miss (notebook previews,
`paramReplay`, `queryCache`, `rowAccess.anyClosed`, `filterParse`, `fxStore`, `embedPage`), a
per-pod throttle the spec keeps (`freshOnAsk.triggered`, `liveBudget`, `liveFlight`), or
registration. OIDC's state, nonce and PKCE verifier ride in a cookie (`oidc.ts:4-5`), so a callback
on another pod already works. The only other cancel-style channel is `jobs:cancel`.

## 3. Decisions where the spec leaves room

### 3.1 `resolveUpload` and `offerDownload`

```ts
export interface Upload {
  /** A LOCAL file holding the uploaded bytes: a path on this pod's filesystem (positioned reads are
   *  fine). Read it; never move, keep or delete it — `done()` does. */
  readonly path: string;
  readonly name: string;
  /** Deletes the file, the shared object and the row. Call it in a `finally`. Never throws; failures
   *  are logged and left to the sweep. */
  done(): void;
}
export function resolveUpload(token: unknown): Promise<Upload>;          // throws FileTokenError
export function offerDownload(filePath: string, name: string): Promise<{ downloadToken: string }>;
```

- **Same shape, now async.** Item 1 reads the bundle zip from `upload.path` with positioned reads
  and assumes nothing more: in file mode `path` is the file on the shared volume; in S3 mode it is
  this pod's local copy (the issuing pod's own temp file, or one fetched with `s3.download`, which
  writes a temp sibling, checks the length and renames, so a reader never sees a partial file).
- `done()` stays synchronous and fire-and-forget, as today's `forget` (`fs.rm` with a callback). So
  no caller changes beyond `await`, and every `done()` stays where it is: each call becomes
  `upload = await resolveUpload(token)` inside the same `try`. The token is taken before any byte
  moves, so a failed fetch after a successful take burns the token; the user uploads again (the
  object and row go with the sweep).
- `offerDownload` asserts the file is directly inside the caller's org `temp()` and its name matches
  `^[a-z]+-[0-9a-f-]{32,36}\.[a-z]{2,8}$` (all four callers already comply). In S3 mode it PUTs the
  file before it answers, because another pod cannot ask this one for it.
- **Backends.** `useFileTokenDb(pool)` (wired with the DB, like `useBlobDb`) turns on the Postgres
  store; without it, today's Map and timer run unchanged, and the in-process suites
  (`test-files`, `test-drillScope`, …) see no change.

### 3.2 Where the bytes live, and why orgs cannot cross

One module, `src/server/staging.ts`, owns "the org's staging area". A **key** is a server-made file
name, never a path and never from a client:

| Kind | Key |
|---|---|
| upload | `upload-<32 hex>` (today's name) |
| download | the file's own name (`export-<uuid>.ordinate`, `drill-<uuid>.csv`, …) |
| staged import | `stage-<uuid>.parquet` |
| a pod's fetched copy (never a row) | `fetched-<uuid>` |

- Every key is checked against `^[a-z]+-[0-9a-f-]{32,36}(\.[a-z]{2,8})?$` before it touches a path or
  a URL: no `/`, no `..`.
- **The org always comes from `ctx().org.id`** (checked by `ORG_RE`), never from a row:
  - file mode: `DATA_DIR/orgs/<org>/temp/<key>`;
  - S3: `<prefix>/orgs/<org>/staging/<key>` (bucket-relative, for Node's signed calls) and
    `s3://<bucket>/<prefix>/orgs/<org>/staging/<key>` (for DuckDB).
- **Three walls.**
  1. Every token and stage statement filters `org_id = $1` from `ctx()`, and the tables force RLS on
     `ordinate.org`. A row of another org is never returned.
  2. The key cannot leave the org's directory or prefix, because the org part is ctx's and the key
     has no separator.
  3. DuckDB reads and writes stage Parquet in the org's own worker, whose S3 secret is scoped to
     `orgs/<org>/` and whose `allowed_directories` is the org root (`storage.ts:97-113`,
     `duckdbPool.ts`). Node's signed calls are bucket-wide, so wall 2 is the one that holds for them,
     and a test plants a row with a foreign-looking key to prove it.
- `storage.ts` gains `export function s3Config(): S3Env | null` and exports its private `orgKey`;
  staging builds on those. Staging objects are not registered in `storage_objects`, so the
  dataset GC (`collectGarbage`) never sees them; the sweep (§3.10) owns them.
- **S3 PUT** (`s3.ts`): `signedHeaders(cfg, method, url, creds, now, payloadHash = 'UNSIGNED-PAYLOAD')`,
  and `send(cfg, method, key, body?)` where `body = { open: () => Readable, sha256: hex, size }`. A
  factory, because the 403 retry needs a fresh stream. The request sends `content-length` and
  `duplex: 'half'`. Verified on Node 24.14: `fetch` then sends `Content-Length` and no
  `Transfer-Encoding: chunked`, which S3 would refuse. `put(cfg, key, file, sha256, size)` and
  `open(cfg, key) → { body: Readable, size }` (for the download route) are the two new exports.
- **One PUT is at most 5 GiB.** In S3 mode the upload route caps at `min(MAX_UPLOAD_MB, 5120)`; the
  413 already names the cap. It is not a boot error, so an install with a larger cap still starts
  after the upgrade. The largest download (a backup) is bounded by the zip's 4 GiB − 1.
- **The S3 fast path.** The pod that received an upload, or that wrote a download, keeps its local
  file in a per-process `localCopies` Map (token hash → path, expiry). A take on the same pod uses it
  instead of a GET. Today's per-process sweep timer deletes local copies past `TOKEN_TTL_MS`, so a
  take on another pod never leaves the first pod's copy behind for long.
  `ponytail:` a crash leaves local copies in the emptyDir until the pod is replaced.

### 3.3 The token rows and the take

- `issue` inserts `sha256(token)` (32 bytes, `bytea`); the token is 32 random bytes in base64url, as
  today (`FileToken`, `src/api/contract.ts:79`). The raw token is only ever returned to its owner
  in the reply; `maskFileToken` keeps it out of the request log.
- The take, inside `inOrg` (`BEGIN; set_config('ordinate.org', …)`):

```sql
UPDATE file_tokens SET used_at = now()
 WHERE token_hash = $2 AND org_id = $1 AND user_email = $3 AND kind = $4
   AND used_at IS NULL AND expires_at > now()
RETURNING storage_key, name, size
```

  - `$1` is `ctx().org.id`, `$3` is `ctx().user.email`, `$4` is `'upload'` or `'download'`.
  - No row means unknown, another org's, another user's, the other kind, used or expired. All of
    these are the same `FileTokenError`, so there is no existence oracle (today's rule).
  - Nothing is written for a wrong caller, so the owner's token survives (`files.ts:82-94`).
  - Two takes at once: the row lock makes the second `UPDATE` re-check `used_at IS NULL` after the
    first commits, so exactly one wins.
- `done()` / a finished download: delete the object (and this pod's local copy), then
  `DELETE FROM file_tokens WHERE org_id = $1 AND token_hash = $2`. If the object delete fails, the
  row stays, and the sweep retries.

### 3.4 Staged imports as Parquet

**The cell codec** (`src/data/stageCodec.ts`, pure). Every cell is stored as one VARCHAR, prefixed
with a tag:

| JS cell | Stored |
|---|---|
| `null` | SQL `NULL` |
| a number | `'n' + (Object.is(v, -0) ? '-0' : String(v))`. `String` gives the shortest decimal that round-trips, and `Number('-0')` is `-0`. |
| a string that is well-formed UTF-16 and has no U+0000 | `'s' + v` |
| any other string (a lone surrogate, a NUL) | `'j' + JSON.stringify(v)`, which is pure ASCII escapes, decoded with `JSON.parse` |
| anything else | a `TypeError`: a writer broke the stage contract. It fails the import loudly, never silently. |

Why tags and not the dataset contract (`parquetStore`'s VARCHAR + declared type):

- **A staged table is not yet a dataset.** The composer previews it, joins on it and maps its
  columns from the in-memory values (`datasetCompose.ts:59-102`, `combine.composeTables`). So the
  stage must give back the exact JS values, `-0` included. `String(-0)` is `"0"`.
- **The leading-BOM transport bug** (CLAUDE.md, `parquetStore.ts:249-271`) only eats a BOM at
  position 0. After a tag no value starts with one, and `bomSafe` stays harmless.
- **A lone surrogate** makes `read_json` fail, and `writeTableAsync`'s retry would replace it with
  U+FFFD (`:172-175`, `:343-349`). The `j` tag never reaches that retry.

**Shape.** Columns are `c0..cN` VARCHAR, ZSTD. That is exactly `parquetStore.writeTableAsync`'s
file, so the 0-column (`__empty` + row count) and 0-row cases come for free. Two small additions
to `parquetStore.ts` (377 lines):

- `WriteProgress.encodeCell?: (c: Cell) => string | null`, used by `ndjsonLine` instead of
  `toStorage`. Each 16,384-row chunk is encoded as it is written, so there is never a second
  1M-row copy.
- `readTableAsync(path, schema?, limit?)`: `LIMIT` on the scan. A plain scan of one file keeps
  file order (DuckDB's `preserve_insertion_order`, which `readTableAsync` already relies on), so
  the composer's preview reads only `PREVIEW_PARENT_ROWS`.

The decoder then runs over the rows in place, with no second array.

**Parse metadata** goes in the stage row as JSON text:
`{ v: 1, columns: [{name, type}], rowCount, warnings, sheetNames? }`. It is `text`, not `jsonb`:
`jsonb` refuses `\u0000`, which a column name can hold. `JSON.stringify` escapes lone surrogates
and NUL to ASCII, so names round-trip exactly.

**The store** (`src/data/stageStore.ts`), when the DB is on and `serverDataDir()` is set:

- **`put(table)`**
  1. Check the stage contract (cells are strings, numbers or null).
  2. Insert the row, owned by `ctx()`, expiring `now() + 30 min`.
  3. COPY the Parquet to `staging(stage-<id>.parquet)`.
  4. Only then evict the owner's stages beyond the newest 2 (`DELETE … ORDER BY created_at DESC
     OFFSET 2 RETURNING storage_key`, then delete those objects).

  The row comes first so that a pod dying mid-COPY leaves a row the sweep cleans up (as
  `storage.newObject` registers first). A failed COPY deletes its row. The id only reaches the
  browser after `put` returns, so no reader can race a half-written stage.
- **`get(id, limit?)`** selects the caller's live row (`org_id`, `id`, `user_email`,
  `expires_at > now()`). No row means `null`, which the readers turn into today's `GONE`. Then it
  uses this pod's memory copy, if there is one, or reads the Parquet. **The row is the truth**: a
  stage saved (and dropped) on pod B is GONE on pod A even when A still holds the bytes in memory.
- **`drop(id)`** deletes the row (`RETURNING storage_key`), then the object and the memory copy.
- **The same-pod fast path** is today's Map, kept only for tables of at most
  `STAGE_MEMORY_CELLS = 250_000` cells (rows × max(1, columns)). Larger tables are written, the
  parse is released, and the RPC returns only `previewOf`'s 2,000 rows. That reconciles "the
  in-memory copy stays as a fast path" with "the 1M-row parse leaves the heap". The cap is a count,
  like the notebook cache's (`notebook/run.ts:78`).
- **The async API.** `put`, `get` and `drop` become async; every caller adds `await` and grows no
  lines (`datasets.ts` stays at 747). `get` returns the full `rowCount` with up to `limit` rows, so
  `resolveRef` computes `truncated` from `rowCount`. Without the DB, the Map path is today's code.
- **Cost, measured in Phase B for the PR body:** the write at 1M rows on the parse path (it adds
  to the parse RPC; the composer's spinner covers it), the full read on Save, and RSS after a 1M-row
  parse.

### 3.5 Plan runs as records

**Where and what.** A run lives at `userData/projects/<projectId>/plans/<runId>.json`. That is a
record path (`recordFs.ts:76-86`): a `records` row with the DB, a file without it. So there is one
code path in both modes. It is not on the bundle's whitelist (`bundle.ts:49-79`), so it never
travels in an export or a backup. Deleting a project deletes its runs.

```ts
interface StoredRun extends Omit<PlanRun, 'fileToken'> {
  v: 1;
  by: string;              // who started it: only they can advance, stop, fix or undo it
  createdAt: string;
  updatedAt: string;       // TTL: 24 h from the last change
  lease?: { claim: string; until: string };  // set while a step or the undo runs
}
```

- **The upload token is never stored.** `plan:next` hands it to the step for that one request only
  (the web sends it exactly with an import step, `PlanCard.tsx:151-162`). The raw token never lands
  in a record.
- `by` is new. A run was reachable by anyone in the org with the run id; now it is the starter's,
  like a staged import or a file token. It costs one comparison.
- **On read**, malformed or expired (`updatedAt` older than 24 h) counts as missing. A missing run,
  or one whose `by` is not the caller, answers today's `GONE` ("That plan run has ended — ask again
  to start a new one.").

**The contracts get `projectId`.** The trap at the end of the spec says: if resolvers cannot await,
put `projectId` in the inputs. Resolvers can await (`src/server/authz/index.ts:75`), but the run
lives under its project, so a lookup by run id alone would need an org-wide search or an index.
Instead:

- `plan:next|skip|fix|stop|undo` take `{ projectId: Uuid, runId: Uuid, … }` with
  `project: byProjectId`.
- `planRuns`/`byRun` are deleted from `src/api/assistant.ts` (it is not one of the append-only
  files), along with their install at `plan.ts:88`.
- Authz checks the caller's role on the declared project before anything is read. The handler then
  reads exactly `projects/<projectId>/plans/<runId>.json`, so a run of another project is not at
  that path: it is GONE.
- `PlanCard.tsx` sends `projectId` (it already has it for `plan:start`). The web's typed `rpc`
  fails `tsc` until it does.

**Locking: "each step in `recordFs.locked`", done as compute outside, apply inside.** A step awaits
a parse job, `saveDataset` (DuckDB) and quality checks. Wrapping that whole body in `locked` would
break `locked`'s own rule (`recordFs.ts:46-48`):

1. It would hold one of the pod's 4 DB holds (`:189`) and a pooled client for minutes.
2. Every record write the step makes (the dataset record, versions) would join the run's
   transaction (`:160-169`). A late failure would then roll back record writes whose Parquet had
   already landed.
3. Other saves would queue behind it until `lock_timeout`.

So each step is three short `locked(runPath)` holds around unlocked work. This is the alerts
pattern (`docs/record-locks/00-design.md`, "compute outside, apply inside") with the jobs runner's
fence (`runner.ts:120-153`):

1. **Claim** (locked). Read the run.
   - Running with a live lease: answer the snapshot with "This step is still running."
   - Running with an expired lease (its pod died): mark that step failed, "The server restarted
     while this step ran. Run it again, or skip it.", and answer.
   - Otherwise `beginStep(run)`: state `running`, the step `running`, and
     `lease = { claim: <uuid>, until: now + 90 s }`. Write.
2. **Run the step** with no lock held. A heartbeat every 30 s re-takes the lock and moves
   `lease.until` on, only while `lease.claim` is still ours.
3. **Apply** (locked). Re-read. If `lease.claim` is ours, `endStep(run, i, outcome)`, clear the
   lease and write. If not (a stall past 90 s let another request recover the run), log and apply
   nothing, like a late job finish (`runner.ts:153`).

- **The pure state machine** (`planRun.ts`) is split: `beginStep` (`:121-126`), the executor, and
  `endStep` (`:139-150`), plus `recoverStep`. `runNext` stays as their composition, so
  `scripts/test-planRun.ts` keeps passing and gains cases for each part.
- **Undo** writes back records, and a dataset write-back recomputes steps in DuckDB. So it takes the
  same claim/lease/apply path and shows as `running` while it works.
- **Fix** calls the model outside any lock. Then a locked apply replaces step *i* only if it is
  still `failed` and the run is not running.
- **Skip, stop and replace** are one locked read-modify-write each. They refuse while a live lease
  runs, as today's `isOver || state === 'running'` does (`planRun.ts:155`, `:164`, `:175`), and
  recover an expired one first.
- Two pods (or two tabs) clicking Next at once: one claims, the other gets "still running".

**Cap and TTL.**

- `MAX_RUNS_PER_ORG = 50`. Today it is 20 per pod across every org. Per org with a 24 h TTL, a cap
  of 20 could evict a colleague's run mid-use in a busy org, and 50 runs of JSON cost nothing.
- `prune()` lists the project directories (`recordFs.readdir(projectsBase())`, UUID names only) and
  each `plans/` directory, then:
  - deletes runs past the TTL;
  - beyond the cap, deletes the oldest by `updatedAt`, never one with a live lease.
- It runs at `plan:start`, after the new run is written, and in the sweep job (§3.10).
  `ponytail:` one `readdir` per project and a read per run on each start; an index record when an
  org has hundreds of projects.

### 3.6 Jobs: cancel and clear over the bus, the popover merges

**How cancel finds the owning pod.** It broadcasts. Job ids are UUIDs, so exactly one pod holds a
given job.

1. Pod B's `jobs:cancel` first tries its own queue. That is today's answer when the job is local.
2. If the job is not there and the bus is up, B sends the command
   `{ cmd: 'jobs:cancel', d: { owner: 'org\nemail', id } }` to every other pod and answers
   `{ ok: true }`.
3. The pod holding a job with that id and owner calls `jobs.cancel(id)`. Its `jobs:changed` push
   ("Cancelling…", then `cancelled`) reaches the tab through the fan-out it already uses, and
   confirms.
4. Without the bus (no DB), today's `{ ok: false }`.

`jobs:clear` clears locally, then sends `{ cmd: 'jobs:clear', d: { owner } }` to every other pod.

**The command channel.** `src/server/podCommands.ts` holds:

- `onPodCommand(cmd, fn)`;
- `toOtherPods(cmd, data): boolean` (false without a bus);
- `setPodCommandSender(fn)`.

`bus.ts` makes two additive edits:

- `startBus` installs a sender that runs one `pg_notify(CHANNEL, {p: POD, s, cmd, d})`. The payload
  is under 200 bytes, so it is never sent by reference. `stop()` removes the sender.
- `handle` routes a message carrying `cmd` (after the own-pod check) to `runPodCommand`.

Receivers shape-check `d`. Item 2 adds "close this user's streams" to the bus at the same time;
this is a separate branch in `handle`, so the merge keeps both. Nothing is added to
`src/app/jobs.ts`, whose `drain` belongs to item 1. The relay lives in `src/ipc/jobs.ts`.

**The popover** (`web/src/api/jobs.ts`) merges by job id instead of replacing:

- Each push (and the `jobs:list` reply) upserts its jobs into the cached list. A final state is
  never overwritten by a non-final one: a `jobs:list` reply can be older than a push.
- Active jobs are sorted by `createdAt`. Recent ones by `finishedAt`, newest first, capped at 30 (the
  server's `MAX_RECENT`).
- On a successful Clear, every finished job is dropped locally, then the list is refetched. A pod
  whose recent list is now empty sends no push (`sse.ts:257-258`).
- `useDatasetJob` reads the merged list through a selector hook, `useJobList()`: the same query
  key, without registering the event handlers a second time (which would toast twice). It no longer
  reads raw pushes.

No server payload changes. A dead pod's active job stays in the list until a reload, which is the
same as a dead pod's slice before this change.

### 3.7 Drivers facts: one record per project

- `userData/projects/<pid>/drivers.json`: `{ v: 1, asked: { [token]: { spec, params, at } } }`, the
  newest 20 entries, none older than 24 h.
- **Written** under `recordFs.locked` after the answer is computed. The lock holds only the
  read-modify-write, never DuckDB.
- **Read** with a plain load. An entry past 24 h is missing.
- **Bounded by construction**, so it needs no sweep.
- **Only the panel doors mint a token.** Today `driversFor` remembers on every call (`:392`),
  including each waterfall tile render (`:502`), summaries, alert diagnoses and copilot's own
  recompute. A record write per tile render would be a write on every dashboard view. So
  `driversFor(projectId, spec, params, { remember: true })` is passed only by `runDrivers` (the
  `drivers:explain`, `drivers:explainAlert` and chart-point doors). Every other caller gets no
  token; none of them reads one.
- **It stays project-scoped, as today.** The token names a question, never a figure, and the
  Assistant recomputes it under the asker's own row policy.
- `recall` becomes async (`copilot.ts:310`, `test-drivers.ts:407`).

### 3.8 The shared counter

`src/server/counters.ts` has two stores with the same semantics: Postgres (0021
`shared_counters`), and memory when there is no DB (a Map with the 5,000-key LRU of today's
lockout). A differential test drives both through one script.

```ts
type Bucket = { key: string; limit: number; windowMs: number };
take(org, buckets, by = 1): Promise<{ ok: true; windows: Map<string, number> } | { ok: false; retryAfterSec: number }>
give(org, windows, n): Promise<void>        // refund into the same window it was charged in
peek(org, key): Promise<{ n: number; retryAfterSec: number } | null>
clear(org, key): Promise<void>
```

**`take` is all-or-none in one transaction.** It is the spec's upsert, generalised to `+ by` and a
window that opens at the first hit:

```sql
INSERT INTO shared_counters AS c (org_id, key, n, window_end)
SELECT $1, k, $3, date_trunc('milliseconds', now() + w * interval '1 millisecond')
  FROM unnest($2::text[], $4::int8[]) AS t(k, w)
ON CONFLICT (org_id, key) DO UPDATE SET
  n          = CASE WHEN c.window_end <= now() THEN EXCLUDED.n ELSE c.n + EXCLUDED.n END,
  window_end = CASE WHEN c.window_end <= now() THEN EXCLUDED.window_end ELSE c.window_end END
RETURNING key, n, window_end, ceil(extract(epoch FROM window_end - now()))::int AS left_sec
```

- Keys are de-duplicated and sorted, so two transactions take row locks in the same order and never
  deadlock.
- If any returned `n` passes its bucket's `limit`, it rolls back (nothing charged) and answers the
  largest `left_sec`. The row lock serialises takers on one key, so N pods racing at
  `limit − 1` let exactly one through.
- `window_end` is cut to milliseconds, so a refund can name its window exactly from JS:
  `UPDATE … SET n = greatest(0, n - $k) WHERE org_id = $1 AND key = $2 AND window_end = $3`. A
  window that has already ended ignores the refund.

**Keys and windows against today.** Every limit's number is unchanged.

| Use | Org | Key | Limit | Window | Today |
|---|---|---|---|---|---|
| Password lockout | `auth.org` | `login:<email>` | 10 failures, `peek` before verifying | 15 min from the first failure; success `clear`s | Same rule, per pod (`password.ts:51-62`) |
| Email, org | from the bucket | `mail:<kind>` | `RATE_LIMIT_EMAIL_ORG_PER_HOUR` | 1 h from the first charge | A rolling hour of charges, per pod |
| Email, project | from the bucket | `mail:<project>:<kind>` | half of that | 1 h | Same |
| Test email | from the bucket | `mail:test` | 10 | 1 h | Same |
| Send now | `ctx()` | `sendnow:<project>:<subscription>` | 1 | 60 s from the send | Same rule, per pod |
| Embed, per token | the token's org (after the MAC) | `embed-token:<fingerprint>` (the first 16 characters of the signature, `token.ts:184-187`, never the token) | `RATE_LIMIT_EMBED_PER_MINUTE` | 60 s from the first view | `@fastify/rate-limit`'s local store, a fixed window from the first hit, per pod |
| Embed, per org | same | `embed-org` | `RATE_LIMIT_EMBED_ORG_PER_MINUTE` | 60 s | Same, per pod |

- **The mail budgets change shape:** a rolling hour becomes a fixed hour from the first charge. That
  is what an `ON CONFLICT` counter can be. The worst case is 2× the limit in the minutes around a
  window's end. Today it is N× across N pods, so with two pods or more this is never looser.
- **Budget API.** `budget.ts` keeps its `Bucket` tuple (`[org + '\0' + rest, limit]`) and its
  bucket builders. `hold` and `refund` become async and split the org off the key: every key of one
  hold must name the same org, which is asserted. So **every kind moves without being named**,
  including item 3's `mention` through the existing builder. Item 3's `hold(…)` call needs an
  `await` at the merge.
- The embed check charges both buckets in one `take`. A refused view counts in neither; today a view
  refused by the org limit still counted against its token. That is invisible from outside, since
  it is refused either way.
- **Not moved:** `limits.ts`'s per-IP and per-user buckets (they protect this pod's CPU), the SMTP
  semaphore and `LIVE_MAX_CONCURRENT` (they protect this pod's sockets and the warehouse
  connection slots it opens). R8 says so.

### 3.9 `sample:seed`

`withOrgLock(name, fn)` is added to `src/server/jobs/refreshLock.ts`, which already owns the
advisory-lock pool (`useRefreshLockDb`, `:43-46`):

1. A dedicated client: `BEGIN`, `SET LOCAL lock_timeout = '30s'`,
   `SELECT pg_advisory_xact_lock(hashtext(<org> || ':sample:seed'))`.
2. `fn`: re-check `listProjects()`, then seed.
3. `COMMIT`.

- Transaction-level, so a pod that dies drops it.
- Nothing else runs on that client. The seed's own writes use other clients, so this is not
  `recordFs.locked`'s DuckDB-in-a-transaction problem.
- The per-pod `seeding` Map stays in front, so same-pod callers still share one answer.
- A second pod's caller waits for the first to commit, then sees a project and answers
  `has_projects`. The page already says "Your organization already has a project." and refreshes
  its lists (`NoProject.tsx:30-33`).
- Without the DB it just runs (one process).

### 3.10 The sweep job

`defineJob('shared:sweep', { everyMs: 5 * 60_000 })`, defined once per process (the `defined`
guard, `subscriptions/job.ts:25-34`). The runner runs it per org, in that org's context, so every
statement is under RLS for that org. One pass:

1. `file_tokens` with `expires_at < now() − 10 min`: delete the object, then the row. The grace keeps
   a download that started just before expiry from losing its bytes mid-stream; the token itself
   stopped working at `expires_at`.
2. `import_stages` past `expires_at`: object, then row.
3. `shared_counters` whose `window_end < now()`: delete.
4. Plan runs: `prune()` (§3.5).

- A failed object delete keeps its row for the next pass (as `collectGarbage`, `storage.ts:160-165`).
- The per-process timer in `files.ts` stays. It sweeps the Map backend, or (DB on) this pod's local
  copies.

### 3.11 Without `DATABASE_URL`

Nothing is shared, because there is one process:

- tokens: the Map;
- stages: the Map;
- counters: the memory store;
- jobs: local only;
- `sample:seed`: the in-flight Map.

Plan runs and drivers facts are records either way (recordFs writes files). The Helm chart requires
`DATABASE_URL` (`values.yaml:27`), so a multi-pod install always has it.

## 4. Migration `0021_any_pod.sql`

```sql
-- Any pod can serve any request (docs/any-pod/00-design.md). Three things that were one pod's
-- memory become rows every pod reads:
--
--   file_tokens      upload and download tokens (src/server/fileTokens.ts)
--   import_stages    parsed-but-unsaved imports (src/data/stageStore.ts)
--   shared_counters  the abuse limits' windows (src/server/counters.ts)
--
-- Their bytes live in the org's staging area (src/server/staging.ts):
-- DATA_DIR/orgs/<org>/temp/<storage_key> on a shared volume, or
-- s3://<bucket>/<prefix>/orgs/<org>/staging/<storage_key>. A storage_key is a server-made file name
-- (no separator), and the org part of every path is the caller's, never read from a row.
-- The `shared:sweep` job deletes what has expired.
--
-- file_tokens holds the sha256 of a token, never the token. A take is one conditional UPDATE that
-- names the org, the user and the kind, so a wrong caller matches nothing and burns nothing.
--
-- Additive only: three new tables. org_id is text, as in 0007_records.sql (dev mode's org is the
-- literal `default`).

CREATE TABLE file_tokens (
  token_hash   bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('upload', 'download')),
  storage_key  text        COLLATE "C" NOT NULL,
  name         text        NOT NULL,
  size         bigint      NOT NULL CHECK (size >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX file_tokens_expiry ON file_tokens (org_id, expires_at);

-- `meta` is JSON text, not jsonb: a column name may hold U+0000, which jsonb refuses.
CREATE TABLE import_stages (
  id           uuid        PRIMARY KEY,
  org_id       text        NOT NULL,
  user_email   text        NOT NULL,
  storage_key  text        COLLATE "C" NOT NULL,
  meta         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX import_stages_owner ON import_stages (org_id, user_email, created_at);
CREATE INDEX import_stages_expiry ON import_stages (org_id, expires_at);

-- A window opens at a key's first hit and lasts its limit's window; at its end the count starts
-- over. window_end is cut to milliseconds, so a refund names its window exactly.
CREATE TABLE shared_counters (
  org_id      text        NOT NULL,
  key         text        COLLATE "C" NOT NULL,
  n           bigint      NOT NULL CHECK (n >= 0),
  window_end  timestamptz NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- Defence in depth, forced as on records (0007): every statement already names its org and runs
-- in a transaction that sets `ordinate.org`; unset → NULL → no rows. A superuser or BYPASSRLS role
-- skips RLS entirely, so run the app as an ordinary role.
ALTER TABLE file_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY file_tokens_org ON file_tokens
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE import_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY import_stages_org ON import_stages
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE shared_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_counters_org ON shared_counters
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
```

- Every caller knows its org before it touches these tables:
  - a request: `ctx()`;
  - password sign-in: `auth.org`;
  - an embed view: after the MAC check;
  - the sweep: the runner's per-org context.

  So RLS is forced with no exception.
- The org-scoped transaction is one new helper, `inOrg(pool, org, fn)` in
  `src/server/db/orgTx.ts`. It is the same three statements as `storage.ts:179-194`, which keeps
  its own copy (no refactor).

## 5. Steps, in commit order

Each step ends green: build, the targeted suites, lint, contracts and file size. The full `npm test`
runs both ways at the end.

1. **This design doc.**
2. **Migration 0021, `inOrg`, the shared counter, and the four limiters moved.**
   - Code: `counters.ts` with both stores; `src/server/sharedState.ts` (`wireSharedState(pool)` /
     `unwireSharedState()`), which is two lines in `app.ts`; `password.ts`; `budget.ts` and
     `emailChannel.ts` (async `hold`); `subscriptions/rpc.ts`; `embed/route.ts`.
   - Tests: `scripts/test-sharedCounters.ts`.
   - Docs: `sso.md:211`, `email.md:129`, `configuration.md:83-84`, `:101`, `embedding.md:125`.
3. **S3 PUT and streamed GET, and the staging area.**
   - Code: `s3.ts` (payload-hash signing, `put`, `open`); `storage.ts` (`s3Config`, export
     `orgKey`); `src/server/staging.ts`.
   - Tests: extend `test-storageS3` (a PUT round-trips byte-identical; a body that does not match
     its declared sha256 is refused by the store, as a negative control).
4. **File tokens in Postgres.**
   - Code: `src/server/fileTokens.ts`; `files.ts` (async API, routes on any pod, `localCopies`, the
     5 GiB cap); the 8 + 4 call sites (`await`, every `done()` still in its `finally`); the
     `shared:sweep` job (tokens and counters).
   - Tests: `scripts/podHarness.ts` and `scripts/anyPodPreload.ts`; `scripts/test-anyPod.ts` with
     cases 2, 3, 6, 7, 8 and 9 (§6).
5. **Staged imports as Parquet.**
   - Code: `stageCodec.ts`, `stageStore.ts`; `parquetStore` (`encodeCell`, `limit`);
     `importStage` async with the Map kept; the 3 writers and 2 readers; stages in the sweep.
   - Tests: `scripts/test-stageParquet.ts`; test-anyPod case 1.
6. **Plan runs as records.**
   - Code: `planRun` (`beginStep` / `endStep` / `recoverStep`); `src/ai/planStore.ts` (path,
     sanitize, claim, heartbeat, apply, prune); `plan.ts`; the `projectId` contracts in
     `assistant.ts`; `PlanCard.tsx`; plan runs in the sweep.
   - Tests: extend `test-planRun`; test-anyPod case 4 and the concurrent-Next check.
7. **Jobs over the bus.**
   - Code: `podCommands.ts`; `bus.ts`; `ipc/jobs.ts`; `web/src/api/jobs.ts` (the merge,
     `useJobList`); `SegmentsParts.tsx`.
   - Tests: Vitest; test-anyPod case 5.
8. **Drivers facts record, and the `sample:seed` lock.**
   - Code: `drivers.ts` (`remember` / `recall`, `driversFor`'s option); `copilot.ts:310`;
     `refreshLock.ts` (`withOrgLock`); `projects.ts`.
   - Tests: `test-drivers`; a two-pod seed race in test-anyPod.
9. **Docs.**
   - Every row of the table in §2, with each "per pod" line made true.
   - `docs/server/README.md`'s day-one list loses its sticky item (two things now).
   - `upgrade.md` gets the one line: "Before <version>, more than one pod needed sticky sessions;
     you may remove them after upgrading."
   - R8 rewritten: what is shared now (tokens, bytes, stages, plan runs, drivers facts, counters,
     cancel), what stays per pod and why, and that uploads now rest in the org's staging prefix for
     at most an hour plus the sweep.
   - `CLAUDE.md:52`, `CHANGELOG.md`, and a `docs/README.md` row.
   - The `ponytail:` per-pod comments in code.

## 6. Tests, one to one with the spec

### `scripts/test-anyPod.ts` (new)

The harness:

- Two real server processes, A and B (`node -r scripts/anyPodPreload.js src/server/main.js`,
  `PORT=0`), on one scratch database.
- `AUTH_MODE=dev`, and the preload reads the caller from `x-test-user` / `x-test-org`, as
  `jobsPodPreload.ts` does. So two users are both admins, and only the token's own user check can
  refuse the wrong one.
- Every request alternates between A and B unless a case pins a pod.

It runs three passes:

| Pass | Pods | Proves |
|---|---|---|
| `file` | A and B share one `DATA_DIR` | file mode |
| `s3` | separate `DATA_DIR`s, `STORAGE_URL` on MinIO with a per-run prefix | S3 mode, and that nothing rides on a pod's disk. Skipped with one line when `STORAGE_URL` is not `s3://`; CI sets it (`ci.yml:85-94`). |
| `memory` | no `DATABASE_URL`, shared `DATA_DIR` | the negative control |

| # | Spec test | How |
|---|---|---|
| 1 | Upload on A → parse on B → save on A = a one-pod import | A nasty CSV: `007`, `-0`, `1e21`, an empty string and a NULL, NBSP and tab, a leading BOM, a duplicate and a quoted header, enough rows to pass `STAGE_MEMORY_CELLS` (the Parquet path) and a small one (the fast path). The cross-pod import's rows read over RPC (wire-encoded, so `-0` survives) equal the one-pod import's, with `Object.is` on every cell, and the columns and types match. `dataset:composePreview` on B reads the same stage with a limit. |
| 2 | Export on A → download on B | `projects:export` on A, `GET /api/files/<token>` on B: byte-identical to a same-pod download of a second export. |
| 3 | Backup on B → restore on A | `backups:download` on B, download on A, upload on B, `backups:restore` on A. Every project comes back, and counts match. |
| 4 | A plan run started on A advances on B, undo works on A | `plan:start` on A with `[import, metric]`. The upload is on A; `plan:next` on B runs the import (also a cross-pod take); `plan:next` on A runs the metric; `plan:undo` on A trashes both. Plus: Next on A and B at once (the preload slows the import step), and exactly one runs it while the other gets "still running". |
| 5 | Cancel on B stops a job running on A | The preload holds `sql-save` jobs until their signal aborts. `sql:prepareSave` on A; read the job id from `jobs:list` on A; `jobs:cancel` on B. A's RPC answers `canceled`, and a tab whose stream is on B gets `jobs:changed` with `cancelled`. |
| 6 | Two simultaneous takes of one token, on A and B | `boundary:import` with the same token on both at once, 20 times: exactly one `ok` each time. |
| 7 | A wrong user's take on B does not burn the token | User 2 takes user 1's token on B: refused. Control: user 1 then takes it on A, ok. |
| 8 | An expired token fails on both pods; its object is gone after the sweep | Set `expires_at` to a day ago in SQL. Takes on A and B are refused. Make `shared:sweep` due (`UPDATE jobs SET next_run_at = now()`; the preload shortens the runner's poll). The row is gone, and so is the file (file mode) or the object (S3 GET → 404). |
| 9 | NEGATIVE CONTROL: the memory store fails across pods | In the `memory` pass, an upload on A taken on B is refused ("expired"). Control: the same take on A works. |

Also in this suite:

- **The org wall.** A stage row planted for org X with a key; org Y asking for that id gets GONE.
  A `file_tokens` row planted in org Y with org X's object key can only resolve inside Y's own
  staging (the file is absent).
- **The seed race.** `sample:seed` on A and B at once makes exactly one project.

### Counters (`scripts/test-sharedCounters.ts`, new)

- **11 failed sign-ins across two pods lock the account; control: 9 do not.** Two
  `AUTH_MODE=password` pods on one database, with a user created through the setup code each pod
  logs. Failures alternate A/B. The 11th attempt answers `locked` with `Retry-After`. Control:
  after 9 failures, the right password signs in.
- **The test-email limit holds across pods.** A fake SMTP server; `channel:test` alternating A/B.
  10 are sent and the 11th is refused `rate_limited`. Control: the 10th is sent.
- **The helper, against both stores** (differential): the same scripted sequence (charge, refuse at
  the limit, all-or-none across two buckets, refund, the window ends) gives identical answers from
  the memory store and from Postgres.
- 10 concurrent `take`s at `limit − 1` let exactly one through (control: the memory store, in one
  process, does too).

### `scripts/test-stageParquet.ts` (new, no DB needed)

- **Differential.** The fixture goes through the codec and Parquet, and back through `get` with and
  without a limit. It equals the in-memory path with `Object.is` on every cell, and on columns,
  types, `rowCount`, `warnings` and `sheetNames`.
- **The edge tables:** 0 columns × N rows; N columns × 0 rows; a 1,000-column table; and a column
  name with `"`, a newline, U+0000 and a lone surrogate.
- **NEGATIVE CONTROL:** the same table written with the plain dataset encoding (no tags) fails the
  comparison on `-0` and on the lone surrogate. The fixture really bites.
- A non-string, non-number cell throws.

### Must stay green

- The files, import and plan suites: `test-files`, `test-importServer`, `test-planRun`,
  `test-planCheck`, `test-planRows`.
- The email suites: `test-smtp`, `test-email-db`, `test-subscriptions-db`,
  `test-subscriptions-server`.
- `test-blobs-pods`, `test-jobs-pods`, `test-refreshHooks-pods`, `test-recordLocked-pods`.
- `test-embed-db`, `test-embedLock`, `test-embedToken`.
- `test-password-db`, `test-sampleSeed-db`, `test-drivers`, `test-storageS3`, `test-asyncReach`
  (nothing new reaches a sync DuckDB call), `test-i18n`, and `test-serverDocs`.
- Vitest `JobsButton.test.tsx`; e2e `import.e2e.ts`, `compose.e2e.ts`, `dock.e2e.ts` (the
  Assistant).

### Gates

- `node scripts/test-anyPod.js`, with `file` and `s3` passes green (CI env: password Postgres and
  MinIO).
- `npm test` with and without `DATABASE_URL`.
- `npm run lint`: 0 findings.
- `check-contracts`: 0 unresolved.
- `test-file-size`.
- `helm lint`.

## 7. Risks and traps

1. **Item 3's `hold()` becomes async.** Its `mention` call needs an `await` at the merge. The bucket
   builders and key shape are unchanged, so nothing else moves.
2. **Item 1 and `resolveUpload`.** The path stays local and is valid until `done()`. Restore's
   `done()` stays after the job (`settingsServer.ts:190`, `:196`); if item 1 moves the read into the
   job, it must still finish before `done()`. In file mode the path is on the shared volume (EFS or
   NFS), where positioned reads work but are slower than local disk. Close-to-open consistency
   holds, because the upload's write stream closes before the token is issued.
3. **`bus.ts` is shared with item 2** (closing a user's streams). The command branch is separate and
   additive; keep both at the merge.
4. **Pool budget.** No new long-held client: plan steps hold no lock while they run, and
   `sample:seed` holds one client for a few seconds, once per org. Each embed view adds one short
   transaction (three round trips), which is worth watching on item 1's `pg_pool` metric.
5. **The mail-budget window changes shape** (rolling to fixed). The worst case is 2× at a window's
   end. Documented in `email.md` and `configuration.md`.
6. **A stall past the plan lease** (90 s with no heartbeat, a blocked event loop) lets another
   request recover the run while the first still finishes its writes. The fence then drops the late
   outcome, so undo does not know about those writes; they are still in version history and the
   Trash. The same class as the jobs runner's late finish.
7. **The Parquet write on the parse path** adds seconds at 1M rows, behind the composer's existing
   spinner. Phase B measures it, and the PR body states it.
8. **S3's single PUT** caps uploads at 5 GiB in S3 mode. A drill-down CSV over 5 GiB would fail its
   PUT ("Failed to export the rows"); 1M rows × 1,000 wide columns is the only way to get there.
9. **The popover merge** keeps a dead pod's active jobs until a reload, as before.
10. **i18n.** New server sentences go through `t()` where the file is in `MAIN_FILES`; elsewhere
    they are literals, matching the file. Run `i18n-extract` after `build:ts`.
11. **File size.** `datasets.ts` (747), `ipc/datasets.ts`, `datasetCompose.ts` (370) and
    `copilot.ts` (595) only gain `await`s. New logic goes in new modules. `recordFs.ts` (497) is not
    touched.
12. **Contract change.** The `plan:*` inputs gain `projectId`. A stale browser tab gets a 400 on
    Next until it reloads, which is acceptable for a release.
