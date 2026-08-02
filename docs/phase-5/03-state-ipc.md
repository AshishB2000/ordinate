# Phase 5 — State and the IPC boundary

The port from global-scope `<script>` files to Svelte is, underneath the component work, a
**state-ownership rewrite**. This document is the ground truth for that half: the exact bridge
surface a Svelte component may call, where renderer state lives today, the store layer that
replaces it, the async/cancellation contract, the security invariants the stores must not weaken,
and how a store coexists with a legacy global during the migration.

Everything below was read out of `preload/hubPreload.ts`, `main.ts`, `src/ipc/*.ts` and
`renderer/hub/*.ts` in this worktree — not from CLAUDE.md's representative table. Where the two
disagree, this file is the verified one.

---

## 0. Numbers at a glance

| Thing | Count |
|---|---|
| Keys exposed on `window.hub` | **118** (115 methods + 3 static data properties) |
| … `ipcRenderer.invoke` (request/response) | **99** |
| … `ipcRenderer.send` (fire-and-forget renderer→main) | **7** |
| … `ipcRenderer.on` (main→renderer push subscriptions) | **9** |
| … `ipcRenderer.sendSync` at preload load time (not methods) | **3** |
| `ipcMain.handle` / `ipcMain.on` registrations reachable from the hub | **109** |
| `ipcMain` registrations reachable only from other windows | **3** (`capture:commit`, `capture:cancel`, `hub:open`) |
| `webContents.send` channels main pushes to the hub | **9** (8 live, 1 dead — see §1.4) |
| Bridge methods with **no renderer caller at all** | **10** |
| Renderer files that touch `window.hub` | **16 of 21** (excluding the 2 `globals*.d.ts`) |

The preload/main channel sets are **exactly closed**: every hub `invoke`/`send`/`sendSync` channel
has a matching `ipcMain` registration, and every `ipcMain` registration except the three
overlay/status ones is reachable from the hub bridge. There are no orphan invoke channels. (The 9
`on` channels correctly have no `ipcMain` registration — they are pushes.)

---

## 1. The complete `window.hub.*` surface

Argument lists are the **bridge signatures** (what a component calls), not the wire payloads — the
preload wraps positional args into a single object per channel. "Returns" is the resolved value of
the promise, verified against the handler.

### 1.1 Request/response — `invoke` (99)

#### Execution config, keys, providers (23)

| Method | Args | Channel | Returns | Renderer callers |
|---|---|---|---|---|
| `getKeyStatus()` | — | `key:status` | full `publicConfig()` — see §5.1 | copilot, execMenu, hub, settingsPanels |
| `saveKey(provider, key)` | 2 | `key:save` | `{ ok }` | **none** |
| `saveLocalEndpoint(endpoint)` | 1 | `local:save` | `{ ok }` | **none** |
| `clearKey(provider)` | 1 | `key:clear` | `{ ok }` | **none** |
| `validateKey(provider, key, endpoint?)` | 3 | `key:validate` | `{ ok, models }` | **none** |
| `getModels(provider)` | 1 | `key:models` | `{ ok, models }` | **none** |
| `saveModel(provider, model)` | 2 | `model:save` | `{ ok }` | **none** |
| `activateProvider(provider)` | 1 | `provider:activate` | `{ ok }` | **none** |
| `setExecutionMode(mode)` | `'local'\|'byok'` | `exec:setMode` | `{ ok }` | hub, settingsPanels |
| `setMemoryModel(fields)` | 1 | `memory:setModel` | `{ ok }` | settingsPanels (comment only — dead) |
| `setGlobalRules(text)` | 1 | `rules:set` | `{ ok }` | hub |
| `setNotifications(fields)` | `{sound?,desktop?}` | `notifications:set` | `{ ok }` | hub |
| `bootstrapNotifications()` | — | `notifications:bootstrap` | `{ ok, supported }` | hub |
| `deleteData(scope)` | `'history'\|'credentials'\|'settings'\|'everything'` | `data:delete` | `{ ok, scope, removed }` | hub |
| `saveByokProvider(provider, fields)` | 2 | `byok:saveProvider` | `{ ok, byok }` | hub, settingsPanels |
| `activateByokProvider(provider)` | 1 | `byok:activate` | `{ ok, byok }` | execMenu, settingsPanels |
| `testByokProvider(provider)` | 1 | `byok:test` | typed test result | settingsPanels |
| `revealByokKey(provider)` | 1 | `byok:revealKey` | **raw API key string** | settingsPanels |
| `detectLocalClis()` | — | `cli:detect` | `{ activeId, detectedAt, clis[] }` | execMenu, settingsPanels |
| `detectOneCli(id)` | 1 | `cli:detectOne` | same shape | settingsPanels |
| `setLocalCli(id)` | 1 | `cli:setActive` | `{ ok }` | execMenu, settingsPanels |
| `testLocalCli(id)` | 1 | `cli:test` | typed test result | settingsPanels |
| `listCliModels(id)` | 1 | `cli:models` | `{ ok, models }` | execMenu, settingsPanels |
| `saveCliModel(id, model)` | 2 | `cli:saveModel` | `{ ok }` | hub, settingsPanels |
| `listModels(target, force?)` | 2 | `models:list` | `{ models, at?, source:'cache'\|'live'\|'none', error? }` | execMenu, settingsPanels |

#### Shell, theme, hotkey, geo (6)

| Method | Channel | Returns | Callers |
|---|---|---|---|
| `openSystemSettings()` | `permission:open-settings` | `{ ok }` | **none** |
| `loadGeo(level)` | `geo:load` | GeoJSON `FeatureCollection` (empty on miss; cached in main) | mapRender |
| `getHotkeyLabel()` | `hotkey:label` | `{ label, accelerator }` | hub |
| `saveHotkey(accelerator)` | `hotkey:save` | `{ ok, label? , error? }` | hub |
| `getThemePreference()` | `theme:getPreference` | `{ preference, effective }` | hub |
| `setThemePreference(pref)` | `theme:setPreference` | `{ preference, effective }` | hub |

#### Capture history, chart overrides, export (10)

| Method | Channel | Returns | Callers |
|---|---|---|---|
| `loadThread(entryId)` | `history:load` | thread **without** `messages` (raw model history never leaves main) or `null` | hub |
| `deleteThread(entryId)` | `history:delete` | `{ ok }` | hub |
| `saveChartOverrides(entryId, key, overrides)` | `hub:saveChartOverrides` | `{ ok }` | chartControls |
| `saveImage(src, defaultName)` | `hub:saveImage` | `{ ok, dest? , canceled? }` | chartControls, hub, reportExport |
| `savePdf(base64, defaultName)` | `hub:savePdf` | `{ ok, dest? }` | reportExport |
| `savePptx(base64, defaultName)` | `hub:savePptx` | `{ ok, dest? }` | reportExport |
| `saveDocx(base64, defaultName)` | `hub:saveDocx` | `{ ok, dest? }` | reportExport |
| `captureRegion(rect)` | `hub:captureRegion` | PNG data URL | reportExport |
| `captureReport(html, width)` | `hub:captureReport` | PNG data URL | reportExport |

#### Projects (5)

`listProjects()` → `Project[]` · `createProject(name)` → `Project` · `renameProject(id, name)` →
`Project|null` · `deleteProject(id)` → `{ ok }` · `openProject(id)` → `Project|null`.
Callers: projects.ts (list/create/rename/delete), workspace.ts (list/create/open).

