// Per-project AI Copilot chat history + context-fact builder — MAIN PROCESS ONLY.
//
// Two responsibilities in one small module:
//   1. PERSISTENCE — MANY named chat threads per project, still ONE JSON file:
//      userData/projects/<projectId>/copilot.json. Mirrors src/projects.ts /
//      src/datasets.ts verbatim: the UUID id-validation guard, atomic
//      temp-then-rename writes, graceful skip of missing/corrupt files, and a
//      normalize() that re-sanitizes untrusted-on-disk turns on load.
//   2. CONTEXT FACTS — PURE builders (no fs/DOM/model) that FORMAT already-
//      app-computed numbers (datasetStats / metricValue / vizData outputs) into a
//      compact FACTS text block + a provenance descriptor. The model only narrates
//      these figures; it NEVER computes or invents one — the analyze→compute→
//      display contract, generalized from ipc/datasets.buildDatasetSummaryText.
//
// DUAL-UUID note (honest read): only `projectId` is ever concatenated into a
// filesystem path, so only it needs the traversal guard (copied verbatim from
// projects.ts). Each turn AND each thread still gets a generated randomUUID()
// `id` — a stable renderer key, NEVER a path component — so the "path id
// validated, record id generated" discipline is honored where it matters. All
// threads live in the ONE copilot.json, so adding threads adds no new path
// component and needs no second guard.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from '../app/projects';
import type { Dataset } from '../data/datasets';
import type { ColumnSummary, QualityIssue } from '../data/datasetStats';
import type { Visual } from '../analysis/visuals';
import type { Page } from '../analysis/dashboards';
import type { Analysis, AnalysisTile } from '../analysis/analysis';
import type { VizDataResult } from '../analysis/vizData';
import { harvestAppNumbers } from './numberAudit';
import type { LedgerEntry, LedgerUnit } from './numberAudit';

// ── Types ─────────────────────────────────────────────────────────────────────

// Where the FACTS in an assistant turn came from — safe to show to the user as
// provenance chips. `note` is always 'stats app-computed' (the app did the math).
export interface CopilotProvenance {
  kind: 'dataset' | 'visual' | 'analysis' | 'project';
  name: string;            // entity name (safe to show)
  datasetName?: string;    // for visual/dashboard cards, the underlying dataset
  columns?: string[];      // columns whose stats were sent
  note: string;            // e.g. 'stats app-computed'
}

export interface CopilotTurn {
  id: string;                        // randomUUID — a stable key only, never a path
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;                 // ISO timestamp
  provenance?: CopilotProvenance;    // assistant turns only
}

// One conversation. `id` is a randomUUID — a renderer key, never a path component.
export interface CopilotThread {
  id: string;
  title: string;       // derived from the first user turn, never model-generated
  createdAt: string;   // ISO
  updatedAt: string;   // ISO — bumped on every append; this is what "most recent" means
  turns: CopilotTurn[];
}

// What listThreads() hands the renderer — no turn bodies, so a sidebar of 50
// conversations costs one small IPC payload instead of 50 × 200 turns.
export interface CopilotThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

// The whole on-disk file. v1 was { projectId, turns, schemaVersion: 1 } — a single
// unnamed thread; normalize() migrates it in place on load (see migrateV1).
interface CopilotFile {
  projectId: string;
  threads: CopilotThread[];
  schemaVersion: 2;
}

// A new turn as handed in by the caller (id + createdAt are assigned on append).
export interface NewCopilotTurn {
  role: 'user' | 'assistant';
  text: string;
  provenance?: CopilotProvenance;
}

// A compact FACTS block + its provenance — what a context builder returns.
export interface CopilotFacts {
  text: string;
  provenance: CopilotProvenance;
  /**
   * Every figure this block hands the model, as an app-side record.
   *
   * Built in the SAME pass as `text`, from the same values, because two passes
   * would drift and the drift would be invisible: a figure that reached the
   * prompt without reaching the ledger becomes a false accusation under a
   * perfectly correct answer (see ./numberAudit). Never model output, and in
   * this PR never shown to a user — `ipc/copilot` returns it for tests and the
   * runtime guard only.
   */
  ledger: LedgerEntry[];
}

// Ring-cap so one conversation can't grow unbounded.
const MAX_TURNS = 200;

