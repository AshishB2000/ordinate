// Comments — the STORE: disk, sync, the author. MAIN PROCESS ONLY.
// The shape, the transitions and the merge are ./commentModel.ts (pure).
//
// STORAGE: one `comments.json` per project, beside project.json —
// `userData/projects/<id>/comments.json`, holding `{ schemaVersion: 1,
// comments }`. One file, like alerts.json: every door (card heads, the
// dashboard toggle, Home) reads the whole set anyway, and threads are counted
// in tens. Atomic writes (unique temp sibling, then rename), UUID-checked ids,
// sanitized on every read AND every write. A corrupt local file is kept aside
// as `comments.json.corrupt` and never fatal. No file is created for a project
// nobody has commented on.
//
// SYNC. comments.json lives IN the project folder, so it travels wherever the
// project does: in a bundle, and — when the project lives in a sync folder
// (src/app/syncFolder.ts: the project switcher's "Move to sync folder…") —
// through Dropbox or iCloud Drive to every machine that opens it. A sync
// service copies files; when two machines wrote comments at once it keeps
// BOTH, as a conflict copy beside the file ("comments (Ann's conflicted copy
// 2026-01-02).json", "comments 2.json"). That is where reconcile-by-id comes
// in: every read and every change folds each conflict copy into this file
// (commentModel.reconcileComments — same result whichever machine does it),
// writes the merge, and removes the copies it folded, so the project's conflict
// warning never points at work that is not lost. A copy that does not parse
// (half-downloaded) is left alone for that round. There is no watcher: the
// other machine's changes arrive on the next read — a panel, a dashboard, Home.
//
// Every operation on one project runs in order through `serial`, so an add
// racing a list in the same process can never write over each other.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as config from './config';
import { projectDir } from './recordKinds';
import * as model from './commentModel';
import type { Comment } from './commentModel';

const FILE = 'comments.json';

export type Result = { ok: true; comments: Comment[] } | { ok: false; error: string };

// ── author ───────────────────────────────────────────────────────────────────

function osUser(): string {
  try {
    return os.userInfo().username;
  } catch (_) {
    return ''; // no passwd entry (a container, say) — resolveAuthor falls back
  }
}

/** The name written on this machine's comments: Settings' display name, else the OS user. */
export function author(): string {
  return model.resolveAuthor(config.get().displayName, osUser());
}

/** Yours to edit or delete: written under your current name, or under your OS
 *  user name before you set a display name. */
export function isMine(name: string): boolean {
  return name === author() || (!!name && name === osUser());
}

// ── disk ─────────────────────────────────────────────────────────────────────

interface Read { state: 'ok' | 'missing' | 'corrupt'; comments: Comment[] }

async function readFile(file: string): Promise<Read> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (_) {
    return { state: 'missing', comments: [] };
  }
  try {
    // ponytail: raw disk JSON — sanitizeComments checks every field
    const raw: any = JSON.parse(text);
    return { state: 'ok', comments: model.sanitizeComments(raw && raw.comments) };
  } catch (_) {
    return { state: 'corrupt', comments: [] };
  }
}

