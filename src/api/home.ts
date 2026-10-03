import { z } from 'zod';
import { onlyReadable, rpc } from './contract';

export const home = {
  // preload: invoke('recent:list', { limit }) — limit is optional (default 50
  // in the handler); Home asks for the default, the palette for 6. Spans the
  // org's projects, so it is trimmed to the ones the caller may read.
  'recent:list': rpc({
    access: 'read',
    org: true,
    input: z.strictObject({ limit: z.number().int().min(1).max(500).optional() }).optional(),
    visible: onlyReadable('projectId'),
  }),
} as const;
