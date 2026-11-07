// Cube as a semantic layer (semantic layer part 7, e1; docs/live-data/cube.md, docs/semantic-layer/07-portability.md
// D14, D18) — MAIN PROCESS ONLY.
//
// One registry entry, in the "Semantic layers" group, with the `semantic` capability: Cube's REST API at the
// operator-given URL, plain JSON over `httpShared.httpRequest` — which checks and pins EVERY request through the SSRF
// guard, never follows a redirect, caps the bytes, and destroys the socket on the timeout or the caller's signal.
//
//   listModels     GET  <base>/v1/meta: its cubes and views (public, visible, plainly named)
//   describeModel  the same meta: a model's dimensions typed, its measures with whether they add up
//   run            POST <base>/v1/load with the encoder's query (src/engine/live/semantic/cube.ts), re-posted while
//                  Cube says "Continue wait", read back by ./cubeWire.ts
//   listTables     the models (the connection test); `run`, the copy path, refuses: a layer has no rows to copy
//
// Sign-in: the API SECRET signs a fresh HS256 token per request (`iat` now, `exp` +5 minutes), or a TOKEN the
// deployment accepts goes as is. Either is the `token` field, `secret: true`: it lives in the secrets store as
// `connection.token`, and every error is redacted of it and of each token signed from it. Plain http only to an
// address SSRF_ALLOW admits (a self-hosted Cube inside the operator's network); everything else is https.

import { DATE_GRAINS } from '../analysis/categoryKey';
import type { ColumnType } from '../data/parse';
import { CUBE_NAME_RE, CUBE_ROW_LIMIT, isCubeBody, loadRows, metaCubes, shortName, type CubeBody } from './cubeWire';
import { CANCELLED, asArray, asString, budgetMs, httpRequest, prop, secret, str, timeoutError } from './httpShared';
import { signJwtHs256 } from './jwt';
import { allowListed, checkHost, guardOn } from './ssrf';
import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorSemantic } from './types';
import { safeError } from './types';

const POLL_MS = 200;
const TOKEN_LIFE_S = 300;

type Json = { ok: true; json: unknown } | ConnectorError;

