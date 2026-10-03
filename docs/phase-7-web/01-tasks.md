# Phase 7 — task specs

One task = one Claude Code session = one PR. Read `00-plan.md` first; its §6 rules apply to every
task and are not repeated here.

## How to start a session

Paste this, changing only the task id:

```
Do task T0.1 from docs/phase-7-web/01-tasks.md.
Read CLAUDE.md, docs/phase-7-web/00-plan.md (all of it) and your task spec before touching code.
Work in a new worktree under .claude/worktrees/ off origin/develop, on the branch named in the spec.
Follow §6 of the plan exactly. When every "Done when" item is true, run all gates, commit,
tick the task's box in 01-tasks.md, append what you measured or decided to log.md,
and open the PR (or tell me it is ready to push if it is a weekday 08:00–18:00).
If the spec is wrong or blocked, stop and tell me why instead of improvising.
```

Run tasks in dependency order. Tasks marked **∥** can run at the same time as others in the same
row of the plan's dependency graph.

---

## P0 — Foundations

### [x] T0.1 Server skeleton
- **Branch** `web/t0.1-server` · **Depends** — · **Scope** `src/server/`, `package.json`, `scripts/`
- Add `src/server/app.ts` (Fastify 5 factory, no listen) and `src/server/main.ts` (reads env, listens).
  `npm run server` builds TS and starts it. Env: `PORT` (8080), `DATA_DIR`, `ORDINATE_ENV`
  (`dev|prod`), `LOG_LEVEL`. Config is read once into a frozen object in `src/server/env.ts`;
  unknown or invalid values fail startup with one clear line.
- Routes: `GET /healthz` (process up), `GET /readyz` (DuckDB `isAvailable()` and, later, Postgres).
- Structured JSON logs through Fastify's logger; a redaction list for `authorization`, `cookie`,
  `password`, `token`, `secret`, `key`.
- The server must start **without Electron installed** — prove it with a test that spawns
  `node src/server/main.js` with `NODE_PATH` stripped of electron and hits `/healthz`.
- **Done when:** `npm run server` → `curl :8080/healthz` is 200; `scripts/test-server-boot.ts` passes; lint zero.

### [x] T0.2 RPC registry, contracts and wire codec
- **Branch** `web/t0.2-rpc` · **Depends** T0.1 · **Scope** `src/server/rpc.ts`, `src/server/wire.ts`, `src/api/`, `src/ipc/*.ts` (one import line each)
- `src/server/rpc.ts`: an `ipcMain`-compatible registry (`handle`, `on`, `removeHandler`) that
  stores handlers. Every `src/ipc/*.ts` imports `ipcMain` from a new `src/ipc/bus.ts`, which
  re-exports Electron's `ipcMain` under the desktop and the registry under the server. **Do this
  rewrite with a script**, then check `git diff --stat` shows one line per file.
- `src/api/contract.ts`: `rpc({ access, input })` and the `Access` type. `src/api/index.ts` merges
  area files. Route `POST /api/rpc/:channel` → 404 if no contract, 400 on zod failure (error lists
  paths, never echoes values), then runs the handler with `args` spread as today.
- `src/server/wire.ts`: tagged JSON encode/decode for `NaN`, `Infinity`, `-Infinity`, `-0`,
  `undefined` (in arrays and objects), `Date`, `Map`, `Set`, `Uint8Array`, `Buffer`, `BigInt`.
  The same file is imported by the web client (no Node imports in it).
- Differential test `scripts/test-wire.ts`: for a fixture set **and** the real outputs of
  `vizSampleData`, metric, stats and anomaly handlers on the sample project, assert
  `structuredClone(x)` and `decode(encode(x))` are deep-equal with `Object.is` at every leaf.
- Add contracts for the channels Home needs (projects list, datasets list, recent) so T0.6 has
  something to call.
- **Done when:** the test passes; an uncontracted channel returns 404; a malformed input returns 400.

### [x] T0.3 Request context, paths, dev auth
- **Branch** `web/t0.3-context` · **Depends** T0.2 · **Scope** `src/server/context.ts`, `src/app/paths.ts`, every `app.getPath` call site
- `src/server/context.ts`: `AsyncLocalStorage<{ user, org, requestId, client }>`; `ctx()` throws
  outside a request in server mode, returns a fixed desktop context under Electron.
