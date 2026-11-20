// Slack's four doors. The first three authorize THEMSELVES (like src/server/hooks/route.ts): no session, no cookie,
// CSRF-exempt (./../csrf.ts SELF_AUTH) — the signature or the one-time state row is the credential.
//
//   POST /api/slack/events        HMAC-SHA256 of `v0:<timestamp>:<raw body>` under the app's signing secret, in constant
//                                 time, a timestamp within 5 minutes. url_verification is answered after the check.
//   POST /api/slack/interactions  the same signature; button presses (Helpful / Not helpful, Share to channel).
//   GET|POST /api/slack/connect/callback
//                                 Slack's OpenID answer (`form_post` is a cross-site POST that carries no session
//                                 cookie). Authenticated only by the state row and the verified id_token (./linking.ts).
//   GET /api/slack/connect?s=     the NORMAL session gate: writes the signed-in user on the state row, then goes to Slack.
//
// The raw body is kept as a string: the HMAC is over exactly what Slack sent.

import type { FastifyInstance } from 'fastify';
import { ctx } from '../context';
import * as store from './db';
import { authorizeUrl, finishLink } from './linking';
import { handleEvent, handleInteraction, type Envelope } from './events';
import { verifySignature } from './signature';
import { CALLBACK_ROUTE, CONNECT_ROUTE, EVENTS_ROUTE, INTERACTIONS_ROUTE } from './paths';


const BODY_MAX = 512 * 1024;

/** Does `raw`, signed as `headers` say, verify under the signing secret of ANY install (a url_verification names no team)? */
async function anyInstallSigned(raw: string, ts: unknown, sig: unknown): Promise<boolean> {
  for (const i of await store.allInstalls()) {
    const secret = await store.getSecret(i.orgId, 'signingSecret');
    if (secret && verifySignature(secret, ts, sig, raw)) return true;
  }
  return false;
}

async function signedFor(teamId: string | undefined, raw: string, ts: unknown, sig: unknown): Promise<store.Install | null> {
  const inst = teamId ? await store.installByTeam(teamId) : null;
  const secret = inst && (await store.getSecret(inst.orgId, 'signingSecret'));
  return inst && secret && verifySignature(secret, ts, sig, raw) ? inst : null;
}

export function registerSlackRoutes(app: FastifyInstance, o: { pool: () => unknown }): void {
  void app.register(async (slack) => {
    slack.removeAllContentTypeParsers();
    slack.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_MAX }, (_req, body, done) => done(null, body));

    slack.post(EVENTS_ROUTE, { bodyLimit: BODY_MAX }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!o.pool()) return reply.code(404).send({ error: 'not available' });
      const raw = typeof req.body === 'string' ? req.body : '';
      const ts = req.headers['x-slack-request-timestamp'];
      const sig = req.headers['x-slack-signature'];
      let env: Envelope;
      try {
        env = JSON.parse(raw) as Envelope;
      } catch {
        return reply.code(400).send({ error: 'bad body' });
      }
      if (env.type === 'url_verification') {
        if (!(await anyInstallSigned(raw, ts, sig)) || typeof env.challenge !== 'string') return reply.code(401).send({ error: 'bad signature' });
        return reply.send({ challenge: env.challenge });
      }
      // An unknown team has no secret to check against: acknowledged and dropped, so Slack stops retrying.
      if (!env.team_id || !(await store.installByTeam(env.team_id))) return reply.send({});
      if (!(await signedFor(env.team_id, raw, ts, sig))) return reply.code(401).send({ error: 'bad signature' });
      await handleEvent(env);
      return reply.send({});
    });

    slack.post(INTERACTIONS_ROUTE, { bodyLimit: BODY_MAX }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!o.pool()) return reply.code(404).send({ error: 'not available' });
      const raw = typeof req.body === 'string' ? req.body : '';
      let payload: { team?: { id?: string } } = {};
      try {
        payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '') as typeof payload;
      } catch {
        return reply.code(400).send({ error: 'bad body' });
      }
      if (!(await signedFor(payload.team?.id, raw, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature']))) {
        return reply.code(401).send({ error: 'bad signature' });
      }
      await handleInteraction(payload as Parameters<typeof handleInteraction>[0]);
      return reply.send({});
    });

    // GET: Slack's query-string answer. POST: `form_post`. Neither reads a cookie.
    const callback = async (params: Record<string, unknown>, reply: import('fastify').FastifyReply) => {
      reply.header('cache-control', 'no-store');
      if (!o.pool()) return reply.code(404).send({ error: 'not available' });
      const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
      const r = await finishLink({ code: str('code'), state: str('state'), error: str('error') });
      return reply.redirect(`/settings?slack=${r.ok ? 'linked' : r.reason}`);
    };
    slack.get(CALLBACK_ROUTE, async (req, reply) => callback((req.query ?? {}) as Record<string, unknown>, reply));
    slack.post(CALLBACK_ROUTE, { bodyLimit: BODY_MAX }, async (req, reply) =>
      callback(Object.fromEntries(new URLSearchParams(typeof req.body === 'string' ? req.body : '')), reply));

    // The one with a session (app.ts's gate has run: ctx() is the signed-in member).
    slack.get<{ Querystring: { s?: string } }>(CONNECT_ROUTE, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!o.pool()) return reply.code(404).send({ error: 'not available' });
      const { org, user } = ctx();
      const url = typeof req.query.s === 'string' && req.query.s.length < 200 ? await authorizeUrl(req.query.s, org.id, user.email) : null;
      return url ? reply.redirect(url) : reply.redirect('/settings?slack=state');
    });
  });
}
