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
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import { sanitizePages, sanitizeDashboardFilters, sanitizeStyle } from './dashboards';
import type { FilterStep } from '../data/transforms';
import { sanitizeParameters } from './params';
import type { Parameter } from './params';
import { sanitizeViews, sanitizeDefaultViewId } from './savedViews';
import type { SavedView } from './savedViews';

// Re-exported so callers can type an analysis sheet without importing two
// modules — and so it stays visible that a sheet IS a dashboard Page.
export type { Page, Card, CardLayout, CardMetric, CardType, CardControl, ControlValue, ControlKind, DashboardStyle } from './dashboards';
import type { Page, DashboardStyle } from './dashboards';
import * as recordFs from '../app/recordFs';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { logger } from '../app/logger';
import { callerOn } from '../server/authz/caller';
import { asPublished, audienceCopy, copyOf, sanitizePublished, statusOf, type DashboardStatus, type PublishedCopy } from './publishedCopy';
import { AsyncLocalStorage } from 'node:async_hooks';

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

  /**
   * Named values the sheet references — `{{name}}` in titles and text cards,
   * `[[name]]` in filters, calculated fields and metric formulas — each moved by
   * a `parameter` control. `value` is the DEFAULT; what a reader has picked is
   * view state, and only "Save as default" writes it here. See ./params.
   * Absent on every record written before parameters existed, which is exactly
   * "no parameters" — no migration.
   */
  parameters: Parameter[];

  /** Named reader states (./savedViews) and the one the dashboard opens on
   *  ('' = none). Re-sanitized against the sheets on every load and save. */
  views?: SavedView[];
  defaultViewId?: string;

  /**
   * What viewers see (./publishedCopy.ts): the content as last Published, charts frozen. Absent = a draft only
   * editors see. Not content: outside the edit-conflict tag, and Publish never bumps `updatedAt`. Replaces the
   * old `ready: true` flag, which a read turns into a copy once (migrateReady).
   */
  published?: PublishedCopy;

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
  /** Saved views by name — ⌘K lists "Dashboard › View" rows from these. */
  views?: Array<{ id: string; name: string }>;
  /** The first sheet's first two visual cards, as saved-visual ids — what a preview card draws (Home). Absent when it has none. */
  previewIds?: string[];
  /** ./publishedCopy.ts DashboardStatus. A viewer's list holds published ones only, and says `published`. */
  status: DashboardStatus;
  publishedAt?: string;
  publishedBy?: string;
}


function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
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
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file); // atomic on same fs
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
  const a: Analysis = {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled dashboard',
    sheets: sanitizePages(data.sheets),
    filters: sanitizeDashboardFilters(data.filters),
    // Absent on every record written before styles existed → the default.
    style: sanitizeStyle(data.style),
    parameters: sanitizeParameters(data.parameters, randomUUID),
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 1,
  };
  const published = sanitizePublished(data.published, randomUUID);
  if (published) a.published = published;
  // A Ready dashboard whose one-time migration could not be written (migrateReady): published as it stands, charts
  // following the Visuals store until a Publish freezes them — never a dashboard its viewers lose.
  else if (data.ready === true) a.published = copyOf(a, a.updatedAt, undefined);
  return withViews(a, data.views, data.defaultViewId);
}

const audience = new AsyncLocalStorage<true>();

/** A project viewer (read access only) reads published dashboards only; editors, admins and the system read drafts. */
export async function readsPublishedOnly(projectId: string): Promise<boolean> {
  return isValidId(projectId) && (audience.getStore() === true || (await callerOn(projectId)).restricted);
}

/** Runs `fn` reading dashboards as a viewer would, whoever is asking: what a notice to anyone in the project may name. */
export function asAudience<T>(fn: () => Promise<T>): Promise<T> {
  return audience.run(true, fn);
}

/**
 * What a send, a report, a published page or an export renders — they reach viewers: the published copy, or for a
 * dashboard never published (only an editor reaches it) the draft. A viewer's own read is the copy already.
 */
export async function getAudienceAnalysis(projectId: string, id: string): Promise<Analysis | null> {
  const a = await getAnalysis(projectId, id);
  return a && audienceCopy(a);
}

/**
 * `ready: true` (the Ready switch, before drafts) → a published copy of the content as it stands, charts frozen, and
 * the flag gone; every other key byte for byte, so the edit tag and `updatedAt` do not move. Under the record's lock,
 * re-read: a second reader (any pod) finds nothing to do. Never fatal — a failure leaves the stored record, which
 * normalize() still reads as published.
 */
