// Metric persistence — MAIN PROCESS ONLY.
// One JSON file per metric under userData/projects/<projectId>/metrics/<id>.json,
// a `metrics/` sibling of `datasets/` and `visuals/`.
//
// A Metric is the app's NAME for a number: "Revenue" is `sum of revenue`, and
// once that is written down once, every surface that shows revenue shows the
// same figure with the same formatting. Before this, each surface carried its
// own `{column, aggregation}` and its own format guess, so a KPI card, an alert
// and a chart legend could all disagree about what "Revenue" meant.
//
// THE NUMBER IS NEVER STORED HERE. A record holds a DEFINITION; the figure is
// resolved on demand by src/ipc/metrics.ts through `computeCardMetric`, which is
// the same call the metric card makes. A stored number would be a number that
// can go stale, and the app does the math — every time.
//
// Mirrors src/analysis/visuals.ts conventions verbatim: the dual-UUID
// id-validation guard (BOTH projectId AND metric id are UUID-checked before
// either touches a path), atomic JSON writes, graceful skip of missing/corrupt
// files, and a normalize() that fills defaults + re-sanitizes on load.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { sanitizeSteps } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from './metricValue';

export type { MetricAggregation };

/** How a metric's number is written for a reader. Every surface that shows the
 *  metric formats through THIS, so one metric reads the same everywhere. */
export interface MetricFormat {
  /**
   * `duration` is a count of SECONDS, rendered as `1h 23m`. A column of days is
   * a `number` with a ` days` suffix — a duration kind that guessed its own unit
   * from the column name would be the app inventing a unit for someone's data.
   */
  kind: 'number' | 'currency' | 'percent' | 'duration';
  /** Fixed decimal places, 0–6. `percent` counts places AFTER the ×100. */
  decimals: number;
  prefix?: string;
  suffix?: string;
  /** 5.2M rather than 5,194,599. Ignored by `duration`, which is already compact. */
  compact: boolean;
}

/** A column rolled up by one aggregation — what every `{column, aggregation}`
 *  in the app already means, now with a name on it. */
export interface MetricSimpleDefinition {
  column: string;
  aggregation: MetricAggregation;
}

/** An expression over OTHER metrics and over aggregations of this dataset's
 *  columns — `[Profit] / [Revenue]`, `sum(revenue) - sum(cost)`. Compiled by the
 *  ordinary formula engine; see ./metricFormula for the one thing that differs. */
export interface MetricFormulaDefinition {
  formula: string;
}

export type MetricDefinition = MetricSimpleDefinition | MetricFormulaDefinition;

export function isFormulaDefinition(d: MetricDefinition): d is MetricFormulaDefinition {
  return typeof (d as MetricFormulaDefinition).formula === 'string';
}

export interface Metric {
  id: string;
  projectId: string;
  name: string;
  datasetId: string;
  definition: MetricDefinition;
  /** Metric-level row filters, applied BEFORE aggregation and BEFORE any scope
   *  filter — "revenue, excluding refunds" is part of what Revenue MEANS. */
  filters: FilterStep[];
  format: MetricFormat;
  description?: string;
  /**
   * Which way is good news. Read by the surfaces that colour a delta — an alert
   * message, an insight mover — so a 10% fall in `Cost` is not painted red.
   * Absent means "no opinion", which is what every metric gets by default.
   */
  direction?: 'up_good' | 'down_good';
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface MetricSummary {
  id: string;
  name: string;
  datasetId: string;
  definition: MetricDefinition;
  format: MetricFormat;
  description?: string;
  direction?: 'up_good' | 'down_good';
  updatedAt: string;
}

let projectsBase: string | null = null;

function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(appPaths.userData(), 'projects');
  return projectsBase;
}

// Ids arrive from the renderer over IPC. Validate the SHAPE before either id
// ever reaches a filesystem path — an id like ".." would otherwise escape the
// project's metrics dir. Copied verbatim from visuals.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function metricsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'metrics');
}

function metricFilePath(projectId: string, id: string): string {
  return path.join(metricsDir(projectId), id + '.json');
}

const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const FORMAT_KINDS: ReadonlySet<string> = new Set(['number', 'currency', 'percent', 'duration']);
const MAX_DECIMALS = 6;
/** An expression longer than this is not a metric, it is a program. */
const MAX_FORMULA = 2000;
const MAX_DESCRIPTION = 500;

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied from
// visuals.ts, per-write tmp suffix and all.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

