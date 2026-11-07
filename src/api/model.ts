import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const model = {
  // preload: invoke('model:overview', { projectId }) — the Data model's Datasets tab in one read: every dataset's role, key
  // state, description, always-applied filters and calculated fields, and what to fill in next. Metadata only, never a row.
  // A caller row access rules restrict gets no key count and no quoted value (src/ipc/modelOverview.ts, REDACT).
  'model:overview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
} as const;
