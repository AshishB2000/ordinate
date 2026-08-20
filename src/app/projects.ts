// Project (workspace) persistence — MAIN PROCESS ONLY.
// One directory per project under userData/projects/<id>/project.json.
// The directory name IS the project id. No index file — listProjects() scans
// the dir, exactly like src/history.ts scans userData/history/*/thread.json.
// Mirrors src/history.ts conventions (userData path, graceful skip of
// missing/corrupt files). API keys are NEVER written here.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

let projectsDir: string | null = null;

function getProjectsDir(): string {
  if (!projectsDir) projectsDir = path.join(app.getPath('userData'), 'projects');
  return projectsDir;
}

// A project id is always a generated UUID (createProject uses randomUUID()).
// Ids arrive from the renderer over IPC, so validate the SHAPE before it ever
// reaches a filesystem path — otherwise an id like ".." or "../../foo" would
// escape userData/projects and, via deleteProject's recursive+force rm, delete
// arbitrary directories. Anything not a plain UUID is rejected.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function projectDir(id: string): string {
  return path.join(getProjectsDir(), id);
}

function projectFilePath(id: string): string {
  return path.join(projectDir(id), 'project.json');
}

// Atomic JSON write: write to a temp sibling then rename (atomic on same fs),
// so a crash mid-write never leaves a half-written project.json.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

// Basic shape validation for a parsed project.json (skips corrupt files).
function isValidProject(data: any): data is Project {
  return Boolean(data) && typeof data.id === 'string' && data.id.length > 0;
}

// Create the projects directory on first run.
export async function init(): Promise<void> {
  await fs.promises.mkdir(getProjectsDir(), { recursive: true });
}

// Return all projects, newest-updated first. Skips corrupt/missing quietly.
export async function listProjects(): Promise<Project[]> {
  const dir = getProjectsDir();
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const projects: Project[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    try {
      const raw = await fs.promises.readFile(projectFilePath(id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidProject(data)) continue;
      projects.push(normalize(data));
    } catch (err: any) { // ponytail: fs errors carry .code, JSON errors don't
      // ENOENT = a project dir without a project.json (e.g. interrupted create).
      // Not corruption — skip quietly. Only log real damage.
      if (err.code !== 'ENOENT') {
        console.error('[projects] Skipping corrupt or unreadable project:', id, err.message);
      }
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return projects;
}

// Coerce a parsed object into a well-formed Project (fills sane defaults).
function normalize(data: any): Project {
  const createdAt = data.createdAt || new Date().toISOString();
  return {
    id: String(data.id),
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled project',
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 1,
  };
}

// Load a single project. Returns null if missing or corrupt.
export async function getProject(id: string): Promise<Project | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(projectFilePath(id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidProject(data)) return null;
    return normalize(data);
  } catch (_) {
    return null;
  }
}

// Create a new project directory + project.json. Id is generated (never derived
// from the user-supplied name). Returns the created project.
export async function createProject(name: string): Promise<Project> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const project: Project = {
    id,
    name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Untitled project',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  await fs.promises.mkdir(projectDir(id), { recursive: true });
  await writeJsonAtomic(projectFilePath(id), project);
  return project;
}

// Rename a project (bumps updatedAt). Returns the updated project, or null if
// the project doesn't exist.
export async function renameProject(id: string, name: string): Promise<Project | null> {
  if (!isValidId(id)) return null;
  const existing = await getProject(id);
  if (!existing) return null;
  const updated: Project = {
    ...existing,
    name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Untitled project',
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(projectFilePath(id), updated);
  return updated;
}

// Delete a project's directory (recursive). Returns true on success.
export async function deleteProject(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  try {
    await fs.promises.rm(projectDir(id), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}