async function writeFile(file: string, comments: Comment[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const body: model.CommentFile = { schemaVersion: 1, comments: model.sanitizeComments(comments) };
  // A unique temp per write: two overlapping writes must never share a path.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

const same = (a: Comment[], b: Comment[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// The sync service's names for a second copy — the same two rules
// syncLock.findConflicts reads a whole project folder with, for this one file.
// Dropbox: "comments (Ann's conflicted copy 2026-01-02).json" / "(Case Conflict)".
const DROPBOX = /^comments \((?:.*conflicted copy.*|case conflict.*)\)\.json$/i;
// iCloud: "comments 2.json" — the number goes before the extension.
const ICLOUD = /^comments (?:[2-9]|\d{2,})\.json$/;

/** Conflict copies of comments.json in a project folder. Top level only: that is where the file lives. */
async function conflictCopies(projectId: string): Promise<string[]> {
  const dir = projectDir(projectId);
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch (_) { return []; }
  return names.filter((n) => DROPBOX.test(n) || ICLOUD.test(n)).sort().map((n) => path.join(dir, n));
}

/**
 * Reconcile `mine` (what this process holds now) with every conflict copy the
 * sync service left, write the merge where it differs, then remove the copies
 * it folded in. Returns the merged list.
 */
async function persist(projectId: string, mine: Comment[], onDisk: Comment[] | null): Promise<Comment[]> {
  const local = path.join(projectDir(projectId), FILE);
  let merged = mine;
  const folded: string[] = [];
  for (const copy of await conflictCopies(projectId)) {
    const theirs = await readFile(copy);
    if (theirs.state !== 'ok') continue; // mid-sync: it will parse next time, and clobbering it would lose it
    merged = model.reconcileComments(merged, theirs.comments);
    folded.push(copy);
  }
  if (!onDisk || !same(merged, onDisk)) await writeFile(local, merged);
  for (const copy of folded) {
    try { await fs.promises.rm(copy, { force: true }); } catch (_) { /* next read folds it again, harmlessly */ }
  }
  return merged;
}

async function loadLocal(projectId: string): Promise<Comment[]> {
  const local = path.join(projectDir(projectId), FILE);
  const read = await readFile(local);
  if (read.state === 'corrupt') {
    // Keep what cannot be read, out of the way, before anything overwrites it.
    try { await fs.promises.rename(local, local + '.corrupt'); } catch (_) { /* best effort */ }
  }
  return read.comments;
}

// ── serial per project ───────────────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

function serial<T>(projectId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) || Promise.resolve();
  const run = prev.then(job, job);
  queues.set(projectId, run.catch(() => undefined));
  return run;
}

// ── operations ───────────────────────────────────────────────────────────────

/** Every live thread of a project, with any sync conflict copies folded in. */
export function list(projectId: string): Promise<Result> {
  if (!projectDir(projectId)) return Promise.resolve({ ok: false, error: 'Unknown project.' });
  return serial(projectId, async () => {
    try {
      const mine = await loadLocal(projectId);
      const merged = await persist(projectId, mine, mine);
      return { ok: true as const, comments: model.visible(merged) };
    } catch (err: any) {
      return { ok: false as const, error: (err && err.message) || 'Could not read comments.' };
    }
  });
}

/**
 * Load, apply one change, write — in one serial step. `change` returns the new
 * list, or a string saying why nothing changed.
 */
function mutate(projectId: string, change: (all: Comment[], now: string) => Comment[] | string): Promise<Result> {
  if (!projectDir(projectId)) return Promise.resolve({ ok: false, error: 'Unknown project.' });
  return serial(projectId, async () => {
    try {
      const mine = await loadLocal(projectId);
      // Fold the other machine in FIRST, so a change is applied to the latest thread.
      const base = await persist(projectId, mine, mine);
      const next = change(base, new Date().toISOString());
      if (typeof next === 'string') return { ok: false as const, error: next };
      const merged = await persist(projectId, next, base);
      return { ok: true as const, comments: model.visible(merged) };
    } catch (err: any) {
      return { ok: false as const, error: (err && err.message) || 'Could not save the comment.' };
    }
  });
}

/** Apply `fn` to thread `id`; a null from `fn` means the change does not apply. */
function onThread(projectId: string, id: string, fn: (c: Comment, now: string) => Comment | null | string): Promise<Result> {
  return mutate(projectId, (all, now) => {
    const i = all.findIndex((c) => c.id === id && !c.deletedAt);
    if (i < 0) return 'That comment is no longer here.';
    const next = fn(all[i], now);
    if (typeof next === 'string') return next;
    if (!next) return all; // already in that state — a no-op, not an error
    return all.slice(0, i).concat([next], all.slice(i + 1));
  });
}

export function add(projectId: string, target: unknown, body: unknown): Promise<Result> {
  return mutate(projectId, (all, now) => {
    const c = model.makeComment(randomUUID(), target, body, author(), now);
    return c ? all.concat([c]) : 'A comment needs some text and something to be about.';
  });
}

export function reply(projectId: string, id: string, body: unknown): Promise<Result> {
  return onThread(projectId, id, (c, now) => model.addReply(c, randomUUID(), body, author(), now) || 'A reply needs some text.');
}

export function edit(projectId: string, id: string, body: unknown): Promise<Result> {
  return onThread(projectId, id, (c, now) => (isMine(c.author) ? model.editBody(c, body, now) : 'Only the author can edit a comment.'));
}

export function resolve(projectId: string, id: string): Promise<Result> {
  return onThread(projectId, id, (c, now) => model.resolve(c, now));
}

export function reopen(projectId: string, id: string): Promise<Result> {
  return onThread(projectId, id, (c, now) => model.reopen(c, now));
}

export function remove(projectId: string, id: string): Promise<Result> {
  return onThread(projectId, id, (c, now) => (isMine(c.author) ? model.tombstone(c, now) : 'Only the author can delete a comment.'));
}

export function removeReply(projectId: string, id: string, replyId: string): Promise<Result> {
  return onThread(projectId, id, (c, now) => {
    const r = c.replies.find((x) => x.id === replyId);
    if (!r || r.deletedAt) return 'That reply is no longer here.';
    return isMine(r.author) ? model.deleteReply(c, replyId, now) : 'Only the author can delete a reply.';
  });
}
