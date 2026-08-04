// Dashboard persistence — MAIN PROCESS ONLY.
// One JSON file per dashboard under userData/projects/<projectId>/dashboards/<id>.json,
// a `dashboards/` sibling of `datasets/` and `visuals/`. A Dashboard is a grid of
// cards across one or more pages, saved per project. Cards come in three types:
// visual (references a saved Visual by id), text (heading + body), and metric
// (a dataset column + aggregation → ONE app-computed number, produced only by the
// pure src/metricValue.ts helper — never stored, never from the model).
//
// Mirrors src/visuals.ts / src/datasets.ts conventions verbatim: the dual-UUID
// id-validation guard (BOTH projectId AND dashboard id are UUID-checked before
// either touches a path, so a dashboard path can never escape
// userData/projects/<projectId>/dashboards), atomic JSON writes, graceful skip of
// missing/corrupt files, and a normalize() that fills defaults + re-sanitizes every
// stored (untrusted) card/page/layout on load.
//
// A dashboard does NOT validate that referenced visualId/datasetId still exist —
// a dangling reference is handled gracefully at render time (the card shows a
// placeholder), so deleting a visual/dataset never corrupts a dashboard.
//
// ── schema v3: a Card is TWO-SHAPED ────────────────────────────────────────
// An authoring card (on an analysis sheet, or on a legacy dashboard) REFERENCES
// a visual by id. A PUBLISHED card carries an inline `CardVisual` — a by-value
// copy of the Visual's definition taken at publish time. That copy is the whole
// snapshot guarantee: editing (or deleting) the source Visual afterwards cannot
// change one byte of the published dashboard.
//
// This module therefore takes a VALUE import of ./visuals for its three
// sanitizers. There is no cycle (visuals.ts imports projects/datasets/transforms
// and never dashboards), and calling the real sanitizers is deliberate: a
// CardVisual is untrusted renderer/disk input and duplicating a security
// whitelist is how whitelists drift.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from './projects';
import { sanitizeChartType, sanitizeEncoding, sanitizeOverrides, sanitizeFilters } from './visuals';
import type { Visual } from './visuals';
import { sanitizeSteps } from './transforms';
import type { FilterStep } from './transforms';

export type CardType = 'visual' | 'text' | 'metric';
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

// The fixed column count the renderer's CSS grid uses (kept in sync with the
// .dash-grid class in hub.css). Exported so callers/tests share one source.
export const GRID_COLS = 12;

export interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardMetric {
  datasetId: string;
  column: string;
  aggregation: MetricAggregation;
  label?: string;
  format?: 'auto' | 'plain' | 'thousands' | 'compact' | 'percent' | 'currency';
}

/**
 * A by-value copy of a Visual's DEFINITION, taken at publish time — NOT a copy
 * of its data. Every figure a published card shows is still recomputed on open
 * from the LIVE dataset (`visual:data` takes exactly these fields), so a
 * published dashboard shows current data through a frozen definition.
 *
 * Derived with `Pick<Visual, …>` on purpose: if `Visual` grows a field, this
 * type does not silently acquire it, and the copy site in `analysis:publish` is
 * the one place that has to decide whether a published card should carry it.
 */
export type CardVisual = Pick<
  Visual,
  'datasetId' | 'name' | 'chartType' | 'encoding' | 'overrides' | 'filters'
>;

export interface Card {
  id: string; // UUID — a stable key only, never a filesystem path
  type: CardType;
  layout: CardLayout;

  /** Authoring-time REFERENCE — analysis sheets and legacy dashboards. */
  visualId?: string; // type 'visual'

  /**
   * Publish-time SNAPSHOT. WHEN PRESENT IT WINS: no render path may resolve
   * `visualId`. A published card keeps `visualId` too, but only as (i) the
   * republish source and (ii) an "open the source visual" affordance.
   */
  visual?: CardVisual; // type 'visual'

  heading?: string; // type 'text'
  text?: string; // type 'text'
  metric?: CardMetric; // type 'metric'
}

export interface Page {
  id: string;
  name: string;
  cards: Card[];
}

export interface Dashboard {
  id: string;
  projectId: string;
  name: string;
  pages: Page[];
  // Dashboard-wide row filters (Week 10, schema v2). Reuses the Week 6 transforms
  // FilterStep so `applyPipeline`/`buildVizData` apply them verbatim. Merged into
  // every card (dashboard filters first) before aggregation, so one filter drives
  // all cards — 100% app-computed, strict-number rule intact. A v1 file (no
  // `filters`) normalizes to [], i.e. behaves exactly as Week 9 (backward-compatible).
  filters: FilterStep[];

