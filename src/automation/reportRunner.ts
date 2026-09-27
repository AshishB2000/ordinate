// A report, generated with no window on screen — MAIN PROCESS.
//
// A report is built in the RENDERER (see the header of src/ipc/reports.ts):
// pdfmake, pptxgenjs and docx are page globals and a chart capture needs a DOM.
// So an unattended run is a HIDDEN hub window, loaded with `?headless=report`,
// where renderer/hub/automationReport.ts drives the same pipeline the schedule
// uses (buildReportPages → reportBytes) and hands the bytes back over
// `automation:reportDone`. Main writes the file.
//
// The window is `secondary=1` so its tab strip saves nothing — in the GUI
// process it shares localStorage with the real hub — and it is never shown,
// never focused and never added to the hub registry, so no broadcast, capture
// or "open settings" push can reach it.

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, session } from 'electron';
import { AutomationError } from './errors';

const ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 180_000;

export interface ReportOutcome {
  ok: boolean;
  base64?: string;
  ext?: string;
  error?: string;
  /** Map tiles left without a picture — maps need the visible window's WebGL2. */
  skippedMaps: number;
}

const pending = new Map<number, (o: ReportOutcome) => void>();

/** The hidden window's answer (src/ipc/automation.ts). Only a window this file opened is heard. */
export function settle(senderId: number, raw: unknown): boolean {
  const done = pending.get(senderId);
  if (!done) return false;
  pending.delete(senderId);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  done({
    ok: o.ok === true,
    base64: typeof o.base64 === 'string' ? o.base64 : undefined,
    ext: typeof o.ext === 'string' && /^(pdf|pptx|docx)$/.test(o.ext) ? o.ext : undefined,
    error: typeof o.error === 'string' ? o.error.slice(0, 500) : undefined,
    skippedMaps: typeof o.skippedMaps === 'number' && o.skippedMaps > 0 ? Math.floor(o.skippedMaps) : 0,
  });
  return true;
}

/**
 * The hub's session preloads (preload/hub<Area>Preload.js) are registered by
 * createHubWindow — which a headless process never calls. Same discovery rule
 * as src/windows/hubWindow.ts, skipping any already registered.
 */
function ensureSessionPreloads(): void {
  const ses = session.defaultSession;
  const have = new Set(ses.getPreloadScripts().map((p) => p.filePath));
  const dir = path.join(ROOT, 'preload');
  for (const n of fs.readdirSync(dir).filter((f) => /^hub[A-Z][A-Za-z]*Preload\.js$/.test(f)).sort()) {
    const filePath = path.join(dir, n);
    if (!have.has(filePath)) ses.registerPreloadScript({ type: 'frame', filePath });
  }
}

export async function runReport(
  projectId: string,
  reportId: string,
  opts: { headless: boolean; timeoutMs?: number },
): Promise<{ bytes: Buffer; ext: string; skippedMaps: number }> {
  if (opts.headless) ensureSessionPreloads();
  else if (!session.defaultSession.getPreloadScripts().length) {
    // The GUI registers them with its first hub window, a moment after launch.
    throw new AutomationError('runtime', 'Ordinate is still starting — try again in a moment.');
  }
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'hubPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const id = win.webContents.id;
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = new Promise<ReportOutcome>((resolve, reject) => {
      pending.set(id, resolve);
      const secs = Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000);
      timer = setTimeout(() => reject(new AutomationError('runtime', `The report did not finish within ${secs} seconds.`)), opts.timeoutMs || TIMEOUT_MS);
      win.webContents.once('render-process-gone', () => reject(new AutomationError('runtime', 'The report renderer stopped unexpectedly.')));
    });
    outcome.catch(() => { /* awaited below; this only keeps an early rejection handled */ });
    await win.loadFile(path.join(ROOT, 'renderer', 'hub', 'index.html'), {
      query: { secondary: '1', headless: 'report', project: projectId, report: reportId },
    });
    const o = await outcome;
    if (!o.ok || !o.base64 || !o.ext) throw new AutomationError('runtime', o.error || 'The report could not be built.');
    return { bytes: Buffer.from(o.base64, 'base64'), ext: o.ext, skippedMaps: o.skippedMaps };
  } finally {
    if (timer) clearTimeout(timer);
    pending.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}
