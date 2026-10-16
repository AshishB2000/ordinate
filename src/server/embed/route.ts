// GET /embed/<token> — a published dashboard inside another site's iframe
// (docs/embed/00-design.md, threat model R16).
//
// The token is the whole credential: no cookie is read or set (a third-party
// iframe has none), no sign-in is looked up. In this order:
//
//   1. the header's shape (./token.ts readHeader): HS256 and an org id, or a
//      bare refusal NOBODY may frame — we cannot even trust which org it names;
//   2. that org's secret (the secrets store) and the MAC, compared in constant
//      time; no secret, or a bad MAC → the same bare refusal;
//   3. from here the org is known: the per-token and per-org rate limits, an
//      audit row for every outcome, and refusals the org's own sites may frame
//      (the host should see "expired", not a blank box);
//   4. the claims (unknown claim, empty or widened lock, exp > 24 h → refused),
//      embedding on for the org (or a server-signed preview token, served only
//      to a same-origin iframe), the Referer, when there is one, from an
//      allowed site or this one;
//   5. the published link in that org, the dashboard in the link, the project
//      not deleted — then the page (src/publish/embedPage.ts), built under the
//      locked filters as a published page's request (the Live cache floor).
//
// The page's header CSP is its own pinned policy plus `frame-ancestors <the
// org's origins>`, and no X-Frame-Options: the ONE route that may be framed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { runAsPublished, type Identity } from '../context';
import { audit, type Outcome } from '../authz/audit';
import { pageCsp } from '../published';
import { readSettings, secretOf } from './settings';
import { readHeader, tokenFingerprint, verifyToken, MAX_TTL_SEC, type TokenRefusal } from './token';
import { refusalCsp, refusalHtml } from './pages';
import {
  embedExpired, embedFailed, embedInvalid, embedNotFound, embedOrigin, embedPreviewOnly, embedRateLimited, embedRepublish, embedTooLong, embedUnavailable,
} from '../embedMessages';

// A wildcard, not `:token`: a token is longer than Fastify's 100-character parameter cap (readHeader bounds it).
export const EMBED_ROUTE = '/embed/*';
const MINUTE = 60_000;
const SELF = "'self'";

