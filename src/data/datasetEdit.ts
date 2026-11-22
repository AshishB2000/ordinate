// Edit a dataset's column definitions (names and types): the column editor's write, split out of datasets.ts (file size).
// datasets.ts re-exports `updateDataset`, so every caller keeps `datasets.updateDataset`.

import * as fs from 'fs';
import { coerceValue } from './parse';
import type { ParsedColumn } from './parse';
import * as transforms from './transforms';
import type { Dataset } from './datasets';
import { getDataset, persist } from './datasets';
import { datasetsDir } from './datasetRecord';
import { resolveColumnEdit } from './columnEdit';
import { logRenames } from '../server/autopilot/renames';
import { applyPipelineAsync } from './regexOffThread';
import { saltForSteps } from '../app/privacyStore';
import { loadStepRefs } from './stepRefs';
import { isValidId } from '../app/ids';
import type { TableData } from './transforms';

// Edit a dataset's column DEFINITIONS: rename columns and/or correct types.
// `patch.columns` is the FULL new columns array, in the order the SHOWN (prepared) columns have.
// A renamed column needs no cell work; a column whose TYPE changed has all its
// cells re-coerced through parse.coerceValue (text→number parses / nulls
// non-numeric, number→text keeps the digits, etc). Bumps updatedAt. Returns null
// if either id is invalid or the dataset does not exist. A column-count mismatch
// is clamped defensively (extra patch columns ignored, missing ones kept).
export async function updateDataset(
  projectId: string,
  id: string,
  patch: { columns?: ParsedColumn[] },
): Promise<Dataset | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getDataset(projectId, id);
  if (!existing) return null;

  const incoming = Array.isArray(patch.columns) ? patch.columns : null;
  if (!incoming) return existing; // nothing to change

  // Edit the SOURCE when a pipeline exists (so the change survives the next
  // recompute and the invariant output === applyPipeline(source, steps) holds);
  // otherwise the stored columns/rows. The patch is indexed against the SHOWN
  // (prepared) columns and resolved by name (./columnEdit.ts): a step-made
  // column's rename becomes a rename_column step; its retype is refused.
  const base: TableData = existing.source ?? { columns: existing.columns, rows: existing.rows };
  const width = base.columns.length;
  const { columns: newColumns, addSteps, renames } = resolveColumnEdit(existing.columns, base.columns, incoming, existing.source !== undefined ? existing.steps ?? [] : null);
  const steps = addSteps.length ? transforms.sanitizeSteps([...(existing.steps ?? []), ...addSteps]) : existing.steps;

  // Re-coerce only the columns whose type actually changed (cheap; a pure rename
  // skips the rows rewrite).
  const retyped: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (newColumns[c].type !== base.columns[c].type) retyped.push(c);
  }
  let baseRows = base.rows;
  if (retyped.length > 0) {
    baseRows = base.rows.map((row) => {
      const out = row.slice();
      for (const c of retyped) out[c] = coerceValue(row[c] ?? null, newColumns[c].type);
      return out;
    });
  }

  const now = new Date().toISOString();
  let updated: Dataset;
  if (existing.source !== undefined) {
    const source: TableData = { columns: newColumns, rows: baseRows };
    const salt = await saltForSteps(projectId, steps);
    const output = await applyPipelineAsync(source, steps ?? [], { salt, ...(await loadStepRefs(projectId, id, steps)) });
    updated = {
      ...existing, source, steps, columns: output.columns, rows: output.rows,
      rowCount: output.rowCount, stepCounts: output.stepCounts, updatedAt: now,
    };
  } else {
    updated = { ...existing, columns: newColumns, rows: baseRows, rowCount: baseRows.length, updatedAt: now };
  }
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await persist(projectId, updated);
  logRenames(projectId, id, renames, now); // after it landed: a logged rename that did not would repair wrongly
  return updated;
}

