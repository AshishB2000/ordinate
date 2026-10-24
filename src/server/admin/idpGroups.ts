// Admin → People → "Identity provider groups" (docs/sso-lifecycle/00-design.md
// §3.13, §3.15). The route has already checked the caller is an org admin
// (src/api/admin.ts); every statement names `ctx().org.id`.
//
//   admin:idpGroups    the map, where groups are read from, and what is managed
//   admin:setIdpGroup  map a group to a role and/or a team (both null: remove).
//                      Under the EXCLUSIVE people lock: a team whose links
//                      changed is emptied, then every member with a stored
//                      group list is applied again at once — the team refills
//                      now, and a mapping mistake is fixed without a disable.
// A map is refused while the server reads no groups (`dormant`): it would do nothing.

import type { Pool } from 'pg';
import { ctx, type Role } from '../context';
import type { AuthEnv } from '../env';
import { registry } from '../rpc';
import { canonGroup, readMap, roleManaged, type SyncLog } from '../auth/idpGroups';
import { reapplyAll, reportMany } from '../auth/idpReapply';
import { withPeopleLock } from '../auth/store';
import { logger } from '../../app/logger';

export interface IdpGroupsView {
  readonly mode: AuthEnv['mode'];
  /** Where groups are read, or null: the map is dormant. */
  readonly source: 'oidc' | 'header' | null;
  /** The claim or header name groups are read from. */
  readonly from: string | null;
  readonly roleManaged: boolean;
  readonly groups: { group: string; role: Role | null; teamId: string | null; teamName: string | null }[];
  readonly linkedTeamIds: string[];
}

/** The one logger (../../app/logger), in the shape the sync reports take: inside the request, its lines carry reqId and org. */
const LOG: SyncLog = { warn: (o, msg) => logger.warn(msg, o), error: (o, msg) => logger.error(msg, o) };

export function register(pool: () => Pool | null, auth: () => AuthEnv): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('admin needs Postgres (DATABASE_URL)');
    return p;
  };

  registry.handle('admin:idpGroups', async (): Promise<IdpGroupsView> => {
    const a = auth();
    const org = ctx().org.id;
    const map = await readMap(db(), org);
    const names = await db().query<{ id: string; name: string }>('SELECT id::text, name FROM teams WHERE org_id = $1', [org]);
    const team = new Map(names.rows.map((r) => [r.id, r.name]));
    const from = a.groupsFrom ? ('claim' in a.groupsFrom ? a.groupsFrom.claim : a.groupsFrom.header) : null;
    return {
      mode: a.mode,
      source: a.groupsFrom ? ('claim' in a.groupsFrom ? 'oidc' : 'header') : null,
      from,
      roleManaged: await roleManaged(db(), a, org),
      groups: map.map((m) => ({ ...m, teamName: m.teamId ? team.get(m.teamId) ?? null : null })),
      linkedTeamIds: a.groupsFrom ? [...new Set(map.flatMap((m) => (m.teamId ? [m.teamId] : [])))] : [],
    };
  });

  registry.handle('admin:setIdpGroup', async (_e, input: { group: string; role: Role | null; teamId: string | null }) => {
    const a = auth();
    if (!a.groupsFrom) return { ok: false as const, error: 'dormant' };
    const group = canonGroup(input.group);
    if (!group) return { ok: false as const, error: 'group' };
    const { org: { id: org }, requestId } = ctx();
    const done = await withPeopleLock(db(), org, 'exclusive', async (c) => {
      if (input.teamId && (await c.query('SELECT 1 FROM teams WHERE org_id = $1 AND id = $2', [org, input.teamId])).rowCount !== 1) return null;
      const old = await c.query<{ role: Role | null; teamId: string | null }>('SELECT role, team_id::text AS "teamId" FROM idp_groups WHERE org_id = $1 AND group_name = $2', [org, group]);
      const before = old.rows[0]?.teamId ?? null;
      // The same mapping again: nothing to write, nobody to re-apply (S-M1).
      if ((old.rows[0]?.role ?? null) === input.role && before === input.teamId) return [];
      if (!input.role && !input.teamId) await c.query('DELETE FROM idp_groups WHERE org_id = $1 AND group_name = $2', [org, group]);
      else {
        await c.query(
          `INSERT INTO idp_groups (org_id, group_name, role, team_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, group_name) DO UPDATE SET role = $3, team_id = $4`,
          [org, group, input.role, input.teamId],
        );
      }
      // A team whose links changed holds members no group now vouches for: emptied, then refilled below.
      const changed = before === input.teamId ? [] : [before, input.teamId].filter((t): t is string => !!t);
      if (changed.length) await c.query('DELETE FROM team_members m USING teams t WHERE m.team_id = t.id AND t.org_id = $1 AND t.id = ANY($2::uuid[])', [org, changed]);
      return reapplyAll(c, a, org);
    });
    if (!done) return { ok: false as const, error: 'unknown team' };
    await reportMany(db(), org, done, LOG, requestId);
    return { ok: true as const };
  });
}
