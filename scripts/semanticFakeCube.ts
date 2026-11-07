// The test harness's FAKE CUBE (semantic layer part 7, e1; docs/live-data/cube.md). Not a suite itself.
//
// CI has no Cube deployment, so:
//
//   decodeCube   a strict parser of exactly the query object src/engine/live/semantic/cube.ts writes, back into
//                b1's neutral question — the round trip test-semanticCube holds the encoder to. `as: 'cube'` reads
//                it as Cube itself would (the connector's own post-processing ignored), which is what the fake runs.
//   canonical    the plan's question in the decoder's spelling: the same meaning, written one way (a one-value
//                text list is its comparison, a NULL in a text list its '', "Other" its `not in`, a day comparison
//                its range).
//   cubeReply    an answer in Cube's wire shape: rows keyed by member, a time keyed `cube.dim.granularity` and
//                spelled `…T00:00:00.000`, every number as a string, an `annotation` typing each member, and the
//                rows ordered as Postgres orders them (a NULL FIRST on `desc`) before Cube's limit cuts them.
//   startFakeCube  an HTTP server on 127.0.0.1 answering GET /cubejs-api/v1/meta and POST /cubejs-api/v1/load,
//                checking the Authorization header (an HS256 token signed with its secret, or a fixed token), and
//                answering each decoded question by scripts/semanticFake.ts runFake over a DuckDB table.
//
// It proves OUR encoder, connector and shaping against our engine; that Cube answers the same is the nightly's
// (scripts/test-semanticCubeLive.ts).

import * as http from 'http';
import type * as net from 'net';
import { createHmac } from 'node:crypto';
import type { CubeBody, CubeFilter, CubeQuery } from '../src/connectors/cubeWire';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { SemanticFilter, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const wire: typeof import('../src/connectors/cubeWire') = require('../src/connectors/cubeWire');
const enc: typeof import('../src/engine/live/semantic/cube') = require('../src/engine/live/semantic/cube');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const fake: typeof import('./semanticFake') = require('./semanticFake');

const show = (v: unknown): string => JSON.stringify(v);
const bad = (what: string, f: unknown): never => {
  throw new Error(`fake Cube: ${what}: ${show(f)}`);
};

// ── Decoding ─────────────────────────────────────────────────────────────────

type Leaf = Extract<CubeFilter, { member: string }>;
const isLeaf = (f: CubeFilter): f is Leaf => 'member' in f;
const kids = (f: CubeFilter, kind: 'and' | 'or'): CubeFilter[] | null => (kind in f ? (f as Record<string, CubeFilter[]>)[kind] : null);
const op = (f: CubeFilter | undefined, operator: string): Leaf | null => (f && isLeaf(f) && f.operator === operator ? f : null);
const num = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : bad('not a number as the encoder writes one', s);
};

