import { z } from 'zod';
import { rpc, Uuid } from './contract';

export const datasets = {
  // preload: invoke('dataset:list', { projectId })
  'dataset:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }) }),
} as const;