- `src/app/paths.ts`: `userData()`, `downloads()`, `temp()`, `documents()`. Server mode resolves
  under `DATA_DIR/orgs/<orgId>/`. Replace all 56 `app.getPath(...)` calls **with a script**; then
  grep must find zero outside `paths.ts`.
- Dev auth: in `ORDINATE_ENV=dev` every request runs as user `dev@local`, org `default`, role
  `admin`. In `prod` with no auth configured the server refuses to start.
- `event.sender` / `e.sender` / `fromWebContents` (15 sites, 10 files): route through
  `ctx().client` (implemented in T0.5; stub with a no-op here).
- **Done when:** `npm test` green under Electron **and** server mode; a test proves two concurrent
  requests with different orgs resolve different `userData()` paths.

### [x] T0.4 Files: upload and download ∥
- **Branch** `web/t0.4-files` · **Depends** T0.3 · **Scope** `src/server/files.ts`, `web/src/api/files.ts` (if web exists, else stub)
- `POST /api/files` multipart, streamed to `temp()`, cap from `MAX_UPLOAD_MB` (default 200), returns
  `{ fileToken, name, size }`; token is single-use, org-bound, expires in 1 h.
- `GET /api/files/:token` streams a server-produced file with `Content-Disposition: attachment`.
- `resolveUpload(token)` helper for handlers. Convert **one** import path end to end (CSV import in
  `src/ipc/datasetImport.ts`) as the reference; others convert during their screen port.
- **Done when:** a test uploads a CSV, imports it via RPC with the token, and a second use of the
  token fails; an oversize upload gets 413 without the body being buffered.

### [x] T0.5 Server-sent events and jobs ∥
- **Branch** `web/t0.5-sse` · **Depends** T0.3 · **Scope** `src/server/sse.ts`, `src/app/jobs.ts` (wiring only)
- `GET /api/events?client=<id>`: one stream per browser tab, heartbeat every 20 s, cleaned up on
  close. `ctx().client.send(channel, payload)` writes to it (wire-encoded).
- Map the five push channels (`hub:new-entry`, `hub:open-settings`, `hub:show-permission`,
  `menu:run`, `overlay:frame`) — keep the first, drop the rest with a note in `log.md`.
- Job progress/cancel (`src/app/jobs.ts`, `computePool`) emits over SSE.
- **Done when:** a test starts a job over RPC and receives progress and completion events on the stream.

### [x] T0.6 Web app shell
- **Branch** `web/t0.6-shell` · **Depends** T0.2 · **Scope** `web/` (new), root `package.json` scripts
- `web/` with Vite + React 19 + TS strict, React Router 7, TanStack Query 5. `npm --prefix web run
  dev` proxies `/api` to `:8080`; `npm run server` serves `web/dist` in prod.
- `web/src/api/client.ts`: `rpc(channel, ...args)` typed from `src/api` contracts (type-only
  import), wire codec, `X-Ordinate-Client` header, errors → typed `RpcError`. One TanStack Query
  hook file per area later; add `useProjects`, `useDatasets` now.
- Shell: left nav (Home, Data, Visuals, Analyses, Dashboards, Explore, Reports, Settings), top bar
  (project switcher placeholder, search placeholder, user menu), routes with lazy-loaded feature
  chunks, error boundary per route, 404 page.
- `web/src/theme.css` copied from `renderer/theme.css`; light/dark via `data-theme` + system default.
- CSP for the built app: no inline script or style; Vite config emits none.
- Supported browsers: the latest two versions of Chrome, Edge, Firefox and Safari (Vite `build.target`
  set to match).
- oxlint covers `web/` with the react and react-hooks plugins; zero findings.
- **Done when:** `npm run server` + browser shows the shell and a real project list from the API.

