// The six SaaS connectors (src/connectors/saas.ts): each one's recorded
// response → rows and COLUMN TYPES, through the registry and the real dispatch
// (connectionRun.runConnection), with an injected fake fetch — no network.
//
// The type assertions are the point. Several columns below would be typed
// NUMBER by the CSV detector ("94107", "12345", an 11-digit HubSpot id) and must
// come out TEXT because the API sent or documents them as text; an amount must
// stay a number; ISO timestamps must be dates.
//
// Bounds, hosts and secrets are test-saasBounds.ts.
//
//   npm run build:ts && node scripts/test-connectorsSaas.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { fakeFetch, fixture, fixtureText } from './saasFake';
import type { FakeCall, FakeReply } from './saasFake';

// ponytail: compiled siblings of the .ts sources.
const registry: typeof import('../src/connectors') = require('../src/connectors');
const run: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const http: typeof import('../src/connectors/saasHttp') = require('../src/connectors/saasHttp');
const saas: typeof import('../src/connectors/saas') = require('../src/connectors/saas');
const apis: typeof import('../src/connectors/saasApis') = require('../src/connectors/saasApis');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');

type Cols = { name: string; type: string }[];
const typesOf = (cols: Cols): Record<string, string> => Object.fromEntries(cols.map((c) => [c.name, c.type]));

function serve(route: (c: FakeCall) => FakeReply): FakeCall[] {
  const f = fakeFetch(route);
  http.setFetch(f.fetch);
  return f.calls;
}

async function dispatch(id: string, values: Record<string, unknown>, secrets: Record<string, string>, table: string, rowLimit = 1000) {
  return run.runConnection(id, values, secrets, { table }, { rowLimit });
}

