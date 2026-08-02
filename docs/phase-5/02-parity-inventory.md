# Phase 5 — Parity Inventory

**What this is.** The enumeration the Phase 5 gate ("full feature parity, verified screen by screen
against the current app") is scored against. Every screen, panel, modal, popover and overlay a user
can reach; every renderer file and the globals it puts into and takes out of the shared scope; the
load-order dependencies that a module bundler will surface as `ReferenceError`s; a proposed component
tree; a ranked port order argued from dependency counts; and the stateful behaviour that a naive port
loses silently.

**What this is not.** It is not the state/IPC design — that is
[`03-state-ipc.md`](03-state-ipc.md), which owns the `window.hub.*` surface, the store layer, and the
async boundary. Where the two touch (port order, in-flight requests) this document argues from
*screens and coupling*, that one argues from *state*. They agree on the conclusion.

**Method.** Every number below was produced by parsing the tree, not by reading and estimating. Line
counts are `wc -l`. "Top-level symbol" means a declaration at column 0 in a renderer `.ts` — which,
because these are classic global-scope `<script>`s with no module wrapper, means *in the one shared
scope*. Cross-file bindings were computed by intersecting each file's declared symbols against every
other file's identifier occurrences, then hand-verified (two false positives removed — see §2.4).

**Status of the source tree read.** `renderer/` at `feat/phase-5`, worktree
`/Users/ashishb/Projects/ordinate-phase5`. Read-only: this document is the only file this pass wrote.

---

## 0. Numbers at a glance

| | count |
|---|---:|
| Renderer files (all kinds) | 43 |
| Renderer lines total (`.ts` + `.html` + `.css`, incl. vendor) | 22,627 |
| **Hub executable `.ts` files** | **21** |
| **Hub executable `.ts` lines** | **13,485** |
| Hub ambient declaration files (`globals.d.ts`, `globals.hub-c.d.ts`) | 2 files / 276 lines |
| Hub `index.html` | 1,495 lines, **267 unique element ids** |
| `hub.css` | 6,069 lines, **748 distinct class selectors**, 8 id selectors, 28 attribute-selector rules |
| `renderer/theme.css` | 116 lines, 78 custom-property declarations |
| Secondary window renderers | 4 (`overlay`, `status`, `about`, `permission`) — **2 live, 2 dead** |
| Secondary window `.ts` | 123 lines total |
| **Top-level symbols sharing one global scope** | **715** |
| **Genuine cross-file symbol bindings** | **154** |
| Name collisions across files | **0** (see §2.4 for the two near-misses) |
| `window.hub.*` methods exposed by preload | 118 |
| …declared in `globals.d.ts` | 116 |
| …actually called | 108 |
| …**exposed but undeclared** (reached through a cast) | **2** |
| Parse-time (non-declaration) top-level statements, `hub.ts` | **63** |
| Parse-time `getElementById` bindings | 90 (`hub.ts`) + 19 (`settingsPanels.ts`) |
| Chart types in `VIZ_LABELS` | 28 (25 charts + 2 maps + table) |
| …renderable by the dark Mosaic stack | 16 of 28 |

**Screen inventory totals** (§1): **8 primary screens**, **31 sub-surfaces**, **12 always-mounted
singleton overlays/popovers**, **9 imperatively-created transient modals/menus**, **2 live secondary
windows** (+2 dead), **1 offscreen export renderer**. **62 addressable surfaces** in total — that is
the length of the parity checklist.

---

## 1. Screen and panel inventory

### 1.1 How visibility actually works today

Nothing in the hub is routed. There is no router, no history, no URL. Visibility is four mechanisms,
all of them CSS reading a DOM attribute or a `hidden` property that JS flipped:

| mechanism | driver | CSS | screens it controls |
|---|---|---|---|
| `.win[data-view]` | `workspace.ts setView()` | `hub.css:3948-3950` | Home ↔ Workspace |
| `.hub-body[data-section]` | `workspace.ts selectSection()` | `hub.css:4157-4158` | the 5 workspace sections |
| `#capture-view[data-cv-state]` | `hub.ts` (9 assignment sites) | `hub.css:1564-1569` | capture loading / result / error |
| `.hidden` / `el.hidden = …` | everywhere | — | every panel, banner, menu, empty state |

Plus two whole-document state classes: `html[data-theme]` (`hub.ts:115`) and
`html.dash-presenting` (`dashboards.ts:1253`).

**Consequence for the port.** Every one of these is an *ancestor* attribute selector reaching into a
*descendant* that will live in a different Svelte component. Svelte's scoped styles compile
`.hub-body[data-section="sources"] .sidebar` into nothing useful once `.sidebar` is in
`Sidebar.svelte`. These 28 attribute rules plus the ~10 `.hidden` conventions must either become
`:global(...)`, or the show/hide must move from CSS into `{#if}`. Choose one and apply it uniformly —
mixing them is how a panel ends up visible in one state and invisible in another.

### 1.2 Primary screens (8)

| # | Screen | Element | Mounted | Owner file |
|---|---|---|---|---|
| P1 | Launch splash | `#splash` | always in DOM; `hidden = true` after 2,620 ms | `hub.ts:152-165` |
| P2 | Title bar | `.titlebar` | always | `index.html:23`, OS padding from `html[data-os]` (`hub.ts:5-9`) |
| P3 | Home / project gallery | `#home-view` | always in DOM, CSS-hidden off `.win[data-view]` | `projects.ts` |
| P4 | Workspace → **Sources** | `.hub-body[data-section="sources"]` (sidebar + `.main`) | always in DOM | `hub.ts` + `connections.ts` |
| P5 | Workspace → **Datasets** | `#ws-datasets` | in DOM, `hidden` toggled | `datasets.ts` + `prepare.ts` |
| P6 | Workspace → **Visuals** | `#ws-visuals` | in DOM, `hidden` toggled | `visuals.ts` |
| P7 | Workspace → **Dashboards** | `#ws-dashboards` | in DOM, `hidden` toggled | `dashboards.ts` |
| P8 | Workspace → **AI / Copilot** | `#ws-ai` | in DOM, `hidden` toggled | `copilot.ts` |

Every workspace section is **always mounted** and merely hidden. Nothing is created or destroyed on
navigation. This is load-bearing: `selectSection()` calls `refreshDatasetList()` /
`refreshConnectionList()` / `refreshVisualList()` / `refreshDashboardList()` / `refreshCopilot()` on
entry (`workspace.ts:67-75`) precisely *because* the DOM survived and holds stale content. A Svelte
port that uses `{#if section === 'datasets'}` changes this from "refresh a live DOM" to
"mount fresh", which is mostly an improvement but silently changes five behaviours — see §6.21.

### 1.3 Sub-surfaces (31)

**Sources (P4) — 10**

| # | Surface | Element | Notes |
|---|---|---|---|
| S1 | Sidebar search | `#cap-search` | filters existing DOM nodes in place (`hub.ts:807`), does not re-render a list |
| S2 | Capture history rail | `#capture-history` | session + on-disk entries; selection via `.cap-hist-item-active` |
| S3 | Sidebar empty state | `.side-empty` | |
| S4 | Key badge | `#key-badge` | `aria-live="polite"` |
| S5 | Main header | `.main-top` | title/sub mutate per state |
| S6 | Hotkey-fail banner | `#hotkey-fail-banner` | shown when `globalShortcut.register()` returned false |
| S7 | Empty state | `.conv` / `.state-pad` | 3-step onboarding, hotkey chips re-rendered from the live accelerator |
| S8 | Readiness banner | `#api-banner` | shown only when neither a Local CLI nor a BYOK provider is ready |
| S9 | Capture view | `#capture-view` | **3 mutually exclusive states**: `loading` / `result` / `error` |
| S10 | Connect-data panel | `#conn-panel` | overlays the main body; contains S11-S13 |

**Capture view (S9) internals — 5**

| # | Surface | Element |
|---|---|---|
| S9a | Screenshot thumb + meta (→ lightbox) | `.cv-thumb-section`, `#cv-thumb-wrap` |
| S9b | Loading panel with animated step list | `.cv-loading-panel`, `.cv-step[data-status]` |
| S9c | Error panel (badge, retry, open-settings) | `.cv-error-panel`, `#cve-badge` |
| S9d | Result panel → conversation thread | `#cv-thread` — N turns, each with headline / metrics / details / viz picker / viz area / `⋯` controls |
| S9e | Follow-up composer | `#followup-*` |

**Connect-data panel (S10) internals — 3**

| # | Surface | Element |
|---|---|---|
| S11 | Connection form (Postgres fields ↔ URL fields) | `#conn-form`, `#conn-pg-fields`, `#conn-url-fields` |
| S12 | Run area (table picker / query / preview / save-as-dataset) | `#conn-run-area` |
| S13 | Saved connections list | `#conn-saved-list` |

**Datasets (P5) — 7**

| # | Surface | Element |
|---|---|---|
| S14 | Import toolbar + paste box + sheet picker | `#ds-toolbar`, `#ds-paste-wrap`, `#ds-sheet-wrap` |
| S15 | Parse preview + warnings + save bar | `#ds-preview`, `#ds-warnings`, `#ds-save-bar` |
| S16 | Saved-dataset list | `#ds-saved-list` |
| S17 | **Explorer** | `#ds-explorer` — head, capture-provenance strip, quality flags, toolbar, columns menu, explain output |
| S18 | Explorer grid (paged, 500 rows/page) | `#ds-explorer-scroll` |
| S19 | **Prepare panel** | `#ds-prepare-panel` — steps list, `+ Add step` type menu, per-type step editor |
| S20 | Prepare AI + combine | `#ds-suggest-out`, `#ds-calc-suggest-out`, `.ds-combine-wrap` |

**Visuals (P6) — 4**

| # | Surface | Element |
|---|---|---|
| S21 | Builder: dataset / category / measures / split / geo | `#viz-builder`, `#viz-encoding` |
| S22 | Visual-level filter rows | `#viz-filters-list` |
| S23 | Chart-type picker + viz area | `#viz-switcher-mount`, `#viz-area` |
| S24 | Saved-visual list | `#viz-saved-list` |

**Dashboards (P7) — 6**

| # | Surface | Element |
|---|---|---|
| S25 | List view | `#dash-list-view` |
| S26 | Editor head (name, rename, add visual/metric/text, save) | `.dash-editor-head` |
| S27 | Toolbar: filter chips, quick category/period, AI, present, export, share | `#dash-toolbar` |
| S28 | AI interpretation panel | `#dash-ai-out` (same `.ai-interp` shell as `#ds-calc-suggest-out`) |
| S29 | Page tabs + 12-col grid + card bodies (visual / metric / text) | `#dash-pages`, `#dash-grid` |
| S30 | Empty-page starter layouts | `#dash-starters` |

**AI / Copilot (P8) — 1**

| # | Surface | Element |
|---|---|---|
| S31 | Hint + context chip + message list + composer | `#ai-hint`, `#ai-context`, `#ai-messages`, `#ai-composer` |

### 1.4 Always-mounted singleton overlays and popovers (12)

All of these live in `index.html` (or are built once at parse time) and are toggled with `hidden`.
They are **siblings of every screen**, which is why they are reachable from anywhere and why they
must become app-level singletons in Svelte, not per-screen children.

| # | Surface | Element | Built |
|---|---|---|---|
| O1 | **Settings panel** (full-window) | `#settings-panel` | HTML; 7 category panes |
| O1a | → Execution pane, Local CLI | `#ex-local-panel` | HTML shell, rows rendered by `settingsPanels.ts` |
| O1b | → Execution pane, BYOK | `#ex-byok-panel` | HTML shell, cards rendered by `settingsPanels.ts` |
| O2 | **About panel** (full-window) | `#about-panel` | HTML |
| O3 | **Permission panel** (full-window) | `#permission-panel` | HTML — **unreachable**, see §3.5 |
| O4 | Image lightbox | `#img-lightbox` | HTML |
| O5 | Toast | `#hub-toast` | HTML |
| O6 | Image action menu | `#img-action-menu` | HTML |
| O7 | Execution-mode menu | `#exec-menu` | HTML |
| O8 | Settings gear menu | `#settings-menu` | HTML |
| O9 | Help menu | `#help-menu` | HTML |
| O10 | **Chart `⋯` menu** | `.chart-menu` | **built in JS at parse time** (`hub.ts:1009-1129`), `document.body.appendChild` |
| O11 | Columns menu (Explorer) | `#ds-cols-menu` | HTML |
| O12 | Step-type menu (Prepare) | `#ds-step-type-menu` | HTML |

The Settings panel's 7 panes are separate parity items: `exec`, `hotkey`, `prompt`
(Instructions/Rules), `appearance`, `notifications`, `general` (incl. Delete-my-data), `about`.

### 1.5 Imperatively created, transient (9)

Created with `document.createElement`, appended to `document.body`, removed on close. These are the
hardest to enumerate from the HTML — they exist only in JS.

| # | Surface | Factory | Consumers |
|---|---|---|---|
| T1 | Generic prompt / confirm modal | `promptModal()` — `projects.ts:118` | 6 files, **12 call sites** |
| T2 | Choose-a-thing modal (pick visual / dataset / column) | `dashChooseModal()` — `dashboards.ts:55` | `dashboards.ts`, `hub.ts` |
| T3 | Dashboard share modal | `dashboards.ts:1466` | `dashboards.ts` |
| T4 | Capture → dataset review grid | `openCaptureDatasetModal()` — `captureDataset.ts:57` | `hub.ts`, `datasets.ts` |
| T5 | Export dialog | `openExportDialog()` — `reportExport.ts:655` | `renderResult.ts` |
| T6 | Chart mini-menu (Values / Periods) | `openMiniMenu()` — `chartControls.ts:261` | `chartControls.ts`, `mapRender.ts` |
| T7 | Custom dropdown listbox (body-portaled) | `makeDropdown()` — `customDropdown.ts:50` | `hub.ts`, `settingsPanels.ts` (3 instances) |
| T8 | Project card `⋯` menu | `projects.ts:64` | `projects.ts` |
| T9 | Dashboard card / page context menus | `dashboards.ts` | `dashboards.ts` |

### 1.6 Secondary windows (4 renderers; 2 live, 2 dead)

| Window | Renderer | `.ts` | Instantiated? | Trigger |
|---|---|---:|---|---|
| **Overlay** (drag-box capture) | `renderer/overlay/` | 89 | **Yes** | every capture (`main.ts:201`) |
| **Status** | `renderer/status/` | 16 | **Yes, error path only** | `pushStatus()` has exactly **one** caller — `main.ts:211`, the overlay's `did-fail-load` handler |
| About | `renderer/about/` | 11 | **No** | `createAboutWindow` is exported from `src/windows/aboutWindow.ts` and **called nowhere** |
| Permission | `renderer/permission/` | 7 | **No** | `createPermissionWindow` likewise **called nowhere** |

**Finding.** `renderer/about/` (132 HTML + 176 CSS + 11 TS) and `renderer/permission/` (83 + 173 + 7)
are **dead code** — 582 lines superseded by the in-hub panels O2/O3. They must not appear on the
parity checklist and must not be ported. Verify with the owner before deleting; deleting is out of
scope for this pass.

### 1.7 The offscreen export renderer (1)

`src/reportCapture.ts` loads a self-contained HTML string built by `src/dashboardExport.ts` into a
hidden `BrowserWindow` and screenshots it. It has no file in `renderer/`, its Chart.js is the
`node_modules` UMD inlined at export time, and it is **explicitly not a place a MapLibre map can
render** (WebGL in a hidden window is unreliable — hence `capturePage` compositing for maps, per
`CLAUDE.md`). **A Svelte port must not touch it.** If the port changes how charts are configured, the
exported HTML diverges from the on-screen chart, and nothing in the test suite catches it.

---

## 2. Per-file breakdown

### 2.1 The shared-scope contract, and why `globals.d.ts` is not it

`renderer/hub/globals.d.ts` (268 lines) declares **only genuinely external globals**: the
`window.hub` preload bridge (116 members), the vendor UMDs (`Chart`, `ChartBoxPlot`, `vg`, `pdfMake`,
`PptxGenJS`, `docx`, `maplibregl`), the baked GeoJSON payloads, and the three functions that are
defined *inside an IIFE* and exposed via `window`/`global` (`makeDropdown`, `normalizeName`,
`matchGeoItem`). Its closing comment states the reason explicitly: hub-internal symbols are shared by
TypeScript's single-program script scope, so declaring them here would double-declare them (TS2451).

**So the real cross-file contract is invisible.** There is no file that lists it. It is 154 bindings
across 715 top-level symbols, discoverable only by grep. §2.5 is the first written form of it.

Two gaps between the declared contract and reality:

1. **`getDatasetMeta` and `datasetPage` are exposed by `preload/hubPreload.ts` but absent from
   `globals.d.ts`.** `datasets.ts` reaches them through casts —
   `(window.hub as unknown as { datasetPage?: … }).datasetPage` (`datasets.ts:369-371`) and
   `(window.hub as any).getDatasetMeta(…)` (`datasets.ts:390`) — with a comment at `datasets.ts:358`
   acknowledging it. These are the **1M-row paging path**. A port that regenerates the bridge type
   from `globals.d.ts` will drop them and silently fall back to the pure-JS `pageRowsJs` twin, which
   is *correct but slow*: exactly the failure mode `CLAUDE.md` warns about for the resident layer.
2. **10 declared bridge methods are never called**: `saveKey`, `saveLocalEndpoint`, `clearKey`,
   `validateKey`, `getModels`, `saveModel`, `activateProvider`, `openSystemSettings`,
   `onShowPermission`, `openInputMonitoringSettings`. (Cross-referenced in
   [`03-state-ipc.md`](03-state-ipc.md) §1.6.) `onShowPermission` being dead is the other half of the
   Permission-panel finding in §3.5.

### 2.2 Master table

`decls` = top-level symbols this file contributes to the shared scope. `pub` = of those, how many are
read by another file. `out` / `in` = distinct files depended on / depending on. `hub.*` = distinct
bridge methods called. Coupling = `out + in`.

| file | lines | decls | pub | out | in | `hub.*` | coupling | owns |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `mapWorker.ts` | 33 | 0 | 0 | 0 | 0 | 0 | **0** | MapLibre CSP worker URL bootstrap |
| `geoMatch.ts` | 49 | 0 | 0 | 0 | 1 | 0 | **1** | pure geo name matching (also `require`d by a Node self-check) |
| `customDropdown.ts` | 248 | 0 | 0 | 0 | 2 | 0 | **2** | the `<select>` replacement widget |
| `workspace.ts` | 120 | 10 | 7 | 6 | 9 | 3 | **15** | view/section router; `currentProjectId` |
| `projects.ts` | 211 | 10 | 3 | 2 | 7 | 5 | **9** | home gallery, card `⋯` menu, **`promptModal`** |
| `copilot.ts` | 302 | 18 | 2 | 4 | 2 | 7 | **6** | AI chat panel |
| `captureDataset.ts` | 343 | 5 | 4 | 4 | 2 | 4 | **6** | capture→dataset review modal, recapture handoff |
| `execMenu.ts` | 451 | 22 | 9 | 2 | 2 | 6 | **4** | exec chip popup rendering |
| `chartControls.ts` | 474 | 13 | 5 | 3 | 3 | 4 | **6** | `⋯` menu behaviour, Values/Periods, override patching |
| `connections.ts` | 485 | 22 | 2 | 3 | 2 | 8 | **5** | Postgres/URL connect panel |
| `renderResult.ts` | 635 | 18 | 7 | 6 | 6 | 0 | **12** | `renderVizInArea`, chart-type picker, `renderTurnResult`, `VIZ_LABELS` |
| `settingsPanels.ts` | 656 | 44 | 3 | 2 | 2 | 15 | **4** | BYOK cards + Local CLI detection panes |
| `plotRender.ts` | 691 | 27 | 3 | 3 | 1 | 2 | **4** | **dark** Mosaic/vgplot engine |
| `visuals.ts` | 733 | 49 | 3 | 7 | 3 | 11 | **10** | visual builder + saved list |
| `reportExport.ts` | 786 | 22 | 3 | 4 | 2 | 7 | **6** | chart/map→PNG, export dialog, PDF/PPTX/DOCX |
| `prepare.ts` | 822 | 37 | 4 | 4 | 3 | 10 | **7** | transform pipeline UI |
| `mapRender.ts` | 829 | 34 | 4 | 3 | 3 | 2 | **6** | MapLibre GL maps, legends, geo periods |
| `datasets.ts` | 1,011 | 61 | 12 | 5 | 6 | 10 | **11** | import/preview/save, saved list, **paged Explorer** |
| `chartRender.ts` | 1,092 | 20 | 13 | 1 | 7 | 0 | **8** | `buildChart` (Chart.js engine), palette, `chartInstances` |
| `dashboards.ts` | 1,569 | 94 | 6 | 7 | 5 | 19 | **12** | list, editor, grid, cards, filters, present, export, share |
| **`hub.ts`** | **1,966** | **209** | **64** | **12** | **13** | **31** | **25** | everything else |
| **total** | **13,485** | **715** | **154** | — | — | 108 distinct | | |

### 2.3 What each file puts into the shared scope

Only the *public* symbols are listed (those another file reads). Private top-level symbols are
counted but not enumerated; they matter for the port only as "things that will become module-local
and stop leaking".

**`hub.ts` — 64 public symbols, the single largest port risk.** Five distinct clusters:

- *Toast + modals*: `showToast` (**51 call sites across 6 files**), `makeModalAccessible` (5 modals).
- *Chart `⋯` menu DOM*: `chartMenuEl`, `CURATED_COLORS`, and **22 element refs** — `cmCopyImg`,
  `cmDownload`, `cmCopyData`, `cmCustomToggle`, `cmCustomize`, `cmTitleInput`, `cmSwatches`,
  `cmShowLegend`, `cmLegendPos`, `cmLegendPosField`, `cmShowGridlines`, `cmYZero`, `cmYZeroRow`,
  `cmSort`, `cmSortField`, `cmNumFmt`, `cmSmooth`, `cmSmoothRow`, `cmAxisSection`, `cmXAxis`,
  `cmYAxis`, `cmReset` — **all 22 read and written by `chartControls.ts`**, plus the two dismiss
  handler slots `_chartMenuDismiss` / `_chartMenuEscape`.
- *Exec state + DOM*: `execBtn`, `execMenu`, `execModeSeg`, `execAgentList`, `execModelSel`,
  `execModelDl`, `execModelCli`, `execModelRefresh`, `execModelHint`, `_execDismiss`, `_execEsc`,
  `execMode`, `execByok`, `execLocal`, `execDidScan` — **all consumed by `execMenu.ts`** (16 reads of
  `execBtn` alone).
- *Tables*: `BYOK_AGENTS`, `BYOK_DISPLAY`, `RUNNABLE_LOCAL`, `MODEL_LIST_CLIS`, `LIVE_MODEL_CLIS`,
  `PROVIDER_LOGOS`, `AGENT_LOGOS`, `BRAND_BADGE`, `TILE_IDS`, `PROVIDER_MODELS`.
- *Entry state + formatters*: `entries`, `currentEntryId`, `showAnalyzeResult`, `_fmtVal`, `fmtWith`,
  `histogramBins`, `formatSidebarTime`, `openLightboxSrc`, `refreshKeyStatus`, `showSettingsPanel`,
  `closeSettingsMenu`.

**`chartRender.ts` — 13 public.** `buildChart` (8 call sites, 6 files), `chartInstances`,
`mapInstances`, `chartSeries`, `chartHasPeriodDropdown`, `chartIsSmallMultiple`,
`PER_SERIES_DATASET_TYPES`, `NO_VALUE_LABEL_TYPES`, `legendOnByDefault`, `valueLabelKeys`,
`getCSSVar`, `CHART_PALETTE`, `buildDataTable`. Depends on exactly one file (`hub.ts`, for `_fmtVal`
and `histogramBins`) — the cleanest large file in the tree.

**`datasets.ts` — 12 public.** `refreshDatasetList` (4 consumers), `initDatasets`, `openSavedDataset`,
`renderExplorerTable`, `loadExplorerStats`, `normalizeCols`, `dsEl`, `dsShow`, and the four open-entity
globals `expId` / `expName` / `expColumns` / `expRows`. `prepare.ts` reads **10 of these 12**
(17 references to `expId` alone) and `copilot.ts` reads `expId`/`expName`.

**`workspace.ts` — 7 public, 120 lines, the highest leverage-per-line in the tree.**
`currentProjectId` alone has **143 references across 8 files** (47 in `dashboards.ts`, 24 in
`visuals.ts`, 20 in `prepare.ts`, 17 in `datasets.ts`, 16 in `connections.ts`).

**`renderResult.ts` — 7 public.** `renderVizInArea` (10 call sites, 5 files), `VIZ_LABELS`,
`renderTurnResult`, `ALL_CHART_TYPE_IDS`, `buildVizPicker`, `eligibleChartTypes`,
`countNumericSeries`.

**`execMenu.ts` — 9 public**, all render functions called from `hub.ts`'s wiring:
`renderExecModeSeg`, `renderExecAgents`, `renderCliModelSelect`, `renderExecModel`,
`renderByokModelSelect`, `openExecMenu`, `closeExecMenu`, `updateExecBtnIcon`, `agentIconHTML`.

**`dashboards.ts` — 6 public** out of 94 top-level symbols (88 private — the best-encapsulated large
file). `dashCurrent` is read 7× by `copilot.ts`; `mkAiPanel` is reused by `prepare.ts`;
`destroyDashCharts` is called by `plotRender.ts`.

**`plotRender.ts` — 3 public**, consumed by exactly one file: `mosaicEnabled`, `mosaicCanRender`,
`renderMosaicViz` → `renderResult.ts`, in a **4-line branch**. See §4.5.

**`mapRender.ts` — 4 public**: `renderMapInArea`, `destroyMapInContainer`, `getMapInContainer`,
`waitForMapIdle`.

**`reportExport.ts` — 3 public**: `captureChartPNG`, `captureMapPNG`, `openExportDialog`.

**`chartControls.ts` — 5 public**: `addChartControls`, `openMiniMenu`, `openValuesMenu`, `dataToTSV`,
`persistOverride`.

**`projects.ts` — 3 public**, but one of them (`promptModal`) is consumed by 6 files.

**`prepare.ts` — 4**: `expSteps`, `initPrepare`, `resetPreparePanel`, `FILTER_OPS`.
**`visuals.ts` — 3**: `initVisuals`, `refreshVisualList`, `vizEditingId`.
**`connections.ts` — 2**: `initConnections`, `refreshConnectionList`.
**`copilot.ts` — 2**: `initCopilot`, `refreshCopilot`.
**`captureDataset.ts` — 4**: `openCaptureDatasetModal`, `startRecapture`, `maybeResumeRecapture`,
`captureHasExtractedTable`.
**`settingsPanels.ts` — 3**: `refreshExecPane`, `exShowMode`, `byokExpandProvider`.

**`customDropdown.ts`, `geoMatch.ts`, `mapWorker.ts` — 0 top-level symbols.** All three are IIFEs.
The first two attach to `window`/`global`; the third is pure side effect. These are the only three
files in the hub that do not participate in the shared scope, and consequently the only three that
already behave like modules.

### 2.4 The two shadowing near-misses

The automated cross-reference initially reported `plotRender.ts` as having 9 inbound dependents.
Hand-verification found this is wrong, and *why* it is wrong is a porting hazard in its own right:

`plotRender.ts` declares two top-level functions with extremely generic names — **`field()`**
(`plotRender.ts:154`) and **`requirement()`** (`plotRender.ts:162`). Both are in the one shared global
scope. Seven other files use `field` as a **local** identifier (15 occurrences in `hub.ts`, 8 in
`prepare.ts`, 7 in `settingsPanels.ts`, 4 in `chartControls.ts`, 2 in `connections.ts`, 1 each in
`dashboards.ts` and `execMenu.ts`), and `copilot.ts` uses `requirement` locally.

Today every one of those is shadowed by a `const`/`let`/parameter in an inner scope, so nothing
breaks. But there is **no mechanism preventing** a future edit from referencing `field` at a point
where the local is out of scope and silently binding to plotRender's spec-builder. TypeScript will
not complain — the symbol exists and is a function. This is the failure mode a global scope has and a
module system does not, and it is one of the stronger arguments for the port on its own terms.

**True cross-file bindings after correction: 154** (156 raw, minus these two).

**Zero genuine name collisions** across all 715 symbols. That is remarkable discipline for a
global-scope codebase of this size, and it means the port will not have to rename anything.

### 2.5 Full cross-file binding table

Read as: *symbol* ← *consumer file*(*occurrences*). This is the contract that must survive the port.

<details>
<summary>154 bindings (click to expand)</summary>

**from `hub.ts` (64)**
`showToast` ← reportExport(27) captureDataset(15) dashboards(8) chartControls(3) mapRender(1) ·
`chartMenuEl` ← chartControls(9) · `cmCustomToggle` `cmLegendPos` `cmNumFmt` `cmSort` `cmSwatches`
`cmXAxis` `cmYAxis` ← chartControls(6 each) · `cmCustomize` `cmTitleInput` `_chartMenuDismiss`
`_chartMenuEscape` ← chartControls(5 each) · `cmShowGridlines` `cmShowLegend` `cmSmooth` `cmYZero` ←
chartControls(4 each) · `cmAxisSection` `cmCopyData` `cmCopyImg` `cmDownload` `cmLegendPosField`
`cmReset` `cmSmoothRow` `cmSortField` `cmYZeroRow` ← chartControls(2 each) · `CURATED_COLORS` ←
chartControls(1) ·
`execBtn` `execModelSel` ← execMenu(16 each) · `execModelCli` ← execMenu(13) · `execLocal` ←
execMenu(12) · `execByok` ← execMenu(11) · `execMode` ← execMenu(10) · `execMenu` ← execMenu(9)
settingsPanels(1) · `execModelDl` `execModelRefresh` ← execMenu(8 each) · `execAgentList` ←
execMenu(7) · `_execDismiss` `_execEsc` ← execMenu(5 each) · `execModelHint` ← execMenu(4) ·
`execDidScan` `execModeSeg` ← execMenu(2 each) ·
`_fmtVal` ← chartRender(6) mapRender(6) · `openLightboxSrc` ← datasets(6) · `formatSidebarTime` ←
connections(2) dashboards(2) datasets(2) projects(2) visuals(2) · `entries` ← mapRender(3)
renderResult(2) chartControls(1) execMenu(1) settingsPanels(1) · `makeModalAccessible` ←
captureDataset(1) dashboards(1) projects(1) reportExport(1) · `fmtWith` ← dashboards(3) chartRender(1)
· `BYOK_DISPLAY` ← execMenu(3) settingsPanels(2) · `RUNNABLE_LOCAL` ← execMenu(3) settingsPanels(1) ·
`refreshKeyStatus` ← execMenu(2) settingsPanels(2) · `showSettingsPanel` ← execMenu(2) ·
`histogramBins` ← chartRender(2) · `BRAND_BADGE` `LIVE_MODEL_CLIS` ← execMenu(2 each) · `BYOK_AGENTS`
← execMenu(1) settingsPanels(2) · `MODEL_LIST_CLIS` `PROVIDER_MODELS` ← execMenu(1)
settingsPanels(1) · `AGENT_LOGOS` `PROVIDER_LOGOS` `TILE_IDS` `closeSettingsMenu` ← execMenu(1 each) ·
`currentEntryId` `showAnalyzeResult` ← renderResult(1 each)

**from `chartRender.ts` (13)**
`buildChart` ← chartControls(4) renderResult(4) reportExport(3) dashboards(1) mapRender(2) visuals(1) ·
`chartInstances` ← chartControls(4) renderResult(4) dashboards(3) plotRender(3) · `mapInstances` ←
mapRender(5) dashboards(1) · `getCSSVar` ← mapRender(5) reportExport(2) · `valueLabelKeys` ←
mapRender(3) · `chartSeries` ← chartControls(3) renderResult(2) · `chartIsSmallMultiple` ←
chartControls(2) renderResult(1) · `CHART_PALETTE` ← plotRender(3) · `buildDataTable` ← plotRender(1)
renderResult(1) · `chartHasPeriodDropdown` `legendOnByDefault` `NO_VALUE_LABEL_TYPES`
`PER_SERIES_DATASET_TYPES` ← chartControls(1 each)

**from `workspace.ts` (7)**
`currentProjectId` ← dashboards(47) visuals(24) prepare(20) datasets(17) connections(16) copilot(6)
captureDataset(4) projects(3) · `selectSection` ← captureDataset(3) · `openWorkspace` ← projects(3) ·
`ensureWorkspaceForCapture` ← hub(2) · `showHome` ← projects(2) · `initWorkspaceRouter` ← hub(1) ·
`currentSection` ← copilot(1)

**from `datasets.ts` (12)**
`expId` ← prepare(17) copilot(4) · `expColumns` ← prepare(6) · `refreshDatasetList` ← connections(5)
captureDataset(3) prepare(3) workspace(2) · `expName` ← copilot(4) · `expRows` `normalizeCols`
`renderExplorerTable` `loadExplorerStats` ← prepare(2 each) · `dsEl` `dsShow` `openSavedDataset` ←
prepare(1 each) · `initDatasets` ← hub(1)

**from `renderResult.ts` (7)**
`renderVizInArea` ← chartControls(6) visuals(5) dashboards(4) plotRender(4) reportExport(1) ·
`buildVizPicker` ← visuals(4) reportExport(2) · `VIZ_LABELS` ← visuals(4) dashboards(2)
reportExport(1) · `ALL_CHART_TYPE_IDS` ← visuals(2) plotRender(1) reportExport(1) · `renderTurnResult`
← hub(2) visuals(1) · `countNumericSeries` `eligibleChartTypes` ← visuals(2 each)

**from `execMenu.ts` (9)** `closeExecMenu` ← hub(4) · `agentIconHTML` ← settingsPanels(4) ·
`updateExecBtnIcon` ← hub(3) · `openExecMenu` `renderByokModelSelect` `renderCliModelSelect`
`renderExecAgents` `renderExecModel` `renderExecModeSeg` ← hub(1 each)

**from `projects.ts` (3)** `promptModal` ← dashboards(10) visuals(2) captureDataset(1) datasets(1)
hub(1) prepare(1) · `initHome` ← hub(1) · `renderHomeGallery` ← workspace(1)

**from `dashboards.ts` (6)** `dashCurrent` ← copilot(7) · `mkAiPanel` ← prepare(2) ·
`destroyDashCharts` ← plotRender(1) · `dashChooseModal` `initDashboards` ← hub(1 each) ·
`refreshDashboardList` ← workspace(2)

**from `mapRender.ts` (4)** `destroyMapInContainer` ← dashboards(2) reportExport(2) renderResult(1) ·
`renderMapInArea` ← renderResult(2) reportExport(2) · `getMapInContainer` `waitForMapIdle` ←
reportExport(2 each)

**from `chartControls.ts` (5)** `addChartControls` ← renderResult(2) · `dataToTSV` `openMiniMenu`
`openValuesMenu` ← mapRender(1 each) · `persistOverride` ← visuals(1)

**from `reportExport.ts` (3)** `openExportDialog` ← renderResult(2) · `captureChartPNG` ←
dashboards(1) renderResult(1) · `captureMapPNG` ← dashboards(1)

**from `prepare.ts` (4)** `FILTER_OPS` ← visuals(2) · `expSteps` `resetPreparePanel` ←
datasets(1 each) · `initPrepare` ← hub(1)

**from `captureDataset.ts` (4)** `startRecapture` ← datasets(5) · `captureHasExtractedTable`
`maybeResumeRecapture` `openCaptureDatasetModal` ← hub(3 each)

**from `settingsPanels.ts` (3)** `refreshExecPane` ← hub(3) · `byokExpandProvider` `exShowMode` ←
execMenu(2 each)

**from `visuals.ts` (3)** `vizEditingId` ← copilot(4) · `refreshVisualList` ← workspace(2) ·
`initVisuals` ← hub(1)

**from `connections.ts` (2)** `refreshConnectionList` ← workspace(2) · `initConnections` ← hub(1)

**from `copilot.ts` (2)** `refreshCopilot` ← workspace(2) · `initCopilot` ← hub(1)

**from `plotRender.ts` (3)** `mosaicCanRender` `mosaicEnabled` `renderMosaicViz` ←
renderResult(1 each)

**via `window` (not top-level symbols)** `makeDropdown` ← hub(1) settingsPanels(2) ·
`normalizeName`/`matchGeoItem` ← mapRender(10)

</details>

---

## 3. The load-order question

`CLAUDE.md` states: *"many `<script>` files sharing one global scope (call-time resolution, so load
order is irrelevant)."*

