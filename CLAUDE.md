# Ordinate

A **local-first, open-source personal BI workspace.** Bring data in (files, paste, Excel, 35 SQL/HTTP
sources, URL, or a screenshot capture) → **prepare** it with a reversible pipeline → **visualize**
across 28 chart & map types → assemble **dashboards** → **share** offline. MIT, model-agnostic.

**Core principle: the app does the math.** All aggregation, stats, metrics and anomaly detection run
in pure main-process code; a model only *extracts structure* (a table from a screenshot) or
*narrates figures the app already computed*. It **never** writes a computed number.

**Naming.** Screenchart → Ordinate. Screenchart is now one *data source* (screenshot capture), not
the product. `package.json` keeps `name`/`productName: "Screenchart"` — changing them moves
Electron's `userData` and orphans existing config, history and projects, so that is a migration, not
a rename. The built macOS bundle is still `Screenchart.app`, which is why the permission panel and
notification text still say Screenchart: they name rows in macOS System Settings.

**History lives in `docs/`, not here.** Phases 0–3c (DuckDB), 4 (MapLibre), 5 (Svelte), 6 (Tauri,
costed and CLOSED) each have a `docs/phase-*/` write-up with the measurements behind every decision.
Re-litigate with numbers, not opinion.

## Architecture

- **Storage is Parquet.** A dataset record is metadata-only JSON; the table lives in a sibling
  `<id>.parquet`, plus `<id>.source.parquet` for the immutable prepare source. 500k rows ≈ 0.3 MB.
  Row cap **1,000,000**. Per-project directories under `userData/projects/<id>/`.
- **DuckDB** (`@duckdb/node-api`, prebuilt N-API, no `electron-rebuild`) behind a **synchronous**
  bridge in `src/duckdb.ts`: DuckDB runs in a worker and the main thread blocks on `Atomics.wait`
  over a growable `SharedArrayBuffer`. `queryAsync`/`execAsync` exist on the same connection for
  interactive callers — **a blocking call freezes all windows, the menu bar and the hotkey.**
  All columns are stored VARCHAR with Ordinate's own `ColumnType` in the JSON record; a typed column
  would let the sniffer turn `007` into `7`.
- **A sidecar (`duckdbSidecar.ts` + `duckdbSidecarChild.ts`) is BUILT but NOT adopted.** It proves
  the sync API survives a process boundary. It is **not** a speedup. Adopting it is a new decision.

### The resident-query layer

`residentQuery` (metrics + aggregated charts), `statsResident`, `anomaliesResident`, `datasetPage`,
`parquetStore`, `datasetView` all query the stored Parquet **in place** — no table is materialised
to answer a question. Each returns `null` on any failure and the caller falls back to the pure-JS
original. **The JS implementations are the reference**, so changing one means changing or
re-verifying the other; every module is paired with a *differential* test comparing the two with
`Object.is`. A broken fast path is not wrong, only ~600× slower, so `src/residentTrace.ts` also
records `resident`/`skipped`/`failed` per call site and warns once per op on `failed`.

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
`@duckdb/node-api` bug, worked around in `parquetStore` only).

### Workspace

- **Sources** — `src/parse.ts` centralises parsing (strict `isFiniteNumber`, so `007`, zips and
  >15-digit ids stay text). **`src/connectors/` is a REGISTRY of 35 read-only sources — one
  connector is one entry, never a union type**; wire-compatible sources share a driver
  (`postgres.ts` 11, `mysql.ts` 8, `http.ts` 7, `mssql.ts` 3, `oracle.ts` 2 **thin mode only, never
  `initOracleClient`**, `local.ts` 3, `url.ts` 1). **Three rules: read-only, secrets never leave
  main, EVERY query bounded server-side** — the old central `LIMIT` wrapper is gone because it broke
  five of six dialects.