async function migrateReady(projectId: string, id: string, data: any): Promise<any> { // any: the stored record
  if (data.ready !== true) return data;
  try {
    return await patchStored(projectId, id, async (stored) => {
      if (stored.ready !== true) return false;
      if (!sanitizePublished(stored.published, randomUUID)) {
        const a = normalize({ ...stored, ready: undefined }, projectId);
        const { frozenSheets } = require('./publishDashboard') as typeof import('./publishDashboard'); // lazy: it imports this store
        stored.published = { ...copyOf(a, a.updatedAt, undefined), sheets: await frozenSheets(projectId, a.sheets) };
      }
      delete stored.ready;
      return true;
    }) ?? data;
  } catch (err: any) { // any: a write that could not happen
    logger.warn('[analysis] could not move a Ready dashboard to a published copy:', id, err?.message);
    return data;
  }
}

/** The stored JSON of one record, read, patched in place by `fn` (true = write it back) and written, under its lock. Null when missing. */
export async function patchStored(projectId: string, id: string, fn: (stored: any) => Promise<boolean>): Promise<any> { // any: the stored record
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = analysisFilePath(projectId, id);
  return recordFs.locked(file, async () => {
    let data: any; // any: the stored record, patched as parsed
    try {
      data = JSON.parse(await recordFs.readFile(file, 'utf8'));
    } catch (_) {
      return null;
    }
    if (!isValidAnalysis(data)) return null;
    if (await fn(data)) await writeJsonAtomic(file, data);
    return data;
  });
}

/** Saved views, checked against the record's FINAL sheets and parameters — a
 *  view naming a card that is gone loses that pick. Absent → none. */
function withViews(a: Analysis, views: unknown, defaultViewId: unknown): Analysis {
  a.views = sanitizeViews(views, a);
  a.defaultViewId = sanitizeDefaultViewId(defaultViewId, a.views);
  return a;
}

// No-op stub kept for symmetry with dashboards.init()/visuals.init(). The
// per-project analyses/ dir is created lazily on first saveAnalysis.
export async function init(): Promise<void> {
  // Intentionally empty — per-project analyses/ dirs are created on demand.
}

/**
 * One stored record (parsed, past migrateReady) → its summary AS `publishedOnly` reads it, or null for one the list
 * skips: listAnalyses's and ⌘K's index's (0022) one parser. The index reads a `ready` record as it is, as a list does
 * when its migration fails; the next list read migrates it, and that write updates the index.
 */
export function summaryOf(projectId: string, data: any, publishedOnly: boolean): AnalysisSummary | null { // any: the parsed record
  if (!isValidAnalysis(data)) return null;
  const stored = normalize(data, projectId);
  // A viewer lists the published copy, by its own name and sheets; a draft is not listed to them at all.
  const a = publishedOnly ? asPublished(stored) : stored;
  if (!a) return null;
  // From the record already read: no second file, no figure.
  const previewIds = (a.sheets[0]?.cards ?? []).flatMap((c) => (c.type === 'visual' && c.visualId ? [c.visualId] : [])).slice(0, 2);
  return {
    id: a.id,
    name: a.name,
    sheetCount: a.sheets.length,
    updatedAt: a.updatedAt,
    views: (a.views || []).map((v) => ({ id: v.id, name: v.name })),
    ...(previewIds.length ? { previewIds } : {}),
    status: publishedOnly ? 'published' : statusOf(stored),
    ...(stored.published ? { publishedAt: stored.published.publishedAt, ...(stored.published.publishedBy ? { publishedBy: stored.published.publishedBy } : {}) } : {}),
  };
}

// Return summaries for a project's analyses, newest-updated first. Skips
// corrupt/missing files quietly (ENOENT silent; real damage logged).
export async function listAnalyses(projectId: string): Promise<AnalysisSummary[]> {
  if (!isValidId(projectId)) return [];
  const publishedOnly = await readsPublishedOnly(projectId);
  const dir = analysesDir(projectId);
  let dirents;
  try {
    dirents = await recordFs.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no analyses dir yet
  }

  const out: AnalysisSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await recordFs.readFile(analysisFilePath(projectId, id), 'utf8');
      const a = summaryOf(projectId, await migrateReady(projectId, id, JSON.parse(raw)), publishedOnly);
      if (a) out.push(a);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.error('[analysis] Skipping corrupt or unreadable analysis:', id, err.message);
      }
    }
  }

  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Load a single analysis AS THE CALLER MAY READ IT: a viewer gets the published
