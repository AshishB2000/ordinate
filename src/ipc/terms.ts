// Glossary terms IPC (semantic D10–D12) — list, get, save, update, delete a Term (../analysis/terms).
//
// A term is a filter with a name, and its filter values can name rows ("customer in Acme, Initech"):
// a caller restricted by row access rules on the project gets every step without `value`, `values` or
// `radius`, the flag `valuesHidden`, a definition that writes "…" for them, and the tag of what it was
// sent (D12, the same rule as D6). Its names and description are everyone's. The figures a term changes
// are the doors' business (../analysis/termExpand), never this file's.

import { ipcMain } from './bus';
import * as terms from '../analysis/terms';
import type { Term } from '../analysis/terms';
import * as datasets from '../data/datasets';
import * as versions from '../app/versions';
import * as trash from '../app/trash';
import { restrictedOn } from '../data/rowAccess';
import { tagForCaller } from './rowDoors';
import { contentTag, isRecordChanged } from '../app/editConflict';
import type { FilterStep } from '../data/transforms';
import type { FactTerm } from '../ai/termFacts';
import { withheldColumns } from '../ai/columnNotes';
import { assistantColumnDocs } from '../app/sharePolicy';

/** A term as `projectId`'s caller may read it: unchanged, or (restricted) every filter value left out. */
export async function termForCaller(projectId: string, t: Term): Promise<Term & { valuesHidden?: true }> {
  if (!(await restrictedOn(projectId))) return t;
  const filters = t.filters.map((s) => {
    const { value: _v, values: _vs, radius: _r, ...rest } = s;
    return rest as FilterStep;
  });
  return { ...t, filters, valuesHidden: true };
}

/** Every term with its dataset's name and its definition in words — without values for a restricted caller. */
async function listForCaller(projectId: string) {
  const hide = await restrictedOn(projectId);
  const names = new Map<string, string>();
  const out = [];
  for (const t of await terms.listFullTerms(projectId)) {
    if (!names.has(t.datasetId)) names.set(t.datasetId, (await datasets.getDatasetMeta(projectId, t.datasetId))?.name ?? '');
    out.push({ ...terms.toSummary(t), datasetName: names.get(t.datasetId) || null, definition: terms.describeTermFilters(t, () => hide) });
  }
  return out;
}

/**
 * The glossary terms of `datasetId` as the Assistant's FACTS state them (../ai/termFacts termLines): a value is
 * written as "…" for a caller row access rules restrict, and for a column marked personal or financial.
 */
export async function termFactsFor(projectId: string, datasetId: string): Promise<FactTerm[]> {
  const own = (await terms.listFullTerms(projectId)).filter((t) => t.datasetId === datasetId);
  if (!own.length) return [];
  const hideAll = await restrictedOn(projectId);
  const withheld = withheldColumns(await assistantColumnDocs(projectId, datasetId));
  return own.map((t) => ({
    name: t.name, aliases: t.aliases, ...(t.description ? { description: t.description } : {}),
    definition: terms.describeTermFilters(t, (s) => hideAll || withheld.has(s.column)),
  }));
}

export function register(): void {
  ipcMain.handle('term:list', async (_e, { projectId }: { projectId: string }) => ({ ok: true, terms: await listForCaller(projectId) }));

  ipcMain.handle('term:get', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const t = await terms.readTerm(projectId, id);
    if (!t) return { ok: false, error: 'Glossary term not found' };
    const term = await termForCaller(projectId, t.rec);
    return { ok: true, term, tag: await tagForCaller(projectId, 'term', term, t.tag) }; // tag: the term dialog's base
  });

  ipcMain.handle('term:save', async (_e, { projectId, input }: { projectId: string; input: terms.TermInput }) => {
    const problem = await terms.termProblem(projectId, input);
    if (problem) return { ok: false, ...problem };
    const t = await terms.saveTerm(projectId, input);
    if (!t) return { ok: false, error: 'Could not save the term. Check the dataset still exists.', field: 'datasetId' };
    await versions.record(projectId, 'term', t);
    return { ok: true, term: t };
  });

  // `base`: the dialog's content tag — a stale copy is 409 record_changed (../app/editConflict); `tag` is the next base.
  ipcMain.handle('term:update', async (_e, { projectId, id, base, patch }: { projectId: string; id: string; base?: string; patch: Partial<terms.TermInput> }) => {
    try {
      const before = await terms.getTerm(projectId, id);
      if (!before) return { ok: false, error: 'Glossary term not found' };
      const problem = await terms.termProblem(projectId, { ...patch, aliases: patch.aliases ?? (patch.name !== undefined ? before.aliases : undefined), datasetId: before.datasetId }, id);
      if (problem) return { ok: false, ...problem };
      const t = await terms.updateTerm(projectId, id, patch, base);
      if (!t) return { ok: false, error: 'Glossary term not found' };
      await versions.record(projectId, 'term', t, { before });
      return { ok: true, term: t, tag: contentTag('term', t) };
    } catch (err) {
      if (isRecordChanged(err)) throw err; // the route's 409
      return { ok: false, error: (err as Error)?.message || 'Failed to update the term' };
    }
  });

  ipcMain.handle('term:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const done = await trash.trashRecord(projectId, 'term', id); // to the Trash
    return done.ok ? { ok: true } : { ok: false, error: 'Could not delete the term' };
  });
}
