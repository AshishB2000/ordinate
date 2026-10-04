// SSRF guard (T6.1) — MAIN PROCESS ONLY.
//
// On the server, a connection's host, a URL source and an AI gateway's base URL
// are typed by a user, and the pod that opens the socket sits inside the
// operator's network: next to the cloud metadata service, the Postgres that
// holds every org's records, and whatever else the VPC reaches. So every
// socket opened from user input goes through `checkHost`, which RESOLVES the
// name and refuses it when ANY address it resolves to is internal, and the
// socket is then opened to exactly the address that was checked (`pinnedLookup`,
// or the IP handed to a DB driver) — a DNS answer that changes between the check
// and the connect (rebinding) never reaches the network. `safeFetch` is fetch
// over that, re-checking every redirect hop.
//
// The desktop is local-first — connecting to localhost IS the use case — so
// callers apply the guard only when `guardOn()` (server mode); the desktop keeps
// its exact behaviour.
//
// An operator opens a range with SSRF_ALLOW (CIDRs, comma-separated, e.g. an
// internal warehouse "10.20.0.0/16"); an allowed address skips the refusal list.
//
// Node's own `dns`/`net`/`http(s)` only — no dependency.

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { BlockList, isIP, type LookupFunction } from 'net';
import { Readable } from 'stream';
import { proxyList } from '../server/env';
import { serverDataDir } from '../server/context';

/** The guard applies on the server only (see the header). */
export function guardOn(): boolean {
  return serverDataDir() !== null;
}

/**
 * The refused ranges, each named in the refusal so a user learns why. Order
 * matters only for the name shown when ranges nest.
 */
