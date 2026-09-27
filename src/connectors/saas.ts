// SaaS connectors — MAIN PROCESS ONLY.
//
// Six hosted APIs as read-only sources:
//
//   google-sheets  a "Publish to web" CSV link, or the Sheets API (key + range)
//   airtable       one table of a base              offset-paged, pageSize
//   notion         one database, properties → columns  cursor-paged, page_size
//   stripe         charges / invoices / customers / subscriptions   limit + starting_after
//   github         issues / pulls / commits of one repo             per_page + page
//   hubspot        contacts / deals / companies     limit + after
//
// Each resource is a TABLE in the workbench tree, so it imports, previews and
// refreshes through exactly the path a SQL table does: connectionRun compiles
// the table into `select * from "issues" limit N`, and run() reads the resource
// name back out of that (the one statement shape these sources answer). A
// dataset's origin is therefore the ordinary `{kind:'connection', table}`, and a
// scheduled or manual refresh re-runs it with no SaaS-specific code anywhere.
//
// The three connector rules live in saasHttp.ts: every request goes to a host in
// the def's `hosts` (and is refused otherwise), secrets ride in headers and are
// scrubbed from every error, and every page uses the API's own page-size
// parameter under a row cap and a page cap. Date ranges go to the API's own
// filters (Stripe `created[gte|lte]`, GitHub `since`/`until` plus a
// newest-first walk that stops at `from`, HubSpot's search filter), so the
// server does the filtering.
//
// Each API's request code (URL, paging, date filter, form checks) is
// saasApis.ts; this file is the part every source shares. Nothing here writes.

import type {
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorField,
  ConnectorRows,
  ConnectorSchema,
  ConnectorTable,
  ConnectorTables,
} from './types';
import type { SaasError } from './saasHttp';
import {
  AIRTABLE_HOSTS, airtableFetch, err, GITHUB_HOSTS, githubFetch, HUBSPOT_HOSTS, hubspotFetch, NOTION_HOSTS,
  notionFetch, SHEETS_HOSTS, sheetsFetch, STRIPE_HOSTS, stripeFetch,
} from './saasApis';
import type { Result } from './saasApis';

const RESOURCE_SQL = /^\s*select\s+\*\s+from\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+limit\s+\d+)?\s*;?\s*$/i;

/** The resource a statement names — `select * from "issues" limit 500`, as
 *  connectionRun compiles a table, or just `issues` — or null. */
export function resourceOf(sql: string, resources: readonly string[]): string | null {
  const m = RESOURCE_SQL.exec(String(sql || ''));
  const name = m ? m[1] : String(sql || '').trim();
  return resources.includes(name) ? name : null;
}

// ── the shared shape of a SaaS source ────────────────────────────────────────

interface SaasSpec {
  id: string;
  label: string;
  blurb: string;
  hosts: readonly string[];
  fields: ConnectorField[];
  /** The tables this source offers. */
  resources: readonly string[];
  fetch(ctx: ConnectorContext, resource: string): Promise<Result>;
}

/** Rows a tree expand reads to describe a resource's columns: one small page. */
const DESCRIBE_ROWS = 20;

function defOf(spec: SaasSpec): ConnectorDef {
  const noSql = (): ConnectorError => err(
    `${spec.label} has no SQL. Pick ${spec.resources.join(', ')} on the left, or run: select * from ${spec.resources[0]}`,
  );
  return {
    id: spec.id,
    label: spec.label,
    family: 'saas',
    category: 'Apps & SaaS',
    readOnly: true,
    blurb: spec.blurb,
    hosts: spec.hosts,
    fields: spec.fields,

    // The reachability check AND the table list: one page of ONE record per
    // resource. A resource the credential cannot read (403/404) is left out of
    // the tree rather than failing the test; a rejected credential (401) or a
    // form problem fails at once, because it would fail every resource the same.
    async listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
      const probe = { ...ctx, rowLimit: 1 };
      const tables: ConnectorTable[] = [];
      let first: SaasError | null = null;
      for (const name of spec.resources) {
        const r = await spec.fetch(probe, name);
        if (r.ok) { tables.push({ name }); continue; }
        if (r.status === undefined || r.status === 401) return err(r.error);
        first = first || r;
      }
      return tables.length ? { ok: true, tables } : err(first ? first.error : 'Nothing to read.');
    },

    async run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
      const name = resourceOf(sql, spec.resources);
      if (!name) return noSql();
      const r = await spec.fetch(ctx, name);
      return r.ok ? r : err(r.error);
    },

    // Columns come from one small page, typed the way an import types them —
    // an API's schema is its records, so there is no cheaper catalog to ask.
    async describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
      const name = resourceOf(table, spec.resources);
      if (!name) return err(`No such table: ${String(table ?? '').slice(0, 60)}`);
      const r = await spec.fetch({ ...ctx, rowLimit: DESCRIBE_ROWS }, name);
      return r.ok ? { ok: true, columns: r.columns.map((c) => ({ name: c.name, type: c.type })) } : err(r.error);
    },
  };
}

const fromField = (help: string): ConnectorField =>
  ({ key: 'from', label: 'From date', type: 'text', placeholder: 'YYYY-MM-DD', help });
