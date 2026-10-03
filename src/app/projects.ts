// Project (workspace) persistence — MAIN PROCESS ONLY.
// One directory per project under userData/projects/<id>/project.json.
// The directory name IS the project id. No index file — listProjects() scans
// the dir, exactly like src/history.ts scans userData/history/*/thread.json.
// Mirrors src/history.ts conventions (userData path, graceful skip of
// missing/corrupt files). API keys are NEVER written here.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { sanitizeColorMap } from '../analysis/colorMap';
import type { ColorMap } from '../analysis/colorMap';
import * as recordFs from './recordFs';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
  /**
   * Insight ids the user has dismissed (feat/insights). OPTIONAL, so every
   * record written before this existed stays valid untouched.
   *
   * Ids here, not on the dataset record: dismissing is a VIEW preference over
   * the whole project, and a dataset record is rewritten on every refresh.
   * `insights.Insight.id` names WHAT a finding is about (kind, column, period),
   * so a dismissal survives a recompute and a new period brings the card back.
   * Capped, because this list is unbounded otherwise.
   */
  dismissedInsights?: string[];
  /** Set by Archive: hidden from the switcher, Recent and search, restorable.
   *  Nothing in the project is touched. */
  archivedAt?: string;
  /** When it was last switched to — the switcher's "opened 2h ago", and which
   *  project a launch adopts. Not `updatedAt`: opening changes nothing. */
  lastOpenedAt?: string;
  /**
   * Project-wide category colours: column → value → ramp slot ('chart-3').
   * The first time a value is drawn it is dealt a slot (analysis/colorMap.ts),
   * and every chart, legend, map and export in the project reads it from here.
   * OPTIONAL and sanitized on every read, like the lists above.
   */
  colorMap?: ColorMap;
}

/** Enough for every card on every dataset in a project, several times over. */
const MAX_DISMISSED = 500;


function getProjectsDir(): string {
  return path.join(appPaths.userData(), 'projects');
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
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file); // atomic on same fs
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
    dirents = await recordFs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const projects: Project[] = [];
  for (const dirent of dirents) {
    // A project moved to a sync folder is a LINK here (syncFolder.ts), and a
    // dirent reports a link as isSymbolicLink(), never isDirectory().
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    const id = dirent.name;
    try {
      const raw = await recordFs.readFile(projectFilePath(id), 'utf8');
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
    dismissedInsights: sanitizeDismissed(data.dismissedInsights),
    ...(typeof data.archivedAt === 'string' && data.archivedAt ? { archivedAt: data.archivedAt } : {}),
    ...(typeof data.lastOpenedAt === 'string' && data.lastOpenedAt ? { lastOpenedAt: data.lastOpenedAt } : {}),
    ...colorMapField(data.colorMap),
  };
}

function colorMapField(raw: unknown): { colorMap?: ColorMap } {
  const colorMap = sanitizeColorMap(raw);
  return Object.keys(colorMap).length ? { colorMap } : {};
}

/**
 * Replace the project's colour map (sanitized; an empty map removes the key).
 * Like the insight list, a VIEW preference over the whole project, so
 * `updatedAt` — and Recent's order — stays put. Returns the stored map, or
 * null for a missing project. Callers that read-modify-write serialize
 * themselves (src/ipc/format.ts).
 */
export async function setColorMap(id: string, map: unknown): Promise<ColorMap | null> {
  if (!isValidId(id)) return null;
  const existing = await getProject(id);
  if (!existing) return null;
  const next: Project = { ...existing };
  delete next.colorMap;
  Object.assign(next, colorMapField(map));
  await writeJsonAtomic(projectFilePath(id), next);
  return next.colorMap || sanitizeColorMap(null);
}

/** Archive or un-archive. Like the insight list, NOT an edit of the project's
 *  content, so `updatedAt` (and Recent's order) stays put. */
export async function setArchived(id: string, archived: boolean): Promise<Project | null> {
  const existing = await getProject(id);
  if (!existing) return null;
  const next: Project = { ...existing };
  if (archived) next.archivedAt = new Date().toISOString();
  else delete next.archivedAt;
  await writeJsonAtomic(projectFilePath(id), next);
  return next;
}

/** Stamp "opened now". Best effort: a failed write costs a stale "opened …". */
export async function touchOpened(id: string): Promise<void> {
  const existing = await getProject(id);
  if (!existing) return;
  try {
    await writeJsonAtomic(projectFilePath(id), { ...existing, lastOpenedAt: new Date().toISOString() });
  } catch (_) { /* best effort */ }
}

// Off-disk input: keep only plain non-empty strings, deduped and capped. A
// hand-edited array of objects must not reach the renderer as one.
function sanitizeDismissed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_DISMISSED) break;
  }
  return out;
}

/**
 * Add or remove one dismissed insight id. Returns the stored list, or null if
 * the project is missing. Deliberately does NOT bump `updatedAt`: hiding a card
 * is not a change to the project's content and must not reorder Recent.
 */
export async function setInsightDismissed(
  id: string,
  insightId: string,
  dismissed: boolean,
): Promise<string[] | null> {
  if (!isValidId(id) || typeof insightId !== 'string' || !insightId) return null;
  const existing = await getProject(id);
  if (!existing) return null;
  const current = existing.dismissedInsights || [];
  const next = dismissed
    ? (current.includes(insightId) ? current : [...current, insightId].slice(-MAX_DISMISSED))
    : current.filter((x) => x !== insightId);
  await writeJsonAtomic(projectFilePath(id), { ...existing, dismissedInsights: next });
  return next;
}

// Load a single project. Returns null if missing or corrupt.
export async function getProject(id: string): Promise<Project | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await recordFs.readFile(projectFilePath(id), 'utf8');
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

// Delete a project's directory (recursive). Returns true on success. A synced
// project is a link to the user's own folder: the LINK goes, never the folder.
export async function deleteProject(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  try {
    const st = await fs.promises.lstat(projectDir(id)).catch(() => null);
    if (st && st.isSymbolicLink()) await recordFs.unlink(projectDir(id));
    else await recordFs.rm(projectDir(id), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}
