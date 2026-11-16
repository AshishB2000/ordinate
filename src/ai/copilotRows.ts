// The Assistant's conversations as Postgres rows (0023_assistant_threads.sql,
// docs/assistant-threads/00-design.md): one row per conversation, one per turn.
// With DATABASE_URL, ./copilot.ts hands each public call here after its own
// checks; without it, the project's copilot.json as before. The rules are the
// file's, kept exactly, but one: a member reads and writes only their own
// conversations, MAX_TURNS per conversation, a title from the first user turn,
// and "most recent" is updated_at with `touched` (the file's array order) on a
// tie. The one: no MAX_THREADS. Every conversation is kept, the list is paged
// on assistant_threads_mine (`listPage`), and an org may delete the ones unused
// for N days (`pruneUnused`, 0025_assistant_retention.sql).
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
import { folderOf } from '../server/authz/folderSql';
import type { AnswerSpec } from './answerSpec';
import type { AnswerSnapshot } from './answerSnapshot';
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
interface ThreadRow { id: string; owner: string | null; title: string; created_at: Date; updated_at: Date; turns: number; agent_id: string | null; at_us: string; touched: string }

const RECENT = 'ORDER BY t.updated_at DESC, t.touched DESC';
// `at_us` and `touched` are a page's cursor: updated_at to the microsecond, so a tie is never lost to rounding.
const SUMMARY = `SELECT t.id::text, t.title, t.updated_at, t.agent_id::text,
    (SELECT count(*)::int FROM assistant_turns u WHERE u.org_id = t.org_id AND u.project_id = t.project_id AND u.thread_id = t.id) AS turns,
    (extract(epoch FROM t.updated_at) * 1000000)::bigint::text AS at_us, t.touched::text AS touched
  FROM assistant_threads t`;
const TURNS = 'SELECT thread_id::text, id::text, role, text, created_at, body FROM assistant_turns';

const summaryOf = (r: ThreadRow): CopilotThreadSummary =>
  ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString(), turnCount: r.turns, ...(r.agent_id ? { agentId: r.agent_id } : {}) });

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
async function target(c: PoolClient, org: string, projectId: string, threadId: string | undefined, lock = false): Promise<{ id: string; title: string; agent_id?: string | null } | null> {
  const named = threadId && copilot.isValidId(threadId) ? threadId : null;
  const r = await c.query<{ id: string; title: string; agent_id: string | null }>(
    `SELECT t.id::text, t.title, t.agent_id::text FROM assistant_threads t WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3
      ORDER BY coalesce(t.id = $4::uuid, false) DESC, t.updated_at DESC, t.touched DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [org, projectId, me(), named],
  );
  return r.rows[0] ?? null;
}

const newThread = (c: PoolClient, org: string, projectId: string, id: string, at: string, agentId?: string) =>
  c.query(
    `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at, agent_id) VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
    [org, projectId, id, me(), copilot.FALLBACK_TITLE, at, agentId ?? null],
  );

/** Every member's conversations in stored order (least recently touched first), turns and all. */
export async function loadThreads(projectId: string): Promise<CopilotThread[]> {
  await moveFile(projectId);
  return tx(false, async (c, org) => {
    const threads = await c.query<ThreadRow>(
      'SELECT id::text, owner, title, created_at, updated_at, agent_id::text FROM assistant_threads WHERE org_id = $1 AND project_id = $2 ORDER BY touched',
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
      turns: byThread.get(r.id) ?? [], ...(r.owner !== null ? { owner: r.owner } : {}), ...(r.agent_id ? { agentId: r.agent_id } : {}),
    }));
  });
}

export async function listThreads(projectId: string): Promise<CopilotThreadSummary[]> {
  await moveFile(projectId);
  const r = await tx(false, (c, org) => c.query<ThreadRow>(`${SUMMARY} WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3 ${RECENT}`, [org, projectId, me()]));
  return r.rows.map(summaryOf);
}

/** A page's cursor, `<updated_at in µs since 1970>.<touched>`: the last row it showed. Anything else is null. */
const CURSOR_RE = /^(-?\d{1,18})\.(\d{1,19})$/;