function trimTo(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/**
 * Whitelist an untrusted (renderer/stored) definition.
 *
 * A formula wins when BOTH shapes are present: `{formula}` is the deliberate
 * one to write, and a stale `{column, aggregation}` left beside it by an editor
 * that switched tabs must not silently become the definition.
 *
 * An unusable input degrades to `count` of nothing, which resolves to null
 * rather than to a wrong figure — the same thing `computeMetric` already does
 * with an unknown column.
 */
export function sanitizeDefinition(raw: unknown): MetricDefinition {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const formula = trimTo(o.formula, MAX_FORMULA);
  if (formula) return { formula };
  const column = typeof o.column === 'string' ? o.column : '';
  const aggregation: MetricAggregation =
    typeof o.aggregation === 'string' && AGG_FNS.has(o.aggregation)
      ? (o.aggregation as MetricAggregation)
      : 'sum';
  return { column, aggregation };
}

/**
 * Whitelist an untrusted format. Every key is clamped rather than rejected: a
 * format is presentation, and a bad one must never be the reason a metric has
 * no value. `decimals` is floored into 0–MAX_DECIMALS; a non-finite one becomes
 * the kind's own default.
 */
export function sanitizeFormat(raw: unknown): MetricFormat {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = typeof o.kind === 'string' && FORMAT_KINDS.has(o.kind)
    ? (o.kind as MetricFormat['kind'])
    : 'number';
  const fallback = kind === 'percent' ? 1 : kind === 'currency' ? 0 : 0;
  const d = typeof o.decimals === 'number' && Number.isFinite(o.decimals) ? Math.floor(o.decimals) : fallback;
  const out: MetricFormat = {
    kind,
    decimals: Math.max(0, Math.min(MAX_DECIMALS, d)),
    compact: o.compact === true,
  };
  // Short, because these sit hard against the number: a long prefix is a label,
  // and the card already has one.
  //
  // NOT trimmed, unlike every other string here: the whole job of a suffix is
  // often the space in front of it (" days"), and trimming one renders 3.5 days
  // as "3.5days". Control characters are stripped instead — a newline inside a
  // KPI value is the only thing whitespace here can do wrong.
  const affix = (raw: unknown): string =>
    typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 8) : '';
  const prefix = affix(o.prefix);
  const suffix = affix(o.suffix);
  if (prefix) out.prefix = prefix;
  if (suffix) out.suffix = suffix;
  return out;
}

// Whitelist metric-level filters. Delegates to transforms.sanitizeSteps so
// filter validation stays single-source, then keeps ONLY 'filter' steps — a
// Metric never carries an aggregate/rename step, its aggregation IS its
// definition. Same rule, same reason, as visuals.sanitizeFilters.
export function sanitizeMetricFilters(raw: unknown): FilterStep[] {
  return sanitizeSteps(raw).filter((s): s is FilterStep => s.type === 'filter');
}

function isValidMetric(data: any): boolean {
  return Boolean(data) && typeof data.id === 'string' && data.id.length > 0 && typeof data.datasetId === 'string';
}

function normalize(data: any, projectId: string): Metric {
  const createdAt = data.createdAt || new Date().toISOString();
  const m: Metric = {
    id: String(data.id),
    projectId,
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Untitled metric',
    datasetId: String(data.datasetId),
    definition: sanitizeDefinition(data.definition),
    filters: sanitizeMetricFilters(data.filters),
    format: sanitizeFormat(data.format),
    createdAt,
    updatedAt: data.updatedAt || createdAt,
    schemaVersion: 1,
  };
  const description = trimTo(data.description, MAX_DESCRIPTION);
  if (description) m.description = description;
  if (data.direction === 'up_good' || data.direction === 'down_good') m.direction = data.direction;
  return m;
}

export function toSummary(m: Metric): MetricSummary {
  const s: MetricSummary = {
    id: m.id,
    name: m.name,
    datasetId: m.datasetId,
    definition: m.definition,
    format: m.format,
    updatedAt: m.updatedAt,
  };
  if (m.description) s.description = m.description;
  if (m.direction) s.direction = m.direction;
  return s;
}

// No-op stub kept for symmetry with projects.init()/visuals.init(). The
// per-project metrics/ dir is created lazily on first saveMetric.
export async function init(): Promise<void> {
  // Intentionally empty — per-project metrics/ dirs are created on demand.
}

/**
 * A project's metrics, by NAME (locale-aware, case-insensitive).
 *
 * Newest-first is wrong for this list in a way it is not wrong for visuals: a
 * metric is looked up by name in a picker, so the order has to be the one a
 * reader can scan. Skips corrupt/missing files quietly (ENOENT silent; real
 * damage logged), exactly as listVisuals does.
 */
