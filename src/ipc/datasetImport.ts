import { ipcMain } from './bus';
import * as path from 'path';
import { parsePaste } from '../data/parse';
import type { ParseResult } from '../data/parse';
import { sourceKindFor, storedKind, type FileSourceKind } from '../data/fileImport';
import { parseAnyFile } from '../data/parquetImport';
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

/** Parse one picked file as a job; resolves with the parse, rejects on error or cancel. */
export function parseAsJob(
  filePath: string,
  kind: FileSourceKind,
  sheetName?: string,
  name: string = path.basename(filePath),
): Promise<ParseResult> {
  const job = jobs.submit<ParseResult>({
    kind: 'import',
    label: `Read ${name}`,
    // Parquet is read by DuckDB itself (async, in the caller's org worker on the
    // server), not by a compute worker's tokenizer.
    run: (ctx) => kind !== 'parquet' && computePool.available()
      ? computePool.run<ParseResult>('parse', { filePath, kind, sheetName }, { onProgress: ctx.progress, signal: ctx.signal })
      : parseAnyFile(filePath, kind, sheetName),
    resultOf: (r) => ({ message: `${r.rowCount.toLocaleString('en-US')} rows × ${r.columns.length} columns` }),
  });
  return job.done;
}

export function register(): void {
  // Parse an uploaded file WITHOUT saving: it arrives through POST /api/files as
  // { fileToken } (src/server/files.ts). The token is single use and its file is
  // deleted after the parse, so a sheet switch uploads again; the server's temp
  // path never goes back to the browser.
  ipcMain.handle('dataset:pickAndParse', async (_e, { sheetName, fileToken }: any = {}) => {
    let upload: Upload | null = null;
    try {
      upload = resolveUpload(fileToken);
      const chosenPath = upload.path;

      // An upload's own path is `upload-<hex>`: its kind comes from the client's name.
      const fileName = upload.name;
      const ext = path.extname(fileName).toLowerCase();
      const kind = sourceKindFor(ext);
      if (!kind) return { ok: false, error: `Unsupported file type: ${ext || '(none)'}` };

      const parsed = await parseAsJob(chosenPath, kind, typeof sheetName === 'string' ? sheetName : undefined, fileName);
      return {
        ok: true,
        fileName,
        sourceKind: storedKind(kind),
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
      const parsed = parsePaste(text);
      // On the server pasted rows are STAGED like a file's, so the composer's
      // preview and save never send them back over HTTP (the desktop renderer
      // keeps sending its inline rows, as before).
      return { ok: true, preview: serverDataDir() !== null ? importStage.previewOf(parsed, importStage.put(parsed)) : parsed };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to parse the pasted text' };
    }
  });
}
