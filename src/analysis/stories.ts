// STORIES — the record store. MAIN PROCESS.
//
// One JSON file per story under `userData/projects/<pid>/stories/<id>.json`,
// the layout and the discipline of every other record store here (the pattern
// is src/analysis/analysis.ts): ids are generated UUIDs validated before they
// touch a path, writes are atomic (temp sibling, then rename), a corrupt file
// is skipped and never fatal, and `normalize` re-sanitises every block on the
// way in AND out through ./storyModel — so a hand-edited file cannot smuggle a
// block, an SVG or a path past the editor.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import { sanitizeBlocks, starterBlocks } from './storyModel';
import type { StoryBlock } from './storyModel';

export interface Story {
  id: string;
  projectId: string;
  name: string;
  blocks: StoryBlock[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface StorySummary {
  id: string;
  name: string;
  blockCount: number;
  /** The first line of prose that is not the title — the card's excerpt. */
  excerpt: string;
  updatedAt: string;
}

function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function storiesDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'stories');
}
function storyFilePath(projectId: string, id: string): string {
  return path.join(storiesDir(projectId), id + '.json');
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

function cleanName(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function normalize(data: any, projectId: string): Story {
  const createdAt = typeof data.createdAt === 'string' && data.createdAt ? data.createdAt : new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    name: cleanName(data.name) || 'Untitled story',
    blocks: sanitizeBlocks(data.blocks),
    createdAt,
    updatedAt: typeof data.updatedAt === 'string' && data.updatedAt ? data.updatedAt : createdAt,
    schemaVersion: 1,
  };
}

/** The card excerpt: the first prose line that is not a heading. */
export function excerptOf(blocks: StoryBlock[]): string {
  for (const b of blocks) {
    if (b.kind !== 'text' && b.kind !== 'callout') continue;
    for (const line of b.text.split('\n')) {
      const t = line.trim();
      if (t && !/^#{1,6}\s/.test(t)) return t.replace(/[*_`>]/g, '').replace(/^[-+] |^\d+\. /, '').slice(0, 160);
    }
  }
  return '';
}

export async function listStories(projectId: string): Promise<StorySummary[]> {
  if (!isValidId(projectId)) return [];
  let dirents;
  try {
    dirents = await fs.promises.readdir(storiesDir(projectId), { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out: StorySummary[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const id = d.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const data = JSON.parse(await fs.promises.readFile(storyFilePath(projectId, id), 'utf8'));
      if (!data || typeof data.id !== 'string') continue;
      const s = normalize(data, projectId);
      out.push({ id: s.id, name: s.name, blockCount: s.blocks.length, excerpt: excerptOf(s.blocks), updatedAt: s.updatedAt });
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error('[stories] Skipping corrupt or unreadable story:', id, err.message);
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

export async function getStory(projectId: string, id: string): Promise<Story | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(storyFilePath(projectId, id), 'utf8'));
    if (!data || typeof data.id !== 'string') return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

/** A new story. With no blocks given it opens on its title and a paragraph to type into. */
export async function saveStory(projectId: string, input: { name?: unknown; blocks?: unknown }): Promise<Story | null> {
  if (!isValidId(projectId)) return null;
  if (!(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const name = cleanName(input.name) || 'Untitled story';
  const story: Story = {
    id: randomUUID(),
    projectId,
    name,
    blocks: input.blocks !== undefined ? sanitizeBlocks(input.blocks) : starterBlocks(name),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  await fs.promises.mkdir(storiesDir(projectId), { recursive: true });
  await writeJsonAtomic(storyFilePath(projectId, story.id), story);
  return story;
}

/** Replace-or-keep, like updateAnalysis: `blocks` is replaced wholesale, never merged. */
export async function updateStory(projectId: string, id: string, patch: { name?: unknown; blocks?: unknown }): Promise<Story | null> {
  const existing = await getStory(projectId, id);
  if (!existing) return null;
  const updated: Story = {
    ...existing,
    name: cleanName(patch.name) || existing.name,
    blocks: patch.blocks !== undefined ? sanitizeBlocks(patch.blocks) : existing.blocks,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(storiesDir(projectId), { recursive: true });
  await writeJsonAtomic(storyFilePath(projectId, id), updated);
  return updated;
}

export async function deleteStory(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(storyFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
