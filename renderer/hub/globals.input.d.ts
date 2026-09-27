// Additive globals for the input-table scripts (inputBind/inputColumns/
// inputGrid/inputKeys/inputPage.ts) — kept apart from the shared globals.d.ts,
// the same arrangement as globals.snapshots.d.ts, so concurrent branches do
// not collide on it. Classic-script functions need no declaration here; only
// the preload bridge and the bound shared module do.

// preload/hubInputPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubInput: {
    create(projectId: string, name: string, columns: any[]): Promise<any>;
    load(projectId: string, id: string): Promise<any>;
    validate(projectId: string, id: string, rows: any[]): Promise<any>;
    save(projectId: string, id: string, batches: any[]): Promise<any>;
    setColumns(projectId: string, id: string, columns: any[], from: number[]): Promise<any>;
  };
}

type ItCell = string | number | null;
interface ItRange { r0: number; c0: number; r1: number; c1: number }
interface ItBatch { label: string; ops: any[] }
interface ItHistEntry { label: string; forward: ItBatch; inverse: ItBatch }
interface ItHistory { past: ItHistEntry[]; future: ItHistEntry[] }

// src/data/inputTable/edits.ts, bound by inputBind.ts.
interface OrdInputEditsApi {
  MAX_CELL_TEXT: number;
  UNDO_CAP: number;
  applyBatch(rows: ItCell[][], batch: ItBatch, width: number, cap: number): { rows: ItCell[][]; inverse: ItBatch } | null;
  histNew(): ItHistory;
  histPush(h: ItHistory, e: ItHistEntry): void;
  histUndo(h: ItHistory): ItHistEntry | null;
  histRedo(h: ItHistory): ItHistEntry | null;
  histLabels(h: ItHistory | null): { undo: string | null; redo: string | null };
  parseTsv(text: string): string[][];
  toTsv(block: ItCell[][]): string;
  editBatch(rows: ItCell[][], r: number, c: number, raw: string, column: string, cap: number): ItBatch | null;
  pasteBatch(text: string, sel: ItRange, rowCount: number, width: number, cap: number): { batch: ItBatch; range: ItRange; clipped: number } | null;
  fillDownBatch(rows: ItCell[][], sel: ItRange): ItBatch | null;
  clearBatch(rows: ItCell[][], sel: ItRange): ItBatch | null;
  insertRowsBatch(at: number, n: number, rowCount: number, cap: number): ItBatch | null;
  deleteRowsBatch(r0: number, r1: number, rowCount: number): ItBatch | null;
}
