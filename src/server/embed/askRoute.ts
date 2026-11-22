// POST /embed/ask — a customer's question to an embedded Assistant (docs/embedded-assistant/00-design.md).
// The signed token in the BODY (never a URL, so no access log holds it) is the whole credential: no cookie, no sign-in.
// In this order: the header's shape, the org's secret and the MAC (one bare refusal for every failure, so no probe
// tells an unknown org, a bad MAC and an unmarked agent apart), embedding on for the org, the claims, the agent's marking,
// the asker (a token that does not lock every required column is refused), then the ask as that asker. From the MAC on,
// every outcome writes one audit row: the customer's id, the agent, the outcome — never the question or the answer.

import { createHash, randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { FastifyInstance } from 'fastify';
import { runInContext } from '../context';
import { embedAsk, MAX_QUESTION } from '../../ipc/embedAsk';
import { readHeader } from './token';
import { verifyAskToken } from './askToken';
import { readSettings, secretOf } from './settings';
import * as counters from '../counters';
import { getCaps, getEmbedAgent, recordAsk, type AskOutcome } from './assistants';
import { buildAsker } from './asker';
import { refusalCsp, refusalHtml } from './pages';
import { ASK_MAX_TTL_SEC } from './askToken';
import { WEB_DIST } from '../static';
import { embedExpired, embedInvalid, embedOrigin, embedTooLong } from '../embedMessages';
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

/** The page's own CSP: its script and style are files of this server, it talks to this server only, and only the org's sites may frame it. */
export function askPageCsp(ancestors: readonly string[]): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`;
}

/**
 * GET /embed/ask/<token> — the Assistant's page inside the host's iframe (phase 3). The token is checked here the way the ask checks
 * it (header shape, MAC, claims, embedding on, the agent's marking, the asker), so a bad link shows its sentence instead of a
 * composer that fails on the first question; the page then reads the token from its own URL and sends it in the body of POST /embed/ask.
 * Framable by the org's listed origins only (frame-ancestors), never by anyone before the MAC held; no referrer leaves it.
 */
let pageDir = WEB_DIST;

/** Test seam (scripts/test-embedAskRoute): where embed-ask.html is read from; no argument restores the built app's. */
export function setAskPageDirForTest(dir: string = WEB_DIST): void {
  pageDir = dir;
}

export function registerEmbedAskPage(app: FastifyInstance): void {
  app.get<{ Params: { '*': string } }>(`${EMBED_ASK_ROUTE}/*`, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').header('referrer-policy', 'no-referrer');
    reply.removeHeader('set-cookie');
    const refuse = (code: number, message: string, ancestors: readonly string[]) => {
      reply.removeHeader('x-frame-options');
      if (!ancestors.length) reply.header('x-frame-options', 'DENY');
      return reply.code(code).header('content-security-policy', refusalCsp(ancestors)).type('text/html; charset=utf-8').send(refusalHtml(message));
    };
    const token = req.params['*'];
    const head = readHeader(token);
    if (!head) return refuse(403, embedInvalid(), []);
    const { org } = head;
    let secret: string | null;
    let settings: Awaited<ReturnType<typeof readSettings>>;
    try {
      secret = await secretOf(org);
      settings = await readSettings(org);
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask page: settings could not be read');
      return refuse(503, embedAskFailed(), []);
    }
    if (!secret) return refuse(403, embedInvalid(), []);
    const v = verifyAskToken(token, secret, Math.floor(Date.now() / 1000));
    if (!v.ok && (v.reason === 'bad' || v.reason === 'signature')) return refuse(403, embedInvalid(), []);
    const ancestors = settings.enabled ? settings.origins : [];
    if (!v.ok) return refuse(403, v.reason === 'expired' ? embedExpired() : v.reason === 'exp_too_far' ? embedTooLong(ASK_MAX_TTL_SEC / 3600) : embedInvalid(), ancestors);
    if (!settings.enabled) return refuse(403, embedAskUnavailable(), []);
    // Defence in depth beside frame-ancestors: a Referer, when the host sends one, is this server or an allowed site.
    const ref = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    if (ref) {
      let from: URL | null = null;
      try { from = new URL(ref); } catch { from = null; }
      if (!from || !(from.host === req.headers.host || settings.origins.includes(from.origin))) return refuse(403, embedOrigin(), ancestors);
    }
    let marking;
    try {
      marking = await getEmbedAgent(org, v.claims.agent);
    } catch (err) {
      req.log.error({ err: (err as Error).name }, 'embed ask page: marking could not be read');
      return refuse(503, embedAskFailed(), ancestors);
    }
    const asker = marking ? buildAsker(org, v.claims, marking) : null;
    if (!asker || !asker.ok) return refuse(403, embedAskUnavailable(), ancestors);
    let html: string;
    try {
      html = await fsp.readFile(path.join(pageDir, 'embed-ask.html'), 'utf8');
    } catch {
      return refuse(503, embedAskFailed(), ancestors); // the web app is not built
    }
    reply.removeHeader('x-frame-options');
    return reply.header('content-security-policy', askPageCsp(ancestors)).type('text/html; charset=utf-8').send(html);
  });
}
