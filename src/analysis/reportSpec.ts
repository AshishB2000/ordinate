// The Report record — shape, sanitizers, default page list, and its on-disk
// store. MAIN PROCESS ONLY.
//
// A Report is a project record like an Analysis is, and this file is built the
// same way analysis.ts is, for the same reasons: the shape and its defensive
// clamps sit next to the CRUD that writes them, because a sanitizer in one file
// and the write in another is how a record ends up on disk in a shape the
// loader rejects. Per-project dir, UUID ids validated before they touch a path,
// atomic temp-then-rename writes, corrupt files skipped rather than fatal.
//
// A report is a PAGE LIST plus how to print it. It stores no figure and no
// picture: every number in a generated file is recomputed from the live
// dataset at generation time, through the same compute IPC the dashboard uses.
// What it does store is the page ORDER, which pages are in, and any caption the
// author overrode — decisions, not data.
//
// The DUE CHECK (scheduleDue) is a pure exported function taking `now`, for the
// same reason refreshScheduler's is: nothing in src/ should call Date.now()
// inside logic a test wants to pin.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import { GRID_COLS } from './dashboards';
import type { Card, Page } from './dashboards';
import { t } from '../app/i18n';
import * as recordFs from '../app/recordFs';

export type ReportFormat = 'pdf' | 'pptx' | 'docx';
export type ReportPageKind = 'cover' | 'summary' | 'sheet' | 'tile' | 'notes' | 'narrative' | 'discussion' | 'scorecard';
export type ReportPageLayout = 'full' | 'half';
export type ReportCadence = 'off' | 'daily' | 'weekly' | 'monthly';
export type PaperSize = 'letter' | 'a4';
export type PaperOrientation = 'portrait' | 'landscape';

export interface ReportPage {
  /** Generated UUID. A list key only — a page is never a file. */
  id: string;
  kind: ReportPageKind;
  /** 0-based sheet index — `sheet` pages. */
  sheetIdx?: number;
  /** The card this page is about — `tile` pages. */
  cardId?: string;
  /** Author prose — `notes` pages. */
  notes?: string;
  /** The scorecard this page prints — `scorecard` pages (analysis/scorecards.ts). */
  scorecardId?: string;
  /**
   * The author's replacement for the app's sentence. ABSENT means "use the
   * app's", which is why it is optional rather than seeded with the computed
   * string: seeding it would freeze today's figures into the record and the
   * caption would stop following the data.
   */
  caption?: string;
  /** Unchecked in the page list → skipped at generation, kept in the record. */
  include: boolean;
  layout: ReportPageLayout;
}

export interface ReportCover {
  title: string;
  subtitle?: string;
  /** Print the app's mark on the cover. */
  logo?: boolean;
}

export interface ReportSchedule {
  cadence: ReportCadence;
  /** Local time of day, "HH:MM". The earliest a run may start on its day. */
  at: string;
  /** Absolute directory the user picked. Empty → the schedule cannot run. */
  folder: string;
}

export interface ReportPaper {
  size: PaperSize;
  orientation: PaperOrientation;
}

