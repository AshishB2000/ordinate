// Glossary terms (semantic layer D10) — MAIN PROCESS ONLY. One JSON file per term under
// userData/projects/<projectId>/terms/<id>.json, beside `metrics/`.
//
// A term is a NAMED ROW FILTER: "EMEA" is `region in (EU, ME, AF)` on Customers. A filter list holds
// a reference to it (`{ type: 'term', term: <id> }`, ../data/termStep) and the figure doors expand
// it (./termExpand), so editing the term changes every figure that uses it. The store mirrors
// ./metrics.ts: both ids UUID-checked before either reaches a path, atomic writes, a corrupt file
// skipped, the edit-conflict tag, and a normalize that re-sanitizes on load. `datasetId` is
// immutable: a term's columns are that table's.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { isValidId } from '../app/ids';
import { sanitizeFilterList } from '../data/filterList';
import { hasTermType, isTermStep } from '../data/termStep';
import type { FilterStep } from '../data/transforms';
import * as recordFs from '../app/recordFs';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { sanitizeAliases } from '../app/columnNames';
import { logger } from '../app/logger';
import * as msg from '../data/termMessages';
import { nameClash } from './termNames';
import { describeFilter, describeFilterHidden } from './metricFormat';

export const MAX_TERM_FILTERS = 50;
const MAX_DESCRIPTION = 500;
const MAX_NAME = 200;

