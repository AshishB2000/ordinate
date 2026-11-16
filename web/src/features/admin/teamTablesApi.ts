// Admin → Teams → <team> → Tables (docs/team-folders/00-design.md, "Connection tables per team"): the team's ticks on a
// project's connection tables. The server decides what a tick gives (src/server/authz/teamTables.ts); this file holds
// the replies' shapes, the two calls, and how a click changes one connection's ticks — pure, so it is tested alone.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

/** One tick as `teamTables:get` returns it and `:set` takes it: a schema (no `table`) or one table. */
export interface Tick {
  connId: string;
  schema: string;
  table?: string;
  include: boolean;
  hidden: string[];
}

export interface TeamTablesReply {
  ok: true;
  /** The team's role on the project; null: its ticks give nothing until the project is shared with it. */
  role: 'viewer' | 'editor' | 'admin' | null;
  rows: Tick[];
}

type Fail = { ok: false; error: string };

export const GET = 'teamTables:get';

export const useTeamTables = (projectId: string, teamId: string) =>
  useQuery({
    queryKey: [GET, projectId, teamId],
    queryFn: async () => {
      const r = (await rpc(GET, { projectId, teamId })) as TeamTablesReply | Fail;
      if (!r.ok) throw new Error(r.error || 'The team’s tables could not be loaded.');
      return r;
    },
    enabled: !!projectId,
  });

/**
 * Saves one connection's ticks as a whole, and the list is read again (a refusal puts the stored ones back). The
 * caller shows `ticks` from its own state until `onSettled`: a query's update renders a tick later, so a controlled
 * box would flick back first.
 */
export function useSaveTicks(projectId: string, teamId: string) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ connId, ticks }: { connId: string; ticks: Tick[] }) => {
      const rows = ticks.filter((t) => t.connId === connId).map((t) => ({ schema: t.schema, ...(t.table ? { table: t.table } : {}), include: t.include, ...(t.hidden.length ? { hidden: t.hidden } : {}) }));
      const r = (await rpc('teamTables:set', { projectId, teamId, connId, rows })) as { ok: true } | Fail;
      if (!r.ok) throw new Error(r.error || 'The tables could not be saved.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [GET, projectId, teamId] }), // awaited before a call's own onSettled
  });
  return (connId: string, ticks: Tick[], done: { onError: (e: unknown) => void; onSettled: () => void }): void => {
    qc.setQueryData<TeamTablesReply>([GET, projectId, teamId], (old) => old && { ...old, rows: ticks });
    m.mutate({ connId, ticks }, done);
  };
}

/** Writes the viewers' name for a table on its source table doc (creating the doc when it has none). */
export async function saveLabel(projectId: string, connId: string, table: string, docId: string | undefined, label: string): Promise<void> {
  const r = (await rpc('sourceTable:save', docId ? { projectId, connId, docId, patch: { label } } : { projectId, connId, table, patch: { label } })) as { ok: boolean; error?: string };
  if (!r.ok) throw new Error(r.error || 'The name could not be saved.');
}

// ── What a click does, pure ─────────────────────────────────────────────────

const isSchemaRow = (t: Tick, connId: string, schema: string): boolean => t.connId === connId && t.schema === schema && t.table === undefined;
const isTableRow = (t: Tick, connId: string, schema: string, table: string): boolean => t.connId === connId && t.schema === schema && t.table === table;

export interface TableState {
  /** Given to the team: by its own row, or by its schema's. */
  given: boolean;
  /** Its own row says so (an include with hidden columns, or an exclude). */
  own: boolean;
  hidden: string[];
}

export const schemaTicked = (ticks: readonly Tick[], connId: string, schema: string): boolean => ticks.some((t) => isSchemaRow(t, connId, schema) && t.include);

/** A table's tick, by the server's rule: its own row wins over its schema's. */
export function tableState(ticks: readonly Tick[], connId: string, schema: string, table: string): TableState {
  const row = ticks.find((t) => isTableRow(t, connId, schema, table));
  if (row) return { given: row.include, own: true, hidden: row.include ? row.hidden : [] };
  return { given: schemaTicked(ticks, connId, schema), own: false, hidden: [] };
}

/** Ticks a schema on (every table in it, new ones too) or off (its excludes go with it; a table ticked on its own stays). */
export function toggleSchema(ticks: readonly Tick[], connId: string, schema: string, on: boolean): Tick[] {
  const rest = ticks.filter((t) => !isSchemaRow(t, connId, schema) && !(t.connId === connId && t.schema === schema && t.table !== undefined && (on ? t.include && !t.hidden.length : !t.include)));
  return on ? [...rest, { connId, schema, include: true, hidden: [] }] : rest;
}

/** Ticks one table on or off. Under a ticked schema, off is an exclude; on removes it. */
export function toggleTable(ticks: readonly Tick[], connId: string, schema: string, table: string, on: boolean): Tick[] {
  const rest = ticks.filter((t) => !isTableRow(t, connId, schema, table));
  const bySchema = schemaTicked(ticks, connId, schema);
  if (on) return bySchema ? rest : [...rest, { connId, schema, table, include: true, hidden: [] }];
  return bySchema ? [...rest, { connId, schema, table, include: false, hidden: [] }] : rest;
}

/** The columns this team's viewers never read on a given table (none: the schema's tick, or a plain one, is enough). */
export function setHidden(ticks: readonly Tick[], connId: string, schema: string, table: string, hidden: readonly string[]): Tick[] {
  const rest = ticks.filter((t) => !isTableRow(t, connId, schema, table));
  if (!hidden.length && schemaTicked(ticks, connId, schema)) return rest;
  return [...rest, { connId, schema, table, include: true, hidden: [...hidden].sort() }];
}

/** How many tables and schemas a connection has ticked (an exclude is not one). */
export const tickedCount = (ticks: readonly Tick[], connId: string): number => ticks.filter((t) => t.connId === connId && t.include).length;
