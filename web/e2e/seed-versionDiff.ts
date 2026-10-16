// Gives the version-diff spec a dashboard with two saves to compare: the sample
// dashboard as seeded, then an edit — a dashboard filter added, one KPI's
// aggregation changed, one card moved, the note rewritten and the dashboard
// renamed. Through the store and versions.record, as analysis:update does (the
// same reason seed-history.ts gives). Run as its own process against a running
// server's DATA_DIR: records are files in dev mode.
//
//   node web/e2e/seed-versionDiff.ts <dataDir> <projectId>     (needs `npm run build:ts`)

import { createRequire } from 'node:module';

const [dataDir, projectId] = process.argv.slice(2);
if (!dataDir || !projectId) throw new Error('usage: node web/e2e/seed-versionDiff.ts <dataDir> <projectId>');

// The compiled main world, by the shapes used here only (see seed.ts).
type Identity = object;
type Card = { id: string; type: string; layout: { x: number; y: number; w: number; h: number }; metric?: { label?: string; aggregation: string }; heading?: string; text?: string };
type Analysis = { id: string; name: string; updatedAt: string; filters: unknown[]; sheets: { id: string; name: string; cards: Card[] }[] };
const require = createRequire(import.meta.url);
const context = require('../../src/server/context.js') as {
  enterServerMode(dir: string): void;
  identityFor(cfg: { dataDir: string }): (headers: object) => Identity | null;
  runInContext<T>(identity: Identity, requestId: string, fn: () => T): T;
};
const envMod = require('../../src/server/env.js') as { parseEnv(src: Record<string, string>): { dataDir: string } };
const analysis = require('../../src/analysis/analysis.js') as {
  listAnalyses(projectId: string): Promise<{ id: string }[]>;
  getAnalysis(projectId: string, id: string): Promise<Analysis | null>;
  updateAnalysis(projectId: string, id: string, patch: Partial<Analysis>): Promise<Analysis | null>;
};
const versions = require('../../src/app/versions.js') as {
  record(projectId: string, type: 'dashboard', rec: unknown, opts?: { before?: unknown; now?: Date }): Promise<unknown>;
};

const cfg = envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'dev', DATA_DIR: dataDir });
context.enterServerMode(cfg.dataDir);
const dev = context.identityFor(cfg)({});
if (!dev) throw new Error('dev auth returned no identity');

const out = await context.runInContext(dev, 'e2e-seed-versiondiff', async () => {
  const [first] = await analysis.listAnalyses(projectId);
  if (!first) throw new Error('the sample project has no dashboard');
  const before = await analysis.getAnalysis(projectId, first.id);
  if (!before) throw new Error('the sample dashboard could not be read');
  // An hour ago, so the two saves read as two times.
  await versions.record(projectId, 'dashboard', before, { now: new Date(Date.now() - 3_600_000) });

  const sheets = structuredClone(before.sheets);
  const cards = sheets[0].cards;
  const units = cards.find((c) => c.type === 'metric' && c.metric?.label === 'Units sold');
  const note = cards.find((c) => c.type === 'text');
  const orders = cards.find((c) => c.type === 'metric' && c.metric?.label === 'Orders');
  if (!units || !units.metric || !note || !orders) throw new Error('the sample dashboard lost its KPI or note cards');
  units.metric.aggregation = 'avg';
  note.text = `${String(note.text || '').split(' ').slice(0, 6).join(' ')} — edited for the quarterly review.`;
  // Dragged to its own row under everything else on the sheet.
  const bottom = Math.max(...cards.filter((c) => c !== orders).map((c) => c.layout.y + c.layout.h));
  orders.layout = { ...orders.layout, x: 0, y: bottom };
  const edited = await analysis.updateAnalysis(projectId, first.id, {
    name: `${before.name} (Q4)`,
    sheets,
    filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }],
  });
  if (!edited) throw new Error('the edit did not save');
  await versions.record(projectId, 'dashboard', edited, { before });
  return { analysisId: first.id, original: before.name, edited: edited.name };
});
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
