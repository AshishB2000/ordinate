// Additive globals for the geospatial-analysis scripts (depth round 6), kept
// apart from the shared globals.d.ts so concurrent branches do not collide on
// it. A classic script's own top-level functions are visible to the others
// through the shared program; what needs a line here is what the page GETS
// from outside it — the preload bridge.

// The geo bridge (preload/hubGeoPreload.ts → src/ipc/geoAnalysis.ts).
// ponytail: IPC envelopes typed loosely, as window.hub is
interface Window {
  hubGeo: {
    /** Free text → { ok, place: { label, lat, lng, level } } or { ok: false, error }. */
    resolvePlace(text: string): Promise<any>;
    /** { ok, bundled: [{ id, label }], custom: [{ id, name, featureCount, properties }] }. */
    boundarySources(projectId: string): Promise<any>;
    /** { ok, stats: { total, matched, noCoords, regions, top } } for an unsaved spatial_join step. */
    spatialPreview(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
    /** Add (index < 0) or replace the step, as a job; the dataset:addStep reply. */
    saveSpatialStep(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
  };
}
