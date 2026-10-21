// An email channel's send (docs/email/00-design.md §6, §8–9): whom it reaches
// NOW, how much an org may send, the batches and their retries, and what an
// outcome means — over the SMTP client (./smtp.ts). Called by
// subscriptions/deliver.ts and nothing else.
//
// RECIPIENTS are resolved at send time in ONE query: enabled, signed-in (a
// pending invitee is not yet a member) users of this org, picked directly or
// through a team of this org, who can read the project now (an org admin, or a
// grantee directly or through a team — authz.readerEmails' predicate), then
// sign-in's own domain rule and the strict address pattern. A test goes to the
// calling admin alone; it never runs the query.
//
// LIMITS (./budget.ts, per pod): each batch is held against the org's hourly
// bucket and the project's half of it, per kind, and what the relay did not
// take is given back. A list larger than one project's share can never go and
// says so (`list_too_large`); a budget that runs out mid-send stops there.
//
// BATCHES of ≤ MAX_RCPT are each tried, however an earlier one ended — except
// after a relay-wide failure (TLS, AUTH, a refused relay), which every batch
// would repeat. Some accepted and some not is a PARTIAL send. RETRIES: ≤
// MAX_ATTEMPTS per batch, only for a transient failure BEFORE the final dot
// (after it the relay may have queued the message).
//
// THE LOG gets the relay's words (scrubbed of the password by smtp.ts), never an
// address; a browser gets a typed code and the catalog's sentence.

import type { Pool } from 'pg';
import type { Channel, EmailTo } from '../../app/channels';
import * as config from '../../app/config';
import { renderEmail, type RenderedEmail } from '../../analysis/subscriptionEmail';
import type { MessageModel } from '../../analysis/subscriptionMessage';
import { testEmailBody } from '../../analysis/subscriptionText';
import { domainAllowed } from '../auth/store';
import { isValidId } from '../../app/ids';
import { ctx } from '../context';
import type { Delivery, PostCode, PostResult } from '../subscriptions/deliver';
import { isMailAddress, type MailEnv } from './mailEnv';
import { buildMime, MailError, type MailErrorKind } from './mime';
import { hold, projectShare, resetBudgetsForTest, sendBuckets, testBucket, type Bucket, type Hold } from './budget';
import { MAX_RCPT, sendOnce, useRelay } from './smtp';

export { TEST_EMAILS_PER_HOUR } from './budget';

export interface MailLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];
/** Failures every later batch would repeat: stop trying once one of these ends a batch. */
const RELAY_WIDE: ReadonlySet<MailErrorKind> = new Set(['tls', 'auth', 'refused']);

let relay: MailEnv | null = null;
let directory: { pool: Pool | null; allowed: readonly string[] } = { pool: null, allowed: [] };
let log: MailLog = { info: () => undefined, warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)) };
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wiring (subscriptions/job.ts): the relay from the env, the user directory, ALLOWED_EMAIL_DOMAINS, the log. */
export function wireMail(cfg: MailEnv | null, pool: Pool | null, allowed: readonly string[], l?: MailLog): void {
  relay = cfg;
  useRelay(cfg);
  directory = { pool, allowed };
  if (l) log = l;
}

/** Can this server send email: a relay, and a directory to resolve recipients in. */
export function mailReady(): boolean {
  return relay !== null && directory.pool !== null;
}

/** The sender's name, shown above an email's title. */
export function brandName(): string {
  return relay?.from.name || 'Ordinate';
}

/** Test hooks. */
export function setMailSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
export function resetLimitsForTest(org?: string): Promise<void> {
  return resetBudgetsForTest(org);
}

const PICKED = `FROM users u
 WHERE u.org_id = $1 AND u.disabled_at IS NULL AND u.last_login_at IS NOT NULL
   AND (u.id = ANY($2::uuid[])
        OR EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
                    WHERE m.user_id = u.id AND t.org_id = $1 AND t.id = ANY($3::uuid[])))`;
// authz/index.ts readerEmails' predicate, word for word.
const READS_PROJECT = `
   AND (u.role = 'admin' OR EXISTS (
         SELECT 1 FROM project_grants g
          WHERE g.org_id = u.org_id AND g.project_id = $4
            AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))))`;

