// NOTEBOOKS — the record store. MAIN PROCESS.
//
// One JSON file per notebook under `userData/projects/<pid>/notebooks/<id>.json`,
// the discipline of every other record store (stories.ts is the model): ids are
// generated UUIDs validated before they touch a path, writes are atomic (temp
// sibling, then rename), a corrupt file is skipped and never fatal, and every
// cell is re-sanitised on the way in AND out through ./model — so a hand-edited
// file cannot smuggle a cell past the editor.
//
// Results are NOT stored here. A notebook is its cells; what they computed is
// the run cache's (./run.ts), keyed on the inputs, and a reopened notebook
// re-runs from it at no cost.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projects from '../../app/projects';
import { projectDir, isValidId } from '../../app/recordKinds';
import { excerptOf, sanitizeCells, starterCells } from './model';
import type { NbCell, Notebook } from './model';
import * as recordFs from '../../app/recordFs';

export interface NotebookSummary {
  id: string;
  name: string;
  cellCount: number;
  /** How many cells of each kind — the card's "3 SQL · 1 chart". */
  kinds: Partial<Record<NbCell['kind'], number>>;
  excerpt: string;
  updatedAt: string;
}

function dir(projectId: string): string {
  return path.join(projectDir(projectId), 'notebooks');
}
function file(projectId: string, id: string): string {
  return path.join(dir(projectId), id + '.json');
}

async function writeJsonAtomic(target: string, obj: unknown): Promise<void> {
  const tmp = target + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, target);
}

function cleanName(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function normalize(data: any, projectId: string): Notebook {
  const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    name: cleanName(data.name) || 'Untitled notebook',
    cells: sanitizeCells(data.cells, randomUUID),
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt,
    schemaVersion: 1,
  };
}

export async function getNotebook(projectId: string, id: string): Promise<Notebook | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await recordFs.readFile(file(projectId, id), 'utf8'));
    if (!data || data.id !== id) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

export async function listNotebooks(projectId: string): Promise<NotebookSummary[]> {
  if (!isValidId(projectId)) return [];
  let names: string[];
  try {
    names = await recordFs.readdir(dir(projectId));
  } catch (_) {
    return [];
  }
  const out: NotebookSummary[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    const nb = isValidId(id) ? await getNotebook(projectId, id) : null;
    if (!nb) continue; // corrupt or foreign: skipped, never fatal
    const kinds: NotebookSummary['kinds'] = {};
    for (const c of nb.cells) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    out.push({ id: nb.id, name: nb.name, cellCount: nb.cells.length, kinds, excerpt: excerptOf(nb.cells), updatedAt: nb.updatedAt });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

/** A new notebook. Without cells it opens on a heading and a query over `firstSlug`. */
export async function createNotebook(
  projectId: string,
  input: { name?: unknown; cells?: unknown; firstSlug?: string | null },
): Promise<Notebook | null> {
  if (!isValidId(projectId) || !(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const name = cleanName(input.name) || 'Untitled notebook';
  const nb: Notebook = {
    id: randomUUID(),
    projectId,
    name,
    cells: input.cells !== undefined ? sanitizeCells(input.cells, randomUUID) : starterCells(name, input.firstSlug || null, randomUUID),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, nb.id), nb);
  return nb;
}

/** Replace-or-keep: `cells` is replaced wholesale, never merged. */
export async function updateNotebook(projectId: string, id: string, patch: { name?: unknown; cells?: unknown }): Promise<Notebook | null> {
  const existing = await getNotebook(projectId, id);
  if (!existing) return null;
  const updated: Notebook = {
    ...existing,
    name: cleanName(patch.name) || existing.name,
    cells: patch.cells !== undefined ? sanitizeCells(patch.cells, randomUUID) : existing.cells,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, id), updated);
  return updated;
}

export async function deleteNotebook(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(file(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
