import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** What can sit in the Trash (src/app/recordKinds.ts RECORD_TYPES). */
const RecordType = z.enum(['dataset', 'visual', 'dashboard', 'metric', 'report', 'alert']);
const Entry = z.strictObject({ projectId: Uuid, type: RecordType, id: Uuid });

// The Trash (T2.2, src/ipc/trash.ts). Deleting a record moves it here (each
// record type's own `*:delete`); the server's tick purges it after 30 days.
// Restoring is an edit (`write`); deleting for good — one item or all —
// cannot be undone, so it is the project admin's.
export const trash = {
  // preload: invoke('trash:list', { projectId })
  'trash:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('trash:restore', { projectId, type, id })
  'trash:restore': rpc({ access: 'write', input: Entry, project: byProjectId }),
  // preload: invoke('trash:purge', { projectId, type, id })
  'trash:purge': rpc({ access: 'admin', input: Entry, project: byProjectId }),
  // preload: invoke('trash:empty', { projectId })
  'trash:empty': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
} as const;
