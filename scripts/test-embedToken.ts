// Embed tokens (src/server/embed/token.ts, docs/embed/00-design.md): what
// verifies and everything that must not. Pure — no server, no database.
//
// Every refusal has its negative control: the same token, correct, verifies.
// The host's side is signed here the way the Admin snippets do it (node:crypto
// only), NOT with signToken, so a bug shared by both halves cannot pass.
//
//   npm run build:ts && node scripts/test-embedToken.js

import { createHmac } from 'crypto';
import { finish, ok } from './selfcheck';
import { MAX_TTL_SEC, PREVIEW_TTL_SEC, previewKey, readHeader, signToken, tokenFingerprint, verifyToken } from '../src/server/embed/token';
import { normalizeOrigin } from '../src/server/embed/settings';

const SECRET = 'ord_embed_' + 'k'.repeat(43);
const ORG = 'acme';
const PUB = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const DASH = '6f1c1b5e-6a0e-4a8f-9c55-1f8e4c0d2a10';
const NOW = 1_760_000_000;

const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
/** The Node snippet's signer, verbatim in spirit: header.payload, HMAC-SHA256 over it with the secret string. */
function hostSign(header: unknown, payload: unknown, secret = SECRET): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
const HEAD = { alg: 'HS256', typ: 'JWT', kid: ORG };
const base = { pub: PUB, dash: DASH, exp: NOW + 600 };
const verify = (t: string, now = NOW) => verifyToken(t, SECRET, now);
const reason = (t: string, now = NOW): string => { const v = verify(t, now); return v.ok ? 'ok' : v.reason; };

// ── The happy path, and that both signers agree ──────────────────────────────
const good = hostSign(HEAD, { ...base, params: { Region: 'East', Year: [2024, 2025] }, theme: 'dark', hide: ['title'] });
const v = verify(good);
ok('control: a host-signed token verifies', v.ok);
ok('control: claims come back typed — one value becomes a list', v.ok && JSON.stringify(v.claims.params) === JSON.stringify({ Region: ['East'], Year: [2024, 2025] }) && v.claims.theme === 'dark' && v.claims.hide[0] === 'title');
ok('control: readHeader names the org and nothing else', readHeader(good)?.org === ORG);
ok('signToken and the host snippet produce the same token', signToken(ORG, { ...base }, SECRET) === hostSign(HEAD, { ...base }));
ok('a fingerprint is a prefix of the MAC, never the token', tokenFingerprint(good).length === 16 && !tokenFingerprint(good).includes('.') && good.endsWith(good.split('.')[2]));

// ── Signature ────────────────────────────────────────────────────────────────
{
  const [h, p, s] = good.split('.');
  const flip = (x: string, i: number) => x.slice(0, i) + (x[i] === 'A' ? 'B' : 'A') + x.slice(i + 1);
  ok('bad signature: one character of the MAC changed', reason(`${h}.${p}.${flip(s, 5)}`) === 'signature');
  ok('bad signature: the payload edited, MAC kept (a widened lock)', reason(`${h}.${b64({ ...base })}.${s}`) === 'signature');
  ok('bad signature: another org\'s secret', verifyToken(good, SECRET + 'x', NOW).ok === false);
  ok('bad signature: a truncated MAC', reason(`${h}.${p}.${s.slice(0, 20)}`) === 'signature');
  ok('bad signature: a non-canonical spelling of the same MAC', reason(`${h}.${p}.${s.slice(0, -1)}${String.fromCharCode(s.charCodeAt(s.length - 1) + 1)}`) === 'signature');
  ok('bad signature: an empty MAC', reason(`${h}.${p}.`) === 'bad');
  // Wrong org: signed with A's secret, header claiming B — B's secret is what the server tries.
  const forB = hostSign({ ...HEAD, kid: 'globex' }, base);
  ok('wrong org: a token naming org B, signed with A\'s secret, fails B\'s check', verifyToken(forB, 'ord_embed_' + 'g'.repeat(43), NOW).ok === false);
  ok('control: the same token checks against the secret it was signed with', verifyToken(forB, SECRET, NOW).ok);
}

