// The Assistant's conversations as Postgres rows (0023_assistant_threads.sql,
// docs/assistant-threads/00-design.md): one row per conversation, one per turn.
// With DATABASE_URL, ./copilot.ts hands each public call here after its own
// checks; without it, the project's copilot.json as before. The rules are the
// file's, kept exactly: a member reads and writes only their own
// conversations, MAX_THREADS each per project (least recently touched go
// first), MAX_TURNS per conversation, a title from the first user turn, and
// "most recent" is updated_at with `touched` (the file's array order) on a tie.
//
// An append is an INSERT of the turn and an UPDATE of its conversation. One
// member's writes in one project run one at a time (an advisory lock per
// owner), which is what the record lock gave them: a bare append finds the
// conversation the previous one made. Two members never wait on each other.
// Forced RLS: one org per transaction (../server/db/inOrg.ts), and every
// statement names its org as well.
//
// A project's copilot.json is moved in by the first call that finds it
// (`moveFile`), then deleted. An older pod still rolling out may write it
// again; the next call moves that one too.

import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import * as recordFs from '../app/recordFs';
import { logger } from '../app/logger';
import { recordNotSaved, recordUnreadable } from '../app/recordLockMessages';
import { ctx, serverDataDir } from '../server/context';
import { inOrg, orgDb } from '../server/db/inOrg';
import { sameChart } from './answerRefine';
import type { AnswerSpec } from './answerSpec';
// A cycle (./copilot imports this module): only used inside functions, never at load.
import * as copilot from './copilot';
import type { CopilotThread, CopilotThreadSummary, CopilotTurn } from './copilot';

/** Conversations are rows: a server with DATABASE_URL, once its migrations ran (src/server/app.ts). */
export function on(): boolean {
  return orgDb() !== null && serverDataDir() !== null;
}

let ownerLock = true;
/** Test hook: without the per-owner lock (the NEGATIVE CONTROL of scripts/test-copilotThreadLock.ts). */
export function _setOwnerLock(held: boolean): void {
  ownerLock = held;
}

const me = (): string => ctx().user.email;

/**
 * One transaction as the caller's org. A database failure is logged here and refused in the
 * catalog's words: the Assistant's handlers reply with an error's message, and Postgres text never
 * reaches a reply (threat model R7).
 */
async function tx<T>(write: boolean, fn: (c: PoolClient, org: string) => Promise<T>): Promise<T> {
  try {
    return await inOrg(fn);
  } catch (err) {
    logger.error('[copilot] conversation rows not ' + (write ? 'saved:' : 'read:'), err instanceof Error ? err.message : String(err));
    throw Object.assign(new Error(write ? recordNotSaved() : recordUnreadable()), { cause: err });
  }
}

// Postgres text holds no NUL character: the one change a turn's text or a title takes on the way in.
const pgText = (s: string): string => s.replaceAll('\0', '\uFFFD');

/** One member's writes in one project, one at a time, on every pod, until the transaction ends. */
async function lockOwner(c: PoolClient, org: string, projectId: string, owner: string): Promise<void> {
  if (ownerLock) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`assistant:${org}:${projectId}:${owner}`]);
}

interface TurnRow { thread_id: string; id: string; role: string; text: string; created_at: Date; body: string }
interface ThreadRow { id: string; owner: string | null; title: string; created_at: Date; updated_at: Date; turns: number }

const RECENT = 'ORDER BY t.updated_at DESC, t.touched DESC';
const SUMMARY = `SELECT t.id::text, t.title, t.updated_at,
    (SELECT count(*)::int FROM assistant_turns u WHERE u.org_id = t.org_id AND u.project_id = t.project_id AND u.thread_id = t.id) AS turns
  FROM assistant_threads t`;
const TURNS = 'SELECT thread_id::text, id::text, role, text, created_at, body FROM assistant_turns';

const summaryOf = (r: ThreadRow): CopilotThreadSummary => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString(), turnCount: r.turns });

// A stored turn goes through the file's own sanitizer on every read, as copilot.json's did.
function turnOf(r: TurnRow): CopilotTurn | undefined {
  let extra: object = {};
  try {
    const b: unknown = JSON.parse(r.body);
    if (b && typeof b === 'object' && !Array.isArray(b)) extra = b;
  } catch { /* a damaged body keeps the turn, without its other fields */ }
  return copilot.normalizeTurns([{ ...extra, id: r.id, role: r.role, text: r.text, createdAt: r.created_at.toISOString() }])[0];
}