export interface Report {
  id: string;
  /** Re-supplied by the loader, never trusted from the file. */
  projectId: string;
  /** The dashboard this report prints. Dangling → the report opens empty. */
  analysisId: string;
  /**
   * A report made FROM a scorecard prints that scorecard and has no dashboard
   * (`analysisId` is ''). Absent on every dashboard report — no migration.
   */
  scorecardId?: string;
  name: string;
  format: ReportFormat;
  pages: ReportPage[];
  cover: ReportCover;
  /** Ignored for PPTX, which is always 16:9. */
  paper: ReportPaper;
  /** Print the filter bar's current selections on the cover. */
  includeFilters: boolean;
  /** Add a model-written Narrative page. Off by default; needs a model. */
  narrative: boolean;
  /** Add a final Discussion page: the dashboard's comment threads. Off by
   *  default — comments are a working conversation, printed only on purpose. */
  discussion: boolean;
  /** Print under a saved view of the dashboard (./savedViews): its id, 'all'
   *  for one section per view, or absent for the dashboard as saved. */
  viewId?: string;
  schedule?: ReportSchedule;
  lastRunAt?: string;
  lastFile?: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface ReportSummary {
  id: string;
  name: string;
  analysisId: string;
  format: ReportFormat;
  /** The Reports tab draws the cover small, so it needs the cover. Free — it is
   *  already on the record this summary is built from. */
  cover: ReportCover;
  paper: ReportPaper;
  pageCount: number;
  schedule?: ReportSchedule;
  lastRunAt?: string;
  lastFile?: string;
  updatedAt: string;
}

// ── defensive whitelisting (never throw — keep known keys, clamp, drop rest) ──

const FORMATS: ReadonlySet<string> = new Set(['pdf', 'pptx', 'docx']);
const KINDS: ReadonlySet<string> = new Set(['cover', 'summary', 'sheet', 'tile', 'notes', 'narrative', 'discussion', 'scorecard']);
const CADENCES: ReadonlySet<string> = new Set(['off', 'daily', 'weekly', 'monthly']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function sanitizeFormat(raw: unknown): ReportFormat {
  return FORMATS.has(raw as string) ? (raw as ReportFormat) : 'pdf';
}

export function sanitizePaper(raw: unknown): ReportPaper {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    size: o.size === 'a4' ? 'a4' : 'letter',
    orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

export function sanitizeCover(raw: unknown): ReportCover {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cover: ReportCover = { title: str(o.title).trim() || t('common.report'), logo: o.logo !== false };
  const subtitle = str(o.subtitle).trim();
  if (subtitle) cover.subtitle = subtitle;
  return cover;
}

/** "HH:MM" or the 09:00 default. Anything unparseable becomes the default. */
export function sanitizeTimeOfDay(raw: unknown): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str(raw).trim());
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : '09:00';
}

export function sanitizeSchedule(raw: unknown): ReportSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const cadence = (CADENCES.has(o.cadence as string) ? o.cadence : 'off') as ReportCadence;
  // An absolute path only. The folder is a directory the user picked through
  // the native panel, and a relative one would resolve against the app's cwd.
  const folder = str(o.folder);
  return { cadence, at: sanitizeTimeOfDay(o.at), folder: path.isAbsolute(folder) ? folder : '' };
}

export function sanitizePage(raw: unknown): ReportPage | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || !KINDS.has(o.kind as string)) return null;
  const page: ReportPage = {
    id: isValidId(o.id) ? o.id : randomUUID(),
    kind: o.kind as ReportPageKind,
    include: o.include !== false,
    layout: o.layout === 'half' ? 'half' : 'full',
  };
  if (page.kind === 'sheet') {
    const n = Number(o.sheetIdx);
    page.sheetIdx = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  }
  // A cardId is a dashboards.Card id — a UUID, and a dangling one degrades to a
  // "tile no longer on this dashboard" placeholder rather than corrupting the
  // record, the same rule a dashboard card's visualId follows.
  if (page.kind === 'tile' && isValidId(o.cardId)) page.cardId = o.cardId;
  if (page.kind === 'notes') page.notes = str(o.notes);
  // A scorecard page names its scorecard by UUID; one naming nothing is dropped.
  if (page.kind === 'scorecard') {
    if (!isValidId(o.scorecardId)) return null;
    page.scorecardId = o.scorecardId;
  }
  const caption = str(o.caption);
  if (caption) page.caption = caption;
  return page;
}

export function sanitizePages(raw: unknown): ReportPage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizePage).filter((p): p is ReportPage => p !== null);
}

// ── the default page list ────────────────────────────────────────────────────

/**
 * The report a dashboard gets before anyone edits it: a cover, a summary, one
 * page per sheet, then one page per BIG chart.
 *
 * "Big" is `w >= GRID_COLS / 2` — half a sheet or more. The sample dashboard's
 * three charts are exactly half-width (planBuild.ts's `chartW`), and they are
 * precisely the tiles that earn a page of their own; a 3-wide KPI tile does
 * not, and neither does a text note. So the cut is at half, inclusive.
 *
 * Pure: it reads the sheets and returns a list. It does not look at the data,
 * which is why the same call is safe to make for a preview and for a save.
 */
export function defaultPages(sheets: Page[] | null | undefined): ReportPage[] {
  const pages: ReportPage[] = [
    { id: randomUUID(), kind: 'cover', include: true, layout: 'full' },
    { id: randomUUID(), kind: 'summary', include: true, layout: 'full' },
  ];
  const list = Array.isArray(sheets) ? sheets : [];
  list.forEach((_sheet, i) => {
    pages.push({ id: randomUUID(), kind: 'sheet', sheetIdx: i, include: true, layout: 'full' });
  });
  for (const sheet of list) {
    for (const card of (Array.isArray(sheet.cards) ? sheet.cards : []) as Card[]) {
      if (!isBigChart(card)) continue;
      pages.push({ id: randomUUID(), kind: 'tile', cardId: card.id, include: true, layout: 'full' });
    }
  }
  return pages;
}

