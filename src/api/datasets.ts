import { z } from 'zod';
import { FileToken, rpc, Uuid } from './contract';

export const datasets = {
  // preload: invoke('dataset:list', { projectId })
  'dataset:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }) }),
  // Server form of the file import: the file was uploaded through POST
  // /api/files first; a path or a native dialog never applies on the server.
  // `write`: it consumes the upload and stages a table for a save.
  'dataset:pickAndParse': rpc({
    access: 'write',
    input: z.strictObject({ fileToken: FileToken, sheetName: z.string().min(1).max(255).optional() }),
  }),
} as const;