  // ── schema v3: a dashboard is the PUBLISHED SNAPSHOT of an Analysis ────────
  // `analysisId` is PROVENANCE ONLY. It must NEVER become a lookup — "load the
  // analysis to render the dashboard" would destroy the snapshot guarantee, and
  // a published dashboard has to render with its analysis deleted. null = a
  // legacy standalone dashboard, or one created before its analysis existed.
  analysisId: string | null;
  // When this snapshot was taken; null on a legacy record.
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 3;
}

export interface DashboardSummary {
  id: string;
  name: string;
  pageCount: number;
  updatedAt: string;
}

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id ever
// reaches a filesystem path — an id like ".." would otherwise escape the project's
// dashboards dir. Copied verbatim from visuals.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function dashboardsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'dashboards');
}

function dashboardFilePath(projectId: string, id: string): string {
  return path.join(dashboardsDir(projectId), id + '.json');
}

const CARD_TYPES: ReadonlySet<string> = new Set(['visual', 'text', 'metric']);
const METRIC_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const METRIC_FORMATS: ReadonlySet<string> = new Set([
  'auto',
  'plain',
  'thousands',
  'compact',
  'percent',
  'currency',
]);

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// visuals.ts.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

// ── Defensive whitelisting (never throw — "keep known keys, clamp, drop rest") ──

// Coerce one field to a finite non-negative integer with a fallback.
function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

// Clamp an untrusted layout onto the fixed grid: w ∈ [1, GRID_COLS], h ≥ 1,
// x ∈ [0, GRID_COLS-1], y ≥ 0, and x + w ≤ GRID_COLS (overflow shrinks w).
export function sanitizeLayout(raw: unknown): CardLayout {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  let x = intOr(o.x, 0);
  let y = intOr(o.y, 0);
  let w = intOr(o.w, 1);
  let h = intOr(o.h, 1);

  if (x < 0) x = 0;
  if (x > GRID_COLS - 1) x = GRID_COLS - 1;
  if (y < 0) y = 0;
  if (w < 1) w = 1;
  if (w > GRID_COLS) w = GRID_COLS;
  if (h < 1) h = 1;
  if (x + w > GRID_COLS) w = GRID_COLS - x; // overflow shrinks width

  return { x, y, w, h };
}

/**
 * Whitelist an untrusted inline visual snapshot. DELEGATES to the real
 * visuals.ts sanitizers (`sanitizeChartType`/`sanitizeEncoding`/
 * `sanitizeOverrides`/`sanitizeFilters`) rather than reimplementing them, so a
 * published card can never be a looser whitelist than the Visual it was copied
 * from. Returns null when there is no dataset to draw from — a snapshot without
 * one carries nothing renderable.
 *
 * `datasetId` is checked as a non-empty string, not as a UUID, matching the
 * metric-card rule above: it never touches a path here, and every consumer
 * (`datasets.getDataset`/`getDatasetMeta`) re-validates the UUID shape before
 * one is built.
 */
export function sanitizeCardVisual(raw: unknown): CardVisual | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const datasetId = typeof o.datasetId === 'string' ? o.datasetId : '';
  if (!datasetId) return null;
  return {
    datasetId,
    name: typeof o.name === 'string' ? o.name : '',
    chartType: sanitizeChartType(o.chartType),
    encoding: sanitizeEncoding(o.encoding),
    overrides: sanitizeOverrides(o.overrides),
    filters: sanitizeFilters(o.filters),
  };
}

