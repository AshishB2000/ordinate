// Certified and retired status (semantic layer part 4, D3): read and set by a project ADMIN only. A pin hashes a
// term's values, so it reaches a browser through `model:review` and nowhere else.

import { z } from 'zod';
import { Base, byProjectId, rpc, Uuid } from './contract';

/** `metric:` / `term:` / `dataset:<uuid>`; the store checks the id's shape (statusDocs.parseStatusRef). */
const StatusRef = z.string().regex(/^(metric|term|dataset):[0-9a-fA-F-]{36}$/);
const Note = z.string().max(500);

export const governance = {
  // The Review dialog: the pin of what the admin is looking at (certify takes it back as `base`), its status, and the
  // newest version key to diff `status.versionKey` against. `denials`: reading is not an event.
  'model:review': rpc({ access: 'admin', audit: 'denials', input: z.strictObject({ projectId: Uuid, ref: StatusRef }), project: byProjectId }),
  // Certify what was reviewed: a pin that moved since is 409 record_changed, carrying the current pin as `tag`.
  'model:certify': rpc({
    access: 'admin',
    input: z.strictObject({ projectId: Uuid, ref: StatusRef, base: Base, note: Note.optional() }),
    project: byProjectId,
  }),
  // Retire, optionally naming what replaces it: { ok:false, error, field } when the replacement cannot be one.
  'model:retire': rpc({
    access: 'admin',
    input: z.strictObject({ projectId: Uuid, ref: StatusRef, replacedBy: StatusRef.optional(), note: Note.optional() }),
    project: byProjectId,
  }),
  'model:clearStatus': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid, ref: StatusRef }), project: byProjectId }),
} as const;
