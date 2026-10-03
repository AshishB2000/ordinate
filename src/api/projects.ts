import { z } from 'zod';
import { rpc } from './contract';

export const projects = {
  // preload: invoke('projects:list') — no payload.
  'projects:list': rpc({ access: 'read', input: z.undefined() }),
} as const;
