# Brief: migrate Ordinate to the DuckDB / Arrow / Mosaic / Tauri stack

You are picking up a migration of an existing, working application. Read this whole brief before
touching code. The current codebase is not a prototype — it is ~2,500 lines of tested data-layer
TypeScript plus a full Electron app, and its behaviour is the specification for the new one.

---

## 1. Mission

Move Ordinate from "TypeScript does everything" to "TypeScript orchestrates, DuckDB computes."

| Layer | From (today) | To (target) |
|---|---|---|
| Engine | `transforms.ts` folding `Cell[][]` in JS | **DuckDB**, embedded |
| Memory format | JS arrays of boxed cells | **Apache Arrow** (zero-copy) |
| Storage | JSON per record under `userData/projects/<id>/` | **Parquet** for table data, JSON for metadata |
| Coordination | `dashboardFilters.ts` merging `FilterStep[]` per card | **Mosaic** (`uwdata/mosaic`) coordinator + data cube indexes |
| Charts | Chart.js 4 + plugins (Canvas 2D) | **vgplot / deck.gl** (WebGL) |
| Maps | Leaflet + raster OSM tiles | **MapLibre GL** or deck.gl (vector, GPU) |
| UI | Vanilla global-scope scripts | **Svelte** or **SolidJS** |
| Shell | Electron 42 | **Tauri** (Rust + system WebView) |

The goal is speed and efficiency at scale. Today the app is comfortable with thousands of rows;
the target is interactive cross-filtering on millions.

---

## 2. Current state

- **Repo:** `/Users/ashishb/Projects/ordinate` — private, default branch `develop`.
- **History:** one commit (`d70a143 Initial commit`), 223 files. Imported from the Screenchart
  project; no prior history.
- **Build:** `npm run build:ts` (tsc, in-place sibling emit, no bundler). Zero errors expected.
- **Tests:** `scripts/test-*.js`, run with `npm test`. Plain Node asserts, no framework.
  **964 assertions passed in the source project.** `node_modules` is not installed in this repo yet —
  run `npm install` first (its `postinstall` also fetches map GeoJSON into `geo/`).
- **Docs:** `CLAUDE.md` is the architecture reference and is accurate. The project was renamed from
  Screenchart to Ordinate; all markdown has been swept, but `package.json` still carries the old
  `productName` (see section 6).

**Read `CLAUDE.md` first.** It documents the IPC surface, the config schema, the on-disk store
layout, and the security model in detail. Do not re-derive any of that.

---

## 3. Invariants — these must survive the migration

If a phase would break one of these, stop and raise it rather than proceeding.

1. **Local-first.** No telemetry, no analytics, no surprise network calls. Data goes only to the
   user's own configured endpoint, or nowhere. Map tiles are the single declared external fetch.
2. **The app does the math.** Every aggregate, statistic, metric, and anomaly is computed by
   deterministic, auditable code. A model may extract structure or narrate figures the app already
   computed. **A model never writes a computed number.** Moving the math into DuckDB SQL keeps this
   property — moving it into a model does not.
3. **AI is optional everywhere.** Every AI feature is gated on a configured model and returns
   `not_ready` when there is none. The entire app must work with no model configured.
4. **Secrets never leave the trusted process.** API keys and connection secrets live in
   `userData/config.json`, are stripped from all metadata and error strings, and are never sent to
   a renderer, written to a project folder, or included in an export. `publicConfig()` /
   `publicByok()` are the only renderer-safe views. Preserve this boundary across the Tauri port.
5. **Reversible prepare pipeline.** The ordered step list is the source of truth. Removing a step
   must recompute from the immutable source. Today that is free (re-fold); in SQL it means
   regenerating a composed query from the step list. **Never mutate stored data in place.**
6. **Strict number parsing.** `007`, zip codes, and >15-digit identifiers must stay text. See
   `isFiniteNumber` and `finalizeTable` in `src/parse.ts`. This is a correctness guarantee, not a
   detail — see landmine 6.1.
7. **No `eval`, no `new Function`.** Anywhere. User and model input never becomes executable code
   or a shell command.
8. **Path hardening.** Every id is a generated UUID validated against `UUID_RE` before touching a
   path; writes are atomic (temp sibling then rename); corrupt files are skipped, never fatal.
9. **Feature parity.** 8 source kinds (`csv json paste xlsx postgres url combined capture`),
   28 chart/map types, the full prepare step set, dashboards with cross-visual filters, and report
   export (PDF/Word/PPT/HTML/PNG). Losing one is a regression, not a simplification.
10. **Local CLI execution stays shell-free.** `execFile`/`spawn` with an args array, never
    `shell: true`. Detect and run only — never install anything for the user.

---

## 4. Known landmines

These are the specific places where a naive port produces silently wrong behaviour. Each one needs
a deliberate decision, not a default.

**6.1 — DuckDB's CSV sniffer will corrupt data the current parser protects.**
DuckDB will happily read `007` as integer `7` and a zip code as a number. `src/parse.ts` exists
specifically to prevent that. Ingest with all columns forced to `VARCHAR`, then apply the existing
type-detection rules explicitly. The tests in `scripts/test-parse.js` encode the expected behaviour
— they must still pass, in spirit if not verbatim.

**6.2 — `formula.ts` is 70 functions with Tableau semantics, not SQL semantics.**
1,043 lines, with deliberate behaviour that differs from DuckDB's defaults:
- Per-row failure yields `null`; it never throws. Div-by-zero, type mismatch, and unknown column
  all degrade to `null`.
