// The RPC contract: what makes a handler reachable over HTTP. A channel with no
// contract is a 404 even when a handler is registered (plan §4), so the API
// grows one checked channel at a time.
//
// `input` validates the handler's ONE payload argument — every contracted
// channel takes `(event, payload)`. `access` is the narrowest role that may
// call it; enforcement arrives with roles (T3.3), dev mode runs as admin.

import { z } from 'zod';

export type Access = 'read' | 'write' | 'admin';

export interface Contract<I extends z.ZodType = z.ZodType> {
  readonly access: Access;
  readonly input: I;
}

export function rpc<I extends z.ZodType>(c: { access: Access; input: I }): Contract<I> {
  return Object.freeze({ access: c.access, input: c.input });
}

/** A record id, as UUID_RE spells it everywhere a record id reaches a path. */
export const Uuid = z.guid();

/** A token from `POST /api/files` (src/server/files.ts): 32 random bytes, base64url. */
export const FileToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
