// The column rename log (0044_autopilot_usage.sql `column_renames`): every rename the column editor made, with both names, so a
// later repair is exact. Called by `updateDataset` AFTER the dataset was persisted: a logged rename that never landed would
// make a wrong "exact" repair, while a lost entry only degrades to "flagged". Without a database it is a no-op.
// Rare and small, so written straight away (tracked, so a shutdown waits for it) rather than batched.

import { randomUUID } from 'crypto';
import { isValidId } from '../../app/ids';
import { logger } from '../../app/logger';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { trackWork } from '../lifecycle';

export interface Rename {
  from: string;
  to: string;
  /** 'source': the source column was renamed. 'step': a rename_column step was appended (a prepare step reads the column). */
  kind: 'source' | 'step';
}

/**
 * Log one edit's renames, in order. `datasetAt` is the dataset's own updatedAt of that edit: the rows are written on separate
 * connections, so `seq` alone could swap two quick edits (a to b, then b to c); the repair orders by (dataset_at, seq).
 * Never throws and never makes the edit wait.
 */
export function logRenames(projectId: string, datasetId: string, renames: readonly Rename[], datasetAt: string): void {
  if (!renames.length || !orgDb() || !isValidId(projectId) || !isValidId(datasetId) || Number.isNaN(Date.parse(datasetAt))) return;
  const p = (async () => {
    const org = ctx().org.id;
    const edit = randomUUID();
    await inOrg(async (c) => {
      for (const r of renames) {
        await c.query(
          'INSERT INTO column_renames (org_id, project_id, dataset_id, edit_id, kind, old_name, new_name, dataset_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)',
          [org, projectId.toLowerCase(), datasetId.toLowerCase(), edit, r.kind, r.from, r.to, datasetAt],
        );
      }
    }, org);
  })().catch((err: unknown) => logger.warn(`[autopilot] a column rename could not be logged (${String((err as { code?: unknown })?.code ?? 'error')}); a chart using the old name is flagged, not repaired.`));
  trackWork(p);
}

/** One dataset's logged renames, oldest first (the repair and the tests). */
export async function renamesOf(datasetId: string): Promise<Array<Rename & { editId: string; seq: number }>> {
  const org = ctx().org.id;
  const r = await inOrg((c) => c.query<{ from: string; to: string; kind: 'source' | 'step'; editId: string; seq: string }>(
    `SELECT old_name AS "from", new_name AS "to", kind, edit_id::text AS "editId", seq::text AS seq
       FROM column_renames WHERE org_id = $1 AND dataset_id = $2 ORDER BY dataset_at, seq`, [org, datasetId.toLowerCase()]), org);
  return r.rows.map((x) => ({ ...x, seq: Number(x.seq) }));
}