### [ ] T0.7 UI kit
- **Branch** `web/t0.7-ui` · **Depends** T0.6 · **Scope** `web/src/ui/`
- Primitives on Radix, styled with CSS Modules + theme tokens, matching the current hub look
  (study `renderer/hub/hub.css` and the running desktop app): Button, IconButton, Input, Textarea,
  Select, Combobox, Checkbox, Switch, Radio, Dialog, Drawer, Popover, Menu, ContextMenu, Tabs,
  Tooltip, Toast (replaces `hubNotify`), Badge, Skeleton, EmptyState, ErrorState, Splitter
  (replaces `dockResize`/`sidePanel` behaviour), Panel, Toolbar, Kbd, Icon (all SVGs from
  `renderer/hub/icons.ts` → `web/src/ui/icons/`), `customDropdown` behaviour folded into Select.
- A dev-only gallery route `/dev/ui` showing every component in every state, both themes.
- Vitest + Testing Library for each: renders, keyboard, focus trap where relevant.
- **Done when:** gallery reviewed by a human; tests and lint green.

### [ ] T0.8 E2E harness and CI
- **Branch** `web/t0.8-e2e` · **Depends** T0.7, T0.4, T0.5 · **Scope** `web/e2e/`, `.github/workflows/`
- Playwright starts the built server on a temp `DATA_DIR` seeded with the sample project
  (`src/app/sampleProject.ts`), opens Chrome, signs in as dev.
- Fixtures: `failOnConsoleError` (every spec), `rpcBudget(n)` (fails when a page load issues more
  than `n` RPCs — default 25), `screens(name)` (one screenshot per theme into `__screens__/`).
- First spec: shell loads, nav works, project list renders.
- Projects run Chromium on every PR and WebKit + Firefox nightly. A bundle-size check fails the build
  if the initial JS chunk exceeds 300 KB gzip (feature routes are lazy chunks).
- CI: new job in `ci.yml` — web build, Vitest, e2e. Keep the Electron smoke until P8. Update both
  `branches:` lists if touched.
- **Done when:** the PR shows the new job green alongside the existing checks.

---

## P1 — Rendering core

### [ ] T1.1 Chart engine ∥
- **Branch** `web/t1.1-charts` · **Depends** T0.8 · **Scope** `web/src/charts/`
- **Legacy:** `chartRender`, `chartDatasets`, `chartScales`, `chartShapes`, `chartPalette`,
  `chartValueLabels`, `chartAnnotations`, `chartFamiliesExtra`, `chartFamiliesPlugins`,
  `chartTraits`, `chartTypeSpec`, `chartTable`, `chartEvents`, `renderResult` (`VIZ_LABELS` = 39),
  `wordCloudLayout`, `wordCloudRender`, `cjsShim`. **Not** `plotRender` (Mosaic — dropped).
- Port the config-building code as **pure ES modules** (no React inside), then a `<Chart>`
  component that owns the Chart.js instance (create on mount, `update()` on data change, destroy on
  unmount, resize observer). Chart.js plugins (boxplot, financial, matrix, sankey, treemap) via
  dynamic import per family.
- **Differential test:** for all 39 ids on `vizSampleData`, the legacy builder (loaded in Node
  with a minimal DOM stub) and the port produce identical Chart.js config JSON.
- Export to PNG (`canvas.toDataURL`) helper for later report/dashboard export.
- **Done when:** `/dev/charts` renders all 39 from the API; differential test passes; e2e screenshots both themes.

### [ ] T1.2 Pivot, cohort and funnel grids ∥
- **Branch** `web/t1.2-grids` · **Depends** T0.8 · **Scope** `web/src/charts/grids/`
- **Legacy:** `pivotRender`, `cohortRender`, funnel table bits in `renderResult`.
- Render `PivotGrid` / `data.cohort` / `data.eventFunnel` from the server as semantic `<table>`s.
  Subtotals come from the server — never recompute them in the browser.
- **Done when:** visual parity on the sample dashboards' pivot and cohort cards; a11y check (table headers, scope).

### [ ] T1.3 Maps ∥
- **Branch** `web/t1.3-maps` · **Depends** T0.8 · **Scope** `web/src/charts/maps/`
- **Legacy:** `mapRender`, `mapBasemap`, `mapFlow`, `mapGeoThumb`, `mapHexbin`, `mapKinds`,
  `mapOverlays`, `mapPoints`, `mapThumb`, `mapWorker`, `geoCluster`, `geoMatch`, `geoRadius`.
