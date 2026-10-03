// SCENARIOS — the record store. MAIN PROCESS.
//
// One JSON file per scenario under `userData/projects/<pid>/scenarios/<id>.json`,
// with the discipline of every record store here (the pattern is
// src/analysis/scorecards.ts): ids are generated UUIDs validated before they
// touch a path, writes are atomic (temp sibling, then rename), a corrupt file is
// skipped and never fatal, and `normalize` re-sanitises every field on the way
// in AND out through ./scenarioModel. Definitions only — never a figure.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import { sanitizeBaseMetricIds, sanitizeDrivers } from './scenarioModel';
import type { Scenario } from './scenarioModel';

export type { Scenario } from './scenarioModel';

export interface ScenarioSummary {
  id: string;
  name: string;
  metricCount: number;
  driverCount: number;
  /** The drivers in words, in order — the card lists the first few. */
  driverNames: string[];
  updatedAt: string;
}

type ScenarioInput = { name?: unknown; baseMetricIds?: unknown; drivers?: unknown };

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
  return path.join(projectsBase(), projectId, 'scenarios');
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

// ponytail: `any` — a parsed file of unknown shape, narrowed field by field below.
function normalize(data: any, projectId: string): Scenario {
  const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    name: cleanName(data.name) || 'Untitled scenario',
    baseMetricIds: sanitizeBaseMetricIds(data.baseMetricIds),
    drivers: sanitizeDrivers(data.drivers),
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt,
    schemaVersion: 1,
  };
}

function summaryOf(s: Scenario): ScenarioSummary {
  return {
    id: s.id, name: s.name, metricCount: s.baseMetricIds.length, driverCount: s.drivers.length,
    driverNames: s.drivers.map((d) => d.name).filter(Boolean), updatedAt: s.updatedAt,
  };
}

export async function listScenarios(projectId: string): Promise<ScenarioSummary[]> {
  if (!isValidId(projectId)) return [];
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir(projectId), { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out: ScenarioSummary[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const id = d.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const data = JSON.parse(await fs.promises.readFile(file(projectId, id), 'utf8'));
      if (!data || typeof data.id !== 'string') continue;
      out.push(summaryOf(normalize(data, projectId)));
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error('[scenarios] Skipping corrupt or unreadable scenario:', id, err.message);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

export async function getScenario(projectId: string, id: string): Promise<Scenario | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(file(projectId, id), 'utf8'));
    if (!data || typeof data.id !== 'string') return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

export async function saveScenario(projectId: string, input: ScenarioInput): Promise<Scenario | null> {
  if (!isValidId(projectId)) return null;
  if (!(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const s = normalize({ ...input, id: randomUUID(), createdAt: now, updatedAt: now }, projectId);
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, s.id), s);
  return s;
}

/** Replace-or-keep per field; `drivers` and `baseMetricIds` are replaced wholesale, never merged. */
export async function updateScenario(projectId: string, id: string, patch: ScenarioInput): Promise<Scenario | null> {
  const existing = await getScenario(projectId, id);
  if (!existing) return null;
  const next = normalize({
    ...existing,
    name: cleanName(patch.name) || existing.name,
    baseMetricIds: patch.baseMetricIds !== undefined ? patch.baseMetricIds : existing.baseMetricIds,
    drivers: patch.drivers !== undefined ? patch.drivers : existing.drivers,
    updatedAt: new Date().toISOString(),
  }, projectId);
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, id), next);
  return next;
}

export async function duplicateScenario(projectId: string, id: string): Promise<Scenario | null> {
  const src = await getScenario(projectId, id);
  if (!src) return null;
  return saveScenario(projectId, { name: src.name + ' (copy)', baseMetricIds: src.baseMetricIds, drivers: src.drivers });
}

export async function deleteScenario(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(file(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
