import { ipcMain } from './bus';
import * as reportSpec from '../analysis/reportSpec';
import * as analysis from '../analysis/analysis';
import { tileCaption } from '../analysis/captions';
import type { CaptionInput } from '../analysis/captions';
import { serverDataDir } from '../server/context';
import { displayNames } from '../app/catalog';
import * as versions from '../app/versions';
import * as trash from '../app/trash';

// Reports IPC — the record's CRUD and the app-written caption.
//
// WHAT IS NOT HERE: the report itself. A page is laid out and a
// PDF/PPTX/DOCX is built in the browser (web/src/features/reports/), where the
// chart engine, the maps and the three document libraries live, from the pages
// the server resolves (src/analysis/reportPages.ts). The desktop app's folder
// picker, save panel, "reveal", scheduled write and due list (its scheduler ran
// in the desktop window) went with it (T8.1).
//
// Every id is UUID-checked by reportSpec before it reaches a path.

/**
 * What a reply may say about a report. On the server a record imported from a
 * desktop install can still carry `lastFile` and a schedule `folder` — absolute
 * paths on someone's machine — and neither means anything to a browser.
 */
export function publicReport<T extends { lastFile?: string; schedule?: reportSpec.ReportSchedule }>(r: T): T {
  if (!serverDataDir() || !r) return r;
  const out = { ...r };
  delete out.lastFile;
  if (out.schedule) out.schedule = { ...out.schedule, folder: '' };
  return out;
}

export function register() {
  ipcMain.handle('reports:list', async (_e, { projectId }: any = {}) =>
    (await reportSpec.listReports(String(projectId || ''))).map(publicReport));

  ipcMain.handle('reports:get', async (_e, { projectId, id }: any = {}) => {
    const r = await reportSpec.getReport(String(projectId || ''), String(id || ''));
    return r ? publicReport(r) : r;
  });

  /**
   * Create a report for a dashboard, pre-filled from the dashboard's own shape.
   *
   * The page list is built HERE, from the analysis record on disk, rather than
   * being sent in by the renderer: the default pages are a function of the
   * sheets, main can read the sheets, and a renderer-supplied list would be one
   * more untrusted array to clamp for no gain.
   */
  ipcMain.handle('reports:create', async (_e, { projectId, analysisId }: any = {}) => {
    const pid = String(projectId || '');
    const aid = String(analysisId || '');
    const a = await analysis.getAnalysis(pid, aid);
    if (!a) return { ok: false, error: 'Dashboard not found.' };
    const report = await reportSpec.saveReport(pid, {
      analysisId: aid,
      name: a.name + ' report',
      format: 'pdf',
      pages: reportSpec.defaultPages(a.sheets),
      cover: { title: a.name, logo: true },
    });
    if (report) await versions.record(pid, 'report', report);
    return report ? { ok: true, report: publicReport(report) } : { ok: false, error: 'Could not create the report.' };
  });

  ipcMain.handle('reports:update', async (_e, { projectId, id, patch }: any = {}) => {
    const before = await reportSpec.getReport(String(projectId || ''), String(id || ''));
    const r = await reportSpec.updateReport(String(projectId || ''), String(id || ''), patch || {});
    if (r) await versions.record(String(projectId), 'report', r, { before });
    return r ? { ok: true, report: publicReport(r) } : { ok: false, error: 'Report not found.' };
  });

  ipcMain.handle('reports:delete', async (_e, { projectId, id }: any = {}) =>
    trash.trashRecord(String(projectId || ''), 'report', String(id || ''))); // to the Trash

  /** A copy with its own id, its own name and NO run history or schedule — a
   *  duplicate that inherited a schedule would silently double the deliveries. */
  ipcMain.handle('reports:duplicate', async (_e, { projectId, id }: any = {}) => {
    const pid = String(projectId || '');
    const src = await reportSpec.getReport(pid, String(id || ''));
    if (!src) return { ok: false, error: 'Report not found.' };
    const copy = await reportSpec.saveReport(pid, {
      analysisId: src.analysisId, scorecardId: src.scorecardId, name: src.name + ' copy', format: src.format,
      pages: src.pages, cover: src.cover, paper: src.paper,
      includeFilters: src.includeFilters, narrative: src.narrative, discussion: src.discussion,
    });
    return copy ? { ok: true, report: publicReport(copy) } : { ok: false, error: 'Could not duplicate.' };
  });

  /**
   * The app's own sentence for one tile.
   *
   * Pure arithmetic over figures the renderer already computed — see
   * src/analysis/captions.ts. It crosses the bridge rather than being written
   * in the renderer so there is exactly ONE caption implementation, and it is
   * the one scripts/test-captions.ts pins to exact strings.
   */
  ipcMain.handle('reports:caption', async (_e, { input }: any = {}) => {
    const i = { ...(input || {}) } as CaptionInput & { projectId?: string; datasetId?: string };
    // Column display names from the catalog, when the caller says which dataset.
    if (i.projectId && i.datasetId) i.names = await displayNames(String(i.projectId), String(i.datasetId));
    return tileCaption(i);
  });
}
