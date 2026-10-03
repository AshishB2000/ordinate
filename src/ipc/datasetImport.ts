import { ipcMain } from './bus';
import * as path from 'path';
import { parsePaste } from '../data/parse';
import type { ParseResult } from '../data/parse';
import { parseFile, sourceKindFor } from '../data/fileImport';
import * as importStage from '../data/importStage';
import * as jobs from '../app/jobs';
import * as computePool from '../engine/computePool';
import { serverDataDir } from '../server/context';
import { resolveUpload, type Upload } from '../server/files';

// Import IPC — pick a data file and parse it, or parse pasted text. Split out
// of ./datasets.ts at its 800-line cap. MAIN PROCESS.
//
// A picked file is parsed as a JOB (src/app/jobs.ts): in a compute worker
// (src/engine/computeWorker.ts, op `parse`), so a 1M-row CSV no longer parks
// the main thread for the second its tokenizer takes, with a Jobs-popover row
// and Cancel. The parsed table is then STAGED in main (src/data/importStage)
// and the renderer receives a display slice plus a `stagedId`: the composer's
// preview and Save resolve that id here, so the rows never cross IPC at all.

// Paths main handed out from the native open dialog. The re-parse (sheet-switch)
// branch of dataset:pickAndParse accepts a renderer-supplied filePath ONLY if it
// is in this set — otherwise a compromised/injected renderer could pass any
// absolute path (e.g. userData/config.json) and read back its contents, exfil-
// trating stored API keys / connection secrets. Bounds the read to files the
// user explicitly picked this session.
const pickedPaths = new Set<string>();

/** Parse one picked file as a job; resolves with the parse, rejects on error or cancel. */
export function parseAsJob(
  filePath: string,
  kind: 'csv' | 'json' | 'xlsx',
  sheetName?: string,
  name: string = path.basename(filePath),
): Promise<ParseResult> {
  const job = jobs.submit<ParseResult>({
    kind: 'import',
    label: `Read ${name}`,
    run: (ctx) => computePool.available()
      ? computePool.run<ParseResult>('parse', { filePath, kind, sheetName }, { onProgress: ctx.progress, signal: ctx.signal })
      : parseFile(filePath, kind, sheetName),
    resultOf: (r) => ({ message: `${r.rowCount.toLocaleString('en-US')} rows × ${r.columns.length} columns` }),
  });
  return job.done;
}

export function register(): void {
  // Open the native file picker (or, when given { filePath } from a prior pick,
  // skip the dialog and re-parse that file with a chosen sheetName). Returns the
  // parsed preview WITHOUT saving.
  // ponytail: dual behavior (dialog vs re-parse) keeps sheet switching stateless
  // — the renderer passes back the filePath it already received, no re-picking.
  //
  // On the server there is neither: the file was uploaded through POST
  // /api/files and arrives as { fileToken } (src/server/files.ts). The token is
  // single use and its file is deleted after the parse, so a sheet switch there
  // uploads again; the server's temp path never goes back to the browser.
  ipcMain.handle('dataset:pickAndParse', async (_e, { sheetName, filePath, fileToken }: any = {}) => {
    let upload: Upload | null = null;
    try {
      let chosenPath: string;
      if (serverDataDir() !== null) {
        upload = resolveUpload(fileToken);
        chosenPath = upload.path;
      } else if (typeof filePath === 'string' && filePath) {
        // Re-parse an already-picked file (e.g. sheet switch). Only honor a path
        // main previously returned from the dialog — never an arbitrary path.
        if (!pickedPaths.has(filePath)) return { ok: false, error: 'File was not picked in this session' };
        chosenPath = filePath;
      } else {
        // Lazy: the server loads this module without Electron (native dialogs are desktop-only).
        const { canceled, filePaths } = await (require('electron') as typeof import('electron')).dialog.showOpenDialog({
          title: 'Import data file',
          properties: ['openFile'],
          filters: [
            { name: 'Data files', extensions: ['csv', 'json', 'xlsx'] },
            { name: 'CSV', extensions: ['csv'] },
            { name: 'JSON', extensions: ['json'] },
            { name: 'Excel', extensions: ['xlsx'] },
          ],
        });
        if (canceled || !filePaths?.length) return { ok: true, canceled: true };
        chosenPath = filePaths[0];
        pickedPaths.add(chosenPath); // allow later sheet-switch re-parses of this file
      }

      // An upload's own path is `upload-<hex>`: its kind comes from the client's name.
      const fileName = upload ? upload.name : path.basename(chosenPath);
      const ext = path.extname(fileName).toLowerCase();
      const kind = sourceKindFor(ext);
      if (!kind) return { ok: false, error: `Unsupported file type: ${ext || '(none)'}` };

      const parsed = await parseAsJob(chosenPath, kind, typeof sheetName === 'string' ? sheetName : undefined, fileName);
      return {
        ok: true,
        ...(upload ? {} : { filePath: chosenPath }),
        fileName,
        sourceKind: kind,
        preview: importStage.previewOf(parsed, importStage.put(parsed)),
      };
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled || (err && err.name === 'JobCancelled')) return { ok: true, canceled: true };
      return { ok: false, error: err?.message || 'Failed to read or parse the file' };
    } finally {
      upload?.done();
    }
  });

  // Parse pasted text (JSON / CSV / TSV auto-detect). Returns preview, no disk
  // write. Non-string/empty text yields a warning-bearing empty result.
  // ponytail: untrusted renderer payload — any.
  ipcMain.handle('dataset:parsePaste', async (_e, { text }: any = {}) => {
    try {
      if (typeof text !== 'string' || text.trim() === '') {
        return { ok: true, preview: { columns: [], rows: [], rowCount: 0, warnings: ['Empty file'] } };
      }
      return { ok: true, preview: parsePaste(text) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to parse the pasted text' };
    }
  });
}
