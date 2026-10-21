// Uploads and downloads that ANY pod serves (docs/any-pod/00-design.md §3.1–3.3):
// the token is a row (./fileTokens.ts), the bytes are in the org's staging
// area (./staging.ts). ./files.ts uses this when the database is on, and its
// in-process Map otherwise.
//
// CAPTURED, NEVER RE-READ. A take records { org, user, place, hash } from ctx()
// inside the request; everything after it — `done()`, a download's `close`
// (which a client abort fires OUTSIDE the request, where ctx() throws), the
// local-copy timer — uses only those values, and every deferred delete ends in
// `.catch(log)`. An uncaught throw there would take the pod down.
//
// LOCAL COPIES (S3 only). The pod that received an upload, or wrote a
// download, keeps its file (≤ LOCAL_COPY_MAX) so a take on THIS pod needs no
// GET. An open handle holds its copy (refs); the 60 s timer drops a copy that
// has expired or whose row was taken elsewhere or is gone.

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { ctx } from './context';
import * as tokens from './fileTokens';
import * as staging from './staging';

/** A local copy above this is deleted once its PUT lands: another pod would GET it anyway. */
export const LOCAL_COPY_MAX = 64 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface Log {
  warn(obj: object, msg: string): void;
}
let log: Log = { warn: () => undefined };
export function useFilesLog(l: Log): void {
  log = l;
}

interface Copy {
  readonly file: string;
  readonly org: string;
  readonly expires: number;
  refs: number;
}
const copies = new Map<string, Copy>(); // token hash (hex) → this pod's file

/** What a take captured. Nothing after the take reads ctx(). */
export interface Taken {
  readonly org: string;
  readonly hash: Buffer;
  readonly hex: string;
  readonly place: staging.Place;
  readonly name: string;
  readonly size: number;
  readonly usedAt: Date;
}

/** Thrown by a take that matched nothing; ./files.ts turns it into its FileTokenError. */
export class NoToken extends Error {}

export const sha256File = async (file: string): Promise<string> => {
  const h = createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
};

/**
 * A new token for `file` (in the caller's org temp dir, `size` bytes, `sha256` hex when known).
 * The row first, then the bytes up (S3); a failed PUT deletes its row.
 */
export async function issue(kind: 'upload' | 'download', file: string, name: string, size: number, ttlMs: number, sha256?: string): Promise<string> {
  const { org, user } = ctx();
  const place = staging.here(path.basename(file));
  const token = randomBytes(32).toString('base64url');
  await tokens.insert(token, { org: org.id, user: user.email, kind, key: place.name, name, size, ttlMs });
  if (!staging.isS3()) return token;
  try {
    await staging.publish(place, file, sha256 ?? await sha256File(file), size);
  } catch (err) {
    await tokens.remove(place.org, tokens.hashOf(token)).catch((e: unknown) => log.warn({ err: e }, 'file token: a row could not be deleted after its upload failed'));
    throw err;
  }
  const hex = tokens.hashOf(token).toString('hex');
  if (size <= LOCAL_COPY_MAX) copies.set(hex, { file, org: place.org, expires: Date.now() + ttlMs, refs: 0 });
  else void fs.promises.rm(file, { force: true }).catch(() => undefined);
  return token;
}

/** THE TAKE, for the current request's org and user. Throws NoToken. */
export async function take(token: unknown, kind: 'upload' | 'download'): Promise<Taken> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new NoToken();
  const { org, user } = ctx();
  const hash = tokens.hashOf(token);
  const row = await tokens.takeRow(org.id, user.email, kind, hash);
  if (!row) throw new NoToken();
  let place: staging.Place;
  try {
    place = staging.placeIn(org.id, row.key);
  } catch {
    throw new NoToken();
  }
  return { org: org.id, hash, hex: hash.toString('hex'), place, name: row.name, size: row.size, usedAt: row.usedAt };
}

