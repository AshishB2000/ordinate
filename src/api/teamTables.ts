import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Connection tables per team (docs/team-folders/00-design.md D19, "Connection tables per team"; src/ipc/teamTables.ts):
// which warehouse tables a team's project viewers may ask the Assistant about, and which of their columns stay hidden.
// Project admins (and org admins) only: who sees which table is no viewer's or editor's business.

/** One tick: a schema (no `table`: its every table, new ones included) or one table, exactly as listTables names them. */
const Row = z.strictObject({
  schema: z.string().max(1_000),
  table: z.string().trim().min(1).max(1_000).optional(),
  include: z.boolean(),
  // On an include table row only: the columns this team's viewers never read.
  hidden: z.array(z.string().min(1).max(256)).max(500).optional(),
});

export const teamTables = {
  // A viewer's Explore picker: the source tables their teams were given that an editor named for viewers and whose columns
  // were read — `{connId, docId, name, live}`, `name` the label alone, never the warehouse name. Empty for an editor
  // (their picker lists `sourceTable:list`). src/ipc/teamTables.ts givenTables.
  'teamTables:mine': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Admin → Teams → <team> → Tables: the team's ticks on the project and its role there (without one, its ticks give nothing).
  'teamTables:get': rpc({ access: 'admin', audit: 'denials', input: z.strictObject({ projectId: Uuid, teamId: Uuid }), project: byProjectId }),
  // The team's ticks on ONE connection, replaced as a whole (at most 2,000 a team and connection). Audited as every admin call is.
  'teamTables:set': rpc({
    access: 'admin',
    input: z.strictObject({ projectId: Uuid, teamId: Uuid, connId: Uuid, rows: z.array(Row).max(2_000) }),
    project: byProjectId,
  }),
} as const;
