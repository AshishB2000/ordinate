// Password hashing for AUTH_MODE=password: Node's own scrypt (no dependency),
// run on libuv's thread pool, so a sign-in never blocks the event loop.
//
// Stored as `scrypt$<N>$<r>$<p>$<salt>$<hash>` (salt and hash base64url), so the
// cost can be raised later and old hashes still verify. Compared with
// timingSafeEqual; an unknown email is checked against a dummy hash, so a
// wrong address and a wrong password take the same time.

import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'crypto';

/** N = 2^15, r = 8, p = 1: 32 MiB and roughly 50–100 ms per hash on a server core. */
const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
// Ceilings for a stored hash's own parameters, so a corrupt row cannot ask for a huge allocation.
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

/** Shortest and longest password accepted. The ceiling keeps a request body from being a hashing workload. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** Characters as a person counts them (code points): an emoji is one, not two UTF-16 units. */
export function charCount(s: string): number {
  let n = 0;
  for (const _c of s) n++;
  return n;
}

/** null when acceptable, else why not ('short' | 'long'). */
export function passwordProblem(pw: unknown): 'short' | 'long' | null {
  if (typeof pw !== 'string' || charCount(pw) < PASSWORD_MIN) return 'short';
  if (pw.length > PASSWORD_MAX) return 'long';
  return null;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  // maxmem: scrypt needs 128·N·r bytes; Node's 32 MiB default is exactly too small at N = 2^15.
  const opts: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 };
  return new Promise((resolve, reject) => scrypt(password.normalize('NFC'), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, COST.N, COST.r, COST.p);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

// Verified against when there is no stored hash, so timing does not say whether the email exists.
let dummy: Promise<string> | null = null;

/** Whether `password` matches `stored`. A missing or malformed `stored` is false, after the same work. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  const [tag, n, r, p, salt, hash] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  const valid =
    parts.length === 6 && tag === 'scrypt' && Number.isInteger(N) && N > 1 && N <= MAX_N && (N & (N - 1)) === 0 &&
    Number.isInteger(R) && R >= 1 && R <= MAX_R && Number.isInteger(P) && P >= 1 && P <= MAX_P;
  if (!valid) {
    dummy ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummy);
    return false;
  }
  const want = Buffer.from(hash, 'base64url');
  const got = await derive(password, Buffer.from(salt, 'base64url'), N, R, P);
  return want.length === got.length && timingSafeEqual(want, got);
}

// No 0/O, 1/I/L: the code is read off a log and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

/** A first-run setup code, e.g. `K7QM-2XRA-V9TD` (12 symbols from 31: ~59 bits). */
export function newSetupCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** A typed code as it was printed: upper case, dashes and spaces ignored; null when it cannot be one. */
export function normalSetupCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_GROUPS * CODE_GROUP_LEN) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return Array.from({ length: CODE_GROUPS }, (_, g) => s.slice(g * CODE_GROUP_LEN, (g + 1) * CODE_GROUP_LEN)).join('-');
}
