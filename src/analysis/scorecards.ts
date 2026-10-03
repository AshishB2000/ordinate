// SCORECARDS — the record store. MAIN PROCESS.
//
// One JSON file per scorecard under `userData/projects/<pid>/scorecards/<id>.json`,
// with the discipline of every record store here (the pattern is
// src/analysis/stories.ts): ids are generated UUIDs validated before they touch
// a path, writes are atomic (temp sibling, then rename), a corrupt file is
// skipped and never fatal, and `normalize` re-sanitises every row on the way in
// AND out through ./scorecardModel. Definitions only — see that file's header.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import { isScorePeriod, sanitizeRows } from './scorecardModel';
import type { Scorecard, ScorePeriod } from './scorecardModel';

export type { Scorecard } from './scorecardModel';

export interface ScorecardSummary {
  id: string;
  name: string;
  period: ScorePeriod;
  rowCount: number;
  /** Distinct groups, in order — the card lists them. */
  groups: string[];
  updatedAt: string;
}

let base: string | null = null;
function projectsBase(): string {
  if (!base) base = path.join(appPaths.userData(), 'projects');
  return base;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function dir(projectId: string): string {
  return path.join(projectsBase(), projectId, 'scorecards');
}
function file(projectId: string, id: string): string {
  return path.join(dir(projectId), id + '.json');
}

async function writeJsonAtomic(target: string, obj: unknown): Promise<void> {
  const tmp = target + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, target);
}

function cleanName(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function cleanDescription(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined;
}

// ponytail: `any` — a parsed file of unknown shape, narrowed field by field below.
function normalize(data: any, projectId: string): Scorecard {
  const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : new Date().toISOString();
  const sc: Scorecard = {
    id: String(data.id),
    projectId,
    name: cleanName(data.name) || 'Untitled scorecard',
    period: isScorePeriod(data.period) ? data.period : 'month',
    rows: sanitizeRows(data.rows),
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt,
    schemaVersion: 1,
  };
  const description = cleanDescription(data.description);
  if (description) sc.description = description;
  return sc;
}

function summaryOf(sc: Scorecard): ScorecardSummary {
  const groups: string[] = [];
  for (const r of sc.rows) if (r.group && groups.indexOf(r.group) < 0) groups.push(r.group);
  return { id: sc.id, name: sc.name, period: sc.period, rowCount: sc.rows.length, groups, updatedAt: sc.updatedAt };
}

export async function listScorecards(projectId: string): Promise<ScorecardSummary[]> {
  if (!isValidId(projectId)) return [];
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir(projectId), { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out: ScorecardSummary[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const id = d.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const data = JSON.parse(await fs.promises.readFile(file(projectId, id), 'utf8'));
      if (!data || typeof data.id !== 'string') continue;
      out.push(summaryOf(normalize(data, projectId)));
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error('[scorecards] Skipping corrupt or unreadable scorecard:', id, err.message);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

export async function getScorecard(projectId: string, id: string): Promise<Scorecard | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(file(projectId, id), 'utf8'));
    if (!data || typeof data.id !== 'string') return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

export async function saveScorecard(
  projectId: string, input: { name?: unknown; period?: unknown; rows?: unknown; description?: unknown },
): Promise<Scorecard | null> {
  if (!isValidId(projectId)) return null;
  if (!(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const sc = normalize({ ...input, id: randomUUID(), createdAt: now, updatedAt: now }, projectId);
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, sc.id), sc);
  return sc;
}

/** Replace-or-keep per field; `rows` is replaced wholesale, never merged. */
export async function updateScorecard(
  projectId: string, id: string, patch: { name?: unknown; period?: unknown; rows?: unknown; description?: unknown },
): Promise<Scorecard | null> {
  const existing = await getScorecard(projectId, id);
  if (!existing) return null;
  const next = normalize({
    ...existing,
    name: cleanName(patch.name) || existing.name,
    period: isScorePeriod(patch.period) ? patch.period : existing.period,
    rows: patch.rows !== undefined ? patch.rows : existing.rows,
    description: patch.description !== undefined ? patch.description : existing.description,
    updatedAt: new Date().toISOString(),
  }, projectId);
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, id), next);
  return next;
}

export async function duplicateScorecard(projectId: string, id: string): Promise<Scorecard | null> {
  const src = await getScorecard(projectId, id);
  if (!src) return null;
  return saveScorecard(projectId, { name: src.name + ' (copy)', period: src.period, rows: src.rows, description: src.description });
}

export async function deleteScorecard(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(file(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
