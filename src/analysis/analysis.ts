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
import type { CardType } from './dashboards';
import * as visuals from './visuals';
import type { FilterStep } from '../data/transforms';
import { sanitizeParameters } from './params';
import type { Parameter } from './params';
import { sanitizeViews, sanitizeDefaultViewId } from './savedViews';
import type { SavedView } from './savedViews';

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
  return withViews({
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
  }, data.views, data.defaultViewId);
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
        views: (a.views || []).map((v) => ({ id: v.id, name: v.name })),
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
    sheets: sanitizePages(input.sheets),
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
    parameters?: unknown;
    views?: unknown;
    defaultViewId?: unknown;
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
    // Replace-or-keep, like every array here.
    parameters: patch.parameters !== undefined ? sanitizeParameters(patch.parameters, randomUUID) : existing.parameters,
    updatedAt: new Date().toISOString(),
  };
  withViews(updated, patch.views !== undefined ? patch.views : existing.views,
    patch.defaultViewId !== undefined ? patch.defaultViewId : existing.defaultViewId);
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


// ── The dashboard's own inventory, flattened ────────────────────────────────
//
// ONE read model, two consumers: the FACTS the Assistant is given about an open
// dashboard (src/ai/copilot.ts analysisFacts) and the context its edit-delta
// validator resolves tile names against (src/analysis/dashboardDelta.ts). They
// must agree — the model can only name a tile the app can then find, so a second
// copy of this walk is how "the Assistant edited the wrong chart" happens.
//
// A visual card stores only `visualId`; its title, chart type and encoding live
// on the separate Visual record, which is why this is async and why the card
// walk alone was never enough.
//
// NAMES ONLY. Column names and aggregation names, never a value and never a
// figure — the same rule every other AI-facing builder in this codebase follows.

export interface AnalysisTile {
  cardId: string;
  /** 0-based index of the page the tile sits on. */
  pageIndex: number;
  type: CardType;
  /** Visual name, metric label, text heading or control label — whatever the
   *  user would actually call this tile when asking to change it. */
  title: string;
  visualId?: string;
  datasetId?: string;
  chartType?: string;
  /** The dimension column, for a visual. A NAME, not its values. */
  category?: string;
  /** Measures as "sum(revenue)" — aggregation + column NAME only. */
  measures?: string[];
}

/** Flatten an Analysis into its tiles, resolving each visual card's Visual
 *  record. A deleted Visual leaves the tile in place with a plain title, so a
 *  broken card is still nameable rather than invisible. */
export async function listAnalysisTiles(projectId: string, a: Analysis): Promise<AnalysisTile[]> {
  const out: AnalysisTile[] = [];
  const seen = new Map<string, Awaited<ReturnType<typeof visuals.getVisual>>>();
  const pages = Array.isArray(a && a.sheets) ? a.sheets : [];
  for (let p = 0; p < pages.length; p += 1) {
    const cards = Array.isArray(pages[p].cards) ? pages[p].cards : [];
    for (const card of cards) {
      if (!card || typeof card !== 'object' || !card.id) continue;
      const tile: AnalysisTile = { cardId: card.id, pageIndex: p, type: card.type, title: '' };
      if (card.type === 'visual' && card.visualId) {
        tile.visualId = card.visualId;
        let v = seen.get(card.visualId);
        if (v === undefined) {
          v = await visuals.getVisual(projectId, card.visualId);
          seen.set(card.visualId, v);
        }
        if (v) {
          tile.title = v.name;
          tile.datasetId = v.datasetId;
          tile.chartType = v.chartType;
          if (v.encoding && typeof v.encoding.category === 'string') tile.category = v.encoding.category;
          const vals = v.encoding && Array.isArray(v.encoding.values) ? v.encoding.values : [];
          tile.measures = vals.map((m) => `${m.aggregation}(${m.column})`);
        } else {
          tile.title = '(deleted visual)';
        }
      } else if (card.type === 'metric' && card.metric) {
        tile.title = card.metric.label || `${card.metric.aggregation}(${card.metric.column})`;
        tile.datasetId = card.metric.datasetId;
      } else if (card.type === 'text') {
        tile.title = card.heading || 'Text';
      } else if (card.type === 'control' && card.control) {
        const param = card.control.kind === 'parameter' ? (a.parameters || []).find((x) => x.id === card.control!.paramId) : undefined;
        tile.title = card.control.label || (param ? param.name : card.control.column);
        if (card.control.datasetId) tile.datasetId = card.control.datasetId;
      }
      if (!tile.title) tile.title = card.type;
      out.push(tile);
    }
  }
  return out;
}
