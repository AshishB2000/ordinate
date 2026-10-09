// Self-check for the Snowflake connector (src/connectors/snowflake*.ts), plan
// L1.2 / L1.5. The SQL API is HTTPS-only, so — the Databricks precedent — the
// protocol runs against a FAKE transport (scripts/snowflakeFake.ts) answering
// from recorded JSON fixtures, and the pure parts (request, JWT claims,
// bindings, shaping) are called directly. The real socket layer has its own
// suite against a local server (test-connectorsSnowflakeHttp).
//
//   1. the account → host guard (R-L4), with a negative control
//   2. the request: URL, headers, body, QUERY_TAG; PAT and key-pair sign-in;
//      JWT claims verified with crypto.verify; the JWT cache per org
//   3. bindings: every type, refusals, an adversarial literal suite
//   4. shaping: every rowType, epoch dates/timestamps incl. TZ offsets, U+FEFF,
//      ids past 15 digits, REAL for extract vs live — and through connectionRun
//   5. the protocol: the F3 cap, 202 polling, partitions, truncation, errors,
//      cancel on abort (in a poll and mid-submit), on timeout
//   6. listTables (with the admin-role warning) and describeTable (bound names)
//   7. a SECRET CANARY: a private key, its passphrase and a PAT, grepped for in
//      every output, error, request and log line
//
//   npm run build:ts && node scripts/test-connectorsSnowflake.js

export {}; // module scope — sibling test scripts share top-level names
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'crypto';
import { ok, finish } from './selfcheck';
import { FakeSnowflake, HANDLE, deferred, fixture, reply, until } from './snowflakeFake';

let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

const sf: typeof import('../src/connectors/snowflake') = require('../src/connectors/snowflake');
const auth: typeof import('../src/connectors/snowflakeAuth') = require('../src/connectors/snowflakeAuth');
const shape: typeof import('../src/connectors/snowflakeShape') = require('../src/connectors/snowflakeShape');
const sql: typeof import('../src/connectors/snowflakeSql') = require('../src/connectors/snowflakeSql');
const registry: typeof import('../src/connectors') = require('../src/connectors');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const context: typeof import('../src/server/context') = require('../src/server/context');
const messages: typeof import('../src/connectors/connectorMessages') = require('../src/connectors/connectorMessages');
const types: typeof import('../src/connectors/types') = require('../src/connectors/types');

type Ctx = import('../src/connectors/types').ConnectorContext;
type Rows = import('../src/connectors/types').ConnectorRows;
type LiveParam = import('../src/connectors/types').LiveParam;

// ── the canaries ─────────────────────────────────────────────────────────────
const PASSPHRASE = `Pass/phrase+${randomBytes(6).toString('hex')}=x`;
const PAT = `ver:1-hint:12345-${randomBytes(24).toString('base64url')}`;
const { privateKey: KEY, publicKey: PUB } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
});
const PLAIN_KEY = createPrivateKey({ key: KEY, passphrase: PASSPHRASE }).export({ type: 'pkcs8', format: 'pem' }).toString();

/** Every spelling a leak could take (as test-connections-server): plain, URL-encoded, hex, base64 at 3 alignments. */
function spellings(v: string): string[] {
  const b = Buffer.from(v);
  const out = new Set<string>([v, encodeURIComponent(v), b.toString('hex')]);
  for (let off = 0; off < 3; off++) {
    const sub = b.subarray(off);
    const whole = sub.subarray(0, sub.length - (sub.length % 3));
    out.add(whole.toString('base64'));
    out.add(whole.toString('base64url'));
  }
  return [...out].filter((x) => x.length >= 8).map((x) => x.toLowerCase());
}
/** A PEM leaks if any body line of it does. */
const pemLines = (pem: string): string[] => pem.split('\n').filter((l) => l.length >= 40 && !l.startsWith('-----')).map((l) => l.toLowerCase());
const NEEDLES = [...spellings(PASSPHRASE), ...spellings(PAT), ...pemLines(KEY), ...pemLines(PLAIN_KEY)];
const leaks = (hay: string): boolean => NEEDLES.some((n) => hay.toLowerCase().includes(n));
const outputs: string[] = [];
const keep = <T>(v: T): T => (outputs.push(JSON.stringify(v)), v);

