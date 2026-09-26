// Workspace FORMATS and BRANDING over IPC. MAIN PROCESS.
//
// Settings → General → Formats and Settings → Appearance → Branding write
// here. Each write goes through config (which re-sanitizes and re-seeds the
// formatter and the calendar main computes under), then the new values are
// PUSHED to the hub (`prefs:changed`) so every open surface re-renders its
// figures and repaints its accent at once, without a reload.
//
// The logo is a file: picked with the native dialog, validated by content
// (src/app/branding.ts), stored under userData, and handed back as a data:
// URL — never a path — so a renderer can show it, a report can embed it and
// an export can carry it, all without file access.

import { ipcMain, dialog, app } from 'electron';
import * as fs from 'fs';

import * as config from '../app/config';
import * as hubs from '../windows/hubRegistry';
import { readLogoDataUrl, removeLogo, saveLogo, LOGO_MAX_BYTES } from '../app/branding';

function publicPrefs(): { formats: unknown; branding: unknown } {
  const cfg = config.get();
  return { formats: { ...cfg.formats }, branding: { ...cfg.branding } };
}

export function register(): void {
  // Every hub window: each repaints its own figures and accent.
  const push = (): void => hubs.broadcast('prefs:changed', publicPrefs());

  ipcMain.handle('prefs:get', async () => publicPrefs());

  // A PARTIAL patch, merged over what is stored — config sanitizes the result.
  ipcMain.handle('formats:set', async (_e, patch: unknown) => {
    const cur = config.get().formats;
    config.save({ formats: { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) } });
    push();
    return { ok: true, ...publicPrefs() };
  });

  ipcMain.handle('branding:set', async (_e, patch: unknown) => {
    const cur = config.get().branding;
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    // `logo` is not the renderer's to set: it records which FILE exists.
    config.save({ branding: { ...cur, accent: 'accent' in p ? p.accent : cur.accent, dashboardStyle: p.dashboardStyle ?? cur.dashboardStyle } });
    push();
    return { ok: true, ...publicPrefs() };
  });

  /** `scope` is 'workspace' or a dashboard (analysis) id. */
  ipcMain.handle('branding:pickLogo', async (_e, scope: unknown) => {
    const s = typeof scope === 'string' ? scope : 'workspace';
    const hub = hubs.primary();
    const opts = {
      title: 'Choose a logo',
      properties: ['openFile' as const],
      filters: [{ name: 'Logo (PNG or SVG)', extensions: ['png', 'svg'] }],
    };
    const res = hub ? await dialog.showOpenDialog(hub, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    let buf: Buffer;
    try {
      const st = await fs.promises.stat(res.filePaths[0]);
      if (st.size > LOGO_MAX_BYTES) return { ok: false, error: `That logo is ${(st.size / 1024).toFixed(0)} KB — the limit is ${LOGO_MAX_BYTES / 1024} KB.` };
      buf = await fs.promises.readFile(res.filePaths[0]);
    } catch (_) {
      return { ok: false, error: 'That file could not be read.' };
    }
    const saved = await saveLogo(app.getPath('userData'), s, buf);
    if (!saved.ok) return saved;
    if (s === 'workspace') {
      config.save({ branding: { ...config.get().branding, logo: saved.kind } });
      push();
    }
    return { ok: true, dataUrl: await readLogoDataUrl(app.getPath('userData'), s) };
  });

  ipcMain.handle('branding:clearLogo', async (_e, scope: unknown) => {
    const s = typeof scope === 'string' ? scope : 'workspace';
    await removeLogo(app.getPath('userData'), s);
    if (s === 'workspace') {
      config.save({ branding: { ...config.get().branding, logo: '' } });
      push();
    }
    return { ok: true };
  });

  ipcMain.handle('branding:logo', async (_e, scope: unknown) => ({
    ok: true,
    dataUrl: await readLogoDataUrl(app.getPath('userData'), typeof scope === 'string' ? scope : 'workspace'),
  }));
}