/** A visual card taking half a sheet or more — see defaultPages. */
export function isBigChart(card: Card | null | undefined): boolean {
  if (!card || card.type !== 'visual' || !card.id) return false;
  const w = card.layout && Number(card.layout.w);
  return Number.isFinite(w) && w >= GRID_COLS / 2;
}

// ── filenames ────────────────────────────────────────────────────────────────

/**
 * `<name>-<YYYY-MM-DD>.<ext>` — the name a generated file lands under.
 *
 * The date is the LOCAL one, not UTC: a report the user generated on Tuesday
 * evening in UTC-5 is a Tuesday report to them, and a UTC stamp would file it
 * under Wednesday. Same reason the schedule's `at` is a local time of day.
 */
export function reportFilename(name: string, ext: string, when: Date = new Date()): string {
  const slug = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
  return `${slug}-${localDateStamp(when)}.${String(ext).replace(/[^a-z0-9]/gi, '')}`;
}

/** YYYY-MM-DD in the machine's own timezone. */
export function localDateStamp(when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
}

// ── the schedule ─────────────────────────────────────────────────────────────

// ponytail: a month is 30 days here. Calendar months would need a
// "same day-of-month next month" walk plus a rule for the 31st, and nothing in
// the UI promises more than "monthly". Revisit if a user asks for "the 1st".
const CADENCE_MS: Record<Exclude<ReportCadence, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Which of these are due at `now` — pure, and the whole scheduling rule.
 *
 * Two gates, both needed. The INTERVAL gate is the same one refreshScheduler
 * uses, including its self-healing treatment of an unparseable stamp as
 * "never ran": treating a corrupt stamp as "just ran" would disable the
 * schedule forever. The TIME-OF-DAY gate is what makes "daily at 09:00" mean
 * 09:00 rather than "24 hours after whenever it last happened to fire".
 *
 * A schedule with no folder is never due. There is nowhere to put the file, and
 * the honest behaviour is to stay silent rather than to fail once a day.
 */
export function scheduleDue<T extends { schedule?: ReportSchedule; lastRunAt?: string }>(
  reports: T[], now: number,
): T[] {
  const out: T[] = [];
  for (const r of Array.isArray(reports) ? reports : []) {
    const s = r && r.schedule;
    if (!s || s.cadence === 'off' || !s.folder) continue;
    if (!timeOfDayReached(now, s.at)) continue;
    if (!r.lastRunAt) { out.push(r); continue; }
    const last = Date.parse(r.lastRunAt);
    if (!Number.isFinite(last)) { out.push(r); continue; }
    if (now - last >= CADENCE_MS[s.cadence]) out.push(r);
  }
  return out;
}

/** Has the local clock passed "HH:MM" today? */
export function timeOfDayReached(now: number, at: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(sanitizeTimeOfDay(at));
  if (!m) return true;
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

// ── the store ────────────────────────────────────────────────────────────────

function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

function reportsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'reports');
}

function reportFilePath(projectId: string, id: string): string {
  return path.join(reportsDir(projectId), id + '.json');
}

// Atomic JSON write: temp sibling then rename. The per-write UUID suffix is
// load-bearing — a fixed temp name lets two overlapping writes to one record
// share a path and interleave into a corrupt file. Copied from analysis.ts.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

/** Coerce a parsed record into a well-formed Report. `projectId` is the
 *  CALLER's, never the file's, so a hand-edited record cannot re-home itself. */
function normalize(data: any, projectId: string): Report {
  const createdAt = str(data.createdAt) || new Date().toISOString();
  const r: Report = {
    id: String(data.id),
    projectId,
    analysisId: isValidId(data.analysisId) ? data.analysisId : '',
    name: str(data.name).trim() || t('reportSpec.untitled_report'),
    format: sanitizeFormat(data.format),
    pages: sanitizePages(data.pages),
    cover: sanitizeCover(data.cover),
    paper: sanitizePaper(data.paper),
    includeFilters: data.includeFilters !== false,
    narrative: data.narrative === true,
    discussion: data.discussion === true,
    createdAt,
    updatedAt: str(data.updatedAt) || createdAt,
    schemaVersion: 1,
  };
  const schedule = sanitizeSchedule(data.schedule);
  if (schedule) r.schedule = schedule;
  if (isValidId(data.scorecardId)) r.scorecardId = data.scorecardId;
  if (isValidId(data.viewId) || data.viewId === 'all') r.viewId = data.viewId;
  if (str(data.lastRunAt)) r.lastRunAt = str(data.lastRunAt);
  if (str(data.lastFile)) r.lastFile = str(data.lastFile);
  return r;
}