const def = registry.getConnector('snowflake')!;
const VALUES = { account: 'MyOrg-MyAccount', user: 'reader', auth: 'keypair', warehouse: 'COMPUTE_WH', role: 'ORDINATE_READER', database: 'SALES', schema: 'PUBLIC' };
const KP = { token: KEY, password: PASSPHRASE };
const PATS = { token: PAT };
const ctxOf = (values: Record<string, unknown> = {}, secrets: Record<string, string> = KP, extra: Partial<Ctx> = {}): Ctx =>
  ({ values: { ...VALUES, ...values }, secrets, rowLimit: 1000, timeoutMs: 5_000, ...extra });
const inOrg = <T>(org: string, fn: () => T): T => context.runInContext({ user: { email: 'a@acme.test', role: 'admin' }, org: { id: org } }, 'req', fn);
const jwtParts = (jwt: string): { head: Record<string, unknown>; claims: Record<string, unknown>; input: string; sig: Buffer } => {
  const [h, p, s] = jwt.split('.');
  return { head: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(p, 'base64url').toString()), input: `${h}.${p}`, sig: Buffer.from(s, 'base64url') };
};

const fake = new FakeSnowflake();
sf.setTransport(fake.transport);

async function main(): Promise<void> {
  ok('grep: the canary spellings are found when planted (negative control)', leaks(`x ${encodeURIComponent(PASSPHRASE)} y`) && leaks(KEY) && leaks(PLAIN_KEY.slice(40, 200)) && !leaks('nothing ' + randomBytes(24).toString('base64')));

  // ── 1. account → host (R-L4) ───────────────────────────────────────────────
  const host = (a: string, link = false): string => { const r = auth.accountOrigin(a, link); return r.ok ? r.origin.href : `refused: ${r.error}`; };
  ok('account: case-insensitive, lowered; we build the host', host('MyOrg-MyAccount') === 'https://myorg-myaccount.snowflakecomputing.com/');
  ok('account: a locator with region', host('xy12345.us-east-2.aws') === 'https://xy12345.us-east-2.aws.snowflakecomputing.com/');
  ok('account: privatelink', host('xy12345.us-east-2.aws', true) === 'https://xy12345.us-east-2.aws.privatelink.snowflakecomputing.com/');
  ok('account: a pasted hostname is reduced to its identifier', host('XY12345.snowflakecomputing.com') === 'https://xy12345.snowflakecomputing.com/');
  const bad = ['evil.com/', 'a@b', '..', 'a..b', '.a', 'a.', '', '  ', 'https://x.snowflakecomputing.com', 'a b', 'a.b.c.d.e', 'x/../y', 'a:443', '127.0.0.1:80',
    '%2e', 'ａbc', 'a\u0000b', 'a#b', 'a?b', 'a\\b', 'x'.repeat(201)];
  const accepted = bad.filter((a) => auth.accountOrigin(a, false).ok);
  ok(`account: ${bad.length} non-identifiers refused (a URL, a path, @, empty parts, unicode, a port, …)`, accepted.length === 0, JSON.stringify(accepted));
  ok('account: the refusal names the rule, not the input', !host('evil.com/').includes('evil'));
  let fuzzOk = true;
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: 1 + (i % 24) }, () => 'aZ0._-/@:?#%\\ .x'[Math.floor(Math.random() * 16)]).join('');
    const r = auth.accountOrigin(s, i % 2 === 0);
    if (r.ok && (!r.origin.hostname.endsWith('.snowflakecomputing.com') || r.origin.protocol !== 'https:' || r.origin.port !== '' || r.origin.pathname !== '/')) fuzzOk = false;
  }
  ok('account: 2,000 fuzzed inputs — every accepted one is an https subdomain of snowflakecomputing.com', fuzzOk);
  ok('negative control: without the guard, "evil.com/" + our suffix names evil.com', new URL('https://evil.com/.snowflakecomputing.com/').hostname === 'evil.com');
  ok('account: the JWT account is the first part, upper-cased (no region)', (auth.accountOrigin('xy12345.us-east-2.aws', false) as { jwtAccount: string }).jwtAccount === 'XY12345'
    && (auth.accountOrigin('MyOrg-MyAccount', false) as { jwtAccount: string }).jwtAccount === 'MYORG-MYACCOUNT');

  // ── 2. the request, sign-in, JWT ───────────────────────────────────────────
  const patReq = sf.buildRequest(ctxOf({ auth: 'pat' }, PATS), 'select 1', { requestId: '11111111-2222-4333-8444-555555555555' });
  ok('request: built', patReq.ok, JSON.stringify(patReq));
  if (patReq.ok) {
    const body = JSON.parse(patReq.body) as Record<string, any>; // any: the request body, read field by field
    ok('request: POST /api/v2/statements?requestId=<uuid> on our origin', patReq.url.href === 'https://myorg-myaccount.snowflakecomputing.com/api/v2/statements?requestId=11111111-2222-4333-8444-555555555555');
    ok('request: PAT as the bearer, typed PROGRAMMATIC_ACCESS_TOKEN', patReq.headers.authorization === `Bearer ${PAT}` && patReq.headers['x-snowflake-authorization-token-type'] === 'PROGRAMMATIC_ACCESS_TOKEN');
    ok('request: statement, timeout (s), warehouse, role, database, schema', body.statement === 'select 1' && body.timeout === 5 && body.warehouse === 'COMPUTE_WH' && body.role === 'ORDINATE_READER' && body.database === 'SALES' && body.schema === 'PUBLIC');
    ok('request: QUERY_TAG ordinate:<org>, WEEK_START 1, TIMEZONE UTC, one statement', JSON.stringify(body.parameters) === JSON.stringify({ QUERY_TAG: 'ordinate:desktop', WEEK_START: 1, TIMEZONE: 'UTC', MULTI_STATEMENT_COUNT: 1 }), JSON.stringify(body.parameters));
    ok('request: no bindings key without parameters', !('bindings' in body));
  }
  const tagged = inOrg('acme', () => sf.buildRequest(ctxOf({ auth: 'pat' }, PATS, { costTag: 'live' }), 'select 1'));
  ok('request: QUERY_TAG carries the request\'s org and the cost tag', tagged.ok && JSON.parse(tagged.body).parameters.QUERY_TAG === 'ordinate:acme:live');
  const refuse = (values: Record<string, unknown>, secrets: Record<string, string>): string => { const r = sf.buildRequest(ctxOf(values, secrets), 'select 1'); return r.ok ? 'built' : r.error; };
  ok('request: warehouse and role are required', /Warehouse/.test(refuse({ warehouse: '' }, PATS)) && /Role/.test(refuse({ role: ' ' }, PATS)));
  ok('sign-in: a private key in the PAT slot is refused — never sent as a bearer', /private key/i.test(refuse({ auth: 'pat' }, { token: PLAIN_KEY })));
  ok('sign-in: a PAT with a line break is refused', /no spaces/.test(refuse({ auth: 'pat' }, { token: 'abc\ndef' })));
  ok('sign-in: key pair needs a user and a key', /User/.test(refuse({ user: '' }, KP)) && /Private key is required/.test(refuse({}, { token: '' })));
  ok('sign-in: a wrong passphrase is refused without the key in the message', /could not be read/.test(refuse({}, { token: KEY, password: 'wrong' })) && !leaks(refuse({}, { token: KEY, password: 'wrong' })));
  ok('sign-in: an encrypted key without its passphrase is refused', /could not be read/.test(refuse({}, { token: KEY })));

  auth.clearJwtCache();
  const t0 = Date.UTC(2026, 9, 9, 12, 0, 0);
  const kp = inOrg('acme', () => sf.buildRequest(ctxOf(), 'select 1', { nowMs: t0 }));
  ok('jwt: built with the encrypted key and its passphrase', kp.ok, JSON.stringify(kp));
  if (kp.ok) {
    const jwt = kp.headers.authorization.replace(/^Bearer /, '');
    const { head, claims, input, sig } = jwtParts(jwt);
    const fp = 'SHA256:' + createHash('sha256').update(createPublicKey(PUB).export({ type: 'spki', format: 'der' })).digest('base64');
    ok('jwt: typed KEYPAIR_JWT, RS256', kp.headers['x-snowflake-authorization-token-type'] === 'KEYPAIR_JWT' && head.alg === 'RS256' && head.typ === 'JWT');
    ok('jwt: iss = ACCOUNT.USER.SHA256:<fingerprint>, sub = ACCOUNT.USER', claims.iss === `MYORG-MYACCOUNT.READER.${fp}` && claims.sub === 'MYORG-MYACCOUNT.READER', JSON.stringify(claims));
    ok('jwt: iat now, lifetime ≤ 1 h (59 min)', claims.iat === t0 / 1000 && (claims.exp as number) - (claims.iat as number) === 3540);
    ok('jwt: the signature verifies against the PUBLIC key (crypto.verify)', verify('sha256', Buffer.from(input), PUB, sig));
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'MYORG-MYACCOUNT.ADMIN' })).toString('base64url');
    ok('jwt: negative control — a changed claim does not verify', !verify('sha256', Buffer.from(`${input.split('.')[0]}.${forged}`), PUB, sig));
    ok('jwt: no part of the private key or passphrase is in it', !leaks(jwt));
    const again = inOrg('acme', () => sf.buildRequest(ctxOf(), 'select 2', { nowMs: t0 + 60_000 }));
    ok('jwt cache: a minute later, the same org reuses it', again.ok && again.headers.authorization === kp.headers.authorization);
    const other = inOrg('globex', () => sf.buildRequest(ctxOf(), 'select 2', { nowMs: t0 + 60_000 }));
    ok('jwt cache: keyed by orgKey() — another org signs its own', other.ok && jwtParts(other.auth.token).claims.iat === t0 / 1000 + 60);
    const late = inOrg('acme', () => sf.buildRequest(ctxOf(), 'select 3', { nowMs: t0 + 56 * 60_000 }));
    ok('jwt cache: re-signed once less than 5 minutes are left', late.ok && jwtParts(late.auth.token).claims.iat === t0 / 1000 + 56 * 60);
  }
  const loc = sf.buildRequest(ctxOf({ account: 'XY12345.us-east-2.aws' }, { token: PLAIN_KEY }), 'select 1', { nowMs: t0 });
  ok('jwt: a locator\'s region is left out of iss; an unencrypted key needs no passphrase', loc.ok && String(jwtParts(loc.auth.token).claims.iss).startsWith('XY12345.READER.SHA256:'));

  // ── 3. bindings ───────────────────────────────────────────────────────────
  const P = (type: LiveParam['type'], value: LiveParam['value']): LiveParam => ({ name: 'p', type, value });
  const b = sql.buildBindings([P('text', 'North'), P('number', 42), P('number', 2.5), P('boolean', false), P('date', '2024-03-01'),
    P('timestamp', '2024-03-01T12:34:56.123456789Z'), P('timestamp', '1969-12-31T23:59:59.9995Z'), P('text', null), P('number', null)]);
  ok('bindings: text, FIXED, REAL, BOOLEAN, DATE (epoch ms), TIMESTAMP_NTZ (epoch ns), nulls', b.ok && JSON.stringify(b.bindings) === JSON.stringify({
    1: { type: 'TEXT', value: 'North' }, 2: { type: 'FIXED', value: '42' }, 3: { type: 'REAL', value: '2.5' }, 4: { type: 'BOOLEAN', value: 'false' },
    5: { type: 'DATE', value: String(Date.UTC(2024, 2, 1)) }, 6: { type: 'TIMESTAMP_NTZ', value: '1709296496123456789' },
    7: { type: 'TIMESTAMP_NTZ', value: '-500000' }, 8: { type: 'TEXT', value: null }, 9: { type: 'FIXED', value: null },
  }), b.ok ? JSON.stringify(b.bindings) : b.error);
  const refused = [P('number', NaN), P('number', Infinity), P('number', '1'), P('date', '2024-02-30'), P('date', '2024-3-1'), P('timestamp', 'yesterday'), P('boolean', 'true')]
    .filter((p) => sql.buildBindings([p]).ok);
  ok('bindings: NaN, Infinity, a string number, an impossible date, a non-ISO date or timestamp, a string boolean are refused', refused.length === 0, JSON.stringify(refused));
  ok('placeholders: counted outside strings, quoted names and comments', sql.countPlaceholders(`select '?', "a?b", ? -- ?\n/* ? */ from t where x = ? and y = 'it''s ?' and z = $$?$$`) === 2);

  const NASTY = ["'; drop table orders; --", "\\'", '’ or ‘1’=‘1', '${process.exit()}', 'a\u0000b', '?', '$$ select 1 $$', 'line\nbreak', '\uFEFFbom', '"quoted"', '/* c */', '\\', ''];
  const nastySql = 'select count(*) as n from orders where ' + NASTY.map(() => 'region = ?').join(' or ');
  fake.answer = (_r, kind) => kind === 'cancel' ? reply(200, fixture('cancel-200')) : reply(200, fixture('result-types'));
  const nr = keep(await def.live!.runBound(ctxOf({}, KP, { costTag: 'live' }), nastySql, NASTY.map((v, i) => ({ name: `p${i}`, type: 'text' as const, value: v }))));
  const nastyBody = fake.of('submit').at(-1)!;
  const nastyJson = nastyBody.json ?? {};
  const bound = nastyJson.bindings as Record<string, { type: string; value: string }>;
  ok('adversarial literals: the statement sent is exactly the compiled SQL inside the cap — no value inlined', nr.ok && nastyBody.json?.statement === sql.cappedStatement(nastySql, 1000));
  ok(`adversarial literals: all ${NASTY.length} values travel as bindings, byte for byte (Object.is)`, NASTY.every((v, i) => Object.is(bound[String(i + 1)].value, v) && bound[String(i + 1)].type === 'TEXT'));
  ok('runBound: QUERY_TAG says live', (nastyJson.parameters as Record<string, unknown>).QUERY_TAG === 'ordinate:desktop:live');
  const before = fake.seen.length;
  const mismatch = keep(await def.live!.runBound(ctxOf(), 'select ? from t', []));
  ok('runBound: placeholders ≠ parameters is refused before any request (negative control: nothing sent)', !mismatch.ok && fake.seen.length === before);

  // ── 4. shaping ────────────────────────────────────────────────────────────
  const allTypes = JSON.parse(fixture('result-types'));
  const ex = shape.shapeFirst(allTypes, 'extract');
  const live = shape.shapeFirst(allTypes, 'live');
  if (ex.ok && live.ok) {
    const cols = shape.connectorColumns(ex.columns);
    ok('types: source names', cols.map((c) => c.type).join() === 'NUMBER(38,0),NUMBER(9,0),NUMBER(12,2),FLOAT,VARCHAR,DATE,TIME,TIMESTAMP_NTZ,TIMESTAMP_LTZ,TIMESTAMP_TZ,BOOLEAN,VARIANT');
    ok('types: declared from rowType (NUMBER(38,0) left to parse.ts)', cols.map((c) => c.columnType ?? '-').join() === '-,number,number,number,text,date,text,date,date,date,text,text', cols.map((c) => c.columnType ?? '-').join());
    const [r0, r1, r2] = ex.rows;
    ok('ids past 15 digits stay text (the exact string)', r0[0] === '12345678901234567890' && r1[0] === '7');
    ok('FIXED(p ≤ 15) is a number', r0[1] === 3 && r0[2] === 1234.5 && Object.is(r1[2], -4) && r2[1] === null);
    ok('REAL: extract prints 15 significant digits; live keeps the exact double', r0[3] === 0.3 && Object.is(live.rows[0][3], 0.30000000000000004) && Number.isNaN(r1[3]));
    ok('a leading U+FEFF survives; "007" stays text', r0[4] === '\uFEFFAcme' && (r0[4] as string).charCodeAt(0) === 0xfeff && r1[4] === '007');
    ok('DATE: epoch days → ISO', r0[5] === '2019-03-27' && r1[5] === '1969-12-31');
    ok('TIME: seconds since midnight', r0[6] === '23:01:59' && r1[6] === '01:00:00.5');
    ok('TIMESTAMP_NTZ / LTZ: epoch seconds → UTC ISO (ms), negatives floored', r0[7] === '2021-03-19T17:06:59.000Z' && r0[8] === '2023-11-14T22:13:20.123Z' && r1[7] === '1969-12-31T23:59:58.500Z' && r1[8] === '1970-01-01T00:00:00.000Z');
    ok('TIMESTAMP_TZ: offsets +01:00, -06:00 and UTC are the same instant in UTC', [r0[9], r1[9], r2[9]].every((v) => v === '2021-03-19T17:06:59.000Z'), JSON.stringify([r0[9], r1[9], r2[9]]));
    ok('BOOLEAN; VARIANT compacted losslessly (no number re-printed)', r0[10] === true && r1[10] === false && r0[11] === '{"a":1,"b":["x y",12345678901234567890]}' && r1[11] === '"plain \\"quoted\\" text"');
    ok('nulls stay null', r2.slice(1, 9).every((v) => v === null) && r2[11] === null);
  } else ok('shapeFirst shapes the all-types fixture', false, JSON.stringify(ex));
  ok('a non-jsonv2 result is refused', !shape.shapeFirst({ resultSetMetaData: { format: 'arrowv1', rowType: [] } }, 'extract').ok);
  ok('epoch helpers refuse what they cannot read (passed through as text)', shape.epochSecondsToIso('1e9') === null && shape.timestampTzToIso('2021-03-19 17:06') === null && shape.epochDaysToIso('99999999') === null);

  fake.answer = (_r, kind) => kind === 'cancel' ? reply(200, fixture('cancel-200')) : reply(200, fixture('result-types'));
  const pr = keep(await connectionRun.runConnection('snowflake', VALUES, KP, { query: 'select * from orders' }, { rowLimit: 10 }));
  if (pr.ok) {
    const t = Object.fromEntries(pr.result.columns.map((c) => [c.name, c.type]));
    ok('through connectionRun: a 20-digit id column is text, amounts and REAL numbers, timestamps dates, the payload text', t.ORDER_ID === 'text' && t.QTY === 'number' && t.AMOUNT === 'number' && t.RATIO === 'number' && t.NAME === 'text' && t.ORDERED_ON === 'date' && t.CREATED_TZ === 'date' && t.PAYLOAD === 'text', JSON.stringify(t));
    ok('through connectionRun: 0.3 kept as a number (not nulled), U+FEFF kept', pr.result.rows[0][3] === 0.3 && pr.result.rows[0][4] === '\uFEFFAcme');
  } else ok('runConnection over the fake', false, pr.error);
  fake.answer = (r, kind) => kind === 'submit' ? reply(200, fixture('result-partitioned')) : reply(200, fixture(`partition-${r.url.searchParams.get('partition')}`));
  const small = keep(await connectionRun.runConnection('snowflake', VALUES, KP, { query: 'select id, region from orders' }));
  ok('through connectionRun: a NUMBER(38,0) column of small values is a number (parse.ts decides)', small.ok && small.result.columns[0].type === 'number' && small.result.rows[7][0] === 8);

  // ── 5. the protocol ───────────────────────────────────────────────────────
  fake.seen = [];
  const all = keep(await def.run(ctxOf(), 'select id, region from orders -- a trailing comment;'));
  ok('F3: the user SQL sits on its own line inside the cap (a trailing comment cannot eat it)', fake.statements()[0] === 'select * from (\nselect id, region from orders -- a trailing comment\n) limit 1001');
  ok('partitions: 0 inline, then ?partition=1 and 2 in order, on our origin', fake.of('partition').map((s) => s.url.href).join() === [1, 2].map((p) => `https://myorg-myaccount.snowflakecomputing.com/api/v2/statements/${HANDLE}?partition=${p}`).join());
  ok('partitions: 8 rows in order, not truncated', all.ok && (all as Rows).rows.map((r) => r[0]).join() === '1,2,3,4,5,6,7,8' && !(all as Rows).truncated);
  fake.seen = [];
  const capped = keep(await def.run(ctxOf({}, KP, { rowLimit: 4 }), 'select id, region from orders'));
  ok('cap: rows stop at N, truncated reported; partition 2 is never read', capped.ok && (capped as Rows).rows.length === 4 && (capped as Rows).truncated && fake.of('partition').length === 1 && fake.statements()[0].endsWith(') limit 5'));
  const atCap = keep(await def.run(ctxOf({}, KP, { rowLimit: 8 }), 'select id, region from orders'));
  ok('cap: exactly N rows is not truncated', atCap.ok && (atCap as Rows).rows.length === 8 && !(atCap as Rows).truncated);

  fake.seen = [];
  let polls = 0;
  fake.answer = (r, kind) => {
    if (kind === 'submit') return reply(202, fixture('async-202').replace('"/api/v2/statements/', '"https://evil.example/api/v2/statements/'));
    if (kind === 'status') return ++polls < 3 ? reply(202, fixture('async-202')) : reply(200, fixture('result-types'));
    return reply(200, fixture('cancel-200'));
  };
  const polled = keep(await def.run(ctxOf(), 'select 1'));
  ok('202: polled until 200, at the handle on OUR origin (a foreign statementStatusUrl host is ignored)', polled.ok && polls === 3 && fake.of('status').every((s) => s.url.origin === 'https://myorg-myaccount.snowflakecomputing.com' && s.url.pathname === `/api/v2/statements/${HANDLE}`));

  fake.answer = (_r, kind) => kind === 'submit' ? reply(422, fixture('failure-422')) : reply(200, '{}');
  const failed = keep(await def.run(ctxOf(), 'select * form t'));
  ok('422: the statement\'s own error, with its code', !failed.ok && failed.error.startsWith('Snowflake error 001003: SQL compilation error'), JSON.stringify(failed));
  fake.answer = () => reply(401, fixture('unauthorized-401'));
  const denied = keep(await def.run(ctxOf(), 'select 1'));
  ok('401: "refused the sign-in" with Snowflake\'s reason', !denied.ok && /refused the sign-in \(HTTP 401\): JWT token is invalid/.test(denied.error));
  fake.answer = () => reply(200, '{"resultSetMetaData": {"rowType": [', true);
  const clipped = keep(await def.run(ctxOf(), 'select 1'));
  ok('a body clipped by the byte ceiling is an error, not a guess', !clipped.ok && /100 MB/.test(clipped.error));

  // Cancel on abort while polling.
  fake.seen = [];
  fake.answer = (_r, kind) => kind === 'submit' ? reply(202, fixture('async-202')) : kind === 'status' ? new Promise(() => undefined) : reply(200, fixture('cancel-200'));
  const ac = new AbortController();
  const pending = def.run(ctxOf({}, KP, { signal: ac.signal }), 'select 1');
  await until(() => fake.of('status').length > 0);
  ac.abort();
  const aborted = keep(await pending);
  ok('abort while polling: cancelled, and POST …/<handle>/cancel was sent', !aborted.ok && /cancelled/.test(aborted.error) && fake.of('cancel').length === 1 && fake.of('cancel')[0].url.href === `https://myorg-myaccount.snowflakecomputing.com/api/v2/statements/${HANDLE}/cancel`, JSON.stringify(aborted));
  // Abort mid-submit: no handle yet — answered at once, cancelled when the 202 lands.
  fake.seen = [];
  const sub = deferred<import('../src/connectors/snowflakeHttp').SfHttpResponse>();
  fake.answer = (_r, kind) => kind === 'submit' ? sub.promise : reply(200, fixture('cancel-200'));
  const ac2 = new AbortController();
  const pending2 = def.run(ctxOf({}, KP, { signal: ac2.signal }), 'select 1');
  await until(() => fake.of('submit').length === 1);
  const t1 = Date.now();
  ac2.abort();
  const early = keep(await pending2);
  ok('abort mid-submit: the caller is answered at once', !early.ok && /cancelled/.test(early.error) && Date.now() - t1 < 500 && fake.of('cancel').length === 0);
  sub.resolve(reply(202, fixture('async-202')));
  ok('abort mid-submit: the statement is cancelled as soon as its handle arrives', await until(() => fake.of('cancel').length === 1));
  // Timeout while polling.
  fake.seen = [];
  fake.answer = (_r, kind) => kind === 'cancel' ? reply(200, fixture('cancel-200')) : reply(202, fixture('async-202'));
  const slow = keep(await def.run(ctxOf({}, KP, { timeoutMs: 600 }), 'select system$wait(10)'));
  ok('timeout: past the deadline the statement is cancelled and the caller told', !slow.ok && /timed out after 1s/.test(slow.error) && fake.of('cancel').length === 1 && (fake.of('submit')[0].json?.timeout === 1));
  fake.seen = [];
  const pre = new AbortController();
  pre.abort();
  const never = keep(await def.run(ctxOf({}, KP, { signal: pre.signal }), 'select 1'));
  ok('an already-aborted caller sends nothing', !never.ok && fake.seen.length === 0);

  // ── 6. listTables, describeTable ──────────────────────────────────────────
  fake.seen = [];
  fake.answer = (_r, kind) => kind === 'submit' ? reply(200, fixture('information-schema-tables')) : reply(200, '{}');
  const listed = keep(await def.listTables(ctxOf()));
  ok('listTables (database set): INFORMATION_SCHEMA, schema.table', listed.ok && JSON.stringify(listed.tables) === JSON.stringify([{ schema: 'PUBLIC', name: 'CUSTOMERS' }, { schema: 'PUBLIC', name: 'ORDERS' }, { schema: 'RAW', name: 'EVENTS' }]) && /information_schema\.tables/.test(fake.statements()[0]) && !listed.warnings);
  fake.answer = (_r, kind) => kind === 'submit' ? reply(200, fixture('show-tables')) : reply(200, '{}');
  const acct = keep(await connectionRun.listTables('snowflake', { ...VALUES, database: '', role: 'accountadmin' }, KP));
  ok('listTables (no database): SHOW TERSE TABLES, DB.SCHEMA as the schema', acct.ok && fake.statements().at(-1) === 'show terse tables in account limit 1000' && JSON.stringify(acct.tables[2]) === JSON.stringify({ schema: 'analytics_db.reporting', name: 'orders' }));
  ok('connectionRun quotes those exactly: "DB"."SCHEMA"."TABLE"', connectionRun.buildTableSql('snowflake', 'analytics_db.reporting.orders', 10) === 'select * from "analytics_db"."reporting"."orders" limit 10' && connectionRun.buildTableSql('snowflake', 'PUBLIC.ORDERS', 5) === 'select * from "PUBLIC"."ORDERS" limit 5');
  ok('test connection: an admin role (any case) is WARNED about, through the catalog', acct.ok && acct.warnings?.length === 1 && acct.warnings[0] === messages.adminRoleWarning('ACCOUNTADMIN') && /ACCOUNTADMIN role/.test(acct.warnings[0]));
  const tested = keep(await connectionRun.testConnection('snowflake', { ...VALUES, role: 'SYSADMIN' }, KP));
  ok('testConnection carries the warning; SECURITYADMIN too; a reader role is not warned', tested.ok && tested.warnings?.[0] === messages.adminRoleWarning('SYSADMIN') && sf.adminRole('"securityadmin"') === 'SECURITYADMIN' && sf.adminRole('ORDINATE_READER') === null);

  fake.seen = [];
  fake.answer = (_r, kind) => kind === 'submit' ? reply(200, fixture('describe-columns')) : reply(200, '{}');
  const desc = keep(await def.describeTable!(ctxOf(), "PUBLIC.x' or '1'='1"));
  const ds = fake.of('submit')[0].json!;
  ok('describeTable: schema and table name are BOUND, never in the statement', !String(ds.statement).includes("'1'='1") && JSON.stringify(ds.bindings) === JSON.stringify({ 1: { type: 'TEXT', value: 'PUBLIC' }, 2: { type: 'TEXT', value: "x' or '1'='1" } }));
  ok('describeTable: columns, NUMBER(p,s), nullability, the row estimate', desc.ok && desc.columns.map((c) => `${c.name}:${c.type}:${c.nullable}`).join() === 'ORDER_ID:NUMBER(38,0):false,REGION:TEXT:true,CREATED_AT:TIMESTAMP_TZ:true' && desc.rowEstimate === 1_250_000);
  const n0 = fake.seen.length;
  const badDb = keep(await def.describeTable!(ctxOf(), 'a"b.PUBLIC.ORDERS'));
  ok('describeTable: a database part that is not an identifier is refused before any request', !badDb.ok && fake.seen.length === n0);
  ok('describeTable: one-part names use current_schema()', (await def.describeTable!(ctxOf(), 'ORDERS')).ok && /current_schema\(\)/.test(fake.statements().at(-1)!));

  // ── 7. the secret canary ──────────────────────────────────────────────────
  // A hostile Snowflake echoing the bearer and the secrets back in an error body.
  fake.seen = [];
  const jwtNow = sf.buildRequest(ctxOf(), 'select 1');
  const bearer = jwtNow.ok ? jwtNow.auth.token : 'none';
  // (Each echoes ITS OWN connection's secrets — another connection's are not this one's to know.)
  fake.answer = (r) => {
    const own = r.headers['x-snowflake-authorization-token-type'] === 'PROGRAMMATIC_ACCESS_TOKEN' ? PAT : PASSPHRASE;
    return reply(422, JSON.stringify({ code: '000001', message: `echo ${r.headers.authorization} ${own}`, statementHandle: HANDLE }));
  };
  const echoed = [keep(await def.run(ctxOf(), 'select 1')), keep(await def.run(ctxOf({ auth: 'pat' }, PATS), 'select 1')), keep(await def.listTables(ctxOf({ auth: 'pat' }, PATS)))];
  // The JWT's claims and signature are the part that grants access (its header is the same for every RS256 token).
  const sigPart = bearer.split('.').slice(1).join('.').slice(0, 60);
  ok('canary: an error echoing the bearer and the secrets is redacted', echoed.every((r) => !r.ok && r.error.includes('***')) && !echoed.some((r) => JSON.stringify(r).includes(sigPart)));
  ok('negative control: the stored secrets alone would not redact the JWT — it is added to the set', types.safeError(`echo Bearer ${bearer}`, KP).includes(sigPart));
  const requests = fake.seen.length ? fake.seen : [];
  const reqText = (s: (typeof requests)[number], withAuth: boolean): string => `${s.url.href}\n${s.body}\n${JSON.stringify({ ...s.headers, authorization: withAuth ? s.headers.authorization : '' })}`;
  ok('canary: no private key or passphrase in any request, authorization included', fake.seen.every((s) => !leaks(reqText(s, true).replace(PAT, ''))));
  ok('canary: the PAT is only ever in the Authorization header', fake.seen.every((s) => !leaks(reqText(s, false))));
  ok(`canary: no secret in any of the ${outputs.length} results and errors`, outputs.length >= 20 && !outputs.some(leaks), outputs.findIndex(leaks));
  ok('canary: none in the catalog', !leaks(JSON.stringify(registry.connectorCatalog())));
  ok('canary: none in anything this process printed', captured.length > 1000 && !leaks(captured));
}

main()
  .catch((err) => ok('suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    sf.setTransport(null);
    finish();
  });
