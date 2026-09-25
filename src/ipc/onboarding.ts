import { ipcMain } from 'electron';
import * as onboarding from '../app/onboarding';

// First-run guidance IPC: what the Get-started card shows, and the three
// things the renderer may change about it (fold, dismiss, tour seen). The
// ticks themselves are computed in main from real records — see onboarding.ts.
export function register(): void {
  ipcMain.handle('onboarding:status', async () => onboarding.status());
  ipcMain.handle('onboarding:set', async (_e, patch: any = {}) => ({ ok: onboarding.set(patch || {}) }));
}
