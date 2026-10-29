// What a NEW mention becomes (docs/notifications/00-design.md §5.4-5.9): a row on
// the person's Home, a notice in their open tabs, and an email.
//
// NEVER IN THE WRITE'S WAY. A comment write starts this with `void` once it has
// stored the piece; it never throws, and a slow or broken relay never delays or
// fails the comment. `mentionsSettled()` lets a test wait for it.
//
// CURRENT READERS AT SEND TIME. The write checked its new mentions inside its
// lock; this reads the project's readers AGAIN, and only a mentioned person
// still among them gets anything. The email goes further through the channel
// send's own recipient query (signed in, allowed domain, a deliverable address).
//
// ONCE PER PIECE. The `mentions` INSERT is the gate: the push and the email go
// out only for the people it inserted a row for. If it fails, nothing is sent —
// a repeat must never notify twice. After it, the push and the email fail apart.
//
// PER PERSON, PER HOUR (../mail/budget.ts): an author causes at most
// MENTION_PUSHES_PER_AUTHOR notices and MENTION_EMAILS_PER_AUTHOR emails, and a
// recipient gets at most MENTION_EMAILS_PER_RECIPIENT emails; past a limit only
// the Home row is written. So one member cannot drain the org's mention budget.

import type { Channel } from '../../app/channels';
import type { CommentTarget } from '../../app/commentModel';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { commentSnippet, personName } from '../../app/mentionToken';
import { threadPath } from '../../app/threadPath';
import { audit } from '../authz/audit';
import { ctx } from '../context';
import { mailReady } from '../mail/emailChannel';
import { hold, mentionEmailBuckets, mentionPushBucket } from '../mail/budget';
import { aDeletedRecord, mentionedYouOn, mentionEmailReason } from '../mentionMessages';
import { appLink } from '../publicUrl';
import { publish } from '../sse';
import { deliver } from '../subscriptions/deliver';
import { orgDb } from '../db/inOrg';
import { writerEmails } from '../authz/index';
import { asAudience } from '../../analysis/analysis';
import { currentReaders, labelFor, peopleIn } from './people';
import { recipient, recordMentions } from './store';
import { logger } from '../../app/logger';

/** One stored comment or reply that names people. */
export interface Piece {
  projectId: string;
  commentId: string;
  /** The comment's id for its own body, or the reply's. */
  id: string;
  target: CommentTarget;
  author: string;
  body: string;
}

/** The push a mentioned person's tabs get (`mentions:new`): ids and words, never a figure. */
export interface MentionNotice {
  projectId: string;
  id: string;
  commentId: string;
  target: { kind: CommentTarget['kind']; id: string };
  analysisId?: string;
  by: string;
  on: string;
}

const inFlight = new Set<Promise<void>>();

/** Test hook: until every notice started so far has ended. */
export async function mentionsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

/** Tell `emails` (new mentions of `piece`, never its author). Never throws. */
export function notifyMentions(piece: Piece, emails: string[]): Promise<void> {
  const p = run(piece, emails).catch((err: unknown) => logger.warn('[mentions] notices failed:', err instanceof Error ? err.message : String(err)));
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

async function run(piece: Piece, emails: string[]): Promise<void> {
  if (!emails.length || !orgDb()) return;
  const readers = await currentReaders(piece.projectId);
  let still = emails.filter((e) => readers !== null && readers.has(e));
  if (!still.length) return;
  // A dashboard's draft is its editors' (docs/analysis/00-model.md): the notice names what viewers can open, and one
  // on a dashboard (or a card) only a draft has goes to the project's editors alone.
  let where = await asAudience(() => placeOf(piece));
  if (!where.found && (piece.target.kind === 'analysis' || piece.target.kind === 'card')) {
    const pool = orgDb();
    const writers = new Set(pool ? (await writerEmails(pool, ctx().org.id, piece.projectId)).map((e) => e.toLowerCase()) : []);
    still = still.filter((e) => writers.has(e.toLowerCase()));
    if (!still.length) return;
    where = await placeOf(piece);
  }
  const fresh = await recordMentions({ projectId: piece.projectId, pieceId: piece.id, commentId: piece.commentId, author: piece.author }, still);
  if (!fresh.length) return;
  const notice: MentionNotice = { projectId: piece.projectId, id: piece.id, commentId: piece.commentId, target: { kind: piece.target.kind, id: piece.target.id }, ...(where.analysisId ? { analysisId: where.analysisId } : {}), by: personName(piece.author), on: where.name };
  const org = ctx().org.id;
  for (const email of fresh) {
    if (!(await hold(mentionPushBucket(org, piece.author), 1))) {
      logger.warn('[mentions] notice not pushed: its author reached the hourly limit (the Home row stands)');
      continue;
    }
    try {
      publish({ org, user: email }, 'mentions:new', notice);
    } catch (err) {
      logger.warn('[mentions] push failed:', err instanceof Error ? err.message : String(err));
    }
  }
  if (!mailReady()) return;
  const words = commentSnippet(piece.body, labelFor(peopleIn([piece.body], readers)), 1000);
  for (const email of fresh) {
    await mailOne(piece, email, notice, words).catch((err: unknown) => logger.warn('[mentions] email failed:', err instanceof Error ? err.message : String(err)));
  }
}

/** The record's name and, for a card, the dashboard it is on. */
async function placeOf(piece: Piece): Promise<{ name: string; analysisId?: string; found: boolean }> {
  try {
    // Lazy: ipc/comments starts these notices.
    const { targetNames } = require('../../ipc/comments') as typeof import('../../ipc/comments');
    const names = await targetNames(piece.projectId, [{ target: piece.target } as never]);
    const t = names[`${piece.target.kind}:${piece.target.id}`];
    return t ? { name: t.name, ...(t.analysisId ? { analysisId: t.analysisId } : {}), found: true } : { name: aDeletedRecord(), found: false };
  } catch {
    return { name: aDeletedRecord(), found: false };
  }
}

/** One person's email, through the one send door, and its audit row. */
async function mailOne(piece: Piece, email: string, notice: MentionNotice, words: string): Promise<void> {
  const who = await recipient(email);
  if (!who || !who.emailMe) return; // turned off in Settings → You
  const path = threadPath(piece.projectId, piece.target, notice.analysisId);
  const message = composeMessage({
    title: mentionedYouOn(notice.by, notice.on), subtitle: [], note: words, kpis: [], visuals: [],
    link: path ? appLink(path) : null, footer: '',
  });
  // A channel of one, made here and never saved: the send resolves it as it resolves any list (current reader, signed in, allowed domain).
  const one: Channel = { id: who.id, name: 'mention', kind: 'email', to: { userIds: [who.id], teamIds: [] }, createdBy: piece.author, createdAt: '', updatedAt: '' };
  const { org, requestId } = ctx();
  const held = await hold(mentionEmailBuckets(org.id, piece.author, email), 1);
  if (!held) {
    logger.warn('[mentions] email not sent: its author or recipient reached the hourly limit (the Home row stands)');
    return;
  }
  const r = await deliver(one, { kind: 'mention', projectId: piece.projectId, message, reason: mentionEmailReason(notice.by) });
  if (!r.ok) await held.refund(1); // not sent: it cost the author and the recipient nothing
  await audit(orgDb(), { org: org.id, actor: piece.author, action: 'rpc', channel: 'comment:mention', projectId: piece.projectId, targets: [piece.commentId, piece.id, who.id], outcome: r.ok ? 'ok' : 'error', requestId }).catch(() => undefined);
}
