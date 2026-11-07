// Glossary terms (semantic D10–D12): a named row filter on one dataset — "EMEA", "Enterprise",
// "Recent order" — that a filter list references as `{ type: 'term', term: <id> }`. The server
// expands a reference at every figure door; the web only names it and edits the record.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { FilterStep } from '../../visuals/api';
import type { StatusView } from '../status/status';
import { failure } from '../../analyses/api';

/** `term:list`'s row: no filter values for a viewer row access rules restrict — the definition writes "…" for them. */
export interface TermSummary {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  datasetId: string;
  datasetName: string | null;
  definition: string;
  updatedAt: string;
  /** Certified, changed since, or retired (part 4). */
  status?: StatusView;
}

/** `term:get`'s record. */
export interface Term {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  datasetId: string;
  filters: FilterStep[];
  valuesHidden?: true;
}

export type TermStep = { type: 'term'; term: string; fromControl?: true };

/** A reference to a term in a filter list (a malformed one stays a kept step the web cannot read). */
export function isTermStep(s: unknown): s is TermStep {
  const o = s as { type?: unknown; term?: unknown } | null;
  return !!o && typeof o === 'object' && o.type === 'term' && typeof o.term === 'string';
}

/** The term a step references, or null — not a type guard: a screen's list is typed `FilterStep[]` (see ../../visuals/keptStep). */
export const termIdOf = (s: unknown): string | null => (isTermStep(s) ? s.term : null);

/** The project's terms: ONE `term:list` per page, shared by every row and picker that names one. */
export function useTerms(projectId: string | undefined) {
  return useQuery({
    queryKey: ['term:list', projectId],
    queryFn: projectId
      ? async () => {
          const r = (await rpc('term:list', { projectId })) as { ok: boolean; terms?: TermSummary[]; error?: string };
          if (!r.ok) throw new Error(r.error || 'The glossary could not be loaded.');
          return r.terms ?? [];
        }
      : skipToken,
  });
}

/** `term:usage`'s entry: the records that use a term, counted and worded by the server (src/analysis/termUsage.ts). */
export interface TermUsage {
  total: number;
  summary: string;
  refs: { kind: 'visual' | 'dashboard' | 'metric' | 'alert' | 'scorecard' | 'report'; id: string; name: string }[];
}

/** Where each term is used, by id; null when the server answered nothing (an older pod). A failure leaves the glossary readable. */
export function useTermUsage(projectId: string) {
  return useQuery({
    queryKey: ['term:usage', projectId],
    queryFn: async () => {
      const r = (await rpc('term:usage', { projectId })) as { ok?: boolean; usage?: Record<string, TermUsage> } | null;
      return r?.ok && r.usage ? r.usage : null;
    },
  });
}

/** What a term step reads as: its term's name, or why there is none. */
export function termLabel(list: readonly TermSummary[] | undefined, id: string): string {
  if (!list) return 'Glossary term';
  return list.find((t) => t.id === id)?.name ?? 'A deleted glossary term';
}

/** "Europe, Middle East" → ['Europe', 'Middle East']: the field is one comma-separated line, as a column's "Also called". */
export const splitAliases = (line: string): string[] => line.split(',').map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);

export interface TermFields {
  name: string;
  aliases: string[];
  description: string;
  filters: FilterStep[];
}
export type TermField = 'name' | 'aliases' | 'filters' | 'datasetId';
export type TermSaveResult = { term: Term } | { error: string; field?: TermField };

/** Create (`datasetId`) or update (`id`) a term; a refusal keeps the server's sentence and the box it belongs beside. */
export async function saveTerm(projectId: string, id: string, datasetId: string, fields: TermFields, base?: string): Promise<TermSaveResult> {
  try {
    const r = (id
      ? await rpc('term:update', { projectId, id, ...(base ? { base } : {}), patch: fields })
      : await rpc('term:save', { projectId, input: { ...fields, datasetId } })) as { ok: boolean; term?: Term; error?: string; field?: TermField };
    if (r.ok && r.term) return { term: r.term };
    return { error: r.error || 'Could not save the term.', field: r.field };
  } catch (err) {
    return { error: failure(err, 'Could not save the term.') };
  }
}
