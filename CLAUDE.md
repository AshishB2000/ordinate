# Ordinate

A **self-hosted, open-source BI web app.** A company runs it in its own infrastructure (Docker
Compose, Kubernetes via Helm, ECS); people open a URL and sign in with the company's IdP. Bring data
in (files, paste, Excel, 38 SQL/HTTP/SaaS sources, a URL, or an uploaded screenshot) → **prepare**
it with a reversible pipeline → **visualize** across 39 chart, map & table types → author
**analyses**, publish **dashboards** → share them at a URL. MIT, model-agnostic.

**Core principle: deterministic engines do the math, never a model.** For a copied (extract)
dataset the engine is ours — pure server code and DuckDB over our Parquet; React only formats what
the server returns — it never sums, averages or rounds a figure the server did not. For a **Live**
dataset it is the source warehouse, running SQL the app compiled from a validated spec, and a parity
test proves that SQL and our engine agree on the same rows. A model only *extracts structure* (a
table from a screenshot) or *narrates figures an engine computed*; it **never** writes a computed
number. A screen that needs a number the API lacks gets it added on the server, with its
differential test.

**History lives in `docs/`, not here** (index: `docs/README.md`). Phase 7 — the move to the web —
is `docs/phase-7-web/`: plan, task log with every measurement, threat model, retro. Older
`docs/phase-*/` write-ups are desktop-era history. Re-litigate with numbers, not opinion. Operator
docs: `docs/server/`.

## Architecture

Stateless pods (`src/server/main.ts`, port 8080) behind the operator's ingress, serving the React
SPA (`web/dist`) and the API from one origin. Metadata in Postgres; Parquet on `DATA_DIR` or
`s3://` through DuckDB `httpfs`, under `orgs/<org>/<project>/`.

- **RPC** is `POST /api/rpc/<channel>` (Fastify 5), body wire-encoded by `src/server/wire.ts` (tags
  NaN, ±Inf, -0, undefined, holes, BigInt, Date, Map, Set, Uint8Array — plain JSON silently changes
  figures). **No contract, no channel:** a handler (`src/ipc/*.ts`, registered on `src/ipc/bus.ts`)
  is reachable only if `src/api/` has its contract with a real zod input and the narrowest `access`
  (`read|write|admin`), scoped by `project: (input) => id` or `org: true` (neither or both fails
  `tsc`). No contract → 404; denied → 403 before the handler runs.
  `node scripts/check-contracts.js` (in `npm test`) must list 0 unresolved. `src/api/index.ts`,
  `web/src/app/routes.tsx` and `web/src/app/nav.ts` are **append-only**.
- **Request context** is `AsyncLocalStorage` (`src/server/context.ts`): `ctx()` carries user, org,
  request id, client and an abort signal fired when the client hangs up; outside a request it throws.
  **Every in-memory cache is keyed with `orgKey()`** — record ids repeat across orgs after an import;
  T0.3 and T5.1 found 21 caches leaking across orgs.
- **Auth** (`src/server/auth/`, `AUTH_MODE`): `password` — **the default**, for trying Ordinate out
  (own accounts, scrypt, a first-run setup code printed in the log, temporary passwords an admin
  sets that must be changed; `password.ts`, startup warns to move to SSO), `oidc` (code + PKCE,
  `openid-client`), `header` (`X-Forwarded-Email` believed only from a TCP peer in
  `TRUSTED_PROXY_CIDRS`), `dev` (everyone admin, no Postgres; **explicit only**, for the test
  harness; refused when `ORDINATE_ENV=prod`). Personal API tokens (`ord_…`, sha256-stored) for the
  RPC API and `/api/mcp`. Roles, grants and audit: `src/server/authz/`.
- **Push** is SSE, `GET /api/events?client=<uuid>`, bound to org + user; across pods over Postgres
  `LISTEN/NOTIFY` (`src/server/jobs/bus.ts`). Jobs are a Postgres table claimed with `FOR UPDATE
  SKIP LOCKED` under a lease (`src/server/jobs/`).
- **Files**: `POST /api/files` → `fileToken`; exports → `downloadToken` for `GET /api/files/<token>`.
  Tokens are per pod and single-use — **more than one replica needs sticky sessions** (R8).
- **Publish**: `/p/<publishId>/` (`src/server/published.ts`, pages from `src/publish/`), org members
  only unless the org turns on `public_links`. `dashboardExport.sanitizeBundle` is a **security
  control**: whitelist to labels/numbers/strings/`data:image` only.
