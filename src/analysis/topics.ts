// Topics (semantic layer part 6, D14–D15) — MAIN PROCESS ONLY. One JSON file per topic under
// userData/projects/<projectId>/topics/<id>.json, beside `terms/`.
//
// A topic ("Sales") is a named, ORDERED short list of the project's datasets (each with an optional field subset; no
// `fields` means all), metrics and terms, so a team starts from its own corner of the project. It is NEVER access
// control (D15): no door reads one, and every reader still reaches everything outside it. The store mirrors
// ./terms.ts: ids UUID-checked before they reach a path, atomic writes, a corrupt file skipped, the edit-conflict tag,
// and a normalize that re-sanitizes on load. Members that have gone are dropped for READERS (`topicsForReaders`),
// counted, and never written back: the editor's next save removes them.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import * as metrics from './metrics';
import * as terms from './terms';
import { isValidId, projectDir, RECORD_DIR } from '../app/recordKinds';
import * as recordFs from '../app/recordFs';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { osUser } from '../app/catalog';
import { logger } from '../app/logger';
import * as msg from './topicMessages';

export const MAX_TOPICS = 50;
export const MAX_TOPIC_DATASETS = 12; // the Assistant's cap: a topic always fits whole in its facts
export const MAX_TOPIC_FIELDS = 500;
export const MAX_TOPIC_IDS = 100;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_FIELD = 256;
const MAX_BY = 200;

export interface TopicDataset {
  id: string;
  /** In the topic's order; absent = every field. */
  fields?: string[];
}

export interface Topic {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  datasets: TopicDataset[];
  metricIds: string[];
  termIds: string[];
  updatedBy: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface TopicInput {
  name: string;
  description?: unknown;
  datasets: unknown;
  metricIds?: unknown;
  termIds?: unknown;
}

type Field = 'name' | 'datasets' | 'metricIds' | 'termIds';

function topicsDir(projectId: string): string {
  return path.join(projectDir(projectId), RECORD_DIR.topic);
}

function topicFile(projectId: string, id: string): string {
  return path.join(topicsDir(projectId), id + '.json');
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

const trimTo = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.trim().slice(0, max) : '');
const arr = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);

/** Distinct UUIDs, first wins, at most `max`. */
function ids(raw: unknown, max: number): string[] {
  return [...new Set(arr(raw).filter(isValidId))].slice(0, max);
}

/** Datasets once each (first wins), at most 12; a field list deduped and capped, an empty one meaning every field. */
function sanitizeDatasets(raw: unknown): TopicDataset[] {
  const seen = new Set<string>();
  const out: TopicDataset[] = [];
  for (const d of arr(raw)) {
    const id = d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined;
    if (!isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    const rawFields = (d as { fields?: unknown }).fields;
    const fields = [...new Set(arr(rawFields).filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= MAX_FIELD))].slice(0, MAX_TOPIC_FIELDS);
    out.push(fields.length ? { id, fields } : { id });
    if (out.length === MAX_TOPIC_DATASETS) break;
  }
  return out;
}

// any: parsed stored JSON
function isValidTopic(data: any): boolean {
  return !!data && typeof data === 'object' && isValidId(data.id);
}

/** A stored or typed topic in its one shape. Idempotent: sanitizing twice is sanitizing once. */
// any: parsed stored JSON
export function sanitizeTopic(data: any, projectId: string): Topic {
  const t: Topic = {
    id: String(data.id),
    projectId,
    name: trimTo(data.name, MAX_NAME) || 'Untitled topic',
    datasets: sanitizeDatasets(data.datasets),
    metricIds: ids(data.metricIds, MAX_TOPIC_IDS),
    termIds: ids(data.termIds, MAX_TOPIC_IDS),
    updatedBy: trimTo(data.updatedBy, MAX_BY),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    schemaVersion: 1,
  };
  const description = trimTo(data.description, MAX_DESCRIPTION);
  if (description) t.description = description;
  return t;
}

