// BigQuery's bounds (src/connectors/bigquery.ts), off an injected transport:
//
//   • CANCEL — an abort while the job runs (ctx.signal, or the request's own
//     signal when a tab closes) sends jobs.cancel with a cancel-only token; an
//     abort while jobs.query is still in flight cancels the job when its id
//     lands; our own timeout cancels too. Negative control: a finished query
//     sends no cancel.
//   • COST — maximumBytesBilled on every billed query = min(connection field,
//     LIVE_MAX_BYTES_BILLED, ctx.maxBytes), never above the ceiling; the
//     variable's parser refuses a typo at startup.
//   • HOSTS — every request is https to a declared host; the guard refuses
//     anything else (negative control: a declared host passes); a bad project
//     id, location or dataset is refused before a request; a hostile
//     jobReference is never followed; no file in the family opens a socket of
//     its own.
//   • SECRET CANARY — a planted key file (its PEM, every PEM line, its key id),
//     the assertions and an access token, against a server that echoes all of
//     them back in every error: none reaches a result, an error or this
//     process's output, and the key never reaches a request.
//
//   npm run build:ts && node scripts/test-bigqueryBounds.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { assertionOf, ctxFor, fakeTransport, fixture, happy, isCancel, isDry, isQuery, isResults, isToken, makeKey, PROJECT, wait } from './bigqueryFake';
import type { Call, Reply } from './bigqueryFake';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bqb-'));

// ── Capture every byte this process prints (the canary greps it) ────────────
let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

// ponytail: compiled siblings of the .ts sources.
const registry: typeof import('../src/connectors') = require('../src/connectors');
const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
const auth: typeof import('../src/connectors/bigqueryAuth') = require('../src/connectors/bigqueryAuth');
const run: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const context: typeof import('../src/server/context') = require('../src/server/context');
const env: typeof import('../src/server/env') = require('../src/server/env');

const KEY = makeKey();
const def = registry.getConnector('bigquery')!;
const JOB = 'job_Zq3x9bQ1aBcDeFgHiJkLmNoPq';
const every: Call[] = [];

function serve(route: (c: Call) => Reply): Call[] {
  const f = fakeTransport(route);
  bq.setTransport(async (o) => {
    const r = f.transport(o);
    every.push(f.calls[f.calls.length - 1]);
    return r;
  });
  auth.clearTokens();
  return f.calls;
}
const ctx = (values: Record<string, unknown> = {}, extra = {}) => ctxFor(KEY, values, extra);
const errOf = (r: { ok: boolean; error?: string }): string => (r.ok ? '' : String(r.error));
async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await wait(5);
  }
  return true;
}
const running = (c: Call): Reply | null => (isQuery(c) ? { json: fixture('query-incomplete.json') } : null);

