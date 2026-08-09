import { contextBridge, ipcRenderer } from 'electron';

// ponytail: IPC payloads/results are big JSON envelopes owned by main + renderer;
// full typing here isn't worth it — the bridge just forwards them.

// Brand glyphs for the Execution mode dropdown. This preload is sandboxed and
// can't require('simple-icons'), so main loads the paths (full Node) and we pull
// them synchronously at load time — a tiny { slug: 24×24 path } map. The renderer
// paints each with fill=currentColor; brands not in simple-icons get a badge.
let PROVIDER_LOGOS: any = {};
try { PROVIDER_LOGOS = ipcRenderer.sendSync('provider:logos') || {}; } catch (_) { PROVIDER_LOGOS = {}; }
// Full-color agent logos (data URIs) for marks not in simple-icons (e.g. Antigravity).
let AGENT_LOGOS: any = {};
try { AGENT_LOGOS = ipcRenderer.sendSync('agent:logos') || {}; } catch (_) { AGENT_LOGOS = {}; }
let CONNECTOR_LOGOS: any = {};
try { CONNECTOR_LOGOS = ipcRenderer.sendSync('connector:logos') || {}; } catch (_) { CONNECTOR_LOGOS = {}; }
// App version (from package.json via app.getVersion) — read once for the About panel.
let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('app:version') || ''; } catch (_) { APP_VERSION = ''; }

