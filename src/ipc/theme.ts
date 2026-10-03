import { nativeTheme } from 'electron';
import { ipcMain } from './bus';
import * as config from '../app/config';
import { setHubTitleBarOverlay } from '../windows/hubWindow';
import * as hubs from '../windows/hubRegistry';

// ── Theme preference (single source of truth) ───────────────────────────────
// themePreference is 'system' | 'light' | 'dark'. 'system' follows the OS via
// nativeTheme. The effective theme ('light'|'dark') is resolved here and pushed
// to the renderer, which only ever applies a concrete light/dark value.
// Every hub window paints the theme, so every one of them is told
// (src/windows/hubRegistry.ts) — a second window opened from a tab included.
function effectiveTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function register() {
  ipcMain.handle('theme:getPreference', () => ({
    preference: config.get().themePreference || 'system',
    effective: effectiveTheme(),
  }));

  ipcMain.handle('theme:setPreference', (_e, preference: any) => {
    const cfg = config.save({ themePreference: preference });
    // nativeTheme.themeSource accepts exactly 'system'|'light'|'dark'.
    nativeTheme.themeSource = cfg.themePreference as 'system' | 'light' | 'dark';
    const effective = effectiveTheme();
    for (const w of hubs.all()) setHubTitleBarOverlay(w, effective); // repaint Windows controls to match
    return { preference: cfg.themePreference, effective };
  });

  // Re-apply live when the OS theme changes (only meaningful in 'system' mode).
  nativeTheme.on('updated', () => {
    const effective = effectiveTheme();
    hubs.broadcast('theme:apply', { effective });
    for (const w of hubs.all()) setHubTitleBarOverlay(w, effective); // repaint Windows controls to match
  });
}
