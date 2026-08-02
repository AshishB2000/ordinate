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

> **Phase 4 (MapLibre GL) is IN PROGRESS on `feat/phase-4-maplibre` — the `maplibre-gl` dependency
> is intentional.** An audit pass already stashed it once as "stray … contradicts phase-3 §3"; it is
> not stray. `renderer/hub/mapRender.ts` has been ported from Leaflet to **MapLibre GL 4.7.1**,
> pinned to v4 for its UMD + `-csp` builds (v6 is ESM-only and needs a bundler this repo does not
> have). **The external-fetch surface is unchanged:** an inline `version: 8` style object with one
> raster source over the same three `a|b|c.tile.openstreetmap.org` hosts, and deliberately **no
> `glyphs` and no `sprite` URL** — both would add a network host and break invariant 1. Because
> there are no glyphs, map value labels are DOM `Marker`s rather than a symbol layer, so a bare
> `canvas.toDataURL()` loses them; export must go through `capturePage`. Maps now require **WebGL2**
> and must render in the visible hub window, never the offscreen report window.
>
> **Note for whoever merges `docs/architecture-after-duckdb`:** its CLAUDE.md lists "deck.gl/MapLibre"
> under *not built, argued against*. That line is what triggered the stash and must be amended when
> that branch lands. Per [`docs/phase-3b/README.md`](docs/phase-3b/README.md), Mosaic is likewise
> mis-filed there as rejected when it is actually unblocked with only B1/B2 outstanding.

> **Architecture direction (planned — NOT built).** A migration to DuckDB + Apache Arrow + Mosaic +
> WebGL charts + Tauri is specified in [`.claude/plans/rewrite-to-duckdb-stack.md`](.claude/plans/rewrite-to-duckdb-stack.md).
> **Everything below this line describes the code as it exists today** and remains the source of
> truth until a migration phase lands. Update this file as each phase completes — do not describe
> the target stack here before it is real.

## Project Overview
- **What:** a project-based BI workspace. A **project** holds datasets, visuals, and dashboards, all
  as plain JSON on disk. Everything works with **no model configured**; AI is a fully-optional add-on.
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
- **Language/UI:** TypeScript, **incremental migration** from plain JS (no bundler — `tsc` only);
  vanilla HTML/CSS, no framework. Mixed tree: converted files are `.ts`, the rest still `.js`.
- **Screenshot/hotkey:** `desktopCapturer` + `globalShortcut` (default `CommandOrControl+Alt+S`
  → `⌘⌥S` on macOS; user-configurable).
- **Charts:** Chart.js 4 + plugins (treemap, sankey, matrix, financial, `@sgratzl` boxplot).
  **Maps:** Leaflet (OSM tiles — the one planned external network call).
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
  Mirrors `src/history.ts` conventions. **Path-traversal hardening:** every id is a generated UUID,
  validated by a `UUID_RE` regex before it touches a path (dual-UUID guard on `projectId` + record
  id); writes are **atomic** (temp sibling then `rename`); corrupt/unreadable files are skipped, not
  fatal. `src/projects.ts`, `datasets.ts`, `visuals.ts`, `dashboards.ts` own these stores.
- **Sources** — `datasets.ts` stores the parsed table + `sourceKind`. Parsing is centralized in
  `src/parse.ts` (`finalizeTable`, strict `isFiniteNumber` gate so `007`/zips/>15-digit ids stay
  text) and `parseXlsx.ts` (read-only single-sheet via `exceljs`). `connections.ts` +
  `connectionRun.ts` = Postgres (pure-JS `pg`, parameterized `information_schema`, sub-select +
  `LIMIT`/`statement_timeout`, client closed in `finally`). URL fetch is https-only, byte/timeout
  capped. `captureDataset.ts` projects a capture's `extractedTable` into a reviewable dataset draft.
- **Prepare** — `transforms.ts` folds ordered steps (calculated_field, filter, group_aggregate,
  dedupe, fill_empty, trim, drop_column, rename_column) over an immutable deep copy → reversible;
  unknown step skipped with a warning, never throws. `formula.ts` = safe expression evaluator
  (tokenizer + recursive-descent parser + tree-walker, **no `eval`/`new Function`**; div-by-zero /
  type-mismatch / unknown-column → `null`). `combineTables` (append / inner join) is IPC-only.
- **Explore** — `datasetStats.ts`: per-column summaries + quality flags (empty_heavy,
  constant_column, duplicate_rows).
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
| Status | `renderer/status/` | `statusPreload` → `window.screenchart` | `statusWindow.js` |
| About | `renderer/about/` | `aboutPreload` → `window.about` | `aboutWindow.js` |
| Permission | `renderer/permission/` | `permissionPreload` → `window.permission` | `permissionWindow.js` |

Settings/About/Permission are fixed full-window overlay panels inside the hub (`#settings-panel`
with `#ex-local-panel`/`#ex-byok-panel`, `#about-panel`, `#permission-panel`), shown via
`hub:open-settings`; back returns to the hub view.

### Result surface
Thumbnail (→ lightbox), headline + analysis, a chart or Leaflet map with a `⋯` menu
(Values/Periods/customize), follow-up chips + input, and report export (PDF/Word/PPT — charts
and maps). A disk-persisted history rail lists captures (newest first); clicking restores its thread.

