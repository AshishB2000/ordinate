import { ipcMain, dialog, app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { buildSelfContainedHtml } from '../analysis/dashboardExport';
import { getFormatPrefs } from '../app/format';
import { captureHtmlToPng, captureHtmlToPdf } from '../app/reportCapture';
import * as jobs from '../app/jobs';

// Dashboard EXPORT + SHARE IPC — MAIN PROCESS.
//
//  dashboard:exportHtml   → build a self-contained, offline interactive .html (inlined
//                           app-computed data + a copy of the Chart.js UMD read off
//                           node_modules + a tiny render script) and save via the native
//                           panel.
//  dashboard:exportPng    → snapshot a renderer-built dashboard one-pager HTML to a PNG
//                           (REUSES reportCapture.captureHtmlToPng — the same offscreen
//                           routine hub:captureReport uses) and save.
//  dashboard:exportPdf    → same offscreen render → Chromium printToPDF (native, no
//                           pdfmake, no new dependency) and save.
//  dashboard:revealFolder → shell.showItemInFolder on a project's userData/projects/<id>
//                           folder (UUID-guarded so the path can never escape projects).
//
// SECRET-EXCLUSION GUARANTEE. Nothing here reads config.json or any key. The HTML export
// serializes ONLY the whitelisted bundle (see src/dashboardExport.sanitizeBundle —
// labels/numbers/strings + data: PNGs), the PNG/PDF exports capture a rendered page (no
// data source), and the reveal target is a project's text-JSON folder (datasets/visuals/
// dashboards) — connection secrets live in the gitignored config.json and never appear
// in either. Every number was computed by the pure pipeline (strict-number rule intact).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Path to the Chart.js UMD inside the (possibly asar-packed) app. `app.getAppPath()`
// resolves inside the asar in a packaged build, and fs can read a file out of the asar.
function chartLibPath(): string {
  return path.join(app.getAppPath(), 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
}

// Prefer a caller-supplied name (only if it already ends in the right extension) else a
// safe timestamped default. Never trust the renderer name for anything but the dialog's
// suggested filename — the user still confirms the destination in the native panel.
function safeName(defaultName: unknown, ext: string, base: string): string {
  const re = new RegExp('\\.' + ext + '$', 'i');
  if (typeof defaultName === 'string' && re.test(defaultName)) return defaultName;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}-${ts}.${ext}`;
}

/**
 * Ask where, THEN produce and write as a job (src/app/jobs.ts). The order
 * matters: a job that sat in "running" while the user browsed a save panel
 * would be a progress bar measuring nothing. `produce` does the rendering off
 * the event loop's critical path (the offscreen capture is async), the write is
 * temp-then-rename, and the popover's Reveal shows the file.
 */
async function exportAsJob(
  label: string,
  opts: { title: string; defaultName: string; filterName: string; ext: string },
  produce: () => Promise<Buffer | null>,
): Promise<{ ok: boolean; dest?: string; canceled?: boolean; error?: string }> {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: opts.title,
    defaultPath: path.join(app.getPath('downloads'), opts.defaultName),
    filters: [{ name: opts.filterName, extensions: [opts.ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const job = jobs.submit({
    kind: 'export',
    label,
    run: async (ctx) => {
      ctx.progress(0.1, 'Rendering');
      const buf = await produce();
      if (!buf) throw new Error('Could not render the dashboard');
      ctx.checkCancelled();
      ctx.progress(0.9, 'Writing the file');
      const tmp = filePath + '.partial';
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, filePath);
      return filePath;
    },
    resultOf: (dest) => ({ path: dest }),
  });
  try {
    return { ok: true, dest: await job.done };
  } catch (err: any) {
    if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
    return { ok: false, error: err?.message || 'Export failed' };
  }
}

export function register() {
  // Build + save the self-contained interactive HTML. `bundle` is untrusted renderer
  // input; buildSelfContainedHtml whitelists it before serializing.
  ipcMain.handle('dashboard:exportHtml', async (_e, { bundle, defaultName }: any = {}) => {
    try {
      let chartLibJs = '';
      try {
        chartLibJs = await fs.promises.readFile(chartLibPath(), 'utf8');
      } catch (e) {
        // No Chart.js on disk → charts degrade to a "Chart engine unavailable" tile in
        // the exported file rather than failing the whole export.
        console.error('[dashboardExport] could not read Chart.js UMD', e);
      }
      let formatJs = '';
      try {
        formatJs = await fs.promises.readFile(path.join(__dirname, '..', 'app', 'format.js'), 'utf8');
      } catch (e) {
        console.error('[dashboardExport] could not read the formatter', e);
      }
      const name = safeName(defaultName, 'html', 'dashboard');
      return await exportAsJob(`Export ${name}`, {
        title: 'Export dashboard (HTML)',
        defaultName: name,
        filterName: 'HTML',
        ext: 'html',
      }, async () => Buffer.from(buildSelfContainedHtml(bundle, chartLibJs, { js: formatJs, prefs: getFormatPrefs() }), 'utf8'));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the dashboard HTML' };
    }
  });

  // Snapshot a renderer-built dashboard one-pager HTML → PNG (reused capture routine).
  ipcMain.handle('dashboard:exportPng', async (_e, { html, width, defaultName }: any = {}) => {
    try {
      if (typeof html !== 'string' || !html) return { ok: false, error: 'No content to export' };
      const name = safeName(defaultName, 'png', 'dashboard');
      return await exportAsJob(`Export ${name}`, {
        title: 'Export dashboard (PNG)',
        defaultName: name,
        filterName: 'PNG Image',
        ext: 'png',
      }, async () => {
        const dataUrl = await captureHtmlToPng(html, width);
        return dataUrl ? Buffer.from(dataUrl.replace(/^data:image\/[^;]+;base64,/, ''), 'base64') : null;
      });
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the dashboard image' };
    }
  });

  // Same offscreen render → native Chromium printToPDF.
  ipcMain.handle('dashboard:exportPdf', async (_e, { html, width, defaultName }: any = {}) => {
    try {
      if (typeof html !== 'string' || !html) return { ok: false, error: 'No content to export' };
      const name = safeName(defaultName, 'pdf', 'dashboard');
      return await exportAsJob(`Export ${name}`, {
        title: 'Export dashboard (PDF)',
        defaultName: name,
        filterName: 'PDF Document',
        ext: 'pdf',
      }, () => captureHtmlToPdf(html, width));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the dashboard PDF' };
    }
  });

  // Reveal a project's on-disk folder (the git-shareable, secret-free artifact).
  // projectId is UUID-validated AND the resolved path is confirmed to stay inside
  // userData/projects, so it can never point outside that tree.
  ipcMain.handle('dashboard:revealFolder', async (_e, { projectId }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
        return { ok: false, error: 'Invalid project id' };
      }
      const projectsBase = path.resolve(app.getPath('userData'), 'projects');
      const dir = path.resolve(projectsBase, projectId);
      // Defense-in-depth: the UUID gate already forbids separators/'..', so `dir` must
      // sit directly under projectsBase. Confirm it before revealing anything.
      if (path.dirname(dir) !== projectsBase) {
        return { ok: false, error: 'Path escapes the projects directory' };
      }
      // Reveal the project.json if present, else the folder itself.
      const manifest = path.join(dir, 'project.json');
      const target = fs.existsSync(manifest) ? manifest : dir;
      if (!fs.existsSync(target)) return { ok: false, error: 'Project folder not found' };
      shell.showItemInFolder(target);
      return { ok: true, dest: target };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to reveal the project folder' };
    }
  });
}
