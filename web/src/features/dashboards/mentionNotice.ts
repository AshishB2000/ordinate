// The one app-wide listener for a mention of the signed-in person
// (`mentions:new`, pushed to their tabs only — docs/notifications §5.9): "Ann Lee
// mentioned you on Revenue review", with Open, which marks it seen and opens the
// thread. Mounted by the top bar's bell, beside the paused-subscription notice.
// The route is built here from ids (src/app/threadPath.ts); a push never hands
// the browser a URL to follow.

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { rpc } from '../../api/client';
import { useServerEvent } from '../../api/events';
import { toast } from '../../ui/Toast';
import { threadPath, type ThreadKind } from '../../../../src/app/threadPath.ts';
import { MENTIONS_KEY } from './mentionsApi';

interface Notice {
  projectId?: unknown;
  id?: unknown;
  target?: { kind?: unknown; id?: unknown };
  analysisId?: unknown;
  by?: unknown;
  on?: unknown;
}

const KINDS: ReadonlySet<string> = new Set(['analysis', 'card', 'visual', 'dataset', 'story']);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function useMentionNotice(): void {
  const navigate = useNavigate();
  const client = useQueryClient();
  useServerEvent('mentions:new', (p) => {
    const n = (p ?? {}) as Notice;
    const projectId = str(n.projectId);
    const kind = str(n.target?.kind);
    if (!projectId || !KINDS.has(kind)) return;
    void client.invalidateQueries({ queryKey: MENTIONS_KEY });
    const href = threadPath(projectId, { kind: kind as ThreadKind, id: str(n.target?.id) }, str(n.analysisId) || null);
    toast(`${str(n.by) || 'Someone'} mentioned you on ${str(n.on) || 'a comment'}`, {
      action: href
        ? {
            label: 'Open',
            onClick: () => {
              void rpc('mentions:seen', { projectId, id: str(n.id) }).then(() => client.invalidateQueries({ queryKey: MENTIONS_KEY }));
              void navigate(href);
            },
          }
        : undefined,
    });
  });
}
