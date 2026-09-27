import { ipcMain, dialog, shell, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as reportSpec from '../analysis/reportSpec';
import * as analysis from '../analysis/analysis';
import * as projects from '../app/projects';
import { tileCaption } from '../analysis/captions';
import type { CaptionInput } from '../analysis/captions';
import { notifyFile } from '../app/notify';
import { noteWrittenPath } from './jobs';
import { displayNames } from '../app/catalog';
import * as versions from '../app/versions';
import * as trash from '../app/trash';

// Reports IPC — the record's CRUD, the app-written caption, the folder picker,
// the scheduled write, and the due list.
//
// WHAT IS NOT HERE, and deliberately: the report itself. A page is laid out and
// a PDF/PPTX/DOCX is built in the RENDERER (renderer/hub/reportRender.ts +
// reportExport.ts), because that is where the chart engine, the map and the
// three document libraries live — pdfmake, pptxgenjs and docx are <script>
// globals, and a chart capture needs a real DOM. Main's part is the record, the
// sentence, and the bytes→disk step, which is the part that touches a path.
//
// So the scheduled path is deliberately a round trip: main decides WHAT is due
// (`reports:due`, a pure call into reportSpec.scheduleDue), the hub renders it,
// and main writes the bytes (`reports:writeScheduled`). Trying to generate in
// main instead would mean a second, headless copy of the whole renderer.
//
// Two rules this file keeps, both about paths:
//   • Every id is UUID-checked by reportSpec before it reaches a path.
//   • The only directory a scheduled write may land in is the one stored on the
//     record's own schedule, which only ever got there through the native
//     folder picker below. A renderer-supplied destination is never honoured.

/** A renderer payload is untrusted; base64 in, bytes out, or null. */
function decode(base64: unknown): Buffer | null {
  if (typeof base64 !== 'string' || !base64) return null;
  try {
    const buf = Buffer.from(base64, 'base64');
    return buf.length ? buf : null;
  } catch (_) {
    return null;
  }
}

const EXTS: ReadonlySet<string> = new Set(['pdf', 'pptx', 'docx']);

export function register() {
  ipcMain.handle('reports:list', async (_e, { projectId }: any = {}) =>
    reportSpec.listReports(String(projectId || '')));

  ipcMain.handle('reports:get', async (_e, { projectId, id }: any = {}) =>
    reportSpec.getReport(String(projectId || ''), String(id || '')));

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
    return report ? { ok: true, report } : { ok: false, error: 'Could not create the report.' };
  });

  ipcMain.handle('reports:update', async (_e, { projectId, id, patch }: any = {}) => {
    const before = await reportSpec.getReport(String(projectId || ''), String(id || ''));
    const r = await reportSpec.updateReport(String(projectId || ''), String(id || ''), patch || {});
    if (r) await versions.record(String(projectId), 'report', r, { before });
    return r ? { ok: true, report: r } : { ok: false, error: 'Report not found.' };
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
      analysisId: src.analysisId, name: src.name + ' copy', format: src.format,
      pages: src.pages, cover: src.cover, paper: src.paper,
      includeFilters: src.includeFilters, narrative: src.narrative,
    });
    return copy ? { ok: true, report: copy } : { ok: false, error: 'Could not duplicate.' };
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

  /** The native folder picker — the ONLY way a schedule's folder is ever set.
   *  Picking grants access to that directory; the app never writes to a user
   *  folder it was not handed this way. */
  ipcMain.handle('reports:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a folder for scheduled reports',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, folder: filePaths[0] };
  });

  /**
   * Write a SCHEDULED run's bytes into the report's own folder.
   *
   * The destination is read off the stored record, never off the payload: the
   * renderer says which report and hands over the bytes, and main decides where
   * they go. `<name>-<YYYY-MM-DD>.<ext>`, local date (reportSpec.reportFilename).
   *
   * `nowMs` is a parameter so a test can drive a dated filename without waiting
   * for a calendar day — the same reason scheduleDue takes `now`.
   */
  ipcMain.handle('reports:writeScheduled', async (_e, { projectId, id, base64, nowMs }: any = {}) => {
    const pid = String(projectId || '');
    const rid = String(id || '');
    const report = await reportSpec.getReport(pid, rid);
    if (!report) return { ok: false, error: 'Report not found.' };
    const folder = report.schedule && report.schedule.folder;
    if (!folder) return { ok: false, error: 'This report has no scheduled folder.' };
    const buf = decode(base64);
    if (!buf) return { ok: false, error: 'Nothing to write.' };

    const when = Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)) : new Date();
    const dest = path.join(folder, reportSpec.reportFilename(report.name, report.format, when));
    try {
      await fs.promises.mkdir(folder, { recursive: true });
      await fs.promises.writeFile(dest, buf);
    } catch (e) {
      console.error('[reports] scheduled write failed', e);
      return { ok: false, error: 'Could not write into the scheduled folder.' };
    }
    // Stamp with the SAME clock the filename used. Stamping with Date.now()
    // instead would let a faked-clock run reschedule itself against real time.
    await reportSpec.updateReport(pid, rid, { lastRunAt: when.toISOString(), lastFile: dest });
    const notified = notifyFile(`Report ready — ${path.basename(dest)}`, dest);
    noteWrittenPath(dest); // a renderer job may name it for the Jobs popover's Reveal
    return { ok: true, dest, notified };
  });

  /**
   * Which reports are due at `nowMs`, across every project.
   *
   * Metadata only, and no work is started here: the hub renderer takes this
   * list and generates each one. Deliberately mirrors refreshScheduler's
   * scheduledMetas/dueDatasets split — enumerate, then ask the pure function.
   */
  ipcMain.handle('reports:due', async (_e, { nowMs }: any = {}) => {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const out: Array<{ projectId: string; id: string; name: string; format: string }> = [];
    let list: Array<{ id: string }> = [];
    try {
      list = await projects.listProjects();
    } catch (_) {
      return out;
    }
    for (const p of list) {
      let reports: reportSpec.Report[] = [];
      try {
        reports = await reportSpec.readAll(p.id);
      } catch (_) {
        continue; // one unreadable project must not stop the rest
      }
      for (const r of reportSpec.scheduleDue(reports, now)) {
        out.push({ projectId: p.id, id: r.id, name: r.name, format: r.format });
      }
    }
    return out;
  });

  /** Select a generated file in the OS file manager. Only ever a path this app
   *  wrote and stored on a record — never a renderer-supplied string. */
  ipcMain.handle('reports:reveal', async (_e, { projectId, id }: any = {}) => {
    const r = await reportSpec.getReport(String(projectId || ''), String(id || ''));
    if (!r || !r.lastFile) return { ok: false, error: 'Nothing generated yet.' };
    if (!fs.existsSync(r.lastFile)) return { ok: false, error: 'That file has moved or been deleted.' };
    shell.showItemInFolder(r.lastFile);
    return { ok: true };
  });

  /** A manual Generate saves through the native panel, exactly as every other
   *  export in the app does, and then stamps the record so the Reports list can
   *  say "last generated". The dialog is what grants write access to the file. */
  ipcMain.handle('reports:saveAs', async (_e, { projectId, id, base64, ext }: any = {}) => {
    const pid = String(projectId || '');
    const rid = String(id || '');
    const report = await reportSpec.getReport(pid, rid);
    if (!report) return { ok: false, error: 'Report not found.' };
    const e = EXTS.has(String(ext)) ? String(ext) : report.format;
    const buf = decode(base64);
    if (!buf) return { ok: false, error: 'Nothing to save.' };
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Save report',
      defaultPath: path.join(app.getPath('downloads'), reportSpec.reportFilename(report.name, e)),
      filters: [{ name: e.toUpperCase(), extensions: [e] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(filePath, buf);
    } catch (err) {
      console.error('[reports] save failed', err);
      return { ok: false, error: 'Save failed.' };
    }
    await reportSpec.updateReport(pid, rid, { lastRunAt: new Date().toISOString(), lastFile: filePath });
    noteWrittenPath(filePath);
    return { ok: true, dest: filePath };
  });
}