const REFUSED: ReadonlyArray<readonly [why: string, cidrs: readonly string[]]> = [
  // 127/8 and ::1 — the pod itself: its admin ports, sidecars, the server's own API.
  ['loopback', ['127.0.0.0/8', '::1/128']],
  // 169.254/16 and fe80::/10 — includes the cloud metadata service at
  // 169.254.169.254 (AWS/GCP/Azure/OCI credentials for the pod's role).
  ['link-local (cloud metadata)', ['169.254.0.0/16', 'fe80::/10']],
  // 0/8 "this network": 0.0.0.0 connects to the local host on Linux and macOS. :: likewise.
  ['unspecified', ['0.0.0.0/8', '::/128']],
  // RFC 1918 — the operator's VPC: databases, Kubernetes services, other pods.
  ['private network', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']],
  // RFC 6598 shared address space — carrier/cluster NAT; Alibaba's metadata is 100.100.100.200.
  ['carrier-grade NAT', ['100.64.0.0/10']],
  // IPv6 unique-local (fc00::/7) — the IPv6 private range; AWS's IPv6 metadata is fd00:ec2::254.
  ['unique-local IPv6', ['fc00::/7']],
  // fec0::/10 — deprecated site-local, still routed by some stacks.
  ['site-local IPv6', ['fec0::/10']],
  // IPv6 forms that EMBED an IPv4 address and can carry a refused one through a
  // v4-only list: v4-mapped ::ffff:0:0/96 ([::ffff:127.0.0.1]), v4-compatible
  // ::/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16, Teredo
  // 2001::/32. Refused whole — no public service needs to be named this way.
  ['IPv4 embedded in IPv6', ['::ffff:0:0/96', '::/96', '64:ff9b::/96', '64:ff9b:1::/48', '2002::/16', '2001::/32']],
  // 192.0.0/24 IETF protocol assignments, 198.18/15 benchmarking, the
  // documentation nets, 6to4 relay anycast, 100::/64 discard — never a real
  // server on the internet, sometimes internal plumbing.
  ['reserved', [
    '192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '192.88.99.0/24',
    '100::/64', '2001:db8::/32', '2001:10::/28',
  ]],
  // 224/4 multicast and 240/4 reserved (incl. 255.255.255.255 broadcast); ff00::/8.
  ['multicast or broadcast', ['224.0.0.0/4', '240.0.0.0/4', 'ff00::/8']],
];

// One list per family: a BlockList matches an IPv4 address against IPv6 rules
// through its mapped form, so `::/96` in a shared list would refuse ALL of IPv4.
const split = (sep: '.' | ':'): ReadonlyArray<readonly [string, BlockList]> =>
  REFUSED.map(([why, cidrs]) => [why, proxyList(cidrs.filter((c) => c.includes(sep)), why)] as const);
const REFUSED_V4 = split('.');
const REFUSED_V6 = split(':');

let allowRaw: string | undefined;
let allowList = new BlockList();

/** SSRF_ALLOW as a BlockList, re-read when the variable changes (env.ts validated it at startup). */
function allowed(): BlockList {
  const raw = process.env.SSRF_ALLOW;
  if (raw !== allowRaw) {
    allowList = proxyList((raw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), 'SSRF_ALLOW');
    allowRaw = raw;
  }
  return allowList;
}

/** Why `address` is refused, or null when it may be connected to. */
export function refusedRange(address: string): string | null {
  const family = isIP(address);
  if (family === 0) return 'not an IP address';
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (allowed().check(address, type)) return null;
  for (const [why, list] of family === 6 ? REFUSED_V6 : REFUSED_V4) if (list.check(address, type)) return why;
  return null;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** A checked host and the one address every socket for it connects to. */
export interface PinnedHost {
  /** The host as typed (canonicalized: lower case, legacy IPv4 forms decoded, no brackets). */
  readonly host: string;
  readonly address: string;
  readonly family: 4 | 6;
}

const HINT = 'This server does not connect to internal addresses; an administrator can allow a range with SSRF_ALLOW.';

/**
 * Resolve `raw` and refuse it if ANY address is internal; otherwise the first
 * address, to pin. The host is canonicalized by the WHATWG URL parser first, so
 * decimal/octal/hex IPv4 (`2130706433`, `0177.0.0.1`, `0x7f.1`) mean the same
 * here on every OS — macOS's resolver reads `0177.0.0.1` as 177.0.0.1, glibc's
 * as 127.0.0.1. Anything that is not a bare host (a port, a path, credentials,
 * a socket path) is refused rather than guessed at.
 */
export async function checkHost(raw: string): Promise<PinnedHost> {
  const typed = String(raw ?? '').trim();
  const bare = typed.replace(/^\[(.*)\]$/, '$1');
  let host = '';
  try {
    const u = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}/`);
    if (!u.port && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash) host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    // falls through to the refusal below
  }
  if (!host) throw new SsrfError(`Refused: ${JSON.stringify(typed.slice(0, 100))} is not a host name or IP address.`);

  let addrs: { address: string; family: number }[];
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new SsrfError(`Could not resolve ${host}.`);
    }
  }
  if (addrs.length === 0) throw new SsrfError(`Could not resolve ${host}.`);
  for (const a of addrs) {
    const why = refusedRange(a.address);
    if (why) {
      const shown = a.address === host ? host : `${host} (${a.address})`;
      throw new SsrfError(`Refused: ${shown} is an internal address (${why}). ${HINT}`);
    }
  }
  return Object.freeze({ host, address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 });
}

/**
 * A `lookup` for net/http/tls that answers with the pinned address only — the
 * socket connects to what `checkHost` approved, whatever DNS says now. (Node
 * skips `lookup` for an IP literal, which `checkHost` already checked.)
 */
export function pinnedLookup(pin: PinnedHost): LookupFunction {
  return (_hostname, options, callback) => {
    const cb = callback as (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void;
    if ((options as dns.LookupOptions).all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

// ── safeFetch ────────────────────────────────────────────────────────────────

/** Redirects followed before giving up; each hop is checked like the first. */
export const MAX_REDIRECTS = 5;

/** Headers kept on a redirect to ANOTHER origin — nothing that could carry a credential. */
const CROSS_ORIGIN_KEEP = new Set(['accept', 'accept-language', 'user-agent']);

function bodyOf(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  throw new TypeError('safeFetch sends a string or bytes body only');
}

function send(
  url: URL, method: string, headers: Headers, body: string | Uint8Array | undefined, pin: PinnedHost, signal?: AbortSignal | null,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // agent:false — a pooled socket is keyed by host:port, not by the address
    // it was pinned to; one socket per request keeps "checked = connected" simple.
    const req = mod.request(url, {
      method,
      headers: Object.fromEntries(headers),
      lookup: pinnedLookup(pin),
      agent: false,
      signal: signal ?? undefined,
    });
    req.once('response', resolve);
    req.once('error', reject);
    req.end(body);
  });
}

function toResponse(res: http.IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, x);
  }
  const status = res.statusCode ?? 0;
  const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  if (empty) res.resume();
  // ponytail: no Content-Encoding decoding — we never send Accept-Encoding, so a
  // compliant server answers identity. Add zlib here if a provider ignores that.
  const stream = empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
  return new Response(stream, { status, statusText: res.statusMessage, headers });
}

/**
 * `fetch` for a user-supplied URL: http(s) only, the host checked and pinned
 * (`checkHost`), redirects followed up to MAX_REDIRECTS with every hop checked
 * again, credentials dropped on a hop to another origin. `redirect: 'manual'`
 * hands a 3xx back (the SaaS transport re-checks hops itself); `'error'` throws.
 * Throws SsrfError on a refusal, as fetch throws on a network error.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = new URL(String(input));
  let method = (init.method || 'GET').toUpperCase();
  let body = bodyOf(init.body);
  let headers = new Headers(init.headers);
  const mode = init.redirect || 'follow';
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError(`Refused: only http and https URLs are fetched, not ${url.protocol}`);
    if (url.username || url.password) throw new SsrfError('Refused: credentials in a URL are not sent.');
    const pin = await checkHost(url.hostname);
    const res = await send(url, method, headers, body, pin, init.signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (mode === 'manual' || status < 300 || status >= 400 || !location) return toResponse(res, method);

    res.destroy();
    if (mode === 'error') throw new SsrfError(`Refused: the server redirected (HTTP ${status}).`);
    if (hop >= MAX_REDIRECTS) throw new SsrfError(`Refused: more than ${MAX_REDIRECTS} redirects.`);
    const next = new URL(location, url);
    if (next.origin !== url.origin) {
      const kept = new Headers();
      headers.forEach((v, k) => { if (CROSS_ORIGIN_KEEP.has(k)) kept.set(k, v); });
      headers = kept;
    }
    // fetch's rule: 303, and 301/302 after a POST, continue as a body-less GET.
    if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    url = next;
  }
}
