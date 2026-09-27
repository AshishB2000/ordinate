// Comments and annotations — the PURE half: the shape, its sanitizer, the
// state transitions and the two-machine merge. MAIN PROCESS, and bare `node`
// for scripts/test-comments.ts: nothing here touches disk, a clock or Electron.
// ./comments.ts is the half that does (the alerts.ts / alertStore.ts split).
//
// THE RECORD. A comment is a thread on ONE target — an analysis (dashboard), a
// card on one, a visual, a dataset or a story — optionally pinned to a chart
// POINT (the category label as the chart shows it, and the series when the
// chart has more than one). Replies are flat. The author string is resolved in
// MAIN when a comment or reply is written; a renderer never supplies it.
//
// THREE FIELDS BEYOND THE PRODUCT SPEC, all additive, all there so two machines
// sharing a sync folder converge instead of one silently winning:
//   updatedAt  the last body edit            → the later edit wins
//   stateAt    the last resolve / reopen     → "A resolved at t1, B reopened at
//                                              t2 > t1" converges to OPEN
//   deletedAt  a tombstone                   → a delete on one machine is not
//                                              resurrected by the other's copy
// A reply may carry `deletedAt` too, for the same reason.
//
// THE MERGE is last-writer-wins on wall-clock ISO timestamps, per field group,
// with a total-order tie-break so reconcile(a, b) and reconcile(b, a) are the
// same value. A tombstone beats a live copy unless that copy saw activity
// (an edit, a reply, a resolve) AFTER the delete — losing someone's reply to a
// delete they never saw is data loss; a thread coming back is visible and can
// be deleted again. Real clocks drift, so every transition stamps a time
// strictly after the one it supersedes (`after`), which keeps a machine whose
// clock runs slow from having its own resolve undone by its own older copy.
// ponytail: wall-clock LWW, not a vector clock — fine for a handful of people
// on one shared folder; a CRDT is the upgrade if edits ever race in earnest.

import { isValidId } from './ids';