/**
 * The caller's conversations newest first, `copilot.THREAD_PAGE` at a time: those after `after` (a cursor
 * this returned), and the cursor after the last when there are more. Keyset on assistant_threads_mine
 * (updated_at, touched), never OFFSET: a page costs the same however deep, and a conversation touched
 * between two pages moves to the top instead of shifting what the next page shows.
 */
/**
 * Shared folders (docs/team-folders, ../ipc/turnsOpen): for a caller restricted to the folders `$5` (NULL: nobody
 * restricts them, the count is every turn), each conversation's turns as they are shown — an answer on a dataset
 * outside `$5` (0034 `ordinate_turn_datasets`) is not, nor a question whose next turn is one — and its first question,
 * with whether it is shown (a title taken from a hidden one reads untitled). In the page's one query.
 */
const SHOWN = `LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE NOT x.closed AND NOT (x.role = 'user' AND x.next_closed))::int AS shown,
      (array_agg(x.text ORDER BY x.seq) FILTER (WHERE x.role = 'user' AND x.text ~ '\\S'))[1] AS first_q,
      (array_agg(x.next_closed ORDER BY x.seq) FILTER (WHERE x.role = 'user' AND x.text ~ '\\S'))[1] AS first_q_hidden
    FROM (SELECT u.seq, u.role, u.text, c.closed, coalesce(lead(c.closed) OVER (ORDER BY u.seq), false) AS next_closed
            FROM assistant_turns u CROSS JOIN LATERAL (SELECT u.role = 'assistant' AND EXISTS (SELECT 1 FROM unnest(ordinate_turn_datasets(u.body)) AS d(id)
              WHERE ${folderOf("'dataset'", 'd.id', 'u.org_id', 'u.project_id')} <> ALL($5::uuid[])) AS closed) c
           WHERE u.org_id = t.org_id AND u.project_id = t.project_id AND u.thread_id = t.id) x) v ON $5::uuid[] IS NOT NULL`;

export async function listPage(projectId: string, after?: string, open: readonly string[] | null = null): Promise<{ threads: CopilotThreadSummary[]; next: string | null }> {
  const from = after === undefined ? null : CURSOR_RE.exec(after);
  if (after !== undefined && !from) return { threads: [], next: null };
  await moveFile(projectId);
  const page = copilot.THREAD_PAGE;
  const r = await tx(false, (c, org) => c.query<ThreadRow & { shown: number | null; first_q: string | null; first_q_hidden: boolean | null }>(
    `${SUMMARY.replace(' FROM assistant_threads t', `, v.shown, v.first_q, v.first_q_hidden FROM assistant_threads t ${SHOWN}`)}
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.owner = $3
       ${from ? `AND (t.updated_at, t.touched) < (timestamptz 'epoch' + $6::bigint * interval '1 microsecond', $7::bigint)` : ''}
     ${RECENT} LIMIT $4`,
    [org, projectId, me(), page + 1, open, ...(from ? [from[1], from[2]] : [])],
  ));
  const rows = r.rows.slice(0, page);
  const last = rows.at(-1);
  const shownOf = (x: (typeof rows)[number]): ThreadRow => (open === null ? x : {
    ...x, turns: x.shown ?? 0,
    title: x.first_q_hidden && x.first_q !== null && x.title === copilot.titleFromTurns([{ role: 'user', text: x.first_q } as CopilotTurn]) ? copilot.FALLBACK_TITLE : x.title,
  });
  return { threads: rows.map((x) => summaryOf(shownOf(x))), next: r.rows.length > page && last ? `${last.at_us}.${last.touched}` : null };
}

export async function threadFor(projectId: string, threadId?: string): Promise<copilot.ThreadRef | null> {
  await moveFile(projectId);
  const t = await tx(false, (c, org) => target(c, org, projectId, threadId));
  return t ? { id: t.id, title: t.title, ...(t.agent_id ? { agentId: t.agent_id } : {}) } : null;
}

