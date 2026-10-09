// Google BigQuery (src/connectors/bigquery*.ts) off recorded REST replies, with
// an injected transport — no network, no account. HTTPS-only, so like
// Databricks the request and response SHAPING is exported and pinned here; the
// socket layer is http.ts's already-tested httpRequest.
//
//   • the key: token_uri pinned to Google's exactly (look-alikes refused, and
//     no request made), the JWT's claims verified with crypto.verify, the token
//     cached per key, scope and org
//   • a job: jobComplete=false polled with getQueryResults, pages followed by
//     pageToken, the cap's wrapper and truncation
//   • types: epoch TIMESTAMP → UTC ISO (exact, differential against Date),
//     ids over 15 digits stay text, a leading U+FEFF survives the dispatch
//   • read-only: the dry-run gate refuses anything but a SELECT (negative
//     control: a SELECT runs), a 403 for scopes says so
//   • named parameters: adversarial literals never reach the SQL text
//   • the catalog, the dispatch's table SQL, the editor's estimate end to end
//
// Cancel, the cost guard, hosts and the secret canary: test-bigqueryBounds.ts.
//
//   npm run build:ts && node scripts/test-connectorsBigquery.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { verify } from 'crypto';
import { assertionOf, ctxFor, fakeTransport, fixture, happy, isDry, isQuery, isResults, isToken, makeKey, PROJECT, TOKEN_URI } from './bigqueryFake';
import type { Call, Reply } from './bigqueryFake';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bq-'));

// ponytail: compiled siblings of the .ts sources.
const registry: typeof import('../src/connectors') = require('../src/connectors');
const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
const auth: typeof import('../src/connectors/bigqueryAuth') = require('../src/connectors/bigqueryAuth');
const shape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
const run: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const context: typeof import('../src/server/context') = require('../src/server/context');

const KEY = makeKey();
const def = registry.getConnector('bigquery')!;

function serve(route: (c: Call) => Reply): Call[] {
  const f = fakeTransport(route);
  bq.setTransport(f.transport);
  auth.clearTokens();
  return f.calls;
}
const ctx = (values: Record<string, unknown> = {}, extra = {}) => ctxFor(KEY, values, extra);
const errOf = (r: { ok: boolean; error?: string }): string => (r.ok ? '' : String(r.error));

