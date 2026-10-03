// Notebooks IPC — the Data page's Notebooks tab (renderer/hub/nb*.ts). MAIN.
//
// Every handler validates its ids before a path is built and answers
// `{ ok:true, … }` or `{ ok:false, error }` — a thrown error never reaches the
// renderer as a rejection. The work lives in src/analysis/notebook/: the store,
// the graph (view names, dependencies, staleness, cache keys), the runner and
// the Markdown export. This file only wires them to channels and to the jobs.
//
//   notebook:list / get / create / save / delete      the record
//   notebook:run      one cell, by id, from the notebook AS SAVED (the page
//                     saves first), with a renderer-chosen runId Cancel names.
//                     A run still going after PROMOTE_MS becomes a JOB — the
//                     Jobs popover shows it and can cancel it too.
//   notebook:cancel   stop a run by its runId
//   notebook:prepareSave   the whole result staged for the composer, with the
//                     `notebook` origin that re-runs it (sql:prepareSave's twin)
//   notebook:pinVisual     a chart cell → a dataset over its source cell (reused
//                     when already saved) + a visual with the cell's spec
//   notebook:exportMarkdown   the export, through the native save panel

import { dialog } from 'electron';
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import * as fs from 'fs';
import * as path from 'path';
import { isValidId } from '../app/ids';
import * as jobs from '../app/jobs';
import * as datasets from '../data/datasets';
import * as importStage from '../data/importStage';
import { refreshDataset } from '../data/datasetRefresh';
import { refreshDependents } from '../data/datasetDependents';
import * as visuals from '../analysis/visuals';
import { reportFilename } from '../analysis/reportSpec';
import * as sqlDatasets from '../engine/sqlDatasets';
import * as store from '../analysis/notebook/store';
import * as run from '../analysis/notebook/run';
import { notebookMarkdown } from '../analysis/notebook/exportMd';
import type { ExportResult } from '../analysis/notebook/exportMd';
import type { NbCell, Notebook } from '../analysis/notebook/model';
import { noteWrittenPath } from './jobs';

/** A cell still running after this long is promoted to a job. */
export const PROMOTE_MS = 800;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const live = new Map<string, { ctl: AbortController; jobId: string | null }>();

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

async function load(projectId: unknown, id: unknown): Promise<Notebook | null> {
  return isValidId(projectId) && isValidId(id) ? store.getNotebook(projectId, id) : null;
}

async function withGraph(projectId: string, nb: Notebook): Promise<{ ok: true; notebook: Notebook; graph: unknown }> {
  return { ok: true, notebook: nb, graph: await run.graphFor(projectId, nb) };
}

function cellLabel(nb: Notebook, cellId: string): string {
  const i = nb.cells.findIndex((c) => c.id === cellId);
  const c = nb.cells[i];
  return (c && c.title) || `cell ${i + 1}`;
}

/** The datasets saved from this cell — the ones a fresh run of it should refresh. */
async function savedFrom(projectId: string, notebookId: string, cellId: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const d of await datasets.listDatasets(projectId)) {
    if (d.originKind !== 'notebook') continue;
    const m = await datasets.getDatasetMeta(projectId, d.id);
    const o: any = m && m.origin;
    if (o && o.notebookId === notebookId && (cellId === null || o.cellId === cellId)) out.push(d.id);
  }
  return out;
}

/**
 * A cell that just produced a NEW result (not a cache hit) re-runs the
 * datasets saved from it, and they push to theirs: its inputs changed, so
 * they follow. Never throws; a failure lands on the dataset's refresh markers.
 */
async function refreshSaved(projectId: string, notebookId: string, cellId: string): Promise<void> {
  try {
    for (const id of await savedFrom(projectId, notebookId, cellId)) {
      const res = await refreshDataset(projectId, id);
      if (res.ok) await refreshDependents(projectId, id);
    }
  } catch (_) { /* recorded on the dataset by refreshDataset */ }
}

