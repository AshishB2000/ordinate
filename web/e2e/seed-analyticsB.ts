// Gives the analytics B spec (T2.11) data the sample project lacks, through the
// same stores the handlers call: a "Web events" dataset (user, event, time —
// what a cohort and a funnel read), and an "Orders feed" with a source and a
// daily schedule that has been refreshed twice, so it keeps two snapshots (the
// first one region short, the latest with a new region added). Run as its own
// process (DuckDB keeps the runner alive), against a
// server's DATA_DIR while it runs: records are files in dev mode.
//
//   node web/e2e/seed-analyticsB.ts <dataDir> <projectId>     (needs `npm run build:ts`)

import { createRequire } from 'node:module';

const [dataDir, projectId] = process.argv.slice(2);
if (!dataDir || !projectId) throw new Error('usage: node web/e2e/seed-analyticsB.ts <dataDir> <projectId>');

// The compiled main world, by the shapes used here only (see seed.ts).
type Identity = object;
type Column = { name: string; type: 'text' | 'number' | 'date' };
type Cell = string | number | null;
const require = createRequire(import.meta.url);
const context = require('../../src/server/context.js') as {
  enterServerMode(dir: string): void;
  identityFor(cfg: { dataDir: string }): (headers: object) => Identity | null;
  runInContext<T>(identity: Identity, requestId: string, fn: () => T): T;
};
const envMod = require('../../src/server/env.js') as { parseEnv(src: Record<string, string>): { dataDir: string } };
const datasets = require('../../src/data/datasets.js') as {
  saveDataset(projectId: string, input: { name: string; sourceKind: string; columns: Column[]; rows: Cell[][]; origin?: unknown }): Promise<{ id: string } | null>;
  setAutoRefresh(projectId: string, id: string, patch: { every: 'daily' }): Promise<unknown>;
  updateDatasetData(projectId: string, id: string, data: { columns: Column[]; rows: Cell[][] }): Promise<unknown>;
  markRefresh(projectId: string, id: string, status: 'ok', error: null): Promise<boolean>;
};

const cfg = envMod.parseEnv({ ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

/** 120 users over three months: everyone visits, fewer browse, fewer buy — deterministic. */
function webEvents(): { columns: Column[]; rows: Cell[][] } {
  const rows: Cell[][] = [];
  const steps = ['visit', 'browse', 'cart', 'purchase'];
  for (let u = 0; u < 120; u += 1) {
    const start = Date.UTC(2024, Math.floor(u / 40), 1 + (u % 28), 9, 0, 0);
    const depth = 1 + ((u * 7) % 4); // 1..4 steps
    for (let s = 0; s < depth; s += 1) rows.push([`u${String(u).padStart(3, '0')}`, steps[s], new Date(start + s * 3_600_000 * (s + 1)).toISOString().slice(0, 19).replace('T', ' ')]);
    // Some come back a month or two later.
    if (u % 3 === 0) rows.push([`u${String(u).padStart(3, '0')}`, 'visit', new Date(start + 32 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')]);
    if (u % 5 === 0) rows.push([`u${String(u).padStart(3, '0')}`, 'visit', new Date(start + 63 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')]);
  }
  return { columns: [{ name: 'user_id', type: 'text' }, { name: 'event', type: 'text' }, { name: 'event_time', type: 'date' }], rows };
}

const FEED_COLS: Column[] = [
  { name: 'region', type: 'text' },
  { name: 'orders', type: 'number' },
  { name: 'revenue', type: 'number' },
];
const feed = (extra: Cell[][] = []): Cell[][] => [
  ['East', 120, 18_400],
  ['West', 96, 15_250],
  ['Central', 71, 9_980],
  ...extra,
];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const out = await context.runInContext(dev, 'e2e-seed-analyticsB', async () => {
  const ev = await datasets.saveDataset(projectId, { name: 'Web events', sourceKind: 'csv', ...webEvents() });
  if (!ev) throw new Error('Web events was not saved');
  // A source to refresh from (never fetched here) and a schedule: snapshots are kept.
  const fd = await datasets.saveDataset(projectId, {
    name: 'Orders feed',
    sourceKind: 'url',
    columns: FEED_COLS,
    rows: feed().slice(0, 2),
    origin: { kind: 'url', url: 'https://example.com/orders-feed.csv' },
  });
  if (!fd) throw new Error('Orders feed was not saved');
  await datasets.setAutoRefresh(projectId, fd.id, { every: 'daily' });
  await pause(20);
  await datasets.updateDatasetData(projectId, fd.id, { columns: FEED_COLS, rows: feed() });
  await datasets.markRefresh(projectId, fd.id, 'ok', null);
  await pause(20);
  await datasets.updateDatasetData(projectId, fd.id, { columns: FEED_COLS, rows: feed([['South', 54, 7_310]]).map((r) => (r[0] === 'West' ? ['West', 101, 16_020] : r)) });
  await datasets.markRefresh(projectId, fd.id, 'ok', null);
  return { eventsId: ev.id, feedId: fd.id };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
