// The one app-wide listener for a subscription that paused itself
// (`subscriptions:paused`, pushed to its owner only): the server's sentence, as a
// toast, on whatever page the owner is on. Mounted by the top bar's bell. Its
// own small file so the shell's bundle takes this and nothing else of the feature.

import { useServerEvent } from '../../api/events';
import { toast } from '../../ui/Toast';

export function usePausedNotice(): void {
  useServerEvent('subscriptions:paused', (p) => {
    const message = (p as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string' && message) toast(message, { kind: 'error' });
  });
}