**That claim is false.** It is true of the ~95% of the code that resolves inside function bodies, and
it is what every file's header comment reasonably asserts about itself. But there are **four hard
load-order dependencies**, one of which is a documented invariant and three of which are not, plus a
whole-file class of ordering risk. Reordering the `<script>` tags in `index.html` breaks the app.

The current order (`index.html:1443-1493`) is:

```
1443  chart.js UMD ─┐
1444  treemap        │ vendor
1445  matrix         │
1446  sankey         │
1447  financial      │
1448  boxplot       ─┘
1451  vendor/vgplot.js
1459  maplibre-gl-csp.js
1460  mapWorker.js          ← app code begins
1464  pdfmake  1465 vfs_fonts  1468 pptxgen  1471 docx
1472  world-countries.js  1473 us-states.js
1474  geoMatch.js
1475  chartRender.js   1476 plotRender.js   1477 reportExport.js   1478 mapRender.js
1479  renderResult.js  1480 chartControls.js
1481  customDropdown.js
1482  execMenu.js      1483 settingsPanels.js
1484  projects.js      1485 workspace.js    1486 datasets.js       1487 captureDataset.js
1488  prepare.js       1489 connections.js  1490 visuals.js        1491 dashboards.js
1492  copilot.js
1493  hub.js           ← last
```