- **Postgres** via `pg`: numbered plain `.sql` in `src/server/db/migrations/`, applied in one
  transaction under an advisory lock; an edited applied file or an out-of-order number refuses
  startup. **Migrations must be additive** (`helm rollback` does not undo them). Records go through
  `src/app/recordFs.ts`: a JSON file without `DATABASE_URL`, a `records` row (RLS forced) with it.
- **Secrets**: envelope encryption under `ORDINATE_MASTER_KEY` (`src/server/secrets/`), a data key
  per org. Connection passwords and AI keys go through it, never `config.json`; no DB or key → saving
  a secret is refused. Browser-safe views are `publicConfig()`/`publicByok()`
  (`src/app/execConfig.ts`): has-key flags only.
- **Storage**: a dataset = metadata record + `<id>.parquet` + `<id>.source.parquet` (immutable
  prepare source); row cap **1,000,000**; columns stored VARCHAR with Ordinate's own `ColumnType` in
  the record (a typed column turns `007` into `7`). On S3 the record upsert is the atomic switch.

### DuckDB on the server

- **One locked worker per org** (`src/engine/duckdbPool.ts`, wired by `routeByOrg()` in
  `src/server/main.ts`): `memory_limit`, `threads`, `temp_directory` in the org, `allowed_directories`
  = the org root (+ its S3 prefix), then `enable_external_access=false`, `lock_configuration=true`.
  LRU past `DUCKDB_MAX_WORKERS`, idle eviction, per-query timeout; the request's abort signal
  interrupts. Close a worker through its own queue — **never `terminate()`** (aborts the process
  mid native call). Compute-pool threads borrow the caller's org worker, never run their own DuckDB.
- **Never block the event loop.** `src/engine/duckdb.ts` keeps a synchronous `query()`/`exec()`
  (Atomics.wait) for workers and self-checks, but `src/server/main.ts` calls
  `forbidSyncOnMainThread()` and `scripts/test-asyncReach.ts` proves nothing reachable from
  `src/server/*` or `src/ipc/*` calls it. Request paths use `queryAsync`/`execAsync`.
- **User regex never runs on the request thread**: `src/engine/regexPool.ts`/`regexWorker.ts`, 2 s
  deadline per call, thread replaced on overrun; a sync fold that meets a user regex without the
  worker's answers refuses rather than runs it.
- **User SQL**: one read-only statement through `src/engine/sqlGate.ts` (a deny-list lexer — the
  project boundary inside an org, threat model R2); the org lock is the org boundary.
- Built, not adopted: `duckdbSidecar.ts`; `sqlGen`/`pipelineDuck` (no server path runs them).

### The resident-query layer

`residentQuery` (metrics + aggregated charts), `statsResident`, `anomaliesResident`, `datasetPage`,
`parquetStore`, `datasetView` and the other `src/engine/*Resident.ts` query the stored Parquet **in
place** — no table is materialised to answer a question. Each returns `null` on any failure and the
caller falls back to the pure-JS original. **The JS implementations are the reference**, so changing
one means changing or re-verifying the other; every module is paired with a *differential* test
comparing the two with `Object.is`. A broken fast path is not wrong, only ~600× slower, so
`src/engine/residentTrace.ts` records `resident`/`skipped`/`failed` per call site (exported on
`/metrics`) and warns once per op on `failed`.

Non-negotiable in this layer:

- **Cast on the DECLARED type, never inference.** `TRY_CAST('007' AS DOUBLE)` is `7`. Only
  `number` columns are cast. `sum()` over text must stay a loud binder error, never a wrong figure.
- **Order is never assumed.** A bare `GROUP BY` does not preserve first-seen order and *whether it
  reorders is machine-dependent* — carry an explicit ordinal (`read_parquet(…, file_row_number=true)`)
  and end every `ORDER BY` with it, or paging duplicates and drops rows.
- **Empty means `null` OR `''` OR whitespace**, matching JS. DuckDB's `trim()` strips NBSP but not
  tab and RE2's `\s` does the opposite, so the class is spelled out explicitly.
- **Prefer `CASE WHEN … THEN v END` over `FILTER (WHERE …)`** — per-column `FILTER` costs 16× at
  width; this was a real 57 s regression on a 1,000-column table.
- **Every aggregate is `CAST(… AS DOUBLE)`** — `SUM(INTEGER)` is HUGEINT and reaches JS as a BigInt.
- **The fast path is a cost model, not a flag.** Thresholds live at the call site with the
  measurements that produced them; anomalies needs a width term as well as a row term.

