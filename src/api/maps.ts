import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// The map data channels (T1.3). The boundary shapes themselves are not an RPC:
// they are static files under /api/geo (src/server/geo.ts).

export const maps = {
  // `visual:data` (every map draws through it) lives in ./visuals.ts with the charts' channel.
  // preload: hubAuthoring.getBoundary(projectId, id, property) — a custom
  // choropleth's own imported shapes, `name` set from the join property.
  'boundary:get': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, id: Uuid, property: z.string().max(200).optional() }),
    project: byProjectId,
  }),
  // preload: hubGeo.resolvePlace(text) — the radius control's "within 25 km of
  // <place>": free text → a place in the bundled offline table. Names no
  // project (the table is the same for everyone), so any org member.
  'geo:resolvePlace': rpc({ access: 'read', org: true, input: z.strictObject({ text: z.string().max(200) }) }),
} as const;
