// `model:export` (semantic layer part 7, a1): the project's definitions as a zip of model files
// (src/app/modelExport.ts), handed back as a download token, as `projects:export` hands back a bundle.
// The zip is byte-identical while nothing changed: entries in path order, each stamped MODEL_ZIP_TIME.
// It stores nothing: the file sits in the org's temp() until it is sent (src/server/files.ts).
//
// `model:importPlan` (a2): the dry run of an uploaded zip (src/app/modelRead.ts, src/app/modelPlan.ts). It writes
// nothing and keeps nothing: the upload is deleted before the reply, so the apply uploads it again (any pod).
//
// `model:importApply` (a3): the same zip again, planned again and applied if its hash is the dry run's
// (src/app/modelApply.ts). Before the first write it offers the model as it was, as a download.
//
// Both take dbt's semantic manifest too (f1): an upload whose content opens a JSON object is read as one
// (src/app/dbtRead.ts) and translated (src/app/dbtImport.ts) over `datasetMap`, then planned and applied the same way.

import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import { writeZipAsync } from '../app/bundle';
import { exportModel, ModelExportRefused, type ModelCounts, type NotCarried } from '../app/modelExport';
import { MODEL_ZIP_TIME, modelJson, type ModelFiles } from '../app/modelFormat';
import { FileTokenError, offerDownload, resolveUpload, type Upload } from '../server/files';
import { readModelZip, type ModelRead, type ParsedModel } from '../app/modelRead';
import { looksLikeJson, readDbtUpload } from '../app/dbtRead';
import { dbtModel } from '../app/dbtPlan';
import { applyImport, type ApplyChoice, type ApplyReply } from '../app/modelApply';
import { planImport, type ImportPlan } from '../app/modelPlan';
import { modelUploadExpired } from '../app/modelFileMessages';
import { modelRefusal } from '../app/modelAccess';

export type ModelPlanReply = { ok: true; plan: ImportPlan } | { ok: false; error: string };
export type ModelApplyReply = ApplyReply | { ok: false; error: string };

export type ModelExportReply = { ok: true; downloadToken: string; counts: ModelCounts; notCarried: NotCarried[] } | { ok: false; error: string };

/** Every object's `base` left out: with none, an import compares nothing three-way and every difference is an update. */
function withoutBases(files: ModelFiles): ModelFiles {
  const drop = (o: Record<string, unknown>) => { const { base: _b, ...rest } = o; return rest; };
  return new Map([...files].map(([p, text]): [string, string] => {
    if (!p.endsWith('.json') || p === 'model.json') return [p, text];
    const o = JSON.parse(text) as Record<string, unknown>;
    return [p, modelJson(p === 'relationships.json' ? { relationships: (o.relationships as Record<string, unknown>[]).map(drop) } : drop(o))];
  }));
}

/**
 * The zip's bytes and its download name. Refuses a restricted caller (ModelExportRefused). `asWas`: the model as it was
 * before an import, without bases, so importing it overwrites what the import changed (a base would read "newer here").
 */
