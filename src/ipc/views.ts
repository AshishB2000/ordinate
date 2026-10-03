import { ipcMain } from './bus';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import * as analysis from '../analysis/analysis';
import { applyViewOp, viewScope, parseDeepLink, viewLink } from '../analysis/savedViews';
import type { ViewOp } from '../analysis/savedViews';
import { initDeepLinks, openLink, takeLink } from '../app/deepLink';

// Saved views IPC (src/analysis/savedViews.ts holds every rule). The renderer
// gathers a reader's live state and sends it here; main whitelists it against
// the stored record and writes it through updateAnalysis, the one analysis write.
//
//   views:edit       create / rename / update / delete / default → the new list
//   views:scope      a view's filters + parameters, for a report generated on it
//   views:parseLink  parseDeepLink, for the smoke and a pasted link
//   views:openLink   act on a link as if the OS had delivered it
//   views:takeLink   the pending deep-link open, once (src/app/deepLink.ts)

export interface ViewsDeps {
  headless?: boolean;
  focusHub: () => void;
  getHubWindow: () => BrowserWindow | null;
}

export function register(deps: ViewsDeps): void {
  ipcMain.handle('views:edit', async (_e, { projectId, analysisId, op }: any = {}) => {
    try {
      const a = await analysis.getAnalysis(projectId, analysisId);
      if (!a) return { ok: false, error: 'That dashboard could not be read.' };
      const res = applyViewOp(a, op as ViewOp, a, new Date().toISOString(), randomUUID);
      if (!res.ok) return res;
      const saved = await analysis.updateAnalysis(projectId, analysisId, { views: res.views, defaultViewId: res.defaultViewId });
      if (!saved) return { ok: false, error: 'Could not save the view.' };
      return { ok: true, viewId: res.viewId, views: saved.views || [], defaultViewId: saved.defaultViewId || '', link: res.viewId ? viewLink(analysisId, res.viewId) : '' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the view.' };
    }
  });

  ipcMain.handle('views:scope', async (_e, { projectId, analysisId, viewId }: any = {}) => {
    const a = await analysis.getAnalysis(projectId, analysisId);
    const view = a && (a.views || []).find((v) => v.id === viewId);
    if (!a || !view) return { ok: false, error: 'That view no longer exists.' };
    return { ok: true, name: view.name, ...viewScope(view, a) };
  });

  ipcMain.handle('views:parseLink', (_e, { url }: any = {}) => parseDeepLink(url));
  ipcMain.handle('views:openLink', (_e, { url }: any = {}) => openLink(url));
  ipcMain.handle('views:takeLink', () => takeLink());

  if (!deps.headless) initDeepLinks(deps);
}
