# Quickstart

Run Screenchart from source and understand how the pieces fit. Screenchart is a **local-first
personal BI workspace**: you create a **project**, bring **data** in (files, paste, Excel, Postgres,
a URL, or a screenshot capture), **prepare** it, build **visuals** and **dashboards**, and **share**
them offline. AI is optional at every step, and the app computes every number itself.

## Environment requirements

- **Node.js 20+** and **npm** (only needed to install deps and run the scripts).
- **Electron 42** — installed as a dev dependency; you don't install it globally.
- **macOS** (primary) or **Windows**. Linux runs in dev but isn't a build target yet.
- **Optional — a Local CLI agent** already on your `PATH` (Claude Code, Codex, Cursor,
  Antigravity, Grok, OpenCode). Screenchart detects and runs these; it never installs them.
  No CLI? Use **BYOK** with an Anthropic / OpenAI / Gemini / gateway key instead.

## Quickstart

```bash
git clone https://github.com/AshishB2000/screenchart.git
cd screenchart
npm install        # also runs postinstall → downloads map GeoJSON
npm start          # compiles TypeScript (build:ts), then launches the app
```

`npm start` runs `npm run build:ts` first (tsc compiles each `.ts` to a sibling `.js` in place —
no bundler), then launches Electron against the working tree. On first capture, macOS asks for
**Screen Recording** permission; grant it under **System Settings → Privacy & Security → Screen
Recording**, then relaunch.

## Other scripts

| Command | What it does |
|---|---|
| `npm start` | Compile TypeScript, then run the app against the working tree |
| `npm run build:ts` | Compile all `.ts` to sibling `.js` in place (tsc, no bundler) |
| `npm test` | Compile, then run the `scripts/test-*` self-checks (pure logic, no framework) |
| `npm run icons:verify` | Verify bundled brand logos against installed `simple-icons` |
| `npm run dist:mac` | Build a macOS `.dmg` (electron-builder) |
| `npm run dist:mac:unsigned` | macOS build with code-signing disabled |
| `npm run dist:win` | Build a Windows installer/zip |

`postinstall` (`scripts/download-geo.js`) fetches the map GeoJSON on `npm install`.

## Two execution modes

Set in **Settings → Execution** (`config.executionMode`):

- **`local`** (default) — a Local CLI already on your machine. The crop is written to a temp file
  under `userData/tmp/…` and its path is handed to the CLI via a prompt hint or flag
  (`--add-dir`, `-i`). Detect-and-run only, never install; execution is shell-free
  (`execFile`/`spawn` with an args array).
- **`byok`** — Bring Your Own Key to a cloud API (Anthropic / OpenAI / Gemini / any
  OpenAI-compatible gateway). The crop is sent **inline as base64** in the HTTPS body. Keys are
  stored plaintext in `userData/config.json` (gitignored), never logged, never sent to a renderer.

Capture is gated on `config.executionReady()` — with no CLI or key, the hub opens Execution
settings instead of starting a capture.

## The workspace flow

Work is organized into **projects**, each stored as one folder of plain JSON on disk under
`userData/projects/<id>/` (`project.json` + `datasets/`, `visuals/`, `dashboards/`). Every id is a
UUID validated before it touches a path, and writes are atomic (temp file then rename), so a project
folder is safe to sync or commit to git.

1. **Bring in data** (`sourceKind`): a **CSV/JSON/XLSX** file via the native picker
   (`dataset:pickAndParse`; XLSX is read-only, one sheet at a time); **paste** (`dataset:parsePaste`,
   which auto-detects JSON vs delimited and sniffs tab vs comma, so **TSV works via paste**); a
   **Postgres** connection (`connections.ts`, read-only, parameterized + row/timeout capped); a
   **URL / JSON API** (https-only, byte/timeout capped); or a **screenshot capture** projected into a
   dataset (`captureDataset.ts`). A "combine" step (append / inner join) produces a `combined` dataset.
   The strict `isFiniteNumber` gate keeps `007`/zips/long ids as text everywhere.
2. **Prepare** (`transforms.ts` + `formula.ts`): stack reversible steps (calculated_field, filter,
   group_aggregate, dedupe, fill_empty, trim, drop_column, rename_column) folded over an immutable
   source copy — remove a step and the result recomputes from source. Calculated fields run a
   hand-written safe evaluator (no `eval`/`new Function`).
