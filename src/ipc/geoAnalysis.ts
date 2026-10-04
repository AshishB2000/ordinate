// Geospatial analysis IPC (depth round 6) — MAIN PROCESS. Registered from
// src/ipc/round6.ts under `// r6:geo`.
//
//   geo:resolvePlace     free text → the offline place it names, shown by the
//                        radius control BEFORE it filters ("Austin, TX")
//   geo:boundarySources  the boundary sets a spatial join can use: the bundled
//                        three and the project's own imported ones
//   geo:spatialPreview   what an unsaved spatial_join step would do to its
//                        real input — matched points, the busiest regions
//   geo:saveSpatialStep  add / replace the step as a JOB (point in polygon over
//                        every row is the one prepare edit worth a progress row)
//
// Every figure here is counted by the app; the renderer only prints it. The
// hexbin and flow MAPS answer through `visual:data` (./geoViz.ts), not here.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as jobs from '../app/jobs';
import { listBoundaries } from '../app/projectBoundaries';
import { isValidId } from '../app/ids';
import { resolvePlace } from '../analysis/places';
import { BUNDLED_BOUNDARIES, checkSpatialJoin, spatialStats } from '../analysis/geo/spatialJoin';
import { inputAt } from './preparePower';
import { commitSteps } from './datasets';
import { forClient } from './stepReply';

async function preview(projectId: string, datasetId: string, index: number, raw: unknown): Promise<unknown> {
  const step = checkSpatialJoin((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  if (typeof step === 'string') return { ok: false, error: step };
  const at = await inputAt(projectId, datasetId, index, step);
  if (!at) return { ok: false, error: 'Dataset not found' };
  const stats = spatialStats(at.input, step, at.ctx);
  if (typeof stats === 'string') return { ok: false, error: stats };
  // The meter's share (one decimal) and the "outside every region" count, so a browser only prints them.
  const pct = stats.total ? Math.round((stats.matched / stats.total) * 1000) / 10 : 0;
  return { ok: true, stats: { ...stats, pct, outside: stats.total - stats.matched - stats.noCoords } };
}

async function save(projectId: string, datasetId: string, index: number, raw: unknown): Promise<unknown> {
  const step = checkSpatialJoin((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  if (typeof step === 'string') return { ok: false, error: step };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const steps: unknown[] = Array.isArray(meta.steps) ? meta.steps.slice() : [];
  if (Number.isInteger(index) && index >= 0 && index < steps.length) steps[index] = step;
  else steps.push(step);
  const rows = typeof meta.rowCount === 'number' ? meta.rowCount : 0;
  const job = jobs.submit({
    kind: 'compute',
    label: `Assign regions — ${meta.name || 'dataset'}`,
    projectId,
    datasetId,
    cancellable: false,
    run: async (ctx) => {
      ctx.progress(0.05, `${rows.toLocaleString('en-US')} points`);
      const res = await commitSteps(projectId, datasetId, steps);
      if (!res.ok) throw new Error(res.error);
      ctx.progress(1);
      return res;
    },
    resultOf: () => ({ message: `${rows.toLocaleString('en-US')} points assigned to regions` }),
  });
  try {
    return await job.done;
  } catch (err: any) { // ponytail: any thrown value, reported by its message only
    return { ok: false, error: err?.message || 'Could not assign the regions' };
  }
}

// ponytail: IPC payloads are untrusted JSON envelopes (typed any, as in datasets.ts); every field is coerced before use.
export function register(): void {
  ipcMain.handle('geo:resolvePlace', async (_e, { text }: any = {}) => {
    const hit = resolvePlace(text);
    if (hit) return { ok: true, place: hit };
    const t = String(text == null ? '' : text).trim().slice(0, 80);
    return { ok: false, error: t ? `No place called "${t}" in the offline places table.` : 'Type a city, county or ZIP code.' };
  });

  ipcMain.handle('geo:boundarySources', async (_e, { projectId }: any = {}) => {
    const own = isValidId(projectId) ? await listBoundaries(projectId).catch(() => []) : [];
    return {
      ok: true,
      bundled: BUNDLED_BOUNDARIES,
      custom: own.map((b) => ({ id: b.id, name: b.name, featureCount: b.featureCount, properties: b.properties })),
    };
  });

  ipcMain.handle('geo:spatialPreview', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      return await preview(String(projectId || ''), String(datasetId || ''), Number(index), step);
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not preview the step' };
    }
  });

  ipcMain.handle('geo:saveSpatialStep', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      return forClient(await save(String(projectId || ''), String(datasetId || ''), Number(index), step));
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not assign the regions' };
    }
  });
}