#### Datasets — metadata, import, explore (14)

| Method | Channel | Returns | Callers |
|---|---|---|---|
| `pickAndParseDataset(sheetName?, filePath?)` | `dataset:pickAndParse` | `{ ok, canceled?, filePath?, fileName?, sourceKind?, preview? }` | datasets |
| `parsePasteDataset(text)` | `dataset:parsePaste` | `{ ok, preview }` | datasets |
| `saveDataset({projectId,name,sourceKind,columns,rows})` | `dataset:save` | `Dataset` \| `{ok:false,error}` | datasets, connections |
| `listDatasets(projectId)` | `dataset:list` | `DatasetSummary[]` | captureDataset, dashboards, datasets, prepare, visuals |
| `getDataset(projectId, id)` | `dataset:get` | **full `Dataset` incl. every row** | dashboards ×2, prepare, visuals |
| `getDatasetMeta(projectId, id)` | `dataset:meta` | `Dataset` **without rows** | datasets |
| `datasetPage(projectId, datasetId, {offset,limit,search?,sortColumn?,sortDir?})` | `dataset:page` | `{ ok, rows, total, offset }` \| `{ok:false,error}` | datasets (via a cast — see §2.6) |
| `deleteDataset(projectId, id)` | `dataset:delete` | `{ ok }` | datasets |
| `datasetStats(projectId, datasetId)` | `dataset:stats` | `{ ok, summaries, issues }` | datasets |
| `updateDataset(projectId, datasetId, columns)` | `dataset:update` | `{ ok, dataset }` | datasets |
| `explainDataset(projectId, datasetId)` | `dataset:explain` | `{ ok, text }` \| `{ok:false,notReady}` | datasets |
| `captureToDatasetDraft(extractedTable)` | `captureDataset:draft` | `{ ok, columns, rows, warnings }` | captureDataset |
| `saveCaptureDataset(payload)` | `captureDataset:save` | `{ ok, dataset, warnings }` | captureDataset |
| `combineDatasets(projectId, a, b, mode, on?)` | `dataset:combine` | `{ ok, dataset, warnings }` | prepare |

#### Prepare pipeline (7)

`addDatasetStep` · `updateDatasetStep(…, index, step)` · `removeDatasetStep(…, index)` ·
`reorderDatasetSteps(…, order[])` · `setDatasetSteps(…, steps[])` — all return
`{ ok, dataset, preview:{ columns, rows, rowCount, warnings } }`. Plus `suggestDatasetSteps` →
`{ ok, steps }|{ok:false,notReady}` and `suggestCalcField` → `{ ok, name, expression, warning? }`.
All callers: prepare.ts only.

#### Connections (6)

`listConnections(projectId)` → public (secret-free) list · `testAndSaveConnection(projectId, kind,
config, secret)` → `{ ok, connection }` · `listConnectionTables(projectId, connId)` ·
`runConnection(projectId, connId, tableOrQuery)` → ParseResult preview ·
`refreshConnection(projectId, connId, datasetId)` · `deleteConnection(projectId, connId)` → `{ok}`.
All callers: connections.ts only. **`secret` travels one-way — there is no reveal bridge.**

#### Visuals (9)

`listVisuals` · `getVisual` · `saveVisual(payload)` · `updateVisual(projectId,id,patch)` ·
`deleteVisual` · `duplicateVisual` · `suggestVisual(projectId,datasetId)` ·
`computeVisualData(projectId, datasetId, encoding, filters?)` → `{ ok, data:{labels,series,geo?},
recommendedShape, warnings }`. Callers: visuals.ts, dashboards.ts.

#### Mosaic connector — dark (2)

`mosaicView(projectId, datasetId)` → `{ ok, name, columns:[{name,type,sqlType}] }` ·
`mosaicQuery(sql, type?)` → `{ ok, rows, rowCount, truncated }`. Caller: plotRender.ts only, and
only when `localStorage.scMosaic === '1'`.

#### Dashboards (13)

`listDashboards` · `getDashboard` · `saveDashboard({projectId,name,pages?,filters?})` ·
`updateDashboard(projectId,id,patch)` · `deleteDashboard` · `draftDashboard(projectId)` →
`{ ok, name, pages }` (unsaved) · `summarizeDashboard` → `{ ok, text, provenance }` ·
`explainDashboardAnomalies` → `{ ok, text, anomalies }` · `computeMetric(projectId, datasetId,
column, aggregation, filters?)` → `{ ok, value:number|null }` · `exportDashboardHtml(bundle,
defaultName?)` · `exportDashboardPng(html, width, defaultName?)` · `exportDashboardPdf(...)` ·
`revealProjectFolder(projectId)`. Callers: dashboards.ts only.

#### Copilot (4)

`copilotHistory(projectId)` → `{ ok, turns }` · `copilotAsk(projectId, {kind,id}, question)` →
`{ ok, answer, provenance, turns }` \| `{ok:false,notReady}` · `copilotClear(projectId)` →
`{ ok }` · `setCopilotEnabled(enabled)` → `{ ok, enabled }`. Callers: copilot.ts only.

### 1.2 Fire-and-forget — `send` (7)

| Method | Channel | Callers | Note |
|---|---|---|---|
| `takeScreenshot()` | `hub:capture` | captureDataset, hub | main gates on `executionReady()`; on failure it pushes `hub:open-settings` instead |
| `retry(entryId)` | `hub:retry` | hub | result arrives later on `hub:entry-result` |
| `followup(entryId, text)` | `hub:followup` | hub | result arrives later on `hub:followup-result` |
| `copyText(text)` | `hub:copyText` | chartControls, mapRender | |
| `copyImage(dataUrl)` | `hub:copy` | chartControls, hub | |
| `openExternal(url)` | `shell:open` | hub, settingsPanels | |
| `openInputMonitoringSettings()` | `privacy:open-input-monitoring` | **none** | |

These three are the **request/response pairs split across two channels** (`hub:capture` →
`hub:new-entry` → `hub:entry-result`; `hub:retry` → `hub:entry-result`; `hub:followup` →
`hub:followup-result`). They are the only IPC in the app that is *not* a promise, and they are the
reason the capture surface needs a real state machine rather than an `await` (§4.5).

### 1.3 Main→renderer pushes — `on` (9)

| Method | Channel | Payload | Fired when | Subscriber |
|---|---|---|---|---|
| `onNewEntry(cb)` | `hub:new-entry` | `{ entryId, dataUrl }` | a crop was committed | hub.ts |
| `onEntryResult(cb)` | `hub:entry-result` | `{ entryId, ...AnalyzeResult }` | analysis / retry finished | hub.ts |
| `onFollowupResult(cb)` | `hub:followup-result` | `{ entryId, ...result }` | follow-up finished | hub.ts |
| `onHistory(cb)` | `hub:history` | `HistorySummary[]` | hub opened; also `[]` after "delete history" | hub.ts |
| `onKeyChanged(cb)` | `key:changed` | — | any credential/CLI change in main | hub.ts, copilot.ts |
| `onOpenSettings(cb)` | `hub:open-settings` | `cat` (currently always `'exec'`) | capture attempted while not ready | hub.ts |
| `onHotkeyState(cb)` | `hub:hotkey-state` | `{ ok, hotkey, label, … }` | hub load | hub.ts |
| `onThemeApply(cb)` | `theme:apply` | `{ effective }` | OS theme changed in `system` mode | hub.ts |
| `onShowPermission(cb)` | `hub:show-permission` | — | main wants the permission panel | **nobody** |