function decodeFilter(f: CubeFilter, column: (member: string) => LiveColumn, nonBlank: readonly string[]): SemanticFilter {
  const and = kids(f, 'and');
  const or = kids(f, 'or');
  const first = (isLeaf(f) ? f : (and ?? or ?? [])[0]) as Leaf | undefined;
  if (!first || !isLeaf(first)) return bad('a filter the encoder does not write', f);
  const col = column(first.member);
  const at = { column: col.name };
  const vs = first.values ?? [];
  const only = (n: number): boolean => (and ?? or ?? [f]).length === n;
  if (col.type === 'text') {
    if (op(f, 'equals') && !vs.includes('')) return { kind: 'in', ...at, values: vs, negate: false };
    if (op(f, 'notEquals') && !vs.includes('')) return { kind: 'in', ...at, values: vs, negate: true };
    if (or && only(2) && op(or[0], 'equals') && vs.includes('') && op(or[1], 'notSet')) return { kind: 'in', ...at, values: vs, negate: false };
    if (and && only(2) && op(and[0], 'notEquals') && vs.includes('') && op(and[1], 'set')) {
      return nonBlank.includes(first.member) && show(vs) === show(['']) ? { kind: 'empty', ...at, negate: true } : { kind: 'in', ...at, values: vs, negate: true };
    }
  } else if (col.type === 'number') {
    if (op(f, 'equals')) return { kind: 'in', ...at, values: vs.map(num), negate: false };
    if (op(f, 'notEquals')) return { kind: 'in', ...at, values: vs.map(num), negate: true };
    const cmp = (({ gt: '>', gte: '>=', lt: '<', lte: '<=' }) as Record<string, '>' | '>=' | '<' | '<=' | undefined>)[isLeaf(f) ? f.operator : ''];
    if (cmp && vs.length === 1) return { kind: 'compare', ...at, op: cmp, value: num(vs[0]) };
    if (op(f, 'set') || op(f, 'notSet')) return { kind: 'empty', ...at, negate: !!op(f, 'set') };
    if (and && only(2) && op(and[0], 'notEquals') && vs.length === 1 && op(and[1], 'set')) return { kind: 'compare', ...at, op: '!=', value: num(vs[0]) };
    if ((and || or) && only(2) && op((and ?? or)![0], 'set') && op((and ?? or)![1], 'notSet')) return { kind: 'in', ...at, values: [], negate: !!or };
  } else {
    const day = (l: Leaf | null): string => (l && l.values?.length === 1 && enc.isoDay(l.values[0]) ? l.values[0] : bad('not one ISO day', l));
    if (op(f, 'set') || op(f, 'notSet')) return { kind: 'empty', ...at, negate: !!op(f, 'set') };
    if (op(f, 'afterOrOnDate')) return { kind: 'compare', ...at, op: '>=', value: day(first) };
    if (and && only(1) && op(and[0], 'set')) return { kind: 'range', ...at };
    if (and && and.every((x) => op(x, 'afterOrOnDate') || op(x, 'beforeDate')) && and.length >= 1 && and.length <= 2) {
      const from = and.find((x) => op(x, 'afterOrOnDate'));
      const before = and.find((x) => op(x, 'beforeDate'));
      if (and.length === 2 && (!from || !before || and[0] !== from)) return bad('a range out of order', f);
      return { kind: 'range', ...at, ...(from ? { from: day(from as Leaf) } : {}), ...(before ? { to: enc.dayAfter(day(before as Leaf), -1) } : {}) };
    }
    if (or && only(2) && op(or[0], 'beforeDate') && op(or[1], 'notSet')) return { kind: 'compare', ...at, op: '<', value: day(or[0] as Leaf) };
    if (or && only(3) && op(or[0], 'beforeDate') && op(or[1], 'afterOrOnDate') && op(or[2], 'notSet')) {
      const a = day(or[0] as Leaf);
      if (day(or[1] as Leaf) !== enc.dayAfter(a)) return bad('a "not this day" that skips days', f);
      return { kind: 'compare', ...at, op: '!=', value: a };
    }
  }
  return bad(`a ${col.type} filter the encoder does not write`, f);
}

/**
 * The encoder's body → the question and model it asks. `as: 'ours'` (the default) reads the connector's post-processing
 * too (a value list's blanks dropped, then cut); `as: 'cube'` reads only what Cube sees, as Cube would run it.
 */