- MapLibre GL **4.7.1** via dynamic import (keep the pin in this phase; upgrading is a separate
  decision now that a bundler exists — note it in `log.md`). Keep "no glyphs, no sprite URL"; value
  labels stay DOM markers. GeoJSON served from the server (`geo/`), OSM tiles stay the one declared
  external fetch — add the tile host to the web CSP `img-src`/`connect-src` only.
- **Done when:** every map kind in the sample renders; no CSP violation in e2e.

### [ ] T1.4 Data grid ∥
- **Branch** `web/t1.4-datagrid` · **Depends** T0.8 · **Scope** `web/src/ui/DataGrid/`
- **Legacy:** `dsGrid`, `dsVirtual`, `composerGrid` (editable mode), `inputGrid`.
- Virtualized rows and columns (`@tanstack/react-virtual`), server paging through `datasetPage`
  (1M rows must scroll smoothly: fetch pages of 500 around the viewport), sticky header, column
  resize, type badges, keyboard cell navigation, optional editable cells (for capture drafts and
  input tables only).
- **Done when:** e2e scrolls a 1M-row dataset end to end with no duplicated or missing row
  (compare ordinals) and stays under the RPC budget.

---

## P2 — Screen ports (all ∥ with each other once P1 is merged)

Each task: read every legacy file listed, write the parity checklist into the PR, add contracts for
every channel the screen uses, convert any `dialog` call it hits to the T0.4 file flows, one e2e
spec + screenshots. Feature code lives in `web/src/features/<area>/`.

### [ ] T2.1 Home and app chrome
- **Branch** `web/t2.1-home` · **Legacy:** `homePage`, `homeAsk`, `homeData`, `getStarted`,
  `navCard`, `workspace`, `hub`, `hubMenus` (→ in-app menus), `hubNotify` (→ Toast), `jobsPanel`,
  `coachMarks`, `brand`, `emptyState`, `skeleton`.
- Drop: `tabNav`, `tabStrip`, `tabModel`, `tabSplit`, `tabKinds` (routes replace tabs),
  `hubHotkey`, `hubCapture`, `lazyScript`.

### [ ] T2.2 Projects, trash, versions
- **Branch** `web/t2.2-projects` · **Legacy:** `projects`, `projectSwitcher`, `trashPage`,
  `versionsPanel`. Drop `projectSync` (sync folder is desktop-only).

### [ ] T2.3 Data: list, dataset page, catalog
- **Branch** `web/t2.3-data` · **Legacy:** `dataSection`, `datasets`, `dsList`, `dsExplorer`,
  `dsProfile`, `dsLineage`, `lineagePanel`, `dataSearch`, `catalogPage`, `catalogDetails`,
  `catalogUi`, `dsRules`, `dsRuleEditor`, `relationshipsPage`, `relationshipDialog`.

### [ ] T2.4 Import, composer, captures, input tables
- **Branch** `web/t2.4-import` · **Legacy:** `dsImport`, `composer`, `composerGrid`,
  `captureDataset`, `captureList`, `captureStatus`, `inputPage`, `inputGrid`, `inputColumns`,
  `inputKeys`, `inputBind`.
- Every file import goes through T0.4 uploads (CSV, TSV, JSON, Excel, Parquet). Paste stays.
- Captures: new "Upload or paste a screenshot" source → `captureDataset:draft`; the capture list
  stays a tab under Data. Model reads the image server-side; preview cells editable for this source only.

### [ ] T2.5 Connections
- **Branch** `web/t2.5-connections` · **Legacy:** `connections`, `connNew`, `connEditor`,
  `connDetails`, `connRun`, `connWorkbench`, `saas`.
- Remove the 3 local-folder sources from the registry in server mode (`capabilities()`), keep URL.
- Secret fields are write-only in the UI: show "set" / "replace", never the value.

### [ ] T2.6 Prepare and pipelines
- **Branch** `web/t2.6-prepare` · **Legacy:** `prepare`, `prepareClean`, `prepareCombine`,
  `prepareForms`, `prepareGeo`, `prepareMask`, `prepareReshape`, `formulaEditor`, `calcMenu`,
  `textSteps`, `textProfile`, `textPreviews`, `pipelinesPage`, `pipelinesDetail`, `pipelinesGraph`.
- The formula editor validates through the server parser — no client-side evaluation.