### 3.1 Hazard L1 — `mapWorker.ts` must run after `maplibre-gl-csp.js` and before any map

**Documented.** `mapWorker.ts:9-13` says so in prose: *"Ordering matters: this runs at top level
immediately after maplibre-gl-csp.js and before every other hub script, so no map can be constructed
before the worker URL is set. Keep the `<script>` tags in index.html in that order."*

The file is a bare IIFE that guards on `typeof maplibregl === 'undefined'` and **returns silently**
if the UMD has not loaded. So getting the order wrong does not throw — it produces a MapLibre with no
worker URL, and maps fail later, elsewhere, with a different error.

*Port action.* This becomes three lines at the very top of the Svelte app entry, before any component
imports. It is the single easiest thing on this list to get right and the easiest to forget.

### 3.2 Hazard L2 — `chartRender.ts` registers the boxplot plugin at parse time

```js
// chartRender.ts:14
if (window.Chart && window.ChartBoxPlot && window.ChartBoxPlot.BoxPlotController) {
  try { window.Chart.register(window.ChartBoxPlot.BoxPlotController, window.ChartBoxPlot.BoxAndWiskers); } catch (_) {}
}
```

Undocumented as an ordering constraint. Guarded, so it fails **silently** — the boxplot chart type
just renders nothing. Note the comment above it: treemap/matrix/sankey/financial self-register with
the global `Chart`, so those four also depend on `chart.umd.js` having loaded first, but they enforce
it themselves.

