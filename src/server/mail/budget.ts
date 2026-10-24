// Hourly email budgets, ACROSS PODS (docs/email/00-design.md D6; the shared
// counter, docs/any-pod/00-design.md §3.8):
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
//
// The hour is a window that opens at a bucket's first charge (../counters.ts),
// not a rolling hour: at a window's end a full hour's budget is free again.
// A bucket's key is `<org>\0<the rest>`; every kind goes through the same
// counter under `mail:<the rest>`, so a new kind needs nothing here but its key.

import * as counters from '../counters';

const HOUR = 3_600_000;
export const TEST_EMAILS_PER_HOUR = 10;

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
  refund(n: number): Promise<void>;
}

/** The org every bucket names — one hold is one org's. */
function orgOf(buckets: readonly Bucket[]): string {
  const orgs = new Set(buckets.map(([key]) => key.slice(0, key.indexOf('\0'))));
  if (orgs.size !== 1 || buckets.some(([key]) => key.indexOf('\0') <= 0)) throw new Error('email budget: one hold, one org');
  return [...orgs][0];
}

/** Holds `n` in every bucket, or nothing and null when any of them lacks the room. */
export async function hold(buckets: readonly Bucket[], n: number): Promise<Hold | null> {
  if (!buckets.length) return { refund: async () => undefined };
  const org = orgOf(buckets);
  const taken = await counters.take(org, buckets.map(([key, limit]) => ({
    key: 'mail:' + key.slice(key.indexOf('\0') + 1).split('\0').join(':'),
    limit,
    windowMs: HOUR,
  })), n);
  if (!taken.ok) return null;
  return { refund: (k) => counters.give(org, taken.windows, k) };
}

/** Test hook: every budget in memory; with `org`, that org's budgets in Postgres too. */
export async function resetBudgetsForTest(org?: string): Promise<void> {
  counters.resetMemoryForTest();
  if (org) await counters.forgetForTest(org, 'mail:');
}