### [ ] T2.7 Visuals builder
- **Branch** `web/t2.7-visuals` · **Legacy:** `visuals`, `vizGallery`, `vizNew`, `vizBuilder`,
  `vizThumbs`, `encodingForm`, `encodingMap`, `encodingRelated`, `chartControls`, `formatPanel`,
  `formatBind`, `fmtApply`, `fmtColors`, `fmtColorsUi`, `fmtProfile`, `fmtSort`, `facetGrid`,
  `facetShelf`, `palette`, `paletteRows`, `drill`, `filterDialog`, `filterType`, `filterTypeApply`,
  `filterValues`, `periodPicker`, `tooltip`, `analyticsPane`, `analyticsEditors`, `actionEditor`,
  `chartAnnotations` (editor side).
- This is the largest port; split into two PRs if it passes ~3,000 lines (builder, then format/filter panels).

### [ ] T2.8 Analyses and authoring
- **Branch** `web/t2.8-analyses` · **Legacy:** `analyses`, `anList`, `anNew`, `anNewTemplates`,
  `anDraft`, `authoring`, `authoringPanes`, `authoringProps`, `authoringRail`, `authoringSelect`,
  `layoutEdit`, `layoutFilters`, `layoutKinds`, `layoutSizes`, `sizeLayout`, `gridArrange`,
  `cardModel`, `cardKinds`, `tileActions`, `kpiCompare`, `metricEditor`, `metricPicker`,
  `metricsPage`, `paramDialog`.
- Publish still copies **by value** into a dashboard (spec: `docs/analysis/00-model.md`).

### [ ] T2.9 Dashboards, sharing, alerts, comments
- **Branch** `web/t2.9-dashboards` · **Legacy:** `dashboards`, `dashGrid`, `dashAdd`,
  `dashAddControl`, `dashCardChrome`, `dashControlBar`, `dashControls`, `dashFiltersUi`,
  `dashHistory`, `dashParams`, `dashSelection`, `dashShare`, `dashStyle`, `dashAi`, `summaryCard`,
  `textCard`, `markdown`, `publishDialog`, `alerts`, `alertsInbox`, `commentPanel`, `commentDoors`,
  `commentStore`.
- Publish-to-folder becomes publish-to-URL: `/p/<publishId>` served by the server, still through
  `dashboardExport.sanitizeBundle`. Access: org members by default; "anyone with the link" is an
  admin-enabled org setting, off by default.
- Comments show the real author (from `ctx().user`), not a local name.
- Move the published site's own renderer `renderer/publish/` (`publishCore.ts`, `publishClient.ts`,
  inlined into every page by `src/publish/siteHtml.ts`) to `src/publish/site/` and fix the paths, so
  T8.1 can delete `renderer/` without breaking publishing. Its CSP and whitelist stay as they are.

### [ ] T2.10 Analytics workbenches A — stats, drivers, scenarios, segments
- **Branch** `web/t2.10-analytics-a` · **Legacy:** `statsPanel`, `statsCharts`, `statsControls`,
  `statsTile`, `statsViews`, `statsViewsGroups`, `driversEntry`, `driversPanel`, `scenarioPage`,
  `scenarioList`, `scenarioCard`, `scenarioCompare`, `scenarioDrivers`, `segments`, `segmentsRfm`,
  `segmentsView`.

### [ ] T2.11 Analytics workbenches B — pivot, cohort, snapshots, events, insights, SQL
- **Branch** `web/t2.11-analytics-b` · **Legacy:** `pivotBuilder`, `cohortBuilder`, `snapshots`,
  `snapshotAsOf`, `snapshotDiffView`, `eventsPage`, `eventsEditor`, `insights`, `queryTab`,
  `queryEditor`, `queryParams`.
- The SQL tab runs only through `sqlGate`; nothing in the browser builds SQL.

### [ ] T2.12 AI dock, ask, plans
- **Branch** `web/t2.12-dock` · **Legacy:** `dock`, `dockEdit`, `dockHero`, `dockPropose`,
  `dockResize`, `askCore`, `askActivity`, `answerCard`, `planCard`, `planEdit`, `execMenu`,
  `hubResultMenus`, `sidePanel`.
- Streaming answers over SSE (`analyzeStream`). Models are API-key providers only in server mode.