`hub:show-permission` is a **live push with no subscriber**: main sends it (`main.ts:350,355`) and
the hub ignores it. The button that would open that panel calls `showPermissionPanel()`, which is
declared in `globals.d.ts` but defined nowhere — a documented pre-existing bug. Phase 5 should fix
it by subscribing, not by preserving the bug.

### 1.4 Load-time synchronous reads (3, not methods)

`providerLogos`, `agentLogos`, `appVersion` are plain data properties, filled by
`ipcRenderer.sendSync('provider:logos' | 'agent:logos' | 'app:version')` **at preload evaluation
time**. Read in hub.ts only. They are safe to expose to Svelte as module constants — they never
change and must never become stores (a store implies invalidation that cannot happen).

### 1.5 Channels the hub cannot reach

| Channel | Owner | Note |
|---|---|---|
| `overlay:frame`, `capture:commit`, `capture:cancel` | `window.overlay` | overlay window only |
| `status:state`, `hub:open` | `window.screenchart` | status window only |
| `permission:open-settings`, `permission:done` | `window.permission` | **`permission:done` has no `ipcMain` handler** — dead; the permission window is now an inline hub panel |
| `shell:open` | `window.about` | about window shares the hub's channel |

**Phase 5 scope note:** only the hub is being ported. The overlay, status, about and permission
preloads are 5–11 lines each and stay as-is. Do not merge them into a shared bridge — each is a
deliberate least-privilege surface.

### 1.6 Dead bridge surface (10 methods)

`saveKey`, `saveLocalEndpoint`, `clearKey`, `validateKey`, `getModels`, `saveModel`,
`activateProvider` — the **v1 single-provider key API**, fully superseded by `byok:*`.
`setMemoryModel` — only referenced in a comment noting the UI was removed.
`openSystemSettings`, `onShowPermission`, `openInputMonitoringSettings` — the permission-panel path
described above.

Do not port these into the Svelte bridge typing. Leaving them exposed keeps 8 `ipcMain` handlers
reachable from renderer script for no reason; deleting them is a separate, easily-reverted commit
and should not be bundled into the component port.

---

## 2. Where renderer state lives today

Four storage media, in descending order of how much of the app depends on them.

### 2.1 Module-level `let` in a shared global scope (the bulk of it)

The hub is 22 classic `<script>` files sharing **one** global scope, loaded in a fixed order
(`index.html:1474–1493`), with cross-file access resolved at call time. A `let` at the top of
`datasets.ts` is directly readable and writable from `copilot.ts`. There is no module boundary to
lean on and no way to observe a write. This is the entire "store layer" today.

| Owner file | Symbol | What it is | Read from |
|---|---|---|---|
| workspace | `currentProjectId` | **the** active project id, `null` on HOME | workspace, datasets, prepare, visuals, dashboards, connections, copilot, captureDataset — 8 files |
| workspace | `currentSection` | active nav section | workspace, copilot |
| hub | `entries[]` | array of capture entries `{id,dataUrl,cropPath,state,result,error,title,turns[],activeVizType,chartOverrides,updatedAt}` | hub, captureDataset |
| hub | `currentEntryId` | selected capture | hub, captureDataset |
| hub | `currentThemePref` | `'system'\|'light'\|'dark'` | hub |
| hub | `execMode`, `execByok`, `execLocal`, `execDidScan` | execution-menu mirror of `publicConfig()` | hub, execMenu |
| hub | `notifPrefs` | `{sound,desktop}` mirror of config | hub |
| hub | `cvActiveStep`, `cvStepTimer` | the fake progress stepper | hub |
| hub | `stpRecording`, `stpCapturedAccel`, `stpRecordingHandler`, `stpOpener`, `_stpKeydown` | hotkey-recorder modal | hub |
| hub | `_smDismiss/_smEsc/_hmDismiss/_hmEsc/_execDismiss/_execEsc/_menuDismissHandler/_chartMenuDismiss/_chartMenuEscape/_lightboxA11y/_toastTimer` | 11 outside-click / Esc / focus-trap teardown handles | hub |
| datasets | `dsPreview`, `dsSourceKind`, `dsSuggestedName`, `dsFilePath` | in-flight import draft (holds a **full ParseResult** until saved) | datasets |
| datasets | `expId`, `expName`, `expColumns`, `expRows`, `expSummaries`, `expHidden`, `expSearch`, `expSortCol`, `expSortDir`, `expPageRows`, `expTotal`, `expOffset`, `expPageSeq`, `expSearchTimer` | the Explore grid — **query + one page**, never the table | datasets, prepare, copilot |
| prepare | `expSteps` | the open dataset's pipeline — *written by `datasets.openSavedDataset`*, owned by prepare | datasets, prepare |
| prepare | `dsStepEditIndex`, `dsStepEditType`, `dsSuggestedSteps` | step editor + unconfirmed AI proposal | prepare |
| visuals | `vizDatasetId`, `vizColumns`, `vizMeasures`, `vizEditingId`, `vizCurrentChartType`, `vizOverrides`, `vizFilters`, `vizPicker`, `vizRecomputeTimer`, `vizSaveTimer` | the visual builder | visuals, copilot |
| visuals | `vizEntry` | a **fake capture entry** the builder hands to the shared chart renderer | visuals, chartRender |
| dashboards | `dashList`, `dashCurrent`, `dashPageIdx`, `dashDirty`, `dashSaveTimer`, `dashDragId`, `dashPresenting`, `dashPresentKeyHandler` | dashboard list + open dashboard (cross-filters live at `dashCurrent.filters`) | dashboards, copilot |
| connections | `connRunConnId`, `connRunKind`, `connRunPreview` | last connection run preview (a full ParseResult) | connections |
| copilot | `copilotBusy` | re-entrancy guard | copilot |
| captureDataset | `pendingCaptureTarget` | `{datasetId, mode}` pending across a **whole capture round-trip** | captureDataset, hub |
| projects | `openProjectMenu` | which card menu is open | projects |
| settingsPanels | `exByokStatus`, `exByokActive`, `exByokExpanded`, `lcActiveId`, `lcModels`, `lcDidInitialScan` | a **second** mirror of the same config as `execMode`/`execByok`/`execLocal` | settingsPanels |
| settingsPanels | `revealedKey` (function-scoped, per card) | **a raw API key held in a renderer variable** | settingsPanels |
| chartControls | `_activeMiniMenu` | open `⋯` menu | chartControls |
| plotRender | `mosaicTokens` (WeakMap), `mosaicTokenSeq` | per-container render token | plotRender |
| reportExport | `_exportEscape`, `_exportA11y` | export modal teardown | reportExport |

**Cross-file shared state — the list a port must not get wrong** (the rest is file-local):
`currentProjectId`, `currentSection`, `entries`, `currentEntryId`, `expId`, `expName`,
`expColumns`, `expSteps`, `vizEditingId`, `vizEntry`, `dashCurrent`, `pendingCaptureTarget`,
`execMode`/`execByok`/`execLocal`, `notifPrefs`, `currentThemePref`.

