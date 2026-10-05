// Workspace FORMATS and BRANDING over IPC. MAIN PROCESS.
//
// Settings → General → Formats and Settings → Appearance → Branding write
// here. Each write goes through config (which re-sanitizes and re-seeds the
// formatter and the calendar the server computes under).
//
// The logo is a file, validated by content (src/app/branding.ts), stored under
// userData, and handed back as a data: URL — never a path — so a page can show
// it, a report can embed it and an export can carry it, all without file access.
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';

import * as config from '../app/config';
import { readLogoDataUrl, removeLogo } from '../app/branding';

function publicPrefs(): { formats: unknown; branding: unknown } {
  const cfg = config.get();
  return { formats: { ...cfg.formats }, branding: { ...cfg.branding } };
}

export function register(): void {

  ipcMain.handle('prefs:get', async () => publicPrefs());

  // A PARTIAL patch, merged over what is stored — config sanitizes the result.
  ipcMain.handle('formats:set', async (_e, patch: unknown) => {
    const cur = config.get().formats;
    config.save({ formats: { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) } });
    return { ok: true, ...publicPrefs() };
  });

  ipcMain.handle('branding:set', async (_e, patch: unknown) => {
    const cur = config.get().branding;
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    // `logo` is not the renderer's to set: it records which FILE exists.
    config.save({ branding: { ...cur, accent: 'accent' in p ? p.accent : cur.accent, dashboardStyle: p.dashboardStyle ?? cur.dashboardStyle } });
    return { ok: true, ...publicPrefs() };
  });

  ipcMain.handle('branding:clearLogo', async (_e, scope: unknown) => {
    const s = typeof scope === 'string' ? scope : 'workspace';
    await removeLogo(appPaths.userData(), s);
    if (s === 'workspace') {
      config.save({ branding: { ...config.get().branding, logo: '' } });
    }
    return { ok: true };
  });

  ipcMain.handle('branding:logo', async (_e, scope: unknown) => ({
    ok: true,
    dataUrl: await readLogoDataUrl(appPaths.userData(), typeof scope === 'string' ? scope : 'workspace'),
  }));
}
