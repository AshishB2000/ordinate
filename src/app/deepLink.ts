// `ordinate://dashboard/<id>?view=<viewId>` — opening the app on a dashboard,
// on a saved view. MAIN PROCESS.
//
// Parsing is pure and lives in src/analysis/savedViews.ts (parseDeepLink); this
// file is the OS plumbing around it. A link reaches the app three ways:
//
//   macOS          `open-url`, which can fire BEFORE `ready` on a cold start
//                  (registered at module load, so it is never missed).
//   Windows/Linux  the argv of the launch — the first instance's own argv on a
//                  cold start, or a second launch's, handed over by the
//                  single-instance lock's `second-instance` (src/main.ts takes it).
//
// Every link is held as ONE pending open. The hub takes it when it boots (the
// cold start) and is pinged to take it when it is already up — so neither
// order of "link arrives" and "renderer ready" loses one. A malformed link, or
// one naming a dashboard in no project, is ignored with a log line.

import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import { parseDeepLink } from '../analysis/savedViews';
import * as projects from './projects';
import * as analysis from '../analysis/analysis';

export interface PendingOpen { projectId: string; dashboardId: string; viewId: string }

let pending: PendingOpen | null = null;
let deps: { focusHub: () => void; getHubWindow: () => BrowserWindow | null } | null = null;

const SCHEME = 'ordinate';
const isLink = (a: unknown): a is string => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + ':');

/** The project holding this dashboard — the link names a dashboard, not a project. */
async function projectOf(dashboardId: string): Promise<string> {
  for (const p of await projects.listProjects()) {
    if (await analysis.getAnalysis(p.id, dashboardId)) return p.id;
  }
  return '';
}

/** Resolve a link and hand it to the hub. False when it was refused. */
export async function openLink(url: unknown): Promise<boolean> {
  const link = parseDeepLink(url);
  if (!link) { console.warn('[deeplink] ignored a malformed link'); return false; }
  const wasReady = app.isReady();
  await app.whenReady();
  const projectId = await projectOf(link.dashboardId);
  if (!projectId) { console.warn('[deeplink] no project holds that dashboard'); return false; }
  pending = { projectId, dashboardId: link.dashboardId, viewId: link.viewId || '' };
  // Cold start: main's own boot opens the hub, and the hub takes the link.
  if (wasReady && deps) {
    deps.focusHub();
    const w = deps.getHubWindow();
    if (w && !w.isDestroyed()) w.webContents.send('views:link');
  }
  return true;
}

/** The pending open, once. */
export function takeLink(): PendingOpen | null {
  const p = pending;
  pending = null;
  return p;
}

export function initDeepLinks(d: { focusHub: () => void; getHubWindow: () => BrowserWindow | null }): void {
  deps = d;
  // ponytail: registered from a PACKAGED app only. From a dev checkout this
  // would point the OS's ordinate:// handler at the bare Electron binary — and
  // every smoke run would re-register it. Installers declare the scheme too
  // (package.json build.protocols).
  if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
  app.on('open-url', (e, url) => { e.preventDefault(); void openLink(url); });
  app.on('second-instance', (_e, argv) => { const u = argv.find(isLink); if (u) void openLink(u); });
  const first = process.argv.find(isLink);
  if (first) void openLink(first);
}
