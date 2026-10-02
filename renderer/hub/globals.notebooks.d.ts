// Additive globals for the notebook scripts (nbList/nbPage/nbCells/nbEditor/
// nbRun/nbActions.ts) — kept apart from the shared globals.d.ts, the same
// arrangement as globals.input.d.ts, so concurrent branches do not collide on
// it. Classic-script functions need no declaration here; only the preload
// bridge and the shapes the scripts share do.

// preload/hubNotebooksPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubNotebooks: {
    list(projectId: string): Promise<any>;
    get(projectId: string, id: string): Promise<any>;
    create(projectId: string, name: string): Promise<any>;
    save(projectId: string, id: string, name: string, cells: any[]): Promise<any>;
    remove(projectId: string, id: string): Promise<any>;
    run(projectId: string, id: string, cellId: string, runId: string): Promise<any>;
    cancel(runId: string): Promise<any>;
    prepareSave(projectId: string, id: string, cellId: string): Promise<any>;
    pinVisual(projectId: string, id: string, cellId: string): Promise<any>;
    exportMarkdown(projectId: string, id: string, charts: Record<string, string>): Promise<any>;
  };
}

/** A cell as the page edits it — src/analysis/notebook/model.ts NbCell. */
interface NbCellDoc {
  id: string;
  kind: 'sql' | 'formula' | 'chart' | 'markdown' | 'param';
  title?: string;
  sql?: string;
  expression?: string;
  column?: string;
  sourceCellId?: string;
  chartType?: string;
  encoding?: any;
  text?: string;
  name?: string;
  type?: 'number' | 'text' | 'date';
  value?: number | string | null;
}

/** src/analysis/notebook/graph.ts CellInfo. */
interface NbCellInfo {
  id: string;
  kind: string;
  position: number;
  view: string | null;
  deps: string[];
  sig: string;
  error: string | null;
}

/** src/analysis/notebook/run.ts RunReply, plus the page's own run state. */
interface NbResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  columns?: Array<{ name: string; type: string }>;
  rows?: any[][];
  rowCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
  cached?: boolean;
  sig?: string;
  chart?: { chartType: string; data: any; warnings: string[] };
  warnings?: string[];
  /** The page's run counter when this result landed — the gutter's [n]. */
  exec?: number;
}
