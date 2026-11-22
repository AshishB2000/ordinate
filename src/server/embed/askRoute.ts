// POST /embed/ask — a customer's question to an embedded Assistant (docs/embedded-assistant/00-design.md).
// The signed token in the BODY (never a URL, so no access log holds it) is the whole credential: no cookie, no sign-in.
// In this order: the header's shape, the org's secret and the MAC (one bare refusal for every failure, so no probe
// tells an unknown org, a bad MAC and an unmarked agent apart), embedding on for the org, the claims, the agent's marking,
// the asker (a token that does not lock every required column is refused), then the ask as that asker. From the MAC on,
// every outcome writes one audit row: the customer's id, the agent, the outcome — never the question or the answer.

import { createHash, randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { runInContext } from '../context';
import { embedAsk, MAX_QUESTION } from '../../ipc/embedAsk';
import { readHeader } from './token';
import { verifyAskToken } from './askToken';
import { readSettings, secretOf } from './settings';
import * as counters from '../counters';
import { getCaps, getEmbedAgent, recordAsk, type AskOutcome } from './assistants';
import { buildAsker } from './asker';
import { embedAskFailed, embedAskLimited, embedAskUnavailable } from '../embedAskMessages';

export const EMBED_ASK_ROUTE = '/embed/ask';
let askTimeoutMs = 120_000;

/** Test seam (scripts/test-embedAskRoute): the time limit, in ms; no argument restores it. */
export function setAskTimeoutForTest(ms = 120_000): void {
  askTimeoutMs = ms;
}

export function registerEmbedAskRoute(app: FastifyInstance): void {
  app.post<{ Body: unknown }>(EMBED_ASK_ROUTE, { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    reply.removeHeader('set-cookie');
    const refuse = (code: number, error: string) => reply.code(code).send({ ok: false, error });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const token = body.token;
    const head = readHeader(token);
    if (!head || typeof token !== 'string') return refuse(403, embedAskUnavailable());
    const { org } = head;
    let secret: string | null;
    let on: boolean;
    try {
      secret = await secretOf(org);
      on = (await readSettings(org)).enabled;
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask: settings could not be read');
      return refuse(503, embedAskFailed());
    }
    if (!secret) return refuse(403, embedAskUnavailable());
    const v = verifyAskToken(token, secret, Math.floor(Date.now() / 1000));
    if (!v.ok && (v.reason === 'bad' || v.reason === 'signature')) return refuse(403, embedAskUnavailable());
    // The signature held: the org is known, every outcome below is audited.
    const id = randomUUID();
    const claims = v.ok ? v.claims : null;
    const record = async (outcome: AskOutcome, agentId: string | null) => {
      try {
        await recordAsk(org, { id, agentId, customer: claims?.sub ?? '', outcome });
      } catch (err) {
        req.log.error({ err: (err as Error).name }, 'embed ask: audit write failed');
      }
    };
    if (!claims || !on) {
      await record('denied', claims?.agent ?? null);
      return refuse(403, embedAskUnavailable());
    }
    let marking;
    try {
      marking = await getEmbedAgent(org, claims.agent);
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask: marking could not be read');
      await record('error', claims.agent);
      return refuse(503, embedAskFailed());
    }
    const asker = marking ? buildAsker(org, claims, marking) : null;
    if (!asker || !asker.ok) {
      await record('denied', claims.agent);
      return refuse(403, embedAskUnavailable());
    }
    // Q4: the caps, across pods. Per customer per minute (the customer's id is hashed: a key is stored) and per org per day; both or neither is charged.
    try {
      const caps = await getCaps(org);
      const who = createHash('sha256').update(claims.agent + '\u0000' + claims.sub).digest('hex').slice(0, 24);
      const taken = await counters.take(org, [
        { key: 'embed-ask-customer:' + who, limit: caps.perMinute, windowMs: 60_000 },
        { key: 'embed-ask-day', limit: caps.daily, windowMs: 24 * 60 * 60_000 },
      ]);
      if (!taken.ok) {
        await record('limited', claims.agent);
        reply.header('retry-after', taken.retryAfterSec);
        return refuse(429, embedAskLimited());
      }
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask: the caps could not be checked');
      await record('error', claims.agent);
      return refuse(503, embedAskFailed());
    }
    const question = typeof body.question === 'string' ? body.question.slice(0, MAX_QUESTION * 2) : '';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('embed ask time limit')), askTimeoutMs);
    try {
      const res = await runInContext(asker.identity, id, () => embedAsk(question, body.history, ac.signal), undefined, ac.signal);
      await record(res.ok ? 'ok' : res.kind === 'blank' ? 'refused' : 'error', claims.agent);
      return reply.code(res.ok ? 200 : res.kind === 'blank' ? 400 : 200).send(res);
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask: failed');
      await record('error', claims.agent);
      return refuse(500, embedAskFailed());
    } finally {
      clearTimeout(timer);
    }
  });
}
