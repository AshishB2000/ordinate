import { ipcMain } from './bus';
import { ctx } from '../server/context';
import * as onboarding from '../app/onboarding';

// First-run guidance IPC: the caller's own Get-started tour (ticks, fold,
// hide) and the org's coach marks seen. A stop ticks when the browser reports
// a visit to its page; see onboarding.ts.
export function register(): void {
  ipcMain.handle('onboarding:status', async () => onboarding.status(ctx().user.email));
  ipcMain.handle('onboarding:set', async (_e, patch: any = {}) => ({ ok: onboarding.set(ctx().user.email, patch || {}) }));
  ipcMain.handle('onboarding:visit', async (_e, { step }: { step: onboarding.StepId }) => ({ ok: onboarding.visit(ctx().user.email, step) }));
}
