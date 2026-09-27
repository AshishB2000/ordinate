// The three connector rules, for the SaaS family (src/connectors/saasHttp.ts
// and saas.ts), with an injected fake fetch — no network:
//
//   BOUNDED   — the page-size parameter is on every request, paging stops at
//               the row cap and at MAX_PAGES, date ranges reach the API's own
//               filters, and a hung request times out.
//   HOSTS     — a URL (or a redirect) to a host the connector did not declare is
//               refused before any request; http is refused; a credential never
//               follows a redirect to another host.
//   SECRETS   — a token the API echoes back never reaches an error string, and
//               the smoke's fixture override is honoured for loopback ONLY.
//
//   npm run build:ts && node scripts/test-saasBounds.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { fakeFetch } from './saasFake';
import type { FakeCall, FakeReply } from './saasFake';

// ponytail: compiled siblings of the .ts sources.
const run: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const http: typeof import('../src/connectors/saasHttp') = require('../src/connectors/saasHttp');

function serve(route: (c: FakeCall) => FakeReply): FakeCall[] {
  const f = fakeFetch(route);
  http.setFetch(f.fetch);
  return f.calls;
}

const GH = { repo: 'octo/demo' };
const GH_KEY = { token: 'ghp_s3cretToken' };
const issue = (n: number, created: string) => ({ id: 1000 + n, number: n, title: 't' + n, created_at: created });