export interface Term {
  id: string;
  projectId: string;
  name: string;
  /** "Also called" (../app/columnNames sanitizeAliases): at most 8, each 60 characters or fewer. */
  aliases: string[];
  description?: string;
  /** The table its columns belong to. Immutable. */
  datasetId: string;
  /** 1–50 plain `filter` steps: never a term, never a control's mark. */
  filters: FilterStep[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface TermSummary {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  datasetId: string;
  updatedAt: string;
}

export interface TermInput {
  name: string;
  aliases?: unknown;
  description?: unknown;
  datasetId: string;
  filters: unknown;
}

function termsDir(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'terms');
}

function termFile(projectId: string, id: string): string {
  return path.join(termsDir(projectId), id + '.json');
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

const trimTo = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.trim().slice(0, max) : '');

/** A term's filters as stored: plain filter steps only (a term inside a term is refused on save, dropped on read), unmarked, at most 50. */
export function sanitizeTermFilters(raw: unknown): FilterStep[] {
  return sanitizeFilterList(raw)
    .filter((s) => s.type === 'filter')
    .slice(0, MAX_TERM_FILTERS)
    .map((s) => {
      if (s.fromControl === undefined) return s;
      const out = { ...s };
      delete out.fromControl; // a term's own dates are a fixed filter: no control ever moves them
      return out;
    });
}

// any: parsed stored JSON
function isValidTerm(data: any): boolean {
  return !!data && typeof data === 'object' && isValidId(data.id) && isValidId(data.datasetId);
}

// any: parsed stored JSON
function normalize(data: any, projectId: string): Term {
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString();
  const name = trimTo(data.name, MAX_NAME) || 'Untitled term';
  const t: Term = {
    id: String(data.id),
    projectId,
    name,
    aliases: sanitizeAliases(data.aliases, name),
    datasetId: String(data.datasetId),
    filters: sanitizeTermFilters(data.filters),
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : createdAt,
    schemaVersion: 1,
  };
  const description = trimTo(data.description, MAX_DESCRIPTION);
  if (description) t.description = description;
  return t;
}

export function toSummary(t: Term): TermSummary {
  const s: TermSummary = { id: t.id, name: t.name, aliases: t.aliases, datasetId: t.datasetId, updatedAt: t.updatedAt };
  if (t.description) s.description = t.description;
  return s;
}

/** Every term of the project as full records, by name (locale-aware). Corrupt files are skipped. */
export async function listFullTerms(projectId: string): Promise<Term[]> {
  if (!isValidId(projectId)) return [];
  let names: string[];
  try {
    names = await recordFs.readdir(termsDir(projectId));
  } catch (_) {
    return []; // no terms yet
  }
  const out: Term[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!isValidId(id)) continue; // a stray or temp file
    try {
      const data = JSON.parse(await recordFs.readFile(termFile(projectId, id), 'utf8'));
      if (isValidTerm(data)) out.push(normalize(data, projectId));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') logger.error('[terms] Skipping corrupt or unreadable term:', id, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function listTerms(projectId: string): Promise<TermSummary[]> {
  return (await listFullTerms(projectId)).map(toSummary);
}

/** The record and the tag of what is stored, from ONE read (../app/editConflict). */
export async function readTerm(projectId: string, id: string): Promise<Tagged<Term> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return readTagged('term', termFile(projectId, id), (d) => (isValidTerm(d) ? normalize(d, projectId) : null));
}

export async function getTerm(projectId: string, id: string): Promise<Term | null> {
  return (await readTerm(projectId, id))?.rec ?? null;
}

/** How a definition words each of `filters`: a glossary term by its name (a record read per term), any other step by `words`. */
export async function termWords(projectId: string, filters: readonly FilterStep[], words: (s: FilterStep) => string = describeFilter): Promise<(s: FilterStep) => string> {
  const idOf = (s: unknown): string | null => (isTermStep(s) ? s.term : null); // a term is a kept step, not a FilterStep
  const names = new Map<string, string>();
  for (const f of filters) {
    const id = idOf(f);
    if (!id || names.has(id)) continue;
    const t = await getTerm(projectId, id).catch(() => null);
    if (t) names.set(id, t.name);
  }
  return (s) => names.get(idOf(s) ?? '') ?? words(s);
}

/**
 * Why `input` cannot be saved (the box it belongs beside, and the sentence), or null. `exceptId`: the term
 * being edited — its own names do not collide with it, and its dataset is the stored one.
 */
export async function termProblem(
  projectId: string,
  input: Partial<TermInput>,
  exceptId?: string,
): Promise<{ field: 'name' | 'aliases' | 'filters' | 'datasetId'; error: string } | null> {
  const name = trimTo(input.name, MAX_NAME);
  if (name) {
    const clash = await nameClash(projectId, [name], exceptId);
    if (clash) return { field: 'name', error: msg.termNameTaken(clash.said, clash.takenBy) };
  }
  if (input.aliases !== undefined) {
    const clash = await nameClash(projectId, sanitizeAliases(input.aliases, name), exceptId);
    if (clash) return { field: 'aliases', error: msg.termNameTaken(clash.said, clash.takenBy) };
  }
  const meta = isValidId(input.datasetId) ? await datasets.getDatasetMeta(projectId, input.datasetId) : null;
  if (!meta) return { field: 'datasetId', error: msg.termDatasetGone() };
  if (input.filters === undefined) return null;
  if (Array.isArray(input.filters) && input.filters.some(hasTermType)) return { field: 'filters', error: msg.termInTerm() };
  const filters = sanitizeTermFilters(input.filters);
  if (!filters.length) return { field: 'filters', error: msg.termNoFilters() };
  const own = new Set(meta.columns.map((c) => c.name));
  const missing = filters.find((f) => !own.has(f.column));
  return missing ? { field: 'filters', error: msg.termColumnMissing(missing.column, meta.name) } : null;
}

/** Create a term. Null when an id is not a UUID, or the project or the dataset is missing (metadata only, no row read). */
export async function saveTerm(projectId: string, input: TermInput): Promise<Term | null> {
  if (!isValidId(projectId) || !isValidId(input.datasetId)) return null;
  if (!(await projects.getProject(projectId)) || !(await datasets.getDatasetMeta(projectId, input.datasetId))) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const term = normalize({ ...input, id, createdAt: now, updatedAt: now }, projectId);
  await fs.promises.mkdir(termsDir(projectId), { recursive: true });
  await writeJsonAtomic(termFile(projectId, id), term);
  return term;
}

/** Patch a term, holding it while it reads and writes; a stale `base` refuses (409 record_changed). `datasetId` never moves. */
export async function updateTerm(projectId: string, id: string, patch: Partial<TermInput>, base?: unknown): Promise<Term | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = termFile(projectId, id);
  return lockedUpdate('term', { projectId, id, file }, base, () => readTerm(projectId, id), async (existing) => {
    const name = trimTo(patch.name, MAX_NAME) || existing.name;
    const updated: Term = {
      ...existing,
      name,
      aliases: sanitizeAliases(patch.aliases !== undefined ? patch.aliases : existing.aliases, name),
      filters: patch.filters !== undefined ? sanitizeTermFilters(patch.filters) : existing.filters,
      updatedAt: new Date().toISOString(),
    };
    if (patch.description !== undefined) {
      const d = trimTo(patch.description, MAX_DESCRIPTION);
      if (d) updated.description = d;
      else delete updated.description; // '' clears it
    }
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

/** A term's filters in words — "region in EU, ME, AF and status = active". `hide`: the steps worded without their values. */
export function describeTermFilters(t: Pick<Term, 'filters'>, hide: (s: FilterStep) => boolean = () => false): string {
  return t.filters.map((s) => (hide(s) ? describeFilterHidden(s) : describeFilter(s))).join(' and ');
}
