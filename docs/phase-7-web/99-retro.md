# Phase 7 retro: Ordinate as a self-hosted web app

Phase 7 replaced the Electron desktop app with a web app that a company runs itself. It ran from
2026-10-02 to 2026-10-05: 46 tasks (T0.1 to T8.2), PRs #188 to #244, and 154 non-merge commits from
the pre-phase base `6391e6f` to `a67d769` (T8.1 ticked). Every number below comes from
[`log.md`](log.md) (cited by date and task), from git, or from a command run for this retro (marked
*measured*). Where the log gives a range, the range is quoted.

## 1. Tasks and PRs

| Phase | Task → PR |
|---|---|
| P0 Foundations | T0.1 server skeleton #188 · T0.2 RPC + wire codec #190 · T0.3 request context #191 · T0.4 files #195 · T0.5 SSE #196 · T0.6 web shell #194 · T0.7 UI kit #199 · T0.8 e2e harness #201 |
| P1 Rendering | T1.1 charts #209 · T1.2 pivot/cohort/funnel grids #231 · T1.3 maps #210 · T1.4 data grid #207 |
| P2 Screens | T2.1 Home #216 · T2.2 projects #217 · T2.3 Data #222 · T2.4 import #219 · T2.5 connections #214 · T2.6 Prepare/Pipelines #224 · T2.7 Visuals #223 · T2.8 analyses #233 · T2.9 dashboards #240 · T2.10 analytics A #225 · T2.11 analytics B #238 · T2.12 AI dock #215 · T2.13 reports #234 · T2.14 settings #226 |
| P3 Identity | T3.1 Postgres #192 · T3.2 sign-in #200 · T3.3 authorization #202 · T3.4 admin + API tokens #208 |
| P4 Engine | T4.1 async resident A #198 · T4.2 async resident B #205 · T4.3 per-org workers #206 |
| P5 Storage | T5.1 records in Postgres #204 · T5.2 Parquet on S3 #213 · T5.3 secrets #197 · T5.4 jobs + cross-pod events #203 |
| P6 Security | T6.1 SSRF #220 · T6.2 web hardening #211 · T6.3 review + threat model #232 · T6.4 regex off the request thread #237 |
| P7 Packaging | T7.1 Docker + Compose #236 · T7.2 Helm #239 · T7.3 release + operator docs #242 |
| P8 Cutover | T8.1 delete the desktop app #244 · T8.2 docs and rules (this change) |

Fix PRs between the tasks: #189 (develop smokes), #193 (merge drop), #218 (pool idle-sweep race),
#221 (lost DuckDB interrupt), #227 (chain-merge drops and three flakes), #228 (MinIO image),
#229 (suites that assumed trust auth), #230 (57P01 at teardown and a smoke race), #235 (the same
57P01 fix for three later suites), #241 (SQL editor caret), #243 (dev proxy Host). #212 added the
README banner. T6.4 was not in the original plan: T6.3 found R1 and the user made it a task.

## 2. What was built

- **Server** (`src/server/`, Fastify 5): RPC at `POST /api/rpc/<channel>`, reachable only through a
  zod contract in `src/api/` with an access level and a project or org scope; a wire codec that keeps
  NaN, ±Infinity, -0, undefined, Date, Map, Set, BigInt and bytes; request context through
  `AsyncLocalStorage`; uploads and downloads by single-use token; SSE; GeoJSON by exact name;
  `/healthz`, `/readyz`, `/metrics` on its own port.
- **Identity**: OIDC (code + PKCE), header mode behind a trusted proxy, dev mode; sessions in
  Postgres; orgs, teams, per-project grants, an audit log, personal API tokens, an admin console.
- **Storage**: Postgres for records (RLS forced per org), jobs, audit and envelope-encrypted secrets;
  Parquet on disk or S3 through DuckDB `httpfs`, written as versioned keys behind an atomic pointer
  switch, with GC; `npm run import-desktop` for desktop installs.
- **Engine**: every request-path DuckDB call async (`test-asyncReach` proves it), one locked DuckDB
  worker per org, cancel on client hang-up, user regex in a worker with a 2 s deadline.
- **Web app** (`web/`): React 19 + Vite, every desktop screen ported with a parity checklist, 39 chart
  types, maps, grids, a virtualized data grid, a command palette, both themes, designed empty,
  loading and error states.