export function decodeCube(body: unknown, columns: readonly LiveColumn[], as: 'ours' | 'cube' = 'ours'): { model: string; query: SemanticQuery } {
  if (!wire.isCubeBody(body)) return bad('not a Cube body', body);
  const q: CubeQuery = body.query;
  if (q.timezone !== 'UTC') bad('a timezone other than UTC', q.timezone);
  if (!(q.limit > 0 && q.limit <= wire.CUBE_ROW_LIMIT)) bad('a limit outside the cap', q.limit);
  let model = '';
  const nameOf = (member: unknown): string => {
    const parts = String(member).split('.');
    if (parts.length !== 2 || !parts.every((p) => wire.CUBE_NAME_RE.test(p))) bad('a member that is not model.name', member);
    if (model && parts[0] !== model) bad('two models in one question', member);
    model = parts[0];
    return parts[1];
  };
  const column = (member: string): LiveColumn => {
    const name = nameOf(member);
    return columns.find((c) => c.name === name) ?? bad('a member the dataset does not declare', member);
  };
  const dimensions: SemanticQuery['dimensions'] = [
    ...q.timeDimensions.map((t) => {
      if (column(t.dimension).type !== 'date' || !(ck.DATE_GRAINS as readonly string[]).includes(t.granularity)) bad('a time dimension', t);
      return { name: nameOf(t.dimension), grain: t.granularity as import('../src/analysis/categoryKey').DateGrain };
    }),
    ...q.dimensions.map((d) => (column(d).type === 'date' ? bad('a date as a plain dimension', d) : { name: nameOf(d) })),
  ];
  const metrics = q.measures.map(nameOf);
  const nonBlank = as === 'ours' ? body.nonBlank ?? [] : [];
  if ((body.nonBlank?.length ?? 0) > 0 && q.limit !== wire.CUBE_ROW_LIMIT) bad('a value list cut by Cube before its blanks are dropped', body);
  const where = q.filters.map((f) => decodeFilter(f, column, nonBlank));
  const order = q.order.map(([m, dir]) => (dir === 'asc' || dir === 'desc' ? { by: nameOf(m), desc: dir === 'desc' } : bad('an order direction', dir)));
  const limit = as === 'ours' && body.limit !== undefined ? body.limit : q.limit === wire.CUBE_ROW_LIMIT ? undefined : q.limit;
  return { model, query: { dimensions, metrics, where, order, ...(limit !== undefined ? { limit } : {}) } };
}

/** The plan's question as the decoder spells it (the same meaning). */
export function canonical(q: SemanticQuery, columns: readonly LiveColumn[]): SemanticQuery {
  const typeOf = (c: string): string => columns.find((x) => x.name === c)?.type ?? 'text';
  const text = (v: unknown): string => (v == null ? '' : String(v));
  const finite = (v: unknown): number | null => {
    const n = parse.coerceValue((v ?? null) as import('../src/data/transforms').Cell, 'number');
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const one = (f: SemanticFilter): SemanticFilter => {
    const t = typeOf(f.column);
    if (t === 'text' && f.kind === 'compare') return { kind: 'in', column: f.column, values: [text(f.value)], negate: f.op === '!=' };
    if (t === 'text' && f.kind === 'in') return { ...f, values: f.values.map(text) };
    if (t === 'number' && f.kind === 'compare') {
      const n = finite(f.value);
      if (n === null) return { kind: 'in', column: f.column, values: [], negate: false };
      return f.op === '=' ? { kind: 'in', column: f.column, values: [n], negate: false } : { ...f, value: n };
    }
    if (t === 'number' && f.kind === 'in') return { ...f, values: f.values.map(finite).filter((n): n is number => n !== null) };
    if (t === 'date' && f.kind === 'compare') {
      const v = text(f.value);
      if (f.op === '=') return { kind: 'range', column: f.column, from: v, to: v };
      if (f.op === '>') return { ...f, op: '>=', value: enc.dayAfter(v) };
      if (f.op === '<=') return { ...f, op: '<', value: enc.dayAfter(v) };
    }
    return f;
  };
  const where = [...q.where, ...(q.exclude ? [{ kind: 'in' as const, column: q.exclude.dimension, values: q.exclude.values, negate: true }] : [])].map(one);
  const { exclude: _drop, ...rest } = q;
  return { ...rest, where };
}

// ── Cube's reply ─────────────────────────────────────────────────────────────

const cmp = (a: unknown, b: unknown): number => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** Rows in Cube's order as Postgres runs it: `asc` puts a NULL last, `desc` first. */
function postgresOrder(rows: unknown[][], order: Array<{ at: number; desc: boolean }>): unknown[][] {
  return rows.slice().sort((a, b) => {
    for (const { at, desc } of order) {
      const [x, y] = [a[at], b[at]];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        return (x == null ? 1 : -1) * (desc ? -1 : 1);
      }
      const c = cmp(x, y);
      if (c) return desc ? -c : c;
    }
    return 0;
  });
}

