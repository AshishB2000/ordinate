// Analysis persistence — MAIN PROCESS ONLY.
//
// An Analysis is the AUTHORING container: the surface a user edits. It holds
// sheets of cards and analysis-wide filters, and it PUBLISHES snapshots of
// itself as Dashboards (the read surface). One JSON file per analysis under
// userData/projects/<projectId>/analyses/<id>.json — a fourth sibling of
// datasets/, visuals/ and dashboards/.
//
// A SHEET IS A `Page`. src/dashboards.ts already models exactly this shape
// ({ id, name, cards: Card[] } on the fixed 12-column grid) and already ships
// the sanitizers that whitelist it. This module therefore IMPORTS AND REUSES
// `Page`/`sanitizePages` rather than declaring a parallel type: one shape, one
// sanitiser. `Analysis.sheets` and `Dashboard.pages` differ in name only,
// because those are the words the two surfaces use.
//
// Conventions are copied verbatim from src/dashboards.ts: the dual-UUID
// id-validation guard (BOTH projectId AND the record id are UUID-checked before
// either touches a path, so an analysis path can never escape
// userData/projects/<projectId>/analyses), atomic temp-sibling-then-rename JSON
// writes, graceful skip of missing/corrupt files, and a normalize() that fills
// defaults + re-sanitizes every stored (untrusted) sheet/card/layout on load.
//
// An Analysis (the user-facing Dashboard) references visuals and datasets by id
// and validates NEITHER — a dangling reference degrades gracefully at render
// time.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from '../app/projects';
import { sanitizePages, sanitizeDashboardFilters, sanitizeStyle } from './dashboards';
import type { FilterStep } from '../data/transforms';

// Re-exported so callers can type an analysis sheet without importing two
// modules — and so it stays visible that a sheet IS a dashboard Page.
export type { Page, Card, CardLayout, CardMetric, CardType, CardControl, ControlValue, ControlKind, DashboardStyle } from './dashboards';
import type { Page, DashboardStyle } from './dashboards';

export interface Analysis {
  /** Generated UUID — never derived from the name; it is a filesystem path. */
  id: string;
  /** Re-supplied by the loader, never trusted from the file (see normalize). */
  projectId: string;
  name: string;

  /**
   * The authoring surface. REUSES dashboards.Page verbatim — see the header.
   * Always ≥ 1, the same invariant sanitizePages() enforces for a dashboard.
   */
  sheets: Page[];

  /**
   * Analysis-wide cross-visual filters. Identical semantics to
   * Dashboard.filters: filter-only steps, merged in front of each card's own
   * filters by dashboardFilters.mergeDashboardFilters.
   */
  filters: FilterStep[];

  /**
   * How the sheet LOOKS: theme + density + accent, three closed enums clamped
   * by dashboards.sanitizeStyle. Presentation only — it never moves a card.
   *
   * NOT a schema bump, deliberately. `normalize()` runs sanitizeStyle over the
   * stored value, and sanitizeStyle turns a missing field into
   * DEFAULT_DASHBOARD_STYLE — so every v1 record written before this field
   * existed reads back as the `clean` style, which is exactly what those
   * dashboards already looked like. Same reasoning as `Visual.favorite`
   * (visuals.ts:84-91): bumping the version would buy a migration pass for
   * three strings whose absence already means the right thing.
   */
  style: DashboardStyle;

  createdAt: string;
  /** Bumped by any sheet/filter/name edit. */
  updatedAt: string;
  schemaVersion: 1;
}

export interface AnalysisSummary {
  id: string;
  name: string;
  sheetCount: number;
  updatedAt: string;
}

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id
// ever reaches a filesystem path — an id like ".." would otherwise escape the
// project's analyses dir. Copied verbatim from dashboards.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function analysesDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'analyses');
}

function analysisFilePath(projectId: string, id: string): string {
  return path.join(analysesDir(projectId), id + '.json');
}

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// dashboards.ts, including the per-write UUID suffix — a fixed temp name lets
// two overlapping writes to the same record share one path and interleave into
// a corrupt file (or ENOENT on the second rename).
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

// Basic shape validation for a parsed analysis JSON (skips corrupt files).
function isValidAnalysis(data: any): boolean {
  return Boolean(data) && typeof data.id === 'string' && data.id.length > 0;
}