/** The request log's URL with an embed token masked — a token is a credential while it lives. */
export function maskEmbedUrl(url: string): string {
  return url.replace(/^(\/embed\/)[^/?#]+/, '$1[redacted]');
}

/** Any embed token inside a log message (Fastify's own "Route GET:/embed/… not found"). */
export function maskEmbedTokens(s: string): string {
  return s.replace(/\/embed\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '/embed/[redacted]');
}

export interface EmbedRouteOptions {
  readonly pool: () => Pool | null;
  /** RATE_LIMIT_EMBED_PER_MINUTE: views per token. */
  readonly tokenPerMinute: number;
  /** RATE_LIMIT_EMBED_ORG_PER_MINUTE: views per org, every token. */
  readonly orgPerMinute: number;
}

const anonymous = (org: string): Identity => ({ user: { email: 'embed', role: 'viewer' }, org: { id: org } });

const CLAIM_SENTENCE: Record<Exclude<TokenRefusal, 'bad' | 'signature'>, () => string> = {
  expired: embedExpired,
  exp_too_far: () => embedTooLong(MAX_TTL_SEC / 3600),
  claims: embedInvalid,
};

type Limiter = (req: FastifyRequest) => Promise<{ isAllowed: true } | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number }>;

export function registerEmbedRoutes(app: FastifyInstance, opts: EmbedRouteOptions): void {
  const keys = new WeakMap<FastifyRequest, { token: string; org: string }>();
  let perToken: Limiter | null = null;
  let perOrg: Limiter | null = null;
  const over = async (req: FastifyRequest): Promise<number> => {
    perToken ??= app.createRateLimit({ max: opts.tokenPerMinute, timeWindow: MINUTE, keyGenerator: (r) => 'embed-token:' + (keys.get(r)?.token ?? '') });
    perOrg ??= app.createRateLimit({ max: opts.orgPerMinute, timeWindow: MINUTE, keyGenerator: (r) => 'embed-org:' + (keys.get(r)?.org ?? '') });
    for (const limiter of [perToken, perOrg]) {
      const r = await limiter(req);
      if (!r.isAllowed && r.isExceeded) return Math.max(1, r.ttlInSeconds);
    }
    return 0;
  };

  const refuse = (reply: FastifyReply, code: number, message: string, ancestors: readonly string[]) => {
    reply.removeHeader('x-frame-options');
    if (!ancestors.length) reply.header('x-frame-options', 'DENY');
    return reply.code(code).header('content-security-policy', refusalCsp(ancestors)).type('text/html; charset=utf-8').send(refusalHtml(message));
  };

  app.get<{ Params: { '*': string } }>(EMBED_ROUTE, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    reply.removeHeader('set-cookie'); // the CSRF cookie every page gets (../csrf.ts): an embed sets none, and has no form
    const token = req.params['*'];
    const head = readHeader(token);
    if (!head) return refuse(reply, 403, embedInvalid(), []);
    const { org } = head;

    let secret: string | null = null;
    let settings: Awaited<ReturnType<typeof readSettings>>;
    try {
      settings = await readSettings(org);
      secret = await secretOf(org);
    } catch (err) {
      req.log.error({ err }, 'embed: settings could not be read');
      return refuse(reply, 503, embedFailed(), []);
    }
    // An unknown org, no secret, a bad MAC: one answer, so no probe tells them apart.
    if (!secret) return refuse(reply, 403, embedUnavailable(), []);
    const v = verifyToken(token, secret, Math.floor(Date.now() / 1000));
    if (!v.ok && (v.reason === 'bad' || v.reason === 'signature')) return refuse(reply, 403, embedInvalid(), []);

    // The signature held: the org is known, every outcome below is audited.
    const pool = opts.pool();
    const claims = v.ok ? v.claims : null;
    const record = (outcome: Outcome) =>
      audit(pool, {
        org, actor: 'embed', action: 'embed_view', outcome, requestId: String(req.id),
        targets: claims ? [claims.pub, ...(claims.dash ? [claims.dash] : [])] : [],
      }).catch((err: unknown) => req.log.error({ err }, 'embed: audit write failed'));
    const preview = claims?.prv === true;
    const ancestors = preview ? [SELF] : settings.enabled ? settings.origins : [];

    keys.set(req, { token: tokenFingerprint(token), org });
    const wait = await over(req);
    if (wait) {
      await record('denied');
      reply.header('retry-after', wait);
      return refuse(reply, 429, embedRateLimited(), ancestors);
    }
    if (!v.ok) {
      await record('denied');
      return refuse(reply, 403, CLAIM_SENTENCE[v.reason as keyof typeof CLAIM_SENTENCE](), ancestors);
    }
    const c = v.claims;
    if (!preview && !settings.enabled) {
      await record('denied');
      return refuse(reply, 403, embedUnavailable(), []);
    }
    if (preview && !(req.headers['sec-fetch-dest'] === 'iframe' && req.headers['sec-fetch-site'] === 'same-origin')) {
      await record('denied');
      return refuse(reply, 403, embedPreviewOnly(), ancestors);
    }
    // Defence in depth beside frame-ancestors: a Referer, when the host sends one, is this server or an allowed site.
    const ref = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    if (ref) {
      let from: URL | null = null;
      try {
        from = new URL(ref);
      } catch {
        from = null;
      }
      const allowed = from !== null && (from.host === req.headers.host || (!preview && settings.origins.includes(from.origin)));
      if (!allowed) {
        await record('denied');
        return refuse(reply, 403, embedOrigin(), ancestors);
      }
    }

    let out: { html: string } | { missing: 'gone' | 'republish' };
    try {
      out = await runAsPublished(anonymous(org), String(req.id), async () => {
        const hosted = require('../../publish/hosted') as typeof import('../../publish/hosted');
        const projects = require('../../app/projects') as typeof import('../../app/projects');
        const site = await hosted.getSite(c.pub);
        if (!site || !(await projects.getProject(site.projectId))) return { missing: 'gone' as const };
        const dash = c.dash ?? site.config.dashboardIds[0];
        if (!dash || !site.config.dashboardIds.includes(dash)) return { missing: 'gone' as const };
        const { embedHtml } = require('../../publish/embedPage') as typeof import('../../publish/embedPage');
        return embedHtml(site, dash, c);
      });
    } catch (err) {
      req.log.error({ err }, 'embed: page could not be built');
      await record('error');
      return refuse(reply, 500, embedFailed(), ancestors);
    }
    if ('missing' in out) {
      await record('denied');
      return refuse(reply, 404, out.missing === 'republish' ? embedRepublish() : embedNotFound(), ancestors);
    }
    const csp = pageCsp(out.html);
    if (!csp) {
      await record('error');
      return refuse(reply, 500, embedFailed(), ancestors);
    }
    await record('ok');
    reply.removeHeader('x-frame-options');
    return reply.header('content-security-policy', `${csp}; frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`).type('text/html; charset=utf-8').send(out.html);
  });
}
