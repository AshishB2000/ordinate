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