function summarize(r: Report): ReportSummary {
  const s: ReportSummary = {
    id: r.id, name: r.name, analysisId: r.analysisId, format: r.format,
    cover: r.cover, paper: r.paper,
    pageCount: r.pages.filter((p) => p.include).length, updatedAt: r.updatedAt,
  };
  if (r.schedule) s.schedule = r.schedule;
  if (r.lastRunAt) s.lastRunAt = r.lastRunAt;
  if (r.lastFile) s.lastFile = r.lastFile;
  return s;
}

/** Summaries for a project's reports, newest-updated first. Corrupt files are
 *  skipped quietly — one bad record must not empty the list. */
export async function listReports(projectId: string): Promise<ReportSummary[]> {
  const full = await readAll(projectId);
  return full.map(summarize).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Every report in a project, whole. The scheduler needs the records, not the
 *  summaries, and reading the dir twice is how the two drift. */
export async function readAll(projectId: string): Promise<Report[]> {
  if (!isValidId(projectId)) return [];
  let dirents: recordFs.Dirent[];
  try {
    dirents = await recordFs.readdir(reportsDir(projectId), { withFileTypes: true });
  } catch (_) {
    return []; // no reports dir yet is the normal case, not an error
  }
  const out: Report[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const r = await getReport(projectId, d.name.slice(0, -5));
    if (r) out.push(r);
  }
  return out;
}

export async function getReport(projectId: string, id: string): Promise<Report | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    const data = JSON.parse(await recordFs.readFile(reportFilePath(projectId, id), 'utf8'));
    if (!data || typeof data.id !== 'string' || !data.id) return null;
    return normalize(data, projectId);
  } catch (_) {
    return null;
  }
}

export interface ReportInput {
  analysisId?: unknown;
  scorecardId?: unknown;
  name?: unknown;
  format?: unknown;
  pages?: unknown;
  cover?: unknown;
  paper?: unknown;
  includeFilters?: unknown;
  narrative?: unknown;
  discussion?: unknown;
  schedule?: unknown;
  viewId?: unknown;
}

export async function saveReport(projectId: string, input: ReportInput): Promise<Report | null> {
  if (!isValidId(projectId)) return null;
  if (!(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const report = normalize({ ...input, id: randomUUID(), createdAt: now, updatedAt: now }, projectId);
  await fs.promises.mkdir(reportsDir(projectId), { recursive: true });
  await writeJsonAtomic(reportFilePath(projectId, report.id), report);
  return report;
}

/**
 * Patch a report in place, bumping updatedAt. Arrays and objects are REPLACED
 * wholesale, never merged — the same rule updateAnalysis follows, and for the
 * same reason: a half-patched `cover` would quietly reset the fields it omitted.
 */
export async function updateReport(
  projectId: string, id: string,
  patch: ReportInput & { lastRunAt?: string; lastFile?: string },
): Promise<Report | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const existing = await getReport(projectId, id);
  if (!existing) return null;
  const merged: Report = {
    ...existing,
    name: str(patch.name).trim() || existing.name,
    format: patch.format !== undefined ? sanitizeFormat(patch.format) : existing.format,
    pages: patch.pages !== undefined ? sanitizePages(patch.pages) : existing.pages,
    cover: patch.cover !== undefined ? sanitizeCover(patch.cover) : existing.cover,
    paper: patch.paper !== undefined ? sanitizePaper(patch.paper) : existing.paper,
    includeFilters: patch.includeFilters !== undefined ? patch.includeFilters !== false : existing.includeFilters,
    narrative: patch.narrative !== undefined ? patch.narrative === true : existing.narrative,
    discussion: patch.discussion !== undefined ? patch.discussion === true : existing.discussion,
    updatedAt: new Date().toISOString(),
  };
  if (patch.schedule !== undefined) {
    const s = sanitizeSchedule(patch.schedule);
    if (s) merged.schedule = s; else delete merged.schedule;
  }
  if (patch.viewId !== undefined) {
    if (isValidId(patch.viewId) || patch.viewId === 'all') merged.viewId = patch.viewId; else delete merged.viewId;
  }
  if (patch.lastRunAt) merged.lastRunAt = patch.lastRunAt;
  if (patch.lastFile) merged.lastFile = patch.lastFile;
  await fs.promises.mkdir(reportsDir(projectId), { recursive: true });
  await writeJsonAtomic(reportFilePath(projectId, id), merged);
  return merged;
}

export async function deleteReport(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  try {
    await recordFs.rm(reportFilePath(projectId, id), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}
