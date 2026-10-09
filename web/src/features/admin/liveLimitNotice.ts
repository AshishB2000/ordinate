// "Today's live queries are used up" — the server pushes `live:daily-limit`
// once per org per UTC day, to the org's admins only, on the first question
// LIVE_DAILY_QUERY_LIMIT refused (src/server/live/limitNotice.ts). The shell
// listens on every page, so an admin hears of it wherever they are: a toast
// that opens Admin → Live usage, whose figures are re-read.

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useServerEvent } from '../../api/events';
import { toast } from '../../ui/Toast';

export const LIMIT_CHANNEL = 'live:daily-limit';

/** The toast's sentence, from the push's limit (a figure the server sent; only formatted here). */
export function limitMessage(payload: unknown): string {
  const limit = (payload as { limit?: unknown } | null)?.limit;
  const n = typeof limit === 'number' && Number.isFinite(limit) ? `${limit.toLocaleString()} ` : '';
  return `Live datasets have used today’s ${n}warehouse queries. Until 00:00 UTC their figures come from the cache, labelled stale.`;
}

export function useLiveLimitNotice(): void {
  const client = useQueryClient();
  const navigate = useNavigate();
  useServerEvent(LIMIT_CHANNEL, (payload) => {
    void client.invalidateQueries({ queryKey: ['admin:liveUsage'] });
    toast(limitMessage(payload), { kind: 'error', action: { label: 'See usage', onClick: () => void navigate('/admin?tab=live') } });
  });
}
