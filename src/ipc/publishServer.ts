// Publish to a URL and Export, on the server (T2.9). The desktop's
// src/ipc/publish.ts picks a folder in a native dialog and writes a static site
// there; here the SAME pages (src/publish/publish.ts buildPages) become a site
// the server keeps and serves at /p/<publishId>/ (src/publish/hosted.ts,
// src/server/published.ts). Export HTML is the same one-page build
// (dashboardPageHtml) handed to the browser as a download (T0.4).
//
// Every site belongs to a project: a channel naming a site id also names its
// project, and a site of ANOTHER project is "not found" — the contract checked
// the caller's role on the project the input names, so the site must be in it.
//
// Nothing here computes a figure: the builders do, under the project's Share
// policy ('publish' for a site, 'export' for a download), and sanitizePage
// whitelists every page before it is stored.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { ipcMain } from './bus';
import * as appPaths from '../app/paths';
import * as jobs from '../app/jobs';
import * as analysis from '../analysis/analysis';
import * as stories from '../analysis/stories';
import * as scorecards from '../analysis/scorecards';
import { formatBytes } from '../publish/combos';
import { sanitizeStyle } from '../analysis/dashboards';
import { dashboardPageHtml, planPublish, sanitizePublishConfig } from '../publish/publish';
import { getSite, listSites, publishHosted, removeSite, setAccess, type Access, type HostedSite } from '../publish/hosted';
import { ctx } from '../server/context';
import { offerDownload } from '../server/files';
import { orgAllowsLinks } from '../server/published';

type Targets = { projectId: string; dashboardIds?: string[]; storyIds?: string[]; scorecardIds?: string[]; options?: Record<string, unknown>; brands?: unknown };

const LINK_OFF = 'Your organisation has not turned on public links. An admin can, in Admin → Settings.';

/** A site of THIS project, or null. */
async function siteIn(projectId: string, id: string): Promise<HostedSite | null> {
  const s = await getSite(id);
  return s && s.projectId === projectId ? s : null;
}

/** File-name-safe, like the desktop's export dialog default. */
function safeName(name: string, ext: string): string {
  return `${String(name || 'dashboard').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dashboard'}.${ext}`;
}

export function register(pool: () => Pool | null): void {
  ipcMain.handle('publish:targets', async (_e, { projectId }: { projectId: string }) => {
    const [dash, st, sc] = await Promise.all([analysis.listAnalyses(projectId), stories.listStories(projectId), scorecards.listScorecards(projectId)]);
    return {
      ok: true,
      // Each dashboard's accent and theme (sanitizeStyle): the browser turns a custom
      // accent into the brand ramp the published page paints with (publishDialog.ts pdBrands).
      dashboards: await Promise.all(dash.map(async (d) => {
        const st = sanitizeStyle((await analysis.getAnalysis(projectId, d.id))?.style);
        return { id: d.id, name: d.name, sheets: d.sheetCount, updatedAt: d.updatedAt, style: { theme: st.theme, accent: st.accent, ...(st.accentHex ? { accentHex: st.accentHex } : {}) } };
      })),
      stories: st.map((s: { id: string; name: string; updatedAt: string }) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })),
      scorecards: sc.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })),
    };
  });

  // The dialog's live estimate: pages, combinations, bytes against the 50 MB limit. Writes nothing.
  ipcMain.handle('publish:plan', async (_e, t: Targets) => {
    const clean = sanitizePublishConfig({ ...t, outDir: appPaths.temp() });
    if ('error' in clean) return { ok: false, error: clean.error };
    try {
      return { ok: true, plan: await planPublish(clean) };
    } catch (err: any) { // any: a builder's throw
      return { ok: false, error: err?.message || 'Could not size the site.' };
    }
  });

  // The project's published links, and whether this org lets a link be public.
  ipcMain.handle('publish:sites', async (_e, { projectId }: { projectId: string }) => ({
    ok: true,
    sites: await listSites(projectId),
    publicLinks: await orgAllowsLinks(pool(), ctx().org.id),
  }));

  // Publish (or, with `id`, re-publish over the same link) — as a job, so it shows in Jobs.
  ipcMain.handle('publish:run', async (_e, t: Targets & { id?: string; access?: Access }) => {
    if (t.access === 'link' && !(await orgAllowsLinks(pool(), ctx().org.id))) return { ok: false, error: LINK_OFF };
    if (t.id && !(await siteIn(t.projectId, t.id))) return { ok: false, error: 'That published link no longer exists.' };
    const by = ctx().user.email;
    const job = jobs.submit<HostedSite>({
      kind: 'publish',
      label: t.id ? 'Re-publish' : 'Publish',
      projectId: t.projectId,
      run: (jc) => publishHosted(t, by, {
        id: t.id, access: t.access, progress: { progress: jc.progress, checkCancelled: jc.checkCancelled },
      }),
      resultOf: (s) => ({ message: `${s.pages.length + 1} pages · ${formatBytes(s.bytes)}` }),
    });
    try {
      return { ok: true, site: await job.done };
    } catch (err: any) { // any: a builder's throw
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'Publishing failed.' };
    }
  });

  ipcMain.handle('publish:access', async (_e, { projectId, id, access }: { projectId: string; id: string; access: Access }) => {
    if (!(await siteIn(projectId, id))) return { ok: false, error: 'That published link no longer exists.' };
    if (access === 'link' && !(await orgAllowsLinks(pool(), ctx().org.id))) return { ok: false, error: LINK_OFF };
    return { ok: true, site: await setAccess(id, access) };
  });

  ipcMain.handle('publish:unpublish', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    if (!(await siteIn(projectId, id))) return { ok: false, error: 'That published link no longer exists.' };
    return { ok: await removeSite(id) };
  });

  // Export HTML: the dashboard as one self-contained page (the published
  // renderer, its data, its pinned CSP), under the Share policy's EXPORT path.
  ipcMain.handle('dashboard:exportHtml', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const a = await analysis.getAnalysis(projectId, id);
    if (!a) return { ok: false, error: 'That dashboard could not be loaded.' };
    const html = await dashboardPageHtml(projectId, id);
    const file = path.join(appPaths.temp(), `export-${randomUUID()}.html`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, html, { mode: 0o600 });
    return { ok: true, ...offerDownload(file, safeName(a.name, 'html')) };
  });
}
