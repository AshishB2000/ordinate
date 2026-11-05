// A drill hierarchy: an ordered list of one dataset's columns, coarse to fine, that a person named.
// Kept in catalog.json under `tables[<datasetId>].hierarchies` (tableDocs.ts). Types and the sanitizer
// only: a release that cannot write one still keeps what a newer release stored, through every catalog
// read and re-save. Never checked against the data; a level is a column name matched exactly, never trimmed.

import { clip } from './clip';
import { isValidId } from './ids';

export interface Hierarchy { id: string; name: string; levels: string[] }

export const MAX_HIERARCHIES = 10;
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 6;
export const MAX_HIERARCHY_NAME = 80;
const MAX_LEVEL = 256; // catalog.ts's MAX_COLUMN_NAME: a longer name cannot be documented

/** MIN_LEVELS..MAX_LEVELS strings of 1..256 characters, none twice; anything else is null (the entry is corrupt, never half kept). */
function sanitizeLevels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < MIN_LEVELS || raw.length > MAX_LEVELS) return null;
  if (!raw.every((l) => typeof l === 'string' && l.length >= 1 && l.length <= MAX_LEVEL)) return null;
  return new Set(raw).size === raw.length ? [...raw] : null;
}

/** In order, first wins: an entry whose id, name (any case) or any column an earlier entry has is dropped whole. Kept to ten. */
export function sanitizeHierarchies(raw: unknown): Hierarchy[] {
  const out: Hierarchy[] = [];
  if (!Array.isArray(raw)) return out;
  const ids = new Set<string>();
  const names = new Set<string>();
  const columns = new Set<string>();
  for (const e of raw) {
    if (out.length === MAX_HIERARCHIES) break;
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const name = clip(o.name, MAX_HIERARCHY_NAME);
    const levels = sanitizeLevels(o.levels);
    if (!isValidId(o.id) || !name || !levels) continue;
    if (ids.has(o.id) || names.has(name.toLowerCase()) || levels.some((l) => columns.has(l))) continue;
    ids.add(o.id);
    names.add(name.toLowerCase());
    levels.forEach((l) => columns.add(l));
    out.push({ id: o.id, name, levels });
  }
  return out;
}
