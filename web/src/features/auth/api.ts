// Who is signed in, and signing out. Plain routes, not RPC channels: they sit
// outside the server's sign-in gate (src/server/auth/index.ts), because you
// cannot need a session to find out you have none.

import { useQuery } from '@tanstack/react-query';
import { send } from '../../api/client';

export interface Me {
  /** null when signed out. */
  user: { email: string; role: string; mustChangePassword?: boolean } | null;
  org: string | null;
  mode: 'password' | 'oidc' | 'header' | 'dev';
  /** Only a session can be ended here; header mode signs out at the proxy. */
  canSignOut: boolean;
  /** The server keeps members, teams and API tokens (it has Postgres). Absent from an older server. */
  accounts?: boolean;
  /** Password sign-in with no admin yet: the sign-in page creates the first admin account. */
  setup?: boolean;
}

function isMe(v: unknown): v is Me {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const u = m.user as Record<string, unknown> | null | undefined;
  return (
    (u === null || (typeof u === 'object' && typeof u?.email === 'string' && typeof u.role === 'string')) &&
    typeof m.mode === 'string' &&
    typeof m.canSignOut === 'boolean'
  );
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not check who is signed in (${res.status}).`);
  const body: unknown = await res.json();
  if (!isMe(body)) throw new Error('The server answered the sign-in check in an unexpected shape.');
  return body;
}

export const ME_KEY = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 60_000 });
}

/** Ends this browser's session. The caller navigates to the sign-in page. */
export async function signOut(): Promise<void> {
  const res = await send('/api/auth/logout', { method: 'POST' });
  if (!res.ok) throw new Error(`Sign out failed (${res.status}).`);
}

/** Ends every session of the signed-in user, on every device — this one included. */
export async function signOutEverywhere(): Promise<void> {
  const res = await send('/api/auth/logout-everywhere', { method: 'POST' });
  if (!res.ok) throw new Error(`Sign out everywhere failed (${res.status}).`);
}

/** The sign-in page's address, coming back to `next` afterwards. */
export function signInPath(next: string): string {
  return next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
}

/** A password route's answer: ok, or the server's refusal code (src/server/auth/password.ts). */
export type PasswordReply = { ok: true; mustChangePassword?: boolean } | { ok: false; error: string; retryAfter?: number };

async function postPassword(path: string, body: Record<string, string>): Promise<PasswordReply> {
  const res = await send(`/api/auth/password/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // A refusal is 200 { ok: false, error } (no console error for a typo); the per-IP limit is a 429.
  const reply = (await res.json().catch(() => ({}))) as { ok?: unknown; mustChangePassword?: unknown; error?: unknown; retryAfter?: unknown };
  if (res.ok && reply.ok === true) return { ok: true, mustChangePassword: reply.mustChangePassword === true };
  const retryAfter = typeof reply.retryAfter === 'number' ? reply.retryAfter : undefined;
  return { ok: false, error: typeof reply.error === 'string' ? reply.error : `http-${res.status}`, ...(retryAfter ? { retryAfter } : {}) };
}

/** Signs in with Ordinate's own email + password (AUTH_MODE=password). */
export const passwordSignIn = (email: string, password: string) => postPassword('login', { email, password });

/** Creates the first admin account with the setup code from the server's log, and signs in as it. */
export const passwordSetup = (code: string, email: string, password: string) => postPassword('setup', { code, email, password });

/** Changes the signed-in user's password; their other sessions end. */
export const changePassword = (current: string, password: string) => postPassword('change', { current, password });

/** The change-password page's address, coming back to `next` afterwards. */
export function changePasswordPath(next: string): string {
  return next === '/' ? '/change-password' : `/change-password?next=${encodeURIComponent(next)}`;
}

/** The shortest password the server accepts (src/server/auth/passwordHash.ts PASSWORD_MIN). */
export const PASSWORD_MIN = 10;

/** Whether `pw` is under PASSWORD_MIN characters, counted as the server counts them (code points: an emoji is one). */
export function tooShort(pw: string): boolean {
  let n = 0;
  for (const _c of pw) if (++n >= PASSWORD_MIN) return false;
  return true;
}
