// dbt Cloud's Semantic Layer as a semantic layer, BETA (semantic layer part 7, d1; docs/live-data/dbt-semantic-layer.md,
// docs/semantic-layer/07-portability.md D14, D18) — MAIN PROCESS ONLY.
//
// One registry entry, in the "Semantic layers" group, with the `semantic` capability: dbt's GraphQL API as plain JSON
// POSTs (no GraphQL client), every document a constant (./dbtWire.ts), names and values as variables. Beta until a
// real dbt Cloud account runs the warehouse nightly: everything dbt-specific is as documented, unverified.
//
//   listModels     savedQueriesPaginated: a dataset is a saved query
//   describeModel  savedQuery + dimensionsPaginated (types) + metricsPaginated (types) + measures (additivity, SDK)
//   run            the saved query read again (its filter, its names), createQuery, `query` polled until SUCCESSFUL or
//                  FAILED, pages 2…totalPages, read back by ./dbtWire.ts; on the caller's signal or the timeout the
//                  polling stops and one best-effort cancelQuery goes out (D18)
//   listTables     the saved queries (the connection test); `run`, the copy path, refuses: a layer has no rows to copy
//
// NETWORK. Three fixed hosts (`hosts`), chosen by the Region select: `send` refuses any URL that is not https on one
// of them before the transport is called, and the transport is httpShared.httpRequest, which on the server resolves,
// checks and pins every request (ssrf.ts) and never follows a redirect. SECRETS. The service token is the `token`
// field (`secret: true`, `connection.token` in the secrets store); it rides in the Authorization header only, and
// every error is redacted of it (`safeError`).

import { DATE_GRAINS } from '../analysis/categoryKey';
import type { DateGrain } from '../analysis/categoryKey';
import type { ColumnType } from '../data/parse';
import type { Cell, HttpRequestOptions, HttpResult } from './httpShared';
import { CANCELLED, asArray, asString, budgetMs, httpRequest, prop, rowCap, secret, str, timeoutError } from './httpShared';
import { DBT_HOSTS, DBT_IDENT_RE, DBT_REGIONS, DOCS, ENV_ID_RE, dataOf, finishRows, isDbtBody, readPage, type DbtBody } from './dbtWire';
import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSemantic } from './types';
import { safeError } from './types';

const CANCEL_MS = 5_000;
const MAX_PAGES = 20; // catalog pages; a question's pages stop at the row cap

// ── the transport seam ──────────────────────────────────────────────────────

export type Transport = (opts: HttpRequestOptions) => Promise<HttpResult>;
let transport: Transport = httpRequest;

/** Route every dbt request through `t` (scripts/semanticFakeDbt.ts); null restores httpRequest. Tests only. */
export function setTransport(t: Transport | null): void {
  if (t && process.env.ORDINATE_ENV === 'prod') throw new Error('[dbt] a test transport cannot be set when ORDINATE_ENV=prod');
  transport = t || httpRequest;
}

/** The one door to the network: https, a declared host, then the transport. */
export async function send(opts: HttpRequestOptions): Promise<HttpResult> {
  if (opts.url.protocol !== 'https:' || !DBT_HOSTS.includes(opts.url.hostname)) {
    throw new Error(`Refused: ${opts.url.hostname || 'that address'} is not a host this source declares (${DBT_HOSTS.join(', ')}).`);
  }
  return transport(opts);
}

type Gql = { ok: true; data: unknown } | ConnectorError;

/** The endpoint and environment from the form, or why not. */
function target(ctx: ConnectorContext): { url: URL; env: number } | ConnectorError {
  const region = DBT_REGIONS[str(ctx, 'region', 'north-america')];
  if (!region || !Object.prototype.hasOwnProperty.call(DBT_REGIONS, str(ctx, 'region', 'north-america'))) return { ok: false, error: 'Unknown dbt region' };
  const env = str(ctx, 'environmentId').trim();
  if (!ENV_ID_RE.test(env)) return { ok: false, error: 'The dbt environment ID is a number (Deploy → Environments)' };
  return { url: new URL(`https://${region.host}/api/graphql`), env: Number(env) };
}

