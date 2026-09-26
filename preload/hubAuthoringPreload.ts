import { contextBridge, ipcRenderer } from 'electron';

// The hub's authoring bridge — the project data model, image cards and custom
// map boundaries — split out of hubPreload.ts at its 800-line cap.
//
// A sandboxed preload cannot require a sibling file, so this is a second
// preload the SESSION runs in every frame (windows/hubWindow.ts registers it).
// That is why it checks where it is: the overlay and the offscreen export
// windows share the session, and they get nothing from here.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  // ponytail: IPC payloads/results are JSON envelopes owned by main + renderer, as in hubPreload.ts
  contextBridge.exposeInMainWorld('hubAuthoring', {
    // Relationships (src/ipc/relationships.ts).
    listRelationships: (projectId: string) => ipcRenderer.invoke('relationship:list', { projectId }),
    saveRelationship: (projectId: string, relationship: any) =>
      ipcRenderer.invoke('relationship:save', { projectId, relationship }),
    deleteRelationship: (projectId: string, id: string) => ipcRenderer.invoke('relationship:delete', { projectId, id }),
    suggestRelationshipKeys: (projectId: string, fromId: string, toId: string) =>
      ipcRenderer.invoke('relationship:suggest', { projectId, fromId, toId }),
    relatedColumns: (projectId: string, datasetId: string) =>
      ipcRenderer.invoke('relationship:related', { projectId, datasetId }),
    // Image cards: pick into the project, read back as a data: URL (src/ipc/projectAssets.ts).
    pickProjectImage: (projectId: string) => ipcRenderer.invoke('asset:pickImage', { projectId }),
    readProjectImage: (projectId: string, id: string, ext: string) => ipcRenderer.invoke('asset:read', { projectId, id, ext }),
    // Custom map boundaries (src/ipc/projectBoundaries.ts).
    importBoundaries: (projectId: string) => ipcRenderer.invoke('boundary:import', { projectId }),
    listBoundaries: (projectId: string) => ipcRenderer.invoke('boundary:list', { projectId }),
    getBoundary: (projectId: string, id: string, property?: string) => ipcRenderer.invoke('boundary:get', { projectId, id, property }),
  });
}
