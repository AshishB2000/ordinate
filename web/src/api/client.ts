// The one door from the browser to the server: `rpc(channel, ...args)` →
// POST /api/rpc/<channel>. Bodies go through the wire codec both ways, so a
// NaN or a Date arrives as what the handler returned, not what JSON makes of it.

// ── T0.2 seam ───────────────────────────────────────────────────────────────
// TODO(T0.2): replace these three lines with the real contracts and codec:
//   import type { Channel } from '../../../src/api';
//   import { encode, decode } from '../../../src/server/wire';
// and type `args` from the channel's contract input.
type Channel = string;
const encode = (x: unknown): string => JSON.stringify(x);
const decode = (text: string): unknown => JSON.parse(text) as unknown;
// ─────────────────────────────────────────────────────────────────────────────

/** A failed call. `status` 0 means the server was never reached. */
export class RpcError extends Error {
  readonly status: number;
  readonly code: string;
  /** For a 400: the input paths that failed validation (never their values). */
  readonly paths?: readonly string[];

  constructor(status: number, code: string, message: string, paths?: readonly string[]) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
    this.code = code;
    if (paths) this.paths = paths;
  }
}

/** This tab's id. The server routes SSE pushes to a tab by it (T0.5). */
export const CLIENT_ID: string = crypto.randomUUID();

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  issues?: unknown;
}

function toError(status: number, statusText: string, text: string): RpcError {
  let body: ErrorBody = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as ErrorBody;
  } catch {
    // not JSON (a proxy's HTML error page): status alone says it
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const code = str(body.code) ?? str(body.error) ?? `http_${status}`;
  const message = str(body.message) ?? str(body.error) ?? (statusText || `Request failed (${status})`);
  const paths = Array.isArray(body.issues)
    ? body.issues.map((i: { path?: unknown }) => String(i?.path ?? ''))
    : undefined;
  return new RpcError(status, code, message, paths);
}

export async function rpc(channel: Channel, ...args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ordinate-Client': CLIENT_ID },
      body: encode({ args }),
      credentials: 'same-origin',
    });
  } catch {
    throw new RpcError(0, 'network', 'Could not reach the Ordinate server.');
  }
  const text = await res.text();
  if (!res.ok) throw toError(res.status, res.statusText, text);
  return decode(text);
}
