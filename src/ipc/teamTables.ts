// Connection tables per team, managed (docs/team-folders/00-design.md D19; 0036) — MAIN PROCESS.
//
//   teamTables:get   a team's ticks on a project, and the team's role there (null: its ticks give nothing)
//   teamTables:set   the team's ticks on one connection, replaced in one transaction
//   teamTables:mine  a viewer's own given, labelled tables, by label (Explore's picker)
//
// The first two are project ADMIN channels (src/api/teamTables.ts); `mine` is `read`, and names only labels. What the rows decide is ../server/authz/teamTables.ts; the
// screen is Admin → Teams → <team> → Tables (web/src/features/admin/TeamTables.tsx). A tick names the schema and the
// table exactly as `connection:listTables` returned them; nothing here reads the warehouse.

import { ipcMain } from './bus';
import { ctx } from '../server/context';
import { inOrg, orgDb } from '../server/db/inOrg';
import * as connections from '../connectors/connections';
import { connectionGone } from '../app/sourceTableMessages';
import * as say from '../server/teamTableMessages';
import { getConnector, isLiveOffered } from '../connectors';
import { readSourceIndexes } from '../app/sourceTables';
import { seesSourceNames } from '../data/sourceNames';
import { givenConnections, givenOn, tableAccess } from '../server/authz/teamTables';

export interface TickRow { schema: string; table?: string; include: boolean; hidden: string[] }
type Role = 'viewer' | 'editor' | 'admin';

/** One row per schema and table (the last wins), `hidden` only on an include table row, trimmed and distinct. */
export function tidyRows(rows: ReadonlyArray<{ schema: string; table?: string; include: boolean; hidden?: readonly string[] }>): TickRow[] {
  const by = new Map<string, TickRow>();
  for (const r of rows) {
    const table = r.table?.trim() || undefined;
    const hidden = r.include && table ? [...new Set((r.hidden ?? []).map((c) => c.trim()).filter(Boolean))].sort() : [];
    by.set(`${r.schema}\0${table ?? ''}`, { schema: r.schema, ...(table ? { table } : {}), include: r.include, hidden });
  }
  return [...by.values()];
}

async function teamRole(projectId: string, teamId: string): Promise<{ exists: boolean; role: Role | null }> {
  return inOrg(async (c, org) => {
    const r = await c.query<{ role: Role | null }>(
      `SELECT (SELECT g.role FROM project_grants g WHERE g.org_id = t.org_id AND g.project_id = $2 AND g.team_id = t.id) AS role
         FROM teams t WHERE t.org_id = $1 AND t.id = $3`,
      [org, projectId, teamId],
    );
    return { exists: r.rowCount === 1, role: r.rows[0]?.role ?? null };
  });
}

/** A table Explore offers a viewer: its doc, its connection, the label it is read by, and whether it is asked live. */
export interface GivenTable { connId: string; docId: string; name: string; live: boolean }

/**
 * The source tables the caller's teams were given that an editor named and whose columns were read (what `sourceView`
 * lets them answer from), by label: the indexes of the connections their teams named, in one read, and each such
 * connection once. None for an editor (their picker is `sourceTable:list`) or a viewer given nothing (no read).
 */
export async function givenTables(projectId: string): Promise<GivenTable[]> {
  if (await seesSourceNames(projectId)) return [];
  const given = await givenOn(projectId);
  const conns = givenConnections(given);
  if (!conns.length) return [];
  const out: GivenTable[] = [];
  for (const [connId, entries] of await readSourceIndexes(projectId, conns)) {
    const picked = entries.filter((e) => e.label && e.readAt && tableAccess(given, connId, e.table));
    const conn = picked.length ? await connections.getConnection(projectId, connId) : null;
    if (!conn) continue;
    const live = isLiveOffered(getConnector(conn.connectorId), conn.values);
    for (const e of picked) out.push({ connId, docId: e.docId, name: e.label as string, live });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.docId.localeCompare(b.docId));
}

export function register(): void {
  ipcMain.handle('teamTables:mine', async (_e, { projectId }: { projectId: string }) => ({ ok: true, tables: await givenTables(projectId) }));

  ipcMain.handle('teamTables:get', async (_e, { projectId, teamId }: { projectId: string; teamId: string }) => {
    if (!orgDb()) return { ok: false, error: say.teamTablesNeedDatabase() };
    const team = await teamRole(projectId, teamId);
    if (!team.exists) return { ok: false, error: say.teamTablesTeamGone() };
    const rows = await inOrg(async (c, org) => (await c.query<{ conn_id: string; schema: string; table_name: string | null; include: boolean; hidden: string[] }>(
      `SELECT conn_id::text AS conn_id, schema, table_name, include, hidden FROM team_tables
        WHERE org_id = $1 AND project_id = $2 AND team_id = $3 ORDER BY conn_id, schema, table_name NULLS FIRST`,
      [org, projectId, teamId],
    )).rows);
    return {
      ok: true,
      role: team.role,
      rows: rows.map((r) => ({ connId: r.conn_id, schema: r.schema, ...(r.table_name !== null ? { table: r.table_name } : {}), include: r.include, hidden: r.hidden })),
    };
  });

  ipcMain.handle('teamTables:set', async (_e, { projectId, teamId, connId, rows }: { projectId: string; teamId: string; connId: string; rows: TickRow[] }) => {
    if (!orgDb()) return { ok: false, error: say.teamTablesNeedDatabase() };
    if (!(await connections.getConnection(projectId, connId))) return { ok: false, error: connectionGone() };
    if (!(await teamRole(projectId, teamId)).exists) return { ok: false, error: say.teamTablesTeamGone() };
    const tidy = tidyRows(rows);
    const by = ctx().user.email;
    await inOrg(async (c, org) => {
      await c.query('DELETE FROM team_tables WHERE org_id = $1 AND project_id = $2 AND team_id = $3 AND conn_id = $4', [org, projectId, teamId, connId]);
      if (!tidy.length) return;
      await c.query(
        `INSERT INTO team_tables (org_id, project_id, team_id, conn_id, schema, table_name, include, hidden, granted_by)
         SELECT $1, $2, $3, $4, u.schema, u.table_name, u.include, coalesce((SELECT array_agg(h) FROM jsonb_array_elements_text(u.hidden) AS h), '{}'), $5
           FROM unnest($6::text[], $7::text[], $8::bool[], $9::jsonb[]) AS u(schema, table_name, include, hidden)`,
        [org, projectId, teamId, connId, by, tidy.map((r) => r.schema), tidy.map((r) => r.table ?? null), tidy.map((r) => r.include), tidy.map((r) => JSON.stringify(r.hidden))],
      );
    });
    return { ok: true, rows: tidy.length };
  });
}