Known divergences, pinned by tests: parallel float summation differs from a JS left-fold by ~1e-13
and quantile interpolation by ~1e-15 (neither reaches a rendered figure, but `mean` enters AI
prompts unrounded); a leading U+FEFF is lost on every string the bridge returns (upstream
`@duckdb/node-api` bug, worked around in `parquetStore` and the readers that grep for `FEFF`).

#### Live datasets (`docs/live-data/`)

- **Mode is in the record**: `Dataset.mode` (`'extract'` when absent) and `live: {maxCacheAgeSec`
  (0 s – 30 days, default 300), `epoch, schemaSyncedAt}` — no SQL migration (`src/data/liveDataset.ts`).
  A Live dataset is **schema only**: columns DECLARED from the warehouse catalog (`liveSchema.ts`),
  no Parquet, no row cap. Only a connector with `ConnectorDef.live` (a dialect + `runBound`, values
  ALWAYS bind parameters, never SQL text) offers it; the catalog sends a `live` boolean, no dialect.
- **`getDataset` throws `LiveDatasetError` on a Live dataset** — the safety net (D6). A reader not yet
  routed refuses loudly: RPC 409 `live_dataset`, or `{ok:false, code:'live_dataset'}` (per item in a
  batch; the route tags a caught refusal). Never compute on zero rows: a catch that turns errors into
  `[]`/`null` rethrows it, a metadata path never hydrates, a walk over every dataset skips Live
  (`isLive`). `scripts/test-liveSafetyNet.ts` calls every row-reading channel — add a new one there.
- **Compile → bind → cache** (`src/engine/live/`, L2.2–L2.4): a validated spec compiles per dialect,
  runs through `runBound`, cached under `orgKey()` with the record's `epoch` (Refresh bumps it) and
  `maxCacheAgeSec`. There is **no JS fallback** (D7): correctness rests on the parity tests — the
  compiler's DuckDB dialect against the extract path with `Object.is` (`test-liveParity`), then real
  engines (L2.8).
- **The executor** (`src/engine/live/liveQuery.ts`: `liveVizData`/`liveMetric`/`liveAnswer`, L2.3):
  cache (an expired entry is kept as the stale fallback) → ONE warehouse call per question however
  many ask, cancelled only when every asker hangs up → `liveBudget` (`LIVE_MAX_CONCURRENT`; L2.7's
  seams) → `connectors/liveRun.ts` (SSRF guard, `costTag 'live'`, `LIVE_QUERY_TIMEOUT_MS`). A failure
  is the stale answer (`asOf.stale`) or a typed error in a catalog sentence — warehouse text goes to
  the log only (R-L6). `live:<dialect>` outcomes on `/metrics`. CI's warehouse is
  `scripts/liveFakeConnector.ts` (DuckDB dialect; tests or `ORDINATE_TEST_LIVE_FAKE` only, never listed).

### Workspace