async function main(): Promise<void> {
  // ── Registry ───────────────────────────────────────────────────────────────
  ok('registry: bigquery is registered, its own family, a cloud warehouse, read-only',
    !!def && def.family === 'bigquery' && def.category === 'Cloud warehouses' && def.readOnly === true, JSON.stringify(registry.registryDiagnostics().errors));
  ok('registry: two fixed hosts are declared', JSON.stringify(def.hosts) === '["bigquery.googleapis.com","oauth2.googleapis.com"]');
  ok('registry: browsable, and a live capability in the bigquery dialect with an estimate',
    typeof def.describeTable === 'function' && def.live?.dialect === 'bigquery' && typeof def.live.runBound === 'function' && typeof def.live.estimate === 'function');
  const keyField = def.fields.find((f) => f.key === 'token');
  ok('registry: the key is a secret textarea in the token slot, no default', !!keyField && keyField.secret === true && keyField.type === 'textarea' && keyField.default === undefined);
  ok('registry: fields are billing project, key, default dataset, location, max bytes', def.fields.map((f) => f.key).join() === 'project,token,dataset,location,maxBytesBilled');
  const cat = registry.connectorCatalog().find((e) => e.id === 'bigquery');
  ok('catalog: textarea survives, estimates true, hosts shown', cat?.fields.find((f) => f.key === 'token')?.type === 'textarea' && cat.estimates === true && cat.hosts?.length === 2);

  // ── The key file: token_uri pinned, nothing quoted back ───────────────────
  const good = auth.parseKey(KEY.json);
  ok('key: a Google key file parses', !('ok' in good) && good.clientEmail.endsWith('.iam.gserviceaccount.com') && good.projectId === PROJECT);
  const lookalikes = [
    'https://oauth2.googleapis.com.evil.com/token', 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/token/x',
    'https://oauth2.googleapis.com/token?aud=x', 'https://oauth2.googleapis.com/token#x', 'https://OAUTH2.googleapis.com/token',
    'https://oauth2.googleapis.com:443/token', 'https://evil.com/token', ' https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token',
    'https://oauth2.googleapis.com@evil.com/token', '',
  ];
  for (const uri of lookalikes) {
    const k = makeKey({ token_uri: uri });
    const parsed = auth.parseKey(k.json);
    const calls = serve(happy());
    const r = await def.run(ctxFor(k), 'select 1');
    ok(`key: token_uri ${JSON.stringify(uri)} is refused, and no request is made`,
      'ok' in parsed && /token_uri must be exactly/.test(parsed.error) && !r.ok && calls.length === 0 && !errOf(r).includes(k.pem.slice(40, 80)), errOf(r));
  }
  const missingUri = JSON.parse(KEY.json) as Record<string, unknown>;
  delete missingUri.token_uri;
  ok('key: a missing token_uri is refused too', 'ok' in auth.parseKey(JSON.stringify(missingUri)));
  ok('key: the exact URI is accepted (negative control)', !('ok' in auth.parseKey(makeKey({ token_uri: TOKEN_URI }).json)));
  const refusals: [string, string][] = [
    ['not JSON', KEY.json.slice(0, -5)],
    ['not a service account', makeKey({ type: 'authorized_user' }).json],
    ['no client_email', makeKey({ client_email: '' }).json],
    ['no private key', makeKey({ private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n' }).json],
    ['another universe', makeKey({ universe_domain: 'evil.example' }).json],
  ];
  for (const [why, text] of refusals) {
    const r = auth.parseKey(text);
    ok(`key: ${why} → a fixed refusal that quotes none of the file`, 'ok' in r && !r.error.includes('PRIVATE') && !r.error.includes(KEY.privateKeyId) && r.error.length < 200, JSON.stringify(r));
  }

  // ── The JWT and the exchange ───────────────────────────────────────────────
  {
    const calls = serve(happy());
    const before = Math.floor(Date.now() / 1000);
    const r = await def.run(ctx(), 'select region, orders from sales.by_region');
    ok('run: succeeds against the recorded replies', r.ok, errOf(r));
    const tok = calls.filter(isToken);
    ok('exchange: one token request, to exactly the constant TOKEN_URI, form-encoded jwt-bearer',
      tok.length === 1 && tok[0].url.href === TOKEN_URI && tok[0].method === 'POST' && tok[0].headers['content-type'] === 'application/x-www-form-urlencoded'
      && new URLSearchParams(tok[0].body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { assertion, header, claims } = assertionOf(tok[0]);
    const [h, p, s] = assertion.split('.');
    ok('jwt: the signature verifies with crypto.verify against the key\'s public half',
      verify('sha256', Buffer.from(`${h}.${p}`), KEY.publicKey, Buffer.from(s, 'base64url')));
    ok('jwt: a tampered payload does not verify (negative control)',
      !verify('sha256', Buffer.from(`${h}.${Buffer.from(JSON.stringify({ ...claims, scope: 'https://www.googleapis.com/auth/bigquery' })).toString('base64url')}`), KEY.publicKey, Buffer.from(s, 'base64url')));
    ok('jwt: header RS256 / JWT, kid = private_key_id', header.alg === 'RS256' && header.typ === 'JWT' && header.kid === KEY.privateKeyId);
    ok('jwt: iss = client_email, aud = token endpoint, one hour from now',
      claims.iss === `ordinate-reader@${PROJECT}.iam.gserviceaccount.com` && claims.aud === TOKEN_URI
      && Number(claims.iat) >= before && Number(claims.exp) - Number(claims.iat) === 3600);
    ok('jwt: the query token asks for read-only scopes only',
      claims.scope === 'https://www.googleapis.com/auth/bigquery.readonly https://www.googleapis.com/auth/cloud-platform.read-only', String(claims.scope));
    ok('jwtClaims is the pure builder the exchange uses', JSON.stringify(auth.jwtClaims({ clientEmail: 'a@b' }, auth.READ_SCOPES, 100)) ===
      JSON.stringify({ iss: 'a@b', scope: auth.READ_SCOPES.join(' '), aud: TOKEN_URI, iat: 100, exp: 3700 }));
    ok('bearer: every BigQuery call carries the minted token', calls.filter((c) => !isToken(c)).every((c) => c.headers.authorization === 'Bearer ya29.read-1'));
    ok('readTokenReply: Google\'s refusal is reported with its own words', errOf(auth.readTokenReply(400, JSON.stringify(fixture('token-error.json')))) === 'Google refused the service-account key: invalid_grant — Invalid JWT Signature.');

    // The cache: per key, scope and org.
    await def.run(ctx(), 'select 2');
    ok('cache: a second run reuses the token (one exchange)', calls.filter(isToken).length === 1);
    const otherOrg = { user: { email: 'a@b.test', role: 'admin' as const }, org: { id: 'org-two' } };
    await context.runInContext(otherOrg, 'r2', () => def.run(ctx(), 'select 3'));
    ok('cache: another org mints its own (orgKey)', calls.filter(isToken).length === 2);
    await def.run(ctxFor(makeKey()), 'select 4');
    ok('cache: another key mints its own', calls.filter(isToken).length === 3);
  }

  // ── A job: polled, paged, capped ───────────────────────────────────────────
  {
    let polls = 0;
    const calls = serve(happy((c) => {
      if (isQuery(c)) return { json: fixture('query-incomplete.json') };
      if (isResults(c) && !c.url.searchParams.get('pageToken')) return { json: ++polls < 2 ? fixture('query-incomplete.json') : fixture('results-page1.json') };
      if (isResults(c)) return { json: fixture('results-page2.json') };
      return null;
    }));
    const sql = 'select region, count(*) as orders\nfrom sales.orders group by region -- per region';
    const r = await def.run(ctx({ dataset: 'sales' }), sql + ';');
    ok('job: jobComplete=false is polled until done, then paged by pageToken (5 rows, in order)',
      r.ok && JSON.stringify(r.rows) === JSON.stringify([['North', '61'], ['South', '60'], ['East', '60'], ['West', '59'], [null, '0']]) && !r.truncated, JSON.stringify(r));
    const q = calls.find(isQuery)!;
    ok('job: the statement sits on its own line inside the cap wrapper (a trailing comment cannot eat the LIMIT)',
      q.json.query === `select * from (\n${sql}\n) limit 1001`, q.json.query);
    ok('job: legacy SQL off, named parameters, a job always created, the purpose label',
      q.json.useLegacySql === false && q.json.parameterMode === 'NAMED' && q.json.jobCreationMode === 'JOB_CREATION_REQUIRED' && q.json.labels.ordinate === 'extract');
    ok('job: location, default dataset, jobTimeoutMs and a server-side wait are sent',
      q.json.location === 'europe-west2' && JSON.stringify(q.json.defaultDataset) === JSON.stringify({ projectId: PROJECT, datasetId: 'sales' })
      && q.json.jobTimeoutMs === '5000' && q.json.timeoutMs <= 10_000 && q.json.maxResults === 1001);
    const res = calls.filter(isResults);
    ok('job: getQueryResults carries the job\'s location, a wait, and the job id from jobReference',
      res.length === 3 && res.every((c) => c.url.searchParams.get('location') === 'europe-west2' && c.url.pathname === `/bigquery/v2/projects/${PROJECT}/queries/job_Zq3x9bQ1aBcDeFgHiJkLmNoPq`)
      && res[0].url.searchParams.has('timeoutMs'), res.map((c) => c.url.href).join('\n'));
    ok('job: page 2 is asked with the pageToken', res[2].url.searchParams.get('pageToken') === 'BFHJ2HMRPQAQAAASA4EAAEEAQCAAKGQEBBRQ5AAA=');

    // Truncation: a cap of 3 asks page 2 for one more row (cap + 1), then reports truncation.
    const c3 = serve(happy((c) => isQuery(c) ? { json: fixture('results-page1.json') } : isResults(c) ? { json: fixture('results-page2.json') } : null));
    const t3 = await def.run(ctx({}, { rowLimit: 3 }), 'select 1');
    ok('cap: 3 rows of 5, truncated, the wrapper says limit 4',
      t3.ok && t3.rows.length === 3 && t3.truncated && c3.find(isQuery)!.json.query.endsWith(') limit 4'), JSON.stringify(t3));
    ok('cap: page 2 asked only for the one row that proves truncation', c3.filter(isResults)[0]?.url.searchParams.get('maxResults') === '1');
    const c2 = serve(happy((c) => isQuery(c) ? { json: fixture('results-page1.json') } : null));
    const t2 = await def.run(ctx({}, { rowLimit: 2 }), 'select 1');
    ok('cap: past the cap on page 1, page 2 is never fetched', t2.ok && t2.rows.length === 2 && t2.truncated && c2.filter(isResults).length === 0);
  }

  // ── Types ──────────────────────────────────────────────────────────────────
  {
    const shaped = shape.shapeResponse(fixture('query-types.json'), { rowLimit: 100 });
    ok('shape: the recorded reply shapes', shaped.ok);
    if (shaped.ok) {
      const col = (n: string) => shaped.columns.find((c) => c.name === n)!;
      const cell = (r: number, n: string) => shaped.rows[r][shaped.columns.findIndex((c) => c.name === n)];
      ok('types: INT64 / NUMERIC / FLOAT64 declare number, values kept as the exact strings sent',
        col('id').columnType === 'number' && col('amount').columnType === 'number' && col('ratio').columnType === 'number' && cell(0, 'id') === '1' && cell(1, 'amount') === '-0.000001');
      ok('types: an INT64 column with an id over 15 digits is TEXT, every digit kept', col('big_id').columnType === 'text' && cell(0, 'big_id') === '12345678901234567' && cell(1, 'big_id') === '9007199254740993');
      ok('types: an all-null INT64 column is still a number', col('empty').columnType === 'number' && cell(0, 'empty') === null);
      ok('types: BOOL is a boolean in a text column', col('active').columnType === 'text' && cell(0, 'active') === true && cell(1, 'active') === false && cell(2, 'active') === null);
      ok('types: DATE and DATETIME are dates as sent', col('day').columnType === 'date' && cell(0, 'day') === '2024-01-02' && col('at').columnType === 'date' && cell(0, 'at') === '2024-01-02T03:04:05.123456');
      ok('types: TIMESTAMP epoch seconds → UTC ISO', col('ts').columnType === 'date' && cell(0, 'ts') === '2024-01-05T01:20:00.000Z' && cell(1, 'ts') === '1969-12-31T23:59:58.500Z' && cell(2, 'ts') === null);
      ok('types: a leading U+FEFF survives (and a lone one)', String(cell(0, 'note')).charCodeAt(0) === 0xfeff && cell(0, 'note') === '\ufeffhello' && cell(2, 'note') === '\ufeff');
      ok('types: REPEATED → JSON text', col('tags').columnType === 'text' && cell(0, 'tags') === '["a","b"]' && cell(1, 'tags') === '[]' && col('tags').type === 'REPEATED STRING');
      ok('types: RECORD → JSON text, nested TIMESTAMP as ISO, a zip stays a string, a nested INT64 a number',
        cell(0, 'addr') === '{"city":"Leeds","zip":"01234","since":"2024-01-05T01:20:12.345Z","floors":3}' && cell(1, 'addr') === null, String(cell(0, 'addr')));
    }
    // The same reply through the real dispatch (connectionRun → toParseResult).
    serve(happy());
    const viaRun = await run.runConnection('bigquery', ctx().values, { token: KEY.json }, { query: 'select * from t' });
    ok('dispatch: runs', viaRun.ok, errOf(viaRun));
    if (viaRun.ok) {
      const res = viaRun.result;
      const idx = (n: string) => res.columns.findIndex((c) => c.name === n);
      const typeOf = (n: string) => res.columns[idx(n)].type;
      ok('dispatch: number / text / date as declared', typeOf('id') === 'number' && typeOf('big_id') === 'text' && typeOf('ts') === 'date' && typeOf('note') === 'text' && typeOf('active') === 'text');
      ok('dispatch: ids over 15 digits arrive exact, as text', res.rows[0][idx('big_id')] === '12345678901234567' && res.rows[1][idx('big_id')] === '9007199254740993');
      ok('dispatch: -0.0 stays -0 (Object.is) — the string was kept, not a float round trip', Object.is(res.rows[1][idx('ratio')], -0) && res.rows[2][idx('ratio')] === 0.00001);
      ok('dispatch: the leading U+FEFF survives', String(res.rows[0][idx('note')]).charCodeAt(0) === 0xfeff && String(res.rows[0][idx('note')]).length === 6);
    }
    // epochToIso against Date, differentially: random instants written the ways BigQuery writes them.
    let bad = '';
    const MIN = -62135596800000; // 0001-01-01, BigQuery's first TIMESTAMP
    const MAX = 253402300799999; // 9999-12-31T23:59:59.999
    for (let i = 0; i < 2000 && !bad; i += 1) {
      // Every 5th near the epoch, where the exponent goes small or negative.
      const ms = i % 5 === 0 ? Math.floor((Math.random() - 0.5) * 2e7) : MIN + Math.floor(Math.random() * (MAX - MIN + 1));
      const neg = ms < 0;
      const a = Math.abs(ms);
      const secs = `${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
      const [ip, fp] = secs.split('.');
      const digits = (ip + fp).replace(/^0+(?=\d)/, '');
      const eForm = `${digits[0]}.${digits.slice(1)}E${digits.length - 1 - fp.length}`;
      const want = new Date(ms).toISOString();
      for (const s of [(neg ? '-' : '') + secs, (neg ? '-' : '') + eForm]) if (shape.epochToIso(s) !== want) bad = `${s} → ${shape.epochToIso(s)} ≠ ${want}`;
    }
    ok('epochToIso: 2,000 random instants, decimal and E forms, === new Date(ms).toISOString()', !bad, bad);
    ok('epochToIso: garbage and out-of-range are null, never a wrong date', ['abc', '1e400', '', '1.2.3', 'NaN'].every((s) => shape.epochToIso(s) === null));
  }

  // ── Read-only: the dry-run gate ────────────────────────────────────────────
  for (const kind of ['DELETE', 'SCRIPT', 'MERGE', 'CREATE_TABLE_AS_SELECT', 'INSERT', 'DROP_TABLE', '']) {
    const calls = serve(happy((c) => isDry(c) ? { json: { ...(fixture('dryrun-delete.json') as object), statementType: kind || undefined } } : null));
    const r = await def.run(ctx(), 'delete from sales.orders where true');
    ok(`gate: a dry run saying ${kind || '(no statementType)'} is refused, and nothing but the dry run is sent`,
      !r.ok && /only SELECT statements run/.test(errOf(r)) && calls.filter(isQuery).length === 0 && calls.filter(isDry).length === 1, errOf(r));
  }
  {
    const calls = serve(happy());
    const r = await def.run(ctx(), 'select 1');
    const dry = calls.find(isDry)!;
    const q = calls.find(isQuery)!;
    ok('gate: a SELECT dry run lets the query run (negative control)', r.ok && !!q);
    ok('gate: the dry run is of exactly the text that then runs, wrapper included', dry.json.query === q.json.query && dry.json.dryRun === true);
    ok('gate: the dry run bills nothing, so it carries no maximumBytesBilled', dry.json.maximumBytesBilled === undefined);
  }
  {
    const calls = serve(happy((c) => isDry(c) ? { json: { ...(fixture('dryrun-select.json') as object), totalBytesProcessed: '53687091200' } } : null));
    const r = await def.run(ctx(), 'select * from huge');
    ok('cost: a dry run over the cap is refused up front, with the size, and never run',
      !r.ok && /would process 50\.0 GB, over this connection's limit of 10\.0 GB/.test(errOf(r)) && calls.filter(isQuery).length === 0, errOf(r));
  }
  // Google's own refusals, each in one clear sentence.
  for (const [name, status, want] of [
    ['error-scope.json', 403, /read-only access.*insufficient authentication scopes.*bigquery\.readonly/],
    ['error-denied.json', 403, /bigquery\.jobs\.create permission.*Data Viewer.*Job User/],
    ['error-bytes.json', 400, /exceeded limit for bytes billed.*Max bytes billed per query/],
  ] as const) {
    serve(happy((c) => isQuery(c) ? { status, json: fixture(name) } : null));
    const r = await def.run(ctx(), 'select 1');
    ok(`errors: ${name} → a clear sentence`, !r.ok && want.test(errOf(r)), errOf(r));
  }
  serve(happy((c) => isToken(c) ? { status: 400, json: fixture('token-error.json') } : null));
  ok('errors: a refused key says Google refused it', /Google refused the service-account key: invalid_grant/.test(errOf(await def.run(ctx(), 'select 1'))));

  // ── Named parameters: values never reach the SQL text ─────────────────────
  {
    const literals = [`O'Brien`, `x' OR '1'='1`, 'back\\slash\\', '’curly’ “quotes”', '${process.env.HOME}', 'nul\u0000byte', '`; DROP TABLE t; --', '@p999', '\ufeffbom', 'é😀'];
    const sql = 'select region, sum(amount) as total from `sales.orders` where ' + literals.map((_, i) => `note = @p${i}`).join(' or ') +
      ' and id > @p10 and ratio < @p11 and active = @p12 and day >= @p13 and ts < @p14 and note != @p15 group by region';
    const params = [
      ...literals.map((v, i) => ({ name: `p${i}`, type: 'text' as const, value: v })),
      { name: 'p10', type: 'number' as const, value: 42 }, { name: 'p11', type: 'number' as const, value: 2.5 },
      { name: 'p12', type: 'boolean' as const, value: true }, { name: 'p13', type: 'date' as const, value: '2024-01-01' },
      { name: 'p14', type: 'timestamp' as const, value: '2024-01-01T00:00:00.000Z' }, { name: 'p15', type: 'text' as const, value: null },
    ];
    const calls = serve(happy());
    const r = await def.live!.runBound({ ...ctx(), costTag: 'live' }, sql, params);
    const q = calls.find(isQuery)!;
    ok('params: runs, labelled live, with no dry run (compiled SQL)', r.ok && q.json.labels.ordinate === 'live' && calls.filter(isDry).length === 0, errOf(r));
    ok('params: the SQL text is exactly the compiled statement in the cap wrapper', q.json.query === `select * from (\n${sql}\n) limit 1001`);
    ok('params: no adversarial literal appears in the SQL text', literals.every((v) => !q.json.query.includes(v)));
    const qp = q.json.queryParameters as { name: string; parameterType: { type: string }; parameterValue: { value?: string } }[];
    ok('params: every literal travels byte-for-byte as a STRING parameter', literals.every((v, i) => qp[i].name === `p${i}` && qp[i].parameterType.type === 'STRING' && qp[i].parameterValue.value === v));
    ok('params: integral → INT64, fractional → FLOAT64, BOOL, DATE, TIMESTAMP',
      JSON.stringify(qp.slice(10, 15).map((p) => [p.parameterType.type, p.parameterValue.value])) ===
      JSON.stringify([['INT64', '42'], ['FLOAT64', '2.5'], ['BOOL', 'true'], ['DATE', '2024-01-01'], ['TIMESTAMP', '2024-01-01T00:00:00.000Z']]));
    ok('params: null is a typed null — the type, no value', qp[15].parameterType.type === 'STRING' && JSON.stringify(qp[15].parameterValue) === '{}');
    const calls2 = serve(happy());
    const badParam = await def.live!.runBound(ctx(), 'select @p0', [{ name: 'p0', type: 'number', value: 'one' as unknown as number }]);
    ok('params: a mistyped parameter is refused before anything is sent', !badParam.ok && calls2.filter((c) => !isToken(c)).length === 0, errOf(badParam));
    const est = await def.live!.estimate!(ctx(), 'select region from sales.orders where id = @p0', [{ name: 'p0', type: 'number', value: 7 }]);
    ok('estimate: the dry run\'s totalBytesProcessed', est.ok && est.bytes === 1288490188, JSON.stringify(est));
  }

  // ── Catalog ────────────────────────────────────────────────────────────────
  {
    const calls = serve(happy((c) => {
      if (c.url.pathname.endsWith('/datasets')) return { json: fixture('datasets.json') };
      if (c.url.pathname.endsWith('/datasets/sales/tables')) return { json: fixture('tables-sales.json') };
      if (c.url.pathname.endsWith('/datasets/marketing/tables')) return { json: fixture('tables-marketing.json') };
      if (c.url.pathname.endsWith('/tables/orders')) return { json: fixture('table-orders.json') };
      return null;
    }));
    const t = await def.listTables(ctx({ dataset: 'sales' }));
    ok('listTables: dataset.table, the default dataset first', t.ok && JSON.stringify(t.tables) ===
      JSON.stringify([{ schema: 'sales', name: 'orders' }, { schema: 'sales', name: 'orders_by_day' }, { schema: 'marketing', name: 'campaigns' }]), JSON.stringify(t));
    const d = await def.describeTable!(ctx(), 'sales.orders');
    ok('describe: tables.get schema → columns, REQUIRED → not null, numRows as the estimate',
      d.ok && JSON.stringify(d.columns.map((c) => [c.name, c.type, c.nullable])) === JSON.stringify([['id', 'INTEGER', false], ['region', 'STRING', true], ['amount', 'NUMERIC', true], ['ordered_at', 'TIMESTAMP', true], ['items', 'REPEATED RECORD', true]]) && d.rowEstimate === 240, JSON.stringify(d));
    await def.describeTable!(ctx(), 'other-project-9.sales.orders');
    ok('describe: a project-qualified name asks that project', calls.some((c) => c.url.pathname === '/bigquery/v2/projects/other-project-9/datasets/sales/tables/orders'));
    const before = calls.length;
    const refused = await Promise.all(['orders', 'a.b.c.d', 'sales.orders`; drop', 'sales.my table', '../x.y'].map((n) => def.describeTable!(ctx(), n)));
    ok('describe: a malformed or injected name is refused before any request', refused.every((r) => !r.ok) && calls.length === before);
  }

  // ── The dispatch's table SQL and the incremental predicate (L1.4) ─────────
  ok('table SQL: dataset.table as one backtick path', run.buildTableSql('bigquery', 'sales.orders', 10) === 'select * from `sales.orders` limit 10');
  ok('table SQL: project.dataset.table, and a domain-scoped project', run.buildTableSql('bigquery', 'acme-analytics.sales.orders', 5) === 'select * from `acme-analytics.sales.orders` limit 5'
    && run.buildTableSql('bigquery', 'example.com:acme-analytics.sales.orders', 5) === 'select * from `example.com:acme-analytics.sales.orders` limit 5');
  ok('table SQL: injected or malformed names are refused', ['sales.orders`; drop table x; --', 'orders', 'a.b.c.d', 'sales.or\\ders', 'sales.or\nders', 'Bad_Project.sales.orders']
    .every((n) => run.buildTableSql('bigquery', n, 5) === null));
  ok('table SQL: other families are untouched (negative control)', run.buildTableSql('postgres', 'acme-analytics.sales.orders', 5) === null);
  {
    const calls = serve(happy());
    await run.sampleTable('bigquery', ctx().values, { token: KEY.json }, 'sales.orders', 500);
    ok('sample: the table SQL runs inside the cap wrapper', calls.find(isQuery)?.json.query === 'select * from (\nselect * from `sales.orders` limit 500\n) limit 501');
  }

  // ── The editor's estimate, end to end ──────────────────────────────────────
  {
    serve(happy());
    const e = await run.estimateSql('bigquery', ctx().values, { token: KEY.json }, 'select region from sales.orders;');
    ok('estimateSql: bytes and the server-formatted label', e !== null && e.ok && e.bytes === 1288490188 && e.label === '~1.2 GB', JSON.stringify(e));
    ok('estimateSql: null for a source that cannot estimate', (await run.estimateSql('postgres', {}, {}, 'select 1')) === null);
    serve(happy((c) => isDry(c) ? { json: fixture('dryrun-delete.json') } : null));
    const del = await run.estimateSql('bigquery', ctx().values, { token: KEY.json }, 'delete from t where true');
    ok('estimateSql: a DELETE is refused, not priced', del !== null && !del.ok && /DELETE/.test(errOf(del)));
    ok('estimateLabel: 1024-based, one decimal under 100', ['~512 B', '~1.0 KB', '~1.2 GB', '~150 MB', '~10.0 GB'].join() ===
      [512, 1024, 1288490188, 150 * 2 ** 20, 10737418240].map(shape.estimateLabel).join());

    // Through the IPC handler, over a saved connection whose key is in the store.
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
    const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
    require('../src/ipc/connections').register();
    await projects.init();
    const pid = (await projects.createProject('Warehouse')).id;
    const saved = (await connections.saveConnection(pid, { name: 'BQ', connectorId: 'bigquery', values: { project: PROJECT } }))!;
    await secretsIpc.storeSecrets(saved.id, { token: KEY.json });
    const pg = (await connections.saveConnection(pid, { name: 'PG', connectorId: 'postgres', values: { host: 'db', database: 'x' } }))!;
    const handler = rpc.handlers.get('connection:estimate')!;
    serve(happy());
    const viaIpc = (await handler({}, { projectId: pid, connId: saved.id, sql: 'select 1' })) as { ok: boolean; estimate: { bytes: number; label: string } | null };
    ok('ipc: connection:estimate prices a saved BigQuery connection with its stored key', viaIpc.ok && viaIpc.estimate?.label === '~1.2 GB', JSON.stringify(viaIpc));
    const none = (await handler({}, { projectId: pid, connId: pg.id, sql: 'select 1' })) as { ok: boolean; estimate: unknown };
    ok('ipc: …and answers estimate: null for Postgres (no call made)', none.ok && none.estimate === null);
    ok('ipc: the reply carries no key material', !JSON.stringify(viaIpc).includes('PRIVATE') && !JSON.stringify(viaIpc).includes(KEY.privateKeyId));
  }
}

main()
  .catch((e: unknown) => ok('threw', false, e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    bq.setTransport(null);
    finish();
  });
