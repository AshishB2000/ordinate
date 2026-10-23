// Hourly email budgets, per pod (docs/email/00-design.md D6; the R8 ceiling):
//
//   org      RATE_LIMIT_EMAIL_ORG_PER_HOUR recipients per org and kind
//            (subscriptions, alerts and mentions apart, so one cannot starve another)
//   project  half of that per project and kind, so one project cannot drain
//            the org's budget
//   test     TEST_EMAILS_PER_HOUR test emails per org
//   mention  on top of the org and project buckets, per person: what one author
//            can cause (MENTION_EMAILS_PER_AUTHOR emails, MENTION_PUSHES_PER_AUTHOR
//            notices) and what one recipient gets (MENTION_EMAILS_PER_RECIPIENT),
//            so one member cannot drain the org's mention budget or flood a person
//
// A batch HOLDS its recipients in every bucket before it is sent (all or none,
// so two sends at once cannot both pass the check), and gives back what the
// relay did not accept — a failed batch costs nothing.

const HOUR = 3_600_000;
export const TEST_EMAILS_PER_HOUR = 10;

interface Charge { at: number; n: number }
const used = new Map<string, Charge[]>();

function charges(key: string, now: number): Charge[] {
  const live = (used.get(key) ?? []).filter((c) => now - c.at < HOUR && c.n > 0);
  used.set(key, live);
  return live;
}

export type Bucket = readonly [key: string, limit: number];

/** What one send's batches are held against: the org's bucket and the project's half, for this kind. */
export function sendBuckets(org: string, projectId: string, kind: 'dashboard' | 'alert' | 'mention', orgPerHour: number): Bucket[] {
  return [[`${org}\0${kind}`, orgPerHour], [`${org}\0${projectId}\0${kind}`, projectShare(orgPerHour)]];
}

/** The most one project may send per hour and kind — so also the largest list that can ever go out. */
export function projectShare(orgPerHour: number): number {
  return Math.max(1, Math.floor(orgPerHour / 2));
}

export function testBucket(org: string): Bucket[] {
  return [[`${org}\0test`, TEST_EMAILS_PER_HOUR]];
}

export const MENTION_EMAILS_PER_AUTHOR = 20;
export const MENTION_EMAILS_PER_RECIPIENT = 10;
export const MENTION_PUSHES_PER_AUTHOR = 60;

/** One mention email, held against its author's hour and its recipient's (the org and project buckets come after, in the send). */
export function mentionEmailBuckets(org: string, author: string, recipient: string): Bucket[] {
  return [[`${org}\0mention-from\0${author}`, MENTION_EMAILS_PER_AUTHOR], [`${org}\0mention-to\0${recipient}`, MENTION_EMAILS_PER_RECIPIENT]];
}

/** One mention notice in someone's open tabs, held against its author's hour. */
export function mentionPushBucket(org: string, author: string): Bucket[] {
  return [[`${org}\0mention-push\0${author}`, MENTION_PUSHES_PER_AUTHOR]];
}

export interface Hold {
  /** Give back `n` of what was held (the recipients the relay did not take). */
  refund(n: number): void;
}

/** Holds `n` in every bucket, or nothing and null when any of them lacks the room. */
export function hold(buckets: readonly Bucket[], n: number, now = Date.now()): Hold | null {
  if (buckets.some(([key, limit]) => charges(key, now).reduce((sum, c) => sum + c.n, 0) + n > limit)) return null;
  const held = buckets.map(([key]) => {
    const c: Charge = { at: now, n };
    (used.get(key) as Charge[]).push(c);
    return c;
  });
  return { refund: (k) => { for (const c of held) c.n = Math.max(0, c.n - k); } };
}

export function resetBudgetsForTest(): void {
  used.clear();
}
