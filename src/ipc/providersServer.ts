// The server's half of providers.ts (T2.12): the Assistant's readiness and
// "connect a provider", for an org. providers.ts itself stays desktop-only — it
// carries the native dialogs, the window registry and the local-CLI / Ollama
// paths a server never has.
//
//   key:status          what the dock needs to know: publicConfig() (has-key
//                       flags only, never a key) narrowed by the org's provider
//                       policy, plus whether this server can store a key at all
//   byok:saveProvider   key (write-only — it never comes back), endpoint, model
//   byok:test           a real connectivity call; a pass marks the provider verified
//   byok:activate       Active requires Connected (execConfig)
//
// Every channel refuses a provider the org does not allow (Admin → Settings).
// The writes are org-admin only (src/api/assistant.ts): the key and the
// endpoint are the org's, and every member's questions go through them. Each
// change pushes `key:changed` to the org's open tabs so their docks re-read.

import { ipcMain } from './bus';
import * as execConfig from '../app/execConfig';
import { testProvider } from '../ai/analyze';
import { allowedProviders, keyStoreUnavailable } from '../server/aiKeys';
import { ctx } from '../server/context';
import { publish } from '../server/sse';

const NOT_ALLOWED = { ok: false, errorType: 'not_allowed', message: 'Your organization does not allow this provider.' };

function changed(): void {
  publish({ org: ctx().org.id }, 'key:changed');
}

export function register(): void {
  ipcMain.handle('key:status', async () => {
    const pub = execConfig.publicConfig();
    const allowed = await allowedProviders();
    const active = pub.byok.activeProvider;
    return {
      ...pub,
      // Ready means the provider that would answer is one the org allows.
      isReady: pub.isReady && active !== null && allowed.includes(active),
      allowedProviders: allowed,
      keyStore: keyStoreUnavailable(),
    };
  });

  ipcMain.handle('byok:saveProvider', async (_e, { provider, fields }: { provider: string; fields: Record<string, unknown> }) => {
    if (!(await allowedProviders()).includes(provider)) return NOT_ALLOWED;
    const r = await execConfig.saveByokProvider(provider, fields);
    if (r.ok) changed();
    return r;
  });

  ipcMain.handle('byok:test', async (_e, { provider }: { provider: string }) => {
    if (!(await allowedProviders()).includes(provider)) return NOT_ALLOWED;
    const r = await testProvider(provider);
    execConfig.setByokVerified(provider, Boolean(r && r.ok));
    changed();
    return r;
  });

  ipcMain.handle('byok:activate', async (_e, { provider }: { provider: string }) => {
    if (!(await allowedProviders()).includes(provider)) return NOT_ALLOWED;
    const r = execConfig.setByokActiveProvider(provider);
    if (r.ok) changed();
    return r;
  });
}