/** One GraphQL document and its variables → its `data`, or a redacted error. `deadline` bounds it. */
async function gql(ctx: ConnectorContext, query: string, variables: Record<string, unknown>, deadline: number, signal: AbortSignal | null | undefined = ctx.signal): Promise<Gql> {
  const t = target(ctx);
  if ('ok' in t) return t;
  const token = secret(ctx, 'token');
  if (!token) return { ok: false, error: 'The dbt service token is required' };
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, error: timeoutError(budgetMs(ctx)).message };
  try {
    const res = await send({
      url: t.url,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { environmentId: t.env, ...variables } }),
      timeoutMs: left,
      ...(signal ? { signal } : {}),
    });
    if (res.truncated) return { ok: false, error: 'dbt answered past the 100 MB ceiling' };
    let json: unknown;
    try {
      json = JSON.parse(res.body) as unknown;
    } catch {
      json = undefined;
    }
    const d = json === undefined ? null : dataOf(json);
    if (res.status < 200 || res.status >= 300) return { ok: false, error: safeError(`dbt answered HTTP ${res.status}${d && !d.ok ? `: ${d.error}` : ''}`, ctx.secrets) };
    if (!d) return { ok: false, error: 'dbt answered with no JSON' };
    return d.ok ? d : { ok: false, error: safeError(`dbt: ${d.error}`, ctx.secrets) };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/** Every item of a paginated listing (at most MAX_PAGES pages). */
async function pages(ctx: ConnectorContext, doc: string, field: string, vars: Record<string, unknown>, deadline: number): Promise<{ ok: true; items: unknown[] } | ConnectorError> {
  const items: unknown[] = [];
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    const r = await gql(ctx, doc, { ...vars, pageNum }, deadline);
    if (!r.ok) return r;
    const page = prop(r.data, field);
    items.push(...asArray(prop(page, 'items')));
    if (!(Number(prop(page, 'totalPages')) > pageNum)) return { ok: true, items };
  }
  return { ok: false, error: `dbt lists more than ${MAX_PAGES} pages; Ordinate reads ${MAX_PAGES}` };
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

async function listModels(ctx: ConnectorContext): Promise<Awaited<ReturnType<ConnectorSemantic['listModels']>>> {
  const r = await pages(ctx, DOCS.savedQueries, 'savedQueriesPaginated', {}, Date.now() + budgetMs(ctx));
  if (!r.ok) return r;
  const models = r.items.filter((q) => DBT_IDENT_RE.test(asString(prop(q, 'name')))).map((q) => {
    const name = asString(prop(q, 'name'));
    const label = text(prop(q, 'label'));
    const description = text(prop(q, 'description'));
    return { name, ...(label && label !== name ? { label } : {}), ...(description ? { description } : {}) };
  });
  return { ok: true, models };
}

type Saved = { metrics: string[]; groupBy: Array<{ name: string; grain: string | null; datePart: string | null }>; where: string[] };

/** A saved query's metrics, group-bys and own filter, as dbt lists them now. */
async function savedQuery(ctx: ConnectorContext, name: string, deadline: number): Promise<{ ok: true; saved: Saved } | ConnectorError> {
  if (!DBT_IDENT_RE.test(name)) return { ok: false, error: 'Invalid dbt saved query name' };
  const r = await gql(ctx, DOCS.savedQuery, { savedQueryName: name }, deadline);
  if (!r.ok) return r;
  const q = prop(r.data, 'savedQuery');
  if (!q || typeof q !== 'object') return { ok: false, error: `dbt lists no saved query named ${name}` };
  const params = prop(q, 'queryParams');
  const w = prop(params, 'where');
  return {
    ok: true,
    saved: {
      metrics: asArray(prop(params, 'metrics')).map((m) => asString(prop(m, 'name'))),
      groupBy: asArray(prop(params, 'groupBy')).map((g) => ({ name: asString(prop(g, 'name')), grain: text(prop(g, 'grain')) ?? null, datePart: text(prop(g, 'datePart')) ?? null })),
      where: (Array.isArray(w) ? w : w ? [w] : []).map((x) => asString(prop(x, 'whereSqlTemplate'))).filter((s) => s.trim() !== ''),
    },
  };
}

const GRAINS: Readonly<Record<string, DateGrain>> = { DAY: 'day', WEEK: 'week', MONTH: 'month', QUARTER: 'quarter', YEAR: 'year' };

