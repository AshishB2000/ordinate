import { z } from 'zod';
import { rpc, Uuid } from './contract';

// Personal API tokens (T3.4, src/server/auth/tokens.ts): every member manages
// their OWN — the handlers act on the caller's user row only, so `read` (any
// member) is the narrowest access that works. Audited anyway (`audit: true`):
// minting and revoking a credential belongs on the trail.
export const tokens = {
  'tokens:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  // The reply carries the token ONCE; nothing returns it again.
  // `expiresInDays`: every token has an end — 1 to API_TOKEN_MAX_DAYS (the handler holds it to the server's maximum).
  'tokens:create': rpc({ access: 'read', org: true, audit: true, input: z.strictObject({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650) }) }),
  'tokens:revoke': rpc({ access: 'read', org: true, audit: true, input: z.strictObject({ id: Uuid }) }),
} as const;
