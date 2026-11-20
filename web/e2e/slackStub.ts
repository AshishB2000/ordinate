// A local stand-in for Slack for the e2e (never the real Slack): the Web API methods Ordinate calls on setup, linking and a
// first answer, Slack's OpenID Connect (discovery, authorize, token, keys, RS256 id_tokens), and a sender that signs events the
// way Slack does. The server reaches it through ORDINATE_TEST_SLACK_BASE (and SSRF_ALLOW for loopback). It records the calls.
// The self-check suites use scripts/slackStub.ts, which also plays Socket Mode; this one has no import from src/.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

export const BOT_TOKEN = 'xoxb-e2e-0000000000-bot-token';
export const SIGNING = 'e2e-signing-secret';
export const CLIENT_ID = 'e2e-client-id';
export const CLIENT_SECRET = 'e2e-client-secret';
export const TEAM = 'T0E2E';
export const BOT = 'UBOT00E2E';

export interface Call { method: string; params: Record<string, any> } // any: Slack's params
export interface SlackStub {
  origin: string;
  calls: Call[];
  /** Who "Sign in with Slack" signs in. */
  signInAs: string;
  /** Channels the bot is in, for the picker. */
  channels: Array<{ id: string; name: string }>;
  send(base: string, payload: unknown): Promise<Response>;
  close(): Promise<void>;
}

export async function startSlackStub(): Promise<SlackStub> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'e2e', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { nonce: string; user: string }>();
  let origin = '';
  let n = 0;
  const stub: SlackStub = {
    get origin() { return origin; },
    calls: [],
    signInAs: 'UADMIN00E2E',
    channels: [{ id: 'C0SALES', name: 'sales' }, { id: 'C0OPS', name: 'ops' }],
    async send(base, payload) {
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = 'v0=' + createHmac('sha256', SIGNING).update(`v0:${ts}:${raw}`).digest('hex');
      return fetch(`${base}/api/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: raw });
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
  const json = (res: http.ServerResponse, v: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://x');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, { issuer: origin, authorization_endpoint: `${origin}/openid/connect/authorize`, token_endpoint: `${origin}/api/openid.connect.token`, jwks_uri: `${origin}/openid/connect/keys`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] });
      }
      if (url.pathname === '/openid/connect/keys') return json(res, { keys: [jwk] });
      if (url.pathname === '/openid/connect/authorize') {
        const code = randomBytes(12).toString('hex');
        codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', user: stub.signInAs });
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.href });
        return void res.end();
      }
      if (url.pathname === '/api/openid.connect.token') {
        const f = new URLSearchParams(raw);
        const c = codes.get(f.get('code') ?? '');
        if (!c || (f.get('client_secret') ?? '') !== CLIENT_SECRET) return json(res, { ok: false, error: 'invalid_grant' }, 400);
        codes.delete(f.get('code') ?? '');
        const now = Math.floor(Date.now() / 1000);
        const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'e2e' }));
        const body = b64u(JSON.stringify({ iss: origin, aud: CLIENT_ID, sub: c.user, iat: now, exp: now + 600, nonce: c.nonce, 'https://slack.com/user_id': c.user, 'https://slack.com/team_id': TEAM }));
        const sig = b64u(createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey));
        return json(res, { ok: true, access_token: 'xoxp-e2e', token_type: 'Bearer', id_token: `${head}.${body}.${sig}` });
      }
      if (url.pathname.startsWith('/api/')) {
        const method = url.pathname.slice(5);
        const params = (req.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw || '{}') as Record<string, any>) : Object.fromEntries(new URLSearchParams(raw)); // any: Slack's params
        stub.calls.push({ method, params });
        if (bearer !== BOT_TOKEN) return json(res, { ok: false, error: 'invalid_auth' });
        switch (method) {
          case 'auth.test': return json(res, { ok: true, team_id: TEAM, team: 'Acme E2E', user_id: BOT, bot_id: 'B0E2E' });
          case 'bots.info': return json(res, { ok: true, bot: { app_id: 'A0E2E' } });
          case 'users.info': return json(res, { ok: true, user: { id: params.user, team_id: TEAM } });
          case 'chat.postMessage': n += 1; return json(res, { ok: true, channel: params.channel, ts: `${1800000000 + n}.000100` });
          case 'chat.update': case 'chat.postEphemeral': return json(res, { ok: true, channel: params.channel, ts: params.ts ?? '0.0' });
          case 'users.conversations': return json(res, { ok: true, channels: stub.channels.map((c) => ({ ...c, is_private: false })), response_metadata: { next_cursor: '' } });
          default: return json(res, { ok: false, error: 'unknown_method' });
        }
      }
      res.writeHead(404);
      res.end();
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