async function describeModel(ctx: ConnectorContext, model: string): Promise<Awaited<ReturnType<ConnectorSemantic['describeModel']>>> {
  const deadline = Date.now() + budgetMs(ctx);
  const s = await savedQuery(ctx, String(model), deadline);
  if (!s.ok) return s;
  const metricNames = s.saved.metrics.filter((m) => DBT_IDENT_RE.test(m));
  const metricsVar = metricNames.map((name) => ({ name }));
  const [dims, mets] = [await pages(ctx, DOCS.dimensions, 'dimensionsPaginated', { metrics: metricsVar }, deadline), await pages(ctx, DOCS.metrics, 'metricsPaginated', {}, deadline)];
  if (!dims.ok) return dims;
  if (!mets.ok) return mets;
  const dimensionOf = new Map(dims.items.map((d) => [asString(prop(d, 'name')), d]));
  const dimensions = s.saved.groupBy.flatMap((g): Array<{ name: string; type: ColumnType; grains?: DateGrain[] }> => {
    const d = dimensionOf.get(g.name);
    if (!d || g.datePart || !/^[a-z_][a-z0-9_]*(__[a-z0-9_]+)*$/.test(g.name)) return []; // an entity, a date part: not read
    if (prop(d, 'type') === 'CATEGORICAL') return [{ name: g.name, type: 'text' }];
    if (prop(d, 'type') !== 'TIME') return [];
    const grains = asArray(prop(d, 'queryableGranularities')).map((x) => GRAINS[asString(x)]).filter((x): x is DateGrain => !!x);
    return grains.length ? [{ name: g.name, type: 'date', grains: DATE_GRAINS.filter((x) => grains.includes(x)) }] : [];
  });
  const metricOf = new Map(mets.items.map((m) => [asString(prop(m, 'name')), m]));
  const metrics: Array<{ name: string; additive: boolean; description?: string }> = [];
  for (const name of metricNames) {
    const m = metricOf.get(name);
    if (!m) continue;
    // Additive only for a SIMPLE metric whose one measure aggregates SUM or COUNT (the SDK's `measures`, not on the
    // API page); every other type, and a measure that cannot be read, cannot be added up.
    let additive = false;
    if (prop(m, 'type') === 'SIMPLE') {
      const ms = await gql(ctx, DOCS.measures, { metrics: [{ name }] }, deadline);
      const list = ms.ok ? asArray(prop(ms.data, 'measures')) : [];
      additive = list.length === 1 && ['SUM', 'COUNT'].includes(asString(prop(list[0], 'agg')));
    }
    const description = text(prop(m, 'description'));
    metrics.push({ name, additive, ...(description ? { description } : {}) });
  }
  return { ok: true, dimensions, metrics };
}

/** Wait `ms` between polls; false when the caller gave up or the time is spent. */
function pause(ctx: ConnectorContext, ms: number, deadline: number): Promise<boolean> {
  if (ctx.signal?.aborted || Date.now() + ms >= deadline) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', stop);
      resolve(v);
    };
    const stop = (): void => done(false);
    const timer = setTimeout(() => done(true), ms);
    ctx.signal?.addEventListener('abort', stop, { once: true });
  });
}