### [ ] T2.13 Reports, stories, scorecards
- **Branch** `web/t2.13-reports` · **Legacy:** `reportList`, `reportBuilder`, `reportRender`,
  `reportExport`, `reportWriters`, `reportDiscussion`, `reportScorecard`, `storyList`, `storyPage`,
  `storyBlocks`, `storyPickers`, `storyPresent`, `storyPropose`, `storyText`, `scorecardPage`,
  `scorecardList`, `scorecardDetail`, `scorecardEditor`.
- PDF/PPTX/DOCX built in the browser with pdfmake / pptxgenjs / docx via dynamic import; chart
  images from T1.1's PNG helper; maps composite their DOM markers onto the canvas (replaces
  `capturePage`). Scheduled server-side reports render in a later task if needed — log it, don't build it.

### [ ] T2.14 Settings, themes, privacy, command palette
- **Branch** `web/t2.14-settings` · **Legacy:** `settingsPanels`, `settingsFormats`,
  `settingsBackups`, `settingsCollab`, `settingsAutomation`, `themeEditor`, `themeModel`,
  `themeApply`, `themeSettings`, `privacyReview`, `privacySettings`, `privacyShare`, `a11y`,
  `commands`, `commandDefs`.
- Split settings into **My settings** (per user) and **Organization** (admin only; T3.4 fills it).
  Backups become admin download/restore. Command palette on ⌘K / Ctrl+K. An About page (version,
  licenses of bundled dependencies, links) replaces the desktop About panel; the macOS Permission
  panel is dropped.

---

## P3 — Identity and tenancy

### [x] T3.1 Postgres foundation
- **Branch** `web/t3.1-postgres` · **Depends** T0.3 · **Scope** `src/server/db/`
- `DATABASE_URL`; pool via `pg`; numbered `.sql` migrations in `src/server/db/migrations/`, applied
  in a transaction at startup with an advisory lock (safe with N pods); `/readyz` checks the DB.
- Test harness: a Postgres service in CI; tests skip with a clear message locally when
  `DATABASE_URL` is unset.
- **Done when:** two server processes starting at once apply migrations exactly once.

### [x] T3.2 Users, orgs, teams, login
- **Branch** `web/t3.2-auth` · **Depends** T3.1 · **Scope** `src/server/auth/`, `web/src/features/auth/`
- Schema: `orgs`, `users`, `teams`, `team_members`, `sessions`, `api_tokens`.
- Modes (env `AUTH_MODE`): `oidc` (authorization code + PKCE via `openid-client`; issuer, client id,
  secret, redirect from env; users auto-provisioned on first login, optional allowed-domain list),
  `header` (trust `X-Forwarded-Email` **only** from `TRUSTED_PROXY_CIDRS`, for oauth2-proxy), `dev`.
- Bootstrap admin from `ORDINATE_ADMIN_EMAIL`. Sessions: random id, httpOnly, Secure,
  SameSite=Lax, rotated on login, idle and absolute expiry.
- **Done when:** e2e logs in against a mock OIDC provider; header mode rejects a spoofed header from an untrusted IP.

### [x] T3.3 Authorization, sharing, audit
- **Branch** `web/t3.3-authz` · **Depends** T3.2
- Project membership: owner team + shared teams/users with `viewer | editor | admin`. Every
  contract's `access` is checked against the project the input names (each contract declares how
  to find its project id); org-level channels need org admin.
- A script lists every contract with no project resolver — must be zero.
- `audit_log` table: login, logout, record writes, publishes, connection changes, role changes,
  exports. Never logs field values that may hold data or secrets.
- **Done when:** a test matrix (viewer/editor/admin × read/write/admin channel × own/other project/other org) passes with zero unexpected allows.

### [ ] T3.4 Admin UI and API tokens
- **Branch** `web/t3.4-admin` · **Depends** T3.3 · **Scope** `web/src/features/admin/`, `src/automation/`
- Admin: users (invite, disable, role), teams, project ownership transfer, audit log viewer with
  filters, org settings (public links on/off, allowed AI providers, upload cap).
- Personal API tokens (hashed at rest, shown once) for the CLI/MCP. Move the MCP HTTP transport
  from loopback-only to `/api/mcp` with bearer tokens; keep the Origin and body-cap gates.

