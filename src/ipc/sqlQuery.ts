// The Data page's Query tab — SQL over the project's own datasets. MAIN PROCESS.
//
// Four request/response channels, all thin: the work, the read-only gate and
// the engine lock live in src/engine/sqlDatasets.ts. Every handler validates
// the project id there before a path or a statement is built, and every reply
// is `{ok:true,…}` or `{ok:false,error}` — a thrown error never reaches the
// renderer as a rejection.
//
//   sql:schema       the project's datasets, their exposed names and columns
//   sql:run          a bounded preview (PREVIEW_ROWS)
//   sql:explain      validate: the columns and types it WOULD return, no rows
//   sql:prepareSave  the whole result at the dataset cap, plus the `sql` origin
//                    that re-runs it — handed to the ordinary composer save
//   sql:datasetQuery a SQL dataset's own statement ("View query", server only)

import { ipcMain } from './bus';
import { isValidId } from '../app/ids';
import { viewColumns } from '../engine/datasetView';
import * as sqlDatasets from '../engine/sqlDatasets';
import * as importStage from '../data/importStage';
import * as datasets from '../data/datasets';
import * as jobs from '../app/jobs';

export async function schemaFor(projectId: unknown) {
  if (!isValidId(projectId)) return { ok: false, error: 'Invalid project id' };
  const cat = await sqlDatasets.projectCatalog(projectId);
  return {
    ok: true,
    datasets: cat.map((e) => ({
      id: e.id,
      name: e.name,
      alias: e.alias,
      slug: e.slug,
      rowCount: e.rowCount,
      queryable: e.queryable,
      // The names SQL actually sees — de-duplicated exactly as the CTE body is.
      columns: viewColumns(e.columns).map((c) => ({ name: c.name, type: c.type })),
    })),
  };
}

/** "View query": a SQL dataset's statement and parameters — origin kind `sql` only (nothing outside the project). */
export async function datasetQuery(projectId: unknown, datasetId: unknown) {
  if (!isValidId(projectId) || !isValidId(datasetId)) return { ok: false, error: 'Invalid id' };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const o = meta && meta.origin;
  if (!o || o.kind !== 'sql') return { ok: false, error: 'This dataset was not made by a query.' };
  return { ok: true, sql: o.sql, params: o.params ?? [] };
}

export function register(): void {
  ipcMain.handle('sql:datasetQuery', async (_e, { projectId, datasetId }: any = {}) => datasetQuery(projectId, datasetId));

  ipcMain.handle('sql:schema', async (_e, { projectId }: any = {}) => {
    try {
      return await schemaFor(projectId);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the datasets' };
    }
  });

  ipcMain.handle('sql:run', async (_e, { projectId, sql, params }: any = {}) =>
    sqlDatasets.runSql(projectId, sql, params, sqlDatasets.PREVIEW_ROWS));

  ipcMain.handle('sql:explain', async (_e, { projectId, sql, params }: any = {}) =>
    sqlDatasets.explainSql(projectId, sql, params));

  // The full result is read as a JOB (async DuckDB — the query already never
  // blocked) and STAGED in main (src/data/importStage) like a picked file: the
  // renderer gets a display slice and a `stagedId`, and the composer's Save
  // resolves the rows here instead of shipping up to 1M rows both ways.
  ipcMain.handle('sql:prepareSave', async (_e, { projectId, sql, params }: any = {}) => {
    const job = jobs.submit({
      kind: 'sql-save',
      label: 'Read the query result',
      projectId: typeof projectId === 'string' ? projectId : undefined,
      run: async (ctx) => {
        ctx.progress(0.1, 'Running the query');
        const res: any = await sqlDatasets.runForDataset(projectId, sql, params);
        if (!res || res.ok === false) throw new Error((res && res.error) || 'The full result could not be read.');
        return res;
      },
      resultOf: (res: any) => ({ message: `${Number((res.rows || []).length).toLocaleString('en-US')} rows ready to save` }),
    });
    try {
      const res: any = await job.done;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const table = { columns: res.columns || [], rows, rowCount: rows.length, warnings: [] as string[] };
      const stagedId = importStage.put(table);
      return { ...res, rows: rows.slice(0, importStage.PREVIEW_ROWS), rowCount: rows.length, stagedId };
    } catch (err: any) {
      if (err && err.name === 'JobCancelled') return { ok: false, canceled: true, error: 'Cancelled.' };
      return { ok: false, error: err?.message || 'The full result could not be read.' };
    }
  });
}