*Port action.* Explicit `Chart.register(...)` in a module with a real import graph. Add a parity check
that renders a boxplot — nothing in `npm test` does.

### 3.3 Hazard L3 — `hub.ts:400` calls `makeDropdown()` at parse time

```js
// hub.ts:400
const execModelCli = makeDropdown({ className: 'exec-model-dd', ariaLabel: 'Model', onChange: onExecModelChange });
// hub.ts:403
if (execModelHint && execModelHint.parentNode) execModelHint.parentNode.insertBefore(execModelCli.el, execModelHint);
```

`makeDropdown` is not a top-level function declaration — it is assigned to `window` inside
`customDropdown.ts`'s IIFE (`customDropdown.ts:246`). Function-declaration hoisting does not help,
and hoisting does not cross `<script>` boundaries anyway. This works **only** because
`customDropdown.js` is at line 1481 and `hub.js` at 1493.

This one **throws**: move `hub.js` above `customDropdown.js` and boot dies with
`makeDropdown is not defined` before a single pixel paints. It is also the one the type system
actively hides — `globals.d.ts:251` declares `function makeDropdown(...)` as an ambient global, so TS
sees a hoisted function that does not exist at runtime.

(Note the same line passes `onChange: onExecModelChange`, a function declared *later in `hub.ts`* —
that one is safe, because intra-file function declarations do hoist.)

*Port action.* `<Dropdown>` becomes a component; the call site becomes markup. This hazard disappears
entirely — it is one of the clearest wins in the port.

### 3.4 Hazard L4 — `hub.ts`'s `initWorkspaceShell()` IIFE calls into 7 other files at parse time

```js
// hub.ts:172-183
(function initWorkspaceShell() {
  const win = document.querySelector('.win');
  if (win) win.setAttribute('data-view', 'home');
  initWorkspaceRouter(); // workspace.ts
  initHome();            // projects.ts
  initDatasets();        // datasets.ts
  initPrepare();         // prepare.ts
  initConnections();     // connections.ts
  initVisuals();         // visuals.ts
  initDashboards();      // dashboards.ts
  initCopilot();         // copilot.ts
})();
```

The comment above it is explicit: *"Defined in projects.ts / workspace.ts, which load before hub.js."*
This is **eight parse-time cross-file calls** and it is the reason `hub.js` is last. It throws
immediately on any reordering.

This is also the app's de-facto `main()`. There is no `DOMContentLoaded` — the scripts are at the end
of `<body>`, so the DOM is already parsed, and boot is "the last script's top-level statements".