3. **Explore** (`datasetStats.ts`): per-column summaries + quality flags (empty-heavy, constant,
   duplicate rows).
4. **Visualize** (`visuals.ts` + `vizData.ts`): a visual = dataset + encoding + chart type + style;
   `buildVizData` bridges to the existing `chartRender.buildChart` / `mapRender` (28 chart & map types).
5. **Dashboard** (`dashboards.ts`): visual/text/metric cards on a 12-column multi-page grid with
   dashboard-wide cross-filters; metric numbers are computed on the fly (`metricValue.ts`), never stored.
6. **Share** (`dashboardExport.ts`): self-contained interactive HTML (inlined Chart.js, fully offline),
   PNG, or PDF; per-result export to PDF/Word/PPT; or reveal the project folder to commit it. The
   export bundle is sanitized to labels/numbers/strings/`data:image` only — secrets never leave main.

**AI is optional** — copilot chat (`copilot.ts`), transform/field/chart suggestions, dashboard
summaries, and anomaly explanations (`anomalies.ts` detects; the model only narrates). Each action
gates on a configured model and returns `not_ready` otherwise.

## Prompt composition (screenshot capture path)

Each capture is a stateless call; the intelligence lives in the prompt (`src/analyze.js`):

1. `buildSystemPrompt()` + the screenshot are sent to the model, which returns **only** a JSON
   envelope (plain-language analysis + structured data — never a computed number).
2. `parseReply()` validates the reply against controlled vocabularies into `extractedTable` (raw
   values verbatim), `dataShape`, `columnRoles`, `suggestedCalculations`, a number-free
   `headline.angle`, `visualizations`, `geo`, and `followups`.
3. `calc.js` does the arithmetic; `headline.js` composes the headline and inserts the figures.
   **The model is forbidden from writing computed numbers** — every figure is the app's math.
4. **Follow-ups** replay the full thread (system prompt + original prompt + screenshot + every
   prior turn) each time, because the model is stateless.

## File map

| Path | Contents |
|---|---|
| `main.js` | App entry, lifecycle, hotkey, capture loop, window wiring |
| `src/` (capture) | `analyze`, `calc`, `headline`, `capture`, `config`, `history`, `hotkey`, `localCli`, `models`, `icons`, … |
| `src/` (workspace) | `projects`, `datasets`, `parse`, `parseXlsx`, `connections`, `connectionRun`, `captureDataset`, `transforms`, `formula`, `datasetStats`, `visuals`, `vizData`, `dashboards`, `dashboardFilters`, `metricValue`, `dashboardExport`, `reportCapture` |
| `src/` (AI) | `copilot`, `anomalies` |
| `src/ipc/` | One file per IPC area, each exporting `register(deps)` (incl. `projects`, `datasets`, `connections`, `visuals`, `dashboards`, `copilot`, `captureDataset`, `dashboardExport`) |
| `src/windows/` | `BrowserWindow` factories (hub, overlay, status, about, permission) |
| `renderer/hub/` | The main UI — many `<script>` files sharing one global scope (capture surface + workspace scripts `workspace/projects/datasets/prepare/visuals/dashboards/connections/captureDataset/copilot`) |
| `renderer/{overlay,status,about,permission}/` | The other windows |
| `userData/projects/<id>/` | Per-project on-disk store: `project.json` + `datasets/`, `visuals/`, `dashboards/` JSON |
| `preload/` | One `contextBridge` per window |
| `scripts/` | Build hooks + `test-*.js` self-checks (not shipped) |
| `assets/`, `geo/` | Icons + GeoJSON (fetched on postinstall) |

## Troubleshooting

- **Capture fails / "failed to get sources":** Screen Recording permission isn't granted — enable
  Screenchart under **Privacy & Security → Screen Recording** and relaunch.
- **Capture won't start:** no Local CLI detected and no BYOK key set — the hub opens Execution
  settings. Add one, then capture.
- **Provider error (BYOK):** re-check the key in Settings and that the provider has quota (some
  free tiers have daily limits).
- **Local CLI not detected:** confirm the binary is on your `PATH` (`which claude`), then rescan
  in **Settings → Execution**. Screenchart resolves PATH + known user bin dirs.
- **An Automation / "controlling" prompt appears:** it's from a CLI agent (e.g. Cursor) and is
  safe to deny.
- **Maps look blank:** map tiles are the one external fetch (OpenStreetMap) — check your network.