void (async () => {
  // ── Registry ───────────────────────────────────────────────────────────────
  const ids = ['google-sheets', 'airtable', 'notion', 'stripe', 'github', 'hubspot'];
  const defs = ids.map((id) => registry.getConnector(id));
  ok('registry: all six SaaS connectors are registered', defs.every(Boolean), JSON.stringify(registry.registryDiagnostics().errors['./saas'] || ''));
  ok('registry: each is family saas, category Apps & SaaS, read-only',
    defs.every((d) => d && d.family === 'saas' && d.category === 'Apps & SaaS' && d.readOnly === true));
  ok('registry: each declares its host(s)', defs.every((d) => d && Array.isArray(d.hosts) && d.hosts.length > 0));
  ok('registry: each is browsable (a tree of resources)', defs.every((d) => d && typeof d.describeTable === 'function'));
  const cat = registry.connectorCatalog().find((e) => e.id === 'github');
  ok('catalog: the renderer is told the declared hosts', !!cat && JSON.stringify(cat.hosts) === '["api.github.com"]', JSON.stringify(cat));
  ok('catalog: every credential field is a secret',
    ids.every((id) => registry.getConnector(id)!.fields.filter((f) => /token|key/i.test(f.key)).every((f) => f.secret === true)));

  // ── GitHub ─────────────────────────────────────────────────────────────────
  {
    const calls = serve((c) => {
      if (c.url.pathname === '/repos/octo/demo/issues') return { json: fixture('github-issues.json') };
      if (c.url.pathname === '/repos/octo/demo/commits') return { json: fixture('github-commits.json') };
      if (c.url.pathname === '/repos/octo/demo/pulls') return { status: 403, json: { message: 'Resource not accessible by personal access token' } };
      return { status: 404, json: { message: 'Not Found' } };
    });
    const values = { repo: 'https://github.com/octo/demo' };
    const secrets = { token: 'ghp_testtoken123' };
    const r = await dispatch('github', values, secrets, 'issues');
    ok('github: issues import', r.ok, !r.ok && r.error);
    if (r.ok) {
      const res = r.result;
      ok('github: the pull request the issues endpoint also lists is left out', res.rowCount === 2, res.rowCount);
      const t = typesOf(res.columns);
      ok('github: id is TEXT, number and comments are numbers, timestamps are dates',
        t.id === 'text' && t.number === 'number' && t.comments === 'number' && t.created_at === 'date' && t.closed_at === 'date',
        JSON.stringify(t));
      const row = res.rows[0];
      const col = (n: string) => res.columns.findIndex((c) => c.name === n);
      ok('github: nested author, labels, assignees and milestone flatten to readable text',
        row[col('author')] === 'mona' && row[col('labels')] === 'bug, ui' && row[col('assignees')] === 'hubot, mona' && row[col('milestone')] === 'v1.2',
        JSON.stringify(row));
      ok('github: the 10-digit id survives as its digits', row[col('id')] === '2233445566', row[col('id')]);
    }
    ok('github: the token travels as a Bearer header, never in the URL',
      calls.every((c) => c.headers.authorization === 'Bearer ghp_testtoken123' && !c.url.href.includes('ghp_testtoken123')));
    ok('github: every request carries per_page, state=all and newest-created-first',
      calls.every((c) => c.url.searchParams.get('per_page') === '100' && c.url.searchParams.get('state') === 'all' &&
        c.url.searchParams.get('sort') === 'created' && c.url.searchParams.get('direction') === 'desc'));

    const commits = await dispatch('github', values, secrets, 'commits');
    ok('github: commits import with the first line of the message', commits.ok && commits.result.rows[0][1] === 'Fix legend overlap',
      commits.ok ? JSON.stringify(commits.result.rows[0]) : commits.error);
    ok('github: commit dates are dates', commits.ok && typesOf(commits.result.columns).authored_at === 'date');

    calls.length = 0;
    const tables = await run.listTables('github', values, secrets);
    ok('github: listTables lists what the token can read, leaving out a 403 resource',
      tables.ok && tables.tables.map((x) => x.name).join(',') === 'issues,commits', JSON.stringify(tables));
    ok('github: …probing each with a page of ONE', calls.every((c) => c.url.searchParams.get('per_page') === '1'), calls.length);

    serve(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    const bad = await run.testConnection('github', values, secrets);
    ok('github: a rejected token fails Test with the status', !bad.ok && /HTTP 401/.test(bad.error), JSON.stringify(bad));
  }

  // ── Airtable ───────────────────────────────────────────────────────────────
  {
    const calls = serve((c) => c.url.searchParams.get('offset')
      ? { json: { records: [{ id: 'recThird', createdTime: '2024-01-12T00:00:00.000Z', fields: { Name: 'Linus', Zip: '60601', Visits: 1 } }] } }
      : { json: fixture('airtable-records.json') });
    const r = await dispatch('airtable', { baseId: 'appAbc123', table: 'Tasks & Notes' }, { token: 'pat_test' }, 'records');
    ok('airtable: follows the offset to the last page', r.ok && r.result.rowCount === 3 && calls.length === 2, r.ok ? r.result.rowCount : r.error);
    ok('airtable: pageSize on every page, maxRecords bounds the total',
      calls.every((c) => c.url.searchParams.get('pageSize') === '100' && c.url.searchParams.get('maxRecords') === '1001'));
    ok('airtable: the table name is path-encoded', calls[0].url.pathname === '/v0/appAbc123/Tasks%20%26%20Notes', calls[0].url.pathname);
    if (r.ok) {
      const t = typesOf(r.result.columns);
      ok('airtable: a zip sent as a STRING stays text (the CSV detector alone would say number)',
        t.Zip === 'text' && parse.detectColumnType(['94107', '10001', '60601']) === 'number', JSON.stringify(t));
      ok('airtable: a number field is a number, a date field a date, a checkbox text',
        t.Visits === 'number' && t.Due === 'date' && t.Done === 'text' && t.created_time === 'date', JSON.stringify(t));
      const names = r.result.columns.map((c) => c.name);
      ok('airtable: a collaborator flattens to dotted columns', ['Owner.id', 'Owner.email', 'Owner.name'].every((n) => names.includes(n)), names.join(','));
      const col = (n: string) => names.indexOf(n);
      ok('airtable: lists join, attachments read as file names',
        r.result.rows[0][col('Tags')] === 'vip, west' && r.result.rows[0][col('Attachments')] === 'x.png', JSON.stringify(r.result.rows[0]));
      ok('airtable: a checkbox Airtable omits reads as empty, not false', r.result.rows[1][col('Done')] === null);
    }
  }

  // ── Notion ─────────────────────────────────────────────────────────────────
  {
    const calls = serve(() => ({ json: fixture('notion-query.json') }));
    const link = 'https://www.notion.so/acme/Feed-0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210';
    const r = await dispatch('notion', { databaseId: link }, { token: 'secret_notion' }, 'pages');
    ok('notion: queries the database the link names (not the view, not the title)',
      calls[0]?.url.pathname === '/v1/databases/0123456789abcdef0123456789abcdef/query', calls[0]?.url.pathname);
    ok('notion: POSTs its page_size with the pinned API version',
      calls[0]?.method === 'POST' && JSON.parse(calls[0].body).page_size === 100 && calls[0].headers['notion-version'] === '2022-06-28');
    if (r.ok) {
      const t = typesOf(r.result.columns);
      ok('notion: number and number-formula are numbers; date and created_time are dates',
        t.Points === 'number' && t.Score === 'number' && t.Due === 'date' && t.Created === 'date', JSON.stringify(t));
      ok('notion: a rich_text of digits stays text', t.Code === 'text' && parse.detectColumnType(['12345', '67890']) === 'number');
      ok('notion: checkbox, select, status, people and relation are text', ['Done', 'Status', 'Tags', 'Owner', 'Related', 'Ticket'].every((n) => t[n] === 'text'));
      const row = r.result.rows[0];
      const col = (n: string) => r.result.columns.findIndex((c) => c.name === n);
      ok('notion: properties flatten to readable cells',
        row[col('Name')] === 'Launch plan' && row[col('Status')] === 'In progress' && row[col('Tags')] === 'Q1, Marketing' &&
        row[col('Owner')] === 'Ada' && row[col('Related')] === 'r-1, r-2' && row[col('Ticket')] === 'TASK-7' && row[col('Score')] === 42.5,
        JSON.stringify(row));
      ok('notion: an empty select/date is empty, not "null"', r.result.rows[1][col('Status')] === null && r.result.rows[1][col('Due')] === null);
    } else ok('notion: import', false, r.error);
  }

  // ── Stripe ─────────────────────────────────────────────────────────────────
  {
    const calls = serve(() => ({ json: fixture('stripe-charges.json') }));
    const r = await dispatch('stripe', {}, { apiKey: 'rk_test_abc123' }, 'charges');
    ok('stripe: charges import', r.ok && r.result.rowCount === 2, r.ok ? r.result.rowCount : r.error);
    ok('stripe: limit on the request, key as a Bearer header',
      calls[0]?.url.searchParams.get('limit') === '100' && calls[0]?.headers.authorization === 'Bearer rk_test_abc123');
    if (r.ok) {
      const t = typesOf(r.result.columns);
      const names = r.result.columns.map((c) => c.name);
      const col = (n: string) => names.indexOf(n);
      ok('stripe: amount stays an integer number beside its currency',
        t.amount === 'number' && t.currency === 'text' && r.result.rows[0][col('amount')] === 1099 && r.result.rows[0][col('currency')] === 'usd');
      ok('stripe: a unix `created` becomes an ISO date',
        t.created === 'date' && r.result.rows[0][col('created')] === new Date(1709633700 * 1000).toISOString(), String(r.result.rows[0][col('created')]));
      ok('stripe: metadata of digits stays text', t['metadata.order_id'] === 'text', JSON.stringify(t));
      ok('stripe: nested objects flatten to dotted columns; the constant `object` is dropped',
        names.includes('billing_details.address.city') && names.includes('payment_method_details.card.brand') && !names.includes('object'),
        names.join(','));
      ok('stripe: a nested list object reads as its items', r.result.rows[1][col('refunds')] === 're_1' && r.result.rows[0][col('refunds')] === null);
    }
    calls.length = 0;
    const sk = await dispatch('stripe', {}, { apiKey: 'sk_live_nope' }, 'charges');
    ok('stripe: a full secret key is refused before any request', !sk.ok && /restricted key/.test(sk.error) && calls.length === 0);

    serve((c) => (c.url.pathname === '/v1/charges' ? { status: 403, json: { error: { message: 'The provided key does not have the required permissions' } } } : { json: { data: [], has_more: false } }));
    const t = await run.listTables('stripe', {}, { apiKey: 'rk_test_abc123' });
    ok('stripe: a key without Read on charges still lists the rest', t.ok && t.tables.map((x) => x.name).join(',') === 'invoices,customers,subscriptions', JSON.stringify(t));
  }

  // ── HubSpot ────────────────────────────────────────────────────────────────
  {
    const calls = serve(() => ({ json: fixture('hubspot-deals.json') }));
    const r = await dispatch('hubspot', {}, { token: 'pat-na1-test' }, 'deals');
    ok('hubspot: deals import from the list endpoint', r.ok && r.result.rowCount === 2 && calls[0]?.url.pathname === '/crm/v3/objects/deals');
    ok('hubspot: asks for its documented properties, with a page limit',
      !!calls[0]?.url.searchParams.get('properties')?.includes('amount') && calls[0]?.url.searchParams.get('limit') === '100');
    if (r.ok) {
      const t = typesOf(r.result.columns);
      const col = (n: string) => r.result.columns.findIndex((c) => c.name === n);
      ok('hubspot: amount (sent as "1500.00") is a number; dates are dates',
        t.amount === 'number' && r.result.rows[0][col('amount')] === 1500 && t.closedate === 'date' && t.createdate === 'date', JSON.stringify(t));
      ok('hubspot: the 11-digit id and the owner id stay text', t.id === 'text' && t.hubspot_owner_id === 'text' && r.result.rows[0][col('id')] === '12345678901');
      ok('hubspot: an empty amount is empty, not 0', r.result.rows[1][col('amount')] === null);
    }
  }

  // ── Google Sheets ──────────────────────────────────────────────────────────
  {
    const calls = serve(() => ({ json: fixture('sheets-values.json') }));
    const r = await dispatch('google-sheets', { spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', range: 'Sheet1' }, { apiKey: 'AIzaTestKey123' }, 'sheet');
    ok('sheets api: reads the range', r.ok && r.result.rowCount === 3, r.ok ? r.result.rowCount : r.error);
    const u = calls[0]?.url;
    ok('sheets api: a bare sheet name is bounded server-side to header + rows',
      !!u && decodeURIComponent(u.pathname).endsWith("/values/'Sheet1'!1:1001"), u && u.pathname);
    ok('sheets api: unformatted values (so the sheet\'s own number type arrives)', u?.searchParams.get('valueRenderOption') === 'UNFORMATTED_VALUE');
    if (r.ok) {
      const t = typesOf(r.result.columns);
      ok('sheets api: a text-formatted zip stays text, a numeric column is a number, dates are dates',
        t.Zip === 'text' && t.Sales === 'number' && t.Day === 'date' && t.Won === 'text', JSON.stringify(t));
      ok('sheets api: a trailing cell the API omits is empty', r.result.rows[1][4] === null);
    }

    const csvCalls = serve((c): FakeReply => c.url.hostname === 'docs.google.com'
      ? { status: 307, headers: { location: 'https://doc-0s-sheets.googleusercontent.com/pub/abc?output=csv' } }
      : { text: fixtureText('sheets-published.csv'), headers: { 'content-type': 'text/csv' } });
    const csv = await dispatch('google-sheets', { csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-test/pub?output=csv' }, {}, 'sheet');
    ok('sheets csv: follows Google\'s redirect to the declared googleusercontent host',
      csv.ok && csvCalls.length === 2 && csvCalls[1].url.hostname.endsWith('.googleusercontent.com'), csv.ok ? csvCalls.length : csv.error);
    if (csv.ok) {
      const t = typesOf(csv.result.columns);
      ok('sheets csv: types are detected exactly as for an imported .csv (007 stays text)',
        t.sku === 'text' && t.revenue === 'number' && t.day === 'date' && csv.result.rows[0][1] === '007', JSON.stringify(t));
    }
  }

  // ── Pure helpers ───────────────────────────────────────────────────────────
  ok('resourceOf: reads the table connectionRun compiles', saas.resourceOf('select * from "issues" limit 500', ['issues', 'pulls']) === 'issues');
  ok('resourceOf: a bare name, or an unquoted select, also works',
    saas.resourceOf('pulls', ['issues', 'pulls']) === 'pulls' && saas.resourceOf('SELECT * FROM issues;', ['issues']) === 'issues');
  ok('resourceOf: anything else is not a resource',
    saas.resourceOf('select id from issues', ['issues']) === null && saas.resourceOf('select * from "users"', ['issues']) === null);
  ok('boundRange: whole columns get a row bound; an explicit range is left alone',
    apis.boundRange('Sales!A:F', 10) === "'Sales'!A1:F11" && apis.boundRange('Sales!B2:C9', 10) === "'Sales'!B2:C9" &&
    apis.boundRange("My 'Q1' sheet", 5) === "'My ''Q1'' sheet'!1:6");
  ok('notionId: a bare dashed id works', apis.notionId('01234567-89ab-cdef-0123-456789abcdef') === '0123456789abcdef0123456789abcdef');
  ok('githubRepo: owner/name, a link, or nothing',
    apis.githubRepo('octo/demo') === 'octo/demo' && apis.githubRepo('https://github.com/octo/demo.git') === 'octo/demo' &&
    apis.githubRepo('../etc/passwd') === null && apis.githubRepo('octo/demo/issues') === null);

  http.setFetch(null);
  finish();
})();