/** A decoded question's rows (dimensions, then metrics) → Cube's /v1/load reply to `body`. */
export function cubeReply(body: CubeBody, q: SemanticQuery, rows: unknown[][], columns: readonly LiveColumn[]): unknown {
  const model = q.dimensions.length || q.metrics.length ? wire.replyKeys(body.query)[0].key.split('.')[0] : '';
  const at = (name: string): number => [...q.dimensions.map((d) => d.name), ...q.metrics].indexOf(name);
  const ordered = postgresOrder(rows, q.order.map((o) => ({ at: at(o.by), desc: o.desc }))).slice(0, body.query.limit);
  const typeOf = (n: string): string => columns.find((c) => c.name === n)?.type ?? 'text';
  const annotation = { measures: {} as Record<string, unknown>, dimensions: {} as Record<string, unknown>, timeDimensions: {} as Record<string, unknown> };
  q.metrics.forEach((m) => { annotation.measures[`${model}.${m}`] = { title: m, type: 'number' }; });
  q.dimensions.forEach((d) => {
    if (d.grain) annotation.timeDimensions[`${model}.${d.name}.${d.grain}`] = { title: d.name, type: 'time' };
    else annotation.dimensions[`${model}.${d.name}`] = { title: d.name, type: typeOf(d.name) === 'number' ? 'number' : 'string' };
  });
  const data = ordered.map((r) => {
    const o: Record<string, unknown> = {};
    q.dimensions.forEach((d, i) => {
      const v = r[i];
      if (d.grain) {
        const t = v == null ? null : `${String(v)}T00:00:00.000`;
        o[`${model}.${d.name}.${d.grain}`] = t;
        o[`${model}.${d.name}`] = t;
      } else {
        o[`${model}.${d.name}`] = typeof v === 'number' ? String(v) : v; // Postgres numeric reaches JSON as text
      }
    });
    q.metrics.forEach((m, j) => { o[`${model}.${m}`] = r[q.dimensions.length + j] == null ? null : String(r[q.dimensions.length + j]); });
    return o;
  });
  return { query: body.query, data, annotation, lastRefreshTime: '2026-11-05T00:00:00.000Z' };
}

// ── The server ───────────────────────────────────────────────────────────────

/** One model the fake lists: a DuckDB table answered with scripts/semanticFake.ts's metrics. */
export interface FakeModel {
  name: string;
  type?: 'cube' | 'view';
  title?: string;
  description?: string;
  table: string;
  columns: LiveColumn[];
  /** Members listed but not public (left out by the listing). */
  hidden?: { dimensions?: string[]; measures?: string[] };
  public?: false;
}

const AGG: Record<string, string> = { revenue: 'sum', orders: 'count', avg_amount: 'avg', max_amount: 'max' };

export function metaOf(models: readonly FakeModel[]): unknown {
  const member = (m: FakeModel, name: string, extra: Record<string, unknown>, hidden: string[] = []) =>
    ({ name: `${m.name}.${name}`, title: name, shortTitle: name, ...extra, isVisible: !hidden.includes(name), public: !hidden.includes(name) });
  return {
    cubes: models.map((m) => ({
      name: m.name, type: m.type ?? 'cube', title: m.title ?? m.name, ...(m.description ? { description: m.description } : {}),
      isVisible: m.public !== false, public: m.public !== false, connectedComponent: 1,
      dimensions: [...m.columns.map((c) => member(m, c.name, { type: c.type === 'text' ? 'string' : c.type === 'number' ? 'number' : 'time', suggestFilterValues: true })),
        ...(m.hidden?.dimensions ?? []).map((n) => member(m, n, { type: 'string' }, m.hidden?.dimensions))],
      measures: [...Object.keys(AGG).map((n) => member(m, n, { type: 'number', aggType: AGG[n], cumulative: false, cumulativeTotal: false, drillMembers: [] })),
        ...(m.hidden?.measures ?? []).map((n) => member(m, n, { type: 'number', aggType: 'sum', cumulative: false }, m.hidden?.measures))],
      segments: [],
    })),
  };
}