function bodyOf(t: CopilotTurn): string {
  const { id: _i, role: _r, text: _t, createdAt: _c, ...rest } = t;
  return JSON.stringify(rest);
}

async function turnsOf(c: PoolClient, org: string, projectId: string, threadId: string): Promise<CopilotTurn[]> {
  const r = await c.query<TurnRow>(`${TURNS} WHERE org_id = $1 AND project_id = $2 AND thread_id = $3 ORDER BY seq`, [org, projectId, threadId]);
  return r.rows.map(turnOf).filter((t): t is CopilotTurn => t !== undefined);
}

/** The caller's conversation `threadId`, else their most recent, else null — locked for this transaction when `lock`. */
async function target(c: PoolClient, org: string, projectId: string, threadId: string | undefined, lock = false): Promise<{ id: string; title: string } | null> {
  const named = threadId && copilot.isValidId(threadId) ? threadId : null;
  const r = await c.query<{ id: string; title: string }>(
    `SELECT t.id::text, t.title FROM assistant_threads t WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3
      ORDER BY coalesce(t.id = $4::uuid, false) DESC, t.updated_at DESC, t.touched DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [org, projectId, me(), named],
  );
  return r.rows[0] ?? null;
}

/** The owner's newest MAX_THREADS by `touched`: the file's ring, least recently used out first. */
async function capThreads(c: PoolClient, org: string, projectId: string, owner: string): Promise<void> {
  await c.query(
    `DELETE FROM assistant_threads WHERE org_id = $1 AND project_id = $2 AND owner = $3 AND id NOT IN (
       SELECT id FROM assistant_threads WHERE org_id = $1 AND project_id = $2 AND owner = $3 ORDER BY touched DESC LIMIT ${copilot.MAX_THREADS})`,
    [org, projectId, owner],
  );
}

const newThread = (c: PoolClient, org: string, projectId: string, id: string, at: string) =>
  c.query(
    `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [org, projectId, id, me(), copilot.FALLBACK_TITLE, at],
  );

/** Every member's conversations in stored order (least recently touched first), turns and all. */
export async function loadThreads(projectId: string): Promise<CopilotThread[]> {
  await moveFile(projectId);
  return tx(false, async (c, org) => {
    const threads = await c.query<ThreadRow>(
      'SELECT id::text, owner, title, created_at, updated_at FROM assistant_threads WHERE org_id = $1 AND project_id = $2 ORDER BY touched',
      [org, projectId],
    );
    const turns = await c.query<TurnRow>(`${TURNS} WHERE org_id = $1 AND project_id = $2 ORDER BY thread_id, seq`, [org, projectId]);
    const byThread = new Map<string, CopilotTurn[]>();
    for (const r of turns.rows) {
      const t = turnOf(r);
      const list = byThread.get(r.thread_id);
      if (t && list) list.push(t);
      else if (t) byThread.set(r.thread_id, [t]);
    }
    return threads.rows.map((r) => ({
      id: r.id, title: r.title, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
      turns: byThread.get(r.id) ?? [], ...(r.owner !== null ? { owner: r.owner } : {}),
    }));
  });
}

export async function listThreads(projectId: string): Promise<CopilotThreadSummary[]> {
  await moveFile(projectId);
  const r = await tx(false, (c, org) => c.query<ThreadRow>(`${SUMMARY} WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3 ${RECENT}`, [org, projectId, me()]));
  return r.rows.map(summaryOf);
}

export async function latestThreadId(projectId: string): Promise<string | null> {
  await moveFile(projectId);
  return tx(false, async (c, org) => (await target(c, org, projectId, undefined))?.id ?? null);
}

export async function createThread(projectId: string, at: string): Promise<CopilotThreadSummary> {
  await moveFile(projectId);
  const id = randomUUID();
  await tx(true, async (c, org) => {
    await lockOwner(c, org, projectId, me());
    await newThread(c, org, projectId, id, at);
    await capThreads(c, org, projectId, me());
  });
  return { id, title: copilot.FALLBACK_TITLE, updatedAt: at, turnCount: 0 };
}

export async function loadHistory(projectId: string, threadId?: string): Promise<CopilotTurn[]> {
  await moveFile(projectId);
  return tx(false, async (c, org) => {
    const t = await target(c, org, projectId, threadId);
    return t ? turnsOf(c, org, projectId, t.id) : [];
  });
}

/** `record` (built and sanitized by ./copilot) onto the caller's `threadId`, else their most recent, else a new one. */
export async function appendTurn(projectId: string, record: CopilotTurn, threadId?: string): Promise<CopilotTurn[]> {
  await moveFile(projectId);
  return tx(true, async (c, org) => {
    await lockOwner(c, org, projectId, me());
    let t = await target(c, org, projectId, threadId, true);
    if (!t) {
      t = { id: randomUUID(), title: copilot.FALLBACK_TITLE };
      await newThread(c, org, projectId, t.id, record.createdAt);
      await capThreads(c, org, projectId, me());
    }
    const seq = (await c.query<{ seq: number }>(
      `INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body)
       SELECT $1, $2, $3, $4, coalesce(max(seq), 0) + 1, $5, $6, $7, $8 FROM assistant_turns WHERE org_id = $1 AND project_id = $2 AND thread_id = $3
       RETURNING seq`,
      [org, projectId, t.id, record.id, record.role, pgText(record.text), record.createdAt, bodyOf(record)],
    )).rows[0].seq;
    if (seq > copilot.MAX_TURNS) {
      await c.query('DELETE FROM assistant_turns WHERE org_id = $1 AND project_id = $2 AND thread_id = $3 AND seq <= $4', [org, projectId, t.id, seq - copilot.MAX_TURNS]);
    }
    const turns = await turnsOf(c, org, projectId, t.id);
    // Named by the first user turn still kept, until it has a name (the file's rule).
    const title = t.title === copilot.FALLBACK_TITLE ? copilot.titleFromTurns(turns) : t.title;
    await c.query(
      `UPDATE assistant_threads SET updated_at = $4, touched = nextval('assistant_threads_touched'), title = $5 WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [org, projectId, t.id, record.createdAt, pgText(title)],
    );
    return turns;
  });
}

/** Not a touch: updated_at and `touched` stay. */
export async function renameThread(projectId: string, threadId: string, title: string): Promise<CopilotThreadSummary | null> {
  if (!copilot.isValidId(threadId)) return null;
  await moveFile(projectId);
  const r = await tx(true, (c, org) => c.query<ThreadRow>(
    `UPDATE assistant_threads t SET title = $5 WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3 AND t.id = $4
     RETURNING t.id::text, t.title, t.updated_at,
       (SELECT count(*)::int FROM assistant_turns u WHERE u.org_id = t.org_id AND u.project_id = t.project_id AND u.thread_id = t.id) AS turns`,
    [org, projectId, me(), threadId, pgText(title)],
  ));
  return r.rows[0] ? summaryOf(r.rows[0]) : null;
}

export async function markSaved(projectId: string, threadId: string, turnId: string, spec: AnswerSpec, visualId: string): Promise<boolean> {
  if (!copilot.isValidId(threadId) || !copilot.isValidId(turnId)) return false;
  await moveFile(projectId);
  return tx(true, async (c, org) => {
    const r = await c.query<TurnRow>(
      `SELECT u.thread_id::text, u.id::text, u.role, u.text, u.created_at, u.body FROM assistant_turns u
         JOIN assistant_threads t ON t.org_id = u.org_id AND t.project_id = u.project_id AND t.id = u.thread_id
        WHERE u.org_id = $1 AND u.project_id = $2 AND u.thread_id = $3 AND u.id = $4 AND t.owner = $5 FOR UPDATE OF u`,
      [org, projectId, threadId, turnId, me()],
    );
    const turn = r.rows[0] && turnOf(r.rows[0]);
    if (!turn || turn.role !== 'assistant' || !turn.answer || !sameChart(turn.answer, spec)) return false;
    turn.savedVisualId = visualId;
    await c.query('UPDATE assistant_turns SET body = $5 WHERE org_id = $1 AND project_id = $2 AND thread_id = $3 AND id = $4', [org, projectId, threadId, turnId, bodyOf(turn)]);
    return true;
  });
}

export async function deleteThread(projectId: string, threadId: string): Promise<boolean> {
  if (!copilot.isValidId(threadId)) return false;
  await moveFile(projectId);
  const r = await tx(true, (c, org) => c.query('DELETE FROM assistant_threads WHERE org_id = $1 AND project_id = $2 AND owner = $3 AND id = $4', [org, projectId, me(), threadId]));
  return (r.rowCount ?? 0) > 0;
}

/** Every member's conversations in the project, and a copilot.json not yet moved (first, so no move brings it back). */
export async function clearHistory(projectId: string): Promise<void> {
  const file = copilot.copilotFilePath(projectId);
  await recordFs.locked(file, () => recordFs.rm(file, { force: true }));
  await tx(true, (c, org) => c.query('DELETE FROM assistant_threads WHERE org_id = $1 AND project_id = $2', [org, projectId]));
}

// ── The move from copilot.json ──────────────────────────────────────────────

// timestamptz takes any year from 4713 BC; a stored time Postgres would refuse, or none, becomes now.
const YEAR_1 = -62135596800000; // 0001-01-01T00:00:00Z
function when(s: string, now: string): string {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms >= YEAR_1 ? new Date(ms).toISOString() : now;
}

/** `threads` (normalize()d, stored order) into the rows; what is already there stays, by id. */
async function insertThreads(c: PoolClient, org: string, projectId: string, threads: CopilotThread[]): Promise<void> {
  const now = new Date().toISOString();
  for (const t of threads) { // one statement each, in stored order: `touched` follows it
    const id = copilot.isValidId(t.id) ? t.id : randomUUID();
    await c.query(
      `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, project_id, id) DO NOTHING`,
      [org, projectId, id, t.owner ?? null, pgText(t.title), when(t.createdAt, now), when(t.updatedAt, now)],
    );
    if (!t.turns.length) continue;
    // Numbered as an append numbers them, after the conversation's highest: a turn already here
    // (by id) is skipped, and a clash on `seq` fails the move (tried again) instead of dropping one.
    await c.query(
      `INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body)
       SELECT $1, $2, $3, u.id,
              (SELECT coalesce(max(x.seq), 0) FROM assistant_turns x WHERE x.org_id = $1 AND x.project_id = $2 AND x.thread_id = $3) + row_number() OVER (ORDER BY u.n),
              u.role, u.text, u.created_at, u.body
         FROM unnest($4::uuid[], $5::text[], $6::text[], $7::timestamptz[], $8::text[]) WITH ORDINALITY AS u(id, role, text, created_at, body, n)
        WHERE NOT EXISTS (SELECT 1 FROM assistant_turns x WHERE x.org_id = $1 AND x.project_id = $2 AND x.thread_id = $3 AND x.id = u.id)
       ON CONFLICT (org_id, project_id, thread_id, id) DO NOTHING`,
      [org, projectId, id,
        t.turns.map((x) => (copilot.isValidId(x.id) ? x.id : randomUUID())), t.turns.map((x) => x.role),
        t.turns.map((x) => pgText(x.text)), t.turns.map((x) => when(x.createdAt, now)), t.turns.map(bodyOf)],
    );
  }
  for (const owner of new Set(threads.flatMap((t) => (t.owner ? [t.owner] : [])))) await capThreads(c, org, projectId, owner);
}

/** The record's text; null when it is there but past its limits; undefined when there is none. */
async function readRaw(file: string): Promise<string | null | undefined> {
  try {
    return await recordFs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ERECORDTOOLARGE') return null;
    throw err;
  }
}

function parsed(raw: string | null): CopilotThread[] | null {
  if (raw === null) return null;
  try {
    return copilot.normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Move the project's copilot.json into the rows, if there is one, and delete it: one transaction,
 * the record lock's own (recordFs.heldClient), so the rows and the delete commit together and
 * nothing that takes that lock (an older pod's write of the file, another move, clearHistory, which
 * runs before a project delete) can land in between. A turn an older pod writes after it is moved
 * again by the next call; ON CONFLICT DO NOTHING keeps what is already here. Never throws: a
 * failure is logged and tried again on the next call; a file that cannot be read or parsed is set
 * aside as copilot.json.corrupt (the file store skipped it, then wrote over it on the next turn).
 */
async function moveFile(projectId: string): Promise<void> {
  const file = copilot.copilotFilePath(projectId);
  try {
    if ((await readRaw(file)) === undefined) return; // moved already: the common case, one primary-key miss
    await recordFs.locked(file, async () => {
      const raw = await readRaw(file);
      if (raw === undefined) return; // another call moved it first
      const threads = parsed(raw);
      if (!threads) {
        logger.error('[copilot] copilot.json could not be read, kept as copilot.json.corrupt:', projectId);
        return recordFs.rename(file, file + '.corrupt');
      }
      const held = recordFs.heldClient(); // null only with records on files, never a server's layout
      await (held ? insertThreads(held.client, held.org, projectId, threads) : inOrg((c, org) => insertThreads(c, org, projectId, threads)));
      await recordFs.rm(file, { force: true });
    });
  } catch (err) {
    logger.error('[copilot] copilot.json not moved yet, tried again on the next call:', projectId, err instanceof Error ? err.message : String(err));
  }
}
