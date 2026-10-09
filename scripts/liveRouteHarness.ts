// The routed doors' test bench (docs/live-data/00-plan.md L2.4) — helper for
// scripts/test-liveRoute.ts and scripts/test-liveRouteAnswers.ts; not a suite.
//
// On top of ./liveQueryHarness (a server-mode process, org acme's DuckDB worker,
// the fake warehouse, the parity fixture as an extract AND as a Live dataset):
// the real RPC route (Fastify inject, wire-encoded, CSRF pair) signed in as
// acme's admin, and the spy every differential suite here uses — a wrapper on
// `datasets.getDataset` that records each id it is asked to hydrate.

import * as H from './liveQueryHarness';
import { withCsrf } from './csrfPair';

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

export { H };

/** A channel's reply, read field by field by the suites. */
export type Reply = Record<string, any>; // any: each channel's own reply shape, asserted where it is read

appMod.registerHandlers();
const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: H.DATA }), undefined, () => H.ORG_A);

/** One RPC as the web client sends it, as acme's admin. A 200 is wire-decoded; anything else is `{status, body}`. */
export async function post(channel: string, payload: unknown): Promise<{ status: number; body: string; value: Reply }> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/rpc/${encodeURIComponent(channel)}`,
    headers: withCsrf({ 'content-type': 'application/json' }),
    payload: wire.encode({ args: [payload] }),
  });
  let value: Reply = {};
  try {
    value = (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as Reply;
  } catch {
    value = {};
  }
  return { status: r.statusCode, body: r.body, value };
}

/** Every id `datasets.getDataset` was asked for since the spy went on. */
export const hydrated: string[] = [];
const realGet = H.datasets.getDataset;
(H.datasets as { getDataset: typeof realGet }).getDataset = (projectId: string, id: string) => {
  hydrated.push(id);
  return realGet(projectId, id);
};

/** Run `fn`, and say whether it asked `getDataset` for `datasetId`. */
export async function hydrates<T>(datasetId: string, fn: () => Promise<T>): Promise<{ value: T; hydrated: boolean }> {
  const from = hydrated.length;
  const value = await fn();
  return { value, hydrated: hydrated.slice(from).includes(datasetId) };
}

export async function close(): Promise<void> {
  await app.close();
  H.cleanup();
}

/** Median of a list of numbers. */
export function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}
