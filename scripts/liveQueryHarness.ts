// The live executor's test bench — helper for scripts/test-liveQuery.ts and
// scripts/test-liveQueryBudget.ts; not a suite itself.
//
// A real server-mode process: per-org records under a scratch DATA_DIR, each
// org's own locked DuckDB worker (routeByOrg), an in-memory secrets store, and
// the fake warehouse (./liveFakeConnector.ts) registered. `setupOrg` makes, in
// one org: a project, the L2.2 parity fixture as an EXTRACT dataset, the same
// rows as the fake warehouse's table, a fake connection holding a canary
// password, and a Live dataset over that table — the shape "Add from
// connection → Live" stores.

import type { Identity } from '../src/server/context';
import type { LiveColumn } from '../src/engine/live/liveSpec';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

export const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livequery-'));
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, as test-liveParity pins it

export const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
export const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
export const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

context.enterServerMode(DATA);
poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 600_000 });
fakeMod.registerLiveFake();

// The encrypted store's interface over a Map: secrets are stored per (org, kind, ref) as on a real server.
const vault = new Map<string, string>();
configSecrets.useSecretStore({
  get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
  put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
  delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
});

export const projects: typeof import('../src/app/projects') = require('../src/app/projects');
export const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
export const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
export const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
export const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
export const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
export const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
export const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
export const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
export const msg: typeof import('../src/engine/liveQueryMessages') = require('../src/engine/liveQueryMessages');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

export const fake = fakeMod.fake;
export const SECRET_CANARY = 'pw-canary-5d2e9b71';

export const ORG_A: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
export const ORG_B: Identity = { user: { email: 'bo@globex.test', role: 'admin' }, org: { id: 'globex' } };

let req = 0;
/** Run `fn` as a request of `who`, optionally with the request's abort signal. */
export function as<T>(who: Identity, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  req += 1;
  return context.runInContext(who, `t${req}`, fn, undefined, signal);
}

export interface OrgSetup {
  projectId: string;
  extractId: string;
  liveId: string;
  connId: string;
}

/** Make a fake connection (with the canary password) and a Live dataset over `origin` in the current org. */
export async function liveOver(projectId: string, origin: { table?: string; sql?: string }, columns: LiveColumn[], connectorId = fakeMod.LIVE_FAKE_ID, values: Record<string, unknown> = {}): Promise<{ connId: string; liveId: string }> {
  const conn = await connections.saveConnection(projectId, { name: 'Fake warehouse', connectorId, values });
  if (!conn) throw new Error('connection not saved');
  await secretsIpc.storeSecrets(conn.id, { password: SECRET_CANARY });
  const live = await liveRecord.saveLiveRecord(projectId, { name: 'Live', columns, origin: { kind: 'connection', connId: conn.id, ...origin } });
  if (!live) throw new Error('live dataset not saved');
  return { connId: conn.id, liveId: live.id };
}

/** One org's fixture: the parity rows as an extract AND as the fake warehouse's `live_typed`, and a Live dataset over it. */
export async function setupOrg(who: Identity): Promise<OrgSetup> {
  return as(who, async () => {
    await projects.init();
    const projectId = (await projects.createProject('Live executor')).id;
    const rows = fx.fixtureRows();
    // Typed as an import types it ('' → null), as every real copy is (L2.8).
    const extract = await datasets.saveDataset(projectId, { name: 'Fixture copy', sourceKind: 'csv', ...fx.importTyped(fx.COLUMNS, rows) });
    if (!extract) throw new Error('extract not saved');
    await fx.loadWarehouse('live_typed', fx.COLUMNS, rows);
    const { connId, liveId } = await liveOver(projectId, { table: 'live_typed' }, fx.COLUMNS);
    return { projectId, extractId: extract.id, liveId, connId };
  });
}

/** Run SQL in `who`'s own DuckDB worker — the fake warehouse that org's connection reads. */
export function warehouseExec(who: Identity, sql: string): Promise<void> {
  return as(who, () => duck.execAsync(sql));
}

/** Wait (polling) until `cond` holds, or `ms` passes. */
export async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** A gate a fake call can wait on: `open()` lets every waiter through. */
export function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { wait: () => p, open };
}

/** The live:duckdb counts so far. */
export function liveCounts(): import('../src/engine/residentTrace').OpCounts {
  return trace.snapshot()['live:duckdb'] ?? { resident: 0, skipped: 0, failed: 0, lastFailure: null, hit: 0, miss: 0, warehouse: 0, stale: 0, refused: 0, cancelled: 0 };
}

/** Capture console.warn while `fn` runs. */
export async function capturingWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = orig;
  }
}

export function cleanup(): void {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
}