// Ring-cap on conversations per project. 50 is deliberate, not a round number
// pulled from the air: the whole file is read and rewritten on EVERY append, so
// the cost that matters is the worst-case file, not the common one. 50 threads ×
// 200 turns × ~1 KB of text is a ~10 MB read+parse+write per turn — already the
// point where an append stops feeling instant. A user with 50 live conversations
// in one project wants projects, not more threads. Least-recently-used drops first.
const MAX_THREADS = 50;

// Titles are truncated to 60 chars — enough for a sidebar row at the hub's width,
// and a hard cut with no ellipsis: an ellipsis in stored data would come back as
// part of the title on the next load and slowly eat the tail. The renderer can
// add its own visual ellipsis with CSS if it wants one.
const MAX_TITLE = 60;

// Used when a thread has no user turn to name it (a brand-new thread, or a v1
// file whose only turns were assistant turns).
const FALLBACK_TITLE = 'Conversation';

// The id given to the ONE thread a v1 file migrates into. It must be STABLE, not a
// randomUUID(): normalize() runs on every read and the migration is not written
// back until something appends, so a fresh id per read would hand the renderer a
// thread id that no longer matches by the time it asks for that thread's turns.
// A fixed id is safe because a v1 file yields exactly one thread, and thread ids
// only ever have to be unique WITHIN their project's file — they are never paths,
// and never cross projects.
const V1_THREAD_ID = '00000000-0000-4000-8000-000000000001';

// ── Persistence ────────────────────────────────────────────────────────────────

let projectsBase: string | null = null;
function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// projectId arrives from the renderer over IPC. Validate the SHAPE before it ever
// reaches a filesystem path — an id like ".." or "../../foo" would otherwise escape
// userData/projects. Copied verbatim from projects.ts / datasets.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function copilotFilePath(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'copilot.json');
}

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied verbatim.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);
const PROV_KINDS: ReadonlySet<string> = new Set(['dataset', 'visual', 'analysis', 'project']);

// Re-sanitize an untrusted stored provenance object (whitelist fields only).
function normalizeProvenance(p: any): CopilotProvenance | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const kind = PROV_KINDS.has(p.kind) ? p.kind : 'project';
  const prov: CopilotProvenance = {
    kind,
    name: typeof p.name === 'string' ? p.name : '',
    note: typeof p.note === 'string' ? p.note : 'stats app-computed',
  };
  if (typeof p.datasetName === 'string') prov.datasetName = p.datasetName;
  if (Array.isArray(p.columns)) prov.columns = p.columns.filter((c: any) => typeof c === 'string');
  return prov;
}

// Re-sanitize a stored turn list (drop non-object turns, clamp role, coerce text
// to string, keep/repair id + createdAt, whitelist provenance), then ring-cap.
function normalizeTurns(raw: any): CopilotTurn[] {
  const list = Array.isArray(raw) ? raw : [];
  const turns: CopilotTurn[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const role: 'user' | 'assistant' = ROLES.has(t.role) ? t.role : 'user';
    const turn: CopilotTurn = {
      id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
      role,
      text: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
      createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date().toISOString(),
    };
    const prov = normalizeProvenance(t.provenance);
    if (prov) turn.provenance = prov;
    turns.push(turn);
  }
  // Defensive cap on load too, in case a file predates a lower MAX_TURNS.
  return turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
}

// A thread's title is the first USER turn, hard-truncated. NEVER a model call:
// naming a conversation is not worth a token, a latency spike, or a figure the
// model could smuggle into a label. Whitespace-only text doesn't count as a name.
function titleFromTurns(turns: CopilotTurn[]): string {
  const first = turns.find((t) => t.role === 'user' && t.text.trim() !== '');
  return first ? clampTitle(first.text.trim()) : FALLBACK_TITLE;
}

// A stored title is untrusted-on-disk exactly like `text` and provenance are:
// coerce to string, collapse newlines (a sidebar row is one line), hard-cap.
function clampTitle(v: unknown): string {
  const s = (typeof v === 'string' ? v : String(v ?? '')).replace(/\s+/g, ' ').trim();
  if (!s) return FALLBACK_TITLE;
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) : s;
}

