// Who a mention may name, and what it reads as (docs/notifications/00-design.md
// §5.5, §5.8): the project's CURRENT readers — enabled, org admins and grantees
// directly or through a team (authz readerEmails) — never the org directory.
// Without a database there is no directory: mentions are off.

import { readerEmails } from '../authz/index';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import { MAX_MENTIONS, mentionsIn, normalize, personName } from '../../app/mentionToken';
import { formerMember, notAReader, tooManyMentions } from '../mentionMessages';
import type { MentionGate } from '../../app/comments';

/** Mentions are on: there is a directory of people to check them against. */
export function mentionsOn(): boolean {
  return orgDb() !== null;
}

/** The project's current readers, read now — or null without a database. */
export async function currentReaders(projectId: string): Promise<Set<string> | null> {
  const pool = orgDb();
  if (!pool) return null;
  return new Set((await readerEmails(pool, ctx().org.id, projectId)).map(normalize));
}

/** address → name, for the mentioned addresses in `bodies` that `readers` holds. Names only for current readers. */
export function peopleIn(bodies: string[], readers: Set<string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!readers) return out;
  for (const b of bodies) for (const a of mentionsIn(b)) if (readers.has(a)) out[a] = personName(a);
  return out;
}

/** What server text shows for a mention: "@Ann Lee", or "@former member" — never the address. */
export function labelFor(people: Record<string, string>): (address: string) => string {
  return (a) => '@' + (people[a] ?? formerMember());
}

/** The names `bodies` may show (`peopleIn`), reading the project's readers only when one of them mentions someone. A failed read names no one. */
export async function peopleFor(projectId: string, bodies: string[]): Promise<Record<string, string>> {
  if (!bodies.some((b) => b.includes('@('))) return {};
  return peopleIn(bodies, await currentReaders(projectId).catch(() => null));
}

/** The label every server surface (Home's snippet, a report, an email) gives the mentions in `bodies`. */
export async function labelsFor(projectId: string, bodies: string[]): Promise<(address: string) => string> {
  return labelFor(await peopleFor(projectId, bodies));
}

/**
 * The check a comment write runs INSIDE its lock (app/comments.ts `mutate`), on
 * the body as stored and the body it replaces: refused (a sentence) when the
 * piece names more than MAX_MENTIONS people or a NEW mention is not a current
 * reader (none is, without a database); otherwise the new mentions to notify,
 * never the author. A mention kept from the previous body is not re-checked.
 */
export function mentionGate(readers: Set<string> | null, author: string): MentionGate {
  const me = normalize(author);
  return (prev, next) => {
    const now = mentionsIn(next);
    if (now.length > MAX_MENTIONS) return tooManyMentions(MAX_MENTIONS);
    const before = new Set(mentionsIn(prev));
    const fresh = now.filter((a) => !before.has(a));
    if (fresh.some((a) => !readers || !readers.has(a))) return notAReader();
    return fresh.filter((a) => a !== me);
  };
}
