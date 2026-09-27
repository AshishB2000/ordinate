// Additive globals for the Find-segments scripts (segments.ts, segmentsView.ts,
// segmentsRfm.ts) — kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it. What needs a line here is what the page GETS
// from outside the shared program: the preload bridge.

// The Find-segments bridge (preload/hubSegmentsPreload.ts).
// ponytail: IPC envelopes typed loosely, as window.hub is
interface Window {
  hubSegments: {
    features(projectId: string, datasetId: string): Promise<any>;
    fit(projectId: string, datasetId: string, features: string[]): Promise<any>;
    saveColumn(projectId: string, datasetId: string, step: any): Promise<any>;
    rfm(projectId: string, datasetId: string, spec: any): Promise<any>;
    rfmSave(projectId: string, datasetId: string, spec: any): Promise<any>;
  };
}
