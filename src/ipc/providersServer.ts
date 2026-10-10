// The Assistant's older readiness and "connect a provider" channels (T2.12),
// kept registered — contracts are append-only — as thin wrappers over the
// ai:* model (./aiModels.ts, src/server/aiConfig.ts; docs/ai-models/00-plan.md):
//
//   key:status          publicConfig() (has-key flags only, never a key) with
//                       isReady = ai:status.ready and the caller's provider
//                       as the active one; whether this server can store a key
//   byok:saveProvider   save and test (ai:connect); an empty key disconnects
//   byok:test           test again (ai:connect with nothing new)
//   byok:activate       make the provider's first model the org default,
//                       adding its built-in one when it has none
//
// With no database they act on the pod's config.json, as before. The writes
// are org-admin only (src/api/assistant.ts). Each change pushes `key:changed`.

import { ipcMain } from './bus';
import * as execConfig from '../app/execConfig';
import { testProvider } from '../ai/analyze';
import * as aiConfig from '../server/aiConfig';
import { keyStoreUnavailable } from '../server/aiKeys';
import { ctx } from '../server/context';
import { publish } from '../server/sse';
import { podMemberView } from './aiModels';
import { AI_PROVIDERS } from '../api/admin';

function changed(): void {
  publish({ org: ctx().org.id }, 'key:changed');
}

async function status() {
  const pub = execConfig.publicConfig();
  if (!aiConfig.enabled()) {
    const view = podMemberView();
    return { ...pub, isReady: view.ready, allowedProviders: [...new Set(view.models.map((m) => m.provider))], keyStore: keyStoreUnavailable() };
  }
  // From the member's view alone: any member reads this (Settings loads it), so no key is decrypted for it.
  const view = await aiConfig.memberView();
  const providers: Record<string, { hasKey: boolean; verified: boolean; connected: boolean; baseUrl: string; maxTokens: string; model: string }> = {};
  for (const p of AI_PROVIDERS) {
    const model = view.models.find((m) => m.provider === p)?.model ?? '';
    providers[p] = { hasKey: Boolean(model), verified: Boolean(model), connected: Boolean(model), baseUrl: '', maxTokens: '', model };
  }
  return {
    ...pub,
    isReady: view.ready,
    byok: { activeProvider: view.mine?.provider ?? null, providers },
    allowedProviders: [...new Set(view.models.map((m) => m.provider))],
    keyStore: keyStoreUnavailable(),
  };
}

export function register(): void {
  ipcMain.handle('key:status', status);

  ipcMain.handle('byok:saveProvider', async (_e, { provider, fields }: { provider: string; fields: { apiKey?: string; baseUrl?: string; model?: string } }) => {
    if (!aiConfig.enabled()) {
      const r = await execConfig.saveByokProvider(provider, fields);
      if (r.ok) changed();
      return r;
    }
    const r = fields.apiKey === ''
      ? await aiConfig.disconnect(provider)
      : await aiConfig.connect(provider, { apiKey: fields.apiKey, baseUrl: fields.baseUrl || undefined, model: fields.model || undefined }, testProvider);
    changed();
    return r;
  });

  ipcMain.handle('byok:test', async (_e, { provider }: { provider: string }) => {
    if (!aiConfig.enabled()) {
      const r = await testProvider(provider);
      execConfig.setByokVerified(provider, Boolean(r && r.ok));
      changed();
      return r;
    }
    const r = await aiConfig.connect(provider, {}, testProvider);
    changed();
    return r;
  });

  ipcMain.handle('byok:activate', async (_e, { provider }: { provider: string }) => {
    if (!aiConfig.enabled()) {
      const r = execConfig.setByokActiveProvider(provider);
      if (r.ok) changed();
      return r;
    }
    const admin = await aiConfig.adminView();
    if (!admin.providers.find((p) => p.provider === provider)?.connected) return { ok: false, error: 'not_connected' };
    const list = admin.models.map(({ provider: p, model, label }) => ({ provider: p, model, label }));
    let at = list.findIndex((m) => m.provider === provider);
    if (at < 0) {
      const model = await aiConfig.testModel(provider);
      if (!model) return { ok: false, error: 'not_connected' };
      at = list.push({ provider, model, label: model }) - 1;
    }
    const r = await aiConfig.setModels(list, at);
    if (r.ok) changed();
    return r;
  });
}
