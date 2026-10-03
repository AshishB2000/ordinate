// Who is signed in, and signing out. Plain routes, not RPC channels: they sit
// outside the server's sign-in gate (src/server/auth/index.ts), because you
// cannot need a session to find out you have none.

import { useQuery } from '@tanstack/react-query';

export interface Me {
  /** null when signed out. */
  user: { email: string; role: string } | null;
  org: string | null;
  mode: 'dev' | 'oidc' | 'header';
  /** Only a session can be ended here; header mode signs out at the proxy. */
  canSignOut: boolean;
  /** The server keeps members, teams and API tokens (it has Postgres). Absent from an older server. */
  accounts?: boolean;
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
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Sign out failed (${res.status}).`);
}

/** The sign-in page's address, coming back to `next` afterwards. */
export function signInPath(next: string): string {
  return next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
}
