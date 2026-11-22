// The issues board's RPC channels (contracts in src/api/issues.ts). Each runs in the caller's own request context.

import { registry } from '../rpc';
import * as board from './board';
import * as say from '../issueMessages';
import * as store from './db';
import * as trackers from './trackers/service';
import { canStore } from './trackers/tokens';

export function register(): void {
  registry.handle('issues:list', (_e, { projectId }: { projectId: string }) => board.list(projectId));
  registry.handle('issues:setEnabled', (_e, { projectId, enabled }: { projectId: string; enabled: boolean }) => board.setEnabled(projectId, enabled));
  registry.handle('issues:checkNow', (_e, { projectId }: { projectId: string }) => board.checkNow(projectId));
  registry.handle('issues:setStatus', (_e, { projectId, id, status }: { projectId: string; id: string; status: store.Status }) => board.setStatus(projectId, id, status));
  registry.handle('issues:propose', (_e, { projectId, id }: { projectId: string; id: string }) => board.propose(projectId, id));
  registry.handle('issues:send', (_e, { projectId, id, provider }: { projectId: string; id: string; provider: store.Provider }) => board.send(projectId, id, provider));
  registry.handle('tracker:status', async () => (store.dbOrNull() ? { ok: true as const, available: true, ...(await trackers.status()) } : { ok: true as const, available: false, canSave: canStore(), providers: [] }));
  registry.handle('tracker:connect', (_e, p: trackers.Connect) => (store.dbOrNull() ? trackers.connect(p) : { ok: false as const, error: say.needsDb() }));
  registry.handle('tracker:disconnect', (_e, { provider }: { provider: store.Provider }) => (store.dbOrNull() ? trackers.disconnect(provider) : { ok: true as const }));
}