*Port action.* This is the natural root of `App.svelte`'s mount. Each `initX()` becomes a component
`onMount` or simply the component existing. The eight-way parse-time coupling collapses to a tree.

### 3.5 Hazard L5 — `showPermissionPanel()` is called and defined nowhere

`globals.d.ts:255-258` documents this in full:

> PRE-EXISTING BUG (present in the original hub.js): called in the `stpTestPerm` click handler but
> defined nowhere, so it throws at runtime. Declared here to preserve that exact behavior through the
> migration; fix separately.

Call site: `hub.ts:1949` — Settings → General → **"Test permission screen"**. Clicking it hides the
settings panel and then throws `ReferenceError`. `#permission-panel` (O3) exists in the HTML, is
fully styled (173 lines of `permission.css` for the dead standalone twin, plus rules in `hub.css`),
and is **unreachable by any path**. The bridge's `onShowPermission` is also never subscribed (§2.2).

*Port action.* This is a **parity decision, not a bug fix**. Three options: (a) reproduce the throw
(absurd), (b) wire the panel up (a feature, needs sign-off), (c) remove the button and the panel
(deletes a screen). The gate must record which was chosen. Do not let a Svelte port silently
"fix" it by making the button work — that is a behaviour change smuggled in under a refactor.

### 3.6 The broader class: 63 parse-time statements in `hub.ts`, 109 parse-time DOM bindings

Beyond the four named hazards, `hub.ts` executes **63 top-level non-declaration statements** and binds
**90 elements via `getElementById` at parse time** (`settingsPanels.ts` binds another 19). Every one
of those is a *hidden* ordering dependency on the HTML: the element must exist in `index.html` at the
moment the script runs. `const cmSwatches = document.getElementById('cm-swatches')` at `hub.ts:1138`
only works because the `chartMenuEl` IIFE thirty lines earlier already set `innerHTML` and appended
to `document.body` — an intra-file ordering constraint the code comments (`hub.ts:996`).

Also parse-time in `hub.ts`:

- `PROVIDER_LOGOS` / `AGENT_LOGOS` read `window.hub.providerLogos` / `.agentLogos` **synchronously**
  (`hub.ts:383-386`) — a preload-injected value, not an IPC call. If the bridge is not yet present
  they silently become `{}` and every brand logo degrades to a styled badge.
- `console.log('[logos] …')` (`hub.ts:389`) — a diagnostic that fires on every boot.
- `applyHotkeyLabel()` (`hub.ts:73`), `applyEffectiveTheme(...)` (`hub.ts:137`), `refreshKeyStatus()`
  (`hub.ts:686`), `applyReadiness(false)` (`hub.ts:546`).
- Three IIFEs: `initSplash` (two `setTimeout`s), `initTheme` (async), `initExecButtonIcon`.
- A `MutationObserver` on `html[data-theme]` (`hub.ts:1310`) — see §6.13.
- 12 top-level `addEventListener` calls and 4 `window.hub.on*` subscriptions.

By contrast **17 of the 21 files have zero parse-time statements** and do all their wiring inside an
`initX()` called from L4. That is the pattern the port should generalise.

### 3.7 Verdict

> Load order is irrelevant **for symbol resolution inside function bodies**, which is where ~95% of
> the code lives. It is **load-bearing** for: the MapLibre worker bootstrap (L1), the Chart.js boxplot
> registration (L2), `hub.ts`'s parse-time `makeDropdown()` call (L3), and `hub.ts`'s eight-way
> `initWorkspaceShell()` boot (L4). Two of the four fail silently; two throw. The claim in `CLAUDE.md`
> should be amended rather than repeated.

---

## 4. Component decomposition proposal

### 4.1 The shape of the answer

Three layers, and the boundary between them is the whole design:

1. **Svelte components** — everything that is *DOM the user reads and clicks*. Forms, lists, panels,
   menus, grids, cards.
2. **Imperative modules, imported not componentized** — the three chart engines and the export
   pipeline. `buildChart` is 1,092 lines of Chart.js configuration that already owns its canvas;
   MapLibre owns a WebGL context; vgplot returns a DOM node. Wrapping these in components buys
   nothing and risks Svelte's DOM lifecycle fighting the library's. They get **one** component each
   as a mount point.
3. **Stores** — the ~30 shared mutable globals. Design owned by
   [`03-state-ipc.md`](03-state-ipc.md) §3; this document only names which component reads which.

### 4.2 Proposed tree

```
main.ts                          ← L1 MapLibre worker bootstrap, L2 Chart.register, theme boot
└── App.svelte                   ← replaces hub.ts:172 initWorkspaceShell (L4)
    ├── Splash.svelte                                   [P1]
    ├── TitleBar.svelte                                 [P2]
    │
    ├── {#if $view === 'home'}
    │   └── HomeGallery.svelte                          [P3]
    │       ├── ProjectCard.svelte  (+ CardMenu)        [T8]
    │       └── HomeEmpty.svelte
    │
    ├── {:else}  Workspace.svelte
    │   ├── WorkspaceNav.svelte
    │   │
    │   ├── {#if $section === 'sources'}                [P4]
    │   │   ├── Sidebar.svelte
    │   │   │   ├── SearchBox.svelte                    [S1]
    │   │   │   ├── HistoryRail.svelte → HistoryItem    [S2]
    │   │   │   ├── SidebarEmpty.svelte                 [S3]
    │   │   │   └── SidebarFooter.svelte (KeyBadge,     [S4]
    │   │   │        HelpButton)
    │   │   └── SourcesMain.svelte
    │   │       ├── MainHeader.svelte                   [S5]
    │   │       ├── HotkeyFailBanner.svelte             [S6]
    │   │       ├── EmptyState.svelte                   [S7]
    │   │       │   └── ReadinessBanner.svelte          [S8]
    │   │       ├── CaptureView.svelte                  [S9]
    │   │       │   ├── ThumbSection.svelte             [S9a]
    │   │       │   ├── LoadingSteps.svelte             [S9b]
    │   │       │   ├── ErrorPanel.svelte               [S9c]
    │   │       │   ├── Thread.svelte                   [S9d]
    │   │       │   │   └── Turn.svelte (×N)
    │   │       │   │       ├── Headline / Metrics / Details
    │   │       │   │       ├── VizPicker.svelte    ←── shared
    │   │       │   │       ├── VizArea.svelte      ←── shared, THE SEAM
    │   │       │   │       └── ChartControls.svelte ←─ shared
    │   │       │   └── FollowupComposer.svelte         [S9e]
    │   │       └── ConnectPanel.svelte                 [S10]
    │   │           ├── ConnForm.svelte                 [S11]
    │   │           ├── ConnRunArea.svelte              [S12]
    │   │           └── SavedConnections.svelte         [S13]
    │   │
    │   ├── {:else if $section === 'datasets'}          [P5]
    │   │   └── DatasetsSection.svelte
    │   │       ├── ImportToolbar / PasteBox / SheetPicker   [S14]
    │   │       ├── ParsePreview / Warnings / SaveBar        [S15]
    │   │       ├── SavedDatasetList.svelte                  [S16]
    │   │       └── DatasetExplorer.svelte                   [S17]
    │   │           ├── CaptureStrip / QualityFlags / ExplainOut
    │   │           ├── ExplorerToolbar.svelte (+ ColumnsMenu [O11])
    │   │           ├── PreparePanel.svelte                  [S19]
    │   │           │   ├── StepList.svelte → StepRow
    │   │           │   ├── StepTypeMenu.svelte              [O12]
    │   │           │   ├── StepEditor.svelte  (8 step types)
    │   │           │   ├── AiInterpPanel.svelte ←── shared  [S20]
    │   │           │   └── CombineBox.svelte
    │   │           └── ExplorerGrid.svelte  (paged)         [S18]
    │   │
    │   ├── {:else if $section === 'visuals'}           [P6]
    │   │   └── VisualsSection.svelte
    │   │       ├── VisualBuilder.svelte                     [S21]
    │   │       │   ├── EncodingRow / MeasureRow (×N)
    │   │       │   └── FilterRow (×N)                       [S22]
    │   │       ├── VizPicker.svelte    ←── shared           [S23]
    │   │       ├── VizArea.svelte      ←── shared
    │   │       └── SavedVisualList.svelte                   [S24]
    │   │
    │   ├── {:else if $section === 'dashboards'}        [P7]
    │   │   └── DashboardsSection.svelte
    │   │       ├── DashboardList.svelte                     [S25]
    │   │       └── DashboardEditor.svelte
    │   │           ├── EditorHead.svelte                    [S26]
    │   │           ├── DashToolbar.svelte                   [S27]
    │   │           │   ├── FilterBar → FilterChip (×N)
    │   │           │   ├── QuickControls
    │   │           │   └── ToolbarActions
    │   │           ├── AiInterpPanel.svelte ←── shared      [S28]
    │   │           ├── PageTabs.svelte                      [S29]
    │   │           ├── DashGrid.svelte → DashCard.svelte
    │   │           │      ├── VisualCard.svelte → VizArea ←── shared
    │   │           │      ├── MetricCard.svelte
    │   │           │      └── TextCard.svelte
    │   │           └── Starters.svelte                      [S30]
    │   │
    │   └── {:else}  CopilotPanel.svelte                [P8][S31]
    │       ├── CopilotHint / ContextChip
    │       ├── MessageList.svelte → Message
    │       └── Composer.svelte
    │
    └── ── app-level singletons, mounted once ──────────────────────
        ├── SettingsPanel.svelte                        [O1]
        │   ├── ExecPane.svelte
        │   │   ├── LocalCliPanel.svelte                [O1a]
        │   │   └── ByokPanel.svelte → ByokCard (×4)    [O1b]
        │   ├── HotkeyPane / RulesPane / AppearancePane
        │   ├── NotificationsPane / GeneralPane / AboutPane
        ├── AboutPanel.svelte                           [O2]
        ├── PermissionPanel.svelte                      [O3]  ← see §3.5
        ├── Lightbox.svelte                             [O4]
        ├── ToastHost.svelte        ← store-driven      [O5]
        ├── ImageActionMenu.svelte                      [O6]
        ├── ExecMenu.svelte                             [O7]
        ├── SettingsMenu.svelte                         [O8]
        ├── HelpMenu.svelte                             [O9]
        ├── ChartMenu.svelte        ← store-driven      [O10]
        └── ModalHost.svelte        ← store-driven      [T1-T5]
            ├── PromptModal / ChooseModal / ShareModal
            ├── CaptureDatasetModal
            └── ExportDialog

── imperative modules (imported, NOT components) ──────────────────
   chart.ts        ← chartRender.ts   (buildChart, palette, chartInstances)
   map.ts          ← mapRender.ts     (MapLibre)
   plot.ts         ← plotRender.ts    (Mosaic/vgplot, dark)
   exportReport.ts ← reportExport.ts  (PNG / PDF / PPTX / DOCX)
   geoMatch.ts     ← unchanged, pure
   vizPickerLogic  ← renderResult.ts's eligibleChartTypes / VIZ_LABELS /
                     ALL_CHART_TYPE_IDS / countNumericSeries
```

