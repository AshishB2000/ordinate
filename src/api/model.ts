import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

const DatasetMap = z.record(z.string().max(256), Uuid).refine((o) => Object.keys(o).length <= 500, 'at most 500 semantic models');

export const model = {
  // preload: invoke('model:overview', { projectId }) — the Data model's Datasets tab in one read: every dataset's role, key
  // state, description, always-applied filters and calculated fields, and what to fill in next. Metadata only, never a row.
  // A caller row access rules restrict gets no key count and no quoted value (src/ipc/modelOverview.ts, REDACT).
  'model:overview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('model:navigation', { projectId }) — every dataset's drill hierarchies (levels that are no longer a text column
  // marked `missing`) and the calendar's date ladder. Metadata only; level names, never values (src/ipc/modelNavigation.ts).
  'model:navigation': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // invoke('model:export', { projectId }) — the definitions as a zip of model files (src/ipc/modelFiles.ts): a download
  // token, never a row, origin or secret. An editor's: a caller row access rules restrict is refused (part 7 D7).
  'model:export': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // invoke('model:importPlan', { projectId, fileToken }) — the dry run of importing an uploaded model zip (src/ipc/modelFiles.ts): each
  // object unchanged, updated, renamed, new, in conflict, skipped with why, or only here, and the plan's hash. Writes nothing. An editor's:
  // the plan shows term values and value labels, so a caller row access rules restrict is refused (part 7 D7).
  // `datasetMap` (f1): a dbt semantic model's name → the dataset it is, as the person confirmed it in the dry run.
  'model:importPlan': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, fileToken: FileToken, datasetMap: DatasetMap.optional() }), project: byProjectId }),
  // invoke('model:importApply', { projectId, fileToken, planHash, choices? }) — apply the dry run of the same zip, uploaded again (src/ipc/modelFiles.ts,
  // src/app/modelApply.ts): refused whole when the plan's hash moved, else each object through its editor's own save; `choices` picks a side
  // per conflict (absent: this project's). Replies what was written, what failed, and a download of the model as it was. An editor's, as the plan.
  'model:importApply': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, fileToken: FileToken, planHash: z.string().max(64), choices: z.record(z.string().max(400), z.enum(['file', 'here'])).optional(), datasetMap: DatasetMap.optional() }),
    project: byProjectId,
  }),
} as const;
