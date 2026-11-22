// The Linear and Jira tokens: the encrypted secrets store (kind `tracker.token`, ref = the provider), never `config.json`, never a reply.
// The store is wired once by app.ts; without ORDINATE_MASTER_KEY there is none and nothing can be saved.

import type { SecretStore } from '../../secrets/store';
import type { Provider } from '../db';

let store: SecretStore | null = null;
export function useTrackerSecrets(s: SecretStore | null): void {
  store = s;
}
export const canStore = (): boolean => store !== null;
export const getToken = async (org: string, p: Provider): Promise<string | null> => (store ? store.get(org, 'tracker.token', p) : null);
export async function putToken(org: string, p: Provider, value: string): Promise<void> {
  if (!store) throw new Error('Saving a tracker token needs ORDINATE_MASTER_KEY');
  await store.put(org, 'tracker.token', p, value);
}
export async function dropToken(org: string, p: Provider): Promise<void> {
  if (store) await store.delete(org, 'tracker.token', p);
}
