import { ipcMain, dialog, app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { buildSelfContainedHtml } from '../dashboardExport';
import { captureHtmlToPng, captureHtmlToPdf } from '../reportCapture';

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

async function saveBuffer(
  buf: Buffer,
  opts: { title: string; defaultName: string; filterName: string; ext: string },
): Promise<{ ok: boolean; dest?: string; canceled?: boolean }> {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: opts.title,
    defaultPath: path.join(app.getPath('downloads'), opts.defaultName),
    filters: [{ name: opts.filterName, extensions: [opts.ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(filePath, buf);
  return { ok: true, dest: filePath };
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
      const html = buildSelfContainedHtml(bundle, chartLibJs);
      const res = await saveBuffer(Buffer.from(html, 'utf8'), {
        title: 'Export dashboard (HTML)',
        defaultName: safeName(defaultName, 'html', 'dashboard'),
        filterName: 'HTML',
        ext: 'html',
      });
      return res;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the dashboard HTML' };
    }
  });

  // Snapshot a renderer-built dashboard one-pager HTML → PNG (reused capture routine).
  ipcMain.handle('dashboard:exportPng', async (_e, { html, width, defaultName }: any = {}) => {
    try {
      if (typeof html !== 'string' || !html) return { ok: false, error: 'No content to export' };
      const dataUrl = await captureHtmlToPng(html, width);
      if (!dataUrl) return { ok: false, error: 'Could not render the dashboard' };
      const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      return await saveBuffer(buf, {
        title: 'Export dashboard (PNG)',
        defaultName: safeName(defaultName, 'png', 'dashboard'),
        filterName: 'PNG Image',
        ext: 'png',
      });
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the dashboard image' };
    }
  });

  // Same offscreen render → native Chromium printToPDF.
  ipcMain.handle('dashboard:exportPdf', async (_e, { html, width, defaultName }: any = {}) => {
    try {
      if (typeof html !== 'string' || !html) return { ok: false, error: 'No content to export' };
      const buf = await captureHtmlToPdf(html, width);
      if (!buf) return { ok: false, error: 'Could not render the dashboard' };
      return await saveBuffer(buf, {
        title: 'Export dashboard (PDF)',
        defaultName: safeName(defaultName, 'pdf', 'dashboard'),
        filterName: 'PDF Document',
        ext: 'pdf',
      });
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