/** Every topic of the project, by name (locale-aware). Corrupt files are skipped. */
export async function listTopics(projectId: string): Promise<Topic[]> {
  if (!isValidId(projectId)) return [];
  let names: string[];
  try {
    names = await recordFs.readdir(topicsDir(projectId));
  } catch (_) {
    return []; // no topics yet
  }
  const out: Topic[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!isValidId(id)) continue; // a stray or temp file
    try {
      const data = JSON.parse(await recordFs.readFile(topicFile(projectId, id), 'utf8'));
      if (isValidTopic(data)) out.push(sanitizeTopic(data, projectId));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') logger.error('[topics] Skipping corrupt or unreadable topic:', id, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The record and the tag of what is stored, from ONE read (../app/editConflict). */
export async function readTopic(projectId: string, id: string): Promise<Tagged<Topic> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return readTagged('topic', topicFile(projectId, id), (d) => (isValidTopic(d) ? sanitizeTopic(d, projectId) : null));
}

/** What exists now: dataset ids (with their column names, read lazily), metric ids, term ids. Metadata only. */
async function membersOf(projectId: string) {
  const [list, ms, ts] = await Promise.all([datasets.listDatasets(projectId), metrics.listMetrics(projectId), terms.listFullTerms(projectId)]);
  const sets = new Set(list.map((d) => d.id));
  const cols = new Map<string, Promise<Set<string>>>();
  const columnsOf = (id: string): Promise<Set<string>> => {
    if (!cols.has(id)) cols.set(id, datasets.getDatasetMeta(projectId, id).then((m) => new Set((m?.columns ?? []).map((c) => c.name))));
    return cols.get(id)!;
  };
  return { sets, columnsOf, metrics: new Set(ms.map((m) => m.id)), terms: new Set(ts.map((t) => t.id)) };
}

/**
 * Why `input` cannot be saved (the box it belongs beside, and the sentence), or null. `exceptId`: the topic being
 * edited — its own name does not collide with it, and it does not count against the cap.
 */
export async function topicProblem(projectId: string, input: Partial<TopicInput>, exceptId?: string): Promise<{ field: Field; error: string } | null> {
  const name = trimTo(input.name, MAX_NAME);
  if (!name) return { field: 'name', error: msg.topicNameMissing() };
  const others = (await listTopics(projectId)).filter((t) => t.id !== exceptId);
  if (others.some((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return { field: 'name', error: msg.topicNameTaken(name) };
  if (!exceptId && others.length >= MAX_TOPICS) return { field: 'name', error: msg.tooManyTopics(MAX_TOPICS) };
  if (arr(input.datasets).length > MAX_TOPIC_DATASETS) return { field: 'datasets', error: msg.topicTooManyDatasets(MAX_TOPIC_DATASETS) };
  const t = sanitizeTopic({ ...input, id: exceptId ?? randomUUID() }, projectId);
  const have = await membersOf(projectId);
  for (const d of t.datasets) {
    if (!have.sets.has(d.id)) return { field: 'datasets', error: msg.topicMemberGone() };
    if (d.fields) {
      const cols = await have.columnsOf(d.id);
      if (d.fields.some((f) => !cols.has(f))) return { field: 'datasets', error: msg.topicMemberGone() };
    }
  }
  if (t.metricIds.some((id) => !have.metrics.has(id))) return { field: 'metricIds', error: msg.topicMemberGone() };
  if (t.termIds.some((id) => !have.terms.has(id))) return { field: 'termIds', error: msg.topicMemberGone() };
  return null;
}

/** Create a topic (check `topicProblem` first). Null when an id is not a UUID or the project is missing. */
export async function saveTopic(projectId: string, input: TopicInput): Promise<Topic | null> {
  if (!isValidId(projectId) || !(await projects.getProject(projectId))) return null;
  const topic = sanitizeTopic({ ...input, id: randomUUID(), updatedBy: osUser(), updatedAt: new Date().toISOString() }, projectId);
  await fs.promises.mkdir(topicsDir(projectId), { recursive: true });
  await writeJsonAtomic(topicFile(projectId, topic.id), topic);
  return topic;
}

/** Replace a topic's content, holding it while it reads and writes; a stale `base` refuses (409 record_changed). */
export async function updateTopic(projectId: string, id: string, input: TopicInput, base?: unknown): Promise<Topic | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = topicFile(projectId, id);
  return lockedUpdate('topic', { projectId, id, file }, base, () => readTopic(projectId, id), async () => {
    const updated = sanitizeTopic({ ...input, id, updatedBy: osUser(), updatedAt: new Date().toISOString() }, projectId);
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

/**
 * Each topic as readers get it: the members that have gone (a deleted dataset, metric or term, a field a refresh
 * dropped) left out, in order, and how many were. Reads metadata once for the whole list; never writes, never throws
 * on a gone member. A field subset whose every field has gone reads as the whole dataset (no `fields`).
 */
export async function topicsForReaders(projectId: string, list: Topic[]): Promise<{ topic: Topic; stale: number }[]> {
  if (!list.length) return [];
  const have = await membersOf(projectId);
  return Promise.all(list.map(async (t) => {
    let stale = 0;
    const kept: TopicDataset[] = [];
    for (const d of t.datasets) {
      if (!have.sets.has(d.id)) {
        stale++;
        continue;
      }
      if (!d.fields) {
        kept.push(d);
        continue;
      }
      const cols = await have.columnsOf(d.id);
      const fields = d.fields.filter((f) => cols.has(f));
      stale += d.fields.length - fields.length;
      kept.push(fields.length ? { id: d.id, fields } : { id: d.id });
    }
    const metricIds = t.metricIds.filter((id) => have.metrics.has(id));
    const termIds = t.termIds.filter((id) => have.terms.has(id));
    stale += t.metricIds.length - metricIds.length + t.termIds.length - termIds.length;
    return { topic: { ...t, datasets: kept, metricIds, termIds }, stale };
  }));
}

export async function topicForReaders(projectId: string, t: Topic): Promise<{ topic: Topic; stale: number }> {
  return (await topicsForReaders(projectId, [t]))[0];
}
