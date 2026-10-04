# Phase 7 log

Append-only. One entry per task: date, task id, what was measured, what was decided and why.

## 2026-10-02 — T0.1 Server skeleton

- **Measured** (5 runs, `node src/server/main.js`, PORT=0): cold start to listening 67–69 ms; first
  `/readyz` 46–61 ms (one-off DuckDB worker start, blocks the loop once); warm `/readyz` ~1 ms.
- **Dependency:** `fastify ^5.12.5` only. Its transitive `ajv`, `fast-uri`, `json-schema-traverse`,
  `require-from-string` move from dev to prod in the lockfile. The other `@fastify/*` plugins land
  with the task that first uses them.
- **Decided:** `DATA_DIR` is required in `prod` (a pod writing to its container filesystem loses
  every dataset on restart); dev defaults to `./data`. Dev binds `127.0.0.1` because T0.3's dev auth
  makes every request an admin; prod binds `0.0.0.0`. Unknown env *names* are not rejected (each
  later task adds variables), only invalid *values* — one `ordinate: …` line, exit 1.
- **Log redaction** is pino exact-key paths at depths 0–4 for authorization, proxy-authorization,
  cookie, set-cookie, x-api-key, password, token, secret, key. `apiKey`/`accessToken`-style names
  are not matched; a walking serializer is the upgrade if a handler ever logs such an object.
- **No-Electron proof:** `test-server-boot` spawns the server with a preload that makes
  `require('electron')` throw (negative control included); `/healthz` and `/readyz` are 200.

## 2026-10-02 — T0.2 RPC registry, contracts and wire codec

- **Bulk edit (scripted, orchestrator):** 80 `src/ipc/*.ts` take `ipcMain` from `./bus` — 53 one-line
  swaps, 27 split imports. Only `ipcMain.handle` (405 sites) and `ipcMain.on` (11) exist.
- **Wire format:** body = wire-encoded `{ args: [payload?] }`; the contract's zod input validates
  `args[0]`; handler called as `handler(SERVER_EVENT, parsed)`. 404 no contract (even with a handler
  registered), 400 `{error, issues:[{path, code}]}` — paths and zod codes only, never values or
  messages; 501 contracted-but-unregistered; 500 handler failure (message to the log only).
  Tags `{"$":…}` for NaN/±Inf/-0/undefined/holes/BigInt/Date/Map/Set/Uint8Array; an object with its
  own `$` key is escaped (`{"$":"O"}`), and decode uses `defineProperty` so `__proto__` stays a key.
  `Buffer` decodes to a plain `Uint8Array` — what `structuredClone` and Electron IPC give.
