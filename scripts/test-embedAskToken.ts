// The Assistant's embed token and the asker it makes (src/server/embed/askToken.ts, asker.ts,
// docs/embedded-assistant/00-design.md). Pure: no server, no database. Every refusal has its negative control: the same
// token, correct, verifies. The host signs with node:crypto only, not signToken.
//
//   npm run build:ts && node scripts/test-embedAskToken.js

import { createHmac } from 'crypto';
import { finish, ok } from './selfcheck';
import { ASK_MAX_TTL_SEC, verifyAskToken } from '../src/server/embed/askToken';
import { previewKey, verifyToken } from '../src/server/embed/token';
import { buildAsker } from '../src/server/embed/asker';
import { maskEmbedTokens, maskEmbedUrl } from '../src/server/embed/route';

const SECRET = 'ord_embed_' + 'k'.repeat(43);
const ORG = 'acme';
const AGENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const DS = '6f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10';
const NOW = 1_760_000_000;
const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function hostSign(header: unknown, payload: unknown, secret = SECRET): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
const HEAD = { alg: 'HS256', typ: 'JWT', kid: ORG };
const base = { agent: AGENT, sub: 'cust-123', exp: NOW + 600, params: { customer_id: 'C1' } };
const reason = (t: string, now = NOW): string => { const v = verifyAskToken(t, SECRET, now); return v.ok ? 'ok' : v.reason; };
const sign = (over: Record<string, unknown>, drop: string[] = []): string => {
  const p: Record<string, unknown> = { ...base, ...over };
  for (const d of drop) delete p[d];
  return hostSign(HEAD, p);
};

const good = sign({ params: { customer_id: [1, 'C2'] } });
const v = verifyAskToken(good, SECRET, NOW);
ok('control: a host-signed token verifies, claims typed', v.ok && v.claims.agent === AGENT && v.claims.sub === 'cust-123' && JSON.stringify(v.claims.params) === JSON.stringify({ customer_id: [1, 'C2'] }));

ok('expired: refused', reason(sign({ exp: NOW - 120 })) === 'expired');
ok('control: just inside the skew passes', reason(sign({ exp: NOW - 30 })) === 'ok');
ok('more than 1 hour ahead: refused', reason(sign({ exp: NOW + ASK_MAX_TTL_SEC + 120 })) === 'exp_too_far');
ok('control: exactly 1 hour passes', reason(sign({ exp: NOW + ASK_MAX_TTL_SEC })) === 'ok');
ok('a dashboard-length (24 h) token is too long for the Assistant', reason(sign({ exp: NOW + 24 * 3600 })) === 'exp_too_far');
ok('wrong key: a signature refusal', verifyAskToken(hostSign(HEAD, base, 'other-secret'), SECRET, NOW).ok === false && reason(hostSign(HEAD, base, 'other-secret')) === 'signature');
ok('alg none: refused before any claim', reason(hostSign({ alg: 'none', typ: 'JWT', kid: ORG }, base)) === 'bad');
ok('signed with the preview key: a signature refusal', reason(hostSign(HEAD, base, previewKey(SECRET))) === 'signature');
for (const extra of [{ pub: DS }, { dash: DS }, { prv: true }, { theme: 'dark' }, { hide: ['title'] }, { role: 'admin' }, { __proto__x: 1 }]) {
  ok(`unknown or dashboard claim ${Object.keys(extra)[0]}: refused`, reason(sign(extra)) === 'claims');
}
ok('agent not a uuid: refused', reason(sign({ agent: '../x' })) === 'claims');
ok('no agent: refused', reason(sign({}, ['agent'])) === 'claims');
ok('no sub: refused', reason(sign({}, ['sub'])) === 'claims');
ok('blank sub: refused', reason(sign({ sub: '   ' })) === 'claims');
ok('a control character in sub: refused', reason(sign({ sub: 'a\nb' })) === 'claims');
ok('sub over 200 characters: refused', reason(sign({ sub: 'x'.repeat(201) })) === 'claims');
ok('a number as sub: refused', reason(sign({ sub: 5 })) === 'claims');
ok('no params at all: refused, never an open Assistant', reason(sign({}, ['params'])) === 'claims');
ok('empty params: refused', reason(sign({ params: {} })) === 'claims');
ok('an empty value list: refused', reason(sign({ params: { customer_id: [] } })) === 'claims');
ok('a blank value: refused', reason(sign({ params: { customer_id: ' ' } })) === 'claims');
ok('a [[parameter]] value: refused', reason(sign({ params: { customer_id: '[[who]]' } })) === 'claims');
ok('an object value: refused', reason(sign({ params: { customer_id: { $ne: 1 } } })) === 'claims');
ok('101 values: refused', reason(sign({ params: { customer_id: Array.from({ length: 101 }, (_, i) => String(i)) } })) === 'claims');
ok('9 locked columns: refused', reason(sign({ params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, 'x'])) })) === 'claims');
ok('iat in the future: refused', reason(sign({ iat: NOW + 3600 })) === 'claims');

