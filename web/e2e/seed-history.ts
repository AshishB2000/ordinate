// Gives the sample project something for the projects spec to work on: two
// saved versions of one visual (its name edited once), and two other visuals
// in the Trash — no screen that edits or deletes a record is ported yet, so
// this goes through the same stores those screens' handlers call. Run as its
// own process (DuckDB keeps the runner alive), against a
// server's DATA_DIR while it runs: records are files in dev mode.
//
//   node web/e2e/seed-history.ts <dataDir> <projectId>     (needs `npm run build:ts`)

import { createRequire } from 'node:module';

const [dataDir, projectId] = process.argv.slice(2);
if (!dataDir || !projectId) throw new Error('usage: node web/e2e/seed-history.ts <dataDir> <projectId>');

// The compiled main world, by the shapes used here only (see seed.ts).
type Identity = object;
type Visual = { id: string; name: string };
const require = createRequire(import.meta.url);
const context = require('../../src/server/context.js') as {
  enterServerMode(dir: string): void;
  identityFor(cfg: { dataDir: string }): (headers: object) => Identity | null;
  runInContext<T>(identity: Identity, requestId: string, fn: () => T): T;
};
const envMod = require('../../src/server/env.js') as { parseEnv(src: Record<string, string>): { dataDir: string } };
const visuals = require('../../src/analysis/visuals.js') as {
  listVisuals(projectId: string): Promise<Visual[]>;
  getVisual(projectId: string, id: string): Promise<Visual | null>;
  updateVisual(projectId: string, id: string, patch: { name: string }): Promise<Visual | null>;
};
const versions = require('../../src/app/versions.js') as {
  record(projectId: string, type: 'visual', rec: unknown, opts?: { before?: unknown; now?: Date }): Promise<unknown>;
};
const trash = require('../../src/app/trash.js') as {
  trashRecord(projectId: string, type: 'visual', id: string): Promise<{ ok: boolean }>;
};

const cfg = envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

const out = await context.runInContext(dev, 'e2e-seed-history', async () => {
  const list = await visuals.listVisuals(projectId);
  if (list.length < 3) throw new Error(`the sample project has ${list.length} visuals; this seed needs 3`);
  const [kept, ...rest] = list;
  const first = await visuals.getVisual(projectId, kept.id);
  // An hour apart, so the list shows two distinct times.
  await versions.record(projectId, 'visual', first, { now: new Date(Date.now() - 3_600_000) });
  const edited = await visuals.updateVisual(projectId, kept.id, { name: `${kept.name} (edited)` });
  await versions.record(projectId, 'visual', edited, { before: first });
  const trashed: string[] = [];
  for (const v of rest.slice(0, 2)) {
    if (!(await trash.trashRecord(projectId, 'visual', v.id)).ok) throw new Error(`could not trash ${v.name}`);
    trashed.push(v.name);
  }
  return { visualId: kept.id, original: kept.name, edited: `${kept.name} (edited)`, trashed };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