/** One created query's pages, polled: its rows positional to the body's columns, or an error (after a best-effort cancel). */
async function answer(ctx: ConnectorContext, body: DbtBody, vars: Record<string, unknown>, deadline: number): Promise<{ ok: true; rows: Cell[][] } | ConnectorError> {
  const created = await gql(ctx, DOCS.createQuery, vars, deadline);
  if (!created.ok) return created;
  const queryId = asString(prop(prop(created.data, 'createQuery'), 'queryId'));
  if (!queryId) return { ok: false, error: 'dbt answered without a query id' };
  const stopped = (): ConnectorError => {
    // D18: stop polling, and ask dbt to stop (the SDK's cancelQuery; its answer ignored, a fresh signal).
    void gql(ctx, DOCS.cancelQuery, { queryId }, Date.now() + CANCEL_MS, null).catch(() => undefined);
    return { ok: false, error: ctx.signal?.aborted ? CANCELLED : timeoutError(budgetMs(ctx)).message };
  };
  const rows: Cell[][] = [];
  let wait = 250;
  for (let pageNum = 1; ;) {
    const r = await gql(ctx, DOCS.query, { queryId, pageNum }, deadline);
    if (!r.ok) return ctx.signal?.aborted || Date.now() >= deadline ? stopped() : r;
    const q = prop(r.data, 'query');
    const status = asString(prop(q, 'status'));
    if (status === 'FAILED') return { ok: false, error: safeError(`dbt: ${asString(prop(q, 'error')) || 'the query failed'}`, ctx.secrets) };
    if (status !== 'SUCCESSFUL') {
      if (!(await pause(ctx, wait, deadline))) return stopped();
      wait = Math.min(2_000, wait * 2);
      continue;
    }
    const page = readPage(body, prop(q, 'jsonResult'));
    if ('error' in page) return { ok: false, error: page.error };
    rows.push(...page);
    const total = Number(prop(q, 'totalPages'));
    if (rows.length > rowCap(ctx) || !(total > pageNum)) return { ok: true, rows };
    pageNum += 1;
  }
}

/** The encoder's body, asked of dbt with the saved query's own filter, read back named as asked. */
async function run(ctx: ConnectorContext, body: unknown): Promise<ConnectorRows | ConnectorError> {
  if (!isDbtBody(body)) return { ok: false, error: 'Not a dbt question' };
  const deadline = Date.now() + budgetMs(ctx);
  const s = await savedQuery(ctx, body.savedQuery, deadline);
  if (!s.ok) return s;
  const groupBys = new Set(s.saved.groupBy.map((g) => g.name));
  const gone = [...body.metrics.filter((m) => !s.saved.metrics.includes(m.name)), ...body.groupBy.filter((g) => !groupBys.has(g.name))].map((x) => x.name);
  if (gone.length) return { ok: false, error: `The dbt saved query ${body.savedQuery} no longer has ${gone.join(', ')}: sync the dataset again` };
  const cap = rowCap(ctx);
  for (const limit of [body.limit ?? cap + 1, cap + 1]) {
    const vars = { metrics: body.metrics, groupBy: body.groupBy, where: [...body.where, ...s.saved.where.map((sql) => ({ sql }))], orderBy: body.orderBy, limit };
    const got = await answer(ctx, body, vars, deadline);
    if (!got.ok) return got;
    const done = finishRows(body, got.rows, limit, cap);
    if (!('recut' in done)) return done;
  }
  return { ok: false, error: 'dbt answered a full reply twice' }; // unreachable: a reply past the cap is never re-cut
}

const semantic: ConnectorSemantic = {
  backend: 'dbt',
  // Lookups: a query with group-bys alone lists their values (documented). No byte-exact compare: restricted viewers refused (D17).
  caps: { lookups: true, binaryCompare: false },
  listModels,
  describeModel,
  run,
};

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'dbt-semantic-layer',
    label: 'dbt Semantic Layer (beta)',
    family: 'dbt',
    category: 'Semantic layers',
    readOnly: true,
    blurb: 'Beta: not yet checked against a live dbt Cloud account.',
    hosts: DBT_HOSTS,
    fields: [
      {
        key: 'region', label: 'Region', type: 'select', required: true, default: 'north-america',
        options: Object.entries(DBT_REGIONS).map(([value, r]) => ({ value, label: `${r.label} (${r.host})` })),
        help: 'Your dbt Cloud account\'s multi-tenant region. Single-tenant and cell-based accounts are not supported in the beta.',
      },
      { key: 'environmentId', label: 'Environment ID', type: 'text', required: true, placeholder: '123456', help: 'The deployment environment whose Semantic Layer to ask (dbt Cloud → Deploy → Environments).' },
      { key: 'token', label: 'Service token', type: 'password', secret: true, required: true, help: 'A service token with the Semantic Layer Only and Metadata Only permissions.' },
    ],
    listTables: async (ctx) => {
      const r = await listModels(ctx);
      return r.ok ? { ok: true, tables: r.models.map((m) => ({ name: m.name })) } : r;
    },
    run: async () => ({ ok: false, error: 'A semantic layer has no rows to copy. Add it as a Live dataset.' }),
    semantic,
  },
];
