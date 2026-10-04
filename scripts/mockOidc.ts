// A mock OpenID Connect provider for the sign-in tests (T3.2): node:http and
// stdlib crypto only — no mock-provider package. Enough of the spec that
// openid-client talks to it unmodified:
//
//   GET  /.well-known/openid-configuration   discovery
//   GET  /jwks                               the RS256 public key
//   GET  /authorize                          a sign-in page (email + Sign in / Deny)
//   POST /authorize                          → 302 to redirect_uri with ?code&state (or error=access_denied)
//   POST /token                              code → id_token (RS256), checking client secret and PKCE S256
//
// `issued` records every code and token it hands out, so a test can assert
// none of them ever reaches a server log line.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface MockOidcOptions {
  clientId: string;
  clientSecret: string;
}

export interface MockOidc {
  readonly issuer: string;
  /** Every code, access token and id_token issued. */
  readonly issued: string[];
  /** Claims merged into every id_token from now on (tests flip email_verified etc.). */
  extraClaims: Record<string, unknown>;
  /** Answers an /authorize URL without a browser: the redirect back, with ?code&state (or error=access_denied). */
  approve(authorizeUrl: string, email: string, decision?: 'allow' | 'deny'): Promise<string>;
  close(): Promise<void>;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | undefined;
  email: string;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(params: URLSearchParams): string {
  const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock IdP</title><link rel="icon" href="data:,"></head><body>
<h1>Mock identity provider</h1>
<form method="post" action="/authorize">${hidden}
<label>Email <input name="email" type="email" autocomplete="off"></label>
<button name="decision" value="allow">Sign in</button>
<button name="decision" value="deny">Deny</button>
</form></body></html>`;
}

async function body(req: http.IncomingMessage): Promise<URLSearchParams> {
  let s = '';
  for await (const c of req) s += String(c);
  return new URLSearchParams(s);
}

export async function startMockOidc(opts: MockOidcOptions): Promise<MockOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = b64u(randomBytes(8));
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const issued: string[] = [];
  let issuer = '';

  const jwt = (claims: Record<string, unknown>): string => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = b64u(JSON.stringify(claims));
    return `${head}.${payload}.${b64u(sign('sha256', Buffer.from(`${head}.${payload}`), privateKey))}`;
  };

  const redirect = (res: http.ServerResponse, to: string): void => {
    res.writeHead(302, { location: to }).end();
  };
  const json = (res: http.ServerResponse, status: number, o: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(o));
  };

  /** Validates an authorize request; returns the error to show, or null. */
  const badAuthorize = (p: URLSearchParams): string | null => {
    if (p.get('client_id') !== opts.clientId) return 'unknown client_id';
    if (p.get('response_type') !== 'code') return 'response_type must be code';
    if (!p.get('redirect_uri')) return 'redirect_uri missing';
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return 'PKCE S256 required';
    if (!(p.get('scope') ?? '').split(' ').includes('openid')) return 'scope must include openid';
    return null;
  };

  const decide = (p: URLSearchParams): string => {
    const to = new URL(p.get('redirect_uri') as string);
    const state = p.get('state');
    if (state) to.searchParams.set('state', state);
    const email = (p.get('email') ?? '').trim();
    if (p.get('decision') === 'deny' || !email) {
      to.searchParams.set('error', 'access_denied');
      return to.href;
    }
    const code = b64u(randomBytes(24));
    issued.push(code);
    grants.set(code, {
      clientId: p.get('client_id') as string,
      redirectUri: p.get('redirect_uri') as string,
      challenge: p.get('code_challenge') as string,
      nonce: p.get('nonce') ?? undefined,
      email,
    });
    to.searchParams.set('code', code);
    return to.href;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const p = req.method === 'POST' ? await body(req) : url.searchParams;
        const bad = badAuthorize(p);
        if (bad) return void res.writeHead(400, { 'content-type': 'text/plain' }).end(bad);
        if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'text/html' }).end(page(p));
        return redirect(res, decide(p));
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const p = await body(req);
        let id = p.get('client_id');
        let secret = p.get('client_secret');
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        if (basic) {
          const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':');
          [id, secret] = [decodeURIComponent(u), decodeURIComponent(s ?? '')];
        }
        if (id !== opts.clientId || secret !== opts.clientSecret) return json(res, 401, { error: 'invalid_client' });
        const code = p.get('code') ?? '';
        const g = grants.get(code);
        grants.delete(code); // single use
        if (!g || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== g.redirectUri || g.clientId !== id) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const verifier = p.get('code_verifier') ?? '';
        if (b64u(createHash('sha256').update(verifier).digest()) !== g.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        const now = Math.floor(Date.now() / 1000);
        const idToken = jwt({
          iss: issuer,
          sub: createHash('sha256').update(g.email).digest('hex').slice(0, 24),
          aud: opts.clientId,
          iat: now,
          exp: now + 300,
          ...(g.nonce ? { nonce: g.nonce } : {}),
          email: g.email,
          email_verified: true,
          ...mock.extraClaims,
        });
        const access = b64u(randomBytes(24));
        issued.push(access, idToken);
        return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mock: MockOidc = {
    issuer,
    issued,
    extraClaims: {},
    async approve(authorizeUrl, email, decision = 'allow') {
      const p = new URL(authorizeUrl).searchParams;
      const bad = badAuthorize(p);
      if (bad) throw new Error(`mock IdP refused the authorize request: ${bad}`);
      p.set('email', email);
      p.set('decision', decision);
      return decide(p);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return mock;
}