Note the two worst offenders: **`expSteps` is declared in `prepare.ts` but assigned by
`datasets.ts`**, and **`copilot.ts` reads `expId`/`expName`/`vizEditingId`/`dashCurrent` directly
to decide its own context** — a cross-file read of four other files' private state with no
contract. Both are silent-breakage risks the moment those symbols become module-scoped.

### 2.2 DOM attributes as state

Not decoration — these attributes **are** the state, and CSS reads them to show/hide entire views:

| Attribute | Meaning | Written by |
|---|---|---|
| `.win[data-view]` | `home` \| `workspace` | workspace.ts |
| `.hub-body[data-section]` | which section body is visible | workspace.ts |
| `#capture-view[data-cv-state]` | `loading` \| `result` \| `error` | hub.ts (7 sites) |
| `<html>[data-theme]` | `light` \| `dark` — read back by mapRender to pick tile colours | hub.ts |
| `<html>[data-os]` | `mac` \| `win` \| `linux` | hub.ts |
| `.cap-hist-item[data-entry-id]` | selection identity | hub.ts |
| `.dash-card[data-card-id]`, `.ws-nav-item[data-section]`, `.proj-card[data-project-id]`, CLI `[data-id]`, provider `[data-prov]`, chip `[data-type]` | identity for delegated click handlers | various |
| `[data-mosaic]`, `[data-mosaic-sql]` | which engine drew a container (asserted by tests) | plotRender.ts |
| `keyInput[data-masked]` | "the field currently shows a mask, do not save it" | settingsPanels.ts |

`data-mosaic` / `data-mosaic-sql` and `data-cv-state` are **read by the smoke/verification path** —
they must survive the port as attributes, not become internal component state.

### 2.3 `localStorage` (2 keys, both feature flags, both read-only at runtime)

- `scMosaic === '1'` → enable the Mosaic/vgplot stack (plotRender.ts, renderResult.ts).
- `scAllCharts === '1'` → show every chart chip instead of the shape-eligible subset
  (renderResult.ts).

Both are read fresh at each decision point; neither is written by the app. No `sessionStorage`.

### 2.4 Re-fetched from main on every use (no renderer cache)

`getKeyStatus()` is called by four files, each on its own schedule, and re-called on every
`key:changed` push and on each copilot toggle — the renderer keeps *three separate partial mirrors*
of the same `publicConfig()` (`execMode`/`execByok`/`execLocal` in hub.ts, `exByokStatus`/
`lcActiveId`/`lcModels` in settingsPanels.ts, and nothing at all in copilot.ts, which re-fetches).
The lists (`listDatasets`, `listVisuals`, `listDashboards`, `listConnections`) are re-fetched on
every section activation via `selectSection()`. Nothing is cached across a section switch.

### 2.5 State that lives only in main

The renderer never sees, and must never store: raw API keys (except the deliberate
`revealByokKey` round-trip), connection secrets, `entryThreads` (the raw model message array —
explicitly stripped from `history:load`), `entryDataUrls`, the parsed GeoJSON cache, and the
`modelCache`. `dataset:page`'s window and `visual:data`'s `{labels,series}` are the only bulk data
that crosses, and both are bounded.

### 2.6 One bridge method reached through a cast

`datasets.ts:369` resolves `datasetPage` via
`(window.hub as unknown as {datasetPage?: …}).datasetPage` because `globals.d.ts` declares the
`Window['hub']` shape and that file was out of scope for the change that added paging. The Svelte
port should type the bridge once, properly, and delete the cast — but note the cast is **load-
bearing as a fallback**: an absent method reads as `undefined` and the grid falls back to the
client-side path. Keep that "method may be missing" tolerance in the typed wrapper.

---

## 3. The proposed store layer

### 3.1 Principles

1. **One store per piece of state, one writer per store.** Today `currentProjectId` has 3 writers
   and 8 readers. After the port each store has exactly one module that may `set()` it; everything
   else derives or calls an action.
2. **Stores hold *questions*, not *answers*, for anything unbounded.** The Explore grid store holds
   `{offset, limit, search, sortColumn, sortDir}`; the rows are the *result* of that question and
   live in a bounded, replaceable page slot. This is the rule that keeps 1,000,000-row datasets
   working.
3. **Main is the source of truth for every persisted thing.** A mutation action calls IPC, then
   adopts the record main returned — never patches the local copy and hopes. The current code
   already does this well (copilot rebuilds from `res.turns`; prepare adopts the returned
   `preview`); preserve it.
4. **No store holds a secret.** §5.
5. **Every store that is per-project resets when the project changes.** Today this is done by
   scattered assignment and is the likeliest source of ported bugs.

### 3.2 Store inventory

Notation: `W` writable · `D` derived · `R` async resource (see §4.1) · `M` machine (§4.5).

#### Shell / session

| Store | Kind | Owns | Hydrated by | Reset on |
|---|---|---|---|---|
| `route` | W | `{ view:'home'\|'workspace', section }` | — (launch is always HOME) | never |
| `activeProject` | W | `Project \| null` | `openProject(id)`; `ensureWorkspaceForCapture` may `listProjects`/`createProject` | — |
| `activeProjectId` | D | `$activeProject?.id ?? null` | — | — |
| `projects` | R | `Project[]` | `listProjects()` | invalidated by create/rename/delete |
| `appMeta` | const | `{ providerLogos, agentLogos, appVersion }` | preload `sendSync` | never |
| `flags` | const | `{ mosaic, allCharts }` from `localStorage` | read once at boot | never |

`route.view` and `route.section` must keep writing `.win[data-view]` / `.hub-body[data-section]`
during the migration — CSS and the legacy files both read them (§6.3).

#### Config / execution (one store, three current mirrors collapsed)

