// The embedded Assistant's two unauthenticated routes are held to the per-client-IP embed bucket BEFORE their handlers run (and so before
// the two reads each makes), like the dashboard route (src/server/limits.ts). A bare Fastify app with the real limiter and stub handlers
// that count how often they ran: the (limit + 1)th request is a 429 with Retry-After and the handler never ran for it.
//
//   npm run build:ts && node scripts/test-embedAskLimits.js

import Fastify from 'fastify';
import { BlockList } from 'net';
import { ok, finish } from './selfcheck';
import { registerLimits } from '../src/server/limits';
import { EMBED_ASK_PAGE_ROUTE, EMBED_ASK_ROUTE } from '../src/server/embed/askRoute';
import { parseEnv } from '../src/server/env';

(async () => {
  const cfg = parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'dev', DATA_DIR: '/tmp/x', RATE_LIMIT_RPC_IP_PER_MINUTE: '3' });
  const app = Fastify();
  registerLimits(app, cfg.limits, new BlockList());
  const ran = { page: 0, ask: 0, other: 0 };
  app.get(EMBED_ASK_PAGE_ROUTE, async () => (ran.page += 1, 'page'));
  app.post(EMBED_ASK_ROUTE, async () => (ran.ask += 1, 'ask'));
  app.get('/embed/other/*', async () => (ran.other += 1, 'other')); // NEGATIVE CONTROL: a route the limiter does not name
  await app.ready();
  const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '10.0.0.1' });
  const post = () => app.inject({ method: 'POST', url: '/embed/ask', payload: {}, remoteAddress: '10.0.0.1' });

  for (let i = 0; i < 3; i++) await get('/embed/ask/a.b.c');
  const over = await get('/embed/ask/a.b.c');
  ok('the page: the 4th request from one address is a 429 with Retry-After, and its handler never ran', over.statusCode === 429 && Number(over.headers['retry-after']) >= 1 && ran.page === 3, `${over.statusCode} ${ran.page}`);
  ok('the questions share that bucket (the same address is held on POST /embed/ask too)', (await post()).statusCode === 429 && ran.ask === 0);
  const other = await app.inject({ method: 'POST', url: '/embed/ask', payload: {}, remoteAddress: '10.0.0.2' });
  ok('another address is not held by it', other.statusCode === 200 && ran.ask === 1);
  for (let i = 0; i < 6; i++) await get('/embed/other/x');
  ok('NEGATIVE CONTROL: a route the limiter does not name is not counted', ran.other === 6);
  await app.close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