---

## P4 — Engine

### [x] T4.1 Async resident layer: charts and paging
- **Branch** `web/t4.1-async-a` · **Depends** T0.3 · **Scope** `src/engine/`
- Route `residentQuery`, `datasetPage`, `datasetView`, `parquetStore` through `computePool`
  (or `queryAsync`) so no RPC path calls the synchronous bridge. Make the API async upward;
  JS fallbacks stay the reference. Update their differential tests to `await` — still `Object.is`,
  still spying on `getDataset`.
- A guard test: in server mode, calling `duckdb.query` (sync) on the main thread throws.

### [x] T4.2 Async resident layer: the rest
- **Branch** `web/t4.2-async-b` · **Depends** T4.1
- Same for `pivotResident`, `statsResident`, `anomaliesResident`, `qualityResident`,
  `medianResident`, `joinResident`, `pipelineDuck`, and the rest of the 38 sync call sites.
- **Done when:** grep shows zero synchronous DuckDB calls reachable from an RPC handler.

### [ ] T4.3 Per-org workers, limits, load test
- **Branch** `web/t4.3-workers` · **Depends** T4.2
- Workers are keyed by org; each locks `allowed_directories` to its org's data root and sets
  `enable_external_access=false` + `lock_configuration` at start. Pool size, `memory_limit`,
  `threads`, per-query timeout from env. Cancel terminates the worker.
- Load test script: 20 concurrent virtual users on a 1M-row dataset (open dataset, page, three
  chart queries, one stats run). Record p50/p95 and event-loop lag in `log.md`.
- **Done when:** event-loop lag p99 < 50 ms under the load test; a query against another org's
  path fails in the worker.

---

## P5 — Storage for many pods

### [x] T5.1 Records in Postgres
- **Branch** `web/t5.1-records` · **Depends** T3.1
- Repository layer for every record kind in `src/app/recordKinds.ts` (datasets metadata, projects,
  analyses, dashboards, visuals, history, comments, alerts, pipelines, events, themes, …): same
  function signatures, Postgres underneath, `org_id` on every row, row-level checks in every query.
- Importer: `ordinate import-desktop <path-to-userData>` loads a desktop install into an org.
- **Done when:** the whole test suite passes against Postgres; the importer round-trips the sample project.

### [ ] T5.2 Parquet on S3 ∥
- **Branch** `web/t5.2-s3` · **Depends** T4.3
- `STORAGE_URL` = `file:///data` or `s3://bucket/prefix`. Writes go to a new versioned key, then
  the record pointer switches in Postgres (replaces temp-then-rename). Local disk cache with LRU
  size cap. `httpfs` uses the pod's IAM role (no static keys in config).
- Old versions are garbage-collected after a grace period by a job.
- **Done when:** the resident differential tests pass with MinIO in CI.

### [x] T5.3 Secrets at rest ∥
- **Branch** `web/t5.3-secrets` · **Depends** T3.1
- Connection passwords and AI keys: AES-256-GCM per secret with a data key, data keys wrapped by
  `ORDINATE_MASTER_KEY`. Rotation command. `publicConfig()` / `publicByok()` still strip everything.
- **Done when:** a test greps the DB dump and logs for a known secret and finds nothing.

### [x] T5.4 Jobs and cross-pod events ∥
- **Branch** `web/t5.4-jobs` · **Depends** T3.1, T0.5
- `jobs` table claimed with `FOR UPDATE SKIP LOCKED`; `refreshScheduler`, `pipelineCron`,
  `anomalyWatch`, alerts and S3 GC run through it, so each fires once across N pods.
- SSE fan-out via `LISTEN/NOTIFY`, so an event raised on pod A reaches a tab connected to pod B.
- **Done when:** a test with two server processes runs a scheduled job exactly once and delivers its event to a client on the other process.

---

## P6 — Security