// Whitelist one untrusted card by type. An unknown type, or a type missing its
// required payload, → null (dropped by sanitizeCards). Each card gets a stable
// UUID key (a stray/invalid stored id is regenerated).
export function sanitizeCard(raw: unknown): Card | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const type = typeof o.type === 'string' && CARD_TYPES.has(o.type) ? (o.type as CardType) : null;
  if (!type) return null;

  const id = isValidId(o.id) ? o.id : randomUUID();
  const layout = sanitizeLayout(o.layout);
  const card: Card = { id, type, layout };

  if (type === 'visual') {
    // TWO-SHAPED (v3): a visual card is meaningful with a valid `visualId`
    // (authoring) OR a well-formed inline `visual` (published). Both may be
    // present — a published card keeps its reference for republish — and a card
    // carrying NEITHER still has nothing to draw, so it is dropped as before.
    if (isValidId(o.visualId)) card.visualId = o.visualId;
    const inline = sanitizeCardVisual(o.visual);
    if (inline) card.visual = inline;
    if (card.visualId === undefined && card.visual === undefined) return null;
    return card;
  }

  if (type === 'text') {
    if (typeof o.heading === 'string') card.heading = o.heading;
    if (typeof o.text === 'string') card.text = o.text;
    // A text card with neither heading nor body carries no content → drop it.
    if (card.heading === undefined && card.text === undefined) return null;
    return card;
  }

  // metric — needs a dataset column + a known aggregation.
  const m = o.metric && typeof o.metric === 'object' ? (o.metric as Record<string, unknown>) : null;
  if (!m) return null;
  const datasetId = typeof m.datasetId === 'string' ? m.datasetId : '';
  const column = typeof m.column === 'string' ? m.column : '';
  const aggregation =
    typeof m.aggregation === 'string' && METRIC_AGGS.has(m.aggregation)
      ? (m.aggregation as MetricAggregation)
      : null;
  if (!datasetId || !column || !aggregation) return null;
  const metric: CardMetric = { datasetId, column, aggregation };
  if (typeof m.label === 'string') metric.label = m.label;
  if (typeof m.format === 'string' && METRIC_FORMATS.has(m.format)) {
    metric.format = m.format as CardMetric['format'];
  }
  card.metric = metric;
  return card;
}

// Map+filter: keep only cards that survive sanitizeCard.
export function sanitizeCards(raw: unknown): Card[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Card[] = [];
  for (const c of arr) {
    const card = sanitizeCard(c);
    if (card) out.push(card);
  }
  return out;
}

// Whitelist one page: a UUID id (regenerated if missing/invalid), a non-empty
// name (defaulted), and sanitized cards.
export function sanitizePage(raw: unknown): Page {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = isValidId(o.id) ? o.id : randomUUID();
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Page 1';
  return { id, name, cards: sanitizeCards(o.cards) };
}

// Whitelist the pages array. A dashboard always has ≥1 page — an empty/invalid
// input yields a single default page.
export function sanitizePages(raw: unknown): Page[] {
  const arr = Array.isArray(raw) ? raw : [];
  const pages = arr.map((p) => sanitizePage(p));
  if (pages.length === 0) return [{ id: randomUUID(), name: 'Page 1', cards: [] }];
  return pages;
}

// Whitelist untrusted dashboard-wide filters: delegate to the shared
// transforms.sanitizeSteps (drops unknown types/fields) and keep ONLY `filter`
// steps — a dashboard filter is a row predicate, never a column-mutating transform.
// A non-array / absent input → [] (backward-compatible v1 → v2 default). Kept
// separate from visuals.sanitizeFilters because these are the DASHBOARD's own
// filters, not a visual's — the two happen to share a rule, not a meaning.
// (This module does import visuals.ts as of v3, for the CardVisual sanitizers.)
export function sanitizeDashboardFilters(raw: unknown): FilterStep[] {
  return sanitizeSteps(raw).filter((s): s is FilterStep => s.type === 'filter');
}

// Basic shape validation for a parsed dashboard.json (skips corrupt files).
function isValidDashboard(data: any): boolean {
  return Boolean(data) && typeof data.id === 'string' && data.id.length > 0;
}

// Coerce a parsed object into a well-formed Dashboard (fills defaults, guarantees
// schemaVersion 1 + ≥1 page, and re-sanitizes every card on load).
//
// v1/v2 → v3 IS AN IN-MEMORY UPGRADE THAT WRITES NOTHING. This is the same
// contract v1→v2 already had for `filters` ("absent (v1) → []"), and it is what
// lets the implicit-analysis wrap be triggered by an EDIT rather than by a read:
// listing and opening a legacy dashboard leave the bytes on disk untouched, and
// the file stays v2 until something actually writes it.
function normalize(data: any, projectId: string): Dashboard {
  const createdAt = data.createdAt || new Date().toISOString();
  return {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled dashboard',
    pages: sanitizePages(data.pages),
    filters: sanitizeDashboardFilters(data.filters), // absent (v1) → []
    analysisId: isValidId(data.analysisId) ? data.analysisId : null, // absent (v1/v2) → null
    publishedAt: typeof data.publishedAt === 'string' && data.publishedAt ? data.publishedAt : null,
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 3,
  };
}

