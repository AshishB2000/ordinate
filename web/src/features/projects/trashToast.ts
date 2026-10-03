// The words every delete and restore ends in (legacy trashPage.ts
// trDeletedToast / trRestoredLine). A record screen's delete (T2.3+: each
// type's own `*:delete`) moves the record to the Trash and calls
// `toastMovedToTrash` with its reply; Undo is the same `trash:restore` the
// Trash page's Restore makes.

import type { QueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { toast } from '../../ui/Toast';
import { plural, type RecordType, type Restored } from './api';

/** "Restored “Revenue by month” — and its dataset “Retail orders”, which was in Trash too". */
export function restoredLine(restored: readonly Restored[]): string {
  const [main, ...rest] = restored;
  if (!main) return 'Restored';
  let line = `Restored “${main.name || 'Untitled'}”`;
  if (main.type === 'visual' && rest[0]?.type === 'dataset') line += ` — and its dataset “${rest[0].name}”, which was in Trash too`;
  else if (main.type === 'dataset' && rest.length) line += ` and ${plural(rest.length, 'visual')} deleted with it`;
  return line;
}

/** "Moved “Orders” and 2 visuals to Trash · Undo". `reply` is the `*:delete` handler's `{ ok, cascaded }`. */
export function toastMovedToTrash(
  client: QueryClient,
  item: { projectId: string; type: RecordType; id: string; name: string },
  reply: { ok?: boolean; cascaded?: number } | null,
): void {
  if (!reply || reply.ok === false) return void toast('Could not delete that.', { kind: 'error' });
  const n = Number(reply.cascaded || 0);
  const what = item.name ? `“${item.name}”` : `the ${item.type}`;
  toast(`Moved ${what}${n ? ` and ${plural(n, 'visual')}` : ''} to Trash`, {
    action: {
      label: 'Undo',
      onClick: () => {
        rpc('trash:restore', { projectId: item.projectId, type: item.type, id: item.id }).then(
          (r) => {
            const res = r as { ok: boolean; error?: string; restored: Restored[] };
            if (res.ok) toast(restoredLine(res.restored), { kind: 'success' });
            else toast(res.error ?? 'Could not restore that.', { kind: 'error' });
            void client.invalidateQueries();
          },
          (err: unknown) => toast(`Could not restore that: ${err instanceof Error ? err.message : String(err)}.`, { kind: 'error' }),
        );
      },
    },
  });
}
