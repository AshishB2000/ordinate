// MCP over loopback HTTP — `POST /mcp`, one JSON-RPC message in, one out.
// Node's own http module; no Electron, so scripts/test-automation.ts runs the
// REAL server on an ephemeral port.
//
// Gates, in order — every one is a refusal before a byte of the body is read:
//   1. Bound to 127.0.0.1 ONLY (the listen call). Nothing off this machine
//      can connect at all.
//   2. Host must be localhost / 127.0.0.1 (403). A web page whose attacker
//      domain re-resolves to 127.0.0.1 (DNS rebinding) sends ITS name as Host.
//   3. An Origin, when present, must be a loopback http origin (403): a page
//      in the user's browser can POST to localhost, but it says where it is.
//   4. `Authorization: Bearer <token>` (401), compared in constant time. The
//      token lives in main's memory only — see src/ipc/automation.ts.
//   5. POST only (405), a body cap (413), JSON (400 + JSON-RPC parse error).

import * as http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { RPC, rpcError } from './mcp';
import type { RpcResponse } from './mcp';

export const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

export interface HttpOptions {
  port: number;
  /** The CURRENT token — read per request, so Regenerate takes effect at once. */
  token: () => string | null;
  handle: (msg: unknown) => Promise<RpcResponse | null>;
}

/** Host header → is it this machine by name. `[::1]` is refused: the server is not bound there. */
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK.has(name);
}

export function loopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch (_) {
    return false; // includes the literal "null" origin of sandboxed and file: pages
  }
}

/** Constant-time: both sides are hashed to one length before timingSafeEqual. */
export function bearerMatches(header: string | undefined, token: string | null): boolean {
  if (!token || !header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

export function startHttp(opts: HttpOptions): Promise<HttpServer> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        ...(text ? { 'Content-Type': 'application/json' } : {}),
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(text);
    };
    if ((req.url || '').split('?')[0] !== '/mcp') return send(404, { error: 'Not found. The MCP endpoint is /mcp.' });
    if (!loopbackHost(req.headers.host)) return send(403, { error: 'Forbidden host.' });
    const origin = req.headers.origin;
    if (origin !== undefined && !loopbackOrigin(origin)) return send(403, { error: 'Forbidden origin.' });
    if (!bearerMatches(req.headers.authorization, opts.token())) {
      return send(401, { error: 'Missing or wrong access token.' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method !== 'POST') return send(405, { error: 'Use POST.' }, { Allow: 'POST' });

    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        send(413, { error: 'Request too large.' }, { Connection: 'close' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        return send(400, rpcError(null, RPC.parse, 'Parse error'));
      }
      if (Array.isArray(msg)) return send(400, rpcError(null, RPC.invalidRequest, 'Batches are not supported.'));
      opts.handle(msg).then(
        (reply) => (reply ? send(200, reply) : send(202)),
        () => send(500, rpcError(null, RPC.internal, 'Internal error')),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      resolve({
        port: addr && typeof addr === 'object' ? addr.port : opts.port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