// Re-sanitize the whole stored FILE on load and migrate v1 → v2. Never throws:
// every field is coerced or replaced, and anything that isn't an object array
// degrades to an empty thread list (same contract loadHistory has always had).
//
// MIGRATION CONTRACT (v1 → v2): a v1 file has `turns` and no `threads`. Its turns
// become EXACTLY ONE thread, in order, with nothing dropped — titled from its
// first user turn, or FALLBACK_TITLE when it has none. A v1 file is never lost and
// never throws; the upgrade is written back the next time anything appends.
// Exported for scripts/test-copilot-threads.ts — the migration is the whole point
// of this change and asserting it through the filesystem only would be slower and
// prove less.
export function normalize(data: any): CopilotThread[] {
  if (!data || typeof data !== 'object') return [];

  // v1: one unnamed thread stored as a bare `turns` array.
  if (!Array.isArray(data.threads) && Array.isArray(data.turns)) {
    const turns = normalizeTurns(data.turns);
    if (turns.length === 0) return [];
    const createdAt = turns[0].createdAt;
    return [{
      id: V1_THREAD_ID,
      title: titleFromTurns(turns),
      createdAt,
      updatedAt: turns[turns.length - 1].createdAt,
      turns,
    }];
  }

  const raw = Array.isArray(data.threads) ? data.threads : [];
  const threads: CopilotThread[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const turns = normalizeTurns(t.turns);
    const createdAt = typeof t.createdAt === 'string' && t.createdAt
      ? t.createdAt
      : (turns.length > 0 ? turns[0].createdAt : new Date().toISOString());
    threads.push({
      id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
      title: clampTitle(t.title),
      createdAt,
      updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : createdAt,
      turns,
    });
  }
  // Defensive cap on load too, in case a file predates a lower MAX_THREADS.
  return threads.length > MAX_THREADS ? threads.slice(threads.length - MAX_THREADS) : threads;
}

// No-op stub kept for symmetry with projects.init()/datasets.init() — the file is
// created lazily on first appendTurn (its parent project dir already exists).
export async function init(): Promise<void> {
  // Intentionally empty.
}

// Load every thread in a project in STORED order, which is recency order (least
// recently touched first — see mostRecent). Invalid id, missing file, or corrupt
// JSON all yield [] (the "no history yet" path) — never throws. A v1 file is
// migrated here, on the read, so no caller ever sees the old shape.
export async function loadThreads(projectId: string): Promise<CopilotThread[]> {
  if (!isValidId(projectId)) return [];
  try {
    const rawText = await fs.promises.readFile(copilotFilePath(projectId), 'utf8');
    return normalize(JSON.parse(rawText));
  } catch (err: any) { // ponytail: fs errors carry .code, JSON errors don't
    if (err && err.code !== 'ENOENT') {
      console.error('[copilot] Skipping corrupt or unreadable copilot.json:', projectId, err.message);
    }
    return [];
  }
}

// "Most recent" is the LATEST-TOUCHED thread, not the last-created one: reopening
// an old conversation and typing in it should make it the one that reopens next
// time.
//
// The tie-break is load-bearing, not pedantry. `updatedAt` is an ISO string with
// MILLISECOND resolution, and two appends here are two small file writes — asking
// a question and storing its answer routinely land in the same millisecond, as can
// a create-then-append. So ties are the common case, not the rare one, and they
// break toward the LAST array entry — which is why appendTurn moves the thread it
// touched to the end (see below). Array order is therefore recency order.
function mostRecent(threads: CopilotThread[]): CopilotThread | null {
  let best: CopilotThread | null = null;
  for (const t of threads) if (!best || t.updatedAt >= best.updatedAt) best = t;
  return best;
}

// Thread list for a sidebar — no turn bodies. Newest-touched FIRST, i.e. the
// reverse of the on-disk order. Reverse BEFORE sorting: Array.sort is stable, so
// same-millisecond ties then come out in the same order mostRecent() would pick.
export async function listThreads(projectId: string): Promise<CopilotThreadSummary[]> {
  const threads = await loadThreads(projectId);
  return threads
    .slice()
    .reverse()
    .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, turnCount: t.turns.length }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// The id of the thread a bare loadHistory()/appendTurn() targets, or null when the
// project has no conversation yet.
export async function latestThreadId(projectId: string): Promise<string | null> {
  const t = mostRecent(await loadThreads(projectId));
  return t ? t.id : null;
}

