// The ai:* channels (src/api/ai.ts, docs/ai-models/00-plan.md §4): Admin → AI
// and each member's model pick, over src/server/aiConfig.ts. Every write
// pushes `key:changed` to the org's open tabs so their docks re-read.
//
// With no database nothing can be set up (there is nowhere safe for a key):
// the admin view says why, the writes refuse with it, and a member's view is
// the pod's config.json answer (src/ai/byok.ts) — one model or none.

import { ipcMain } from './bus';
import * as execConfig from '../app/execConfig';
import { testProvider } from '../ai/analyze';
import { listModels } from '../ai/models';
import * as aiConfig from '../server/aiConfig';
import { keyStoreUnavailable } from '../server/aiKeys';
import { AI_PROVIDERS } from '../api/admin';
import { aiModelNotEnabled } from '../ai/aiMessages';
import { ctx } from '../server/context';
import { publish } from '../server/sse';

function changed(): void {
  publish({ org: ctx().org.id }, 'key:changed');
}

/** A write's reply, and the push to the org's docks when it went through. */
function pushed<T extends { ok: boolean }>(r: T): T {
  if (r.ok) changed();
  return r;
}

/** The pod's config.json answer, shaped as aiConfig.memberView's (no database). */
export function podMemberView(): aiConfig.MemberView {
  const provider = execConfig.effectiveByokActive();
  if (!provider) return { ready: false, reason: keyStoreUnavailable() ? 'no_key_store' : 'no_model', models: [], mine: null };
  const model = execConfig.getByokProvider(provider).model;
  return { ready: true, models: [{ provider, model, label: model, isDefault: true }], mine: { provider, model } };
}

const noStore = (): { ok: false; error: string } => ({ ok: false, error: keyStoreUnavailable() ?? 'no key store' });

export function register(): void {
  ipcMain.handle('ai:status', () => (aiConfig.enabled() ? aiConfig.memberView() : podMemberView()));

  ipcMain.handle('ai:setMine', async (_e, { provider, model }: { provider: string; model: string }) => {
    if (aiConfig.enabled()) return pushed(await aiConfig.setMine(provider, model));
    const mine = podMemberView().mine;
    return mine && mine.provider === provider && mine.model === model ? { ok: true } : { ok: false, error: aiModelNotEnabled() };
  });

  ipcMain.handle('ai:admin', (): Promise<aiConfig.AdminView> | aiConfig.AdminView => {
    if (aiConfig.enabled()) return aiConfig.adminView();
    return {
      keyStore: keyStoreUnavailable(),
      providers: AI_PROVIDERS.map((provider) => ({ provider, connected: false, saved: false, hasKey: false, baseUrl: '', verifiedAt: null })),
      models: [],
    };
  });

  ipcMain.handle('ai:connect', async (_e, { provider, ...input }: { provider: string; apiKey?: string; baseUrl?: string; model?: string }) => {
    if (!aiConfig.enabled()) return noStore();
    const r = await aiConfig.connect(provider, input, testProvider);
    changed(); // pass or fail, the provider's state changed
    return r;
  });

  ipcMain.handle('ai:disconnect', async (_e, { provider }: { provider: string }) => {
    if (!aiConfig.enabled()) return noStore();
    return pushed(await aiConfig.disconnect(provider));
  });

  ipcMain.handle('ai:providerModels', (_e, { provider }: { provider: string }) => listModels(provider));

  ipcMain.handle('ai:setModels', async (_e, { models, defaultIndex }: { models: { provider: string; model: string; label: string }[]; defaultIndex: number }) => {
    if (!aiConfig.enabled()) return noStore();
    return pushed(await aiConfig.setModels(models, defaultIndex));
  });
}
