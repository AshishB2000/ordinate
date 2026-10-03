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