### [ ] T6.1 SSRF guard
- **Branch** `web/t6.1-ssrf` · **Depends** P5
- One `safeFetch` / `checkHost` used by every connector that opens a socket from user input
  (`http.ts` 7 sources, `url.ts`, SaaS, and the DB drivers' host field): resolve DNS, then refuse
  loopback, link-local (incl. `169.254.169.254`), private ranges, IPv6 equivalents unless the org
  allowlists them; pin the resolved IP for the connection (DNS rebinding); cap redirects and re-check
  each hop.
- **Done when:** a test table of 30+ hostile URLs is refused; allowlisted private hosts work.

### [ ] T6.2 Web hardening
- **Branch** `web/t6.2-web-hardening` · **Depends** T3.2
- CSRF (double-submit token on every non-GET), strict CSP / HSTS / frame-ancestors / referrer
  policy / nosniff headers, rate limits on login and RPC, request body caps, per-RPC timeouts,
  session fixation and logout-everywhere.
- **Done when:** an automated header + CSRF test passes; e2e still has zero console errors.

### [ ] T6.3 Review, threat model, policy
- **Branch** `web/t6.3-security-review` · **Depends** T6.1, T6.2, T4.3
- `docs/phase-7-web/threat-model.md` (assets, trust boundaries, each mitigation and its test).
  `SECURITY.md` with disclosure process. `npm audit --omit=dev` gate in CI (high = fail).
  Run `/security-review` over the branch history and fix or file every finding.

---

## P7 — Packaging and deployment

### [ ] T7.1 Docker image and Compose
- **Branch** `web/t7.1-docker` · **Depends** T5.4
- `deploy/Dockerfile`: multi-stage on `node:24-slim`; build TS + web; fetch GeoJSON **and install
  DuckDB `httpfs` into a baked `extension_directory` at build time** (the container never downloads
  at runtime); non-root user; `HEALTHCHECK`; image < 600 MB.
- `deploy/docker-compose.yml`: ordinate + postgres + minio, `.env.example`, one command to start.
- `GET /metrics` (Prometheus text, no dependency): request counts/latency per channel, job
  counts, compute-pool queue depth, and `residentTrace` `resident`/`skipped`/`failed` per call site.
  Bound to a separate `METRICS_PORT` so it is never exposed through the ingress by accident.
- **Done when:** `docker compose up` on a clean machine → sign in → import CSV → chart → dashboard.

### [ ] T7.2 Helm chart
- **Branch** `web/t7.2-helm` · **Depends** T7.1
- `deploy/helm/ordinate`: Deployment, Service, Ingress, HPA, PDB, ServiceAccount (IRSA annotation
  for S3), migration Job (pre-upgrade hook), Secret refs, resource requests/limits, optional
  **recommended** NetworkPolicy (egress allowlist) off by default. `values.yaml` documented.
- CI: `helm lint` + install into `kind` with Postgres and MinIO, then the e2e smoke against it.

### [ ] T7.3 Releases and operator docs
- **Branch** `web/t7.3-release` · **Depends** T7.2
- Tag `v*` → build multi-arch image (amd64, arm64) → push to GHCR → attach Helm chart.
- `docs/server/`: quick start (Compose), EKS, ECS (task definition example), GKE/AKS notes,
  configuration reference (every env var), SSO setup per IdP, backup/restore, upgrade, sizing.

---

## P8 — Cutover

### [ ] T8.1 Delete the desktop app
- **Branch** `web/t8.1-cutover` · **Depends** all of P2, P7
- Remove Electron, electron-builder, `preload/`, `renderer/`, `src/windows/`, `src/main.ts`,
  `src/ipc/bus.ts` desktop branch, desktop-only IPC files (`windows`, `menu`, `shell`, `platform`,
  `clipboard`, `capture`, `syncFolder`, `cli`, `mosaic`), `src/cli/`, local connectors, folder watch, sync folder, capture
  OS code, Mosaic vendor bundle, Svelte spike, `dist:*` scripts, Electron smoke. Use a script for
  the import cleanup; `npm run build:ts` must stay clean.
- `package.json` `name` → `ordinate` (the userData-path reason for keeping "Screenchart" is gone).
- Shrink the file-size allowlist for every deleted file.

### [ ] T8.2 Docs and rules
- **Branch** `web/t8.2-docs` · **Depends** T8.1
- Rewrite `CLAUDE.md` for the web architecture (keep: the app does the math, resident-layer rules,
  connector rules, path hardening, testing house style). Rewrite `README.md`. Regenerate
  `docs/automation.md`. Write `docs/phase-7-web/99-retro.md` with the measured outcomes.