/** This pod's copy, held (refs + 1), when it still has one. */
function holdCopy(t: Taken): string | null {
  const c = copies.get(t.hex);
  if (!c || !fs.existsSync(c.file)) return null;
  c.refs++;
  return c.file;
}

const transient = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500; // a network error has no status
};

/**
 * A LOCAL file with the taken bytes: this pod's copy, the shared file (file mode), or a fresh GET
 * (S3: retried once on a 5xx or a network error). On failure the take is undone when the cause may
 * pass (so the user can simply try again) and NoToken is thrown — never a path or a store's message.
 */
export async function localFile(t: Taken): Promise<{ file: string; own: boolean; held: boolean }> {
  const held = holdCopy(t);
  if (held) return { file: held, own: false, held: true };
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < (staging.isS3() ? 2 : 1); attempt++) {
    try {
      const got = await staging.fetchLocal(t.place);
      await fs.promises.stat(got.file);
      return { ...got, held: false };
    } catch (err) {
      lastErr = err;
      if (!transient(err)) break;
    }
  }
  if (staging.isS3() && transient(lastErr)) {
    await tokens.untake(t.org, t.hash, t.usedAt).catch((err: unknown) => log.warn({ err }, 'file token: a take could not be undone'));
  }
  throw new NoToken();
}

/** Lets go of a held copy; the last holder deletes it. */
function release(t: Taken): void {
  const c = copies.get(t.hex);
  if (!c) return;
  c.refs = Math.max(0, c.refs - 1);
  if (c.refs === 0) {
    copies.delete(t.hex);
    void fs.promises.rm(c.file, { force: true }).catch(() => undefined);
  }
}

/**
 * The token is done with: this pod's file, the shared bytes, then the row. Uses only what the take
 * captured; never throws (a failure is logged and left to the sweep).
 */
export function finish(t: Taken, local?: { file: string; own: boolean; held: boolean }): void {
  if (local?.held) release(t);
  else if (local?.own) void fs.promises.rm(local.file, { force: true }).catch(() => undefined);
  void staging.remove(t.place)
    .then(() => tokens.remove(t.org, t.hash))
    .catch((err: unknown) => log.warn({ err }, 'file token: its bytes or row could not be deleted; the sweep will'));
}

/** A taken download's bytes as a stream (this pod's copy held while it is read). Throws NoToken when they are gone. */
export async function openTaken(t: Taken): Promise<{ body: Readable; size: number; held: boolean }> {
  const held = holdCopy(t);
  if (held) {
    try {
      const { size } = await fs.promises.stat(held);
      return { body: fs.createReadStream(held), size, held: true };
    } catch {
      release(t);
    }
  }
  try {
    return { ...(await staging.openStream(t.place)), held: false };
  } catch {
    throw new NoToken();
  }
}

/** The 60 s pass over this pod's copies: expired ones, and ones whose row was taken elsewhere or is gone. Never one held. */
export async function sweepCopies(now = Date.now()): Promise<void> {
  const byOrg = new Map<string, string[]>();
  for (const [hex, c] of copies) {
    if (c.refs > 0) continue;
    if (now >= c.expires) {
      copies.delete(hex);
      await fs.promises.rm(c.file, { force: true }).catch(() => undefined);
      continue;
    }
    byOrg.set(c.org, [...(byOrg.get(c.org) ?? []), hex]);
  }
  if (!tokens.dbOn()) return;
  for (const [org, hexes] of byOrg) {
    const live = await tokens.waiting(org, hexes).catch((err: unknown) => {
      log.warn({ err }, 'file token: local copies could not be checked');
      return new Set(hexes);
    });
    for (const hex of hexes) {
      const c = copies.get(hex);
      if (live.has(hex) || !c || c.refs > 0) continue;
      copies.delete(hex);
      await fs.promises.rm(c.file, { force: true }).catch(() => undefined);
    }
  }
}

/** Test hook: this pod's copies (hex → refs). */
export function copiesForTest(): Map<string, number> {
  return new Map([...copies].map(([h, c]) => [h, c.refs]));
}
