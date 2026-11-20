// A local stand-in for Slack, for the self-checks and the e2e (never the real Slack): the Web API methods Ordinate
// calls, Slack's OpenID Connect ("Sign in with Slack": discovery, authorize, token, keys, RS256 id_tokens) and an
// event sender that signs like Slack does. Point the server at it with ORDINATE_TEST_SLACK_BASE=<origin> (with
// SSRF_ALLOW covering 127.0.0.1: the SSRF guard still applies to every call).
//
// It records every call (`calls`) so a test can assert what was sent — and what was NOT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createSign, generateKeyPairSync, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { sign } from '../src/server/slack/signature';

export interface StubUser { id: string; team_id: string; is_stranger?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; is_bot?: boolean; deleted?: boolean }
export interface StubChannel { id: string; name?: string; is_im?: boolean; is_ext_shared?: boolean; is_private?: boolean; members?: string[] }
export interface Call { method: string; params: Record<string, any>; token: string | null } // any: Slack's params

export interface Stub {
  readonly origin: string;
  readonly calls: Call[];
  readonly users: Map<string, StubUser>;
  readonly channels: Map<string, StubChannel>;
  /** Channels `users.conversations` lists (the bot is in them). */
  botChannels: string[];
  readonly team: { id: string; name: string; botUser: string; botToken: string; appId: string };
  readonly oauth: { clientId: string; clientSecret: string; signInAs: { userId: string; teamId: string } };
  /** `members` page size, to exercise the cursor. */
  pageSize: number;
  /** The next N calls of this method answer 429 (Retry-After: 1). */
  rateLimit: { method: string; times: number };
  /** Extra claims the next id_token carries instead of the signed-in user's (a mismatch test). */
  idTokenOverride: Record<string, unknown> | null;
  callsOf(method: string): Call[];
  reset(): void;
  /** Delivers a payload to the server's Events route, signed (or not) the way Slack signs. */
  send(base: string, path: string, payload: unknown, o?: { secret?: string; ts?: number; form?: boolean; tamper?: boolean; headers?: Record<string, string> }): Promise<Response>;
  /** The URL the authorize endpoint last saw. */
  lastAuthorize: URLSearchParams | null;
  close(): Promise<void>;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startSlackStub(init: { team?: string; botToken?: string } = {}): Promise<Stub> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stub-key-1';
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { nonce: string; clientId: string; userId: string; teamId: string }>();
  let n = 0;
  let origin = '';
  const stub: Stub = {
    get origin() { return origin; },
    calls: [],
    users: new Map(),
    channels: new Map(),
    botChannels: [],
    team: { id: init.team ?? 'T001', name: 'Acme Slack', botUser: 'UBOT', botToken: init.botToken ?? 'xoxb-c4nary-b0t-t0ken-0001', appId: 'A001' },
    oauth: { clientId: 'client-001', clientSecret: 'c4nary-client-secret', signInAs: { userId: 'U1', teamId: init.team ?? 'T001' } },
    pageSize: 200,
    rateLimit: { method: '', times: 0 },
    idTokenOverride: null,
    lastAuthorize: null,
    callsOf: (m) => stub.calls.filter((c) => c.method === m),
    reset() {
      stub.calls.length = 0;
      stub.rateLimit = { method: '', times: 0 };
      stub.idTokenOverride = null;
    },
    async send(base, path, payload, o = {}) {
      const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
      const raw = o.form ? `payload=${encodeURIComponent(JSON.stringify(payload))}` : JSON.stringify(payload);
      const sig = sign(o.secret ?? 'c4nary-signing-secret', ts, raw);
      return fetch(base + path, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': o.tamper ? sig.slice(0, -2) + '00' : sig, ...(o.headers ?? {}) },
        body: raw,
      });
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };

  const idToken = (c: { nonce: string; clientId: string; userId: string; teamId: string }): string => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: origin, aud: c.clientId, sub: c.userId, iat: now, exp: now + 600, nonce: c.nonce, 'https://slack.com/user_id': c.userId, 'https://slack.com/team_id': c.teamId, ...(stub.idTokenOverride ?? {}),
    };
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const signing = `${head}.${b64u(JSON.stringify(claims))}`;
    return `${signing}.${b64u(createSign('RSA-SHA256').update(signing).sign(privateKey))}`;
  };

  const json = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(v));
  };

  async function web(method: string, params: Record<string, any>, token: string | null, res: ServerResponse): Promise<void> {
    stub.calls.push({ method, params, token });
    if (stub.rateLimit.method === method && stub.rateLimit.times > 0) {
      stub.rateLimit.times -= 1;
      return json(res, 429, { ok: false, error: 'ratelimited' }, { 'retry-after': '1' });
    }
    if (token !== stub.team.botToken) return json(res, 200, { ok: false, error: 'invalid_auth' });
    switch (method) {
      case 'auth.test': return json(res, 200, { ok: true, team_id: stub.team.id, team: stub.team.name, user_id: stub.team.botUser, bot_id: 'B001' });
      case 'bots.info': return json(res, 200, { ok: true, bot: { app_id: stub.team.appId } });
      case 'chat.postMessage': { n += 1; return json(res, 200, { ok: true, channel: params.channel, ts: `${1700000000 + n}.000100` }); }
      case 'chat.update': case 'chat.postEphemeral': return json(res, 200, { ok: true, channel: params.channel, ts: params.ts ?? '0.0' });
      case 'conversations.open': return json(res, 200, { ok: true, channel: { id: `D${String(params.users)}` } });
      case 'conversations.info': {
        const c = stub.channels.get(String(params.channel));
        if (!c) return json(res, 200, { ok: false, error: 'channel_not_found' });
        return json(res, 200, { ok: true, channel: { id: c.id, name: c.name ?? c.id, is_im: !!c.is_im, is_ext_shared: !!c.is_ext_shared, is_shared: !!c.is_ext_shared, is_private: !!c.is_private } });
      }
      case 'conversations.members': {
        const all = stub.channels.get(String(params.channel))?.members ?? [];
        const from = Number(params.cursor || 0);
        const page = all.slice(from, from + stub.pageSize);
        return json(res, 200, { ok: true, members: page, response_metadata: { next_cursor: from + stub.pageSize < all.length ? String(from + stub.pageSize) : '' } });
      }
      case 'users.info': {
        const u = stub.users.get(String(params.user));
        return u ? json(res, 200, { ok: true, user: u }) : json(res, 200, { ok: false, error: 'user_not_found' });
      }
      case 'users.conversations':
        return json(res, 200, { ok: true, channels: stub.botChannels.map((id) => ({ id, name: stub.channels.get(id)?.name ?? id, is_private: !!stub.channels.get(id)?.is_private })), response_metadata: { next_cursor: '' } });
      default: return json(res, 200, { ok: false, error: 'unknown_method' });
    }
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://x');
      const raw = req.method === 'POST' ? await body(req) : '';
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: origin, authorization_endpoint: `${origin}/openid/connect/authorize`, token_endpoint: `${origin}/api/openid.connect.token`, jwks_uri: `${origin}/openid/connect/keys`,
          response_types_supported: ['code'], response_modes_supported: ['form_post'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        });
      }
      if (url.pathname === '/openid/connect/keys') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/openid/connect/authorize') {
        stub.lastAuthorize = url.searchParams;
        const code = randomBytes(12).toString('hex');
        codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', clientId: url.searchParams.get('client_id') ?? '', userId: stub.oauth.signInAs.userId, teamId: stub.oauth.signInAs.teamId });
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.href });
        return void res.end();
      }
      if (url.pathname === '/api/openid.connect.token') {
        const f = new URLSearchParams(raw);
        const basic = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
        const secret = f.get('client_secret') ?? (basic ? Buffer.from(basic, 'base64').toString().split(':')[1] : '');
        const c = codes.get(f.get('code') ?? '');
        if (!c || secret !== stub.oauth.clientSecret) return json(res, 400, { ok: false, error: 'invalid_grant' });
        codes.delete(f.get('code') ?? '');
        return json(res, 200, { ok: true, access_token: 'xoxp-stub-user-token', token_type: 'Bearer', id_token: idToken(c) });
      }
      if (url.pathname.startsWith('/api/')) {
        const method = url.pathname.slice(5);
        const params = (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw || '{}') as Record<string, any>) : Object.fromEntries(new URLSearchParams(raw));
        return web(method, params, bearer, res);
      }
      res.writeHead(404);
      res.end();
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.users.set(stub.team.botUser, { id: stub.team.botUser, team_id: stub.team.id, is_bot: true });
  return stub;
}