// Start a new, empty conversation and persist it immediately, so the renderer can
// switch to it (and copilot:ask can target it) before a single turn exists. It is
// titled FALLBACK_TITLE until its first user turn renames it. Returns null on an
// invalid projectId or a missing parent project — same guard as appendTurn.
export async function createThread(projectId: string): Promise<CopilotThreadSummary | null> {
  if (!isValidId(projectId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const now = new Date().toISOString();
  const thread: CopilotThread = {
    id: randomUUID(),
    title: FALLBACK_TITLE,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
  const threads = [...(await loadThreads(projectId)), thread];
  await writeThreads(projectId, threads);
  return { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, turnCount: 0 };
}

// Cap to the newest MAX_THREADS and atomic-write the whole file. The array is kept
// in recency order (appendTurn moves what it touched to the end), so the ones that
// drop are the LEAST RECENTLY USED — a conversation you came back to last week is
// not the one to evict just because you started it first.
async function writeThreads(projectId: string, threads: CopilotThread[]): Promise<CopilotThread[]> {
  const capped = threads.length > MAX_THREADS ? threads.slice(threads.length - MAX_THREADS) : threads;
  const file: CopilotFile = { projectId, threads: capped, schemaVersion: 2 };
  await fs.promises.mkdir(path.join(getProjectsBase(), projectId), { recursive: true });
  await writeJsonAtomic(copilotFilePath(projectId), file);
  return capped;
}

// Load ONE thread's turns in order — the most recent thread when no threadId is
// given, which is what keeps every existing caller (and the renderer panel) working
// unchanged. An unknown threadId falls back to the most recent thread rather than
// erroring: a stale id in a reopened window should show a conversation, not a void.
export async function loadHistory(projectId: string, threadId?: string): Promise<CopilotTurn[]> {
  const threads = await loadThreads(projectId);
  const target = (threadId && threads.find((t) => t.id === threadId)) || mostRecent(threads);
  return target ? target.turns : [];
}

// Append ONE turn (assigning its id + createdAt) to a thread, cap that thread to
// the last MAX_TURNS, and atomic-write. Targets `threadId` when given, else the
// most recent thread, else a thread created on the spot. Returns the target
// thread's full updated turn list, or null if the projectId is invalid or its
// parent project no longer exists (no orphan chat under a bogus id).
export async function appendTurn(
  projectId: string,
  turn: NewCopilotTurn,
  threadId?: string,
): Promise<CopilotTurn[] | null> {
  if (!isValidId(projectId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const role: 'user' | 'assistant' = turn && ROLES.has(turn.role) ? turn.role : 'user';
  const record: CopilotTurn = {
    id: randomUUID(),
    role,
    text: turn && typeof turn.text === 'string' ? turn.text : String((turn && turn.text) ?? ''),
    createdAt: new Date().toISOString(),
  };
  const prov = normalizeProvenance(turn && turn.provenance);
  if (prov) record.provenance = prov;

  const threads = await loadThreads(projectId);
  let target = (threadId && threads.find((t) => t.id === threadId)) || mostRecent(threads);
  if (!target) {
    target = { id: randomUUID(), title: FALLBACK_TITLE, createdAt: record.createdAt, updatedAt: record.createdAt, turns: [] };
    threads.push(target);
  }

  const next = [...target.turns, record];
  target.turns = next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
  target.updatedAt = record.createdAt;
  // Rename on the FIRST user turn only: once a thread carries a real title the
  // derived one can't change, since the first user turn never changes. (It can
  // still fall out of the ring cap — the title stays, which is what a user who
  // named a conversation by asking a question expects.)
  if (target.title === FALLBACK_TITLE) target.title = titleFromTurns(target.turns);

  // Move the touched thread to the end so array order stays recency order — this is
  // what makes mostRecent() deterministic when two writes share a millisecond, and
  // what makes the MAX_THREADS ring evict least-recently-used.
  const at = threads.indexOf(target);
  if (at >= 0) threads.splice(at, 1);
  threads.push(target);

  await writeThreads(projectId, threads);
  return target.turns;
}

// Delete a project's copilot.json. Returns true on success — a missing file is
// success (force), an invalid id is false.
export async function clearHistory(projectId: string): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  try {
    await fs.promises.rm(copilotFilePath(projectId), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Context facts (PURE — no fs/DOM/model) ──────────────────────────────────────
//
// Each builder FORMATS already-app-computed numbers into a compact FACTS text +
// provenance. Every text opens with the guard line stating the numbers are
// app-computed and must not be recomputed. No builder ever derives a figure — it
// only lays out the ones handed to it.

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

const SAMPLE_ROWS = 5;

// Format one app-computed value for a facts line. null/undefined → "n/a" (so the
// model is told a figure is unavailable rather than being tempted to guess).
function fmt(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a';
}

// ── Ledger assembly ──────────────────────────────────────────────────────────
//
// One entry per figure the block hands the model. `n/a` adds nothing: a figure
// the app could not compute is precisely one the model may not state.

function num(
  ledger: LedgerEntry[],
  label: string,
  value: number | null | undefined,
  unit: LedgerUnit,
  source: string,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) ledger.push({ label, value, unit, source });
}

// Figures inside a finished APP-AUTHORED sentence — a quality finding, a
// rendered sample row — where no structured field holds them separately. Never
// called on model output (see harvestAppNumbers).
function fromAppText(ledger: LedgerEntry[], label: string, appText: string, source: string): void {
  for (const h of harvestAppNumbers(appText)) ledger.push({ label, value: h.value, unit: h.unit, source });
}

/**
 * Last pass: enter anything the assembled text prints that the structured
 * entries above did not already cover.
 *
 * This is not a shortcut around building a real ledger — it is the guarantee
 * that the record can never be a subset of the prompt. Entity NAMES are the live
 * case: a dataset called "Q3 2024 orders" or a metric card labelled "Top 10
 * accounts" puts digits into the facts block that no statistic produced, and
 * without this a model repeating the name it was given would be accused of
 * inventing a figure. Erring toward silence is the rule here (./numberAudit).
 *
 * Returns how many entries it had to add. `scripts/test-numberAudit.ts` asserts
 * that is ZERO for fixtures whose names carry no digits — so the structured
 * entries stay the real ledger and this stays a backstop, rather than quietly
 * becoming the implementation.
 */
function sealLedger(ledger: LedgerEntry[], text: string, source: string): number {
  const before = ledger.length;
  for (const h of harvestAppNumbers(text)) {
    const covered = ledger.some((e) => Object.is(e.value, h.value) && (h.unit !== 'percent' || e.unit === 'percent'));
    if (!covered) ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source });
  }
  return ledger.length - before;
}

// Dataset: columns + types + app-computed stats (min/max/mean/count |
// distinct/mostCommon) + quality issues + up to N sample rows. This is the
// generalized twin of ipc/datasets.buildDatasetSummaryText (same shape) with the
// guard line prepended.
export function datasetFacts(ds: Dataset, summaries: ColumnSummary[], issues: QualityIssue[]): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const SRC = 'datasetStats';
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  num(ledger, 'row count', ds.rowCount, 'count', 'dataset');
  num(ledger, 'column count', ds.columns.length, 'count', 'dataset');
  lines.push('');
  lines.push('Columns and computed statistics:');
  summaries.forEach((s) => {
    if (s.type === 'number') {
      const parts: string[] = [];
      if (typeof s.min === 'number') parts.push(`min ${s.min}`);
      if (typeof s.max === 'number') parts.push(`max ${s.max}`);
      if (typeof s.mean === 'number') parts.push(`mean ${s.mean}`);
      parts.push(`${s.count ?? 0} numeric values`, `${s.nonEmpty} non-empty`);
      lines.push(`- ${s.name} (number): ${parts.join(', ')}`);
      num(ledger, `${s.name} min`, s.min, 'number', SRC);
      num(ledger, `${s.name} max`, s.max, 'number', SRC);
      num(ledger, `${s.name} mean`, s.mean, 'number', SRC);
      num(ledger, `${s.name} numeric values`, s.count ?? 0, 'count', SRC);
      num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
    } else {
      const parts: string[] = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
      if (s.mostCommon) parts.push(`most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
      lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
      num(ledger, `${s.name} distinct`, s.distinct ?? 0, 'count', SRC);
      num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
      if (s.mostCommon) num(ledger, `${s.name} most common count`, s.mostCommon.count, 'count', SRC);
    }
  });
  if (issues.length > 0) {
    lines.push('');
    lines.push('Data-quality notes:');
    // A finding arrives as a finished sentence ('Column "region" is 60% empty'),
    // so its figures — the app's ONLY source of percentages — are harvested from
    // the sentence rather than read off fields that do not exist.
    issues.forEach((i) => {
      lines.push(`- ${i.detail}`);
      fromAppText(ledger, `quality: ${i.kind}`, i.detail, 'datasetStats.quality');
    });
  }
  const sample = ds.rows.slice(0, SAMPLE_ROWS);
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    num(ledger, 'sample rows shown', sample.length, 'count', 'dataset.sample');
    lines.push(ds.columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      // Harvested from the RENDERED line, not the cells: a text column stores
      // '007' and prints '007', and what the model can cite is what it was shown.
      const rendered = ds.columns.map((_, c) => (row && row[c] != null ? String(row[c]) : '')).join(' | ');
      lines.push(rendered);
      fromAppText(ledger, 'sample row cell', rendered, 'dataset.sample');
    });
  }
  const text = lines.join('\n');
  sealLedger(ledger, text, 'dataset');
  return {
    text,
    ledger,
    provenance: {
      kind: 'dataset',
      name: ds.name,
      columns: summaries.map((s) => s.name),
      note: 'stats app-computed',
    },
  };
}

// Visual: chart type + encoding (category, measures+aggregations, optional series)
// + the COMPUTED labels/series from vizData.buildVizData (real, app-computed
// numbers). No figure is derived here — viz already did the math.
export function visualFacts(v: Visual, datasetName: string, viz: VizDataResult): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  lines.push(`Visual: "${v.name}" — a ${v.chartType} chart over dataset "${datasetName}".`);
  const measures = (v.encoding.values || [])
    .map((m) => `${m.aggregation}(${m.column})`)
    .join(', ');
  lines.push(`Category (x): ${v.encoding.category}. Measures: ${measures || '(none)'}` +
    (v.encoding.series ? `. Split by: ${v.encoding.series}.` : '.'));

  const ledger: LedgerEntry[] = [];
  const data = viz && viz.data ? viz.data : { labels: [], series: [] };
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  if (labels.length > 0 && series.length > 0) {
    lines.push('');
    lines.push('Computed chart values (app-computed):');
    series.forEach((s) => {
      const pairs = labels
        .map((lab, i) => `${lab}=${fmt(s.values ? s.values[i] : null)}`)
        .join(', ');
      lines.push(`- ${s.name}: ${pairs}`);
      // One entry per MARK, labelled the way the chart labels it, so a violation
      // report names the bar the model was looking at.
      labels.forEach((lab, i) => num(ledger, `${s.name} @ ${lab}`, s.values ? s.values[i] : null, 'number', 'vizData'));
    });
  } else {
    lines.push('');
    lines.push('This visual produced no plottable values.');
  }
  const text = lines.join('\n');
  sealLedger(ledger, text, 'visual');
  return {
    text,
    ledger,
    provenance: {
      kind: 'visual',
      name: v.name,
      datasetName,
      columns: [v.encoding.category, ...(v.encoding.values || []).map((m) => m.column)],
      note: 'stats app-computed',
    },
  };
}

// The card body for analysisFacts: metric cards (each a single app-computed
// number) then the text-card inventory. Kept as its own function so the layout
// the grounding prompt expects lives in one place.
function cardBodyLines(
  pages: Page[] | undefined,
  computed: { label: string; value: number | null }[],
  ledger: LedgerEntry[],
): string[] {
  const lines: string[] = [];
  if (computed.length > 0) {
    lines.push('');
    lines.push('Metric cards (each a single app-computed number):');
    computed.forEach((m) => {
      lines.push(`- ${m.label}: ${fmt(m.value)}`);
      num(ledger, m.label, m.value, 'number', 'metricValue');
    });
  }
  const otherCards: string[] = [];
  (pages || []).forEach((p) =>
    (p.cards || []).forEach((c) => {
      if (c.type === 'text' && c.heading) otherCards.push(`text card "${c.heading}"`);
    }),
  );
  if (otherCards.length > 0) {
    lines.push('');
    lines.push('Other cards: ' + otherCards.join(', ') + '.');
  }
  return lines;
}

function countCards(pages: Page[] | undefined): number {
  return (pages || []).reduce((n, p) => n + (Array.isArray(p.cards) ? p.cards.length : 0), 0);
}

// Dashboard facts (internally an Analysis record): the sheet roster plus each
// metric card's ONE app-computed number, for the model to narrate. The provenance
// kind stays 'analysis' — the internal record type — while the prose says Dashboard.
export function analysisFacts(
  a: Analysis,
  computed: { label: string; value: number | null }[],
  tiles: AnalysisTile[] = [],
): CopilotFacts {
  const sheets = Array.isArray(a.sheets) ? a.sheets : [];
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  lines.push(
    `Dashboard: "${a.name}" ` +
    `(${sheets.length} sheet(s), ${countCards(sheets)} card(s)).`,
  );
  num(ledger, 'sheet count', sheets.length, 'count', 'dashboard');
  num(ledger, 'card count', countCards(sheets), 'count', 'dashboard');
  // Per-sheet roster, ADDITIVE to the shared body below — "what's on sheet 2" is
  // unanswerable from a flat card list, and a dashboard is authored sheet by sheet.
  if (sheets.length === 0) {
    lines.push('Sheets: (none).');
  } else {
    lines.push('Sheets:');
    sheets.forEach((s, i) => {
      const cards = Array.isArray(s.cards) ? s.cards : [];
      const counts = new Map<string, number>();
      cards.forEach((c) => counts.set(c.type, (counts.get(c.type) || 0) + 1));
      const breakdown = Array.from(counts.entries()).map(([t, n]) => `${n} ${t}`).join(', ');
      lines.push(`- Sheet ${i + 1} "${s.name}": ${cards.length} card(s)${breakdown ? ` (${breakdown})` : ''}.`);
      num(ledger, `sheet ${i + 1} ("${s.name}") card count`, cards.length, 'count', 'dashboard');
      counts.forEach((n, t) => num(ledger, `sheet ${i + 1} ${t} cards`, n, 'count', 'dashboard'));
      // Each tile BY NAME, which is the whole point: a model that can only see
      // "2 visual" can describe this dashboard but cannot ask to change one of
      // them. Titles are what an edit delta names, and what the app resolves
      // back to a card id — so what is listed here bounds what can be edited.
      // Column and aggregation NAMES only; no values, no figures.
      tiles.filter((t) => t.pageIndex === i).forEach((t) => {
        const bits: string[] = [];
        if (t.chartType) bits.push(t.chartType);
        if (t.category) bits.push(`by ${t.category}`);
        if (t.measures && t.measures.length) bits.push(t.measures.join(', '));
        lines.push(`  - "${t.title}" (${t.type}${bits.length ? ': ' + bits.join(' · ') : ''})`);
      });
    });
  }
  lines.push(...cardBodyLines(sheets, computed, ledger));
  const text = lines.join('\n');
  sealLedger(ledger, text, 'dashboard');
  return {
    text,
    ledger,
    provenance: {
      kind: 'analysis',
      name: a.name,
      columns: computed.map((m) => m.label),
      note: 'stats app-computed',
    },
  };
}

// Project fallback when nothing specific is open: names of the project's datasets,
// visuals, and dashboards (the analysis records; no numbers to compute — pure inventory).
export function projectFacts(
  name: string,
  inventory: { datasets: string[]; visuals: string[]; dashboards: string[] },
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  lines.push(`Project: "${name}".`);
  lines.push(`Datasets (${inventory.datasets.length}): ${inventory.datasets.join(', ') || '(none)'}.`);
  lines.push(`Visuals (${inventory.visuals.length}): ${inventory.visuals.join(', ') || '(none)'}.`);
  lines.push(`Dashboards (${inventory.dashboards.length}): ${inventory.dashboards.join(', ') || '(none)'}.`);
  num(ledger, 'dataset count', inventory.datasets.length, 'count', 'project');
  num(ledger, 'visual count', inventory.visuals.length, 'count', 'project');
  num(ledger, 'dashboard count', inventory.dashboards.length, 'count', 'project');
  lines.push('');
  lines.push('No specific dataset/visual/dashboard is open, so no per-entity figures are available. ' +
    'Ask the user to open one for numeric detail.');
  const text = lines.join('\n');
  // Entity NAMES are the only other digits here, and a model is entitled to
  // repeat the inventory it was handed.
  sealLedger(ledger, text, 'project');
  return {
    text,
    ledger,
    provenance: { kind: 'project', name, note: 'stats app-computed' },
  };
}
