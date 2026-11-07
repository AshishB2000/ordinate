// A drill hierarchy: an ordered list of one dataset's columns, coarse to fine, that a person named.
// Kept in catalog.json under `tables[<datasetId>].hierarchies` (tableDocs.ts). Types and the sanitizer
// only: a release that cannot write one still keeps what a newer release stored, through every catalog
// read and re-save. Never checked against the data; a level is a column name matched exactly, never trimmed.

import { randomUUID } from 'crypto';
import { clip } from './clip';
import type { ParsedColumn } from '../data/parse';
import { hierarchyColumnTaken, hierarchyLevelMissing, hierarchyLevelNotText, hierarchyNameTaken } from './hierarchyMessages';
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

/** A patch entry as a person sends it: an id only when it is editing one that exists. */
export interface HierarchyDraft { id?: string; name: string; levels: string[] }

/** Keeps an id that names an existing hierarchy (once), gives every other entry a new one, and trims names. */
export function withIds(list: readonly HierarchyDraft[], existing: readonly Hierarchy[]): Hierarchy[] {
  const known = new Set(existing.map((h) => h.id));
  const used = new Set<string>();
  return list.map((h) => {
    const id = h.id && known.has(h.id) && !used.has(h.id) ? h.id : randomUUID();
    used.add(id);
    return { id, name: h.name.trim(), levels: h.levels };
  });
}

/** The first broken rule's sentence, or null: a level that is no column, not text, in one hierarchy twice or in two, then a name used twice. */
export function hierarchyProblem(list: readonly { name: string; levels: string[] }[], columns: readonly ParsedColumn[]): string | null {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const levels = list.flatMap((h) => h.levels);
  for (const l of levels) if (!byName.has(l)) return hierarchyLevelMissing(l);
  for (const l of levels) if (byName.get(l)!.type !== 'text') return hierarchyLevelNotText(l, byName.get(l)!.type);
  const owner = new Map<string, string>();
  for (const h of list) {
    for (const l of h.levels) {
      if (owner.has(l)) return hierarchyColumnTaken(l, owner.get(l)!);
      owner.set(l, h.name.trim());
    }
  }
  const names = new Set<string>();
  for (const h of list) {
    const n = h.name.trim().toLowerCase();
    if (names.has(n)) return hierarchyNameTaken(h.name.trim());
    names.add(n);
  }
  return null;
}
