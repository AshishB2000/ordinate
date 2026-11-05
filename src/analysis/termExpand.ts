// Glossary terms at the figure doors (semantic D10–D11). Every figure entry calls this on its filter
// list FIRST — before the row lock, the gates that read the filters, the Live split and the answer
// cache — and uses what it returns from there on. A kept step is a reference: no engine may skip it
// (the figure would widen) and no lock may drop it (rowAccess.withLockSteps keeps filters and terms only).
//
// A term step becomes its term's filter steps, in place, never marked `fromControl` (a term's own dates
// are a fixed filter: no date control moves them). A term on ANOTHER dataset filters that table: each
// step carries `datasetId`, which only the join planner applies (joinPlan.resolveColumnOwner) and every
// single-table engine refuses — it never filters this table's same-named column. A deleted term, one
// this figure cannot reach and one whose column is gone are refused with a sentence that names them;
// a term from a dashboard's scope (`fromControl`) that does not apply here is left out with a note.
// Any other step that is not a plain filter (a newer release's) refuses, unreadable.

import type { FilterStep } from '../data/transforms';
import type { AnswerSpec } from '../ai/answerSpec';
import { hasTermType, isTermStep, TermNotExpandedError } from '../data/termStep';
import type { TermStep } from '../data/termStep';
import * as msg from '../data/termMessages';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import * as trashStore from '../app/trashStore';
import { getTerm } from './terms';
import { reaches } from '../ipc/relationships';

export interface TermExpansion {
  steps: FilterStep[];
  /** What the figure says about the dashboard terms it left out (`termNotApplied`), once each. */
  notes: string[];
}

/** The keys a term step of this release has: one with any other is a newer release's, and is not guessed at. */
const TERM_KEYS = new Set(['type', 'term', 'fromControl']);

/** The refusal for a term this figure cannot use, or the note when it came from a dashboard's scope. */
function notApplied(s: TermStep, reason: 'unreachable' | 'column_gone', sentence: string, name: string, dsName: string, notes: string[]): void {
  if (s.fromControl !== true) throw new TermNotExpandedError(reason, sentence);
  const note = msg.termNotApplied(name, dsName);
  if (!notes.includes(note)) notes.push(note);
}

// shortcut: one record read per term per figure, no memo; add a request-scoped memo if traces show it
async function expandOne(projectId: string, datasetId: string, s: TermStep, out: FilterStep[], notes: string[]): Promise<void> {
  const term = await getTerm(projectId, s.term); // read every time: an edit on any pod changes the next figure
  if (!term) {
    const trashed = await trashStore.readEntry(projectId, 'term', s.term);
    const name = trashed && typeof trashed.name === 'string' && trashed.name.trim() ? trashed.name : '';
    throw new TermNotExpandedError('deleted', name ? msg.termDeleted(name) : msg.termPurged());
  }
  const here = await datasets.getDatasetMeta(projectId, datasetId);
  const own = term.datasetId === datasetId;
  const meta = own ? here : await datasets.getDatasetMeta(projectId, term.datasetId);
  const hereName = here?.name ?? '';
  const termDsName = meta?.name ?? '';
  // Another table: never on a Live figure (no joins there), and only along the data model's safe hops.
  if (!own && (!meta || !here || isLive(here) || isLive(meta) || !(await reaches(projectId, datasetId, term.datasetId)))) {
    return notApplied(s, 'unreachable', msg.termUnreachable(term.name, termDsName || term.name, hereName), term.name, hereName, notes);
  }
  const columns = new Set((meta?.columns ?? []).map((c) => c.name));
  const gone = term.filters.find((f) => !columns.has(f.column));
  if (gone) return notApplied(s, 'column_gone', msg.termColumnGone(term.name, gone.column, termDsName), term.name, hereName, notes);
  for (const f of term.filters) out.push(own ? { ...f } : { ...f, datasetId: term.datasetId });
}

/** `steps` with every term expanded, and the notes of the dashboard terms left out; or the typed refusal. */
export async function expandTerms(projectId: string, datasetId: string, steps: readonly FilterStep[] | undefined): Promise<TermExpansion> {
  const list = steps ?? [];
  if (list.every((s) => s && s.type === 'filter')) return { steps: [...list], notes: [] }; // no term: no read
  const out: FilterStep[] = [];
  const notes: string[] = [];
  for (const s of list) {
    if (s && s.type === 'filter') out.push(s);
    else if (isTermStep(s) && Object.keys(s).every((k) => TERM_KEYS.has(k))) await expandOne(projectId, datasetId, s, out, notes);
    else throw new TermNotExpandedError('unreadable'); // a malformed term, a newer release's step, or a Prepare step sent as a filter
  }
  return { steps: out, notes };
}

/** An answer spec with its `{ term }` filters expanded, and the steps they became. In 05a: the refusal on any term. */
export async function expandAnswerTerms(projectId: string, spec: AnswerSpec): Promise<{ spec: AnswerSpec; steps: FilterStep[] }> {
  if (((spec && spec.filters) || []).some((f) => 'term' in f || hasTermType(f))) throw new TermNotExpandedError('unreadable'); // specFilterSteps' rule
  return { spec, steps: [] };
}
