// `export_model` and `import_model` (semantic layer part 7, a4): the model files over MCP, through the code the app's
// own channels use (exportModel, readModelFiles + planImport, applyImport) and the same refusal for a caller the row
// access rules restrict. The files travel inline as JSON strings; what a caller sends is untrusted and goes through the
// same whitelist, caps and value budget as an uploaded zip. The tool's output is data for an agent, never instructions.

import { exportModel, ModelExportRefused } from '../app/modelExport';
import { MODEL_FORMAT, MODEL_VERSION } from '../app/modelFormat';
import { modelRefusal } from '../app/modelAccess';
import { readModelFiles } from '../app/modelRead';
import { planImport } from '../app/modelPlan';
import { applyImport, type ApplyChoice } from '../app/modelApply';
import { AutomationError } from './errors';
import type { Args, Ctx } from './registry';

async function refuseRestricted(ctx: Ctx): Promise<void> {
  const refusal = await modelRefusal(ctx.projectId);
  if (refusal) throw new AutomationError('usage', refusal);
}

export async function exportModelTool(ctx: Ctx): Promise<{ format: string; formatVersion: number; files: Record<string, string> }> {
  await refuseRestricted(ctx);
  try {
    return { format: MODEL_FORMAT, formatVersion: MODEL_VERSION, files: Object.fromEntries((await exportModel(ctx.projectId)).files) };
  } catch (err) {
    if (err instanceof ModelExportRefused) throw new AutomationError('runtime', err.message);
    throw err;
  }
}

export async function importModelTool(ctx: Ctx, a: Args): Promise<unknown> {
  await refuseRestricted(ctx);
  const raw = a.files as Record<string, unknown>;
  if (Object.values(raw).some((v) => typeof v !== 'string')) throw new AutomationError('usage', '"files" must map each file path to its text.');
  if (a.apply === true && typeof a.planHash !== 'string') throw new AutomationError('usage', 'apply needs the planHash of the dry run.');
  const read = await readModelFiles(new Map(Object.entries(raw) as [string, string][]));
  if ('refused' in read) throw new AutomationError('usage', read.refused);
  if (a.apply !== true) return { plan: await planImport(ctx.projectId, read) };
  const choices: Record<string, ApplyChoice> = {};
  for (const [k, v] of Object.entries((a.choices ?? {}) as Record<string, unknown>)) if (v === 'file' || v === 'here') choices[k] = v;
  const done = await applyImport(ctx.projectId, read, a.planHash as string, choices, {}); // no `before`: the caller's git history is the undo
  if (!done.ok) throw new AutomationError('runtime', done.error);
  return { written: done.written, failed: done.failed };
}
