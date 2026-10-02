// Additive globals for drag and drop (round 10) — kept apart from the shared
// globals.d.ts so concurrent branches do not collide on it.

// preload/hubDropPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubDrop: {
    dropFiles(files: File[], projectId: string | null): Promise<any>;
    pasteImage(): Promise<any>;
    dragOutChart(name: string, dataUrl: string): void;
    dragOutDataset(projectId: string, datasetId: string): void;
  };
}