// Coerce a parsed object into a well-formed Analysis: fill defaults, guarantee
// ≥1 sheet, and re-sanitize every stored sheet/card/layout/filter on load.
// `projectId` comes from the CALLER, never the file, so a hand-edited record
// cannot point itself at another project.
function normalize(data: any, projectId: string): Analysis {
  const createdAt = data.createdAt || new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled dashboard',
    sheets: sanitizePages(data.sheets),
    filters: sanitizeDashboardFilters(data.filters),
    // Absent on every record written before styles existed → the default.
    style: sanitizeStyle(data.style),
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 1,
  };
}

// No-op stub kept for symmetry with dashboards.init()/visuals.init(). The
// per-project analyses/ dir is created lazily on first saveAnalysis.
export async function init(): Promise<void> {
  // Intentionally empty — per-project analyses/ dirs are created on demand.
}

// Return summaries for a project's analyses, newest-updated first. Skips
// corrupt/missing files quietly (ENOENT silent; real damage logged).
export async function listAnalyses(projectId: string): Promise<AnalysisSummary[]> {
  if (!isValidId(projectId)) return [];
  const dir = analysesDir(projectId);
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no analyses dir yet
  }

  const out: AnalysisSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(analysisFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidAnalysis(data)) continue;
      const a = normalize(data, projectId);
      out.push({
        id: a.id,
        name: a.name,
        sheetCount: a.sheets.length,
        updatedAt: a.updatedAt,
      });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[analysis] Skipping corrupt or unreadable analysis:', id, err.message);
      }
    }
  }

  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Load a single analysis. Returns null if either id is invalid, or the file is
// missing/corrupt. A PURE READ — it never migrates and never writes.
export async function getAnalysis(projectId: string, id: string): Promise<Analysis | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(analysisFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidAnalysis(data)) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

// Create a new analysis file. Id is generated (never derived from the name).
// Rejects (returns null) when projectId is not a UUID or the parent project does
// not exist. Referenced visualId/datasetId are NOT
// checked — dangling references degrade gracefully at render time. An analysis
// always gets at least one sheet (a default empty one if none supplied).
export async function saveAnalysis(
  projectId: string,
  input: {
    name: string;
    sheets?: unknown;
    filters?: unknown;
    style?: unknown;
  },
): Promise<Analysis | null> {
  if (!isValidId(projectId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const analysis: Analysis = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled dashboard',
    sheets: sanitizePages(input.sheets),
    filters: sanitizeDashboardFilters(input.filters),
    style: sanitizeStyle(input.style),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
  await fs.promises.mkdir(analysesDir(projectId), { recursive: true });
  await writeJsonAtomic(analysisFilePath(projectId, id), analysis);
  return analysis;
}

// Patch an existing analysis in place, bumping updatedAt. Array fields are
// REPLACED wholesale, never merged; an omitted
// field keeps its stored value. Returns null if either id is invalid or the
// analysis doesn't exist.
//
export async function updateAnalysis(
  projectId: string,
  id: string,
  patch: {
    name?: string;
    sheets?: unknown;
    filters?: unknown;
    style?: unknown;
  },
): Promise<Analysis | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getAnalysis(projectId, id);
  if (!existing) return null;

  const updated: Analysis = {
    ...existing,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name,
    sheets: patch.sheets !== undefined ? sanitizePages(patch.sheets) : existing.sheets,
    filters: patch.filters !== undefined ? sanitizeDashboardFilters(patch.filters) : existing.filters,
    // Same replace-or-keep rule as the arrays above: an OMITTED style keeps the
    // stored one, a SUPPLIED one replaces it wholesale (never axis-merged, for
    // the same reason `sheets` is never merged). So a caller changing one axis
    // must send the whole triple — sanitizeStyle defaults the axes it is not
    // given, and a half-patch would quietly reset the other two.
    style: patch.style !== undefined ? sanitizeStyle(patch.style) : existing.style,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(analysesDir(projectId), { recursive: true });
  await writeJsonAtomic(analysisFilePath(projectId, id), updated);
  return updated;
}

// Delete an analysis file. Returns true on success (force → missing is success).
export async function deleteAnalysis(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(analysisFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
