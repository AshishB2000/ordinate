// Fingerprints for meaning search (src/ai/fingerprints.ts), against a stubbed
// fetch: no real network call is ever made. Plain Node, no database: the keys
// are this temp userData's config.json, read by the same byokCredentials every
// chat call uses.
//
//   off       with no model, fingerprint refuses and sends nothing. NEGATIVE
//             CONTROL: with one, a request goes out
//   shapes    OpenAI /embeddings with dimensions 768, a gateway's the same at
//             its base URL, Gemini batchEmbedContents with outputDimensionality
//             768; every key in a header, never the URL
//   batches   250 texts → 100, 100, 50, vectors back in input order (OpenAI's
//             `index` honoured)
//   vectors   every one L2-normalized (Gemini's 3-4-0 → 0.6-0.8-0); 1536 or
//             767 numbers is the catalog sentence, 768 passes; a zero vector
//             or a short reply is a bad reply
//   errors    401, 429, 500 and a dropped socket are typed; an aborted request
//             signal stops the call
//   canary    a planted key echoed back by the provider is in no reply or log line
//
//   npm run build:ts && node scripts/test-fingerprints.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomBytes } from 'crypto';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fingerprints-'));
process.env.ORDINATE_LOCAL_DIR = userData; // config.ts reads userData from here outside server mode

const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const loggerMod: typeof import('../src/app/logger') = require('../src/app/logger');
const context: typeof import('../src/server/context') = require('../src/server/context');
const fp: typeof import('../src/ai/fingerprints') = require('../src/ai/fingerprints');

const CANARY = `sk-proj-Canary${randomBytes(8).toString('hex')}`;
const show = (v: unknown): string => JSON.stringify(v);

let logged = '';
const line = (_o: object, m: string): void => {
  logged += `${JSON.stringify(_o)} ${m}\n`;
};
const sink: import('../src/app/logger').LogSink = { debug: line, info: line, warn: line, error: line, child: () => sink };
loggerMod.useLogger(sink);

// ── The stub: every request recorded; `reply` decides the answer ────────────
interface Seen { url: string; headers: Record<string, string>; body: any } // any: each provider's own JSON
let seen: Seen[] = [];
let reply: (req: Seen) => Response | Promise<Response> = () => new Response('{}');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (init?.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const req: Seen = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body ?? 'null')) };
  seen.push(req);
  return reply(req);
}) as typeof fetch;

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
/** A one-hot vector at `at`, scaled by 3, `dims` long. */
const hot = (at: number, dims = 768): number[] => Array.from({ length: dims }, (_, i) => (i === at ? 3 : 0));
const textsOf = (req: Seen): string[] => (req.body.input ?? req.body.requests.map((r: { content: { parts: { text: string }[] } }) => r.content.parts[0].text)) as string[];
/** OpenAI's reply for the request's texts: text `t<n>` → one-hot at n % 768, listed in reverse with its `index`. */
const openaiOk = (dims = 768) => (req: Seen) => json({ data: textsOf(req).map((t, i) => ({ index: i, embedding: hot((Number(t.slice(1)) || 0) % 768, dims) })).reverse() });
const OPENAI = { provider: 'openai', model: 'text-embedding-3-small' };
const GEMINI = { provider: 'gemini', model: 'gemini-embedding-001' };
const GATEWAY = { provider: 'gateway', model: 'acme/embed-768' };