**Count: ~78 components + 6 imperative modules + ~12 stores.**

### 4.3 The four shared components

`VizArea`, `VizPicker`, `ChartControls` and `AiInterpPanel` are used from three or four different
sections each. Getting their prop contracts right is most of the port's design work.

**`VizArea.svelte`** replaces `renderVizInArea(container, data, type, entry, turnIdx, source?)` —
10 call sites in 5 files. Props: `{ data, type, entry?, turnIdx?, source? }`. It owns exactly one
`<div bind:this={container}>` and calls the imperative engines in an effect. Its teardown must destroy
the Chart.js instance(s) **and** the MapLibre map — see §6.6, §6.7.

**`ChartControls.svelte`** replaces `addChartControls`, which today *appends* its control cluster into
the caller's container. As a component it becomes a sibling of `VizArea`, driven by the same props.

**`ChartMenu.svelte`** is the hardest single component in the port. Today it is one popover element
built once at `hub.ts:1009`, with **22 module-level element refs in `hub.ts` that `chartControls.ts`
reads and writes directly**. In Svelte it becomes one always-mounted instance driven by a
`chartMenu` store holding `{ open, anchorRect, entry, overrideKey, type, customizeExpanded }`, and the
22 refs become bound values. This one change removes 24 of `hub.ts`'s 64 public symbols.

### 4.4 Where the current structure actively resists componentization

Twelve concrete resisters, worst first.

**R1 — `hub.ts` is a god file that other files reach into.** 209 top-level symbols, 64 read by 12
other files, 31 bridge methods, 63 parse-time statements. It is simultaneously the app entry, the
capture controller, the chart-menu DOM, the exec state, the settings modal, the theme engine, the
toast, the lightbox, and six shared formatters. It cannot be ported as a unit and it cannot be ported
last-as-written; it has to be *dismantled* into ~8 destinations. See §5.

**R2 — 22 DOM element refs owned by one file, mutated by another.** `chartControls.ts` does
`cmTitleInput.value = …`, `cmSort.value = …`, `cmShowLegend.setAttribute('aria-checked', …)` on
elements declared in `hub.ts`. This is the single most Svelte-hostile pattern in the tree: two files
sharing mutable DOM handles with no interface between them.

**R3 — `chartInstances` / `mapInstances` are `WeakMap`s keyed on a container DOM node.**
`chartInstances` is written by `chartRender.ts` and `plotRender.ts`, and read/deleted by
`renderResult.ts`, `chartControls.ts`, `dashboards.ts` and `plotRender.ts` (14 references across 4
files). Svelte owns the lifetime of that container node. If Svelte recreates the node — a keyed
`{#each}` reorder, an `{#if}` flip — the WeakMap entry becomes unreachable and the Chart.js instance
is **never destroyed**: a leaked canvas plus a live animation frame loop. This is a leak Svelte makes
*easier* to introduce than the current code does.

**R4 — imperative container ownership.** `renderVizInArea` does `container.innerHTML = ''` and then
builds into it. So do `renderThread` (`hub.ts:1327`), `renderDashGrid`, `renderExplorerTable`, and
~60 other `innerHTML` sites (`hub.ts` 17, `dashboards.ts` 15, `datasets.ts` 12, `prepare.ts` 12,
`visuals.ts` 11, `execMenu.ts` 9, `settingsPanels.ts` 9, `renderResult.ts` 8, `connections.ts` 6,
`mapRender.ts` 5, others 1-2 each — **~110 total**). Every one is a place where Svelte and the old
code would both claim ownership of the same subtree. The port must be all-or-nothing per subtree.

**R5 — `currentProjectId` is a bare `let` mutated by one file and read by eight.** 143 references. It
must become a store on day one, before any section is ported, or the two worlds desynchronise.
(Design: [`03-state-ipc.md`](03-state-ipc.md) §3.2.)

**R6 — `copilot.ts` reads three other sections' private editing state.** `expId`/`expName`
(datasets), `vizEditingId` (visuals), `dashCurrent` (dashboards) — 15 references. Its own header
comment calls this a feature: *"No new state tracking: buildCopilotContextRef() reads the existing
open-entity globals directly."* It is a feature only while everything shares one scope. It needs an
explicit `openEntity` store, and that store has to exist before *either* copilot or any of the three
owners is ported.

**R7 — `entries` is an array mutated in place.** `entries.length = 0` (`hub.ts:836`), `unshift`
(1552), `push` (1597), `splice` (846), `find` (721). Not reactive under any framework without either
reassignment or a proxy. And the ordering rule is subtle: **session entries are prepended, history
entries are appended** (`hub.ts:1552` vs `1576-1598`). A naive `[...entries, x]` port loses it.

**R8 — `makeDropdown` returns a DOM-owning object with `Object.defineProperty` accessors.** Callers
hold the API object and write to it like a `<select>`: `execModelCli.hidden = true` (`hub.ts:404`),
`.value = …`, `.disabled = …`, `.placeholder = …`, plus `setOptions()`. It also stashes itself back on
the element (`root._dd = api`, typed in `globals.d.ts:243`), portals its listbox into `document.body`,
and keeps a module-level `openDd` singleton so only one dropdown is open app-wide. Three instances
exist (`hub.ts:400`, `settingsPanels.ts:267`, `settingsPanels.ts:475`). None of it survives as-is;
all of it must be re-expressed as props + a shared `openDropdown` store.

**R9 — CSS visibility crosses component boundaries.** 28 attribute-selector rules where the *ancestor*
carries the state and the *descendant* is styled (§1.1), plus `html[data-theme]`, `html[data-os]`,
`html.dash-presenting`. `hub.css` is 6,069 lines with 748 class selectors and only 8 id selectors —
class-heavy, which is good news — but it is one global sheet, and Svelte's scoping will silently
delete rules whose two halves land in different components.

**R10 — five `document.body` portals.** `chartMenuEl` (`hub.ts:1127`), `openMiniMenu`
(`chartControls.ts:270`), the dropdown listbox (`customDropdown.ts:155`), `promptModal`
(`projects.ts:122`), `openCaptureDatasetModal` (`captureDataset.ts:60`), plus `dashChooseModal` and
the share/export dialogs. Svelte has no built-in portal; each needs an explicit host component or an
action.

**R11 — `persistOverride` duck-types two different persistence routes through one function.**
```js
// chartControls.ts:102
function persistOverride(entry, overrideKey, merged) {
  if (typeof entry.saveOverride === 'function') { entry.saveOverride(merged); return; }   // Visuals
  if (window.hub && window.hub.saveChartOverrides) {                                       // capture history
    window.hub.saveChartOverrides(entry.id, overrideKey, merged).catch(() => {});
  }
```
`visuals.ts` constructs an "adapter entry" with a `saveOverride` closure and hands it to the same
chart machinery the capture surface uses. Two write paths, one call site, no type. This is a
*deliberate* reuse and it works; a port must keep the seam, ideally as a discriminated prop rather
than a duck-typed method.

**R12 — the `entry` shape is the chart layer's real input type, and it is undeclared.** `entry` flows
into `renderVizInArea`, `addChartControls`, `renderTurnResult`, `openChartMenu` and `persistOverride`,
carrying `{ id, state, turns[], result, chartOverrides, saveOverride? }`. It is `any` everywhere. Also
covered as a state problem in [`03-state-ipc.md`](03-state-ipc.md) §7.3; as a *component* problem it
means five components share an untyped prop.

---

## 5. Ranked port order

Ranked by coupling, not size. The metric is `out + in` from §2.2, adjusted for the two symbols
(`promptModal`, `showToast`) that inflate several files' inbound counts and should be extracted before
anything else. Every tier states what it unblocks.

### Tier 0 — infrastructure (not screens; do these first or nothing else works)

| # | Item | Lines | Coupling | Why first |
|---|---|---:|---:|---|
| 0.1 | Build + CSP pipeline | — | — | Svelte needs a bundler; the repo has **none** (`tsc` only). The hub CSP is `script-src 'self'; style-src 'self'` with no `unsafe-inline`. Svelte injects `<style>` unless compiled to a file. This is the same class of problem `scripts/build-vendor.js` solved for Plot (`docs/phase-3c/` §2) — solve it the same way, and make the build **fail loudly** if an inline style or `new Function(` reaches the bundle. |
| 0.2 | `mapWorker` bootstrap + `Chart.register` | 33 | 0 | Hazards L1, L2. Three lines in the entry module. |
| 0.3 | Store skeleton: `view`, `section`, `currentProjectId`, `theme` | — | — | R5. Must exist before **any** section is ported, because both worlds will read it. See [`03-state-ipc.md`](03-state-ipc.md) §6.2 for the accessor bridge that lets vanilla `currentProjectId` and the store stay in sync during the transition. |
| 0.4 | `geoMatch.ts` | 49 | 1 | Already pure and already `require`-able. Convert to a real module; the Node self-check (`scripts/test-geo-match.js`) keeps passing. |

### Tier 1 — leaf widgets (extract the symbols that inflate everyone else's coupling)

| # | Item | Lines | Coupling | Removes |
|---|---|---:|---:|---|
| 1.1 | **`<Dropdown>`** ← `customDropdown.ts` | 248 | **0 out / 2 in** | The most isolated non-trivial file in the tree: zero cross-file reads, zero bridge calls, one `window` export. Kills hazard L3. Unblocks ExecMenu and the BYOK panes. |
| 1.2 | **`<ToastHost>` + toast store** ← `showToast` | ~15 | 0 out | Removes **51 call sites / 5 inbound edges** from `hub.ts`. |
| 1.3 | **`<Modal>` + `makeModalAccessible`** ← `hub.ts:1840` | ~30 | 0 out | The focus trap used by 5 modals (§6.11). Removes 4 inbound edges from `hub.ts`. |
| 1.4 | **`<PromptModal>` + modal store** ← `projects.ts:118` | ~60 | 0 out | Removes **12 call sites / 6 inbound edges** from `projects.ts`. After this, `projects.ts`'s coupling drops from 9 to **3**. |

Tier 1 is ~350 lines and removes **15 inbound dependency edges** from the graph. Do not skip it: it is
what makes Tier 2 small.

### Tier 2 — first real screens (prove the pipeline end to end)

