import { z } from 'zod';
import { rpc, Uuid } from './contract';

// Personal API tokens (T3.4, src/server/auth/tokens.ts): every member manages
// their OWN — the handlers act on the caller's user row only, so `read` (any
// member) is the narrowest access that works. Audited anyway (`audit: true`):
// minting and revoking a credential belongs on the trail.
export const tokens = {
  'tokens:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  // The reply carries the token ONCE; nothing returns it again.
  'tokens:create': rpc({ access: 'read', org: true, audit: true, input: z.strictObject({ name: z.string().trim().min(1).max(100) }) }),
  'tokens:revoke': rpc({ access: 'read', org: true, audit: true, input: z.strictObject({ id: Uuid }) }),
} as const;