const toField = (help: string): ConnectorField =>
  ({ key: 'to', label: 'To date', type: 'text', placeholder: 'YYYY-MM-DD', help });

// ── the definitions ──────────────────────────────────────────────────────────

const SPECS: SaasSpec[] = [
  {
    id: 'google-sheets',
    label: 'Google Sheets',
    blurb: 'A "Publish to web" CSV link, or a range read through the Sheets API.',
    hosts: SHEETS_HOSTS,
    resources: ['sheet'],
    fetch: (ctx) => sheetsFetch(ctx),
    fields: [
      { key: 'csvUrl', label: 'Published CSV link', type: 'text', placeholder: 'https://docs.google.com/spreadsheets/d/e/…/pub?output=csv',
        help: 'File → Share → Publish to web → CSV. Leave blank to read through the Sheets API below.' },
      { key: 'spreadsheetId', label: 'Spreadsheet ID', type: 'text', placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        help: 'For the API: the code between /d/ and /edit in the sheet\'s address.' },
      { key: 'range', label: 'Range', type: 'text', default: 'Sheet1', placeholder: 'Sheet1 or Sheet1!A1:F500',
        help: 'A sheet name or an A1 range. The first row is the header.' },
      { key: 'apiKey', label: 'API key', type: 'password', secret: true,
        help: 'A Google Cloud key with the Sheets API enabled, for a sheet shared "Anyone with the link". Sent only to sheets.googleapis.com.' },
    ],
  },
  {
    id: 'airtable',
    label: 'Airtable',
    blurb: 'One table of a base, every page, read-only.',
    hosts: AIRTABLE_HOSTS,
    resources: ['records'],
    fetch: (ctx) => airtableFetch(ctx),
    fields: [
      { key: 'token', label: 'Personal access token', type: 'password', required: true, secret: true,
        help: 'Create one at airtable.com/create/tokens with the data.records:read scope on this base.' },
      { key: 'baseId', label: 'Base ID', type: 'text', required: true, placeholder: 'appXXXXXXXXXXXXXX',
        help: 'Starts with "app" — the first code in the base\'s address.' },
      { key: 'table', label: 'Table', type: 'text', required: true, placeholder: 'Tasks', help: 'The table\'s name or its ID (tbl…).' },
      { key: 'view', label: 'View', type: 'text', help: 'Optional. Only the records this view shows, in its order.' },
    ],
  },
  {
    id: 'notion',
    label: 'Notion',
    blurb: 'One database, each property a column.',
    hosts: NOTION_HOSTS,
    resources: ['pages'],
    fetch: (ctx) => notionFetch(ctx),
    fields: [
      { key: 'token', label: 'Integration secret', type: 'password', required: true, secret: true,
        help: 'From notion.so/my-integrations. Share the database with the integration first, or Notion answers "not found".' },
      { key: 'databaseId', label: 'Database', type: 'text', required: true, placeholder: 'https://www.notion.so/…?v=… or its 32-character ID',
        help: 'Paste the database\'s link, or its ID.' },
    ],
  },
  {
    id: 'stripe',
    label: 'Stripe',
    blurb: 'Charges, invoices, customers and subscriptions, with a restricted key.',
    hosts: STRIPE_HOSTS,
    resources: ['charges', 'invoices', 'customers', 'subscriptions'],
    fetch: stripeFetch,
    fields: [
      { key: 'apiKey', label: 'Restricted key', type: 'password', required: true, secret: true, placeholder: 'rk_live_…',
        help: 'Developers → API keys → Create restricted key, with Read on what you want here. Secret keys (sk_) are refused: they can write.' },
      fromField('Optional. Stripe filters on each record\'s created date (UTC). Amounts are in the currency\'s minor unit.'),
      toField('Optional. Inclusive.'),
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    blurb: 'Issues, pull requests and commits of one repository.',
    hosts: GITHUB_HOSTS,
    resources: ['issues', 'pulls', 'commits'],
    fetch: githubFetch,
    fields: [
      { key: 'token', label: 'Personal access token', type: 'password', required: true, secret: true,
        help: 'A fine-grained token with read-only Issues, Pull requests and Contents on this repository.' },
      { key: 'repo', label: 'Repository', type: 'text', required: true, placeholder: 'octocat/hello-world',
        help: 'owner/name, or the repository\'s github.com link.' },
      fromField('Optional. Issues and pull requests by created date, commits by commit date (UTC).'),
      toField('Optional. Inclusive.'),
    ],
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    blurb: 'Contacts, deals and companies, with a private app token.',
    hosts: HUBSPOT_HOSTS,
    resources: ['contacts', 'deals', 'companies'],
    fetch: hubspotFetch,
    fields: [
      { key: 'token', label: 'Private app access token', type: 'password', required: true, secret: true,
        help: 'Settings → Integrations → Private apps, with the crm.objects.*.read scopes. Only the objects it can read are listed.' },
      fromField('Optional. Filters on created date through HubSpot\'s search API, which returns at most 10,000 records.'),
      toField('Optional. Inclusive.'),
    ],
  },
];

export const CONNECTORS: ConnectorDef[] = SPECS.map(defOf);
