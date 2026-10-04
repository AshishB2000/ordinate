// The Data section's extra fixture (data.e2e.ts), added to the sample project
// of a running e2e server's DATA_DIR through the ordinary stores, as the dev
// user's org: a "Regions" lookup to relate Retail orders to, and "Feed", a
// dataset whose origin and stored refresh error hold a planted key — which no
// reply the browser receives may ever carry.
//
//   node web/e2e/seedData.ts <dataDir> <projectId> <canary>   (after npm run build:ts)

import Module, { createRequire } from 'node:module';

const [dataDir, projectId, canary] = process.argv.slice(2);
if (!dataDir || !projectId || !canary) throw new Error('usage: node web/e2e/seedData.ts <dataDir> <projectId> <canary>');

// As seed.ts: the server has no Electron, so neither does its fixture.
type Resolve = (request: string, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve };
const resolve = M._resolveFilename;
M._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  if (request === 'electron' || request.startsWith('electron/')) throw new Error('electron is not available on the server');
  return resolve.call(this, request, ...rest);
};

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
};
const record = require('../../src/data/datasetRecord.js') as {
  markRefresh(projectId: string, id: string, status: 'ok' | 'error', error: string | null): Promise<boolean>;
};

const cfg = envMod.parseEnv({ ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
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
  if (!regions || !feed) throw new Error('the Data fixture was not saved');
  await record.markRefresh(projectId, feed.id, 'error', `Could not fetch ${url}: 401 Unauthorized`);
  return { regionsId: regions.id, feedId: feed.id };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0); // DuckDB's worker would hold the process open
