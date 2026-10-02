import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The hub's drag-and-drop bridge, exposed as `window.hubDrop` (src/ipc/dragDrop.ts).
// A session preload (see src/windows/hubWindow.ts), so it checks where it is.
//
// `dropFiles` takes FILE OBJECTS, never strings: the path is read here with
// webUtils.getPathForFile, which only knows the path of a file the OS handed
// the page (a real drop, or an <input type=file> pick). A page script cannot
// make up a path for main to read — a File it constructs itself has none.
if (location.protocol === 'file:' && location.pathname.endsWith('/renderer/hub/index.html')) {
  contextBridge.exposeInMainWorld('hubDrop', {
    dropFiles: (files: File[], projectId: string | null) => {
      const paths = Array.from(files || []).map((f) => {
        try { return webUtils.getPathForFile(f); } catch (_) { return ''; }
      }).filter(Boolean);
      return ipcRenderer.invoke('dnd:dropFiles', { projectId, paths });
    },
    pasteImage: () => ipcRenderer.invoke('dnd:pasteImage'),
    dragOutChart: (name: string, dataUrl: string) => ipcRenderer.send('dnd:dragOutChart', { name, dataUrl }),
    dragOutDataset: (projectId: string, datasetId: string) => ipcRenderer.send('dnd:dragOutDataset', { projectId, datasetId }),
  });
}
