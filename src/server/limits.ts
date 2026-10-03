// Rate limits and the RPC time limit (T6.2).
//
//   sign-in   GET /api/auth/login + /api/auth/callback   per client IP   RATE_LIMIT_LOGIN_PER_MINUTE (60)
//   RPC       POST /api/rpc/<channel>                    per client IP   RATE_LIMIT_RPC_IP_PER_MINUTE (3000)
//                                                        per user        RATE_LIMIT_RPC_PER_MINUTE (1200)
//
// Over a limit → 429 with Retry-After (seconds until the window resets). The
// per-IP checks run before sign-in is looked up, so a flood costs no Postgres
// query; the per-user check runs after it (the user is only known then), on
// the org + email, so every tab and API token of one person shares a bucket.
//
// The client IP is the TCP peer — unless the peer is a proxy in
// TRUSTED_PROXY_CIDRS, then the right-most X-Forwarded-For entry that is not
// one of them. Behind an ingress without TRUSTED_PROXY_CIDRS every caller
// shares the ingress's address, and so one per-IP bucket: set it there.
//
// ponytail: counters live in this process (@fastify/rate-limit's LRU store, 5,000
// keys per limit), so N pods allow N × the limit. A shared store (the plugin
// takes one) when that matters.

import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BlockList } from 'net';
import { isTrustedPeer as trusted } from './auth/index';
import { ctx } from './context';
import type { LimitsEnv } from './env';

const MINUTE = 60_000;
export const RPC_ROUTE = '/api/rpc/:channel';
const SIGN_IN_ROUTES = new Set(['/api/auth/login', '/api/auth/callback']);

/** The address a request came from, trusting X-Forwarded-For only as far as the proxies in `proxies`. */
export function clientIp(req: Pick<FastifyRequest, 'headers' | 'socket'>, proxies: BlockList): string {
  let ip = req.socket.remoteAddress ?? '';
  if (!trusted(proxies, ip)) return ip;
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  // Right to left: each trusted proxy vouches for the hop before it.
  while (hops.length && trusted(proxies, ip)) ip = hops.pop() as string;
  return ip;
}

type Limiter = (req: FastifyRequest) => Promise<{ isAllowed: true } | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number }>;

/** 429 + Retry-After when `limiter` says the caller is over; true when it answered. */
async function refused(limiter: Limiter, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const r = await limiter(req);
  if (r.isAllowed || !r.isExceeded) return false;
  const after = Math.max(1, r.ttlInSeconds);
  await reply.code(429).header('retry-after', after).send({ error: 'rate limited', retryAfter: after });
  return true;
}

export interface Limits {
  /** The per-user RPC check: a route-level onRequest hook, after sign-in. */
  perUser(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

/**
 * Registers the plugin and the per-IP checks (a root onRequest hook; call it
 * before sign-in's hook is added). Returns the per-user check for the RPC route.
 */
export function registerLimits(app: FastifyInstance, cfg: LimitsEnv, proxies: BlockList): Limits {
  // global: false — nothing is limited unless asked below. The limiters are
  // made on first use: the plugin's decorator exists once it has loaded.
  void app.register(rateLimit, { global: false });
  const ipKey = (prefix: string) => (req: FastifyRequest) => prefix + normalizeIP(clientIp(req, proxies));
  let signIn: Limiter | null = null;
  let rpcIp: Limiter | null = null;
  let rpcUser: Limiter | null = null;

  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (SIGN_IN_ROUTES.has(route)) {
      signIn ??= app.createRateLimit({ max: cfg.loginPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('login:') });
      await refused(signIn, req, reply);
    } else if (route === RPC_ROUTE) {
      rpcIp ??= app.createRateLimit({ max: cfg.rpcIpPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('rpc:') });
      await refused(rpcIp, req, reply);
    }
  });

  return {
    async perUser(req, reply) {
      rpcUser ??= app.createRateLimit({
        max: cfg.rpcUserPerMinute,
        timeWindow: MINUTE,
        keyGenerator: () => {
          const { org, user } = ctx();
          return `user:${org.id}\u0000${user.email}`;
        },
      });
      await refused(rpcUser, req, reply);
    },
  };
}

/** The reason a request's signal aborts when its RPC ran past RPC_TIMEOUT_SECONDS. */
export class RpcTimeout extends Error {
  constructor() {
    super('rpc time limit');
    this.name = 'RpcTimeout';
  }
}

/**
 * Settles with `work`, or rejects with the signal's reason once it aborts —
 * a time limit (RpcTimeout) or the caller hanging up. `work` itself cannot be
 * stopped; what it awaits on DuckDB is (the same signal interrupts the query
 * in the org worker), and its late result or error is dropped.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}
