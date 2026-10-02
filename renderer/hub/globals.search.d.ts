// Additive globals for search inside the data (dataSearch.ts) — kept apart from
// the shared globals.d.ts so concurrent branches do not collide on it.

// preload/hubSearchPreload.ts — mirrors the contextBridge surface 1:1.
// ponytail: the reply is the JSON envelope src/data/dataSearchRun.ts documents, typed loosely as window.hub is
interface Window {
  hubDataSearch: {
    query(projectId: string, term: string, dashboardId?: string): Promise<any>;
  };
}
