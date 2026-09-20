// Shared cross-file globals for the hub renderer. The hub is many classic
// <script> files sharing ONE global scope (no modules) — every symbol defined
// in one hub file and consumed in another is declared here so each file
// type-checks standalone. Vendor globals (Chart.js, MapLibre GL, pdfmake, pptxgenjs,
// docx) and the preload bridge (window.hub) are typed loosely on purpose.

export {}; // make this a module so `declare global` works

// ── Shared shapes ───────────────────────────────────────────────────────────

/** makeDropdown() options (see customDropdown.js header comment). */
interface DropdownOpts {
  className?: string;
  listClassName?: string;
  ariaLabel?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
}

/** The custom-dropdown widget API returned by makeDropdown(). */
interface DropdownApi {
  el: HTMLElement;
  setOptions(items: Array<{ value: any; label?: any }> | null | undefined, value?: any): DropdownApi;
  getValue(): string;
  open(): void;
  close(): void;
  value: any; // string in practice; setter coerces null/undefined to ''
  disabled: boolean;
  hidden: boolean;
  placeholder: string;
}

declare global {
  /** One live activity step pushed from main during an in-flight ask
   *  (src/ipc/copilot.ts ActivityStep). App-authored strings + counts only —
   *  NEVER model output, NEVER a data value. Rendered as a chip by
   *  askActivity.ts. */
  interface ActivityStep {
    kind: 'read' | 'compute' | 'quality' | 'model' | 'inventory';
    label: string;
    detail?: string;
    count?: number;
  }

  // ── Preload bridge (preload/hubPreload.js) ────────────────────────────────
  // Methods mirror the contextBridge surface 1:1. Payloads/results are typed
  // loosely (any) — ponytail: big IPC envelopes, tighten per-method as needed.
  interface Window {
    hub: {
      takeScreenshot(): void;
      getKeyStatus(): Promise<any>;
      saveKey(provider: string, key: string): Promise<any>;
      saveLocalEndpoint(endpoint: string): Promise<any>;
      clearKey(provider: string): Promise<any>;
      validateKey(provider: string, key: string, endpoint?: string): Promise<any>;
      getModels(provider: string): Promise<any>;
      saveModel(provider: string, model: string): Promise<any>;
      activateProvider(provider: string): Promise<any>;
      setExecutionMode(mode: string): Promise<any>;
      setMemoryModel(fields: any): Promise<any>;
      setGlobalRules(text: string): Promise<any>;
      onDatasetRefreshed(cb: (o: any) => void): void;
      setAutoRefreshEnabled(on: boolean): Promise<any>;
      setNotifications(fields: any): Promise<any>;
      bootstrapNotifications(): Promise<any>;
      deleteData(scope: string): Promise<any>;
      saveByokProvider(provider: string, fields: any): Promise<any>;
      activateByokProvider(provider: string): Promise<any>;
      testByokProvider(provider: string): Promise<any>;
      revealByokKey(provider: string): Promise<any>;
      detectLocalClis(): Promise<any>;
      detectOneCli(id: string): Promise<any>;
      setLocalCli(id: string): Promise<any>;
      testLocalCli(id: string): Promise<any>;
      listCliModels(id: string): Promise<any>;
      saveCliModel(id: string, model: string): Promise<any>;
      listModels(target: any, force?: boolean): Promise<any>;
      onKeyChanged(cb: () => void): void;
      onOpenSettings(cb: (cat?: string) => void): void;
      openExternal(url: string): void;
      openSystemSettings(): Promise<any>;
      onShowPermission(cb: () => void): void;
      loadGeo(level: string): Promise<any>;
      getHotkeyLabel(): Promise<any>;
      saveHotkey(accelerator: string): Promise<any>;
      onHotkeyState(cb: (data: any) => void): void;
      openInputMonitoringSettings(): void;
      onNewEntry(cb: (data: any) => void): void;
      onEntryResult(cb: (data: any) => void): void;
      retry(entryId: string): void;
      followup(entryId: string, text: string): void;
      onFollowupResult(cb: (data: any) => void): void;
      onHistory(cb: (data: any) => void): void;
      loadThread(entryId: string): Promise<any>;
      deleteThread(entryId: string): Promise<any>;
      copyText(text: string): void;
      copyImage(dataUrl: string): void;
      saveImage(src: string, defaultName?: string): Promise<any>;
      savePdf(base64: string, defaultName: string): Promise<any>;
      savePptx(base64: string, defaultName: string): Promise<any>;
      saveDocx(base64: string, defaultName: string): Promise<any>;
      captureRegion(rect: { x: number; y: number; width: number; height: number }): Promise<any>;
      captureReport(html: string, width: number): Promise<any>;
      getThemePreference(): Promise<any>;
      setThemePreference(preference: string): Promise<any>;
      onThemeApply(cb: (data: any) => void): void;
      saveChartOverrides(entryId: string, key: string, overrides: any): Promise<any>;
      // ── Projects (workspace shell) ──
      listProjects(): Promise<any[]>;
      recentItems(limit?: number): Promise<any[]>;
      // Insights — what the app FOUND in the data (src/ipc/insights.ts).
      listInsights(projectId: string, datasetId?: string): Promise<any>;
      dismissInsight(projectId: string, id: string, dismissed?: boolean): Promise<any>;
      userName(): Promise<string>;
      getStarred(): Promise<string[]>;
      setStarred(ids: string[]): Promise<{ ok: boolean; starred: string[] }>;
      createProject(name: string): Promise<any>;
      renameProject(id: string, name: string): Promise<any>;
      deleteProject(id: string): Promise<{ ok: boolean }>;
      openProject(id: string): Promise<any>;
      // ── Datasets (file-based data sources) ──
      pickAndParseDataset(sheetName?: string, filePath?: string): Promise<any>;
      parsePasteDataset(text: string): Promise<any>;
      saveDataset(payload: { projectId: string; name: string; sourceKind: string; columns: any[]; rows: any[]; origin?: any }): Promise<any>;
      refreshDataset(projectId: string, id: string): Promise<any>;
      listDatasets(projectId: string): Promise<any[]>;
      // ── Capture → dataset (Week 13) ──
      captureToDatasetDraft(extractedTable: any): Promise<any>;
      saveCaptureDataset(payload: {
        projectId: string;
        name: string;
        entryId: any;
        columns: any[];
        rows: any[];
        target?: { datasetId: string; mode: 'replace' | 'append' };
      }): Promise<any>;
      getDataset(projectId: string, id: string): Promise<any>;
      // Metadata only — same shape as getDataset but WITHOUT `rows`, and it never
      // migrates (a metadata read stays a read). Prefer this anywhere only
      // `columns` is needed: getDataset hydrates the whole table, which is ~4 s
      // at the 1,000,000-row cap and was freezing three modal-open paths.
      getDatasetMeta(projectId: string, id: string): Promise<any>;
      // Distinct non-empty values of one column, capped, computed in MAIN off the
      // Parquet. Replaces scanning `ds.rows` in the renderer.
      // `search` filters SERVER-SIDE; `total` is the pre-cap match count, so the
      // caller can say "showing the first N of M" instead of implying N is all.
      datasetDistinct(
        projectId: string,
        datasetId: string,
        column: string,
        limit?: number,
        search?: string,
      ): Promise<{ values: string[]; total: number }>;
      deleteDataset(projectId: string, id: string): Promise<{ ok: boolean }>;
      datasetStats(projectId: string, datasetId: string): Promise<any>;
      datasetMedian(projectId: string, datasetId: string, column: string): Promise<any>;
      setDatasetAutoRefresh(projectId: string, datasetId: string, autoRefresh: string | null): Promise<any>;
      setDatasetWatch(projectId: string, datasetId: string, watch: boolean): Promise<any>;
      updateDataset(projectId: string, datasetId: string, columns: any[]): Promise<any>;
      explainDataset(projectId: string, datasetId: string): Promise<any>;
      // ── Data preparation (reversible transform pipeline) ──
      addDatasetStep(projectId: string, datasetId: string, step: any): Promise<any>;
      updateDatasetStep(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
      removeDatasetStep(projectId: string, datasetId: string, index: number): Promise<any>;
      reorderDatasetSteps(projectId: string, datasetId: string, order: number[]): Promise<any>;
      setDatasetSteps(projectId: string, datasetId: string, steps: any[]): Promise<any>;
      combineDatasets(
        projectId: string,
        datasetId: string,
        otherDatasetId: string,
        mode: 'append' | 'join',
        on?: { left: string; right: string },
      ): Promise<any>;
      composePreview(projectId: string, base: any, joins: any[], page?: number): Promise<any>;
      composeSave(payload: {
        projectId: string;
        name: string;
        base: any;
        joins: any[];
        steps?: any[];
        sourceKind?: string;
        origin?: any;
      }): Promise<any>;
      suggestDatasetSteps(projectId: string, datasetId: string): Promise<any>;
      suggestCalcField(projectId: string, datasetId: string): Promise<any>;
      checkFormula(projectId: string, datasetId: string, expression: string): Promise<any>;
      formulaFunctions(): Promise<any[]>;
      // ── Connected data sources (every source is a connector in src/connectors) ──
      // The picker/form catalog. Form SHAPE only — `secret` marks a field whose
      // value goes one-way into the `secret` payload; no value ever comes back.
      connectorCatalog(): Promise<
        {
          id: string;
          label: string;
          family: string;
          category: string;
          blurb?: string;
          fields: {
            key: string;
            label: string;
            type: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea';
            required: boolean;
            placeholder?: string;
            default?: string | number | boolean;
            options?: { value: string; label: string }[];
            secret: boolean;
            help?: string;
          }[];
        }[]
      >;
      searchWorkspace(projectId: string, query: string): Promise<any>;
      listConnections(projectId: string): Promise<any[]>;
      testAndSaveConnection(projectId: string, kind: string, config: any, secret: any): Promise<any>;
      listConnectionTables(projectId: string, connId: string): Promise<any>;
      runConnection(projectId: string, connId: string, tableOrQuery: any): Promise<any>;
      refreshConnection(projectId: string, connId: string, datasetId: string): Promise<any>;
      deleteConnection(projectId: string, connId: string): Promise<{ ok: boolean }>;
      // ── Visuals (saved charts/maps from a dataset + an encoding) ──
      listVisuals(projectId: string): Promise<any[]>;
      getVisual(projectId: string, id: string): Promise<any>;
      saveVisual(payload: {
        projectId: string;
        datasetId: string;
        name: string;
        chartType: string;
        encoding: any;
        overrides?: any;
        filters?: any;
      }): Promise<any>;
      updateVisual(
        projectId: string,
        id: string,
        patch: { name?: string; chartType?: string; encoding?: any; overrides?: any; filters?: any; favorite?: boolean },
      ): Promise<any>;
      deleteVisual(projectId: string, id: string): Promise<{ ok: boolean }>;
      duplicateVisual(projectId: string, id: string): Promise<any>;
      suggestVisual(projectId: string, datasetId: string, intent?: string): Promise<any>;
      computeVisualData(projectId: string, datasetId: string, encoding: any, filters?: any): Promise<any>;
      // The rows behind one mark of that chart — same dataset, same filters,
      // plus an equality filter per clicked axis. Paged/searched/sorted in main.
      // `{ ok:true, available:false, reason }` when the row set cannot be
      // derived exactly, which the panel shows instead of a grid.
      visualRows(
        projectId: string,
        datasetId: string,
        encoding: any,
        filters: any,
        mark: any,
        page: { offset: number; limit: number; search?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' },
      ): Promise<any>;
      // That same row set as a CSV file, written in main through the native save
      // panel. Returns { ok, dest, rows } | { ok:false, canceled|error }.
      exportVisualRows(
        projectId: string,
        datasetId: string,
        encoding: any,
        filters: any,
        mark: any,
        page: { search?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' },
        name?: string,
      ): Promise<any>;
      // ── Mosaic connector (Phase 3c) — the whole database contract in two calls ──
      mosaicView(
        projectId: string,
        datasetId: string,
      ): Promise<
        | { ok: true; name: string; columns: { name: string; type: string; sqlType: 'DOUBLE' | 'VARCHAR' }[] }
        | { ok: false; error: string }
      >;
      mosaicQuery(
        sql: string,
        type?: 'json' | 'exec' | 'arrow',
      ): Promise<
        | { ok: true; rows: Record<string, string | number | null>[]; rowCount: number; truncated: boolean }
        | { ok: false; error: string }
      >;
      // Channel `analysis:draft` (the old `dashboard:draft` was deleted, not
      // aliased). Phase E widened the reply to
      //   { ok, name, rationale, sheets: [{ name, visuals: VisualPreview[] }],
      //     calculatedFields, dropped: [{kind, where, message}], plan }
      // — `sheets`, never `pages`. A VisualPreview's `data` is already the exact
      // {labels, series} (+ geo) object chartRender.buildChart consumes; when it
      // is null it carries a `note` saying why, and that note is what gets
      // rendered — never a substituted figure.
      // `opts` scopes the draft: `datasetId` narrows the FACTS block to one
      // dataset, `intent` is the user's own words from the create wizard. Both
      // optional — the unscoped whole-project draft still passes one argument.
      draftDashboard(
        projectId: string,
        opts?: { datasetId?: string; intent?: string },
      ): Promise<any>;
      // The two halves of the Phase E plan pipeline: preview re-renders a plan
      // without writing anything; build materialises it. Typed loosely because
      // the plan envelope is owned by main (same convention as the rest of this
      // bridge) — ponytail.
      editDashboard(projectId: string, analysisId: string, intent: string): Promise<any>;
      previewAnalysisPlan(projectId: string, plan: any): Promise<any>;
      buildAnalysisPlan(projectId: string, plan: any): Promise<any>;
      starterCards(projectId: string, kind: string, datasetId?: string): Promise<any>;
      // ── Analyses (the AUTHORING container — sheets of cards + filters) ──
      listAnalyses(projectId: string): Promise<any[]>;
      getAnalysis(projectId: string, id: string): Promise<any>;
      createAnalysis(payload: { projectId: string; name: string; sheets?: any; filters?: any; style?: any }): Promise<any>;
      renameAnalysis(projectId: string, id: string, name: string): Promise<any>;
      updateAnalysis(
        projectId: string,
        id: string,
        patch: { name?: string; sheets?: any; filters?: any; style?: any },
      ): Promise<any>;
      deleteAnalysis(projectId: string, id: string): Promise<{ ok: boolean }>;
      // Dashboard TEMPLATES (the create wizard's gallery). Both model-free.
      listTemplates(projectId: string, datasetId?: string): Promise<any>;
      templatePlan(payload: {
        projectId: string;
        datasetId?: string;
        templateId: string;
        mapping: any;
        name?: string;
      }): Promise<any>;
      computeMetric(
        projectId: string,
        datasetId: string,
        column: string,
        aggregation: string,
        filters?: any,
      ): Promise<any>;
      exportDashboardHtml(bundle: any, defaultName?: string): Promise<any>;
      exportDashboardPng(html: string, width: number, defaultName?: string): Promise<any>;
      exportDashboardPdf(html: string, width: number, defaultName?: string): Promise<any>;
      revealProjectFolder(projectId: string): Promise<any>;
      // ── AI Copilot (Week 11) ──
      copilotHistory(projectId: string, threadId?: string): Promise<any>;
      copilotThreads(projectId: string): Promise<any>;
      copilotNewThread(projectId: string): Promise<any>;
      copilotAsk(
        projectId: string,
        context: { kind?: string; id?: string },
        question: string,
        threadId?: string,
        askId?: string,
      ): Promise<any>;
      // Live narration deltas for the in-flight copilotAsk with this askId.
      onCopilotChunk(cb: (d: { askId: string; delta: string }) => void): void;
      // Live activity steps for the in-flight copilotAsk with this askId.
      onAskActivity(cb: (o: { askId: string; step: ActivityStep }) => void): void;
      copilotClear(projectId: string): Promise<any>;
      setCopilotEnabled(enabled: boolean): Promise<any>;
      providerLogos: Record<string, { path: string; color: string; title: string }>;
      agentLogos: Record<string, string>;
      connectorLogos: Record<string,
        { path: string; color: string; title: string } |
        { src: string; title: string }
      >;
      appVersion: string;
    };

    // ── Vendor libraries loaded via <script> tags in index.html ────────────
    Chart: any; // ponytail: Chart.js UMD global, typing the full API isn't worth it
    ChartBoxPlot: any; // ponytail: @sgratzl/chartjs-chart-boxplot UMD global
    // Mosaic/vgplot IIFE global from vendor/vgplot.js (scripts/build-vendor.js).
    // 421 exports — marks, attribute directives, interactors and SQL builders —
    // all reached dynamically by name in plotRender.ts, so a hand-written type
    // would be a second, staler copy of the bundle's surface. Optional because
    // plotRender falls back to Chart.js when the tag failed to load.
    vg?: any; // ponytail: @uwdata/vgplot bundle global
    pdfMake: any; // ponytail: pdfmake UMD global
    PptxGenJS: any; // ponytail: pptxgenjs UMD global (constructor)
    docx: any; // ponytail: docx IIFE global
    // Baked GeoJSON payloads (assets/geo/*.js, generated by scripts/download-geo.js).
    __GEO_WORLD__: any; // ponytail: GeoJSON FeatureCollection
    __GEO_US_STATES__: any; // ponytail: GeoJSON FeatureCollection
    // customDropdown.js attaches its factory to window.
    makeDropdown: (opts?: DropdownOpts) => DropdownApi;
    // Safari/legacy-prefixed AudioContext probed by playCompletionSound() in hub.js.
    webkitAudioContext?: typeof AudioContext;
  }

  /**
   * MapLibre GL UMD global (maplibre-gl-csp.js script tag) — the map engine.
   * maplibre-gl ships real types in its own `maplibre-gl.d.ts`, but pulling
   * them in would need an `import`, and renderer files must stay classic
   * global-scope scripts (see the header comment).
   */
  const maplibregl: any; // ponytail: MapLibre API, can't import its .d.ts from a script

  // HTMLElement carries the dropdown API after makeDropdown() (root._dd = api).
  interface HTMLElement {
    _dd?: DropdownApi;
  }

  // These three are defined INSIDE an IIFE and exposed via window./global.
  // assignment (not as top-level declarations), so — unlike the rest of the
  // renderer's shared symbols — script-global sharing doesn't reach them and
  // they need an ambient declaration here. Callers use the bare name.
  function makeDropdown(opts?: DropdownOpts): DropdownApi; // customDropdown.js
  function normalizeName(n: string | null | undefined): string; // geoMatch.js
  function matchGeoItem(geoItems: any[], featProps: any): any; // geoMatch.js

  // PRE-EXISTING BUG (present in the original hub.js): called in the stpTestPerm
  // click handler but defined nowhere, so it throws at runtime. Declared here to
  // preserve that exact behavior through the migration; fix separately.
  function showPermissionPanel(): void;
}

// NOTE: hub-INTERNAL symbols (execBtn, entries, buildChart, makeDropdown, the
// cm* menu refs, exec* state, the per-file render helpers, …) are intentionally
// NOT declared here. The renderer is a set of classic global-scope <script>s in
// one shared scope, so TypeScript already shares every top-level const/let/
// function across the sibling files in this program — declaring them here too
// would just double-declare them (TS2451). Only genuinely EXTERNAL globals
// belong above: the preload bridge (window.hub), vendor UMD libs loaded via
// <script> (Chart/L/pdfMake/…), and the baked geo payloads.