- **Prepare** — `transforms.ts` folds ordered steps over an immutable copy, so removing a step
  recomputes from source. Unknown step is skipped with a warning, never throws. `formula.ts` is a
  hand-written tokenizer + parser + tree-walker — **no `eval`, no `new Function`, ever.**
  `sqlGen`/`pipelineDuck` compile the same steps to SQL but are **off by default**
  (`ORDINATE_DUCKDB_PIPELINE=1`): loading the rows costs 100× the query.
- **Visuals / dashboards** — `vizData.buildVizData` is a pure bridge to the `{labels, series}` that
  `chartRender`/`mapRender` already consume. Chart ids live in `renderResult.ts` (`VIZ_LABELS` = 28).
  Dashboard metric numbers are computed on the fly, never stored. `dashboardExport.sanitizeBundle`
  is a **security control**: whitelist to labels/numbers/strings/`data:image` only.
- **Analyses** — the QuickSight-style split (analysis = mutable authoring surface, dashboard =
  published read-only snapshot, copied **by value** on publish). Spec: `docs/analysis/00-model.md`.
- **AI (all optional, `not_ready` without a model)** — copilot, suggest steps/calc-field/chart,
  draft layout, summaries, and *explaining* anomalies. `src/anomalies.ts` is a pure detector; the
  model only puts app-found figures into words.

### Windows, renderer, IPC

**Two windows: hub and overlay.** Settings/About/Permission are inline full-window panels in the
hub, not `BrowserWindow`s. Renderer files are **global-scope classic scripts** — no import/export;
shared globals are declared in `renderer/hub/globals.d.ts`.

IPC: `invoke`/`handle` for request-response, `send`/`on` for fire-and-forget. **New handlers go in
the matching `src/ipc/*.ts` `register(deps)`, never in `main.js`.** Renderers reach main only via
`contextBridge` (`contextIsolation: true`, `nodeIntegration: false`).

**Config** (`src/config.js`, main only, v2): `publicConfig()`/`publicByok()` are the only
renderer-safe views and strip every raw key and secret. `executionReady()` gates capture.

### Charts and maps

- **Chart.js 4** is the default stack. **Mosaic/vgplot is built but DARK** (`localStorage
  'scMosaic'`): queries are already ~12 ms, so Chart.js was never the bottleneck — do not default it
  without a measured reason. **Never render `vg.table()`**: its per-instance CSS violates
  `style-src` on every update.
- **MapLibre GL 4.7.1**, pinned to v4 for its UMD and `-csp` builds (v6 is ESM-only and needs a
  bundler this repo does not have). **No `glyphs` and no `sprite` URL** — either adds a network host.
  Without glyphs there is no symbol layer, so value labels are DOM `Marker`s: `canvas.toDataURL()`
  drops them and export must composite via `capturePage`. Maps need **WebGL2** and must render in
  the visible hub window, never the offscreen report window.
- **Svelte 5 is a TOOLCHAIN SPIKE**, default off (`localStorage 'scSvelte'`). Feasibility, not
  benefit — porting a real panel is a new decision.

## Conventions

- **TypeScript, incremental, in-place sibling emit.** New files are `.ts`; materially touching an old
  `.js` means converting it. `npm run build:ts` (tsc, **no bundler**) emits the sibling `.js`, which
  gets an explicit `.gitignore` entry; require paths and `<script src>` never change.
- **`strict` is on in the MAIN world only.** `tsconfig.renderer.json` sets `"strict": false`
  deliberately, so the DOM-heavy legacy layer compiles without hundreds of casts. That is why the
  renderer carries 146 lint findings disabled in a named `.oxlintrc.json` override rather than
  pretended away — they unlock when strict comes back. No `any` without a comment.
- **Lint is a real gate.** `npm run lint` = oxlint, type-aware, zero findings, blocking in CI. Not
  `typescript-eslint`, which refuses TS 7. Prettier stays advisory.
- **Hub CSP is strict** (`default-src 'none'; style-src 'self'; script-src 'self'`): **no inline
  `style=` in hub HTML** — use `hub.css` classes. `element.style.x` from JS is fine.
