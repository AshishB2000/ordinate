// The subscriptions suites' bench (scripts/test-subscriptions-server.ts,
// test-subscriptions-db.ts) — a helper, not a suite.
//
//   receiver   a local HTTP server standing in for Slack / Teams: it records
//              every request and answers from a script (200, 429 + Retry-After,
//              5xx, a redirect). NOTHING here talks to a real Slack or Teams.
//   reaching   the SSRF guard refuses loopback, so the suites allow exactly
//              127.0.0.1/32 (SSRF_ALLOW), as an operator would allow an
//              internal range, and switch on the http:// test hook
//              (channels.allowHttpForTest) — the server's own rule is https only.
//   seed       a project with a dataset, two visuals, a saved metric and a
//              dashboard of two KPIs and two charts.
//   store      an in-memory SecretStore for the suite that runs without
//              Postgres (the real one is src/server/secrets/store.ts).

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import { withCsrf } from './csrfPair';

export const context: typeof import('../src/server/context') = require('../src/server/context');
export const wire: typeof import('../src/server/wire') = require('../src/server/wire');
export const channels: typeof import('../src/app/channels') = require('../src/app/channels');
export const deliver: typeof import('../src/server/subscriptions/deliver') = require('../src/server/subscriptions/deliver');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');

export type Identity = import('../src/server/context').Identity;
export type Reply = { status: number; body: any; text: string }; // any: each channel's own reply shape

/** The secret part of every webhook URL the suites make — what the canary greps for. */
export const CANARY = 'T0CANARY/B0CANARY/xoxb-webhook-canary-7f3a91c2';

export interface Hit { method: string; url: string; body: any; headers: http.IncomingHttpHeaders } // any: the JSON a platform would receive

/** A scripted webhook receiver. `script` answers the next requests in order; then `fallback`. */
export async function receiver(): Promise<{ url: (path?: string) => string; hits: Hit[]; script: Array<[number, Record<string, string>?, string?]>; fallback: [number, Record<string, string>?, string?]; close: () => Promise<void> }> {
  const state = { hits: [] as Hit[], script: [] as Array<[number, Record<string, string>?, string?]>, fallback: [200, {}, 'ok'] as [number, Record<string, string>?, string?] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* not JSON: kept as text */ }
      state.hits.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      const [status, headers, text] = state.script.shift() ?? state.fallback;
      res.writeHead(status, headers ?? {});
      res.end(text ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path = `/services/${CANARY}`) => `http://127.0.0.1:${port}${path}`,
    hits: state.hits,
    script: state.script,
    get fallback() { return state.fallback; },
    set fallback(v) { state.fallback = v; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Let delivery reach the local receiver, and do not sleep through a backoff: the waits are recorded instead. */
export function openLoopback(): { waits: number[] } {
  process.env.SSRF_ALLOW = '127.0.0.1/32';
  channels.allowHttpForTest(true);
  const waits: number[] = [];
  deliver.setSleepForTest(async (ms) => { waits.push(ms); });
  return { waits };
}

/** An in-memory SecretStore, keyed by org like the real one — another org reads nothing. */
export function memoryStore(): import('../src/server/secrets/store').SecretStore & { dump: () => string[] } {
  const rows = new Map<string, string>();
  const key = (org: string, kind: string, ref: string): string => `${org}\n${kind}\n${ref}`;
  return {
    get: async (org, kind, ref) => rows.get(key(org, kind, ref)) ?? null,
    put: async (org, kind, ref, value) => void rows.set(key(org, kind, ref), value),
    delete: async (org, kind, ref) => rows.delete(key(org, kind, ref)),
    dump: () => [...rows.values()],
  };
}

export const SALES = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };
export const BY_MONTH = { category: 'day', values: [{ column: 'amount', aggregation: 'sum' as const }], grain: 'month' };

export interface Seed { ds: string; v1: string; v2: string; rev: string; aid: string; kpiAvg: string; kpiRev: string; tile1: string; tile2: string }

/** A dataset, two visuals, a saved metric (up is good) and a dashboard: two KPIs (one with a Compare) and two charts. */
export async function seed(who: Identity, projectId: string): Promise<Seed> {
  return context.runInContext(who, 'seed', async () => {
    const rows: Array<[string, string, number]> = [];
    const regions = ['North', 'South', 'East', 'West'];
    for (let m = 1; m <= 12; m++) for (const [i, r] of regions.entries()) rows.push([r, `2025-${String(m).padStart(2, '0')}-15`, m * 10 + i * 100]);
    const d = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
      rows,
    });
    if (!d) throw new Error('seed dataset');
    const v1 = await visuals.saveVisual(projectId, { name: 'Sales by region', datasetId: d.id, chartType: 'bar', encoding: SALES, filters: [] } as never);
    const v2 = await visuals.saveVisual(projectId, { name: 'Monthly sales', datasetId: d.id, chartType: 'line', encoding: BY_MONTH, filters: [] } as never);
    const rev = await metrics.saveMetric(projectId, { name: 'Revenue', datasetId: d.id, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'currency', decimals: 0 }, direction: 'up_good' } as never);
    if (!v1 || !v2 || !rev) throw new Error('seed visual / metric');
    const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 3, h: 4 }, ...extra });
    const kpiAvg = card('metric', 0, { metric: { datasetId: d.id, column: 'amount', aggregation: 'avg', label: 'Avg order' } });
    const kpiRev = card('metric', 3, { metric: { datasetId: d.id, column: 'amount', aggregation: 'sum', metricId: rev.id, compare: { mode: 'custom', from: '2025-01-01', to: '2025-06-30' } } });
    const tile1 = card('visual', 6, { visualId: v1.id });
    const tile2 = card('visual', 9, { visualId: v2.id });
    const a = await analysis.saveAnalysis(projectId, { name: 'Board', sheets: [{ name: 'Overview', cards: [kpiAvg, kpiRev, tile1, card('text', 0, { heading: 'Note', text: 'Hello' })] }, { name: 'Trend', cards: [tile2] }] });
    if (!a) throw new Error('seed analysis');
    return { ds: d.id, v1: v1.id, v2: v2.id, rev: rev.id, aid: a.id, kpiAvg: kpiAvg.id, kpiRev: kpiRev.id, tile1: tile1.id, tile2: tile2.id };
  });
}

/** A subscription definition for `seed`, as a browser would send it. */
export function definition(s: Seed, channelIds: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Weekly board', analysisId: s.aid, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'daily', at: '08:00' }, timezone: 'UTC',
    channelIds, message: { title: '', note: '', includeLink: true }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false }, ...over,
  };
}

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

/** RPC over real HTTP, as the web client sends it. `seen` collects every reply's raw text (the canary reads it). */
export function client(base: string, headers: Record<string, string> = {}, seen: string[] = []) {
  const call = async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    seen.push(text);
    return { status: res.status, text, body: res.status === 200 ? wire.decode(text) : text };
  };
  return { call };
}