/** The REST API's base (`…/cubejs-api/v1`) from the form's URL, or why not. */
async function baseOf(ctx: ConnectorContext): Promise<string | ConnectorError> {
  let u: URL;
  try {
    u = new URL(str(ctx, 'url').trim());
  } catch {
    return { ok: false, error: 'The Cube URL is not a URL' };
  }
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'The Cube URL may not carry credentials, a query or a fragment' };
  if (u.protocol === 'http:' && guardOn()) {
    try {
      if (!allowListed((await checkHost(u.hostname)).address)) return { ok: false, error: 'Plain http is only for a deployment SSRF_ALLOW admits: use https' };
    } catch (err: unknown) {
      return { ok: false, error: safeError(err) };
    }
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'The Cube URL must be https' };
  }
  const p = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${!p ? '/cubejs-api/v1' : /\/v1$/.test(p) ? p : `${p}/v1`}`;
}

/** One signed request's JSON, or a redacted error. `deadline` bounds it (and every poll before it). */
async function call(ctx: ConnectorContext, base: string, path: '/meta' | '/load', deadline: number, body?: unknown): Promise<Json> {
  const key = secret(ctx, 'token');
  if (!key) return { ok: false, error: 'The Cube API secret or token is required' };
  const now = Math.floor(Date.now() / 1000);
  const auth = str(ctx, 'auth', 'secret') === 'token' ? key : signJwtHs256({ iat: now, exp: now + TOKEN_LIFE_S }, key);
  const redact = { ...ctx.secrets, signed: auth };
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, error: timeoutError(budgetMs(ctx)).message };
  try {
    const res = await httpRequest({
      url: new URL(`${base}${path}`),
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: left,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (res.truncated) return { ok: false, error: 'Cube answered past the 100 MB ceiling' };
    let json: unknown;
    try {
      json = JSON.parse(res.body) as unknown;
    } catch {
      json = undefined;
    }
    const said = asString(prop(json, 'error'));
    if (res.status < 200 || res.status >= 300) return { ok: false, error: safeError(`Cube answered HTTP ${res.status}${said ? `: ${said}` : ''}`, redact) };
    if (json === undefined) return { ok: false, error: 'Cube answered with no JSON' };
    if (said && said !== 'Continue wait') return { ok: false, error: safeError(`Cube: ${said}`, redact) };
    return { ok: true, json };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, redact) };
  }
}

/** Wait between polls; false when the caller gave up or the time is spent. */
function pause(ctx: ConnectorContext, deadline: number): Promise<boolean> {
  if (ctx.signal?.aborted || Date.now() + POLL_MS >= deadline) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (v: boolean): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', stop);
      resolve(v);
    };
    const stop = (): void => done(false);
    const timer = setTimeout(() => done(true), POLL_MS);
    ctx.signal?.addEventListener('abort', stop, { once: true });
  });
}

/** One /v1/load, re-posted while Cube says "Continue wait" (D18: every poll is the same counted question). */
async function load(ctx: ConnectorContext, base: string, body: CubeBody, deadline: number): Promise<Json> {
  for (;;) {
    const r = await call(ctx, base, '/load', deadline, { query: body.query });
    if (!r.ok || prop(r.json, 'error') !== 'Continue wait') return r;
    if (!(await pause(ctx, deadline))) return { ok: false, error: ctx.signal?.aborted ? CANCELLED : timeoutError(budgetMs(ctx)).message };
  }
}

async function meta(ctx: ConnectorContext): Promise<{ ok: true; cubes: unknown[] } | ConnectorError> {
  const base = await baseOf(ctx);
  if (typeof base !== 'string') return base;
  const r = await call(ctx, base, '/meta', Date.now() + budgetMs(ctx));
  return r.ok ? { ok: true, cubes: metaCubes(r.json) } : r;
}

const shown = (m: unknown): boolean => prop(m, 'isVisible') !== false && prop(m, 'public') !== false;
const titled = (v: unknown, name: string): string | undefined => (typeof v === 'string' && v.trim() && v !== name ? v : undefined);

async function listModels(ctx: ConnectorContext): Promise<Awaited<ReturnType<ConnectorSemantic['listModels']>>> {
  const m = await meta(ctx);
  if (!m.ok) return m;
  const models = m.cubes.filter((c) => shown(c) && CUBE_NAME_RE.test(asString(prop(c, 'name'))) && ['cube', 'view', undefined].includes(prop(c, 'type') as string | undefined)).map((c) => {
    const name = asString(prop(c, 'name'));
    const label = titled(prop(c, 'title'), name);
    const description = titled(prop(c, 'description'), name);
    return { name, ...(label ? { label } : {}), ...(description ? { description } : {}) };
  });
  return { ok: true, models };
}

const TYPES: Readonly<Record<string, ColumnType>> = { string: 'text', number: 'number', time: 'date' };

async function describeModel(ctx: ConnectorContext, model: string): Promise<Awaited<ReturnType<ConnectorSemantic['describeModel']>>> {
  if (!CUBE_NAME_RE.test(String(model))) return { ok: false, error: 'Invalid Cube model name' };
  const m = await meta(ctx);
  if (!m.ok) return m;
  const c = m.cubes.find((x) => prop(x, 'name') === model && shown(x));
  if (!c) return { ok: false, error: `Cube lists no model named ${model}` };
  const members = (part: string): unknown[] => asArray(prop(c, part)).filter((x) => shown(x) && asString(prop(x, 'name')).startsWith(`${model}.`) && CUBE_NAME_RE.test(shortName(asString(prop(x, 'name')))));
  const dimensions = members('dimensions').flatMap((x) => {
    const type = TYPES[asString(prop(x, 'type'))];
    const name = shortName(asString(prop(x, 'name')));
    if (!type) return []; // boolean, geo: not read
    return [type === 'date' ? { name, type, grains: DATE_GRAINS.slice() } : { name, type }];
  });
  // A view joins cubes: grouped by another cube's dimension (one-to-many), a row can count in two groups. Each view
  // member names its own cube in `aliasMember` (cube.member); a measure adds up only when every dimension is its cube's.
  const cubeOf = (x: unknown): string => asString(prop(x, 'aliasMember')).split('.')[0];
  const read = members('dimensions').filter((x) => TYPES[asString(prop(x, 'type'))]);
  const ownCube = (x: unknown): boolean => prop(c, 'type') !== 'view' || (!!cubeOf(x) && read.every((d) => cubeOf(d) === cubeOf(x)));
  const metrics = members('measures').map((x) => {
    // Only a plain sum or count adds up (D16); a rolling window, a distinct count, a formula never. `aggType` is Cube's
    // own measure type, not one of Ordinate's aggregations (data/aggregations), so it is compared, not listed.
    const aggType = asString(prop(x, 'aggType'));
    const additive = (aggType === 'sum' || aggType === 'count') && prop(x, 'cumulative') !== true && prop(x, 'cumulativeTotal') !== true && ownCube(x);
    const name = shortName(asString(prop(x, 'name')));
    const description = titled(prop(x, 'description'), name);
    return { name, additive, ...(description ? { description } : {}) };
  });
  return { ok: true, dimensions, metrics };
}

/** The encoder's body to /v1/load, polled, read back named as asked (a cut that cannot be trusted asked again). */
async function run(ctx: ConnectorContext, body: unknown): Promise<import('./types').ConnectorRows | ConnectorError> {
  if (!isCubeBody(body)) return { ok: false, error: 'Not a Cube question' };
  const base = await baseOf(ctx);
  if (typeof base !== 'string') return base;
  const deadline = Date.now() + budgetMs(ctx);
  return loadRows(body, (b) => load(ctx, base, b, deadline));
}

const semantic: ConnectorSemantic = {
  backend: 'cube',
  // Lookups: a query with dimensions alone lists their values. No byte-exact compare: restricted viewers refused (D17).
  caps: { lookups: true, binaryCompare: false },
  rowLimit: CUBE_ROW_LIMIT,
  listModels,
  describeModel,
  run,
};

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'cube',
    label: 'Cube',
    family: 'cube',
    category: 'Semantic layers',
    readOnly: true,
    blurb: 'Cube\'s REST API. Its cubes and views are added as Live datasets whose metrics Cube computes.',
    fields: [
      {
        key: 'url', label: 'Cube URL', type: 'text', required: true, placeholder: 'https://cube.example.com',
        help: 'The deployment, or its REST API URL (…/cubejs-api/v1). Plain http only for an internal deployment SSRF_ALLOW admits.',
      },
      {
        key: 'auth', label: 'Sign-in', type: 'select', required: true, default: 'secret',
        options: [{ value: 'secret', label: 'API secret' }, { value: 'token', label: 'API token' }],
        help: 'API secret: Ordinate signs a five-minute token for each request. API token: a token the deployment accepts, sent as is.',
      },
      { key: 'token', label: 'API secret or token', type: 'password', secret: true, required: true },
    ],
    listTables: async (ctx) => {
      const r = await listModels(ctx);
      return r.ok ? { ok: true, tables: r.models.map((m) => ({ name: m.name })) } : r;
    },
    run: async () => ({ ok: false, error: 'A semantic layer has no rows to copy. Add it as a Live dataset.' }),
    semantic,
  },
];
