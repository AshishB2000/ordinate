import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const quality = {
  // preload: invoke('quality:run', { projectId, datasetId }) — runs as a job
  // (progress over SSE) and stores the run on the dataset record, hence write.
  'quality:run': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
} as const;
