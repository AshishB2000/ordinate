# Ordinate

A **local-first, open-source personal BI workspace.** Bring data in (files, paste, Excel, Postgres,
URL/API, or a screenshot capture) → **prepare** it with a reversible transform pipeline → **visualize**
across 28 chart & map types → assemble **dashboards** → **share** offline. AI is optional at every step.
Local-first, model-agnostic, open source (MIT).

**Core principle:** the **app does the math.** All aggregation, stats, metrics, and anomaly detection
run in pure main-process code (deterministic, auditable); a model only *extracts structure* (e.g. a
table from a screenshot) or *narrates figures the app already computed* — it **never** writes a
computed number. For the vision-capture path, the intelligence is in the prompt — invest in prompt
quality before adding code.

> **Naming.** The project was renamed **Screenchart → Ordinate**. Screenchart is now the name of one
> data source (screenshot capture), not the product. `package.json` still carries `name:
> "screenchart"` / `productName: "Screenchart"` — changing those moves Electron's `userData`
> directory and orphans existing config, history, and projects, so it needs a migration, not a
> find-and-replace. Docs use Ordinate; the built macOS bundle is still `Screenchart.app`.

> **Architecture: the DuckDB migration LANDED.** Datasets are stored as **Parquet**, and metrics,
> aggregates, column stats, anomaly detection and the Explore grid all query those files **in place**
> — no table is materialised into `Cell[][]` to answer a question. The row cap is **1,000,000**
> (was 50,000). See [`docs/phase-0/`](docs/phase-0/) … [`docs/phase-3c/`](docs/phase-3c/) for the
> measured basis of every decision, and `.claude/plans/rewrite-to-duckdb-stack.md` for the original
> brief. **Not** built: deck.gl, argued against on measured grounds in
> [`docs/phase-3/README.md`](docs/phase-3/README.md), and the Tauri shell, costed separately in
> [`docs/phase-6/`](docs/phase-6/). Apache Arrow is **not** achievable with the current binding —
> `@duckdb/node-api` ships no Arrow support.
>
> **Phase 6 (Tauri) was costed and the recommendation is to CLOSE it**
> ([`docs/phase-6/`](docs/phase-6/), PR #27). This file previously claimed Tauri had been "argued
> against on measured grounds in `docs/phase-3/README.md`" — it had not; the word appears zero times
> there. It has now. Removing `@duckdb/node-api` and re-running all 43 suites stops **1,648 of 3,285
> assertions (50.2%)** from executing; ~1,100 of those are *differential*, asserting a resident SQL
> path byte-identical against a pure-JS original — and those JS originals are not test scaffolding,
> they are the **shipped fallback** every resident entry point returns `null` into. A Rust port
> deletes their oracle. Measured against that: a stdio sidecar costs **0.08 ms** on a real 90 KB
> Explore page (and is *faster* than today's `Atomics` handshake on a metric card), while the
> webview↔Rust boundary a Tauri port would **keep** costs ~6.7 ms at 64 KB, against queries of
> 2–12 ms. `Atomics.wait` is also spec-prohibited on a webview main thread, so the sync bridge could
> only be deleted, never ported. **The one worthwhile idea in Phase 6 needs neither Rust nor Tauri:**
> move DuckDB into a sidecar process as an *Electron* refactor. **That sidecar is now BUILT and
> proven differential, but NOT yet adopted** (PR #34): `src/duckdbSidecar.ts` (parent client) +
> `src/duckdbSidecarChild.ts` (child) present the same synchronous `query()` surface as
> `src/duckdb.ts`, over a child process instead of a worker + `SharedArrayBuffer` — the sync API
> survives because spinning on `EAGAIN` over a non-blocking stdio pipe is a correct blocking read
> (18.7 spins per 83 KB call). The DuckDB↔JS type mapping and result encoder are extracted into
> `src/duckdbEngine.ts` so the worker bridge and the sidecar share ONE converter. **It is NOT a
> speedup** (`ecc4d0c` corrected the phase-6 doc that implied so): measured end-to-end it is at
> parity on a scalar and modestly slower on real payloads, because transport is a small fraction of
> a query's cost. It exists to prove the sync API can survive the move; adopting it is a separate
> decision.
>
> **Phase 5 (Svelte) is a TOOLCHAIN SPIKE, not a migration** ([`docs/phase-5/`](docs/phase-5/), PR
> #22). `svelte` + `esbuild` are devDependencies; `scripts/build-svelte.js` compiles
> `renderer/hub/svelte/*.svelte` into one IIFE bundle assigning a single global
> (`window.OrdinateSvelte`), loaded like any other classic `<script src>` and **last**, because a
> classic script's top-level `const` lives in the global *lexical* environment and is in TDZ until
> its script has run. Scoped styles compile OUT to `svelte/bundle.css` (`css: 'external'`), so the
> CSP is unchanged — and Svelte **5** specifically, because Svelte 4 installs transition keyframes
> via `insertRule`, which `style-src 'self'` refuses. The spike island is behind
> `localStorage 'scSvelte' === '1'`, **default off**: it is developer evidence, not product. What
> the spike proves is *feasibility*, not *benefit* — no measured case for porting anything has been
> made yet, so a real panel port is a new decision.
>
> **Mosaic/vgplot is built but DARK** ([`docs/phase-3c/`](docs/phase-3c/)) — a second chart stack
> behind `localStorage 'scMosaic' === '1'`, default off, covering 16 of 28 chart types and falling
> back to Chart.js for the rest. It exists because the *blockers* were real and are now gone, not
> because it earns its keep: queries are already ~12 ms, so Chart.js was never the bottleneck. Do
> not make it the default without a measured reason. **Never render `vg.table()`** — its CSS is
> per-instance dynamic and cannot be pre-extracted, so it violates `style-src` on every update.
>
> **Phase 4 (MapLibre GL) LANDED** (PR #18) — `maplibre-gl` is an intentional dependency, not stray.
> `renderer/hub/mapRender.ts` runs on **MapLibre GL 4.7.1**, pinned to v4 for its UMD and `-csp`
> builds; v6 is ESM-only and would need a bundler this repo does not have. Phase 3 argued against
> "deck.gl/MapLibre" because `@loaders.gl` fetches workers from unpkg.com and a basemap adds a second
> external fetch — **neither applies to MapLibre**: it does not use `@loaders.gl`, its worker loads
> locally from `node_modules` via the `-csp` build, and the style is an inline `version: 8` object
> over the same three OSM hosts, so **the external-fetch surface is unchanged** (one CSP directive
> added, `connect-src`, because MapLibre fetches tiles with the Fetch API rather than `<img>`). The
> *size* half of that objection stands and was accepted: ~1.1 MB shipped against Leaflet's 164 KB.
> There is deliberately **no `glyphs` and no `sprite` URL** — either adds a network host and breaks
> invariant 1. Without glyphs there is no symbol layer, so map value labels are DOM `Marker`s: a bare
> `canvas.toDataURL()` drops them, and export must composite via `capturePage`. Maps now require
> **WebGL2** and must render in the visible hub window, never the offscreen report window.
>
> **The JS implementations are still the reference.** Every resident (SQL) path falls back to the
> pure-JS original on any failure, and each is guarded by *differential* tests that assert the two
> agree. When changing one, change or re-verify the other.

## Project Overview
- **What:** a project-based BI workspace. A **project** holds datasets, visuals, and dashboards under
  `userData/projects/<id>/`: **metadata as JSON, table data as Parquet** (a 500k-row dataset is
  ~0.3 MB of Parquet plus a ~500-byte JSON record). Everything works with **no model configured**;
  AI is a fully-optional add-on.
- **Data sources (`sourceKind`):** `csv | json | paste | xlsx | postgres | url | combined | capture` —
  all 8 reachable. File dialog is **CSV/JSON/XLSX only** (TSV is paste-only); XLSX is **read-only,
  one sheet**; Postgres and URL are **read-only**.
- **Prepare:** an ordered, **reversible** pipeline folded over an immutable source copy (remove a step
  → recompute from source). Calculated fields use a hand-written safe evaluator (no `eval`).
- **Visuals & dashboards:** a visual = dataset + encoding + chart type + style; dashboards place
  visual/text/metric cards on a 12-column multi-page grid with cross-visual filters. Metric numbers
  are computed on the fly, never stored.
- **Screenshot capture (one of the sources).** A vision model returns plain-language analysis PLUS
  structured data; the app computes metrics, writes a number-accurate headline, and offers charts/maps
  + report export. Each capture is a **conversation** — the model is stateless, so follow-ups replay
  the full thread (system prompt + original prompt + screenshot + every prior turn) each turn. The
  extracted table can be projected into a dataset (`sourceKind: 'capture'`).
- **AI (all optional, each gated on a configured model, returns `not_ready` otherwise):** project
  **copilot** chat, suggest transform steps / calculated field / chart, draft dashboard layout,
  dashboard/executive summary, and explain **anomalies** (the detector `src/anomalies.ts` is pure app
  code — IQR+z-score outliers, dominant category, empty-heavy, constant column, period-over-period;
  the model only puts app-found figures into words). `memoryModel` config exists but nothing consumes it.
- **Audience:** developers / local-AI users (fast, private, no-key); benefits non-technical
  people living in dashboards and spreadsheets most.

## Tech Stack
- **Runtime:** Electron 42 (macOS-first; darwin + win32 build targets, linux eventually).
- **Compute/storage engine:** **DuckDB** (`@duckdb/node-api`, a prebuilt N-API module — no
  `electron-rebuild`) behind a **synchronous** bridge in `src/duckdb.ts`: DuckDB lives in a worker
  thread and the main thread blocks on `Atomics.wait` over a growable `SharedArrayBuffer`. There is
  also a non-blocking `queryAsync`/`execAsync` on the same worker and connection, for interactive or
  high-frequency callers — a blocking call freezes all five windows, the menu bar and the hotkey.
  **Storage: Parquet**, all columns VARCHAR with Ordinate's own `ColumnType` kept in the JSON record
  (a typed column would let the sniffer turn `007` into `7`).
- **Language/UI:** TypeScript, **incremental migration** from plain JS (no bundler — `tsc` only);
  vanilla HTML/CSS, no framework. Mixed tree: converted files are `.ts`, the rest still `.js`.
- **Screenshot/hotkey:** `desktopCapturer` + `globalShortcut` (default `CommandOrControl+Alt+S`
  → `⌘⌥S` on macOS; user-configurable).
- **Charts:** Chart.js 4 + plugins (treemap, sankey, matrix, financial, `@sgratzl` boxplot).
  **Maps:** MapLibre GL 4 (WebGL; raster OSM tiles — the one planned external network call).
- **Data sources:** `pg` (pure-JS Postgres, read-only), `exceljs` (XLSX **read-only, single sheet**;
  write side never loaded), plus a hand-written RFC-4180 CSV tokenizer and `https` URL fetch in `src/`.
- **Export:** `pdfmake` (PDF), `docx` (Word), `pptxgenjs` (PPT); dashboards → self-contained HTML
  (inlined Chart.js UMD) + PNG/PDF via offscreen render. **Logos:** `simple-icons`.
- **Key storage:** plaintext in `userData/config.json` (gitignored, **not** encrypted). **Config:** JSON at `userData/config.json` (v2).
  **History:** threads + crops on disk under `userData` (`src/history.js`).

### Two execution modes (`config.executionMode`)
- **`local`** (default) — a **Local CLI** the user already installed. Runnable: Claude Code,
  Antigravity, Codex, Grok, OpenCode, Cursor. The app **detects and runs only — never installs**
  (the "Install" button just opens a vendor URL). Gemini CLI is retired (honest disabled entry).
- **`byok`** — Bring Your Own Key to a cloud API. Families: **anthropic, openai, gemini, gateway**
  (any OpenAI-compatible endpoint — OpenRouter/custom/local servers). Keys stored plaintext per-provider.

## Architecture

### The capture loop
Hotkey (or "New capture") → gate on `config.executionReady()` → `startCapture()` → frozen frame
via `desktopCapturer` on the **display under the cursor** → full-screen overlay dims that screen →
drag a box → `capture:commit` → main crops the frozen frame → the crop (base64 PNG data URL) is
saved to history, shown as a thumbnail, and sent to `analyze()`. If not ready (no CLI/key), the
hub opens to **Execution settings** instead — capture never starts.

### Image delivery
- **BYOK:** crop sent **inline as base64** in the HTTPS body (Anthropic `image` / OpenAI
  `image_url` / Gemini `inline_data`).
- **Local CLI:** crop written to a **temp file** under `userData/tmp/…`; its path is handed to the
  CLI via a prompt hint or a flag (`--add-dir`, `-i`).

### analyze → compute → display (`src/analyze.js`, `calc.js`, `headline.js`)
`analyze(dataUrl)` sends `buildSystemPrompt()` + image, expects ONLY a JSON envelope →
`parseReply()` validates against controlled vocabularies (drops off-list) into `extractedTable`
(raw numbers verbatim), `dataShape`, `columnRoles`, `suggestedCalculations`, number-free
`headline.angle`, `visualizations`, `geo`, `followups` → `calc.js` does the arithmetic →
`headline.js` composes the headline and inserts figures (model forbidden from writing numbers).

### The workspace (projects → datasets → prepare → visuals → dashboards)
- **On-disk stores** — one directory per project under `userData/projects/<id>/`, holding
  `project.json` plus per-record files in `datasets/`, `visuals/`, `dashboards/` (each `<id>.json`).
  A dataset record is **metadata only** (`schemaVersion: 3`); its table lives in a sibling
  `<id>.parquet`, and the immutable prepare source in `<id>.source.parquet` when one exists (keyed on
  `source !== undefined`, **not** on `steps.length` — `updateSteps` snapshots a source even for an
  empty step list). Migration from the old inline-rows format (v2) is **one-way and lazy**, gated on
  the bridge being available so a machine where the native module fails to load keeps working exactly
  as before. `deleteDataset` removes all three files.
  Mirrors `src/history.ts` conventions. **Path-traversal hardening:** every id is a generated UUID,
  validated by a `UUID_RE` regex before it touches a path (dual-UUID guard on `projectId` + record
  id); writes are **atomic** (temp sibling then `rename`); corrupt/unreadable files are skipped, not
  fatal. `src/projects.ts`, `datasets.ts`, `visuals.ts`, `dashboards.ts` own these stores.
- **Sources** — `datasets.ts` stores the parsed table + `sourceKind`. Parsing is centralized in
  `src/parse.ts` (`finalizeTable`, strict `isFiniteNumber` gate so `007`/zips/>15-digit ids stay
  text) and `parseXlsx.ts` (read-only single-sheet via `exceljs`). **`src/connectors/` is a REGISTRY
  of 35 read-only data sources — one connector is one entry, never a union type.** `types.ts` is the
  contract (`ConnectorDef`: fields, `listTables`, `run`); `index.ts` collects the families and
  exposes a renderer-safe `connectorCatalog()`. Wire-compatible sources SHARE an implementation, so
  35 sources cost four pure-JS drivers (~6.7 MB, no ODBC, nothing for a user to download):
  `postgres.ts` 11 (Postgres, **Redshift**, CockroachDB, AlloyDB, Neon, Supabase, Timescale,
  Yugabyte, Materialize, QuestDB, RisingWave) · `mysql.ts` 8 (MySQL, MariaDB, Aurora, SingleStore,
  TiDB, PlanetScale, StarRocks, Doris) · `http.ts` 7 (ClickHouse, Databricks, Trino, Presto,
  Elasticsearch, OpenSearch, Druid — Node `https` only, no dep) · `mssql.ts` 3 · `oracle.ts` 2
  (**Thin mode only — never call `initOracleClient`**) · `local.ts` 3 (DuckDB/Parquet/CSV files) ·
  `url.ts` 1. `connections.ts` stores `{connectorId, values}` (v2; v1 `kind` migrates lazily);
  `connectionRun.ts` dispatches through the registry. **Three rules: read-only, secrets never leave
  main, EVERY query bounded — the old central `LIMIT` wrapper is gone because it breaks five of six
  dialects, so each family caps server-side itself.** `captureDataset.ts` projects a capture's
  `extractedTable` into a reviewable dataset draft.
- **Prepare** — `transforms.ts` folds ordered steps (calculated_field, filter, group_aggregate,
  dedupe, fill_empty, trim, drop_column, rename_column) over an immutable deep copy → reversible;
  unknown step skipped with a warning, never throws. **The filter-operator vocabulary lives in ONE
  place, `filterOps.ts`** — a dependency-free leaf, because the four consumers (`transforms` the JS
  predicate, `sqlGen` the pipeline compiler, `residentQuery` the resident predicate, `ipc/visuals`
  the warning-freedom gate) cannot share it any other way: `transforms → pipelineDuck → sqlGen`, so
  sqlGen value-importing transforms would close a cycle, which is why the list used to be spelled
  out four times. Adding an op to three of four is INVISIBLE — the resident path just returns null
  for the op it doesn't know and the JS fallback answers correctly, ~600× slower, green in CI.
  `in` / `not in` carry their operand in a separate `values?: Cell[]`, never by widening `value` —
  widening would make every stored visual.json/dashboard.json a migration. An empty `values` list
  SKIPS the step with a warning rather than matching zero rows (a filter that blanks the chart the
  instant it is created reads as a bug), and `not in` is the EXACT complement of `in`, which is
  deliberately unlike `!=` — on a number column `=` and `!=` are both false for a null cell, so
  `!=` is not a complement, while a null cell is in no list and therefore survives `not in`.
  `formula.ts` = safe expression evaluator
  (tokenizer + recursive-descent parser + tree-walker, **no `eval`/`new Function`**; div-by-zero /
  type-mismatch / unknown-column → `null`). `combineTables` (append / inner join) is IPC-only.
  `sqlGen.ts` compiles the same `TransformStep[]` into a CTE chain and `pipelineDuck.ts` runs it,
  but that path is **off by default** (`ORDINATE_DUCKDB_PIPELINE=1`): it must load the rows first,
  and the load costs 100× more than the query. It pays off only once a caller works from a resident
  table, which is what the modules below do.
- **Explore** — `datasetStats.ts`: per-column summaries + quality flags (empty_heavy,
  constant_column, duplicate_rows). `statsResident.ts` computes the same answers straight off the
  Parquet in **one statement for all columns**, and `datasetPage.ts` serves the grid **one 500-row
  page at a time** (paged, searched and sorted in SQL) — the grid used to hold every row in renderer
  memory and re-copy it on each keystroke, which is what capped datasets at 50k.
- **Visuals** — `visuals.ts` stores encoding + chart type + style + filters; `vizData.ts`
  (`buildVizData`) is a **pure bridge** producing the exact `{labels, series}` (+ `geo`) that the
  existing `chartRender.buildChart` / `mapRender` already consume. Chart-type ids/labels live in
  `renderResult.ts` (`VIZ_LABELS` = 25 charts + 2 maps + table = 28; `ALL_CHART_TYPE_IDS` full chip
  list gated behind `localStorage 'scAllCharts'==='1'`, else shape-eligible subset via `SHAPE_CHARTS`).
- **Dashboards** — `dashboards.ts` (visual/text/metric cards on a 12-col multi-page grid; metric via
  pure `metricValue.computeMetric`, computed never stored), `dashboardFilters.ts` (dashboard-wide
  cross-visual `FilterStep[]`, merged per card, missing-column filters skipped so one filter spans
  heterogeneous datasets), `dashboardExport.ts` (self-contained HTML with inlined Chart.js UMD read
  off `node_modules`; PNG/PDF via offscreen `reportCapture.ts`; `sanitizeBundle` whitelists the
  export to labels/numbers/strings/`data:image` only — no secrets, no http(s) images).
  **Planned but NOT built (decision only, `docs/analysis/00-model.md`, PR #39):** a QuickSight-style
  split where an **analysis** is the mutable workspace that owns sheets and a **dashboard** is a
  read-only *published snapshot*. On publish each referenced Visual's definition (datasetId,
  chartType, encoding, overrides, filters) is copied **by value** into the card — visuals stay
  project-level, referenced by id, and Parquet is never duplicated. Legacy dashboards survive,
  wrapped lazily on first edit; `normalize()` upgrades in memory and writes nothing. This supersedes
  `draftDashboard`/`dashboard:draft` with `analysis:draft` — but that is a decision record, no
  product code exists yet, so the current IPC and code below still use `dashboard:draft`.
### The resident-query layer (how a question gets answered)

Every one of these queries the stored `.parquet` **in place** and returns `null` on any failure, so
the caller keeps its pure-JS path. That fallback is the safety property — and the hazard: a broken
fast path is not *wrong*, just slow, so each module is paired with a **differential** test that
asserts it matches the JS original value-for-value (with `Object.is`, so `''` can never pass as
`null`), and several also assert *which path ran*.

| module | replaces | measured at 1M rows |
|--------|----------|---------------------|
| `residentQuery.ts` | `metricValue.computeMetric`, the aggregated half of `buildVizData` | metric 1,257 ms → **2 ms**; chart 1,394 ms → **12 ms** |
| `statsResident.ts` | `datasetStats` (+ a bounded row sample for prompts) | 2,227 ms → **73 ms** |
| `anomaliesResident.ts` | `anomalies.detectAnomalies` | 4,511 ms → **328 ms** |
| `datasetPage.ts` | the renderer's in-memory grid | one page in **~11 ms** |
| `parquetStore.ts` | the JSON table blob | 500k rows ≈ **0.3 MB** |
| `datasetView.ts` | — | typed, user-named SQL `VIEW` over the positional store |

**Rules that are not negotiable in this layer:**
- **Cast on the DECLARED type, never inference.** `TRY_CAST('007' AS DOUBLE)` is `7`. Only a
  `number`-typed column is cast; `text`/`date` stay VARCHAR. `sum()` over a text column must stay a
  loud binder error, never a silently wrong figure.
- **Order is never assumed.** A bare `GROUP BY` does not preserve first-seen order, and *whether it
  reorders is machine-dependent* — so every query carries an explicit ordinal
  (`read_parquet(..., file_row_number=true)`) and ends its `ORDER BY` with it. Without a total order,
  paging duplicates and drops rows.
- **Empty means `null` OR `''` OR whitespace**, matching JS. DuckDB's `trim()` strips NBSP but not
  tab, and RE2's `\s` does the opposite, so the whitespace class is spelled out explicitly.
- **Prefer `CASE WHEN … THEN v END` over `FILTER (WHERE …)`.** Per-column `FILTER` clauses cost
  16× more at width — this was a real regression (57 s on a 1,000-column table).
- **Choosing the fast path is a cost model, not a flag.** Thresholds live at the call site and are
  documented with the measurements that produced them; anomalies needs a width term as well as a row
  term, because its cost scales with column count.
- Every aggregate is `CAST(… AS DOUBLE)` — `SUM(INTEGER)` is HUGEINT and reaches JS as a **BigInt**.

**Known divergences**, pinned by tests rather than hidden: parallel float summation differs from a
JS left-fold in the last ULPs (~1e-13), and quantile interpolation by ~1e-15. Neither reaches a
rendered figure, but `mean` enters AI prompts unrounded. A leading U+FEFF is lost on every string
the bridge returns — an upstream `@duckdb/node-api` bug, worked around in `parquetStore` only.

- **AI (optional)** — `copilot.ts` (`askCopilot`: per-project `copilot.json` thread, 200-turn cap;
  main builds an app-computed FACTS block, model narrates only those), plus `suggestSteps`,
  `suggestCalcField`, `suggestChart`, `draftDashboard`, `summarizeDashboard`, and
  `anomalies.detectAnomalies` (pure detector; model only explains). Each returns `not_ready` with no
  model. `copilotEnabled` is a hard on/off switch (default true).

### Windows (all inline panels live in the hub; no extra BrowserWindow for settings)
| Window | Renderer | Preload → bridge | Factory (`src/windows/`) |
|--------|----------|------------------|--------------------------|
| Hub | `renderer/hub/` | `hubPreload` → `window.hub` | `hubWindow.js` |
| Overlay | `renderer/overlay/` | `overlayPreload` → `window.overlay` | `overlayWindow.js` |

**Two windows, not five.** About and Permission were separate `BrowserWindow`s once; the
single-window redesign replaced them with inline hub panels and their factories, preloads and
renderers were never instantiated again. All of it (`renderer/about/`, `renderer/permission/`,
`src/windows/{about,permission}Window.ts`, `preload/{about,permission}Preload.ts` — 683 lines)
was deleted. `main.ts`'s `openPermission()` has always driven the hub panel, not a window.

**Status went the same way.** It was documented as a "small always-present window that tells the
user the hotkey", but after the single-window redesign nothing opened it except one path: the
capture overlay's `did-fail-load` handler, via a `pushStatus()` with exactly one caller. A 400×320
`BrowserWindow` plus a preload and a renderer (261 lines) existed to show one error string. That
error is now `dialog.showErrorBox` in `main.ts` — native, needs no window, and works when the hub
is closed, which was the only real argument for a separate window. `renderer/status/`,
`src/windows/statusWindow.ts`, `preload/statusPreload.ts` and the `status:state` channel are gone.

Settings/About/Permission are fixed full-window overlay panels inside the hub (`#settings-panel`
with `#ex-local-panel`/`#ex-byok-panel`, `#about-panel`, `#permission-panel`), shown via
`hub:open-settings`; back returns to the hub view. The permission panel has two entry points, both
wired in `hub.ts`: the `hub:show-permission` push (sent by `openPermission()` when a capture is
blocked, consumed via `onShowPermission`) and Settings → General → "Test permission screen".

### Result surface
Thumbnail (→ lightbox), headline + analysis, a chart or MapLibre map with a `⋯` menu
(Values/Periods/customize), follow-up chips + input, and report export (PDF/Word/PPT — charts
and maps). A disk-persisted history rail lists captures (newest first); clicking restores its thread.

### Code layout
- **Main:** `main.ts` (emits `main.js`) = entry/lifecycle/hotkey/capture loop/windows. Logic in `src/` modules:
  DuckDB layer (`duckdb, duckdbWorker, duckdbEngine, duckdbSidecar, duckdbSidecarChild,
  parquetStore, sqlGen, pipelineDuck, residentQuery, statsResident, anomaliesResident,
  datasetPage, datasetView`);
  capture path (`analyze, calc, headline, capture, config, history, hotkey, localCli, localCliRun,
  models, icons, userPath, disclaim`); workspace (`projects, datasets, parse, parseXlsx,
  connections, connectionRun, captureDataset, transforms, filterOps, formula, datasetStats, visuals, vizData,
  dashboards, dashboardFilters, metricValue, dashboardExport, reportCapture`); AI (`copilot,
  anomalies`). **IPC** split into `src/ipc/*.ts`, each exporting `register(deps)`, wired in
  `main.js`. Add new IPC to the matching `src/ipc` module, not `main.js`.
- **Renderer (hub):** many `<script>` files sharing one global scope (call-time resolution, so
  load order is irrelevant): capture surface — `hub.js` (shell/state/error card), `renderResult.js`
  (result + chart-type picker), `chartRender.js` (buildChart), `chartControls.js`
  (Values/Periods/customize), `plotRender.js` (the dark Mosaic/vgplot stack — `renderVizInArea`'s
  one extra branch; falls back to Chart.js on anything it can't draw), `mapRender.js` (MapLibre GL),
  `reportExport.js` (export + map→PNG),
  `execMenu.js`, `settingsPanels.js` (Local CLI + BYOK), `customDropdown.js`, `geoMatch.js`,
  `filterValues.js` + `filterDialog.js` (**ONE type-aware filter dialog, three call sites** —
  `encodingForm` the visual FILTERS well, `prepare` the pipeline step, `dashboards` the sheet filter
  bar. Text → a checkbox list of distinct values with a SERVER-SIDE search; number → min/max
  compiling to two AND-ed steps; date → from/to. Relative dates are deliberately out of scope.
  A `date` column is stored as its ORIGINAL STRING and compared lexicographically, so the native
  `<input type=date>` is offered only when the stored values are actually ISO — on `MM/DD/YYYY` data
  an ISO picker would build a confidently wrong filter);
  workspace — `workspace.js` (nav/shell), `projects.js`, `datasets.js`, `prepare.js`, `visuals.js`,
  `dashboards.js`, `connections.js`, `captureDataset.js`, `copilot.js`. Shared globals in
  `renderer/hub/globals.d.ts` (+ `globals.hub-c.d.ts`).

### IPC surface (representative — full set in `src/ipc/*` + `main.js`)
Renderer→main: `invoke` (reply) or `send` (fire-and-forget); main→renderer: `webContents.send`.

| Area | Channels |
|------|----------|
| Capture | `capture:commit`/`:cancel`, `overlay:frame`, `hub:capture`, `hub:captureRegion` (map→PNG) |
| Results | `hub:new-entry`, `hub:entry-result`, `hub:followup`(+`-result`), `hub:retry`, `hub:saveChartOverrides` |
| Projects | `projects:list`/`:create`/`:open`/`:rename`/`:delete` |
| Datasets/Prepare | `dataset:pickAndParse`/`:parsePaste`/`:get`/`:list`/`:save`/`:update`/`:delete`/`:combine`, `dataset:addStep`/`:updateStep`/`:removeStep`/`:reorderSteps`/`:setSteps`, `dataset:stats`/`:explain`, `dataset:suggestSteps`/`:suggestCalcField`, **`dataset:meta`** (rows-free open), **`dataset:page`** (one grid window: offset/limit/search/sort), **`dataset:distinct`** (one column's distinct values — capped, **searched in SQL**, and returning the pre-cap `total` so the filter picker can say "showing the first N of M"), `captureDataset:draft`/`:save` |
| Connections | `connectors:catalog` (renderer-safe source list), `connections:list`, `connection:testAndSave`/`:listTables`/`:run`/`:refresh`/`:delete` |
| Visuals | `visual:get`/`:list`/`:save`/`:update`/`:duplicate`/`:delete`/`:data`/`:suggest` |
| Mosaic (dark) | `mosaic:view` (ensure a typed view over the Parquet), `mosaic:query` (one statement, **async bridge only**) |
| Dashboards | `dashboard:get`/`:list`/`:save`/`:update`/`:delete`/`:metric`/`:draft`/`:summary`/`:explainAnomalies`, `dashboard:exportHtml`/`:exportPng`/`:exportPdf`/`:revealFolder` |
| Copilot | `copilot:ask`/`:history`/`:clear`/`:setEnabled` |
| Exec/BYOK | `exec:setMode`, `byok:saveProvider`/`:test`/`:activate`/`:revealKey`, `key:status`/`:save`/`:clear`/`:validate`/`:models`, `local:save`, `provider:activate`, `model:save`, `rules:set`, `memory:setModel` |
| Local CLI | `cli:detect`/`:detectOne`/`:setActive`/`:test`/`:models`/`:saveModel`, `models:list` |
| History/export | `history:load`/`:delete`, `data:delete`, `hub:history`, `hub:saveImage`/`:savePdf`/`:saveDocx`/`:savePptx`/`:captureReport`, `hub:copy`/`:copyText` |
| Theme/notif/hotkey | `theme:getPreference`/`:setPreference`/apply, `notifications:bootstrap`/`:set`, `hotkey:save`/`:label`, `hub:hotkey-state`, `hub:open`/`:open-settings`/`:show-permission`, `shell:open`, `provider:logos`/`agent:logos`, `permission:open-settings` |

### Config (`src/config.js`) — main process only, schema v2
`DEFAULTS` is the source of truth: `executionMode`, `activeProvider`, `byok` (per-provider
`{apiKey, baseUrl, maxTokens, model, verified}`), `localCli` (`{activeId, lastDetection, models}`),
`memoryModel` (integration point, no memory step yet), `copilotEnabled` (default true),
`connectionSecrets` (per-connection Postgres passwords / URL bearer tokens — **secrets never leave
main**: stripped from connection metadata + error strings, never sent to a renderer or written to a
shareable project folder/export), `modelCache`, `hotkey`, `theme`/`themePreference`, `globalRules`,
`notifications`. `sanitize()` whitelists plain fields; keys/BYOK/CLI/secrets use dedicated setters.
`publicConfig()`/`publicByok()` are the only renderer-safe views — they add status booleans and
**strip every raw key/secret**. `executionReady()` gates capture. v1 flat config migrates to v2 on load.

## Coding Conventions
- **TypeScript, incremental (in-place sibling emit).** New files are `.ts`; when materially
  touching an old `.js`, convert it: same directory, `foo.js` → `foo.ts`, `npm run build:ts`
  (tsc, no bundler) emits the sibling `foo.js`, and that emitted path gets an explicit
  `.gitignore` entry. require paths / `<script src>` tags / electron-builder config never change.
  Two worlds, two configs: `tsconfig.main.json` (main/src/preload/scripts — NodeNext CommonJS,
  node types) and `tsconfig.renderer.json` (DOM, no node types). **`strict` is on in the MAIN
  world only.** `tsconfig.renderer.json` sets `"strict": false` — `noImplicitAny` and
  `strictNullChecks` are off across all ~15,800 renderer lines, deliberately, so the DOM-heavy
  legacy layer compiles without hundreds of casts. This file used to claim strict was on
  everywhere; it was wrong about half the codebase. That relaxation is why the renderer carries
  146 lint findings the main world does not, and why they are turned off in a named override in
  `.oxlintrc.json` rather than pretended away — they unlock when `strict` comes back on. No `any`
  without a comment. Renderer files stay **global-scope scripts** — no import/export in renderer
  `.ts` (shared globals are declared in `renderer/hub/globals.d.ts`).
  `prestart`/`pretest`/`predist:*` compile automatically.
- **Lint is a real gate.** `npm run lint` = **oxlint**, type-aware, over the main world and the
  renderer; the tree is at **zero findings** and CI fails a PR that adds one. Not
  `typescript-eslint` — it refuses TS 7 at runtime (this repo is on 7.0.2); oxlint's type-aware
  engine is `tsgolint`, built on the TS 7 native compiler. Prettier stays **advisory**
  (`continue-on-error`): 238 files are unformatted and normalising them is a whole-tree diff.
- **Heavy vendor bundles load on FIRST USE, not at hub open** (`renderer/hub/lazyScript.ts`):
  pdfmake+fonts, pptxgenjs, docx, and MapLibre+GeoJSON — 4,346K of the former 5,476K eager
  payload, now 1,130K. `ensureBundle(name)` before the call site's existing "engine not loaded"
  guard. A dynamic same-origin `<script src>` is not inline, so the CSP is unchanged. **`async =
  false` is load-bearing** — two groups are order-dependent (`mapWorker.js` after the MapLibre
  UMD; `vfs_fonts.js` after pdfmake) and a dynamically inserted script defaults to async. Chart.js
  stays eager. vgplot has deferred itself since Phase 3c; `svelte/bundle.js` is eager on purpose.
- Unconverted plain JS keeps `'use strict'` everywhere. `contextIsolation: true`,
  `nodeIntegration: false` — all renderer↔main via `contextBridge` + IPC, never direct Node from
  a renderer.
- `invoke`/`handle` for request/response; `send`/`on` for fire-and-forget. New handlers go in the
  matching `src/ipc/*` `register()`. Renderer reads `window.<bridge>.*` (hub → `window.hub`).
- Hub CSP is strict (`default-src 'none'; style-src 'self'; script-src 'self'; img-src data: file:
  <OSM hosts>`): **no inline `style=` in hub HTML** — use `hub.css` classes (JS `element.style.x`
  IS allowed and used).
- Local CLI execution is shell-free: `execFile`/`spawn` with an **args array, never `shell:true`**;
  no user/AI/config string ever becomes a command.

## File Placement
`main.js` → app/IPC wiring/windows. `src/` → main-process modules (capture path + workspace
`projects/datasets/parse/parseXlsx/connections/connectionRun/captureDataset/transforms/formula/
datasetStats/visuals/vizData/dashboards/dashboardFilters/metricValue/dashboardExport/reportCapture`
+ AI `copilot/anomalies`); `src/ipc/` → one file per area (`register()`); `src/windows/` →
BrowserWindow factories. On-disk workspace stores live under `userData/projects/<id>/` (`project.json`
+ `datasets/`, `visuals/`, `dashboards/` per-record JSON). `renderer/{hub,overlay,status,about,
permission}/` → windows (hub is the multi-`<script>` split above, incl. workspace scripts
`workspace/projects/datasets/prepare/visuals/dashboards/connections/captureDataset/copilot`);
`renderer/theme.css` → shared CSS vars. `preload/` → one contextBridge per window. `scripts/` →
build + `test-*.js` self-checks (not shipped). `assets/`, `geo/` → icons + GeoJSON (fetched on
postinstall).

## UI and Design
- Overlay dims the display under the cursor (multi-monitor aware) behind a drag-box selector.
- Single window: settings/about/permission are inline overlay panels, never a new window.
- Charts (Chart.js) for tabular data; MapLibre GL for genuinely geographic data (`map_bubble`/
  `map_choropleth`). Chart-type picker = Recommended / Selected / + More; grouped data supports
  Values/Periods and small multiples where it fits.
- Theming: system/light/dark (`themePreference`); `data-theme` on `<html>`, CSS vars in
  `theme.css`. Brand/badge colors are CSS classes (CSP forbids inline styles).

## Security
- Keys stored **plaintext** in `userData/config.json` (gitignored, not encrypted) — but **never
  logged or sent to a renderer**. Renderers get only `hasKey`/status. Renderer key validation is a
  **format check only, no network**.
- Local CLI: **detect and run only — NEVER install** (no `npm/brew/curl`, no shell). Detection
  resolves binaries on PATH + known bin dirs and runs `<bin> --version`.
- Local/private is a core promise: no telemetry, no surprise network calls — data goes only to the
  user's configured endpoint (or stays fully local with a local CLI). OSM tiles are the one
  declared external fetch, only when a map is shown.
- Don't build out-of-scope features unprompted.

## Content Guidelines
Plain-language, concrete, insight-first (e.g. "Revenue's up 12%, but it's all one client —
concentration risk."), not jargon. All figures are computed by the app.

## Testing and Commands
- **Priority test:** local vision model accuracy on real screenshots. Node self-checks in
  `scripts/test-*.js` (pure logic, no framework) via `npm test` (**56 self-check files**, thousands
  of assertions — 7 of them the per-family connector suites, plus `duckdbSidecar` and `cssVars`); add one per
  non-trivial helper. **Adding a suite needs no wiring**: `npm test` is
  `node --test "scripts/test-*.js"` and the glob finds it. It was a 53-long `&&` chain until
  2026-08-04, which meant the FIRST failure hid every one after it; the runner now reports all 56
  every run, in parallel (45.9s → 28.5s). `npm run test:coverage` adds
  `--experimental-test-coverage`, which the chain could not do at all.
- **Differential tests are the house style for anything with two implementations.** A resident-SQL
  module is tested by running the SAME input through it and through the pure-JS original and
  comparing with `Object.is` — not against hand-written expected values. Several also spy on
  `datasets.getDataset` to assert the table was *never hydrated*, so a fast path that silently stops
  firing fails loudly instead of passing green and inert.
- **A fast path that stops firing is now loud at RUNTIME too**, not only in tests
  (`src/residentTrace.ts`). Every resident module returns `null` on failure and the caller quietly
  hydrates in JS — correct, but a ~600× slowdown that ships green. Each of the seven call sites
  records `resident` / `skipped` (a deliberate decision: no bridge, not resident, or below the cost
  threshold — counted, silent) / `failed` (attempted and came back null anyway — **warns**, once per
  op per process). `failed` should be zero on every machine; a threshold change shows up as
  `skipped` instead.
- **`npm run smoke` is the only check that runs the actual app.** It launches Electron via
  Playwright's `_electron` driver, saves a **1,000,000-row** dataset, opens the project from the
  rendered UI, asserts the dataset is visible with its row count, and fails on **any** renderer
  console error. That last rule is what catches a blocked inline style — a CSP violation that made
  two hub banners paint visible on every load survived 2,400 passing assertions, because nothing
  else rendered the page. Note the first paint is a **splash screen**: a screenshot taken there
  passes every size and DOM check while proving nothing.
- **CI** (`.github/workflows/ci.yml`) runs type-check + `npm test` + the smoke test on every PR to
  `develop`; `lint.yml` runs `npm run lint` (**blocking**) and Prettier (**advisory**, and labelled
  as such in the job name — an advisory job that can never go green is noise); `build.yml` builds
  both installers on real runners (tag or manual dispatch).

```bash
npm start          # run the app (no dev build step)
npm run smoke      # launch the REAL app and drive it (see below)
npm test           # node --test over scripts/test-*.js — all 56, parallel, all reported
npm run test:coverage  # same, with --experimental-test-coverage
npm run lint       # oxlint, type-aware, main + renderer. BLOCKING in CI, zero findings
npm run dist:mac   # macOS dmg (electron-builder)
npm run dist:win   # Windows installer/zip
npm run icons:verify   # verify logos vs installed simple-icons
npm run build:vendor   # regenerate renderer/hub/vendor/* (vgplot bundle + plot.css)
```
`build:vendor` is **not** part of any other script. `renderer/hub/vendor/vgplot.js` and `plot.css`
are **committed build artifacts** — that is what keeps CI and `electron-builder` from needing the
181 MB Mosaic dependency tree, none of which is in `package.json`. It installs into a scratch dir
outside the repo (never `node_modules`), strips Observable Plot's three `<style>` injections so the
hub CSP needs no hash or nonce, and stubs `@duckdb/duckdb-wasm` (which otherwise drags in
`new Function(` and `cdn.jsdelivr.net` URLs). It **exits non-zero** if any of those patches stops
applying — a Plot version bump breaks the build, loudly, rather than the running app, silently.
Benchmarks: `npm run bench:pipeline` (10k/100k/1M, diffable before/after) and
`npm run bench:resident`. Their recorded baselines live in `docs/phase-1/`.

`postinstall` fetches map GeoJSON (`scripts/download-geo.js`). `npm run build:ts` compiles the
converted `.ts` files in place (runs automatically via `prestart`/`pretest`/`predist:*`);
unconverted JS loads directly. The only other "build" is packaging installers.

## Git and commits
- **Branch from `develop` for every change.** `develop` is this repo's **default branch** and the
  trunk all work merges into; `main` sits at the initial import and is not used. Each new feature or
  fix starts on a fresh branch off an up-to-date `develop` (`fix/...`, `feat/...`, `perf/...`,
  `test/...`, `docs/...`), is committed there, then pushed and merged via a pull request.
  **Never commit directly to `develop`.** Note `ci.yml`/`lint.yml` watch `[develop, main]`, and that
  list is the third thing to break this way: it watched `dev` (never existed), then an earlier trunk
  name, before the trunk settled on `develop` — each time CI silently stopped running rather than failing.
  **Renaming the trunk means editing those two lists in the same commit.** A local clone also keeps
  the old upstream (`branch.<name>.merge`) and has to be repointed by hand:
  `git branch --set-upstream-to=origin/develop develop`.
- **Never** add a `Co-Authored-By: Claude …` trailer (or any AI co-author line) to commit
  messages. Write the title + body and stop — no trailer.

## Out of scope (don't build unprompted)
**From the DuckDB brief, deliberately not built** — each argued from measurements in
[`docs/phase-3/README.md`](docs/phase-3/README.md), so re-litigate with numbers, not opinion:
deck.gl (`@loaders.gl` defaults to fetching workers from unpkg.com — MapLibre avoids this and shipped
in Phase 4, PR #18). Apache Arrow is not achievable with the current binding.

**The Tauri shell was costed in [`docs/phase-6/`](docs/phase-6/) (PR #27) and the recommendation is
to CLOSE it** — not deferred, closed. Re-litigate only with new numbers: the size case is weaker than
it looks (Electron is 48% of a 561 MB install; a stripped single-arch `libduckdb.dylib` is 45.7 MiB
against 112 MiB fat), security comes out net negative for this app (2 invariants strengthened, 4
weakened; `contextIsolation` has no equivalent and `app.emit()` broadcasts to all windows), and half
the test suite loses its oracle. The Local CLI path would have to bypass Tauri's capability system
entirely. **Its one good idea — DuckDB in a sidecar — is an Electron refactor and does not need
Tauri.**
The **Svelte renderer** moved out of this list in Phase 5 — but only as far as a *spike*: porting a
real panel, or letting a component render unflagged, is still a new decision needing a measured
case ([`docs/phase-5/`](docs/phase-5/)).

**Built but deliberately dark:** Mosaic + vgplot ([`docs/phase-3c/`](docs/phase-3c/)). Turning it on
by default, mapping style overrides / the `⋯` menu to Plot, or moving filters into renderer SQL are
all *new* decisions needing their own justification — the measured case for the stack still has not
been made. `vg.table()` and anything else from `@uwdata/mosaic-inputs` are off-limits under the CSP.

Also out of scope: installing CLIs for the user, a hosted/central-server web version, a marketing website,
spreadsheet export, and a full memory/summarization step (`memoryModel` config exists as an
integration point but nothing consumes it yet). Ask before adding runtime dependencies — prefer
stdlib / native platform features / already-installed deps.