- Arithmetic refuses to coerce numeric strings — casting must be explicit via `INT()`/`FLOAT()`.
- `DATEDIFF` counts boundary crossings (Tableau semantics), not elapsed duration.
- Dates are text cells; there is no date type.
Translating these to SQL expressions requires a mapping layer. **`scripts/test-formula.js`
(~130 assertions) is the conformance suite — it must pass against the new backend.** Do not
translate function-by-function without running it.

**6.3 — Tauri has no `desktopCapturer`.**
The entire capture loop (frozen frame of the display under the cursor → dimming overlay →
drag-box → crop) is built on Electron's `desktopCapturer` plus `globalShortcut`. Tauri needs a Rust
screen-capture implementation and its own global-shortcut plugin, plus a new overlay-window
strategy that is still multi-monitor aware. **Budget this as its own phase.** Do not discover it
during the shell port.

**6.4 — The export stack is Node-only.**
`pdfmake`, `docx`, `pptxgenjs`, and the offscreen render path in `reportCapture.ts` all assume a
Node runtime. Tauri has no Node. Each needs a Rust equivalent, a WASM build, or a rearchitecture.
`dashboardExport.ts` also reads the Chart.js UMD bundle off `node_modules` to inline it — that
mechanism disappears entirely.

**6.5 — `pg` and `exceljs` disappear, and DuckDB replaces them well.**
Use DuckDB's `postgres` extension for Postgres and its `excel`/`spatial` extensions for XLSX.
This is a genuine simplification — but the read-only guarantee and the query caps
(`LIMIT`, `statement_timeout`, client closed in `finally`) must be reimplemented, not assumed.

**6.6 — Not all 28 chart types exist in vgplot.**
Treemap, sankey, boxplot, and the financial charts are Chart.js plugins today. Check what vgplot
and deck.gl actually provide before promising parity, and report the gap early.

**6.7 — `sanitizeBundle` is a security control, not a formatter.**
It whitelists exports to labels, numbers, strings, and `data:` images — no secrets, no `http(s)`
images. Any new export path needs the equivalent.

---

## 5. Phases

Each phase is independently shippable and independently revertible. **Do not start a phase until
the previous one's gate passes.** One branch per phase, off `develop`.

### Phase 0 — Spec extraction (no product changes)
Turn the existing test suite into an explicit behaviour spec: for each of `parse`, `transforms`,
`formula`, `datasetStats`, `vizData`, `dashboardFilters`, `metricValue`, write down the contract the
assertions encode. Identify every assertion that DuckDB would break by default.
**Gate:** a written spec document, plus `npm test` green at 964 assertions on the current code.

### Phase 1 — DuckDB + Arrow behind the existing APIs
Keep Electron, keep Chart.js, keep the vanilla UI. Replace only the compute: `applyPipeline` becomes
SQL generation from the same `TransformStep[]`, executed by DuckDB, returning Arrow. The exported
function signatures in `transforms.ts`, `vizData.ts`, `datasetStats.ts`, and `metricValue.ts` do not
change — callers must not notice.
**Gate:** full test suite passes. Add a benchmark (10k / 100k / 1M rows) and record before/after.
This is the single highest-value phase; if the project stops here, it was still worth doing.

### Phase 2 — Parquet storage
Table data moves from JSON to Parquet under `userData/projects/<id>/`. Metadata stays JSON. Write a
one-way migration for existing projects, and keep atomic writes and UUID path validation.
**Gate:** existing projects open correctly after migration; round-trip tests pass.

### Phase 3 — Mosaic + WebGL charts
Introduce the Mosaic coordinator. Cards publish declarative queries; Mosaic cross-filters them
against DuckDB with data cube indexing. Replace Chart.js with vgplot/deck.gl, one chart family at a
time, and report any type that has no equivalent.
**Gate:** all 26 non-map chart types render; cross-visual filtering is interactive on 1M rows.

### Phase 4 — MapLibre GL
Replace Leaflet and the raster OSM path with vector tiles. `map_bubble` and `map_choropleth` keep
working, `geoMatch` place-name joining still works, and map→PNG export still works.
**Gate:** both map types render and export; the external-fetch surface is still declared and minimal.

### Phase 5 — Svelte or SolidJS UI
Port the hub. The renderer is currently many global-scope scripts sharing one namespace with
call-time resolution — this is a rewrite of the UI layer, not a wrapper. Keep the inline-panel
model (settings/about/permission are panels, never new windows).
**Gate:** full feature parity, verified screen by screen against the current app.

### Phase 6 — Tauri shell
Last, and hardest. Electron IPC (`ipcMain.handle` / `contextBridge`) becomes Tauri commands. Then
solve landmines 6.3 and 6.4: screen capture in Rust, and a new export stack.
**Gate:** capture loop works on multi-monitor macOS and Windows; all export formats produce correct
files; the secrets boundary from invariant 4 is intact.

---

## 6. Rules of engagement

- **Branch per phase**, off `develop` (`feat/phase-1-duckdb`, etc.). Never commit directly to `main`.
- **Never** add a `Co-Authored-By` or AI co-author trailer to a commit message. Title and body, stop.
- Ask before adding runtime dependencies beyond the target stack above.
- Keep `npm test` green. When behaviour genuinely must change, change the test deliberately and say
  so in the commit body — never delete a failing assertion to make a phase pass.
- Report parity gaps as you find them. A missing chart type or an unportable export format is
  information the owner needs immediately, not at the end.
- Update `CLAUDE.md` as the architecture changes. It is the reference the next session reads.

---

## 7. First action

Do not write code yet. Run `npm install && npm run build:ts && npm test`, confirm the baseline is
green, read `CLAUDE.md` and the five data-layer files, then produce the Phase 0 spec document and a
list of every assertion you expect DuckDB to break. Bring that back before starting Phase 1.