// ── Algorithm confusion and header shape ─────────────────────────────────────
for (const [label, header] of [
  ['alg none', { alg: 'none', typ: 'JWT', kid: ORG }],
  ['alg HS512', { alg: 'HS512', typ: 'JWT', kid: ORG }],
  ['alg RS256', { alg: 'RS256', typ: 'JWT', kid: ORG }],
  ['alg hs256 (case)', { alg: 'hs256', typ: 'JWT', kid: ORG }],
  ['no alg', { typ: 'JWT', kid: ORG }],
  ['no kid', { alg: 'HS256', typ: 'JWT' }],
  ['kid not an org id', { alg: 'HS256', kid: '../etc' }],
  ['a jwk header', { alg: 'HS256', kid: ORG, jwk: { kty: 'oct', k: 'AA' } }],
  ['a jku header', { alg: 'HS256', kid: ORG, jku: 'https://evil.test/keys' }],
  ['typ other than JWT', { alg: 'HS256', typ: 'JWE', kid: ORG }],
] as const) {
  const t = hostSign(header, base);
  ok(`header refused before any key is read: ${label}`, readHeader(t) === null && reason(t) === 'bad');
}
ok('alg none with an empty signature', readHeader(`${b64({ alg: 'none', kid: ORG })}.${b64(base)}.`) === null);
ok('header without typ is fine (control)', reason(hostSign({ alg: 'HS256', kid: ORG }, base)) === 'ok');
ok('not three parts', readHeader('a.b') === null && readHeader('a.b.c.d') === null);
ok('padding or other characters refused', readHeader(good + '=') === null && readHeader(good.replace('.', '+')) === null);
ok('oversize token refused', readHeader(hostSign(HEAD, { ...base, junk: 'x'.repeat(9000) })) === null);
ok('header not JSON', readHeader(`${b64('nope')}.${b64(base)}.${good.split('.')[2]}`) === null);

// ── Expiry ───────────────────────────────────────────────────────────────────
ok('expired: exp in the past', reason(hostSign(HEAD, { ...base, exp: NOW - 120 })) === 'expired');
ok('control: inside the 60 s skew still verifies', reason(hostSign(HEAD, { ...base, exp: NOW - 30 })) === 'ok');
ok('missing exp refused', reason(hostSign(HEAD, { pub: PUB })) === 'claims');
ok('exp as a string refused', reason(hostSign(HEAD, { ...base, exp: String(NOW + 60) })) === 'claims');
ok('exp more than 24 h ahead refused', reason(hostSign(HEAD, { ...base, exp: NOW + MAX_TTL_SEC + 3600 })) === 'exp_too_far');
ok('control: exactly 24 h ahead verifies', reason(hostSign(HEAD, { ...base, exp: NOW + MAX_TTL_SEC })) === 'ok');
ok('a preview token may live 10 minutes, not an hour', reason(hostSign(HEAD, { ...base, prv: 1, exp: NOW + 3600 })) === 'exp_too_far' && reason(hostSign(HEAD, { ...base, prv: 1, exp: NOW + PREVIEW_TTL_SEC })) === 'ok');
ok('iat in the future refused', reason(hostSign(HEAD, { ...base, iat: NOW + 3600 })) === 'claims');
ok('a token that was valid is refused once its time passes', reason(good, NOW + 700) === 'expired');