/** HS256 JWT check: the signature over `head.body` with `secret`, and an `exp` still ahead. */
export function verifyHs256(token: string, secret: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  if (createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') !== s) return null;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() ? { header, payload } : null;
  } catch {
    return null;
  }
}

export interface FakeCubeOptions {
  models: FakeModel[];
  /** Accept tokens signed with this secret, or exactly `token`. */
  secret?: string;
  token?: string;
  /** The REST API's base path (Cube's default). */
  basePath?: string;
}

export interface FakeCube {
  url: string;
  port: number;
  /** Requests seen, by path; the bodies Cube was posted; the Authorization headers sent. */
  loads: number;
  metas: number;
  bodies: CubeBody[];
  auths: string[];
  /** Answer "Continue wait" to this many loads before each answer. */
  waits: number;
  /** A test's own answer to a request (status + JSON), before the fake's. */
  hook: ((path: string, body: unknown) => { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | undefined) | null;
  openSockets(): number;
  close(): Promise<void>;
}

export function startFakeCube(opts: FakeCubeOptions): Promise<FakeCube> {
  const base = opts.basePath ?? '/cubejs-api/v1';
  const sockets = new Set<net.Socket>();
  let pendingWaits = 0;
  const self: FakeCube = {
    url: '', port: 0, loads: 0, metas: 0, bodies: [], auths: [], waits: 0, hook: null,
    openSockets: () => sockets.size,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  const send = (res: http.ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof json === 'string' ? json : JSON.stringify(json));
  };
  const authorized = (auth: string): boolean => (opts.token !== undefined && auth === opts.token) || (opts.secret !== undefined && !!verifyHs256(auth, opts.secret));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      void (async () => {
        const path = (req.url ?? '').split('?')[0];
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) as unknown : undefined;
        } catch {
          return send(res, 400, { error: 'Bad JSON' });
        }
        const auth = String(req.headers.authorization ?? '');
        self.auths.push(auth);
        if (path === `${base}/load`) self.loads += 1;
        if (path === `${base}/meta`) self.metas += 1;
        const own = self.hook?.(path, body);
        if (own) return own.text !== undefined ? (res.writeHead(own.status, own.headers ?? {}), res.end(own.text)) : send(res, own.status, own.json ?? {}, own.headers);
        if (!authorized(auth)) return send(res, 403, { error: 'Invalid token' });
        if (path === `${base}/meta` && req.method === 'GET') return send(res, 200, metaOf(opts.models.filter((m) => m.public !== false)));
        if (path !== `${base}/load` || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
        if (self.waits > 0 && pendingWaits < self.waits) {
          pendingWaits += 1;
          return send(res, 200, { error: 'Continue wait' });
        }
        pendingWaits = 0;
        const b = (body as { query?: unknown } | undefined);
        const modelName = String((wire.isCubeBody(b) ? wire.replyKeys(b.query)[0]?.key : '') ?? '').split('.')[0];
        const model = opts.models.find((m) => m.name === modelName);
        if (!model || !wire.isCubeBody(b)) return send(res, 400, { error: `Cube model "${modelName}" not found` });
        self.bodies.push(b);
        try {
          const { query } = decodeCube(b, model.columns, 'cube');
          const answer = await fake.runFake(model.table, model.columns, { ...query, limit: undefined });
          return send(res, 200, cubeReply(b, query, answer.rows, model.columns));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise<FakeCube>((resolve) => server.listen(0, '127.0.0.1', () => {
    self.port = (server.address() as net.AddressInfo).port;
    self.url = `http://127.0.0.1:${self.port}`;
    resolve(self);
  }));
}