| Store | Kind | Owns | Hydrated by |
|---|---|---|---|
| `config` | R | the whole `publicConfig()` envelope | `getKeyStatus()`; **re-fetched on the `key:changed` push** |
| `isReady` | D | `$config.isReady` | — |
| `execMode` | D | `$config.executionMode` | — |
| `byokStatus` | D | `$config.byok` (`{activeProvider, providers:{…status booleans}}`) | — |
| `localCliStatus` | D | `$config.localCli` | — |
| `notifications` | D | `$config.notifications` | — |
| `copilotEnabled` | D | `$config.copilotEnabled` | — |
| `theme` | W | `{ preference, effective }` | `getThemePreference()`; updated by the `theme:apply` push |
| `hotkey` | W | `{ label, accelerator, registered }` | `getHotkeyLabel()` + the `hub:hotkey-state` push |
| `cliScan` | R | `{ activeId, detectedAt, clis[] }` | `detectLocalClis()` — the once-per-session background scan (`execDidScan`/`lcDidInitialScan` collapse into this resource's "already loaded" state) |
| `modelList(target)` | R (keyed) | `{ models, source, error? }` | `listModels(target, force?)` |

**This is the single biggest cleanup in the phase.** `execMode`/`execByok`/`execLocal`/`notifPrefs`
in hub.ts and `exByokStatus`/`exByokActive`/`lcActiveId`/`lcModels` in settingsPanels.ts are two
independent, hand-synchronised copies of one payload. Every mutation action
(`setExecutionMode`, `saveByokProvider`, `activateByokProvider`, `setLocalCli`, `saveCliModel`,
`setNotifications`, `setGlobalRules`, `setCopilotEnabled`, `deleteData`) ends with
`config.invalidate()`. Main also pushes `key:changed` after most of them, so the invalidation must
be **idempotent and deduplicated** or the settings panel will double-fetch on every keystroke-save.

`exByokExpanded` (which provider cards are open) is pure view state and stays local to the
component — it must *not* join `config`, or a refetch collapses the card the user is typing in.

#### Capture surface

| Store | Kind | Owns |
|---|---|---|
| `entries` | W | `Map<entryId, Entry>` — replaces the `entries[]` array; ordering (session entries first, then history) becomes a derived `entryOrder` |
| `currentEntryId` | W | selected entry |
| `currentEntry` | D | `$entries.get($currentEntryId)` |
| `entryMachine(id)` | M | per-entry `idle → loading → result \| error`, driven by the `hub:new-entry` / `hub:entry-result` pushes |
| `pendingRecapture` | W | `{ datasetId, mode } \| null` — survives a full capture round-trip |

`Entry.turns[]`, `Entry.chartOverrides`, `Entry.activeVizType` stay nested inside the entry record.
Update them immutably (`entries.update(m => new Map(m).set(id, {...e, turns:[...e.turns, t]}))`) so
component subscriptions fire — today the code mutates `entry.turns.push(...)` and then manually
calls `renderThread(entry)`, which is exactly the pattern that silently stops updating under a
store.

#### Workspace resources (all keyed by project)

| Store | Kind | Hydrated by | Invalidated by |
|---|---|---|---|
| `datasetList` | R | `listDatasets(pid)` | save/update/delete/combine/captureSave/connectionRefresh |
| `visualList` | R | `listVisuals(pid)` | save/update/delete/duplicate |
| `dashboardList` | R | `listDashboards(pid)` | save/update/delete |
| `connectionList` | R | `listConnections(pid)` | testAndSave/delete |

Each subscribes to `activeProjectId` and re-fetches (or clears to `null`, not `[]` — see §4.3) when
it changes. Today `selectSection()` refetches on every nav click; a resource with an explicit
invalidation set is both fewer round-trips and, more importantly, *correct* after a mutation made
in a different section.

#### The Explore grid — the load-bearing one

This store must be designed against a specific failure: a naive `openDataset` store that caches a
`Dataset` object. `dataset:get` structured-clones every row (4,083 ms at 1M rows) and is what the
paging work removed from this path. **The rule: no store may hold `Dataset.rows`.**

| Store | Kind | Owns | IPC |
|---|---|---|---|
| `openDataset` | W | metadata only: `{ id, name, columns[], sourceKind, capture?, steps[] }` | `getDatasetMeta` — **never `getDataset`** |
| `gridQuery` | W | `{ offset, limit, search, sortColumn, sortDir }` — *the question* | — |
| `gridPage` | R (derived from `[openDataset.id, gridQuery]`, debounced 250 ms on `search`) | `{ rows, total, offset }` for **one ~500-row window** | `datasetPage` |
| `gridView` | W | `{ hiddenColumns: Set<number> }` — repaints from the page in hand, no IPC | — |
| `datasetStats` | R (keyed on dataset id) | `{ summaries, issues }` | `datasetStats` |
| `prepareSteps` | W | the ordered `TransformStep[]` | adopted from every step mutation's `{ok, dataset, preview}` |
| `preparePreview` | W | `{ columns, rowCount, warnings }` — **`preview.rows` is dropped on adoption** | — |
| `stepEditor` | W | `{ index, type, draft }` | — |
| `suggestedSteps` | W | unconfirmed AI proposal | `suggestDatasetSteps` |

`gridPage`'s derivation *is* the `expPageSeq` generation counter, expressed once instead of by hand
(§4.2). The 250 ms search debounce and the "snap to offset 0 once if the page came back empty but
`total > 0`" retry are load-bearing behaviours — port them into the resource, not into a component.

`expRows` (the client-side fallback buffer) is already dead: `openSavedDataset` sets it to `[]` and
main falls back to hydrate-and-page internally for v2 records. **Do not resurrect it as a store.**

#### Visual builder

| Store | Kind | Owns |
|---|---|---|
| `builder` | W | `{ datasetId, columns[], measures[], editingId, chartType, overrides, filters }` |
| `builderData` | R (derived from `builder`, debounced) | `computeVisualData` result — `{labels, series, geo?}`, already aggregated and bounded |
| `builderDirty` | D | drives the debounced `updateVisual` autosave |

`vizEntry` — the fake capture-entry object the builder hands to the shared chart renderer — is an
adapter, not state. Keep it as a **derived** value (`derived([builder, builderData], toEntry)`) so
that when the shared chart renderer is itself ported, the adapter disappears with it.

`builder.columns` currently comes from `getDataset` (full hydration for a column list). Switch it to
`getDatasetMeta` — see §7.1.

#### Dashboards, and cross-filter state

| Store | Kind | Owns |
|---|---|---|
| `openDashboard` | W | the full `Dashboard` record (pages + cards; **bounded — cards are specs, not data**) |
| `dashPage` | W | active page index |
| `dashFilters` | W | `FilterStep[]` — the dashboard-wide cross-filter set |
| `dashDirty` / autosave | W + effect | debounced `updateDashboard` |
| `cardData(cardId)` | R (keyed) | per-card `{labels, series}` or metric value |
| `dashDrag`, `dashPresenting` | W | interaction state, component-local candidates |

**The cross-filter design decision.** Today `dashCurrent.filters` is *both* the persisted field and
the live UI selection — mutating it marks the dashboard dirty and triggers an autosave, and a
mismatched array shape is repaired in five separate places (`if (!Array.isArray(dashCurrent.filters))
dashCurrent.filters = []` appears 4×). Split it:

- `dashFilters` is a **first-class store**, seeded from `openDashboard.filters` on load and written
  back on save. Normalise to `[]` once, at load, not at every read site.
- Every card's data resource derives from `[card, dashFilters]`, so a filter change invalidates
  every card at once — which is already the behaviour (`renderAllCards` after any filter edit), just
  expressed declaratively.
- **The filter merge must stay in main.** `mergeDashFilters` in dashboards.ts is a renderer-side
  mirror of `src/dashboardFilters.mergeDashboardFilters`; the merged array is passed to
  `visual:data` / `dashboard:metric`, which apply it in SQL. The store passes filters through — it
  never evaluates one. (This is the same reason `plotRender` declines Mosaic whenever filters are
  present.)
- **A filter change must cancel the in-flight card queries it supersedes.** With N cards on a page,
  a fast filter edit fires N requests and then N more; without per-card generation tokens the first
  batch can land last. §4.2.

#### Copilot thread

| Store | Kind | Owns | IPC |
|---|---|---|---|
| `copilotTurns` | R | `turns[]` — **disk is truth** | `copilotHistory(pid)`; replaced wholesale from `copilotAsk`'s `res.turns` |
| `copilotBusy` | W | in-flight guard | — |
| `copilotContext` | **D** | `{kind, id, label}` | — |
| `copilotHint` | W | the soft-gate message | — |

`copilotContext` is the interesting one and the reason to do this properly. Today
`buildCopilotContextRef()` reaches directly into `expId`, `expName`, `vizEditingId` and
`dashCurrent` — four other files' private variables — and picks the first non-empty by priority.
As a Svelte store that becomes an honest derived:

```
copilotContext = derived([openDataset, builder, openDashboard], ([ds, b, dash]) =>
    ds?.id   ? { kind:'dataset',   id: ds.id,   label:'dataset · '   + ds.name }
  : b?.editingId ? { kind:'visual', id: b.editingId, label:'visual · open visual' }
  : dash?.id ? { kind:'dashboard', id: dash.id, label:'dashboard · ' + dash.name }
  :            { kind:'', id:'', label:'whole project' });
```

That is a strict improvement — the indicator currently only re-renders when `refreshCopilot()`
happens to run, so it can display a stale scope. Preserve the **priority order** exactly
(dataset → visual → dashboard); it is user-visible and matches the nav order.

The optimistic "Thinking…" bubble is UI-only and must **not** enter `copilotTurns`: on failure main
leaves the thread untouched and the renderer reloads from disk to drop it. Model it as
`copilotBusy` + a transient component-local placeholder, never a turn.

#### Import / connection drafts (bounded-but-large, deliberately not resources)

`dsPreview` (a full parsed `ParseResult`, up to the row cap) and `connRunPreview` are **transient
drafts held until the user clicks Save**, then sent straight back to main. They stay writable stores
with an explicit `clear()` and must be cleared on: project change, section change away, successful
save, and opening a saved dataset (today `openSavedDataset` clears `dsFilePath` and hides the
preview panels by hand). A leaked draft is a multi-hundred-MB retention bug that no test would
catch.

### 3.3 What deliberately does **not** become a store

The 11 dismiss/Esc/focus-trap handles, `_activeMiniMenu`, `_toastTimer`, `openProjectMenu`,
`cvStepTimer`/`cvActiveStep`, `dashDragId`, the hotkey-recorder trio, `mosaicTokens`. These are
imperative lifecycle handles; in Svelte they are `onMount`/`onDestroy` and `use:` actions. Promoting
them to stores is how a port ends up with leaked global listeners.

---

## 4. The async boundary

Every one of the 99 `invoke` methods is a promise, and today each call site invents its own
handling: some `try/catch` to `null`, some to `{}`, some check `res && res.ok`, some check
truthiness of a row count (a bug the paging code explicitly fixed by trusting only `ok === true`).
There are three ad-hoc cancellation mechanisms (`expPageSeq`, `mosaicTokens`+`mosaicTokenSeq`, and
"is `currentEntryId` still the one I started with?") and four ad-hoc debounces
(`expSearchTimer` 250 ms, `vizRecomputeTimer`, `vizSaveTimer`, `dashSaveTimer`).

Unify all of it behind one primitive.

### 4.1 The `resource` primitive

```
type Async<T> =
  | { status: 'idle' }
  | { status: 'loading'; prev?: T }   // prev = keep showing stale data while refetching
  | { status: 'ready';   data: T }
  | { status: 'error';   message: string; prev?: T }
  | { status: 'notReady' };           // AI-gated: no model configured
```

A `resource(key, fetcher, opts)` is a readable `Async<T>` that:

- re-runs whenever `key` (a store or tuple of stores) changes, after an optional debounce;
- carries a **monotonic generation counter**; a reply whose generation is not the current one is
  dropped, full stop — this is `expPageSeq` and `mosaicTokenSeq`, written once;
- also re-checks the **key identity** on resolve, not just the counter (`refreshExplorerPage` checks
  both `seq !== expPageSeq` *and* `wantId !== expId`; keep both — the counter alone does not catch a
  re-entry that happens to land on the same generation);
- exposes `invalidate()` for mutation-driven refetch and `clear()` for teardown;
- **never throws.** Nearly every current call site already hand-rolls a `try/catch`; the resource
  absorbs both a rejected promise and an `{ok:false}` envelope into `error`, once.

`notReady` is a **first-class status, not an error.** Eight AI calls return `{ok:false, notReady:true}`
when no model is configured (`dataset:explain`, `dataset:suggestSteps`, `dataset:suggestCalcField`,
`visual:suggest`, `dashboard:draft`, `dashboard:summary`, `dashboard:explainAnomalies`,
`copilot:ask`). Rendering those as errors would violate the product rule that AI is optional and
its absence is a soft hint, never a failure dialog.

### 4.2 Cancellation on navigate-away

IPC `invoke` **cannot be cancelled** — main will finish the work and reply. Cancellation here means
*discarding the reply*, and it must be automatic, because the manual version is already
inconsistent (the grid does it, the visual builder does not).

Three layers, all required:

1. **Generation + key check inside the resource** (above). Covers a superseded request of the same
   kind.
2. **`onDestroy` → `resource.clear()`**, which bumps the generation. A component unmounted mid-flight
   can never write to a store afterwards. This is the layer that does not exist today at all — the
   current code relies on a late reply writing into a module global that the next screen happens to
   overwrite.
3. **Scope guards on the shared keys.** Any resource keyed on `activeProjectId` re-checks it on
   resolve. A reply for project A arriving after the user opened project B is otherwise
   indistinguishable from a fresh reply, because the payloads carry no project id.

Multi-card fan-out (a dashboard page, N cards) needs **per-card generations**, not one shared
counter — one counter means the last card started cancels the others' results.

### 4.3 Loading, empty, and stale — three distinct things

- **`{ok:false}` never means "no data".** The paging code learned this the hard way: an empty page is
  a real result (search matched nothing, or you paged past the end). Only `ok === true` may be
  interpreted; `ok === false` is an error and must keep the previous rows on screen rather than
  paint a blank grid.
- **Stale-while-revalidate is the default** for lists and pages: `loading` carries `prev`, so the UI
  keeps the last good rows and shows a subtle busy affordance rather than flashing empty. This
  matches today's behaviour, where the grid simply keeps its DOM until the new page paints.
- **A project change clears to `idle`, not to `[]`.** `[]` renders as "no datasets yet", which is a
  lie about a project that has not been read.
- **Retry semantics.** `dataset:page` has a one-shot "snap to offset 0 and retry" for a table that
  shrank under the user. That is the *only* automatic retry in the app; do not generalise it into
  the resource primitive.

### 4.4 Debounce and autosave

Four debounces today, four different implementations. Standardise on the resource's `debounce`
option and one `debouncedAction` helper:

| What | Delay | Why |
|---|---|---|
| Explore search → `dataset:page` | **250 ms** | a full-scan search in main costs ~55 ms at 200k rows — never per character |
| Visual builder → `visual:data` | existing `vizRecomputeTimer` | recompute is ~12 ms at 1M rows, so this is UI smoothing, not cost |
| Visual overrides → `updateVisual` | existing `vizSaveTimer` | disk write |
| Dashboard layout → `updateDashboard` | existing `dashSaveTimer` | disk write |

Autosaves must **flush on unmount**. Today an unmount mid-debounce loses the edit silently; with
components that mount and unmount on every nav click, this goes from rare to routine. `onDestroy`
must `flush()` pending saves, and the flush must be fire-and-forget-safe (main is still alive).

### 4.5 The push channels are a state machine, not a promise

`hub:capture` / `hub:retry` / `hub:followup` have no reply. Their results arrive on `hub:new-entry`,
`hub:entry-result` and `hub:followup-result`, addressed by `entryId`, possibly for an entry the user
is no longer looking at, possibly interleaved. Wrapping them in a fake promise is wrong — main can
legitimately answer an old entry after a new one.

Model each entry as an explicit machine keyed by `entryId`, with the push handlers registered
**once at app boot** (not per-component) writing into `entries`. The currently-viewed entry is a
*view* over that map. This is essentially what hub.ts does; the port must keep the discipline that
`showAnalyzeResult` already has — always update the entry record, and only touch the visible surface
`if (entryId === currentEntryId)`.

Register all 8 live push subscriptions once, in a single `ipcBridge.ts` boot module. `ipcRenderer.on`
has **no `off` on this bridge** — re-registering per component mount leaks a listener per mount,
which under a Svelte router means one leak per navigation.

---

## 5. Security boundary — what the store layer must not do

`contextIsolation: true` and `nodeIntegration: false` are unchanged by this phase. Svelte is
compiled ahead of time; there is no runtime `eval`, and the hub's strict CSP
(`default-src 'none'; style-src 'self'; script-src 'self'`) must continue to hold, which means:

- **Svelte's compiled output must be a plain `<script src>` self-hosted file.** No CDN, no inline
  `<script>`, no `new Function`. (This is the same constraint that forced `scripts/build-vendor.js`
  to strip Observable Plot's three `<style>` injections.)
- **Component `<style>` blocks compile to a stylesheet, not inline `style=` attributes.** `style-src
  'self'` allows a self-hosted CSS file; it does not allow inline styles. Svelte's `style:` directive
  and dynamic inline styles set `element.style.x` at runtime, which *is* allowed — the same rule the
  hub already lives under. Verify with the smoke test, which fails on any renderer console error and
  is the only thing that has ever caught a CSP violation here.
- **No store may reach Node.** Every store's fetcher goes through `window.hub`. A store must never
  import `electron`, `fs`, or `path`.

### 5.1 What the renderer is allowed to hold

`publicConfig()` is the whole contract. It returns status booleans and non-secret settings:
`version, activeProvider, executionMode, isReady, byok (publicByok — per provider: hasKey,
verified, connected, baseUrl, maxTokens, model), localCli (activeId, detectedAt, clis — no
resolvedPath), memoryModel, model, hasApiKey, providerStatus, hotkey, theme, themePreference,
prompt, globalRules, notifications, copilotEnabled`.

**No raw key, no connection secret, no CLI resolved path.** The `config` store caches exactly this
envelope and nothing more. `saveByokProvider(provider, {apiKey})` sends a key *to* main; the store
must not keep the value it just sent — write it and forget it.

### 5.2 The two places a secret touches the renderer, and the rule for each

| Path | Today | Rule for the store layer |
|---|---|---|
| `revealByokKey(provider)` → raw key string | held in a **function-scoped** `let revealedKey` inside one card's closure, cleared on mask/blur/input, and guarded so the mask is never re-saved (`keyInput.dataset.masked`) | **Must stay component-local, must never become a store.** A store is globally reachable, survives navigation, and would put a plaintext key in any devtools store inspector. Keep it in the component's local scope, clear it in `onDestroy`, and keep the `data-masked` guard. |
| `testAndSaveConnection(…, secret)` | one-way; there is **no reveal bridge** for connection secrets | Keep it one-way. Do not add a `connectionSecret` store, and do not add a reveal channel "for symmetry with BYOK". |

**Flag: any proposed store named `keys`, `credentials`, `secrets`, `revealedKeys`, or a `config`
store that caches the result of `revealByokKey` is a security regression and must be rejected in
review.**

### 5.3 Data that is safe but must stay bounded

Not a secret, but a store that holds it is a memory bug: `Dataset.rows` (up to 1M), `dsPreview`,
`connRunPreview`, `geo:load`'s county GeoJSON (megabytes; main already caches it — the renderer
should not cache it a second time), and `captureRegion`/`captureReport` PNG data URLs. Hold each in
exactly one place with an explicit clear.

### 5.4 Untrusted content

Model output (`copilotAsk`, `summarizeDashboard`, `explainDataset`, `explainDashboardAnomalies`) and
parsed file/connection data are **untrusted strings**. copilot.ts is careful to use `textContent`,
never `innerHTML`. Svelte's `{expr}` interpolation escapes by default — so the safe path is also the
default path. **`{@html}` is banned in every component that renders model output or dataset cell
values.** Similarly, `dashboardExport.sanitizeBundle` whitelists the export to
labels/numbers/strings/`data:image` only; nothing in the store layer may widen what reaches it.

---

## 6. Migration mechanics — Svelte and vanilla globals coexisting

This is where the phase will actually go wrong, so it gets the most specific rules.

### 6.1 The problem, precisely

Legacy hub scripts are 22 files in one global scope. `currentProjectId` is a bare `let` that any of
them reads and three of them write. A Svelte store is a closure. **A legacy `currentProjectId = x`
assignment cannot be observed by a store, and a `store.set(x)` cannot be seen by a legacy read.**
During the port both will exist simultaneously for weeks.

### 6.2 The mechanism: one bridge module, accessor-backed, store-authoritative

Create `renderer/hub/legacyBridge.ts`, loaded **before every other hub script**, which for each
shared symbol installs an accessor property on `window` (or `globalThis`) whose getter/setter is the
store:

```
function bridgeGlobal(name, store) {
  Object.defineProperty(globalThis, name, {
    get: () => get(store),
    set: (v) => store.set(v),
    configurable: true,
  });
}
```

Then delete the `let currentProjectId` declaration from workspace.ts (a real `let` shadows and wins
over a `window` property; an accessor and a `let` of the same name cannot coexist). Every legacy
read and write now flows through the store, and Svelte components subscribe normally. **The store is
the single source of truth in both directions from day one** — there is no reconciliation, no
mirroring, and no "which copy is newer" question.

Bridge exactly the cross-file symbols listed in §2.1, and no others:

`currentProjectId`, `currentSection`, `entries`, `currentEntryId`, `expId`, `expName`, `expColumns`,
`expSteps`, `vizEditingId`, `vizEntry`, `dashCurrent`, `pendingCaptureTarget`, `execMode`,
`execByok`, `execLocal`, `notifPrefs`, `currentThemePref`.

Everything file-local stays a plain `let` and is ported when its file is.

### 6.3 The four traps

1. **Mutation instead of assignment.** `entry.turns.push(t)`, `dashCurrent.filters = []`,
   `expHidden.add(i)`, `entries.unshift(e)` — a getter-backed bridge returns the object and the
   legacy code mutates it in place. **The setter never fires and no subscriber updates.** The
   accessor bridge fixes reads and assignments only.
   *Mitigation:* for the four mutable containers (`entries`, `dashCurrent`, `expHidden`, `expSteps`),
   the bridge must expose a **`Proxy`** whose mutating traps call `store.set` — or, better, the
   legacy mutation sites must be converted to assignment (`entries = [e, ...entries]`) as a
   *separate, mechanical, pre-port commit* with tests green in between. Do the conversion; the Proxy
   is a fallback for containers too hot to touch. **This is the number-one bug source in the phase.**
2. **DOM attributes that are also state.** `.win[data-view]`, `.hub-body[data-section]` and
   `#capture-view[data-cv-state]` drive CSS *and* are read by legacy code and by tests. A Svelte
   component that owns the route must keep writing them (a single `$effect` /
   `$: document.querySelector('.win').setAttribute(...)`) until the last legacy consumer is gone. Do
   not treat them as an implementation detail of the router component.
3. **Double subscription to pushes.** The 8 live `ipcRenderer.on` handlers are registered at hub.ts
   top level. If a Svelte component also subscribes (to `onEntryResult`, say), both run, and there is
   **no unsubscribe on this bridge**. Rule: the boot module owns all 8 subscriptions; components read
   the resulting stores. Never call a `hub.onX` from a component.
4. **Load order.** Legacy scripts resolve cross-file symbols *at call time*, so order is currently
   irrelevant. `legacyBridge.ts` breaks that: its `defineProperty` calls must run before any legacy
   script *assigns* the symbol during its own top-level evaluation. Put it first in `index.html`,
   before `geoMatch.js`.

### 6.4 Suggested port order (state-first, lowest coupling first)

1. `legacyBridge.ts` + the boot IPC module + the `resource` primitive. No components. Smoke green.
2. `config` store — collapse the three mirrors. Highest value, touches only hub.ts/settingsPanels.ts/
   execMenu.ts/copilot.ts, and every one of them already re-fetches so a shared cache is strictly
   better.
3. `projects` + `route` + `activeProject` (projects.ts + workspace.ts, 329 lines total, 3 bridged
   symbols).
4. Copilot (301 lines, self-contained apart from its four cross-file context reads, which
   §3.2's derived store fixes cleanly).
5. Connections, then the visual builder, then Explore/prepare, then dashboards.
6. The capture surface (hub.ts, 1,965 lines) **last** — it owns the push machine, 11 lifecycle
   handles and the entry model, and it is the one surface `npm run smoke` exercises end to end.

### 6.5 Verification during the port

`npm run smoke` is the only check that runs the real app, and it **fails on any renderer console
error** — which is what makes it the guard for both CSP regressions and for a store that throws on a
late reply. Run it after every bridged symbol, not at the end. The differential-test house style
applies here too: while two implementations of a piece of state coexist, assert they agree.

---

## 7. Where the current design resists a clean store model

Five places. Each needs a decision before the components that depend on it are written.

### 7.1 Four call sites hydrate a whole table to read a column list

`visuals.ts:259`, `prepare.ts:567`, `dashboards.ts:777` and `dashboards.ts:1172` call
`hub.getDataset(projectId, id)` and then use **only `ds.columns`**. `dataset:get` structured-clones
every row — 4,083 ms at 1M rows, which is precisely the cost `dataset:meta` was added to avoid, and
only the Explore grid was ever switched over. Three of these are inside a modal-open path, so the UI
freezes for four seconds on a large dataset today.

*Fix, and it is a prerequisite:* switch all four to `getDatasetMeta`. Otherwise the obvious store
(`datasetById`) caches full tables and the port makes the problem permanent and global instead of
transient and local.

### 7.2 The dashboard filter-value picker scans rows in the renderer

`distinctColumnOptions(ds, column)` (dashboards.ts:1186) iterates `ds.rows` to collect up to 200
distinct values for the filter chooser. It is capped at 200 *outputs*, not 200 *rows* — a
low-cardinality column over a million rows walks the entire table in the renderer. **This is the one
remaining place that genuinely needs the whole table client-side**, and it is incompatible with
"no store holds rows".

*Options:* (a) a new `dataset:distinct(projectId, datasetId, column, limit)` handler — one
`SELECT DISTINCT … LIMIT` against the Parquet, which is the resident-layer answer and cheap; (b)
reuse `mosaic:query`, but that is gated on the dark Mosaic flag and would make a default-on feature
depend on a dark one; (c) leave it hydrating. (a) is the only one consistent with the phase.
This is new IPC surface, so it needs sign-off, not a silent addition.

### 7.3 The chart renderer's entry-shaped input

`chartRender.buildChart`, `renderResult.renderVizInArea`, `chartControls` and `reportExport` all
consume a **capture "entry"** object. The visual builder therefore fabricates one (`vizEntry`), and
dashboards route their cards through the same path. Three genuinely different domains
(capture thread, saved visual, dashboard card) share one accidental data shape.

Under a store model that shape has to be either a real interface or a set of adapters. Recommend:
define `ChartInput { labels, series, geo?, chartType, overrides, title }`, keep `toEntry()` adapters
at the three call sites, and do **not** try to fix the renderer in this phase — `chartRender.ts` is
1,091 lines and `mapRender.ts` is 828, and MapLibre in particular has hard constraints (WebGL2, DOM
`Marker` value labels, export must composite via `capturePage`) that make it the wrong thing to
touch while also changing the state model.

### 7.4 `dashCurrent.filters` is simultaneously persisted data and live UI selection

Described in §3.2. Editing a filter dirties the dashboard and schedules a disk write — so
"filter the view to look at something" and "change the saved dashboard" are the same action. That
may be intended, but it should be an explicit decision in Phase 5 rather than an emergent property
of one field serving two roles. If they are meant to be separable, `dashFilters` (live) and
`openDashboard.filters` (persisted) must be two stores with an explicit "save current filters"
action.

### 7.5 `hub:capture` is a request whose response is a push, addressed by an id the caller never sees

`takeScreenshot()` returns nothing. The caller cannot know whether capture started, was gated to
Execution settings, or was cancelled at the overlay. `captureDataset.ts` works around this with
`pendingCaptureTarget`, a module global that must survive a full round-trip through the overlay, the
crop, main's `analyze()`, and the `hub:entry-result` push — and it is consumed by a
`maybeResumeRecapture(entry)` call from hub.ts's push handler.

This is genuinely hard to model as a store because the correlation id is minted in main. Two honest
options: (a) keep it as a small explicit machine (`pendingRecapture` store + the boot push handler),
which is what §3.2 proposes and is a faithful port; or (b) change `hub:capture` to an `invoke` that
returns `{ started, entryId? }`, which would make the whole flow correlatable — a **main-process
change**, out of scope for a renderer port, and worth its own proposal rather than being smuggled in.

---

## 8. Summary of decisions this document asks for

| # | Decision | Blocking |
|---|---|---|
| 1 | Adopt the accessor-backed `legacyBridge.ts` with store-authoritative reads/writes | yes — nothing else can start |
| 2 | Convert the four in-place mutation sites (`entries`, `dashCurrent`, `expHidden`, `expSteps`) to assignment before porting their files | yes |
| 3 | Switch the four `getDataset`-for-columns call sites to `getDatasetMeta` | yes |
| 4 | Add `dataset:distinct` for the dashboard filter picker (new IPC — needs sign-off) | yes, for dashboards |
| 5 | Collapse the three `publicConfig` mirrors into one `config` resource | no, but do it first |
| 6 | `revealByokKey`'s value stays component-local; no secret store, ever | yes (review gate) |
| 7 | All 8 live pushes registered once in a boot module; components never call `hub.onX` | yes |
| 8 | Delete or keep the 10 dead bridge methods — separate commit either way | no |
| 9 | Fix `hub:show-permission` (live push, no subscriber; `showPermissionPanel` undefined) | no |
| 10 | Leave `chartRender`/`mapRender` on an entry-shaped adapter this phase | no |