// Kind confusion, both ways.
const dashToken = hostSign(HEAD, { pub: AGENT, dash: DS, exp: NOW + 600, params: { customer_id: 'C1' } });
ok('control: that dashboard token verifies as a dashboard token', verifyToken(dashToken, SECRET, NOW).ok === true);
ok('a dashboard token is refused by the Assistant', reason(dashToken) === 'claims');
ok('an Assistant token is refused by the dashboard parser', (() => { const r = verifyToken(good, SECRET, NOW); return !r.ok && r.reason === 'claims'; })());

// The asker.
const marking = { agentId: AGENT, projectId: '2b4e28ba-2fa1-41d2-883f-0016d3cca427', datasets: [{ id: DS.toUpperCase(), column: 'customer_id' }] };
const claims = (p: Record<string, readonly (string | number)[]>) => ({ agent: AGENT, sub: 'cust-123', exp: NOW + 600, params: p });
const a = buildAsker(ORG, claims({ customer_id: [7, 'C1'] }), marking);
ok('control: the asker locks the dataset (lowercase id) to the values as text', a.ok && JSON.stringify(a.identity.embed?.datasets[DS]) === JSON.stringify({ column: 'customer_id', values: ['7', 'C1'], writers: '' }) && a.identity.user.role === 'viewer');
ok('the asker\'s email carries a hash, never the customer id', a.ok && !a.identity.user.email.includes('cust-123') && a.identity.user.email.startsWith('embed:'));
const two = { ...marking, datasets: [...marking.datasets, { id: '7f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10', column: 'account' }] };
ok('a token that lacks a required column: refused whole', (() => { const r = buildAsker(ORG, claims({ customer_id: ['C1'] }), two); return !r.ok && r.reason === 'lock_missing'; })());
ok('control: both required columns locked passes', buildAsker(ORG, claims({ customer_id: ['C1'], account: ['A'] }), two).ok);
ok('a lock on a column no dataset requires: refused', (() => { const r = buildAsker(ORG, claims({ customer_id: ['C1'], region: ['W'] }), marking); return !r.ok && r.reason === 'lock_extra'; })());
ok('another agent\'s token against this marking: refused', !buildAsker(ORG, { ...claims({ customer_id: ['C1'] }), agent: DS }, marking).ok);
ok('a marking with no dataset gives no asker: every lock is extra', !buildAsker(ORG, claims({ customer_id: ['C1'] }), { ...marking, datasets: [] }).ok);

// Log masking.
ok('the page URL of an Assistant token is masked', maskEmbedUrl('/embed/ask/aaa.bbb.ccc?x=1') === '/embed/ask/[redacted]?x=1');
ok('control: the POST route has no token in its URL and is left as is', maskEmbedUrl('/embed/ask') === '/embed/ask');
ok('a dashboard URL is masked as before', maskEmbedUrl('/embed/aaa.bbb.ccc') === '/embed/[redacted]');
ok('a Fastify "not found" line with an Assistant token is masked', maskEmbedTokens('Route GET:/embed/ask/aaa.bbb.ccc not found') === 'Route GET:/embed/ask/[redacted] not found' && maskEmbedTokens('GET:/embed/aaa.bbb.ccc') === 'GET:/embed/[redacted]');
finish();
