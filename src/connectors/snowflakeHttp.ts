// The Snowflake transport — MAIN PROCESS ONLY. One bounded HTTPS request.
//
// Why not http.ts's httpRequest, which every other HTTP engine shares: it
// decodes the body as UTF-8 text, and the SQL API sends result partitions
// after the first GZIP-COMPRESSED (Content-Encoding: gzip) — bytes that a text
// decode destroys; and it takes no abort signal, which the live path needs to
// cancel a warehouse statement when the viewer hangs up. http.ts cannot grow
// (pinned in the file-size allowlist), so this is its own small file over the
// same SSRF guard everything else uses:
//
//   • ssrf.ts `safeFetch`: the host is resolved, refused if ANY address is
//     internal (SSRF_ALLOW opens a range — PrivateLink needs it), and the socket
//     pinned to the address that was checked. No redirect is followed
//     (`redirect: 'error'`): a bearer token must never ride a hop elsewhere.
//   • a wall clock (the socket is destroyed, not merely abandoned) and the
//     caller's abort signal, whichever comes first;
//   • a byte ceiling on the wire AND on the decompressed body (gunzip with
//     `maxOutputLength`, so a decompression bomb stops at the ceiling — R9).
//
// Nothing here logs a URL, a header or a body.

import { gunzipSync } from 'node:zlib';
import { safeFetch } from './ssrf';

export interface SfHttpRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** Wall clock for this one request. */
  timeoutMs: number;
  /** Ceiling on the body, compressed and decompressed. */
  maxBytes: number;
  /** The caller giving up (a hung-up viewer). Destroys the socket. */
  signal?: AbortSignal;
}

export interface SfHttpResponse {
  status: number;
  /** UTF-8 text, decompressed. Partial when `truncated`. */
  body: string;
  /** True when the byte ceiling clipped the body. */
  truncated: boolean;
}

/** How the protocol reaches Snowflake. The self-check injects a fake one. */
export type SfTransport = (req: SfHttpRequest) => Promise<SfHttpResponse>;

export class SfAbortError extends Error {
  constructor(public readonly reason: 'timeout' | 'cancelled', ms: number) {
    super(reason === 'timeout' ? `Request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'The query was cancelled');
    this.name = 'SfAbortError';
  }
}

/** Read at most `max` bytes; past it the stream is cancelled and `clipped` set. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Buffer; clipped: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), clipped: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), clipped: false };
    const chunk = Buffer.from(value);
    if (total + chunk.length > max) {
      chunks.push(chunk.subarray(0, max - total));
      try { await reader.cancel(); } catch { /* already closed */ }
      return { bytes: Buffer.concat(chunks), clipped: true };
    }
    total += chunk.length;
    chunks.push(chunk);
  }
}

const isGzip = (b: Buffer): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** The real transport. Throws on a network failure or a refusal; SfAbortError on the clock or the signal. */
export async function snowflakeFetch(req: SfHttpRequest): Promise<SfHttpResponse> {
  const ms = Math.max(1, Math.floor(req.timeoutMs));
  const clock = AbortSignal.timeout(ms);
  const signal = req.signal ? AbortSignal.any([req.signal, clock]) : clock;
  const why = (): SfAbortError | null => (req.signal?.aborted ? new SfAbortError('cancelled', ms) : clock.aborted ? new SfAbortError('timeout', ms) : null);
  try {
    const res = await safeFetch(req.url, {
      method: req.method,
      headers: { 'user-agent': 'Ordinate', ...req.headers },
      body: req.body,
      redirect: 'error',
      signal,
    });
    const { bytes, clipped } = await readCapped(res, req.maxBytes);
    let body = bytes;
    let truncated = clipped;
    // Decided by the bytes, not the header: a body that starts with the gzip
    // magic is compressed whatever the header says, and JSON never does.
    if (isGzip(bytes)) {
      if (clipped) return { status: res.status, body: '', truncated: true };
      try {
        body = gunzipSync(bytes, { maxOutputLength: req.maxBytes });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') throw new Error('Snowflake sent a compressed body that would not decompress');
        return { status: res.status, body: '', truncated: true };
      }
      truncated = false;
    }
    return { status: res.status, body: body.toString('utf8'), truncated };
  } catch (e) {
    throw why() ?? e;
  }
}
