// "Ask an editor" (docs/assistant/00-design.md, phase G): a viewer whose question needs data the
// project does not have (outcome D), a link nobody defined (E) or a table that must be copied first
// (a connection that is not live-capable) tells the project's editors and admins.
//
// WHO. The project's editors and admins NOW (authz writerEmails: an org admin, or an editor or admin
// grant of their own or a team's), never the asker, never another viewer, never another project's.
// Each gets a row of `editor_asks` (0033) carrying the question, the reason and the note as sent: a
// viewer's conversation is private, so the editor reads what was sent, never the turn. The bell
// lists only rows on projects the caller may still edit (`WRITABLE`).
//
// THE MENTION PATH (./notify.ts). The rows, then a notice in each one's open tabs (`asks:new`: ids
// and names, no question), then an email to those who turned on "Email me when a viewer asks for
// data" (users.request_email, off by default) through `deliver`, under the mention email budget
// (the asker's hour and each recipient's). The rows are the gate; the push and the email never stand
// in the send's way (`asksSettled` lets a test wait for them).
//
// NOT TWICE, NOT A FLOOD. The same person, project, reason and question (case and spacing aside)
// within a day is "already sent": nothing is written or told again. At most ASKS_PER_DAY sends per
// person a day, across projects. Both are shared counters (../counters.ts, every pod), and a send
// refused or failed is given back: it costs nothing.

import { createHash, randomUUID } from 'crypto';
import type { Channel } from '../../app/channels';
import { composeMessage } from '../../analysis/subscriptionMessage';
import { personName } from '../../app/mentionToken';
import { getProject } from '../../app/projects';
import { logger } from '../../app/logger';
import { writerEmails } from '../authz/index';
import * as counters from '../counters';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { hold, mentionEmailBuckets } from '../mail/budget';
import { mailReady } from '../mail/emailChannel';
import * as say from '../mentionMessages';
import { appLink } from '../publicUrl';
import { publish } from '../sse';
import { WRITABLE } from './store';
import { deliver } from '../subscriptions/deliver';

export type AskReason = 'missing' | 'link' | 'copy';
/** Sends one person may make a day, across projects. */
export const ASKS_PER_DAY = 10;
/** Rows kept per member, newest first (as `mentions`). */
const MAX_ROWS = 200;
const DAY = 86_400_000;

/** Where an editor fixes it: Connections for missing data or a copy, the Data model's Relationships for a link. */
export function askPath(projectId: string, reason: AskReason): string {
  return reason === 'link' ? `/model/${projectId}?tab=relationships` : `/connections/${projectId}`;
}

export function reasonText(reason: AskReason): string {
  return reason === 'link' ? say.askReasonLink() : reason === 'copy' ? say.askReasonCopy() : say.askReasonMissing();
}

export type AskReply = { ok: true; already?: true } | { ok: false; error: string; code?: 'rate_limited' };

interface Ask {
  id: string;
  projectId: string;
  asker: string;
  question: string;
  reason: AskReason;
  note: string;
}

/** The push an editor's tabs get: ids and names, never the question or the note. */
export interface AskNotice {
  projectId: string;
  id: string;
  by: string;
  on: string;
  reason: AskReason;
}

const inFlight = new Set<Promise<void>>();

/** Test hook: until every notice started so far has ended. */
export async function asksSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

/** Who asked, in what project, for what — the dedupe key's hash, so no question text sits in a counter key. */
function sameKey(a: Pick<Ask, 'asker' | 'projectId' | 'reason' | 'question'>): string {
  return 'ask:same:' + createHash('sha256').update([a.asker.toLowerCase(), a.projectId.toLowerCase(), a.reason, a.question.toLowerCase()].join('\0')).digest('hex').slice(0, 32);
}

/** The caller asks the editors of `projectId`. */
export async function askEditors(projectId: string, input: { question: string; reason: AskReason; note?: string }): Promise<AskReply> {
  const pool = orgDb();
  if (!pool) return { ok: false, error: say.asksOff() };
  const { org, user } = ctx();
  const ask: Ask = {
    id: randomUUID(), projectId, asker: user.email, reason: input.reason,
    question: input.question.replace(/\s+/g, ' ').trim().slice(0, 1000), note: (input.note ?? '').trim().slice(0, 1000),
  };
  const to = (await writerEmails(pool, org.id, projectId)).filter((e) => e.toLowerCase() !== ask.asker.toLowerCase());
  if (!to.length) return { ok: false, error: say.noEditorsToAsk() };
  const same = await counters.take(org.id, [{ key: sameKey(ask), limit: 1, windowMs: DAY }]);
  if (!same.ok) return { ok: true, already: true };
  const mine = await counters.take(org.id, [{ key: `ask:from:${ask.asker.toLowerCase()}`, limit: ASKS_PER_DAY, windowMs: DAY }]);
  if (!mine.ok) {
    await counters.give(org.id, same.windows, 1); // refused: it is not "already sent" tomorrow
    return { ok: false, code: 'rate_limited', error: say.tooManyAsks(ASKS_PER_DAY) };
  }
  try {
    await record(ask, to);
  } catch (err) {
    await counters.give(org.id, same.windows, 1);
    await counters.give(org.id, mine.windows, 1);
    throw err;
  }
  const p = tell(ask, to).catch((err: unknown) => logger.warn('[asks] notices failed:', err instanceof Error ? err.message : String(err)));
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return { ok: true };
}

