// A bookmarked dataset or dashboard that loaded nothing (docs/team-folders D12): the server's `folder:of` says
// whether it is in a folder the caller cannot open, and then the page says so in the server's words ("This is in
// a folder you can't open.") instead of "not found". Asked only after the page found nothing; it names nothing.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { isFolderRefusal, liveRefusalOf } from './refusal';

/** `sentence`: the server's, when the item is in a folder the caller cannot open. `pending`: still asking. */
export function useFolderClosed(projectId: string, kind: 'dataset' | 'dashboard', id: string, ask: boolean): { pending: boolean; sentence: string | null } {
  const q = useQuery({
    queryKey: ['folder:of', projectId, kind, id],
    queryFn: () => rpc('folder:of', { projectId, kind, id }),
    enabled: ask && !!projectId && !!id,
    retry: false,
  });
  return { pending: ask && q.isPending, sentence: q.data && isFolderRefusal(q.data) ? liveRefusalOf(q.data) : null };
}