async function main(): Promise<void> {
  // ── Cancel ─────────────────────────────────────────────────────────────────
  {
    const ac = new AbortController();
    const calls = serve(happy((c) => running(c) ?? (isResults(c) ? { hang: true } : null)));
    const p = def.run(ctx({}, { signal: ac.signal, timeoutMs: 20_000 }), 'select * from sales.orders');
    ok('cancel: the job is being polled', await until(() => calls.some(isResults)));
    const t0 = Date.now();
    ac.abort();
    const r = await p;
    ok('cancel: an abort mid-poll returns at once, as cancelled', !r.ok && /cancelled/.test(errOf(r)) && Date.now() - t0 < 1_500, `${errOf(r)} after ${Date.now() - t0} ms`);
    const cancels = calls.filter(isCancel);
    ok('cancel: jobs.cancel for that job, in its location',
      cancels.length === 1 && cancels[0].url.pathname === `/bigquery/v2/projects/${PROJECT}/jobs/${JOB}/cancel` && cancels[0].url.searchParams.get('location') === 'europe-west2', cancels.map((c) => c.url.href).join());
    const cancelTokenCall = calls.filter(isToken).find((c) => assertionOf(c).claims.scope === 'https://www.googleapis.com/auth/bigquery');
    ok('cancel: with a token minted for the bigquery scope, used for that one call only',
      !!cancelTokenCall && /^Bearer ya29\.cancel-\d+$/.test(cancels[0]?.headers.authorization ?? '') && calls.filter((c) => !isCancel(c) && !isToken(c)).every((c) => /^Bearer ya29\.read-/.test(c.headers.authorization)));
  }
  {
    const ac = new AbortController();
    const calls = serve(happy((c) => (isQuery(c) ? { json: fixture('query-incomplete.json'), delayMs: 300 } : null)));
    const p = def.run(ctx({}, { signal: ac.signal, timeoutMs: 20_000 }), 'select 1');
    await until(() => calls.some(isQuery));
    const t0 = Date.now();
    ac.abort();
    const r = await p;
    ok('cancel: an abort while jobs.query is in flight returns at once', !r.ok && /cancelled/.test(errOf(r)) && Date.now() - t0 < 200, `${Date.now() - t0} ms`);
    ok('cancel: …and the job is cancelled when its id lands', await until(() => calls.some(isCancel)) && calls.find(isCancel)!.url.pathname.endsWith(`/jobs/${JOB}/cancel`));
  }
  {
    const calls = serve(happy((c) => running(c) ?? (isResults(c) ? { json: fixture('query-incomplete.json') } : null)));
    const r = await def.run(ctx({}, { timeoutMs: 600 }), 'select 1');
    ok('timeout: a job past the budget is cancelled and reported', !r.ok && /did not finish within 1s/.test(errOf(r)) && calls.filter(isCancel).length === 1, errOf(r));
  }
  {
    // A closed tab: no ctx.signal, the request's own signal (src/server/app.ts).
    const ac = new AbortController();
    const calls = serve(happy((c) => running(c) ?? (isResults(c) ? { hang: true } : null)));
    const who = { user: { email: 'a@b.test', role: 'admin' as const }, org: { id: 'default' } };
    const p = context.runInContext(who, 'req-1', () => def.run(ctx({}, { timeoutMs: 20_000 }), 'select 1'), undefined, ac.signal);
    await until(() => calls.some(isResults));
    ac.abort();
    const r = await p;
    ok('cancel: the request\'s signal (a hung-up client) cancels the job too', !r.ok && calls.filter(isCancel).length === 1, errOf(r));
  }
  {
    const calls = serve(happy());
    const r = await def.run(ctx(), 'select 1');
    ok('cancel: a finished query sends no cancel (negative control)', r.ok && calls.filter(isCancel).length === 0);
  }

  // ── Cost: maximumBytesBilled ───────────────────────────────────────────────
  const G = 10_737_418_240;
  const matrix: [string, Record<string, unknown>, string | undefined, number | undefined, number][] = [
    ['no field → the 10 GiB default', {}, undefined, undefined, G],
    ['the field, lower', { maxBytesBilled: 5_000_000_000 }, undefined, undefined, 5_000_000_000],
    ['the field as a form string', { maxBytesBilled: '2000000000' }, undefined, undefined, 2_000_000_000],
    ['the field above the ceiling → the ceiling', { maxBytesBilled: 20_000_000_000 }, undefined, undefined, G],
    ['LIVE_MAX_BYTES_BILLED lower than the field', { maxBytesBilled: 5_000_000_000 }, '1000000000', undefined, 1_000_000_000],
    ['LIVE_MAX_BYTES_BILLED alone', {}, '1000000000', undefined, 1_000_000_000],
    ['ctx.maxBytes lower still', { maxBytesBilled: 5_000_000_000 }, '3000000000', 123_456_789, 123_456_789],
    ['a negative field is ignored', { maxBytesBilled: -5 }, undefined, undefined, G],
    ['a non-numeric field is ignored', { maxBytesBilled: 'lots' }, undefined, undefined, G],
    ['a zero field is ignored', { maxBytesBilled: 0 }, undefined, undefined, G],
    ['an unparseable ceiling falls back to the default, never unbounded', {}, '10GB', undefined, G],
  ];
  for (const [label, values, ceiling, callerMax, want] of matrix) {
    if (ceiling === undefined) delete process.env.LIVE_MAX_BYTES_BILLED;
    else process.env.LIVE_MAX_BYTES_BILLED = ceiling;
    const calls = serve(happy((c) => (isDry(c) ? { json: { ...(fixture('dryrun-select.json') as object), totalBytesProcessed: '1000' } } : null)));
    const extra = callerMax === undefined ? {} : { maxBytes: callerMax };
    await def.run(ctx(values, extra), 'select 1');
    await def.live!.runBound(ctx(values, extra), 'select @p0', [{ name: 'p0', type: 'number', value: 1 }]);
    const billed = calls.filter(isQuery);
    ok(`bytes: ${label} (${want})`, billed.length === 2 && billed.every((c) => c.json.maximumBytesBilled === String(want)), billed.map((c) => c.json.maximumBytesBilled).join());
  }
  delete process.env.LIVE_MAX_BYTES_BILLED;
  ok('env: the parser\'s default is 10 GiB', env.maxBytesBilled(undefined) === G && env.maxBytesBilled('') === G && env.DEFAULT_MAX_BYTES_BILLED === G);
  ok('env: a whole number of bytes is taken', env.maxBytesBilled('1048576') === 1_048_576);
  ok('env: a unit, a zero, a fraction or past 2^53 is refused', ['10GB', '0', '1.5', '-1', '99999999999999999', ' 5'].every((v) => {
    try { env.maxBytesBilled(v); return false; } catch (e) { return e instanceof env.EnvError && /LIVE_MAX_BYTES_BILLED/.test(e.message); }
  }));
  ok('env: parseEnv refuses a typo at startup', (() => {
    try { env.parseEnv({ AUTH_MODE: 'dev', LIVE_MAX_BYTES_BILLED: 'ten gigs' }); return false; } catch (e) { return e instanceof env.EnvError; }
  })());
  ok('env: …and accepts a good value (negative control)', (() => {
    try { env.parseEnv({ AUTH_MODE: 'dev', LIVE_MAX_BYTES_BILLED: '1073741824' }); return true; } catch { return false; }
  })());

  // ── Hosts, names, job references ───────────────────────────────────────────
  {
    let reached = 0;
    bq.setTransport(async () => { reached += 1; return { status: 200, body: '{}', truncated: false }; });
    const refused: string[] = [];
    for (const href of ['https://evil.example/x', 'http://bigquery.googleapis.com/bigquery/v2', 'https://bigquery.googleapis.com.evil.com/', 'https://oauth2.googleapis.com.evil.com/token', 'https://169.254.169.254/computeMetadata/v1/']) {
      try { await bq.send({ url: new URL(href), method: 'GET', timeoutMs: 1000 }); } catch (e) { if (/is not a host this source declares/.test(String(e))) refused.push(href); }
    }
    ok('hosts: the guard refuses every undeclared host or plain http, before the transport', refused.length === 5 && reached === 0, refused.join());
    await bq.send({ url: new URL('https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics/queries'), method: 'GET', timeoutMs: 1000 });
    ok('hosts: a declared host passes (negative control)', reached === 1);
  }
  for (const project of ['evil.com/x', '../x', 'a', 'UPPER-case', 'my-proj?x=1', 'my-proj#frag', 'my_project', '-leading', 'trailing-', 'x'.repeat(40), 'my-project-123/../../jobs']) {
    const calls = serve(happy());
    const r = await def.run(ctx({ project }), 'select 1');
    ok(`names: billing project ${JSON.stringify(project)} is refused before any request`, !r.ok && calls.length === 0, errOf(r));
  }
  for (const [label, values] of [['location', { location: 'us; drop' }], ['default dataset', { dataset: 'sales/../x' }]] as const) {
    const calls = serve(happy());
    const r = await def.run(ctx(values), 'select 1');
    ok(`names: a bad ${label} is refused before any request`, !r.ok && calls.length === 0, errOf(r));
  }
  {
    const calls = serve(happy());
    await def.run(ctx({ project: 'example.com:acme-analytics' }), 'select 1');
    ok('names: a domain-scoped project is encoded into the path', calls.filter(isQuery).every((c) => c.url.pathname === '/bigquery/v2/projects/example.com%3Aacme-analytics/queries') && calls.some(isQuery));
  }
  for (const jobReference of [{ projectId: PROJECT, jobId: '../../../datasets' }, { projectId: 'evil.com/x', jobId: 'job_ok' }, { projectId: PROJECT, jobId: 'job?x=1' }, {}]) {
    const calls = serve(happy((c) => (isQuery(c) ? { json: { jobReference, jobComplete: false } } : null)));
    const r = await def.run(ctx(), 'select 1');
    ok(`jobs: a hostile jobReference ${JSON.stringify(jobReference)} is never followed`, !r.ok && calls.filter((c) => c.method === 'GET' || isCancel(c)).length === 0, errOf(r));
  }
  {
    const src = ['bigquery', 'bigqueryAuth', 'bigqueryShape'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'connectors', `${f}.ts`), 'utf8')).join('\n');
    ok('sockets: the family opens none of its own — no http/https/net/tls/dns import, no fetch',
      !/from '(node:)?(https?|net|tls|dns)'|require\('(node:)?(https?|net|tls|dns)'\)|\bfetch\(/.test(src) && /import \{ httpRequest, MAX_BYTES \} from '\.\/http'/.test(src));
  }

  // ── Secret canary ──────────────────────────────────────────────────────────
  {
    const CANARY_TOKEN = `ya29.CANARY-${Math.random().toString(36).slice(2)}-access`;
    const pemLines = KEY.pem.split('\n').map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'));
    const pemBody = pemLines.join('');
    const outputs: string[] = [];
    // Each result as JSON AND each error raw — JSON escapes a PEM's newlines.
    const keep = (label: string, v: { ok: boolean; error?: string } | null): void => {
      outputs.push(`${label}: ${JSON.stringify(v)}`);
      if (v && !v.ok) outputs.push(String(v.error));
    };
    const assertions: string[] = [];
    // A server that echoes every credential it sees, in every way it can fail.
    const echoed: string[] = [];
    const echo = (c: Call): string => {
      const all = `${c.headers.authorization ?? ''} ${c.body} ${KEY.json} ${KEY.pem} ${pemBody}`;
      echoed.push(all);
      return all;
    };
    const scenarios: [string, (c: Call) => Reply | null][] = [
      ['success', (c) => (isToken(c) ? { json: { access_token: CANARY_TOKEN, expires_in: 3599 } } : null)],
      ['token refused, echoing the assertion and the key', (c) => (isToken(c) ? { status: 400, json: { error: 'invalid_grant', error_description: echo(c) } } : null)],
      ['token refused as HTML', (c) => (isToken(c) ? { status: 500, text: `<html>${echo(c)}</html>` } : null)],
      ['query refused, echoing the bearer token', (c) => (isToken(c) ? { json: { access_token: CANARY_TOKEN, expires_in: 3599 } } : isQuery(c) ? { status: 403, json: { error: { code: 403, message: echo(c), errors: [{ reason: 'accessDenied' }] } } } : null)],
      ['dry run refused as plain text, echoing everything', (c) => (isToken(c) ? { json: { access_token: CANARY_TOKEN, expires_in: 3599 } } : isDry(c) ? { status: 400, text: 'x'.repeat(250) + echo(c) } : null)],
      ['listing refused, echoing', (c) => (isToken(c) ? { json: { access_token: CANARY_TOKEN, expires_in: 3599 } } : c.method === 'GET' ? { status: 401, json: { error: { code: 401, message: echo(c) } } } : null)],
    ];
    for (const [label, extra] of scenarios) {
      const calls = serve(happy(extra));
      keep(`${label} run`, await def.run(ctx(), 'select 1'));
      keep(`${label} runBound`, await def.live!.runBound(ctx(), 'select @p0', [{ name: 'p0', type: 'text', value: 'x' }]));
      keep(`${label} estimate`, await def.live!.estimate!(ctx(), 'select 1', []));
      keep(`${label} listTables`, await def.listTables(ctx()));
      keep(`${label} describe`, await def.describeTable!(ctx(), 'sales.orders'));
      keep(`${label} dispatch run`, await run.runConnection('bigquery', ctx().values, { token: KEY.json }, { query: 'select 1' }));
      keep(`${label} dispatch test`, await run.testConnection('bigquery', ctx().values, { token: KEY.json }));
      keep(`${label} dispatch estimate`, await run.estimateSql('bigquery', ctx().values, { token: KEY.json }, 'select 1'));
      for (const c of calls.filter(isToken)) assertions.push(assertionOf(c).assertion);
    }
    // The socket layer itself failing, after a token was issued, with every secret in its message.
    bq.setTransport(async (o) => {
      if (o.url.hostname === 'oauth2.googleapis.com') return { status: 200, body: JSON.stringify({ access_token: CANARY_TOKEN, expires_in: 3599 }), truncated: false };
      throw new Error(`socket hang up near ${KEY.pem} ${KEY.json} ${o.headers?.authorization ?? ''}`);
    });
    auth.clearTokens();
    keep('transport throws', await def.run(ctx(), 'select 1'));
    keep('transport throws, listing', await def.listTables(ctx()));
    for (const bad of [makeKey({ token_uri: 'https://evil.example/token', private_key: KEY.pem, private_key_id: KEY.privateKeyId }), makeKey({ type: 'user', private_key: KEY.pem })]) {
      keep('refused key', await def.run(ctxFor(bad), 'select 1'));
    }
    keep('key that is not JSON', await def.run(ctxFor({ ...KEY, json: KEY.json.slice(0, -3) }), 'select 1'));

    const planted: [string, string][] = [
      ['the key file', KEY.json], ['the PEM', KEY.pem.trim()], ['the PEM body', pemBody], ['the key id', KEY.privateKeyId], ['the access token', CANARY_TOKEN],
      ...pemLines.map((l, i): [string, string] => [`PEM line ${i + 1}`, l]),
      ...assertions.map((a, i): [string, string] => [`assertion ${i + 1}`, a]),
    ];
    const haystack = outputs.join('\n') + '\n' + captured;
    const leaks = planted.filter(([, v]) => haystack.includes(v)).map(([n]) => n);
    ok(`canary: ${planted.length} planted secrets appear in no result, error or output line (${outputs.length} outputs)`, leaks.length === 0, leaks.join(', '));
    ok('canary: the errors were real (the scenarios failed, each redacted)', outputs.filter((o) => o.includes('***')).length >= 10, outputs.filter((o) => o.includes('***')).length);
    const sent = every.map((c) => `${c.url.href} ${JSON.stringify(c.headers)} ${c.body}`).join('\n');
    ok('canary: the key file, its PEM and every PEM line never reach a request', [KEY.json, KEY.pem.trim(), pemBody, ...pemLines].every((v) => !sent.includes(v)));
    ok('canary: the access token travels only in an Authorization header', every.every((c) => !c.url.href.includes(CANARY_TOKEN) && !c.body.includes(CANARY_TOKEN)));
    const raw = echoed.join('\n');
    ok('canary: control — the server really echoed the key, its PEM, the token and an assertion (so a missed scrub would show)',
      [KEY.json, KEY.pem, pemBody, CANARY_TOKEN].every((v) => raw.includes(v)) && assertions.some((a) => raw.includes(a)));
  }
}

main()
  .catch((e: unknown) => ok('threw', false, e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    bq.setTransport(null);
    finish();
  });