### Code layout
- **Main:** `main.js` = entry/lifecycle/hotkey/capture loop/windows. Logic in `src/` modules:
  capture path (`analyze, calc, headline, capture, config, history, hotkey, localCli, localCliRun,
  models, icons, userPath, disclaim`); workspace (`projects, datasets, parse, parseXlsx,
  connections, connectionRun, captureDataset, transforms, formula, datasetStats, visuals, vizData,
  dashboards, dashboardFilters, metricValue, dashboardExport, reportCapture`); AI (`copilot,
  anomalies`). **IPC** split into `src/ipc/*.ts`, each exporting `register(deps)`, wired in
  `main.js`. Add new IPC to the matching `src/ipc` module, not `main.js`.
- **Renderer (hub):** many `<script>` files sharing one global scope (call-time resolution, so
  load order is irrelevant): capture surface — `hub.js` (shell/state/error card), `renderResult.js`
  (result + chart-type picker), `chartRender.js` (buildChart), `chartControls.js`
  (Values/Periods/customize), `mapRender.js` (Leaflet), `reportExport.js` (export + map→PNG),
  `execMenu.js`, `settingsPanels.js` (Local CLI + BYOK), `customDropdown.js`, `geoMatch.js`;
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
| Datasets/Prepare | `dataset:pickAndParse`/`:parsePaste`/`:get`/`:list`/`:save`/`:update`/`:delete`/`:combine`, `dataset:addStep`/`:updateStep`/`:removeStep`/`:reorderSteps`/`:setSteps`, `dataset:stats`/`:explain`, `dataset:suggestSteps`/`:suggestCalcField`, `captureDataset:draft`/`:save` |
| Connections | `connections:list`, `connection:testAndSave`/`:listTables`/`:run`/`:refresh`/`:delete` |
| Visuals | `visual:get`/`:list`/`:save`/`:update`/`:duplicate`/`:delete`/`:data`/`:suggest` |
| Dashboards | `dashboard:get`/`:list`/`:save`/`:update`/`:delete`/`:metric`/`:draft`/`:summary`/`:explainAnomalies`, `dashboard:exportHtml`/`:exportPng`/`:exportPdf`/`:revealFolder` |
| Copilot | `copilot:ask`/`:history`/`:clear`/`:setEnabled` |
| Exec/BYOK | `exec:setMode`, `byok:saveProvider`/`:test`/`:activate`/`:revealKey`, `key:status`/`:save`/`:clear`/`:validate`/`:models`, `local:save`, `provider:activate`, `model:save`, `rules:set`, `memory:setModel` |
| Local CLI | `cli:detect`/`:detectOne`/`:setActive`/`:test`/`:models`/`:saveModel`, `models:list` |
| History/export | `history:load`/`:delete`, `data:delete`, `hub:history`, `hub:saveImage`/`:savePdf`/`:saveDocx`/`:savePptx`/`:captureReport`, `hub:copy`/`:copyText` |
| Theme/notif/hotkey | `theme:getPreference`/`:setPreference`/apply, `notifications:bootstrap`/`:set`, `hotkey:save`/`:label`, `hub:hotkey-state`, `hub:open`/`:open-settings`/`:show-permission`, `status:state`, `shell:open`, `provider:logos`/`agent:logos`, `permission:open-settings` |

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
  node types) and `tsconfig.renderer.json` (DOM, no node types). `strict` is on; no `any` without
  a comment. Renderer files stay **global-scope scripts** — no import/export in renderer `.ts`
  (shared globals are declared in `renderer/hub/globals.d.ts`). `prestart`/`pretest`/`predist:*`
  compile automatically.
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
- Charts (Chart.js) for tabular data; Leaflet for genuinely geographic data (`map_bubble`/
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
  `scripts/test-*.js` (pure logic, no framework) via `npm test`; add one per non-trivial helper.

```bash
npm start          # run the app (no dev build step)
npm test           # scripts/test-*.js self-checks
npm run dist:mac   # macOS dmg (electron-builder)
npm run dist:win   # Windows installer/zip
npm run icons:verify   # verify logos vs installed simple-icons
```
`postinstall` fetches map GeoJSON (`scripts/download-geo.js`). `npm run build:ts` compiles the
converted `.ts` files in place (runs automatically via `prestart`/`pretest`/`predist:*`);
unconverted JS loads directly. The only other "build" is packaging installers.

## Git and commits
- **Branch from `main` for every change.** Each new feature or fix starts on a fresh branch
  created from an up-to-date `main` (`fix/...` for a bugfix, `feat/...` for a feature), is
  committed there, then pushed and merged into `main` via a pull request. **Never commit
  directly to `main`.**
- **Never** add a `Co-Authored-By: Claude …` trailer (or any AI co-author line) to commit
  messages. Write the title + body and stop — no trailer.

## Out of scope (don't build unprompted)
Installing CLIs for the user, a hosted/central-server web version, a marketing website,
spreadsheet export, and a full memory/summarization step (`memoryModel` config exists as an
integration point but nothing consumes it yet). Ask before adding runtime dependencies — prefer
stdlib / native platform features / already-installed deps.