export async function createThread(projectId: string, at: string, agentId?: string): Promise<CopilotThreadSummary> {
  await moveFile(projectId);
  const id = randomUUID();
  await tx(true, async (c, org) => {
    await lockOwner(c, org, projectId, me());
    await newThread(c, org, projectId, id, at, agentId);
  });
  return { id, title: copilot.FALLBACK_TITLE, updatedAt: at, turnCount: 0, ...(agentId ? { agentId } : {}) };
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
     RETURNING t.id::text, t.title, t.updated_at, t.agent_id::text,
       (SELECT count(*)::int FROM assistant_turns u WHERE u.org_id = t.org_id AND u.project_id = t.project_id AND u.thread_id = t.id) AS turns`,
    [org, projectId, me(), threadId, pgText(title)],
  ));
  return r.rows[0] ? summaryOf(r.rows[0]) : null;
}

export async function markSaved(projectId: string, threadId: string, turnId: string, spec: AnswerSpec, visualId: string): Promise<boolean> {
  return changeTurn(projectId, threadId, turnId, spec, (turn) => {
    turn.savedVisualId = visualId;
  });
}

/** `change` on one assistant turn of the caller's `threadId` whose stored answer draws `spec` (or ran that SQL), its body rewritten. False: no such turn. */
async function changeTurn(projectId: string, threadId: string, turnId: string, spec: copilot.TurnAnswer, change: (turn: CopilotTurn) => void): Promise<boolean> {
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
    if (!turn || !copilot.holds(turn, spec)) return false;
    change(turn);
    await c.query('UPDATE assistant_turns SET body = $5 WHERE org_id = $1 AND project_id = $2 AND thread_id = $3 AND id = $4', [org, projectId, threadId, turnId, bodyOf(turn)]);
    return true;
  });
}

/** ./copilot `setSnapshot`: `snap` undefined removes it. */
export async function setSnapshot(projectId: string, threadId: string, turnId: string, spec: copilot.TurnAnswer, snap: AnswerSnapshot | undefined): Promise<boolean> {
  return changeTurn(projectId, threadId, turnId, spec, (turn) => {
    if (snap) turn.snapshot = snap;
    else delete turn.snapshot;
  });
}

/** ./copilot `replaceAnswer`. */
export async function replaceAnswer(projectId: string, threadId: string, turnId: string, from: AnswerSpec, to: AnswerSpec, note: string): Promise<boolean> {
  return changeTurn(projectId, threadId, turnId, from, (turn) => {
    turn.answer = to;
    if (turn.provenance) turn.provenance = { ...turn.provenance, note };
    delete turn.snapshot;
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

// ── Retention (Admin → Settings) ────────────────────────────────────────────

/** Conversations deleted per transaction, each with its turns (at most MAX_TURNS each), and transactions per pass. */
const PRUNE_BATCH = 100;
const PRUNE_BATCHES = 20;

/**
 * Deletes `org`'s conversations whose last turn is older than its "Delete Assistant conversations unused for
 * N days" (org_settings.assistant_retention_days); none while that is unset, the default. PRUNE_BATCH per
 * transaction, so no lock is held for long, and at most PRUNE_BATCHES a pass: a backlog clears over the
 * next passes of the shared sweep (../server/sharedState.ts), which calls this. A conversation an append
 * holds is skipped (SKIP LOCKED): it is in use. Returns how many went.
 */
export async function pruneUnused(org: string = ctx().org.id): Promise<number> {
  if (!orgDb()) return 0; // conversations are not rows here (a sweep wired without them, as some suites do)
  const days = await inOrg(async (c) => (await c.query<{ d: number | null }>('SELECT assistant_retention_days AS d FROM org_settings WHERE org_id = $1', [org])).rows[0]?.d ?? null, org);
  if (!days) return 0;
  let total = 0;
  for (let i = 0; i < PRUNE_BATCHES; i++) {
    const n = await inOrg(async (c) => (await c.query(
      `DELETE FROM assistant_threads WHERE (org_id, project_id, id) IN (
         SELECT org_id, project_id, id FROM assistant_threads WHERE org_id = $1 AND updated_at < now() - $2 * interval '1 day'
          LIMIT ${PRUNE_BATCH} FOR UPDATE SKIP LOCKED)`,
      [org, days],
    )).rowCount ?? 0, org);
    total += n;
    if (n < PRUNE_BATCH) break;
  }
  return total;
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
      `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at, agent_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, project_id, id) DO NOTHING`,
      [org, projectId, id, t.owner ?? null, pgText(t.title), when(t.createdAt, now), when(t.updatedAt, now), t.agentId ?? null],
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
