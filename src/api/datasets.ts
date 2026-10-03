import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

export const datasets = {
  // preload: invoke('dataset:list', { projectId })
  'dataset:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Server form of the file import: the file was uploaded through POST
  // /api/files first; a path or a native dialog never applies on the server.
  // `write`: it consumes the upload and stages a table for a save. Org-level:
  // the upload names no project yet (the save that follows does).
  'dataset:pickAndParse': rpc({
    access: 'write',
    org: true,
    input: z.strictObject({ fileToken: FileToken, sheetName: z.string().min(1).max(255).optional() }),
  }),
} as const;
