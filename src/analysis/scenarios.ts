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
import * as recordFs from '../app/recordFs';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { logger } from '../app/logger';
import { followsAll, openOrNull } from './followsOpen'; // shared folders: it follows every metric it moves (docs/team-folders D3)
import { mayChangeStored, mustEditRecord } from '../app/recordOpen'; // shared folders: a new record needs Edit on what it follows (docs/team-folders D18)

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

function projectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
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
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, target);
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
  let records;
  try {
    records = await recordFs.listRecords(dir(projectId));
  } catch (_) {
    return [];
  }
  const out: ScenarioSummary[] = [];
  const opens = await followsAll(projectId); // null: nothing restricts the caller
  for await (const r of records) {
    const id = r.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const data = JSON.parse(r.text());
      if (!data || typeof data.id !== 'string') continue;
      const s = normalize(data, projectId);
      if (opens && !(await opens(s))) continue; // in a folder the caller cannot open: not listed
      out.push(summaryOf(s));
    } catch (err: any) {
      if (err.code !== 'ENOENT') logger.error('[scenarios] Skipping corrupt or unreadable scenario:', id, err.message);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

export async function getScenario(projectId: string, id: string): Promise<Scenario | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await recordFs.readFile(file(projectId, id), 'utf8'));
    if (!data || typeof data.id !== 'string') return null;
    return await openOrNull(projectId, normalize(data, projectId)); // closed: as missing (D12)
  } catch (_) {
    return null;
  }
}

export async function saveScenario(projectId: string, input: ScenarioInput): Promise<Scenario | null> {
  if (!isValidId(projectId)) return null;
  if (!(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const s = normalize({ ...input, id: randomUUID(), createdAt: now, updatedAt: now }, projectId);
  await mustEditRecord(projectId, 'scenario', s);
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  await writeJsonAtomic(file(projectId, s.id), s);
  return s;
}

/** The record and the tag of what is stored, from ONE read (src/app/editConflict.ts): its editor's open and the guarded save. */
export async function readScenario(projectId: string, id: string): Promise<Tagged<Scenario> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return openOrNull(projectId, await readTagged('scenario', file(projectId, id), (d) => (d && typeof d.id === 'string' ? normalize(d, projectId) : null)), (t) => t.rec); // closed: as missing, so its guarded save refuses too
}

/** Replace-or-keep per field; `drivers` and `baseMetricIds` are replaced wholesale, never merged. Holds
 *  the record while it reads and writes; a stale `base` refuses (src/app/editConflict.ts). */
export async function updateScenario(projectId: string, id: string, patch: ScenarioInput, base?: unknown): Promise<Scenario | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const at = file(projectId, id);
  return lockedUpdate('scenario', { projectId, id, file: at }, base, () => readScenario(projectId, id), async (existing) => {
    const next = normalize({
      ...existing,
      name: cleanName(patch.name) || existing.name,
      baseMetricIds: patch.baseMetricIds !== undefined ? patch.baseMetricIds : existing.baseMetricIds,
      drivers: patch.drivers !== undefined ? patch.drivers : existing.drivers,
      updatedAt: new Date().toISOString(),
    }, projectId);
    await fs.promises.mkdir(dir(projectId), { recursive: true });
    await writeJsonAtomic(at, next);
    return next;
  });
}

export async function duplicateScenario(projectId: string, id: string): Promise<Scenario | null> {
  const src = await getScenario(projectId, id);
  if (!src) return null;
  return saveScenario(projectId, { name: src.name + ' (copy)', baseMetricIds: src.baseMetricIds, drivers: src.drivers });
}

export async function deleteScenario(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  if (!(await mayChangeStored(projectId, 'scenario', file(projectId, id)))) return true; // closed to the caller: as a missing one (gone is success)
  try {
    await recordFs.rm(file(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