- **Sources** — `src/data/parse.ts` centralises parsing (strict `isFiniteNumber`, so `007`, zips
  and >15-digit ids stay text). **`src/connectors/` is a REGISTRY of 38 read-only sources — one
  connector is one entry, never a union type**; wire-compatible sources share a driver (`postgres.ts`
  11, `mysql.ts` 8, `http.ts` 7, `saas.ts` 6, `mssql.ts` 3, `oracle.ts` 2 **thin mode only, never
  `initOracleClient`**, `url.ts` 1). **Rules: read-only; secrets never leave the server (replies
  carry `secretSet` flags); EVERY query bounded server-side** (user SQL on its own line inside the
  dialect's wrapper — a trailing comment once dropped the cap, F3/F3b); **every socket goes through
  the SSRF guard** (`src/connectors/ssrf.ts`: check every resolved address, pin to it, re-check each
  redirect; private ranges only via `SSRF_ALLOW`).
- **No dataset origin reaches a browser** — no file path, keyed URL or SQL text; replies carry
  `{kind, label, refreshable}` (`dataset:source`). The server keeps no `file` origin (F1).
- **Captures are a SOURCE**: upload a screenshot → `captureDataset:draft` → composer (preview cells
  editable — a model's reading of an image) → `composeSave`; the one origin that is not re-fetchable.
- **Prepare** — `src/data/transforms.ts` folds ordered steps over an immutable copy, so removing a
  step recomputes from source; an unknown step is skipped with a warning. `src/formula/` is a
  hand-written tokenizer + parser + tree-walker — **no `eval`, no `new Function`, ever** (lint-enforced).
- **Visuals** — `buildVizData` (`src/analysis/vizData.ts`) is the pure bridge to `{labels, series}`;
  ids in `web/src/charts/vizLabels.ts` (`VIZ_LABELS` = 39). Pivot/cohort/event funnel are `<table>`
  grids computed BESIDE it; **pivot subtotals are recomputed from the source, never folded from the
  cells above**. Dashboard metric numbers are computed on the fly, never stored.
- **Analyses** — analysis = mutable authoring surface, dashboard = published read-only snapshot,
  copied **by value** on publish. Spec: `docs/analysis/00-model.md`.
- **AI (optional, `not_ready` without a model)** — API-key providers only, keys per org in the
  secrets store, calls via `src/ai/providerFetch.ts` (SSRF-guarded), org allow-list checked each call.
  `src/analysis/anomalies.ts` is a pure detector; the model only puts app-found figures into words.
- **Automation** — live surface: HTTP MCP, `POST /api/mcp` (`src/automation/serverMcp.ts`, bearer
  token, runs as its user). The CLI (`cli.ts`, `argv.ts`) has no entry point since T8.1.

### Web app (`web/`)

Vite + React 19 + TS `strict`, React Router 7, TanStack Query 5, Radix primitives styled by us, CSS
Modules over `web/src/theme.css` tokens. `web/src/api/client.ts` imports `src/api` **types only**, so
a renamed channel fails `tsc` in both halves. Every list, panel and chart has a designed empty,
loading (skeleton) and error state, in both themes.

- **Charts**: Chart.js 4 used directly (`web/src/charts/`); core and plugins load on first use, as do
  pdfmake / pptxgenjs / docx. **Maps**: MapLibre GL **4.7.1, pinned exactly**, the `-csp` build with
  a same-origin worker. **No `glyphs` and no `sprite` URL** — either adds a network host — so value
  labels are DOM markers. OSM tiles are the one declared external fetch (`MAP_TILE_ORIGINS`).
- **CSP is a header** (`src/server/headers.ts`: `APP_CSP` outside `/api/`, deny-all under it) —
  `script-src 'self'`, no inline script or style. CSRF (`src/server/csrf.ts`) compares Origin with
  Host, so the ingress and the Vite dev proxy must preserve Host.
- **Initial JS ≤ 300 KB gzip** (`npm --prefix web run size`, CI-enforced); each area is a lazy chunk.

## Conventions

- **TypeScript, in-place sibling emit.** New files are `.ts`; `npm run build:ts` (tsc; Vite is only
  for `web/`) emits the gitignored sibling `.js`. `strict` everywhere except `tsconfig.site.json`
  (`src/publish/site/**`, a named `.oxlintrc.json` override). No `any` without a comment.
- **Lint is a real gate.** `npm run lint` = oxlint, type-aware, over `src`, `scripts`, `web/src`,
  `web/e2e` — zero findings, blocking in CI. Not `typescript-eslint` (refuses TS 7). Prettier advisory.
- **File size is a real limit** (500 soft / 800 hard, CI-enforced, `web/` too): @.claude/rules/file-size.md
- **Server sentences go through the catalog** (`t('key', { params })` in `MAIN_FILES`,
  `scripts/i18n-extract.ts`). Write the English literal, then `node scripts/i18n-extract.js` (after
  build:ts) regenerates `src/i18n/en.json` and adds `null` drafts to es/de/fr/ja. Never hand-edit
  `en.json`; after a rebase take develop's and rerun. `test-i18n` fails on a hard-coded string, a
  missing/unused key or a dropped `{param}`. Format figures BEFORE `t()`. The React UI is English-only.
- **Path hardening:** every record id is a UUID checked by `UUID_RE` before it touches a path; every
  org id matches `ORG_RE` (`src/app/paths.ts`) before `DATA_DIR/orgs/<org>/` is built; GeoJSON is
  served by exact name from a whitelist; writes are atomic (temp then rename — one upsert in
  Postgres); corrupt records are skipped, never fatal.
- **Secrets are never logged or sent to a browser** (`REDACT_PATHS` in `src/server/app.ts`,
  `scrubbed()`, `safeError`). A new secret field gets a canary test: plant it, grep every output.
- **No local CLI, no run-time install.** The server spawns nothing built from a user, model or config
  string (any child process: args array, **never `shell: true`**); the image bakes DuckDB's
  `httpfs`/`aws` and the GeoJSON. No telemetry, no surprise network calls.

## Deploy

`deploy/Dockerfile` (non-root, amd64 + arm64, **≤ 600 MB**, CI-enforced); `deploy/docker-compose.yml`
(+ Postgres, MinIO; app port on `127.0.0.1` only); `deploy/helm/ordinate` (migration hook Job,
metrics Service never on the Ingress, secrets only via `existingSecret`). `/metrics` only on
`METRICS_PORT`. `release.yml` (image + chart on a `v*` tag) has never run — releasing is the user's
call. Every env var is in `docs/server/configuration.md`; `test-serverDocs` enforces it.

## Testing

- **Self-check files**, no framework: `npm test` is `node --test "scripts/test-*.js"`, so **adding a
  suite needs no wiring** (and no count is written here). Suites report through `scripts/selfcheck.ts`
  (`ok`/`failureCount`/`finish`). Gate runs: no `DATABASE_URL`, with one, and the CI env (password
  Postgres + MinIO). A scratch-DB pg Pool needs an `'error'` listener (57P01 at teardown).
- **Differential tests are the house style.** Two implementations means asserting they agree with
  `Object.is`, not against hand-written values; several spy on `datasets.getDataset` to prove the
  table was never hydrated. Where the reference was deleted (the desktop renderer) the test compares
  against **golden fixtures** recorded from it (`scripts/fixtures/golden/`, `web/src/**/__golden__/`,
  wire-encoded) — never re-record one to make a test pass. Every guard ships a **negative control**.
- **Web**: Vitest + Testing Library next to the component. **One Playwright e2e per screen** in
  `web/e2e/` (`e2e()` in `web/e2e/fixtures.ts`, against the built server): it **fails on any console
  error, page error or CSP violation**, holds an **RPC budget** (`rpcBudget`, default 25 per page
  load — batch an endpoint before raising it), and writes light + dark screenshots to
  `web/e2e/__screens__/` — look at them. `E2E_CHROMIUM` overrides the browser.
- **CI** (`ci.yml`, every PR to `develop`): jobs `check`, `web`, `audit` (`scripts/audit-gate.ts`),
  `docker`, `helm`, plus `lint.yml`. The required check **`smoke (all shards)`** aggregates check,
  web, docker, helm and audit. `e2e-nightly.yml` runs Firefox and WebKit.

```bash
npm run server        # build:ts, then the server on 127.0.0.1:8080 (./data); serves web/dist. Needs
                      # DATABASE_URL (password sign-in, the default) — or AUTH_MODE=dev, as the tests set
npm run dev:web       # Vite dev server, /api proxied to 127.0.0.1:8080
npm run build:web     # web/dist (tsc + vite build)
npm test              # every self-check suite, parallel
npm run test:web      # Vitest
npm --prefix web run e2e    # Playwright e2e against the built server
npm --prefix web run size   # initial JS ≤ 300 KB gzip
npm run lint          # oxlint — BLOCKING, zero findings
npm run loadtest      # 20 virtual users × 5 iterations over real HTTP, 1M rows
npm run secrets:rotate      # re-wrap org data keys (ORDINATE_MASTER_KEY_OLD / _NEW)
npm run import-desktop -- <userData> [--org id]   # one-time import of a desktop install
node scripts/gen-automation-docs.js   # regenerate docs/automation.md (after build:ts)
```

`npm start` is the same server entry point. `postinstall` builds and fetches map GeoJSON;
`prestart`/`pretest` compile automatically.

## Git

- **Every change gets its own worktree off `develop`** (`git worktree add -b feat/x
  .claude/worktrees/x origin/develop`), then PR → **CI green** → merge → remove the worktree →
  `git pull` on `develop`. Never commit to `develop` directly; a plain `checkout` in this shared
  clone moves the tree under other running sessions, which has already cost work here.
- **Resolve conflicts keeping both sides and re-check the merged tree.** Phase 7 lost routes and log
  entries to one-sided merges (#193, #227) and fixes to commits pushed after a merge (#235).
- A PR showing **no checks at all** is not passing — a stale branch filter in `ci.yml`/`lint.yml` or a
  merge conflict; read `mergeStateStatus`. Renaming the trunk means editing both `branches:` lists in
  the same commit. Checks failing in seconds with no steps is GitHub billing, not code.
- **Never** add a `Co-Authored-By` or any AI co-author trailer to a commit message.

## Out of scope (don't build unprompted)

deck.gl (`@loaders.gl` fetches workers from unpkg.com); Apache Arrow (not achievable with the
current binding); any desktop shell (Electron is deleted; Tauri was costed and closed —
`docs/phase-6/`); MapLibre v5/v6 without re-checking its CSP worker; Next.js/SSR, Redux, Tailwind,
MUI/Ant (rejected in `docs/phase-7-web/00-plan.md` §2); a marketing site; spreadsheet export; a
memory/summarization step (`memoryModel` exists, nothing consumes it). A hosted web version is IN
scope — it is the product. **Ask before adding a runtime dependency** — prefer stdlib, native
platform features, or something already installed.
