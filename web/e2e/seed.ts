// Seeds the bundled sample project into a fresh DATA_DIR, as the dev user's
// org, through the ordinary path (src/app/sampleProject.ts). With --large it
// also adds a 1,000,000-row dataset to that project (the data grid's spec):
// an ordinary record saved empty, then its Parquet written straight by DuckDB
// from range() — `ordinal` 0..999,999 is each row's position, so a spec can
// prove no row was skipped or drawn twice. ~1 s, where building the rows in JS
// and saving them would take many.
// Plus a "Shipments" dataset with coordinates for the maps (scripts/geoFixture.ts —
// the sample itself has none). Run as its own
// process by server.ts — the seed loads DuckDB, which would otherwise keep the
// test runner alive — and with Electron made unloadable, so the e2e also
// proves the sample seeds on a server that has no Electron at all.
//
//   node web/e2e/seed.ts <dataDir> [--large]     (needs `npm run build:ts` first)

import Module, { createRequire } from 'node:module';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: node web/e2e/seed.ts <dataDir> [--large]');
const large = process.argv.includes('--large');
const LARGE_ROWS = 1_000_000;

// The repo's own server-boot test uses the same trick: resolving 'electron' throws.
type Resolve = (request: string, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: Resolve };
const resolve = M._resolveFilename;
M._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  if (request === 'electron' || request.startsWith('electron/')) throw new Error('electron is not available on the server');
  return resolve.call(this, request, ...rest);
};

// The compiled main world, by the shapes used here only: `typeof import()` of
// these would type-check the whole server graph under this harness's tsconfig.
type Identity = object;
const require = createRequire(import.meta.url);
const context = require('../../src/server/context.js') as {
  enterServerMode(dir: string): void;
  identityFor(cfg: { dataDir: string }): (headers: object) => Identity | null;
  runInContext<T>(identity: Identity, requestId: string, fn: () => T): T;
};
const envMod = require('../../src/server/env.js') as {
  parseEnv(src: Record<string, string>): { dataDir: string };
};
const sample = require('../../src/app/sampleProject.js') as {
  FIRST_PROJECT_NAME: string;
  seedSampleProject(): Promise<{ seeded: boolean; projectId?: string }>;
};
const projects = require('../../src/app/projects.js') as { init(): Promise<void> };
const datasets = require('../../src/data/datasets.js') as {
  saveDataset(projectId: string, input: { name: string; sourceKind: string; columns: unknown[]; rows: unknown[] }): Promise<{ id: string } | null>;
};
// The sample has states but no coordinates: the point, hexbin and flow maps read this (T1.3).
const geo = require('../../scripts/geoFixture.js') as {
  GEO_FIXTURE_NAME: string;
  geoFixture(): { columns: unknown[]; rows: unknown[][] };
};
type Column = { name: string; type: 'text' | 'number' | 'date' };
const record = require('../../src/data/datasetRecord.js') as {
  parquetPath(projectId: string, id: string): string;
  datasetFilePath(projectId: string, id: string): string;
  writeJsonAtomic(file: string, obj: unknown): Promise<void>;
};
const recordFs = require('../../src/app/recordFs.js') as { readFile(file: string, enc: 'utf8'): Promise<string> };
const duck = require('../../src/engine/duckdb.js') as { execAsync(sql: string): Promise<void> };

/** The 1M-row dataset: ordinal (number), label (text), day (date) — stored VARCHAR c0..c2 like every table. */
async function seedLarge(projectId: string): Promise<{ datasetId: string; rows: number; ms: number }> {
  const t0 = performance.now();
  const columns: Column[] = [
    { name: 'ordinal', type: 'number' },
    { name: 'label', type: 'text' },
    { name: 'day', type: 'date' },
  ];
  const ds = await datasets.saveDataset(projectId, { name: 'One million rows', sourceKind: 'csv', columns, rows: [] });
  if (!ds) throw new Error('the large dataset record was not saved');
  const pq = record.parquetPath(projectId, ds.id).replace(/'/g, "''");
  await duck.execAsync(
    `COPY (SELECT CAST(i AS VARCHAR) AS c0, 'row ' || CAST(i AS VARCHAR) AS c1, ` +
      `CAST(DATE '2020-01-01' + CAST(i % 3650 AS INTEGER) AS VARCHAR) AS c2 FROM range(${LARGE_ROWS}) t(i)) ` +
      `TO '${pq}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  );
  // The record says how many rows its table holds; it was saved with none.
  const file = record.datasetFilePath(projectId, ds.id);
  const meta = JSON.parse(await recordFs.readFile(file, 'utf8')) as Record<string, unknown>;
  await record.writeJsonAtomic(file, { ...meta, rowCount: LARGE_ROWS });
  return { datasetId: ds.id, rows: LARGE_ROWS, ms: Math.round(performance.now() - t0) };
}

const cfg = envMod.parseEnv({ ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
// The identity every dev-mode request gets, so the sample lands in that org.
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

const seeded = await context.runInContext(dev, 'e2e-seed', async () => {
  await projects.init();
  const s = await sample.seedSampleProject();
  if (s.projectId) {
    const fixture = geo.geoFixture();
    if (!(await datasets.saveDataset(s.projectId, { name: geo.GEO_FIXTURE_NAME, sourceKind: 'csv', ...fixture }))) throw new Error('the Shipments dataset was not saved');
  }
  return { ...s, large: large && s.projectId ? await seedLarge(s.projectId) : undefined };
});
if (!seeded.seeded || !seeded.projectId) throw new Error(`sample project was not seeded: ${JSON.stringify(seeded)}`);
process.stdout.write(`${JSON.stringify({ ...seeded, projectName: sample.FIRST_PROJECT_NAME })}\n`);
process.exit(0); // DuckDB's worker would hold the process open
