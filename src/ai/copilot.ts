// Per-project AI Copilot chat history + context-fact builder — MAIN PROCESS ONLY.
//
// Two responsibilities, now in two files — this one PERSISTS, ./copilotFacts
// BUILDS the facts, and this file re-exports its builders so callers see one
// module:
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
import type { LedgerEntry } from './numberAudit';

// ── Types ─────────────────────────────────────────────────────────────────────

// Where the FACTS in an assistant turn came from — safe to show to the user as
// provenance chips. `note` is always 'stats app-computed' (the app did the math).
export interface CopilotProvenance {
  kind: 'dataset' | 'visual' | 'analysis' | 'project' | 'capture';
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
const PROV_KINDS: ReadonlySet<string> = new Set(['dataset', 'visual', 'analysis', 'project', 'capture']);

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
// The builders moved to ./copilotFacts under the 800-line cap. They are
// re-exported here so every caller — ipc/copilot.ts and the self-checks — keeps
// reaching them as `copilot.datasetFacts(...)`, which is what they are: this
// module's second job, in a second file.
export {
  datasetFacts,
  visualFacts,
  analysisFacts,
  captureFacts,
  projectFacts,
} from './copilotFacts';