- **Security**: SSRF guard on every socket a connection opens, CSRF double-submit, header CSP,
  rate limits, timeouts, a threat model, `SECURITY.md`, a CI audit gate.
- **Packaging**: a multi-arch image, a Compose stack, a Helm chart with a migration hook, a release
  workflow, operator docs in `docs/server/`.
- **Cutover**: Electron, `renderer/`, `preload/`, the windows, desktop-only IPC, local CLI execution,
  local-folder connectors, Mosaic and the Svelte spike deleted. Tests against deleted reference code
  became golden fixtures, each with a negative control.

## 3. Key numbers

| What | Number | Source |
|---|---|---|
| Lines deleted at the cutover | 1,079 files, +5,788 / −196,790 lines; `npm install` removed 365 packages, added 0 | log 2026-10-05 T8.1 |
| Initial JS bundle (gzip, limit 300 KB) | 110.8 KB (T0.6) → 142.7 (T0.8) → 177 (T2.14) → 188.41 (T2.9) → **188.44 KB** | log 2026-10-02 to 10-04; *measured* `npm --prefix web run size` on `a67d769` |
| RPC budget | 25 per page load (`rpcBudget`, T0.8). `/dev/charts` hit 25 exactly → `visual:dataBatch` (T2.1); dashboard runtime flow 24, pivot builder 22, Home 2, compose.e2e ≤ 15 | log T0.8, T1.1, T2.1, T2.9, T2.11, T7.1 |
| RPC contracts | 8 (T3.3) → 91 (T2.2) → 145 (T2.7) → 213 (T2.14) → 239 (T2.8) → 284 (T2.11) → 295 (T2.9) → **312**, 0 unresolved | log; *measured* `node scripts/check-contracts.js` |
| Self-check suites (`npm test`) | 245/245 (#193) → 287/287 (T7.3) → 254/254 after T8.1 removed suites whose code was gone; `scripts/test-*.ts` files 207 at `6391e6f` → 238 at `a67d769` | #193, log T7.3, T8.1; *measured* `ls` |
| Vitest | 0 (no `web/`) → 336 (#218) → 594 (T2.8) → **691** (T8.1) | #218, log T2.8, T8.1 |
| Playwright e2e | 4 (T0.8) → **62** (T7.3, T8.1), 27 spec files | log; *measured* `ls web/e2e/*.e2e.ts` |
| Image size (cap 600 MB) | 589 MB (T7.1) → amd64 583 / arm64 589 MB, compressed 136 / 133 MB (T7.3) → **582 MB** (T8.1) | log T7.1, T7.3, T8.1 |
| Compose | `up --wait` 15 s clean, 54 s with a cold build; quick start from a clean state 38 s | log T7.1, T7.3 |
| Helm | `install --wait` 12.3 s; upgrade hook Job 3 s; **`/readyz` 267/267 OK over 27 s** of `helm upgrade`; additive migration through the hook 16 s; `helm rollback` 13 s | log T7.2, T7.3 |
| ReDoS deadline | 2 s per call; six hostile patterns at once all time out in 2.0–4.0 s; max event-loop delay 6.6–28.8 ms; ordinary 100k-row replace 38.8 → 47.2 ms, formula `regexp_replace` 37.9 → 106.3 ms | log T6.4 |
| Load test | 20 users × 5 iterations, 1M rows, 600 requests, 0 failed; event-loop p99 22.6 ms at load 20 | log T4.3 |
| Wire codec | plain JSON would have silently changed 3 of 28 real replies | log T0.2 |
| SSRF | 49/49 hostile URLs refused before any socket; 0 DB sockets opened | log T6.1 |
| Cross-pod events | NOTIFY pod A → tab on pod B median 0.66–0.91 ms | log T5.4 |
| S3 | page median disk 37.4 / S3 httpfs 41.9 / S3 cached 35.4 ms (1M rows, MinIO) | log T5.2 |

## 4. What went wrong, and the fixes

**Merges that dropped work.**
- #193: the T0.3/T3.1 conflict was resolved in GitHub's web editor by keeping one side of each of
  three conflicts. `src/server/app.ts` lost an import and develop stopped compiling.
- #227: the four "Merge branch 'develop' into web/t2.x-chain" merges (#223–#226) took develop's side
  of `web/src/app/routes.tsx` and `log.md`. Develop lost 22 route lines (Visuals, Prepare, Pipelines,
  Analytics, About) and 83 log lines. Both files were restored from the gated chain tip `bdeeb95`.

**Merges before CI.** Merges landed on local gate runs while CI was down (below), and the user
merges within seconds of a PR opening. #228 merged with only its first commit, so its second became
#229. The #235 fixes were pushed to chain branches after #231–#234 had merged and never reached
develop until re-sent.

**CI billing.** From 2026-10-03 02:22 UTC GitHub Actions refused every job ("recent account payments
have failed"). The user chose to merge on the orchestrator's local gates (build, `npm test` without
and with Postgres, lint, web build, Vitest, e2e, the touched Electron smokes) until Actions ran again
with #227 on 2026-10-04 (log 2026-10-03, 2026-10-04).

**Flakes and their root causes.** None was fixed by loosening an assertion.

| Symptom | Root cause | Fix |
|---|---|---|
| `connections.e2e` failed about 1 run in 2, on develop too | The three SQL editors moved the caret in a `requestAnimationFrame` after a completion; keys typed in that frame landed at the end, then the caret jumped back | `web/src/ui/useCaret` places the caret in a layout effect (#241): 8/8 passes |
| A suite passed every check, then died with exit 134 (`Napi::Error`) | `selfcheck.finish()` called `process.exit()` while a `@duckdb/node-api` call was in flight | `finish()` closes the busy bridge and exits once the worker is gone, with `test-selfcheckExit` as proof (`6cad8f2`, in #240) |
| DB suites crashed at teardown on CI only | `DROP DATABASE … WITH (FORCE)` ends the scratch DB's idle connections (57P01); a pg Pool with no `'error'` listener re-emits that as an unhandled error | One listener per pool: 11 suites (#230), 3 more (#235) |
| CI's first run after billing failed at "Start MinIO" | `minio/minio` was gone from Docker Hub | `chainguard/minio` (#228) |
| Two suites failed only on CI | They assumed a trust-auth Postgres and a pre-created bucket | Signed in as a real role; created the bucket (#229) |
| "the DuckDB worker stopped" under load | The idle sweep and LRU could close a worker that was still starting while a call waited on `ready` | A `waiting` counter (#218) |
| A cancelled query ran to completion (22–57 s) | `connection.interrupt()` is dropped when nothing is executing yet | Re-interrupt every 10 ms until the call settles (#221) |
| `test-automationTools`, `auth.e2e`, `shell.e2e` | A search-index timer inside the test window; Chromium's `/favicon.ico` 404 on the mock IdP; a wait for exactly `/data` before its redirect | Stubbed timer, `data:` icon, path-or-subpath wait (#227) |
| `npm run dev:web` got 403 on every POST | The Vite proxy shorthand turns on `changeOrigin`, so Host and Origin disagreed for the CSRF check | `changeOrigin: false` plus `devproxy.e2e.ts` (#243) |

**Other things that bit.**
- T5.1 first ran as migration 0004 against the shared dev DB and was then renumbered 0007, which left
  a stale row and table. Out-of-order migration numbers now refuse startup (log T5.1).
- Single DB suites failed under the parallel load of several agents and passed alone (log T2.4
  onward). The gate rule stayed: a failure counts unless it passes on an isolated re-run.
- Tenant-isolation bugs were found in passing, not by a dedicated review: 14 modules caching the
  first caller's paths (T0.3), 7 caches keyed by record id alone (T5.1), cross-project
  `connection:delete` (T2.5), conversations shared per project (T2.12).

## 5. Security findings

From the T6.3 review (`6391e6f..HEAD`, 159 commits, by hand) and T6.4; details in
[`threat-model.md`](threat-model.md) §5 and §6.

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | An imported bundle could plant a `file` origin; `dataset:refresh` read any csv/json/xlsx on the pod, including other orgs' data | High | No file origin on the server; `refreshFromFile` refuses |
| F2 | Connection secrets outlived a deleted project; a bundle naming that id adopted the password | High | Fresh ids on import; `projects:delete` drops secrets |
| F3 | Postgres connector sent user SQL as multi-statement text: writes on the source, and a trailing `--` dropped the row cap | High | Extended protocol (one statement); user SQL on its own line |
| F3b | MySQL family: a trailing comment dropped the `LIMIT` | Medium | User SQL on its own line |
| F4 | `sqlGate` missed a path in a parenthesised join and `json_execute_serialized_sql` (latent) | Medium | Gate fixed; function denied |
| F5 | `alerts:fired` / `hub:dataset-refreshed` went to the whole org, with raw refresh errors | Medium | Project readers only; errors redacted |
| F6 | `projects:export` (raw origins) was `read` | Medium | Project admin |
| F7 | `/api/mcp` had no rate limit | Low | Shares the RPC buckets |
| F8 | `composeSave` linked a capture from no project | Low | Only the caller's project's captures link |
| R1 | User regex on the request thread: ReDoS stalled the pod for every org | High (availability) | T6.4: regex worker, 2 s deadline (numbers in §3). Mitigated, with residuals listed in the threat model |

No cross-project IDOR was found in the 213 contracts reviewed at T6.3.

## 6. Still open

- **Sticky sessions.** Upload/download tokens, plan runs and rate limits are per pod, so more than
  one replica needs sticky sessions. Documented for ALB, nginx and GKE; untested (R8, log T7.3).
- **Never run for real:** IRSA, ECS, ALB, RDS, GCS, AKS, any real IdP, and `release.yml` itself.
  Nothing has been tagged; cutting v0.1.0 is the user's call (log T7.3). `package.json` says 0.1.0,
  which `CHANGELOG.md` also uses for the desktop release; choose the first web version before
  tagging. The Firefox/WebKit nightly has no recorded run in `log.md`.
- **Rare DuckDB native abort in CI.** `6cad8f2` covers a suite exiting during an in-flight call. A
  `libc++abi … Napi::Error` at process exit was also seen in other suites (#221) and in
  `datasetPageRpc` (log T7.2); whether every case is covered is unproven. Follow-up.
- **The automation CLI and stdio MCP** (`src/automation/cli.ts`, `argv.ts`) have no entry point
  since T8.1. HTTP MCP at `/api/mcp` is the live surface. Wire a Node entry or delete them.
- **`test-backups` load flake:** fails once under full parallel load, passes alone (log T2.8, T2.13,
  T2.11, T7.2).
- **Image headroom:** 582 MB against the 600 MB cap, 18 MB (11 MB at T7.1).
- **Accepted risks** in the threat model: R2 (SQL gate is a deny-list lexer), R3 (bundle import can
  inflate to 4 GB in memory), R13 (org editors may call org-level writes; user decision pending).
  GitHub private vulnerability reporting must be switched on for `SECURITY.md`'s link to work. The
  MapLibre advisory allowlist entry is due for review by 2027-01-04.
- **Functional gaps:** `pipelines:run` is one RPC (more than 60 s → 504); pipeline `report`/`publish`
  nodes and automation PNG/PDF export refuse on the server; scheduled server-side reports are not
  built; listing records is one query per record (log T5.1); secrets rotation accepts one master key
  per pod (log T5.3).
- **Carried desktop bugs, pinned not fixed:** `geoMatch` gives West Virginia Virginia's value (log
  T1.3); the candlestick port uses the label index where the desktop never drew a candle (log T1.1).

## 7. Lessons

1. **A merge is a change.** Every lost-work incident (#193, #227, #235) came from a merge, not a
   task. Resolve keeping both sides, re-run the gates on the merged tree, and do not consider work
   landed until it is on develop.
2. **Contracts paid for themselves.** "No contract, no channel" let 14 screens port in parallel
   without one unchecked endpoint, and gave T6.3 a finite list (213) to review.
3. **Differential tests survive deleting the reference** if the reference's answers are recorded
   first. Golden fixtures with negative controls kept every test at T8.1.
4. **Load hides and creates bugs.** The pool race, the lost interrupt, 57P01 and the exit-134 abort
   only showed under parallel load or on CI. Isolated re-runs separated flakes from failures; root
   causes, not retries, closed them.
5. **Measure the work, not the wall clock.** T3.3's "< 5 ms" assertion failed at load average 31;
   asserting the number of queries per decision held.
6. **Tenant isolation fails in caches.** 21 caches and one handler leaked across orgs or projects;
   none was in the authorization code. `orgKey()` and per-org DuckDB workers made the boundary
   structural.
7. **Write numbers down as you go.** This retro is built from `log.md`; nothing here had to be
   reconstructed from memory.