// Least-privilege bridge for the hub window.
// The raw API key is NEVER exposed here — only a boolean hasApiKey status.
contextBridge.exposeInMainWorld('hub', {
  // Trigger a screen capture (main gates on hasApiKey).
  takeScreenshot: () => ipcRenderer.send('hub:capture'),
  // Read-only key status: { hasApiKey: boolean, provider: string, keySecure: boolean }.
  getKeyStatus: () => ipcRenderer.invoke('key:status'),
  // Save a remote provider's API key (encrypted in main).
  saveKey: (provider: string, key: string) => ipcRenderer.invoke('key:save', { provider, key }),
  // Save a local Ollama endpoint (no API key).
  saveLocalEndpoint: (endpoint: string) => ipcRenderer.invoke('local:save', { endpoint }),
  // Remove the stored key for a specific provider.
  clearKey: (provider: string) => ipcRenderer.invoke('key:clear', { provider }),
  // Validate an API key or endpoint; returns { ok, models }.
  validateKey: (provider: string, key: string, endpoint?: string) =>
    ipcRenderer.invoke('key:validate', { provider, key, endpoint }),
  // Fetch model list using the stored key (key never leaves main process).
  getModels: (provider: string) => ipcRenderer.invoke('key:models', { provider }),
  // Save the chosen model for a specific provider.
  saveModel: (provider: string, model: string) => ipcRenderer.invoke('model:save', { provider, model }),
  // Switch which provider is used for captures.
  activateProvider: (provider: string) => ipcRenderer.invoke('provider:activate', { provider }),
  // ── Execution mode / BYOK ──
  // Set execution mode: 'local' | 'byok'.
  setExecutionMode: (mode: string) => ipcRenderer.invoke('exec:setMode', { mode }),
  // Persist the memory-model choice ({ mode, provider?, model? }).
  setMemoryModel: (fields: any) => ipcRenderer.invoke('memory:setModel', { fields }),
  // Persist the user's global rules (Instructions / Rules box).
  setGlobalRules: (text: string) => ipcRenderer.invoke('rules:set', { text }),
  // Completion-notification toggles ({ sound?, desktop? }).
  // Fire-and-forget from main after an unattended refresh: { datasetId, ok,
  // error, rowsBefore, rowsAfter, name }. The hub updates that row in place.
  onDatasetRefreshed: (cb: (o: any) => void) =>
    ipcRenderer.on('hub:dataset-refreshed', (_e, o) => cb(o)),
  setAutoRefreshEnabled: (on: boolean) => ipcRenderer.invoke('autorefresh:set', on),
  setNotifications: (fields: any) => ipcRenderer.invoke('notifications:set', { fields }),
  // Show a benign notification to register the app with the OS when the Desktop
  // toggle is first enabled → { ok, supported }.
  bootstrapNotifications: () => ipcRenderer.invoke('notifications:bootstrap'),
  // Destructive, confirmed-in-MAIN data deletion. scope:
  // 'history' | 'credentials' | 'settings' | 'everything'.
  deleteData: (scope: string) => ipcRenderer.invoke('data:delete', { scope }),
  // Save a byok provider's editable fields ({ apiKey?, baseUrl?, maxTokens?, model? }).
  saveByokProvider: (provider: string, fields: any) => ipcRenderer.invoke('byok:saveProvider', { provider, fields }),
  // Switch the active byok provider.
  activateByokProvider: (provider: string) => ipcRenderer.invoke('byok:activate', { provider }),
  // Run a minimal real connectivity test; returns a typed result.
  testByokProvider: (provider: string) => ipcRenderer.invoke('byok:test', { provider }),
  // Reveal a byok provider's saved key (Settings "Show" toggle only, on demand).
  revealByokKey: (provider: string) => ipcRenderer.invoke('byok:revealKey', { provider }),
  // ── Local CLI detection ──
  // Rescan all known CLIs on PATH; returns { activeId, detectedAt, clis: [...] }.
  detectLocalClis: () => ipcRenderer.invoke('cli:detect'),
  // Re-check a single CLI by id; returns the same shape.
  detectOneCli: (id: string) => ipcRenderer.invoke('cli:detectOne', { id }),
  // Persist the selected Local CLI (selection only — runs nothing).
  setLocalCli: (id: string) => ipcRenderer.invoke('cli:setActive', { id }),
  // Run a minimal real prompt through a local CLI; returns a typed result.
  testLocalCli: (id: string) => ipcRenderer.invoke('cli:test', { id }),
  // List a Local CLI's available models (Antigravity runs `agy models`); { ok, models }.
  listCliModels: (id: string) => ipcRenderer.invoke('cli:models', { id }),
  // Persist the chosen model for a Local CLI (selection only — runs nothing).
  saveCliModel: (id: string, model: string) => ipcRenderer.invoke('cli:saveModel', { id, model }),
  // Shared live model list for a BYOK provider (cache-first; pass force to refresh).
  listModels: (target: string, force?: boolean) => ipcRenderer.invoke('models:list', { target, force }),
  // Register a callback fired when main signals the key has changed.
  onKeyChanged: (cb: () => void) => ipcRenderer.on('key:changed', () => cb()),
  // Register a callback fired when main wants the settings modal opened at a
  // category (cat string, e.g. 'exec'). Replaces the old setup-panel signal.
  onOpenSettings: (cb: (cat: string) => void) => ipcRenderer.on('hub:open-settings', (_e, cat) => cb(cat)),
  // Open a URL in the default external browser.
  openExternal: (url: string) => ipcRenderer.send('shell:open', url),
  // Open macOS System Settings to the Screen Recording pane.
  openSystemSettings: () => ipcRenderer.invoke('permission:open-settings'),
  // Register a callback fired when main wants the permission panel shown.
  onShowPermission: (cb: () => void) => ipcRenderer.on('hub:show-permission', () => cb()),
  // Lazy-load a large geo boundary set (e.g. 'us_county') on demand from main.
  loadGeo: (level: string) => ipcRenderer.invoke('geo:load', level),
  // Get the display label for the configured hotkey (platform-aware, from main).
  getHotkeyLabel: () => ipcRenderer.invoke('hotkey:label'),
  // Save a new hotkey accelerator; returns { ok, label?, error? }.
  saveHotkey: (accelerator: string) => ipcRenderer.invoke('hotkey:save', { accelerator }),
  // Register a callback fired with the hotkey registration state on hub load.
  onHotkeyState: (cb: (data: any) => void) => ipcRenderer.on('hub:hotkey-state', (_e, data) => cb(data)),
  // Open macOS Privacy & Security → Input Monitoring directly.
  openInputMonitoringSettings: () => ipcRenderer.send('privacy:open-input-monitoring'),
  // Register a callback fired when a new capture entry is ready (any source).
  onNewEntry: (cb: (data: any) => void) => ipcRenderer.on('hub:new-entry', (_e, data) => cb(data)),
  // Register a callback fired when the AI result arrives for a specific entry.
  onEntryResult: (cb: (data: any) => void) => ipcRenderer.on('hub:entry-result', (_e, data) => cb(data)),
  // Re-analyze the same crop for an existing entry without re-capturing.
  retry: (entryId: string) => ipcRenderer.send('hub:retry', { entryId }),
  // Send a follow-up question for an existing entry thread.
  followup: (entryId: string, text: string) => ipcRenderer.send('hub:followup', { entryId, text }),
  // Register a callback fired when a follow-up result arrives.
  onFollowupResult: (cb: (data: any) => void) => ipcRenderer.on('hub:followup-result', (_e, data) => cb(data)),
  // Register a callback fired with persisted history summaries on hub open.
  onHistory: (cb: (data: any) => void) => ipcRenderer.on('hub:history', (_e, data) => cb(data)),
  // Load a full thread from disk (returns thread data without messages array).
  loadThread: (entryId: string) => ipcRenderer.invoke('history:load', { entryId }),
  // Delete a thread's files from disk.
  deleteThread: (entryId: string) => ipcRenderer.invoke('history:delete', { entryId }),
  // Copy text or image to clipboard via main process.
  copyText: (text: string) => ipcRenderer.send('hub:copyText', text),
  copyImage: (dataUrl: string) => ipcRenderer.send('hub:copy', dataUrl),
  // Save a screenshot image via the native save panel (user picks the location).
  saveImage: (src: string, defaultName: string) => ipcRenderer.invoke('hub:saveImage', { src, defaultName }),
  // Save a generated PDF report (base64 bytes) via the native save panel.
  savePdf: (base64: string, defaultName: string) => ipcRenderer.invoke('hub:savePdf', { base64, defaultName }),
  // Save a generated PowerPoint (.pptx) report (base64 bytes) via the native save panel.
  savePptx: (base64: string, defaultName: string) => ipcRenderer.invoke('hub:savePptx', { base64, defaultName }),
  // Save a generated Word (.docx) report (base64 bytes) via the native save panel.
  saveDocx: (base64: string, defaultName: string) => ipcRenderer.invoke('hub:saveDocx', { base64, defaultName }),
  // Snapshot a page region (DIP rect {x,y,width,height}) to a PNG data URL — used to
  // export the live MapLibre map into reports. It composites the WebGL canvas AND the
  // DOM layer on top of it (value-label markers, legend) in one shot — a bare
  // canvas.toDataURL() would drop the markers, which are DOM because the style ships
  // no glyphs and so has no symbol layer.
  captureRegion: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('hub:captureRegion', rect),
  // Render a self-contained HTML report to a PNG data URL via a hidden, content-sized
  // window (full-report PNG export). width is the logical page width in px.
  captureReport: (html: string, width: number) => ipcRenderer.invoke('hub:captureReport', { html, width }),
  // Theme preference ('system'|'light'|'dark'). Get returns { preference, effective };
  // set persists it and returns the resolved { preference, effective }.
  getThemePreference: () => ipcRenderer.invoke('theme:getPreference'),
  setThemePreference: (preference: string) => ipcRenderer.invoke('theme:setPreference', preference),
  // Fired when main resolves a new effective theme (OS change in 'system' mode).
  onThemeApply: (cb: (data: any) => void) => ipcRenderer.on('theme:apply', (_e, data) => cb(data)),
  // Persist chart customization overrides for a specific chart slot in a thread.
  saveChartOverrides: (entryId: string, key: string, overrides: any) =>
    ipcRenderer.invoke('hub:saveChartOverrides', { entryId, key, overrides }),
  // ── Projects (workspace shell) ──
  // List all projects (newest-updated first).
  listProjects: () => ipcRenderer.invoke('projects:list'),
  // Cross-project recent list (datasets/analyses/dashboards, newest first).
  recentItems: (limit?: number) => ipcRenderer.invoke('recent:list', { limit }),
  // Home "Starred" pins — a flat "type:id" list. get reads; set replaces.
  getStarred: () => ipcRenderer.invoke('starred:get'),
  setStarred: (ids: string[]) => ipcRenderer.invoke('starred:set', { ids }),
  // Create a new project; returns the created Project.
  createProject: (name: string) => ipcRenderer.invoke('projects:create', { name }),
  // Rename a project (bumps updatedAt); returns the updated Project or null.
  renameProject: (id: string, name: string) => ipcRenderer.invoke('projects:rename', { id, name }),
  // Delete a project's directory; returns { ok: boolean }.
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', { id }),
  // Load a single validated project to enter its workspace; returns Project or null.
  openProject: (id: string) => ipcRenderer.invoke('projects:open', { id }),
  // ── Datasets (file-based data sources) ──
  // Open the native file picker (or, with { filePath }, re-parse a picked file's
  // sheet); returns { ok, canceled?, filePath?, fileName?, sourceKind?, preview? }.
  pickAndParseDataset: (sheetName?: string, filePath?: string) =>
    ipcRenderer.invoke('dataset:pickAndParse', { sheetName, filePath }),
  // Parse pasted text (JSON / CSV / TSV auto-detect); returns { ok, preview }.
  parsePasteDataset: (text: string) => ipcRenderer.invoke('dataset:parsePaste', { text }),
  // Persist a dataset under its project; returns the saved Dataset or { ok:false, error }.
  // `origin` (optional) is what makes the dataset refreshable later; main
  // whitelists it before storing, so an unrecognised one is simply dropped.
  saveDataset: (payload: { projectId: string; name: string; sourceKind: string; columns: any[]; rows: any[]; origin?: any }) =>
    ipcRenderer.invoke('dataset:save', payload),
  // Re-fetch a dataset from wherever it came from (file / url / connection /
  // combined). Returns { ok:true, dataset, warnings } or { ok:false, error }.
  // A failure never touches the stored rows.
  refreshDataset: (projectId: string, id: string) => ipcRenderer.invoke('dataset:refresh', { projectId, id }),
  // List a project's dataset summaries (newest-updated first).
  listDatasets: (projectId: string) => ipcRenderer.invoke('dataset:list', { projectId }),
  // ── Capture → dataset (Week 13) ──
  // Turn a capture's extractedTable into a review-grid draft (strictly typed,
  // rectangular) WITHOUT saving. Returns { ok, columns, rows, warnings }.
  captureToDatasetDraft: (extractedTable: any) =>
    ipcRenderer.invoke('captureDataset:draft', { extractedTable }),
  // Persist the reviewed/corrected capture as a dataset, or replace/append an
  // existing capture-dataset (target). cropPath is resolved in MAIN from entryId —
  // never sent from here. Returns { ok, dataset, warnings } | { ok:false, error }.
  saveCaptureDataset: (payload: {
    projectId: string;
    name: string;
    entryId: any;
    columns: any[];
    rows: any[];
    target?: { datasetId: string; mode: 'replace' | 'append' };
  }) => ipcRenderer.invoke('captureDataset:save', payload),
  // Load a single dataset (full rows) by id; returns Dataset or null.
  getDataset: (projectId: string, id: string) => ipcRenderer.invoke('dataset:get', { projectId, id }),
  // Delete a dataset; returns { ok: boolean }.
  deleteDataset: (projectId: string, id: string) => ipcRenderer.invoke('dataset:delete', { projectId, id }),
  // Per-column summaries + quality issues for an opened dataset (computed once in main).
  datasetStats: (projectId: string, datasetId: string) =>
    ipcRenderer.invoke('dataset:stats', { projectId, datasetId }),
  // Open a dataset WITHOUT its rows — metadata only. The grid fetches the window
  // it draws through datasetPage, so nothing needs the full table clone.
  getDatasetMeta: (projectId: string, id: string) =>
    ipcRenderer.invoke('dataset:meta', { projectId, id }),
  // Distinct values of ONE column, computed in main off the Parquet. The
  // dashboard filter picker used to hydrate the whole table to do this itself.
  // `search` is applied IN SQL and `total` comes back with the page, so the
  // filter picker never fetches a whole column to filter it in the renderer.
  datasetDistinct: (projectId: string, datasetId: string, column: string, limit?: number, search?: string) =>
    ipcRenderer.invoke('dataset:distinct', { projectId, datasetId, column, limit, search }),
  // One window of rows for the Explore grid, paged/searched/sorted in main against
  // the stored .parquet. The grid used to hold the WHOLE table in renderer memory
  // and re-copy it on every keystroke, which is what capped datasets at 50k rows.
  datasetPage: (
    projectId: string,
    datasetId: string,
    req: {
      offset: number;
      limit: number;
      search?: string;
      sortColumn?: string;
      sortDir?: 'asc' | 'desc';
      filters?: any[];
    },
  ) => ipcRenderer.invoke('dataset:page', { projectId, datasetId, ...req }),
  // Rename columns / correct types; main re-coerces cells on a type change. Returns
  // { ok, dataset } | { ok:false, error }.
  // `autoRefresh`: 'hourly' | 'daily' | 'weekly' to set, null/'off' to clear,
  // omitted to leave alone. Same channel as the column patch — one record.
  setDatasetAutoRefresh: (projectId: string, datasetId: string, autoRefresh: string | null) =>
    ipcRenderer.invoke('dataset:update', { projectId, datasetId, autoRefresh }),
  setDatasetWatch: (projectId: string, datasetId: string, watch: boolean) =>
    ipcRenderer.invoke('dataset:update', { projectId, datasetId, watch }),
  updateDataset: (projectId: string, datasetId: string, columns: any[]) =>
    ipcRenderer.invoke('dataset:update', { projectId, datasetId, columns }),
  // OPTIONAL AI narration of an opened dataset (numbers computed in main, not by
  // the model). Returns { ok, text } | { ok:false, notReady } | { ok:false, error }.
  explainDataset: (projectId: string, datasetId: string) =>
    ipcRenderer.invoke('dataset:explain', { payload: { projectId, datasetId } }),
  // ── Data preparation (reversible transform pipeline) ──
  // Steps are addressed by array index. Every step-mutating call recomputes the
  // derived output from the immutable source in main and returns
  // { ok, dataset, preview:{ columns, rows, rowCount, warnings } }.
  addDatasetStep: (projectId: string, datasetId: string, step: any) =>
    ipcRenderer.invoke('dataset:addStep', { projectId, datasetId, step }),
  updateDatasetStep: (projectId: string, datasetId: string, index: number, step: any) =>
    ipcRenderer.invoke('dataset:updateStep', { projectId, datasetId, index, step }),
  removeDatasetStep: (projectId: string, datasetId: string, index: number) =>
    ipcRenderer.invoke('dataset:removeStep', { projectId, datasetId, index }),
  reorderDatasetSteps: (projectId: string, datasetId: string, order: number[]) =>
    ipcRenderer.invoke('dataset:reorderSteps', { projectId, datasetId, order }),
  setDatasetSteps: (projectId: string, datasetId: string, steps: any[]) =>
    ipcRenderer.invoke('dataset:setSteps', { projectId, datasetId, steps }),
  // Combine two datasets' PREPARED output into a brand-new saved dataset →
  // { ok, dataset, warnings }.
  combineDatasets: (
    projectId: string,
    datasetId: string,
    otherDatasetId: string,
    mode: 'append' | 'join',
    on?: { left: string; right: string },
  ) => ipcRenderer.invoke('dataset:combine', { projectId, datasetId, otherDatasetId, mode, on }),
  // ── The dataset composer ──────────────────────────────────────────────────
  // One chain shape for both: a `base` that is EITHER { datasetId } or
  // { inline: { name, columns, rows } } — the file just picked, not saved yet —
  // and `joins`, each { datasetId | inline, mode, on? }. Preview folds a 50k
  // sample per parent and returns one page; save folds the lot.
  composePreview: (
    projectId: string,
    base: any,
    joins: any[],
    page?: number,
  ) => ipcRenderer.invoke('dataset:composePreview', { projectId, base, joins, page }),
  composeSave: (payload: {
    projectId: string;
    name: string;
    base: any;
    joins: any[];
    steps?: any[];
    sourceKind?: string;
    origin?: any;
  }) => ipcRenderer.invoke('dataset:composeSave', payload),
  // OPTIONAL AI step suggestions (structure only; app does all math). Returns
  // { ok, steps } | { ok:false, notReady:true } | { ok:false, error }.
  suggestDatasetSteps: (projectId: string, datasetId: string) =>
    ipcRenderer.invoke('dataset:suggestSteps', { projectId, datasetId }),
  // OPTIONAL AI calculated-field suggestion (structure only — the app compiles and
  // computes the formula). Returns the proposal WITHOUT applying it, for the user to
  // edit and Save. { ok, name, expression, warning? } | { ok:false, notReady:true } |
  // { ok:false, error }.
  suggestCalcField: (projectId: string, datasetId: string) =>
    ipcRenderer.invoke('dataset:suggestCalcField', { projectId, datasetId }),
  // ── Connected data sources (every source is a connector in src/connectors) ──
  // Secrets (passwords / tokens / API keys) travel ONE-WAY to main inside
  // `secret` and are NEVER read back — no reveal bridge, mirroring BYOK keys.
  // Every data source the app can read, as {id,label,family,category,blurb,
  // fields} — enough to BUILD the connection form with no hardcoded list in the
  // renderer. Form SHAPE only: a field's `secret` flag travels so the renderer
  // can render a password input and route the value into `secret`; a secret
  // VALUE never comes back this way. Resolves to a bare array (empty if the
  // registry could not be read — the picker falls back on its own).
  connectorCatalog: () => ipcRenderer.invoke('connectors:catalog'),
  // List a project's saved connections (secret-free public view).
  listConnections: (projectId: string) => ipcRenderer.invoke('connections:list', { projectId }),
  // Global search — NAMES only, across the five things the sidebar's box names.
  searchWorkspace: (projectId: string, query: string) =>
    ipcRenderer.invoke('search:query', { projectId, query }),
  // Test a connection with the typed secret; persist metadata + secret only on
  // success. `kind` is the connectorId (the two pre-registry names, 'postgres'
  // and 'url', are the ids of the connectors that replaced them, so an
  // un-migrated caller keeps working); `config` carries the form field values.
  testAndSaveConnection: (projectId: string, kind: string, config: any, secret: any) =>
    ipcRenderer.invoke('connection:testAndSave', { projectId, kind, config, secret }),
  // List a saved connection's tables (secret loaded in main). A source with no
  // table picker returns an empty list, not an error.
  listConnectionTables: (projectId: string, connId: string) =>
    ipcRenderer.invoke('connection:listTables', { projectId, connId }),
  // Run a saved connection and return a ParseResult preview (no save).
  runConnection: (projectId: string, connId: string, tableOrQuery: any) =>
    ipcRenderer.invoke('connection:run', { projectId, connId, tableOrQuery }),
  // Re-run a connection and overwrite its linked dataset's data.
  refreshConnection: (projectId: string, connId: string, datasetId: string) =>
    ipcRenderer.invoke('connection:refresh', { projectId, connId, datasetId }),
  // Delete a saved connection (also drops its secret from config.json).
  deleteConnection: (projectId: string, connId: string) =>
    ipcRenderer.invoke('connection:delete', { projectId, connId }),
  // ── Visuals (saved charts/maps built from a dataset + an encoding) ──
  // List a project's saved visuals (newest-updated first).
  listVisuals: (projectId: string) => ipcRenderer.invoke('visual:list', { projectId }),
  // Load a single visual by id; returns Visual or null.
  getVisual: (projectId: string, id: string) => ipcRenderer.invoke('visual:get', { projectId, id }),
  // Persist a new visual; returns the saved Visual or { ok:false, error }. Carries
  // optional chart-styling `overrides` and visual-level `filters`.
  saveVisual: (payload: { projectId: string; datasetId: string; name: string; chartType: string; encoding: any; overrides?: any; filters?: any }) =>
    ipcRenderer.invoke('visual:save', payload),
  // Patch an existing visual's name / chartType / encoding / overrides / filters
  // / favorite (datasetId immutable). Any omitted field keeps its stored value.
  updateVisual: (projectId: string, id: string, patch: { name?: string; chartType?: string; encoding?: any; overrides?: any; filters?: any; favorite?: boolean }) =>
    ipcRenderer.invoke('visual:update', { projectId, id, ...patch }),
  // Delete a visual; returns { ok: boolean }.
  deleteVisual: (projectId: string, id: string) => ipcRenderer.invoke('visual:delete', { projectId, id }),
  // Duplicate a visual into an independent copy; returns { ok, visual } | { ok:false, error }.
  duplicateVisual: (projectId: string, id: string) => ipcRenderer.invoke('visual:duplicate', { projectId, id }),
  // OPTIONAL AI chart suggestions (structure only, execution-gated). Returns
  // { ok:true, options:[{ encoding, chartType, why }] } | { ok:false, notReady }
  // | { ok:false, error }. `intent` is the user's own words and may be ''.
  suggestVisual: (projectId: string, datasetId: string, intent?: string) =>
    ipcRenderer.invoke('visual:suggest', { projectId, datasetId, intent }),
  // Compute the renderer-ready { labels, series } (+ optional geo) for an encoding
  // over a dataset — ALL aggregation math runs in main's pure bridge (no model).
  // Optional `filters` (transforms filter steps) are applied BEFORE aggregation.
  computeVisualData: (projectId: string, datasetId: string, encoding: any, filters?: any) =>
    ipcRenderer.invoke('visual:data', { projectId, datasetId, encoding, filters }),
  // The ROWS behind one mark of that same chart — same dataset, same filter
  // list, plus an equality filter per clicked axis. Paged/searched/sorted in
  // main against the stored .parquet. Returns
  // { ok:true, available:true, filters, columns, rows, total, offset }
  // | { ok:true, available:false, reason } when the row set cannot be derived
  // exactly | { ok:false, error }. A READ: it writes nothing.
  visualRows: (
    projectId: string,
    datasetId: string,
    encoding: any,
    filters: any,
    mark: any,
    page: { offset: number; limit: number; search?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' },
  ) => ipcRenderer.invoke('visual:rows', { projectId, datasetId, encoding, filters, mark, page }),
  // The same row set as a CSV file. Main re-resolves the drill, opens the native
  // save panel and streams the rows — the renderer sends arguments, never rows.
  // Returns { ok:true, dest, rows } | { ok:false, canceled } | { ok:false, error }.
  exportVisualRows: (
    projectId: string,
    datasetId: string,
    encoding: any,
    filters: any,
    mark: any,
    page: { search?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' },
    name?: string,
  ) => ipcRenderer.invoke('visual:rowsExport', { projectId, datasetId, encoding, filters, mark, page, name }),
  // ── Mosaic connector (Phase 3c) — Mosaic's whole database contract is one
  // method, so it is two channels here. Ensure the typed, user-named SQL VIEW
  // over a dataset's stored Parquet and report the columns it exposes; returns
  // { ok, name, columns:[{name,type,sqlType}] } | { ok:false, error }.
  mosaicView: (projectId: string, datasetId: string) => ipcRenderer.invoke('mosaic:view', { projectId, datasetId }),
  // Run ONE statement and get plain JSON rows back (Arrow is impossible — the
  // native binding ships none — and is REJECTED rather than downgraded, so build
  // the Coordinator with { consolidate: false }). type: 'json' (default) | 'exec'.
  // Returns { ok, rows, rowCount, truncated } | { ok:false, error }.
  mosaicQuery: (sql: string, type?: string) => ipcRenderer.invoke('mosaic:query', { sql, type }),
  // ── Dashboards (a grid of cards — visual/text/metric — across one or more pages) ──
  // List a project's saved dashboards (newest-updated first).
  listDashboards: (projectId: string) => ipcRenderer.invoke('dashboard:list', { projectId }),
  // Load a single dashboard (full pages/cards) by id; returns Dashboard or null.
  getDashboard: (projectId: string, id: string) => ipcRenderer.invoke('dashboard:get', { projectId, id }),
  // Persist a new dashboard; returns the saved Dashboard or { ok:false, error }.
  // Optional dashboard-wide `filters` (transforms filter steps) are merged into every card.
  saveDashboard: (payload: { projectId: string; name: string; pages?: any; filters?: any }) =>
    ipcRenderer.invoke('dashboard:save', payload),
  // Patch an existing dashboard's name / pages / dashboard-wide filters; returns
  // { ok, dashboard } | { ok:false, error }. Any omitted field keeps its stored value.
  updateDashboard: (projectId: string, id: string, patch: { name?: string; pages?: any; filters?: any }) =>
    ipcRenderer.invoke('dashboard:update', { projectId, id, ...patch }),
  // Delete a dashboard; returns { ok: boolean }.
  deleteDashboard: (projectId: string, id: string) => ipcRenderer.invoke('dashboard:delete', { projectId, id }),
  // ── The AI ANALYSIS PLAN: draft → (edit →) preview → build ────────────────
  //
  // OPTIONAL AI plan draft (STRUCTURE ONLY — the model names datasets, columns,
  // chart types, aggregations and formulas, and never writes a figure). MAIN
  // builds a row-free FACTS block, makes the one model call, VALIDATES the
  // envelope against the real records, and renders a preview from real data.
  // Returns WITHOUT saving anything.
  //
  //   { ok:true, name, rationale, sheets:[{name, visuals:[VisualPreview]}],
  //     calculatedFields:[CalcFieldPreview], dropped:[{kind, where, message}],
  //     plan }                                  ← hand `plan` back to build
  //   | { ok:false, notReady:true }              ← no model configured
  //   | { ok:false, error }
  //
  // A VisualPreview carries { name, chartType, encoding, filters, datasetName,
  // data, recommendedShape, warnings, note? }. `data` is the EXACT
  // {labels, series} shape chartRender.buildChart consumes, computed by the same
  // function that will draw the built Visual — or null, with `note` saying why
  // (a card waiting on a calculated field; a table too large to preview). A
  // CalcFieldPreview carries { name, expression, refs, unknownRefs, sample } —
  // the sample is real rows the APP evaluated. `dropped` is what the model
  // proposed and the app refused; show it, do not hide it.
  //
  // The CHANNEL is `analysis:draft`; `dashboard:draft` was deleted, not aliased.
  // The METHOD name is kept — the model call behind it is still
  // analyze.draftDashboard(), extended in place rather than twinned.
  // `opts` scopes the draft: `datasetId` narrows the FACTS block to one dataset,
  // `intent` is the user's own description of what they want. Both optional — the
  // hero/empty-state buttons still call this with a bare projectId.
  draftDashboard: (projectId: string, opts?: { datasetId?: string; intent?: string }) =>
    ipcRenderer.invoke('analysis:draft', {
      projectId,
      datasetId: opts && opts.datasetId,
      intent: opts && opts.intent,
    }),
  // Re-validate + re-preview a plan the USER edited. NOT an AI call — this works
  // with no model configured. Same reply shape as draftDashboard, minus notReady.
  previewAnalysisPlan: (projectId: string, plan: any) =>
    ipcRenderer.invoke('analysis:previewPlan', { projectId, plan }),
  // APPROVAL. Re-validates with the same validator the preview ran, then creates
  // the records: calculated fields become ordinary TransformSteps, visuals become
  // real Visuals, sheets become an Analysis. Also NOT an AI call.
  // { ok:true, analysis, visualIds, calculatedFields, dropped, warnings }
  // | { ok:false, error }.
  buildAnalysisPlan: (projectId: string, plan: any) =>
    ipcRenderer.invoke('analysis:buildPlan', { projectId, plan }),

  // ── Analyses (the AUTHORING container — sheets of cards + analysis-wide
  // filters; a dashboard is a published snapshot OF one). ────────────────────
  listAnalyses: (projectId: string) => ipcRenderer.invoke('analysis:list', { projectId }),
  getAnalysis: (projectId: string, id: string) => ipcRenderer.invoke('analysis:get', { projectId, id }),
  createAnalysis: (payload: { projectId: string; name: string; sheets?: any; filters?: any }) =>
    ipcRenderer.invoke('analysis:create', payload),
  renameAnalysis: (projectId: string, id: string, name: string) =>
    ipcRenderer.invoke('analysis:rename', { projectId, id, name }),
  updateAnalysis: (projectId: string, id: string, patch: { name?: string; sheets?: any; filters?: any }) =>
    ipcRenderer.invoke('analysis:update', { projectId, id, ...patch }),
  deleteAnalysis: (projectId: string, id: string) => ipcRenderer.invoke('analysis:delete', { projectId, id }),
  // PUBLISH — take a SNAPSHOT of the analysis as a dashboard. Each referenced
  // Visual's DEFINITION is copied BY VALUE into its card, so editing (or
  // deleting) that visual afterwards cannot change the published dashboard.
  // Data is NOT snapshotted: a published dashboard reads live data through a
  // frozen definition. Pass `dashboardId` to REPUBLISH over one this analysis
  // published before; anything else publishes a new dashboard.
  // { ok, dashboard, created } | { ok:false, error }.
  publishAnalysis: (projectId: string, id: string, opts?: { dashboardId?: string; name?: string }) =>
    ipcRenderer.invoke('analysis:publish', { projectId, id, ...(opts || {}) }),
  // The implicit wrap of a LEGACY standalone dashboard. Call it when the user
  // opens one FOR EDITING — never on list, never on open-to-view: that is what
  // keeps a read a read. Idempotent. { ok, analysis, created } | { ok:false, error }.
  analysisForDashboard: (projectId: string, dashboardId: string) =>
    ipcRenderer.invoke('analysis:forDashboard', { projectId, dashboardId }),
  // OPTIONAL AI executive summary (prose). MAIN recomputes every card's figure and
  // feeds them as FACTS; the model only narrates, never recomputes. Returns
  // { ok, text, provenance } | { ok:false, notReady:true } | { ok:false, error }.
  summarizeDashboard: (projectId: string, id: string) => ipcRenderer.invoke('dashboard:summary', { projectId, id }),
  // OPTIONAL anomaly explanation — the APP detects anomalies (pure, computed), the
  // model only contextualizes them. Returns the raw app-detected list alongside the
  // prose. { ok, text, anomalies } (text may be null when none) |
  // { ok:false, notReady:true, anomalies } | { ok:false, error }.
  explainDashboardAnomalies: (projectId: string, id: string) =>
    ipcRenderer.invoke('dashboard:explainAnomalies', { projectId, id }),
  // The ONE app-computed number a metric card shows (computed in MAIN, never the
  // model, never the renderer). Optional dashboard-wide `filters` are applied (in MAIN)
  // over the dataset BEFORE the number is computed. Returns
  // { ok:true, value:number|null } | { ok:false, error }.
  computeMetric: (projectId: string, datasetId: string, column: string, aggregation: string, filters?: any) =>
    ipcRenderer.invoke('dashboard:metric', { projectId, datasetId, column, aggregation, filters }),
  // ── Dashboard export + share (Week 10) ──
  // Build + save a self-contained, offline interactive .html of the dashboard (inlined
  // app-computed data + a copy of Chart.js + a render script). Returns { ok, dest? }.
  exportDashboardHtml: (bundle: any, defaultName?: string) =>
    ipcRenderer.invoke('dashboard:exportHtml', { bundle, defaultName }),
  // Snapshot a renderer-built dashboard one-pager HTML → PNG (reused report-capture path).
  exportDashboardPng: (html: string, width: number, defaultName?: string) =>
    ipcRenderer.invoke('dashboard:exportPng', { html, width, defaultName }),
  // Same offscreen render → native Chromium printToPDF (no new dependency).
  exportDashboardPdf: (html: string, width: number, defaultName?: string) =>
    ipcRenderer.invoke('dashboard:exportPdf', { html, width, defaultName }),
  // Reveal the project's on-disk folder — the git-shareable, secret-free artifact.
  // projectId is UUID-guarded in MAIN so the path can never escape userData/projects.
  revealProjectFolder: (projectId: string) => ipcRenderer.invoke('dashboard:revealFolder', { projectId }),
  // ── AI Copilot (Week 11) — per-project, context-aware chat ──
  // Load one conversation's turns (survives reload); returns { ok, turns, threadId }.
  // threadId is optional and defaults to the most recent conversation, so every
  // pre-threads caller keeps working unchanged.
  copilotHistory: (projectId: string, threadId?: string) =>
    ipcRenderer.invoke('copilot:history', { projectId, threadId }),
  // List a project's conversations, newest-touched first; returns
  // { ok, threads: [{ id, title, updatedAt, turnCount }] }.
  copilotThreads: (projectId: string) => ipcRenderer.invoke('copilot:threads', { projectId }),
  // Start a fresh conversation; returns { ok, thread }.
  copilotNewThread: (projectId: string) => ipcRenderer.invoke('copilot:newThread', { projectId }),
  // Ask a question about the active entity. context = { kind, id } (kind:
  // 'dataset'|'visual'|'dashboard', else project inventory). Numbers are computed
  // in MAIN; the model only narrates. threadId is optional (most recent).
  // Returns { ok, answer, provenance, turns, threadId } |
  // { ok:false, notReady:true } | { ok:false, error }.
  copilotAsk: (projectId: string, context: { kind?: string; id?: string }, question: string, threadId?: string) =>
    ipcRenderer.invoke('copilot:ask', { projectId, context, question, threadId }),
  // Clear a project's chat history; returns { ok: boolean }.
  copilotClear: (projectId: string) => ipcRenderer.invoke('copilot:clear', { projectId }),
  // Flip the hard ON/OFF switch; returns { ok, enabled }.
  setCopilotEnabled: (enabled: boolean) => ipcRenderer.invoke('copilot:setEnabled', { enabled }),
  // Shared map { providerId: { path, color, title } } for real brand icons (no keys).
  providerLogos: PROVIDER_LOGOS,
  // Static map of { agentId: dataUri } for full-color logos (no keys).
  agentLogos: AGENT_LOGOS,
  connectorLogos: CONNECTOR_LOGOS,
  // App version string (e.g. "0.1.0") from package.json — for the About panel.
  appVersion: APP_VERSION,
});