export async function modelZip(projectId: string, asWas = false): Promise<{ bytes: Buffer; name: string; counts: ModelCounts; notCarried: NotCarried[] }> {
  const exp = await exportModel(projectId);
  const files = asWas ? withoutBases(exp.files) : exp.files;
  const entries = [...files.keys()].sort().map((name) => ({ name, data: Buffer.from(files.get(name) as string, 'utf8') }));
  const project = await projects.getProject(projectId);
  const safe = (project?.name ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';
  return { bytes: await writeZipAsync(entries, MODEL_ZIP_TIME), name: `${safe}-model${asWas ? '-before-import' : ''}.zip`, counts: exp.counts, notCarried: exp.notCarried };
}

/** The zip in the org's temp, offered as a download (`model:export`, and an import's "the model as it was"). Refuses as `modelZip` does. */
export async function offerModelZip(projectId: string, asWas = false): Promise<{ downloadToken: string; counts: ModelCounts; notCarried: NotCarried[] }> {
  const zip = await modelZip(projectId, asWas);
  const target = path.join(appPaths.temp(), `model-${randomUUID()}.zip`);
  try {
    await recordFs.writeFile(target + '.partial', zip.bytes);
    await recordFs.rename(target + '.partial', target);
    const { downloadToken } = await offerDownload(target, zip.name, createHash('sha256').update(zip.bytes).digest('hex'));
    return { downloadToken, counts: zip.counts, notCarried: zip.notCarried };
  } catch (err) {
    for (const f of [target + '.partial', target]) await recordFs.rm(f, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** An import's "the model as it was", offered before its first write (the catalog and relationships keep no versions). */
export async function beforeImportZip(projectId: string): Promise<string> {
  return (await offerModelZip(projectId, true)).downloadToken;
}

/**
 * One run over an uploaded model zip: a caller row access rules restrict is refused before the upload is read (D7), a
 * spent token is said in a sentence, and the upload is deleted before the reply, whatever happens (any pod).
 */
/** A model zip, or a dbt semantic manifest translated over this project's datasets: told by its content, never its name. */
async function readUpload(projectId: string, file: string, datasetMap: unknown): Promise<ModelRead> {
  if (!(await looksLikeJson(file))) return readModelZip(file);
  const read = await readDbtUpload(file);
  if ('error' in read) return { refused: read.error };
  return dbtModel(projectId, read.json, (datasetMap && typeof datasetMap === 'object' ? datasetMap : {}) as Record<string, string>);
}

async function withModelUpload<T>(projectId: unknown, fileToken: unknown, datasetMap: unknown, run: (projectId: string, read: ParsedModel) => Promise<T>): Promise<T | { ok: false; error: string }> {
  const p = typeof projectId === 'string' ? projectId : '';
  const refusal = await modelRefusal(p);
  if (refusal) return { ok: false, error: refusal };
  let upload: Upload;
  try {
    upload = await resolveUpload(fileToken);
  } catch (err) {
    if (err instanceof FileTokenError) return { ok: false, error: modelUploadExpired() };
    throw err;
  }
  try {
    const read = await readUpload(p, upload.path, datasetMap);
    if ('refused' in read) return { ok: false, error: read.refused };
    return await run(p, read);
  } catch (err) {
    if (err instanceof ModelExportRefused) return { ok: false, error: err.message };
    throw err; // the route answers 500 and logs it
  } finally {
    upload.done();
  }
}

export function register(): void {
  ipcMain.handle('model:export', async (_e, { projectId }: { projectId?: unknown } = {}): Promise<ModelExportReply> => {
    try {
      return { ok: true, ...(await offerModelZip(typeof projectId === 'string' ? projectId : '')) };
    } catch (err) {
      if (err instanceof ModelExportRefused) return { ok: false, error: err.message };
      throw err; // the route answers 500 and logs it: an unknown failure's text is not for a browser
    }
  });

  ipcMain.handle('model:importPlan', async (_e, { projectId, fileToken, datasetMap }: { projectId?: unknown; fileToken?: unknown; datasetMap?: unknown } = {}): Promise<ModelPlanReply> =>
    withModelUpload(projectId, fileToken, datasetMap, async (p, read) => ({ ok: true as const, plan: await planImport(p, read) })));

  ipcMain.handle('model:importApply', async (_e, { projectId, fileToken, planHash, choices, datasetMap }: { projectId?: unknown; fileToken?: unknown; planHash?: unknown; choices?: unknown; datasetMap?: unknown } = {}): Promise<ModelApplyReply> =>
    withModelUpload(projectId, fileToken, datasetMap, (p, read) => applyImport(p, read, typeof planHash === 'string' ? planHash : '', (choices && typeof choices === 'object' ? choices : {}) as Record<string, ApplyChoice>, { before: () => beforeImportZip(p) })));
}
