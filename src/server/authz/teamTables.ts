// Connection tables per team (docs/team-folders/00-design.md D19, "Connection tables per team"; 0036): which documented
// warehouse tables a project VIEWER may ask about, and which of their columns stay hidden from them. The rule, in full:
//
//   a team gives table X   its table row for X says include (hidden: that row's columns), or it has no table row for X
//                          and an include row for X's schema (nothing hidden). A table row always wins.
//   a person is given X    some team they are in, holding a role on the project, gives X. Hidden from them: the
//                          columns EVERY such giving team hides (most permissive wins, as Metabase's groups add up).
//
// Editors and admins answer from every table (phase D): nothing here is asked for them. Nothing is ticked by default.
// Names are exact, never case-folded (D2); a column is hidden case-insensitively (a hide, never a leak). A documented
// table's name is listTables' entry qualified (`schema.name`); its schema is what comes before its last dot, so a
// name with a dot of its own reads as a schema nobody ticked: a hide.
//
// Step 3's index finds a given table by the same rule in its WHERE (../assistantSearchIndex `givenSql`): a viewer row
// carries `tableKey` and `schemaKey`, the caller's `givenKeys` are passed in, and scripts/test-teamTables.ts holds the
// two to each other. Fail closed: a database error THROWS (the request is refused). Memoised per request.

import { createHash } from 'crypto';
import { ctx, orgKey } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { callerOn } from './caller';

export interface TeamTableRow {
  teamId: string;
  connId: string;
  /** '' for a source with no schemas. */
  schema: string;
  /** Null: the whole schema, tables added later included. */
  table: string | null;
  include: boolean;
  /** Include table rows only. */
  hidden: readonly string[];
}

/** One team's ticks, by `conn\0table` (null: excluded) and `conn\0schema`. */
interface TeamTicks { tables: Map<string, ReadonlySet<string> | null>; schemas: Set<string> }
/** What the caller's teams give, team by team: the rule is applied per team, then united. */
export interface Given { readonly teams: readonly TeamTicks[] }

export const NOTHING: Given = Object.freeze({ teams: Object.freeze([]) });

/** listTables' entry as a documented table names it (the web's `qualify`). */
export const qualify = (schema: string, table: string): string => (schema ? `${schema}.${table}` : table);
/** The schema a documented table's name sits in. */
export const schemaOf = (table: string): string => {
  const i = table.lastIndexOf('.');
  return i < 0 ? '' : table.slice(0, i);
};

const hashed = (tag: string, s: string): string => tag + createHash('sha256').update(s).digest('base64url').slice(0, 22);
/** Step 3's index key of a documented table of a connection (0028 `keys`). Never a name: a hash, so it fits a GIN entry. */
export const tableKey = (connId: string, table: string): string => hashed('tbl:', `${connId.toLowerCase()}\0${table}`);
/** …and of its schema. */
export const schemaKey = (connId: string, schema: string): string => hashed('sch:', `${connId.toLowerCase()}\0${schema}`);

const at = (connId: string, name: string): string => `${connId.toLowerCase()}\0${name}`;

/** The rows as the rule reads them. Two table rows naming one table (a dotted name): an exclude wins. Pure. */
export function givenFrom(rows: readonly TeamTableRow[]): Given {
  const byTeam = new Map<string, TeamTicks>();
  for (const r of rows) {
    const team = byTeam.get(r.teamId) ?? { tables: new Map(), schemas: new Set<string>() };
    byTeam.set(r.teamId, team);
    if (r.table === null) {
      if (r.include) team.schemas.add(at(r.connId, r.schema));
      continue;
    }
    const k = at(r.connId, qualify(r.schema, r.table));
    const had = team.tables.get(k);
    const hidden = new Set(r.hidden.map((c) => c.toLowerCase()));
    team.tables.set(k, !r.include || had === null ? null : had ? new Set([...had].filter((c) => hidden.has(c))) : hidden);
  }
  return { teams: [...byTeam.values()] };
}

