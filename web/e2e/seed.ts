// Seeds the bundled sample project into a fresh DATA_DIR, as the dev user's
// org, through the ordinary path (src/app/sampleProject.ts). Run as its own
// process by server.ts — the seed loads DuckDB, which would otherwise keep the
// test runner alive — and with Electron made unloadable, so the e2e also
// proves the sample seeds on a server that has no Electron at all.
//
//   node web/e2e/seed.ts <dataDir>     (needs `npm run build:ts` first)

import Module, { createRequire } from 'node:module';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: node web/e2e/seed.ts <dataDir>');

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

const cfg = envMod.parseEnv({ ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
// The identity every dev-mode request gets, so the sample lands in that org.
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

const seeded = await context.runInContext(dev, 'e2e-seed', async () => {
  await projects.init();
  return sample.seedSampleProject();
});
if (!seeded.seeded || !seeded.projectId) throw new Error(`sample project was not seeded: ${JSON.stringify(seeded)}`);
process.stdout.write(`${JSON.stringify({ ...seeded, projectName: sample.FIRST_PROJECT_NAME })}\n`);
process.exit(0); // DuckDB's worker would hold the process open