| # | Screen | File | Lines | Coupling | Why here |
|---|---|---|---:|---:|---|
| 2.1 | **Overlay window** | `renderer/overlay/overlay.ts` | 89 | **0** | Its own `BrowserWindow`, its own preload, **zero shared globals**, 5 event handlers, 1 IPC in / 2 out. It proves the build, the CSP, and the preload bridge against a real user-facing surface, at 89 lines, with a blast radius of exactly one window. **Port this first.** |
| 2.2 | Status window | `renderer/status/status.ts` | 16 | 0 | 16 lines. Error path only. Free. |
| 2.3 | **Home / project gallery** | `projects.ts` | 211 | **3** (after 1.4) | The first hub screen. Reads only `currentProjectId`, `openWorkspace`, `showHome`, `formatSidebarTime`. 5 bridge methods, all CRUD. |
| 2.4 | Workspace router + nav | `workspace.ts` | 120 | 6 out / 9 in | 120 lines, but the hub's spine. Port immediately after Home so the two-view flip is Svelte-owned before any section moves. Its 9 inbound edges are 6× `currentProjectId` (already a store from 0.3) + 5 `refreshX()` calls that become `{#if}` mounts. |

### Tier 3 — self-contained sections (no chart dependency)

| # | Screen | File | Lines | Coupling | Notes |
|---|---|---|---:|---:|---|
| 3.1 | Connect-data panel | `connections.ts` | 485 | **3 out / 2 in** | Forms + list + preview table. Zero chart code. 8 bridge methods. The security invariant (password/token write-only, never read back) must be re-asserted in review. |
| 3.2 | Copilot | `copilot.ts` | 302 | 4 out / 2 in | Small, but blocked on the `openEntity` store (R6). Port the store with it. |
| 3.3 | Settings: exec panes | `settingsPanels.ts` | 656 | **2 out / 2 in** | 15 bridge methods, 19 parse-time DOM refs, 44 top-level symbols of which only 3 are public. Highly self-contained despite its size. Needs `<Dropdown>` (1.1). |
| 3.4 | Exec menu popup | `execMenu.ts` | 451 | 2 out / 2 in | 32 references into `hub.ts`'s exec state. Must be ported **together with** the exec store carved out of `hub.ts` — this is the first forced incision into the god file. |

### Tier 4 — the chart seam

| # | Item | Files | Lines | Notes |
|---|---|---|---:|---|
| 4.1 | `chart.ts` / `map.ts` / `plot.ts` / `exportReport.ts` as modules | `chartRender`, `mapRender`, `plotRender`, `reportExport` | 3,398 | **Mechanical**: add imports/exports, change nothing else. `chartRender.ts` depends on exactly one other file. |
| 4.2 | `<VizArea>` + `<VizPicker>` | `renderResult.ts` | 635 | The seam. Owns Chart.js/MapLibre/Mosaic teardown (R3, §6.6-6.7). |
| 4.3 | `<ChartMenu>` + `<ChartControls>` | `chartControls.ts` + `hub.ts:989-1164` | 474 + 175 | R2. Moves 24 symbols out of `hub.ts`. |

### Tier 5 — data sections

| # | Screen | File | Lines | Coupling | Notes |
|---|---|---|---:|---:|---|
| 5.1 | Datasets + Explorer | `datasets.ts` | 1,011 | 5 out / 6 in | The paged grid (§6.4) and the two undeclared bridge methods (§2.1) are the risk. |
| 5.2 | Prepare | `prepare.ts` | 822 | 4 out / 3 in | Reads **10 of `datasets.ts`'s 12** public symbols. Port in the same change as 5.1 or immediately after; they are one screen in two files. |
| 5.3 | Visuals | `visuals.ts` | 733 | 7 out / 3 in | Highest outbound of any section. Blocked on Tier 4. |
| 5.4 | Dashboards | `dashboards.ts` | 1,569 | 7 out / 5 in | Largest section. Blocked on Tier 4 + metric cards + export. Presentation mode and debounced autosave are the parity risks (§6.16, §6.18). |

### Tier 6 — last

| # | Screen | File | Lines | Coupling | Why last |
|---|---|---|---:|---:|---|
| 6.1 | **Sources / capture surface** | `hub.ts` remainder | ~1,000 after Tiers 1-4 carve out ~950 | **25** | Highest coupling in the tree by a factor of two: 12 outbound + 13 inbound edges, 64 public symbols, 31 bridge methods, 63 parse-time statements, 90 parse-time DOM refs, 4 push-channel subscriptions, and all four load-order hazards. Everything else reads *from* it, so every earlier tier shrinks it; porting it first would mean porting everything at once. |

**Summary of the argument.** First = `renderer/overlay/overlay.ts`: 89 lines, **zero** shared globals,
its own window — the only surface in the tree where a mistake cannot reach anything else. Last =
`hub.ts`: coupling 25, the next highest is 15. Between them, the order is strictly ascending coupling,
with the one exception that Tier 1's four extractions run before everything because each one *removes*
edges from the graph rather than traversing them.

---

## 6. Stateful behaviour a naive port would silently lose

Each item: what it is, where it lives, and the specific way a straightforward Svelte rewrite loses it.
**These are parity checklist items, not code review notes** — none of them is visible in a screenshot
and none is covered by `npm test`.

### Selection and navigation

**6.1 — History rail selection.** `currentEntryId` (`hub.ts:716`) plus a class toggled by DOM query:
`el.classList.toggle('cap-hist-item-active', el.dataset.entryId === String(id))` (`hub.ts:862`), and
cleared by `querySelectorAll(...).forEach(el => el.classList.remove(...))` (`hub.ts:1478`). Deleting
the selected entry resets to the empty state (`hub.ts:848`). *Loss:* a keyed `{#each}` port must drive
the class from the store; the imperative clear at 1478 has no equivalent and will be forgotten.

**6.2 — Thread scroll position.** `renderThread` does `cvThread.innerHTML = ''` and rebuilds
(`hub.ts:1325-1327`), so **scroll resets to top on every re-render today** — including on theme change
(§6.13). A keyed-`{#each}` Svelte port would *preserve* scroll. That is arguably better, but it is a
behaviour change and must be recorded as one, not shipped silently.

**6.3 — Copilot auto-scroll.** `list.scrollTop = list.scrollHeight` after every render
(`copilot.ts:115`). *Loss:* Svelte's DOM update is not synchronous with the state change; the same
line in a reactive block runs *before* the new message is in the DOM and scrolls to the old bottom.
Needs `await tick()`.

**6.4 — Explorer paging race guard.** `expPageSeq` generation counter + an `expId` re-check:
```js
// datasets.ts:701, 718
const seq = ++expPageSeq;
…
if (seq !== expPageSeq || wantId !== expId) return; // a newer request already won
```
Debounced search (`expSearchTimer`, `datasets.ts:356`), header-sort clicks and page steps all issue
overlapping requests against a 1M-row Parquet. *Loss:* a plain `await` in an effect re-introduces
out-of-order page rendering — the exact class of bug the resident-query layer was built to avoid.
Cross-referenced in [`03-state-ipc.md`](03-state-ipc.md) §4.1.

**6.5 — Mosaic render token.** `mosaicTokens` (a `WeakMap<HTMLElement, number>`) + `mosaicTokenSeq`
(`plotRender.ts:555-602`). One token per container: a slow vgplot query that resolves after the user
switched chart type must neither draw over the newer chart nor fire its Chart.js fallback. *Loss:*
the WeakMap is keyed on a container node Svelte may replace.

### Resource lifetime — the leaks

**6.6 — Chart.js instance destruction.** `chartInstances` is checked and `.destroy()`d in **five**
places, each handling a different case:
- `renderResult.ts:20` — handles both a single chart and an **array** (small multiples).
- `chartControls.ts:418`, `:450` — destroy before re-render from the Values/Periods menus.
- `dashboards.ts:399` — `destroyDashCharts`, called on editor close and on presentation enter/exit.
- `reportExport.ts:21` — destroys the offscreen chart after `toDataURL`.

*Loss:* miss one and you leak a `<canvas>`, its 2D context, and a live `requestAnimationFrame` loop.
A dashboard with 12 cards, entered and exited from presentation mode ten times, leaks 120 charts. R3
explains why Svelte makes this *easier* to get wrong.

**6.7 — MapLibre context destruction.** `destroyMapInContainer` + the `mapInstances` WeakMap,
called from `renderResult.ts`, `dashboards.ts` (×2) and `reportExport.ts` (×2). MapLibre holds a
**WebGL2 context**; browsers cap these at roughly 16 and silently kill the oldest. *Loss:* maps in a
dashboard start rendering blank after enough re-renders, with no error. Note that presentation mode
deliberately destroys and rebuilds the entire grid (`dashboards.ts:1257`, `:1268`) precisely so charts
refit — the comment says "destroy→rebuild, no leak", and that property must survive.

**6.8 — The offscreen export chart.** `captureChartPNG` builds a detached chart, rasterises, destroys
(`reportExport.ts:21`). Maps take a different route entirely — `captureMapPNG` goes through
`waitForMapIdle` + main-process `captureRegion`, because `canvas.toDataURL()` drops the DOM `Marker`
value labels (there is no glyph URL, per `CLAUDE.md`). *Loss:* a port that "simplifies" map export to
`toDataURL` produces PNGs with no labels, which looks correct until you read the numbers.

### Menus, popovers, focus

**6.9 — The `⋯` chart menu.** One shared popover, repositioned per open (`hub.ts:990`). State that
must survive: `_chartMenuDismiss` / `_chartMenuEscape` handler slots (`hub.ts:992-993`); an
`AbortController` created per open that removes **all** listeners on close (`chartControls.ts:201`,
aborted at `:223` outside-click and `:226` Escape); and — subtly — the **Customize section's
expanded/collapsed state persists across opens** because the DOM element is reused and never reset.
*Loss:* a component that mounts fresh on open resets Customize to collapsed every time.

**6.10 — Mini-menu singleton.** `_activeMiniMenu` (`chartControls.ts:261`): opening a Values menu
closes an open Periods menu, app-wide. *Loss:* two menus open at once.

**6.11 — Focus trap and return.** `makeModalAccessible(box, label, initialFocus)` (`hub.ts:1840-1866`)
captures `document.activeElement` **before** moving focus, traps Tab between the first and last
focusable, and returns focus to the opener on close. Used by 5 modals: capture-dataset
(`captureDataset.ts:305`), dashChoose (`dashboards.ts:118`), export (`reportExport.ts:783`),
promptModal (`projects.ts:169`), lightbox (`hub.ts:950`). The **Settings panel has a second, separate
trap** (`hub.ts:1874-1921`) with its own `stpOpener`. *Loss:* keyboard users lose their place; screen
readers lose the modal boundary. Nothing tests this.

