// The map data hook: one `visual:data` call for one map. The reply's figures
// are the server's (vizData / mapData / geoAgg); nothing here touches them.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import type { MapData } from './types';

export type MapDataInput = RpcInput<'visual:data'>;

/** What `visual:data` answers: the map's data, or the reason it has none ("No latitude and longitude columns…"). */
export type MapReply = { ok: true; data: MapData; warnings?: string[] } | { ok: false; error: string };

export function useMapData(input: MapDataInput | undefined) {
  return useQuery({
    queryKey: ['visual:data', input],
    queryFn: input === undefined ? skipToken : async () => (await rpc('visual:data', input)) as MapReply,
  });
}
