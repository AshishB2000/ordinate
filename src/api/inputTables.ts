import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';
import { Cell } from './datasets';

// Input tables (src/ipc/input.ts → src/data/inputTable/): a small dataset
// typed in the app. Shapes are bounded here; the store re-checks every
// definition (columns.checkColumns) and replays every batch over the STORED
// table (edits.applyBatch), refusing anything malformed.

const Column = z.strictObject({
  name: z.string().max(100),
  type: z.enum(['text', 'number', 'date']),
  required: z.boolean().optional(),
  lookup: z.strictObject({ datasetId: Uuid, column: z.string().max(200) }).optional(),
});
const Columns = z.array(Column).max(50);

const Index = z.number().int().min(0).max(1_000_000);
const Block = z.array(z.array(Cell).max(50)).max(10_000);
const Op = z.union([
  z.strictObject({ t: z.literal('set'), r: Index, c: Index, cells: Block }),
  z.strictObject({ t: z.literal('ins'), at: Index, rows: Block }),
  z.strictObject({ t: z.literal('del'), at: Index, n: Index }),
]);
/** One user action — edits.ts `Batch`. */
const Batch = z.strictObject({ label: z.string().max(200), ops: z.array(Op).max(20_000) });

const Table = z.strictObject({ projectId: Uuid, id: Uuid });

export const inputTables = {
  // New dataset → Input table: a name and the column definitions.
  'input:create': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, name: z.string().max(120), columns: Columns }), project: byProjectId }),
  // The table as the grid shows it, and what is wrong with it.
  'input:load': rpc({ access: 'read', input: Table, project: byProjectId }),
  // The batches made since the last save; the reply is the stored table and its check.
  'input:save': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid, batches: z.array(Batch).min(1).max(500) }),
    project: byProjectId,
  }),
  // Edit columns: new definitions, each with the index of the column it came from (-1 = new).
  'input:setColumns': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid, columns: Columns, from: z.array(z.number().int().min(-1).max(49)).max(50) }),
    project: byProjectId,
  }),
  // The lookup pickers: every other dataset of the project with its typed columns.
  'input:lookups': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid.optional() }), project: byProjectId }),
} as const;