- **Measured** on the largest real reply (`stats:run` regression, 80,456 bytes, 50-run mean):
  encode 0.33 ms, decode 0.17 ms; plain JSON round trip 0.37 ms; structuredClone 0.22 ms. Plain JSON
  would have silently changed 3 of the 28 real replies tested (`category: undefined` on the
  choropleth's viz data, `periodKey: undefined` in insights) — the codec is not optional.
- **Decided:** one payload argument per contract (plan §4). Nine handlers take more than one
  (`filterParse:parse`, four `format:colors:*`, `incremental:set`, three `privacy:*`) — tuple inputs
  when their screens port. `Uuid = z.guid()` (matches the repo's version-agnostic `UUID_RE`).
  Registry throws on a duplicate `handle`, as Electron does.
- **21 test suites** captured handlers through a fake `ipcMain` in their Electron stub; they now read
  the registry's map. No assertion removed.
- **Open for T0.3:** `registerHandlers()` (lazy requires) is not called from `main.ts` yet — the
  Home modules' import graph has 26 Electron importers: 20 only `app` (T0.3's `paths.ts`), and 6 more
  (`net` in `ai/analyze*`, `nativeImage` in `cli/localCliRun`, `dialog` in `ipc/projects`,
  `ipc/datasetImport`, `ipc/backups`, plus `shell`/`BrowserWindow` in `backups`).
- **Local infra:** Postgres 17 and MinIO installed via Homebrew as services (user's choice) so P3/P5
  tasks test locally; Compose/Helm verify in CI.

## 2026-10-02 — T3.1 Postgres foundation

- **Migrations:** numbered plain `.sql` in `src/server/db/migrations/`, all pending applied in ONE
  transaction behind `pg_advisory_xact_lock(7310452291)`; sha256 per file (CRLF→LF) recorded in
  `schema_migrations`; an edited applied migration refuses startup naming the file. Read from
  `path.join(__dirname, 'migrations')` — the Docker image must `COPY src/` after `build:ts` (an empty
  directory is refused, never booted on).
- **Measured:** applying 0001 at startup 24–38 ms locally incl. connect + lock wait (180 ms under the
  parallel `npm test` load); in-process apply 3.6 ms; no-op 1.0 ms.
- **Proof:** two real server processes against one fresh DB → each migration recorded once, one pod
  applied all, the other none, no duplicate-object error. Negative control: lock replaced by
  `SELECT 1` → the test failed 3/3.
- **Pool:** max 10, idle 30 s, connect timeout 3 s (a dead DB fails `/readyz` in 3 s),
  `application_name=ordinate`. pg errors are rebuilt through `safeError` so the URL's password
  (encoded or decoded) never reaches a log; proven with a canary.
- **CI:** `postgres:17` service on the test job; `DATABASE_URL` set on the self-checks step. No
  branch filter touched.
- **Known:** a DB-recorded version with no file (image rollback) is ignored, not refused; no per-file
  non-transactional migration (`CREATE INDEX CONCURRENTLY`) yet — `ponytail:` in `migrate.ts`.
## 2026-10-02 — T0.3 Request context, paths, dev auth

- **Bulk edit (scripted, orchestrator):** 64 `app.getPath(...)` in 44 files → `appPaths.<name>()`
  (`src/app/paths.ts`); `app` dropped from the electron import wherever nothing else used it; the
  import is `appPaths` because some files have a local `paths`. Zero `getPath(` outside `paths.ts`.
  One allowlisted file (`cli/localCliRun.ts`) would have grown by the split import; its two
  `child_process` imports were merged instead of raising the ratchet.
- **Tenant isolation bug found and fixed:** 14 modules cached the first caller's `userData()/projects`
  (or `history`) path in a module variable — on the server org B would have read org A's records.
  Caches removed (desktop re-asks Electron per call; cheap). The new concurrent-org test fails with
  the old cache put back.
- **Server mode** is explicit: `enterServerMode(dataDir)`, called only by `src/server/main.ts`.
  Without it `ctx()` is a fixed desktop context; with it `ctx()` throws outside a request. Every
  `/api/` request runs in `AsyncLocalStorage` with Fastify's `req.id`.
- **Org layout:** `DATA_DIR/orgs/<orgId>/{userData,downloads,temp,documents}`, created on first use;
  org id must match `^[a-z0-9][a-z0-9-]{0,62}$` before touching a path.
- **Dev auth:** dev → `dev@local`, org `default`, admin. prod refuses to start with one line until
  T3.2's `AUTH_MODE`.
- **Senders:** `senderOf(e)` (desktop `e.sender`, server `ctx().client`, a no-op `send` until T0.5)
  and `windowOf(e)` for dialog parents (null on the server). `dnd` OS drag-out stays desktop-only.
- **Electron at load:** moved inside desktop-only functions in `ipc/projects`, `ipc/datasetImport`,
  `ipc/backups`, `ai/analyze`, `ai/analyzeStream`, `cli/localCliRun`, `app/bundle`. `main.ts` now
  calls `registerHandlers()`, so `test-server-boot` (Electron blocked) covers the whole Home graph.
- **Open:** `src/app/sampleProject.ts` still imports Electron at load (T0.8 seeds the sample on the
  server); `config.ts` format/calendar/language are process-wide — two orgs can race (`ponytail:`,
  P5).

## 2026-10-02 — T0.6 Web app shell

- **Stack installed:** react / react-dom 19.3.0, react-router 7.18.4 (pinned to 7 per §2; 8.4 is
  out), @tanstack/react-query 5.104.1; dev: vite 8.3.2, typescript 7.0.2, vitest 5.0.3,
  @testing-library/react 16.3.3 + @testing-library/dom 10.4.2, jsdom 29.1.1 (30 needs Node ≥ 24.15;
  this machine has 24.14), @types/react(-dom) 19.3.0 (React 19 ships no types). Root:
  @fastify/static 10.1.5.
- **Decided (orchestrator):** `jsdom` and `@types/react*` are implied by the §2 choices (Testing
  Library needs a DOM; TS strict needs React's types). No `@vitejs/plugin-react` — Vite 8 compiles
  JSX with oxc (`jsx: automatic`).
- **Measured:** initial JS chunk 351.4 KB raw / **110.8 KB gzip** (T0.8 caps at 300 KB) with the wire
  codec in and zod out; CSS 3.3 KB gzip; Home 3.6 KB gzip; each area its own lazy chunk.
- **CSP:** the build emits a `<meta>` CSP and no inline script/style; theme applied before first
  paint by an external `theme-boot.js`. Live check: `npm run server` with 3 seeded projects in
  `DATA_DIR/orgs/default` → Home lists them, zero console errors.
- **Client:** `rpc(channel, payload?)` typed from `src/api` contracts (type-only import of the `.ts`
  source so Vite never picks up tsc's CommonJS `.js`); results stay `unknown` (contracts carry
  inputs only) and the hooks narrow with commented casts. `web/tsconfig.json` drops
  `noUncheckedIndexedAccess` (not part of `strict`; T0.2's `wire.ts` fails it).
- **Static serving:** hashed assets immutable, `index.html` no-cache, client routes fall back to
  `index.html`, but a miss under `/api/*` or a missing asset is a JSON 404, never HTML.
- **Dependency graph note:** the spec lists T0.6 → T0.2, but the real project list needs T0.3's
  per-org paths; the plan's graph (T0.6 after T0.3) was right and was followed.
- `build.target` is chrome149/edge149/firefox151/safari26 — estimated "latest two" from the
  browsers Playwright 1.62 bundles; T0.8's nightly WebKit/Firefox runs will catch a wrong guess.

## 2026-10-02 — T0.4 Files: upload and download

- **Dependency:** `@fastify/multipart ^10.1.2` (§2), required lazily inside `registerFileRoutes`
  so the desktop never loads it. `MAX_UPLOAD_MB` (default 200) validated in `env.ts`.
- **Tokens:** `randomBytes(32)` base64url (43 chars, one zod `FileToken` shared by contract and
  server), in-memory, single-use, bound to org + user, 1 h expiry, 60 s sweep. One message for
  unknown/forbidden/used/expired so a caller cannot probe existence. Upload lands as
  `orgs/<org>/temp/upload-<hex>` (`wx`, 0600); the client filename is display text only.
  Downloads: `offerDownload(path, name)` → `{ downloadToken }`, single use, deleted after send;
  `Content-Disposition` with an ASCII fallback + RFC 5987 `filename*` (a hostile name cannot inject
  a header). The token in `/api/files/<token>` is masked in the request log.
- **Oversize without buffering:** the file stream is destroyed at the cap (otherwise busboy drains
  the rest of the part — the first attempt read all 200 MB). Then a lingering close: discard what is
  still arriving, half-close, drop after 2 s or 16 MB. `Connection: close` alone lost the 413 to a TCP
  reset 1 run in 3. Measured with a 200 MB generator body and `MAX_UPLOAD_MB=2`: browser-like client
  gets 413 after 5 MB sent; a hostile client ignoring 413 and FIN is cut after 23 MB; RSS +6.8 / +9.4
  MB; declared Content-Length over the cap → 413 before reading.
- **150 MB upload:** 168–329 ms over loopback (~456–895 MB/s, machine at load 43–80); peak RSS
  +18–78 MB over ~140 MB idle — the body is never held.
- **Converted:** `dataset:pickAndParse` takes `{fileToken, sheetName?}` on the server (`write`);
  the desktop dialog path is unchanged and the server never returns its temp path.
- **Open:** tokens are per-process — N pods need sticky sessions until P5 moves them to Postgres
  (`ponytail:`); `/api/files` role check comes with T3.3; xlsx sheet switching re-uploads;
  **security follow-up:** `importStage`'s `stagedId` is a random UUID not bound to an org, so
  `dataset:save` could take another org's staged table given its id — bind it when `dataset:save`
  gets a contract (T2.4) and check in T6.3.

## 2026-10-02 — T0.5 Server-sent events and jobs

- **Design:** `GET /api/events?client=<uuid>` — the tab's own UUID, the same value it sends as
  `X-Ordinate-Client`. A stream is bound at open to org + user; another owner opening that id gets
  403, the same owner reopening replaces it. `clientFor(header, who)` hands an RPC the stream only
  if it is open and bound to the caller. Frames are named events
  (`event: <channel>` + wire-encoded `data:`); heartbeat comment every 20 s.
- **Backpressure:** queue on `write() === false`, cap 256 per stream; a newer `jobs:changed` (the
  tab's whole list) replaces its queued copy; completions are never dropped — if the queue still
  fills, the stream is closed rather than grown.
- **Jobs:** `jobs.ts` tags `job.client` at submit (server only, 5 lines); each tab receives only its
  own jobs' slice, and only when that slice changed (another org's job ticking used to re-send every
  tab's list — caught by the test). `jobs:finished` replaces the desktop OS notification. First
  contract that starts a job: `quality:run` (`write`).
- **Measured** (loopback, 200 events): send → receive median 0.30 ms, p95 1.15 ms, max 3.4 ms.
  1,000 idle streams: ~8.4 KB heap / ~40 KB RSS each; registry back to 0 after close.
- **Push channels:** keep `hub:new-entry` (a capture becoming an entry — upload-based on the
  server). Drop `hub:open-settings` (Settings is a route), `hub:show-permission` (macOS Screen
  Recording; the server never captures), `menu:run` (native menu; the web shell has its own menus
  and palette), `overlay:frame` (the screenshot overlay window is gone).
- **No Last-Event-ID resume** — a reconnecting tab re-reads state over RPC.
- **Open:** `src/ipc/jobs.ts` still imports Electron at load → `jobs:list/cancel/clear` have no
  contracts yet (need org/user ownership filters when added); the job queue's `MAX_RUNNING=3` is
  process-global across orgs (fairness, not a leak — P5 jobs table); an export job's `result.path`
  must become a T0.4 download token before it reaches a tab.

## 2026-10-02 — T5.3 Secrets at rest

- **Design:** envelope encryption, stdlib `crypto` only. One random 32-byte data key per org in
  `secret_data_keys`, AES-256-GCM-wrapped by `ORDINATE_MASTER_KEY` (AAD = org + key id). Each secret
  in `secrets` (PK org_id, kind, ref) is AES-256-GCM under its org's data key, fresh 12-byte IV,
  AAD = org + kind + ref — a row copied to another org or ref fails to decrypt (4 cases tested).
  Master key: 32 bytes as hex or base64(url), parsed to a `KeyObject` (never printed by
  `JSON.stringify`/`inspect`), required in prod with `DATABASE_URL`; `master_kid` = 16-hex
  fingerprint so a pod on the wrong key names both.
- **Rotation:** `npm run secrets:rotate` (OLD/NEW from env) re-wraps data keys only in one
  transaction — payloads byte-identical; idempotent; unknown key aborts with nothing changed.
  Measured 30 ms for 3 data keys. Gap: a pod accepts one master key, so pods not yet rolled cannot
  read secrets between rotate and rollout (`ponytail:` — accept a key list).
- **Measured:** seal 4.6 µs / open 2.5 µs per 30-byte secret; store put 0.41 ms / get 0.21 ms on local
  Postgres.
- **Proof:** a canary written through the store and through the real config setters is absent —
  plain, URL-encoded, hex, base64/base64url at all three alignments — from `pg_dump`, a
  `row_to_json` dump of every table, the trace-level app logger, 6 child processes, every
  `SecretError`, and `publicConfig()`/`publicByok()`. A planted-spelling negative control proves the
  grep finds each form.
- **REQUIRED FOLLOW-UP (not optional):** the store is a seam; nothing on the server routes through it
  yet, so a server today would still write connection passwords and AI keys to the per-org plaintext
  `config.json`. T2.5 must route `src/ipc/connections.ts` `storeSecrets`/`loadSecrets`/
  `connection:delete` (via `src/app/configSecrets.ts`) through it in server mode; T2.12 must route
  `src/app/execConfig.ts` (`setApiKey`/`getApiKey`/`hasKey`/BYOK) and `src/ai/analyze.ts`,
  `src/ai/models.ts` key reads. T6.3's threat model checks both are done.

## 2026-10-02 — T4.1 Async resident layer: charts and paging

- **Chosen transport: the bridge's `queryAsync`/`execAsync`, not `computePool`.** 1M-row Parquet,
  medians of 31 interleaved runs (load avg 33–112 from parallel sessions — ratios matter, not
  absolutes):

  | case | path | latency ms | main thread blocked ms |
  |---|---|---|---|
  | page unsorted (count + 100 rows @500k) | sync | 93 | 93 |
  | | queryAsync | 92 | 9 |
  | | computePool | 65 | 14 |
  | page sorted | sync | 196 | 196 |
  | | queryAsync | 265 | 8 |
  | | computePool | 204 | 19 |
  | chart (cat-key + grouped sum) | sync | 28 | 28 |
  | | queryAsync | 31 | 1.2 |
  | | computePool | 29 | 4.9 |

  Quieter pre-change run: sync page 35 / sorted 80 / chart 19.5 ms. Pool threads cost 133–537 ms
  cold each AND run their own DuckDB, which cannot see the main bridge's views (`datasetView`) or
  registered join/fx relations — decisive against the pool for request paths.
- **Converted:** `residentQuery` (metric/aggregate/cat-key), `datasetPage`, `datasetView`, the
  request-path `parquetStore` write; all IPC callers await. SQL text unchanged (ordinal last in every
  ORDER BY; casts on declared type). `residentFilter.ts` split out (residentQuery 863 → 700 lines);
  `residentSync.ts` keeps sync twins only for T4.2's unconverted consumers.
- **Guard:** `forbidSyncOnMainThread()` in `duckdb.ts` (worker threads exempt). Not yet switched on
  by `src/server/main.ts` — T4.2 wires it once the remaining sync sites are converted.
  `test-serverModeResident` drives the real handlers with the guard on: Object.is-equal to the JS
  reference, `getDataset` never called, trace `resident` never `failed`; sabotaging `datasetPage.js`
  back to sync fails it loudly.
- **Differential suites:** 14 now await; pass counts match the develop baseline; residentQuery
  533 → 859 (sync-vs-async equality added). None weakened.
- **T4.2's input** (sync sites still reachable from IPC): pivotResident, cohortResident,
  funnelResident, facetResident, joinResident (5 queries + `withRelation`), fxResident,
  lodResident, scenarioResident, segmentResident, qualityResident, anomaliesResident,
  insightsAgg.residentAgg, statsResident, medianResident, pipelineDuck (flagged), plus
  `runOrdered` and `residentSync.ts`. Startup probes (`isAvailable`) block once (~115 ms).

## 2026-10-02 — T3.2 Users, orgs, teams, login

- **Dependencies:** `openid-client ^6.8.8`, `@fastify/cookie ^11.1.2` (§2). Migration `0003_auth.sql`:
  orgs, users, teams, team_members, sessions, api_tokens (issuing tokens is T3.4).
- **Modes (`AUTH_MODE`):** `oidc` — authorization code + PKCE, users auto-provisioned as **viewer**,
  optional `ALLOWED_EMAIL_DOMAINS`, `email_verified=false` refused; `header` — `X-Forwarded-Email`
  trusted only when the kernel's TCP peer (`req.socket.remoteAddress`, never `X-Forwarded-For` or
  Fastify `trustProxy`) is in `TRUSTED_PROXY_CIDRS` (a `net.BlockList`, v4/v6/v4-mapped); `dev` —
  refused when `ORDINATE_ENV=prod`. `ORDINATE_ADMIN_EMAIL` is made admin at every sign-in (also the
  recovery path). Single org by default (`ORDINATE_ORG=default`); schema is multi-org.
- **Sessions:** 256-bit random id, only its sha256 stored; cookie `__Host-ordinate_session` in prod
  (`ordinate_session` in dev), httpOnly, SameSite=Lax, Secure in prod. Idle 8 h
  (`SESSION_IDLE_MINUTES`), absolute 7 d (`SESSION_ABSOLUTE_HOURS`), both against the DB's `now()` so
  drifting pod clocks agree; rotated on every sign-in; logout and logout-everywhere delete rows.
  Login state/nonce/PKCE verifier ride a 10-min httpOnly cookie scoped to the callback — any pod can
  finish any login. One UPDATE per request slides the idle window (`ponytail:` throttle if needed).
- **Gate:** `/api/*` needs an identity except `/api/auth/*` (matched by route); `/api/events` and
  `/api/files*` return 401 signed out (tested). Signed-out HTML navigations redirect server-side to
  `/sign-in?next=…` (off-site `next` refused). Logged URLs drop the query string and mask file tokens.
- **Proof:** real-browser e2e against a stdlib mock OIDC provider (`scripts/mockOidc.ts`: discovery,
  JWKS, authorize, token with client-secret + PKCE S256 checks, RS256 id_token) — 21/21: redirect,
  denial error state, sign-in to the shell's kit menu, rotation, sign-out, deep link; zero console
  errors; 17 secret values absent from 142 server log lines. `test-auth` 86, `test-auth-db` 66
  (rotation, planted id, idle/absolute expiry, logout-everywhere, spoofed header from untrusted v4/v6
  peers incl. with a trusted-looking X-Forwarded-For, real-socket 127.0.0.1 vs ::1). Negative
  control (no URL serializer / no rotation / forced peer trust) fails exactly the expected checks.
- **Found on the integrated base:** `test-server-boot`'s prod child inherited `DATABASE_URL`, so
  T5.3's master-key check refused before the sign-in check it asserts — fixed in the test's spawn env
  (`DATABASE_URL: ''`), assertion unchanged.
- **Open:** e2e needs `E2E_CHROMIUM` locally (Playwright 1.62.1 wants Chromium 1234; the cache has
  1243) — T0.8 owns the harness and CI browser install. No userinfo fallback (an id_token without
  email is refused). CSRF tokens are T6.2 (SameSite=Lax + POST-only logout meanwhile).

## 2026-10-02 — T0.8 E2E harness and CI (box NOT ticked: CI blocked)

- **Harness:** `@playwright/test` is not installed (only `playwright`), so specs are `node:test` +
  the `playwright` library, run by Node 24 type stripping; no new dependency. `startServer()` seeds a
  temp `DATA_DIR` (the ordinary `seedSampleProject()`, Electron blocked) and spawns the built server
  in dev. Fixtures: `failOnConsoleError` (console error, pageerror, CSP violation),
  `rpcBudget(n=25)` (per document load or client-side URL change), `screens(name)` (light + dark).
  `E2E_BROWSER` chromium|firefox|webkit; `E2E_CHROMIUM` overrides the binary.
- **Measured:** RPCs per page load — Home 1 (`projects:list`), every other area 0. e2e 4/4 in ~12 s.
  Initial JS 142.7 KB gzip vs the 300 KB budget (`web/scripts/bundle-size.ts`).
- **Negative controls:** budget 0 fails on Home (budget 1 would pass — Home makes exactly one RPC);
  an injected console error, uncaught throw and inline `<style>` are each caught; bundle limit 100 KB
  exits 1; a re-added `require('electron')` in sampleProject fails the seed.
- **sampleProject** no longer imports Electron (CSV resolved from `__dirname` — the same directory
  `app.getAppPath()` named, unpacked or in app.asar).
- **CI:** new `web` job in `ci.yml` (web build, size check, Vitest,
  `npx playwright install --with-deps chromium`, e2e, screenshots as an artifact) and
  `e2e-nightly.yml` (Firefox + WebKit, 07:00 UTC + manual). No branch filter touched.
- **Blocked:** GitHub Actions refuses to start jobs ("recent account payments have failed or your
  spending limit needs to be increased") since 2026-10-03 02:22 UTC, so the Done-when ("the PR shows
  the new job green") cannot be met yet. Firefox/WebKit have never run (not cached locally).

## 2026-10-02 — T3.3 Authorization, sharing, audit

- **Contracts declare scope:** every contract has `project: (input) => id` (sync or async resolver)
  or `org: true` — neither or both fails `tsc`. `scripts/check-contracts.ts`: 8 contracts,
  0 unresolved (asserted in `npm test`, with a negative control). `visible` trims cross-project
  lists fail-closed; `creates` grants the creator admin; `audit: true` audits reads (exports).
  New: `projects:create` (org write), `project:access` (read), `project:share` (project admin).
- **Rules:** org admin = admin on every project of their org; otherwise effective project role =
  max(user grant, every team grant), none if no grant. read ≤ viewer, write ≤ editor,
  admin ≤ admin. The project must exist in the caller's org. Unknown / non-UUID / throwing resolver
  / unscoped contract → 403 before the handler, never 500. `/api/files` POST needs org write;
  `/api/events` and downloads need membership.
- **DECISION PENDING (user):** org-level *write* channels allow org **editors**, not only admins
  (otherwise only an admin could create a project or upload a file). The spec read "org-level
  channels need org admin"; reverting is one line in `orgAllows`.
- **Schema `0006_authz.sql`:** `project_grants` (user XOR team, owner = one admin team per
  project; composite FKs make a cross-org grant impossible in the DB); `audit_log` (actor, action
  rpc|login|logout|logout_everywhere, channel, project, `target_ids uuid[]` harvested only from
  `id`/`…Id` keys, outcome ok|denied|error, request id) on every write/admin RPC and OIDC sign-in/out.
- **Proof:** real-HTTP matrix (viewer/editor/admin/org-admin × read/write/admin × own / other
  project / other org) — every cell equals the expected table, ZERO unexpected allows; spies show a
  denied call never reaches its handler; sabotaging the grant check yields 12 unexpected allows.
  Canary project name absent from every audit row and a full-table dump.
- **Measured:** `authorize()` ≈ 330 µs for a member (project.json read + 1 grant query), ≈ 61 µs
  for an org admin, idle; 20 ms / 1 ms at load average 31. The suite's "< 5 ms" wall-clock assert
  failed under that load, so it now asserts the WORK instead — exactly one query per member
  decision, none for an org admin — and prints the timing.
- **Open:** no owner-team assignment/transfer yet (T3.4); projects created before T3.3 have no
  grants (only org admins see them until shared); header-mode sign-ins are not audited (no event).

## 2026-10-02 — T5.4 Jobs and cross-pod events

- **Schema `0005_jobs.sql`:** `jobs` — one row per (org, kind, target) with `next_run_at`,
  `lease_owner` (`<pod>/<claim uuid>`), `lease_until`, `runs`, last start/finish/error (500 chars);
  `event_payloads` (UNLOGGED) for event bodies too big for a NOTIFY.
- **Claim:** one statement — CTE `SELECT … due AND lease expired AND kind = ANY(known) LIMIT 1 FOR
  UPDATE SKIP LOCKED` feeding the UPDATE that stamps the lease. Heartbeat every lease/3; finish
  reschedules `WHERE lease_owner = <this claim>` (a run whose lease was retaken neither reschedules nor
  counts). Defaults: poll 5 s, lease 60 s; one job at a time per pod. Once per run normally;
  at-least-once on a crash or a loop stalled past the lease (documented).
- **Wiring:** the real `refreshScheduler.tickNow` runs as kind `tick` every 60 s in each org's
  context — dataset refresh, alerts (incl. the anomaly watch), quality checks, pipeline cron, Trash
  purge. `defineJob(kind, …)` is the hook for T5.2's S3 GC. Desktop/no-DB unchanged.
- **Fan-out:** one LISTEN connection per pod (reconnect 1 s); sends batched in publish order with a
  sequence number; > 7,900 bytes go by reference (insert + `pg_notify` in one statement, bodies older
  than 5 min swept). Receivers re-check T0.5's org/user/client binding and refuse line breaks in
  channel names/payloads (SSE frame injection). `clientFor` returns a remote client for a valid tab
  on another pod.
- **Proof (two real server processes, one scratch DB, 69 checks):** 5 due rounds → exactly 5 runs
  split across pods, no duplicates; a real hourly-refresh dataset ticked once per org across pods
  and its event reached every `default` tab on both pods once, the other org's tabs nothing; SIGKILL
  mid-run → the other pod retakes after the lease (2 starts, 1 end, runs=1); 20 concurrent claimers
  → 1 claim (lease removed: 5/5 — negative control); 20 KB payload arrives whole, in order.
- **Measured** (loopback): NOTIFY pod A → tab on pod B median 0.66–0.91 ms, p95 1.8–4 ms (13 / 80 ms
  under the full parallel test load); claim on 1,000 rows 0.19–0.27 ms; SIGKILL → retaken 1.05–1.66 s
  with a 1.5 s lease. Per-NOTIFY queries queued to a 474 ms median under load → batched.
- **Migration numbering:** 0004 was reserved for T5.1, which now takes 0007 — a lower number landing
  after 5 and 6 are applied would run out of order.
- **Open:** `reports:run-due` not wired (no server report generator); server alert delivery is the
  SSE push only; pipeline alert/report/publish nodes still `require('../ipc/alerts')` (Electron) and
  fail as node errors on the server until T2.x; `pipelines:changed` still targets desktop windows;
  org discovery reads `DATA_DIR/orgs` (T3.2's `orgs` table next — `ponytail:`).

## 2026-10-02 — T5.1 Records in Postgres

- **Seam:** `src/app/recordFs.ts`, a drop-in for the `fs.promises` subset the stores use. Desktop or
  no `DATABASE_URL` → the real file; server + Postgres → a *record path* (a `.json` and its `.tmp` /
  `.corrupt` companions under userData `projects/`, `history/`, `templates/`, or `themes.json`)
  becomes a row. Parquet, images, `salt.key` and the search cache stay on the per-org disk. A script
  swapped 185 `fs.promises.<op>` call sites in 32 stores; every record store was already async, so no
  signature changed. Atomic write = `.tmp` staged in memory, rename = one upsert.
- **Schema `0007_records.sql`:** `records(org_id, path COLLATE "C", body text, updated_at)`, PK
  (org_id, path). `body` is the file's exact text (jsonb would reorder keys and refuse `.corrupt`).
  RLS enabled and FORCED (`org_id = current_setting('ordinate.org')`, set per transaction); every
  statement also filters `org_id` from `ctx()`, never from input.
- **Migration order is now enforced:** a new file numbered below the highest applied version refuses
  startup and rolls back (tested). This bit us live: T5.1 first ran as 0004 against the shared dev DB
  and was then renumbered 0007, leaving a stale row and table — the shared `ordinate_test` DB was
  recreated, and the e2e harness no longer hands the caller's `DATABASE_URL` to every spec (T0.8).
- **Tenant isolation, found and fixed:** seven in-memory caches were keyed by record ids alone (answer
  cache, notebook cell keys, fx settings, masking salt, param replay, filter catalog, fx rates) — on a
  server, ids repeat across orgs after an import, so org B could be served org A's cached answers or
  salt. Now keyed via `orgKey()`.
- **Proof:** `test-records` runs one scenario (138 calls across all 28 stores, incl. versions, trash,
  bundle export) on JSON and on Postgres, frozen clock + counted ids — identical results, the final 25
  records byte-identical, no record files left on disk by the Postgres run. Tenant: with A's ids org B
  cannot list/get/rename/update/trash/delete A's records (app filter alone, as superuser); with RLS
  alone a plain role naming org A sees/changes nothing. `npm test` 257/257 with and without a DB.
- **Importer:** `npm run import-desktop -- <userData> [--org id]` — records via `recordFs`, Parquet
  copied, follows sync-folder links, skips `config.json` (secrets) and `.tmp`; idempotent. Round trip
  of the sample project: 13 rows = 13 files, byte-equal; both Parquet files 5,000 rows; RPC listings
  equal the desktop handlers'; another org sees nothing.
- **Measured** (1,000 visuals, local, load ~9): save median 0.26 → 0.44 ms; get 0.05 → 0.11 ms;
  list 1,000 57 → 111 ms (one query per record — `ponytail:` add a `dir` column + batch read);
  `projects.list` over 2,003 rows 0.1 → 1.8 ms.
- **Open:** per-process write queues (alerts.json etc.) do not serialize across pods — `SELECT … FOR
  UPDATE` per record when N > 1; fx cache can go stale across pods (T5.4's bus can invalidate);
  `backups.ts` is desktop-only; store suites still run file-only (Postgres coverage is the
  differential scenario).

## 2026-10-02 — T4.2 Async resident layer: the rest

- **Converted** to the bridge's async calls, awaited up to the handler: pivot, cohort, funnel, facet,
  join (async `withRelationAsync`, UUID key), fx, lod, scenario, segment, quality, anomalies,
  statsResident, median, the insights aggregator, pipelineDuck, pipelinePower. SQL text unchanged.
  Deleted: `residentSync.ts`, sync `runOrdered`/`withRelation`. Sync Parquet helpers moved to
  `parquetStoreSync.ts` (tests/benches/fixtures only; 38 scripts repointed by script).
- **Guard ON:** `src/server/main.ts` calls `forbidSyncOnMainThread()` right after `enterServerMode()`.
  `test-server-boot` passes with it on.
- **Done-when proof — `scripts/test-asyncReach.ts`:** roots = every `src/server/*.ts` and
  `src/ipc/*.ts`; edges = runtime `import`/`export from`/`require()` (lazy too; `import type` and
  `new Worker(file)` are not edges); a sync site = `<duckdb>.query(`/`.exec(`, a renamed named import
  of them, or `runOrdered(`. 106 roots reach 446 modules with **zero** sync sites (still zero with
  T5.1's stores on the chain). Worker-only (allowed sync, asserted unreachable): `computeWorker`,
  `duckdbWorker`, `duckdbSidecarChild`, `parquetStoreSync`.
- **`test-serverModeResident`** (guard on, compute inlined): 29 → 47 checks — pivot, cohort,
  `dataset:stats`, two `stats:run` specs, `dataset:median`, `insights:list` added; each Object.is-equal
  to the JS reference, trace resident never failed, zero `getDataset`. Sync call re-inserted into the
  built pivot/stats modules → fails loudly and hydrates.
- **Measured** (1M rows, medians of 3×11 interleaved, load ~9–10; "blocked" = delay of a 1 ms
  main-thread timer):

  | case | before latency / blocked | after latency / blocked (longest single block) |
  |---|---|---|
  | pivot (2 row dims × quarter, 2 measures, totals) | 124–138 / 123–137 ms | 133–137 / 17–21 ms (6–6.5) |
  | stats (summaries + quality issues) | 82–95 / 81–94 ms | 93–99 / 35–43 ms (9.5–11) |

- **Behaviour change:** `transforms.applyPipeline` (sync, every request) no longer tries
  `runOnDuckDb` first — that path was already off by default (`ORDINATE_DUCKDB_PIPELINE`), so the
  default desktop is unchanged; the flag now has no effect in the shipped app; `runOnDuckDb` stays
  async with its differential tests.
- `test-residentQuery` 859 → 533: the removed 326 were T4.1's sync-twin checks on the deleted
  `residentSync`; every JS-reference differential check is kept.

## 2026-10-03 — Ticking T0.7 and T0.8; CI is unavailable

- GitHub Actions refuses every job ("recent account payments have failed or your spending limit
  needs to be increased") since 2026-10-03 02:22 UTC. The user decided not to fix billing now and to
  merge on the orchestrator's local gate runs instead: build, `npm test` with and without
  `DATABASE_URL`, lint, web build + Vitest, the e2e harness (Chromium 1243 via `E2E_CHROMIUM`), and
  the Electron smokes the change touches — run at every step of each merge chain.
- **T0.7:** the gallery screenshots (both themes + dialog/drawer/select) went to the user for review;
  the user merged #199. **T0.8:** the CI job is defined but has never run on GitHub; it passes
  locally (5/5 incl. the T3.2 auth spec). Its first real run happens when billing is restored —
  re-check then.
- **Merge order is a chain:** each PR's branch contains its predecessors, conflicts already resolved
  with both sides kept; merge in the stated order with merge commits.

## 2026-10-03 — T4.3 Per-org workers, limits, load test

- **Design:** one DuckDB worker per org (`src/engine/duckdbPool.ts`), locked before it reports ready:
  `memory_limit`, `threads`, `temp_directory` inside the org, `allowed_directories` = the org root's
  real path with a trailing `/`, then `enable_external_access=false` and `lock_configuration=true`.
  LRU beyond `DUCKDB_MAX_WORKERS` (8) plus idle eviction (`DUCKDB_IDLE_SECONDS` 300); a worker is
  closed through its own queue, never `terminate()` (aborts the process mid native call). Env:
  `DUCKDB_MEMORY_LIMIT` (80% of cgroup/machine ÷ workers), `DUCKDB_THREADS` (cores),
  `DUCKDB_QUERY_TIMEOUT_SECONDS` (60). Every request carries an abort signal (`ctx().signal`) fired
  when the client hangs up; timeout/abort interrupt the worker's query.
- **Hole closed:** on the server, compute-pool threads ran their own UNLOCKED DuckDB (negative
  control: without the port lease a compute thread reads org B's file). Each compute op now gets a
  port to the caller's org worker.
- **Proof (`test-duckdbPool`, 53):** org A's worker refuses org B's Parquet, a sibling org sharing
  A's id prefix, `..` escapes, `/etc/passwd` via read_text/read_csv/glob, `COPY TO` B, `ATTACH`,
  `LOAD httpfs`, `SET allowed_directories/enable_external_access/memory_limit` — DuckDB's own
  permission/locked errors; an unlocked DuckDB reads them all (control). Timeout at 600 ms then the
  same worker answers in 1 ms; cancel at 152 ms; a queued cancelled call never runs; a client hang-up
  over HTTP interrupts (without the abort the next answer took 17 s). `test-serverModeResident` 47 →
  88: the whole differential section also runs through org `acme`'s locked worker.
- **Load test** (`npm run loadtest`; 20 users × 5 iterations, 1M rows, real HTTP, 600 requests,
  0 failed). Event-loop delay p99 (10 ms sampling resolution included; idle reads ~11): 19.6 ms quiet,
  15.7–19.3 ms at load 9–68; orchestrator re-run on the integrated chain: **p99 22.6 ms at load 20**.
  Per-op p50/p95 (quiet, ms): open 0.7/16 · page 324/673 · sorted page 589/869 · charts ~650–690/~835
  · stats 925/976. One user alone: page 34, charts 33–43, stats 53. Requests of one org serialize on
  its connection — a per-worker connection pool is the upgrade (`ponytail:`).
- **S3 (for T5.2):** before the lock, `LOAD httpfs` + `CREATE SECRET … SCOPE 's3://…/orgs/<org>/'` and
  that prefix in `allowed_directories` — accepted by DuckDB 1.5 in a spike, untested against S3/MinIO.
- **Integration decision (orchestrator):** T4.3 contracted `dataset:meta`, but T1.4 proved its reply
  carries the dataset's origin (file path, a URL that may hold a key, SQL). The contract was dropped;
  the browser uses T1.4's `dataset:columns`, and the load test's "open" step now calls it.

## 2026-10-03 — T1.4 Data grid

- `web/src/ui/DataGrid/`: rows and columns virtualized (`@tanstack/react-virtual ^3.14.13`), blocks of
  500 fetched around the viewport + 200-row margin, ≤ 2 requests in flight, ≤ 20 blocks cached
  (farthest evicted), stale replies dropped; scroll space compressed above 8M px (as legacy
  `dsVirtual`); sticky header, column resize, type badges, keyboard grid (one tab stop,
  `aria-activedescendant`), optional editable cells that only report edits. New `dataset:columns`
  (header only — never the origin); `dataset:page` contract (limit ≤ 5,000, strict filter shape,
  still through `sanitizeFilters`). Thin route `/data/:projectId/:datasetId` for T2.3 to build on.
- **Proof (e2e, 1,000,000-row seeded dataset):** 25 jumps incl. every page boundary and the last row —
  every drawn row's ordinal equals its index, consecutive, no repeats, ≤ 2 RPCs per jump (max 2); a
  continuous 10,000-row scroll across 20 boundaries sees exactly 10,000 consecutive rows in 20 RPCs.
  Negative control: a source shifted by one row fails.
- **Measured:** first rows 136–257 ms; 20 RPCs per 10k rows; fast scroll p95 frame 17–18 ms (vsync
  bound); 153 cells in the DOM; heap 10 MB; DatasetPage chunk 12.5 KB gzip. Compression only proven
  in Chromium (Firefox clamps at ~17.9M px — nightly will tell).

## 2026-10-03 — T3.4 Admin UI and API tokens

- `web/src/features/admin/`: people (invite = pending user row, disable, role), teams + members,
  project ownership transfer (old owner team keeps an ordinary admin grant), audit log viewer
  (actor/action/channel/project/date/outcome filters, keyset paging), org settings (public links —
  off by default, allowed AI providers — stored, enforced by T2.12, per-org upload cap ≤
  `MAX_UPLOAD_MB`, enforced by `/api/files`). Migration `0008_admin.sql`. 13 admin channels.
- **API tokens:** `ord_` + 43 base64url chars, shown once; stored as sha256 + 12-char prefix; Bearer on
  the RPC API and `/api/mcp`, runs as the user with their CURRENT role; disabled user or revoked
  token → 401; a token cannot mint a token. Redaction gained `apiToken`, `accessToken`, `api_token`,
  `bearer` (negative control: dropping `apiToken` fails the leak check).
- **MCP at `/api/mcp`:** bearer only, Origin check (foreign/`null` → 403), 1 MB body cap, JSON-RPC
  errors kept; tools trimmed to projects the caller can read; writes need editor and are audited.
  Electron-only automation (report capture, alerts, report runner) now loads lazily; `export_dashboard`
  and `run_report` are not offered on the server. Desktop loopback transport unchanged.
- **Proof:** `test-admin-db` 54 (viewer/editor 403 on all 13 channels, admin 200, other org's admin
  changes nothing; ok/denied audit rows; canary email in no row); `test-tokens-db` 43; e2e admin flow
  in header mode on a scratch DB. Admin list reads audit only refusals (`audit: 'denials'`) so browsing
  the log does not write to it.
- **Measured** (load ~51): `projects:list` 1.23 ms header / 1.55 ms bearer (one UPDATE stamps
  last_used); MCP initialize 1.18 ms; audit first page on 20k rows 15.7 ms, deep keyset page 2.5 ms.
- **Process note:** the auto-mode classifier refused `git reset --hard` in the agent's fresh worktree;
  it used `git switch -c` on the clean tree instead (non-destructive, same start point). The T1.2 agent
  hit the same refusal and stopped — surfaced to the user.

## 2026-10-03 — T1.1 Chart engine

- `web/src/charts/`: the legacy builders ported as pure modules (`build.ts` returns the config instead
  of constructing Chart.js), plus `<Chart>` (create on mount, `update()` in place for same-type
  changes, new instance for a new type, ResizeObserver, theme-token colours, rebuild on
  `data-theme` change) and a `DataTable` for the `table` id. Chart.js core (69.7 KB gzip) and each
  family plugin load on first use — initial JS stays 148.8 KB gzip on the integrated chain.
- **Differential test (Vitest, 137):** the emitted legacy scripts run in a `vm` with a recording
  `new Chart()`, minimal DOM, the real `format.js` and English `t()`; data = the sample CSV through the
  server's own `parseFile` + `buildVizData`. 39 ids × 3 override sets + 7 ids × 2 with overlays,
  pins and events — functions compared by presence/name, everything else Object.is. Negative
  control: two tweaks fail 48 cases.
- **`/dev/charts`:** all 39 from the API (`visual:data` contract — read, project scope; T1.1's strict
  encoding merged with T4.3's filter steps/params/analytics on integration), every canvas non-blank
  (min 5,825 drawn pixels), zero console/CSP errors, both themes. 25 RPCs per load = the budget
  exactly (23 distinct encodings) — a batch endpoint before more encodings land.
- **Deliberate divergence:** the desktop's candlestick never draws a candle (text `x` with
  `parsing:false`); the port uses the label index. Pinned in the differential test; the desktop fix
  (`renderer/hub/chartDatasets.ts` + regenerating `test-chartSpec` golden hashes) is its own task.
- PNG helper composites on the theme surface (`#fff` / `#1c1c20`); off-screen 2× render like the
  desktop capture.

## 2026-10-03 — T1.3 Maps

- `web/src/charts/maps/`: the 13 legacy files ported as pure modules (`geoMatch`, `geoCluster`,
  `mapKinds`, `geometry`, `colors`, `features`, `thumb`, `radius`) + `MapView` (all kinds, period,
  Values menu, legends; empty / skeleton / no-WebGL / data-instead / error states; theme redraw),
  `MapThumb`, `RadiusEditor`. MapLibre **4.7.1 pinned** (exact), dynamic import, the `-csp` build with
  its worker emitted as a same-origin asset (`setWorkerUrl`) — no blob:/eval. No glyphs, no sprite;
  value labels and cluster counts are DOM markers. Upgrading to v5/v6 is now feasible (Vite bundles
  ESM) — a separate decision: re-check the CSP worker and `canvasContextAttributes`.
- **GeoJSON:** `GET /api/geo/index.json` → `GET /api/geo/<level>.<sha256-16>.json` (immutable 1 y,
  gzip), served by exact name from a 3-level whitelist — no request path reaches the filesystem;
  same for every org, sign-in required (`test-geoRoutes`: 10 traversal attempts 404).
- **CSP:** only the three OSM tile hosts added to `img-src`/`connect-src`. Negative control: without
  them the maps spec fails with 1,437 problems (479 CSP events).
- **Proof:** `/dev/maps` draws region, bubble, offline-basemap region (sample retail data), points,
  hexbin, flow (a seeded deterministic "Shipments" dataset — the sample has no coordinates); WebGL
  canvases verified by sampled colours, 144 flow routes, 6 cluster markers, radius "Chicago" 50 km →
  75 points; no request leaves the server + OSM hosts. Differential Vitest vs the legacy draw code on
  real server replies (sources, markers, camera fit, both themes) — sabotage fails it. Headless WebGL2
  via SwiftShader (`--enable-unsafe-swiftshader` in the shared e2e launch).
- **Measured:** 8 RPCs per `/dev/maps`; MapLibre CSP bundle 187 KB gzip + 352 KB worker, all lazy —
  initial JS unchanged.
- **Integration (orchestrator):** T1.1 and T1.3 both contracted `visual:data`. One contract now: the
  charts' loose encoding (`sanitizeEncoding` whitelists every shelf) + the maps' strict `geo` block
  (unknown level → 400 naming the path, never the value) + a bounded `radius` on filter steps. The maps
  test that asserted "refuses a pivot shelf" now asserts the shared channel accepts it.
- **Desktop bug carried and pinned:** `geoMatch`'s substring rule gives West Virginia Virginia's value
  (26 labels for 25 states in the sample) — fix both copies as its own task. Point colours use the
  default palette until the project colour map has a web channel (T2.7).

## 2026-10-03 — T6.2 Web hardening

- **Dependency:** `@fastify/rate-limit ^11.2.0` (§2).
- **CSRF (`src/server/csrf.ts`)** on every non-GET, before sign-in (a refusal costs no DB query):
  (1) Origin — cross-site `Origin`, `Origin: null`, or `Sec-Fetch-Site: cross-site` without an
  Origin → 403 `origin`; (2) double-submit — cookie `ordinate_csrf` (`__Host-` + Secure in prod,
  script-readable, SameSite=Lax) must equal `X-CSRF-Token` (timing-safe) → else 403 `csrf`. The
  cookie is issued on page/API responses lacking it, never on static assets. Exempt: `Authorization:
  Bearer` only where a token actually decides identity (Postgres configured), and `/api/mcp` (refuses
  cookies itself). The Origin check compares with Host — the ingress must preserve Host (nginx,
  ALB, GKE do by default).
- **Headers (`src/server/headers.ts`)** on every response, incl. SSE: CSP by PATH — `APP_CSP`
  outside `/api/` (+ `frame-ancestors 'none'`), deny-all `API_CSP` under it (by content-type broke
  e2e: a 304 for index.html has none and the browser merges it into the cached page); the Vite meta
  CSP is gone, the header is the single source. X-Frame-Options DENY, nosniff, Referrer-Policy
  `strict-origin-when-cross-origin` (OSM's tile policy wants a Referer; paths never leave the
  origin), Permissions-Policy, COOP same-origin, HSTS in prod.
- **Integration with T1.3 (orchestrator):** the OSM tile hosts moved from the old build-time CSP into
  `MAP_TILE_ORIGINS`; the test now pins exactly those three hosts, only in img-src/connect-src, and no
  other external host anywhere. The maps e2e passes with the header CSP (zero violations).
- **Limits (`src/server/limits.ts`):** login+callback 60/min per client IP; RPC 3000/min per IP and
  1200/min per user (org + email); 429 + Retry-After; client IP from X-Forwarded-For only when the TCP
  peer is in `TRUSTED_PROXY_CIDRS`. Per-pod counters (`ponytail:` — N pods allow N× the limit; a
  shared store when it matters). JSON body cap `MAX_RPC_BODY_KB` 1024 (separate from uploads);
  `RPC_TIMEOUT_SECONDS` 60 → 504 and the request's abort signal interrupts DuckDB (measured: 504 in
  1013 ms with a 1 s limit; the org worker answered `SELECT 1` 2 ms later).
- **Proof:** `test-webHardening` 166 (every route class's headers incl. 304/404/403/413/429, prod
  HSTS + `__Host-` cookie; CSRF matrix on rpc/files/logout/logout-everywhere/page DELETE; rate limits
  incl. XFF spoof rotation; body cap; timeout). Negative control: disabling the CSRF match, the SSE
  header copy and the timeout race fails 31 checks. Session fixation: a planted LIVE attacker session
  is ended when the victim signs in over it (`test-auth-db`). Logout-everywhere: e2e signs a second
  browser context out from the account menu. 14 existing suites + the load test send the CSRF pair
  (`scripts/csrfPair.ts`); bearer-token suites deliberately do not (proves the exemption).
- **Note for the load test:** 600 requests as one dev user exceed 1200/min only if finished in < 30 s
  — raise `RATE_LIMIT_RPC_PER_MINUTE` for it. `/api/mcp` has no rate limit yet.
- Observed under load (8 agents, load avg > 30): `test-auth-db` failed once in a full DB run and passed
  twice alone — watch for a recurrence.

## 2026-10-03 — T5.2 Parquet on S3

- **Config:** `STORAGE_URL` unset | `file:///dir` (= DATA_DIR) | `s3://bucket/prefix` (needs
  `DATABASE_URL`); `S3_ENDPOINT` (MinIO, path style), `S3_REGION`, `STORAGE_CACHE_MB` (2048; 0 = off),
  `STORAGE_GC_GRACE_MINUTES` (60), `DUCKDB_EXTENSION_DIR`. File mode and the desktop are unchanged.
- **Write = new versioned key, then the pointer switches:** `persistNow` registers the keys in
  `storage_objects` (`0009_storage.sql`, RLS forced), the org worker COPYs straight to
  `s3://…/orgs/<org>/<project>/<id>.<version>[.source].parquet`, then the record row (Postgres since
  T5.1) is upserted with `storageVersion` — that upsert is the atomic switch. Reads resolve the pointer
  each call: the pod's cached copy if present, else the `s3://` URL via httpfs while the exact bytes
  download in the background (byte-capped LRU across orgs, re-adopted on restart).
- **Isolation:** each org worker loads httpfs + aws (never installed at runtime), creates one
  `credential_chain` secret (`REFRESH auto`) scoped to the org's prefix, and adds that prefix to
  `allowed_directories` — all before the lock. Node-side S3 (GET/DELETE/create-bucket) is ~40 lines of
  SigV4, credentials from the same chain; no AWS SDK, no static keys in config.
- **GC (`storage:gc`, every 15 min per org):** a version no record body mentions (live, trashed or
  versioned) is stamped `unreferenced_since`; deleted once unreferenced longer than the grace.
- **Proof (MinIO):** `test-serverModeResident` 88 → 177 — two S3 passes (cache off: every read via
  httpfs in the org worker; cache on), all Object.is-equal to the JS reference, no local Parquet
  written. `test-storageS3` 40: org `evil` cannot read `acme`'s object, a `..` key, a sibling prefix
  `orgs/acmex/`, or acme's cached copy (DuckDB's own Permission Errors). Atomic switch: readers looping
  through six writes always see exactly one version (pointer-before-upload sabotage → "Dataset not
  found"). GC deletes exactly the superseded versions past the grace; current/trashed/in-flight
  survive. `test-jobs-pods` 69/69 with S3 (the spawned pods need `DUCKDB_EXTENSION_DIR` exported —
  note for operators/CI).
- **Measured** (MinIO on loopback, 1M rows, 8.5 MiB table, load 36–45): page median disk 37.4 / S3
  httpfs 41.9 / S3 cached 35.4 ms; chart 33.7 / 37.0 / 31.1 ms; cold first page 98 / 95 / 93 ms
  (heavier load: httpfs cold 4.6 s vs cached 0.8 s — the cache earns its keep on cold reads and other
  pods). Save 1M rows ~equal on disk and S3. Hot table cache hit rate 90% (1 miss, 9 hits).
- **Open:** snapshots are off in S3 mode (keep the old pointer instead of copying a file); bundle
  export/import-desktop/pointer-less desktop records still use local files until their next write
  (migration command = follow-up); IRSA `REFRESH auto` and real AWS untested; a locked worker still
  accepts `CREATE SECRET` (unreachable from user SQL via `sqlGate` — threat-model item for T6.3);
  operators should set an `AbortIncompleteMultipartUpload` lifecycle rule; CI's `minio/minio:latest`
  image may be unmaintained — re-check when CI returns.
- **Found (T4.3 code, logged for a fix):** under heavy load `test-duckdbPool`'s LRU/idle section fails
  ("DuckDB worker stopped") — the idle sweep can close a worker still starting while a call waits on
  `ready`. Reproduced on the T4.3 base alone; fix as its own change.

## 2026-10-03 — T2.5 Connections

- **Secrets (T5.3 follow-up, DONE for connections):** on the server `connection:testAndSave`,
  `connection:replaceSecret` and `connection:delete` route through the encrypted store
  (org from `ctx()`, kind `connection.password|token`, connection id) via `src/app/configSecrets.ts`,
  never `config.json`. No DB or master key → refused before a socket opens ("This server cannot store
  passwords or tokens…"); a failed store after the record write removes the record again. Replies carry
  only `secretSet` flags; Replace tests the new value before keeping it. Canary passwords: absent from
  every DATA_DIR file, `row_to_json` dumps, `pg_dump`, the trace log, process output, every RPC reply,
  the DOM; the connector is proven to receive the stored value (`test-connections-server` 46).
- **Bug found and fixed:** `connection:delete` treated a missing file as success and secrets were keyed
  by connection id alone — an editor of project A could delete project B's stored credential. The
  handler now checks the connection belongs to the project first.
- **Server mode hides local-file sources** (`capabilities().localFiles === false`): `duckdb-file`,
  `parquet-folder`, `csv-folder` are hidden and a desktop-imported record with one is refused; URL
  stays; 38 sources on the server.
- **T6.1 hook points:** every socket a connection opens goes through `src/connectors/connectionRun.ts`'s
  four dispatches — `def.listTables` (~l.219), `def.run` in `fetchRows` (~282), `def.describeTable`
  (~341), `def.run` in `explainSql` (~413) — plus `datasetRefresh.ts`'s `runConnection('url', …)`.
- **Contracts:** 15 channels; viewers can see cards but every channel that uses a stored credential
  against the source is `write`. Read-only + server-side row bounds unchanged (a DELETE refused; a
  1,000,001 limit is a 400). `connections:list` returns a server-counted `datasetCount`.
- **Measured:** 4 RPCs on the list, 7 opening a table in the workbench, ≤ 16 in a whole session;
  WorkbenchPage 9.0 KB / ConnectionsPage 3.4 KB gzip, lazy.
- Changed: identifiers inserted qualified part by part (`"sales"."orders"` — the desktop quoted the
  whole name as one identifier, wrong for Postgres); confirm/prompt → Dialogs; Save as dataset saves on
  the server. Connector logos still live in `renderer/hub/assets/connectors` — T8.1 must move them.

## 2026-10-03 — T2.12 AI dock, ask, plans

- **Secrets (T5.3 follow-up, DONE for AI keys):** in server mode `execConfig` `setApiKey`/`getApiKey`/
  `hasKey`/BYOK route to the encrypted store, one row per org + provider (`src/server/aiKeys.ts`);
  `config.json` keeps a `keyStored` flag only; `publicConfig()`/`publicByok()` report has-key flags; no
  DB or master key → saving a key is refused with the reason. `analyze.ts`/`models.ts` read keys through
  `byokCredentials`. Provider calls go through `src/ai/providerFetch.ts` (Electron `net.fetch` on the
  desktop, Node `fetch` on the server). Canary key: received by the stub provider, absent from every
  file, all 15 tables, the trace log, process output, every RPC reply and SSE frame
  (`test-dockServer` 43; config.json sabotage fails it).
- **API-key providers only on the server:** `src/cli` loads lazily from desktop branches; execution mode
  forced to `byok`; `cli:*`/`exec:setMode` uncontracted (404). `test-server-boot` now fails if any module
  resolves into `src/cli` (with a control). Org "allowed AI providers" (T3.4) enforced: not-ready status,
  `dispatch` refuses without calling the provider, save/test/activate refuse.
- **Scoping fixes found:** conversations were per project (every member saw every thread) — per member on
  the server now; a `capture` context could read another project's capture by id — restricted to the
  asked project.
- **Web:** dock (⌘L/⌘J, Splitter-resized, route-derived context), streaming over SSE to the asking tab
  only (a second tab of the same user gets nothing), activity chips, answer cards (all figures from the
  server), plan card (run all, step, edit, fix, skip, stop, undo; import step via upload), connect-a-
  provider form (write-only key). 18 contracts; asking is `read`, running a plan `write`, provider
  settings org `admin`.
- **Open:** a gateway provider's `baseUrl` is not SSRF-guarded (T6.1 `safeFetch`); plan runs live in one
  pod's memory (sticky sessions; `ponytail:`); proposal cards needing other screens (T2.6–T2.9, T2.13)
  deferred — the server already returns the suggested action.

## 2026-10-04 — T2.1 Home and app chrome

- **Home:** greeting with server counts (`home:overview`), Get-started card (`onboarding:status/set`),
  Starred and Recent (filter, scope, Show all), Your data / Saved visuals column. The ask bar hands its
  question to the real dock (`features/assistant/dockState.ts` `openDockWith` / `takePendingQuestion`):
  asked at once when the dock is ready, otherwise left in its composer with focus inside the dock.
- **Chrome:** top bar = Jobs button + divider + Assistant toggle + account menu (Help links). Jobs popover
  over `/api/events`; ONE EventSource client (`web/src/api/events.ts`, backoff reconnect, `onReconnect`;
  `onServerEvent`/`connectEvents` aliases for the dock). The T2.1 placeholder dock is deleted.
- **Server:** stars are per user (`starredBy`); jobs carry their owner and a tab lists/cancels/clears only
  its user's jobs, never seeing a result path (`jobs.publicJob`, also on SSE pushes); `visual:dataBatch`
  answers a page of charts in one call (kept `/dev/charts` inside its 25-RPC budget).
- **Measured:** initial JS 161 KB gzip; `test-home` 39; Home = 2 RPCs per load.

## 2026-10-04 — T2.2 Projects, trash, versions

- **Convention for every later screen:** call `useCurrentProject()` (`web/src/features/projects/current.tsx`):
  `?project=` → this browser's last choice → most recently opened readable project. A page whose URL
  names a project calls `useAdoptProject(id)` so the switcher agrees. Record screens use `trashToast.ts`
  ("Moved to Trash · Undo") and link History to `/versions/:projectId/:type/:id`.
- **Switcher:** rename, share (grants: person/team, role), export (download token), archive/restore,
  delete (type the name), new, import (upload token; importer becomes admin). Actions shown by role.
- **Access:** read `projects:overview/open/export(audited)/roles`, `trash:list`, `versions:list/get`;
  write `projects:rename/import`, `trash:restore`, `versions:restore`; admin `projects:archive/delete`,
  `trash:purge/empty`, `project:shareTargets`. Purge was anyone on the desktop — now project admin.
  `test-projects-server` role matrix (4 roles × 13 channels), denied calls never reach a handler.
- **Server:** deleting a project drops its grants; desktop safety backup skipped; duplicate Trash-purge
  hook removed from `jobs/schedules.ts`.
- **Open:** `projects:open` stamps a shared (not per-user) "last opened"; sync-folder features dropped;
  version previews of dashboards/visuals are facts + layout sketch until T2.7/T2.9.
- **Chain gates (T2.1+T2.2 on develop):** `npm test` 269/269 with and without DB; Vitest 372/372;
  e2e 17 + 2 skip (no DB), 21/21 (DB; one connections timeout once in a full run, passed alone and on
  rerun); lint 0; 91 contracts, 0 unresolved; file sizes pass.

## 2026-10-04 — T2.4 Import, composer, captures, input tables

- **Screens:** import (upload → staged → composer), the composer (joins, preview, save through the
  ordinary `composeSave`), captures (list tab + page; a capture becomes a dataset through
  `captureDataset:draft` → composer with editable preview cells), input tables. Uses
  `useCurrentProject()`; one upload helper (`upload()` in `web/src/api/client.ts`, 413 worded with the cap).
- **AI reconciled with T2.12:** one fetch seam (`providerFetch`), one key source (`byokCredentials`, the
  org's secrets store), one allow-list check (`execConfig.providerAllowed` inside `resolveByok`, used by
  every model call incl. captures). `test-importServer`: allow-list `['openai']` with a gateway connected →
  `not_allowed`, draft refused, mock model 0 calls.
- **Security:** staged imports bound to org + user; a capture summary carries `hasImage`, never its crop
  path, on the server — stripped in `datasetSummary.summarize` itself so recent/search/catalog and every
  other `listDatasets` caller get it (negative control: 2 checks fail without it).
- **Measured:** RPCs per load — composer 19, screenshot→composer 12, Captures tab 4–6; initial JS
  167 KB gzip; 104 contracts, 0 unresolved.
- **Chain gates (on develop f0a0637):** `npm test` 270/270 without DB, with DB 268 + 2 passing alone
  (connections-server, secrets — shared-DB contention); Vitest 379/379; e2e 27/27 (DB), 23 + 2 skip (no DB);
  lint 0; file sizes pass. Agent: Electron import/composer/capture/dock smokes pass.
- **Open:** desktop-only `src/ipc/providers.ts` still calls `net.fetch` (not on the server path).

## 2026-10-04 — T6.1 SSRF guard

- **`src/connectors/ssrf.ts`:** `checkHost` canonicalizes with the WHATWG URL parser (decimal/octal/hex
  IPv4 mean the same on every OS), refuses non-bare hosts, resolves with `lookup({all:true})` and refuses if
  ANY answer is refused; `pinnedLookup` connects to exactly the checked address; `safeFetch` = http(s)
  only, no URL credentials, check + pin, `agent:false`, ≤5 redirects each re-checked, credential headers
  dropped cross-origin. Refused: loopback, link-local (incl. metadata), unspecified, RFC 1918, CGNAT,
  ULA/site-local, IPv4-in-IPv6 forms, reserved/documentation, multicast/broadcast. IPv4 and IPv6 lists
  kept separate (a shared `BlockList` matches IPv4 against `::/96` and refused every public address).
- **Wired:** `connectionRun.ts` four dispatches (pg host = pin, TLS servername = typed name; mysql2
  `stream`; tedious `connector`; Oracle Easy Connect pinned, ADB connect strings checked not pinned),
  `http.ts` (7 engines incl. Trino nextUri), `url.ts` (+ `datasetRefresh`), `saasHttp.ts`, the AI
  gateway `baseUrl` via `providerFetch`. Server mode only; the desktop still reaches localhost.
- **Allowlist:** `SSRF_ALLOW` CIDR list, validated at boot (per server, not per org — moving it to
  `org_settings` is a one-column follow-up).
- **Done-when:** `test-ssrf` — 49/49 hostile URLs refused before any socket (target 30+), 20 raw DB-host
  spellings, redirects to metadata/loopback/private/file/gopher, DNS rebinding on a hop, redirect cap,
  cross-origin credential drop; 0 DB sockets opened; allowlisted loopback works for 4 drivers + HTTP with
  exactly 1 lookup (pinned). Negative controls: no guard 97 FAIL, no pin 2, first-hop-only 7, DB pin 4.
- **Measured:** `checkHost` on an IP 7.3 µs; refusing `localhost` 0.074 ms; `safeFetch` 0.215 ms vs
  `fetch` 0.130 ms on loopback (new socket per request so checked == connected).
- **Integration:** T2.4's import suite and captures e2e use a loopback stub model → `SSRF_ALLOW` set
  there, like dock/connections. Chain gates (on develop 9893149): `npm test` 271/271 with and without DB;
  Vitest 379/379; e2e 27/27 (DB), 23 + 2 skip; lint 0.
- **For T6.3:** an allowlist entry also allows its IPv4-mapped IPv6 form; `SSRF_ALLOW=0.0.0.0/0` turns the
  guard off; SQL Server named-instance UDP 1434 lookup is unpinned (`ponytail:`); no Content-Encoding
  decoding in `safeFetch` (never sends Accept-Encoding).

## 2026-10-04 — T2.3 Data: list, dataset page, catalog

- **Screens:** `/data` → current project; `/data/:projectId` tabs Datasets / Captures (T2.4's
  `useCaptures`) / Catalog / Relationships + search inside the data; `/data/:projectId/:datasetId` tabs
  Data / Quality / Columns. Delete → `toastMovedToTrash` with Undo; "Pipeline history" → `/versions`.
- **DataGrid (merged with T2.4's):** one header-activation API (`onHeaderActivate(col, anchor)` → a
  `ColumnMenu` popover: profile, sort, rename, type, hide); `header(column, i)` content slot; hidden
  columns via `GridColumn.at` with `sourceCol`/`cellOf` so `cellFlag`/`editorList`/`onEdit` never shift.
- **No origin reaches the browser:** new `dataset:source` → `{kind, label, refreshable}`;
  `dataset:columns/update/refresh` reply name/rows/columns only; refresh errors cut URLs to host and paths
  to file name (server); `lineage:get` re-keys file/URL nodes. `test-dataViews` (83): a canary planted in
  4 origins + a refresh error is absent from all 44 Data replies over HTTP; negative control 3 FAIL.
- **Server computes every figure:** `dataset:profile` (one column's whole panel, == JS reference for all 4
  types, never hydrates, traced resident); filled %, `matchPct`, `ratePct`, catalog kind counts, upstream
  count. Histogram now 20 buckets in axis order with empty buckets at 0 (the desktop drew them scrambled).
- **Contracts:** catalog, lineage, relationship, quality, dataSearch (`projectId` required — the desktop's
  empty value searched every project), dataset delete/refresh/source/profile; `dataset:distinct` is T2.4's.
- **Measured:** dataset page ≈ 9 RPCs; initial JS 167 KB gzip; 125 contracts, 0 unresolved.
- **Chain gates (on T6.1):** `npm test` 272/272 with and without DB; Vitest 386/386; e2e 29/29 (DB),
  25 + 2 skip; lint 0; file sizes pass. Agent: Electron dataset/depth/composer/workspace smokes pass.
- **Open:** rename/retype index against stored columns (same as desktop `updateDataset`) — can hit the
  wrong column on a dataset with prepare steps; T2.6 should fix both. Connector logos in the Source
  column dropped (crop thumbnails stay out: summaries carry `hasImage` only).

## 2026-10-04 — T2.7 Visuals builder

- **Part 1:** gallery (thumbs through T2.1's `visual:dataBatch`), new-visual flow, builder, encoding form;
  chart-type eligibility checked against `renderResult.js` + `mapKinds.js` (`eligibility.test.ts`).
  Pivot/cohort/funnel show a designed "not yet available" state until T1.2.
- **Part 2:** format (axes, legend, labels, sort incl. custom order, series/value palettes, colour by
  category, project colour map), filters (values paged 200 from the server, conditions, ranges, relative
  periods via `period:picker`), analytics overlays (readouts are the server's text), small multiples,
  drill (rows drawer + audited CSV download). `web/src/charts/fmtApply.ts` is differential-tested
  against the desktop's `fmtApply.js` + `fmtColors.js` (58 tests; a broken port fails 14).
- **Server:** `src/ipc/visualsServer.ts` (`visual:rows`, `visual:rowsDownload`, `period:picker`);
  `../ipc/format` (`format:colors:*`) registered on the server once. `test-visualsServer` 65 incl. 403s
  per role. One `dataset:distinct` (T2.4's).
- **Changed:** a new target overlay starts at the server's max (not a browser-rounded value); period
  filters kept on save (desktop dropped them); facet PNG copy disabled; facet interior-tick muting dropped.
- **Measured:** RPCs gallery 5–7, saved builder 12–17, new builder 15; initial JS 167 KB gzip, builder
  chunk 25 KB; 145 contracts, 0 unresolved.
- **Chain gates (on develop 40abbdc + T2.3):** `npm test` 273/273 with and without DB; Vitest 468/468;
  e2e 33/33 (DB), 29 + 2 skip; lint 0; file sizes pass. Agent: `smoke-viz-builder`/`-thumbs` pass.

## 2026-10-04 — T2.6 Prepare and pipelines

- **Prepare** at `/data/:projectId/:datasetId/prepare` (a "Prepare" button on the dataset page): step
  rail on a splitter beside the prepared rows; all 25 step types; `?add=<type>&column=<name>` opens a
  prefilled editor (T2.3's profile links to it). Formula editor validates through the server parser
  (server-coloured tokens, "did you mean", 8-row preview equal to the engine with `Object.is`) — no
  client-side evaluation. **Pipelines** at `/pipelines` (nav), DAG, cron editor, run history, live over SSE.
- **Server:** step-edit replies carry no rows, source or origin (`src/ipc/stepReply.ts`); every printed
  figure is the server's (keyword shares, text-profile bars, spatial match %, parse-dates "of N",
  pipeline summaries, run tallies). Origin leak fixed: `pipelines:get` node ids held a file path or a URL
  with its key → masked `source:url:#<hash>`, mapped back for run/pause (`src/app/pipelineIds.ts`).
  `pipelines:changed` per org over SSE; live-run map per org.
- **Column fix (T2.3's open item):** rename/retype resolves by name against the shown columns
  (`src/data/columnEdit.ts`): a source column edits the source by name, or becomes a `rename_column` step
  when a step reads it; a step-made column gets a `rename_column` step; retyping one is refused.
  `test-columnEdit` 15 (negative control: the old by-position rule hits the wrong column).
- **Measured:** RPCs Prepare 13–16, Pipelines 9–11; chunks 22.3 / 8.0 KB gzip; 169 contracts, 0 unresolved.
- **Chain gates (on T2.7):** `npm test` 275/275 with and without DB; Vitest 486/486; e2e 35/35 (DB; one
  connections timeout in the first run, see the flake investigation), 31 + 2 skip; lint 0.
- **Open:** `pipelines:run` waits for the whole run in one RPC (> 60 s → 504) — should become a job;
  report/alert/publish nodes still fail on the server (T5.4 gap); desktop `smoke-round6` word-cloud label
  check fails (outside this diff; being fixed separately).

## 2026-10-04 — T2.10 Analytics workbenches A — stats, drivers, scenarios, segments

- **Routes:** `/analytics` (doors + dataset picker), `/analytics/:projectId/:datasetId/{stats,drivers,
  segments}`, `/analytics/scenarios/:projectId[/compare|/:scenarioId]`; nav "Analytics".
- **Figures moved to the server** (the desktop renderer computed them): `stats:run` `figures`
  (group totals, cross-tab shares, residual/QQ reference spans — `src/analysis/stats/figures.ts`),
  `stats:pair` fit-line end points, drivers waterfall running levels, `scenario:compare` `best`,
  `segments:fit` `shares`. `test-analyticsServer`: every derived figure `Object.is` the desktop's
  arithmetic; role matrix wrong=0, leaks=0.
- **Server-only channels** `stats:addToDashboard` (server merges the card), `stats:dashboards`,
  `scenario:metrics` — instead of contracting `analysis:*`/`metric:list`, which T2.8 owns.
- **Measured:** RPCs /analytics 4, stats flow 7, drivers 8, segments 8, scenarios 2–6; chunks 4–10.5 KB gzip.
- **Chain gates (on T2.6):** `npm test` 276/276 without DB, with DB 275 + `test-projects-server` passing
  alone (shared-DB contention); Vitest 491/491; e2e 40/40 (DB), 36 + 2 skip; lint 0; 191 contracts.
- **Open:** dock context for analytics routes not wired (needs `dockState.ts` route match);
  `drivers:explainAlert`/`scenario:card` uncontracted until T2.9; three analytics CSS modules ~600 lines.

## 2026-10-04 — T2.14 Settings, themes, privacy, command palette

- **My settings** `/settings` (You: account, theme, shortcuts; Privacy: the project's share policy) and
  **Organization** tabs in Admin (Workspace: formats, calendar with the server's "Today is…" preview,
  branding, Assistant rules, refresh/alert switches; Themes editor; Backups). Formats/accent write through
  `formats:set`/`branding:set` and refresh the `prefs:get` cache. One shared theme preference (`theme.ts`).
- **Backups:** admin download (zip of every project bundle + `backup.json`) and restore over T0.4 tokens;
  restore needs `confirm: 'restore'` (400 without), refuses a tampered/partial/junk file whole, restores
  each project as a NEW project "… (restored <date>)" — nothing is overwritten. Audited incl. refused
  attempts. Role matrix 19 channels, denied calls never reach a handler.
- **Command palette** ⌘K / Ctrl+K and the top-bar Search box: one registry (`useCommands` per page,
  duplicate ids refused), fuzzy + recency, `>` commands, `/` records (`recent:list`, `search:query`, current
  project), `?` shortcuts sheet. **About** `/about`: version, links, 386 bundled packages' licences from a
  build-time `licenses.json` (Vite plugin, no dependency; 62 KB gzip, fetched only on About).
- **Registered once, unguarded:** `settingsServer`, `themes`, `privacy`, `search`, `periods`.
- **Measured:** RPCs /settings 3, Admin ≤ 6, About ≤ 5; initial JS 177 KB gzip (was 168: palette + settings
  shell); theme model differential test vs the server's over 410 cases.
- **Chain gates (on T2.10):** `npm test` 277/277 with and without DB; Vitest 516/516; e2e 41/41 (DB),
  37 + 2 skip; lint 0; 213 contracts, 0 unresolved.
- **Open:** `calendar:today` reads a process-wide calendar (the `config.ts` per-org limitation noted for
  P5); the org backup zip is built in memory under the 60 s RPC timeout; restored projects visible to org
  admins only until shared; dropped desktop-only settings (hotkey, launch at login, permissions, local CLI).

## 2026-10-04 — Orchestrator resume: chain-merge drops, flaky checks

- **Found on develop (a91fce6):** the four "Merge branch 'develop' into web/t2.x-chain" merges (#223–#226)
  took develop's side of `web/src/app/routes.tsx` and this log — develop lost the Visuals, Prepare,
  Pipelines, Analytics and About routes (22 lines) and the T2.7/T2.6/T2.10/T2.14 entries (83 lines).
  Every other file matched the gated chain tip `bdeeb95`; both files restored from it (#227).
- **Leftover local `web/*` branches:** a line-by-line check of every added line against develop — all present
  in a later form except the routes/log above. Nothing else carried over.
- **Three flaky checks, each failing on develop's own tree:** `test-automationTools` (search-index timer inside
  the creators' before/after window, 2 of 3 → stubbed `scheduleIndex` as two other suites do, 10 of 10);
  `auth.e2e` (mock IdP page without an icon → Chromium's `/favicon.ico` 404 is a console error, 2 of 2 → empty
  `data:` icon, 2 of 2); `shell.e2e` nav (waited for exactly `/data`, which redirects to `/data/<projectId>`,
  2 of 3 → item path or sub-path, 5 of 5). No assertion loosened.
- **Under load (4 agents, load average ~55):** single DB suites (`dockServer`, `tokens-db`, `jobs-pods`,
  `connections-server`) fail once in a full parallel run and pass alone — the shared-DB contention already
  recorded under T2.4. Gate rule unchanged: a failure counts unless it passes on an isolated re-run.
- **CI:** GitHub Actions starts jobs again (#227's 8 checks ran) — merges go back to waiting for green CI. Its first
  run failed at T5.2's "Start MinIO": `minio/minio` is gone from Docker Hub → `chainguard/minio` (#228).
- **Blocked:** `docker`, `helm`, `kind` are not installed on this machine (T7.1/T7.2 "Done when").

## 2026-10-04 — T1.2 Pivot, cohort and funnel grids

- **`web/src/charts/grids/`:** `GridViz` picks the pivot / cohort / event-funnel view for those three chart ids;
  each is a semantic `<table>` (every `<th>` scoped: `col`, `colgroup` for merged headers, `row` in the body;
  named tables; labelled, focusable scroll regions). Pivot sort re-asks the server (one `visual:data`), subtotal
  rows collapse, > 200 rows window like the desktop; cohort table ↔ retention curve; CSV re-asks the server.
- **Server does the math:** the desktop cohort header summed the sizes in the browser — `CohortGrid.members` now
  comes from `foldCohort` (shared by the JS and resident paths); `test-cohort` +2, differential unchanged.
- **Parity (Done-when):** the sample dashboard has no pivot/cohort card, so parity is on `/dev/charts` over the
  sample dataset. `grids.test.tsx` runs the real desktop `pivotRender`/`cohortRender` in jsdom against the port
  over the same server replies — 9 encodings, 700+ cells compared by tag, text, spans, kind, colour, indent,
  hover text; negative controls (drop a subtotal class, change funnel rounding) fail. Desktop-vs-port shots in
  both themes compared by eye. A11y: header scope/name asserted in Vitest and again in Chromium (`grids.e2e`).
- **Measured:** `/dev/charts` 8/5/5 RPCs per load; grids chunk ≈ 9.7 KB gzip JS + 2.2 KB CSS, lazy; initial JS
  177.4 KB gzip. Gates: `npm test` 277/277 without DB, with DB 276 + `connections-server` passing alone; Vitest
  547/547; e2e 42/42; lint 0.
- **Open:** the Visuals builder (`ChartStage.tsx`) still says "not in the browser yet" for these ids — T2.11
  wires `GridViz` there; pivot "Copy as table"/"Export CSV" belong to the dashboard card menu (T2.8/T2.9); the
  sample yields a single quarterly cohort (same on the desktop).

## 2026-10-04 — T6.3 Review, threat model, policy

- **`docs/phase-7-web/threat-model.md`:** assets, actors, trust boundaries, every mitigation with the
  `scripts/test-*.ts` / e2e that proves it (each cited file and check name grepped), findings (§5), open and
  accepted risks (§6), dependency audit (§7). **`SECURITY.md`:** reports through GitHub private
  vulnerability reporting — **switched off on the repo; the user has to enable it** (Settings → Code security).
- **Review** (`6391e6f..HEAD`, 159 commits, by hand — `/security-review` only reads a pending diff). Fixed, each
  with a regression test that fails on the old code (`test-securityReview` +283 lines):
  F1 high — an imported bundle could plant a dataset `file` origin and `dataset:refresh` read any csv/json/xlsx
  on the pod (other orgs' data) → server drops file origins on load, `refreshFromFile` refuses;
  F2 high — connection secrets outlived a deleted project and a bundle naming that id took the password →
  fresh ids on import, `projects:delete` drops secrets;
  F3 high — Postgres connector sent user SQL as simple multi-statement text (`; commit; begin read write; …`
  wrote to the source, a trailing `--` dropped the row cap) → extended protocol (one statement), user SQL on
  its own line; F3b medium — MySQL trailing comment; F4 medium (latent) — sqlGate missed a path in a
  parenthesised join and `json_execute_serialized_sql`; F5 medium — `alerts:fired` / `hub:dataset-refreshed`
  went org-wide → project readers only, errors redacted; F6 medium — `projects:export` (raw origins: URL keys,
  SQL) was `read` → `admin`; F7 low — `/api/mcp` had no rate limit; F8 low — composeSave linked a capture from
  no project. No cross-project IDOR in 213 contracts.
- **Audit gate (user decision):** in-range `npm audit fix` (lockfile only: fast-uri 3.1.8, brace-expansion
  1.1.21/2.1.7/5.0.12); `scripts/audit-gate.ts` fails on any high/critical advisory outside a 3-entry allowlist
  (maplibre-gl GHSA-jrc7-96c5-q579; image-size GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr — unreachable, no fix
  in range, review by 2027-01-04), on an expired entry and on a stale entry; negative controls fail 3 + 3.
  Node 24 runs it as `.ts` in CI, no install.
- **Open:** R1 high — user regex on the request thread (ReDoS stalls the pod for every org; V8's linear engine
  does not cover the `u` flag) → **new task T6.4** (user decision); R2 SQL gate is a deny-list lexer; R3
  bundle import can inflate to 4 GB in memory; lows/info in §6.
- **Gates (orchestrator, on T1.2):** `npm test` 278/278 without DB, with DB 278 (`secrets`, `geoAgg` once
  each under load, both pass alone); Vitest 516/516; e2e 41/41; lint 0; file sizes pass.

## 2026-10-04 — T2.8 Analyses and authoring

- **Built:** `/analyses` (live previews, rename, history, Trash with Undo, catalog tags, Lineage, designed
  empty/error/loading states), the three-step create wizard (datasets, templates with column mapping and a
  server-computed KPI preview, layouts, the Assistant; `?new=1&dataset=`), the reviewed AI draft, and the
  authoring workbench at `/analyses/:projectId/:analysisId` — sheets, chart/map/KPI/text/divider/container/tab/
  statistics/image/navigation cards, filter controls and parameters (`paramDialog`), drag/resize with snap and
  keyboard, multi-select align/distribute/group, tablet/phone layouts, Properties, undo/redo, 600 ms autosave.
  `/data/metrics`: metric list, editor (simple/formula, typed filter dialog), save-as-metric from a KPI card.
- **Server:** contracts for every channel the screens call (239 total) plus batch reads that answer a screen
  in one call through the registered handlers (`analysis:gallery`, `analysis:open`, `analysis:tiles`,
  `metric:table`, `metric:values`); `test-analysesServer` compares each with the single handler (`Object.is`),
  runs a viewer/editor/org-admin matrix on Postgres, and proves publish copies **by value**. Sheet geometry is
  a port of `cardModel`/`sizeLayout` with a differential Vitest against the legacy modules.
- **Measured:** RPCs per load — list 8, wizard 3, canvas 2; initial JS 177.86 KB gzip (limit 300). Gates
  (orchestrator, on the T2.13 tip that contains it): `npm test` 281/281 without and with DB; CI env (postgres
  password auth + MinIO) 280 + `backups` passing alone 3/3; Vitest 594/594; e2e 50/50; lint 0. Screens in both
  themes reviewed.
- **Open:** "Create report…" in the dashboard menu lands with T2.13's follow-up; pivot "Copy as table" /
  "Export CSV" belong to the T2.9 card menu.

## 2026-10-04 — T2.13 Reports, stories, scorecards

- **Built:** reports (list, new from a dashboard, three-pane builder with true-size preview, Generate now),
  stories (list, new, Assistant draft, Markdown editor with outline, slash picker, live charts/metrics from
  `story:figures`, pinned filters, images, callouts, undo/redo, autosave, present mode, PDF), scorecards (list,
  seeded new, rows editor, period table with server-computed tallies/attainment/change strings, detail drawer).
- **Server does the math:** `src/analysis/reportPages.ts` resolves every page (`report:preview`/`report:build`)
  through the same handlers a single call uses, on the Share policy's report path; desktop paths are stripped
  from replies. The Markdown parser moved to `src/analysis/storyText.ts`, shared by server and browser and
  differential-tested against the desktop's. 28 contracts; local-path channels stay uncontracted.
- **Browser export:** PDF/PPTX/DOCX with pdfmake / pptxgenjs / docx loaded on first use (plan §1 approved
  these); charts via T1.1's PNG helper; maps render off-screen with their DOM markers composited onto the
  WebGL canvas (replaces `capturePage`).
- **Measured:** `/reports` 1–4 RPCs per load; initial JS 178.86 KB gzip. Gates (orchestrator): `npm test`
  281/281 without and with DB; CI env 280 + `backups` passing alone 3/3 (failed once under load); Vitest
  594/594; e2e 50/50; lint 0. Screens in both themes reviewed.
- **Logged, not built (per spec):** scheduled server-side reports. **Follow-ups:** "Create report…" in the
  T2.8 dashboard menu; pivot/cohort tiles in printed reports (now possible through T1.2's `GridViz`).

## 2026-10-04 — T7.1 Docker image and Compose

- **Image** (`deploy/Dockerfile`, multi-stage on `node:24-slim`): **589 MB** (cap 600; CI fails above it).
  Runs as `node`; `HEALTHCHECK` on `/readyz`; DuckDB `httpfs` + `aws` baked into
  `/opt/ordinate/duckdb-extensions` with autoinstall off. GeoJSON fetched at build and checked non-empty
  (177 / 52 / 3,221 features). Runtime deps pruned of desktop-only packages (maplibre-gl, pdfmake, pptxgenjs,
  Chart.js plugins, oracledb thick binaries, the musl DuckDB binding); a build-time `registerHandlers()` +
  driver require guard fails the build on over-pruning (negative control: dropping `sizeLayout.js` fails it).
- **No runtime download, proven:** a container on an `--internal` network (DNS `EAI_AGAIN`, direct IP
  `ENETUNREACH`) loads httpfs/aws from the baked dir, reads and writes S3 on MinIO; with an empty extension
  dir it refuses ("not found … Install it first") and never turns healthy.
- **Compose** (`deploy/docker-compose.yml`, `.env.example`): ordinate + postgres:17 + MinIO + one-shot bucket
  init; header-mode sign-in (oauth2-proxy shape), app port on `127.0.0.1` only, secrets only from `.env`.
  Clean `up --wait` 15 s (54 s with a cold image build); restart 6 s; down/up with volumes 13 s; data and the
  dashboard survive both. A forged `X-Forwarded-Email` from an untrusted peer gets `user: null` / 403.
- **`/metrics`** (`src/server/metrics.ts`, no dependency): RPC counts/latency per channel, job counts,
  compute-pool queue depth, `residentTrace` outcomes per op — only on `METRICS_PORT`; the app port 404s it
  for every Accept header. `test-promMetrics` 39 ok, exposition validator with 6 negative controls.
- **Done when** (`web/e2e/compose.e2e.ts` against the stack, all UI): sign in → new project → import CSV →
  chart → that chart as a card on a dashboard (T2.8 canvas) → reopened, card draws. 22.8 s, zero console
  errors; RPCs per load ≤ 15. Screens `compose-*-{light,dark}.png` reviewed. New CI job `docker` runs it.
- **Gates (agent, orchestrator's gates script, on faaca54):** `npm test` 282/282 without DB, with DB, and CI
  env; Vitest 594/594; e2e 49 + `connections` passing alone (known load flake); lint 0.
- **Open:** the `docker` CI job's first run is also the first amd64 build; publish to a read-only dashboard
  waits for T2.9; `chainguard/minio:latest` unpinned; ~11 MB image headroom; header mode trusts any local
  peer on the published port (documented, never bind `0.0.0.0`).

## 2026-10-04 — T6.4 User regex off the request thread

- **What moved:** on the server, every user regex a request can reach — regex split/replace, keyword rules,
  quality `regex` rules, input-table rule checks, "show failing rows" — runs in `src/engine/regexWorker.ts`
  via `regexPool.ts` (stdlib `worker_threads`): one message per batch of DISTINCT texts (≤ 20,000 texts /
  4M chars), **2 s deadline per call**, thread terminated and lazily replaced on overrun, ≤ 4 calls in
  flight, one warm idle thread. The worker's answers feed the existing synchronous folds, so ordinary output
  is byte-identical; a server-side sync fold that meets a user regex without those answers refuses rather than
  runs it (covers the loose `filters` lists from T2.8/T2.13). Desktop unchanged. Formula `regexp_*` (no `u`
  flag) runs on V8's linear engine on the server. Swept: story Markdown `/\s+$/` (28 s on 100k spaces) →
  `trimEnd()`, 2 ms.
- **Measured** (`test-regexDeadline`, 34 ok): six hostile calls at once (`(\w+)+!`, `(a|a)+!`, `\w+…\w+!` over a
  40-char cell, through replace/split/keyword/quality) all return the translated timeout with rows untouched —
  four at ~2.0 s, two at ~4.0 s behind the 4-thread cap; max event-loop delay 6.6–28.8 ms; a 5 ms ticker kept
  firing. Negative controls: the old inline fold still running at 4,000 ms; worker or linear engine disabled →
  suite killed at 60 s. Ordinary-step cost, 100k rows, median of 9 (desktop inline → server): replace
  38.8 → 47.2 ms, split 58.9 → 93.0, keyword 33.3 → 51.8, formula `regexp_replace` 37.9 → 106.3, quality
  rule 3.7 → 23.9; ≤ 1.1 ms at 1k rows — no cost model, the server always uses the worker.
- **Threat model:** R1 → MITIGATED with these numbers (§6), §4.6 row added. Residual: the four threads can be
  kept busy 2 s at a time (bounded queueing, not a pod stall).
- **Gates (orchestrator, on b8f5417):** `npm test` 282/282 without DB, with DB, and CI env; Vitest 594/594;
  e2e 50/50; lint 0; initial JS 178.87 KB. Rebased onto T7.1 (`.gitignore`: both blocks kept), then
  build, lint, `regexDeadline`, `promMetrics`, `server-boot`, `file-size` re-run green.
- **Open:** story `INLINE_RE` link alternative scans to end of line from every `[` (50k `[` ≈ 2.9 s/match;
  shared with the desktop parser, a behaviour change — kept in R1); `notebook/exportMd.ts` still trims with
  `/\s+$/`; the keyword job on large text has no warm-up on the server (progress bar skips that phase);
  `test-publishSite` can flake when its random privacy token contains "000" (follow-up task suggested).