export async function listMetrics(projectId: string): Promise<MetricSummary[]> {
  if (!isValidId(projectId)) return [];
  let dirents;
  try {
    dirents = await fs.promises.readdir(metricsDir(projectId), { withFileTypes: true });
  } catch (_) {
    return []; // no metrics dir yet
  }

  const out: MetricSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const id = dirent.name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue; // skip stray/tmp files
    try {
      const raw = await fs.promises.readFile(metricFilePath(projectId, id), 'utf8');
      const data = JSON.parse(raw);
      if (!isValidMetric(data)) continue;
      out.push(toSummary(normalize(data, projectId)));
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[metrics] Skipping corrupt or unreadable metric:', id, err.message);
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

export async function getMetric(projectId: string, id: string): Promise<Metric | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const raw = await fs.promises.readFile(metricFilePath(projectId, id), 'utf8');
    const data = JSON.parse(raw);
    if (!isValidMetric(data)) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

/**
 * Load a project's metrics as FULL records, keyed by lowercased name.
 *
 * This is what a formula metric resolves `[Revenue]` against, so it is one
 * directory read for a whole resolution rather than one per reference. A
 * duplicate name keeps the FIRST by sort order, which `listMetrics` has already
 * made deterministic — two metrics called "Revenue" is a mistake the editor
 * prevents, and picking one by disk order would make it a different mistake on
 * every machine.
 */
export async function metricsByName(projectId: string): Promise<Map<string, Metric>> {
  const out = new Map<string, Metric>();
  for (const s of await listMetrics(projectId)) {
    const key = s.name.toLowerCase();
    if (out.has(key)) continue;
    const full = await getMetric(projectId, s.id);
    if (full) out.set(key, full);
  }
  return out;
}

export interface MetricInput {
  name: string;
  datasetId: string;
  definition: unknown;
  filters?: unknown;
  format?: unknown;
  description?: unknown;
  direction?: unknown;
}

/**
 * Create a metric. Id is generated, never derived from the name.
 *
 * Rejects (returns null) when projectId/datasetId are not UUIDs, the parent
 * project is missing, or the referenced dataset does not exist — a metric that
 * names no real dataset is a row in the table that can never resolve. The
 * dataset check is metadata-only: nothing here reads a row.
 */
export async function saveMetric(projectId: string, input: MetricInput): Promise<Metric | null> {
  if (!isValidId(projectId) || !isValidId(input.datasetId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;
  const ds = await datasets.getDatasetMeta(projectId, input.datasetId);
  if (!ds) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  const metric = normalize(
    { ...input, id, createdAt: now, updatedAt: now, datasetId: input.datasetId },
    projectId,
  );
  await fs.promises.mkdir(metricsDir(projectId), { recursive: true });
  await writeJsonAtomic(metricFilePath(projectId, id), metric);
  return metric;
}

/**
 * Patch a metric in place, bumping updatedAt. `datasetId` is immutable — a
 * re-target is a new metric, because every card and rule pointing at this one
 * was written about THIS dataset's numbers.
 */
export async function updateMetric(
  projectId: string,
  id: string,
  patch: Partial<MetricInput>,
): Promise<Metric | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getMetric(projectId, id);
  if (!existing) return null;

  const updated: Metric = {
    ...existing,
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : existing.name,
    definition: patch.definition !== undefined ? sanitizeDefinition(patch.definition) : existing.definition,
    filters: patch.filters !== undefined ? sanitizeMetricFilters(patch.filters) : existing.filters,
    format: patch.format !== undefined ? sanitizeFormat(patch.format) : existing.format,
    updatedAt: new Date().toISOString(),
  };
  // Both are CLEARABLE, so "key present" decides, not truthiness: passing '' is
  // how the editor removes a description, and `undefined` is how it leaves one
  // alone. A truthiness test would make an emptied box a no-op.
  if (patch.description !== undefined) {
    const d = trimTo(patch.description, MAX_DESCRIPTION);
    if (d) updated.description = d;
    else delete updated.description;
  }
  if (patch.direction !== undefined) {
    if (patch.direction === 'up_good' || patch.direction === 'down_good') updated.direction = patch.direction;
    else delete updated.direction;
  }

  await fs.promises.mkdir(metricsDir(projectId), { recursive: true });
  await writeJsonAtomic(metricFilePath(projectId, id), updated);
  return updated;
}

/** Copy a metric into a new file with a fresh UUID and " (copy)" appended. The
 *  parent project and dataset are already known-valid (the source loaded). */
export async function duplicateMetric(projectId: string, id: string): Promise<Metric | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const source = await getMetric(projectId, id);
  if (!source) return null;

  const newId = randomUUID();
  const now = new Date().toISOString();
  const copy: Metric = { ...source, id: newId, name: `${source.name} (copy)`, createdAt: now, updatedAt: now };
  await fs.promises.mkdir(metricsDir(projectId), { recursive: true });
  await writeJsonAtomic(metricFilePath(projectId, newId), copy);
  return copy;
}

/**
 * Delete a metric file. Returns true on success (force → missing is success).
 *
 * Deliberately does NOT consult usage. A dangling `metricId` is handled the way
 * a dangling `visualId` already is — the consumer falls back to its own stored
 * `{column, aggregation}` and the card keeps showing its number — so blocking
 * the delete here would trade a graceful degrade for a record the user cannot
 * remove. The CONFIRM is the UI's job (src/ipc/metrics.ts's `metric:usage`
 * feeds it), which is where a human can weigh it.
 */
export async function deleteMetric(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await fs.promises.rm(metricFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