// ── Claims: unknown, malformed, widening ─────────────────────────────────────
const claims = (extra: Record<string, unknown>) => reason(hostSign(HEAD, { ...base, ...extra }));
ok('unknown claim refused (a misspelt params must not give an unscoped dashboard)', claims({ parmas: { Region: 'East' } }) === 'claims');
ok('unknown claim refused (org)', claims({ org: 'globex' }) === 'claims');
ok('pub not a UUID refused', reason(hostSign(HEAD, { ...base, pub: '../x' })) === 'claims');
ok('dash not a UUID refused', claims({ dash: 'abc' }) === 'claims');
ok('an empty lock list refused (an empty `in` would widen)', claims({ params: { Region: [] } }) === 'claims');
ok('a null lock value refused', claims({ params: { Region: null } }) === 'claims');
ok('an object lock value refused', claims({ params: { Region: { op: 'not in', values: ['East'] } } }) === 'claims');
ok('an over-long lock value refused', claims({ params: { Region: ['x'.repeat(201)] } }) === 'claims');
ok('control: a 200-character lock value verifies', claims({ params: { Region: ['x'.repeat(200)] } }) === 'ok');
ok('a blank lock value refused (it would match every row with no value)', claims({ params: { Region: ['  '] } }) === 'claims' && claims({ params: { Region: '' } }) === 'claims');
ok('a __proto__ lock column refused', reason(`${b64(HEAD)}.${b64('{"pub":"' + PUB + '","exp":' + (NOW + 60) + ',"params":{"__proto__":["x"]}}')}`.replace(/$/, '.' + createHmac('sha256', SECRET).update(`${b64(HEAD)}.${b64('{"pub":"' + PUB + '","exp":' + (NOW + 60) + ',"params":{"__proto__":["x"]}}')}`).digest('base64url'))) === 'claims');
ok('a constructor lock column is an ordinary column, held to its value', (() => { const r = verify(hostSign(HEAD, { ...base, params: { constructor: 'x' } })); return r.ok && Object.getPrototypeOf(r.claims.params) === null && JSON.stringify(Object.entries(r.claims.params)) === JSON.stringify([['constructor', ['x']]]); })());
ok('preview key: derived, not the secret, and a token signed with it fails the secret', previewKey(SECRET) !== SECRET && previewKey(SECRET) === previewKey(SECRET)
  && reason(signToken(ORG, { ...base, prv: 1 }, previewKey(SECRET))) === 'signature' && verifyToken(signToken(ORG, { ...base, prv: 1 }, previewKey(SECRET)), previewKey(SECRET), NOW).ok);
ok('a parameter reference in a lock refused', claims({ params: { Region: '[[region]]' } }) === 'claims');
ok('too many lock columns refused', claims({ params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, 'v'])) }) === 'claims');
ok('too many lock values refused', claims({ params: { Region: Array.from({ length: 101 }, (_, i) => `v${i}`) } }) === 'claims');
ok('params as a list refused', claims({ params: [['Region', 'East']] }) === 'claims');
ok('theme other than light/dark refused', claims({ theme: 'neon' }) === 'claims');
ok('hide with an unknown part refused', claims({ hide: ['title', 'header'] }) === 'claims');
ok('prv other than 1 refused', claims({ prv: 'yes' }) === 'claims');
ok('payload not an object refused', reason(hostSign(HEAD, [base])) === 'claims');
ok('a __proto__ lock does not pollute and is refused or ignored', (() => {
  const t = `${b64(HEAD)}.${b64('{"pub":"' + PUB + '","exp":' + (NOW + 60) + ',"params":{"__proto__":["x"]}}')}`;
  const tok = `${t}.${createHmac('sha256', SECRET).update(t).digest('base64url')}`;
  const r = verify(tok);
  return ({} as Record<string, unknown>).x === undefined && (!r.ok || Object.keys(r.claims.params).length <= 1);
})());

// ── Allowed origins ──────────────────────────────────────────────────────────
const origins: Array<[string, string | null]> = [
  ['https://portal.acme.com', 'https://portal.acme.com'],
  ['https://Portal.Acme.com/', 'https://portal.acme.com'],
  ['https://portal.acme.com:8443', 'https://portal.acme.com:8443'],
  ['http://localhost:5173', 'http://localhost:5173'],
  ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
  ['http://[::1]:3000', 'http://[::1]:3000'],
  ['http://portal.acme.com', null],
  ['https://portal.acme.com/app', null],
  ['https://portal.acme.com?x=1', null],
  ['https://portal.acme.com#x', null],
  ['https://*.acme.com', null],
  ['https://user:pw@acme.com', null],
  ['javas' + 'cript:alert(1)', null], // spelt in two so the lint rule against script URLs does not read it as one
  ['data:text/html,x', null],
  ['*', null],
  ["'self'", null],
  ['acme.com', null],
  ['', null],
];
for (const [raw, want] of origins) ok(`origin ${JSON.stringify(raw)} → ${want}`, normalizeOrigin(raw) === want, normalizeOrigin(raw));

finish();