void (async () => {
  // ── Row cap: a fake with 50 pages stops at the cap ─────────────────────────
  {
    const calls = serve((c) => {
      const page = Number((c.url.searchParams.get('offset') || 'p0').slice(1));
      const records = Array.from({ length: 100 }, (_, i) => ({ id: `rec${page}_${i}`, fields: { n: page * 100 + i } }));
      return { json: page < 49 ? { records, offset: `p${page + 1}` } : { records } };
    });
    const r = await run.runConnection('airtable', { baseId: 'appAbc', table: 'T' }, { token: 'pat' }, { table: 'records' }, { rowLimit: 250 });
    ok('cap: 250 rows out of a 5,000-record table', r.ok && r.result.rowCount === 250, r.ok ? r.result.rowCount : r.error);
    ok('cap: …after 3 requests, not 50', calls.length === 3, calls.length);
    ok('cap: the page-size parameter is on EVERY request', calls.every((c) => c.url.searchParams.get('pageSize') === '100'));
    ok('cap: the result says it was truncated, at the count kept',
      r.ok && r.truncated && r.result.warnings.some((w) => w === 'Result truncated at 250 rows.'), r.ok && JSON.stringify(r.result.warnings));
  }

  // ── Page cap: an API that never runs out stops at MAX_PAGES ────────────────
  {
    let id = 0;
    const calls = serve(() => ({
      json: { object: 'list', has_more: true, data: Array.from({ length: 100 }, () => ({ id: 'ch_' + (id += 1), amount: 1 })) },
    }));
    const r = await run.runConnection('stripe', {}, { apiKey: 'rk_test_x' }, { table: 'charges' });
    ok('page cap: stops at MAX_PAGES requests', calls.length === http.MAX_PAGES, calls.length);
    ok('page cap: …which is 50,000 rows under the 1,000,000 cap, reported as truncated',
      r.ok && r.result.rowCount === http.MAX_PAGES * http.PAGE_SIZE && r.truncated, r.ok ? r.result.rowCount : r.error);
    ok('page cap: limit=100 on every page, each starting after the last id',
      calls.every((c) => c.url.searchParams.get('limit') === '100') &&
      calls[1].url.searchParams.get('starting_after') === 'ch_100' && calls[2].url.searchParams.get('starting_after') === 'ch_200');
  }

  // ── Page-number paging keeps ONE page size ─────────────────────────────────
  {
    const calls = serve((c) => ({ json: Array.from({ length: Number(c.url.searchParams.get('per_page')) }, (_, i) => ({ sha: `s${c.url.searchParams.get('page')}_${i}` })) }));
    const r = await run.runConnection('github', GH, GH_KEY, { table: 'commits' }, { rowLimit: 150 });
    ok('github paging: 150 rows from pages 1 and 2 of 100 (a changing per_page would skip rows)',
      r.ok && r.result.rowCount === 150 && calls.map((c) => c.url.searchParams.get('page') + '/' + c.url.searchParams.get('per_page')).join(',') === '1/100,2/100',
      calls.map((c) => c.url.search).join(' '));
  }

  // ── Date ranges reach the API's own filters ────────────────────────────────
  {
    const range = { from: '2024-01-01', to: '2024-01-31' };
    const from = Date.UTC(2024, 0, 1) / 1000;
    const to = Math.floor(Date.UTC(2024, 0, 31, 23, 59, 59, 999) / 1000);

    let calls = serve(() => ({ json: { data: [], has_more: false } }));
    await run.runConnection('stripe', range, { apiKey: 'rk_test_x' }, { table: 'invoices' });
    ok('stripe: From/To become created[gte]/created[lte] in unix seconds',
      calls[0].url.searchParams.get('created[gte]') === String(from) && calls[0].url.searchParams.get('created[lte]') === String(to),
      calls[0].url.search);
    calls = serve(() => ({ json: { data: [], has_more: false } }));
    await run.runConnection('stripe', {}, { apiKey: 'rk_test_x' }, { table: 'subscriptions' });
    ok('stripe: subscriptions ask for status=all (the default hides canceled ones)', calls[0].url.searchParams.get('status') === 'all');

    calls = serve(() => ({ json: [] }));
    await run.runConnection('github', { ...GH, ...range }, GH_KEY, { table: 'commits' });
    ok('github commits: From/To become since/until',
      calls[0].url.searchParams.get('since') === '2024-01-01T00:00:00.000Z' && calls[0].url.searchParams.get('until') === '2024-01-31T23:59:59.999Z',
      calls[0].url.search);

    // Newest-created first: three too new, four in range, then older — the walk
    // stops at the first older one and never asks for page 2.
    const page1 = [
      ...[5, 4, 3].map((d) => issue(100 + d, `2024-02-0${d}T00:00:00Z`)),
      ...[30, 20, 10, 1].map((d) => issue(d, `2024-01-${String(d).padStart(2, '0')}T12:00:00Z`)),
      ...Array.from({ length: 93 }, (_, i) => issue(900 + i, '2023-12-15T00:00:00Z')),
    ];
    calls = serve((c) => ({ json: c.url.searchParams.get('page') === '1' ? page1 : page1 }));
    const r = await run.runConnection('github', { ...GH, ...range }, GH_KEY, { table: 'issues' });
    ok('github issues: only the four created in range', r.ok && r.result.rowCount === 4, r.ok ? r.result.rowCount : r.error);
    ok('github issues: since=From reaches the server, and the walk stops without a page 2',
      calls.length === 1 && calls[0].url.searchParams.get('since') === '2024-01-01T00:00:00.000Z', calls.length);
    ok('github issues: a range ending the walk is NOT reported as truncated', r.ok && !r.truncated);

    calls = serve(() => ({ json: { results: [] } }));
    await run.runConnection('hubspot', range, { token: 'pat-x' }, { table: 'contacts' });
    const body = calls[0] && calls[0].body ? JSON.parse(calls[0].body) : {};
    const filters = body.filterGroups?.[0]?.filters || [];
    ok('hubspot: a range uses the search endpoint with createdate GTE/LTE in ms',
      calls[0]?.method === 'POST' && calls[0].url.pathname === '/crm/v3/objects/contacts/search' &&
      filters[0]?.operator === 'GTE' && filters[0]?.value === String(from * 1000) && filters[1]?.operator === 'LTE' && body.limit === 100,
      JSON.stringify(body));

    calls = serve(() => ({ json: [] }));
    const badDate = await run.runConnection('github', { ...GH, from: '01/02/2024' }, GH_KEY, { table: 'commits' });
    ok('a malformed date is refused before any request', !badDate.ok && /YYYY-MM-DD/.test(badDate.error) && calls.length === 0);
    const backwards = await run.runConnection('stripe', { from: '2024-02-01', to: '2024-01-01' }, { apiKey: 'rk_x' }, { table: 'charges' });
    ok('a From after To is refused', !backwards.ok && /after/.test(backwards.error));
  }

  // ── Declared hosts only ────────────────────────────────────────────────────
  {
    const ctx = run.buildContext({}, { token: 'tok_abcdef' });
    let calls = serve(() => ({ json: {} }));
    const off = await http.saasRequest(ctx, ['api.github.com'], { url: new URL('https://evil.example/steal') });
    ok('hosts: a URL on an undeclared host is refused, and nothing is sent', !off.ok && /Refused/.test(off.error) && calls.length === 0, JSON.stringify(off));
    const plain = await http.saasRequest(ctx, ['api.github.com'], { url: new URL('http://api.github.com/x') });
    ok('hosts: plain http to a declared host is refused too', !plain.ok && calls.length === 0);
    ok('hosts: a wildcard matches a subdomain only',
      http.hostAllowed('doc-0s.googleusercontent.com', ['*.googleusercontent.com']) &&
      !http.hostAllowed('googleusercontent.com.evil.example', ['*.googleusercontent.com']) &&
      !http.hostAllowed('evilgoogleusercontent.com', ['*.googleusercontent.com']));

    calls = serve(() => ({ status: 302, headers: { location: 'https://evil.example/collect' } }));
    const hop = await http.saasRequest(ctx, ['api.github.com'], { url: new URL('https://api.github.com/x'), headers: { authorization: 'Bearer tok_abcdef' } });
    ok('hosts: a redirect to an undeclared host is refused after one request', !hop.ok && /Refused/.test(hop.error) && calls.length === 1);

    calls = serve((c) => (c.url.hostname === 'a.example' ? { status: 302, headers: { location: 'https://b.example/y' } } : { text: 'ok' }));
    await http.saasRequest(ctx, ['a.example', 'b.example'], { url: new URL('https://a.example/x'), headers: { authorization: 'Bearer tok_abcdef' } });
    ok('hosts: a credential does not follow a redirect to another (declared) host',
      calls.length === 2 && calls[0].headers.authorization === 'Bearer tok_abcdef' && calls[1].headers.authorization === undefined);

    calls = serve(() => ({ json: {} }));
    const csv = await run.runConnection('google-sheets', { csvUrl: 'https://evil.example/spreadsheets/d/e/x/pub?output=csv' }, {}, { table: 'sheet' });
    ok('sheets: a "published CSV" link off docs.google.com is refused with no request', !csv.ok && calls.length === 0, JSON.stringify(csv));
    const notCsv = await run.runConnection('google-sheets', { csvUrl: 'https://docs.google.com/spreadsheets/d/abc/edit' }, {}, { table: 'sheet' });
    ok('sheets: a link that is not the published CSV explains where to get one', !notCsv.ok && /Publish to web/.test(notCsv.error));
  }

  // ── Secrets never reach an error ───────────────────────────────────────────
  {
    serve((c) => ({ status: 401, json: { message: `Bad credentials: ${c.headers.authorization}` } }));
    const r = await run.runConnection('github', GH, GH_KEY, { table: 'issues' });
    ok('secrets: an API that echoes the token back → the error names the status, not the token',
      !r.ok && /HTTP 401/.test(r.error) && !r.error.includes('ghp_s3cretToken'), JSON.stringify(r));

    serve((c) => ({ status: 400, json: { error: { message: `Bad request for ${c.url.href}` } } }));
    const g = await run.runConnection('google-sheets', { spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74', range: 'A' }, { apiKey: 'AIzaSECRETkey42' }, { table: 'sheet' });
    ok('secrets: the Sheets key (a query parameter) is scrubbed from an error that quotes the URL',
      !g.ok && !g.error.includes('AIzaSECRETkey42') && /HTTP 400/.test(g.error), JSON.stringify(g));

    const listed = await run.listTables('github', GH, { token: 'ghp_s3cretToken' });
    ok('secrets: …and from listTables', !listed.ok && !listed.error.includes('ghp_s3cretToken'));
  }

  // ── Timeout ────────────────────────────────────────────────────────────────
  {
    serve(() => ({ hang: true }));
    const t0 = Date.now();
    const r = await run.runConnection('notion', { databaseId: '0123456789abcdef0123456789abcdef' }, { token: 'secret_x' }, { table: 'pages' }, { timeoutMs: 60 });
    ok('timeout: a hung request is aborted at the per-request timeout', !r.ok && /timed out/.test(r.error) && Date.now() - t0 < 5000, JSON.stringify(r));
  }

  // ── The smoke's fixture override: loopback only ────────────────────────────
  {
    ok('override: http://127.0.0.1:<port> is honoured', http.fixtureOrigin('http://127.0.0.1:41234') === 'http://127.0.0.1:41234');
    ok('override: http://localhost:<port> is honoured', http.fixtureOrigin('http://localhost:5000/') === 'http://localhost:5000');
    ok('override: any other host is ignored', http.fixtureOrigin('http://evil.example:80') === null && http.fixtureOrigin('http://127.0.0.1.evil.example:81') === null);
    ok('override: https, a missing port or credentials are ignored',
      http.fixtureOrigin('https://127.0.0.1:443') === null && http.fixtureOrigin('http://127.0.0.1') === null &&
      http.fixtureOrigin('http://user:pw@127.0.0.1:81') === null && http.fixtureOrigin('not a url') === null);

    const calls = serve(() => ({ json: [] }));
    process.env[http.FIXTURE_ENV] = 'http://evil.example:8080';
    await run.runConnection('github', GH, GH_KEY, { table: 'commits' });
    process.env[http.FIXTURE_ENV] = 'http://127.0.0.1:41234';
    await run.runConnection('github', GH, GH_KEY, { table: 'commits' });
    const refused = await http.saasRequest(run.buildContext({}, {}), ['api.github.com'], { url: new URL('https://evil.example/') });
    delete process.env[http.FIXTURE_ENV];
    ok('override: a non-loopback value leaves the request on the declared host', calls[0]?.url.origin === 'https://api.github.com', calls[0]?.url.href);
    ok('override: a loopback value re-points the SAME path at the fixture server',
      calls[1]?.url.origin === 'http://127.0.0.1:41234' && calls[1].url.pathname === '/repos/octo/demo/commits', calls[1]?.url.href);
    ok('override: it never widens the host check (an undeclared host is still refused)', !refused.ok && calls.length === 2);
  }

  http.setFetch(null);
  finish();
})();