// copy (./publishedCopy.ts asPublished) or null for a draft — the same null as a
// missing id — so a reader not written with drafts in mind cannot hand one to
// them. Null too if either id is invalid, or the file is missing/corrupt.
export async function getAnalysis(projectId: string, id: string): Promise<Analysis | null> {
  const a = await getStoredAnalysis(projectId, id);
  return a && (await readsPublishedOnly(projectId)) ? asPublished(a) : a;
}

/** The record as stored — the draft, its published copy inside — whoever asks. For writes, and for the sends and
 *  pages that pick the copy themselves (publishedCopy.audienceCopy). The only write is migrateReady's, once. */
export async function getStoredAnalysis(projectId: string, id: string): Promise<Analysis | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await recordFs.readFile(analysisFilePath(projectId, id), 'utf8');
    const data = await migrateReady(projectId, id, JSON.parse(raw));
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
    parameters?: unknown;
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
    // A NEW dashboard's sheets get click-to-filter ON, written explicitly, unless the caller
    // said otherwise. Only here: a stored sheet without the field stays as it was (updateAnalysis).
    sheets: sanitizePages(input.sheets).map((s) => (s.clickFilter === undefined ? { ...s, clickFilter: true } : s)),
    filters: sanitizeDashboardFilters(input.filters),
    style: sanitizeStyle(input.style),
    parameters: sanitizeParameters(input.parameters, randomUUID),
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
// analysis doesn't exist. Holds the record (every pod) while it reads and
// writes; a `base` that is not the stored record's content tag refuses the
// save untouched (src/app/editConflict.ts, ERECORDCHANGED).
export async function updateAnalysis(
  projectId: string,
  id: string,
  patch: {
    name?: string;
    sheets?: unknown;
    filters?: unknown;
    style?: unknown;
    parameters?: unknown;
    views?: unknown;
    defaultViewId?: unknown;
  },
  base?: unknown,
): Promise<Analysis | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = analysisFilePath(projectId, id);
  return lockedUpdate('dashboard', { projectId, id, file }, base, () => readAnalysis(projectId, id), async (existing) => {
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
      // Replace-or-keep, like every array here.
      parameters: patch.parameters !== undefined ? sanitizeParameters(patch.parameters, randomUUID) : existing.parameters,
      updatedAt: new Date().toISOString(),
    };
    withViews(updated, patch.views !== undefined ? patch.views : existing.views,
      patch.defaultViewId !== undefined ? patch.defaultViewId : existing.defaultViewId);
    await fs.promises.mkdir(analysesDir(projectId), { recursive: true });
    await writeJsonAtomic(file, updated);
    return updated;
  });
}

/** The record and the tag of what is stored, from ONE read (src/app/editConflict.ts): its editor's open and the guarded save. */
export async function readAnalysis(projectId: string, id: string): Promise<Tagged<Analysis> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  let ready = false;
  const read = () => readTagged('dashboard', analysisFilePath(projectId, id), (d) => {
    ready = isValidAnalysis(d) && d.ready === true;
    return isValidAnalysis(d) ? normalize(d, projectId) : null;
  });
  const t = await read();
  if (!t || !ready) return t;
  await migrateReady(projectId, id, { ready: true }); // the tag does not move: `published` is outside it
  return read();
}

/**
 * Run `fn` holding this dashboard's record (recordFs.locked: no other holder of it, on any pod, runs
 * meanwhile) — a saved-view edit's read-modify-write. An invalid id holds nothing: get/update refuse it.
 */
export function lockedAnalysis<T>(projectId: string, id: string, fn: () => Promise<T>): Promise<T> {
  return isValidId(projectId) && isValidId(id) ? recordFs.locked(analysisFilePath(projectId, id), fn) : fn();
}

// Delete an analysis file. Returns true on success (force → missing is success).
export async function deleteAnalysis(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(analysisFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

// The dashboard's tiles, flattened (the Assistant's facts and its edit validator): ./analysisTiles.ts.
export { listAnalysisTiles } from './analysisTiles';
export type { AnalysisTile } from './analysisTiles';
