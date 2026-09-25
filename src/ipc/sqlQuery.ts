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

import { ipcMain } from 'electron';
import { isValidId } from '../app/ids';
import { viewColumns } from '../engine/datasetView';
import * as sqlDatasets from '../engine/sqlDatasets';

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

export function register(): void {
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

  ipcMain.handle('sql:prepareSave', async (_e, { projectId, sql, params }: any = {}) =>
    sqlDatasets.runForDataset(projectId, sql, params));
}
