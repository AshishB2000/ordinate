import { z } from 'zod';
import { rpc } from './contract';

export const home = {
  // preload: invoke('recent:list', { limit }) — limit is optional (default 50
  // in the handler); Home asks for the default, the palette for 6.
  'recent:list': rpc({
    access: 'read',
    input: z.strictObject({ limit: z.number().int().min(1).max(500).optional() }).optional(),
  }),
} as const;
