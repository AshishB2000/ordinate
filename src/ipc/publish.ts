import { dialog, BrowserWindow } from 'electron';
import { ipcMain } from './bus';
import * as os from 'os';
import * as path from 'path';
import * as jobs from '../app/jobs';
import * as analysis from '../analysis/analysis';
import * as stories from '../analysis/stories';
import * as scorecards from '../analysis/scorecards';
import { formatBytes } from '../publish/combos';
import { sanitizePublishConfig, planPublish, publishSite, getStoredConfig, storeConfig } from '../publish/publish';
import type { PublishConfig, PublishResult } from '../publish/publish';
import type { PlatformDeps } from './platform';

// Publish to folder — IPC. The dialog's targets, folder picker, size plan and
// run; "Re-publish" with the remembered choices; and the optional re-publish
// after a refresh, through the jobs system.
//
// WHERE A SITE MAY BE WRITTEN: only a folder the user chose in the native
// picker this session, or the folder a previous publish of this project was
// written to (which itself came from that picker). A renderer-supplied path is
// never enough on its own — the same rule the scheduled-report folder keeps.

const picked = new Set<string>();

/** Run a publish as a job; stores the choices on success. */
export function submitPublish(config: PublishConfig, label?: string): { id: string; done: Promise<PublishResult> } {
  const job = jobs.submit<PublishResult>({
    kind: 'publish',
    label: label || `Publish to ${path.basename(config.outDir)}`,
    projectId: config.projectId,
    run: async (ctx) => {
      const r = await publishSite(config, { progress: ctx.progress, checkCancelled: ctx.checkCancelled });
      await storeConfig(config, r);
      return r;
    },
    resultOf: (r) => ({ path: path.join(r.outDir, 'index.html'), message: `${r.files.length} files · ${formatBytes(r.bytes)}` }),
  });
  return job;
}

async function allowedOut(config: PublishConfig): Promise<boolean> {
  if (picked.has(config.outDir)) return true;
  const stored = await getStoredConfig(config.projectId);
  return Boolean(stored && stored.outDir === config.outDir);
}

// Re-publish after a refresh: debounced per project, so a scheduled tick that
// refreshes five datasets publishes once, after the last.
const pending = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 15_000;
function scheduleRepublish(projectId: string): void {
  const prev = pending.get(projectId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    pending.delete(projectId);
    void getStoredConfig(projectId).then((cfg) => {
      if (cfg && cfg.options.afterRefresh) submitPublish(cfg, 'Re-publish after refresh').done.catch(() => { /* on the job record */ });
    });
  }, DEBOUNCE_MS);
  t.unref();
  pending.set(projectId, t);
}

export function register(deps: PlatformDeps): void {
  if (!deps.headless) {
    jobs.onFinish((job) => {
      if (job.kind === 'refresh' && job.state === 'done' && job.projectId) scheduleRepublish(job.projectId);
    });
  }

  ipcMain.handle('publish:targets', async (_e, { projectId }: any = {}) => {
    try {
      const [dash, st, sc] = await Promise.all([analysis.listAnalyses(projectId), stories.listStories(projectId), scorecards.listScorecards(projectId)]);
      return {
        ok: true,
        dashboards: dash.map((d) => ({ id: d.id, name: d.name, sheets: d.sheetCount, updatedAt: d.updatedAt })),
        stories: st.map((s: any) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })), // any: StorySummary
        scorecards: sc.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not list what can be published.' };
    }
  });

  ipcMain.handle('publish:config', async (_e, { projectId }: any = {}) => ({ ok: true, config: await getStoredConfig(String(projectId || '')) }));

  ipcMain.handle('publish:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Publish to folder', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = path.resolve(r.filePaths[0]);
    picked.add(dir);
    return { ok: true, path: dir };
  });

  ipcMain.handle('publish:plan', async (_e, { config }: any = {}) => {
    // Sizing writes nothing, so it needs no folder yet: stand one in.
    const clean = sanitizePublishConfig({ ...(config || {}), outDir: (config && config.outDir) || os.tmpdir() });
    if ('error' in clean) return { ok: false, error: clean.error };
    try {
      return { ok: true, plan: await planPublish(clean) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not size the site.' };
    }
  });

  ipcMain.handle('publish:run', async (_e, { config }: any = {}) => {
    const clean = sanitizePublishConfig(config);
    if ('error' in clean) return { ok: false, error: clean.error };
    if (!(await allowedOut(clean))) return { ok: false, error: 'Choose the output folder again.' };
    await storeConfig(clean); // remembered even if the run fails, so Re-publish can retry
    const job = submitPublish(clean);
    try {
      const r = await job.done;
      return { ok: true, result: r, jobId: job.id };
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'Publishing failed.' };
    }
  });

  ipcMain.handle('publish:republish', async (_e, { projectId, brands }: any = {}) => {
    const stored = await getStoredConfig(String(projectId || ''));
    if (!stored) return { ok: false, error: 'This project has not been published yet.' };
    // Fresh brand ramps from the renderer when it sent them; otherwise the stored ones.
    const cfg = brands ? sanitizePublishConfig({ ...stored, brands }) : stored;
    if ('error' in cfg) return { ok: false, error: cfg.error };
    try {
      const r = await submitPublish(cfg, 'Re-publish').done;
      return { ok: true, result: r };
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'Publishing failed.' };
    }
  });
}