/** Is `table` of `connId` given to the caller, and which columns (lowercased) stay hidden? Null: not given. Pure. */
export function tableAccess(given: Given, connId: string, table: string): { hidden: ReadonlySet<string> } | null {
  const k = at(connId, table);
  const s = at(connId, schemaOf(table));
  const giving: ReadonlySet<string>[] = [];
  for (const t of given.teams) {
    const row = t.tables.get(k);
    const gives = row !== undefined ? row : t.schemas.has(s) ? new Set<string>() : null;
    if (gives) giving.push(gives);
  }
  if (!giving.length) return null;
  const [first, ...rest] = giving;
  return { hidden: new Set([...first].filter((c) => rest.every((g) => g.has(c)))) };
}

/**
 * The index's half of the rule (../assistantSearchIndex `givenSql`): a viewer row is found when its keys meet `keys`
 * and none of `denied` — `keys` the tables a table row gives and the schemas a schema row gives, `denied` every table
 * some team names that the caller is not given (an exclude no other team overrides). Pure.
 */
export function givenKeys(given: Given): { keys: string[]; denied: string[] } {
  const keys = new Set<string>();
  const named = new Set<string>();
  for (const t of given.teams) {
    for (const s of t.schemas) keys.add(keyOf(s, schemaKey));
    for (const [k, v] of t.tables) {
      named.add(k);
      if (v) keys.add(keyOf(k, tableKey));
    }
  }
  const denied: string[] = [];
  for (const k of named) if (!keyOf(k, (conn, table) => tableAccess(given, conn, table))) denied.push(keyOf(k, tableKey));
  return { keys: [...keys].sort(), denied: denied.sort() };
}

/** The connections the caller's teams named a schema or a table of (an exclude's too): where a given table can be. */
export const givenConnections = (given: Given): string[] =>
  [...new Set(given.teams.flatMap((t) => [...t.tables.keys(), ...t.schemas].map((k) => k.slice(0, k.indexOf('\0')))))].sort();

function keyOf<T>(k: string, make: (connId: string, name: string) => T): T {
  const i = k.indexOf('\0');
  return make(k.slice(0, i), k.slice(i + 1));
}

// ── The rows of the caller's teams ───────────────────────────────────────────

const memo = new WeakMap<object, Map<string, Promise<Given>>>();

/**
 * What the caller's teams give on `projectId`: only the teams that hold a role on the project count (a team with no
 * project role gets nothing from its ticks). No query for a caller in no team, or without a database: nothing.
 * Asked only for a caller who does not see source names (a project viewer); editors read every table.
 */
export function givenOn(projectId: string): Promise<Given> {
  const p = projectId.toLowerCase();
  const store = ctx() as object;
  let inner = memo.get(store);
  if (!inner) memo.set(store, (inner = new Map()));
  const key = orgKey(`${ctx().user.email}\u0000${p}`);
  let hit = inner.get(key);
  if (!hit) {
    hit = read(p);
    inner.set(key, hit);
    const m = inner;
    hit.catch(() => m.delete(key)); // a failed lookup is not remembered as an answer
  }
  return hit;
}

async function read(projectId: string): Promise<Given> {
  const teams = (await callerOn(projectId)).teamIds;
  if (!teams.length || !orgDb()) return NOTHING;
  const rows = await inOrg(async (c, org) => (await c.query<{ team_id: string; conn_id: string; schema: string; table_name: string | null; include: boolean; hidden: string[] }>(
    `SELECT t.team_id::text AS team_id, t.conn_id::text AS conn_id, t.schema, t.table_name, t.include, t.hidden
       FROM team_tables t
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.team_id = ANY($3::uuid[])
        AND EXISTS (SELECT 1 FROM project_grants g WHERE g.org_id = t.org_id AND g.project_id = t.project_id AND g.team_id = t.team_id)`,
    [org, projectId, teams],
  )).rows);
  return rows.length ? givenFrom(rows.map((r) => ({ teamId: r.team_id, connId: r.conn_id, schema: r.schema, table: r.table_name, include: r.include, hidden: r.hidden }))) : NOTHING;
}