async function record(ask: Ask, to: string[]): Promise<void> {
  await inOrg(async (c, org) => {
    await c.query(
      `INSERT INTO editor_asks (org_id, user_email, id, project_id, asker, question, reason, note)
       SELECT $1, u, $2, $3, $4, $5, $6, $7 FROM unnest($8::text[]) AS u ON CONFLICT DO NOTHING`,
      [org, ask.id, ask.projectId, ask.asker, ask.question, ask.reason, ask.note, to],
    );
    await c.query(
      `DELETE FROM editor_asks a WHERE a.org_id = $1 AND a.user_email = ANY($2::text[])
         AND a.id NOT IN (SELECT k.id FROM editor_asks k WHERE k.org_id = $1 AND k.user_email = a.user_email
                           ORDER BY k.created_at DESC LIMIT ${MAX_ROWS})`,
      [org, to],
    );
  });
}

/** The push to each one's tabs, then the email to those who turned it on. Never throws past its caller's catch. */
async function tell(ask: Ask, to: string[]): Promise<void> {
  const org = ctx().org.id;
  const by = personName(ask.asker);
  const on = (await getProject(ask.projectId).catch(() => null))?.name ?? '';
  const notice: AskNotice = { projectId: ask.projectId, id: ask.id, by, on, reason: ask.reason };
  for (const email of to) {
    try {
      publish({ org, user: email }, 'asks:new', notice);
    } catch (err) {
      logger.warn('[asks] push failed:', err instanceof Error ? err.message : String(err));
    }
  }
  if (!mailReady()) return;
  for (const email of to) await mailOne(ask, email, by, on).catch((err: unknown) => logger.warn('[asks] email failed:', err instanceof Error ? err.message : String(err)));
}

async function mailOne(ask: Ask, email: string, by: string, on: string): Promise<void> {
  const r0 = await orgDb()!.query<{ id: string; request_email: boolean }>('SELECT id::text, request_email FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [ctx().org.id, email]);
  const who = r0.rows[0];
  if (!who || !who.request_email) return; // off unless they turned it on
  const message = composeMessage({
    title: say.askedForData(by, on), subtitle: [`“${ask.question}”`, reasonText(ask.reason)], note: ask.note, noteBy: by,
    kpis: [], visuals: [], link: appLink(askPath(ask.projectId, ask.reason)), footer: '',
  });
  // A channel of one, made here and never saved, as a mention's: the send resolves it as it resolves any list.
  const one: Channel = { id: who.id, name: 'ask', kind: 'email', to: { userIds: [who.id], teamIds: [] }, createdBy: ask.asker, createdAt: '', updatedAt: '' };
  const held = await hold(mentionEmailBuckets(ctx().org.id, ask.asker, email), 1);
  if (!held) return logger.warn('[asks] email not sent: its asker or recipient reached the hourly limit (the bell row stands)');
  const r = await deliver(one, { kind: 'mention', projectId: ask.projectId, message, reason: say.askEmailReason() });
  if (!r.ok) await held.refund(1);
}

/** One of the caller's rows, as the bell shows it: names, never an address. */
export interface AskRow {
  projectId: string;
  id: string;
  by: string;
  question: string;
  reason: AskReason;
  /** The reason as words: "This data isn't in Ordinate yet." */
  why: string;
  note: string;
  at: string;
  seen: boolean;
}

/** The caller's asks on projects they may edit now, unseen first, then newest. */
export async function listAsks(limit: number): Promise<AskRow[]> {
  const { user } = ctx();
  const r = await inOrg((c, org) =>
    c.query<{ project_id: string; id: string; asker: string; question: string; reason: AskReason; note: string; created_at: Date; seen_at: Date | null }>(
      `SELECT a.project_id::text, a.id::text, a.asker, a.question, a.reason, a.note, a.created_at, a.seen_at
         FROM editor_asks a
        WHERE a.org_id = $1 AND a.user_email = $2 AND (${WRITABLE})
        ORDER BY (a.seen_at IS NULL) DESC, a.created_at DESC
        LIMIT $4`,
      [org, user.email, user.role === 'admin', limit],
    ),
  );
  return r.rows.map((x) => ({
    projectId: x.project_id, id: x.id, by: personName(x.asker), question: x.question, reason: x.reason, why: reasonText(x.reason),
    note: x.note, at: x.created_at.toISOString(), seen: x.seen_at !== null,
  }));
}

/** The caller's "Email me when a viewer asks for data" (off unless they turned it on). */
export async function requestEmail(): Promise<boolean> {
  const pool = orgDb();
  if (!pool) return false;
  const r = await pool.query<{ request_email: boolean }>('SELECT request_email FROM users WHERE org_id = $1 AND email = $2', [ctx().org.id, ctx().user.email]);
  return r.rows[0]?.request_email ?? false;
}

export async function setRequestEmail(on: boolean): Promise<boolean> {
  const pool = orgDb();
  if (!pool) return false;
  const r = await pool.query('UPDATE users SET request_email = $3 WHERE org_id = $1 AND email = $2', [ctx().org.id, ctx().user.email, on]);
  return r.rowCount === 1;
}
