// How many people a page shows folder content to that they could not open in Ordinate (docs/team-folders, "Publish,
// `/p/`, embeds and exports"; D17): the Publish and embed dialogs' "Shows data from folders N people can't open". The
// per-person rule is the move warning's (folderPeople.levelAt over folderMove.worldOf, held to the resolver). Counts
// only, never an address.

import { inOrg, orgDb } from '../db/inOrg';
import type { PlacedKind } from './folders';
import { levelAt } from './folderPeople';
import { rootId, worldOf } from './folderMove';

/**
 * Project members folders restrict (not admins, a project role) who cannot open at least one of `items`' folders: the
 * dashboards on a page and the datasets they read. 0 without Postgres, or when every item is in Everyone (one query).
 */
export async function outsideCount(projectId: string, items: ReadonlyArray<{ kind: PlacedKind; id: string }>): Promise<number> {
  if (!orgDb() || !items.length) return 0;
  const p = projectId.toLowerCase();
  return inOrg(async (c, org) => {
    const folders = (await c.query<{ folder_id: string }>(
      `SELECT DISTINCT folder_id::text AS folder_id FROM folder_items
        WHERE org_id = $1 AND project_id = $2 AND (kind, item_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
      [org, p, items.map((i) => i.kind), items.map((i) => i.id.toLowerCase())],
    )).rows;
    if (!folders.length) return 0;
    const w = await worldOf(c, org, p);
    const roots = [...new Set(folders.map((f) => rootId(p, f.folder_id.toLowerCase(), w)))];
    return w.members.filter((m) => roots.some((r) => levelAt(m, r, p, r ? w.grants.get(r) ?? [] : []) === 'none')).length;
  });
}