// No-op stub kept for symmetry with visuals.init(). The per-project dashboards/
// dir is created lazily on first saveDashboard.
export async function init(): Promise<void> {
  // Intentionally empty — per-project dashboards/ dirs are created on demand.
}

// Return summaries for a project's dashboards, newest-updated first. Skips
// corrupt/missing files quietly (ENOENT silent; real damage logged).
export async function listDashboards(projectId: string): Promise<DashboardSummary[]> {
  if (!isValidId(projectId)) return [];
  const dir = dashboardsDir(projectId);
  let dirents;
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return []; // no dashboards dir yet
  }

  const out: DashboardSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(dashboardFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidDashboard(data)) continue;
      const d = normalize(data, projectId);
      out.push({ id: d.id, name: d.name, pageCount: d.pages.length, updatedAt: d.updatedAt });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[dashboards] Skipping corrupt or unreadable dashboard:', id, err.message);
      }
    }
  }

  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}

// Load a single dashboard. Returns null if either id is invalid, or the file is
// missing/corrupt.
export async function getDashboard(projectId: string, id: string): Promise<Dashboard | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(dashboardFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidDashboard(data)) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

// Create a new dashboard file. Id is generated (never derived from the name).
// Rejects (returns null) when projectId is not a UUID or the parent project does
// not exist (mirrors saveVisual). Referenced visualId/datasetId are NOT checked —
// dangling references degrade gracefully at render time. A dashboard always gets
// at least one page (a default empty page if none supplied).
export async function saveDashboard(
  projectId: string,
  input: { name: string; pages?: unknown; filters?: unknown; analysisId?: unknown; publishedAt?: unknown },
): Promise<Dashboard | null> {
  if (!isValidId(projectId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const dashboard: Dashboard = {
    id,
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled dashboard',
    pages: sanitizePages(input.pages),
    filters: sanitizeDashboardFilters(input.filters),
    analysisId: isValidId(input.analysisId) ? input.analysisId : null,
    publishedAt: typeof input.publishedAt === 'string' && input.publishedAt ? input.publishedAt : null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 3,
  };
  await fs.promises.mkdir(dashboardsDir(projectId), { recursive: true });
  await writeJsonAtomic(dashboardFilePath(projectId, id), dashboard);
  return dashboard;
}

// Patch an existing dashboard's name and/or full pages array in place, bumping
// updatedAt. Returns null if either id is invalid or the dashboard doesn't exist.
//
// ── A PUBLISHED DASHBOARD IS READ-ONLY, AND IT IS ENFORCED HERE ─────────────
// `analysisId !== null` means "this file is a snapshot someone published". Any
// write to it that is not itself a publish is REFUSED (null), no matter which
// main-process caller made it. The guard lives in the store, not in the
// renderer, because the renderer's ~600 ms autosave debounce would otherwise
// overwrite a snapshot the moment a card was nudged — and a renderer-side check
// is a courtesy, not a guarantee.
//
// `opts.publish` is the ONE way past it, and only two callers may set it:
// `analysis:publish` (writing the new snapshot) and the implicit wrap (stamping
// provenance onto a legacy dashboard). Neither is a user edit of the snapshot's
// contents.
export async function updateDashboard(
  projectId: string,
  id: string,
  patch: { name?: string; pages?: unknown; filters?: unknown; analysisId?: unknown; publishedAt?: unknown },
  opts: { publish?: boolean } = {},
): Promise<Dashboard | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getDashboard(projectId, id);
  if (!existing) return null;
  if (existing.analysisId !== null && !opts.publish) return null; // read-only snapshot

  const updated: Dashboard = {
    ...existing,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name,
    pages: patch.pages !== undefined ? sanitizePages(patch.pages) : existing.pages,
    filters: patch.filters !== undefined ? sanitizeDashboardFilters(patch.filters) : existing.filters,
    analysisId:
      patch.analysisId !== undefined
        ? (isValidId(patch.analysisId) ? patch.analysisId : null)
        : existing.analysisId,
    publishedAt:
      patch.publishedAt !== undefined
        ? (typeof patch.publishedAt === 'string' && patch.publishedAt ? patch.publishedAt : null)
        : existing.publishedAt,
    updatedAt: new Date().toISOString(),
  };
  await fs.promises.mkdir(dashboardsDir(projectId), { recursive: true });
  await writeJsonAtomic(dashboardFilePath(projectId, id), updated);
  return updated;
}

// Delete a dashboard file. Returns true on success (force → missing is success).
export async function deleteDashboard(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(dashboardFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