export const TARGET_KINDS = ['analysis', 'card', 'visual', 'dataset', 'story'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const BODY_MAX = 5000;
export const LABEL_MAX = 200;
export const AUTHOR_MAX = 80;
export const MAX_COMMENTS = 5000;
export const MAX_REPLIES = 500;

export interface CommentPoint { label: string; series?: string }
export interface CommentTarget { kind: TargetKind; id: string; point?: CommentPoint }

export interface CommentReply {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  /** Tombstone: the reply was deleted. Body is emptied. */
  deletedAt?: string;
}

export interface Comment {
  id: string;
  target: CommentTarget;
  body: string;
  author: string;
  createdAt: string;
  /** Present → the thread is resolved. */
  resolvedAt?: string;
  replies: CommentReply[];
  /** The last body edit. */
  updatedAt?: string;
  /** The last resolve or reopen — what the resolve state reconciles on. */
  stateAt?: string;
  /** Tombstone: the thread was deleted. Body and replies are emptied. */
  deletedAt?: string;
}

export interface CommentFile { schemaVersion: 1; comments: Comment[] }

// ── sanitize (never throw — keep known keys, clamp, drop the rest) ───────────

/** A canonical ISO timestamp, or undefined. Every stored time goes through it,
 *  which is what makes the string comparisons below mean "earlier / later". */
function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function isTargetKind(v: unknown): v is TargetKind {
  return typeof v === 'string' && (TARGET_KINDS as readonly string[]).includes(v);
}

// ponytail: raw disk / IPC JSON — every field is checked before it is kept
export function sanitizeTarget(raw: any): CommentTarget | null {
  if (!raw || typeof raw !== 'object' || !isTargetKind(raw.kind) || !isValidId(raw.id)) return null;
  const target: CommentTarget = { kind: raw.kind, id: raw.id.toLowerCase() };
  const p = raw.point;
  if (p && typeof p === 'object' && (typeof p.label === 'string' || typeof p.label === 'number')) {
    const point: CommentPoint = { label: text(String(p.label), LABEL_MAX) };
    const series = text(p.series, LABEL_MAX);
    if (series) point.series = series;
    target.point = point;
  }
  return target;
}

// ponytail: raw disk JSON — every field is checked before it is kept
export function sanitizeReply(raw: any): CommentReply | null {
  if (!raw || typeof raw !== 'object' || !isValidId(raw.id)) return null;
  const createdAt = iso(raw.createdAt);
  if (!createdAt) return null;
  const deletedAt = iso(raw.deletedAt);
  const body = text(raw.body, BODY_MAX);
  if (!deletedAt && !body.trim()) return null;
  const r: CommentReply = { id: raw.id.toLowerCase(), body: deletedAt ? '' : body, author: text(raw.author, AUTHOR_MAX), createdAt };
  if (deletedAt) r.deletedAt = deletedAt;
  return r;
}

// ponytail: raw disk JSON — every field is checked before it is kept
export function sanitizeComment(raw: any): Comment | null {
  if (!raw || typeof raw !== 'object' || !isValidId(raw.id)) return null;
  const target = sanitizeTarget(raw.target);
  const createdAt = iso(raw.createdAt);
  if (!target || !createdAt) return null;
  const author = text(raw.author, AUTHOR_MAX);
  const deletedAt = iso(raw.deletedAt);
  const id = raw.id.toLowerCase();
  if (deletedAt) return { id, target, body: '', author, createdAt, replies: [], deletedAt };
  const body = text(raw.body, BODY_MAX);
  if (!body.trim()) return null;
  const replies: CommentReply[] = [];
  for (const r of Array.isArray(raw.replies) ? raw.replies : []) {
    const clean = sanitizeReply(r);
    if (clean) replies.push(clean);
  }
  const c: Comment = { id, target, body, author, createdAt, replies: mergeReplies(replies, []).slice(0, MAX_REPLIES) };
  const updatedAt = iso(raw.updatedAt);
  if (updatedAt) c.updatedAt = updatedAt;
  const resolvedAt = iso(raw.resolvedAt);
  if (resolvedAt) c.resolvedAt = resolvedAt;
  // A resolve always has a state time; an old or hand-written file may not.
  const stateAt = iso(raw.stateAt) || resolvedAt;
  if (stateAt) c.stateAt = stateAt;
  return c;
}

/** A whole file's list: sanitized, duplicate ids merged, capped, in order. */
export function sanitizeComments(raw: unknown): Comment[] {
  const clean: Comment[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const s = sanitizeComment(c);
    if (s) clean.push(s);
  }
  // Merging with an empty list folds duplicate ids through the same rules.
  return reconcileComments(clean, []);
}

// ── the merge ────────────────────────────────────────────────────────────────

const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function maxIso(...xs: Array<string | undefined>): string {
  let m = '';
  for (const x of xs) if (x && x > m) m = x;
  return m;
}

/**
 * The copy with the later key; on a tie, the one whose JSON sorts later. A
 * TOTAL order on the two values, so pick(x, y) and pick(y, x) are always the
 * same value — the property the whole merge's commutativity rests on.
 */
function pick<T>(x: T, y: T, kx: string, ky: string): T {
  if (kx !== ky) return kx > ky ? x : y;
  return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
}

/** The latest moment anyone touched this thread. */
export function activityAt(c: Comment): string {
  let m = maxIso(c.createdAt, c.updatedAt, c.stateAt, c.deletedAt);
  for (const r of c.replies) m = maxIso(m, r.createdAt, r.deletedAt);
  return m;
}

function mergeReplies(a: CommentReply[], b: CommentReply[]): CommentReply[] {
  const by = new Map<string, CommentReply>();
  for (const r of a.concat(b)) {
    const prev = by.get(r.id);
    // Replies are immutable, so the only real disagreement is a delete — and
    // for a reply the delete always wins.
    by.set(r.id, !prev ? r : pick(prev, r, prev.deletedAt || '', r.deletedAt || ''));
  }
  return [...by.values()].sort(byCreated);
}

function mergeOne(a: Comment, b: Comment): Comment {
  if (a.deletedAt || b.deletedAt) {
    if (a.deletedAt && b.deletedAt) return pick(a, b, a.deletedAt, b.deletedAt);
    const dead = a.deletedAt ? a : b;
    const live = a.deletedAt ? b : a;
    // Ties go to the tombstone: only activity strictly after a delete saves a thread.
    return activityAt(live) > (dead.deletedAt as string) ? live : dead;
  }
  const content = pick(a, b, a.updatedAt || a.createdAt, b.updatedAt || b.createdAt);
  const state = pick(a, b, a.stateAt || '', b.stateAt || '');
  const out: Comment = {
    id: content.id,
    target: content.target,
    body: content.body,
    author: content.author,
    createdAt: content.createdAt,
    replies: mergeReplies(a.replies, b.replies).slice(0, MAX_REPLIES),
  };
  if (content.updatedAt) out.updatedAt = content.updatedAt;
  if (state.resolvedAt) out.resolvedAt = state.resolvedAt;
  if (state.stateAt) out.stateAt = state.stateAt;
  return out;
}

/**
 * Two copies of one project's comments → one. Union by id; for an id on both
 * sides, body/target from the later edit, resolve state from the later
 * resolve/reopen, replies unioned by id, tombstones as described up top.
 * Deterministic whatever the argument order, and idempotent: reconcile(x, x)
 * is x for any sanitized x. The result is ordered oldest first.
 */
export function reconcileComments(a: Comment[], b: Comment[]): Comment[] {
  const by = new Map<string, Comment>();
  for (const c of a.concat(b)) {
    const prev = by.get(c.id);
    by.set(c.id, prev ? mergeOne(prev, c) : c);
  }
  // The cap drops the OLDEST threads, never the one just written.
  return [...by.values()].sort(byCreated).slice(-MAX_COMMENTS);
}

// ── transitions (pure: a new value, or null when the change does not apply) ──

/**
 * `now`, unless an earlier write already claimed a time at or after it — then
 * one millisecond past that. A slow clock must still produce a LATER stamp than
 * the state it replaces, or the merge would hand the old state back.
 */
export function after(prev: string | undefined, now: string): string {
  if (!prev || prev < now) return now;
  return new Date(Date.parse(prev) + 1).toISOString();
}

function cleanBody(body: unknown): string {
  return typeof body === 'string' ? body.replace(/\r\n?/g, '\n').trim().slice(0, BODY_MAX) : '';
}

export function makeComment(id: string, rawTarget: unknown, body: unknown, author: string, now: string): Comment | null {
  const target = sanitizeTarget(rawTarget);
  const text0 = cleanBody(body);
  if (!isValidId(id) || !target || !text0) return null;
  return { id: id.toLowerCase(), target, body: text0, author: author.slice(0, AUTHOR_MAX), createdAt: now, replies: [] };
}

export function addReply(c: Comment, id: string, body: unknown, author: string, now: string): Comment | null {
  const text0 = cleanBody(body);
  if (c.deletedAt || !isValidId(id) || !text0 || c.replies.length >= MAX_REPLIES) return null;
  const reply: CommentReply = { id: id.toLowerCase(), body: text0, author: author.slice(0, AUTHOR_MAX), createdAt: after(activityAt(c), now) };
  return { ...c, replies: c.replies.concat([reply]) };
}

export function editBody(c: Comment, body: unknown, now: string): Comment | null {
  const text0 = cleanBody(body);
  if (c.deletedAt || !text0 || text0 === c.body) return null;
  return { ...c, body: text0, updatedAt: after(c.updatedAt || c.createdAt, now) };
}

export function resolve(c: Comment, now: string): Comment | null {
  if (c.deletedAt || c.resolvedAt) return null;
  const at = after(c.stateAt || c.createdAt, now);
  return { ...c, resolvedAt: at, stateAt: at };
}

export function reopen(c: Comment, now: string): Comment | null {
  if (c.deletedAt || !c.resolvedAt) return null;
  const { resolvedAt: _gone, ...rest } = c;
  return { ...rest, stateAt: after(c.stateAt || c.createdAt, now) };
}

/** Delete a thread: keep a tombstone so the other machine's copy stays deleted. */
export function tombstone(c: Comment, now: string): Comment | null {
  if (c.deletedAt) return null;
  return { id: c.id, target: c.target, body: '', author: c.author, createdAt: c.createdAt, replies: [], deletedAt: after(activityAt(c), now) };
}

export function deleteReply(c: Comment, replyId: string, now: string): Comment | null {
  const r = c.replies.find((x) => x.id === replyId);
  if (c.deletedAt || !r || r.deletedAt) return null;
  const dead: CommentReply = { id: r.id, body: '', author: r.author, createdAt: r.createdAt, deletedAt: after(activityAt(c), now) };
  return { ...c, replies: c.replies.map((x) => (x.id === replyId ? dead : x)) };
}

/** Only live threads and live replies — what a renderer is ever shown. */
export function visible(list: Comment[]): Comment[] {
  return list.filter((c) => !c.deletedAt).map((c) => ({ ...c, replies: c.replies.filter((r) => !r.deletedAt) }));
}

/** The name on a new comment: the display name from Settings, else the OS user. */
export function resolveAuthor(displayName: unknown, osUser: unknown): string {
  const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : '');
  return clean(displayName) || clean(osUser) || 'Me';
}