async function runOne(projectId: string, nb: Notebook, cellId: string, runId: string | null): Promise<run.RunReply> {
  const ctl = new AbortController();
  const entry = { ctl, jobId: null as string | null };
  if (runId) live.set(runId, entry);
  const work = run.runCell(projectId, nb, cellId, ctl.signal);
  const timer = setTimeout(() => {
    const job = jobs.submit({
      kind: 'compute',
      label: `Run ${cellLabel(nb, cellId)} · ${nb.name}`,
      projectId,
      silent: true,
      run: async (ctx) => {
        ctx.signal.addEventListener('abort', () => ctl.abort(), { once: true });
        ctx.progress(0.1, 'Running');
        const r = await work;
        if (!r.ok) throw r.cancelled ? new jobs.JobCancelled() : new Error(r.error);
        return r;
      },
      resultOf: (r) => ({ message: r.ok ? `${r.rowCount.toLocaleString('en-US')} rows` : undefined }),
    });
    entry.jobId = job.id;
  }, PROMOTE_MS);
  try {
    const res = await work;
    if (res.ok && !res.cached && res.kind !== 'chart') void refreshSaved(projectId, nb.id, cellId);
    return res;
  } finally {
    clearTimeout(timer);
    if (runId) live.delete(runId);
  }
}

