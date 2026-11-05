// `model:export` (semantic layer part 7, a1): the project's definitions as a zip of model files
// (src/app/modelExport.ts), handed back as a download token, as `projects:export` hands back a bundle.
// The zip is byte-identical while nothing changed: entries in path order, each stamped MODEL_ZIP_TIME.
// It stores nothing: the file sits in the org's temp() until it is sent (src/server/files.ts).
//
// `model:importPlan` (a2): the dry run of an uploaded zip (src/app/modelRead.ts, src/app/modelPlan.ts). It writes
// nothing and keeps nothing: the upload is deleted before the reply, so the apply uploads it again (any pod).

import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import { writeZipAsync } from '../app/bundle';
import { exportModel, ModelExportRefused, type ModelCounts, type NotCarried } from '../app/modelExport';
import { MODEL_ZIP_TIME } from '../app/modelFormat';
import { FileTokenError, offerDownload, resolveUpload, type Upload } from '../server/files';
import { readModelZip } from '../app/modelRead';
import { planImport, type ImportPlan } from '../app/modelPlan';
import { modelRestricted, modelUploadExpired } from '../app/modelFileMessages';
import { restrictedOn } from '../data/rowAccess';

export type ModelPlanReply = { ok: true; plan: ImportPlan } | { ok: false; error: string };

export type ModelExportReply = { ok: true; downloadToken: string; counts: ModelCounts; notCarried: NotCarried[] } | { ok: false; error: string };

/** The zip's bytes and its download name. Refuses a restricted caller (ModelExportRefused). */
export async function modelZip(projectId: string): Promise<{ bytes: Buffer; name: string; counts: ModelCounts; notCarried: NotCarried[] }> {
  const { files, counts, notCarried } = await exportModel(projectId);
  const entries = [...files.keys()].sort().map((name) => ({ name, data: Buffer.from(files.get(name) as string, 'utf8') }));
  const project = await projects.getProject(projectId);
  const safe = (project?.name ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';
  return { bytes: await writeZipAsync(entries, MODEL_ZIP_TIME), name: `${safe}-model.zip`, counts, notCarried };
}

export function register(): void {
  ipcMain.handle('model:export', async (_e, { projectId }: { projectId?: unknown } = {}): Promise<ModelExportReply> => {
    let zip: Awaited<ReturnType<typeof modelZip>>;
    try {
      zip = await modelZip(typeof projectId === 'string' ? projectId : '');
    } catch (err) {
      if (err instanceof ModelExportRefused) return { ok: false, error: err.message };
      throw err; // the route answers 500 and logs it: an unknown failure's text is not for a browser
    }
    const target = path.join(appPaths.temp(), `model-${randomUUID()}.zip`);
    try {
      await recordFs.writeFile(target + '.partial', zip.bytes);
      await recordFs.rename(target + '.partial', target);
      const { downloadToken } = await offerDownload(target, zip.name, createHash('sha256').update(zip.bytes).digest('hex'));
      return { ok: true, downloadToken, counts: zip.counts, notCarried: zip.notCarried };
    } catch (err) {
      for (const f of [target + '.partial', target]) await recordFs.rm(f, { force: true }).catch(() => undefined);
      throw err;
    }
  });

  ipcMain.handle('model:importPlan', async (_e, { projectId, fileToken }: { projectId?: unknown; fileToken?: unknown } = {}): Promise<ModelPlanReply> => {
    const p = typeof projectId === 'string' ? projectId : '';
    if (await restrictedOn(p)) return { ok: false, error: modelRestricted() }; // before the upload is read (D7)
    let upload: Upload;
    try {
      upload = await resolveUpload(fileToken);
    } catch (err) {
      if (err instanceof FileTokenError) return { ok: false, error: modelUploadExpired() };
      throw err;
    }
    try {
      const read = await readModelZip(upload.path);
      if ('refused' in read) return { ok: false, error: read.refused };
      return { ok: true, plan: await planImport(p, read) };
    } catch (err) {
      if (err instanceof ModelExportRefused) return { ok: false, error: err.message };
      throw err; // the route answers 500 and logs it
    } finally {
      upload.done();
    }
  });
}