**6.12 — Menu Escape + focus-return, three more times.** The gear menu (`hub.ts:251,284,294`), help
menu (`hub.ts:334,360`) and exec menu (`execMenu.ts:437`) each store a `_dismiss`/`_esc` handler pair
and explicitly `.focus()` their trigger on close. Three near-identical implementations that should
become one component but must behave identically after.

**6.13 — Theme change re-renders the active thread.** A `MutationObserver` on `html[data-theme]`
(`hub.ts:1310-1313`) calls `renderThread(entry)` when the attribute flips. Charts read CSS custom
properties **at build time** via `getCSSVar` (`chartRender.ts`), so this observer is the *only* thing
that recolours a chart on a light/dark switch. *Loss:* switch to dark mode and the chart keeps light
axis labels on a dark card. Also note this re-render resets thread scroll (§6.2).

**6.14 — Dropdown behaviour** (`customDropdown.ts`, 248 lines, eight distinct behaviours):
- `openDd` module singleton — only one dropdown open app-wide (`:154`).
- Listbox portaled to `document.body` at `position: fixed` so no ancestor `overflow` clips it (`:155`,
  `:122`) — the entire reason the widget exists instead of a `<select>`.
- Height capped to `min(320px, 55vh)` bounded by available space, **flipped above the trigger** when
  there is more room there (`:119-128`).
- **Self-closes when the trigger scrolls out of view** (`:116`).
- Four listeners added on open and removed on close, all **capture-phase**: `mousedown`, `keydown`,
  `resize`, `scroll` (`:165-168` / `:177-180`). The scroll handler ignores the list's *own* scroll
  (`:136`).
- Keyboard: ↑/↓/Home/End move an `activeIndex` with `scrollIntoView({block:'nearest'})`; Enter
  selects; Escape closes **and returns focus to the trigger**; Tab closes (`:139-151`).
- `Object.defineProperty` accessors for `value` / `disabled` / `hidden` / `placeholder`, each with
  side effects — setting `disabled` or `hidden` **closes the list** (`:229-236`).
- The trigger is a `div[role=button]`, not a `<button>`, because it nests inside a `<button>` in the
  settings CLI row (`:12-14` header comment).

*Loss:* every one of these is a small behaviour nobody writes a test for and everybody notices.

### Timers, debounces and flush-on-close

**6.15 — Splash timing.** 2,000 ms hold + 620 ms fade via two `setTimeout`s, plus a CSS custom
property `--splash-fill` set from JS (`hub.ts:155-165`). `npm run smoke` notes that the **first paint
is the splash** — a screenshot taken there passes every DOM check while proving nothing.

**6.16 — Six independent debounces, and one that must be flushed.**

| timer | file | flushed on teardown? |
|---|---|---|
| `dashSaveTimer` — dashboard autosave | `dashboards.ts:37` | **Yes** — `closeDashEditor` flushes first (`:124`), *"so a quick edit isn't lost"* |
| `vizSaveTimer` — visual override autosave | `visuals.ts:31` | verify |
| `expSearchTimer` — explorer search | `datasets.ts:356` | n/a (superseded by `expPageSeq`) |
| global-rules textarea | `hub.ts:580` | verify |
| chart-menu title input | `chartControls.ts:143` | menu close aborts the controller — verify the pending write |
| chart-menu axis labels | `chartControls.ts:179` | same |

*Loss:* Svelte destroys a component's DOM on `{#if}` flip; if the flush does not happen in
`onDestroy`, the user's last keystroke is silently discarded. The dashboard case is already
load-bearing enough that someone wrote a comment about it.

**6.17 — Capture step animation interval.** `cvStepTimer` — a `setInterval` cleared in three places
(`hub.ts:1418`, `1431`, `1436`). *Loss:* an uncleared interval keeps ticking against a destroyed
panel.

**6.18 — Presentation mode.** `dashPresenting` flag + `html.dash-presenting` class + a
**capture-phase** `keydown` listener stored in `dashPresentKeyHandler` and removed on exit
(`dashboards.ts:1246-1268`), plus a full grid destroy/rebuild on both enter and exit. *Loss:* an
un-removed capture-phase Escape handler swallows Escape for every modal in the app afterwards.

### Cross-boundary and in-flight

**6.19 — Push results for entries that are no longer selected.** `hub:entry-result` and
`hub:followup-result` arrive on IPC for an entry the user may have navigated away from. Five guards:
`if (entryId !== currentEntryId) return` (`hub.ts:1495`, `:1638`) and
`if (currentEntryId !== snapId) return` (`:914`, `:927`, `:1500`). Crucially the entry's **data is
still recorded** — only the *render* is skipped. *Loss:* a Svelte port that subscribes in a component
`onMount` and unsubscribes on destroy drops background results entirely; the subscription must live at
app level and write to a store. See [`03-state-ipc.md`](03-state-ipc.md) §4.5.

**6.20 — Recapture handoff across the full capture round-trip.** `pendingCaptureTarget`
(`captureDataset.ts:16`) is set by `startRecapture()`, survives renderer → main → overlay window →
main → renderer, and is consumed by `maybeResumeRecapture()` inside the `onEntryResult` handler
(`hub.ts:1568-1570`). *Loss:* any remount between those two points silently drops the
replace/append target and the recapture lands as a brand-new dataset.

**6.21 — Section-entry refresh, five of them.** `selectSection()` calls `refreshDatasetList` /
`refreshConnectionList` / `refreshVisualList` / `refreshDashboardList` / `refreshCopilot`
(`workspace.ts:67-75`) because sections are hidden, not unmounted. Under `{#if}` mounting these become
`onMount` — which changes *when* they fire (mount vs every entry) and whether stale content is ever
visible. Both are defensible; pick one and check all five.

**6.22 — The Local CLI scan runs once per session.** `execDidScan` (`hub.ts`) and
`lcDidInitialScan` (`settingsPanels.ts:404`). *Loss:* a component that re-scans on every mount
**spawns CLI child processes every time the user opens Settings**. This is the one item on this list
with a real cost outside the renderer.

**6.23 — Search text survives re-render only by accident.** `filterSidebar` (`hub.ts:807`) hides
existing history DOM nodes rather than rebuilding a list, so the `#cap-search` input is never
recreated and its value persists. *Loss:* a `{#each}` port that rebuilds the list is fine — but a port
that also rebuilds the input clears the query mid-typing.

**6.24 — Explorer view state deliberately resets.** Column visibility, sort column/direction and
search live in module state in `datasets.ts`, not on disk. Closing and reopening a dataset **resets
them today**. That is current behaviour; preserve it (or change it deliberately).

**6.25 — `chartOverrides` are merged into the live entry object.** `patchOverride`
(`chartControls.ts:237-249`) mutates `entry.chartOverrides[overrideKey]` in place, deletes null keys,
then persists via `persistOverride` (R11). Two write paths — `entry.saveOverride` for Visuals,
`window.hub.saveChartOverrides` for capture history. *Loss:* an immutable-update port must keep both
routes and keep the null-key deletion (it is how "reset to default" works).

### 6.26 — Both chart stacks, accounted for

The port must carry **two** chart engines.

- `plotRender.ts` is **691 lines, 27 top-level symbols, 3 public, 1 consumer**. The entire integration
  is a **4-line branch** in `renderVizInArea` (`renderResult.ts:29-34`), guarded by
  `mosaicEnabled() && mosaicCanRender(type, source)`.
- The flag is `localStorage 'scMosaic' === '1'` (`plotRender.ts:53`), **default off**.
- Coverage: **16 of 28** chart types (`MOSAIC_CHART_TYPES`); the other 12 are an explicit
  `MOSAIC_FALLBACK_TYPES` list, deliberately enumerated rather than defaulted, so a new chart type
  fails a test instead of silently choosing Chart.js forever.
- **Everything falls back to Chart.js on any miss** — flag off, no dataset identity, unmappable
  encoding, unresolvable view, query error. Failures are recorded on the container and at
  `console.debug`, never thrown.
- `vendor/vgplot.js` (608,767 bytes) and `vendor/plot.css` (2,125 bytes) are **committed build
  artifacts** loaded unconditionally by `index.html:1451` and `:21`, flag or no flag. They exist
  because `scripts/build-vendor.js` strips Plot's three `<style>` injections and stubs
  `@duckdb/duckdb-wasm` (which otherwise drags in `new Function(` and `cdn.jsdelivr.net`) — see
  [`docs/phase-3c/`](../phase-3c/README.md) §1-2.

**Gate implications, three of them:**

1. **With the flag off, `plotRender` must be provably inert.** The default parity pass runs with
   `scMosaic` unset and must produce byte-comparable Chart.js output.
2. **The flag-on pass is a separate, secondary checklist** covering the 16 covered types plus a
   fallback check on the 12 uncovered ones. It is not part of the primary gate — `CLAUDE.md` is
   explicit that turning Mosaic on by default is a *new decision needing its own justification*.
3. **`vg.table()` and everything from `@uwdata/mosaic-inputs` stay forbidden.** Their CSS is
   per-instance dynamic, unextractable, and violates `style-src` on every update. If the port
   introduces a bundler, the `STYLE_INJECTION_ALLOWLIST` guard in `build-vendor.js` must keep running,
   and the new bundler needs the *same* guard — a Svelte build that permits inline styles reopens the
   hole Phase 3c closed.

---

## 7. What the gate should check

The parity checklist is the union of:

- **62 addressable surfaces** — §1.2 (8) + §1.3 (31) + §1.4 (12) + §1.5 (9) + §1.6 (2 live) —
  each verified visually in both light and dark theme.
- **7 Settings category panes**, plus the two exec sub-panes.
- **3 capture-view states** (`loading` / `result` / `error`).
- **28 chart types** through `<VizArea>`, plus **16 more** with `scMosaic=1`.
- **26 stateful behaviours** — §6.1 through §6.26 — each with a written pass/fail, because none is
  visible in a screenshot.
- **1 explicit decision** on the Permission panel (§3.5) — reproduce the throw, wire it up, or delete.
- **2 explicit decisions** on dead code: `renderer/about/` and `renderer/permission/` (582 lines, §1.6).
- **`npm run smoke` still fails on any renderer console error.** That is the check that caught a
  blocked inline style surviving 2,400 passing assertions; it is also the check most likely to catch
  a Svelte build that violates `style-src`. Do not weaken it for the port.

Two claims in `CLAUDE.md` should be amended when Phase 5 lands: that renderer load order is
irrelevant (§3.7), and that `globals.d.ts` is a complete index of the shared contract (§2.1).