export function register(): void {
  ipcMain.handle('notebook:list', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: true, notebooks: await store.listNotebooks(String(projectId || '')) };
    } catch (err: any) {
      return bad(err?.message || 'Could not read the notebooks.');
    }
  });

  ipcMain.handle('notebook:get', async (_e, { projectId, id }: any = {}) => {
    const nb = await load(projectId, id);
    return nb ? withGraph(projectId, nb) : bad('Notebook not found.');
  });

  ipcMain.handle('notebook:create', async (_e, { projectId, name, cells }: any = {}) => {
    try {
      if (!isValidId(projectId)) return bad('Invalid project id');
      const cat = cells === undefined ? await sqlDatasets.projectCatalog(projectId) : [];
      const first = cat.find((e) => e.queryable);
      const nb = await store.createNotebook(projectId, { name, cells, firstSlug: first ? first.slug : null });
      return nb ? withGraph(projectId, nb) : bad('Could not create the notebook.');
    } catch (err: any) {
      return bad(err?.message || 'Could not create the notebook.');
    }
  });

  ipcMain.handle('notebook:save', async (_e, { projectId, id, name, cells }: any = {}) => {
    try {
      if (!isValidId(projectId) || !isValidId(id)) return bad('Invalid id');
      const nb = await store.updateNotebook(projectId, id, { name, cells });
      return nb ? withGraph(projectId, nb) : bad('Notebook not found.');
    } catch (err: any) {
      return bad(err?.message || 'Could not save the notebook.');
    }
  });

  ipcMain.handle('notebook:delete', async (_e, { projectId, id }: any = {}) =>
    ({ ok: isValidId(projectId) && isValidId(id) ? await store.deleteNotebook(projectId, id) : false }));

  ipcMain.handle('notebook:run', async (_e, { projectId, id, cellId, runId }: any = {}) => {
    const nb = await load(projectId, id);
    if (!nb) return bad('Notebook not found.');
    if (!isValidId(cellId)) return bad('Invalid cell id');
    return runOne(projectId, nb, cellId, typeof runId === 'string' && RUN_ID_RE.test(runId) ? runId : null);
  });

  ipcMain.handle('notebook:cancel', (_e, { runId }: any = {}) => {
    const entry = typeof runId === 'string' ? live.get(runId) : undefined;
    if (!entry) return { ok: false };
    if (!(entry.jobId && jobs.cancel(entry.jobId))) entry.ctl.abort();
    return { ok: true };
  });

  ipcMain.handle('notebook:prepareSave', async (_e, { projectId, id, cellId }: any = {}) => {
    const nb = await load(projectId, id);
    if (!nb || !isValidId(cellId)) return bad('Notebook not found.');
    const job = jobs.submit({
      kind: 'sql-save',
      label: `Read ${cellLabel(nb, cellId)} · ${nb.name}`,
      projectId,
      run: async (ctx) => {
        ctx.progress(0.1, 'Running the cell');
        const res = await run.cellTable(projectId, nb, cellId, ctx.signal);
        if (!res.ok) throw res.cancelled ? new jobs.JobCancelled() : new Error(res.error);
        return res;
      },
      resultOf: (res) => ({ message: `${res.rows.length.toLocaleString('en-US')} rows ready to save` }),
    });
    try {
      const res = await job.done;
      const stagedId = importStage.put({ columns: res.columns, rows: res.rows, rowCount: res.rows.length, warnings: [] } as any);
      return {
        ok: true,
        columns: res.columns,
        rows: res.rows.slice(0, importStage.PREVIEW_ROWS),
        rowCount: res.rows.length,
        stagedId,
        origin: { kind: 'notebook', notebookId: nb.id, cellId, deps: res.deps },
        name: `${nb.name} · ${cellLabel(nb, cellId)}`,
      };
    } catch (err: any) {
      if (err && err.name === 'JobCancelled') return { ok: false, canceled: true, error: 'Cancelled.' };
      return bad(err?.message || 'The result could not be read.');
    }
  });

  ipcMain.handle('notebook:pinVisual', async (_e, { projectId, id, cellId }: any = {}) => {
    const nb = await load(projectId, id);
    const cell = nb && nb.cells.find((c) => c.id === cellId);
    if (!nb || !cell || cell.kind !== 'chart') return bad('That chart cell is no longer in the notebook.');
    const source = cell.sourceCellId;
    try {
      let datasetId = (await savedFrom(projectId, nb.id, source))[0] || null;
      const created = !datasetId;
      if (!datasetId) {
        const job = jobs.submit({
          kind: 'sql-save',
          label: `Save ${cellLabel(nb, source)} · ${nb.name}`,
          projectId,
          run: async (ctx) => {
            const t = await run.cellTable(projectId, nb, source, ctx.signal);
            if (!t.ok) throw new Error(t.error);
            ctx.progress(0.5, 'Saving');
            const ds = await datasets.saveDataset(projectId, {
              name: `${nb.name} · ${cellLabel(nb, source)}`,
              sourceKind: 'notebook',
              columns: t.columns,
              rows: t.rows,
              origin: { kind: 'notebook', notebookId: nb.id, cellId: source, deps: t.deps },
            });
            if (!ds) throw new Error('Could not save the chart\'s data.');
            return ds.id;
          },
        });
        datasetId = await job.done;
      }
      const v = await visuals.saveVisual(projectId, {
        name: cell.title || `${nb.name} chart`,
        datasetId: datasetId as string,
        chartType: cell.chartType,
        encoding: cell.encoding,
      });
      if (!v) return bad('Could not create the visual.');
      return { ok: true, visualId: v.id, datasetId, datasetCreated: created };
    } catch (err: any) {
      return bad(err?.message || 'Could not pin the chart.');
    }
  });

  ipcMain.handle('notebook:exportMarkdown', async (_e, { projectId, id, charts }: any = {}) => {
    const nb = await load(projectId, id);
    if (!nb) return bad('Notebook not found.');
    try {
      const results: Record<string, ExportResult | { error: string }> = {};
      for (const c of nb.cells as NbCell[]) {
        if (c.kind !== 'sql' && c.kind !== 'formula') continue;
        const r = await run.runCell(projectId, nb, c.id);
        results[c.id] = r.ok ? r : { error: r.error };
      }
      const pngs: Record<string, string> = {};
      if (charts && typeof charts === 'object') {
        for (const [k, v] of Object.entries(charts)) if (isValidId(k) && typeof v === 'string' && v.length < 8_000_000) pngs[k] = v;
      }
      const md = notebookMarkdown({ name: nb.name, cells: nb.cells, graph: await run.graphFor(projectId, nb), results, charts: pngs });
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export notebook as Markdown',
        defaultPath: path.join(appPaths.downloads(), reportFilename(nb.name, 'md')),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      await fs.promises.writeFile(filePath, md, 'utf8');
      noteWrittenPath(filePath);
      return { ok: true, dest: filePath };
    } catch (err: any) {
      return bad(err?.message || 'The export failed.');
    }
  });
}
