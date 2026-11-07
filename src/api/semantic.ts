// Semantic layers (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D11, D14): a connection whose
// connector has the `semantic` capability lists its models, and one is added as a Live dataset. Both are `write`:
// the listing names the layer's models (an origin), so it is shown only where the caller may add one.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const semantic = {
  // The layer's models: name, label, description.
  'connection:semanticModels': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, connId: Uuid }), project: byProjectId }),
  // "Add as dataset": describes the model, saves the record and queues its first sync (which writes the mirror metrics).
  'connection:addSemanticDataset': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, connId: Uuid, model: z.string().min(1).max(512), name: z.string().max(200).optional(), maxCacheAgeSec: z.number().int().optional() }),
    project: byProjectId,
  }),
} as const;
