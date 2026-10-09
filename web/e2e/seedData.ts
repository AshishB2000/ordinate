// The Data section's extra fixture (data.e2e.ts), added to the sample project
// of a running e2e server's DATA_DIR through the ordinary stores, as the dev
// user's org: a "Regions" lookup to relate Retail orders to, "Feed", a
// dataset whose origin and stored refresh error hold a planted key — which no
// reply the browser receives may ever carry — and "Live orders", refreshed
// incrementally every 5 minutes, whose last run took 7 (L0.3: behind schedule).
//
//   node web/e2e/seedData.ts <dataDir> <projectId> <canary>   (after npm run build:ts)

import { createRequire } from 'node:module';

const [dataDir, projectId, canary] = process.argv.slice(2);
if (!dataDir || !projectId || !canary) throw new Error('usage: node web/e2e/seedData.ts <dataDir> <projectId> <canary>');

type Identity = object;
type Column = { name: string; type: 'text' | 'number' | 'date' };
const require = createRequire(import.meta.url);
const context = require('../../src/server/context.js') as {
  enterServerMode(dir: string): void;
  identityFor(cfg: { dataDir: string }): (headers: object) => Identity | null;
  runInContext<T>(identity: Identity, requestId: string, fn: () => T): T;
};
const envMod = require('../../src/server/env.js') as { parseEnv(src: Record<string, string>): { dataDir: string } };
const datasets = require('../../src/data/datasets.js') as {
  saveDataset(projectId: string, input: { name: string; sourceKind: string; columns: Column[]; rows: (string | number | null)[][]; origin?: unknown }): Promise<{ id: string } | null>;
  writeIncremental(projectId: string, id: string, mutate: () => object): Promise<unknown>;
  setAutoRefresh(projectId: string, id: string, patch: { every?: string; lastAutoAt?: string; lastAutoMs?: number }): Promise<unknown>;
};
const record = require('../../src/data/datasetRecord.js') as {
  markRefresh(projectId: string, id: string, status: 'ok' | 'error', error: string | null): Promise<boolean>;
};

const cfg = envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

const out = await context.runInContext(dev, 'e2e-data-seed', async () => {
  const regions = await datasets.saveDataset(projectId, {
    name: 'Regions',
    sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'manager', type: 'text' }, { name: 'target', type: 'number' }],
    rows: [['East', 'Ana Ruiz', 900_000], ['West', 'Bo Chen', 1_100_000], ['Central', 'Cy Park', 700_000], ['South', 'Di Osei', 500_000]],
  });
  const url = `https://api.example.com/v1/orders.json?api_key=${canary}`;
  const feed = await datasets.saveDataset(projectId, {
    name: 'Feed',
    sourceKind: 'json',
    columns: [{ name: 'id', type: 'number' }, { name: 'status', type: 'text' }],
    rows: [[1, 'open'], [2, 'closed'], [3, 'open']],
    origin: { kind: 'url', url },
  });
  const live = await datasets.saveDataset(projectId, {
    name: 'Live orders',
    sourceKind: 'postgres',
    columns: [{ name: 'id', type: 'number' }, { name: 'updated', type: 'number' }],
    rows: [[1, 100], [2, 101]],
    origin: { kind: 'connection', connId: '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d', table: 'orders' },
  });
  if (!regions || !feed || !live) throw new Error('the Data fixture was not saved');
  await record.markRefresh(projectId, feed.id, 'error', `Could not fetch ${url}: 401 Unauthorized`);
  await record.markRefresh(projectId, live.id, 'ok', null);
  await datasets.writeIncremental(projectId, live.id, () => ({ enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: 101, runsSinceFull: 1, log: [] }));
  await datasets.setAutoRefresh(projectId, live.id, { every: '5min', lastAutoAt: new Date().toISOString(), lastAutoMs: 7 * 60_000 });
  return { regionsId: regions.id, feedId: feed.id, liveId: live.id };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0); // DuckDB's worker would hold the process open
