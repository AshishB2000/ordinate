// Drag and drop IPC — files dropped on the window, an image pasted on Home or
// Data, and the two drags OUT of the app (a chart as PNG, a dataset as CSV).
//
//   dnd:dropFiles       paths from REAL dropped File objects (the preload reads
//                       them with webUtils.getPathForFile; the page never names a
//                       path) → src/app/dropImport.ts sniffs and routes each one
//   dnd:pasteImage      main reads the clipboard ITSELF and starts a capture from
//                       it — exactly the capture flow, including its not-ready gate
//   dnd:dragOutChart    a Chart.js PNG → temp file → webContents.startDrag
//   dnd:dragOutDataset  a dataset's current (prepared) table → CSV → startDrag
//
// startDrag has to answer the renderer's `dragstart`, so the two drag-outs are
// `send`, not `invoke`, and call `event.sender.startDrag` as soon as the file is
// written. Temp files live under <temp>/ordinate-drag/, cleared at launch.

import * as path from 'path';
import { clipboard, nativeImage } from 'electron';
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import type { IpcMainEvent, NativeImage } from 'electron';
import * as datasets from '../data/datasets';
import * as execConfig from '../app/execConfig';
import * as sharePolicy from '../app/sharePolicy';
import { handleDrop, MAX_DROP_FILES } from '../app/dropImport';
import { clearDragDir, csvOf, pngFromDataUrl, writeDragFile } from '../app/dragOut';
import { importBundleFile } from './projects';

export interface DragDropDeps {
  /** main.ts's capture pipeline: store, analyze, record, tell the hub. */
  ingestCapture: (dataUrl: string) => void;
  /** What a capture does without a model: open Settings → Execution. */
  openExecutionSettings: () => void;
  /** A bundle import makes its new project the active one. */
  onActive: (id: string) => void;
  headless?: boolean;
}

const MAX_PNG_BYTES = 40 * 1024 * 1024;
const MAX_PASTE_SIDE = 10_000;

export function dragDir(): string {
  return path.join(appPaths.temp(), 'ordinate-drag');
}

/** The image the OS shows under the pointer. Never empty — macOS refuses an empty icon. */
function dragIcon(img?: NativeImage): NativeImage {
  if (img && !img.isEmpty()) return img.resize({ width: 96 });
  return nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png')).resize({ width: 64 });
}

function startDrag(e: IpcMainEvent, file: string, icon: NativeImage): void {
  if (e.sender.isDestroyed()) return;
  e.sender.startDrag({ file, icon });
}

export function register(deps: DragDropDeps): void {
  if (!deps.headless) clearDragDir(dragDir());

  // ponytail: untrusted renderer payloads — any, validated field by field.
  ipcMain.handle('dnd:dropFiles', async (_e, { projectId, paths }: any = {}) => {
    const list = Array.isArray(paths) ? paths.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.includes('\0')) : [];
    if (!list.length) return { ok: false, error: 'Nothing that was dropped is a file.' };
    const results = await handleDrop(typeof projectId === 'string' && projectId ? projectId : null, list.slice(0, MAX_DROP_FILES),
      (file) => importBundleFile(file, (id) => { if (typeof id === 'string') deps.onActive(id); }));
    const skipped = list.length - Math.min(list.length, MAX_DROP_FILES);
    return { ok: true, results, skipped };
  });

  ipcMain.handle('dnd:pasteImage', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false, error: 'The clipboard has no image to capture.' };
    const { width, height } = img.getSize();
    if (width > MAX_PASTE_SIDE || height > MAX_PASTE_SIDE) return { ok: false, error: 'That image is too large to capture.' };
    if (!execConfig.executionReady()) {
      deps.openExecutionSettings();
      return { ok: true, notReady: true };
    }
    deps.ingestCapture(img.toDataURL());
    return { ok: true };
  });

  const dragOutChart = async (e: IpcMainEvent, { name, dataUrl }: any = {}): Promise<void> => {
    try {
      const png = pngFromDataUrl(dataUrl, MAX_PNG_BYTES);
      if (!png) return;
      const file = await writeDragFile(dragDir(), name, 'png', png);
      startDrag(e, file, dragIcon(nativeImage.createFromBuffer(png)));
    } catch (err: any) {
      console.error('[dnd] chart drag-out failed:', err?.message || err);
    }
  };
  ipcMain.on('dnd:dragOutChart', (e, a) => { void dragOutChart(e, a); });

  // ponytail: the CSV is written before the OS drag starts, so a very large
  // dataset (hundreds of MB) may miss a quick drag; pre-writing on hover would fix it.
  const dragOutDataset = async (e: IpcMainEvent, { projectId, datasetId }: any = {}): Promise<void> => {
    try {
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return;
      // A CSV dragged out LEAVES the app, so the project's Share policy for
      // exports masks or drops its marked columns first — as the CLI export does.
      const t = await sharePolicy.applyToTable(projectId, datasetId, { columns: ds.columns, rows: ds.rows }, 'export');
      const csv = csvOf(t.columns.map((c) => String(c.name)), t.rows);
      const file = await writeDragFile(dragDir(), ds.name, 'csv', csv);
      startDrag(e, file, dragIcon());
    } catch (err: any) {
      console.error('[dnd] dataset drag-out failed:', err?.message || err);
    }
  };
  ipcMain.on('dnd:dragOutDataset', (e, a) => { void dragOutDataset(e, a); });
}