(async () => {
  try {
    // ── Off by default ──────────────────────────────────────────────────────
    const off = await fp.fingerprint(['Revenue'], null);
    ok('off: no model → refused with the Admin → AI sentence', !off.ok && off.errorType === 'off'
      && off.message === 'Meaning search is off. An admin can pick a fingerprint model in Admin → AI.', show(off));
    ok('off: …and no request was made', seen.length === 0);
    const anthropic = await fp.fingerprint(['Revenue'], { provider: 'anthropic', model: 'claude-x' });
    ok('anthropic: no embedding API → the "needs an OpenAI, Gemini or gateway key" sentence, nothing sent', !anthropic.ok && anthropic.errorType === 'no_model' && seen.length === 0, show(anthropic));
    const noKey = await fp.fingerprint(['Revenue'], OPENAI);
    ok('no key: OpenAI without a key is refused before any request', !noKey.ok && noKey.errorType === 'no_key' && /Connect OpenAI API in Admin → AI/.test(noKey.message) && seen.length === 0, show(noKey));
    ok('empty: no texts → no vectors and no request', show(await fp.fingerprint([], OPENAI)) === show({ ok: true, vectors: [] }) && seen.length === 0);

    execConfig.setByokProvider('openai', { apiKey: CANARY });
    execConfig.setByokProvider('gemini', { apiKey: CANARY });
    execConfig.setByokProvider('gateway', { apiKey: CANARY, baseUrl: 'https://gw.example.test/v1/' });

    // ── OpenAI ─────────────────────────────────────────────────────────────
    reply = openaiOk();
    const one = await fp.fingerprint(['t5'], OPENAI);
    ok('off NEGATIVE CONTROL: with a model, one request goes out', one.ok && seen.length === 1);
    const o = seen[0];
    ok('openai: POST https://api.openai.com/v1/embeddings', o.url === 'https://api.openai.com/v1/embeddings', o.url);
    ok('openai: model, input, dimensions 768, float', show(o.body) === show({ model: 'text-embedding-3-small', input: ['t5'], dimensions: 768, encoding_format: 'float' }), show(o.body));
    ok('openai: the key as a bearer header, not in the URL', o.headers.authorization === `Bearer ${CANARY}` && !o.url.includes(CANARY));
    ok('openai: a 768-number Float32Array of length 1', one.ok && one.vectors[0] instanceof Float32Array && one.vectors[0].length === 768 && Object.is(one.vectors[0][5], 1));

    // ── Batches ────────────────────────────────────────────────────────────
    seen = [];
    const many = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const batched = await fp.fingerprint(many, OPENAI);
    ok('batches: 250 texts → 3 requests of 100, 100 and 50', seen.length === 3 && seen.map((r) => r.body.input.length).join() === '100,100,50', show(seen.map((r) => r.body.input.length)));
    ok('batches: …the texts in order across them', seen.flatMap((r) => r.body.input as string[]).join() === many.join());
    ok('batches: 250 vectors back in input order (the reply listed them reversed, by index)', batched.ok && batched.vectors.length === 250
      && batched.vectors.every((v, i) => Object.is(v[i % 768], 1)), batched.ok ? '' : show(batched));
    seen = [];
    reply = (req) => (seen.length === 2 ? json({ error: { message: 'Rate limit reached' } }, 429) : openaiOk()(req));
    const partial = await fp.fingerprint(many, OPENAI);
    ok('batches: a failing second batch fails the call, and the third is never sent', !partial.ok && partial.errorType === 'rate_limit' && seen.length === 2, show(partial));

    // ── Gemini ─────────────────────────────────────────────────────────────
    seen = [];
    reply = (req) => json({ embeddings: textsOf(req).map(() => ({ values: [3, 4, ...Array(766).fill(0)] })) });
    const gem = await fp.fingerprint(['Revenue', 'Region'], GEMINI);
    const g = seen[0];
    ok('gemini: POST …/v1beta/models/gemini-embedding-001:batchEmbedContents', g?.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', g?.url);
    ok('gemini: one request per text, model, parts, outputDimensionality 768', show(g?.body) === show({ requests: ['Revenue', 'Region'].map((text) => ({
      model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, outputDimensionality: 768 })) }), show(g?.body));
    ok('gemini: the key in x-goog-api-key, not in the URL', g?.headers['x-goog-api-key'] === CANARY && !g.url.includes('key=') && !g.url.includes(CANARY));
    ok('vectors: Gemini\'s truncated 3-4-0… is normalized to 0.6-0.8-0…', gem.ok && Object.is(gem.vectors[0][0], Math.fround(0.6)) && Object.is(gem.vectors[0][1], Math.fround(0.8))
      && gem.vectors[1].slice(2).every((x) => x === 0), gem.ok ? String(gem.vectors[0].slice(0, 3)) : show(gem));
    ok('vectors: unit() scales any vector to length 1', (() => {
      const u = fp.unit([1, 2, 3, 4]);
      return !!u && Math.abs(Math.hypot(...u) - 1) < 1e-6;
    })());

    // ── Gateway and the 768 check ──────────────────────────────────────────
    seen = [];
    reply = openaiOk(1536);
    const wide = await fp.fingerprint(['t1'], GATEWAY);
    ok('gateway: POST <its base URL>/embeddings with its typed model and dimensions 768', seen[0]?.url === 'https://gw.example.test/v1/embeddings'
      && seen[0].body.model === 'acme/embed-768' && seen[0].body.dimensions === 768, show(seen[0]));
    ok('768: a 1536-number reply is the catalog sentence', !wide.ok && wide.errorType === 'dimensions' && wide.message === 'This model returns 1,536 dimensions; meaning search needs 768.', show(wide));
    reply = openaiOk(767);
    const short = await fp.fingerprint(['t1'], GATEWAY);
    ok('768: …so is 767', !short.ok && short.errorType === 'dimensions' && /returns 767 dimensions/.test(short.message), show(short));
    reply = openaiOk(768);
    ok('768 NEGATIVE CONTROL: 768 passes', (await fp.fingerprint(['t1'], GATEWAY)).ok);
    reply = () => json({ data: [{ index: 0, embedding: Array(768).fill(0) }] });
    const zero = await fp.fingerprint(['t1'], GATEWAY);
    ok('vectors: a zero vector cannot be normalized → bad reply', !zero.ok && zero.errorType === 'bad_reply', show(zero));
    reply = () => json({ data: [{ index: 0, embedding: hot(0) }] });
    const fewer = await fp.fingerprint(['t1', 't2'], GATEWAY);
    ok('vectors: one vector for two texts → bad reply', !fewer.ok && fewer.errorType === 'bad_reply', show(fewer));

    // ── Errors and the canary ──────────────────────────────────────────────
    reply = () => json({ error: { message: `Incorrect API key provided: ${CANARY}.` } }, 401);
    const denied = await fp.fingerprint(['t1'], OPENAI);
    ok('errors: 401 → auth, with the provider\'s reason, the key cut out', !denied.ok && denied.errorType === 'auth' && /Incorrect API key provided: \*\*\*/.test(denied.detail ?? ''), show(denied));
    reply = () => new Response('upstream exploded', { status: 500 });
    const broke = await fp.fingerprint(['t1'], OPENAI);
    ok('errors: 500 → provider, with its text', !broke.ok && broke.errorType === 'provider' && /500 · upstream exploded/.test(broke.detail ?? ''), show(broke));
    reply = () => {
      throw new Error(`connect ECONNREFUSED while sending ${CANARY}`);
    };
    const net = await fp.fingerprint(['t1'], OPENAI);
    ok('errors: a dropped socket → network', !net.ok && net.errorType === 'network', show(net));
    reply = openaiOk();
    seen = [];
    const gone = new AbortController();
    gone.abort();
    const who = { user: { email: 'boss@acme.test', role: 'admin' as const }, org: { id: 'acme' } };
    const hungUp = await context.runInContext(who, 'r1', () => fp.fingerprint(['t1'], OPENAI), undefined, gone.signal);
    ok('abort: a request whose caller hung up is not sent on (the ctx signal is joined)', !hungUp.ok && hungUp.errorType === 'network' && seen.length === 0, show(hungUp));
    const replies = show([denied, broke, net, hungUp]);
    ok('canary: the key reached the provider (in its header)', o.headers.authorization.includes(CANARY));
    ok('canary: in no reply', !replies.includes(CANARY), replies);
    ok('canary: in no log line', logged.length > 0 && !logged.includes(CANARY), logged);
    ok('canary NEGATIVE CONTROL: the log did carry the echoing reply (key cut out) and the socket error', logged.includes('Incorrect API key provided: ***')
      && logged.includes('ECONNREFUSED while sending ***'), logged);

    // ── Admin → AI's Test ──────────────────────────────────────────────────
    reply = openaiOk();
    const tested = await fp.testFingerprint(OPENAI);
    ok('test: one sample → 768 dimensions and a whole-millisecond latency', tested.ok && tested.dimensions === 768 && Number.isInteger(tested.ms) && tested.ms >= 0, show(tested));
    reply = openaiOk(1536);
    const testedWide = await fp.testFingerprint(GATEWAY);
    ok('test: a wrong-size model answers with the sentence', !testedWide.ok && testedWide.errorType === 'dimensions', show(testedWide));
  } finally {
    globalThis.fetch = realFetch;
    loggerMod.useLogger(null);
    fs.rmSync(userData, { recursive: true, force: true });
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