- **Heavy vendor bundles load on FIRST USE** (`lazyScript.ts`): pdfmake, pptxgenjs, docx, MapLibre.
  **`async = false` is load-bearing** — two groups are order-dependent and dynamic scripts default
  to async.
- **Local CLI execution is shell-free:** `execFile`/`spawn` with an **args array, never
  `shell: true`**. No user, model or config string ever becomes a command.
- **Keys are plaintext in `userData/config.json`** (gitignored) but **never logged or sent to a
  renderer**. Renderers get `hasKey`/status only. Renderer key validation is format-only, no network.
- **Detect and run CLIs, NEVER install** (no npm/brew/curl). No telemetry, no surprise network calls.
  OSM tiles are the one declared external fetch, only when a map is shown.
- **Path hardening:** every record id is a generated UUID validated by `UUID_RE` before it touches a
  path; writes are atomic (temp sibling then rename); corrupt files are skipped, never fatal.

## File placement

`main.ts` → app/IPC wiring/windows. `src/` → main-process modules. `src/ipc/` → one file per area.
`src/windows/` → BrowserWindow factories. `renderer/{hub,overlay}/` → windows.
`renderer/theme.css` → shared CSS vars. `preload/` → one contextBridge per window.
`scripts/` → build + `test-*.js` self-checks. `assets/`, `geo/` → icons + GeoJSON.

## Testing

- **56 self-check files**, pure logic, no framework: `npm test` is `node --test "scripts/test-*.js"`,
  so **adding a suite needs no wiring**. All 56 report every run, in parallel.
- **Differential tests are the house style.** Two implementations means asserting they agree with
  `Object.is`, not against hand-written values. Several also spy on `datasets.getDataset` to prove
  the table was never hydrated, so a fast path that stops firing fails loudly instead of passing
  green and inert.
- **`npm run smoke` is the only check that runs the real app.** It drives Electron via Playwright,
  saves a 1M-row dataset, opens it from the rendered UI, and **fails on any renderer console
  error** — which is what catches a CSP violation. Note the first paint is a splash screen: a
  screenshot taken there passes every size and DOM check while proving nothing.
- **CI** (`.github/workflows/`) runs type-check + tests + smoke, and `lint.yml` blocking, on every
  PR to `develop`.

```bash
npm start          # run the app
npm run smoke      # launch the REAL app and drive it
npm test           # all 56 suites, parallel
npm run lint       # oxlint — BLOCKING, zero findings
npm run dist:mac   # / dist:win — installers
npm run build:appicon   # regenerate icon.png/.icns/.ico from assets/icons/ordinate.svg
```

`renderer/hub/vendor/vgplot.js` + `plot.css` are **committed build artifacts** (`npm run
build:vendor`), which is what keeps CI and electron-builder from needing the 181 MB Mosaic tree.
`postinstall` fetches map GeoJSON. `prestart`/`pretest`/`predist:*` compile automatically.

## Git

- **Every change gets its own worktree off `develop`** (`git worktree add -b feat/x ../ordinate-x
  origin/develop`), then PR → **CI green** → merge → remove the worktree → `git pull` on `develop`.
  Never commit to `develop` directly; a plain `checkout` in this shared clone moves the tree under
  other running sessions, which has already cost work here.
- A PR showing **no checks at all** is not a passing PR — that is what a stale branch filter in
  `ci.yml`/`lint.yml` looks like, and it has now happened twice. Renaming the trunk means editing
  both `branches:` lists in the same commit.
- **Never** add a `Co-Authored-By` or any AI co-author trailer to a commit message.

## Out of scope (don't build unprompted)

deck.gl (`@loaders.gl` fetches workers from unpkg.com); Apache Arrow (not achievable with the
current binding); the Tauri shell (costed and closed — `docs/phase-6/`); making Mosaic the default;
`vg.table()` and `@uwdata/mosaic-inputs`; installing CLIs for the user; a hosted web version; a
marketing site; spreadsheet export; a memory/summarization step (`memoryModel` exists, nothing
consumes it). **Ask before adding a runtime dependency** — prefer stdlib, native platform features,
or something already installed.