function db(): Pool {
  if (!directory.pool) throw new Error('email needs the user directory (DATABASE_URL)');
  return directory.pool;
}

const deliverable = (emails: string[]): string[] => emails.filter((e) => domainAllowed(directory.allowed, e) && isMailAddress(e));

/** The channel's people who can read `projectId` right now. */
export async function recipients(to: EmailTo, projectId: string): Promise<string[]> {
  if (!isValidId(projectId)) throw new Error('a send names no project');
  const r = await db().query<{ email: string }>(`SELECT u.email ${PICKED} ${READS_PROJECT} ORDER BY u.email`, [ctx().org.id, to.userIds, to.teamIds, projectId]);
  return deliverable(r.rows.map((x) => x.email));
}

/** How many people the channel names today (no project asked): what a test reports. */
export async function reach(to: EmailTo): Promise<number> {
  const r = await db().query<{ email: string }>(`SELECT u.email ${PICKED}`, [ctx().org.id, to.userIds, to.teamIds]);
  return deliverable(r.rows.map((x) => x.email)).length;
}

/** The calling admin's own address, if it is an enabled, signed-in member's: where a test goes. */
async function callerAddress(): Promise<string | null> {
  const { org, user } = ctx();
  const r = await db().query<{ email: string }>('SELECT email FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL AND last_login_at IS NOT NULL', [org.id, user.email]);
  return deliverable(r.rows.map((x) => x.email))[0] ?? null;
}

/** Are all of `to`'s ids users and teams of the caller's org? What channel:save checks. */
export async function knownRecipients(to: EmailTo): Promise<boolean> {
  const org = ctx().org.id;
  const [u, t] = await Promise.all([
    db().query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, to.userIds]),
    db().query<{ n: number }>('SELECT count(*)::int AS n FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, to.teamIds]),
  ]);
  return u.rows[0].n === to.userIds.length && t.rows[0].n === to.teamIds.length;
}

export interface BatchOutcome {
  /** Recipients the relay took, and refused at RCPT, over every batch. */
  accepted: number;
  rejected: number;
  attempts: number;
  /** Batches that ended without the relay taking them. */
  failedBatches: number;
  /** The hourly budget ran out before every batch was held. */
  limited: boolean;
  /** The first batch failure, for the run's code (the log has each). */
  error: MailError | null;
}

/** A refund that cannot reach the counter is logged, never thrown: the batch's outcome stands. */
async function giveBack(held: Hold | null, n: number): Promise<void> {
  if (held && n > 0) await held.refund(n).catch((err: unknown) => log.warn({ err }, 'email budget refund failed'));
}

/**
 * `data` to `to` in messages of ≤ MAX_RCPT. Each batch is held against `budget`
 * first (when given), retried only when that cannot deliver twice, and given
 * back what the relay did not take. Every batch is tried after a failed one,
 * unless the failure was relay-wide.
 */
export async function sendBatches(to: readonly string[], data: string, channelId: string, budget?: readonly Bucket[]): Promise<BatchOutcome> {
  const out: BatchOutcome = { accepted: 0, rejected: 0, attempts: 0, failedBatches: 0, limited: false, error: null };
  for (let i = 0; i < to.length; i += MAX_RCPT) {
    const batch = to.slice(i, i + MAX_RCPT);
    const held = budget ? await hold(budget, batch.length) : null;
    if (budget && !held) {
      out.limited = true;
      log.warn({ channel: channelId, unsent: to.length - i }, 'email stopped: the hourly email budget ran out');
      break;
    }
    const t0 = Date.now();
    let fatal = false;
    for (let attempt = 1; ; attempt++) {
      out.attempts++;
      try {
        const r = await sendOnce(batch, data);
        out.accepted += r.accepted;
        out.rejected += r.rejected.length;
        await giveBack(held, batch.length - r.accepted);
        log.info({ channel: channelId, recipients: batch.length, accepted: r.accepted, rejected: r.rejected.map((x) => x.code), ms: Date.now() - t0 }, 'email sent');
        break;
      } catch (err) {
        const e = err instanceof MailError ? err : new MailError('unreachable', err instanceof Error ? err.message : String(err));
        log.warn({ channel: channelId, attempt, kind: e.kind, code: e.code, afterDot: e.afterDot, detail: e.detail }, 'email not sent');
        const transient = (e.kind === 'unreachable' || e.kind === 'timeout' || e.kind === 'temporary') && !e.afterDot;
        if (!transient || attempt >= MAX_ATTEMPTS) {
          // After the final dot the relay may have it: keep it charged. Otherwise it cost nothing.
          if (!e.afterDot) await giveBack(held, batch.length);
          out.failedBatches++;
          out.error ??= e;
          fatal = RELAY_WIDE.has(e.kind);
          break;
        }
        await sleep(BACKOFF_MS[attempt - 1] ?? 0);
      }
    }
    if (fatal) break;
  }
  return out;
}

const CODE: Record<MailErrorKind, PostCode> = {
  unreachable: 'unreachable', timeout: 'unreachable', refused: 'refused', tls: 'tls_failed', auth: 'auth_failed',
  // A relay that does not speak SMTP was not reached; a message that cannot be built is a failed composition.
  rejected: 'mail_failed', temporary: 'mail_failed', protocol: 'unreachable', input: 'compute_failed',
};

/** The org's look for an email: its accent and language. Never fails a send. */
function look(channelName: string): { channelName: string; accent: string; brand: string; lang: string } {
  try {
    const c = config.get();
    return { channelName, accent: c.branding?.accent ?? '', brand: brandName(), lang: c.language || 'en' };
  } catch {
    return { channelName, accent: '', brand: brandName(), lang: 'en' };
  }
}

/** The email as the subscription preview shows it. */
export function previewEmail(model: MessageModel, channelName: string): RenderedEmail {
  return renderEmail(model, look(channelName));
}


/** Send `message` over an email channel. Never throws. */
export async function sendEmail(c: Channel, d: Delivery, message: MessageModel): Promise<PostResult> {
  const cfg = relay;
  if (!cfg || !mailReady() || !c.to) return { ok: false, code: 'mail_off', attempts: 0 };
  const org = ctx().org.id;
  let to: string[];
  let body = message;
  try {
    if (d.kind === 'test') {
      const me = await callerAddress();
      to = me ? [me] : [];
      body = { ...message, note: [message.note, testEmailBody(c.name, await reach(c.to))].filter(Boolean).join(' ') };
    } else {
      to = await recipients(c.to, d.projectId);
    }
  } catch (err) {
    log.warn({ channel: c.id, error: err instanceof Error ? err.message : String(err) }, 'email recipients could not be read');
    return { ok: false, code: 'unreachable', attempts: 0 };
  }
  if (!to.length) {
    log.warn({ channel: c.id, ...(d.kind === 'test' ? {} : { projectId: d.projectId }) }, 'email not sent: nobody on the channel can read it');
    return { ok: false, code: 'no_recipients', attempts: 0 };
  }
  // A list one project could never send within an hour is not "busy this hour": it says so, every time.
  if (d.kind !== 'test' && to.length > projectShare(cfg.orgPerHour)) {
    log.warn({ channel: c.id, recipients: to.length, share: projectShare(cfg.orgPerHour) }, 'email not sent: the list is larger than the hourly limit allows');
    return { ok: false, code: 'list_too_large', attempts: 0 };
  }
  let data: string;
  try {
    const r = previewEmail(body, c.name);
    data = buildMime({ from: cfg.from, subject: r.subject, text: r.text, html: r.html });
  } catch (err) {
    log.warn({ channel: c.id, error: err instanceof MailError ? err.detail : String(err) }, 'email not built');
    return { ok: false, code: 'compute_failed', attempts: 0 };
  }
  const out = await sendBatches(to, data, c.id, d.kind === 'test' ? testBucket(org) : sendBuckets(org, d.projectId, d.kind, cfg.orgPerHour));
  // Some people got it: sent — and, when a batch failed or the budget ran out, partial (said in the run, never a failure).
  if (out.accepted > 0) return { ok: true, code: 'sent', attempts: out.attempts, ...(out.error || out.limited ? { partial: { sent: out.accepted, total: to.length } } : {}) };
  if (out.error) return { ok: false, code: CODE[out.error.kind], ...(out.error.code ? { status: out.error.code } : {}), attempts: out.attempts };
  return { ok: false, code: 'rate_limited', attempts: out.attempts };
}
